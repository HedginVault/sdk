import { BN } from "@coral-xyz/anchor";
import { type AccountInfo, Keypair, PublicKey } from "@solana/web3.js";
import { describe, expect, it } from "vitest";
import { jupiterConfig } from "../src/build/jupiter-api";
import { localTransport } from "../src/build/transport";
import { getAssociatedTokenAddress, getConfigPda, getStrategyPda, getSwapAuthorityPda } from "../src/chain/pda";
import { createDirectClient, type DirectActionRequest } from "../src/direct";
import {
  BONK,
  BONK_STRATEGY,
  DELEGATE,
  M,
  NOW_MS,
  P,
  PROGRAM,
  SOL,
  TOKEN_2022,
  TOKEN_PROGRAM,
  USDC,
  V,
  VAULT,
  ata,
  chain,
  decodeTx,
  delegateWallet,
  encodeAccount,
  fakeConnection,
  info,
  key,
  manager,
  mintData,
  run,
  stranger,
} from "./direct-chain";

const JUP = new PublicKey("JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4");
const JUP_EVENT_AUTHORITY = new PublicKey("D8cy77BBepLMngZx6ZukaTff5hCt1HrWyKk3Hnd9oitf");
const ATA_PROGRAM = new PublicKey("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");
const COMPUTE_BUDGET = "ComputeBudget111111111111111111111111111111";
const ROUTE = [229, 23, 203, 151, 122, 227, 173, 42];
const SHARED_ACCOUNTS_ROUTE = [193, 32, 155, 51, 65, 214, 156, 129];
const ALT = key(50);
const AMM = [key(51), key(52)];
const UNLISTED = key(53);
const SWAP_DATA = Buffer.from([...ROUTE, 7, 7, 7]);
const LITE = "https://lite-api.jup.ag/swap/v1";
const EXCLUDE = "excludeDexes=Kipseli%2CObsidian%2CQuantum%2C1DEX&maxAccounts=40";

const quoteResponse = (labels = ["Meteora DLMM"]) => ({
  inputMint: USDC.toBase58(),
  inAmount: "1000000",
  outputMint: BONK.toBase58(),
  outAmount: "52000000000",
  otherAmountThreshold: "51740000000",
  swapMode: "ExactIn",
  slippageBps: 50,
  priceImpactPct: "0.0012",
  routePlan: labels.map((label) => ({ swapInfo: { ammKey: AMM[0]?.toBase58(), label }, percent: 100 })),
  contextSlot: 1,
});

const meta = (pubkey: PublicKey, isSigner = false, isWritable = false) => ({ pubkey: pubkey.toBase58(), isSigner, isWritable });

/** Jupiter's `route` instruction for `user`: nine fixed accounts, then the AMM accounts and the user again as a signer. */
function swapInstructions(user: PublicKey, destination: PublicKey, destinationTokenProgram: PublicKey, extraAmms: PublicKey[] = []) {
  const destinationAta = getAssociatedTokenAddress(user, destination, destinationTokenProgram);
  return {
    swapInstruction: {
      programId: JUP.toBase58(),
      accounts: [
        meta(TOKEN_PROGRAM),
        meta(user, true),
        meta(key(60), false, true),
        meta(destinationAta, false, true),
        meta(destinationAta, false, true),
        meta(destination),
        meta(JUP),
        meta(JUP_EVENT_AUTHORITY),
        meta(JUP),
        ...[...AMM, ...extraAmms].map((k) => meta(k, false, true)),
        meta(user, true, true),
      ],
      data: SWAP_DATA.toString("base64"),
    },
    setupInstructions: [
      {
        programId: ATA_PROGRAM.toBase58(),
        accounts: [meta(user, true, true), meta(destinationAta, false, true), meta(user), meta(destination), meta(PublicKey.default), meta(destinationTokenProgram)],
        data: Buffer.from([1]).toString("base64"),
      },
    ],
    cleanupInstruction: null,
    addressLookupTableAddresses: [ALT.toBase58()],
  };
}

interface JupiterCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

