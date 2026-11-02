import { BN, type IdlAccounts } from "@coral-xyz/anchor";
import { PublicKey, type TransactionInstruction } from "@solana/web3.js";
import { z } from "zod";
import { type ConfigAccount, decodeTokenAmount, isChildAccount } from "../chain/decode";
import { getAssociatedTokenAddress, getConfigPda, getStrategyPda, getVaultPda } from "../chain/pda";
import { ApiError } from "../errors";
import type { HedgeVault } from "../idl/hedge_vault";
import { assembled, type InstructionSet } from "./assemble";
import {
  amountString,
  assertAuthority,
  assertOperator,
  type BuildEnv,
  DELEGATE_ALL,
  delegateFor,
  loadVaultCtx,
  type Operator,
  pubkey,
  readTokenProgram,
  type VaultCtx,
} from "./context";
import { jupiterInitializeIx } from "./jupiter-initialize";
import { STRATEGY_VAULT_OFFSET } from "./jupiter-swap";
import { USDC_MINT } from "./phoenix-accounts";
import { closeJupiterStrategyIx } from "./strategy";
import { encodeName, vaultName } from "./vault";

const TOKEN_PROGRAM_ID = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");

/** The program's `MAX_CHILD_VAULTS`. */
const MAX_CHILD_VAULTS = 16;

/** The mint a transfer moves: the deposit mint, or a mint both vaults track with a Jupiter strategy. */
interface TransferMint {
  mint: PublicKey;
  tokenProgram: PublicKey;
}

/** 2 RPC: a child vault of `parent`, refused when it belongs elsewhere. */
async function loadChild(env: BuildEnv, parent: VaultCtx, address: string): Promise<VaultCtx> {
  const child = await loadVaultCtx(env, address);
  if (!child.account.parent.equals(parent.key)) throw new ApiError(400, "Validation", "child does not belong to this vault");
  return child;
}

/** Moves `amount` between two vaults of `parent`'s family: the parent itself or any of its child vaults. */
const escrowTransferIx = (
  env: BuildEnv,
  parent: VaultCtx,
  operator: Operator,
  source: PublicKey,
  destination: PublicKey,
  amount: BN,
  { mint, tokenProgram }: TransferMint = { mint: parent.depositMint, tokenProgram: parent.tokenProgram },
) => {
  const tracked = !mint.equals(parent.depositMint);
  return env.program.methods
    .escrowTransfer(amount)
    .accountsPartial({
      authority: env.payer,
      config: getConfigPda(env.programId),
      parent: parent.key,
      source,
      destination,
      mint,
      sourceTokenAccount: getAssociatedTokenAddress(source, mint, tokenProgram),
      destinationTokenAccount: getAssociatedTokenAddress(destination, mint, tokenProgram),
      sourceStrategy: tracked ? getStrategyPda(source, mint, env.programId) : null,
      destinationStrategy: tracked ? getStrategyPda(destination, mint, env.programId) : null,
      tokenProgram,
      delegate: delegateFor(operator, DELEGATE_ALL),
    })
    .instruction();
};

/**
 * The mint a transfer moves, from the request's optional `mint`. Outside the deposit mint the sending vault
 * must already track it; the receiving vault's Jupiter strategy is created first when it has none.
 */
async function transferMint(
  env: BuildEnv,
  parent: VaultCtx,
  parentOperator: Operator,
  source: VaultCtx,
  destination: VaultCtx,
  mint: string | undefined,
): Promise<{ mint?: TransferMint; setup: TransactionInstruction[] }> {
  if (!mint || mint === parent.depositMint.toBase58()) return { setup: [] };
  const key = new PublicKey(mint);
  const [sending, receiving, mintInfo] = await env.connection.getMultipleAccountsInfo([
    getStrategyPda(source.key, key, env.programId),
    getStrategyPda(destination.key, key, env.programId),
    key,
  ]);
  if (!sending) throw new ApiError(400, "Validation", "The sending vault does not hold this token");
  if (!mintInfo) throw new ApiError(404, "NotFound", `Mint ${mint} not found`);
  const setup: TransactionInstruction[] = [];
  if (!receiving) {
    // A child accepts its own delegates and its parent's.
    const operator = destination.key.equals(parent.key) ? parentOperator : await assertOperator(env, destination, env.payer);
    setup.push(await jupiterInitializeIx(env, destination, operator, key));
  }
  return { mint: { mint: key, tokenProgram: mintInfo.owner }, setup };
}

