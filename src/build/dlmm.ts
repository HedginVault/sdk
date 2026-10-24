import { PublicKey, type TransactionInstruction } from "@solana/web3.js";
import { z } from "zod";
import { ApiError } from "../errors";
import { type Assembled, assemble, fitsInTransaction, isComputeLimitError, refreshBatch } from "./assemble";
import { amountString, type BuildEnv, pubkey } from "./context";
import {
  addLiquidityIxs,
  type BinRange,
  claimFeeIx,
  DLMM_INITIAL_POSITION_WIDTH,
  DLMM_MAX_POSITION_WIDTH,
  DLMM_MAX_RESIZE_LENGTH,
  type DlmmCtx,
  extendPositionIx,
  initializePositionIx,
  loadDlmmCtx,
  binsWithValue,
  type OpenPosition,
  pairOf,
  pairStrategySetupIxs,
  readOpenPosition,
  removeLiquidityIx,
  vaultAtaIxs,
} from "./dlmm-ix";
import { buildWideAddPlan, DLMM_MAX_EXIT_BINS_PER_TX, nextBinChunk, withoutRepeats } from "./dlmm-wide";
import { zapRemove } from "./dlmm-zap";
import { excludingTransferFee, missingRangeBinArrayIxs, readPool, readPositionData } from "./meteora";
import type { LocalStep } from "./registry";
import { closeDlmmStrategyIx } from "./strategy";

const shape = z.enum(["spot", "curve", "bidAsk"]);
const maxActiveBinSlippage = z.number().int().min(0).max(1000);
const binId = z.number().int();
/** Optional sub-range of an existing position; both ends inclusive, given together or not at all. */
const binSelection = { lowerBinId: binId.optional(), upperBinId: binId.optional() };
export const slippageBps = z.number().int().min(1).max(10_000);

export const dlmmInitializeInput = z.object({
  vault: pubkey,
  lbPair: pubkey,
  width: z.number().int().min(1).max(DLMM_INITIAL_POSITION_WIDTH).optional(),
  ...binSelection,
});
export const dlmmOpenInput = z.object({
  vault: pubkey,
  lbPair: pubkey,
  lowerBinId: binId,
  upperBinId: binId,
  amountX: amountString,
  amountY: amountString,
  shape,
  maxActiveBinSlippage,
});
export const dlmmAddInput = z.object({ vault: pubkey, position: pubkey, amountX: amountString, amountY: amountString, shape, maxActiveBinSlippage, ...binSelection });
export const dlmmWideStepInput = z.object({
  vault: pubkey,
  position: pubkey,
  targetUpperBinId: binId,
  amountX: amountString,
  amountY: amountString,
  shape,
  maxActiveBinSlippage,
  activeBinId: binId,
  ...binSelection,
});
export const dlmmAddRangeInput = dlmmWideStepInput.extend({ cursorBinId: binId });
export const dlmmRemoveInput = z.object({
  vault: pubkey,
  position: pubkey,
  bpsToRemove: z.number().int().min(1).max(10_000),
  cursorBinId: binId.optional(),
  /** Set to zap: the removed non-deposit token is swapped into the deposit mint in the same transaction. */
  slippageBps: slippageBps.optional(),
  ...binSelection,
});
export const dlmmFlipInput = z.object({ vault: pubkey, position: pubkey, lowerBinId: binId, upperBinId: binId, activeBinId: binId, maxActiveBinSlippage });
export const dlmmClaimFeeInput = z.object({ vault: pubkey, position: pubkey, cursorBinId: binId.optional() });
export const dlmmCloseInput = z.object({ vault: pubkey, position: pubkey });

/** The requested inclusive bin selection, or null when absent; rejects one outside the position. */
function selectedBins(b: { lowerBinId?: number; upperBinId?: number }, position: BinRange): BinRange | null {
  if (b.lowerBinId === undefined && b.upperBinId === undefined) return null;
  if (b.lowerBinId === undefined || b.upperBinId === undefined) throw new ApiError(400, "Validation", "lowerBinId and upperBinId must be given together");
  if (position.lowerBinId > b.lowerBinId || b.lowerBinId > b.upperBinId || b.upperBinId > position.upperBinId)
    throw new ApiError(400, "Validation", "selected bins must lie inside the position");
  return { lowerBinId: b.lowerBinId, upperBinId: b.upperBinId };
}