/** Serves recorded-shape Jupiter responses and records every request. */
function fakeJupiter(responses: { quote?: () => Response; swap?: () => Response } = {}) {
  const calls: JupiterCall[] = [];
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const url = String(input);
    calls.push({
      url,
      method: init?.method ?? "GET",
      headers: Object.fromEntries(Object.entries(init?.headers ?? {})),
      body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
    });
    if (url.includes("/quote?")) return responses.quote?.() ?? json(quoteResponse());
    return responses.swap?.() ?? json(swapInstructions(VAULT, BONK, TOKEN_2022));
  };
  return { fetch, calls };
}

function lookupTable(addresses: PublicKey[]): Buffer {
  const data = Buffer.alloc(56 + addresses.length * 32);
  data.writeUInt32LE(1, 0);
  data.writeBigUInt64LE(0xffff_ffff_ffff_ffffn, 4);
  addresses.forEach((a, i) => a.toBuffer().copy(data, 56 + i * 32));
  return data;
}

function tokenAccount(mint: PublicKey, owner: PublicKey, amount: bigint, withheld?: bigint): Buffer {
  const data = Buffer.alloc(withheld === undefined ? 165 : 178);
  mint.toBuffer().copy(data, 0);
  owner.toBuffer().copy(data, 32);
  data.writeBigUInt64LE(amount, 64);
  data.writeUInt8(1, 108);
  if (withheld !== undefined) {
    data.writeUInt8(2, 165);
    data.writeUInt16LE(2, 166);
    data.writeUInt16LE(8, 168);
    data.writeBigUInt64LE(withheld, 170);
  }
  return data;
}

const BONK_ATA = getAssociatedTokenAddress(VAULT, BONK, TOKEN_2022);
const SOL_STRATEGY = getStrategyPda(VAULT, SOL, PROGRAM);

/** The direct-build chain plus a lookup table, an unlisted mint, the vault's BONK balance, and the config's slippage cap. */
async function jupiterChain(o: { delegatePermissions?: number; maxSlippageBps?: number; bonkBalance?: bigint; withheld?: bigint } = {}) {
  const accounts = await chain({ permissions: o.delegatePermissions ?? 1, expiresAt: 0 });
  accounts.set(ALT.toBase58(), info(new PublicKey("AddressLookupTab1e1111111111111111111111111"), lookupTable(AMM)));
  accounts.set(UNLISTED.toBase58(), info(TOKEN_PROGRAM, mintData()));
  accounts.set(getConfigPda(PROGRAM).toBase58(), info(PROGRAM, await encodeAccount("config", { nextVaultId: new BN(3), maxSlippageBps: o.maxSlippageBps ?? 0 })));
  if (o.bonkBalance !== undefined) accounts.set(BONK_ATA.toBase58(), info(TOKEN_2022, tokenAccount(BONK, VAULT, o.bonkBalance, o.withheld)));
  return accounts;
}

const buyBody = { vault: V, sourceMint: USDC.toBase58(), destinationMint: BONK.toBase58(), amount: "1000000", slippageBps: 50 };
const buy: DirectActionRequest = { action: "jupiter/swap", ...buyBody };

const swapAccounts = {
  authority: M,
  config: getConfigPda(PROGRAM).toBase58(),
  vault: V,
  strategy: BONK_STRATEGY.toBase58(),
  source_strategy: P,
  source_mint: USDC.toBase58(),
  destination_mint: BONK.toBase58(),
  vault_source_token_account: ata(VAULT, USDC, TOKEN_PROGRAM),
  vault_destination_token_account: BONK_ATA.toBase58(),
  source_token_program: TOKEN_PROGRAM.toBase58(),
  destination_token_program: TOKEN_2022.toBase58(),
  system_program: "11111111111111111111111111111111",
  associated_token_program: ATA_PROGRAM.toBase58(),
  event_authority: JUP_EVENT_AUTHORITY.toBase58(),
  jupiter_program: JUP.toBase58(),
  delegate: P,
};

