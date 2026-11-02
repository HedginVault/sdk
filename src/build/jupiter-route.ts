import { BN } from "@coral-xyz/anchor";
import { type AccountMeta, AddressLookupTableAccount, ComputeBudgetProgram, PublicKey, SystemProgram, TransactionInstruction } from "@solana/web3.js";
import { z } from "zod";
import type { MinOut } from "../actions";
import { getAssociatedTokenAddress, getConfigPda, getStrategyPda, getSwapAuthorityPda } from "../chain/pda";
import { ApiError } from "../errors";
import { fitsInTransaction, MAX_TX_ACCOUNTS } from "./assemble";
import { amountString, type BuildEnv, type VaultCtx } from "./context";
import { type JupiterInstruction, type JupiterQuote, requestQuote, requestSwapInstructions, toInstruction } from "./jupiter-api";

const ROUTE = [229, 23, 203, 151, 122, 227, 173, 42];
const ROUTE_WITH_TOKEN_LEDGER = [150, 86, 71, 116, 167, 93, 14, 104];
const EXACT_OUT_ROUTE = [208, 51, 239, 151, 123, 43, 237, 92];
const SHARED_ACCOUNTS_ROUTE = [193, 32, 155, 51, 65, 214, 156, 129];
const SHARED_ACCOUNTS_EXACT_OUT_ROUTE = [176, 209, 105, 168, 154, 125, 69, 62];
const SHARED_ACCOUNTS_ROUTE_WITH_TOKEN_LEDGER = [230, 121, 143, 80, 119, 159, 106, 170];
const SET_TOKEN_LEDGER = [228, 85, 185, 112, 78, 79, 77, 2];
const JUPITER_PROGRAM_ID = new PublicKey("JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4");
const ASSOCIATED_TOKEN_PROGRAM_ID = new PublicKey("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");
const TOKEN_PROGRAM_ID = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
const TOKEN_2022_PROGRAM_ID = new PublicKey("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb");
const PUMP_AMM_PROGRAM_ID = new PublicKey("pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA");
const PUMP_AMM_INIT_USER_VOLUME_ACCUMULATOR = Buffer.from([94, 6, 202, 115, 255, 96, 232, 183]);
const CREATE_IDEMPOTENT = Buffer.from([1]);

const is = (data: Buffer | number[], discriminator: number[]) => discriminator.every((v, i) => v === data[i]);

/**
 * Caps the accounts of a route that shares its transaction with zap out's DLMM remove and claim
 * instructions. Every route runs as a CPI beside the vault's own accounts, so an uncapped one can
 * overflow the packet. 30 was measured for the vault-signed swap; the swap authority and its two
 * token accounts add three more, so the route gives up three. Quoted beside `routeMaxAccounts`.
 */
export const JUPITER_MAX_ACCOUNTS = 27;

/**
 * The cap of a swap that shares its transaction with nothing but its own setup, quoted beside
 * `routeMaxAccounts`. Jupiter treats the cap as an estimate: at 40 the routes measured stayed under
 * the packet.
 */
export const SWAP_MAX_ACCOUNTS = 40;

/** The program relays a route behind 8 accounts of its own, and a CPI takes at most 128 account infos. */
const MAX_ROUTE_ACCOUNTS = 128 - 8;

/** Jupiter's `maxAccounts` leaves out each hop's program, so the budget keeps room for this many hops. */
const ROUTE_HOPS = 5;

/**
 * The largest `maxAccounts` whose route keeps the transaction within `MAX_TX_ACCOUNTS`, given the
 * `beside` accounts the rest of it locks. Jupiter hands every leg its accounts through the route, so
 * the swap authority, its two token accounts and the source token program, all among `beside`, are
 * shared rather than added. Jupiter only estimates the cap, so `fitsInTransaction` still decides.
 */
export const routeMaxAccounts = (beside: number) => MAX_TX_ACCOUNTS - (beside - 4) - ROUTE_HOPS;