const widthOf = (range: BinRange) => range.upperBinId - range.lowerBinId + 1;

/**
 * Centers a `width`-bin range on the active bin: `floor(width / 2)` bins sit below it. The returned
 * `upperBinId` is exclusive, as `meteora_dlmm_initialize_position` takes it.
 */
export function rangeFromWidth(activeId: number, width: number) {
  const lowerBinId = activeId - Math.floor(width / 2);
  return { lowerBinId, upperBinId: lowerBinId + width };
}

export async function buildDlmmInitialize(env: BuildEnv, b: z.infer<typeof dlmmInitializeInput>): Promise<LocalStep> {
  const c = await loadDlmmCtx(env, b.vault);
  const pool = await readPool(env, new PublicKey(b.lbPair));
  let { lowerBinId: lower, upperBinId: upper } = b;
  if (lower === undefined || upper === undefined) {
    if (!b.width) throw new ApiError(400, "Validation", "width or lowerBinId/upperBinId required");
    ({ lowerBinId: lower, upperBinId: upper } = rangeFromWidth(pool.lbPair.activeId, b.width));
  }
  if (upper <= lower) throw new ApiError(400, "Validation", "upperBinId must be greater than lowerBinId");
  if (upper - lower > DLMM_INITIAL_POSITION_WIDTH) throw new ApiError(400, "Validation", `range must span at most ${DLMM_INITIAL_POSITION_WIDTH} bins`);
  const pair = pairOf(pool);
  // The program refuses the position until each non-deposit pair mint has its Jupiter strategy.
  const setup = await pairStrategySetupIxs(c, pair);
  const { ix, position } = await initializePositionIx(c, pair, lower, upper);
  // The position account stores `upper - 1` as its last bin; report what the chain will hold.
  return { ...(await assemble(env, [...setup, ix], [], { signers: [position] })), position: position.publicKey.toBase58(), lowerBinId: lower, upperBinId: upper - 1 };
}

/**
 * Opens a position and prepares its resize and funding transactions as one batch. `upperBinId` is
 * exclusive, as in `dlmm/initialize`.
 */
export async function buildDlmmOpen(env: BuildEnv, b: z.infer<typeof dlmmOpenInput>): Promise<LocalStep | LocalStep[]> {
  if (b.upperBinId <= b.lowerBinId) throw new ApiError(400, "Validation", "upperBinId must be greater than lowerBinId");
  if (b.upperBinId - b.lowerBinId > DLMM_MAX_POSITION_WIDTH) throw new ApiError(400, "Validation", `range must span at most ${DLMM_MAX_POSITION_WIDTH} bins`);
  const amountX = BigInt(b.amountX);
  const amountY = BigInt(b.amountY);
  if (amountX === 0n && amountY === 0n) throw new ApiError(400, "Validation", "amountX or amountY must be greater than zero");

  const c = await loadDlmmCtx(env, b.vault);
  const pool = await readPool(env, new PublicKey(b.lbPair));
  const pair = pairOf(pool);
  const range = { lowerBinId: b.lowerBinId, upperBinId: b.upperBinId - 1 };
  const setup = await pairStrategySetupIxs(c, pair);

  if (b.upperBinId - b.lowerBinId > DLMM_INITIAL_POSITION_WIDTH) {
    const activeBinId = pool.lbPair.activeId;
    if ((amountX > 0n && range.upperBinId < activeBinId) || (amountY > 0n && range.lowerBinId > activeBinId))
      throw new ApiError(400, "Validation", "the selected range cannot hold the supplied token amount");
    const initialUpperExclusive = b.lowerBinId + DLMM_INITIAL_POSITION_WIDTH;
    const { ix, position } = await initializePositionIx(c, pair, b.lowerBinId, initialUpperExclusive);
    const groups: TransactionInstruction[][] = [[...setup, ix]];
    for (let createdUpper = initialUpperExclusive - 1; createdUpper < range.upperBinId; ) {
      const binsToAdd = Math.min(DLMM_MAX_RESIZE_LENGTH, range.upperBinId - createdUpper);
      const resize = await extendPositionIx(c, position.publicKey, pair, binsToAdd);
      const current = groups[groups.length - 1];
      if (current && fitsInTransaction(env.payer, [...current, resize])) current.push(resize);
      else groups.push([resize]);
      createdUpper += binsToAdd;
    }
    const resizes: Assembled[] = [];
    for (const [index, group] of groups.entries())
      resizes.push(await assemble(env, group, [], { signers: index === 0 ? [position] : [], deferSimulation: index > 0 }));
    const funding = await buildWideAddPlan(c, {
      position: position.publicKey,
      pool,
      ...range,
      cursorBinId: range.lowerBinId,
      activeBinId,
      amountXBaseUnits: amountX,
      amountYBaseUnits: amountY,
      shape: b.shape,
      maxActiveBinSlippage: b.maxActiveBinSlippage,
      deferFirstSimulation: true,
    });
    const [first, ...rest] = resizes;
    if (!first) throw new Error("unreachable: the initialize group always exists");
    return [{ ...first, position: position.publicKey.toBase58(), ...range }, ...rest, ...funding];
  }

  const { ix: initIx, position } = await initializePositionIx(c, pair, b.lowerBinId, b.upperBinId);
  const binArrays = await missingRangeBinArrayIxs(env, pool, range.lowerBinId, range.upperBinId);
  const add = await addLiquidityIxs(c, position.publicKey, pool, range, amountX, amountY, b.shape, b.maxActiveBinSlippage);
  const meta = { position: position.publicKey.toBase58(), ...range };
  const all = [...binArrays, ...setup, initIx, ...add];
  if (fitsInTransaction(env.payer, all)) return { ...(await assemble(env, all, [], { signers: [position] })), ...meta };
  return [
    { ...(await assemble(env, [...binArrays, ...setup, initIx], [], { signers: [position] })), ...meta },
    await assemble(env, add, [], { deferSimulation: true }),
  ];
}

