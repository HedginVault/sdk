import { PublicKey, type TransactionInstruction } from "@solana/web3.js";
import { z } from "zod";
import { getConfigPda } from "../chain/pda";
import { assemble, type Assembled } from "./assemble";
import { assertOperator, type BuildEnv, DELEGATE_JUPITER, delegateFor, loadVaultCtx, type Operator, pubkey, type VaultCtx } from "./context";

export const jupiterInitializeInput = z.object({ vault: pubkey, targetMint: pubkey });

export const jupiterInitializeIx = (env: BuildEnv, vault: VaultCtx, operator: Operator, targetMint: PublicKey): Promise<TransactionInstruction> =>
  env.program.methods
    .jupiterInitializeStrategy()
    .accounts({
      authority: env.payer,
      config: getConfigPda(env.programId),
      vault: vault.key,
      destinationMint: targetMint,
      delegate: delegateFor(operator, DELEGATE_JUPITER),
    })
    .instruction();

export async function buildJupiterInitialize(env: BuildEnv, b: z.infer<typeof jupiterInitializeInput>): Promise<Assembled> {
  const vault = await loadVaultCtx(env, b.vault);
  const operator = await assertOperator(env, vault, env.payer);
  return assemble(env, [await jupiterInitializeIx(env, vault, operator, new PublicKey(b.targetMint))]);
}
