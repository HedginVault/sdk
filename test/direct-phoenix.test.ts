import { gunzipSync } from "node:zlib";
import { type AccountInfo, PublicKey, SystemProgram, VersionedTransaction } from "@solana/web3.js";
import { describe, expect, it } from "vitest";
import { getConfigPda, getStrategyPda } from "../src/chain/pda";
import { createDirectClient, type DirectActionRequest } from "../src/direct";
import { keypairSigner } from "../src/signer";
import recorded from "./data/phoenix-mainnet.json";
import {
  COMPUTE_BUDGET,
  DELEGATE,
  M,
  NOW_MS,
  P,
  PHOENIX,
  PHOENIX_GLOBAL_CONFIG,
  PROGRAM,
  TOKEN_PROGRAM,
  USDC,
  V,
  VAULT,
  ata,
  chain,
  clock,
  delegateWallet,
  encodeAccount,
  fakeConnection,
  info,
  key,
  manager,
  run,
  signatureOf,
  stranger,
} from "./direct-chain";

const LOG_AUTHORITY = "GdxfTLSsdSY37G6fZoYtdGDSfgFnbT2EmRpuePZxWShS";
const HAWKEYE = "RiSeVw3ZjNfsaXPRb4mgaqYaEEt41pNNJoDvVh7pgQj";
const EMBER_STATE = "6ur7v6AXNpnHeEb6xuk7PyezvZ1i5GrgYyWZkNCpzbRz";
const EMBER_VAULT = "FKcEb4TdPDTRuMnQDpSEPQBcrm15S73xiUD6Qf8ZLUkq";
const EMBER_PROGRAM = "EMBERpYNE6ehWmXymZZS2skiFmCa9V5dp14e1iduM5qy";
const ATA_PROGRAM = "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL";
const SYSTEM = SystemProgram.programId.toBase58();
const API = "https://perp-api.phoenix.trade";

const CANONICAL = key(70);
const GLOBAL_VAULT = key(71);
const PERP_ASSET_MAP = key(72);
const GLOBAL_TRADER_INDEX = key(73);
const ACTIVE_TRADER_BUFFER = key(74);
const WITHDRAW_QUEUE = key(75);
const SOL_BOOK = key(80);
const BTC_BOOK = key(81);
const ONBOARDER = key(90);

const phoenixPda = (...seeds: Buffer[]) => PublicKey.findProgramAddressSync(seeds, PHOENIX)[0];
const TRADER = phoenixPda(Buffer.from("trader"), VAULT.toBuffer(), Buffer.from([0, 0]));
const STRATEGY = getStrategyPda(VAULT, TRADER, PROGRAM).toBase58();
const CONDITIONAL_ORDERS = phoenixPda(Buffer.from("conditional_orders"), TRADER.toBuffer()).toBase58();
const SOL_SPLINE = phoenixPda(Buffer.from("spline"), SOL_BOOK.toBuffer()).toBase58();
/** The global trader index has one arena after its header, the active trader buffer none. */
const TAIL = [GLOBAL_TRADER_INDEX.toBase58(), phoenixPda(Buffer.from("global_trader_index"), Buffer.from([1])).toBase58(), ACTIVE_TRADER_BUFFER.toBase58()];

/** `recorded` holds mainnet accounts: the perp asset map, where asset 0 marks at 11684 ticks, and a trader long 3 lots of asset 0, short asset 1, flat in asset 2. */
const unpack = (packed: { data: string }) => gunzipSync(Buffer.from(packed.data, "base64"));

function traderIndexHeader(count: number) {
  const data = Buffer.alloc(56);
  data.writeUInt16LE(count, 52);
  data.writeUInt16LE(count + 1, 54);
  return data;
}