interface WideAdd {
  amountX: string;
  amountY: string;
  shape: z.infer<typeof shape>;
  maxActiveBinSlippage: number;
  /** The active bin the caller planned the range against. */
  activeBinId: number;
  cursorBinId: number;
  lowerBinId?: number;
  upperBinId?: number;
}

/** Funds a wide position from `cursorBinId` up, chunk by chunk, after any missing pair strategies. */
async function wideAdd(c: DlmmCtx, p: OpenPosition, b: WideAdd): Promise<Assembled[]> {
  if (widthOf(p) > DLMM_MAX_POSITION_WIDTH) throw new ApiError(400, "Validation", "position range changed; refresh before adding liquidity");
  const { lowerBinId, upperBinId } = selectedBins(b, p) ?? p;
  if (b.cursorBinId < lowerBinId || b.cursorBinId > upperBinId) throw new ApiError(400, "Validation", "cursor must be inside the selected bins");
  const amountXBaseUnits = BigInt(b.amountX);
  const amountYBaseUnits = BigInt(b.amountY);
  if (amountXBaseUnits === 0n && amountYBaseUnits === 0n) throw new ApiError(400, "Validation", "amountX or amountY must be greater than zero");
  if (Math.abs(p.pool.lbPair.activeId - b.activeBinId) > b.maxActiveBinSlippage)
    throw new ApiError(409, "Stale", "pool price moved during the wide position flow; refresh before adding more liquidity");
  // A position opened before pair strategies were enforced gets them in a leading transaction.
  const setupIxs = await pairStrategySetupIxs(c, pairOf(p.pool));
  const setup = setupIxs.length ? [await assemble(c.env, setupIxs)] : [];
  const funding = await buildWideAddPlan(c, {
    position: p.key,
    pool: p.pool,
    lowerBinId,
    upperBinId,
    cursorBinId: b.cursorBinId,
    activeBinId: b.activeBinId,
    amountXBaseUnits,
    amountYBaseUnits,
    shape: b.shape,
    maxActiveBinSlippage: b.maxActiveBinSlippage,
    deferFirstSimulation: setup.length > 0,
  });
  return [...setup, ...funding];
}

