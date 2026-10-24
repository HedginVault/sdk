/** Meteora DLMM accounts encoded with the Meteora SDK's own IDL, on top of the direct-build chain. */
import { BN, Program } from "@coral-xyz/anchor";
import type { LbClmm } from "@meteora-ag/dlmm";
import { type AccountInfo, type Connection, PublicKey, SYSVAR_CLOCK_PUBKEY } from "@solana/web3.js";
import { getStrategyPda } from "../src/chain/pda";
import { meteora } from "../src/build/meteora";
import { DLMM, LIMIT_ORDER, POOL, POSITION, PROGRAM, SOL, TOKEN_PROGRAM, USDC, VAULT, chain, info, key, mintData, strategy } from "./direct-chain";

const sdk = meteora();
const lbClmm = new Program<LbClmm>(sdk.IDL, { connection: {} as Connection });
type Layout = { layout: { encode(value: unknown, buffer: Buffer): number } };
// Anchor's `encode` writes into a fixed 1000-byte buffer, too small for a position or bin array, so these use its layouts directly.
const layouts = (lbClmm.coder.accounts as unknown as { accountLayouts: Map<string, Layout> }).accountLayouts;

type MeteoraAccount = "lbPair" | "positionV2" | "binArray" | "limitOrder";

function encode(name: MeteoraAccount, fields: Record<string, unknown>, tail = Buffer.alloc(0)): Buffer {
  const discriminator = Buffer.from(lbClmm.idl.accounts?.find((a) => a.name === name)?.discriminator ?? []);
  const size = lbClmm.coder.accounts.size(name);
  const zero = lbClmm.coder.accounts.decode<Record<string, unknown>>(name, Buffer.concat([discriminator, Buffer.alloc(size - 8)]));
  const layout = layouts.get(name);
  if (!layout) throw new Error(`no layout ${name}`);
  const body = Buffer.alloc(size - 8);
  layout.layout.encode({ ...zero, ...fields }, body);
  return Buffer.concat([discriminator, body, tail]);
}

const Q64 = new BN(1).shln(64);
export const ACTIVE_BIN = 100;
export const BIN_STEP = 10;
/** Position bins 90..109: Y (USDC) at and below the active bin, X (SOL) at and above it. */
export const POSITION_RANGE = { lowerBinId: 90, upperBinId: 109 };
export const X_PER_BIN = 1_000_000n;
export const Y_PER_BIN = 2_000_000n;
export const ACTIVE_X = 500_000n;
export const FEE_X_PER_BIN = 10n;
export const FEE_Y_PER_BIN = 20n;
export const RESERVE_X = key(30);
export const RESERVE_Y = key(31);
export const BIN_ARRAY_1 = sdk.deriveBinArray(POOL, new BN(1), DLMM)[0];
export const BIN_ARRAY_0 = sdk.deriveBinArray(POOL, new BN(0), DLMM)[0];
export const BIN_ARRAY_2 = sdk.deriveBinArray(POOL, new BN(2), DLMM)[0];
export const SOL_STRATEGY = getStrategyPda(VAULT, SOL, PROGRAM);
export const NATIVE_LOADER = new PublicKey("NativeLoader1111111111111111111111111111111");

const binAmounts = (binId: number) => ({
  x: binId > ACTIVE_BIN ? X_PER_BIN : binId === ACTIVE_BIN ? ACTIVE_X : 0n,
  y: binId <= ACTIVE_BIN ? Y_PER_BIN : 0n,
});

export const lbPairData = (o: { activeId?: number } = {}) =>
  encode("lbPair", {
    activeId: o.activeId ?? ACTIVE_BIN,
    binStep: BIN_STEP,
    tokenXMint: SOL,
    tokenYMint: USDC,
    reserveX: RESERVE_X,
    reserveY: RESERVE_Y,
  });

