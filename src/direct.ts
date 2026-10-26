import { type Connection, PublicKey, VersionedTransaction } from "@solana/web3.js";
import type { ActionRequest } from "./actions";
import { jupiterConfig } from "./build/jupiter-api";
import { readQuote } from "./build/jupiter-swap";
import { DEFAULT_PHOENIX_API_URL, phoenixOnboardTransport } from "./build/phoenix-api";
import { readPoolInfo } from "./build/meteora";
import { readPhoenix } from "./build/phoenix-read";
import type { InstructionSet } from "./build/assemble";
import { type InstructionAction, type LocalAction, isInstructionAction } from "./build/registry";
import { instructionsLocal, localTransport } from "./build/transport";
import type { QuoteRequest } from "./client";
import { chainContext, hedgeProgram, readRequestQueue, readVaultDetail, readVaults } from "./chain/reads";
import { type ExecuteOptions, type ExecutionTransport, type Outcome, executeBuild, executePhoenixOnboard } from "./executor";
import type { BuiltStep, PhoenixManager, PoolInfo, Quote, RequestQueue, VaultDetail, VaultSummary } from "./schemas";
import { DEFAULT_MAX_COMPUTE_UNIT_PRICE_MICROLAMPORTS, HEDGE_VAULT_PROGRAM_ID, type TransactionSigner } from "./signer";

/** An action the direct client builds without the API. Others need `createHedgeClient`. */
export type DirectActionRequest = Extract<ActionRequest, { action: LocalAction }>;

/** One method per action, named after its path: `jupiter/swap` is `jupiterSwap`. */
export const DIRECT_ACTIONS = {
  vaultInitialize: "vault/initialize",
  vaultUpdate: "vault/update",
  vaultClaimFee: "vault/claim-fee",
  vaultClose: "vault/close",
  strategyClose: "strategy/close",
  jupiterInitialize: "jupiter/initialize",
  jupiterSwap: "jupiter/swap",
  jupiterSweep: "jupiter/sweep",
  phoenixInitialize: "phoenix/initialize",
  phoenixDeposit: "phoenix/deposit",
  phoenixWithdraw: "phoenix/withdraw",
  phoenixSweep: "phoenix/sweep",
  phoenixOrder: "phoenix/order",
  phoenixTpSl: "phoenix/tpsl",
  phoenixCancel: "phoenix/cancel",
  dlmmInitialize: "dlmm/initialize",
  dlmmOpen: "dlmm/open",
  dlmmAdd: "dlmm/add",
  dlmmRemove: "dlmm/remove",
  dlmmFlip: "dlmm/flip",
  dlmmClaimFee: "dlmm/claim-fee",
  dlmmZapOut: "dlmm/zap-out",
  dlmmClose: "dlmm/close",
  dlmmLimitOrderPlace: "dlmm/limit-order/place",
  dlmmLimitOrderCancel: "dlmm/limit-order/cancel",
} as const satisfies Record<string, DirectActionRequest["action"]>;

type DirectActions = typeof DIRECT_ACTIONS;

/** The parameters of one action: its `ActionRequest` without `action`, each variant kept apart. */
export type ActionParams<A extends DirectActionRequest["action"]> = Extract<DirectActionRequest, { action: A }> extends infer R
  ? R extends { action: A }
    ? Omit<R, "action">
    : never
  : never;

export interface BuildOptions {
  /** Fee payer and acting authority: the vault authority or one of its delegates. The wallet that later signs. */
  payer: PublicKey;
  /** Milliseconds since the epoch; defaults to `Date.now`. */
  now?: () => number;
}

/** One built transaction: unsigned by the payer, already simulated, with a recent blockhash. */
export interface UnsignedStep {
  transaction: VersionedTransaction;
  simulation: { unitsConsumed: number; deferred?: boolean };
  blockhash: string;
  /** Consecutive marked steps may be sent together; an unmarked step waits for the ones before it. */
  sendConcurrently?: boolean;
  /** A follow-up build `send` runs once this step confirms. */
  next?: { path: string; body: Record<string, unknown> };
  /** What the step creates or changes, such as `vault`, `position` or `limitOrder`. */
  [field: string]: unknown;
}

/**
 * An action's unsigned transactions, in send order. Sign them within about a minute, before the
 * blockhash expires. `send` signs, sends, confirms, and builds any follow-up step itself.
 */
