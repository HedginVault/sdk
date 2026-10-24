import type { IdlAccounts, Program } from "@coral-xyz/anchor";
import { type AccountInfo, type Connection, PublicKey } from "@solana/web3.js";
import { z } from "zod";
import type { BuildAction, ActionRequest } from "../actions";
import type { VaultAccount } from "../chain/decode";
import { getDelegatePda, getShareMintPda } from "../chain/pda";
import { decodeVault, hedgeProgram } from "../chain/reads";
import { ApiError } from "../errors";
import type { HedgeVault } from "../idl/hedge_vault";
import type { JupiterConfig } from "./jupiter-api";

/** What a local builder needs in place of the app's env and module singletons. */
export interface BuildContext {
  connection: Connection;
  programId: PublicKey;
  /** The signer's key: fee payer and acting authority of every transaction built. */
  payer: PublicKey;
  /** Milliseconds since the epoch. */
  now: () => number;
  /** Jupiter and Phoenix HTTP calls. */
  fetch: typeof fetch;
  jupiter: JupiterConfig;
  /** Phoenix's perp-api: market list and trader onboarding. */
  phoenixApiUrl: string;
}

export type BuildEnv = BuildContext & { program: Program<HedgeVault> };

export const buildEnv = (ctx: BuildContext): BuildEnv => ({ ...ctx, program: hedgeProgram(ctx.connection, ctx.programId) });

/** The request body of one action, as `toBuildRequest` sends it. */
export type ActionBody<A extends BuildAction> = Omit<Extract<ActionRequest, { action: A }>, "action">;

export const pubkey = z.string().refine(
  (s) => {
    try {
      new PublicKey(s);
      return true;
    } catch {
      return false;
    }
  },
  { message: "invalid public key" },
);

const DIGITS = /^\d+$/;
const U64_MAX = 18446744073709551615n;

/** u64 base units. Refinements run even after a failed regex, so the bound re-tests `DIGITS` before `BigInt`. */
export const amountString = z
  .string()
  .regex(DIGITS, "must be a non-negative integer string")
  .refine((s) => !DIGITS.test(s) || BigInt(s) <= U64_MAX, "must fit in u64");

export const bps = z.number().int().min(0).max(10_000);

/** Mint account owner: SPL Token or Token-2022. */
export async function readTokenProgram(env: BuildEnv, mint: PublicKey): Promise<PublicKey> {
  return tokenProgramOf(mint, await env.connection.getAccountInfo(mint));
}

export function tokenProgramOf(mint: PublicKey, info: AccountInfo<Buffer> | null): PublicKey {
  if (!info) throw new ApiError(404, "NotFound", `Mint ${mint.toBase58()} not found`);
  return info.owner;
}

export interface VaultCtx {
  key: PublicKey;
  account: VaultAccount;
  depositMint: PublicKey;
  tokenProgram: PublicKey;
  shareMint: PublicKey;
}

/** 2 RPC: the vault, then its deposit mint's token program. */
export async function loadVaultCtx(env: BuildEnv, address: string): Promise<VaultCtx> {
  const key = new PublicKey(address);
  const account = decodeVault({ programId: env.programId, coder: env.program.coder.accounts }, await env.connection.getAccountInfo(key));
  return {
    key,
    account,
    depositMint: account.depositMint,
    tokenProgram: await readTokenProgram(env, account.depositMint),
    shareMint: getShareMintPda(key, env.programId),
  };
}

export function assertAuthority(vault: VaultCtx, payer: PublicKey): void {
  if (!vault.account.authority.equals(payer)) throw new ApiError(403, "Forbidden", "Connected wallet is not the vault authority");
}

/** Who signs a delegate-capable action: the vault authority (`null`), or one of its delegates. */
export type Operator = { delegate: PublicKey; permissions: number } | null;

/** The program's `DELEGATE_*` permission groups, one bit per protocol. */
export const DELEGATE_JUPITER = 1;
export const DELEGATE_METEORA_DLMM = 2;
export const DELEGATE_PHOENIX = 4;
const PERMISSION_LABELS: Record<number, string> = { 1: "Jupiter", 2: "Meteora DLMM", 4: "Phoenix" };

/** The authority, or a wallet with an unexpired Delegate of this vault (1 RPC). */
export async function assertOperator(env: BuildEnv, vault: VaultCtx, payer: PublicKey): Promise<Operator> {
  if (vault.account.authority.equals(payer)) return null;
  // The program only creates a Delegate at this PDA, so finding it there proves its vault and wallet.
  const address = getDelegatePda(vault.key, payer, env.programId);
  const info = await env.connection.getAccountInfo(address);
  if (!info || !info.owner.equals(env.programId))
    throw new ApiError(403, "Forbidden", "Connected wallet is not the vault authority or one of its delegates");
  const delegate = env.program.coder.accounts.decode<IdlAccounts<HedgeVault>["delegate"]>("delegate", info.data);
  const expiresAt = delegate.expiresAt.toNumber();
  if (expiresAt !== 0 && env.now() / 1000 >= expiresAt)
    throw new ApiError(403, "DelegateExpired", "This wallet's delegate access to the vault has expired");
  return { delegate: address, permissions: delegate.permissions.toNumber() };
}

/** The optional `delegate` account of an instruction gated by `permission`: none for the authority. */
export function delegateFor(operator: Operator, permission: number): PublicKey | null {
  if (!operator) return null;
  if ((operator.permissions & permission) === 0)
    throw new ApiError(403, "DelegatePermissionDenied", `This delegate cannot run ${PERMISSION_LABELS[permission] ?? "this protocol"} actions`);
  return operator.delegate;
}
