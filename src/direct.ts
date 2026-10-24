import { type Connection, PublicKey } from "@solana/web3.js";
import { type ActionRequest, toBuildRequest } from "./actions";
import { jupiterConfig } from "./build/jupiter-api";
import { readQuote } from "./build/jupiter-swap";
import type { LocalAction } from "./build/registry";
import { localTransport } from "./build/transport";
import type { QuoteRequest } from "./client";
import { chainContext, hedgeProgram, readRequestQueue, readVaultDetail, readVaults } from "./chain/reads";
import { type ExecuteOptions, type Outcome, executeBuild } from "./executor";
import type { Quote, RequestQueue, VaultDetail, VaultSummary } from "./schemas";
import { DEFAULT_MAX_COMPUTE_UNIT_PRICE_MICROLAMPORTS, HEDGE_VAULT_PROGRAM_ID, type TransactionSigner } from "./signer";

/** An action `DirectHedgeClient.execute` can build without the API. Others need `createHedgeClient`. */
export type DirectActionRequest = Extract<ActionRequest, { action: LocalAction }>;

export interface DirectClientOptions {
  /** Every read goes through this connection; its commitment applies. */
  connection: Connection;
  /** Defaults to the mainnet Hedge Vault program. */
  programId?: string;
  /** Used only for Jupiter token symbols. Defaults to the global fetch. */
  fetch?: typeof fetch;
  /** Sends Jupiter lookups to api.jup.ag with this key instead of the keyless lite-api.jup.ag. */
  jupiterApiKey?: string;
  /** Overrides the Jupiter host for quotes and swaps, as the app's `JUPITER_API_HOST` does. */
  jupiterHost?: string;
  /** Refuse transactions whose priority fee exceeds this. */
  maxComputeUnitPriceMicroLamports?: bigint;
}

/** The reads that work straight from chain, with the same return types as `HedgeClient`. */
export interface DirectHedgeClient {
  /** Every vault of the program, sorted by id. Names are the on-chain names. */
  listVaults(): Promise<VaultSummary[]>;
  getVault(vault: string): Promise<VaultDetail>;
  getRequests(vault: string): Promise<RequestQueue>;
  /** A Jupiter quote for a swap by this vault, slippage capped at the protocol's `maxSlippageBps`. */
  getQuote(request: QuoteRequest): Promise<Quote>;
  /**
   * Builds the action locally from chain state, then inspects, signs, sends and confirms it through
   * the connection, under the same signing policy as `HedgeClient.execute`. Never rebuilds after an
   * ambiguous send.
   */
  execute(request: DirectActionRequest, signer: TransactionSigner, options?: ExecuteOptions): Promise<Outcome>;
}

export function createDirectClient(options: DirectClientOptions): DirectHedgeClient {
  const programId = new PublicKey(options.programId ?? HEDGE_VAULT_PROGRAM_ID);
  const maxComputeUnitPriceMicroLamports = options.maxComputeUnitPriceMicroLamports ?? DEFAULT_MAX_COMPUTE_UNIT_PRICE_MICROLAMPORTS;
  // Wrapped so browsers do not call the global fetch with the context object as `this`.
  const fetcher: typeof fetch = options.fetch ?? ((input, init) => fetch(input, init));
  const ctx = chainContext({ connection: options.connection, programId, fetch: fetcher, jupiterApiKey: options.jupiterApiKey });
  const jupiter = jupiterConfig(options.jupiterApiKey, options.jupiterHost);
  const base = { connection: options.connection, programId, fetch: fetcher, jupiter };
  return {
    listVaults: () => readVaults(ctx),
    getVault: (vault) => readVaultDetail(ctx, vault),
    getRequests: (vault) => readRequestQueue(ctx, vault),
    getQuote: (request) => readQuote({ ...base, program: hedgeProgram(options.connection, programId) }, request),
    execute: (request, signer, executeOptions) =>
      executeBuild(
        toBuildRequest(request),
        localTransport({ ...base, payer: signer.publicKey, now: executeOptions?.now ?? Date.now }),
        signer,
        { manager: signer.publicKey, programId: programId.toBase58(), maxComputeUnitPriceMicroLamports },
        executeOptions,
      ),
  };
}