describe("direct jupiter/swap", () => {
  it("swaps as the vault authority through the quoted route and confirms", async () => {
    const jupiter = fakeJupiter();
    const { outcome, sent, calls, txs } = await run(buy, {}, manager, await jupiterChain(), { fetch: jupiter.fetch });
    expect(outcome).toEqual({ kind: "confirmed", signatures: [expect.any(String)] });
    expect(calls).toEqual(['send {"preflightCommitment":"confirmed"}', "status"]);
    expect(sent).toHaveLength(1);
    expect(txs).toEqual([
      {
        hedge: [
          {
            name: "jupiterSwap",
            args: { swapData: SWAP_DATA.toString("base64"), amount: "1000000", slippageBps: 50 },
            accounts: swapAccounts,
            // The trailing user meta stays, stripped of its signer flag.
            remaining: [...AMM.map((k) => k.toBase58()), V],
          },
        ],
        payer: M,
        blockhash: expect.any(String),
        computeUnitLimit: 70_000,
        computeUnitPriceMicroLamports: 6_000n,
        // Jupiter's create of the destination ATA is dropped: `jupiter_swap` creates it.
        programs: [COMPUTE_BUDGET, COMPUTE_BUDGET, "jupiterSwap"],
        lookupTables: [ALT.toBase58()],
      },
    ]);
    expect(jupiter.calls).toEqual([
      {
        url: `${LITE}/quote?inputMint=${USDC.toBase58()}&outputMint=${BONK.toBase58()}&amount=1000000&slippageBps=50&swapMode=ExactIn&${EXCLUDE}`,
        method: "GET",
        headers: { "Content-Type": "application/json" },
        body: undefined,
      },
      {
        url: `${LITE}/swap-instructions`,
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: {
          quoteResponse: quoteResponse(),
          userPublicKey: V,
          destinationTokenAccount: BONK_ATA.toBase58(),
          useSharedAccounts: false,
          wrapAndUnwrapSol: false,
          dynamicSlippage: false,
          useTokenLedger: false,
        },
      },
    ]);
  });

  it("swaps for a delegate with Jupiter permission", async () => {
    const { outcome, ix } = await run(buy, {}, delegateWallet, await jupiterChain(), { fetch: fakeJupiter().fetch });
    expect(outcome.kind).toBe("confirmed");
    expect(ix?.accounts).toEqual({ ...swapAccounts, authority: delegateWallet.publicKey.toBase58(), delegate: DELEGATE.toBase58() });
    expect(ix?.payer).toBe(delegateWallet.publicKey.toBase58());
  });

  it("refuses a delegate without Jupiter permission before calling Jupiter", async () => {
    const jupiter = fakeJupiter();
    const { outcome, sent } = await run(buy, {}, delegateWallet, await jupiterChain({ delegatePermissions: 2 }), { fetch: jupiter.fetch });
    expect(outcome).toEqual({ kind: "failed", signatures: [], code: "DelegatePermissionDenied", message: "This delegate cannot run Jupiter actions" });
    expect(jupiter.calls).toEqual([]);
    expect(sent).toEqual([]);
  });

  it("refuses a wallet that is neither authority nor delegate", async () => {
    const { outcome } = await run(buy, {}, stranger, await jupiterChain(), { fetch: fakeJupiter().fetch });
    expect(outcome).toEqual({ kind: "failed", signatures: [], code: "Forbidden", message: "Connected wallet is not the vault authority or one of its delegates" });
  });

  it("clamps slippage above the protocol's maxSlippageBps to the cap, in the quote and the instruction", async () => {
    const jupiter = fakeJupiter();
    const { ix } = await run({ ...buy, slippageBps: 900 }, {}, manager, await jupiterChain({ maxSlippageBps: 300 }), { fetch: jupiter.fetch });
    expect(ix?.args).toEqual({ swapData: SWAP_DATA.toString("base64"), amount: "1000000", slippageBps: 300 });
    expect(jupiter.calls[0]?.url).toContain("&slippageBps=300&");
  });

  it("caps at 1000 bps when the config's cap is the legacy zero", async () => {
    const { ix } = await run({ ...buy, slippageBps: 5000 }, {}, manager, await jupiterChain(), { fetch: fakeJupiter().fetch });
    expect(ix?.args).toMatchObject({ slippageBps: 1000 });
  });

  it("rejects slippage outside 1..10000 before any read", async () => {
    const jupiter = fakeJupiter();
    const { outcome } = await run({ ...buy, slippageBps: 0 }, {}, manager, await jupiterChain(), { fetch: jupiter.fetch });
    expect(outcome).toEqual({ kind: "failed", signatures: [], code: "Validation", message: "slippageBps: Number must be greater than or equal to 1" });
    expect(jupiter.calls).toEqual([]);
  });

  it("refuses a swap of a mint into itself", async () => {
    const { outcome } = await run({ ...buy, destinationMint: USDC.toBase58() }, {}, manager, await jupiterChain(), { fetch: fakeJupiter().fetch });
    expect(outcome).toEqual({ kind: "failed", signatures: [], code: "Validation", message: "sourceMint and destinationMint must differ" });
  });

  it.each([
    {
      failure: "a quote 500",
      responses: { quote: () => new Response("upstream down", { status: 500 }) },
      code: "JupiterQuoteFailed",
      message: "Jupiter could not quote this swap right now. Try again in a moment.",
    },
    {
      failure: "no route",
      responses: { quote: () => json({ error: "No routes found", errorCode: "COULD_NOT_FIND_ANY_ROUTE" }, 400) },
      code: "JupiterQuoteFailed",
      message: "Jupiter found no swap route for this pair and amount. Try a different amount or token.",
    },
    {
      failure: "a quote that is not JSON",
      responses: { quote: () => new Response("<html>", { status: 200 }) },
      code: "JupiterBadResponse",
      message: "Jupiter returned a response that is not JSON (/quote)",
    },
    {
      failure: "a quote missing outAmount",
      responses: { quote: () => json({ ...quoteResponse(), outAmount: undefined }) },
      code: "JupiterBadResponse",
      message: "Jupiter returned an unexpected response (/quote)",
    },
    {
      failure: "a swap-instructions 500",
      responses: { swap: () => new Response("", { status: 500 }) },
      code: "JupiterSwapFailed",
      message: "Jupiter could not build this swap right now. Try again in a moment.",
    },
    {
      failure: "malformed swap-instructions JSON",
      responses: { swap: () => new Response("{", { status: 200 }) },
      code: "JupiterBadResponse",
      message: "Jupiter returned a response that is not JSON (/swap-instructions)",
    },
    {
      failure: "a swap instruction with a bad program id",
      responses: { swap: () => json({ ...swapInstructions(VAULT, BONK, TOKEN_2022), swapInstruction: { programId: "nope", accounts: [], data: "" } }) },
      code: "JupiterBadResponse",
      message: "Jupiter returned an unexpected response (/swap-instructions)",
    },
    {
      failure: "a shared-accounts route",
      responses: {
        swap: () => {
          const res = swapInstructions(VAULT, BONK, TOKEN_2022);
          return json({ ...res, swapInstruction: { ...res.swapInstruction, data: Buffer.from(SHARED_ACCOUNTS_ROUTE).toString("base64") } });
        },
      },
      code: "JupiterUnsupportedCpiRoute",
      message: "Jupiter returned a route that requires user-level accounts instead of a direct vault CPI",
    },
  ])("fails the build on $failure and sends nothing", async ({ responses, code, message }) => {
    const { outcome, sent, calls } = await run(buy, {}, manager, await jupiterChain(), { fetch: fakeJupiter(responses).fetch });
    expect(outcome).toEqual({ kind: "failed", signatures: [], code, message });
    expect(sent).toEqual([]);
    expect(calls).toEqual([]);
  });

  it("fails the build when Jupiter is unreachable", async () => {
    const fetch: typeof globalThis.fetch = async () => {
      throw new TypeError("fetch failed");
    };
    const { outcome, sent } = await run(buy, {}, manager, await jupiterChain(), { fetch });
    expect(outcome).toEqual({ kind: "failed", signatures: [], code: "JupiterQuoteFailed", message: "Jupiter could not quote this swap right now. Try again in a moment." });
    expect(sent).toEqual([]);
  });

  it("sends x-api-key to api.jup.ag when jupiterApiKey is set", async () => {
    const jupiter = fakeJupiter();
    await run(buy, {}, manager, await jupiterChain(), { fetch: jupiter.fetch, jupiterApiKey: "test-key" });
    expect(jupiter.calls.map((c) => [c.url.split("?")[0], c.headers])).toEqual([
      ["https://api.jup.ag/swap/v1/quote", { "Content-Type": "application/json", "x-api-key": "test-key" }],
      ["https://api.jup.ag/swap/v1/swap-instructions", { "Content-Type": "application/json", "x-api-key": "test-key" }],
    ]);
  });

  it("uses jupiterHost over the default host", async () => {
    const jupiter = fakeJupiter();
    await run(buy, {}, manager, await jupiterChain(), { fetch: jupiter.fetch, jupiterHost: "https://jup.example" });
    expect(jupiter.calls.map((c) => c.url.split("?")[0])).toEqual(["https://jup.example/swap/v1/quote", "https://jup.example/swap/v1/swap-instructions"]);
  });

  it("creates the destination strategy in the same transaction on the first swap into a token", async () => {
    const jupiter = fakeJupiter({ swap: () => json(swapInstructions(VAULT, SOL, TOKEN_PROGRAM)) });
    const { outcome, txs } = await run({ ...buy, destinationMint: SOL.toBase58() }, {}, manager, await jupiterChain(), { fetch: jupiter.fetch });
    expect(outcome.kind).toBe("confirmed");
    expect(txs.map((t) => t.programs)).toEqual([[COMPUTE_BUDGET, COMPUTE_BUDGET, "jupiterInitializeStrategy", "jupiterSwap"]]);
    expect(txs[0]?.hedge.map((h) => h.accounts.strategy)).toEqual([SOL_STRATEGY.toBase58(), SOL_STRATEGY.toBase58()]);
  });

  it("closes the source strategy in the same transaction when the swap sells the whole balance", async () => {
    const jupiter = fakeJupiter({ swap: () => json(swapInstructions(VAULT, USDC, TOKEN_PROGRAM)) });
    const sell: DirectActionRequest = { ...buy, sourceMint: BONK.toBase58(), destinationMint: USDC.toBase58(), amount: "777" };
    const { txs } = await run(sell, {}, manager, await jupiterChain({ bonkBalance: 777n }), { fetch: jupiter.fetch });
    expect(txs.map((t) => t.programs)).toEqual([[COMPUTE_BUDGET, COMPUTE_BUDGET, "jupiterSwap", "vaultCloseStrategy"]]);
    expect(txs[0]?.hedge[1]).toEqual({
      name: "vaultCloseStrategy",
      args: {},
      accounts: { authority: M, config: getConfigPda(PROGRAM).toBase58(), vault: V, strategy: BONK_STRATEGY.toBase58(), system_program: "11111111111111111111111111111111", delegate: P },
      remaining: [BONK_ATA.toBase58(), TOKEN_2022.toBase58()],
    });
  });

  it.each([
    { left: "a partial balance", bonkBalance: 778n, withheld: undefined },
    { left: "withheld transfer fees", bonkBalance: 777n, withheld: 1n },
  ])("keeps the source strategy open with $left", async ({ bonkBalance, withheld }) => {
    const jupiter = fakeJupiter({ swap: () => json(swapInstructions(VAULT, USDC, TOKEN_PROGRAM)) });
    const sell: DirectActionRequest = { ...buy, sourceMint: BONK.toBase58(), destinationMint: USDC.toBase58(), amount: "777" };
    const { txs } = await run(sell, {}, manager, await jupiterChain({ bonkBalance, withheld }), { fetch: jupiter.fetch });
    expect(txs.map((t) => t.programs)).toEqual([[COMPUTE_BUDGET, COMPUTE_BUDGET, "jupiterSwap"]]);
  });

  it("runs a Pump.fun route as the vault's swap authority", async () => {
    const authority = getSwapAuthorityPda(VAULT, PROGRAM);
    const jupiter = fakeJupiter({ quote: () => json(quoteResponse(["Pump.fun"])), swap: () => json(swapInstructions(authority, BONK, TOKEN_2022)) });
    const { ix } = await run(buy, {}, manager, await jupiterChain(), { fetch: jupiter.fetch });
    expect(ix?.name).toBe("jupiterSwapViaAuthority");
    expect(ix?.accounts).toMatchObject({ swap_authority: authority.toBase58(), swap_destination_token_account: ata(authority, BONK, TOKEN_2022) });
    expect(jupiter.calls[1]?.body).toMatchObject({ userPublicKey: authority.toBase58(), destinationTokenAccount: ata(authority, BONK, TOKEN_2022) });
  });
});

