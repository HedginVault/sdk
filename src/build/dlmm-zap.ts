import { type AddressLookupTableAccount, PublicKey, type TransactionInstruction } from "@solana/web3.js";
import { z } from "zod";
import { decodeTokenAmount } from "../chain/decode";
import { getAssociatedTokenAddress, getConfigPda, getStrategyPda } from "../chain/pda";
import { ApiError } from "../errors";
import { type Assembled, assemble, fitsInTransaction, isComputeLimitError, refreshBatch } from "./assemble";
import { amountString, assertOperator, type BuildEnv, DELEGATE_JUPITER, delegateFor, loadVaultCtx, pubkey, readTokenProgram } from "./context";
import {
  type BinRange,
  binsWithValue,
  claimFeeIx,
  DLMM_INITIAL_POSITION_WIDTH,
  DLMM_MAX_POSITION_WIDTH,
  type DlmmCtx,
  loadDlmmCtx,
  type OpenPosition,
  pairOf,
  readOpenPosition,
  removeLiquidityIx,
  vaultAtaIxs,
} from "./dlmm-ix";
import { DLMM_MAX_EXIT_BINS_PER_TX, nextBinChunk } from "./dlmm-wide";
import { jupiterInitializeIx } from "./jupiter-initialize";
import { jupiterSwapIx, jupiterTokenLedgerSwapIx } from "./jupiter-route";
import { maxSlippageBps, mintStillUsed, readOpenPairStrategies } from "./jupiter-swap";
import { excludingTransferFee, type Pool, type PositionData, readPositionData } from "./meteora";
import type { LocalStep } from "./registry";
import { closeDlmmStrategyIx, closeJupiterStrategyIx, type DlmmPair } from "./strategy";

const slippageBps = z.number().int().min(1).max(10_000);

export const dlmmZapOutInput = z.object({ vault: pubkey, position: pubkey, cursorBinId: z.number().int().optional(), slippageBps });
export const dlmmZapOutSwapInput = z.object({
  vault: pubkey,
  sources: z.array(z.object({ mint: pubkey, balanceBefore: amountString, closeWhenEmpty: z.boolean().optional() })).min(1).max(2),
  slippageBps,
});

type Token = Pool["tokenX"];

interface ZapIxs {
  ixs: TransactionInstruction[];
  lookupTables: AddressLookupTableAccount[];
  initializesStrategy: boolean;
}

/** 1 RPC: the requested slippage, capped by the protocol config. */
const cappedSlippage = async (env: BuildEnv, requested: number) =>
  Math.min(requested, maxSlippageBps(env, await env.connection.getAccountInfo(getConfigPda(env.programId))));

/** 0-1 RPC: the protocol lookup table when configured and active. Unset or inactive yields none, so transactions still build, only larger. */
async function protocolLookupTables(env: BuildEnv): Promise<AddressLookupTableAccount[]> {
  if (!env.protocolLookupTable) return [];
  const { value } = await env.connection.getAddressLookupTable(env.protocolLookupTable);
  return value?.isActive() ? [value] : [];
}

const tooLarge = (env: BuildEnv, message: string) =>
  new ApiError(422, "TransactionTooLarge", env.protocolLookupTable ? message : `${message}; set the protocolLookupTable option to shrink it`);

const jupiterStrategyExists = async (env: BuildEnv, vault: PublicKey, mint: PublicKey) =>
  (await env.connection.getAccountInfo(getStrategyPda(vault, mint, env.programId))) !== null;

/**
 * Wraps `produce`, instructions that pay `source` tokens into the vault, with Jupiter's token ledger:
 * the ledger snapshots the vault's source ATA before them and the swap spends only the increase, never
 * idle funds. The ledger account is shared across Jupiter users, so both halves stay in one transaction.
 */
