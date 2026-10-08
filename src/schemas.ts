import { z } from "zod";

/** Token amounts cross JSON as base-unit integer strings. */
export const BaseUnits = z.string().regex(/^\d+$/);
/** A signed base-unit integer string, e.g. a realized loss or negative margin equity. */
export const SignedBaseUnits = z.string().regex(/^-?\d+$/);
/** A u64 counter or id that crosses JSON as a string, such as an epoch. */
const U64String = z.string().regex(/^\d+$/);
const DecimalString = z.string().regex(/^\d+(\.\d+)?$/);

export const ErrorBodySchema = z.object({ error: z.object({ code: z.string(), message: z.string() }) });

export const VaultSummarySchema = z.object({
  address: z.string(),
  name: z.string(),
  status: z.string(),
  depositMint: z.string(),
  depositSymbol: z.string(),
  depositDecimals: z.number().int().nonnegative(),
  totalAssets: BaseUnits,
});
export type VaultSummary = z.infer<typeof VaultSummarySchema>;

export const VaultsResponseSchema = z.object({ vaults: z.array(VaultSummarySchema) });

export const TokenInfoSchema = z.object({
  mint: z.string(),
  symbol: z.string(),
  decimals: z.number().int().nonnegative(),
});
export type TokenInfo = z.infer<typeof TokenInfoSchema>;

export const HoldingsSchema = z.object({
  depositToken: TokenInfoSchema,
  totalValue: BaseUnits,
  totalUsd: z.number().nullable(),
  navTotalAssets: BaseUnits,
  navDeltaBps: z.number().nullable(),
  /** True when some token has no price. Missing value is not zero. */
  partial: z.boolean(),
  unpriced: z.array(z.string()),
  tokens: z.array(
    z.object({ token: TokenInfoSchema, amount: BaseUnits, usd: z.number().nullable(), shareBps: z.number().nullable() }),
  ),
});
export type Holdings = z.infer<typeof HoldingsSchema>;

export const StrategySchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("jupiter"), address: z.string(), symbol: z.string(), decimals: z.number().int().nonnegative(), vaultBalance: BaseUnits }),
  z.object({
    type: z.literal("dlmm"),
    address: z.string(),
    position: z.string(),
    lbPair: z.string().optional(),
    tokenX: TokenInfoSchema,
    tokenY: TokenInfoSchema,
    lowerPrice: z.string(),
    upperPrice: z.string(),
    activePrice: z.string(),
    amountX: BaseUnits,
    amountY: BaseUnits,
    pendingFeeX: BaseUnits,
    pendingFeeY: BaseUnits,
  }),
  z.object({ type: z.literal("phoenix"), address: z.string(), equity: BaseUnits, leverage: z.number().nullable() }),
  z.object({ type: z.literal("unreadable"), address: z.string(), protocol: z.string(), reason: z.string() }),
]);
export type Strategy = z.infer<typeof StrategySchema>;

export const QuoteSchema = z.object({
  inAmount: BaseUnits,
  outAmount: BaseUnits,
  priceImpactPct: z.string(),
  routeLabels: z.array(z.string()),
  slippageBps: z.number().int(),
});
export type Quote = z.infer<typeof QuoteSchema>;

export const PoolSearchSchema = z.object({
  total: z.number().int().nonnegative(),
  page: z.number().int().positive(),
  pages: z.number().int().nonnegative(),
  pools: z.array(
    z.object({
      address: z.string(),
      name: z.string(),
      tokenX: z.object({ mint: z.string(), symbol: z.string(), decimals: z.number().int().nonnegative() }),
      tokenY: z.object({ mint: z.string(), symbol: z.string(), decimals: z.number().int().nonnegative() }),
      binStep: z.number(),
      /** USD; display only. */
      tvl: z.number().nullable().optional(),
      fees24h: z.number().nullable().optional(),
      /** Percent, e.g. 0.04 = 0.04 %. */
      baseFeePct: z.number().nullable().optional(),
    }),
  ),
});
export type PoolSearchPage = z.infer<typeof PoolSearchSchema>;

export const TokenDetailSchema = TokenInfoSchema.extend({
  name: z.string().optional(),
  priceUsd: z.number().nullable(),
  /** Jupiter verification; `null` when unknown. Warn before swapping an unverified token. */
  verified: z.boolean().nullable(),
});
export type TokenDetail = z.infer<typeof TokenDetailSchema>;

