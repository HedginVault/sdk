import { BN, type IdlAccounts, Program } from "@coral-xyz/anchor";
import type { AccountInfo, Connection, PublicKey } from "@solana/web3.js";
import { PublicKey as Key } from "@solana/web3.js";
import { z } from "zod";
import { ApiError } from "../errors";
import idl from "../idl/hedge_vault.json";
import type { HedgeVault } from "../idl/hedge_vault";
import type { TokenInfo, VaultDetail, VaultSummary } from "../schemas";
import {
  type ConfigAccount,
  type VaultAccount,
  decodeMetadataSymbol,
  decodeMintDecimals,
  decodeTokenAmount,
  isChildAccount,
  toVaultDetail,
  toVaultSummary,
  tokenInfo,
} from "./decode";
import { getAssociatedTokenAddress, getConfigPda, getDepositRequestPda, getMetadataPda, getShareMintPda, getWithdrawalRequestPda } from "./pda";

type DepositRequestAccount = IdlAccounts<HedgeVault>["depositRequest"];
type WithdrawalRequestAccount = IdlAccounts<HedgeVault>["withdrawalRequest"];

/** RPC cap for getMultipleAccountsInfo, and Jupiter's /tokens/v2/search cap. */
const MAX_PER_CALL = 100;

export interface ChainContext {
  connection: Connection;
  programId: PublicKey;
  fetch: typeof fetch;
  jupiterApiKey?: string;
  program: Program<HedgeVault>;
}

export type AccountsCoder = Program<HedgeVault>["coder"]["accounts"];

/** Anchor's client for the camel-cased IDL at `programId`. It has no wallet, so it never signs or sends. */
export const hedgeProgram = (connection: Connection, programId?: PublicKey): Program<HedgeVault> =>
  new Program<HedgeVault>({ ...(idl as HedgeVault), address: (programId ?? new Key(idl.address)).toBase58() }, { connection });

export const accountsCoder = (connection: Connection): AccountsCoder => hedgeProgram(connection).coder.accounts;

const JupiterTokensSchema = z.array(z.object({ id: z.string(), symbol: z.string() }));

const chunks = <T>(items: T[]) =>
  Array.from({ length: Math.ceil(items.length / MAX_PER_CALL) }, (_, i) => items.slice(i * MAX_PER_CALL, (i + 1) * MAX_PER_CALL));

export async function getAccounts(ctx: ChainContext, keys: PublicKey[]): Promise<(AccountInfo<Buffer> | null)[]> {
  const out: (AccountInfo<Buffer> | null)[] = [];
  for (const chunk of chunks(keys)) out.push(...(await ctx.connection.getMultipleAccountsInfo(chunk)));
  return out;
}

/** Symbols from Jupiter token search. A failed or malformed response leaves mints unresolved rather than failing the read. */
async function jupiterSymbols(ctx: ChainContext, mints: string[]): Promise<Map<string, string>> {
  const host = ctx.jupiterApiKey ? "https://api.jup.ag" : "https://lite-api.jup.ag";
  const headers: Record<string, string> = ctx.jupiterApiKey ? { "x-api-key": ctx.jupiterApiKey } : {};
  const out = new Map<string, string>();
  for (const chunk of chunks(mints)) {
    try {
      const res = await ctx.fetch(`${host}/tokens/v2/search?query=${chunk.join(",")}`, { headers });
      if (!res.ok) continue;
      const parsed = JupiterTokensSchema.safeParse(await res.json());
      if (parsed.success) for (const t of parsed.data) if (chunk.includes(t.id)) out.set(t.id, t.symbol);
    } catch {
      continue;
    }
  }
  return out;
}

type ReadToken = { token: TokenInfo; tokenProgram: PublicKey };

