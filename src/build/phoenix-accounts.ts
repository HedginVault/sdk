import type { Side } from "@ellipsis-labs/rise" with { "resolution-mode": "import" };
import { type AccountInfo, type AccountMeta, PublicKey } from "@solana/web3.js";
import { ApiError } from "../errors";
import { PHOENIX_PROGRAM_ID } from "../signer";
import type { BuildEnv } from "./context";
import { loadRise, type Rise } from "./rise";

// Ported from the app's `server/phoenix.ts`; keep the two in step.

export const PHOENIX_PROGRAM = new PublicKey(PHOENIX_PROGRAM_ID);
export const PHOENIX_GLOBAL_CONFIG = new PublicKey("2zskx2iyCvb6Stg7RBZkt1f6MrF4dpYtMG3yMvKwqtUZ");
/** Phoenix strategies only run on USDC vaults (`InvalidPhoenixDepositMint`). */
export const USDC_MINT = new PublicKey("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");

// `sha256("account:<name>")[..8]`
const GLOBAL_CONFIG_DISCRIMINATOR = Buffer.from([37, 146, 212, 210, 47, 136, 111, 20]);
const TRADER_DISCRIMINATOR = Buffer.from([41, 97, 73, 105, 110, 214, 112, 9]);
const GLOBAL_CONFIG_LEN = 776;
/** Capability bits an onboarded trader holds: place market, deposit, withdraw. Mirrors the program's readiness check. */
const TRADER_READY_FLAGS = (1 << 2) | (1 << 4) | (1 << 5);

export interface PhoenixExchange {
  canonicalMint: PublicKey;
  globalVault: PublicKey;
  perpAssetMap: PublicKey;
  withdrawQueue: PublicKey;
  /** Both trader indexes, headers first, writable: the remaining accounts of every market or collateral CPI. */
  tail: AccountMeta[];
}

export const unavailable = (detail: string) => new ApiError(502, "PhoenixUnavailable", `Phoenix is unavailable right now (${detail}). Try again shortly.`);

const isPhoenix = (info: AccountInfo<Buffer>, discriminator?: Buffer) =>
  info.owner.equals(PHOENIX_PROGRAM) && (!discriminator || info.data.subarray(0, 8).equals(discriminator));
const readKey = (data: Buffer, offset: number) => new PublicKey(data.subarray(offset, offset + 32));
const findPhoenixPda = (seeds: Buffer[]) => PublicKey.findProgramAddressSync(seeds, PHOENIX_PROGRAM)[0];

/** The cross-margin trader `(0, 0)` the program registers for a vault. */
export const getPhoenixTraderAddress = (vault: PublicKey) => findPhoenixPda([Buffer.from("trader"), vault.toBuffer(), Buffer.from([0, 0])]);
/** The trader's take-profit / stop-loss slots; Phoenix creates it on request, so it may not exist. */
export const getPhoenixConditionalOrdersAddress = (traderAccount: PublicKey) =>
  findPhoenixPda([Buffer.from("conditional_orders"), traderAccount.toBuffer()]);
export const getPhoenixSplineAddress = (orderbook: PublicKey) => findPhoenixPda([Buffer.from("spline"), orderbook.toBuffer()]);

export const isTraderReady = (info: AccountInfo<Buffer>) =>
  isPhoenix(info, TRADER_DISCRIMINATOR) && info.data.length >= 100 && (info.data.readUInt32LE(96) & TRADER_READY_FLAGS) === TRADER_READY_FLAGS;

/** 1 RPC: Phoenix's global config, validated by owner, discriminator and length. */
export async function readGlobalConfig(env: Pick<BuildEnv, "connection">) {
  const info = await env.connection.getAccountInfo(PHOENIX_GLOBAL_CONFIG);
  if (!info) throw unavailable("global config not found");
  if (!isPhoenix(info, GLOBAL_CONFIG_DISCRIMINATOR) || info.data.length < GLOBAL_CONFIG_LEN) throw unavailable(`phoenix_decode:${PHOENIX_GLOBAL_CONFIG.toBase58()}`);
  return {
    canonicalMint: readKey(info.data, 296),
    globalVault: readKey(info.data, 328),
    perpAssetMap: readKey(info.data, 360),
    globalTraderIndex: readKey(info.data, 392),
    activeTraderBuffer: readKey(info.data, 424),
    withdrawQueue: readKey(info.data, 472),
  };
}

export const readCanonicalMint = async (env: BuildEnv) => (await readGlobalConfig(env)).canonicalMint;

/**
 * A trader index's header followed by its arenas `PDA([seed, [i]])`. The count, header included, is
 * `min(u16@52, u16@54)` of the header; the program validates the same list, so it is never hard-coded.
 */
function arenaAccounts(header: PublicKey, info: AccountInfo<Buffer> | null, seed: string): PublicKey[] {
  if (!info || !isPhoenix(info) || info.data.length < 56) throw unavailable(`phoenix_decode:${header.toBase58()}`);
  const count = Math.min(info.data.readUInt16LE(52), info.data.readUInt16LE(54));
  if (count < 1) throw unavailable(`phoenix_decode:${header.toBase58()}`);
  return [header, ...Array.from({ length: count - 1 }, (_, i) => findPhoenixPda([Buffer.from(seed), Buffer.from([i + 1])]))];
}

