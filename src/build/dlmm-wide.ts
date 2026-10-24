import type { PublicKey, TransactionInstruction } from "@solana/web3.js";
import type { DlmmShape } from "../actions";
import { ApiError } from "../errors";
import { type Assembled, assemble, fitsInTransaction, isComputeLimitError } from "./assemble";
import { addLiquidityIxs, type DlmmCtx } from "./dlmm-ix";
import { missingRangeBinArrayIxs, type Pool } from "./meteora";

/** Upper bound attempted for one deposit; packet size and simulation can reduce it. */
export const DLMM_MAX_ADD_BINS_PER_TX = 91;
/** Remove and claim chunk size, independent of deposit tuning. */
export const DLMM_MAX_EXIT_BINS_PER_TX = 26;

/** One Meteora add-liquidity call over a chunk. */
export interface DepositLeg {
  shape: DlmmShape;
  amountXBaseUnits: bigint;
  amountYBaseUnits: bigint;
}

/** Split a requested range into contiguous inclusive chunks for Meteora liquidity CPIs. */
export function nextBinChunk(cursorBinId: number, upperBinId: number, maxBins = DLMM_MAX_ADD_BINS_PER_TX) {
  return { lowerBinId: cursorBinId, upperBinId: Math.min(upperBinId, cursorBinId + maxBins - 1) };
}

/** Fixed-point unit for the ask side's inverse-price factors. */
const PRICE_SCALE = 1n << 64n;

/**
 * The bins one side funds over the whole requested range, and each bin's weight there. Meteora sizes
 * ask-side (token X) bins by weight over bin price, so X-side weights carry an inverse-price factor,
 * held relative to the side's top bin so it only grows toward the price.
 */
function sideWeights(
  lowerBinId: number, upperBinId: number, activeBinId: number, binStep: number, shape: DlmmShape, side: "x" | "y",
) {
  const first = side === "x" ? Math.max(lowerBinId, activeBinId) : lowerBinId;
  const last = side === "x" ? upperBinId : Math.min(upperBinId, activeBinId);
  const minDistance = side === "x" ? first - activeBinId : activeBinId - last;
  const maxDistance = side === "x" ? last - activeBinId : activeBinId - first;
  const shapeWeight = (binId: number) => {
    const distance = Math.abs(binId - activeBinId);
    return BigInt(shape === "spot" ? 1 : shape === "bidAsk" ? distance + 1 : minDistance + maxDistance - distance + 1);
  };
  const inversePrice: bigint[] = [];
  if (side === "x")
    for (let index = last - first, factor = PRICE_SCALE; index >= 0; index--, factor = (factor * BigInt(10_000 + binStep)) / 10_000n)
      inversePrice[index] = factor;
  // Only bins in [first, last] are ever weighed.
  const priceWeight = (binId: number) => (side === "x" ? (inversePrice[binId - first] ?? 0n) : PRICE_SCALE);
  const weight = (binId: number) => shapeWeight(binId) * priceWeight(binId);
  return { first, last, shapeWeight, priceWeight, weight };
}

/** Allocate each side's base units by its weights over the whole requested range. */
export function amountForBinChunk(
  lowerBinId: number,
  upperBinId: number,
  activeBinId: number,
  binStep: number,
  chunkLowerBinId: number,
  chunkUpperBinId: number,
  shape: DlmmShape,
  amountXBaseUnits: bigint,
  amountYBaseUnits: bigint,
) {
  const allocation = (side: "x" | "y", totalAmount: bigint) => {
    const { first, last, weight } = sideWeights(lowerBinId, upperBinId, activeBinId, binStep, shape, side);
    if (first > last || totalAmount === 0n) return 0n;
    let totalWeight = 0n;
    let beforeWeight = 0n;
    let throughWeight = 0n;
    for (let binId = first; binId <= last; binId++) {
      const w = weight(binId);
      totalWeight += w;
      if (binId < chunkLowerBinId) beforeWeight += w;
      if (binId <= chunkUpperBinId) throughWeight += w;
    }
    return (totalAmount * throughWeight) / totalWeight - (totalAmount * beforeWeight) / totalWeight;
  };
  return { amountXBaseUnits: allocation("x", amountXBaseUnits), amountYBaseUnits: allocation("y", amountYBaseUnits) };
}

/**
 * Meteora draws a curve or bid-ask ramp from the chunk's own edges, starting at weight 1. A chunk
 * of a wider range sits partway up the whole-range ramp, so it is funded as a flat spot leg at the
 * chunk's lowest whole-range weight minus one, plus the shape's own ramp on top. Both legs get the
 * same per-bin price factor from Meteora, so the flat leg's share is weighed with it too.
 */
