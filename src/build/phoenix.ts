import { BN } from "@coral-xyz/anchor";
import { PublicKey } from "@solana/web3.js";
import { z } from "zod";
import { getAssociatedTokenAddress, getConfigPda, getStrategyPda } from "../chain/pda";
import { ApiError } from "../errors";
import { assemble, type Assembled } from "./assemble";
import { amountString, assertOperator, type BuildEnv, DELEGATE_PHOENIX, delegateFor, loadVaultCtx, pubkey } from "./context";
import {
  getPhoenixConditionalOrdersAddress,
  getPhoenixSplineAddress,
  getPhoenixTraderAddress,
  loadMarkTicks,
  loadPhoenixExchange,
  loadTpSlState,
  type PhoenixConditionalOrder,
  type PhoenixExchange,
  readCanonicalMint,
  type TpSlState,
  USDC_MINT,
} from "./phoenix-accounts";
import { type PhoenixMarket, resolvePhoenixMarket } from "./phoenix-api";
import { loadRise, type Rise } from "./rise";

// Ported from the app's `server/tx/phoenix.ts` and its `api/tx/phoenix/*` routes; keep them in step.

const TOKEN_PROGRAM_ID = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
/** Slots of a new conditional orders account (slot 0 is never used); Phoenix grows a full one at the payer's expense. */
const TPSL_CAPACITY = 8;
/** How far past its trigger a TP/SL may fill, against the trader. */
const TPSL_SLIPPAGE_BPS = 200n;

const symbol = z.string().min(1).max(32);
/** A non-negative decimal with up to 12 fractional digits, like "0.5" or "150.25". */
const decimalString = z.string().regex(/^\d{1,15}(\.\d{1,12})?$/, "must be a decimal number");

export const phoenixVaultInput = z.object({ vault: pubkey });
export const phoenixAmountInput = phoenixVaultInput.extend({ amount: amountString });

export const phoenixOrderInput = phoenixVaultInput
  .extend({
    symbol,
    side: z.enum(["long", "short"]),
    size: decimalString,
    reduceOnly: z.boolean(),
    disarmTpSl: z.boolean().optional(),
    tpSl: z
      .object({ takeProfit: decimalString.nullable(), stopLoss: decimalString.nullable() })
      .refine((t) => t.takeProfit !== null || t.stopLoss !== null, "set takeProfit or stopLoss")
      .optional(),
    order: z.discriminatedUnion("type", [
      z.object({ type: z.literal("market"), slippageBps: z.number().int().min(1).max(2_000) }),
      z.object({ type: z.literal("limit"), price: decimalString, postOnly: z.boolean() }),
    ]),
  })
  .superRefine((b, ctx) => {
    if (!b.tpSl) return;
    const reject = (message: string) => ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["tpSl"], message });
    if (b.order.type === "limit") reject("only a market order can carry TP/SL; set it from the TP/SL panel once the limit fills");
    else if (b.reduceOnly) reject("a reduce-only order cannot carry TP/SL");
    else if (b.disarmTpSl) reject("cannot be combined with disarmTpSl");
  });

export const phoenixTpSlInput = phoenixVaultInput.extend({ symbol, takeProfit: decimalString.nullable(), stopLoss: decimalString.nullable() });

export const phoenixCancelInput = phoenixVaultInput.extend({
  symbol,
  // 20 ids keep a by-id cancel inside one transaction (the program allows 100).
  orders: z.union([z.literal("all"), z.array(z.object({ priceInTicks: amountString, orderSequenceNumber: amountString })).min(1).max(20)]),
});

type Empty = Record<string, never>;
const vaultAta = (vault: PublicKey, mint: PublicKey) => getAssociatedTokenAddress(vault, mint, TOKEN_PROGRAM_ID);

/** 2-3 RPC: the vault, its mint, and the delegate. The Phoenix permission is checked before any Phoenix read. */
async function phoenixVault(env: BuildEnv, address: string) {
  const vault = await loadVaultCtx(env, address);
  const delegate = delegateFor(await assertOperator(env, vault, env.payer), DELEGATE_PHOENIX);
  const traderAccount = getPhoenixTraderAddress(vault.key);
  return {
    authority: env.payer,
    config: getConfigPda(env.programId),
    vault: vault.key,
    strategy: getStrategyPda(vault.key, traderAccount, env.programId),
    traderAccount,
    delegate,
  };
}
type Common = Awaited<ReturnType<typeof phoenixVault>>;

const collateralAccounts = (c: Common, ex: PhoenixExchange) => ({
  ...c,
  usdcMint: USDC_MINT,
  canonicalMint: ex.canonicalMint,
  vaultUsdcTokenAccount: vaultAta(c.vault, USDC_MINT),
  vaultCanonicalTokenAccount: vaultAta(c.vault, ex.canonicalMint),
  globalVault: ex.globalVault,
});

