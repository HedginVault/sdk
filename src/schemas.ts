import { z } from "zod";

/** Token amounts cross JSON as base-unit integer strings. */
export const BaseUnits = z.string().regex(/^\d+$/);

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
