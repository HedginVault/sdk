import { ComputeBudgetProgram, Keypair, PublicKey, TransactionInstruction, TransactionMessage, VersionedTransaction } from "@solana/web3.js";
import { describe, expect, it, vi } from "vitest";
import { createHedgeClient } from "../src/client";
import { ApiError } from "../src/errors";
import type { ActionRequest } from "../src/actions";
import { PHOENIX_PROGRAM_ID, keypairSigner } from "../src/signer";
import { SOL, USDC, VAULT, holdings, navHistory, phoenixView, quote, requestQueue, strategyHistory, vaultDetail } from "./fixtures";

const vault = {
  address: "Vau1t111111111111111111111111111111111111111",
  name: "Demo",
  status: "active",
  depositMint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
  depositSymbol: "USDC",
  depositDecimals: 6,
  totalAssets: "1500000",
  navPerShare: "1000000",
};

function stubFetch(status: number, body: unknown) {
  return vi.fn(async () => new Response(JSON.stringify(body), { status }));
}

describe("createHedgeClient", () => {
  it("lists vaults with the bearer key on the V1 path", async () => {
    const fetch = stubFetch(200, { vaults: [vault] });
    const api = createHedgeClient({ baseUrl: "https://example.test", apiKey: "hv1_demo_secret", fetch });
    const vaults = await api.listVaults();
    expect(vaults).toEqual([
      { address: vault.address, name: "Demo", status: "active", depositMint: vault.depositMint, depositSymbol: "USDC", depositDecimals: 6, totalAssets: "1500000" },
    ]);
    expect(fetch).toHaveBeenCalledWith(
      "https://example.test/api/external/v1/vaults",
      expect.objectContaining({ headers: { Authorization: "Bearer hv1_demo_secret" } }),
    );
  });
  it("surfaces the documented error body", async () => {
    const api = createHedgeClient({ baseUrl: "https://example.test", apiKey: "k", fetch: stubFetch(401, { error: { code: "unauthorized", message: "Invalid API key" } }) });
    await expect(api.listVaults()).rejects.toEqual(new ApiError(401, "unauthorized", "Invalid API key"));
    await expect(api.listVaults()).rejects.toMatchObject({ status: 401, code: "unauthorized" });
  });
  it("flags a success body that breaks the contract", async () => {
    const api = createHedgeClient({ baseUrl: "https://example.test", apiKey: "k", fetch: stubFetch(200, { vaults: [{ ...vault, totalAssets: 1.5 }] }) });
    await expect(api.listVaults()).rejects.toMatchObject({ code: "contract_mismatch" });
  });

  it("reads holdings from the vault-scoped path", async () => {
    const fetch = stubFetch(200, { vault: VAULT, data: holdings });
    const api = createHedgeClient({ baseUrl: "https://example.test", apiKey: "k", fetch });
    expect(await api.getHoldings(VAULT)).toEqual(holdings);
    expect(fetch).toHaveBeenCalledWith(`https://example.test/api/external/v1/vaults/${VAULT}/holdings`, expect.anything());
  });
  it("sends quote parameters as query strings", async () => {
    const fetch = stubFetch(200, { vault: VAULT, data: quote });
    const api = createHedgeClient({ baseUrl: "https://example.test", apiKey: "k", fetch });
    expect(await api.getQuote({ vault: VAULT, inputMint: USDC, outputMint: SOL, amount: "1000000", slippageBps: 50 })).toEqual(quote);
    expect(fetch).toHaveBeenCalledWith(
      `https://example.test/api/external/v1/jupiter/quote?vault=${VAULT}&inputMint=${USDC}&outputMint=${SOL}&amount=1000000&slippageBps=50`,
      expect.anything(),
    );
  });
  it("rejects a strategy type the contract does not know", async () => {
    const api = createHedgeClient({ baseUrl: "https://example.test", apiKey: "k", fetch: stubFetch(200, { vault: VAULT, data: [{ type: "mystery", address: "x" }] }) });
    await expect(api.getStrategies(VAULT)).rejects.toMatchObject({ code: "contract_mismatch" });
  });

  it("accepts the docs' base URL form", async () => {
    const fetch = stubFetch(200, { vaults: [] });
    await createHedgeClient({ baseUrl: "https://hedgin.xyz/api/external/v1/", apiKey: "k", fetch }).listVaults();
    expect(fetch).toHaveBeenCalledWith("https://hedgin.xyz/api/external/v1/vaults", expect.anything());
  });

  it("reads a pasted mint's details with the vault scope", async () => {
    const token = { mint: SOL, symbol: "SOL", decimals: 9, priceUsd: 150, verified: true, logo: null };
    const fetch = stubFetch(200, { vault: VAULT, data: token });
    const api = createHedgeClient({ baseUrl: "https://example.test", apiKey: "k", fetch });
    expect(await api.getToken(VAULT, SOL)).toEqual({ mint: SOL, symbol: "SOL", decimals: 9, priceUsd: 150, verified: true });
    expect(fetch).toHaveBeenCalledWith(`https://example.test/api/external/v1/tokens/${SOL}?vault=${VAULT}`, expect.anything());
  });

  it("reads one pool's active bin with the vault scope", async () => {
    const pool = { lbPair: "Pool1", tokenX: { mint: SOL, symbol: "SOL", decimals: 9 }, tokenY: { mint: USDC, symbol: "USDC", decimals: 6 }, binStep: 10, activeBinId: -5, activePrice: "150" };
    const fetch = stubFetch(200, { vault: VAULT, data: pool });
    const api = createHedgeClient({ baseUrl: "https://example.test", apiKey: "k", fetch });
    expect(await api.getPool(VAULT, "Pool1")).toEqual(pool);
    expect(fetch).toHaveBeenCalledWith(`https://example.test/api/external/v1/dlmm/pools/Pool1?vault=${VAULT}`, expect.anything());
  });

  it("searches pools with the vault scope", async () => {
    const fetch = stubFetch(200, { vault: VAULT, data: { total: 0, page: 2, pages: 0, pools: [] } });
    const api = createHedgeClient({ baseUrl: "https://example.test", apiKey: "k", fetch });
    expect(await api.searchPools(VAULT, "SOL", 2)).toEqual({ total: 0, page: 2, pages: 0, pools: [] });
    expect(fetch).toHaveBeenCalledWith(`https://example.test/api/external/v1/dlmm/pools?vault=${VAULT}&query=SOL&page=2`, expect.anything());
  });

  it("keeps an LP position's token prices, Meteora PnL, and open time", async () => {
    const tokenX = { mint: SOL, symbol: "SOL", decimals: 9, priceUsd: 150, logo: null };
    const tokenY = { mint: USDC, symbol: "USDC", decimals: 6, priceUsd: 1, logo: null };
    const dlmm = {
      type: "dlmm", address: "S1", position: "P1", lbPair: "Pool1", tokenX, tokenY, lowerPrice: "140", upperPrice: "160", activePrice: "150",
      amountX: "1", amountY: "2", pendingFeeX: "0", pendingFeeY: "0", createdTs: 1_700_000_000, pnlUsd: -1.5, pnlPct: -2.25, bins: [],
    };
    const fetch = stubFetch(200, { vault: VAULT, data: [dlmm] });
    const api = createHedgeClient({ baseUrl: "https://example.test", apiKey: "k", fetch });
    const [strategy] = await api.getStrategies(VAULT);
    expect(strategy).toMatchObject({ tokenX: { priceUsd: 150 }, tokenY: { priceUsd: 1 }, createdTs: 1_700_000_000, pnlUsd: -1.5, pnlPct: -2.25 });
  });

  it("keeps a pool's fee, TVL, and 24h volume from search results", async () => {
    const tokenX = { mint: SOL, symbol: "SOL", decimals: 9 };
    const tokenY = { mint: USDC, symbol: "USDC", decimals: 6 };
    const found = { address: "Pool1", name: "SOL-USDC", tokenX, tokenY, binStep: 20, baseFeePct: 0.2, tvl: 1_250_000, volume24h: 340_000, fees24h: 680, currentPrice: 150 };
    const fetch = stubFetch(200, { vault: VAULT, data: { total: 1, page: 1, pages: 1, pools: [found] } });
    const api = createHedgeClient({ baseUrl: "https://example.test", apiKey: "k", fetch });
    expect((await api.searchPools(VAULT, "SOL")).pools).toEqual([
      { address: "Pool1", name: "SOL-USDC", tokenX, tokenY, binStep: 20, baseFeePct: 0.2, tvl: 1_250_000, volume24h: 340_000, fees24h: 680 },
    ]);
  });
});

