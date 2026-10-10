import type { PoolInfo } from "./schemas";

/** The app's widest supported position; wider ranges are rejected before building. */
export const DLMM_MAX_POSITION_BINS = 1_400;
/** One position account holds this many bins; wider opens become several transactions. */
export const DLMM_BINS_PER_TRANSACTION = 70;

/** Which tokens a range can take: X sits at and above the active bin, Y at and below. */
export type DepositSides = "x" | "y" | "both";

export interface PriceRange {
  lowerBinId: number;
  /** Exclusive, as `dlmm/open` expects. */
  upperBinId: number;
  binCount: number;
  sides: DepositSides;
  /** Actual prices (token Y per token X) of the first and last bin; bins are discrete. */
  lowPrice: number;
  highPrice: number;
}

type PoolPricing = Pick<PoolInfo, "activeBinId" | "activePrice" | "binStep">;

// Bin indices from float logs can land at 4.9999999; snap those to the integer they mean.
const snap = (value: number) => (Math.abs(value - Math.round(value)) < 1e-9 ? Math.round(value) : value);

/** Fractional bin offset of `price` from the active bin. */
function binOffset(pool: PoolPricing, price: number): number {
  return snap(Math.log(price / Number(pool.activePrice)) / Math.log(1 + pool.binStep / 10_000));
}

export function binPrice(pool: PoolPricing, binId: number): number {
  return Number(pool.activePrice) * (1 + pool.binStep / 10_000) ** (binId - pool.activeBinId);
}

/**
 * Converts a human price range (token Y per token X) to the smallest bin range that covers it,
 * so callers never deal with bin ids.
 */
export function binRangeForPrices(pool: PoolPricing, minPrice: number, maxPrice: number): PriceRange {
  if (!(minPrice > 0) || !(maxPrice > 0) || !Number.isFinite(minPrice) || !Number.isFinite(maxPrice)) {
    throw new Error("Prices must be positive numbers");
  }
  if (minPrice >= maxPrice) throw new Error("Min price must be below max price");
  if (!(Number(pool.activePrice) > 0)) throw new Error("Pool has no usable active price");
  const lowerBinId = pool.activeBinId + Math.floor(binOffset(pool, minPrice));
  const lastBinId = pool.activeBinId + Math.ceil(binOffset(pool, maxPrice));
  const binCount = lastBinId - lowerBinId + 1;
  if (binCount > DLMM_MAX_POSITION_BINS) {
    throw new Error(`That range needs ${binCount} bins; the maximum is ${DLMM_MAX_POSITION_BINS}. Narrow it.`);
  }
  const sides: DepositSides = lastBinId < pool.activeBinId ? "y" : lowerBinId > pool.activeBinId ? "x" : "both";
  return {
    lowerBinId,
    upperBinId: lastBinId + 1,
    binCount,
    sides,
    lowPrice: binPrice(pool, lowerBinId),
    highPrice: binPrice(pool, lastBinId),
  };
}

/** On-chain convention: both ends inclusive, like a position's own `lowerBinId`/`upperBinId`. */
export interface InclusiveBinRange {
  lowerBinId: number;
  upperBinId: number;
}

export type FlipSide = "x" | "y";

/** A flip sells the vault's non-deposit token: X, unless X is the deposit mint. */
export function flipSide(tokenXMint: string, depositMint: string): FlipSide {
  return tokenXMint !== depositMint ? "x" : "y";
}

/**
 * The part of `selection` holding only one side's token, as `dlmm/flip` needs: bins strictly above the
 * active bin for X, strictly below it for Y. The active bin holds both tokens, so it is never flipped.
 */
export function flipRange(selection: InclusiveBinRange, activeBinId: number, side: FlipSide): InclusiveBinRange | null {
  const lowerBinId = side === "x" ? Math.max(selection.lowerBinId, activeBinId + 1) : selection.lowerBinId;
  const upperBinId = side === "y" ? Math.min(selection.upperBinId, activeBinId - 1) : selection.upperBinId;
  return lowerBinId <= upperBinId ? { lowerBinId, upperBinId } : null;
}
