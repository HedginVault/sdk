import type { IdlAccounts } from "@coral-xyz/anchor";
import { PublicKey } from "@solana/web3.js";
import type { HedgeVault } from "../idl/hedge_vault";
import type { TokenInfo, VaultDetail, VaultSummary } from "../schemas";

export type VaultAccount = IdlAccounts<HedgeVault>["vault"];
export type ConfigAccount = IdlAccounts<HedgeVault>["config"];

type Status = VaultDetail["status"];

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

const decodeName = (bytes: number[]) => new TextDecoder().decode(Uint8Array.from(bytes)).replace(/\0+$/, "");

const STATUSES: Record<string, Status> = { normal: "normal", paused: "paused", reduceOnly: "reduceOnly", frozen: "frozen" };

function decodeStatus(s: object): Status {
  const key = Object.keys(s)[0] ?? "";
  const status = STATUSES[key];
  if (!status) throw new Error(`Unknown status variant: ${key}`);
  return status;
}

/** Decimals of an SPL / Token-2022 mint (extensions live past the base 82 bytes). */
export function decodeMintDecimals(data: Buffer): number | null {
  return data.length < MINT_SPAN ? null : data.readUInt8(44);
}

/** Amount of an SPL / Token-2022 token account; a missing or malformed account counts as 0. */
export const decodeTokenAmount = (data: Buffer | undefined): bigint =>
  data && data.length >= TOKEN_ACCOUNT_SPAN ? data.readBigUInt64LE(64) : 0n;

/** A child vault names its parent; a vault that takes deposits has the default key there. */
export const isChildAccount = (a: Pick<VaultAccount, "parent">) => !a.parent.equals(PublicKey.default);

/**
 * Mint and symbol of a Metaplex `Metadata` v1 account (key, update authority, mint, then length-prefixed name and
 * symbol, NUL-padded to their caps). Null for anything else.
 */
export function decodeMetadataSymbol(data: Buffer): { mint: string; symbol: string } | null {
  const KEY_METADATA_V1 = 4;
  if (data.length < 65 || data[0] !== KEY_METADATA_V1) return null;
  let o = 65;
  const str = () => {
    if (o + 4 > data.length) return null;
    const n = data.readUInt32LE(o);
    if (o + 4 + n > data.length) return null;
    const s = data.subarray(o + 4, o + 4 + n).toString("utf8").replace(/\0+$/, "");
    o += 4 + n;
    return s;
  };
  const name = str();
  const symbol = str();
  if (name === null || symbol === null) return null;
  return { mint: new PublicKey(data.subarray(33, 65)).toBase58(), symbol };
}

const shortSymbol = (mint: string) => `${mint.slice(0, 4)}…${mint.slice(-4)}`;

export const tokenInfo = (mint: string, decimals: number, jupiterSymbol: string | undefined): TokenInfo => ({
  mint,
  symbol: KNOWN_SYMBOLS[mint] ?? jupiterSymbol ?? shortSymbol(mint),
  decimals,
});

/** The on-chain part of the app's `toVaultSummary`. Listing names, manager profiles and performance live in Hedgin's database. */
export function toVaultSummary(address: string, a: VaultAccount, token: TokenInfo): VaultSummary {
  return {
    address,
    name: decodeName(a.name) || `Vault #${a.id.toString()}`,
    status: decodeStatus(a.status),
    depositMint: a.depositMint.toBase58(),
    depositSymbol: token.symbol,
    depositDecimals: token.decimals,
    totalAssets: a.totalAssets.toString(),
    approvalRequired: a.approvalRequired !== 0,
    parent: isChildAccount(a) ? a.parent.toBase58() : null,
    childCount: a.childCount,
    selection: a.selection !== 0,
  };
}

export interface VaultBalances {
  shareMint: string;
  /** The share mint's Metaplex symbol; null until the vault's share metadata exists. */
  shareSymbol: string | null;
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
    // The program prices NAV from this counter, not the share mint's supply, so a direct burn cannot move it.
    shareSupply: a.shareSupply.toString(),
    shareSymbol: b.shareSymbol,
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