export async function buildDlmmAdd(env: BuildEnv, b: z.infer<typeof dlmmAddInput>): Promise<LocalStep | LocalStep[]> {
  const c = await loadDlmmCtx(env, b.vault);
  const p = await readOpenPosition(c, b.position);
  const selection = selectedBins(b, p);
  if (widthOf(p) > DLMM_INITIAL_POSITION_WIDTH)
    return wideAdd(c, p, { ...b, cursorBinId: selection?.lowerBinId ?? p.lowerBinId, activeBinId: p.pool.lbPair.activeId });
  const setup = await pairStrategySetupIxs(c, pairOf(p.pool));
  const ixs = await addLiquidityIxs(c, p.key, p.pool, selection ?? p, BigInt(b.amountX), BigInt(b.amountY), b.shape, b.maxActiveBinSlippage);
  return assemble(env, [...setup, ...ixs]);
}

export async function buildDlmmAddRange(env: BuildEnv, b: z.infer<typeof dlmmAddRangeInput>): Promise<LocalStep[]> {
  const c = await loadDlmmCtx(env, b.vault);
  const p = await readOpenPosition(c, b.position);
  if (b.targetUpperBinId !== p.upperBinId || b.cursorBinId < p.lowerBinId || b.cursorBinId > p.upperBinId)
    throw new ApiError(400, "Validation", "position range changed; refresh before adding liquidity");
  return wideAdd(c, p, b);
}

/** One resize step toward `targetUpperBinId`, then the next step or the funding once the position is wide enough. */
export async function buildDlmmExtend(env: BuildEnv, b: z.infer<typeof dlmmWideStepInput>): Promise<LocalStep> {
  const c = await loadDlmmCtx(env, b.vault);
  const p = await readOpenPosition(c, b.position);
  const width = b.targetUpperBinId - p.lowerBinId + 1;
  if (width < 1 || width > DLMM_MAX_POSITION_WIDTH || b.targetUpperBinId <= p.upperBinId)
    throw new ApiError(400, "Validation", `target range must span at most ${DLMM_MAX_POSITION_WIDTH} bins and extend the position`);
  const binsToAdd = Math.min(DLMM_MAX_RESIZE_LENGTH, b.targetUpperBinId - p.upperBinId);
  const pair = pairOf(p.pool);
  const setup = await pairStrategySetupIxs(c, pair);
  const ix = await extendPositionIx(c, p.key, pair, binsToAdd);
  const nextUpper = p.upperBinId + binsToAdd;
  const { lowerBinId, upperBinId, ...step } = b;
  const body = { ...step, ...(lowerBinId !== undefined && upperBinId !== undefined && { lowerBinId, upperBinId }) };
  return {
    ...(await assemble(env, [...setup, ix])),
    next:
      nextUpper < b.targetUpperBinId
        ? { path: "dlmm/extend", body }
        : { path: "dlmm/add-range", body: { ...body, cursorBinId: lowerBinId ?? p.lowerBinId } },
  };
}

/**
 * Splits `[from, to]` into the widest chunks whose instructions fit one transaction, halving on
 * overflow. Every chunk may go out with the others (`sendConcurrently`).
 */
async function exitChunks(
  c: DlmmCtx,
  range: BinRange,
  ixsFor: (chunk: BinRange) => Promise<TransactionInstruction[]>,
  deferSimulation: boolean,
): Promise<Assembled[]> {
  const built: Assembled[] = [];
  for (let lowerBinId = range.lowerBinId; lowerBinId <= range.upperBinId; ) {
    for (let maxBins = DLMM_MAX_EXIT_BINS_PER_TX; ; ) {
      const chunk = nextBinChunk(lowerBinId, range.upperBinId, maxBins);
      const ixs = await ixsFor(chunk);
      if (fitsInTransaction(c.env.payer, ixs)) {
        built.push({ ...(await assemble(c.env, ixs, [], { deferSimulation })), sendConcurrently: true });
        lowerBinId = chunk.upperBinId + 1;
        break;
      }
      if (chunk.lowerBinId === chunk.upperBinId) throw new ApiError(422, "TransactionTooLarge", "one bin does not fit in a transaction for this pool");
      maxBins = Math.max(1, Math.floor(widthOf(chunk) / 2));
    }
  }
  return built;
}

