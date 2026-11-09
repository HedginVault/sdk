import { BN } from "@coral-xyz/anchor";
import { type Connection, PublicKey, type Transaction } from "@solana/web3.js";
import { z } from "zod";
import { type ChainContext, type VaultPosition, hedgeProgram, readPosition, readVaultState, readVaults } from "./chain/reads";
import { type DepositorRequest, buildDepositorTransaction } from "./chain/requests";
import type { VaultAccount } from "./chain/decode";
import { normalizeBaseUrl } from "./client";
import { ApiError } from "./errors";
import type { VaultDetail, VaultSummary } from "./schemas";
import { DEFAULT_MAX_PRIORITY_FEE_LAMPORTS, HEDGE_VAULT_PROGRAM_ID } from "./signer";

export type { RequestState, RequestView, VaultPosition } from "./chain/reads";

export interface HedgeVaultOptions {
  /** Override only for a non-production deployment of the program. */
  programId?: PublicKey;
  /** Used for Jupiter token symbols. A failed lookup falls back to a short mint symbol. */
  fetch?: typeof fetch;
  /** Sends Jupiter lookups to api.jup.ag with this key instead of the keyless lite-api.jup.ag. */
  jupiterApiKey?: string;
  /** Most a built transaction may pay in priority fee, price × compute unit limit. Defaults to 0.001 SOL. */
  maxPriorityFeeLamports?: bigint;
  /** Hedgin origin whose listed vaults `getAll` returns and `deposit` accepts. Defaults to https://hedgin.xyz. */
  baseUrl?: string;
}

const ListedVaultsSchema = z.object({ vaults: z.array(z.string()) });

/**
 * The vaults hedgin.xyz lists: not hidden by an admin and out of selection. Fails closed, so a deposit never goes to a
 * vault the SDK could not confirm. ponytail: a client-side gate on a public program, anyone can still call it directly.
 */
async function readListedVaults(fetchImpl: typeof fetch, opt: HedgeVaultOptions): Promise<Set<string>> {
  try {
    const response = await fetchImpl(`${normalizeBaseUrl(opt.baseUrl ?? "https://hedgin.xyz")}/api/vaults/listed`);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return new Set(ListedVaultsSchema.parse(await response.json()).vaults);
  } catch (e) {
    throw new ApiError(503, "ListingUnavailable", `Could not read Hedgin's listed vaults: ${e instanceof Error ? e.message : String(e)}`);
  }
}

/** BN at the boundary, bigint inside; the request check then refuses anything that is not a positive u64. */
function baseUnits(value: BN, field: string): bigint {
  if (!BN.isBN(value)) throw new ApiError(400, "Validation", `${field} must be a BN in base units`);
  return BigInt(value.toString());
}

function context(connection: Connection, opt: HedgeVaultOptions): ChainContext {
  const programId = opt.programId ?? new PublicKey(HEDGE_VAULT_PROGRAM_ID);
  return { connection, programId, fetch: opt.fetch ?? fetch, jupiterApiKey: opt.jupiterApiKey, program: hedgeProgram(connection, programId) };
}

/**
 * One Hedge Vault, read from chain through your own RPC. No Hedgin server or API key is involved. Every action returns
 * an unsigned, simulated, checked `Transaction` paid by `user`; send it with `sendAndConfirmTransaction` or your
 * wallet adapter. The SDK never signs or sends.
 */
export class HedgeVault {
  private constructor(
    private readonly ctx: ChainContext,
    /** The vault address. */
    readonly pubkey: PublicKey,
    /** The vault as of the last `create` or `refetchStates`. */
    public state: VaultDetail,
    private account: VaultAccount,
    private readonly tokenProgram: PublicKey,
    private readonly maxPriorityFeeLamports: bigint,
    private readonly opt: HedgeVaultOptions,
  ) {}

  /** Loads a vault. Throws `ApiError` 404 `NotFound` for an address that is not a vault of the program. */
  static async create(connection: Connection, vault: PublicKey, opt: HedgeVaultOptions = {}): Promise<HedgeVault> {
    const ctx = context(connection, opt);
    const { detail, account, tokenProgram } = await readVaultState(ctx, vault);
    return new HedgeVault(ctx, vault, detail, account, tokenProgram, opt.maxPriorityFeeLamports ?? DEFAULT_MAX_PRIORITY_FEE_LAMPORTS, opt);
  }

  /** Every vault Hedgin lists, sorted by id. Uses `getProgramAccounts` and Hedgin's list of listed vaults. */
  static async getAll(connection: Connection, opt: HedgeVaultOptions = {}): Promise<VaultSummary[]> {
    const ctx = context(connection, opt);
    const [vaults, listed] = await Promise.all([readVaults(ctx), readListedVaults(ctx.fetch, opt)]);
    return vaults.filter((v) => listed.has(v.address));
  }

  /** Re-reads the vault into `state`. */
  async refetchStates(): Promise<void> {
    const { detail, account } = await readVaultState(this.ctx, this.pubkey);
    this.state = detail;
    this.account = account;
  }

  /** The user's shares, their value at the last NAV, and any open deposit or withdrawal request. */
  async getPositionByUser(user: PublicKey): Promise<VaultPosition> {
    const { account, position } = await readPosition(this.ctx, this.pubkey, user);
    this.account = account;
    return position;
  }

  /**
   * Queues a deposit of `amount` deposit-mint base units into a vault Hedgin lists; its manager may deposit regardless.
   * A SOL vault wraps whatever native SOL the user's wSOL account is short by.
   */
  async deposit({ user, amount }: { user: PublicKey; amount: BN }): Promise<Transaction> {
    return this.build(user, { action: "deposit/create", vault: this.pubkey, amount: baseUnits(amount, "amount") });
  }

  /** Refunds the user's open deposit request. */
  async cancelDeposit({ user }: { user: PublicKey }): Promise<Transaction> {
    return this.build(user, { action: "deposit/cancel", vault: this.pubkey });
  }

  /** Queues a withdrawal of `shares` share base units. */
  async withdraw({ user, shares }: { user: PublicKey; shares: BN }): Promise<Transaction> {
    return this.build(user, { action: "withdrawal/create", vault: this.pubkey, shares: baseUnits(shares, "shares") });
  }

  /** Returns the user's escrowed shares. */
  async cancelWithdrawal({ user }: { user: PublicKey }): Promise<Transaction> {
    return this.build(user, { action: "withdrawal/cancel", vault: this.pubkey });
  }

  private async build(user: PublicKey, request: DepositorRequest): Promise<Transaction> {
    // UX only: the program refuses anyone else with VaultInSelection.
    if (request.action === "deposit/create" && this.account.selection !== 0 && !this.account.authority.equals(user))
      throw new ApiError(403, "VaultInSelection", "This vault is in selection. Only its manager can deposit.");
    if (request.action === "deposit/create" && !this.account.authority.equals(user) && !(await readListedVaults(this.ctx.fetch, this.opt)).has(this.pubkey.toBase58()))
      throw new ApiError(403, "VaultNotListed", "This vault is not listed on Hedgin, so it takes no deposits through the SDK");
    const vault = { key: this.pubkey, account: this.account, tokenProgram: this.tokenProgram };
    return buildDepositorTransaction(this.ctx, vault, request, user, this.maxPriorityFeeLamports);
  }
}