async function ledgerSwapAround(
  c: DlmmCtx,
  source: Token,
  amountBaseUnits: bigint,
  slippage: number,
  strategyExists: boolean,
  produce: TransactionInstruction[],
): Promise<ZapIxs> {
  // Remove and claim pay the source mint into the vault, so the program requires its strategy either way.
  const initIxs = strategyExists ? [] : [await jupiterInitializeIx(c.env, c.vault, c.operator, source.publicKey)];
  if (amountBaseUnits === 0n) return { ixs: [...initIxs, ...produce], lookupTables: [], initializesStrategy: !strategyExists };
  const mints = { source: source.publicKey, destination: c.vault.depositMint, sourceTokenProgram: source.owner, destinationTokenProgram: c.vault.tokenProgram };
  const swap = await jupiterTokenLedgerSwapIx(c.env, c.vault, delegateFor(c.operator, DELEGATE_JUPITER), mints, amountBaseUnits, slippage);
  return {
    ixs: [...initIxs, ...swap.setup, swap.tokenLedgerInstruction, ...produce, swap.ix],
    lookupTables: swap.lookupTables,
    initializesStrategy: !strategyExists,
  };
}

/** The deposit mint's side of the pair, and the other side the zap sells. */
function zapSides(c: DlmmCtx, pool: Pool, message: string) {
  const depositIsX = pool.tokenX.publicKey.equals(c.vault.depositMint);
  if (!depositIsX && !pool.tokenY.publicKey.equals(c.vault.depositMint)) throw new ApiError(400, "Validation", message);
  return { sourceIsX: !depositIsX, source: depositIsX ? pool.tokenY : pool.tokenX };
}

/** The source-token base units `bpsToRemove` takes out of `range`, floored per bin like the on-chain remove. */
export function zapRemoveSourceAmount(
  bins: { binId: number; positionXAmount: string; positionYAmount: string }[],
  range: BinRange,
  bpsToRemove: number,
  sourceIsX: boolean,
): bigint {
  let amount = 0n;
  for (const bin of bins) {
    if (bin.binId < range.lowerBinId || bin.binId > range.upperBinId) continue;
    amount += (BigInt(sourceIsX ? bin.positionXAmount : bin.positionYAmount) * BigInt(bpsToRemove)) / 10_000n;
  }
  return amount;
}

/**
 * Removes `bpsToRemove` of one range and swaps the non-deposit token it returns in the same transaction.
 * Fees stay unclaimed and the position stays open. When Jupiter has no route (dust), the remove still
 * goes through and that token stays in the vault as an idle balance.
 */
async function removeZapIxs(c: DlmmCtx, p: OpenPosition, bpsToRemove: number, range: BinRange, slippage: number, jupiterStrategyInitialized: boolean): Promise<ZapIxs> {
  const { sourceIsX, source } = zapSides(c, p.pool, "zap needs the vault deposit mint to be one side of the DLMM pair");
  const atas = vaultAtaIxs(c, p.pool);
  const removeIx = await removeLiquidityIx(c, p, bpsToRemove, range);
  const plain = { ixs: [...atas, removeIx], lookupTables: [], initializesStrategy: false };
  const raw = zapRemoveSourceAmount((await readPositionData(p.pool, p.key)).positionBinData, range, bpsToRemove, sourceIsX);
  if (raw === 0n) return plain;
  const amount = await excludingTransferFee(c.env, source, raw);
  if (amount === 0n) return plain;
  const strategyExists = jupiterStrategyInitialized || (await jupiterStrategyExists(c.env, c.vault.key, source.publicKey));
  try {
    const swap = await ledgerSwapAround(c, source, amount, slippage, strategyExists, [removeIx]);
    return { ...swap, ixs: [...atas, ...swap.ixs] };
  } catch (error) {
    if (!(error instanceof ApiError && error.code === "JupiterQuoteFailed")) throw error;
    return plain;
  }
}

/**
 * `dlmm/remove` with `slippageBps`: every chunk removes its share and swaps the non-deposit token into
 * the deposit mint in the same transaction, so each swap spends only what its chunk returned.
 */
