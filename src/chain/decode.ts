import type { IdlAccounts } from "@coral-xyz/anchor";
import type { HedgeVault } from "../idl/hedge_vault";
import type { RequestQueue, TokenInfo, VaultDetail, VaultSummary } from "../schemas";

export type VaultAccount = IdlAccounts<HedgeVault>["vault"];
export type ConfigAccount = IdlAccounts<HedgeVault>["config"];
export type DepositRequestAccount = IdlAccounts<HedgeVault>["depositRequest"];
export type WithdrawalRequestAccount = IdlAccounts<HedgeVault>["withdrawalRequest"];

type Status = VaultDetail["status"];
type RequestState = RequestQueue["deposits"][number]["state"];

/** Seconds per NAV epoch; mirrors `EPOCH_DURATION` in the program and app. */
export const EPOCH_DURATION = 14_400;

const MINT_SPAN = 82;
const TOKEN_ACCOUNT_SPAN = 165;

// ponytail: applied on every cluster, while the app gates this table on mainnet. Gate on the genesis hash if a non-mainnet mint ever reuses one of these addresses.
/** Mainnet mints whose symbol overrides Jupiter, as the app does. */
const KNOWN_SYMBOLS: Record<string, string> = {
  EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v: "USDC",
  So11111111111111111111111111111111111111112: "SOL",
  Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB: "USDT",
  "3NZ9JMVBmGAqocybic2c7LQCJScmgsAZ6vQqTDzcqmJh": "WBTC",
};

export const decodeName = (bytes: number[]) => new TextDecoder().decode(Uint8Array.from(bytes)).replace(/\0+$/, "");

const STATUSES: Record<string, Status> = { normal: "normal", paused: "paused", reduceOnly: "reduceOnly" };

export function decodeStatus(s: object): Status {
  const key = Object.keys(s)[0] ?? "";
  const status = STATUSES[key];
  if (!status) throw new Error(`Unknown status variant: ${key}`);
  return status;
}

/** Decimals and supply of an SPL / Token-2022 mint (extensions live past the base 82 bytes). */
export function decodeMint(data: Buffer): { decimals: number; supply: bigint } | null {
  if (data.length < MINT_SPAN) return null;
  return { supply: data.readBigUInt64LE(36), decimals: data.readUInt8(44) };
}

/** Amount of an SPL / Token-2022 token account; a missing or malformed account counts as 0. */
export const decodeTokenAmount = (data: Buffer | undefined): bigint =>
  data && data.length >= TOKEN_ACCOUNT_SPAN ? data.readBigUInt64LE(64) : 0n;

const shortSymbol = (mint: string) => `${mint.slice(0, 4)}…${mint.slice(-4)}`;

export const tokenInfo = (mint: string, decimals: number, jupiterSymbol: string | undefined): TokenInfo => ({
  mint,
  symbol: KNOWN_SYMBOLS[mint] ?? jupiterSymbol ?? shortSymbol(mint),
  decimals,
});

export function toVaultSummary(address: string, a: VaultAccount, token: TokenInfo): VaultSummary {
  return {
    address,
    name: decodeName(a.name) || `Vault #${a.id.toString()}`,
    status: decodeStatus(a.status),
    depositMint: a.depositMint.toBase58(),
    depositSymbol: token.symbol,
    depositDecimals: token.decimals,
    totalAssets: a.totalAssets.toString(),
  };
}

export interface VaultBalances {
  shareMint: string;
  shareSupply: bigint;
  idleBalance: bigint;
}

export function toVaultDetail(address: string, a: VaultAccount, token: TokenInfo, config: ConfigAccount, b: VaultBalances): VaultDetail {
  return {
    ...toVaultSummary(address, a, token),
    id: a.id.toString(),
    status: decodeStatus(a.status),
    navPerShare: a.navPerShare.toString(),
    depositCap: a.depositCap.toString(),
    performanceFeeBps: a.performanceFeeBps,
    managementFeeBps: a.managementFeeBps,
    lastNavTs: a.lastNavTs.toNumber(),
    authority: a.authority.toBase58(),
    shareMint: b.shareMint,
    shareSupply: b.shareSupply.toString(),
    idleBalance: b.idleBalance.toString(),
    pendingDeposits: a.pendingDeposits.toString(),
    pendingWithdrawalShares: a.pendingWithdrawalShares.toString(),
    unclaimedManagerFeeShares: a.unclaimedManagerFeeShares.toString(),
    unclaimedPlatformFeeShares: a.unclaimedPlatformFeeShares.toString(),
    epochOutflow: a.epochOutflow.toString(),
    highWaterMark: a.highWaterMark.toString(),
    navEpoch: a.navEpoch.toString(),
    minDeposit: a.minDeposit.toString(),
    minWithdrawalShares: a.minWithdrawalShares.toString(),
    depositPaused: a.depositPaused !== 0,
    withdrawalPaused: a.withdrawalPaused !== 0,
    pendingPerformanceFeeBps: a.pendingPerformanceFeeBps,
    pendingManagementFeeBps: a.pendingManagementFeeBps,
    feeEffectiveTs: a.feeEffectiveTs.toNumber(),
    openStrategyCount: a.openStrategyCount,
    protocol: {
      status: decodeStatus(config.status),
      maxEpochOutflowBps: config.maxEpochOutflowBps,
      // Zero is a legacy unset value; the program then applies DEFAULT_MAX_SLIPPAGE_BPS (10%).
      maxSlippageBps: config.maxSlippageBps || 1_000,
    },
  };
}

const epochOf = (ts: number) => BigInt(Math.floor(ts / EPOCH_DURATION));

/**
 * The program resolves a request only in the epoch its NAV was posted for. Once a newer epoch starts the
 * request is frozen (neither claimable nor cancellable) until that epoch's NAV lands.
 */
const requestState = (navEpoch: bigint, requestEpoch: bigint, currentEpoch: bigint): RequestState =>
  navEpoch <= requestEpoch ? "pending" : navEpoch === currentEpoch ? "resolvable" : "frozen";

export function toRequestQueue(
  vault: VaultAccount,
  deposits: DepositRequestAccount[],
  withdrawals: WithdrawalRequestAccount[],
  nowSeconds: number,
): RequestQueue {
  const navEpoch = BigInt(vault.navEpoch.toString());
  const navPerShare = BigInt(vault.navPerShare.toString());
  const current = epochOf(nowSeconds);
  const common = (r: DepositRequestAccount | WithdrawalRequestAccount) => {
    const state = requestState(navEpoch, BigInt(r.epoch.toString()), current);
    return { owner: r.authority.toBase58(), epoch: r.epoch.toString(), createdTs: r.createdTs.toNumber(), state };
  };
  const byAge = (a: { createdTs: number }, b: { createdTs: number }) => a.createdTs - b.createdTs;
  return {
    deposits: deposits
      .map((r) => {
        const base = common(r);
        return { ...base, amount: r.amount.toString(), cancellable: base.state === "pending" || navPerShare === 0n };
      })
      .sort(byAge),
    withdrawals: withdrawals
      .map((r) => {
        const base = common(r);
        return { ...base, shares: r.shares.toString(), cancellable: base.state === "pending" };
      })
      .sort(byAge),
  };
}