async function phoenixChain(o: { delegatePermissions?: number; trader?: boolean } = {}) {
  const accounts = await chain({ permissions: o.delegatePermissions ?? 4, expiresAt: 0 });
  const config = Buffer.alloc(776);
  Buffer.from([37, 146, 212, 210, 47, 136, 111, 20]).copy(config);
  for (const [offset, k] of [[296, CANONICAL], [328, GLOBAL_VAULT], [360, PERP_ASSET_MAP], [392, GLOBAL_TRADER_INDEX], [424, ACTIVE_TRADER_BUFFER], [472, WITHDRAW_QUEUE]] as const)
    k.toBuffer().copy(config, offset);
  accounts.set(PHOENIX_GLOBAL_CONFIG.toBase58(), info(PHOENIX, config));
  accounts.set(GLOBAL_TRADER_INDEX.toBase58(), info(PHOENIX, traderIndexHeader(2)));
  accounts.set(ACTIVE_TRADER_BUFFER.toBase58(), info(PHOENIX, traderIndexHeader(1)));
  accounts.set(PERP_ASSET_MAP.toBase58(), info(PHOENIX, unpack(recorded.perpAssetMap)));
  if (o.trader !== false) accounts.set(TRADER.toBase58(), info(PHOENIX, unpack(recorded.trader)));
  return accounts;
}

const market = (symbol: string, assetId: number, book: PublicKey) => ({
  symbol,
  assetId,
  marketPubkey: book.toBase58(),
  tickSize: 100,
  baseLotsDecimals: 2,
  takerFee: 0.0005,
  makerFee: 0,
  marketStatus: "active",
  isolatedOnly: false,
  metadata: { name: symbol, logoUri: null, displayColor: null, calendar: null },
  leverageTiers: [{ maxLeverage: 20 }],
  riskFactors: { maintenanceBps: 5000 },
});
const MARKETS = [market("SOL", 0, SOL_BOOK), market("BTC", 1, BTC_BOOK), market("ETH", 2, key(82))];

const usdc = (value: number) => ({ value, ui: (value / 1e6).toFixed(6) });
/** The fields of perp-api's `TraderView` the app reads. */
const TRADER_VIEW = {
  collateralBalance: usdc(81_515_585),
  effectiveCollateral: usdc(79_689_523),
  initialMargin: usdc(1_200_000),
  maintenanceMargin: usdc(600_000),
  withdrawableQuoteCollateral: usdc(78_000_000),
  riskState: "healthy",
  positions: [
    { symbol: "SOL", liquidationPrice: { value: 12.5, ui: "12.50" } },
    { symbol: "BTC", liquidationPrice: null },
  ],
  limitOrders: {
    SOL: [
      { price: { value: 116.5, ui: "116.50" }, side: "bid", orderSequenceNumber: "42", tradeSizeRemaining: { value: 0.5, ui: "0.50" }, isReduceOnly: false },
      { price: { value: 100, ui: "100.00" }, side: "ask", orderSequenceNumber: "43", tradeSizeRemaining: { value: 0.03, ui: "0.03" }, isReduceOnly: true, isStopLoss: true },
    ],
    DOGE: [{ price: { value: 0.2, ui: "0.20" }, side: "ask", orderSequenceNumber: "7", tradeSizeRemaining: { value: 10, ui: "10" }, isReduceOnly: false }],
  },
};

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

interface PhoenixCall {
  url: string;
  method: string;
  body: unknown;
}

/** Serves hand-written perp-api responses shaped like the app's types and records every request. */
function fakePhoenix(
  responses: { markets?: () => Response; trader?: () => Response; build?: () => Response; send?: (body: { transaction: string }) => Response } = {},
) {
  const calls: PhoenixCall[] = [];
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const url = String(input);
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
    calls.push({ url, method: init?.method ?? "GET", body });
    if (url.endsWith("/v1/view/exchange/markets")) return responses.markets?.() ?? json(MARKETS);
    if (url.endsWith(`/v1/view/trader/${TRADER.toBase58()}`)) return responses.trader?.() ?? json(TRADER_VIEW);
    if (url.endsWith("/v1/exchange/build-register-ixs")) return responses.build?.() ?? json(registerIxs());
    if (url.endsWith("/v1/exchange/send-register-ixs"))
      return responses.send?.(body) ?? json({ signature: signatureOf(Buffer.from(body.transaction, "base64")) });
    return new Response("not found", { status: 404 });
  };
  return { fetch, calls };
}