/** The distinct accounts `ixs` lock in a transaction, with the payer and the compute budget program `assemble` adds. */
export const accountsIn = (payer: PublicKey, ixs: TransactionInstruction[]) =>
  new Set([
    payer.toBase58(),
    ComputeBudgetProgram.programId.toBase58(),
    ...ixs.flatMap((ix) => [ix.programId.toBase58(), ...ix.keys.map((key) => key.pubkey.toBase58())]),
  ]).size;

/**
 * Venues that fail when the swap user is a program PDA signing inside a CPI, whatever the size:
 * Kipseli answers `InvalidRealUser`, Obsidian custom error 0xa, Quantum 0x9, and 1DEX wants a
 * system-owned user. A route through one cannot execute, so it is not a route the vault can take.
 */
const CPI_REJECTED_DEXES = ["Kipseli", "Obsidian", "Quantum", "1DEX"];

/**
 * The least a swap may return: the shown quote's output after its slippage, for the input it was
 * quoted for. A build swapping a different input scales it, so it holds as a price floor.
 */
export const minOutInput: z.ZodType<MinOut, z.ZodTypeDef, unknown> = z
  .object({ inAmount: amountString, minOutAmount: amountString })
  // Refinements run on a dirty object too, so a malformed amount is left to `amountString`'s own issue.
  .refine((m) => !/^\d+$/.test(m.inAmount) || BigInt(m.inAmount) > 0n, "minOut.inAmount must be positive");

/**
 * Quotes Jupiter's best route across every venue that runs under the vault's swap authority, split
 * and multi-hop included, within `maxAccounts`.
 */
export const getQuote = (
  env: Pick<BuildEnv, "fetch" | "jupiter">,
  inputMint: PublicKey,
  outputMint: PublicKey,
  amount: bigint,
  slippageBps: number,
  maxAccounts: number,
): Promise<JupiterQuote> => requestQuote(env, { inputMint, outputMint, amount, slippageBps, excludeDexes: CPI_REJECTED_DEXES, maxAccounts });

/**
 * Quotes every cap at once, best output first. A cap that found the same route as another adds
 * nothing, and one that failed is skipped while another answered; with none, the first cap's error
 * stands.
 */
export async function routesBestFirst(
  env: Pick<BuildEnv, "fetch" | "jupiter">,
  inputMint: PublicKey,
  outputMint: PublicKey,
  amount: bigint,
  slippageBps: number,
  caps: number[],
): Promise<JupiterQuote[]> {
  const settled = await Promise.allSettled([...new Set(caps)].map((cap) => getQuote(env, inputMint, outputMint, amount, slippageBps, cap)));
  const quotes = settled.flatMap((result) => (result.status === "fulfilled" ? [result.value] : []));
  const failed = settled.find((result): result is PromiseRejectedResult => result.status === "rejected");
  if (quotes.length === 0) throw failed?.reason ?? new Error("routesBestFirst needs at least one cap");
  const distinct = [...new Map(quotes.map((quote) => [JSON.stringify(quote.routePlan), quote])).values()];
  return distinct.sort((a, b) => {
    const [outA, outB] = [BigInt(a.view.outAmount), BigInt(b.view.outAmount)];
    return outA === outB ? 0 : outA > outB ? -1 : 1;
  });
}

/**
 * How much more a swap in its own transaction must pay than the zap's in-transaction route before
 * the zap withdraws first and swaps after. Beside DLMM instructions a route keeps only ~27 accounts,
 * which can leave a thin pool as the only route while the deep one needs a few more accounts.
 */
export const SEPARATE_SWAP_MIN_GAIN_BPS = 25;

/** Whether the swap of a transaction of its own pays at least `SEPARATE_SWAP_MIN_GAIN_BPS` more than the zap's. */
export const separateSwapPays = (inBatchOut: bigint, separateOut: bigint) => separateOut * 10_000n >= inBatchOut * BigInt(10_000 + SEPARATE_SWAP_MIN_GAIN_BPS);

