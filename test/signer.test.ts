import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ComputeBudgetProgram,
  Keypair,
  PublicKey,
  SystemProgram,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
} from "@solana/web3.js";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_MAX_COMPUTE_UNIT_PRICE_MICROLAMPORTS,
  PHOENIX_PROGRAM_ID,
  inspectPhoenixOnboardTransaction,
  inspectTransaction,
  keypairFromFile,
  keypairSigner,
} from "../src/signer";

const PROGRAM_ID = "r2ahBQ6gbPCJ9FxBymYcXuwXi8NmenRry7SE7QR7FAt";
const manager = Keypair.generate();
const blockhash = new PublicKey(new Uint8Array(32).fill(7)).toBase58();
const vaultIx = (extraSigner?: PublicKey) =>
  new TransactionInstruction({
    programId: new PublicKey(PROGRAM_ID),
    keys: extraSigner ? [{ pubkey: extraSigner, isSigner: true, isWritable: true }] : [],
    data: Buffer.from([1]),
  });

function build(instructions: TransactionInstruction[], payer = manager.publicKey, preSign: Keypair[] = []): string {
  const message = new TransactionMessage({ payerKey: payer, recentBlockhash: blockhash, instructions }).compileToV0Message();
  const tx = new VersionedTransaction(message);
  if (preSign.length > 0) tx.sign(preSign);
  return Buffer.from(tx.serialize()).toString("base64");
}

const policy = { manager: manager.publicKey, programId: PROGRAM_ID, maxComputeUnitPriceMicroLamports: DEFAULT_MAX_COMPUTE_UNIT_PRICE_MICROLAMPORTS };
const sign = async (tx: VersionedTransaction) => Buffer.from((await keypairSigner(manager).signTransaction(tx)).serialize()).toString("base64");

describe("inspectTransaction", () => {
  it("accepts a builder-shaped transaction and signs it", async () => {
    const base64 = build([
      ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }),
      ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 10_000 }),
      vaultIx(),
    ]);
    const tx = inspectTransaction(base64, policy);
    const signed = VersionedTransaction.deserialize(Buffer.from(await sign(tx), "base64"));
    expect(signed.signatures[0]?.some((b) => b !== 0)).toBe(true);
  });

  it("accepts a sweep: Jupiter swap and strategy close, both through the vault program", () => {
    const jupiter = new PublicKey("JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4");
    const swap = new TransactionInstruction({
      programId: new PublicKey(PROGRAM_ID),
      keys: [
        { pubkey: manager.publicKey, isSigner: true, isWritable: true },
        { pubkey: jupiter, isSigner: false, isWritable: false },
      ],
      data: Buffer.from([2]),
    });
    const close = new TransactionInstruction({
      programId: new PublicKey(PROGRAM_ID),
      keys: [{ pubkey: manager.publicKey, isSigner: true, isWritable: true }],
      data: Buffer.from([3]),
    });
    const base64 = build([ComputeBudgetProgram.setComputeUnitLimit({ units: 600_000 }), ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 10_000 }), swap, close]);
    expect(inspectTransaction(base64, policy).message.compiledInstructions).toHaveLength(4);
  });

  it("keeps a builder-added position signature when the manager signs", async () => {
    const position = Keypair.generate();
    const base64 = build([vaultIx(position.publicKey)], manager.publicKey);
    const tx = VersionedTransaction.deserialize(Buffer.from(base64, "base64"));
    tx.sign([position]);
    const presigned = Buffer.from(tx.serialize()).toString("base64");
    const signed = VersionedTransaction.deserialize(Buffer.from(await sign(inspectTransaction(presigned, policy)), "base64"));
    expect(signed.signatures.every((sig) => sig.some((b) => b !== 0))).toBe(true);
  });

  it("accepts the Pump.fun AMM volume accumulator a Jupiter route through Pump AMM needs first", () => {
    const pumpAmm = new PublicKey("pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA");
    const init = new TransactionInstruction({
      programId: pumpAmm,
      keys: [{ pubkey: manager.publicKey, isSigner: true, isWritable: true }],
      data: Buffer.from([94, 6, 202, 115, 255, 96, 232, 183]),
    });
    expect(inspectTransaction(build([init, vaultIx()]), policy).message.compiledInstructions).toHaveLength(2);
  });

  it("refuses any other Pump.fun AMM instruction, such as a buy paid from the manager wallet", () => {
    const buy = new TransactionInstruction({
      programId: new PublicKey("pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA"),
      keys: [{ pubkey: manager.publicKey, isSigner: true, isWritable: true }],
      data: Buffer.from([102, 6, 61, 18, 1, 218, 235, 234]),
    });
    expect(() => inspectTransaction(build([buy, vaultIx()]), policy)).toThrow("Unexpected program pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA");
  });

  it("refuses a transfer out of the manager wallet", () => {
    const base64 = build([SystemProgram.transfer({ fromPubkey: manager.publicKey, toPubkey: Keypair.generate().publicKey, lamports: 1 }), vaultIx()]);
    expect(() => inspectTransaction(base64, policy)).toThrow(/Unexpected program 11111111111111111111111111111111/);
  });

  it("refuses a transaction paid by another wallet", () => {
    expect(() => inspectTransaction(build([vaultIx()], Keypair.generate().publicKey), policy)).toThrow(/Fee payer .* is not the signer's key/);
  });

  it("refuses when another required signature is missing", () => {
    expect(() => inspectTransaction(build([vaultIx(Keypair.generate().publicKey)]), policy)).toThrow(/also needs a signature/);
  });

  it("refuses a priority fee above the cap", () => {
    const base64 = build([ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 100_001 }), vaultIx()]);
    expect(() => inspectTransaction(base64, policy)).toThrow(/above the cap/);
  });

  it("refuses bytes that are not a transaction", () => {
    expect(() => inspectTransaction("bm90IGEgdHg=", policy)).toThrow(/Not a serialized Solana transaction/);
  });
});