const marketsCall = { url: `${API}/v1/view/exchange/markets`, method: "GET", body: undefined };

const common = (authority = M, delegate = P) => ({
  authority,
  config: getConfigPda(PROGRAM).toBase58(),
  vault: V,
  strategy: STRATEGY,
  global_config: PHOENIX_GLOBAL_CONFIG.toBase58(),
  delegate,
});

const marketAccounts = (authority = M, delegate = P) => ({
  ...common(authority, delegate),
  trader_account: TRADER.toBase58(),
  perp_asset_map: PERP_ASSET_MAP.toBase58(),
  orderbook: SOL_BOOK.toBase58(),
  spline_collection: SOL_SPLINE,
  log_authority: LOG_AUTHORITY,
  phoenix_program: PHOENIX.toBase58(),
  hawkeye_program: HAWKEYE,
});

const marketOrder: DirectActionRequest = {
  action: "phoenix/order",
  vault: V,
  symbol: "SOL",
  side: "long",
  size: "0.5",
  reduceOnly: false,
  order: { type: "market", slippageBps: 100 },
};

const tpSlArgs = {
  assetId: 0,
  // A long closes by selling: take profit above the mark, stop loss below, each filling up to 2% under its trigger.
  greater: { tradeSide: { ask: {} }, kind: { ioc: {} }, triggerPriceInTicks: "13000", executionPriceInTicks: "12740" },
  less: { tradeSide: { ask: {} }, kind: { ioc: {} }, triggerPriceInTicks: "10000", executionPriceInTicks: "9800" },
  size: { percent: { "0": 100 } },
};

const conditionalAccounts = {
  ...common(),
  trader_account: TRADER.toBase58(),
  conditional_orders: CONDITIONAL_ORDERS,
  log_authority: LOG_AUTHORITY,
  phoenix_program: PHOENIX.toBase58(),
  system_program: SYSTEM,
};

