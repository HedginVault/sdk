import { BN } from "@coral-xyz/anchor";
import { type AccountInfo, PublicKey, VersionedTransaction } from "@solana/web3.js";
import { describe, expect, it } from "vitest";
import { jupiterConfig } from "../src/build/jupiter-api";
import { meteora } from "../src/build/meteora";
import { localTransport } from "../src/build/transport";
import { getAssociatedTokenAddress, getConfigPda, getStrategyPda } from "../src/chain/pda";
import type { DirectActionRequest } from "../src/direct";
import { createDirectClient } from "../src/direct";
import {
  DELEGATE,
  DLMM,
  DLMM_STRATEGY,
  LIMIT_ORDER,
  LIMIT_STRATEGY,
  M,
  NOW_MS,
  P,
  POOL,
  POSITION,
  PROGRAM,
  SOL,
  TOKEN_PROGRAM,
  USDC,
  V,
  VAULT,
  decodeTx,
  delegateWallet,
  encodeAccount,
  fakeConnection,
  info,
  key,
  manager,
  run,
} from "./direct-chain";
import { keypairSigner } from "../src/signer";
import { BIN_ARRAY_0, BIN_ARRAY_1, BIN_ARRAY_2, SOL_STRATEGY, dlmmChain, positionData } from "./dlmm-chain";

const COMPUTE_BUDGET = "ComputeBudget111111111111111111111111111111";
const ATA_PROGRAM = "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL";
const JUP = new PublicKey("JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4");
const ROUTE_WITH_TOKEN_LEDGER = [150, 86, 71, 116, 167, 93, 14, 104];
const ROUTE = [229, 23, 203, 151, 122, 227, 173, 42];
const SET_TOKEN_LEDGER = [228, 85, 185, 112, 78, 79, 77, 2];
const LEDGER = key(61);
const ALT = key(50);
const PROTOCOL_ALT = key(70);
const AMM = [key(51), key(52)];
const LITE = "https://lite-api.jup.ag/swap/v1";
const SOL_ATA = getAssociatedTokenAddress(VAULT, SOL, TOKEN_PROGRAM);
const USDC_ATA = getAssociatedTokenAddress(VAULT, USDC, TOKEN_PROGRAM);
const LOOKUP_TABLE_PROGRAM = new PublicKey("AddressLookupTab1e1111111111111111111111111");

const meta = (pubkey: PublicKey, isSigner = false, isWritable = false) => ({ pubkey: pubkey.toBase58(), isSigner, isWritable });
const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });

function lookupTable(addresses: PublicKey[]): Buffer {
  const data = Buffer.alloc(56 + addresses.length * 32);
  data.writeUInt32LE(1, 0);
  data.writeBigUInt64LE(0xffff_ffff_ffff_ffffn, 4);
  addresses.forEach((a, i) => a.toBuffer().copy(data, 56 + i * 32));
  return data;
}

function tokenAccount(mint: PublicKey, owner: PublicKey, amount: bigint): Buffer {
  const data = Buffer.alloc(165);
  mint.toBuffer().copy(data, 0);
  owner.toBuffer().copy(data, 32);
  data.writeBigUInt64LE(amount, 64);
  data.writeUInt8(1, 108);
  return data;
}

/** A SOL to USDC route for the vault, with Jupiter's token ledger when `ledger`; `extraAmms` lengthen it past the packet. */
function swapInstructions(ledger: boolean, extraAmms: PublicKey[] = []) {
  const fixed = [meta(TOKEN_PROGRAM), meta(VAULT, true), meta(SOL_ATA, false, true), meta(USDC_ATA, false, true), meta(USDC_ATA, false, true), meta(USDC), meta(JUP), meta(JUP)];
  return {
    swapInstruction: {
      programId: JUP.toBase58(),
      accounts: ledger ? [...fixed.slice(0, 7), meta(LEDGER, false, true), meta(JUP), meta(JUP), ...[...AMM, ...extraAmms].map((k) => meta(k, false, true))] : [...fixed, meta(JUP), ...AMM.map((k) => meta(k, false, true))],
      data: Buffer.from([...(ledger ? ROUTE_WITH_TOKEN_LEDGER : ROUTE), 7]).toString("base64"),
    },
    tokenLedgerInstruction: ledger ? { programId: JUP.toBase58(), accounts: [meta(LEDGER, false, true), meta(SOL_ATA)], data: Buffer.from(SET_TOKEN_LEDGER).toString("base64") } : null,
    setupInstructions: [],
    cleanupInstruction: null,
    addressLookupTableAddresses: [ALT.toBase58()],
  };
}