const onboarder = Keypair.generate().publicKey;
const phoenixIx = (signer?: PublicKey) =>
  new TransactionInstruction({
    programId: new PublicKey(PHOENIX_PROGRAM_ID),
    keys: signer ? [{ pubkey: signer, isSigner: true, isWritable: false }] : [],
    data: Buffer.from([2]),
  });

describe("normal path versus Phoenix onboarding", () => {
  it("normal inspection refuses a direct Phoenix call", () => {
    expect(() => inspectTransaction(build([phoenixIx()]), policy)).toThrow(`Unexpected program ${PHOENIX_PROGRAM_ID}`);
  });

  it("normal inspection refuses the onboarding shape for its missing co-signature", () => {
    expect(() => inspectTransaction(build([phoenixIx(onboarder)]), policy)).toThrow(`Transaction also needs a signature from ${onboarder.toBase58()}`);
  });

  it("onboarding inspection accepts a Phoenix-only transaction still missing Phoenix's signature", async () => {
    const tx = inspectPhoenixOnboardTransaction(build([phoenixIx(onboarder)]), policy);
    const signed = VersionedTransaction.deserialize(Buffer.from(await sign(tx), "base64"));
    expect(signed.signatures.map((sig) => sig.some((b) => b !== 0))).toEqual([true, false]);
  });

  it("onboarding inspection refuses any other top-level program, including ComputeBudget", () => {
    expect(() => inspectPhoenixOnboardTransaction(build([phoenixIx(onboarder), vaultIx()]), policy)).toThrow(`Unexpected program ${PROGRAM_ID}`);
    const priced = build([ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 1 }), phoenixIx(onboarder)]);
    expect(() => inspectPhoenixOnboardTransaction(priced, policy)).toThrow("Unexpected program ComputeBudget111111111111111111111111111111");
  });

  it("onboarding inspection refuses another fee payer", () => {
    const other = Keypair.generate().publicKey;
    expect(() => inspectPhoenixOnboardTransaction(build([phoenixIx(onboarder)], other), policy)).toThrow(`Fee payer ${other.toBase58()} is not the signer's key`);
  });
});

describe("keypairFromFile", () => {
  const dir = mkdtempSync(join(tmpdir(), "hv-bot-"));

  it("loads a Solana CLI keypair file", () => {
    const keypair = Keypair.generate();
    const path = join(dir, "ok.json");
    writeFileSync(path, JSON.stringify(Array.from(keypair.secretKey)));
    expect(keypairFromFile(path).publicKey.equals(keypair.publicKey)).toBe(true);
  });

  it("rejects malformed files without echoing their contents", () => {
    const path = join(dir, "bad.json");
    writeFileSync(path, JSON.stringify([1, 2, 3, "secret-ish"]));
    expect(() => keypairFromFile(path)).toThrow("Keypair file is not a 64-byte Solana keypair array");
    expect(() => keypairFromFile(join(dir, "missing.json"))).toThrow(/Cannot read/);
  });
});