/** One build through the local transport, to see the steps `execute` would follow. */
async function buildSteps(action: "jupiter/swap" | "jupiter/sweep", body: Record<string, unknown>, accounts: Map<string, AccountInfo<Buffer>>, fetch: typeof globalThis.fetch) {
  const { connection, calls } = fakeConnection(accounts);
  const transport = localTransport({ connection, programId: PROGRAM, payer: manager.publicKey, now: () => NOW_MS, fetch, jupiter: jupiterConfig() });
  const steps = await transport.build(action, body);
  return { steps, calls, txs: steps.map((s) => decodeTx(Buffer.from(s.transaction, "base64"), accounts)) };
}

/** AMM accounts outside the lookup table: at 15 a sweep's swap fits alone but not with its close; at 16 a swap no longer fits with a strategy init. */
const route = (length: number) => Array.from({ length }, (_, i) => key(100 + i));

describe("direct jupiter/swap steps", () => {
  it("returns the API's step shape with initializesStrategy", async () => {
    const { steps } = await buildSteps("jupiter/swap", buyBody, await jupiterChain(), fakeJupiter().fetch);
    expect(steps.map((s) => Object.keys(s).sort())).toEqual([["blockhash", "initializesStrategy", "simulation", "ticket", "transaction"]]);
    expect(steps[0]).toMatchObject({ initializesStrategy: false, ticket: "local", simulation: { unitsConsumed: 50_000 } });
  });

  it("initializes the strategy alone and continues with the swap when both do not fit", async () => {
    const jupiter = fakeJupiter({ swap: () => json(swapInstructions(VAULT, SOL, TOKEN_PROGRAM, route(16))) });
    const body = { vault: V, sourceMint: USDC.toBase58(), destinationMint: SOL.toBase58(), amount: "1000000", slippageBps: 900 };
    const { steps, txs } = await buildSteps("jupiter/swap", body, await jupiterChain(), jupiter.fetch);
    expect(txs.map((t) => t.programs)).toEqual([[COMPUTE_BUDGET, COMPUTE_BUDGET, "jupiterInitializeStrategy"]]);
    expect(steps.map((s) => [s.initializesStrategy, s.next])).toEqual([[true, { path: "jupiter/swap", body }]]);
  });
});