export const escrowCreateInput = z.object({
  vault: pubkey,
  name: vaultName,
  fundAmount: amountString.refine((s) => /[1-9]/.test(s), "must be greater than 0").optional(),
});

/** 3 RPC: the parent and the config. Carries the new child's address. */
export async function escrowCreateInstructions(env: BuildEnv, b: z.infer<typeof escrowCreateInput>): Promise<InstructionSet & { child: string }> {
  const parent = await loadVaultCtx(env, b.vault);
  assertAuthority(parent, env.payer);
  if (isChildAccount(parent.account)) throw new ApiError(400, "Validation", "A child vault cannot have child vaults");
  if (parent.account.childCount >= MAX_CHILD_VAULTS) throw new ApiError(400, "Validation", `Vault already has ${MAX_CHILD_VAULTS} child vaults`);
  const config = getConfigPda(env.programId);
  const configInfo = await env.connection.getAccountInfo(config);
  if (!configInfo) throw new Error("Protocol config account is missing");
  const { nextVaultId } = env.program.coder.accounts.decode<ConfigAccount>("config", configInfo.data);
  const child = getVaultPda(BigInt(nextVaultId.toString()), env.programId);
  const create = await env.program.methods
    .escrowCreate({ name: encodeName(b.name) })
    .accountsPartial({
      authority: env.payer,
      config,
      parent: parent.key,
      // The IDL cannot express the next_vault_id seed, so the child is passed explicitly.
      child,
      depositMint: parent.depositMint,
      childTokenAccount: getAssociatedTokenAddress(child, parent.depositMint, parent.tokenProgram),
      depositMintTokenProgram: parent.tokenProgram,
    })
    .instruction();
  const fund = b.fundAmount ? [await escrowTransferIx(env, parent, null, parent.key, child, new BN(b.fundAmount))] : [];
  return { instructions: [create, ...fund], child: child.toBase58() };
}

export const buildEscrowCreate = assembled(escrowCreateInstructions);

export const escrowMoveInput = z.object({ vault: pubkey, child: pubkey, amount: amountString, mint: pubkey.optional() });

async function escrowMove(env: BuildEnv, b: z.infer<typeof escrowMoveInput>, toChild: boolean): Promise<InstructionSet> {
  const parent = await loadVaultCtx(env, b.vault);
  const operator = await assertOperator(env, parent, env.payer);
  const child = await loadChild(env, parent, b.child);
  const [source, destination] = toChild ? [parent, child] : [child, parent];
  const { mint, setup } = await transferMint(env, parent, operator, source, destination, b.mint);
  return { instructions: [...setup, await escrowTransferIx(env, parent, operator, source.key, destination.key, new BN(b.amount), mint)] };
}

export const escrowFundInstructions = (env: BuildEnv, b: z.infer<typeof escrowMoveInput>) => escrowMove(env, b, true);
export const escrowDefundInstructions = (env: BuildEnv, b: z.infer<typeof escrowMoveInput>) => escrowMove(env, b, false);
export const buildEscrowFund = assembled(escrowFundInstructions);
export const buildEscrowDefund = assembled(escrowDefundInstructions);

export const escrowTransferInput = z
  .object({ vault: pubkey, source: pubkey, destination: pubkey, amount: amountString, mint: pubkey.optional() })
  .refine((b) => b.source !== b.destination, "source and destination must differ");