/** Bin array `index`; bins 90..109 hold the fixture position's amounts. */
export function binArrayData(index: number) {
  const bins = Array.from({ length: 70 }, (_, i) => {
    const binId = index * 70 + i;
    const inPosition = binId >= POSITION_RANGE.lowerBinId && binId <= POSITION_RANGE.upperBinId;
    const { x, y } = inPosition ? binAmounts(binId) : { x: 0n, y: 0n };
    return { amountX: new BN(x.toString()), amountY: new BN(y.toString()), price: Q64, liquiditySupply: inPosition ? Q64 : new BN(0) };
  });
  const zeroBin = lbClmm.coder.types.decode("bin", Buffer.alloc(144));
  return encode("binArray", { index: new BN(index), lbPair: POOL, bins: bins.map((b) => ({ ...zeroBin, ...b })) });
}

/** The vault's position over `range`, owning every share of its bins, with pending fees. */
export function positionData(range = POSITION_RANGE, owner = VAULT) {
  const zeroFee = lbClmm.coder.types.decode("feeInfo", Buffer.alloc(48));
  const width = range.upperBinId - range.lowerBinId + 1;
  const feeInfos = Array.from({ length: 70 }, (_, i) => {
    const binId = range.lowerBinId + i;
    const { x, y } = i < width ? binAmounts(binId) : { x: 0n, y: 0n };
    return { ...zeroFee, feeXPending: new BN(x > 0n ? FEE_X_PER_BIN.toString() : 0), feeYPending: new BN(y > 0n ? FEE_Y_PER_BIN.toString() : 0) };
  });
  return encode("positionV2", {
    lbPair: POOL,
    owner,
    liquidityShares: Array.from({ length: 70 }, (_, i) => (i < width ? Q64 : new BN(0))),
    feeInfos,
    lowerBinId: range.lowerBinId,
    upperBinId: range.upperBinId,
  });
}

/** A limit order of the vault with an ask resting in bin 105 and an emptied bin 106. */
function limitOrderData() {
  const bin = (binId: number, amount: number) => {
    const data = Buffer.alloc(sdk.LIMIT_ORDER_BIN_DATA_SIZE);
    data.writeBigUInt64LE(BigInt(amount), 0);
    data.writeInt32LE(binId, 16);
    data.writeUInt8(1, 20);
    return data;
  };
  return encode("limitOrder", { lbPair: POOL, owner: VAULT, binCount: 2 }, Buffer.concat([bin(105, 5_000), bin(106, 0)]));
}

function clockData() {
  const data = Buffer.alloc(40);
  data.writeBigUInt64LE(500n, 16);
  data.writeBigInt64LE(1_760_000_000n, 32);
  return data;
}

/** The direct-build chain with a full SOL/USDC pool, its bin arrays, the vault's position and limit order, and SOL's Jupiter strategy. */
export async function dlmmChain(o: { delegatePermissions?: number; solStrategy?: boolean; activeId?: number; positionRange?: typeof POSITION_RANGE } = {}) {
  const accounts = await chain({ permissions: o.delegatePermissions ?? 2, expiresAt: 0 });
  const entries: [PublicKey, AccountInfo<Buffer>][] = [
    [POOL, info(DLMM, lbPairData({ activeId: o.activeId }))],
    [POSITION, info(DLMM, positionData(o.positionRange))],
    [LIMIT_ORDER, info(DLMM, limitOrderData())],
    [BIN_ARRAY_1, info(DLMM, binArrayData(1))],
    [RESERVE_X, info(TOKEN_PROGRAM, Buffer.alloc(165))],
    [RESERVE_Y, info(TOKEN_PROGRAM, Buffer.alloc(165))],
    [SYSVAR_CLOCK_PUBKEY, info(new PublicKey("Sysvar1111111111111111111111111111111111111"), clockData())],
    // Reward mints default to the system program's address, which the SDK reads like any mint.
    [PublicKey.default, info(NATIVE_LOADER, Buffer.alloc(0))],
    [USDC, info(TOKEN_PROGRAM, mintData())],
  ];
  for (const [k, v] of entries) accounts.set(k.toBase58(), v);
  if (o.solStrategy !== false) accounts.set(SOL_STRATEGY.toBase58(), info(PROGRAM, await strategy({ jupiterSwap: { targetMint: SOL } })));
  return accounts;
}