/** 2 RPC: the global configuration, then both trader-index headers for the dynamic tail. */
export async function loadPhoenixExchange(env: BuildEnv): Promise<PhoenixExchange> {
  const { globalTraderIndex, activeTraderBuffer, ...config } = await readGlobalConfig(env);
  const [gti, atb] = await env.connection.getMultipleAccountsInfo([globalTraderIndex, activeTraderBuffer]);
  const tail = [...arenaAccounts(globalTraderIndex, gti ?? null, "global_trader_index"), ...arenaAccounts(activeTraderBuffer, atb ?? null, "active_trader_buffer")];
  return { ...config, tail: tail.map((pubkey) => ({ pubkey, isSigner: false, isWritable: true })) };
}

export interface PhoenixMark {
  markTicks: bigint;
  tickSize: bigint;
  /** Base lots per whole base unit, as a power of ten; may be negative. */
  baseLotDecimals: number;
}

/** Each market's mark by asset id. */
export function decodeMarks(rise: Rise, key: PublicKey, info: AccountInfo<Buffer>): Map<number, PhoenixMark> {
  if (!isPhoenix(info)) throw unavailable(`phoenix_decode:${key.toBase58()}`);
  try {
    return new Map(
      rise.decodePerpAssetMap(info.data).metadata.entries.map(({ value: a }) => [
        Number(a.staticMarketParams.assetId),
        { markTicks: BigInt(a.oraclePrice.markPrice.price.ticks), tickSize: BigInt(a.staticMarketParams.tickSize), baseLotDecimals: a.staticMarketParams.baseLotDecimals },
      ]),
    );
  } catch {
    throw unavailable(`phoenix_decode:${key.toBase58()}`);
  }
}

/** 1 RPC: the market's current mark in ticks, from the perp asset map the order CPI reads. */
export async function loadMarkTicks(env: BuildEnv, ex: PhoenixExchange, assetId: number): Promise<bigint> {
  const [info, rise] = await Promise.all([env.connection.getAccountInfo(ex.perpAssetMap), loadRise()]);
  if (!info) throw unavailable("perp asset map not found");
  const mark = decodeMarks(rise, ex.perpAssetMap, info).get(assetId)?.markTicks;
  if (!mark) throw new ApiError(422, "PhoenixNoMark", "Market has no mark price");
  return mark;
}

export interface PhoenixTrigger {
  triggerTicks: bigint;
  /** The position side the trigger's order closes: an ask closes a long. */
  closes: "long" | "short";
}

/** One slot of the conditional orders account with at least one armed trigger. */
export interface PhoenixConditionalOrder {
  /** Slot in the account; slot 0 is never used. */
  index: number;
  assetId: number;
  greater: PhoenixTrigger | null;
  less: PhoenixTrigger | null;
}

/** Armed slots of a conditional orders account, by account slot index. */
export function decodeConditionalOrders(rise: Rise, key: PublicKey, info: AccountInfo<Buffer>): PhoenixConditionalOrder[] {
  if (!isPhoenix(info)) throw unavailable(`phoenix_decode:${key.toBase58()}`);
  try {
    const collection = rise.decodeConditionalOrderCollection(info.data);
    const trigger = (t: { isActive: boolean; triggerPrice: bigint | number; tradeSide: Side }): PhoenixTrigger | null =>
      t.isActive ? { triggerTicks: BigInt(t.triggerPrice), closes: t.tradeSide === rise.Side.Ask ? "long" : "short" } : null;
    return collection.activeOrderIndices.flatMap((index) => {
      const o = collection.orders[index];
      return o ? [{ index, assetId: o.assetId, greater: trigger(o.greaterTriggerOrder), less: trigger(o.lessTriggerOrder) }] : [];
    });
  } catch {
    throw unavailable(`phoenix_decode:${key.toBase58()}`);
  }
}

export interface TpSlState {
  /** Side of the open position in the market, from the trader account; null when flat. */
  positionSide: "long" | "short" | null;
  /** Armed slots; null when the conditional orders account does not exist yet. */
  orders: PhoenixConditionalOrder[] | null;
}

/** 1 RPC: the trader's position in `assetId` and its armed TP/SL slots. */
export async function loadTpSlState(env: BuildEnv, vault: PublicKey, assetId: number): Promise<TpSlState> {
  const trader = getPhoenixTraderAddress(vault);
  const conditionalOrders = getPhoenixConditionalOrdersAddress(trader);
  const [[traderInfo, ordersInfo], rise] = await Promise.all([env.connection.getMultipleAccountsInfo([trader, conditionalOrders]), loadRise()]);
  if (!traderInfo) throw unavailable("trader account not found");
  if (!isPhoenix(traderInfo, TRADER_DISCRIMINATOR)) throw unavailable(`phoenix_decode:${trader.toBase58()}`);
  let position;
  try {
    position = rise.decodeTrader(traderInfo.data).positions.entries.find(({ key, value }) => BigInt(key) === BigInt(assetId) && BigInt(value.baseLotPosition) !== 0n);
  } catch {
    throw unavailable(`phoenix_decode:${trader.toBase58()}`);
  }
  return {
    positionSide: position ? (BigInt(position.value.baseLotPosition) > 0n ? "long" : "short") : null,
    orders: ordersInfo ? decodeConditionalOrders(rise, conditionalOrders, ordersInfo) : null,
  };
}
