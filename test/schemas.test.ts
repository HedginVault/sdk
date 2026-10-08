import { describe, expect, it } from "vitest";
import { NavHistoryPointSchema, PhoenixManagerSchema, RequestQueueSchema, StrategyHistoryItemSchema, VaultDetailSchema } from "../src/schemas";
import { navHistory, phoenixView, requestQueue, strategyHistory, vaultDetail } from "./fixtures";

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
});