export async function buildDlmmRemove(env: BuildEnv, b: z.infer<typeof dlmmRemoveInput>): Promise<LocalStep | LocalStep[]> {
  const c = await loadDlmmCtx(env, b.vault);
  const p = await readOpenPosition(c, b.position);
  const selection = selectedBins(b, p);
  // A position opened before pair strategies were enforced needs them before it can be unwound.
  const setup = await pairStrategySetupIxs(c, pairOf(p.pool));
  if (b.slippageBps !== undefined) return zapRemove(c, p, b.bpsToRemove, selection ?? p, b.cursorBinId, b.slippageBps, setup);
  if (b.cursorBinId === undefined && widthOf(p) <= DLMM_INITIAL_POSITION_WIDTH)
    return assemble(env, [...setup, ...vaultAtaIxs(c, p.pool), await removeLiquidityIx(c, p, b.bpsToRemove, selection ?? undefined)]);
  const bounds = selection ?? p;
  const lowerBinId = b.cursorBinId ?? bounds.lowerBinId;
  if (lowerBinId < bounds.lowerBinId || lowerBinId > bounds.upperBinId)
    throw new ApiError(400, "Validation", selection ? "cursor must be inside the selected bins" : "cursor must be inside the position");
  const head = setup.length ? [await assemble(env, setup)] : [];
  const chunks = await exitChunks(
    c,
    { lowerBinId, upperBinId: bounds.upperBinId },
    async (chunk) => [...vaultAtaIxs(c, p.pool), await removeLiquidityIx(c, p, b.bpsToRemove, chunk)],
    setup.length > 0,
  );
  return [...head, ...chunks];
}

/**
 * Withdraws one side's bins in full and re-adds that token there as Bid-Ask: atomically when it fits,
 * else as chunked removes then chunked re-adds in one batch. The batch stops at the first failure,
 * so a re-add never runs after a failed remove; a failed re-add leaves the token idle in the vault.
 */
export async function buildDlmmFlip(env: BuildEnv, b: z.infer<typeof dlmmFlipInput>): Promise<LocalStep | LocalStep[]> {
  const c = await loadDlmmCtx(env, b.vault);
  const p = await readOpenPosition(c, b.position);
  selectedBins(b, p);
  const liveActiveBinId = p.pool.lbPair.activeId;
  if (Math.abs(liveActiveBinId - b.activeBinId) > b.maxActiveBinSlippage) throw new ApiError(409, "Stale", "pool price moved; refresh before flipping");
  // The side comes from the price the caller chose bins against; bins the live price has since moved
  // into hold both tokens, so they are trimmed rather than failing the whole flip.
  const side = b.lowerBinId > b.activeBinId ? "x" : b.upperBinId < b.activeBinId ? "y" : null;
  if (!side) throw new ApiError(400, "Validation", "flip needs bins entirely above or below the pool price");
  const selection =
    side === "x"
      ? { lowerBinId: Math.max(b.lowerBinId, liveActiveBinId + 1), upperBinId: b.upperBinId }
      : { lowerBinId: b.lowerBinId, upperBinId: Math.min(b.upperBinId, liveActiveBinId - 1) };
  if (selection.lowerBinId > selection.upperBinId) throw new ApiError(409, "Stale", "pool price moved past the selected bins; refresh before flipping");

  // Remove floors each bin's share, so re-adding the full on-chain amount could exceed what came back.
  let withdrawn = 0n;
  for (const bin of (await readPositionData(p.pool, p.key)).positionBinData) {
    if (bin.binId < selection.lowerBinId || bin.binId > selection.upperBinId) continue;
    const amount = BigInt(side === "x" ? bin.positionXAmount : bin.positionYAmount);
    if (amount > 0n) withdrawn += amount - 1n;
  }
  const amount = await excludingTransferFee(env, side === "x" ? p.pool.tokenX : p.pool.tokenY, withdrawn);
  if (amount <= 0n) throw new ApiError(400, "Validation", "no liquidity in the selected bins");
  const [amountX, amountY] = side === "x" ? [amount, 0n] : [0n, amount];

  const setup = await pairStrategySetupIxs(c, pairOf(p.pool));
  const remove = [...vaultAtaIxs(c, p.pool), await removeLiquidityIx(c, p, 10_000, selection)];
  const add = await addLiquidityIxs(c, p.key, p.pool, selection, amountX, amountY, "bidAsk", b.maxActiveBinSlippage);
  const ixs = withoutRepeats([...setup, ...remove, ...add]);
  if (fitsInTransaction(env.payer, ixs)) {
    try {
      return await assemble(env, ixs);
    } catch (error) {
      if (!isComputeLimitError(error)) throw error;
    }
  }
  const head = setup.length ? [await assemble(env, setup)] : [];
  const removes = await exitChunks(c, selection, async (chunk) => [...vaultAtaIxs(c, p.pool), await removeLiquidityIx(c, p, 10_000, chunk)], setup.length > 0);
  const adds = await buildWideAddPlan(c, {
    position: p.key,
    pool: p.pool,
    ...selection,
    cursorBinId: selection.lowerBinId,
    activeBinId: liveActiveBinId,
    amountXBaseUnits: amountX,
    amountYBaseUnits: amountY,
    shape: "bidAsk",
    maxActiveBinSlippage: b.maxActiveBinSlippage,
    // The re-adds spend tokens the removes return, so none can be simulated before the removes land.
    deferFirstSimulation: true,
  });
  return refreshBatch(env, [...head, ...removes, ...adds]);
}

