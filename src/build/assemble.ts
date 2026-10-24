import {
  type AddressLookupTableAccount,
  ComputeBudgetProgram,
  PACKET_DATA_SIZE,
  PublicKey,
  type TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
} from "@solana/web3.js";
import { ApiError } from "../errors";
import type { BuildEnv } from "./context";
import { describeTxFailure } from "./program-errors";

const MAX_COMPUTE_UNITS = 1_400_000;
const MIN_MICRO_LAMPORTS = 1_000;
const MAX_MICRO_LAMPORTS = 10_000;

export interface Assembled {
  /** Unsigned base64 v0 transaction. */
  transaction: string;
  simulation: { unitsConsumed: number };
  blockhash: string;
}

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

/** 3 RPC: fee sample, simulation, blockhash. Builds a v0 transaction paid by `env.payer` and never signs it. */
export async function assemble(env: BuildEnv, instructions: TransactionInstruction[], lookupTables: AddressLookupTableAccount[] = []): Promise<Assembled> {
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
  return { transaction: Buffer.from(compile(blockhash, units).serialize()).toString("base64"), simulation: { unitsConsumed }, blockhash };
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
