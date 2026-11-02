import { type AddressLookupTableAccount, PublicKey, type TransactionInstruction } from "@solana/web3.js";
import { z } from "zod";
import type { MinOut, ZapSource } from "../actions";
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
import { jupiterSwapIx, jupiterTokenLedgerSwapIx, minOutInput, protocolLookupTables } from "./jupiter-route";
import { maxSlippageBps, mintStillUsed, readOpenPairStrategies } from "./jupiter-swap";
import { excludingTransferFee, type Pool, type PositionData, readPositionData } from "./meteora";
import type { LocalStep } from "./registry";
import { closeDlmmStrategyIx, closeJupiterStrategyIx } from "./strategy";

const slippageBps = z.number().int().min(1).max(10_000);

export const dlmmZapOutInput = z.object({
  vault: pubkey,
  position: pubkey,
  cursorBinId: z.number().int().optional(),
  slippageBps,
  /** One of the pool's two mints, or the deposit mint, to end in. Defaults to the vault deposit mint. */
  outputMint: pubkey.optional(),
  /** The floor of the zap swap, and of the follow-up into the deposit mint for a pool without it. */
  minOut: minOutInput.optional(),
  followUpMinOut: minOutInput.optional(),
  /** Withdraw first and swap the returned non-deposit token after, in a transaction of its own, under `minOut`. */
  separateSwap: z.boolean().optional(),
});
export const dlmmZapOutSwapInput = z.object({
  vault: pubkey,
  sources: z
    .array(
      z.object({
        mint: pubkey,
        balanceBefore: amountString,
        closeWhenEmpty: z.boolean().optional(),
        minOut: minOutInput.optional(),
        /** The mint to swap into. Defaults to the vault deposit mint. */
        outputMint: pubkey.optional(),
      }),
    )
    .min(1)
    .max(2),
  slippageBps,
  /** Sells the vault's whole balance of this mint once every source is swapped. */
  sweepAfter: pubkey.optional(),
});

type Token = Pool["tokenX"];

interface ZapIxs {
  ixs: TransactionInstruction[];
  lookupTables: AddressLookupTableAccount[];
  initializesStrategy: boolean;
}

/** The pool token a zap sells, the one it ends in, and the non-deposit mint whose Jupiter strategy it may have to create first. */
interface ZapMints {
  source: Token;
  output: Token;
  pairMint: PublicKey;
}

/** 1 RPC: the requested slippage, capped by the protocol config. */
export const cappedSlippage = async (env: BuildEnv, requested: number) =>
  Math.min(requested, maxSlippageBps(env, await env.connection.getAccountInfo(getConfigPda(env.programId))));

const tooLarge = (env: BuildEnv, message: string) =>
  new ApiError(422, "TransactionTooLarge", env.protocolLookupTable ? message : `${message}; set the protocolLookupTable option to shrink it`);

const jupiterStrategyExists = async (env: BuildEnv, vault: PublicKey, mint: PublicKey) =>
  (await env.connection.getAccountInfo(getStrategyPda(vault, mint, env.programId))) !== null;

/** 1 RPC: the vault's balance of a pool token. */
export const vaultTokenBalance = async (c: DlmmCtx, token: Token) =>
  decodeTokenAmount((await c.env.connection.getAccountInfo(getAssociatedTokenAddress(c.vault.key, token.publicKey, token.owner)))?.data);

/** Continues a zap with the pre-zap balances needed to isolate tokens returned by the position. */
export const zapSwapNextStep = (b: { vault: string; slippageBps: number; sweepAfter?: string }, sources: ZapSource[]): LocalStep["next"] => ({
  path: "dlmm/zap-out/swap",
  body: { vault: b.vault, sources, slippageBps: b.slippageBps, ...(b.sweepAfter && { sweepAfter: b.sweepAfter }) },
});

const sweepNextStep = (vault: string, mint: string, slippage: number): LocalStep["next"] => ({ path: "jupiter/sweep", body: { vault, mint, slippageBps: slippage } });

/**
 * Wraps `produce`, instructions that pay `source` tokens into the vault, with Jupiter's token ledger:
 * the ledger snapshots the vault's source ATA before them and the swap spends only the increase, never
 * idle funds. The ledger account is shared across Jupiter users, so both halves stay in one transaction.
 * `alongside` is what else the caller puts in that transaction, so the route picked fits beside it.
 */