export async function buildDlmmClaimFee(env: BuildEnv, b: z.infer<typeof dlmmClaimFeeInput>): Promise<LocalStep | LocalStep[]> {
  const c = await loadDlmmCtx(env, b.vault);
  const p = await readOpenPosition(c, b.position);
  // A position opened before pair strategies were enforced needs them before fees can be claimed.
  const setup = await pairStrategySetupIxs(c, pairOf(p.pool));
  if (b.cursorBinId === undefined && widthOf(p) <= DLMM_INITIAL_POSITION_WIDTH) return assemble(env, [...setup, ...vaultAtaIxs(c, p.pool), await claimFeeIx(c, p)]);
  const lowerBinId = b.cursorBinId ?? p.lowerBinId;
  if (lowerBinId < p.lowerBinId || lowerBinId > p.upperBinId) throw new ApiError(400, "Validation", "cursor must be inside the position");
  const head = setup.length ? [await assemble(env, setup)] : [];
  const chunks = await exitChunks(
    c,
    { lowerBinId, upperBinId: p.upperBinId },
    async (chunk) => [...vaultAtaIxs(c, p.pool), await claimFeeIx(c, p, chunk)],
    setup.length > 0,
  );
  return [...head, ...chunks];
}

/**
 * Removes all liquidity, claims fees, and closes the position and its strategy: in one transaction for
 * a compact position, else range by range and then the close, in one batch.
 */
export async function buildDlmmClose(env: BuildEnv, b: z.infer<typeof dlmmCloseInput>): Promise<LocalStep | LocalStep[]> {
  const c = await loadDlmmCtx(env, b.vault);
  const p = await readOpenPosition(c, b.position);
  const pair = pairOf(p.pool);
  // A position opened before pair strategies were enforced needs them before it can be closed.
  const setup = await pairStrategySetupIxs(c, pair);
  const closeIx = await closeDlmmStrategyIx(env, c.vault, c.operator, p.key, pair);
  if (widthOf(p) <= DLMM_INITIAL_POSITION_WIDTH)
    return assemble(env, [...setup, ...vaultAtaIxs(c, p.pool), await removeLiquidityIx(c, p, 10_000), await claimFeeIx(c, p), closeIx]);
  const bins = await binsWithValue(p);
  const head = setup.length ? [await assemble(env, setup)] : [];
  const exits = bins.length
    ? await exitChunks(
        c,
        { lowerBinId: Math.min(...bins), upperBinId: Math.max(...bins) },
        async (chunk) => [...vaultAtaIxs(c, p.pool), await removeLiquidityIx(c, p, 10_000, chunk), await claimFeeIx(c, p, chunk)],
        setup.length > 0,
      )
    : [];
  const built = [...head, ...exits];
  built.push(await assemble(env, [closeIx], [], { deferSimulation: built.length > 0 }));
  return refreshBatch(env, built);
}
