import { BN, type IdlAccounts, type IdlTypes } from "@coral-xyz/anchor";
import { Keypair, PublicKey, SYSVAR_RENT_PUBKEY, type TransactionInstruction } from "@solana/web3.js";
import type { DlmmShape } from "../actions";
import { getAssociatedTokenAddress, getConfigPda, getStrategyPda } from "../chain/pda";
import { ApiError } from "../errors";
import type { HedgeVault } from "../idl/hedge_vault";
import { assertOperator, type BuildEnv, DELEGATE_METEORA_DLMM, delegateFor, loadVaultCtx, type Operator, type VaultCtx } from "./context";
import { jupiterInitializeIx } from "./jupiter-initialize";
import { createAtaIdempotentIx } from "./jupiter-route";
import { meteora, missingBinArrayIxs, type Pool, readPool, readPositionData } from "./meteora";
import { DLMM_EVENT_AUTHORITY, DLMM_PROGRAM_ID, type DlmmPair, LIMIT_ORDER_DISCRIMINATOR } from "./strategy";

const MEMO_PROGRAM_ID = new PublicKey("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr");

/** The app's position limits: one initialize creates up to 70 bins, extends add up to 91, and a position spans at most 1,400. */
export const DLMM_INITIAL_POSITION_WIDTH = 70;
export const DLMM_MAX_POSITION_WIDTH = 1_400;
export const DLMM_MAX_RESIZE_LENGTH = 91;
export const DLMM_MAX_LIMIT_ORDER_BINS = 50;

type RemainingAccountsInfo = IdlTypes<HedgeVault>["remainingAccountsInfo"];
type PositionAccount = IdlAccounts<HedgeVault>["positionV2"];

/** Both ends inclusive, as a position account stores them. */
export interface BinRange {
  lowerBinId: number;
  upperBinId: number;
}

/** What every DLMM instruction of one build shares: the vault, who signs, and the delegate account the DLMM bit allows. */
export interface DlmmCtx {
  env: BuildEnv;
  vault: VaultCtx;
  operator: Operator;
  delegate: PublicKey | null;
}

/** An existing position with the pool it sits in, read once per build. */
export interface OpenPosition extends BinRange {
  key: PublicKey;
  pool: Pool;
}

/** 3 RPC. A delegate without the Meteora DLMM permission fails here, before any pool read. */
export async function loadDlmmCtx(env: BuildEnv, address: string): Promise<DlmmCtx> {
  const vault = await loadVaultCtx(env, address);
  const operator = await assertOperator(env, vault, env.payer);
  return { env, vault, operator, delegate: delegateFor(operator, DELEGATE_METEORA_DLMM) };
}

/** 1 RPC: a position this vault owns. */
export async function readPositionAccount(c: DlmmCtx, position: PublicKey): Promise<PositionAccount> {
  const info = await c.env.connection.getAccountInfo(position);
  if (!info?.owner.equals(DLMM_PROGRAM_ID)) throw new ApiError(404, "NotFound", "Position not found");
  const account = c.env.program.coder.accounts.decode<PositionAccount>("positionV2", info.data);
  if (!account.owner.equals(c.vault.key)) throw new ApiError(403, "Denied", "position does not belong to this vault");
  return account;
}

/** 1 RPC for the position, then ~3 for its pool. */
export async function readOpenPosition(c: DlmmCtx, address: string): Promise<OpenPosition> {
  const key = new PublicKey(address);
  const account = await readPositionAccount(c, key);
  return { key, lowerBinId: account.lowerBinId, upperBinId: account.upperBinId, pool: await readPool(c.env, account.lbPair) };
}

/** The bins still holding liquidity, fees or rewards, so a retry after a partial exit revisits only those. */
export async function binsWithValue(p: OpenPosition): Promise<number[]> {
  return (await readPositionData(p.pool, p.key)).positionBinData
    .filter((bin) =>
      [bin.positionXAmount, bin.positionYAmount, bin.positionFeeXAmount, bin.positionFeeYAmount, ...bin.positionRewardAmount].some((amount) => BigInt(amount) !== 0n),
    )
    .map((bin) => bin.binId);
}

/** 1 RPC: the pool a limit order rests in. The hedge_vault IDL has no LimitOrder account; its lb_pair follows the discriminator. */
export async function readLimitOrderLbPair(env: BuildEnv, limitOrder: PublicKey): Promise<PublicKey> {
  const info = await env.connection.getAccountInfo(limitOrder);
  if (!info) throw new ApiError(404, "NotFound", "Limit order not found");
  if (!info.owner.equals(DLMM_PROGRAM_ID) || info.data.length < 40 || !info.data.subarray(0, 8).equals(LIMIT_ORDER_DISCRIMINATOR))
    throw new ApiError(400, "Validation", "Account is not a DLMM limit order");
  return new PublicKey(info.data.subarray(8, 40));
}