/**
 * Builds `routes` in order and returns the first that `fits`. A route Jupiter cannot build for the
 * vault, or one already below the manager's minimum, gives way to the next, and so does one whose
 * accounts the program cannot relay in a CPI. When none fits, the first one built comes back with
 * `fits: false` so the caller can split the transaction; with none built, the first error stands.
 */
export async function firstFitting<T extends { routeAccounts: number }>(
  routes: JupiterQuote[],
  build: (quote: JupiterQuote) => Promise<T>,
  fits: (built: T) => boolean,
): Promise<{ built: T; fits: boolean }> {
  let error: unknown;
  let unfit: T | undefined;
  for (const quote of routes) {
    let built: T;
    try {
      built = await build(quote);
    } catch (e) {
      if (!(e instanceof ApiError)) throw e;
      error ??= e;
      continue;
    }
    if (built.routeAccounts > MAX_ROUTE_ACCOUNTS) continue;
    if (fits(built)) return { built, fits: true };
    unfit ??= built;
  }
  if (unfit) return { built: unfit, fits: false };
  throw error ?? new ApiError(422, "TransactionTooLarge", "Jupiter's route for this swap has more accounts than the vault can relay");
}

/**
 * The slippage a route may still take and return the `minOut` the manager approved, scaled to
 * `amount`. A fresh quote below that floor means the market moved after the quote they saw, so the
 * build stops instead of shipping a worse price inside the same slippage.
 */
export function slippageWithin(outAmount: bigint, amount: bigint, minOut: MinOut, slippageBps: number): number {
  const inAmount = BigInt(minOut.inAmount);
  const floor = (BigInt(minOut.minOutAmount) * amount + inAmount - 1n) / inAmount;
  if (outAmount < floor) throw new ApiError(409, "QuoteMoved", "The price moved past your slippage since the quote. Review the new quote and try again.");
  if (outAmount === 0n) return slippageBps;
  return Math.min(slippageBps, Number(((outAmount - floor) * 10_000n) / outAmount));
}

/**
 * Reorders Jupiter's account list into what the program's `JupiterSwapCpi::swap` expects as remaining
 * accounts. Some routes (Pump.fun AMM) repeat the user among the AMM accounts as a signer. The user is
 * the vault's swap authority, which the program signs for inside the CPI, so no remaining account
 * signs the transaction.
 */
export function extractRemainingAccounts(swapInstruction: TransactionInstruction): AccountMeta[] {
  const { data } = swapInstruction;
  const keys = swapInstruction.keys.map((key) => ({ ...key, isSigner: false }));
  const pick = (...indexes: number[]) => indexes.flatMap((i) => keys[i] ?? []);
  if (is(data, ROUTE)) return keys.slice(9);
  if (is(data, ROUTE_WITH_TOKEN_LEDGER)) return [...pick(7), ...keys.slice(10)];
  if (is(data, EXACT_OUT_ROUTE)) return keys.slice(11);
  if (is(data, SHARED_ACCOUNTS_ROUTE) || is(data, SHARED_ACCOUNTS_EXACT_OUT_ROUTE)) return [...pick(1, 4, 5), ...keys.slice(13)];
  throw new ApiError(502, "JupiterUnknownRoute", "Jupiter picked a route the vault cannot run. Try a different amount or token.");
}

/** 1 RPC. Tables that do not exist are dropped, as the app does. */
async function readLookupTables(env: BuildEnv, addresses: string[]): Promise<AddressLookupTableAccount[]> {
  if (addresses.length === 0) return [];
  const keys = addresses.map((a) => new PublicKey(a));
  const infos = await env.connection.getMultipleAccountsInfo(keys);
  return infos.flatMap((info, i) => {
    const key = keys[i];
    return info && key ? [new AddressLookupTableAccount({ key, state: AddressLookupTableAccount.deserialize(info.data) })] : [];
  });
}

