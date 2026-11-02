import { type AccountInfo, PublicKey } from "@solana/web3.js";
import { z } from "zod";
import { getStrategyPda } from "../chain/pda";
import { decodeVault } from "../chain/reads";
import type { PhoenixManager } from "../schemas";
import type { BuildEnv } from "./context";
import {
  decodeConditionalOrders,
  decodeMarks,
  getPhoenixConditionalOrdersAddress,
  getPhoenixTraderAddress,
  isTraderReady,
  type PhoenixMark,
  readGlobalConfig,
  USDC_MINT,
} from "./phoenix-accounts";
import { loadRise, type Rise } from "./rise";

// Ported from the app's `server/readers/phoenix-manager.ts`; keep the two in step.

type ReadEnv = Pick<BuildEnv, "connection" | "programId" | "program" | "fetch" | "phoenixApiUrl">;

const MarketRowSchema = z.object({
  symbol: z.string(),
  assetId: z.number().int().nonnegative(),
  tickSize: z.number().int().positive(),
  baseLotsDecimals: z.number().int(),
  takerFee: z.number(),
  makerFee: z.number(),
  marketStatus: z.string(),
  isolatedOnly: z.boolean(),
  metadata: z.object({ name: z.string().nullish(), calendar: z.object({ id: z.string().nullish() }).nullish() }).nullish(),
  leverageTiers: z.array(z.object({ maxLeverage: z.number() })).nullish(),
});
type MarketRow = z.infer<typeof MarketRowSchema>;

/** Phoenix reports USDC amounts as whole base units in a JSON number. */
const amount = z.object({ value: z.number().int(), ui: z.string() });
/** A price or size: a float with its display string. */
const display = z.object({ value: z.number(), ui: z.string() });
const TraderViewSchema = z.object({
  collateralBalance: amount,
  effectiveCollateral: amount,
  initialMargin: amount,
  maintenanceMargin: amount,
  withdrawableQuoteCollateral: amount,
  riskState: z.string(),
  positions: z.array(z.object({ symbol: z.string(), liquidationPrice: display.nullable() })),
  limitOrders: z.record(
    z.array(
      z.object({
        price: display,
        side: z.enum(["bid", "ask"]),
        orderSequenceNumber: z.string().regex(/^\d+$/),
        tradeSizeRemaining: display,
        isReduceOnly: z.boolean(),
        isStopLoss: z.boolean().optional(),
        isConditionalOrder: z.boolean().optional(),
      }),
    ),
  ),
});
type TraderView = z.infer<typeof TraderViewSchema>;