const marketAccounts = (c: Common, ex: PhoenixExchange, orderbook: PublicKey) => ({
  ...c,
  perpAssetMap: ex.perpAssetMap,
  orderbook,
  splineCollection: getPhoenixSplineAddress(orderbook),
});

const conditionalAccounts = (c: Common) => ({ ...c, conditionalOrders: getPhoenixConditionalOrdersAddress(c.traderAccount) });

/** Registers the vault's trader if it does not exist yet and records the strategy. */
export async function buildPhoenixInitialize(env: BuildEnv, b: z.infer<typeof phoenixVaultInput>): Promise<Assembled> {
  const c = await phoenixVault(env, b.vault);
  const canonicalMint = await readCanonicalMint(env);
  const ix = await env.program.methods
    .phoenixInitializeStrategy()
    .accountsPartial({ ...c, canonicalMint, vaultCanonicalTokenAccount: vaultAta(c.vault, canonicalMint) })
    .instruction();
  return assemble(env, [ix]);
}

/** Wraps idle USDC through Ember and deposits it as trader collateral. */
export async function buildPhoenixDeposit(env: BuildEnv, b: z.infer<typeof phoenixAmountInput>): Promise<Assembled> {
  const c = await phoenixVault(env, b.vault);
  const ex = await loadPhoenixExchange(env);
  const ix = await env.program.methods
    .phoenixDepositFunds(new BN(b.amount))
    .accountsPartial(collateralAccounts(c, ex))
    .remainingAccounts(ex.tail)
    .instruction();
  return assemble(env, [ix]);
}

/** Withdraws collateral; Phoenix either pays it out now (unwrapped to USDC) or queues all of it. */
export async function buildPhoenixWithdraw(env: BuildEnv, b: z.infer<typeof phoenixAmountInput>): Promise<Assembled> {
  const c = await phoenixVault(env, b.vault);
  const ex = await loadPhoenixExchange(env);
  const ix = await env.program.methods
    .phoenixWithdrawFunds(new BN(b.amount))
    .accountsPartial({ ...collateralAccounts(c, ex), perpAssetMap: ex.perpAssetMap, withdrawQueue: ex.withdrawQueue })
    .remainingAccounts(ex.tail)
    .instruction();
  return assemble(env, [ix]);
}

/** Unwraps canonical tokens a queued withdrawal delivered later into USDC. No trader, no tail. */
export async function buildPhoenixSweep(env: BuildEnv, b: z.infer<typeof phoenixVaultInput>): Promise<Assembled> {
  const { traderAccount: _trader, ...c } = await phoenixVault(env, b.vault);
  const canonicalMint = await readCanonicalMint(env);
  const ix = await env.program.methods
    .phoenixEmberWithdraw()
    .accountsPartial({
      ...c,
      usdcMint: USDC_MINT,
      canonicalMint,
      vaultUsdcTokenAccount: vaultAta(c.vault, USDC_MINT),
      vaultCanonicalTokenAccount: vaultAta(c.vault, canonicalMint),
    })
    .instruction();
  return assemble(env, [ix]);
}

const sideArg = (side: "long" | "short") => (side === "long" ? { bid: {} as Empty } : { ask: {} as Empty });

type OrderBody = z.infer<typeof phoenixOrderInput>;

/**
 * Program order parameters for a ticket; pure. Sizes floor to lots and prices to ticks. A market order is
 * capped at the mark ± `slippageBps`, rounded against the trader, and must fill in full.
 */
export function toOrderParams(rise: Rise, o: OrderBody, market: PhoenixMarket, markTicks: bigint, clientOrderId: bigint) {
  const numBaseLots = BigInt(rise.baseUnitsToBaseLotsWithMarketParams(o.size, market));
  if (numBaseLots <= 0n) throw new ApiError(400, "Validation", "size: below one base lot");
  const shared = {
    side: sideArg(o.side),
    numBaseLots: new BN(numBaseLots.toString()),
    matchLimit: null,
    clientOrderId: new BN(clientOrderId.toString()),
    lastValidSlot: null,
    reduceOnly: o.reduceOnly,
    cancelExisting: false,
  };
  if (o.order.type === "limit") {
    const priceInTicks = BigInt(rise.priceUsdToTicksWithMarketParams(o.order.price, market));
    if (priceInTicks <= 0n) throw new ApiError(400, "Validation", "price: below one tick");
    return {
      kind: "limit" as const,
      params: { ...shared, priceInTicks: new BN(priceInTicks.toString()), postOnly: o.order.postOnly, slide: false, selfTradeBehavior: { cancelProvide: {} as Empty } },
    };
  }
  const bps = BigInt(o.order.slippageBps);
  const limit = o.side === "long" ? (markTicks * (10_000n + bps) + 9_999n) / 10_000n : (markTicks * (10_000n - bps)) / 10_000n;
  return {
    kind: "market" as const,
    params: {
      ...shared,
      priceInTicks: new BN((limit > 0n ? limit : 1n).toString()),
      numQuoteLots: null,
      minBaseLotsToFill: new BN(numBaseLots.toString()),
      minQuoteLotsToFill: new BN(0),
      selfTradeBehavior: { abort: {} as Empty },
    },
  };
}