const quoteResponse = { inAmount: "9500100", outAmount: "1000", priceImpactPct: "0", routePlan: [{ swapInfo: { label: "Meteora DLMM" } }] };

function fakeJupiter(o: { ledger?: boolean; extraAmms?: PublicKey[] } = {}) {
  const calls: { url: string; body: unknown }[] = [];
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const url = String(input);
    calls.push({ url, body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined });
    if (url.includes("/quote?")) return json(quoteResponse);
    if (url.includes("/tokens/v2/search")) return json([{ id: SOL.toBase58(), symbol: "SOL" }]);
    return json(swapInstructions(o.ledger ?? true, o.extraAmms));
  };
  return { fetch, calls };
}

async function chainWithTables(o: Parameters<typeof dlmmChain>[0] = {}) {
  const accounts = await dlmmChain(o);
  accounts.set(ALT.toBase58(), info(LOOKUP_TABLE_PROGRAM, lookupTable(AMM)));
  accounts.set(PROTOCOL_ALT.toBase58(), info(LOOKUP_TABLE_PROGRAM, lookupTable([PROGRAM, getConfigPda(PROGRAM), VAULT, POOL, DLMM])));
  accounts.set(getConfigPda(PROGRAM).toBase58(), info(PROGRAM, await encodeAccount("config", { nextVaultId: new BN(3), maxSlippageBps: 300 })));
  return accounts;
}

/** One build through the local transport: the steps `execute` would inspect, sign and send. */
async function build(
  action: string,
  body: Record<string, unknown>,
  o: { accounts?: Map<string, AccountInfo<Buffer>>; payer?: PublicKey; jupiter?: ReturnType<typeof fakeJupiter>; protocolLookupTable?: PublicKey } = {},
) {
  const accounts = o.accounts ?? (await chainWithTables());
  const fake = fakeConnection(accounts);
  const jupiter = o.jupiter ?? fakeJupiter();
  const transport = localTransport({
    connection: fake.connection,
    programId: PROGRAM,
    payer: o.payer ?? manager.publicKey,
    now: () => NOW_MS,
    fetch: jupiter.fetch,
    jupiter: jupiterConfig(),
    phoenixApiUrl: "https://perp-api.phoenix.trade",
    ...(o.protocolLookupTable && { protocolLookupTable: o.protocolLookupTable }),
  });
  const steps = await transport.build(action, body);
  return { steps, reads: fake.reads, jupiter, txs: steps.map((s) => decodeTx(Buffer.from(s.transaction, "base64"), accounts)) };
}

const binArray = (index: number) => meteora().deriveBinArray(POOL, new BN(index), DLMM)[0].toBase58();

const failure = (p: Promise<unknown>) => p.then(() => undefined, (e: unknown) => (e instanceof Error ? { name: e.name, message: e.message, code: (e as { code?: string }).code } : e));

const CB = COMPUTE_BUDGET;
const pos = POSITION.toBase58();
const arg = (h: { args: unknown }, name: string) => (h.args as Record<string, unknown>)[name];
const addArgs = (h: { args: unknown }) => (h.args as { params: { liquidityParameter: Record<string, unknown> } }).params.liquidityParameter;
const strategyOf = (h: { args: unknown }) => addArgs(h).strategyParameters as { minBinId: number; maxBinId: number; strategyType: Record<string, unknown> };

describe("direct dlmm/initialize", () => {
  it("centres a width on the active bin, signs for the new position, and reports its inclusive range", async () => {
    const { steps, txs } = await build("dlmm/initialize", { vault: V, lbPair: POOL.toBase58(), width: 10 });
    expect(steps).toHaveLength(1);
    const [tx] = txs;
    expect(tx?.programs).toEqual([CB, CB, "meteoraDlmmInitializePosition"]);
    expect(tx?.hedge[0]?.args).toEqual({ lowerBinId: 95, upperBinId: 105 });
    expect(tx?.hedge[0]?.accounts).toMatchObject({ authority: M, vault: V, lb_pair: POOL.toBase58(), strategy_x: SOL_STRATEGY.toBase58(), strategy_y: P, position: steps[0]?.position, delegate: P });
    expect(steps[0]).toMatchObject({ lowerBinId: 95, upperBinId: 104 });
    const signed = VersionedTransaction.deserialize(Buffer.from(steps[0]?.transaction ?? "", "base64"));
    expect(signed.signatures[1]?.some((b) => b !== 0)).toBe(true);
  });

  it("opens the missing Jupiter strategy of the non-deposit pair mint first", async () => {
    const { txs } = await build("dlmm/initialize", { vault: V, lbPair: POOL.toBase58(), lowerBinId: 90, upperBinId: 100 }, { accounts: await chainWithTables({ solStrategy: false }) });
    expect(txs[0]?.programs).toEqual([CB, CB, "jupiterInitializeStrategy", "meteoraDlmmInitializePosition"]);
  });

  it("executes to confirmed and reports the created position", async () => {
    const { outcome, sent } = await run({ action: "dlmm/initialize", vault: V, lbPair: POOL.toBase58(), width: 10 }, {}, manager, await chainWithTables());
    expect(outcome).toEqual({ kind: "confirmed", signatures: [expect.any(String)], created: { position: expect.any(String) } });
    expect(sent).toHaveLength(1);
  });
});

