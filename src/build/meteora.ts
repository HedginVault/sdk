import { BN } from "@coral-xyz/anchor";
import { PublicKey, type TransactionInstruction } from "@solana/web3.js";
import { tokenInfo } from "../chain/decode";
import { type Ctx, jupiterSymbols } from "../chain/reads";
import { ApiError } from "../errors";
import type { PoolInfo } from "../schemas";
import type { BuildEnv } from "./context";

export type Meteora = typeof import("@meteora-ag/dlmm");
export type Pool = InstanceType<Meteora["default"]>;
export type PositionData = Awaited<ReturnType<Pool["getPosition"]>>["positionData"];

/**
 * Required on first DLMM use, so `require("@hedginxyz/sdk")` does not load Meteora's SDK and its own
 * Anchor copy for callers who never touch DLMM. Node caches the module.
 */
export const meteora = (): Meteora => require("@meteora-ag/dlmm");

/** The CJS build replaces `module.exports` with the DLMM class, so `.default` is undefined there; the ESM build keeps it. */
const dlmmClass = (sdk: Meteora): Meteora["default"] => sdk.default ?? (sdk as unknown as Meteora["default"]);

/**
 * ~3 batched RPC: the pool, its bitmap extension and the clock, then reserves and mints. The SDK
 * throws a plain Error for a key that is not a usable lbPair; both cases are the caller's wrong account.
 */
export async function readPool(env: Pick<BuildEnv, "connection">, lbPair: PublicKey): Promise<Pool> {
  try {
    const [pool] = await dlmmClass(meteora()).createMultiple(env.connection, [lbPair]);
    if (!pool) throw new Error("LB Pair not found");
    return pool;
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    if (/not found/i.test(message)) throw new ApiError(404, "NotFound", "LB pair not found");
    if (/discriminator/i.test(message)) throw new ApiError(404, "NotFound", "Account is not an LB pair");
    throw e;
  }
}

/** `initialize_bin_array` for each of `indexes` that does not exist yet (1 batched RPC). */
export async function missingBinArrayIxs(env: BuildEnv, pool: Pool, indexes: BN[]): Promise<TransactionInstruction[]> {
  if (indexes.length === 0) return [];
  const { deriveBinArray } = meteora();
  const keys = indexes.map((i) => deriveBinArray(pool.pubkey, i, pool.program.programId)[0]);
  const infos = await env.connection.getMultipleAccountsInfo(keys);
  // The SDK's `initializeBinArrays` reads each array again and simulates a compute-budget instruction; `assemble` owns both.
  return Promise.all(
    indexes.flatMap((index, i) => {
      const binArray = keys[i];
      if (infos[i] || !binArray) return [];
      return [pool.program.methods.initializeBinArray(index).accountsPartial({ binArray, funder: env.payer, lbPair: pool.pubkey }).instruction()];
    }),
  );
}

/** Bin arrays a contiguous inclusive range touches that do not exist yet. */
export const missingRangeBinArrayIxs = (env: BuildEnv, pool: Pool, lowerBinId: number, upperBinId: number) =>
  missingBinArrayIxs(env, pool, meteora().getBinArrayIndexesCoverage(new BN(lowerBinId), new BN(upperBinId)));

/** `amount` of `token` less the Token-2022 transfer fee at the current epoch (1 RPC). */
export async function excludingTransferFee(env: BuildEnv, token: Pool["tokenX"], amount: bigint): Promise<bigint> {
  const { epoch } = await env.connection.getEpochInfo("confirmed");
  return BigInt(meteora().calculateTransferFeeExcludedAmount(new BN(amount.toString()), token.mint, epoch).amount.toString());
}

/** 2 RPC: the position, then the clock and its bin arrays. Amounts and fees per bin and in total, in base units. */
export async function readPositionData(pool: Pool, position: PublicKey): Promise<PositionData> {
  return (await pool.getPosition(position)).positionData;
}

/** ~3 RPC and 1 HTTP: a pool with its live active bin and price (token Y per token X), and Jupiter's symbols. */
export async function readPoolInfo(ctx: Ctx, address: string): Promise<PoolInfo> {
  let lbPair: PublicKey;
  try {
    lbPair = new PublicKey(address);
  } catch {
    throw new ApiError(400, "Validation", "lbPair must be a public key");
  }
  const pool = await readPool(ctx, lbPair);
  const { tokenX, tokenY, lbPair: state } = pool;
  const symbols = await jupiterSymbols(ctx, [tokenX.publicKey.toBase58(), tokenY.publicKey.toBase58()]);
  const token = (t: Pool["tokenX"]) => tokenInfo(t.publicKey.toBase58(), t.mint.decimals, symbols.get(t.publicKey.toBase58()));
  return {
    lbPair: lbPair.toBase58(),
    tokenX: token(tokenX),
    tokenY: token(tokenY),
    binStep: state.binStep,
    activeBinId: state.activeId,
    activePrice: pool.fromPricePerLamport((1 + state.binStep / 10_000) ** state.activeId),
  };
}
