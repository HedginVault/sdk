import { BN } from "@coral-xyz/anchor";
import { type AccountMeta, AddressLookupTableAccount, PublicKey, SystemProgram, TransactionInstruction } from "@solana/web3.js";
import { getAssociatedTokenAddress, getConfigPda, getStrategyPda, getSwapAuthorityPda } from "../chain/pda";
import { ApiError } from "../errors";
import type { BuildEnv, VaultCtx } from "./context";
import { type JupiterInstruction, requestQuote, requestSwapInstructions, toInstruction } from "./jupiter-api";

const ROUTE = [229, 23, 203, 151, 122, 227, 173, 42];
const ROUTE_WITH_TOKEN_LEDGER = [150, 86, 71, 116, 167, 93, 14, 104];
const EXACT_OUT_ROUTE = [208, 51, 239, 151, 123, 43, 237, 92];
const SHARED_ACCOUNTS_ROUTE = [193, 32, 155, 51, 65, 214, 156, 129];
const SHARED_ACCOUNTS_EXACT_OUT_ROUTE = [176, 209, 105, 168, 154, 125, 69, 62];
const SHARED_ACCOUNTS_ROUTE_WITH_TOKEN_LEDGER = [230, 121, 143, 80, 119, 159, 106, 170];
const ASSOCIATED_TOKEN_PROGRAM_ID = new PublicKey("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");
const TOKEN_PROGRAM_ID = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
const TOKEN_2022_PROGRAM_ID = new PublicKey("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb");
const PUMP_AMM_PROGRAM_ID = new PublicKey("pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA");
const PUMP_AMM_INIT_USER_VOLUME_ACCUMULATOR = Buffer.from([94, 6, 202, 115, 255, 96, 232, 183]);
const CREATE_IDEMPOTENT = Buffer.from([1]);

/**
 * The cap of a swap that shares its transaction with nothing but its own setup. Jupiter treats the
 * cap as an estimate: at 40 the routes measured stayed under the packet, at 50 they did not.
 */
const SWAP_MAX_ACCOUNTS = 40;

/**
 * Venues that fail when the swap user is a program PDA signing inside a CPI: Kipseli answers
 * `InvalidRealUser`, Obsidian custom error 0xa, Quantum 0x9, and 1DEX wants a system-owned user.
 */
const CPI_REJECTED_DEXES = ["Kipseli", "Obsidian", "Quantum", "1DEX"];

/**
 * The Pump.fun bonding curve takes its SOL by a System transfer from the user, which the vault PDA
 * cannot make because it carries data, so a route through it runs as the vault's swap authority.
 */
const PUMP_FUN = "Pump.fun";

const is = (data: Buffer | number[], discriminator: number[]) => discriminator.every((v, i) => v === data[i]);

/** Quotes Jupiter's best route across every venue that runs under the vault, split and multi-hop included. */
export const quoteSwap = (env: Pick<BuildEnv, "fetch" | "jupiter">, inputMint: PublicKey, outputMint: PublicKey, amount: bigint, slippageBps: number) =>
  requestQuote(env, { inputMint, outputMint, amount, slippageBps, excludeDexes: CPI_REJECTED_DEXES, maxAccounts: SWAP_MAX_ACCOUNTS });

/**
 * Reorders Jupiter's account list into the remaining accounts `jupiter_swap` expects. Some routes
 * repeat the user as a signer; the user is a PDA the program signs for, so no remaining account signs.
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

const createAtaIdempotentIx = (payer: PublicKey, owner: PublicKey, mint: PublicKey, tokenProgram: PublicKey) =>
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
 * from the user, which the PDA cannot do, so the authority creates it first (1 RPC, only for routes that use it).
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

/**
 * 1-2 HTTP and 1-2 RPC: the quote, the route's instructions, its lookup tables, and the Pump.fun AMM
 * accumulator when the route uses it. Refuses any route that needs user-level accounts.
 */
export async function jupiterSwapIx(env: BuildEnv, vault: VaultCtx, delegate: PublicKey | null, mints: SwapMints, amount: bigint, slippageBps: number) {
  const route = await quoteSwap(env, mints.source, mints.destination, amount, slippageBps);
  const swapAuthority = route.view.routeLabels.includes(PUMP_FUN) ? getSwapAuthorityPda(vault.key, env.programId) : null;
  // The account Jupiter swaps as: its token accounts hold the funds while the route runs.
  const user = swapAuthority ?? vault.key;
  const destinationTokenAccount = getAssociatedTokenAddress(user, mints.destination, mints.destinationTokenProgram);
  const res = await requestSwapInstructions(env, route, user, destinationTokenAccount, false);
  const swap = toInstruction(res.swapInstruction);
  // The swap instruction creates the destination ATA itself (`init_if_needed`, paid by the authority),
  // so Jupiter's create of it, funded by the PDA, is redundant.
  const isDestinationCreate = (ix: JupiterInstruction) => {
    const created = userAtaCreate(ix, user);
    return created !== null && created.mint.equals(mints.destination) && created.tokenProgram.equals(mints.destinationTokenProgram);
  };
  const requiredSetup = res.setupInstructions.filter((ix) => !isDestinationCreate(ix));
  // A multi-hop route passes through the user's ATA of each intermediate mint; the authority creates those instead.
  const intermediateAtas = requiredSetup.flatMap((ix) => userAtaCreate(ix, user) ?? []);
  const shared = [SHARED_ACCOUNTS_ROUTE, SHARED_ACCOUNTS_EXACT_OUT_ROUTE, SHARED_ACCOUNTS_ROUTE_WITH_TOKEN_LEDGER].some((d) => is(swap.data, d));
  if (shared || requiredSetup.length > intermediateAtas.length || res.cleanupInstruction)
    throw new ApiError(502, "JupiterUnsupportedCpiRoute", "Jupiter returned a route that requires user-level accounts instead of a direct vault CPI");
  if (res.tokenLedgerInstruction) throw new ApiError(502, "JupiterUnexpectedTokenLedger", "Jupiter returned an unexpected token-ledger instruction");

  const remainingAccounts = extractRemainingAccounts(swap);
  const fromDeposit = mints.source.equals(vault.depositMint);
  const toDeposit = mints.destination.equals(vault.depositMint);
  const args = [swap.data, new BN(amount.toString()), slippageBps] as const;
  const ix = await (swapAuthority ? env.program.methods.jupiterSwapViaAuthority(...args) : env.program.methods.jupiterSwap(...args))
    .accounts({
      authority: env.payer,
      config: getConfigPda(env.programId),
      vault: vault.key,
      // The deposit side is the idle balance and has no strategy; between two target mints the source's rides along.
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
  const [lookupTables, pumpSetup] = await Promise.all([readLookupTables(env, res.addressLookupTableAddresses), pumpAmmSetupIxs(env, user, remainingAccounts)]);
  const setup = [...intermediateAtas.map(({ mint, tokenProgram }) => createAtaIdempotentIx(env.payer, user, mint, tokenProgram)), ...pumpSetup];
  return { ix, lookupTables, setup };
}