describe("direct dlmm/open", () => {
  it("creates and funds a compact position in one transaction", async () => {
    const body = { vault: V, lbPair: POOL.toBase58(), lowerBinId: 90, upperBinId: 110, amountX: "3000000", amountY: "4000000", shape: "spot", maxActiveBinSlippage: 3 };
    const { steps, txs } = await build("dlmm/open", body);
    expect(txs.map((t) => t.programs)).toEqual([[CB, CB, "meteoraDlmmInitializePosition", ATA_PROGRAM, ATA_PROGRAM, "meteoraDlmmAddLiquidity"]]);
    const [init, add] = txs[0]?.hedge ?? [];
    expect(init?.args).toEqual({ lowerBinId: 90, upperBinId: 110 });
    expect(addArgs(add ?? { args: {} })).toMatchObject({ amountX: "3000000", amountY: "4000000", activeId: 100, maxActiveBinSlippage: 3 });
    expect(strategyOf(add ?? { args: {} })).toMatchObject({ minBinId: 90, maxBinId: 109 });
    expect(add?.remaining).toEqual([BIN_ARRAY_1.toBase58()]);
    expect(steps[0]).toMatchObject({ position: add?.accounts.position, lowerBinId: 90, upperBinId: 109 });
  });

  it("opens a wide position as initialize plus extends, then funds it chunk by chunk, all in one batch", async () => {
    const body = { vault: V, lbPair: POOL.toBase58(), lowerBinId: 0, upperBinId: 300, amountX: "1000000000", amountY: "2000000000", shape: "spot", maxActiveBinSlippage: 3 };
    const { steps, txs } = await build("dlmm/open", body);
    expect(txs.map((t) => t.programs)).toEqual([
      [CB, CB, "meteoraDlmmInitializePosition", "meteoraDlmmExtendPosition", "meteoraDlmmExtendPosition", "meteoraDlmmExtendPosition"],
      // Each chunk creates the one missing bin array it reaches first: indexes 0, 2, 3 and 4.
      ...Array(4).fill([CB, CB, DLMM.toBase58(), ATA_PROGRAM, ATA_PROGRAM, "meteoraDlmmAddLiquidity"]),
    ]);
    expect(txs.slice(1).map((t) => t.hedge[0]?.remaining)).toEqual([
      [BIN_ARRAY_0.toBase58(), BIN_ARRAY_1.toBase58()],
      [BIN_ARRAY_1.toBase58(), BIN_ARRAY_2.toBase58()],
      [BIN_ARRAY_2.toBase58(), binArray(3)],
      [binArray(3), binArray(4)],
    ]);
    const [resize, ...funding] = txs;
    expect(resize?.hedge.map((h) => h.args)).toEqual([{ lowerBinId: 0, upperBinId: 70 }, { binsToAdd: 91 }, { binsToAdd: 91 }, { binsToAdd: 48 }]);
    const adds = funding.flatMap((t) => t.hedge);
    // Without a simulated chunk, each chunk stays at 80 bin-legs; spot funds every chunk in one leg.
    expect(adds.map((h) => [strategyOf(h).minBinId, strategyOf(h).maxBinId])).toEqual([[0, 79], [80, 159], [160, 239], [240, 299]]);
    // Each side's whole amount lands in its bins: X at and above the active bin, Y at and below it.
    expect(adds.reduce((sum, h) => sum + BigInt(String(addArgs(h).amountX)), 0n)).toBe(1_000_000_000n);
    expect(adds.reduce((sum, h) => sum + BigInt(String(addArgs(h).amountY)), 0n)).toBe(2_000_000_000n);
    expect(adds.map((h) => [addArgs(h).amountX, addArgs(h).amountY])).toEqual([
      ["0", "1584158415"],
      ["321254259", "415841585"],
      ["399441166", "0"],
      ["279304575", "0"],
    ]);
    expect(steps[0]).toMatchObject({ lowerBinId: 0, upperBinId: 299, position: resize?.hedge[0]?.accounts.position, simulation: { unitsConsumed: 50_000 } });
    expect(steps.slice(1).map((s) => s.simulation)).toEqual(Array(4).fill({ unitsConsumed: 0, deferred: true }));
    expect(steps.map((s) => s.sendConcurrently)).toEqual(Array(5).fill(undefined));
    expect(funding.map((t) => t.computeUnitLimit)).toEqual(Array(4).fill(1_400_000));
  });

  it("executes the whole batch in order to confirmed", async () => {
    const request: DirectActionRequest = { action: "dlmm/open", vault: V, lbPair: POOL.toBase58(), lowerBinId: 0, upperBinId: 300, amountX: "1000000000", amountY: "2000000000", shape: "spot", maxActiveBinSlippage: 3 };
    const { outcome, calls, progress } = await run(request, {}, manager, await chainWithTables());
    expect(outcome).toEqual({ kind: "confirmed", signatures: Array(5).fill(expect.any(String)), created: { position: expect.any(String) } });
    // Every step is a confirmation barrier: send, then confirm, then the next.
    expect(calls).toEqual(Array(5).fill(['send {"preflightCommitment":"confirmed"}', "status"]).flat());
    expect(progress.filter((p) => p.kind === "building")).toEqual([{ kind: "building", action: "dlmm/open" }]);
  });

  it("refuses a range wider than 1,400 bins before any read", async () => {
    const body = { vault: V, lbPair: POOL.toBase58(), lowerBinId: 0, upperBinId: 1401, amountX: "1", amountY: "0", shape: "spot", maxActiveBinSlippage: 3 };
    expect(await failure(build("dlmm/open", body))).toEqual({ name: "ApiError", code: "Validation", message: "range must span at most 1400 bins" });
  });
});