/** 0-1 RPC: the protocol lookup table when configured and active. Unset or inactive yields none, so transactions still build, only larger. */
export async function protocolLookupTables(env: Pick<BuildEnv, "connection" | "protocolLookupTable">): Promise<AddressLookupTableAccount[]> {
  if (!env.protocolLookupTable) return [];
  const { value } = await env.connection.getAddressLookupTable(env.protocolLookupTable);
  return value?.isActive() ? [value] : [];
}

export const createAtaIdempotentIx = (payer: PublicKey, owner: PublicKey, mint: PublicKey, tokenProgram: PublicKey) =>
  new TransactionInstruction({
    programId: ASSOCIATED_TOKEN_PROGRAM_ID,
    keys: [
      { pubkey: payer, isSigner: true, isWritable: true },
      { pubkey: getAssociatedTokenAddress(owner, mint, tokenProgram), isSigner: false, isWritable: true },
      { pubkey: owner, isSigner: false, isWritable: false },
      { pubkey: mint, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: tokenProgram, isSigner: false, isWritable: false },
    ],
    data: CREATE_IDEMPOTENT,
  });

const pumpAmmPda = (seeds: Buffer[]) => PublicKey.findProgramAddressSync(seeds, PUMP_AMM_PROGRAM_ID)[0];

/**
 * A Pump.fun AMM buy needs the user's volume accumulator. When it is missing Jupiter funds its rent
 * with a System transfer from the user, which the PDA cannot make, so the authority creates it first
 * (1 RPC, only for routes that use it).
 */
async function pumpAmmSetupIxs(env: BuildEnv, user: PublicKey, remainingAccounts: AccountMeta[]): Promise<TransactionInstruction[]> {
  const accumulator = pumpAmmPda([Buffer.from("user_volume_accumulator"), user.toBuffer()]);
  if (!remainingAccounts.some((account) => account.pubkey.equals(accumulator))) return [];
  if (await env.connection.getAccountInfo(accumulator)) return [];
  return [
    new TransactionInstruction({
      programId: PUMP_AMM_PROGRAM_ID,
      keys: [
        { pubkey: env.payer, isSigner: true, isWritable: true },
        { pubkey: user, isSigner: false, isWritable: false },
        { pubkey: accumulator, isSigner: false, isWritable: true },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
        { pubkey: pumpAmmPda([Buffer.from("__event_authority")]), isSigner: false, isWritable: false },
        { pubkey: PUMP_AMM_PROGRAM_ID, isSigner: false, isWritable: false },
      ],
      data: PUMP_AMM_INIT_USER_VOLUME_ACCUMULATOR,
    }),
  ];
}

/** A create-idempotent of `user`'s ATA for one of the route's mints, paid by `user`. */
function userAtaCreate(ix: JupiterInstruction, user: PublicKey): { mint: PublicKey; tokenProgram: PublicKey } | null {
  if (ix.programId !== ASSOCIATED_TOKEN_PROGRAM_ID.toBase58() || !Buffer.from(ix.data, "base64").equals(CREATE_IDEMPOTENT) || ix.accounts.length !== 6) return null;
  const [payer, ata, owner, mint, , tokenProgram] = ix.accounts.map((a) => new PublicKey(a.pubkey));
  if (!payer || !ata || !owner || !mint || !tokenProgram) return null;
  const valid =
    payer.equals(user) &&
    owner.equals(user) &&
    (tokenProgram.equals(TOKEN_PROGRAM_ID) || tokenProgram.equals(TOKEN_2022_PROGRAM_ID)) &&
    ata.equals(getAssociatedTokenAddress(user, mint, tokenProgram));
  return valid ? { mint, tokenProgram } : null;
}

export interface SwapMints {
  source: PublicKey;
  destination: PublicKey;
  sourceTokenProgram: PublicKey;
  destinationTokenProgram: PublicKey;
}