/** A long takes profit above the mark and stops out below it, selling to close; a short mirrors. */
const tpSlDirection = (side: "long" | "short") =>
  side === "long"
    ? { takeProfit: "greater" as const, stopLoss: "less" as const, closingSide: "ask" as const }
    : { takeProfit: "less" as const, stopLoss: "greater" as const, closingSide: "bid" as const };

/**
 * A full-size TP/SL bracket closing a `positionSide` position; pure. Each trigger fires an IOC whose
 * execution price is the trigger moved `TPSL_SLIPPAGE_BPS` against the trader, never below one tick.
 */
function toTpSlOrder(positionSide: "long" | "short", assetId: number, takeProfitTicks: bigint | null, stopLossTicks: bigint | null) {
  const dir = tpSlDirection(positionSide);
  const trigger = (ticks: bigint | null) => {
    if (ticks === null) return null;
    const execution =
      dir.closingSide === "ask" ? (ticks * (10_000n - TPSL_SLIPPAGE_BPS)) / 10_000n : (ticks * (10_000n + TPSL_SLIPPAGE_BPS) + 9_999n) / 10_000n;
    return {
      tradeSide: dir.closingSide === "ask" ? { ask: {} as Empty } : { bid: {} as Empty },
      kind: { ioc: {} as Empty },
      triggerPriceInTicks: new BN(ticks.toString()),
      executionPriceInTicks: new BN((execution > 0n ? execution : 1n).toString()),
    };
  };
  const takeProfit = trigger(takeProfitTicks);
  const stopLoss = trigger(stopLossTicks);
  return {
    assetId,
    greater: dir.takeProfit === "greater" ? takeProfit : stopLoss,
    less: dir.takeProfit === "less" ? takeProfit : stopLoss,
    size: { percent: { 0: 100 } },
  };
}

interface TpSlCancel {
  conditionalOrderIndex: number;
  greater: boolean;
  less: boolean;
}

const disarmMarket = (orders: PhoenixConditionalOrder[] | null, assetId: number): TpSlCancel[] =>
  (orders ?? []).filter((o) => o.assetId === assetId).map((o) => ({ conditionalOrderIndex: o.index, greater: o.greater !== null, less: o.less !== null }));

interface TpSlPlan {
  create: boolean;
  cancels: TpSlCancel[];
  place: ReturnType<typeof toTpSlOrder> | null;
}

/**
 * Makes the market's TP/SL exactly `want`, both null removing it; pure. Placing adds a slot rather than
 * replacing one, so every armed slot of the market is cancelled first and a retry converges. A trigger
 * must sit on the far side of the mark, or it would fire at once.
 */
function planTpSl(rise: Rise, state: TpSlState, market: PhoenixMarket, want: { takeProfit: string | null; stopLoss: string | null }, markTicks: bigint): TpSlPlan {
  const cancels = disarmMarket(state.orders, market.assetId);
  if (want.takeProfit === null && want.stopLoss === null) {
    if (cancels.length === 0) throw new ApiError(400, "Validation", "No TP/SL is armed on this market");
    return { create: false, cancels, place: null };
  }
  const side = state.positionSide;
  if (!side) throw new ApiError(400, "Validation", "symbol: no open position in this market");
  const dir = tpSlDirection(side);
  const ticks = (field: "takeProfit" | "stopLoss") => {
    const price = want[field];
    if (price === null) return null;
    const t = BigInt(rise.priceUsdToTicksWithMarketParams(price, market));
    if (t <= 0n) throw new ApiError(400, "Validation", `${field}: below one tick`);
    const armable = dir[field] === "greater" ? t > markTicks : t < markTicks;
    if (!armable) throw new ApiError(400, "Validation", `${field}: must be ${dir[field] === "greater" ? "above" : "below"} the mark price for a ${side}`);
    return t;
  };
  return { create: state.orders === null, cancels, place: toTpSlOrder(side, market.assetId, ticks("takeProfit"), ticks("stopLoss")) };
}

const cancelTpSlIx = (env: BuildEnv, c: Common, orderbook: PublicKey, cancel: TpSlCancel) =>
  env.program.methods.phoenixCancelConditionalOrder(cancel).accountsPartial({ ...conditionalAccounts(c), orderbook }).instruction();

