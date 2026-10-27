import {
  type AddressLookupTableAccount,
  ComputeBudgetProgram,
  type Keypair,
  PACKET_DATA_SIZE,
  PublicKey,
  type TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
} from "@solana/web3.js";
import { ApiError } from "../errors";
import type { BuildEnv } from "./context";
import { COMPUTE_LIMIT_MESSAGE, describeTxFailure } from "./program-errors";

const MAX_COMPUTE_UNITS = 1_400_000;
const MIN_MICRO_LAMPORTS = 1_000;
const MAX_MICRO_LAMPORTS = 10_000;

export interface Assembled {
  /** Base64 v0 transaction, unsigned by the payer. */
  transaction: string;
  simulation: { unitsConsumed: number; deferred?: boolean };
  blockhash: string;
  /** Consecutive marked steps may be sent together; an unmarked step is a confirmation barrier. */
  sendConcurrently?: boolean;
}

export interface AssembleOptions {
  /** Keys the transaction creates, such as a new DLMM position: they sign at build time. */
  signers?: Keypair[];
  /**
   * A later step of one batch may depend on accounts an earlier step creates, which a simulation
   * cannot see. It then keeps the 1.4M CU limit, and the send's preflight validates it.
   */
  deferSimulation?: boolean;
}

/** One transaction's instructions, before `assemble` adds the compute budget, fee, blockhash and simulation. */
export interface InstructionSet {
  instructions: TransactionInstruction[];
  lookupTables?: AddressLookupTableAccount[];
  /** Keys the transaction creates, such as a new DLMM position: they must sign it too. */
  signers?: Keypair[];
}

/** Turns an instruction builder into a step builder; extra fields such as a new address ride along. */
export function assembled<B, R extends InstructionSet>(instructionsOf: (env: BuildEnv, b: B) => Promise<R>) {
  return async (env: BuildEnv, b: B): Promise<Assembled & Omit<R, keyof InstructionSet>> => {
    const { instructions, lookupTables, signers, ...meta } = await instructionsOf(env, b);
    return { ...(await assemble(env, instructions, lookupTables, { signers })), ...meta };
  };
}

/** A simulation that ran out of compute: the caller may retry with fewer bins. */
export const isComputeLimitError = (e: unknown) => e instanceof ApiError && e.code === "SimulationFailed" && e.message === COMPUTE_LIMIT_MESSAGE;

/** Bounded upper-quartile fee: enough to compete without letting an RPC response overspend. */
function selectPriorityFeeMicroLamports(samples: number[]): number {
  const sorted = samples.filter((fee) => Number.isSafeInteger(fee) && fee >= 0).sort((a, b) => a - b);
  const upperQuartile = sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.75))];
  if (upperQuartile === undefined) return MIN_MICRO_LAMPORTS;
  return Math.max(MIN_MICRO_LAMPORTS, Math.min(MAX_MICRO_LAMPORTS, upperQuartile));
}

async function priorityFeeMicroLamports(env: BuildEnv, writableAccounts: PublicKey[]): Promise<number> {
  try {
    const samples = await env.connection.getRecentPrioritizationFees({ lockedWritableAccounts: writableAccounts });
    return selectPriorityFeeMicroLamports(samples.map(({ prioritizationFee }) => prioritizationFee));
  } catch {
    return MIN_MICRO_LAMPORTS;
  }
}

