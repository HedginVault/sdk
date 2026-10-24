import { Program } from "@coral-xyz/anchor";
import { type AccountInfo, type Connection, PublicKey } from "@solana/web3.js";
import { z } from "zod";
import { ApiError } from "../errors";
import idl from "../idl/hedge_vault.json";
import type { HedgeVault } from "../idl/hedge_vault";
import type { RequestQueue, TokenInfo, VaultDetail, VaultSummary } from "../schemas";
import {
  type ConfigAccount,
  type DepositRequestAccount,
  type VaultAccount,
  type WithdrawalRequestAccount,
  decodeMint,
  decodeTokenAmount,
  toRequestQueue,
  toVaultDetail,
  toVaultSummary,
  tokenInfo,
} from "./decode";
import { getAssociatedTokenAddress, getConfigPda, getShareMintPda } from "./pda";

/** RPC cap for getMultipleAccountsInfo, and Jupiter's /tokens/v2/search cap. */
const MAX_PER_CALL = 100;
// DepositRequest / WithdrawalRequest layout: 8 discriminator + 32 authority, then vault.
const REQUEST_VAULT_OFFSET = 40;

export interface ChainContext {
  connection: Connection;
  programId: PublicKey;
  fetch: typeof fetch;
  jupiterApiKey?: string;
}

export type AccountsCoder = Program<HedgeVault>["coder"]["accounts"];
type Ctx = ChainContext & { coder: AccountsCoder };

/** Coders and instruction builders only; this Program has no wallet, so it never signs or sends. */
export const hedgeProgram = (connection: Connection, programId: PublicKey) =>
  new Program<HedgeVault>({ ...(idl as HedgeVault), address: programId.toBase58() }, { connection });

export const chainContext = (ctx: ChainContext): Ctx => ({ ...ctx, coder: hedgeProgram(ctx.connection, ctx.programId).coder.accounts });

const JupiterTokensSchema = z.array(z.object({ id: z.string(), symbol: z.string() }));

const chunks = <T>(items: T[]) =>
  Array.from({ length: Math.ceil(items.length / MAX_PER_CALL) }, (_, i) => items.slice(i * MAX_PER_CALL, (i + 1) * MAX_PER_CALL));

async function getAccounts(ctx: Ctx, keys: PublicKey[]): Promise<(AccountInfo<Buffer> | null)[]> {
  const out: (AccountInfo<Buffer> | null)[] = [];
  for (const chunk of chunks(keys)) out.push(...(await ctx.connection.getMultipleAccountsInfo(chunk)));
  return out;
}