async function ledgerSwapAround(
  c: DlmmCtx,
  { source, output, pairMint }: ZapMints,
  amountBaseUnits: bigint,
  slippage: number,
  strategyExists: boolean,
  produce: TransactionInstruction[],
  minOut?: MinOut,
  alongside: TransactionInstruction[] = [],
): Promise<ZapIxs> {
  // Remove and claim pay the pair mint into the vault, so the program requires its strategy either way.
  const initIxs = strategyExists ? [] : [await jupiterInitializeIx(c.env, c.vault, c.operator, pairMint)];
  if (amountBaseUnits === 0n) return { ixs: [...initIxs, ...produce], lookupTables: [], initializesStrategy: !strategyExists };
  const mints = { source: source.publicKey, destination: output.publicKey, sourceTokenProgram: source.owner, destinationTokenProgram: output.owner };
  const swap = await jupiterTokenLedgerSwapIx(c.env, c.vault, delegateFor(c.operator, DELEGATE_JUPITER), mints, amountBaseUnits, slippage, minOut, [
    ...initIxs,
    ...produce,
    ...alongside,
  ]);
  return {
    ixs: [...initIxs, ...swap.setup, swap.tokenLedgerInstruction, ...produce, swap.ix],
    lookupTables: swap.lookupTables,
    initializesStrategy: !strategyExists,
  };
}

