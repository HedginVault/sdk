/** Base-unit integer string, e.g. "1000000" for 1 USDC. Never a JavaScript number. */
export type BaseUnitString = string;

/** Non-negative decimal with up to 12 fractional digits, e.g. "0.5" or "150.25". Not base units. */
export type DecimalString = string;

export type DlmmShape = "spot" | "curve" | "bidAsk";

export type VaultStatus = "normal" | "paused" | "reduceOnly";

/** Optional sub-range of an existing position: both ends inclusive, given together or not at all. */
export type InclusiveBinSelection = { lowerBinId: number; upperBinId: number } | { lowerBinId?: never; upperBinId?: never };

/** A resting Phoenix order, as `getPhoenix(vault).openOrders` lists it. */
export interface PhoenixOrderId {
  /** u64 integer strings. */
  priceInTicks: string;
  orderSequenceNumber: string;
}

/**
 * One manager action, typed per V1 builder. `payer` is never sent: the API sets it from the key.
 * Continuation builders (`dlmm/extend`, `dlmm/add-range`, `dlmm/zap-out/swap`, and `jupiter/sweep`
 * after a zap-out) are followed automatically by `execute` from each step's `next`.
 */
export type ActionRequest =
  | {
      action: "jupiter/swap";
      vault: string;
      sourceMint: string;
      destinationMint: string;
      amount: BaseUnitString;
      slippageBps: number;
    }
  | {
      action: "dlmm/open";
      vault: string;
      lbPair: string;
      lowerBinId: number;
      /** Exclusive. */
      upperBinId: number;
      amountX: BaseUnitString;
      amountY: BaseUnitString;
      shape: DlmmShape;
      maxActiveBinSlippage: number;
    }
  /** With a bin selection, adds only to those bins. */
  | ({
      action: "dlmm/add";
      vault: string;
      position: string;
      amountX: BaseUnitString;
      amountY: BaseUnitString;
      shape: DlmmShape;
      maxActiveBinSlippage: number;
    } & InclusiveBinSelection)
  /** With a bin selection, removes `bpsToRemove` only from those bins. */
  | ({ action: "dlmm/remove"; vault: string; position: string; bpsToRemove: number; cursorBinId?: number } & InclusiveBinSelection)
  /**
   * In one atomic transaction, removes all liquidity from the bins and re-adds that token there as Bid-Ask.
   * The range (both ends inclusive) must lie entirely above the active bin (token X) or below it (token Y);
   * see `flipRange`. `activeBinId` is the one the caller read; a larger move than `maxActiveBinSlippage` fails.
   */
  | {
      action: "dlmm/flip";
      vault: string;
      position: string;
      lowerBinId: number;
      upperBinId: number;
      activeBinId: number;
      maxActiveBinSlippage: number;
    }
  | { action: "dlmm/claim-fee"; vault: string; position: string; cursorBinId?: number }
  | { action: "dlmm/zap-out"; vault: string; position: string; slippageBps: number; cursorBinId?: number }
  | { action: "strategy/close"; vault: string; strategy: string }
  /** Creates a DLMM position with no liquidity, plus any missing pair-token Jupiter strategies. */
  | {
      action: "dlmm/initialize";
      vault: string;
      lbPair: string;
      /** Bins centred on the active bin, 1..70. Exclusive with `lowerBinId`/`upperBinId`. */
      width: number;
      lowerBinId?: never;
      upperBinId?: never;
    }
  | {
      action: "dlmm/initialize";
      vault: string;
      lbPair: string;
      lowerBinId: number;
      /** Exclusive; at most 70 bins above `lowerBinId`. */
      upperBinId: number;
      width?: never;
    }
  /** Removes all liquidity, claims fees, and closes the position and its strategy. */
  | { action: "dlmm/close"; vault: string; position: string }
  /**
   * In one atomic transaction, sells the vault's entire balance of `mint` (not the deposit mint) to the
   * deposit mint and closes that mint's Jupiter strategy. Refused while an open DLMM position or limit
   * order uses `mint`.
   */
  | { action: "jupiter/sweep"; vault: string; mint: string; slippageBps: number }
  /** Opens the vault's Jupiter strategy for `targetMint`, required before holding that token. */
  | { action: "jupiter/initialize"; vault: string; targetMint: string }
  /** Records the vault's Phoenix strategy. Then `onboardPhoenix` registers the trader with Phoenix. */
  | { action: "phoenix/initialize"; vault: string }
  /** Moves idle USDC into Phoenix collateral. `amount` is USDC base units. */
  | { action: "phoenix/deposit"; vault: string; amount: BaseUnitString }
  /** Withdraws Phoenix collateral to the vault; a queued withdrawal later needs `phoenix/sweep`. `amount` is USDC base units. */
  | { action: "phoenix/withdraw"; vault: string; amount: BaseUnitString }
  /**
   * Places a limit order. An ask sells token X in bins above the pool's active bin; a bid sells token Y
   * below it. `bins` are strictly increasing, 1..the API's limit, each amount above zero in the sold token.
   * Opens missing pair-token Jupiter strategies first; the build may be two transactions.
   */
  | {
      action: "dlmm/limit-order/place";
      vault: string;
      lbPair: string;
      side: "ask" | "bid";
      bins: { binId: number; amount: BaseUnitString }[];
    }
  /**
   * Cancels `bins`, or without them every bin still holding anything, paying unfilled amounts, proceeds,
   * and fees back to the vault. Once the order is empty its strategy closes in the same transaction.
   */
  | { action: "dlmm/limit-order/cancel"; vault: string; limitOrder: string; bins?: number[] }
  | {
      action: "phoenix/order";
      vault: string;
      /** Phoenix market symbol, e.g. "SOL". */
      symbol: string;
      side: "long" | "short";
      /** Base asset units as a decimal, e.g. "0.5" SOL. */
      size: DecimalString;
      reduceOnly: boolean;
      order:
        /** `slippageBps` 1..2000 around the current mark. */
        | { type: "market"; slippageBps: number }
        /** `price` in USD per base unit. */
        | { type: "limit"; price: DecimalString; postOnly: boolean };
      /**
       * Arms a TP/SL (USD trigger prices, at least one set) on the whole resulting position, replacing
       * the market's armed one. The API accepts it only on a market order that is not reduce-only.
       */
      tpSl?: { takeProfit: DecimalString | null; stopLoss: DecimalString | null };
      /** A full close also cancels the market's armed TP/SL, which would otherwise stay for the next position. */
      disarmTpSl?: boolean;
    }
  /** Replaces the market's TP/SL. A null price removes that leg; both null removes the bracket. */
  | { action: "phoenix/tpsl"; vault: string; symbol: string; takeProfit: DecimalString | null; stopLoss: DecimalString | null }
  /** `orders` is "all", or 1..20 orders from `getPhoenix(vault).openOrders`. */
  | { action: "phoenix/cancel"; vault: string; symbol: string; orders: "all" | PhoenixOrderId[] }
  /** Unwraps tokens a queued Phoenix withdrawal delivered into USDC. */
  | { action: "phoenix/sweep"; vault: string }
  /**
   * Creates a vault managed by the key's wallet. Needs a key not limited to specific vaults. The
   * new address is not in the `Outcome`; read it with `listVaults()` after confirmation.
   */
  | {
      action: "vault/initialize";
      /** At most 32 UTF-8 bytes. */
      name: string;
      depositMint: string;
      /** 0..10000 each. */
      performanceFeeBps: number;
      managementFeeBps: number;
      /** Deposit-mint base units. */
      depositCap: BaseUnitString;
      minDeposit: BaseUnitString;
      /** Share base units. */
      minWithdrawalShares: BaseUnitString;
    }
  /** Changes only the fields given; at least one is required. Units as in `vault/initialize`. */
  | {
      action: "vault/update";
      vault: string;
      performanceFeeBps?: number;
      managementFeeBps?: number;
      depositCap?: BaseUnitString;
      minDeposit?: BaseUnitString;
      minWithdrawalShares?: BaseUnitString;
      status?: VaultStatus;
      depositPaused?: boolean;
      withdrawalPaused?: boolean;
    }
  /** Mints the manager's accrued fee shares to the manager. */
  | { action: "vault/claim-fee"; vault: string }
  | { action: "vault/close"; vault: string };

