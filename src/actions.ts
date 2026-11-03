/** Base-unit integer string, e.g. "1000000" for 1 USDC. Never a JavaScript number. */
export type BaseUnitString = string;

/** Non-negative decimal with up to 12 fractional digits, e.g. "0.5" or "150.25". Not base units. */
export type DecimalString = string;

export type DlmmShape = "spot" | "curve" | "bidAsk";

export type VaultStatus = "normal" | "paused" | "reduceOnly";

/**
 * The least a swap may return: the shown quote's output after its slippage, for the input it was
 * quoted for. A build swapping a different input scales it, so it holds as a price floor.
 */
export interface MinOut {
  /** Positive. */
  inAmount: BaseUnitString;
  minOutAmount: BaseUnitString;
}

/** Zap options shared by `dlmm/zap-out` and a zapping `dlmm/remove`. */
interface ZapFloors {
  /** The floor of the zap swap. */
  minOut?: MinOut;
  /** The floor of the follow-up into the deposit mint, for a pool without it. */
  followUpMinOut?: MinOut;
  /** Withdraw first and swap the returned non-deposit token after, in a transaction of its own, under `minOut`. */
  separateSwap?: boolean;
}

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
      /** The least `destinationMint` the swap may return, from the quote the caller approved. A fresh quote below it fails with `QuoteMoved`. */
      minOutAmount?: BaseUnitString;
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
  /**
   * With a bin selection, removes `bpsToRemove` only from those bins. With `slippageBps` it zaps: the
   * other pool token is swapped into `outputMint` (a pool token or the deposit mint, by default the
   * deposit mint) in the same transaction.
   */
  | ({
      action: "dlmm/remove";
      vault: string;
      position: string;
      bpsToRemove: number;
      cursorBinId?: number;
      slippageBps?: number;
      outputMint?: string;
    } & ZapFloors &
      InclusiveBinSelection)
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
  /** `outputMint` picks a pool token or the deposit mint to end in. It defaults to the deposit mint. */
  | ({ action: "dlmm/zap-out"; vault: string; position: string; slippageBps: number; cursorBinId?: number; outputMint?: string } & ZapFloors)
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
      /** Deposits and withdrawals settle only after the manager approves each one. */
      approvalRequired?: boolean;
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
      approvalRequired?: boolean;
    }
  /** Mints the manager's accrued fee shares to the manager. */
  | { action: "vault/claim-fee"; vault: string }
  | { action: "vault/close"; vault: string }
  /**
   * On a vault that requires approval, lets `depositor`'s pending deposit settle. `amount` is the amount the
   * manager reviewed; the program refuses with `ApprovedAmountMismatch` if the request changed since. Authority only.
   */
  | { action: "deposit/approve"; vault: string; depositor: string; amount: BaseUnitString }
  /** Same as `deposit/approve` for `withdrawer`'s pending withdrawal, with the reviewed share base units. */
  | { action: "withdrawal/approve"; vault: string; withdrawer: string; shares: BaseUnitString }
  /** Refunds `depositor`'s pending deposit and closes the request. Authority only. */
  | { action: "deposit/reject"; vault: string; depositor: string }
  /** Returns `withdrawer`'s pending withdrawal shares and closes the request. Authority only. */
  | { action: "withdrawal/reject"; vault: string; withdrawer: string }
  /**
   * Creates a child vault of `vault`, a vault that takes deposits: same authority and deposit mint, no
   * depositors of its own. With `fundAmount` the same transaction moves that much deposit token into it.
   * Authority only. The new address is the `Outcome`'s `created.child`.
   */
  | {
      action: "escrow/create";
      vault: string;
      /** At most 32 UTF-8 bytes. */
      name: string;
      /** Deposit-mint base units, positive. */
      fundAmount?: BaseUnitString;
    }
  /**
   * Moves `amount` from `vault` into its child vault. `mint` defaults to the deposit mint; another mint must be
   * tracked by the sending vault, and the receiving vault's Jupiter strategy is created first when missing.
   * Any live delegate of `vault` may run it.
   */
  | { action: "escrow/fund"; vault: string; child: string; amount: BaseUnitString; mint?: string }
  /** Moves `amount` from the child vault back into `vault`. Same rules as `escrow/fund`. */
  | { action: "escrow/defund"; vault: string; child: string; amount: BaseUnitString; mint?: string }
  /** Moves `amount` between any two vaults of `vault`'s family: `vault` itself or its child vaults. */
  | { action: "escrow/transfer"; vault: string; source: string; destination: string; amount: BaseUnitString; mint?: string }
  /**
   * Closes a child vault. With `defundFirst` the same transaction first returns every token it holds to `vault`
   * and closes its Jupiter strategies. Its LP positions, limit orders and Phoenix account must be closed first.
   * Authority only.
   */
  | { action: "escrow/close"; vault: string; child: string; defundFirst?: boolean };

export type BuildAction = ActionRequest["action"];

export interface BuildRequest {
  /** A builder name, or a `next.path` returned by a previous build. */
  action: string;
  body: Record<string, unknown>;
}

export function toBuildRequest(request: ActionRequest): BuildRequest {
  const { action, ...body } = request;
  return { action, body };
}