describe("direct phoenix/order", () => {
  it("places a market order at the mark plus slippage and confirms", async () => {
    const phoenix = fakePhoenix();
    const { outcome, calls, txs } = await run(marketOrder, {}, manager, await phoenixChain(), { fetch: phoenix.fetch });
    expect(outcome).toEqual({ kind: "confirmed", signatures: [expect.any(String)] });
    expect(calls).toEqual(['send {"preflightCommitment":"confirmed"}', "status"]);
    expect(phoenix.calls).toEqual([marketsCall]);
    expect(txs).toEqual([
      {
        hedge: [
          {
            name: "phoenixPlaceMarketOrder",
            args: {
              params: {
                side: { bid: {} },
                // 0.5 SOL at 2 base-lot decimals; the mark 11684 ticks plus 1%, rounded up against the buyer.
                priceInTicks: "11801",
                numBaseLots: "50",
                numQuoteLots: null,
                minBaseLotsToFill: "50",
                minQuoteLotsToFill: "0",
                selfTradeBehavior: { abort: {} },
                matchLimit: null,
                clientOrderId: String(NOW_MS),
                lastValidSlot: null,
                reduceOnly: false,
                cancelExisting: false,
              },
            },
            accounts: marketAccounts(),
            remaining: TAIL,
          },
        ],
        payer: M,
        blockhash: expect.any(String),
        computeUnitLimit: 70_000,
        computeUnitPriceMicroLamports: 6_000n,
        programs: [COMPUTE_BUDGET.toBase58(), COMPUTE_BUDGET.toBase58(), "phoenixPlaceMarketOrder"],
        lookupTables: [],
      },
    ]);
  });

  it("places a limit short for a delegate with Phoenix permission", async () => {
    const request: DirectActionRequest = { ...marketOrder, side: "short", size: "1.25", order: { type: "limit", price: "120.5", postOnly: true } };
    const { outcome, ix } = await run(request, {}, delegateWallet, await phoenixChain(), { fetch: fakePhoenix().fetch });
    expect(outcome.kind).toBe("confirmed");
    expect(ix?.name).toBe("phoenixPlaceLimitOrder");
    expect(ix?.args).toEqual({
      params: {
        side: { ask: {} },
        priceInTicks: "12050",
        numBaseLots: "125",
        selfTradeBehavior: { cancelProvide: {} },
        matchLimit: null,
        clientOrderId: String(NOW_MS),
        lastValidSlot: null,
        reduceOnly: false,
        cancelExisting: false,
        postOnly: true,
        slide: false,
      },
    });
    expect(ix?.accounts).toEqual(marketAccounts(delegateWallet.publicKey.toBase58(), DELEGATE.toBase58()));
    expect(ix?.payer).toBe(delegateWallet.publicKey.toBase58());
  });

  it("arms a TP/SL on the position a market order opens, in the same transaction", async () => {
    const request: DirectActionRequest = { ...marketOrder, tpSl: { takeProfit: "130", stopLoss: "100" } };
    const { outcome, txs } = await run(request, {}, manager, await phoenixChain(), { fetch: fakePhoenix().fetch });
    expect(outcome.kind).toBe("confirmed");
    expect(txs[0]?.programs.slice(2)).toEqual(["phoenixPlaceMarketOrder", "phoenixCreateConditionalOrdersAccount", "phoenixPlacePositionConditionalOrder"]);
    expect(txs[0]?.hedge[1]?.args).toEqual({ capacity: 8 });
    expect(txs[0]?.hedge[2]?.args).toEqual({ order: tpSlArgs });
  });

  it("refuses a delegate without Phoenix permission before calling Phoenix", async () => {
    const phoenix = fakePhoenix();
    const { outcome, sent } = await run(marketOrder, {}, delegateWallet, await phoenixChain({ delegatePermissions: 1 }), { fetch: phoenix.fetch });
    expect(outcome).toEqual({ kind: "failed", signatures: [], code: "DelegatePermissionDenied", message: "This delegate cannot run Phoenix actions" });
    expect(phoenix.calls).toEqual([]);
    expect(sent).toEqual([]);
  });

  it("refuses a wallet that is neither authority nor delegate", async () => {
    const { outcome, sent } = await run(marketOrder, {}, stranger, await phoenixChain(), { fetch: fakePhoenix().fetch });
    expect(outcome).toEqual({ kind: "failed", signatures: [], code: "Forbidden", message: "Connected wallet is not the vault authority or one of its delegates" });
    expect(sent).toEqual([]);
  });

  it("rejects an unknown market before sending", async () => {
    const { outcome, sent } = await run({ ...marketOrder, symbol: "DOGE" }, {}, manager, await phoenixChain(), { fetch: fakePhoenix().fetch });
    expect(outcome).toEqual({ kind: "failed", signatures: [], code: "Validation", message: "Unknown Phoenix market DOGE" });
    expect(sent).toEqual([]);
  });

  it("rejects TP/SL on a limit order before any read", async () => {
    const phoenix = fakePhoenix();
    const request: DirectActionRequest = { ...marketOrder, order: { type: "limit", price: "120", postOnly: false }, tpSl: { takeProfit: "130", stopLoss: null } };
    const { outcome } = await run(request, {}, manager, await phoenixChain(), { fetch: phoenix.fetch });
    expect(outcome).toEqual({
      kind: "failed",
      signatures: [],
      code: "Validation",
      message: "tpSl: only a market order can carry TP/SL; set it from the TP/SL panel once the limit fills",
    });
    expect(phoenix.calls).toEqual([]);
  });

  it.each([
    { failure: "a markets 500", markets: () => new Response("upstream down", { status: 500 }), code: "PhoenixUnavailable", message: "Phoenix is unavailable right now (/v1/view/exchange/markets returned 500). Try again shortly." },
    { failure: "malformed markets JSON", markets: () => new Response("{", { status: 200 }), code: "PhoenixBadResponse", message: "Phoenix returned a response that is not JSON (/v1/view/exchange/markets)" },
    {
      failure: "a market row without its orderbook",
      markets: () => json([{ ...market("SOL", 0, SOL_BOOK), marketPubkey: undefined }]),
      code: "PhoenixBadResponse",
      message: "Phoenix returned an unexpected response (/v1/view/exchange/markets)",
    },
  ])("fails the build on $failure and sends nothing", async ({ markets, code, message }) => {
    const { outcome, sent } = await run(marketOrder, {}, manager, await phoenixChain(), { fetch: fakePhoenix({ markets }).fetch });
    expect(outcome).toEqual({ kind: "failed", signatures: [], code, message });
    expect(sent).toEqual([]);
  });

  it("asks the configured perp-api host", async () => {
    const phoenix = fakePhoenix();
    await run(marketOrder, {}, manager, await phoenixChain(), { fetch: phoenix.fetch, phoenixApiUrl: "https://phoenix.example" });
    expect(phoenix.calls.map((c) => c.url)).toEqual(["https://phoenix.example/v1/view/exchange/markets"]);
  });
});