export const pairOf = (pool: Pool): DlmmPair => ({ lbPair: pool.pubkey, tokenXMint: pool.tokenX.publicKey, tokenYMint: pool.tokenY.publicKey });

/**
 * The keeper values a vault only from its strategy records, so the program refuses every DLMM action
 * unless each pair mint other than the deposit mint has the vault's Jupiter strategy. `null` is Anchor's
 * `None` for the deposit mint side.
 */
const pairStrategyAccounts = (c: DlmmCtx, pair: DlmmPair) => {
  const of = (mint: PublicKey) => (mint.equals(c.vault.depositMint) ? null : getStrategyPda(c.vault.key, mint, c.env.programId));
  return { strategyX: of(pair.tokenXMint), strategyY: of(pair.tokenYMint) };
};

/** Jupiter strategy initializations for the pair mints that still lack one (1 RPC), to run before the DLMM instruction. */
export async function pairStrategySetupIxs(c: DlmmCtx, pair: DlmmPair): Promise<TransactionInstruction[]> {
  const mints = [pair.tokenXMint, pair.tokenYMint].filter((mint, i, all) => !mint.equals(c.vault.depositMint) && all.findIndex((m) => m.equals(mint)) === i);
  if (mints.length === 0) return [];
  const infos = await c.env.connection.getMultipleAccountsInfo(mints.map((mint) => getStrategyPda(c.vault.key, mint, c.env.programId)));
  return Promise.all(mints.filter((_, i) => !infos[i]).map((mint) => jupiterInitializeIx(c.env, c.vault, c.operator, mint)));
}

/** The vault's token accounts for both pair mints, created idempotently: remove, claim and add pay into them. */
export const vaultAtaIxs = (c: DlmmCtx, pool: Pool) =>
  [pool.tokenX, pool.tokenY].map((t) => createAtaIdempotentIx(c.env.payer, c.vault.key, t.publicKey, t.owner));

/** The accounts and remaining accounts of every liquidity instruction over `range` of `position`. No I/O. */
function liquidityAccounts(c: DlmmCtx, position: PublicKey, pool: Pool, range: BinRange) {
  const hookX = pool.tokenX.transferHookAccountMetas;
  const hookY = pool.tokenY.transferHookAccountMetas;
  const remainingAccountsInfo: RemainingAccountsInfo = {
    slices: [
      { accountsType: { transferHookX: {} }, length: hookX.length },
      { accountsType: { transferHookY: {} }, length: hookY.length },
    ],
  };
  const binArrays = meteora().getBinArrayAccountMetasCoverage(new BN(range.lowerBinId), new BN(range.upperBinId), pool.pubkey, DLMM_PROGRAM_ID);
  const accounts = {
    authority: c.env.payer,
    config: getConfigPda(c.env.programId),
    vault: c.vault.key,
    position,
    lbPair: pool.pubkey,
    binArrayBitmapExtension: pool.binArrayBitmapExtension?.publicKey ?? null,
    reserveX: pool.lbPair.reserveX,
    reserveY: pool.lbPair.reserveY,
    tokenXMint: pool.tokenX.publicKey,
    tokenYMint: pool.tokenY.publicKey,
    tokenXProgram: pool.tokenX.owner,
    tokenYProgram: pool.tokenY.owner,
    strategy: getStrategyPda(c.vault.key, position, c.env.programId),
    ...pairStrategyAccounts(c, pairOf(pool)),
    eventAuthority: DLMM_EVENT_AUTHORITY,
    memoProgram: MEMO_PROGRAM_ID,
    delegate: c.delegate,
  };
  return { accounts, remainingAccountsInfo, remainingAccounts: [...hookX, ...hookY, ...binArrays] };
}

/** `upperBinIdExclusive` because the program forwards `upper - lower` to DLMM as the bin count. The caller signs for the new keypair. */
export async function initializePositionIx(c: DlmmCtx, pair: DlmmPair, lowerBinId: number, upperBinIdExclusive: number) {
  const position = Keypair.generate();
  const ix = await c.env.program.methods
    .meteoraDlmmInitializePosition(lowerBinId, upperBinIdExclusive)
    .accounts({
      authority: c.env.payer,
      config: getConfigPda(c.env.programId),
      vault: c.vault.key,
      ...pairStrategyAccounts(c, pair),
      position: position.publicKey,
      lbPair: pair.lbPair,
      eventAuthority: DLMM_EVENT_AUTHORITY,
      // The IDL carries no address constraint for this account, so Anchor cannot resolve it.
      dlmmProgram: DLMM_PROGRAM_ID,
      delegate: c.delegate,
    })
    .instruction();
  return { ix, position };
}