export async function zapRemove(
  c: DlmmCtx,
  p: OpenPosition,
  bpsToRemove: number,
  bounds: BinRange,
  cursorBinId: number | undefined,
  requestedSlippageBps: number,
  setup: TransactionInstruction[],
): Promise<LocalStep | LocalStep[]> {
  let lowerBinId = cursorBinId ?? bounds.lowerBinId;
  if (lowerBinId < bounds.lowerBinId || lowerBinId > bounds.upperBinId) throw new ApiError(400, "Validation", "cursor must be inside the selected bins");
  const slippage = await cappedSlippage(c.env, requestedSlippageBps);
  const protocolTables = await protocolLookupTables(c.env);
  const built: Assembled[] = setup.length ? [await assemble(c.env, setup)] : [];
  let jupiterStrategyInitialized = false;
  while (lowerBinId <= bounds.upperBinId) {
    for (let maxBins = DLMM_MAX_EXIT_BINS_PER_TX; ; ) {
      const range = nextBinChunk(lowerBinId, bounds.upperBinId, maxBins);
      const attemptedBins = range.upperBinId - range.lowerBinId + 1;
      const zap = await removeZapIxs(c, p, bpsToRemove, range, slippage, jupiterStrategyInitialized);
      const lookupTables = [...zap.lookupTables, ...protocolTables];
      if (fitsInTransaction(c.env.payer, zap.ixs, lookupTables)) {
        try {
          // Setup or an earlier chunk creates strategies this one needs; the send's preflight checks it.
          const step = await assemble(c.env, zap.ixs, lookupTables, { deferSimulation: setup.length > 0 || jupiterStrategyInitialized });
          built.push({ ...step, sendConcurrently: !zap.initializesStrategy });
          jupiterStrategyInitialized ||= zap.initializesStrategy;
          lowerBinId = range.upperBinId + 1;
          break;
        } catch (error) {
          if (!isComputeLimitError(error) || attemptedBins === 1) throw error;
        }
      } else if (attemptedBins === 1) {
        throw tooLarge(c.env, "one bin with its swap does not fit in a transaction for this pool");
      }
      maxBins = Math.max(1, Math.floor(attemptedBins / 2));
    }
  }
  // Quotes for many chunks take time; start the whole batch's blockhash lifetime together.
  const [only] = built;
  return built.length === 1 && only ? only : refreshBatch(c.env, built);
}

/** Quotes only the bins being removed, in the SDK's integer base units. */
function zapOutRangeAmounts(bins: PositionData["positionBinData"], range: BinRange, sourceIsX: boolean) {
  let positionAmount = 0n;
  let pendingFee = 0n;
  for (const bin of bins) {
    if (bin.binId < range.lowerBinId || bin.binId > range.upperBinId) continue;
    positionAmount += BigInt(sourceIsX ? bin.positionXAmount : bin.positionYAmount);
    pendingFee += BigInt(sourceIsX ? bin.positionFeeXAmount : bin.positionFeeYAmount);
  }
  return { positionAmount, pendingFee };
}

/** Remove and claim instructions for a zap, and the source-token amounts each returns to the vault. */
async function zapOutParts(c: DlmmCtx, p: OpenPosition, range?: BinRange) {
  const { sourceIsX, source } = zapSides(c, p.pool, "atomic zap out requires the vault deposit mint to be one side of the DLMM pair");
  const removeIx = await removeLiquidityIx(c, p, 10_000, range);
  const claimIx = await claimFeeIx(c, p, range);
  const data = await readPositionData(p.pool, p.key);
  const total = BigInt((sourceIsX ? data.totalXAmountExcludeTransferFee : data.totalYAmountExcludeTransferFee).toString());
  let positionAmount = total;
  let pendingFee = BigInt((sourceIsX ? data.feeXExcludeTransferFee : data.feeYExcludeTransferFee).toString());
  if (range) {
    const amounts = zapOutRangeAmounts(data.positionBinData, range, sourceIsX);
    positionAmount = await excludingTransferFee(c.env, source, amounts.positionAmount);
    pendingFee = await excludingTransferFee(c.env, source, amounts.pendingFee);
  }
  // A position still entirely in the deposit mint only closes. Its source-mint fees are dust that
  // Jupiter cannot route, so they stay in the vault as an idle balance instead of failing the zap.
  if (total === 0n) pendingFee = 0n;
  return { atas: vaultAtaIxs(c, p.pool), removeIx, claimIx, source, positionAmount, pendingFee };
}

