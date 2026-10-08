import { z } from "zod";
import { type ActionRequest, toBuildRequest } from "./actions";
import { ApiError } from "./errors";
import { type ExecuteOptions, type Outcome, executeBuild } from "./executor";
import {
  BuildResponseSchema,
  type BuiltStep,
  ErrorBodySchema,
  type Holdings,
  HoldingsSchema,
  type PoolInfo,
  PoolInfoSchema,
  type PoolSearchPage,
  PoolSearchSchema,
  type Quote,
  QuoteSchema,
  type SendResult,
  SendResponseSchema,
  StatusResponseSchema,
  type Strategy,
  StrategySchema,
  type TokenDetail,
  TokenDetailSchema,
  type TransactionStatus,
  type VaultSummary,
  VaultsResponseSchema,
  vaultData,
} from "./schemas";
import { DEFAULT_MAX_COMPUTE_UNIT_PRICE_MICROLAMPORTS, HEDGE_VAULT_PROGRAM_ID, type TransactionSigner } from "./signer";

const READ_TIMEOUT_MS = 10_000;
// Builders simulate on chain and can call Jupiter, so they get more time.
const WRITE_TIMEOUT_MS = 30_000;

export interface HedgeClientOptions {
  /** `hv1_<id>_<secret>` from the Hedgin admin dashboard. */
  apiKey: string;
  /** Site origin; the docs' base URL (`…/api/external/v1`) also works. Defaults to https://hedgin.xyz. */
  baseUrl?: string;
  /** Override only for a non-production deployment of the program. */
  programId?: string;
  /** Refuse transactions whose priority fee exceeds this. */
  maxComputeUnitPriceMicroLamports?: bigint;
  fetch?: typeof fetch;
}

export interface QuoteRequest {
  vault: string;
  inputMint: string;
  outputMint: string;
  amount: string;
  slippageBps: number;
}

export interface HedgeClient {
  listVaults(): Promise<VaultSummary[]>;
  getHoldings(vault: string): Promise<Holdings>;
  getStrategies(vault: string): Promise<Strategy[]>;
  getQuote(request: QuoteRequest): Promise<Quote>;
  searchPools(vault: string, query: string, page?: number): Promise<PoolSearchPage>;
  /** Any mint's symbol, decimals, and verification, e.g. for a pasted contract address. */
  getToken(vault: string, mint: string): Promise<TokenDetail>;
  /** One pool with its active bin, for choosing a `dlmm/open` range. */
  getPool(vault: string, lbPair: string): Promise<PoolInfo>;
  /**
   * Builds, inspects, signs, sends, and confirms one action, following batches and `next`
   * continuations. Never rebuilds after an ambiguous send.
   */
  execute(request: ActionRequest, signer: TransactionSigner, options?: ExecuteOptions): Promise<Outcome>;
  /** Low-level steps `execute` is made of. Prefer `execute`. */
  build(action: string, body: Record<string, unknown>): Promise<BuiltStep[]>;
  send(signedTransactionBase64: string, ticket: string): Promise<SendResult>;
  status(receipt: string): Promise<TransactionStatus>;
}

export function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, "").replace(/\/api\/external\/v1$/, "");
}

export function createHedgeClient(options: HedgeClientOptions): HedgeClient {
  const fetchImpl = options.fetch ?? fetch;
  const baseUrl = normalizeBaseUrl(options.baseUrl ?? "https://hedgin.xyz");
  const programId = options.programId ?? HEDGE_VAULT_PROGRAM_ID;
  const maxComputeUnitPriceMicroLamports = options.maxComputeUnitPriceMicroLamports ?? DEFAULT_MAX_COMPUTE_UNIT_PRICE_MICROLAMPORTS;

  async function call<T>(path: string, schema: z.ZodType<T>, requestBody?: Record<string, unknown>): Promise<T> {
    const response = await fetchImpl(`${baseUrl}/api/external/v1${path}`, {
      method: requestBody === undefined ? "GET" : "POST",
      headers: {
        Authorization: `Bearer ${options.apiKey}`,
        ...(requestBody === undefined ? {} : { "Content-Type": "application/json" }),
      },
      ...(requestBody === undefined ? {} : { body: JSON.stringify(requestBody) }),
      signal: AbortSignal.timeout(requestBody === undefined ? READ_TIMEOUT_MS : WRITE_TIMEOUT_MS),
    });
    const body: unknown = await response.json().catch(() => null);
    if (!response.ok) {
      const error = ErrorBodySchema.safeParse(body);
      throw error.success
        ? new ApiError(response.status, error.data.error.code, error.data.error.message)
        : new ApiError(response.status, "unexpected_response", `HTTP ${response.status}`);
    }
    const parsed = schema.safeParse(body);
    if (!parsed.success) throw new ApiError(response.status, "contract_mismatch", `Unexpected response shape for ${path.split("?")[0]}`);
    return parsed.data;
  }

  const vaultPath = (vault: string, leaf: string) => `/vaults/${encodeURIComponent(vault)}/${leaf}`;

  const client: HedgeClient = {
    listVaults: async () => (await call("/vaults", VaultsResponseSchema)).vaults,
    getHoldings: async (vault) => (await call(vaultPath(vault, "holdings"), vaultData(HoldingsSchema))).data,
    getStrategies: async (vault) => (await call(vaultPath(vault, "strategies"), vaultData(z.array(StrategySchema)))).data,
    getQuote: async (request) => {
      const query = new URLSearchParams({
        vault: request.vault,
        inputMint: request.inputMint,
        outputMint: request.outputMint,
        amount: request.amount,
        slippageBps: String(request.slippageBps),
      });
      return (await call(`/jupiter/quote?${query}`, vaultData(QuoteSchema))).data;
    },
    searchPools: async (vault, query, page = 1) =>
      (await call(`/dlmm/pools?${new URLSearchParams({ vault, query, page: String(page) })}`, vaultData(PoolSearchSchema))).data,
    getToken: async (vault, mint) =>
      (await call(`/tokens/${encodeURIComponent(mint)}?${new URLSearchParams({ vault })}`, vaultData(TokenDetailSchema))).data,
    getPool: async (vault, lbPair) =>
      (await call(`/dlmm/pools/${encodeURIComponent(lbPair)}?${new URLSearchParams({ vault })}`, vaultData(PoolInfoSchema))).data,
    build: async (action, body) => {
      const { result } = await call(`/transactions/${action}`, BuildResponseSchema, body);
      return Array.isArray(result) ? result : [result];
    },
    send: (transaction, ticket) => call("/transactions/send", SendResponseSchema, { transaction, ticket }),
    status: (receipt) => call(`/transactions/status?${new URLSearchParams({ receipt })}`, StatusResponseSchema),
    execute: (request, signer, executeOptions) =>
      executeBuild(toBuildRequest(request), client, signer, { manager: signer.publicKey, programId, maxComputeUnitPriceMicroLamports }, executeOptions),
  };
  return client;
}