export type BuildAction = ActionRequest["action"];

/** One step of a wide DLMM position flow: extend toward `targetUpperBinId`, then fund it from `activeBinId`. */
type DlmmWideStep = {
  vault: string;
  position: string;
  /** Inclusive. */
  targetUpperBinId: number;
  amountX: BaseUnitString;
  amountY: BaseUnitString;
  shape: DlmmShape;
  maxActiveBinSlippage: number;
  activeBinId: number;
} & InclusiveBinSelection;

/** A token the zap returned, with the vault's balance of it before the zap. */
export interface ZapSource {
  mint: string;
  balanceBefore: BaseUnitString;
  closeWhenEmpty?: boolean;
}

/** Builders that only ever run as a step's `next`: `execute` follows them; callers never start one. */
export type ContinuationRequest =
  | ({ action: "dlmm/extend" } & DlmmWideStep)
  | ({ action: "dlmm/add-range"; cursorBinId: number } & DlmmWideStep)
  /** Swaps what the zap returned of each source into the deposit mint, one source per build. */
  | { action: "dlmm/zap-out/swap"; vault: string; sources: ZapSource[]; slippageBps: number };

export interface BuildRequest {
  /** A builder name, or a `next.path` returned by a previous build. */
  action: string;
  body: Record<string, unknown>;
}

export function toBuildRequest(request: ActionRequest): BuildRequest {
  const { action, ...body } = request;
  return { action, body };
}