/**
 * Remove, claim, a token-ledger Jupiter swap of what they returned, and the close (only for the whole
 * position). The ledger snapshots the vault's source ATA before remove and claim, so the swap spends
 * only tokens produced inside this transaction.
 */
async function zapOutIxs(c: DlmmCtx, p: OpenPosition, slippage: number, range?: BinRange, jupiterStrategyInitialized = false): Promise<ZapIxs> {
  const parts = await zapOutParts(c, p, range);
  const strategyExists = jupiterStrategyInitialized || (await jupiterStrategyExists(c.env, c.vault.key, parts.source.publicKey));
  const swap = await ledgerSwapAround(c, parts.source, parts.positionAmount + parts.pendingFee, slippage, strategyExists, [parts.removeIx, parts.claimIx]);
  // A wide position closes in the batch's last transaction, after every range.
  const closeIxs = range ? [] : [await closeDlmmStrategyIx(c.env, c.vault, c.operator, p.key, pairOf(p.pool))];
  return { ...swap, ixs: [...parts.atas, ...swap.ixs, ...closeIxs] };
}

/**
 * The same zap as three transactions for when the atomic one does not fit: remove and swap, claim and
 * swap, then close. Each swap shares its transaction with the instruction that funded it.
 */
async function zapOutSplitIxs(c: DlmmCtx, p: OpenPosition, slippage: number): Promise<ZapIxs[]> {
  const parts = await zapOutParts(c, p);
  const strategyExists = await jupiterStrategyExists(c.env, c.vault.key, parts.source.publicKey);
  const remove = await ledgerSwapAround(c, parts.source, parts.positionAmount, slippage, strategyExists, [parts.removeIx]);
  let claim: ZapIxs;
  try {
    claim = await ledgerSwapAround(c, parts.source, parts.pendingFee, slippage, strategyExists || remove.initializesStrategy, [parts.claimIx]);
  } catch (error) {
    // Jupiter has no route for dust. Claim anyway; the fee stays in the vault as an idle balance.
    if (!(error instanceof ApiError && error.code === "JupiterQuoteFailed")) throw error;
    claim = { ixs: [parts.claimIx], lookupTables: [], initializesStrategy: false };
  }
  const close = { ixs: [await closeDlmmStrategyIx(c.env, c.vault, c.operator, p.key, pairOf(p.pool))], lookupTables: [], initializesStrategy: false };
  return [{ ...remove, ixs: [...parts.atas, ...remove.ixs] }, claim, close];
}

/**
 * The token ledger swaps only what the zap itself returned, so dust and any earlier balance of the
 * non-deposit token stay behind. Once the position is closed, sell that leftover and close its Jupiter
 * strategy, unless another open position or limit order still needs it. 3 RPC.
 */
async function sweepAfterZap(c: DlmmCtx, closing: PublicKey, pair: DlmmPair, slippage: number): Promise<LocalStep["next"]> {
  const mint = pair.tokenXMint.equals(c.vault.depositMint) ? pair.tokenYMint : pair.tokenXMint;
  if (mint.equals(c.vault.depositMint)) return undefined;
  if (mintStillUsed(await readOpenPairStrategies(c.env, c.vault.key), mint.toBase58(), closing.toBase58())) return undefined;
  return { path: "jupiter/sweep", body: { vault: c.vault.key.toBase58(), mint: mint.toBase58(), slippageBps: slippage } };
}

