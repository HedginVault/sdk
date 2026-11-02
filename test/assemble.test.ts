import { ComputeBudgetInstruction, ComputeBudgetProgram, SystemProgram, TransactionMessage, VersionedTransaction } from "@solana/web3.js";
import { describe, expect, it } from "vitest";
import { assemble } from "../src/build/assemble";
import { buildEnv } from "../src/build/context";
import { jupiterConfig } from "../src/build/jupiter-api";
import { chain, fakeConnection, manager, NOW_MS, PROGRAM } from "./direct-chain";

async function unitLimitOf(options: Parameters<typeof assemble>[3]) {
  const fake = fakeConnection(await chain());
  const env = buildEnv({
    connection: fake.connection,
    programId: PROGRAM,
    payer: manager.publicKey,
    now: () => NOW_MS,
    fetch: globalThis.fetch,
    jupiter: jupiterConfig(),
    phoenixApiUrl: "https://perp-api.phoenix.trade",
  });
  const transfer = SystemProgram.transfer({ fromPubkey: manager.publicKey, toPubkey: manager.publicKey, lamports: 1 });
  const built = await assemble(env, [transfer], [], options);
  const message = TransactionMessage.decompile(VersionedTransaction.deserialize(Buffer.from(built.transaction, "base64")).message);
  const limit = message.instructions.find(
    (ix) => ix.programId.equals(ComputeBudgetProgram.programId) && ComputeBudgetInstruction.decodeInstructionType(ix) === "SetComputeUnitLimit",
  );
  return { units: limit && ComputeBudgetInstruction.decodeSetComputeUnitLimit(limit).units, simulation: built.simulation };
}

describe("assemble deferred", () => {
  it("asks the 1.4M ceiling without a known cost", async () => {
    expect(await unitLimitOf({ deferSimulation: true })).toEqual({ units: 1_400_000, simulation: { unitsConsumed: 0, deferred: true } });
  });

  it("asks the given budget when the caller knows the cost", async () => {
    expect(await unitLimitOf({ deferSimulation: true, computeUnits: 400_000 })).toEqual({ units: 400_000, simulation: { unitsConsumed: 0, deferred: true } });
  });
});