describe("direct phoenix collateral and strategy", () => {
  const collateral = {
    ...common(),
    usdc_mint: USDC.toBase58(),
    canonical_mint: CANONICAL.toBase58(),
    vault_usdc_token_account: ata(VAULT, USDC, TOKEN_PROGRAM),
    vault_canonical_token_account: ata(VAULT, CANONICAL, TOKEN_PROGRAM),
    trader_account: TRADER.toBase58(),
    ember_state: EMBER_STATE,
    ember_vault: EMBER_VAULT,
    global_vault: GLOBAL_VAULT.toBase58(),
    log_authority: LOG_AUTHORITY,
    phoenix_program: PHOENIX.toBase58(),
    ember_program: EMBER_PROGRAM,
    token_program: TOKEN_PROGRAM.toBase58(),
  };

  it("deposits USDC base units as collateral", async () => {
    const { outcome, ix } = await run({ action: "phoenix/deposit", vault: V, amount: "25000000" }, {}, manager, await phoenixChain());
    expect(outcome.kind).toBe("confirmed");
    expect(ix).toMatchObject({ name: "phoenixDepositFunds", args: { amount: "25000000" }, accounts: collateral, remaining: TAIL });
  });

  it("withdraws collateral through the withdraw queue", async () => {
    const { ix } = await run({ action: "phoenix/withdraw", vault: V, amount: "18446744073709551615" }, {}, manager, await phoenixChain());
    expect(ix).toMatchObject({
      name: "phoenixWithdrawFunds",
      args: { amount: "18446744073709551615" },
      accounts: { ...collateral, perp_asset_map: PERP_ASSET_MAP.toBase58(), withdraw_queue: WITHDRAW_QUEUE.toBase58() },
      remaining: TAIL,
    });
  });

  it("rejects an amount beyond u64 before any read", async () => {
    const { outcome } = await run({ action: "phoenix/deposit", vault: V, amount: "18446744073709551616" }, {}, manager, await phoenixChain());
    expect(outcome).toEqual({ kind: "failed", signatures: [], code: "Validation", message: "amount: must fit in u64" });
  });

  it("initializes the strategy on the vault's trader with no tail", async () => {
    const { ix } = await run({ action: "phoenix/initialize", vault: V }, {}, manager, await phoenixChain({ trader: false }));
    expect(ix).toMatchObject({
      name: "phoenixInitializeStrategy",
      args: {},
      accounts: {
        ...common(),
        trader_account: TRADER.toBase58(),
        canonical_mint: CANONICAL.toBase58(),
        vault_canonical_token_account: ata(VAULT, CANONICAL, TOKEN_PROGRAM),
        log_authority: LOG_AUTHORITY,
        phoenix_program: PHOENIX.toBase58(),
        token_program: TOKEN_PROGRAM.toBase58(),
        associated_token_program: ATA_PROGRAM,
        system_program: SYSTEM,
      },
      remaining: [],
    });
  });

  it("sweeps delivered canonical tokens back to USDC", async () => {
    const { ix } = await run({ action: "phoenix/sweep", vault: V }, {}, manager, await phoenixChain());
    const { trader_account: _t, ember_state, ember_vault, global_vault: _g, log_authority: _l, phoenix_program: _p, ...rest } = collateral;
    expect(ix).toMatchObject({ name: "phoenixEmberWithdraw", args: {}, accounts: { ...rest, ember_state, ember_vault }, remaining: [] });
  });
});