/** One perp-api GET; any failure is `null`, which the view reports as Phoenix being unavailable. */
async function getOrNull<T extends z.ZodTypeAny>(env: ReadEnv, path: string, schema: T): Promise<z.infer<T> | null> {
  try {
    const res = await env.fetch(`${env.phoenixApiUrl}${path}`, { signal: AbortSignal.timeout(5_000) });
    if (!res.ok) return null;
    const parsed = schema.safeParse(await res.json());
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

const pow10 = (n: number) => 10n ** BigInt(n);

/** `raw × 10^-decimals` as an exact decimal string, trailing zeros trimmed; `decimals` may be negative. */
function scaleDecimal(raw: bigint, decimals: number): string {
  if (decimals <= 0) return (raw * pow10(-decimals)).toString();
  const digits = (raw < 0n ? -raw : raw).toString().padStart(decimals + 1, "0");
  const frac = digits.slice(-decimals).replace(/0+$/, "");
  return `${raw < 0n ? "-" : ""}${digits.slice(0, -decimals)}${frac ? `.${frac}` : ""}`;
}

/** Ticks as USD per base unit: quote lots per base lot (ticks × tick size) × 10^(baseLotDecimals − 6). */
const ticksToUsd = (ticks: bigint, m: PhoenixMark) => scaleDecimal(ticks * m.tickSize, 6 - m.baseLotDecimals);

/** Asset class from the market's trading-hours calendar; crypto markets trade around the clock and carry none. */
const marketCategory = (calendarId: string | null | undefined) =>
  calendarId?.includes("commodit") ? "commodities" : calendarId?.includes("equit") ? "equities" : "crypto";

/** Tradable markets with their live mark; isolated-only and inactive markets are left out. */
const toMarketViews = (rows: MarketRow[], marks: Map<number, PhoenixMark>): PhoenixManager["markets"] =>
  rows
    .filter((m) => m.marketStatus === "active" && !m.isolatedOnly)
    .map((m) => {
      const mark = marks.get(m.assetId);
      return {
        symbol: m.symbol,
        name: m.metadata?.name ?? m.symbol,
        category: marketCategory(m.metadata?.calendar?.id),
        maxLeverage: m.leverageTiers?.[0]?.maxLeverage ?? 1,
        markPrice: mark ? ticksToUsd(mark.markTicks, mark) : "0",
        tickSize: m.tickSize,
        baseLotsDecimals: m.baseLotsDecimals,
        takerFee: m.takerFee,
        makerFee: m.makerFee,
      };
    })
    .sort((a, b) => a.symbol.localeCompare(b.symbol));

/** Resting limit orders with the tick price a by-id cancel needs. Stop-loss and conditional orders are left out: the program's cancel does not reach them. */
function toOpenOrders(rise: Rise, trader: TraderView, rows: MarketRow[]): PhoenixManager["openOrders"] {
  const bySymbol = new Map(rows.map((m) => [m.symbol, m]));
  return Object.entries(trader.limitOrders).flatMap(([symbol, orders]) => {
    const market = bySymbol.get(symbol);
    if (!market) return [];
    return orders
      .filter((o) => !o.isStopLoss && !o.isConditionalOrder)
      .map((o) => ({
        symbol,
        side: o.side === "bid" ? ("long" as const) : ("short" as const),
        price: o.price.ui,
        size: o.tradeSizeRemaining.ui,
        priceInTicks: BigInt(rise.priceUsdToTicksWithMarketParams(o.price.ui, market)).toString(),
        orderSequenceNumber: o.orderSequenceNumber,
        reduceOnly: o.isReduceOnly,
      }));
  });
}

const toAccountView = (t: TraderView): NonNullable<PhoenixManager["account"]> => ({
  collateral: String(t.collateralBalance.value),
  equity: String(t.effectiveCollateral.value),
  initialMargin: String(t.initialMargin.value),
  maintenanceMargin: String(t.maintenanceMargin.value),
  withdrawable: String(t.withdrawableQuoteCollateral.value),
  riskState: t.riskState,
  liquidationPrices: Object.fromEntries(t.positions.flatMap((p) => (p.liquidationPrice && Number(p.liquidationPrice.ui) > 0 ? [[p.symbol, p.liquidationPrice.ui]] : []))),
});

/** 3 RPC plus up to two perp-api calls, as `HedgeClient.getPhoenix` returns it. */
export async function readPhoenix(env: ReadEnv, address: string): Promise<PhoenixManager> {
  const vault = new PublicKey(address);
  const account = decodeVault({ programId: env.programId, coder: env.program.coder.accounts }, await env.connection.getAccountInfo(vault));
  const trader = getPhoenixTraderAddress(vault);
  const conditionalOrders = getPhoenixConditionalOrdersAddress(trader);
  const [{ perpAssetMap }, rows] = await Promise.all([readGlobalConfig(env), getOrNull(env, "/v1/view/exchange/markets", z.array(MarketRowSchema))]);
  const [[strategyInfo, traderInfo, mapInfo, conditionalInfo], rise] = await Promise.all([
    env.connection.getMultipleAccountsInfo([getStrategyPda(vault, trader, env.programId), trader, perpAssetMap, conditionalOrders]),
    loadRise(),
  ]);
  const marks = mapInfo ? decodeMarks(rise, perpAssetMap, mapInfo) : new Map<number, PhoenixMark>();
  const status = !strategyInfo ? "none" : traderInfo && isTraderReady(traderInfo) ? "ready" : "registered";
  const view = status === "ready" ? await getOrNull(env, `/v1/view/trader/${trader.toBase58()}`, TraderViewSchema) : null;
  const markets = rows ?? [];
  return {
    status,
    usdcVault: account.depositMint.equals(USDC_MINT),
    traderAccount: trader.toBase58(),
    markets: toMarketViews(markets, marks),
    openOrders: status !== "ready" ? [] : view ? toOpenOrders(rise, view, markets) : null,
    withdrawable: status !== "ready" ? "0" : view ? String(view.withdrawableQuoteCollateral.value) : null,
    account: view ? toAccountView(view) : null,
    tpSl: readTpSl(rise, conditionalOrders, conditionalInfo ?? null, markets, marks),
  };
}

/** Armed TP/SL slots priced in USD; null when the account exists but cannot be decoded. */
function readTpSl(rise: Rise, key: PublicKey, info: AccountInfo<Buffer> | null, rows: MarketRow[], marks: Map<number, PhoenixMark>): PhoenixManager["tpSl"] {
  if (!info) return [];
  let orders;
  try {
    orders = decodeConditionalOrders(rise, key, info);
  } catch {
    return null;
  }
  const symbols = new Map(rows.map((m) => [m.assetId, m.symbol]));
  return orders.flatMap((o) => {
    const mark = marks.get(o.assetId);
    const closes = (o.greater ?? o.less)?.closes;
    if (!mark || !closes) return [];
    return [
      {
        symbol: symbols.get(o.assetId) ?? `Asset #${o.assetId}`,
        index: o.index,
        greaterPrice: o.greater ? ticksToUsd(o.greater.triggerTicks, mark) : null,
        lessPrice: o.less ? ticksToUsd(o.less.triggerTicks, mark) : null,
        closes,
      },
    ];
  });
}