/** Symbols from Jupiter token search. A failed or malformed response leaves mints unresolved rather than failing the read. */
async function jupiterSymbols(ctx: Ctx, mints: string[]): Promise<Map<string, string>> {
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

/** Decimals from each mint account, owning token program, and symbol from Jupiter. */
async function readTokens(ctx: Ctx, mints: PublicKey[]): Promise<Map<string, { token: TokenInfo; tokenProgram: PublicKey }>> {
  const unique = [...new Map(mints.map((m) => [m.toBase58(), m])).values()];
  const keys = unique.map((m) => m.toBase58());
  const [infos, symbols] = await Promise.all([getAccounts(ctx, unique), jupiterSymbols(ctx, keys)]);
  return new Map(
    keys.map((key, i) => {
      const info = infos[i];
      const mint = info ? decodeMint(info.data) : null;
      if (!info || !mint) throw new ApiError(404, "NotFound", `Mint ${key} not found`);
      return [key, { token: tokenInfo(key, mint.decimals, symbols.get(key)), tokenProgram: info.owner }];
    }),
  );
}

function parseAddress(address: string): PublicKey {
  try {
    return new PublicKey(address);
  } catch {
    throw new ApiError(400, "Validation", "vault must be a public key");
  }
}

/** Only an account owned by the program with the Vault discriminator is a vault. */
export function decodeVault(ctx: { programId: PublicKey; coder: AccountsCoder }, info: AccountInfo<Buffer> | null): VaultAccount {
  if (!info || !info.owner.equals(ctx.programId)) throw new ApiError(404, "NotFound", "Vault not found");
  try {
    return ctx.coder.decode<VaultAccount>("vault", info.data);
  } catch {
    throw new ApiError(404, "NotFound", "Vault not found");
  }
}

/** Anchor types `memcmp` as `any`; it returns the inner `{ offset, bytes }`, not a whole filter. */
const discriminatorFilter = (ctx: Ctx, name: string): { offset: number; bytes: string } => ctx.coder.memcmp(name);

const programAccounts = (ctx: Ctx, name: "vault" | "depositRequest" | "withdrawalRequest", vault?: PublicKey) =>
  ctx.connection.getProgramAccounts(ctx.programId, {
    filters: [{ memcmp: discriminatorFilter(ctx, name) }, ...(vault ? [{ memcmp: { offset: REQUEST_VAULT_OFFSET, bytes: vault.toBase58() } }] : [])],
  });

/** 1 getProgramAccounts, then one batched mint read and Jupiter lookup for all deposit mints. Every vault, sorted by id. */
export async function readVaults(ctx: Ctx): Promise<VaultSummary[]> {
  const all = (await programAccounts(ctx, "vault")).map(({ pubkey, account }) => ({
    address: pubkey.toBase58(),
    account: ctx.coder.decode<VaultAccount>("vault", account.data),
  }));
  const tokens = await readTokens(ctx, all.map((v) => v.account.depositMint));
  return all
    .sort((a, b) => a.account.id.cmp(b.account.id))
    .map(({ address, account }) => {
      const token = tokens.get(account.depositMint.toBase58());
      if (!token) throw new Error(`Deposit mint ${account.depositMint.toBase58()} was not read`);
      return toVaultSummary(address, account, token.token);
    });
}

/** 3 RPC: the vault and config, then the deposit and share mints, then the vault's idle token account. */
export async function readVaultDetail(ctx: Ctx, address: string): Promise<VaultDetail> {
  const key = parseAddress(address);
  const [vaultInfo, configInfo] = await getAccounts(ctx, [key, getConfigPda(ctx.programId)]);
  const vault = decodeVault(ctx, vaultInfo ?? null);
  if (!configInfo) throw new Error("Protocol config account is missing");
  const config = ctx.coder.decode<ConfigAccount>("config", configInfo.data);
  const shareMint = getShareMintPda(key, ctx.programId);
  const [tokens, [shareMintInfo]] = await Promise.all([readTokens(ctx, [vault.depositMint]), getAccounts(ctx, [shareMint])]);
  const deposit = tokens.get(vault.depositMint.toBase58());
  const share = shareMintInfo ? decodeMint(shareMintInfo.data) : null;
  if (!deposit) throw new Error("Deposit mint was not read");
  if (!share) throw new Error("Share mint account is missing");
  const idleAccount = getAssociatedTokenAddress(key, vault.depositMint, deposit.tokenProgram);
  const [idleInfo] = await getAccounts(ctx, [idleAccount]);
  return toVaultDetail(address, vault, deposit.token, config, {
    shareMint: shareMint.toBase58(),
    shareSupply: share.supply,
    idleBalance: decodeTokenAmount(idleInfo?.data),
  });
}

/** 3 RPC: the vault, then one getProgramAccounts per request type filtered by vault. */
export async function readRequestQueue(ctx: Ctx, address: string): Promise<RequestQueue> {
  const key = parseAddress(address);
  const [vaultInfo] = await getAccounts(ctx, [key]);
  const vault = decodeVault(ctx, vaultInfo ?? null);
  const [deposits, withdrawals] = await Promise.all([
    programAccounts(ctx, "depositRequest", key),
    programAccounts(ctx, "withdrawalRequest", key),
  ]);
  return toRequestQueue(
    vault,
    deposits.map((d) => ctx.coder.decode<DepositRequestAccount>("depositRequest", d.account.data)),
    withdrawals.map((w) => ctx.coder.decode<WithdrawalRequestAccount>("withdrawalRequest", w.account.data)),
    Date.now() / 1000,
  );
}