/** A token-ledger route must snapshot an unsigned `sourceTokenAccount` into the account the route reads it from. */
function isValidLedger(swap: TransactionInstruction, ledger: TransactionInstruction | null, sourceTokenAccount: PublicKey): ledger is TransactionInstruction {
  return (
    is(swap.data, ROUTE_WITH_TOKEN_LEDGER) &&
    ledger !== null &&
    ledger.programId.equals(JUPITER_PROGRAM_ID) &&
    is(ledger.data, SET_TOKEN_LEDGER) &&
    ledger.keys.length === 2 &&
    !ledger.keys.some((k) => k.isSigner) &&
    ledger.keys[1]?.pubkey.equals(sourceTokenAccount) === true &&
    swap.keys[7]?.pubkey.equals(ledger.keys[0]?.pubkey ?? PublicKey.default) === true
  );
}

/**
 * 1 HTTP and 1-2 RPC: `quote`'s instructions, its lookup tables and the protocol's. Builds a route for
 * `jupiter_swap_via_authority`. The vault never signs a route: Jupiter swaps as the vault's swap
 * authority, whose token accounts hold only what the program lends them for the instruction, so a
 * route's accounts cannot reach the vault's own or its users' escrowed funds. Refuses any route that
 * needs user-level accounts.
 */
async function getJupiterSwap(
  env: BuildEnv,
  vault: VaultCtx,
  mints: SwapMints,
  amount: bigint,
  slippageBps: number,
  useTokenLedger: boolean,
  minOut: MinOut | undefined,
  quote: JupiterQuote,
) {
  // Checked before the build so a moved price costs no second Jupiter call.
  const routeSlippageBps = minOut && slippageWithin(BigInt(quote.view.outAmount), amount, minOut, slippageBps);
  // The account Jupiter swaps as: its token accounts hold the funds while the route runs.
  const user = getSwapAuthorityPda(vault.key, env.programId);
  const sourceTokenAccount = getAssociatedTokenAddress(user, mints.source, mints.sourceTokenProgram);
  const destinationTokenAccount = getAssociatedTokenAddress(user, mints.destination, mints.destinationTokenProgram);
  const res = await requestSwapInstructions(env, quote, user, destinationTokenAccount, useTokenLedger);
  const swap = toInstruction(res.swapInstruction);
  // Every route's args end in `slippage_bps: u16, platform_fee_bps: u8`. Jupiter holds the output to
  // `quoted_out_amount` less that slippage, so a tighter one keeps it at or above the approved floor.
  if (routeSlippageBps !== undefined) swap.data.writeUInt16LE(routeSlippageBps, swap.data.length - 3);
  // Jupiter adds a create-idempotent for a missing destination ATA, funded by the user PDA, which
  // cannot sign here. The swap instruction creates that same ATA (`init_if_needed`, paid by the authority),
  // so exactly that instruction is redundant; any other setup still needs user-level accounts.
  const isDestinationCreate = (ix: JupiterInstruction) => {
    const created = userAtaCreate(ix, user);
    return created !== null && created.mint.equals(mints.destination) && created.tokenProgram.equals(mints.destinationTokenProgram);
  };
  const requiredSetup = res.setupInstructions.filter((ix) => !isDestinationCreate(ix));
  // A multi-hop route passes through the user's ATA of each intermediate mint, which the user PDA
  // cannot fund either. The authority creates those ahead of the swap instead.
  const intermediateAtas = requiredSetup.flatMap((ix) => userAtaCreate(ix, user) ?? []);
  const shared = [SHARED_ACCOUNTS_ROUTE, SHARED_ACCOUNTS_EXACT_OUT_ROUTE, SHARED_ACCOUNTS_ROUTE_WITH_TOKEN_LEDGER].some((d) => is(swap.data, d));
  if (shared || requiredSetup.length > intermediateAtas.length || res.cleanupInstruction)
    throw new ApiError(502, "JupiterUnsupportedCpiRoute", "Jupiter returned a route that requires user-level accounts instead of a direct vault CPI");
  let ledger = res.tokenLedgerInstruction ? toInstruction(res.tokenLedgerInstruction) : null;
  if (useTokenLedger) {
    if (!isValidLedger(swap, ledger, sourceTokenAccount)) throw new ApiError(502, "JupiterInvalidTokenLedger", "Jupiter returned an invalid token-ledger route");
    // Earlier instructions pay into the vault's own source account, and the program lends what
    // arrived there since the snapshot, so the ledger records that account, not the swap
    // authority's one Jupiter built it for.
    ledger = new TransactionInstruction({
      programId: JUPITER_PROGRAM_ID,
      keys: [
        { pubkey: ledger.keys[0]?.pubkey ?? PublicKey.default, isSigner: false, isWritable: true },
        { pubkey: getAssociatedTokenAddress(vault.key, mints.source, mints.sourceTokenProgram), isSigner: false, isWritable: false },
      ],
      data: Buffer.from(SET_TOKEN_LEDGER),
    });
  } else if (ledger) throw new ApiError(502, "JupiterUnexpectedTokenLedger", "Jupiter returned an unexpected token-ledger instruction");
  return {
    swapData: swap.data,
    remainingAccounts: extractRemainingAccounts(swap),
    // The protocol table carries the programs, config and common mints every swap locks.
    lookupTables: (await Promise.all([readLookupTables(env, res.addressLookupTableAddresses), protocolLookupTables(env)])).flat(),
    tokenLedgerInstruction: ledger,
    intermediateAtas,
    swapAuthority: user,
  };
}