describe("direct dlmm/extend and dlmm/add-range", () => {
  const step = { vault: V, position: pos, targetUpperBinId: 300, amountX: "1000", amountY: "0", shape: "spot", maxActiveBinSlippage: 3, activeBinId: 100 };

  it("extends by one resize step and continues with the next extend", async () => {
    const { steps, txs } = await build("dlmm/extend", step);
    expect(txs[0]?.hedge.map((h) => [h.name, h.args])).toEqual([["meteoraDlmmExtendPosition", { binsToAdd: 91 }]]);
    expect(steps[0]?.next).toEqual({ path: "dlmm/extend", body: step });
  });

  it("hands over to add-range at the position's lower bin once the last step reaches the target", async () => {
    const { steps, txs } = await build("dlmm/extend", step, { accounts: await chainWithTables({ positionRange: { lowerBinId: 90, upperBinId: 250 } }) });
    expect(txs[0]?.hedge.map((h) => h.args)).toEqual([{ binsToAdd: 50 }]);
    expect(steps[0]?.next).toEqual({ path: "dlmm/add-range", body: { ...step, cursorBinId: 90 } });
  });

  it("refuses to fund when the pool moved more than maxActiveBinSlippage since the flow started", async () => {
    const body = { ...step, targetUpperBinId: 109, cursorBinId: 90, activeBinId: 96 };
    expect(await failure(build("dlmm/add-range", body))).toEqual({ name: "ApiError", code: "Stale", message: "pool price moved during the wide position flow; refresh before adding more liquidity" });
    const { txs } = await build("dlmm/add-range", { ...body, activeBinId: 97 });
    expect(txs.flatMap((t) => t.hedge.map((h) => h.name))).toEqual(["meteoraDlmmAddLiquidity"]);
  });
});

describe("direct dlmm/add", () => {
  const body = { vault: V, position: pos, amountX: "1000", amountY: "2000", shape: "curve", maxActiveBinSlippage: 5 };

  it("adds over the whole position without a selection", async () => {
    const { txs } = await build("dlmm/add", body);
    expect(txs[0]?.programs).toEqual([CB, CB, ATA_PROGRAM, ATA_PROGRAM, "meteoraDlmmAddLiquidity"]);
    const add = txs[0]?.hedge[0] ?? { args: {} };
    expect(addArgs(add)).toMatchObject({ amountX: "1000", amountY: "2000", activeId: 100, maxActiveBinSlippage: 5 });
    expect(strategyOf(add)).toMatchObject({ minBinId: 90, maxBinId: 109 });
  });

  it("adds only to an inclusive bin selection", async () => {
    const { txs } = await build("dlmm/add", { ...body, lowerBinId: 95, upperBinId: 99 });
    expect(strategyOf(txs[0]?.hedge[0] ?? { args: {} })).toMatchObject({ minBinId: 95, maxBinId: 99 });
  });

  it("refuses a selection outside the position, or with one end", async () => {
    expect(await failure(build("dlmm/add", { ...body, lowerBinId: 95, upperBinId: 110 }))).toMatchObject({ code: "Validation", message: "selected bins must lie inside the position" });
    expect(await failure(build("dlmm/add", { ...body, lowerBinId: 95 }))).toMatchObject({ code: "Validation", message: "lowerBinId and upperBinId must be given together" });
  });

  it("refuses a position another vault owns", async () => {
    const accounts = await chainWithTables();
    accounts.set(pos, info(DLMM, positionData(undefined, key(99))));
    expect(await failure(build("dlmm/add", body, { accounts }))).toMatchObject({ code: "Denied", message: "position does not belong to this vault" });
  });
});