describe("direct phoenix/tpsl and phoenix/cancel", () => {
  it("creates the conditional orders account and arms both legs on the open long", async () => {
    const request: DirectActionRequest = { action: "phoenix/tpsl", vault: V, symbol: "SOL", takeProfit: "130", stopLoss: "100" };
    const { outcome, txs } = await run(request, {}, manager, await phoenixChain(), { fetch: fakePhoenix().fetch });
    expect(outcome.kind).toBe("confirmed");
    expect(txs[0]?.hedge).toEqual([
      { name: "phoenixCreateConditionalOrdersAccount", args: { capacity: 8 }, accounts: conditionalAccounts, remaining: [] },
      {
        name: "phoenixPlacePositionConditionalOrder",
        args: { order: tpSlArgs },
        accounts: {
          ...conditionalAccounts,
          perp_asset_map: PERP_ASSET_MAP.toBase58(),
          orderbook: SOL_BOOK.toBase58(),
          spline_collection: SOL_SPLINE,
        },
        remaining: TAIL,
      },
    ]);
  });

  it("refuses a stop loss above the mark of a long", async () => {
    const request: DirectActionRequest = { action: "phoenix/tpsl", vault: V, symbol: "SOL", takeProfit: null, stopLoss: "120" };
    const { outcome, sent } = await run(request, {}, manager, await phoenixChain(), { fetch: fakePhoenix().fetch });
    expect(outcome).toEqual({ kind: "failed", signatures: [], code: "Validation", message: "stopLoss: must be below the mark price for a long" });
    expect(sent).toEqual([]);
  });

  it("refuses a TP/SL on a market with no position", async () => {
    const request: DirectActionRequest = { action: "phoenix/tpsl", vault: V, symbol: "ETH", takeProfit: "4000", stopLoss: null };
    const { outcome } = await run(request, {}, manager, await phoenixChain(), { fetch: fakePhoenix().fetch });
    expect(outcome).toEqual({ kind: "failed", signatures: [], code: "Validation", message: "symbol: no open position in this market" });
  });

  it("cancels listed orders by price and sequence number", async () => {
    const request: DirectActionRequest = { action: "phoenix/cancel", vault: V, symbol: "SOL", orders: [{ priceInTicks: "12050", orderSequenceNumber: "42" }] };
    const { ix } = await run(request, {}, manager, await phoenixChain(), { fetch: fakePhoenix().fetch });
    const { hawkeye_program: _h, ...accounts } = marketAccounts();
    expect(ix).toMatchObject({
      name: "phoenixCancelOrders",
      args: { mode: { byId: { orders: [{ nodePointer: 0, priceInTicks: "12050", orderSequenceNumber: "42" }] } } },
      accounts,
      remaining: TAIL,
    });
  });

  it("cancels every order on the market", async () => {
    const { ix } = await run({ action: "phoenix/cancel", vault: V, symbol: "SOL", orders: "all" }, {}, manager, await phoenixChain(), { fetch: fakePhoenix().fetch });
    expect(ix?.args).toEqual({ mode: { all: {} } });
  });
});

const meta = (pubkey: PublicKey, isSigner = false, isWritable = false) => ({ pubkey: pubkey.toBase58(), isSigner, isWritable });

/** Phoenix's `RegisterTrader` and `OnboardTraderDelegated`, paid by `payer`; its onboarder signs after the manager. */
const registerIxs = (payer = manager.publicKey, extra: object[] = []) => ({
  instructions: [
    { programId: PHOENIX.toBase58(), data: [1, 2, 3], keys: [meta(payer, true, true), meta(TRADER, false, true), meta(VAULT), meta(SystemProgram.programId)] },
    { programId: PHOENIX.toBase58(), data: [4, 5], keys: [meta(ONBOARDER, true), meta(TRADER, false, true)] },
    ...extra,
  ],
});

