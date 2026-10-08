import { Keypair, PublicKey, TransactionInstruction, TransactionMessage, VersionedTransaction } from "@solana/web3.js";
import { describe, expect, it, vi } from "vitest";
import { createHedgeClient } from "../src/client";
import { ApiError } from "../src/errors";
import { keypairSigner } from "../src/signer";
import { SOL, USDC, VAULT, holdings, quote } from "./fixtures";

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