const sweep = (mint: PublicKey, slippageBps = 50): DirectActionRequest => ({ action: "jupiter/sweep", vault: V, mint: mint.toBase58(), slippageBps });

describe("direct jupiter/sweep", () => {
  it("sells the whole balance to the deposit mint and closes the strategy while two open DLMM strategies use other mints", async () => {
    const jupiter = fakeJupiter({ swap: () => json(swapInstructions(VAULT, USDC, TOKEN_PROGRAM)) });
    const { outcome, txs } = await run(sweep(BONK), {}, manager, await jupiterChain({ bonkBalance: 4_200n }), { fetch: jupiter.fetch });
    expect(outcome.kind).toBe("confirmed");
    expect(jupiter.calls[0]?.url).toBe(`${LITE}/quote?inputMint=${BONK.toBase58()}&outputMint=${USDC.toBase58()}&amount=4200&slippageBps=50&swapMode=ExactIn&${EXCLUDE}`);
    expect(txs.map((t) => t.programs)).toEqual([[COMPUTE_BUDGET, COMPUTE_BUDGET, "jupiterSwap", "vaultCloseStrategy"]]);
    expect(txs[0]?.hedge[0]).toMatchObject({
      args: { amount: "4200", slippageBps: 50 },
      accounts: { strategy: BONK_STRATEGY.toBase58(), source_strategy: P, source_mint: BONK.toBase58(), destination_mint: USDC.toBase58() },
    });
    expect(txs[0]?.lookupTables).toEqual([ALT.toBase58()]);
  });

  it("refuses a mint an open DLMM position or limit order still uses", async () => {
    const jupiter = fakeJupiter();
    const { outcome } = await run(sweep(SOL), {}, manager, await jupiterChain(), { fetch: jupiter.fetch });
    expect(outcome).toEqual({ kind: "failed", signatures: [], code: "MintInUse", message: "An open LP position or limit order still uses this token; close it first" });
    expect(jupiter.calls).toEqual([]);
  });

  it("refuses a mint without a Jupiter strategy", async () => {
    const { outcome } = await run(sweep(UNLISTED), {}, manager, await jupiterChain(), { fetch: fakeJupiter().fetch });
    expect(outcome).toEqual({ kind: "failed", signatures: [], code: "NothingToSweep", message: "The vault has no Jupiter strategy for this token" });
  });

  it("refuses the deposit mint", async () => {
    const { outcome } = await run(sweep(USDC), {}, manager, await jupiterChain(), { fetch: fakeJupiter().fetch });
    expect(outcome).toEqual({ kind: "failed", signatures: [], code: "Validation", message: "mint must differ from the vault deposit mint" });
  });

  it("only closes the strategy when the balance is already zero, without calling Jupiter", async () => {
    const jupiter = fakeJupiter();
    const { outcome, txs } = await run(sweep(BONK), {}, manager, await jupiterChain(), { fetch: jupiter.fetch });
    expect(outcome.kind).toBe("confirmed");
    expect(txs.map((t) => t.programs)).toEqual([[COMPUTE_BUDGET, COMPUTE_BUDGET, "vaultCloseStrategy"]]);
    expect(jupiter.calls).toEqual([]);
  });

  it("reports a leftover with no route as unroutable", async () => {
    const jupiter = fakeJupiter({ quote: () => json({ errorCode: "NO_ROUTES_FOUND" }, 400) });
    const { outcome, sent } = await run(sweep(BONK), {}, manager, await jupiterChain({ bonkBalance: 1n }), { fetch: jupiter.fetch });
    expect(outcome).toEqual({ kind: "failed", signatures: [], code: "SweepUnroutable", message: "Jupiter found no route for this leftover token; it stays in the vault" });
    expect(sent).toEqual([]);
  });

  it("refuses a delegate without Jupiter permission", async () => {
    const { outcome } = await run(sweep(BONK), {}, delegateWallet, await jupiterChain({ delegatePermissions: 4, bonkBalance: 1n }), { fetch: fakeJupiter().fetch });
    expect(outcome).toEqual({ kind: "failed", signatures: [], code: "DelegatePermissionDenied", message: "This delegate cannot run Jupiter actions" });
  });

  it("continues with a second sweep when the close does not fit behind a long route", async () => {
    const jupiter = fakeJupiter({ swap: () => json(swapInstructions(VAULT, USDC, TOKEN_PROGRAM, route(15))) });
    const { steps, txs } = await buildSteps("jupiter/sweep", { vault: V, mint: BONK.toBase58(), slippageBps: 900 }, await jupiterChain({ maxSlippageBps: 300, bonkBalance: 9n }), jupiter.fetch);
    expect(txs.map((t) => t.programs)).toEqual([[COMPUTE_BUDGET, COMPUTE_BUDGET, "jupiterSwap"]]);
    expect(steps.map((s) => s.next)).toEqual([{ path: "jupiter/sweep", body: { vault: V, mint: BONK.toBase58(), slippageBps: 300 } }]);
  });
});