/** Removes everything, claims fees, swaps the non-deposit token into the deposit mint, and closes the position. */
export async function buildDlmmZapOut(env: BuildEnv, b: z.infer<typeof dlmmZapOutInput>): Promise<LocalStep | LocalStep[]> {
  const c = await loadDlmmCtx(env, b.vault);
  const p = await readOpenPosition(c, b.position);
  const width = p.upperBinId - p.lowerBinId + 1;
  if (width < 1 || width > DLMM_MAX_POSITION_WIDTH) throw new ApiError(400, "Validation", `position must span 1 to ${DLMM_MAX_POSITION_WIDTH} bins`);
  const cursorBinId = b.cursorBinId ?? p.lowerBinId;
  if (cursorBinId < p.lowerBinId || cursorBinId > p.upperBinId) throw new ApiError(400, "Validation", "cursor must be inside the position");
  const slippage = await cappedSlippage(env, b.slippageBps);
  const protocolTables = await protocolLookupTables(env);
  const sweep = await sweepAfterZap(c, getStrategyPda(c.vault.key, p.key, env.programId), pairOf(p.pool), slippage);
  const withSweep = (batch: Assembled[]): LocalStep[] => batch.map((step, i) => (sweep && i === batch.length - 1 ? { ...step, next: sweep } : step));

  if (width > DLMM_INITIAL_POSITION_WIDTH || b.cursorBinId !== undefined) {
    const bins = await binsWithValue(p);
    const built: Assembled[] = [];
    let lowerBinId = Math.max(cursorBinId, Math.min(...bins));
    const lastBinId = Math.max(...bins);
    let jupiterStrategyInitialized = false;
    while (lowerBinId <= lastBinId) {
      for (let maxBins = DLMM_MAX_EXIT_BINS_PER_TX; ; ) {
        const range = nextBinChunk(lowerBinId, lastBinId, maxBins);
        const attemptedBins = range.upperBinId - range.lowerBinId + 1;
        const zap = await zapOutIxs(c, p, slippage, range, jupiterStrategyInitialized);
        const lookupTables = [...zap.lookupTables, ...protocolTables];
        if (fitsInTransaction(env.payer, zap.ixs, lookupTables)) {
          try {
            // A preceding range creates the Jupiter strategy; the send's preflight checks dependent ranges.
            const step = await assemble(env, zap.ixs, lookupTables, { deferSimulation: jupiterStrategyInitialized });
            built.push({ ...step, sendConcurrently: !zap.initializesStrategy });
            jupiterStrategyInitialized ||= zap.initializesStrategy;
            lowerBinId = range.upperBinId + 1;
            break;
          } catch (error) {
            if (!isComputeLimitError(error) || attemptedBins === 1) throw error;
          }
        } else if (attemptedBins === 1) {
          throw tooLarge(env, "A single-bin zap out does not fit in a Solana transaction");
        }
        maxBins = Math.max(1, Math.floor(attemptedBins / 2));
      }
    }
    built.push(await assemble(env, [await closeDlmmStrategyIx(env, c.vault, c.operator, p.key, pairOf(p.pool))], [], { deferSimulation: true }));
    // Quotes and simulations for a large position take time; start the batch's blockhash lifetime together.
    return withSweep(await refreshBatch(env, built));
  }

  const zap = await zapOutIxs(c, p, slippage);
  const lookupTables = [...zap.lookupTables, ...protocolTables];
  if (fitsInTransaction(env.payer, zap.ixs, lookupTables)) return withSweep([await assemble(env, zap.ixs, lookupTables)]);

  // Too large for one transaction, usually a long Jupiter route: remove+swap, claim+swap, close, sent in order.
  const steps = await zapOutSplitIxs(c, p, slippage);
  const built: Assembled[] = [];
  let jupiterStrategyInitialized = false;
  for (const [index, step] of steps.entries()) {
    const stepTables = [...step.lookupTables, ...protocolTables];
    if (!fitsInTransaction(env.payer, step.ixs, stepTables)) throw tooLarge(env, "Zap out does not fit in Solana transactions, even split in three");
    // The first step may create the Jupiter strategy, and the close needs an empty position.
    built.push(await assemble(env, step.ixs, stepTables, { deferSimulation: index === steps.length - 1 || jupiterStrategyInitialized }));
    jupiterStrategyInitialized ||= step.initializesStrategy;
  }
  return withSweep(await refreshBatch(env, built));
}

/** What this zap returned of the source, excluding tokens the vault already held. */
export function zapSwapAmount(currentBalance: bigint, balanceBefore: bigint): bigint {
  if (currentBalance < balanceBefore)
    throw new ApiError(409, "ZapBalanceChanged", "Vault token balance changed while the zap was in progress; the idle balance was not swapped");
  return currentBalance - balanceBefore;
}