/** Runs ahead of the swap: the ATAs a multi-hop route passes through, paid by the authority, and Pump.fun AMM's account. */
async function swapSetupIxs(env: BuildEnv, user: PublicKey, intermediateAtas: { mint: PublicKey; tokenProgram: PublicKey }[], remainingAccounts: AccountMeta[]) {
  const atas = intermediateAtas.map(({ mint, tokenProgram }) => createAtaIdempotentIx(env.payer, user, mint, tokenProgram));
  return [...atas, ...(await pumpAmmSetupIxs(env, user, remainingAccounts))];
}

/**
 * `jupiter_swap_via_authority` relaying `swapData` over `remainingAccounts`, the route's accounts. A
 * deposit mint side is the idle balance and has no strategy, so `strategy` tracks the other mint.
 * Between two target mints it is the destination's and the source's own strategy rides along.
 */
const swapViaAuthorityIx = (
  env: BuildEnv,
  vault: VaultCtx,
  delegate: PublicKey | null,
  mints: SwapMints,
  amount: bigint,
  slippageBps: number,
  swapData: Buffer,
  remainingAccounts: AccountMeta[],
) => {
  const fromDeposit = mints.source.equals(vault.depositMint);
  const toDeposit = mints.destination.equals(vault.depositMint);
  return env.program.methods
    .jupiterSwapViaAuthority(swapData, new BN(amount.toString()), slippageBps)
    .accounts({
      authority: env.payer,
      config: getConfigPda(env.programId),
      vault: vault.key,
      strategy: getStrategyPda(vault.key, toDeposit ? mints.source : mints.destination, env.programId),
      sourceStrategy: fromDeposit || toDeposit ? null : getStrategyPda(vault.key, mints.source, env.programId),
      sourceMint: mints.source,
      destinationMint: mints.destination,
      sourceTokenProgram: mints.sourceTokenProgram,
      destinationTokenProgram: mints.destinationTokenProgram,
      delegate,
    })
    .remainingAccounts(remainingAccounts)
    .instruction();
};

/**
 * The best-paying route that fits in a transaction of its own, from Jupiter's routes at the default
 * cap and at the most accounts this swap leaves room for. `quote` is the route taken. 2 quotes, then
 * per route tried 1 HTTP and 1-3 RPC.
 */