export interface UnsignedBuild {
  action: LocalAction;
  payer: PublicKey;
  steps: UnsignedStep[];
}

type BuildMethods = { [K in keyof DirectActions]: (params: ActionParams<DirectActions[K]>, options: BuildOptions) => Promise<UnsignedBuild> };

type InstructionMethodName = { [K in keyof DirectActions]: DirectActions[K] extends InstructionAction ? K : never }[keyof DirectActions];

/**
 * The raw instructions of the actions that always fit one transaction, for composing your own. No
 * compute budget, priority fee, blockhash or simulation. Multi-transaction actions (swaps, DLMM
 * liquidity, limit-order placing) split by simulated compute, so only their built form exists.
 */
type InstructionMethods = {
  [K in InstructionMethodName]: (params: ActionParams<DirectActions[K]>, options: BuildOptions) => Promise<InstructionSet>;
};

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

/**
 * Reads straight from chain with `HedgeClient`'s return types, and every local action in three layers:
 * `instructions.<action>` (raw instructions), `<action>` (unsigned transactions), `send` (sign and land).
 * A build throws `ApiError` for a bad request or a failed simulation; `send` reports its result as an `Outcome`.
 */
export interface DirectHedgeClient extends BuildMethods {
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
  instructions: InstructionMethods;
  /**
   * Inspects every step under `HedgeClient.execute`'s signing policy, then signs, sends and confirms
   * them through the connection, building and sending any follow-up step the action needs. The
   * signer must be the build's payer. Never rebuilds after an ambiguous send.
   */
  send(build: UnsignedBuild, signer: TransactionSigner, options?: ExecuteOptions): Promise<Outcome>;
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
  const buildContext = (payer: PublicKey, now: (() => number) | undefined) => ({ ...base, payer, now: now ?? Date.now });

  const build = async (action: LocalAction, params: object, { payer, now }: BuildOptions): Promise<UnsignedBuild> => {
    const steps = await localTransport(buildContext(payer, now)).build(action, { ...params });
    return { action, payer, steps: steps.map(({ ticket: _ticket, ...step }) => ({ ...step, transaction: VersionedTransaction.deserialize(Buffer.from(step.transaction, "base64")) })) };
  };
  const builders = Object.fromEntries(
    Object.entries(DIRECT_ACTIONS).map(([name, action]) => [name, (params: object, options: BuildOptions) => build(action, params, options)]),
  ) as BuildMethods;
  const instructions = Object.fromEntries(
    Object.entries(DIRECT_ACTIONS).flatMap(([name, action]) =>
      isInstructionAction(action)
        ? [[name, (params: object, { payer, now }: BuildOptions) => instructionsLocal(buildContext(payer, now), action, { ...params })]]
        : [],
    ),
  ) as InstructionMethods;

  return {
    ...builders,
    instructions,
    listVaults: () => readVaults(ctx),
    getVault: (vault) => readVaultDetail(ctx, vault),
    getRequests: (vault) => readRequestQueue(ctx, vault),
    getPhoenix: (vault) => readPhoenix(reads, vault),
    getQuote: (request) => readQuote(reads, request),
    getPool: (_vault, lbPair) => readPoolInfo(ctx, lbPair),
    send: (built, signer, executeOptions) => {
      if (!built.payer.equals(signer.publicKey)) return Promise.resolve({ kind: "refused", signatures: [], reason: "The signer is not this build's payer" });
      const transport = localTransport(buildContext(signer.publicKey, executeOptions?.now));
      return executeBuild({ action: built.action, body: {} }, startingWith(built, transport), signer, policy(signer), executeOptions);
    },
    onboardPhoenix: (vault, signer, executeOptions) =>
      executePhoenixOnboard(vault, phoenixOnboardTransport(buildContext(signer.publicKey, executeOptions?.now), vault), signer, policy(signer), executeOptions),
  };
}

/** `transport`, except its first build answers with the steps already built. */
function startingWith(built: UnsignedBuild, transport: ExecutionTransport): ExecutionTransport {
  let first: BuiltStep[] | undefined = built.steps.map((step) => ({
    ...step,
    transaction: Buffer.from(step.transaction.serialize()).toString("base64"),
    ticket: "local",
  }));
  return {
    ...transport,
    build: async (action, body) => {
      if (!first) return transport.build(action, body);
      const steps = first;
      first = undefined;
      return steps;
    },
  };
}