/**
 * Swaps what a zap returned of its first source into the deposit mint, then continues with the rest.
 * Only a Jupiter strategy this zap created may be closed automatically.
 */
export async function buildDlmmZapOutSwap(env: BuildEnv, b: z.infer<typeof dlmmZapOutSwapInput>): Promise<LocalStep> {
  const vault = await loadVaultCtx(env, b.vault);
  const operator = await assertOperator(env, vault, env.payer);
  const delegate = delegateFor(operator, DELEGATE_JUPITER);
  const slippage = await cappedSlippage(env, b.slippageBps);
  const [source, ...rest] = [...new Map(b.sources.map((s) => [s.mint, s])).values()];
  if (!source) throw new ApiError(400, "Validation", "sources must not be empty");
  const sourceMint = new PublicKey(source.mint);
  if (sourceMint.equals(vault.depositMint)) throw new ApiError(400, "Validation", "zap source mint must differ from the vault deposit mint");
  const balanceBefore = BigInt(source.balanceBefore);
  const tokenProgram = await readTokenProgram(env, sourceMint);
  const [sourceInfo, strategyInfo] = await env.connection.getMultipleAccountsInfo([
    getAssociatedTokenAddress(vault.key, sourceMint, tokenProgram),
    getStrategyPda(vault.key, sourceMint, env.programId),
  ]);
  const amount = zapSwapAmount(decodeTokenAmount(sourceInfo?.data), balanceBefore);
  const strategyExists = strategyInfo !== null && strategyInfo !== undefined;
  const initIx = strategyExists ? null : await jupiterInitializeIx(env, vault, operator, sourceMint);
  // A pre-existing strategy or token balance is unrelated to this zap and must remain open.
  const closeWhenEmpty = source.closeWhenEmpty === true || (!strategyExists && balanceBefore === 0n);
  const closeIx = closeWhenEmpty ? await closeJupiterStrategyIx(env, vault, operator, sourceMint, tokenProgram) : null;
  const continueWith = (sources: typeof b.sources): LocalStep["next"] => (sources.length ? { path: "dlmm/zap-out/swap", body: { vault: b.vault, sources, slippageBps: slippage } } : undefined);
  const afterCurrent = continueWith(rest);
  // A follow-up builds only after confirmation, so it sees the post-swap zero balance and closes the strategy and ATA.
  const thenClose = closeIx ? continueWith([{ ...source, closeWhenEmpty: true }, ...rest]) : afterCurrent;

  // A one-sided position can return none of the non-deposit token; initializing and closing the strategy reclaims the ATA rent.
  if (amount === 0n) {
    if (!closeIx) throw new ApiError(409, "ZapNothingToSwap", "The position returned no new tokens; the existing idle balance was preserved");
    return { ...(await assemble(env, initIx ? [initIx, closeIx] : [closeIx])), next: afterCurrent };
  }
  const mints = { source: sourceMint, destination: vault.depositMint, sourceTokenProgram: tokenProgram, destinationTokenProgram: vault.tokenProgram };
  const { ix, lookupTables, setup } = await jupiterSwapIx(env, vault, delegate, mints, amount, slippage);
  const swapIxs = [...setup, ix];
  const full = [...(initIx ? [initIx] : []), ...swapIxs, ...(closeIx ? [closeIx] : [])];
  if (fitsInTransaction(env.payer, full, lookupTables)) return { ...(await assemble(env, full, lookupTables)), next: afterCurrent };
  if (initIx) {
    const initAndSwap = [initIx, ...swapIxs];
    if (fitsInTransaction(env.payer, initAndSwap, lookupTables)) return { ...(await assemble(env, initAndSwap, lookupTables)), next: thenClose };
    return { ...(await assemble(env, [initIx])), next: continueWith([{ ...source, closeWhenEmpty: true }, ...rest]) };
  }
  if (!fitsInTransaction(env.payer, swapIxs, lookupTables)) throw new ApiError(422, "TransactionTooLarge", "Jupiter swap does not fit in a v0 transaction");
  return { ...(await assemble(env, swapIxs, lookupTables)), next: thenClose };
}