export const PoolInfoSchema = z.object({
  lbPair: z.string(),
  tokenX: TokenInfoSchema,
  tokenY: TokenInfoSchema,
  binStep: z.number().int().positive(),
  /** The bin holding the current price; `dlmm/open` ranges are chosen around it. */
  activeBinId: z.number().int(),
  /** Token Y per token X. */
  activePrice: z.string(),
});
export type PoolInfo = z.infer<typeof PoolInfoSchema>;

const VaultStatusSchema = z.enum(["normal", "paused", "reduceOnly"]);

export const VaultDetailSchema = VaultSummarySchema.extend({
  id: U64String,
  status: VaultStatusSchema,
  /** Scaled by 1e9: "1000000000" means one deposit-mint base unit per share base unit. */
  navPerShare: BaseUnits,
  depositCap: BaseUnits,
  performanceFeeBps: z.number().int().nonnegative(),
  managementFeeBps: z.number().int().nonnegative(),
  /** Unix seconds. */
  lastNavTs: z.number().int(),
  authority: z.string(),
  shareMint: z.string(),
  shareSupply: BaseUnits,
  idleBalance: BaseUnits,
  /** Non-deposit tokens in the vault's wallet outside any strategy (airdrops, dust). */
  unmanagedHoldings: z.array(z.object({ token: TokenInfoSchema, amount: BaseUnits })),
  pendingDeposits: BaseUnits,
  pendingWithdrawalShares: BaseUnits,
  unclaimedManagerFeeShares: BaseUnits,
  unclaimedPlatformFeeShares: BaseUnits,
  epochOutflow: BaseUnits,
  highWaterMark: BaseUnits,
  navEpoch: U64String,
  minDeposit: BaseUnits,
  minWithdrawalShares: BaseUnits,
  depositPaused: z.boolean(),
  withdrawalPaused: z.boolean(),
  pendingPerformanceFeeBps: z.number().int().nonnegative(),
  pendingManagementFeeBps: z.number().int().nonnegative(),
  /** Unix seconds when the pending fees apply. */
  feeEffectiveTs: z.number().int(),
  openStrategyCount: z.number().int().nonnegative(),
  protocol: z.object({
    status: VaultStatusSchema,
    maxEpochOutflowBps: z.number().int().nonnegative(),
    maxSlippageBps: z.number().int().nonnegative(),
  }),
});
export type VaultDetail = z.infer<typeof VaultDetailSchema>;

/** One posted NAV, oldest first in the list. */
export const NavHistoryPointSchema = z.object({
  epoch: z.number().int().nonnegative(),
  /** Unix seconds; null for rows recorded without a timestamp. */
  ts: z.number().int().nullable(),
  totalAssets: BaseUnits,
  /** Scaled by 1e9, as in `VaultDetail.navPerShare`. */
  navPerShare: BaseUnits,
  highWaterMark: BaseUnits,
  /** Set by an admin `nav_override`, not by the keeper. */
  overridden: z.boolean(),
});
export type NavHistoryPoint = z.infer<typeof NavHistoryPointSchema>;

const requestFields = {
  owner: z.string(),
  /** The request settles at the first NAV epoch after this one. */
  epoch: U64String,
  /** Unix seconds. */
  createdTs: z.number().int(),
  /** `resolvable` once a later NAV epoch is posted. */
  state: z.enum(["pending", "resolvable"]),
  cancellable: z.boolean(),
};

export const RequestQueueSchema = z.object({
  /** Oldest first. `amount` is deposit-mint base units. */
  deposits: z.array(z.object({ ...requestFields, amount: BaseUnits })),
  /** Oldest first. `shares` is share base units. */
  withdrawals: z.array(z.object({ ...requestFields, shares: BaseUnits })),
});
export type RequestQueue = z.infer<typeof RequestQueueSchema>;