describe("execute", () => {
  const PROGRAM_ID = "r2ahBQ6gbPCJ9FxBymYcXuwXi8NmenRry7SE7QR7FAt";
  const manager = Keypair.generate();

  function unsignedSwap(payer = manager.publicKey): string {
    const message = new TransactionMessage({
      payerKey: payer,
      recentBlockhash: Keypair.generate().publicKey.toBase58(),
      instructions: [new TransactionInstruction({ programId: new PublicKey(PROGRAM_ID), keys: [], data: Buffer.from([1]) })],
    }).compileToV0Message();
    return Buffer.from(new VersionedTransaction(message).serialize()).toString("base64");
  }

  /** Routes the three write endpoints like the V1 API does. */
  function writeApi(transaction: string) {
    const requests: { path: string; body: unknown }[] = [];
    const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input));
      const body: unknown = init?.body ? JSON.parse(String(init.body)) : undefined;
      requests.push({ path: url.pathname + url.search, body });
      if (url.pathname.endsWith("/transactions/jupiter/swap")) {
        return Response.json({ vault: VAULT, result: { transaction, simulation: { unitsConsumed: 1 }, ticket: "tk", blockhash: "bh" } });
      }
      if (url.pathname.endsWith("/transactions/send")) return Response.json({ signature: "sig1", receipt: "rc1", status: "pending" });
      if (url.pathname.endsWith("/transactions/status")) return Response.json({ status: "confirmed" });
      return Response.json({ error: { code: "NotFound", message: "?" } }, { status: 404 });
    });
    return { fetch, requests };
  }

  const swap = { action: "jupiter/swap", vault: VAULT, sourceMint: USDC, destinationMint: SOL, amount: "1000000", slippageBps: 50 } as const;

  it("runs build → sign → send → status in one call without sending payer", async () => {
    const { fetch, requests } = writeApi(unsignedSwap());
    const outcome = await createHedgeClient({ apiKey: "k", fetch }).execute(swap, keypairSigner(manager));
    expect(outcome).toEqual({ kind: "confirmed", signatures: ["sig1"] });
    expect(requests.map((r) => r.path)).toEqual([
      "/api/external/v1/transactions/jupiter/swap",
      "/api/external/v1/transactions/send",
      "/api/external/v1/transactions/status?receipt=rc1",
    ]);
    expect(requests[0]?.body).toEqual({ vault: VAULT, sourceMint: USDC, destinationMint: SOL, amount: "1000000", slippageBps: 50 });
    const sent = requests[1]?.body as { transaction: string; ticket: string };
    expect(sent.ticket).toBe("tk");
    expect(VersionedTransaction.deserialize(Buffer.from(sent.transaction, "base64")).signatures[0]?.some((b) => b !== 0)).toBe(true);
  });

  it("refuses a build paid by another wallet and sends nothing", async () => {
    const { fetch, requests } = writeApi(unsignedSwap(Keypair.generate().publicKey));
    const outcome = await createHedgeClient({ apiKey: "k", fetch }).execute(swap, keypairSigner(manager));
    expect(outcome.kind).toBe("refused");
    expect(requests).toHaveLength(1);
  });
});