describe("direct getQuote", () => {
  const request = { vault: V, inputMint: USDC.toBase58(), outputMint: BONK.toBase58(), amount: "1000000", slippageBps: 900 };

  it("returns Jupiter's quote with the slippage capped by the protocol config", async () => {
    const jupiter = fakeJupiter();
    const { connection } = fakeConnection(await jupiterChain({ maxSlippageBps: 300 }));
    const quote = await createDirectClient({ connection, fetch: jupiter.fetch }).getQuote(request);
    expect(quote).toEqual({ inAmount: "1000000", outAmount: "52000000000", priceImpactPct: "0.0012", routeLabels: ["Meteora DLMM"], slippageBps: 300 });
    expect(jupiter.calls.map((c) => c.url)).toEqual([`${LITE}/quote?inputMint=${USDC.toBase58()}&outputMint=${BONK.toBase58()}&amount=1000000&slippageBps=300&swapMode=ExactIn&${EXCLUDE}`]);
  });

  it("refuses an address that is not a vault before calling Jupiter", async () => {
    const jupiter = fakeJupiter();
    const { connection } = fakeConnection(await jupiterChain());
    const client = createDirectClient({ connection, fetch: jupiter.fetch });
    await expect(client.getQuote({ ...request, vault: Keypair.generate().publicKey.toBase58() })).rejects.toMatchObject({ code: "NotFound" });
    expect(jupiter.calls).toEqual([]);
  });

  it("refuses a quote of a mint into itself", async () => {
    const { connection } = fakeConnection(await jupiterChain());
    await expect(createDirectClient({ connection, fetch: fakeJupiter().fetch }).getQuote({ ...request, outputMint: USDC.toBase58() })).rejects.toMatchObject({
      code: "Validation",
      message: "inputMint and outputMint must differ",
    });
  });
});