describe("direct dlmm/remove", () => {
  it("removes a share of the whole position", async () => {
    const { txs } = await build("dlmm/remove", { vault: V, position: pos, bpsToRemove: 2500 });
    expect(txs[0]?.programs).toEqual([CB, CB, ATA_PROGRAM, ATA_PROGRAM, "meteoraDlmmRemoveLiquidity"]);
    expect(txs[0]?.hedge[0]?.args).toEqual({ params: { bpsToRemove: 2500, remainingAccountsInfo: { slices: [{ accountsType: { transferHookX: {} }, length: 0 }, { accountsType: { transferHookY: {} }, length: 0 }] } } });
    expect(txs[0]?.hedge[0]?.accounts).toMatchObject({ position: pos, strategy: DLMM_STRATEGY.toBase58(), vault_token_x: SOL_ATA.toBase58(), vault_token_y: USDC_ATA.toBase58() });
  });

  it("removes a share of an inclusive selection", async () => {
    const { txs } = await build("dlmm/remove", { vault: V, position: pos, bpsToRemove: 5000, lowerBinId: 101, upperBinId: 104 });
    expect(txs[0]?.hedge[0]).toMatchObject({ name: "meteoraDlmmRemoveLiquidityRange", args: { params: { bpsToRemove: 5000 }, fromBinId: 101, toBinId: 104 } });
  });

  it("removes in concurrent chunks from a cursor", async () => {
    const { steps, txs } = await build("dlmm/remove", { vault: V, position: pos, bpsToRemove: 10_000, cursorBinId: 95 });
    expect(txs.map((t) => t.hedge.map((h) => [arg(h, "fromBinId"), arg(h, "toBinId")]))).toEqual([[[95, 109]]]);
    expect(steps.map((s) => s.sendConcurrently)).toEqual([true]);
  });
});

describe("direct dlmm/flip", () => {
  const flip = { vault: V, position: pos, activeBinId: 100, maxActiveBinSlippage: 2 };

  it("flips X bins above the active bin into Bid-Ask, re-adding what the remove returns less one unit per bin", async () => {
    const { txs } = await build("dlmm/flip", { ...flip, lowerBinId: 103, upperBinId: 106 });
    expect(txs.map((t) => t.programs)).toEqual([[CB, CB, ATA_PROGRAM, ATA_PROGRAM, "meteoraDlmmRemoveLiquidityRange", "meteoraDlmmAddLiquidity"]]);
    const [remove, add] = txs[0]?.hedge ?? [];
    expect(remove?.args).toMatchObject({ params: { bpsToRemove: 10_000 }, fromBinId: 103, toBinId: 106 });
    expect(addArgs(add ?? { args: {} })).toMatchObject({ amountX: "3999996", amountY: "0", maxActiveBinSlippage: 2 });
    expect(strategyOf(add ?? { args: {} })).toMatchObject({ minBinId: 103, maxBinId: 106, strategyType: { bidAskImBalanced: {} } });
  });

  it("flips Y bins below the active bin", async () => {
    const { txs } = await build("dlmm/flip", { ...flip, lowerBinId: 92, upperBinId: 95 });
    const [, add] = txs[0]?.hedge ?? [];
    expect(addArgs(add ?? { args: {} })).toMatchObject({ amountX: "0", amountY: "7999996" });
    expect(strategyOf(add ?? { args: {} })).toMatchObject({ minBinId: 92, maxBinId: 95 });
  });

  it("refuses a range that straddles the active bin", async () => {
    expect(await failure(build("dlmm/flip", { ...flip, lowerBinId: 98, upperBinId: 102 }))).toEqual({
      name: "ApiError",
      code: "Validation",
      message: "flip needs bins entirely above or below the pool price",
    });
  });

  it("fails before send when the active bin moved past maxActiveBinSlippage", async () => {
    const request: DirectActionRequest = { action: "dlmm/flip", ...flip, lowerBinId: 103, upperBinId: 106 };
    const { outcome, sent } = await run(request, {}, manager, await chainWithTables({ activeId: 103 }));
    expect(outcome).toEqual({ kind: "failed", signatures: [], code: "Stale", message: "pool price moved; refresh before flipping" });
    expect(sent).toEqual([]);
    const within = await run(request, {}, manager, await chainWithTables({ activeId: 102 }));
    expect(within.outcome.kind).toBe("confirmed");
  });
});