describe("vault reads", () => {
  const api = (body: unknown) => {
    const fetch = stubFetch(200, { vault: VAULT, data: body });
    return { fetch, client: createHedgeClient({ baseUrl: "https://example.test", apiKey: "k", fetch }) };
  };
  const get = expect.objectContaining({ method: "GET" });

  it("reads the vault detail from the vault root", async () => {
    const { fetch, client } = api(vaultDetail);
    expect(await client.getVault(VAULT)).toEqual(vaultDetail);
    expect(fetch).toHaveBeenCalledWith(`https://example.test/api/external/v1/vaults/${VAULT}`, get);
  });
  it("reads NAV history with and without a limit", async () => {
    const { fetch, client } = api(navHistory);
    expect(await client.getNavHistory(VAULT, 5)).toEqual(navHistory);
    await client.getNavHistory(VAULT);
    expect(fetch).toHaveBeenNthCalledWith(1, `https://example.test/api/external/v1/vaults/${VAULT}/nav?limit=5`, get);
    expect(fetch).toHaveBeenNthCalledWith(2, `https://example.test/api/external/v1/vaults/${VAULT}/nav`, get);
  });
  it("reads the request queue", async () => {
    const { fetch, client } = api(requestQueue);
    expect(await client.getRequests(VAULT)).toEqual(requestQueue);
    expect(fetch).toHaveBeenCalledWith(`https://example.test/api/external/v1/vaults/${VAULT}/requests`, get);
  });
  it("reads strategy history", async () => {
    const { fetch, client } = api(strategyHistory);
    expect(await client.getStrategyHistory(VAULT)).toEqual(strategyHistory);
    expect(fetch).toHaveBeenCalledWith(`https://example.test/api/external/v1/vaults/${VAULT}/strategy-history`, get);
  });
  it("reads the Phoenix view", async () => {
    const { fetch, client } = api(phoenixView);
    expect(await client.getPhoenix(VAULT)).toEqual(phoenixView);
    expect(fetch).toHaveBeenCalledWith(`https://example.test/api/external/v1/vaults/${VAULT}/phoenix`, get);
  });
  it("surfaces the history service being unconfigured", async () => {
    const fetch = stubFetch(503, { error: { code: "HistoryUnavailable", message: "Service temporarily unavailable" } });
    const client = createHedgeClient({ baseUrl: "https://example.test", apiKey: "k", fetch });
    await expect(client.getNavHistory(VAULT)).rejects.toMatchObject({ status: 503, code: "HistoryUnavailable" });
  });
});

