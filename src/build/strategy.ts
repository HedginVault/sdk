import type { IdlAccounts } from "@coral-xyz/anchor";
import { type AccountMeta, PublicKey } from "@solana/web3.js";
import { z } from "zod";
import { getAssociatedTokenAddress, getConfigPda, getStrategyPda } from "../chain/pda";
import { ApiError } from "../errors";
import type { HedgeVault } from "../idl/hedge_vault";
import { assembled, type InstructionSet } from "./assemble";
import {
  assertOperator,
  type BuildEnv,
  DELEGATE_JUPITER,
  DELEGATE_METEORA_DLMM,
  DELEGATE_PHOENIX,
  delegateFor,
  loadVaultCtx,
  type Operator,
  pubkey,
  readTokenProgram,
  type VaultCtx,
} from "./context";
import { PHOENIX_GLOBAL_CONFIG, readCanonicalMint } from "./phoenix-accounts";

type StrategyAccount = IdlAccounts<HedgeVault>["strategy"];

const TOKEN_PROGRAM_ID = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
export const DLMM_PROGRAM_ID = new PublicKey("LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo");
export const DLMM_EVENT_AUTHORITY = new PublicKey("D1ZN9Wj1fRSUQfCjhvnu1hqDMT7hzjzBBpi12nVniYD6");
export const LIMIT_ORDER_DISCRIMINATOR = Buffer.from([137, 183, 212, 91, 115, 29, 141, 227]);

const writable = (pubkey: PublicKey): AccountMeta => ({ pubkey, isWritable: true, isSigner: false });
const readonly = (pubkey: PublicKey): AccountMeta => ({ pubkey, isWritable: false, isSigner: false });

const jupiterCloseAccounts = (vault: VaultCtx, mint: PublicKey, tokenProgram: PublicKey) => [
  writable(getAssociatedTokenAddress(vault.key, mint, tokenProgram)),
  readonly(tokenProgram),
];

/** `vault_close_strategy` of the Jupiter strategy for `mint`, whose token program the caller already read. */
export const closeJupiterStrategyIx = (env: BuildEnv, vault: VaultCtx, operator: Operator, mint: PublicKey, tokenProgram: PublicKey) =>
  env.program.methods
    .vaultCloseStrategy()
    .accounts({
      authority: env.payer,
      config: getConfigPda(env.programId),
      vault: vault.key,
      strategy: getStrategyPda(vault.key, mint, env.programId),
      delegate: delegateFor(operator, DELEGATE_JUPITER),
    })
    .remainingAccounts(jupiterCloseAccounts(vault, mint, tokenProgram))
    .instruction();

export const strategyCloseInput = z.object({ vault: pubkey, strategy: pubkey });

/** 1 RPC: the account must exist. Anchor's `fetch` errors become a 404 like the app's. */
async function readAccount(env: BuildEnv, key: PublicKey, what: string) {
  const info = await env.connection.getAccountInfo(key);
  if (!info) throw new ApiError(404, "NotFound", `${what} not found`);
  return info;
}

/** The lb_pair of a DLMM position or limit order and its mints, from which the pair strategies follow. */
async function readDlmmPair(env: BuildEnv, protocolAccount: PublicKey, kind: "position" | "limitOrder"): Promise<DlmmPair> {
  const info = await readAccount(env, protocolAccount, kind === "position" ? "Position" : "Limit order");
  let lbPair: PublicKey;
  if (kind === "position") {
    lbPair = env.program.coder.accounts.decode<IdlAccounts<HedgeVault>["positionV2"]>("positionV2", info.data).lbPair;
  } else {
    // The hedge_vault IDL has no LimitOrder account; its lb_pair is the first field after the discriminator.
    if (!info.owner.equals(DLMM_PROGRAM_ID) || info.data.length < 40 || !info.data.subarray(0, 8).equals(LIMIT_ORDER_DISCRIMINATOR))
      throw new ApiError(400, "Validation", "Account is not a DLMM limit order");
    lbPair = new PublicKey(info.data.subarray(8, 40));
  }
  const pair = env.program.coder.accounts.decode<IdlAccounts<HedgeVault>["lbPair"]>("lbPair", (await readAccount(env, lbPair, "Pool")).data);
  return { lbPair, tokenXMint: pair.tokenXMint, tokenYMint: pair.tokenYMint };
}

export interface DlmmPair {
  lbPair: PublicKey;
  tokenXMint: PublicKey;
  tokenYMint: PublicKey;
}

