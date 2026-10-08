import { readFileSync } from "node:fs";
import { Keypair, type PublicKey, VersionedTransaction } from "@solana/web3.js";
import { UnsafeTransactionError } from "./errors";

/** The Hedge Vault program published at hedgin.xyz/idl/hedge_vault.json. */
export const HEDGE_VAULT_PROGRAM_ID = "r2ahBQ6gbPCJ9FxBymYcXuwXi8NmenRry7SE7QR7FAt";

const COMPUTE_BUDGET_PROGRAM = "ComputeBudget111111111111111111111111111111";
const SET_COMPUTE_UNIT_PRICE = 3;

/**
 * Programs the app's V1 builders call as top-level instructions. Token movement happens by CPI
 * inside the Hedge Vault program, so nothing here can transfer funds out of the manager wallet;
 * the manager only pays rent (ATA, DLMM bin arrays) and the capped priority fee.
 */
const BUILDER_PROGRAMS = [
  COMPUTE_BUDGET_PROGRAM,
  "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL", // Associated Token Account: create-idempotent
  "LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo", // Meteora DLMM: initializeBinArray
  "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4", // Jupiter: setTokenLedger in zap-out
];

/** The app caps priority fees at 10,000 microLamports per CU; allow headroom, not an open checkbook. */
export const DEFAULT_MAX_COMPUTE_UNIT_PRICE_MICROLAMPORTS = 100_000n;

/**
 * Anything that can sign as the vault manager: a local keypair, a hardware wallet, or a
 * KMS-backed signer. It must add its signature and keep signatures the builder already added.
 */
export interface TransactionSigner {
  publicKey: PublicKey;
  signTransaction(tx: VersionedTransaction): Promise<VersionedTransaction>;
}

export function keypairSigner(keypair: Keypair): TransactionSigner {
  return {
    publicKey: keypair.publicKey,
    signTransaction: async (tx) => {
      tx.sign([keypair]);
      return tx;
    },
  };
}

/** Reads a Solana CLI keypair file (JSON array of 64 bytes). Errors never include the file contents. */
export function keypairFromFile(path: string): Keypair {
  let bytes: unknown;
  try {
    bytes = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    throw new Error(`Cannot read a JSON keypair file at ${path}`);
  }
  if (!Array.isArray(bytes) || bytes.length !== 64 || !bytes.every((b) => Number.isInteger(b) && b >= 0 && b <= 255)) {
    throw new Error("Keypair file is not a 64-byte Solana keypair array");
  }
  return Keypair.fromSecretKey(Uint8Array.from(bytes as number[]));
}

export interface SigningPolicy {
  manager: PublicKey;
  programId: string;
  maxComputeUnitPriceMicroLamports: bigint;
}

/** Decodes a builder transaction and checks it against the policy before anything signs it. */
export function inspectTransaction(base64: string, policy: SigningPolicy): VersionedTransaction {
  let tx: VersionedTransaction;
  try {
    tx = VersionedTransaction.deserialize(Buffer.from(base64, "base64"));
  } catch {
    throw new UnsafeTransactionError("Not a serialized Solana transaction");
  }
  if (tx.version !== 0) throw new UnsafeTransactionError("Expected a v0 transaction");

  const { staticAccountKeys, header, compiledInstructions } = tx.message;
  const payer = staticAccountKeys[0];
  if (!payer?.equals(policy.manager)) {
    throw new UnsafeTransactionError(`Fee payer ${payer?.toBase58() ?? "missing"} is not the signer's key`);
  }
  for (let index = 1; index < header.numRequiredSignatures; index++) {
    if (tx.signatures[index]?.every((byte) => byte === 0) !== false) {
      throw new UnsafeTransactionError(`Transaction also needs a signature from ${staticAccountKeys[index]?.toBase58() ?? "an unknown key"}`);
    }
  }

  const allowed = new Set([policy.programId, ...BUILDER_PROGRAMS]);
  for (const instruction of compiledInstructions) {
    // v0 requires invoked programs to be static keys; an index past them would be malformed.
    const program = staticAccountKeys[instruction.programIdIndex]?.toBase58();
    if (!program || !allowed.has(program)) throw new UnsafeTransactionError(`Unexpected program ${program ?? "outside static keys"}`);
    if (program === COMPUTE_BUDGET_PROGRAM && instruction.data[0] === SET_COMPUTE_UNIT_PRICE) {
      const price = Buffer.from(instruction.data).readBigUInt64LE(1);
      if (price > policy.maxComputeUnitPriceMicroLamports) {
        throw new UnsafeTransactionError(`Priority fee ${price} microLamports/CU is above the cap`);
      }
    }
  }
  return tx;
}