/** Create, then cancels, then place: the order the plan's semantics need. The place validates the trader tail, so it goes last. */
const tpSlIxs = (env: BuildEnv, c: Common, ex: PhoenixExchange, orderbook: PublicKey, plan: TpSlPlan) =>
  Promise.all([
    ...(plan.create ? [env.program.methods.phoenixCreateConditionalOrdersAccount(TPSL_CAPACITY).accountsPartial(conditionalAccounts(c)).instruction()] : []),
    ...plan.cancels.map((cancel) => cancelTpSlIx(env, c, orderbook, cancel)),
    ...(plan.place
      ? [
          env.program.methods
            .phoenixPlacePositionConditionalOrder(plan.place)
            .accountsPartial({ ...marketAccounts(c, ex, orderbook), ...conditionalAccounts(c) })
            .remainingAccounts(ex.tail)
            .instruction(),
        ]
      : []),
  ]);

/** A market or limit order, optionally arming a TP/SL on the resulting position or disarming the market's. */
export async function buildPhoenixOrder(env: BuildEnv, b: OrderBody): Promise<Assembled> {
  const c = await phoenixVault(env, b.vault);
  const [ex, market] = await Promise.all([loadPhoenixExchange(env), resolvePhoenixMarket(env, b.symbol)]);
  const [markTicks, state, rise] = await Promise.all([
    b.order.type === "market" ? loadMarkTicks(env, ex, market.assetId) : 0n,
    b.disarmTpSl || b.tpSl ? loadTpSlState(env, c.vault, market.assetId) : null,
    loadRise(),
  ]);
  const order = toOrderParams(rise, b, market, markTicks, BigInt(env.now()));
  const orderbook = new PublicKey(market.marketPubkey);
  const accounts = marketAccounts(c, ex, orderbook);
  const method = order.kind === "market" ? env.program.methods.phoenixPlaceMarketOrder(order.params) : env.program.methods.phoenixPlaceLimitOrder(order.params);
  const orderIx = await method.accountsPartial(accounts).remainingAccounts(ex.tail).instruction();
  if (b.tpSl && state) {
    if (state.positionSide !== null && state.positionSide !== b.side)
      throw new ApiError(400, "Validation", "tpSl: TP/SL can't be attached to an order that reduces or flips a position; set it from the TP/SL panel");
    // The market order fills in full first, so the bracket arms on a position on `side`.
    const plan = planTpSl(rise, { ...state, positionSide: b.side }, market, b.tpSl, markTicks);
    return assemble(env, [orderIx, ...(await tpSlIxs(env, c, ex, orderbook, plan))]);
  }
  const cancels = b.disarmTpSl && state ? disarmMarket(state.orders, market.assetId) : [];
  return assemble(env, [orderIx, ...(await Promise.all(cancels.map((cancel) => cancelTpSlIx(env, c, orderbook, cancel))))]);
}

/** Replaces the market's TP/SL with exactly the requested legs. */
export async function buildPhoenixTpSl(env: BuildEnv, b: z.infer<typeof phoenixTpSlInput>): Promise<Assembled> {
  const c = await phoenixVault(env, b.vault);
  const [ex, market] = await Promise.all([loadPhoenixExchange(env), resolvePhoenixMarket(env, b.symbol)]);
  const placing = b.takeProfit !== null || b.stopLoss !== null;
  const [state, markTicks, rise] = await Promise.all([
    loadTpSlState(env, c.vault, market.assetId),
    placing ? loadMarkTicks(env, ex, market.assetId) : 0n,
    loadRise(),
  ]);
  const plan = planTpSl(rise, state, market, b, markTicks);
  return assemble(env, await tpSlIxs(env, c, ex, new PublicKey(market.marketPubkey), plan));
}

/** Cancels every resting order on the market, or the listed ones; Phoenix finds each by price and sequence number. */
export async function buildPhoenixCancel(env: BuildEnv, b: z.infer<typeof phoenixCancelInput>): Promise<Assembled> {
  const c = await phoenixVault(env, b.vault);
  const [ex, market] = await Promise.all([loadPhoenixExchange(env), resolvePhoenixMarket(env, b.symbol)]);
  const mode =
    b.orders === "all"
      ? { all: {} as Empty }
      : {
          byId: {
            // A node pointer of 0 is `None`: Phoenix locates the order itself.
            orders: b.orders.map((o) => ({ nodePointer: 0, priceInTicks: new BN(o.priceInTicks), orderSequenceNumber: new BN(o.orderSequenceNumber) })),
          },
        };
  const ix = await env.program.methods
    .phoenixCancelOrders(mode)
    .accountsPartial(marketAccounts(c, ex, new PublicKey(market.marketPubkey)))
    .remainingAccounts(ex.tail)
    .instruction();
  return assemble(env, [ix]);
}