const PROGRAM = new PublicKey("r2ahBQ6gbPCJ9FxBymYcXuwXi8NmenRry7SE7QR7FAt");
const PHOENIX = new PublicKey(PHOENIX_PROGRAM_ID);

function unsigned(payer: PublicKey, instructions: TransactionInstruction[]): string {
  const message = new TransactionMessage({ payerKey: payer, recentBlockhash: Keypair.generate().publicKey.toBase58(), instructions }).compileToV0Message();
  return Buffer.from(new VersionedTransaction(message).serialize()).toString("base64");
}

/** Records every request and answers builds, sends, submits, and status like the V1 API. */
function routedApi(routes: { build: () => string; submit?: () => Response; status?: () => Response }) {
  const requests: { method: string; path: string; body: unknown }[] = [];
  const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const path = url.pathname.replace("/api/external/v1", "");
    requests.push({ method: init?.method ?? "GET", path: path + url.search, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    if (path === "/transactions/send") return Response.json({ signature: "sig1", receipt: "rc1", status: "pending" });
    if (path === "/transactions/phoenix/onboard/submit") return routes.submit?.() ?? Response.json({ signature: "onb1", receipt: "rc-onb", status: "pending" });
    if (path === "/transactions/status") return routes.status?.() ?? Response.json({ status: "confirmed" });
    const vault = path === "/transactions/vault/initialize" ? "NewVau1t11111111111111111111111111111111111" : VAULT;
    return Response.json({ vault, result: { transaction: routes.build(), simulation: { unitsConsumed: 0, deferred: true }, ticket: "tk", blockhash: "bh" } });
  });
  return { fetch, requests };
}

describe("new builder actions", () => {
  const manager = Keypair.generate();
  const vaultIx = new TransactionInstruction({ programId: PROGRAM, keys: [], data: Buffer.from([1]) });

  const cases: { request: ActionRequest; path: string; body: Record<string, unknown> }[] = [
    {
      request: { action: "phoenix/order", vault: VAULT, symbol: "SOL", side: "short", size: "0.5", reduceOnly: false, order: { type: "market", slippageBps: 100 } },
      path: "/transactions/phoenix/order",
      body: { vault: VAULT, symbol: "SOL", side: "short", size: "0.5", reduceOnly: false, order: { type: "market", slippageBps: 100 } },
    },
    {
      request: { action: "phoenix/cancel", vault: VAULT, symbol: "SOL", orders: [{ priceInTicks: "140000", orderSequenceNumber: "9" }] },
      path: "/transactions/phoenix/cancel",
      body: { vault: VAULT, symbol: "SOL", orders: [{ priceInTicks: "140000", orderSequenceNumber: "9" }] },
    },
    {
      request: { action: "vault/initialize", name: "Bot", depositMint: USDC, performanceFeeBps: 2000, managementFeeBps: 200, depositCap: "0", minDeposit: "1000000", minWithdrawalShares: "1" },
      path: "/transactions/vault/initialize",
      body: { name: "Bot", depositMint: USDC, performanceFeeBps: 2000, managementFeeBps: 200, depositCap: "0", minDeposit: "1000000", minWithdrawalShares: "1" },
    },
    { request: { action: "vault/update", vault: VAULT, withdrawalPaused: true }, path: "/transactions/vault/update", body: { vault: VAULT, withdrawalPaused: true } },
    { request: { action: "dlmm/initialize", vault: VAULT, lbPair: "Pool1", width: 20 }, path: "/transactions/dlmm/initialize", body: { vault: VAULT, lbPair: "Pool1", width: 20 } },
  ];

  it.each(cases)("$path posts its body without payer and confirms", async ({ request, path, body }) => {
    const { fetch, requests } = routedApi({ build: () => unsigned(manager.publicKey, [vaultIx]) });
    const outcome = await createHedgeClient({ apiKey: "k", fetch }).execute(request, keypairSigner(manager));
    expect(outcome).toEqual({ kind: "confirmed", signatures: ["sig1"] });
    expect(requests.map((r) => `${r.method} ${r.path}`)).toEqual([`POST ${path}`, "POST /transactions/send", "GET /transactions/status?receipt=rc1"]);
    expect(requests[0]?.body).toEqual(body);
  });
});