/** 2-3 RPC: fee sample, simulation unless deferred, blockhash. Builds a v0 transaction paid by `env.payer` and never signs for it. */
export async function assemble(
  env: BuildEnv,
  instructions: TransactionInstruction[],
  lookupTables: AddressLookupTableAccount[] = [],
  { signers = [], deferSimulation = false }: AssembleOptions = {},
): Promise<Assembled> {
  const writableAccounts = [
    ...new Map(
      [env.payer, ...instructions.flatMap((ix) => ix.keys.filter((key) => key.isWritable).map((key) => key.pubkey))].map((key) => [key.toBase58(), key]),
    ).values(),
  ].slice(0, 128);
  const microLamports = await priorityFeeMicroLamports(env, writableAccounts);
  const compile = (blockhash: string, units: number) =>
    new VersionedTransaction(
      new TransactionMessage({
        payerKey: env.payer,
        recentBlockhash: blockhash,
        instructions: [ComputeBudgetProgram.setComputeUnitLimit({ units }), ComputeBudgetProgram.setComputeUnitPrice({ microLamports }), ...instructions],
      }).compileToV0Message(lookupTables),
    );

  if (deferSimulation) {
    const { blockhash } = await env.connection.getLatestBlockhash("confirmed");
    return { transaction: serialize(compile(blockhash, MAX_COMPUTE_UNITS), signers), simulation: { unitsConsumed: 0, deferred: true }, blockhash };
  }
  // Simulating before fetching the blockhash gives signing its full lifetime and sizes the CU limit to this transaction.
  const sim = await env.connection.simulateTransaction(compile(PublicKey.default.toBase58(), MAX_COMPUTE_UNITS), {
    sigVerify: false,
    replaceRecentBlockhash: true,
  });
  if (sim.value.err) {
    const failure = describeTxFailure(sim.value.logs ?? [], JSON.stringify(sim.value.err), env.programId.toBase58());
    throw new ApiError(422, failure.code ?? "SimulationFailed", failure.message);
  }
  const unitsConsumed = sim.value.unitsConsumed ?? 0;
  const consumed = sim.value.unitsConsumed ?? MAX_COMPUTE_UNITS;
  const units = Math.min(MAX_COMPUTE_UNITS, Math.max(consumed, Math.ceil(consumed * 1.2) + 10_000));
  const { blockhash } = await env.connection.getLatestBlockhash("confirmed");
  return { transaction: serialize(compile(blockhash, units), signers), simulation: { unitsConsumed }, blockhash };
}

function serialize(tx: VersionedTransaction, signers: Keypair[]): string {
  if (signers.length) tx.sign(signers);
  return Buffer.from(tx.serialize()).toString("base64");
}

/**
 * 1 RPC: one fresh blockhash for a batch whose quotes and simulations took a while, so every step's
 * lifetime starts together. Only for wholly unsigned steps: a new blockhash voids any signature.
 */
export async function refreshBatch<T extends Assembled>(env: BuildEnv, steps: T[]): Promise<T[]> {
  const txs = steps.map((step) => VersionedTransaction.deserialize(Buffer.from(step.transaction, "base64")));
  if (txs.some((tx) => tx.signatures.some((signature) => signature.some((byte) => byte !== 0))))
    throw new Error("Cannot refresh a transaction that already has signatures");
  const { blockhash } = await env.connection.getLatestBlockhash("confirmed");
  return steps.map((step, i) => {
    const tx = txs[i];
    if (!tx) return step;
    tx.message.recentBlockhash = blockhash;
    return { ...step, transaction: Buffer.from(tx.serialize()).toString("base64"), blockhash };
  });
}

/**
 * Whether the instructions, with the compute-budget pair `assemble` prepends, serialize into one packet.
 * Measured rather than caught: `serialize()` throws only once the message alone overruns, missing the
 * signatures that can push it over.
 */
export function fitsInTransaction(payer: PublicKey, instructions: TransactionInstruction[], lookupTables: AddressLookupTableAccount[] = []): boolean {
  try {
    const message = new TransactionMessage({
      payerKey: payer,
      recentBlockhash: PublicKey.default.toBase58(),
      instructions: [
        ComputeBudgetProgram.setComputeUnitLimit({ units: MAX_COMPUTE_UNITS }),
        ComputeBudgetProgram.setComputeUnitPrice({ microLamports: MAX_MICRO_LAMPORTS }),
        ...instructions,
      ],
    }).compileToV0Message(lookupTables);
    return new VersionedTransaction(message).serialize().length <= PACKET_DATA_SIZE;
  } catch (e) {
    if (e instanceof RangeError) return false;
    throw e;
  }
}