describe("direct dlmm/claim-fee and dlmm/close", () => {
  it("claims the whole position's fees", async () => {
    const { txs } = await build("dlmm/claim-fee", { vault: V, position: pos });
    expect(txs[0]?.programs).toEqual([CB, CB, ATA_PROGRAM, ATA_PROGRAM, "meteoraDlmmClaimFee"]);
    expect(txs[0]?.hedge[0]?.remaining).toEqual([BIN_ARRAY_1.toBase58()]);
  });

  it("removes, claims and closes a compact position in one transaction", async () => {
    const { txs } = await build("dlmm/close", { vault: V, position: pos });
    expect(txs[0]?.programs).toEqual([CB, CB, ATA_PROGRAM, ATA_PROGRAM, "meteoraDlmmRemoveLiquidity", "meteoraDlmmClaimFee", "vaultCloseStrategy"]);
    expect(txs[0]?.hedge[2]).toMatchObject({ accounts: { strategy: DLMM_STRATEGY.toBase58() }, remaining: [pos, DLMM.toBase58(), expect.any(String), POOL.toBase58(), SOL_STRATEGY.toBase58(), P] });
  });
});

describe("direct dlmm/zap-out", () => {
  const zap = { vault: V, position: pos, slippageBps: 900 };

  /** The fixture's open limit order rests in the same pool, so SOL stays in use until it is gone. */
  const withoutLimitOrder = async () => {
    const accounts = await chainWithTables();
    accounts.delete(LIMIT_STRATEGY.toBase58());
    return accounts;
  };

  it("snapshots the token ledger, removes, claims, swaps what came back, closes, then sweeps", async () => {
    const jupiter = fakeJupiter();
    const { steps, txs } = await build("dlmm/zap-out", zap, { accounts: await withoutLimitOrder(), jupiter, protocolLookupTable: PROTOCOL_ALT });
    expect(txs.map((t) => t.programs)).toEqual([
      [CB, CB, ATA_PROGRAM, ATA_PROGRAM, JUP.toBase58(), "meteoraDlmmRemoveLiquidity", "meteoraDlmmClaimFee", "jupiterSwap", "vaultCloseStrategy"],
    ]);
    // The quote covers the position's X and its unclaimed X fees, capped at the config's 300 bps.
    expect(jupiter.calls[0]?.url).toBe(
      `${LITE}/quote?inputMint=${SOL.toBase58()}&outputMint=${USDC.toBase58()}&amount=9500100&slippageBps=300&swapMode=ExactIn&excludeDexes=Kipseli%2CObsidian%2CQuantum%2C1DEX%2CPump.fun&maxAccounts=30`,
    );
    expect(jupiter.calls[1]?.body).toMatchObject({ userPublicKey: V, useTokenLedger: true });
    expect(txs[0]?.hedge[2]).toMatchObject({ name: "jupiterSwap", args: { amount: "9500100", slippageBps: 300 }, accounts: { strategy: SOL_STRATEGY.toBase58(), source_mint: SOL.toBase58(), destination_mint: USDC.toBase58() } });
    expect(txs[0]?.lookupTables).toEqual([ALT.toBase58(), PROTOCOL_ALT.toBase58()]);
    expect(steps[0]?.next).toEqual({ path: "jupiter/sweep", body: { vault: V, mint: SOL.toBase58(), slippageBps: 300 } });
  });

  it("leaves SOL and its strategy alone while an open limit order still uses it", async () => {
    const { steps } = await build("dlmm/zap-out", zap);
    expect(steps.map((s) => s.next)).toEqual([undefined]);
  });

  it("refuses a route without a valid token ledger", async () => {
    expect(await failure(build("dlmm/zap-out", zap, { jupiter: fakeJupiter({ ledger: false }) }))).toMatchObject({ code: "JupiterInvalidTokenLedger" });
  });

  it("fails before send, naming protocolLookupTable, when the zap does not fit without it", async () => {
    const extraAmms = Array.from({ length: 40 }, (_, i) => key(150 + i));
    expect(await failure(build("dlmm/zap-out", zap, { jupiter: fakeJupiter({ extraAmms }) }))).toEqual({
      name: "ApiError",
      code: "TransactionTooLarge",
      message: "Zap out does not fit in Solana transactions, even split in three; set the protocolLookupTable option to shrink it",
    });
  });

  it("executes the zap, then follows next to the sweep, which closes the emptied SOL strategy", async () => {
    const accounts = await withoutLimitOrder();
    // Once the zap lands the position strategy is gone, so the sweep sees SOL unused.
    const rpc = { send: async () => void accounts.delete(DLMM_STRATEGY.toBase58()) };
    const jupiter = fakeJupiter();
    const { outcome, progress, txs } = await run({ action: "dlmm/zap-out", ...zap }, rpc, manager, accounts, { fetch: jupiter.fetch });
    expect(outcome).toEqual({ kind: "confirmed", signatures: [expect.any(String), expect.any(String)] });
    expect(progress.filter((p) => p.kind === "building").map((p) => p.kind === "building" && p.action)).toEqual(["dlmm/zap-out", "jupiter/sweep"]);
    expect(txs[1]?.hedge.map((h) => [h.name, h.accounts.strategy])).toEqual([["vaultCloseStrategy", SOL_STRATEGY.toBase58()]]);
  });
});