export async function jupiterSwapIx(
  env: BuildEnv,
  vault: VaultCtx,
  delegate: PublicKey | null,
  mints: SwapMints,
  amount: bigint,
  slippageBps: number,
  minOut?: MinOut,
) {
  const relay = (swapData: Buffer, remainingAccounts: AccountMeta[]) => swapViaAuthorityIx(env, vault, delegate, mints, amount, slippageBps, swapData, remainingAccounts);
  const beside = accountsIn(env.payer, [await relay(Buffer.alloc(0), [])]);
  const routes = await routesBestFirst(env, mints.source, mints.destination, amount, slippageBps, [SWAP_MAX_ACCOUNTS, routeMaxAccounts(beside)]);
  const { built, fits } = await firstFitting(
    routes,
    async (quote) => {
      const swap = await getJupiterSwap(env, vault, mints, amount, slippageBps, false, minOut, quote);
      return {
        ix: await relay(swap.swapData, swap.remainingAccounts),
        lookupTables: swap.lookupTables,
        setup: await swapSetupIxs(env, swap.swapAuthority, swap.intermediateAtas, swap.remainingAccounts),
        quote: quote.view,
        routeAccounts: swap.remainingAccounts.length,
      };
    },
    (swap) => fitsInTransaction(env.payer, [...swap.setup, swap.ix], swap.lookupTables),
  );
  if (!fits) throw new ApiError(422, "TransactionTooLarge", "Jupiter swap does not fit in a v0 transaction");
  return built;
}

/**
 * Captures the vault source balance before earlier transaction instructions add tokens. The program
 * then lends the swap authority only that in-transaction increase, at most `quotedAmount`, and
 * swaps it as a plain route, preserving every idle source token. Both must share one transaction.
 * Takes the best-paying route that fits beside `alongside`, the rest of the transaction; `fits: false`
 * when none does.
 */
export async function jupiterTokenLedgerSwapIx(
  env: BuildEnv,
  vault: VaultCtx,
  delegate: PublicKey | null,
  mints: SwapMints,
  quotedAmount: bigint,
  slippageBps: number,
  minOut?: MinOut,
  alongside: TransactionInstruction[] = [],
) {
  const relay = (swapData: Buffer, remainingAccounts: AccountMeta[]) =>
    swapViaAuthorityIx(env, vault, delegate, mints, quotedAmount, slippageBps, swapData, remainingAccounts);
  // the ledger account comes with the route but is no account of an inner swap, so the cap leaves it out
  const beside = accountsIn(env.payer, [await relay(Buffer.alloc(0), []), ...alongside]) + 1;
  const routes = await routesBestFirst(env, mints.source, mints.destination, quotedAmount, slippageBps, [JUPITER_MAX_ACCOUNTS, routeMaxAccounts(beside)]);
  const { built, fits } = await firstFitting(
    routes,
    async (quote) => {
      const swap = await getJupiterSwap(env, vault, mints, quotedAmount, slippageBps, true, minOut, quote);
      if (!swap.tokenLedgerInstruction) throw new ApiError(502, "JupiterInvalidTokenLedger", "Jupiter did not return a token-ledger instruction");
      return {
        ix: await relay(swap.swapData, swap.remainingAccounts),
        tokenLedgerInstruction: swap.tokenLedgerInstruction,
        lookupTables: swap.lookupTables,
        setup: await swapSetupIxs(env, swap.swapAuthority, swap.intermediateAtas, swap.remainingAccounts),
        // the program splits the ledger off before relaying the route
        routeAccounts: swap.remainingAccounts.length - 1,
      };
    },
    (swap) => fitsInTransaction(env.payer, [...alongside, ...swap.setup, swap.tokenLedgerInstruction, swap.ix], swap.lookupTables),
  );
  return { ...built, fits };
}