/** Decimals from each mint account, owning token program, and symbol from Jupiter. A missing mint is absent unless `required`. */
export async function readTokens(ctx: ChainContext, mints: PublicKey[], required: boolean): Promise<Map<string, ReadToken>> {
  const unique = [...new Map(mints.map((m) => [m.toBase58(), m])).values()];
  const keys = unique.map((m) => m.toBase58());
  const [infos, symbols] = await Promise.all([getAccounts(ctx, unique), jupiterSymbols(ctx, keys)]);
  const out = new Map<string, ReadToken>();
  keys.forEach((key, i) => {
    const info = infos[i];
    const decimals = info ? decodeMintDecimals(info.data) : null;
    if (info && decimals !== null) out.set(key, { token: tokenInfo(key, decimals, symbols.get(key)), tokenProgram: info.owner });
    else if (required) throw new ApiError(404, "NotFound", `Mint ${key} not found`);
  });
  return out;
}

/** Only an account owned by the program with the Vault discriminator is a vault. */
export function decodeVault(ctx: ChainContext, info: AccountInfo<Buffer> | null): VaultAccount {
  if (!info || !info.owner.equals(ctx.programId)) throw new ApiError(404, "NotFound", "Vault not found");
  try {
    return ctx.program.coder.accounts.decode<VaultAccount>("vault", info.data);
  } catch {
    throw new ApiError(404, "NotFound", "Vault not found");
  }
}

/**
 * 1 getProgramAccounts, then one batched mint read and Jupiter lookup for all deposit mints. Every vault that takes
 * deposits, sorted by id; child vaults are left out, as the app's list does. A vault whose Token-2022 deposit mint was
 * closed at zero supply is left out rather than failing the list.
 */
export async function readVaults(ctx: ChainContext): Promise<VaultSummary[]> {
  // Anchor types `memcmp` loosely; it returns the inner `{ offset, bytes }` of the Vault discriminator filter.
  const discriminator: { offset: number; bytes: string } = ctx.program.coder.accounts.memcmp("vault");
  const all = (await ctx.connection.getProgramAccounts(ctx.programId, { filters: [{ memcmp: discriminator }] }))
    .map(({ pubkey, account }) => ({ address: pubkey.toBase58(), account: ctx.program.coder.accounts.decode<VaultAccount>("vault", account.data) }))
    .filter((v) => !isChildAccount(v.account));
  const tokens = await readTokens(ctx, all.map((v) => v.account.depositMint), false);
  return all
    .sort((a, b) => a.account.id.cmp(b.account.id))
    .flatMap(({ address, account }) => {
      const token = tokens.get(account.depositMint.toBase58());
      return token ? [toVaultSummary(address, account, token.token)] : [];
    });
}

export interface VaultState {
  detail: VaultDetail;
  account: VaultAccount;
  /** The deposit mint's token program: classic Token or Token-2022. */
  tokenProgram: PublicKey;
}

/**
 * 3 RPC: the vault and config, then the deposit mint with the share mint's metadata, then the vault's idle token
 * account. A child vault has no share mint, so it has no share symbol either.
 */
export async function readVaultState(ctx: ChainContext, key: PublicKey): Promise<VaultState> {
  const [vaultInfo, configInfo] = await getAccounts(ctx, [key, getConfigPda(ctx.programId)]);
  const vault = decodeVault(ctx, vaultInfo ?? null);
  if (!configInfo) throw new Error("Protocol config account is missing");
  const config = ctx.program.coder.accounts.decode<ConfigAccount>("config", configInfo.data);
  const shareMint = getShareMintPda(key, ctx.programId);
  const [tokens, [metadataInfo]] = await Promise.all([readTokens(ctx, [vault.depositMint], true), getAccounts(ctx, [getMetadataPda(shareMint)])]);
  const deposit = tokens.get(vault.depositMint.toBase58());
  if (!deposit) throw new Error("Deposit mint was not read");
  const metadata = metadataInfo ? decodeMetadataSymbol(metadataInfo.data) : null;
  const [idleInfo] = await getAccounts(ctx, [getAssociatedTokenAddress(key, vault.depositMint, deposit.tokenProgram)]);
  const detail = toVaultDetail(key.toBase58(), vault, deposit.token, config, {
    shareMint: shareMint.toBase58(),
    shareSymbol: metadata && metadata.mint === shareMint.toBase58() && metadata.symbol ? metadata.symbol : null,
    idleBalance: decodeTokenAmount(idleInfo?.data),
  });
  return { detail, account: vault, tokenProgram: deposit.tokenProgram };
}