describe("direct dlmm/zap-out/swap", () => {
  it("swaps only what the zap returned and continues with the next source", async () => {
    const accounts = await chainWithTables();
    accounts.set(SOL_ATA.toBase58(), info(TOKEN_PROGRAM, tokenAccount(SOL, VAULT, 1_700n)));
    const jupiter = fakeJupiter({ ledger: false });
    const sources = [{ mint: SOL.toBase58(), balanceBefore: "1000" }, { mint: key(21).toBase58(), balanceBefore: "0" }];
    const { steps, txs } = await build("dlmm/zap-out/swap", { vault: V, sources, slippageBps: 50 }, { accounts, jupiter });
    expect(txs[0]?.hedge.map((h) => [h.name, arg(h, "amount")])).toEqual([["jupiterSwap", "700"]]);
    expect(jupiter.calls[0]?.url).toContain("amount=700&slippageBps=50");
    expect(steps[0]?.next).toEqual({ path: "dlmm/zap-out/swap", body: { vault: V, sources: [sources[1]], slippageBps: 50 } });
  });

  it("refuses when the balance fell below its pre-zap value", async () => {
    const accounts = await chainWithTables();
    accounts.set(SOL_ATA.toBase58(), info(TOKEN_PROGRAM, tokenAccount(SOL, VAULT, 10n)));
    const body = { vault: V, sources: [{ mint: SOL.toBase58(), balanceBefore: "11" }], slippageBps: 50 };
    expect(await failure(build("dlmm/zap-out/swap", body, { accounts }))).toMatchObject({ code: "ZapBalanceChanged" });
  });
});

describe("direct dlmm/remove with a zap", () => {
  it("removes a share and swaps that share of X in the same transaction", async () => {
    const jupiter = fakeJupiter();
    const { txs } = await build("dlmm/remove", { vault: V, position: pos, bpsToRemove: 5000, lowerBinId: 101, upperBinId: 104, slippageBps: 100 }, { jupiter });
    expect(txs[0]?.programs).toEqual([CB, CB, ATA_PROGRAM, ATA_PROGRAM, JUP.toBase58(), "meteoraDlmmRemoveLiquidityRange", "jupiterSwap"]);
    expect(jupiter.calls[0]?.url).toContain("amount=2000000&slippageBps=100");
  });
});

