import { type Connection, PublicKey } from "@solana/web3.js";
import { chainContext, readRequestQueue, readVaultDetail, readVaults } from "./chain/reads";
import type { RequestQueue, VaultDetail, VaultSummary } from "./schemas";
import { HEDGE_VAULT_PROGRAM_ID } from "./signer";

export interface DirectClientOptions {
  /** Every read goes through this connection; its commitment applies. */
  connection: Connection;
  /** Defaults to the mainnet Hedge Vault program. */
  programId?: string;
  /** Used only for Jupiter token symbols. Defaults to the global fetch. */
  fetch?: typeof fetch;
  /** Sends Jupiter lookups to api.jup.ag with this key instead of the keyless lite-api.jup.ag. */
  jupiterApiKey?: string;
}

/** The reads that work straight from chain, with the same return types as `HedgeClient`. */
export interface DirectHedgeClient {
  /** Every vault of the program, sorted by id. Names are the on-chain names. */
  listVaults(): Promise<VaultSummary[]>;
  getVault(vault: string): Promise<VaultDetail>;
  getRequests(vault: string): Promise<RequestQueue>;
}

export function createDirectClient(options: DirectClientOptions): DirectHedgeClient {
  const ctx = chainContext({
    connection: options.connection,
    programId: new PublicKey(options.programId ?? HEDGE_VAULT_PROGRAM_ID),
    // Wrapped so browsers do not call the global fetch with the context object as `this`.
    fetch: options.fetch ?? ((input, init) => fetch(input, init)),
    jupiterApiKey: options.jupiterApiKey,
  });
  return {
    listVaults: () => readVaults(ctx),
    getVault: (vault) => readVaultDetail(ctx, vault),
    getRequests: (vault) => readRequestQueue(ctx, vault),
  };
}