const EPOCH_SECONDS = 14_400n;
/** `navPerShare` is deposit-mint base units per 10^9 share base units. */
export const NAV_PRECISION = 1_000_000_000n;
const TOKEN_PROGRAM = new Key("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");

export type RequestState = "pending" | "resolvable" | "frozen";

interface RequestFields {
  amount?: BN;
  shares?: BN;
  epoch: BN;
  createdTs: BN;
  approved: number;
}

export interface RequestView {
  /** The request settles at the first NAV epoch after this one. */
  epoch: BN;
  /** Unix seconds. */
  createdTs: number;
  /**
   * `resolvable` once a later NAV epoch is posted. `frozen` once a newer epoch starts before its NAV lands: neither
   * resolvable nor cancellable until then.
   */
  state: RequestState;
  cancellable: boolean;
  /** On a vault that requires approval, true until the manager approves this request's current amount. */
  awaitingApproval: boolean;
}

export interface VaultPosition {
  /** Shares in the user's wallet. Shares escrowed by a pending withdrawal are in `withdrawalRequest.shares`. */
  shares: BN;
  /** `shares` at the last posted NAV, in deposit-mint base units. */
  valueAtNav: BN;
  depositRequest: (RequestView & { amount: BN }) | null;
  withdrawalRequest: (RequestView & { shares: BN }) | null;
}

/** As the app's `requestState`: a request is resolvable only while the posted NAV epoch is the current one. */
function toRequestView(r: RequestFields, vault: VaultAccount, cancellableWhenResolvable: boolean, now: number): RequestView {
  const navEpoch = BigInt(vault.navEpoch.toString());
  const epoch = BigInt(r.epoch.toString());
  const current = BigInt(Math.floor(now / 1000)) / EPOCH_SECONDS;
  const state: RequestState = navEpoch <= epoch ? "pending" : navEpoch === current ? "resolvable" : "frozen";
  const awaitingApproval = vault.approvalRequired !== 0 && r.approved === 0;
  return { epoch: r.epoch, createdTs: r.createdTs.toNumber(), state, cancellable: awaitingApproval || state === "pending" || cancellableWhenResolvable, awaitingApproval };
}

/** 1 RPC: the vault, the user's share account and both request accounts. Also returns the fresh vault account. */
export async function readPosition(ctx: ChainContext, key: PublicKey, user: PublicKey, now = Date.now()): Promise<{ account: VaultAccount; position: VaultPosition }> {
  const [vaultInfo, shareInfo, depositInfo, withdrawalInfo] = await getAccounts(ctx, [
    key,
    getAssociatedTokenAddress(user, getShareMintPda(key, ctx.programId), TOKEN_PROGRAM),
    getDepositRequestPda(key, user, ctx.programId),
    getWithdrawalRequestPda(key, user, ctx.programId),
  ]);
  const account = decodeVault(ctx, vaultInfo ?? null);
  const coder = ctx.program.coder.accounts;
  const deposit = depositInfo ? coder.decode<DepositRequestAccount>("depositRequest", depositInfo.data) : null;
  const withdrawal = withdrawalInfo ? coder.decode<WithdrawalRequestAccount>("withdrawalRequest", withdrawalInfo.data) : null;
  const shares = new BN(decodeTokenAmount(shareInfo?.data).toString());
  // A deposit is also cancellable while the vault has no NAV yet, since nothing could price it (app: isDepositCancellable).
  const noNav = account.navPerShare.isZero();
  return {
    account,
    position: {
      shares,
      valueAtNav: shares.mul(account.navPerShare).div(new BN(NAV_PRECISION.toString())),
      depositRequest: deposit ? { ...toRequestView(deposit, account, noNav, now), amount: deposit.amount } : null,
      withdrawalRequest: withdrawal ? { ...toRequestView(withdrawal, account, false, now), shares: withdrawal.shares } : null,
    },
  };
}
