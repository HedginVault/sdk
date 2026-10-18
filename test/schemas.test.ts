import { describe, expect, it } from "vitest";
import { NavHistoryPointSchema, PhoenixManagerSchema, RequestQueueSchema, StrategyHistoryItemSchema, StrategyListSchema, StrategySchema, VaultDetailSchema } from "../src/schemas";
import { navHistory, phoenixView, requestQueue, strategies, strategyHistory, vaultDetail } from "./fixtures";

const viaJson = (value: unknown): unknown => JSON.parse(JSON.stringify(value));

describe("read schemas", () => {
  it("parses the app's vault detail and drops display-only fields", () => {
    const fromApp = { ...vaultDetail, depositLogo: null, depositPriceUsd: 1, metadata: null };
    expect(VaultDetailSchema.parse(viaJson(fromApp))).toEqual(vaultDetail);
  });

  it("rejects a vault detail with a numeric amount", () => {
    expect(VaultDetailSchema.safeParse({ ...vaultDetail, idleBalance: 1000000 }).success).toBe(false);
    expect(VaultDetailSchema.safeParse({ ...vaultDetail, status: "active" }).success).toBe(false);
  });

  it("accepts omitted unmanaged holdings but rejects malformed entries and null", () => {
    const { unmanagedHoldings, ...withoutUnmanagedHoldings } = vaultDetail;
    const fromApp = { ...withoutUnmanagedHoldings, depositLogo: null, depositPriceUsd: 1, metadata: null };
    const parsed = VaultDetailSchema.parse(viaJson(fromApp));
    expect(parsed).toEqual(withoutUnmanagedHoldings);
    expect(parsed.unmanagedHoldings).toBeUndefined();
    expect(VaultDetailSchema.parse(viaJson(vaultDetail)).unmanagedHoldings).toEqual(unmanagedHoldings);
    expect(VaultDetailSchema.safeParse({
      ...fromApp,
      unmanagedHoldings: [{ token: { mint: "SOL", symbol: "SOL", decimals: 9 }, amount: "0.5" }],
    }).success).toBe(false);
    expect(VaultDetailSchema.safeParse({ ...fromApp, unmanagedHoldings: null }).success).toBe(false);
  });

  it("parses NAV history with a null timestamp and rejects a decimal NAV", () => {
    expect(NavHistoryPointSchema.array().parse(viaJson(navHistory))).toEqual(navHistory);
    expect(NavHistoryPointSchema.safeParse({ ...navHistory[0], navPerShare: "1.02" }).success).toBe(false);
  });

  it("parses the request queue and rejects an unknown request state", () => {
    expect(RequestQueueSchema.parse(viaJson(requestQueue))).toEqual(requestQueue);
    const bad = { ...requestQueue, deposits: [{ ...requestQueue.deposits[0], state: "settled" }] };
    expect(RequestQueueSchema.safeParse(bad).success).toBe(false);
  });

  it("parses strategy history with a realized loss and rejects a fractional one", () => {
    expect(StrategyHistoryItemSchema.array().parse(viaJson(strategyHistory))).toEqual(strategyHistory);
    const [item] = strategyHistory;
    const [token] = item?.tokens ?? [];
    expect(StrategyHistoryItemSchema.safeParse({ ...item, tokens: [{ ...token, realizedPnl: "-0.5" }] }).success).toBe(false);
  });

  it("parses the Phoenix view, including Phoenix being unavailable", () => {
    expect(PhoenixManagerSchema.parse(viaJson(phoenixView))).toEqual(phoenixView);
    const unavailable = { ...phoenixView, openOrders: null, withdrawable: null, account: null };
    expect(PhoenixManagerSchema.parse(unavailable)).toEqual(unavailable);
  });

  it("rejects a Phoenix order id that a cancel could not use", () => {
    const bad = { ...phoenixView, openOrders: [{ ...phoenixView.openOrders?.[0], orderSequenceNumber: "abc" }] };
    expect(PhoenixManagerSchema.safeParse(bad).success).toBe(false);
  });

  it("keeps a DLMM position's bins and rejects a fractional bin amount", () => {
    const dlmm = strategies.find((s) => s.type === "dlmm");
    const withBins = { ...dlmm, lowerBinId: -2, upperBinId: 3, activeBinId: 0, binStep: 10, bins: [{ binId: 1, amountX: "5", amountY: "0" }] };
    expect(StrategySchema.parse(viaJson(withBins))).toEqual(withBins);
    expect(StrategySchema.safeParse({ ...withBins, bins: [{ binId: 1, amountX: "0.5", amountY: "0" }] }).success).toBe(false);
  });

  it("parses a limit order as the app returns it, display-only fields dropped", () => {
    const order = strategies.find((s) => s.type === "dlmm_limit_order");
    const fromApp = { ...order, id: 3, createdTs: 1_760_000_000, lastActionTs: 1_760_000_100 };
    expect(StrategySchema.parse(viaJson(fromApp))).toEqual({ ...order, createdTs: 1_760_000_000 });
    expect(StrategySchema.safeParse({ ...order, side: "buy" }).success).toBe(false);
  });

  it("reports a strategy type this SDK does not know as unreadable instead of failing the list", () => {
    const future = { type: "orca_whirlpool", address: "Strat6", whirlpool: "W1" };
    expect(StrategyListSchema.parse(viaJson([...strategies, future]))).toEqual([
      ...strategies,
      { type: "unreadable", address: "Strat6", protocol: "orca_whirlpool", reason: "Not supported by this SDK version; upgrade @hedginxyz/sdk" },
    ]);
    const brokenKnown = { ...strategies[0], vaultBalance: 1 };
    expect(StrategyListSchema.safeParse([brokenKnown]).success).toBe(false);
  });

  it("parses closed limit orders in strategy history, and an unknown type as null", () => {
    const [item] = strategyHistory;
    expect(StrategyHistoryItemSchema.parse({ ...item, type: "dlmm_limit_order" }).type).toBe("dlmm_limit_order");
    expect(StrategyHistoryItemSchema.parse({ ...item, type: "orca_whirlpool" }).type).toBeNull();
  });

  it("keeps armed Phoenix TP/SL brackets", () => {
    const tpSl = [{ symbol: "SOL", index: 0, greaterPrice: "180", lessPrice: null, closes: "long" }];
    expect(PhoenixManagerSchema.parse({ ...phoenixView, tpSl }).tpSl).toEqual(tpSl);
    expect(PhoenixManagerSchema.parse(phoenixView).tpSl).toBeUndefined();
  });
});