/** Extends a vault-owned position on its upper side by one Meteora-safe resize step. */
export const extendPositionIx = (c: DlmmCtx, position: PublicKey, pair: DlmmPair, binsToAdd: number) =>
  c.env.program.methods
    .meteoraDlmmExtendPosition(binsToAdd)
    .accounts({
      authority: c.env.payer,
      config: getConfigPda(c.env.programId),
      vault: c.vault.key,
      ...pairStrategyAccounts(c, pair),
      position,
      lbPair: pair.lbPair,
      eventAuthority: DLMM_EVENT_AUTHORITY,
      delegate: c.delegate,
    })
    .instruction();

/**
 * Adds liquidity over an inclusive range of a position that may not exist on chain yet, with the vault
 * ATAs first. `maxActiveBinSlippage` bounds how far the pool may move from `pool.lbPair.activeId`,
 * the active bin this build read.
 */
export async function addLiquidityIxs(
  c: DlmmCtx,
  position: PublicKey,
  pool: Pool,
  range: BinRange,
  amountXBaseUnits: bigint,
  amountYBaseUnits: bigint,
  shape: DlmmShape,
  maxActiveBinSlippage: number,
): Promise<TransactionInstruction[]> {
  const { accounts, remainingAccountsInfo, remainingAccounts } = liquidityAccounts(c, position, pool, range);
  const { StrategyType, toStrategyParameters } = meteora();
  const strategyType = { spot: StrategyType.Spot, curve: StrategyType.Curve, bidAsk: StrategyType.BidAsk }[shape];
  const ix = await c.env.program.methods
    .meteoraDlmmAddLiquidity({
      liquidityParameter: {
        amountX: new BN(amountXBaseUnits.toString()),
        amountY: new BN(amountYBaseUnits.toString()),
        activeId: pool.lbPair.activeId,
        maxActiveBinSlippage,
        strategyParameters: toStrategyParameters({ minBinId: range.lowerBinId, maxBinId: range.upperBinId, strategyType }),
      },
      remainingAccountsInfo,
    })
    .accounts(accounts)
    .remainingAccounts(remainingAccounts)
    .instruction();
  return [...vaultAtaIxs(c, pool), ix];
}

/** Removes `bpsToRemove` of `range`, or of the whole position. */
export async function removeLiquidityIx(c: DlmmCtx, p: OpenPosition, bpsToRemove: number, range?: BinRange) {
  const { accounts, remainingAccountsInfo, remainingAccounts } = liquidityAccounts(c, p.key, p.pool, range ?? p);
  const method = range
    ? c.env.program.methods.meteoraDlmmRemoveLiquidityRange({ bpsToRemove, remainingAccountsInfo }, range.lowerBinId, range.upperBinId)
    : c.env.program.methods.meteoraDlmmRemoveLiquidity({ bpsToRemove, remainingAccountsInfo });
  return method.accounts(accounts).remainingAccounts(remainingAccounts).instruction();
}

/** Claims the swap fees of `range`, or of the whole position. */
export async function claimFeeIx(c: DlmmCtx, p: OpenPosition, range?: BinRange) {
  const { accounts, remainingAccountsInfo, remainingAccounts } = liquidityAccounts(c, p.key, p.pool, range ?? p);
  const method = range
    ? c.env.program.methods.meteoraDlmmClaimFeeRange(remainingAccountsInfo, range.lowerBinId, range.upperBinId)
    : c.env.program.methods.meteoraDlmmClaimFee(remainingAccountsInfo);
  return method.accounts(accounts).remainingAccounts(remainingAccounts).instruction();
}

export interface LimitOrderBin {
  binId: number;
  /** Base units of the token the order sells. */
  amountBaseUnits: bigint;
}

/**
 * A limit order owned by the vault: an ask rests token X above the active bin, a bid token Y below it.
 * The order account is a fresh keypair the DLMM program initializes, so the caller signs for it.
 * `setupIxs` create the bin arrays (and bitmap extension) the bins need and may go in an earlier transaction.
 */