describe("direct dlmm/limit-order", () => {
  it("places an ask above the active bin, signing for the new order", async () => {
    const body = { vault: V, lbPair: POOL.toBase58(), side: "ask", bins: [{ binId: 105, amount: "5000" }, { binId: 106, amount: "6000" }] };
    const { steps, txs } = await build("dlmm/limit-order/place", body);
    expect(txs[0]?.programs).toEqual([CB, CB, ATA_PROGRAM, "meteoraDlmmPlaceLimitOrder"]);
    const place = txs[0]?.hedge[0];
    expect(place?.args).toMatchObject({ params: { isAskSide: true, relativeBin: null, bins: [{ id: 105, amount: "5000" }, { id: 106, amount: "6000" }] } });
    expect(place?.accounts).toMatchObject({ vault_token: SOL_ATA.toBase58(), token_mint: SOL.toBase58(), limit_order: steps[0]?.limitOrder, strategy: steps[0]?.strategy });
    expect(place?.remaining).toEqual([BIN_ARRAY_1.toBase58()]);
    expect(steps[0]?.strategy).toBe(getStrategyPda(VAULT, new PublicKey(steps[0]?.limitOrder ?? ""), PROGRAM).toBase58());
  });

  it("creates missing bin arrays for a bid far below the price", async () => {
    const body = { vault: V, lbPair: POOL.toBase58(), side: "bid", bins: [{ binId: 10, amount: "5000" }] };
    const { txs } = await build("dlmm/limit-order/place", body);
    expect(txs[0]?.programs).toEqual([CB, CB, DLMM.toBase58(), ATA_PROGRAM, "meteoraDlmmPlaceLimitOrder"]);
    expect(txs[0]?.hedge[0]?.remaining).toEqual([BIN_ARRAY_0.toBase58()]);
  });

  it("refuses a bid that is not below the active bin", async () => {
    const body = { vault: V, lbPair: POOL.toBase58(), side: "bid", bins: [{ binId: 100, amount: "5000" }] };
    expect(await failure(build("dlmm/limit-order/place", body))).toMatchObject({ code: "Validation", message: "a bid must sit below the active bin 100" });
  });

  it("cancels every open bin and closes the strategy in the same transaction", async () => {
    const { steps, txs } = await build("dlmm/limit-order/cancel", { vault: V, limitOrder: LIMIT_ORDER.toBase58() });
    expect(txs[0]?.programs).toEqual([CB, CB, "meteoraDlmmCancelLimitOrder", "vaultCloseStrategy"]);
    expect(txs[0]?.hedge[0]?.args).toMatchObject({ bins: [105] });
    expect(txs[0]?.hedge[1]?.accounts.strategy).toBe(LIMIT_STRATEGY.toBase58());
    expect(steps[0]).toMatchObject({ cancelledBins: [105], closesStrategy: true });
  });

  it("refuses to cancel a bin that holds nothing", async () => {
    expect(await failure(build("dlmm/limit-order/cancel", { vault: V, limitOrder: LIMIT_ORDER.toBase58(), bins: [106] }))).toMatchObject({ code: "Validation", message: "bins 106 hold nothing to cancel" });
  });
});

describe("direct DLMM delegates", () => {
  it("refuses a delegate without the Meteora DLMM permission before reading the pool or calling Jupiter", async () => {
    const accounts = await chainWithTables({ delegatePermissions: 1 });
    const jupiter = fakeJupiter();
    const outcome = failure(build("dlmm/zap-out", { vault: V, position: pos, slippageBps: 50 }, { accounts, payer: delegateWallet.publicKey, jupiter }));
    expect(await outcome).toEqual({ name: "ApiError", code: "DelegatePermissionDenied", message: "This delegate cannot run Meteora DLMM actions" });
    expect(jupiter.calls).toEqual([]);
  });

  it("reads only the vault, its mint and the delegate before refusing", async () => {
    const accounts = await chainWithTables({ delegatePermissions: 1 });
    const fake = fakeConnection(accounts);
    const client = createDirectClient({ connection: fake.connection, fetch: fakeJupiter().fetch });
    const outcome = await client.execute({ action: "dlmm/add", vault: V, position: pos, amountX: "1", amountY: "0", shape: "spot", maxActiveBinSlippage: 1 }, keypairSigner(delegateWallet));
    expect(outcome).toEqual({ kind: "failed", signatures: [], code: "DelegatePermissionDenied", message: "This delegate cannot run Meteora DLMM actions" });
    expect(fake.reads).toEqual([V, USDC.toBase58(), DELEGATE.toBase58()]);
  });

  it("builds for a delegate with the permission, naming its delegate account", async () => {
    const { txs } = await build("dlmm/claim-fee", { vault: V, position: pos }, { payer: delegateWallet.publicKey });
    expect(txs[0]?.hedge[0]?.accounts).toMatchObject({ authority: delegateWallet.publicKey.toBase58(), delegate: DELEGATE.toBase58() });
    expect(txs[0]?.payer).toBe(delegateWallet.publicKey.toBase58());
  });
});

describe("direct getPool", () => {
  it("reads the pool's tokens, bin step and live active bin from chain", async () => {
    const fake = fakeConnection(await chainWithTables());
    const client = createDirectClient({ connection: fake.connection, fetch: fakeJupiter().fetch });
    expect(await client.getPool(V, POOL.toBase58())).toEqual({
      lbPair: POOL.toBase58(),
      tokenX: { mint: SOL.toBase58(), symbol: "SOL", decimals: 6 },
      tokenY: { mint: USDC.toBase58(), symbol: "USDC", decimals: 6 },
      binStep: 10,
      activeBinId: 100,
      activePrice: expect.stringMatching(/^1\.10\d+$/),
    });
  });

  it("answers 404 for an account that is not an LB pair", async () => {
    const client = createDirectClient({ connection: fakeConnection(await chainWithTables()).connection, fetch: fakeJupiter().fetch });
    expect(await failure(client.getPool(V, key(98).toBase58()))).toMatchObject({ code: "NotFound", message: "LB pair not found" });
  });
});