/** Moves tokens between any two vaults of one family: the parent `vault` and its child vaults, in any direction. */
export async function escrowTransferInstructions(env: BuildEnv, b: z.infer<typeof escrowTransferInput>): Promise<InstructionSet> {
  const parent = await loadVaultCtx(env, b.vault);
  const operator = await assertOperator(env, parent, env.payer);
  const member = (address: string) => (address === b.vault ? Promise.resolve(parent) : loadChild(env, parent, address));
  const source = await member(b.source);
  const destination = await member(b.destination);
  const { mint, setup } = await transferMint(env, parent, operator, source, destination, b.mint);
  return { instructions: [...setup, await escrowTransferIx(env, parent, operator, source.key, destination.key, new BN(b.amount), mint)] };
}

export const buildEscrowTransfer = assembled(escrowTransferInstructions);

export const escrowCloseInput = z.object({ vault: pubkey, child: pubkey, defundFirst: z.boolean().optional() });

/**
 * Sweeps a child vault back into its parent: every Jupiter-tracked token and its emptied strategy, then the idle
 * deposit token. Balances are read fresh: the sweep must move every base unit or the strategy cannot close.
 */
async function defundAll(env: BuildEnv, parent: VaultCtx, child: VaultCtx): Promise<TransactionInstruction[]> {
  const coder = env.program.coder.accounts;
  const rows = await env.connection.getProgramAccounts(env.programId, {
    filters: [{ memcmp: coder.memcmp("strategy") }, { memcmp: { offset: STRATEGY_VAULT_OFFSET, bytes: child.key.toBase58() } }],
  });
  const mints = rows.map(({ account }) => {
    const { strategyType } = coder.decode<IdlAccounts<HedgeVault>["strategy"]>("strategy", account.data);
    if (!strategyType.jupiterSwap) throw new ApiError(400, "Validation", "Close the child vault's positions, orders and Phoenix account first");
    return strategyType.jupiterSwap.targetMint;
  });
  const tracked = await Promise.all(mints.map(async (mint) => ({ mint, tokenProgram: await readTokenProgram(env, mint) })));
  const [idle, ...held] = await env.connection.getMultipleAccountsInfo([
    getAssociatedTokenAddress(child.key, child.depositMint, child.tokenProgram),
    ...tracked.map(({ mint, tokenProgram }) => getAssociatedTokenAddress(child.key, mint, tokenProgram)),
  ]);
  const ixs: TransactionInstruction[] = [];
  for (const [i, { mint, tokenProgram }] of tracked.entries()) {
    const balance = decodeTokenAmount(held[i]?.data);
    if (balance > 0n) {
      const { mint: transfer, setup } = await transferMint(env, parent, null, child, parent, mint.toBase58());
      ixs.push(...setup, await escrowTransferIx(env, parent, null, child.key, parent.key, new BN(balance.toString()), transfer));
    }
    ixs.push(await closeJupiterStrategyIx(env, child, null, mint, tokenProgram));
  }
  const balance = decodeTokenAmount(idle?.data);
  if (balance > 0n) ixs.push(await escrowTransferIx(env, parent, null, child.key, parent.key, new BN(balance.toString())));
  return ixs;
}

/**
 * Closes a child vault. With `defundFirst` the same transaction first sweeps it into the parent. LP positions,
 * limit orders and Phoenix accounts must be closed beforehand.
 */
export async function escrowCloseInstructions(env: BuildEnv, b: z.infer<typeof escrowCloseInput>): Promise<InstructionSet> {
  const parent = await loadVaultCtx(env, b.vault);
  assertAuthority(parent, env.payer);
  const child = await loadChild(env, parent, b.child);
  const sweep = b.defundFirst ? await defundAll(env, parent, child) : [];
  const close = await env.program.methods
    .escrowClose()
    .accountsPartial({
      authority: env.payer,
      config: getConfigPda(env.programId),
      parent: parent.key,
      child: child.key,
      depositMint: child.depositMint,
      childTokenAccount: getAssociatedTokenAddress(child.key, child.depositMint, child.tokenProgram),
      usdcTokenAccount: child.depositMint.equals(USDC_MINT) ? null : getAssociatedTokenAddress(child.key, USDC_MINT, TOKEN_PROGRAM_ID),
      depositMintTokenProgram: child.tokenProgram,
    })
    .instruction();
  return { instructions: [...sweep, close] };
}

export const buildEscrowClose = assembled(escrowCloseInstructions);