export async function placeLimitOrderIxs(c: DlmmCtx, pool: Pool, isAskSide: boolean, bins: LimitOrderBin[]) {
  const limitOrder = Keypair.generate();
  const token = isAskSide ? pool.tokenX : pool.tokenY;
  const vaultToken = getAssociatedTokenAddress(c.vault.key, token.publicKey, token.owner);
  const { binArrayIndexes, binArrayAccountMetas, binArrayBitmapExtension } = meteora().getBinArrayInfoForNonContiguousBinIds(
    bins.map((b) => b.binId),
    DLMM_PROGRAM_ID,
    pool.pubkey,
  );
  const setupIxs = await missingBinArrayIxs(c.env, pool, binArrayIndexes);
  // Bins outside the pair's default bitmap need the extension account, created once per pool. The SDK
  // hands back the DLMM program id (Anchor's None) when the bins fit the default bitmap.
  const needsExtension = !binArrayBitmapExtension.equals(DLMM_PROGRAM_ID);
  if (needsExtension && !pool.binArrayBitmapExtension)
    setupIxs.push(
      await pool.program.methods
        .initializeBinArrayBitmapExtension()
        .accountsPartial({ binArrayBitmapExtension, funder: c.env.payer, lbPair: pool.pubkey, rent: SYSVAR_RENT_PUBKEY })
        .instruction(),
    );
  const remainingAccountsInfo: RemainingAccountsInfo = {
    slices: [{ accountsType: isAskSide ? { transferHookX: {} } : { transferHookY: {} }, length: token.transferHookAccountMetas.length }],
  };
  const ix = await c.env.program.methods
    .meteoraDlmmPlaceLimitOrder(
      { isAskSide, padding: Array(16).fill(0), relativeBin: null, bins: bins.map((b) => ({ id: b.binId, amount: new BN(b.amountBaseUnits.toString()) })) },
      remainingAccountsInfo,
    )
    .accountsPartial({
      authority: c.env.payer,
      config: getConfigPda(c.env.programId),
      vault: c.vault.key,
      strategy: getStrategyPda(c.vault.key, limitOrder.publicKey, c.env.programId),
      ...pairStrategyAccounts(c, pairOf(pool)),
      vaultToken,
      limitOrder: limitOrder.publicKey,
      lbPair: pool.pubkey,
      binArrayBitmapExtension: needsExtension ? binArrayBitmapExtension : null,
      reserve: isAskSide ? pool.lbPair.reserveX : pool.lbPair.reserveY,
      tokenMint: token.publicKey,
      tokenProgram: token.owner,
      eventAuthority: DLMM_EVENT_AUTHORITY,
      dlmmProgram: DLMM_PROGRAM_ID,
      delegate: c.delegate,
    })
    .remainingAccounts([...token.transferHookAccountMetas, ...binArrayAccountMetas])
    .instruction();
  // The program expects the vault's token account to exist; the deposit mint's always does.
  return { setupIxs, placeIxs: [createAtaIdempotentIx(c.env.payer, c.vault.key, token.publicKey, token.owner), ix], limitOrder };
}

/** Cancels `binIds` of a vault-owned limit order; DLMM pays unfilled amounts, proceeds and fees into the vault ATAs. */
export async function cancelLimitOrderIx(c: DlmmCtx, pool: Pool, limitOrder: PublicKey, binIds: number[]) {
  const { binArrayAccountMetas } = meteora().getBinArrayInfoForNonContiguousBinIds(binIds, DLMM_PROGRAM_ID, pool.pubkey);
  const hookX = pool.tokenX.transferHookAccountMetas;
  const hookY = pool.tokenY.transferHookAccountMetas;
  const remainingAccountsInfo: RemainingAccountsInfo = {
    slices: [
      { accountsType: { transferHookX: {} }, length: hookX.length },
      { accountsType: { transferHookY: {} }, length: hookY.length },
    ],
  };
  return c.env.program.methods
    .meteoraDlmmCancelLimitOrder(binIds, remainingAccountsInfo)
    .accountsPartial({
      authority: c.env.payer,
      config: getConfigPda(c.env.programId),
      vault: c.vault.key,
      strategy: getStrategyPda(c.vault.key, limitOrder, c.env.programId),
      ...pairStrategyAccounts(c, pairOf(pool)),
      vaultTokenX: getAssociatedTokenAddress(c.vault.key, pool.tokenX.publicKey, pool.tokenX.owner),
      vaultTokenY: getAssociatedTokenAddress(c.vault.key, pool.tokenY.publicKey, pool.tokenY.owner),
      limitOrder,
      lbPair: pool.pubkey,
      binArrayBitmapExtension: pool.binArrayBitmapExtension?.publicKey ?? null,
      reserveX: pool.lbPair.reserveX,
      reserveY: pool.lbPair.reserveY,
      tokenXMint: pool.tokenX.publicKey,
      tokenYMint: pool.tokenY.publicKey,
      tokenXProgram: pool.tokenX.owner,
      tokenYProgram: pool.tokenY.owner,
      memoProgram: MEMO_PROGRAM_ID,
      eventAuthority: DLMM_EVENT_AUTHORITY,
      dlmmProgram: DLMM_PROGRAM_ID,
      delegate: c.delegate,
    })
    .remainingAccounts([...hookX, ...hookY, ...binArrayAccountMetas])
    .instruction();
}
