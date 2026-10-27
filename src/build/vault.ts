import { BN } from "@coral-xyz/anchor";
import { PublicKey } from "@solana/web3.js";
import { z } from "zod";
import type { ConfigAccount } from "../chain/decode";
import { getConfigPda, getManagerPda, getVaultPda } from "../chain/pda";
import { ApiError } from "../errors";
import { assembled, type InstructionSet } from "./assemble";
import { amountString, assertAuthority, bps, type BuildEnv, loadVaultCtx, pubkey, tokenProgramOf } from "./context";

/** Program caps on the manager fees (`MAX_PERFORMANCE_FEE_BPS`, `MAX_MANAGEMENT_FEE_BPS`). */
const MAX_PERFORMANCE_FEE_BPS = 5_000;
const MAX_MANAGEMENT_FEE_BPS = 500;

const encodeName = (name: string): number[] => Array.from(Buffer.from(name.padEnd(32, "\0"), "utf8").subarray(0, 32));

export const vaultInitializeInput = z.object({
  // encodeName truncates at 32 UTF-8 bytes, so bound bytes rather than UTF-16 units.
  name: z
    .string()
    .min(1)
    .refine((s) => Buffer.byteLength(s, "utf8") <= 32, "name must be at most 32 bytes"),
  depositMint: pubkey,
  performanceFeeBps: bps.max(MAX_PERFORMANCE_FEE_BPS),
  managementFeeBps: bps.max(MAX_MANAGEMENT_FEE_BPS),
  depositCap: amountString,
  minDeposit: amountString,
  minWithdrawalShares: amountString,
});

/** 1 RPC for the manager, config and mint. Carries the new vault's address. */
export async function vaultInitializeInstructions(env: BuildEnv, b: z.infer<typeof vaultInitializeInput>): Promise<InstructionSet & { vault: string }> {
  const authority = env.payer;
  const depositMint = new PublicKey(b.depositMint);
  const manager = getManagerPda(authority, env.programId);
  const config = getConfigPda(env.programId);
  const [managerInfo, configInfo, mintInfo] = await env.connection.getMultipleAccountsInfo([manager, config, depositMint]);
  if (!managerInfo?.owner.equals(env.programId)) throw new ApiError(403, "Forbidden", "Connected wallet is not a whitelisted manager");
  if (!configInfo) throw new Error("Protocol config account is missing");
  const { nextVaultId } = env.program.coder.accounts.decode<ConfigAccount>("config", configInfo.data);
  const vault = getVaultPda(BigInt(nextVaultId.toString()), env.programId);
  const ix = await env.program.methods
    .vaultInitialize({
      name: encodeName(b.name),
      performanceFeeBps: b.performanceFeeBps,
      managementFeeBps: b.managementFeeBps,
      depositCap: new BN(b.depositCap),
      minDeposit: new BN(b.minDeposit),
      minWithdrawalShares: new BN(b.minWithdrawalShares),
    })
    .accountsPartial({
      authority,
      config,
      manager,
      // The IDL cannot express the next_vault_id seed, so the vault is passed explicitly.
      vault,
      depositMint,
      depositMintTokenProgram: tokenProgramOf(depositMint, mintInfo ?? null),
    })
    .instruction();
  return { instructions: [ix], vault: vault.toBase58() };
}

export const buildVaultInitialize = assembled(vaultInitializeInstructions);

export const vaultUpdateInput = z
  .object({
    vault: pubkey,
    performanceFeeBps: bps.max(MAX_PERFORMANCE_FEE_BPS).optional(),
    managementFeeBps: bps.max(MAX_MANAGEMENT_FEE_BPS).optional(),
    depositCap: amountString.optional(),
    minDeposit: amountString.optional(),
    minWithdrawalShares: amountString.optional(),
    status: z.enum(["normal", "paused", "reduceOnly"]).optional(),
    depositPaused: z.boolean().optional(),
    withdrawalPaused: z.boolean().optional(),
  })
  // An all-undefined body would assemble a signable instruction that changes nothing.
  .refine(({ vault, ...fields }) => Object.values(fields).some((v) => v !== undefined), "no fields to update");

const statusArg = { normal: { normal: {} }, paused: { paused: {} }, reduceOnly: { reduceOnly: {} } } as const;
const optionalBn = (s: string | undefined) => (s === undefined ? null : new BN(s));

export async function vaultUpdateInstructions(env: BuildEnv, b: z.infer<typeof vaultUpdateInput>): Promise<InstructionSet> {
  const vault = await loadVaultCtx(env, b.vault);
  assertAuthority(vault, env.payer);
  const ix = await env.program.methods
    .vaultUpdate({
      performanceFeeBps: b.performanceFeeBps ?? null,
      managementFeeBps: b.managementFeeBps ?? null,
      depositCap: optionalBn(b.depositCap),
      minDeposit: optionalBn(b.minDeposit),
      minWithdrawalShares: optionalBn(b.minWithdrawalShares),
      status: b.status === undefined ? null : statusArg[b.status],
      depositPaused: b.depositPaused ?? null,
      withdrawalPaused: b.withdrawalPaused ?? null,
    })
    .accounts({ authority: env.payer, vault: vault.key })
    .instruction();
  return { instructions: [ix] };
}

export const buildVaultUpdate = assembled(vaultUpdateInstructions);

export const vaultInput = z.object({ vault: pubkey });

export async function vaultClaimFeeInstructions(env: BuildEnv, b: z.infer<typeof vaultInput>): Promise<InstructionSet> {
  const vault = await loadVaultCtx(env, b.vault);
  assertAuthority(vault, env.payer);
  const ix = await env.program.methods
    .vaultClaimManagerFee()
    .accounts({ authority: env.payer, vault: vault.key, shareMint: vault.shareMint })
    .instruction();
  return { instructions: [ix] };
}

export const buildVaultClaimFee = assembled(vaultClaimFeeInstructions);

export async function vaultCloseInstructions(env: BuildEnv, b: z.infer<typeof vaultInput>): Promise<InstructionSet> {
  const vault = await loadVaultCtx(env, b.vault);
  assertAuthority(vault, env.payer);
  const ix = await env.program.methods
    .vaultClose()
    .accounts({
      authority: env.payer,
      vault: vault.key,
      depositMint: vault.depositMint,
      shareMint: vault.shareMint,
      depositMintTokenProgram: vault.tokenProgram,
    })
    .instruction();
  return { instructions: [ix] };
}

export const buildVaultClose = assembled(vaultCloseInstructions);