async function onboard(accounts: Map<string, AccountInfo<Buffer>>, phoenix: ReturnType<typeof fakePhoenix>, signer = manager) {
  const rpc = fakeConnection(accounts);
  const outcome = await createDirectClient({ connection: rpc.connection, fetch: phoenix.fetch }).onboardPhoenix(V, keypairSigner(signer), clock());
  return { outcome, rpc };
}

const register = { traderAuthority: V, txFeePayer: M, maxPositions: 128 };

describe("direct onboardPhoenix", () => {
  it("signs Phoenix's registration, submits it to Phoenix rather than RPC, and confirms on chain", async () => {
    const phoenix = fakePhoenix();
    const { outcome, rpc } = await onboard(await phoenixChain({ trader: false }), phoenix);
    expect(outcome).toEqual({ kind: "confirmed", signatures: [expect.any(String)] });
    expect(rpc.sent).toEqual([]);
    expect(rpc.calls).toEqual(["status"]);
    expect(phoenix.calls).toEqual([
      { url: `${API}/v1/exchange/build-register-ixs`, method: "POST", body: register },
      {
        url: `${API}/v1/exchange/send-register-ixs`,
        method: "POST",
        body: { transaction: expect.any(String), ...register, traderPdaIndex: 0, traderSubaccountIndex: 0 },
      },
    ]);
    const submitted = phoenix.calls[1]?.body as { transaction: string };
    const tx = VersionedTransaction.deserialize(Buffer.from(submitted.transaction, "base64"));
    expect(tx.message.staticAccountKeys.slice(0, 2).map((k) => k.toBase58())).toEqual([M, ONBOARDER.toBase58()]);
    expect(tx.message.compiledInstructions.map((ix) => Buffer.from(ix.data).toJSON().data)).toEqual([[1, 2, 3], [4, 5]]);
    expect(tx.signatures[1]?.every((b) => b === 0)).toBe(true);
    expect(outcome.signatures).toEqual([signatureOf(Buffer.from(submitted.transaction, "base64"))]);
  });

  it("refuses a registration that also calls another program, before signing or submitting", async () => {
    const phoenix = fakePhoenix({ build: () => json(registerIxs(manager.publicKey, [{ programId: SYSTEM, data: [2, 0, 0, 0], keys: [meta(manager.publicKey, true, true)] }])) });
    const { outcome, rpc } = await onboard(await phoenixChain({ trader: false }), phoenix);
    expect(outcome).toEqual({ kind: "refused", signatures: [], reason: `Unexpected program ${SYSTEM}` });
    expect(phoenix.calls.map((c) => c.url)).toEqual([`${API}/v1/exchange/build-register-ixs`]);
    expect(rpc.sent).toEqual([]);
  });

  it("refuses an already onboarded trader without asking Phoenix", async () => {
    const phoenix = fakePhoenix();
    const { outcome } = await onboard(await phoenixChain(), phoenix);
    expect(outcome).toEqual({ kind: "failed", signatures: [], code: "PhoenixAlreadyOnboarded", message: "The vault's Phoenix trader is already onboarded" });
    expect(phoenix.calls).toEqual([]);
  });

  it("refuses a delegate without Phoenix permission", async () => {
    const phoenix = fakePhoenix();
    const { outcome } = await onboard(await phoenixChain({ delegatePermissions: 1, trader: false }), phoenix, delegateWallet);
    expect(outcome).toEqual({ kind: "failed", signatures: [], code: "DelegatePermissionDenied", message: "This delegate cannot run Phoenix actions" });
    expect(phoenix.calls).toEqual([]);
  });

  it("reports Phoenix's 4xx on submit as a failure", async () => {
    const phoenix = fakePhoenix({ send: () => new Response("bad signature", { status: 400 }) });
    const { outcome } = await onboard(await phoenixChain({ trader: false }), phoenix);
    expect(outcome).toEqual({ kind: "failed", signatures: [], code: "PhoenixRejected", message: "Phoenix rejected the onboarding transaction (400)" });
  });

  it("settles a submit whose reply was lost through the chain, never resubmitting", async () => {
    const phoenix = fakePhoenix({ send: () => new Response("gateway timeout", { status: 504 }) });
    const { outcome, rpc } = await onboard(await phoenixChain({ trader: false }), phoenix);
    expect(outcome).toEqual({ kind: "confirmed", signatures: [expect.any(String)] });
    expect(phoenix.calls.filter((c) => c.url.endsWith("/send-register-ixs"))).toHaveLength(1);
    expect(rpc.calls).toEqual(["status"]);
  });

  it("fails the build on a Phoenix 500 with nothing signed", async () => {
    const phoenix = fakePhoenix({ build: () => new Response("", { status: 500 }) });
    const { outcome, rpc } = await onboard(await phoenixChain({ trader: false }), phoenix);
    expect(outcome).toEqual({
      kind: "failed",
      signatures: [],
      code: "PhoenixUnavailable",
      message: "Phoenix is unavailable right now (/v1/exchange/build-register-ixs returned 500). Try again shortly.",
    });
    expect(rpc.sent).toEqual([]);
  });
});

