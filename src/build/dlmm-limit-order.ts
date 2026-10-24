import { PublicKey } from "@solana/web3.js";
import { z } from "zod";
import { getStrategyPda } from "../chain/pda";
import { ApiError } from "../errors";
import { assemble, fitsInTransaction } from "./assemble";
import { amountString, type BuildEnv, pubkey } from "./context";
import { cancelLimitOrderIx, DLMM_MAX_LIMIT_ORDER_BINS, loadDlmmCtx, pairOf, pairStrategySetupIxs, placeLimitOrderIxs, readLimitOrderLbPair } from "./dlmm-ix";
import { meteora, readPool } from "./meteora";
import type { LocalStep } from "./registry";
import { closeDlmmStrategyIx } from "./strategy";

/** `ask` sells token X above the active bin, `bid` sells token Y below it; bins in increasing order. */
export const dlmmLimitOrderPlaceInput = z.object({
  vault: pubkey,
  lbPair: pubkey,
  side: z.enum(["ask", "bid"]),
  bins: z.array(z.object({ binId: z.number().int(), amount: amountString })).min(1).max(DLMM_MAX_LIMIT_ORDER_BINS),
});

/** Without `bins`, every bin that still holds anything is cancelled and the strategy closed. */
export const dlmmLimitOrderCancelInput = z.object({
  vault: pubkey,
  limitOrder: pubkey,
  bins: z.array(z.number().int()).min(1).max(DLMM_MAX_LIMIT_ORDER_BINS).optional(),
});

/**
 * Places a limit order with its generated key and strategy PDA. When the bins need new bin arrays that
 * do not fit alongside, those go in a first transaction.
 */
export async function buildDlmmLimitOrderPlace(env: BuildEnv, b: z.infer<typeof dlmmLimitOrderPlaceInput>): Promise<LocalStep | LocalStep[]> {
  const binIds = b.bins.map((bin) => bin.binId);
  if (binIds.some((id, i) => i > 0 && id <= (binIds[i - 1] ?? id))) throw new ApiError(400, "Validation", "bins must be in increasing order");
  if (b.bins.some((bin) => BigInt(bin.amount) === 0n)) throw new ApiError(400, "Validation", "every bin amount must be greater than zero");

  const c = await loadDlmmCtx(env, b.vault);
  const pool = await readPool(env, new PublicKey(b.lbPair));
  if (!meteora().isSupportLimitOrder(pool.lbPair)) throw new ApiError(400, "Validation", "this pool does not take limit orders");
  const activeBinId = pool.lbPair.activeId;
  const isAskSide = b.side === "ask";
  // `bins` has at least one entry and is increasing.
  const lowest = binIds[0] ?? activeBinId;
  const highest = binIds[binIds.length - 1] ?? activeBinId;
  if (isAskSide && lowest <= activeBinId) throw new ApiError(400, "Validation", `an ask must sit above the active bin ${activeBinId}`);
  if (!isAskSide && highest >= activeBinId) throw new ApiError(400, "Validation", `a bid must sit below the active bin ${activeBinId}`);

  // The program refuses the order until each non-deposit pair mint has its Jupiter strategy.
  const setup = await pairStrategySetupIxs(c, pairOf(pool));
  const { setupIxs, placeIxs, limitOrder } = await placeLimitOrderIxs(
    c,
    pool,
    isAskSide,
    b.bins.map((bin) => ({ binId: bin.binId, amountBaseUnits: BigInt(bin.amount) })),
  );
  const meta = { limitOrder: limitOrder.publicKey.toBase58(), strategy: getStrategyPda(c.vault.key, limitOrder.publicKey, env.programId).toBase58() };
  const all = [...setup, ...setupIxs, ...placeIxs];
  if (fitsInTransaction(env.payer, all)) return { ...(await assemble(env, all, [], { signers: [limitOrder] })), ...meta };
  return [await assemble(env, [...setup, ...setupIxs]), { ...(await assemble(env, placeIxs, [], { signers: [limitOrder], deferSimulation: true })), ...meta }];
}

/**
 * Cancels the given bins, or every bin that still holds anything. Once nothing is left in the order
 * the strategy closes in the same transaction and the order's rent returns to the wallet.
 */
export async function buildDlmmLimitOrderCancel(env: BuildEnv, b: z.infer<typeof dlmmLimitOrderCancelInput>): Promise<LocalStep> {
  const c = await loadDlmmCtx(env, b.vault);
  const limitOrder = new PublicKey(b.limitOrder);
  const pool = await readPool(env, await readLimitOrderLbPair(env, limitOrder));
  let parsed: Awaited<ReturnType<typeof pool.getLimitOrder>>;
  try {
    parsed = await pool.getLimitOrder(limitOrder);
  } catch {
    throw new ApiError(502, "DlmmUnavailable", "Could not read this limit order from Meteora. Try again in a moment.");
  }
  const open = parsed.limitOrderData.limitOrderBinData.filter((bin) => !bin.empty).map((bin) => bin.binId);
  const cancelled = b.bins ?? open;
  const stale = cancelled.filter((id) => !open.includes(id));
  if (stale.length) throw new ApiError(400, "Validation", `bins ${stale.join(", ")} hold nothing to cancel`);
  const closesStrategy = open.every((id) => cancelled.includes(id));
  const ixs = [
    ...(cancelled.length ? [await cancelLimitOrderIx(c, pool, limitOrder, cancelled)] : []),
    ...(closesStrategy ? [await closeDlmmStrategyIx(env, c.vault, c.operator, limitOrder, pairOf(pool))] : []),
  ];
  return { ...(await assemble(env, ixs)), cancelledBins: cancelled, closesStrategy };
}