describe("onboardPhoenix", () => {
  const manager = Keypair.generate();
  const onboarder = Keypair.generate().publicKey;
  const phoenixIx = new TransactionInstruction({ programId: PHOENIX, keys: [{ pubkey: onboarder, isSigner: true, isWritable: false }], data: Buffer.from([7]) });
  const clock = () => {
    const state = { t: 0 };
    return { state, options: { sleep: async (ms: number) => void (state.t += ms), now: () => state.t } };
  };

  it("builds, signs as fee payer, submits to Phoenix, and polls to confirmation", async () => {
    const { fetch, requests } = routedApi({ build: () => unsigned(manager.publicKey, [phoenixIx]) });
    const outcome = await createHedgeClient({ apiKey: "k", fetch }).onboardPhoenix(VAULT, keypairSigner(manager));
    expect(outcome).toEqual({ kind: "confirmed", signatures: ["onb1"] });
    expect(requests.map((r) => `${r.method} ${r.path}`)).toEqual([
      "POST /transactions/phoenix/onboard",
      "POST /transactions/phoenix/onboard/submit",
      "GET /transactions/status?receipt=rc-onb",
    ]);
    expect(requests[0]?.body).toEqual({ vault: VAULT });
    const submitted = requests[1]?.body as { transaction: string; ticket: string };
    expect(submitted.ticket).toBe("tk");
    const signatures = VersionedTransaction.deserialize(Buffer.from(submitted.transaction, "base64")).signatures;
    expect(signatures.map((sig) => sig.some((b) => b !== 0))).toEqual([true, false]);
  });

  it("refuses an onboarding transaction that calls another program", async () => {
    const { fetch, requests } = routedApi({ build: () => unsigned(manager.publicKey, [phoenixIx, ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 1 })]) });
    const outcome = await createHedgeClient({ apiKey: "k", fetch }).onboardPhoenix(VAULT, keypairSigner(manager));
    expect(outcome).toEqual({ kind: "refused", signatures: [], reason: "Unexpected program ComputeBudget111111111111111111111111111111" });
    expect(requests).toHaveLength(1);
  });

  it("refuses an onboarding transaction paid by another wallet", async () => {
    const other = Keypair.generate().publicKey;
    const { fetch, requests } = routedApi({ build: () => unsigned(other, [phoenixIx]) });
    const outcome = await createHedgeClient({ apiKey: "k", fetch }).onboardPhoenix(VAULT, keypairSigner(manager));
    expect(outcome).toEqual({ kind: "refused", signatures: [], reason: `Fee payer ${other.toBase58()} is not the signer's key` });
    expect(requests).toHaveLength(1);
  });

  it("reports an ambiguous submit as unresolved without resubmitting or rebuilding", async () => {
    const { fetch, requests } = routedApi({
      build: () => unsigned(manager.publicKey, [phoenixIx]),
      submit: () => Response.json({ signature: "onb1", receipt: "rc-onb", status: "unknown" }),
      status: () => Response.json({ status: "pending" }),
    });
    const { state, options } = clock();
    const outcome = await createHedgeClient({ apiKey: "k", fetch }).onboardPhoenix(VAULT, keypairSigner(manager), options);
    expect(outcome).toEqual({ kind: "unresolved", signatures: ["onb1"], pending: ["onb1"] });
    expect(requests.filter((r) => r.method === "POST").map((r) => r.path)).toEqual(["/transactions/phoenix/onboard", "/transactions/phoenix/onboard/submit"]);
    expect(state.t).toBeGreaterThanOrEqual(120_000);
  });
});