export const StrategyHistoryItemSchema = z.object({
  strategy: z.string(),
  id: z.number().int().nullable(),
  type: z.enum(["jupiter", "dlmm", "phoenix"]).nullable(),
  protocolAccount: z.string().nullable(),
  /** Unix seconds. */
  openedTs: z.number().int().nullable(),
  closedTs: z.number().int(),
  openSignature: z.string().nullable(),
  closeSignature: z.string(),
  /** False for strategies opened before exact accounting existed; their totals may be incomplete. */
  exact: z.boolean(),
  /** Per-mint cash flows in that mint's base units. */
  tokens: z.array(
    z.object({
      mint: z.string(),
      /** Null when token metadata was unavailable. */
      symbol: z.string().nullable(),
      decimals: z.number().int().nonnegative().nullable(),
      uiMultiplier: z.number().optional(),
      contributed: BaseUnits,
      returned: BaseUnits,
      feesGross: BaseUnits,
      feesTreasury: BaseUnits,
      feesRetained: BaseUnits,
      /** returned + feesRetained - contributed; negative for a loss. */
      realizedPnl: SignedBaseUnits,
    }),
  ),
});
export type StrategyHistoryItem = z.infer<typeof StrategyHistoryItemSchema>;

export const PhoenixManagerSchema = z.object({
  /** `none`: no strategy; `registered`: strategy exists, trader not onboarded; `ready`: can deposit and trade. */
  status: z.enum(["none", "registered", "ready"]),
  /** Phoenix strategies need a USDC deposit mint. */
  usdcVault: z.boolean(),
  traderAccount: z.string(),
  markets: z.array(
    z.object({
      symbol: z.string(),
      name: z.string(),
      category: z.string(),
      maxLeverage: z.number(),
      /** USD per base unit; "0" when the mark is unavailable. */
      markPrice: DecimalString,
      tickSize: z.number(),
      baseLotsDecimals: z.number().int(),
      /** Fractions, e.g. 0.00035 = 3.5 bps. */
      takerFee: z.number(),
      makerFee: z.number(),
    }),
  ),
  /** Null when Phoenix's API is unavailable. */
  openOrders: z
    .array(
      z.object({
        symbol: z.string(),
        side: z.enum(["long", "short"]),
        /** USD per base unit and remaining base units, as Phoenix reports them. */
        price: z.string(),
        size: z.string(),
        priceInTicks: U64String,
        orderSequenceNumber: U64String,
        reduceOnly: z.boolean(),
      }),
    )
    .nullable(),
  /** USDC base units; null when Phoenix's API is unavailable. Signed because the app passes Phoenix's number through. */
  withdrawable: SignedBaseUnits.nullable(),
  /** Margin summary in USDC base units; null before onboarding or when Phoenix's API is unavailable. */
  account: z
    .object({
      collateral: SignedBaseUnits,
      equity: SignedBaseUnits,
      initialMargin: SignedBaseUnits,
      maintenanceMargin: SignedBaseUnits,
      withdrawable: SignedBaseUnits,
      riskState: z.string(),
      /** USD decimal strings by market symbol. */
      liquidationPrices: z.record(z.string()),
    })
    .nullable(),
});
export type PhoenixManager = z.infer<typeof PhoenixManagerSchema>;

export const vaultData = <T extends z.ZodTypeAny>(data: T) => z.object({ vault: z.string(), data });

export const BuiltStepSchema = z
  .object({
    /** Unsigned base64 v0 transaction. */
    transaction: z.string().min(1),
    simulation: z.object({ unitsConsumed: z.number(), deferred: z.boolean().optional() }),
    /** Short-lived (90 s) proof that the API built this exact message for this key. */
    ticket: z.string().min(1),
    blockhash: z.string().min(1),
    sendConcurrently: z.boolean().optional(),
    next: z.object({ path: z.string().regex(/^[a-z0-9/-]+$/), body: z.record(z.unknown()) }).optional(),
  })
  .passthrough();
export type BuiltStep = z.infer<typeof BuiltStepSchema>;

export const BuildResponseSchema = z.object({
  vault: z.string(),
  result: z.union([BuiltStepSchema, z.array(BuiltStepSchema).min(1)]),
});

export const SendResponseSchema = z.object({
  signature: z.string().min(1),
  receipt: z.string().min(1),
  status: z.enum(["pending", "unknown"]),
});
export type SendResult = z.infer<typeof SendResponseSchema>;

export const StatusResponseSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("pending") }),
  z.object({ status: z.literal("confirmed") }),
  z.object({ status: z.literal("expired") }),
  z.object({ status: z.literal("failed"), code: z.string(), message: z.string() }),
]);
export type TransactionStatus = z.infer<typeof StatusResponseSchema>;