/** A DLMM position and a DLMM limit order close through the same six accounts. */
function dlmmCloseAccounts(env: BuildEnv, vault: VaultCtx, protocolAccount: PublicKey, pair: DlmmPair): AccountMeta[] {
  // The hedge_vault program id stands for "no strategy" on the deposit mint side.
  const pairStrategyMeta = (mint: PublicKey) => readonly(mint.equals(vault.depositMint) ? env.programId : getStrategyPda(vault.key, mint, env.programId));
  return [
    writable(protocolAccount),
    readonly(DLMM_PROGRAM_ID),
    readonly(DLMM_EVENT_AUTHORITY),
    readonly(pair.lbPair),
    pairStrategyMeta(pair.tokenXMint),
    pairStrategyMeta(pair.tokenYMint),
  ];
}

/** `vault_close_strategy` of the DLMM position or limit order `protocolAccount`, whose pair the caller already read. */
export const closeDlmmStrategyIx = (env: BuildEnv, vault: VaultCtx, operator: Operator, protocolAccount: PublicKey, pair: DlmmPair) =>
  env.program.methods
    .vaultCloseStrategy()
    .accounts({
      authority: env.payer,
      config: getConfigPda(env.programId),
      vault: vault.key,
      strategy: getStrategyPda(vault.key, protocolAccount, env.programId),
      delegate: delegateFor(operator, DELEGATE_METEORA_DLMM),
    })
    .remainingAccounts(dlmmCloseAccounts(env, vault, protocolAccount, pair))
    .instruction();

/** The remaining accounts `vault_close_strategy` takes for each strategy type, and the delegate permission it checks. */
async function closeAccounts(env: BuildEnv, vault: VaultCtx, strategyType: StrategyAccount["strategyType"]): Promise<{ permission: number; remaining: AccountMeta[] }> {
  const dlmm = async (protocolAccount: PublicKey, kind: "position" | "limitOrder") => ({
    permission: DELEGATE_METEORA_DLMM,
    remaining: dlmmCloseAccounts(env, vault, protocolAccount, await readDlmmPair(env, protocolAccount, kind)),
  });
  if (strategyType.meteoraDlmm) return dlmm(strategyType.meteoraDlmm.position, "position");
  // The program closes a limit order only once every bin is empty, i.e. after cancelling them all.
  if (strategyType.meteoraDlmmLimitOrder) return dlmm(strategyType.meteoraDlmmLimitOrder.limitOrder, "limitOrder");
  if (strategyType.phoenixPerp) {
    // The program closes the vault's canonical-mint ATA (SPL Token) if it exists; the mint comes from Phoenix.
    const canonicalMint = await readCanonicalMint(env);
    return {
      permission: DELEGATE_PHOENIX,
      remaining: [
        readonly(strategyType.phoenixPerp.traderAccount),
        readonly(PHOENIX_GLOBAL_CONFIG),
        writable(getAssociatedTokenAddress(vault.key, canonicalMint, TOKEN_PROGRAM_ID)),
        readonly(TOKEN_PROGRAM_ID),
      ],
    };
  }
  if (strategyType.jupiterSwap) {
    const mint = strategyType.jupiterSwap.targetMint;
    return { permission: DELEGATE_JUPITER, remaining: jupiterCloseAccounts(vault, mint, await readTokenProgram(env, mint)) };
  }
  throw new ApiError(400, "Validation", "Unsupported strategy type");
}

export async function strategyCloseInstructions(env: BuildEnv, b: z.infer<typeof strategyCloseInput>): Promise<InstructionSet> {
  const vault = await loadVaultCtx(env, b.vault);
  const operator = await assertOperator(env, vault, env.payer);
  const strategy = new PublicKey(b.strategy);
  const info = await env.connection.getAccountInfo(strategy);
  if (!info?.owner.equals(env.programId)) throw new ApiError(404, "NotFound", "Strategy not found");
  const account = env.program.coder.accounts.decode<StrategyAccount>("strategy", info.data);
  // Guard before deriving anything from the payload: a foreign strategy would build against another vault's accounts.
  if (!account.vault.equals(vault.key)) throw new ApiError(400, "Validation", "Strategy does not belong to this vault");
  const { permission, remaining } = await closeAccounts(env, vault, account.strategyType);
  const ix = await env.program.methods
    .vaultCloseStrategy()
    .accounts({ authority: env.payer, config: getConfigPda(env.programId), vault: vault.key, strategy, delegate: delegateFor(operator, permission) })
    .remainingAccounts(remaining)
    .instruction();
  return { instructions: [ix] };
}

export const buildStrategyClose = assembled(strategyCloseInstructions);