export function depositLegsForBinChunk(
  lowerBinId: number,
  upperBinId: number,
  activeBinId: number,
  binStep: number,
  chunkLowerBinId: number,
  chunkUpperBinId: number,
  shape: DlmmShape,
  amountXBaseUnits: bigint,
  amountYBaseUnits: bigint,
): DepositLeg[] {
  const chunk = amountForBinChunk(
    lowerBinId, upperBinId, activeBinId, binStep, chunkLowerBinId, chunkUpperBinId, shape, amountXBaseUnits, amountYBaseUnits,
  );
  const flatAmount = (side: "x" | "y", chunkAmount: bigint) => {
    if (shape === "spot" || chunkAmount === 0n) return 0n;
    const { first, last, shapeWeight, priceWeight, weight } =
      sideWeights(lowerBinId, upperBinId, activeBinId, binStep, shape, side);
    const from = Math.max(first, chunkLowerBinId);
    const to = Math.min(last, chunkUpperBinId);
    let totalWeight = 0n;
    let totalPriceWeight = 0n;
    let minWeight: bigint | undefined;
    for (let binId = from; binId <= to; binId++) {
      totalWeight += weight(binId);
      totalPriceWeight += priceWeight(binId);
      const w = shapeWeight(binId);
      if (minWeight === undefined || w < minWeight) minWeight = w;
    }
    if (minWeight === undefined) return 0n;
    return (chunkAmount * (minWeight - 1n) * totalPriceWeight) / totalWeight;
  };
  const flatX = flatAmount("x", chunk.amountXBaseUnits);
  const flatY = flatAmount("y", chunk.amountYBaseUnits);
  return [
    { shape: "spot" as const, amountXBaseUnits: flatX, amountYBaseUnits: flatY },
    { shape, amountXBaseUnits: chunk.amountXBaseUnits - flatX, amountYBaseUnits: chunk.amountYBaseUnits - flatY },
  ].filter((leg) => leg.amountXBaseUnits > 0n || leg.amountYBaseUnits > 0n);
}

const smallerChunk = (bins: number) => (bins > 70 ? 70 : Math.max(1, Math.floor(bins / 2)));

// ponytail: compute grows with bins times Meteora add calls ("bin-legs"), so an unsimulated chunk
// never exceeds the bin-legs a simulated chunk proved. With nothing simulated, 80 bin-legs (40-bin
// Bid-Ask with two legs) stays near 500k CU of the 1.4M limit. Measure per-pool cost to raise it.
export const UNSIMULATED_MAX_BIN_LEGS_PER_TX = 80;

const instructionKey = (ix: TransactionInstruction) =>
  [ix.programId.toBase58(), Buffer.from(ix.data).toString("base64"), ...ix.keys.map((k) => `${k.pubkey.toBase58()}:${Number(k.isSigner)}:${Number(k.isWritable)}`)].join("|");

/** Drops repeats of an identical instruction, such as the idempotent vault ATA creates every leg prepends. */
export const withoutRepeats = (ixs: TransactionInstruction[]) => {
  const seen = new Set<string>();
  return ixs.filter((ix) => {
    const k = instructionKey(ix);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
};

export interface WideAddPlan {
  position: PublicKey;
  pool: Pool;
  /** The whole funded range, inclusive. */
  lowerBinId: number;
  upperBinId: number;
  cursorBinId: number;
  activeBinId: number;
  amountXBaseUnits: bigint;
  amountYBaseUnits: bigint;
  shape: DlmmShape;
  maxActiveBinSlippage: number;
  /** The position is created or funded by an earlier transaction in the same batch. */
  deferFirstSimulation: boolean;
}

/** Builds every funding transaction up front, so the batch goes out after one inspection. */
export async function buildWideAddPlan(c: DlmmCtx, plan: WideAddPlan): Promise<Assembled[]> {
  const built: Assembled[] = [];
  const plannedBinArrays = new Set<string>();
  let cursorBinId = plan.cursorBinId;
  let maxBins = DLMM_MAX_ADD_BINS_PER_TX;
  // Later chunks skip simulation, so they keep the bin-legs the first simulated chunk proved.
  let maxBinLegs = plan.deferFirstSimulation ? UNSIMULATED_MAX_BIN_LEGS_PER_TX : Infinity;
  while (cursorBinId <= plan.upperBinId) {
    while (maxBins >= 1) {
      const chunk = nextBinChunk(cursorBinId, plan.upperBinId, maxBins);
      const attemptedBins = chunk.upperBinId - chunk.lowerBinId + 1;
      const legs = depositLegsForBinChunk(
        plan.lowerBinId, plan.upperBinId, plan.activeBinId, plan.pool.lbPair.binStep,
        chunk.lowerBinId, chunk.upperBinId, plan.shape, plan.amountXBaseUnits, plan.amountYBaseUnits,
      );
      if (legs.length === 0) {
        cursorBinId = chunk.upperBinId + 1;
        break;
      }
      const binLegs = attemptedBins * legs.length;
      if (binLegs > maxBinLegs && attemptedBins > 1) {
        maxBins = Math.max(1, Math.floor(maxBinLegs / legs.length));
        continue;
      }
      const binArrays = (await missingRangeBinArrayIxs(c.env, plan.pool, chunk.lowerBinId, chunk.upperBinId)).filter((ix) => !plannedBinArrays.has(instructionKey(ix)));
      const adds: TransactionInstruction[] = [];
      for (const leg of legs)
        adds.push(...(await addLiquidityIxs(c, plan.position, plan.pool, chunk, leg.amountXBaseUnits, leg.amountYBaseUnits, leg.shape, plan.maxActiveBinSlippage)));
      const ixs = [...binArrays, ...withoutRepeats(adds)];
      if (!fitsInTransaction(c.env.payer, ixs)) {
        if (attemptedBins === 1) throw new ApiError(400, "Validation", "one bin does not fit in a transaction for this pool");
        maxBins = smallerChunk(attemptedBins);
        continue;
      }
      try {
        const deferSimulation = plan.deferFirstSimulation || built.length > 0;
        built.push(await assemble(c.env, ixs, [], { deferSimulation }));
        if (!deferSimulation) maxBinLegs = binLegs;
        for (const ix of binArrays) plannedBinArrays.add(instructionKey(ix));
        cursorBinId = chunk.upperBinId + 1;
        break;
      } catch (error) {
        if (!isComputeLimitError(error) || attemptedBins === 1) throw error;
        maxBins = smallerChunk(attemptedBins);
      }
    }
  }
  if (built.length === 0) throw new ApiError(400, "Validation", "no liquidity remains for the selected bins");
  return built;
}
