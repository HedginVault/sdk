import { readFileSync } from "node:fs";
import { Keypair, type PublicKey, VersionedTransaction } from "@solana/web3.js";
import { UnsafeTransactionError } from "./errors";

/** The Hedge Vault program published at hedgin.xyz/idl/hedge_vault.json. */
export const HEDGE_VAULT_PROGRAM_ID = "r2ahBQ6gbPCJ9FxBymYcXuwXi8NmenRry7SE7QR7FAt";

/** Phoenix Perpetuals, called directly only by its own onboarding transaction. */
export const PHOENIX_PROGRAM_ID = "EtrnLzgbS7nMMy5fbD42kXiUzGg8XQzJ972Xtk1cjWih";

const COMPUTE_BUDGET_PROGRAM = "ComputeBudget111111111111111111111111111111";
const SET_COMPUTE_UNIT_LIMIT = 2;
const SET_COMPUTE_UNIT_PRICE = 3;
/** The most compute units a transaction can request; assumed when a priced transaction sets no limit. */
const MAX_COMPUTE_UNIT_LIMIT = 1_400_000n;

/**
 * Pump.fun AMM `init_user_volume_accumulator`, which the app adds before a Jupiter route through
 * Pump AMM when the swap authority has none: the manager pays its rent. Pump AMM's other
 * instructions can spend the signer's own SOL, so only this one is allowed.
 */
const PUMP_AMM_PROGRAM = "pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA";
const PUMP_AMM_INIT_USER_VOLUME_ACCUMULATOR = Buffer.from([94, 6, 202, 115, 255, 96, 232, 183]);

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

/**
 * The app's automatic-fee budget: 0.001 SOL per transaction. It prices from Helius's estimate but
 * never lets price × compute unit limit exceed this, so a builder transaction always fits.
 */
export const DEFAULT_MAX_PRIORITY_FEE_LAMPORTS = 1_000_000n;

/** The app's ultra ceiling on the price per compute unit, for callers that also cap the price itself. */
export const DEFAULT_MAX_COMPUTE_UNIT_PRICE_MICROLAMPORTS = 500_000n;

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
  /** Refuse when the priority fee, price × compute unit limit rounded up to lamports, exceeds this. */
  maxPriorityFeeLamports: bigint;
  /** Also refuse a price per compute unit above this; unset means only the total is capped. */
  maxComputeUnitPriceMicroLamports?: bigint;
}

function decodeForSigner(base64: string, manager: PublicKey): VersionedTransaction {
  let tx: VersionedTransaction;
  try {
    tx = VersionedTransaction.deserialize(Buffer.from(base64, "base64"));
  } catch {
    throw new UnsafeTransactionError("Not a serialized Solana transaction");
  }
  if (tx.version !== 0) throw new UnsafeTransactionError("Expected a v0 transaction");
  const payer = tx.message.staticAccountKeys[0];
  if (!payer?.equals(manager)) {
    throw new UnsafeTransactionError(`Fee payer ${payer?.toBase58() ?? "missing"} is not the signer's key`);
  }
  return tx;
}

function checkPrograms(tx: VersionedTransaction, allowed: (program: string, data: Uint8Array) => boolean, policy: SigningPolicy): void {
  const { staticAccountKeys, compiledInstructions } = tx.message;
  let limit: bigint | undefined;
  let price: bigint | undefined;
  for (const instruction of compiledInstructions) {
    // v0 requires invoked programs to be static keys; an index past them would be malformed.
    const program = staticAccountKeys[instruction.programIdIndex]?.toBase58();
    if (!program || !allowed(program, instruction.data)) throw new UnsafeTransactionError(`Unexpected program ${program ?? "outside static keys"}`);
    if (program !== COMPUTE_BUDGET_PROGRAM) continue;
    if (instruction.data[0] === SET_COMPUTE_UNIT_LIMIT) limit = BigInt(Buffer.from(instruction.data).readUInt32LE(1));
    if (instruction.data[0] === SET_COMPUTE_UNIT_PRICE) price = Buffer.from(instruction.data).readBigUInt64LE(1);
  }
  if (price === undefined) return;
  if (policy.maxComputeUnitPriceMicroLamports !== undefined && price > policy.maxComputeUnitPriceMicroLamports) {
    throw new UnsafeTransactionError(`Priority fee ${price} microLamports/CU is above the cap`);
  }
  // The runtime charges price × limit microLamports, rounded up. A missing limit is read at the maximum so it cannot hide a fee.
  const lamports = (price * (limit ?? MAX_COMPUTE_UNIT_LIMIT) + 999_999n) / 1_000_000n;
  if (lamports > policy.maxPriorityFeeLamports) {
    throw new UnsafeTransactionError(`Priority fee ${lamports} lamports is above the ${policy.maxPriorityFeeLamports} lamport cap`);
  }
}

/** Decodes a builder transaction and checks it against the policy before anything signs it. */
export function inspectTransaction(base64: string, policy: SigningPolicy): VersionedTransaction {
  const tx = decodeForSigner(base64, policy.manager);
  const { staticAccountKeys, header } = tx.message;
  for (let index = 1; index < header.numRequiredSignatures; index++) {
    if (tx.signatures[index]?.every((byte) => byte === 0) !== false) {
      throw new UnsafeTransactionError(`Transaction also needs a signature from ${staticAccountKeys[index]?.toBase58() ?? "an unknown key"}`);
    }
  }
  const allowed = (program: string, data: Uint8Array) =>
    program === policy.programId ||
    BUILDER_PROGRAMS.includes(program) ||
    (program === PUMP_AMM_PROGRAM && Buffer.from(data).equals(PUMP_AMM_INIT_USER_VOLUME_ACCUMULATOR));
  checkPrograms(tx, allowed, policy);
  return tx;
}

/**
 * The Phoenix onboarding policy, used only by `onboardPhoenix`. Phoenix's onboarder signs after
 * the manager, so other signatures may still be missing. In exchange every top-level instruction
 * must be the Phoenix program; ComputeBudget is refused too, so no priority fee can be set at all.
 */
export function inspectPhoenixOnboardTransaction(base64: string, policy: SigningPolicy): VersionedTransaction {
  const tx = decodeForSigner(base64, policy.manager);
  if (tx.message.compiledInstructions.length === 0) throw new UnsafeTransactionError("Onboarding transaction has no instructions");
  checkPrograms(tx, (program) => program === PHOENIX_PROGRAM_ID, policy);
  return tx;
}