/** The zap swaps the pool side that is not `outputMint` into it; `outputMint` must be one of the two pool tokens. */
function zapMints(c: DlmmCtx, pool: Pool, outputMint: PublicKey, message: string): ZapMints & { sourceIsX: boolean } {
  const outputIsX = pool.tokenX.publicKey.equals(outputMint);
  if (!outputIsX && !pool.tokenY.publicKey.equals(outputMint)) throw new ApiError(400, "Validation", message);
  const source = outputIsX ? pool.tokenY : pool.tokenX;
  const output = outputIsX ? pool.tokenX : pool.tokenY;
  return { sourceIsX: !outputIsX, source, output, pairMint: source.publicKey.equals(c.vault.depositMint) ? output.publicKey : source.publicKey };
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
 * Removes `bpsToRemove` of one range and swaps the other pool token it returns into `outputMint`, one
 * of the two pool tokens, in the same transaction. Fees stay unclaimed and the position stays open.
 * When Jupiter has no route (dust), the remove still goes through and that token stays in the vault
 * as an idle balance.
 */
async function removeZapIxs(
  c: DlmmCtx,
  p: OpenPosition,
  bpsToRemove: number,
  range: BinRange,
  slippage: number,
  jupiterStrategyInitialized: boolean,
  outputMint: PublicKey,
  minOut?: MinOut,
): Promise<ZapIxs> {
  const mints = zapMints(c, p.pool, outputMint, "zap can only end in one of the pool's two tokens");
  const atas = vaultAtaIxs(c, p.pool);
  const removeIx = await removeLiquidityIx(c, p, bpsToRemove, range);
  const plain = { ixs: [...atas, removeIx], lookupTables: [], initializesStrategy: false };
  const raw = zapRemoveSourceAmount((await readPositionData(p.pool, p.key)).positionBinData, range, bpsToRemove, mints.sourceIsX);
  if (raw === 0n) return plain;
  const amount = await excludingTransferFee(c.env, mints.source, raw);
  if (amount === 0n) return plain;
  const strategyExists = jupiterStrategyInitialized || (await jupiterStrategyExists(c.env, c.vault.key, mints.pairMint));
  try {
    const swap = await ledgerSwapAround(c, mints, amount, slippage, strategyExists, [removeIx], minOut, atas);
    return { ...swap, ixs: [...atas, ...swap.ixs] };
  } catch (error) {
    if (!(error instanceof ApiError && error.code === "JupiterNoRoute")) throw error;
    return plain;
  }
}

/**
 * `dlmm/remove` with `slippageBps`: every chunk removes its share and swaps the other pool token into
 * `outputMint` in the same transaction, so each swap spends only what its chunk returned. `slippage`
 * is already capped.
 */
export async function zapRemove(
  c: DlmmCtx,
  p: OpenPosition,
  bpsToRemove: number,
  bounds: BinRange,
  cursorBinId: number | undefined,
  slippage: number,
  setup: TransactionInstruction[],
  outputMint: PublicKey,
  minOut?: MinOut,
): Promise<LocalStep | LocalStep[]> {
  let lowerBinId = cursorBinId ?? bounds.lowerBinId;
  if (lowerBinId < bounds.lowerBinId || lowerBinId > bounds.upperBinId) throw new ApiError(400, "Validation", "cursor must be inside the selected bins");
  const protocolTables = await protocolLookupTables(c.env);
  const built: Assembled[] = setup.length ? [await assemble(c.env, setup)] : [];
  let jupiterStrategyInitialized = false;
  while (lowerBinId <= bounds.upperBinId) {
    for (let maxBins = DLMM_MAX_EXIT_BINS_PER_TX; ; ) {
      const range = nextBinChunk(lowerBinId, bounds.upperBinId, maxBins);
      const attemptedBins = range.upperBinId - range.lowerBinId + 1;
      const zap = await removeZapIxs(c, p, bpsToRemove, range, slippage, jupiterStrategyInitialized, outputMint, minOut);
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

/**
 * Remove and claim instructions for a zap, and the source-token amounts each returns to the vault.
 * The zap swaps the pool side that is not `outputMint` into it. A non-deposit `outputMint` stays in
 * the vault in that token's Jupiter strategy.
 */
async function zapOutParts(c: DlmmCtx, p: OpenPosition, range: BinRange | undefined, outputMint: PublicKey) {
  const mints = zapMints(c, p.pool, outputMint, "zap out can only end in one of the pool's two tokens");
  const removeIx = await removeLiquidityIx(c, p, 10_000, range);
  const claimIx = await claimFeeIx(c, p, range);
  const data = await readPositionData(p.pool, p.key);
  const total = BigInt((mints.sourceIsX ? data.totalXAmountExcludeTransferFee : data.totalYAmountExcludeTransferFee).toString());
  let positionAmount = total;
  let pendingFee = BigInt((mints.sourceIsX ? data.feeXExcludeTransferFee : data.feeYExcludeTransferFee).toString());
  if (range) {
    const amounts = zapOutRangeAmounts(data.positionBinData, range, mints.sourceIsX);
    positionAmount = await excludingTransferFee(c.env, mints.source, amounts.positionAmount);
    pendingFee = await excludingTransferFee(c.env, mints.source, amounts.pendingFee);
  }
  // A position still entirely in the output mint only closes. Its source-mint fees are dust that
  // Jupiter cannot route, so they stay in the vault as an idle balance instead of failing the zap.
  const leavesSource = total === 0n && pendingFee !== 0n;
  if (total === 0n) pendingFee = 0n;
  return { ...mints, atas: vaultAtaIxs(c, p.pool), removeIx, claimIx, positionAmount, pendingFee, leavesSource };
}

/**
 * Remove, claim, a token-ledger Jupiter swap of what they returned, and the close (only for the whole
 * position). The ledger snapshots the vault's source ATA before remove and claim, so the swap spends
 * only tokens produced inside this transaction. With `separateSwap` nothing is swapped here: the
 * source stays in the vault for a follow-up swap.
 */
async function zapOutIxs(
  c: DlmmCtx,
  p: OpenPosition,
  slippage: number,
  range: BinRange | undefined,
  jupiterStrategyInitialized: boolean,
  outputMint: PublicKey,
  minOut: MinOut | undefined,
  separateSwap: boolean,
): Promise<ZapIxs & { leavesSource: boolean }> {
  const parts = await zapOutParts(c, p, range, outputMint);
  const zapAmount = parts.positionAmount + parts.pendingFee;
  const estimatedAmount = separateSwap ? 0n : zapAmount;
  const strategyExists = jupiterStrategyInitialized || (await jupiterStrategyExists(c.env, c.vault.key, parts.pairMint));
  const produce = [parts.removeIx, parts.claimIx];
  // A wide position closes in the batch's last transaction, after every range.
  const closeIxs = range ? [] : [await closeDlmmStrategyIx(c.env, c.vault, c.operator, p.key, pairOf(p.pool))];
  let leavesSource = parts.leavesSource || zapAmount !== estimatedAmount;
  let swap: ZapIxs;
  try {
    swap = await ledgerSwapAround(c, parts, estimatedAmount, slippage, strategyExists, produce, minOut, [...parts.atas, ...closeIxs]);
  } catch (error) {
    // A range holding only source-mint fees is dust Jupiter may not route; it stays idle for the sweep.
    if (!(error instanceof ApiError && error.code === "JupiterNoRoute" && parts.positionAmount === 0n)) throw error;
    swap = await ledgerSwapAround(c, parts, 0n, slippage, strategyExists, produce);
    leavesSource = true;
  }
  return { ...swap, ixs: [...parts.atas, ...swap.ixs, ...closeIxs], leavesSource };
}

/**
 * The same zap as three transactions for when the atomic one does not fit: remove and swap, claim and
 * swap, then close. Each swap shares its transaction with the instruction that funded it. With
 * `separateSwap` neither step swaps, like `zapOutIxs`.
 */
async function zapOutSplitIxs(
  c: DlmmCtx,
  p: OpenPosition,
  slippage: number,
  outputMint: PublicKey,
  minOut: MinOut | undefined,
  separateSwap: boolean,
): Promise<(ZapIxs & { leavesSource: boolean })[]> {
  const parts = await zapOutParts(c, p, undefined, outputMint);
  const liquidityAmount = separateSwap ? 0n : parts.positionAmount;
  const feeAmount = separateSwap ? 0n : parts.pendingFee;
  const strategyExists = await jupiterStrategyExists(c.env, c.vault.key, parts.pairMint);
  const remove = await ledgerSwapAround(c, parts, liquidityAmount, slippage, strategyExists, [parts.removeIx], minOut, parts.atas);
  let leavesSource = parts.leavesSource || (separateSwap && parts.positionAmount + parts.pendingFee !== 0n);
  let claim: ZapIxs;
  try {
    claim = await ledgerSwapAround(c, parts, feeAmount, slippage, strategyExists || remove.initializesStrategy, [parts.claimIx], minOut);
  } catch (error) {
    // Jupiter has no route for dust. Claim anyway; the fee stays in the vault as an idle balance.
    if (!(error instanceof ApiError && error.code === "JupiterNoRoute")) throw error;
    claim = { ixs: [parts.claimIx], lookupTables: [], initializesStrategy: false };
    leavesSource = true;
  }
  const close = { ixs: [await closeDlmmStrategyIx(c.env, c.vault, c.operator, p.key, pairOf(p.pool))], lookupTables: [], initializesStrategy: false };
  return [{ ...remove, ixs: [...parts.atas, ...remove.ixs] }, claim, close].map((step) => ({ ...step, leavesSource }));
}

/**
 * The non-deposit token this zap leaves a Jupiter strategy open for, unless another open position or
 * limit order still needs that strategy. `empty` when the vault holds none of it before the zap. The
 * zap swaps only what it returns, so the vault's earlier balance is exactly what a sweep sells. 2-4 RPC.
 */
async function leftoverAfterZap(c: DlmmCtx, closingStrategy: PublicKey, pool: Pool) {
  const token = pool.tokenX.publicKey.equals(c.vault.depositMint) ? pool.tokenY : pool.tokenX;
  const mint = token.publicKey;
  if (mint.equals(c.vault.depositMint) || mintStillUsed(await readOpenPairStrategies(c.env, c.vault.key), mint.toBase58(), closingStrategy.toBase58())) return undefined;
  const [ata, strategy] = await c.env.connection.getMultipleAccountsInfo([
    getAssociatedTokenAddress(c.vault.key, mint, token.owner),
    getStrategyPda(c.vault.key, mint, c.env.programId),
  ]);
  return { mint, tokenProgram: token.owner, empty: decodeTokenAmount(ata?.data) === 0n, strategyExists: strategy !== null && strategy !== undefined };
}

/**
 * Removes everything, claims fees, swaps the other pool token into `outputMint`, and closes the position.
 * A pool without the deposit mint ending in the deposit mint zaps into token Y, then a follow-up swaps
 * what that returned into the deposit mint.
 */
export async function buildDlmmZapOut(env: BuildEnv, b: z.infer<typeof dlmmZapOutInput>): Promise<LocalStep | LocalStep[]> {
  const c = await loadDlmmCtx(env, b.vault);
  const p = await readOpenPosition(c, b.position);
  const width = p.upperBinId - p.lowerBinId + 1;
  if (width < 1 || width > DLMM_MAX_POSITION_WIDTH) throw new ApiError(400, "Validation", `position must span 1 to ${DLMM_MAX_POSITION_WIDTH} bins`);
  const cursorBinId = b.cursorBinId ?? p.lowerBinId;
  if (cursorBinId < p.lowerBinId || cursorBinId > p.upperBinId) throw new ApiError(400, "Validation", "cursor must be inside the position");
  const slippage = await cappedSlippage(env, b.slippageBps);
  const protocolTables = await protocolLookupTables(env);
  const { tokenX, tokenY } = p.pool;
  const depositMint = c.vault.depositMint;
  const depositInPool = tokenX.publicKey.equals(depositMint) || tokenY.publicKey.equals(depositMint);
  const requested = b.outputMint ? new PublicKey(b.outputMint) : depositMint;
  const toDeposit = requested.equals(depositMint);
  if (!toDeposit && !requested.equals(tokenX.publicKey) && !requested.equals(tokenY.publicKey))
    throw new ApiError(400, "Validation", "zap out can only end in one of the pool's tokens or the deposit token");
  // A pool without the deposit mint zaps into token Y first. A follow-up swaps only the token Y this
  // zap returned into the deposit mint, measured against the vault's balance before it.
  const outputMint = toDeposit && !depositInPool ? tokenY.publicKey : requested;
  const followUpSources: ZapSource[] =
    toDeposit && !depositInPool
      ? [{ mint: outputMint.toBase58(), balanceBefore: (await vaultTokenBalance(c, tokenY)).toString(), ...(b.followUpMinOut && { minOut: b.followUpMinOut }) }]
      : [];
  // Ending in a non-deposit token keeps it in its Jupiter strategy, so there is nothing to sweep or close.
  const leftover = toDeposit && depositInPool ? await leftoverAfterZap(c, getStrategyPda(c.vault.key, p.key, env.programId), p.pool) : undefined;
  // The vault held none of the token, so a zap that swaps everything it returns leaves the strategy
  // empty and can close it in this approval. Otherwise a sweep sells what is left once this lands.
  const closeJupiter = leftover?.empty ? await closeJupiterStrategyIx(env, c.vault, c.operator, leftover.mint, leftover.tokenProgram) : null;
  // A separate swap measures the source the zap returned against the balance before it, so the
  // deposit token, whose idle balance deposits and withdrawals move, always swaps inside the zap.
  const source = outputMint.equals(tokenX.publicKey) ? tokenY : tokenX;
  const separateSwap = b.separateSwap === true && !source.publicKey.equals(depositMint);
  const separateNext = separateSwap
    ? zapSwapNextStep({ vault: b.vault, slippageBps: slippage, ...(leftover && !leftover.empty && { sweepAfter: leftover.mint.toBase58() }) }, [
        {
          mint: source.publicKey.toBase58(),
          balanceBefore: (await vaultTokenBalance(c, source)).toString(),
          ...(b.minOut && { minOut: b.minOut }),
          ...(!outputMint.equals(depositMint) && { outputMint: outputMint.toBase58() }),
          // the strategy held none before this zap, so it closes once the swap spends what it returned
          ...(leftover?.empty && { closeWhenEmpty: true }),
        },
        ...followUpSources,
      ])
    : undefined;
  const followUpSwap = followUpSources.length ? zapSwapNextStep({ vault: b.vault, slippageBps: slippage }, followUpSources) : undefined;
  const finish = (batch: Assembled[], closedJupiter: boolean): LocalStep[] => {
    const next = separateNext ?? followUpSwap ?? (leftover && !closedJupiter ? sweepNextStep(b.vault, leftover.mint.toBase58(), slippage) : undefined);
    return next ? batch.map((step, index) => (index === batch.length - 1 ? { ...step, next } : step)) : batch;
  };

  if (width > DLMM_INITIAL_POSITION_WIDTH || b.cursorBinId !== undefined) {
    // A retry after a partial exit only revisits bins that still hold liquidity, fees, or rewards.
    const bins = await binsWithValue(p);
    const built: Assembled[] = [];
    let lowerBinId = Math.max(cursorBinId, Math.min(...bins));
    const lastBinId = Math.max(...bins);
    let jupiterStrategyInitialized = false;
    let leavesSource = false;
    while (lowerBinId <= lastBinId) {
      for (let maxBins = DLMM_MAX_EXIT_BINS_PER_TX; ; ) {
        const range = nextBinChunk(lowerBinId, lastBinId, maxBins);
        const attemptedBins = range.upperBinId - range.lowerBinId + 1;
        const zap = await zapOutIxs(c, p, slippage, range, jupiterStrategyInitialized, outputMint, b.minOut, separateSwap);
        const lookupTables = [...zap.lookupTables, ...protocolTables];
        if (fitsInTransaction(env.payer, zap.ixs, lookupTables)) {
          try {
            // A preceding range creates the Jupiter strategy; the send's preflight checks dependent ranges.
            const step = await assemble(env, zap.ixs, lookupTables, { deferSimulation: jupiterStrategyInitialized });
            built.push({ ...step, sendConcurrently: !zap.initializesStrategy });
            jupiterStrategyInitialized ||= zap.initializesStrategy;
            leavesSource ||= zap.leavesSource;
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
    const closeIx = await closeDlmmStrategyIx(env, c.vault, c.operator, p.key, pairOf(p.pool));
    // A retry with nothing left to remove creates no strategy, so there may be none to close or sweep.
    const hasJupiterStrategy = jupiterStrategyInitialized || leftover?.strategyExists === true;
    const closesJupiter = closeJupiter !== null && !leavesSource && hasJupiterStrategy;
    built.push(await assemble(env, closeJupiter && closesJupiter ? [closeIx, closeJupiter] : [closeIx], [], { deferSimulation: true }));
    // Quotes and simulations for a large position take time; start the batch's blockhash lifetime together.
    return finish(await refreshBatch(env, built), closesJupiter || !hasJupiterStrategy);
  }

  const zap = await zapOutIxs(c, p, slippage, undefined, false, outputMint, b.minOut, separateSwap);
  const lookupTables = [...zap.lookupTables, ...protocolTables];
  const closesJupiter = closeJupiter !== null && !zap.leavesSource;
  if (closeJupiter && closesJupiter && fitsInTransaction(env.payer, [...zap.ixs, closeJupiter], lookupTables)) return assemble(env, [...zap.ixs, closeJupiter], lookupTables);
  if (fitsInTransaction(env.payer, zap.ixs, lookupTables)) {
    const step = await assemble(env, zap.ixs, lookupTables);
    if (!closeJupiter || !closesJupiter) return finish([step], false);
    // The close runs after the zap confirmed, so the send's preflight simulates it instead.
    return refreshBatch(env, [step, await assemble(env, [closeJupiter], [], { deferSimulation: true })]);
  }

  // Too large for one transaction, usually a long Jupiter route: remove+swap, claim+swap, close, sent in order.
  const steps = await zapOutSplitIxs(c, p, slippage, outputMint, b.minOut, separateSwap);
  const splitClosesJupiter = closeJupiter !== null && !steps.some((step) => step.leavesSource);
  const built: Assembled[] = [];
  let jupiterStrategyInitialized = false;
  for (const [index, step] of steps.entries()) {
    const last = index === steps.length - 1;
    const ixs = last && closeJupiter && splitClosesJupiter ? [...step.ixs, closeJupiter] : step.ixs;
    const stepTables = [...step.lookupTables, ...protocolTables];
    if (!fitsInTransaction(env.payer, ixs, stepTables)) throw tooLarge(env, "Zap out does not fit in Solana transactions, even split in three");
    // The first step may create the Jupiter strategy, and the close needs an empty position.
    built.push(await assemble(env, ixs, stepTables, { deferSimulation: last || jupiterStrategyInitialized }));
    jupiterStrategyInitialized ||= step.initializesStrategy;
  }
  return finish(await refreshBatch(env, built), splitClosesJupiter);
}

/** What this zap returned of the source, excluding tokens the vault already held. */
export function zapSwapAmount(currentBalance: bigint, balanceBefore: bigint): bigint {
  if (currentBalance < balanceBefore)
    throw new ApiError(409, "ZapBalanceChanged", "Vault token balance changed while the zap was in progress; the idle balance was not swapped");
  return currentBalance - balanceBefore;
}

/**
 * Swaps what a zap returned of its first source into its output mint, the deposit mint by default,
 * then continues with the rest, and once none is left sweeps `sweepAfter`. Only a Jupiter strategy
 * this zap created may be closed automatically.
 */
export async function buildDlmmZapOutSwap(env: BuildEnv, b: z.infer<typeof dlmmZapOutSwapInput>): Promise<LocalStep> {
  const vault = await loadVaultCtx(env, b.vault);
  const operator = await assertOperator(env, vault, env.payer);
  const delegate = delegateFor(operator, DELEGATE_JUPITER);
  const slippage = await cappedSlippage(env, b.slippageBps);
  const [source, ...rest] = [...new Map(b.sources.map((s) => [s.mint, s])).values()];
  if (!source) throw new ApiError(400, "Validation", "sources must not be empty");
  const sourceMint = new PublicKey(source.mint);
  const outputMint = source.outputMint ? new PublicKey(source.outputMint) : vault.depositMint;
  if (sourceMint.equals(vault.depositMint)) throw new ApiError(400, "Validation", "zap source mint must differ from the vault deposit mint");
  if (sourceMint.equals(outputMint)) throw new ApiError(400, "Validation", "zap source mint must differ from its output mint");
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
  const again = (sources: typeof b.sources) => zapSwapNextStep({ vault: b.vault, slippageBps: slippage, ...(b.sweepAfter && { sweepAfter: b.sweepAfter }) }, sources);
  const afterCurrent = rest.length ? again(rest) : b.sweepAfter ? sweepNextStep(b.vault, b.sweepAfter, slippage) : undefined;
  // A follow-up builds only after confirmation, so it sees the post-swap zero balance and closes the strategy and ATA.
  const thenClose = closeIx ? again([{ ...source, closeWhenEmpty: true }, ...rest]) : afterCurrent;

  // A one-sided position can return none of the non-deposit token; initializing and closing the strategy reclaims the ATA rent.
  if (amount === 0n) {
    if (!closeIx) throw new ApiError(409, "ZapNothingToSwap", "The position returned no new tokens; the existing idle balance was preserved");
    return { ...(await assemble(env, initIx ? [initIx, closeIx] : [closeIx])), next: afterCurrent };
  }
  const destinationTokenProgram = outputMint.equals(vault.depositMint) ? vault.tokenProgram : await readTokenProgram(env, outputMint);
  const mints = { source: sourceMint, destination: outputMint, sourceTokenProgram: tokenProgram, destinationTokenProgram };
  const { ix, lookupTables, setup } = await jupiterSwapIx(env, vault, delegate, mints, amount, slippage, source.minOut);
  const swapIxs = [...setup, ix];
  const full = [...(initIx ? [initIx] : []), ...swapIxs, ...(closeIx ? [closeIx] : [])];
  if (fitsInTransaction(env.payer, full, lookupTables)) return { ...(await assemble(env, full, lookupTables)), next: afterCurrent };
  if (initIx) {
    const initAndSwap = [initIx, ...swapIxs];
    if (fitsInTransaction(env.payer, initAndSwap, lookupTables)) return { ...(await assemble(env, initAndSwap, lookupTables)), next: thenClose };
    return { ...(await assemble(env, [initIx])), next: again([{ ...source, closeWhenEmpty: true }, ...rest]) };
  }
  if (!fitsInTransaction(env.payer, swapIxs, lookupTables)) throw new ApiError(422, "TransactionTooLarge", "Jupiter swap does not fit in a v0 transaction");
  return { ...(await assemble(env, swapIxs, lookupTables)), next: thenClose };
}
