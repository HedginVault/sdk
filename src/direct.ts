import { type Connection, PublicKey } from "@solana/web3.js";
import { type ActionRequest, toBuildRequest } from "./actions";
import { jupiterConfig } from "./build/jupiter-api";
import { readQuote } from "./build/jupiter-swap";
import { DEFAULT_PHOENIX_API_URL, phoenixOnboardTransport } from "./build/phoenix-api";
import { readPoolInfo } from "./build/meteora";
import { readPhoenix } from "./build/phoenix-read";
import type { LocalAction } from "./build/registry";
import { localTransport } from "./build/transport";
import type { QuoteRequest } from "./client";
import { chainContext, hedgeProgram, readRequestQueue, readVaultDetail, readVaults } from "./chain/reads";
import { type ExecuteOptions, type Outcome, executeBuild, executePhoenixOnboard } from "./executor";
import type { PhoenixManager, PoolInfo, Quote, RequestQueue, VaultDetail, VaultSummary } from "./schemas";
import { DEFAULT_MAX_COMPUTE_UNIT_PRICE_MICROLAMPORTS, HEDGE_VAULT_PROGRAM_ID, type TransactionSigner } from "./signer";

/** An action `DirectHedgeClient.execute` can build without the API. Others need `createHedgeClient`. */
export type DirectActionRequest = Extract<ActionRequest, { action: LocalAction }>;

export interface DirectClientOptions {
  /** Every read goes through this connection; its commitment applies. */
  connection: Connection;
  /** Defaults to the mainnet Hedge Vault program. */
  programId?: string;
  /** Used for Jupiter and Phoenix HTTP calls. Defaults to the global fetch. */
  fetch?: typeof fetch;
  /** Sends Jupiter lookups to api.jup.ag with this key instead of the keyless lite-api.jup.ag. */
  jupiterApiKey?: string;
  /** Overrides the Jupiter host for quotes and swaps, as the app's `JUPITER_API_HOST` does. */
  jupiterHost?: string;
  /** Phoenix's perp-api, for market parameters and trader onboarding. Defaults to https://perp-api.phoenix.trade. */
  phoenixApiUrl?: string;
  /** Refuse transactions whose priority fee exceeds this. */
  maxComputeUnitPriceMicroLamports?: bigint;
  /**
   * The protocol address lookup table, as the app's `PROTOCOL_LOOKUP_TABLE`. DLMM withdrawals with a
   * zap and `dlmm/zap-out` use it to fit their swap; without it they still build, only larger.
   */
  protocolLookupTable?: string;
}

/** The reads that work straight from chain, with the same return types as `HedgeClient`. */
export interface DirectHedgeClient {
  /** Every vault of the program, sorted by id. Names are the on-chain names. */
  listVaults(): Promise<VaultSummary[]>;
  getVault(vault: string): Promise<VaultDetail>;
  getRequests(vault: string): Promise<RequestQueue>;
  /** Phoenix onboarding status, markets, open orders, and margin, from chain and Phoenix's perp-api. */
  getPhoenix(vault: string): Promise<PhoenixManager>;
  /** A Jupiter quote for a swap by this vault, slippage capped at the protocol's `maxSlippageBps`. */
  getQuote(request: QuoteRequest): Promise<Quote>;
  /** One DLMM pool with its active bin, read from chain, for choosing a `dlmm/open` range. `vault` is unused; it keeps `HedgeClient`'s signature. */
  getPool(vault: string, lbPair: string): Promise<PoolInfo>;
  /**
   * Builds the action locally from chain state, then inspects, signs, sends and confirms it through
   * the connection, under the same signing policy as `HedgeClient.execute`. Never rebuilds after an
   * ambiguous send.
   */
  execute(request: DirectActionRequest, signer: TransactionSigner, options?: ExecuteOptions): Promise<Outcome>;
  /**
   * Registers the vault's Phoenix trader after `phoenix/initialize`. Phoenix builds the transaction and
   * co-signs it on submit, so this signs only a Phoenix-only transaction paid by the signer, sends it to
   * Phoenix rather than the connection, and confirms it through the connection. Never resubmits.
   */
  onboardPhoenix(vault: string, signer: TransactionSigner, options?: ExecuteOptions): Promise<Outcome>;
}

export function createDirectClient(options: DirectClientOptions): DirectHedgeClient {
  const programId = new PublicKey(options.programId ?? HEDGE_VAULT_PROGRAM_ID);
  const maxComputeUnitPriceMicroLamports = options.maxComputeUnitPriceMicroLamports ?? DEFAULT_MAX_COMPUTE_UNIT_PRICE_MICROLAMPORTS;
  // Wrapped so browsers do not call the global fetch with the context object as `this`.
  const fetcher: typeof fetch = options.fetch ?? ((input, init) => fetch(input, init));
  const ctx = chainContext({ connection: options.connection, programId, fetch: fetcher, jupiterApiKey: options.jupiterApiKey });
  const jupiter = jupiterConfig(options.jupiterApiKey, options.jupiterHost);
  const protocolLookupTable = options.protocolLookupTable?.trim();
  const base = {
    connection: options.connection,
    programId,
    fetch: fetcher,
    jupiter,
    phoenixApiUrl: options.phoenixApiUrl?.trim() || DEFAULT_PHOENIX_API_URL,
    ...(protocolLookupTable && { protocolLookupTable: new PublicKey(protocolLookupTable) }),
  };
  const reads = { ...base, program: hedgeProgram(options.connection, programId) };
  const policy = (signer: TransactionSigner) => ({ manager: signer.publicKey, programId: programId.toBase58(), maxComputeUnitPriceMicroLamports });
  const buildContext = (signer: TransactionSigner, executeOptions?: ExecuteOptions) => ({ ...base, payer: signer.publicKey, now: executeOptions?.now ?? Date.now });
  return {
    listVaults: () => readVaults(ctx),
    getVault: (vault) => readVaultDetail(ctx, vault),
    getRequests: (vault) => readRequestQueue(ctx, vault),
    getPhoenix: (vault) => readPhoenix(reads, vault),
    getQuote: (request) => readQuote(reads, request),
    getPool: (_vault, lbPair) => readPoolInfo(ctx, lbPair),
    execute: (request, signer, executeOptions) =>
      executeBuild(toBuildRequest(request), localTransport(buildContext(signer, executeOptions)), signer, policy(signer), executeOptions),
    onboardPhoenix: (vault, signer, executeOptions) =>
      executePhoenixOnboard(vault, phoenixOnboardTransport(buildContext(signer, executeOptions), vault), signer, policy(signer), executeOptions),
  };
}