describe("direct getPhoenix", () => {
  const strategyChain = async (o: { trader?: boolean } = {}) => {
    const accounts = await phoenixChain(o);
    accounts.set(STRATEGY, info(PROGRAM, await encodeAccount("strategy", { vault: VAULT, strategyType: { phoenixPerp: { traderAccount: TRADER } } })));
    return accounts;
  };
  const read = async (accounts: Map<string, AccountInfo<Buffer>>, phoenix: ReturnType<typeof fakePhoenix>) =>
    createDirectClient({ connection: fakeConnection(accounts).connection, fetch: phoenix.fetch }).getPhoenix(V);
  const marketView = (symbol: string, markPrice: string) => ({ symbol, name: symbol, category: "crypto", maxLeverage: 20, markPrice, tickSize: 100, baseLotsDecimals: 2, takerFee: 0.0005, makerFee: 0 });
  const MARKET_VIEWS = [marketView("BTC", "85428"), marketView("ETH", "2719.4"), marketView("SOL", "116.84")];

  it("reads an onboarded trader's markets, orders and margin", async () => {
    const phoenix = fakePhoenix();
    expect(await read(await strategyChain(), phoenix)).toEqual({
      status: "ready",
      usdcVault: true,
      traderAccount: TRADER.toBase58(),
      markets: MARKET_VIEWS,
      // The stop loss and the order in an unlisted market are left out.
      openOrders: [{ symbol: "SOL", side: "long", price: "116.50", size: "0.50", priceInTicks: "11650", orderSequenceNumber: "42", reduceOnly: false }],
      withdrawable: "78000000",
      account: {
        collateral: "81515585",
        equity: "79689523",
        initialMargin: "1200000",
        maintenanceMargin: "600000",
        withdrawable: "78000000",
        riskState: "healthy",
        liquidationPrices: { SOL: "12.50" },
      },
      tpSl: [],
    });
    expect(phoenix.calls.map((c) => c.url)).toEqual([`${API}/v1/view/exchange/markets`, `${API}/v1/view/trader/${TRADER.toBase58()}`]);
  });

  it("reports a registered trader without asking for its view", async () => {
    const phoenix = fakePhoenix();
    const view = await read(await strategyChain({ trader: false }), phoenix);
    expect(view).toMatchObject({ status: "registered", openOrders: [], withdrawable: "0", account: null });
    expect(phoenix.calls.map((c) => c.url)).toEqual([`${API}/v1/view/exchange/markets`]);
  });

  it("reports no strategy", async () => {
    expect(await read(await phoenixChain({ trader: false }), fakePhoenix())).toMatchObject({ status: "none", markets: MARKET_VIEWS });
  });

  it("marks perp-api data unavailable instead of failing on a 500 or a malformed body", async () => {
    const phoenix = fakePhoenix({ markets: () => new Response("{", { status: 200 }), trader: () => new Response("", { status: 500 }) });
    expect(await read(await strategyChain(), phoenix)).toMatchObject({ status: "ready", markets: [], openOrders: null, withdrawable: null, account: null });
  });
});
