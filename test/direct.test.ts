import { BN, Program } from "@coral-xyz/anchor";
import { type AccountInfo, type Connection, type GetProgramAccountsConfig, PublicKey } from "@solana/web3.js";
import bs58 from "bs58";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDirectClient } from "../src/direct";
import { ApiError } from "../src/errors";
import idl from "../src/idl/hedge_vault.json";
import type { HedgeVault } from "../src/idl/hedge_vault";
import { getConfigPda, getShareMintPda, getVaultPda } from "../src/chain/pda";

const coder = new Program<HedgeVault>(idl as HedgeVault, { connection: {} as Connection }).coder.accounts;

const PROGRAM = new PublicKey("r2ahBQ6gbPCJ9FxBymYcXuwXi8NmenRry7SE7QR7FAt");
const OTHER_PROGRAM = new PublicKey(Buffer.alloc(32, 12));
const TOKEN_PROGRAM = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
const key = (n: number) => new PublicKey(Buffer.alloc(32, n));
const HUSD = key(7);
const USDC = new PublicKey("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
const MANAGER = key(9);
const ALICE = key(10);
const BOB = key(11);
const VAULT_1 = new PublicKey("5brsTu4AgKjUdE29bbRcPAy1VyVb1SGjH8qEjzEwu68a");
const VAULT_2 = new PublicKey("CxmmBfsCK1NJVMVga2oewCHr34AVV2mPw9WtdAggwxAE");
const CONFIG = new PublicKey("4E8ZZo4pXGLyW76vJaWVsSG6xMoLevZq3tpECH5ssGC6");
const EPOCH = 14_400;

const bytes = (n: number) => Array<number>(n).fill(0);
const nameBytes = (s: string) => [...Buffer.from(s), ...bytes(32 - s.length)];

function vaultFields(id: number, overrides: Record<string, unknown> = {}) {
  return {
    id: new BN(id),
    authority: MANAGER,
    name: nameBytes("Alpha"),
    reservedKeys: bytes(64),
    depositMint: HUSD,
    shareMint: PublicKey.default,
    depositCap: new BN("18446744073709551615"),
    totalAssets: new BN("2500000000"),
    navPerShare: new BN("1050000000"),
    highWaterMark: new BN("1100000000"),
    navEpoch: new BN(1000),
    lastNavTs: new BN(1000 * EPOCH + 300),
    pendingDeposits: new BN("40000000"),
    pendingWithdrawalShares: new BN("7000000"),
    unclaimedManagerFeeShares: new BN(1234),
    unclaimedPlatformFeeShares: new BN(567),
    epochOutflow: new BN(89),
    nextStrategyId: 3,
    performanceFeeBps: 2000,
    managementFeeBps: 200,
    status: { normal: {} },
    bump: 254,
    version: 1,
    depositPaused: 0,
    withdrawalPaused: 1,
    padding0: bytes(3),
    reserved0: bytes(8),
    minDeposit: new BN(1_000_000),
    minWithdrawalShares: new BN(500_000),
    reserved1: bytes(24),
    feeEffectiveTs: new BN(1_760_000_000),
    reserved2: bytes(12),
    pendingPerformanceFeeBps: 1500,
    pendingManagementFeeBps: 100,
    openStrategyCount: 2,
    delegateCount: 1,
    reserved3: bytes(32),
    ...overrides,
  };
}

const configFields = {
  admin: key(1),
  navUpdater: key(2),
  treasuryAuthority: key(3),
  guardian: key(4),
  nextVaultId: new BN(3),
  platformPerformanceFeeBps: 1000,
  platformManagementFeeBps: 50,
  maxNavDeviationBps: 500,
  maxEpochOutflowBps: 2500,
  status: { reduceOnly: {} },
  bump: 255,
  padding0: bytes(6),
  version: 1,
  padding1: bytes(7),
  pendingAdmin: PublicKey.default,
  maxSlippageBps: 0,
  padding2: bytes(6),
  reserve: Array.from({ length: 18 }, () => new BN(0)),
};

const request = (vault: PublicKey, authority: PublicKey, amount: number, epoch: number, createdTs: number) => ({
  authority,
  vault,
  amount: new BN(amount),
  shares: new BN(amount),
  epoch: new BN(epoch),
  createdTs: new BN(createdTs),
  bump: 1,
  rentEscrow: new BN(0),
  reserved: bytes(24),
});

function mintData(decimals: number, supply: bigint) {
  const data = Buffer.alloc(82);
  data.writeBigUInt64LE(supply, 36);
  data.writeUInt8(decimals, 44);
  data.writeUInt8(1, 45);
  return data;
}

function tokenAccountData(amount: bigint) {
  const data = Buffer.alloc(165);
  data.writeBigUInt64LE(amount, 64);
  return data;
}

const account = (owner: PublicKey, data: Buffer): AccountInfo<Buffer> => ({ owner, data, lamports: 1, executable: false });

/** Serves accounts by address and applies getProgramAccounts memcmp filters as an RPC node would. */
function fakeConnection(accounts: Map<string, AccountInfo<Buffer>>) {
  const calls: string[] = [];
  const connection = {
    getMultipleAccountsInfo: async (keys: PublicKey[]) => {
      calls.push("getMultipleAccountsInfo");
      return keys.map((k) => accounts.get(k.toBase58()) ?? null);
    },
    getProgramAccounts: async (programId: PublicKey, config: GetProgramAccountsConfig) => {
      calls.push(`getProgramAccounts:${programId.toBase58()}`);
      return [...accounts]
        .filter(([, info]) => info.owner.equals(programId))
        .filter(([, info]) =>
          (config.filters ?? []).every((f) => {
            if (!("memcmp" in f)) return false;
            const want = Buffer.from(bs58.decode(f.memcmp.bytes));
            return info.data.subarray(f.memcmp.offset, f.memcmp.offset + want.length).equals(want);
          }),
        )
        .map(([address, info]) => ({ pubkey: new PublicKey(address), account: info }));
    },
  };
  return { connection: connection as unknown as Connection, calls };
}

const jupiterOk = () =>
  vi.fn(async (_url: string | URL | Request, _init?: RequestInit) =>
    new Response(JSON.stringify([{ id: HUSD.toBase58(), symbol: "HUSD", name: "Hedge USD", icon: null }]), { status: 200 }),
  );

const ataOf = (owner: PublicKey, mint: PublicKey) =>
  PublicKey.findProgramAddressSync(
    [owner.toBuffer(), TOKEN_PROGRAM.toBuffer(), mint.toBuffer()],
    new PublicKey("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL"),
  )[0];

async function chain(programId = PROGRAM) {
  const vault1Address = getVaultPda(1n, programId);
  const shareMint = getShareMintPda(vault1Address, programId);
  const vault1 = vaultFields(1, { shareMint });
  const vault2 = vaultFields(2, { name: bytes(32), depositMint: USDC, totalAssets: new BN(0), status: { paused: {} } });
  return new Map<string, AccountInfo<Buffer>>([
    [vault1Address.toBase58(), account(programId, await coder.encode("vault", vault1))],
    [VAULT_2.toBase58(), account(programId, await coder.encode("vault", vault2))],
    [getConfigPda(programId).toBase58(), account(programId, await coder.encode("config", configFields))],
    [HUSD.toBase58(), account(TOKEN_PROGRAM, mintData(6, 10n ** 12n))],
    [USDC.toBase58(), account(TOKEN_PROGRAM, mintData(6, 10n ** 15n))],
    [shareMint.toBase58(), account(TOKEN_PROGRAM, mintData(6, 2_380_952_380n))],
    [ataOf(vault1Address, HUSD).toBase58(), account(TOKEN_PROGRAM, tokenAccountData(750_000_000n))],
  ]);
}

afterEach(() => {
  vi.useRealTimers();
});

describe("createDirectClient", () => {
  it("reads a vault detail from chain with every field", async () => {
    const { connection } = fakeConnection(await chain());
    const fetch = jupiterOk();
    const client = createDirectClient({ connection, fetch });

    expect(await client.getVault(VAULT_1.toBase58())).toEqual({
      address: "5brsTu4AgKjUdE29bbRcPAy1VyVb1SGjH8qEjzEwu68a",
      name: "Alpha",
      status: "normal",
      depositMint: "US517G5965aydkZ46HS38QLi7UQiSojurfbQfKCELFx",
      depositSymbol: "HUSD",
      depositDecimals: 6,
      totalAssets: "2500000000",
      id: "1",
      navPerShare: "1050000000",
      depositCap: "18446744073709551615",
      performanceFeeBps: 2000,
      managementFeeBps: 200,
      lastNavTs: 14_400_300,
      authority: "cGfHiC6Kgg3FpFZvgwGcswsCRtp4aBP2fzuXRQPizuN",
      shareMint: "8W8Fm5j5Xwgwgrgjd6fW2de9cgrzPcXYFqzuc6uTeEu3",
      shareSupply: "2380952380",
      idleBalance: "750000000",
      pendingDeposits: "40000000",
      pendingWithdrawalShares: "7000000",
      unclaimedManagerFeeShares: "1234",
      unclaimedPlatformFeeShares: "567",
      epochOutflow: "89",
      highWaterMark: "1100000000",
      navEpoch: "1000",
      minDeposit: "1000000",
      minWithdrawalShares: "500000",
      depositPaused: false,
      withdrawalPaused: true,
      pendingPerformanceFeeBps: 1500,
      pendingManagementFeeBps: 100,
      feeEffectiveTs: 1_760_000_000,
      openStrategyCount: 2,
      protocol: { status: "reduceOnly", maxEpochOutflowBps: 2500, maxSlippageBps: 1000 },
    });
    expect(fetch).toHaveBeenCalledWith(`https://lite-api.jup.ag/tokens/v2/search?query=${HUSD.toBase58()}`, { headers: {} });
  });

  it("sends the Jupiter key to api.jup.ag when one is set", async () => {
    const { connection } = fakeConnection(await chain());
    const fetch = jupiterOk();
    await createDirectClient({ connection, fetch, jupiterApiKey: "jup-key" }).getVault(VAULT_1.toBase58());
    expect(fetch).toHaveBeenCalledWith(`https://api.jup.ag/tokens/v2/search?query=${HUSD.toBase58()}`, {
      headers: { "x-api-key": "jup-key" },
    });
  });

  it("lists every vault sorted by id, with the fallback name and known-mint symbol", async () => {
    const { connection, calls } = fakeConnection(await chain());
    const client = createDirectClient({ connection, fetch: jupiterOk() });

    expect(await client.listVaults()).toEqual([
      {
        address: "5brsTu4AgKjUdE29bbRcPAy1VyVb1SGjH8qEjzEwu68a",
        name: "Alpha",
        status: "normal",
        depositMint: "US517G5965aydkZ46HS38QLi7UQiSojurfbQfKCELFx",
        depositSymbol: "HUSD",
        depositDecimals: 6,
        totalAssets: "2500000000",
      },
      {
        address: "CxmmBfsCK1NJVMVga2oewCHr34AVV2mPw9WtdAggwxAE",
        name: "Vault #2",
        status: "paused",
        depositMint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
        depositSymbol: "USDC",
        depositDecimals: 6,
        totalAssets: "0",
      },
    ]);
    expect(calls).toEqual(["getProgramAccounts:r2ahBQ6gbPCJ9FxBymYcXuwXi8NmenRry7SE7QR7FAt", "getMultipleAccountsInfo"]);
  });

  it("falls back to a short mint symbol when Jupiter is down", async () => {
    const { connection } = fakeConnection(await chain());
    const fetch = vi.fn(async () => new Response("bad gateway", { status: 502 }));
    const vault = await createDirectClient({ connection, fetch }).getVault(VAULT_1.toBase58());
    expect(vault.depositSymbol).toBe("US51…ELFx");
    expect(vault.depositDecimals).toBe(6);

    const unreachable = vi.fn(async () => {
      throw new TypeError("fetch failed");
    });
    const [first] = await createDirectClient({ connection, fetch: unreachable }).listVaults();
    expect(first?.depositSymbol).toBe("US51…ELFx");
  });

  it("ignores a Jupiter body that does not match the expected shape", async () => {
    const { connection } = fakeConnection(await chain());
    const fetch = vi.fn(async () => new Response(JSON.stringify({ tokens: "nope" }), { status: 200 }));
    expect((await createDirectClient({ connection, fetch }).getVault(VAULT_1.toBase58())).depositSymbol).toBe("US51…ELFx");
  });

  it("classifies queued requests against a fixed clock", async () => {
    const accounts = await chain();
    const add = async (address: PublicKey, name: "depositRequest" | "withdrawalRequest", fields: ReturnType<typeof request>) =>
      accounts.set(address.toBase58(), account(PROGRAM, await coder.encode(name, fields)));
    await add(key(20), "depositRequest", request(VAULT_1, BOB, 3_000_000, 1000, 1000 * EPOCH + 900));
    await add(key(21), "depositRequest", request(VAULT_1, ALICE, 5_000_000, 999, 999 * EPOCH + 60));
    await add(key(22), "withdrawalRequest", request(VAULT_1, ALICE, 2_000_000, 999, 999 * EPOCH + 120));
    await add(key(23), "depositRequest", request(VAULT_2, BOB, 9_000_000, 1000, 1000 * EPOCH + 10));
    const { connection } = fakeConnection(accounts);
    const client = createDirectClient({ connection, fetch: jupiterOk() });

    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime((1000 * EPOCH + 600) * 1000);
    expect(await client.getRequests(VAULT_1.toBase58())).toEqual({
      deposits: [
        { owner: ALICE.toBase58(), amount: "5000000", epoch: "999", createdTs: 999 * EPOCH + 60, state: "resolvable", cancellable: false },
        { owner: BOB.toBase58(), amount: "3000000", epoch: "1000", createdTs: 1000 * EPOCH + 900, state: "pending", cancellable: true },
      ],
      withdrawals: [
        { owner: ALICE.toBase58(), shares: "2000000", epoch: "999", createdTs: 999 * EPOCH + 120, state: "resolvable", cancellable: false },
      ],
    });

    vi.setSystemTime((1001 * EPOCH + 60) * 1000);
    const later = await client.getRequests(VAULT_1.toBase58());
    expect(later.deposits.map((d) => [d.state, d.cancellable])).toEqual([["frozen", false], ["pending", true]]);
    expect(later.withdrawals.map((w) => [w.state, w.cancellable])).toEqual([["frozen", false]]);
  });

  it("lets a deposit be cancelled when the vault has no NAV yet", async () => {
    const accounts = await chain();
    accounts.set(VAULT_1.toBase58(), account(PROGRAM, await coder.encode("vault", vaultFields(1, { navPerShare: new BN(0) }))));
    accounts.set(key(20).toBase58(), account(PROGRAM, await coder.encode("depositRequest", request(VAULT_1, BOB, 1, 999, 1))));
    const { connection } = fakeConnection(accounts);
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime((1000 * EPOCH + 600) * 1000);
    const { deposits } = await createDirectClient({ connection, fetch: jupiterOk() }).getRequests(VAULT_1.toBase58());
    expect(deposits.map((d) => [d.state, d.cancellable])).toEqual([["resolvable", true]]);
  });

  it("rejects addresses that are not vaults of the program", async () => {
    const accounts = await chain();
    accounts.set(key(30).toBase58(), account(OTHER_PROGRAM, accounts.get(VAULT_1.toBase58())?.data ?? Buffer.alloc(0)));
    const { connection } = fakeConnection(accounts);
    const client = createDirectClient({ connection, fetch: jupiterOk() });
    const notFound = { name: "ApiError", status: 404, code: "NotFound", message: "Vault not found" };

    await expect(client.getVault(CONFIG.toBase58())).rejects.toMatchObject(notFound);
    await expect(client.getVault(HUSD.toBase58())).rejects.toMatchObject(notFound);
    await expect(client.getVault(key(30).toBase58())).rejects.toMatchObject(notFound);
    await expect(client.getRequests(key(99).toBase58())).rejects.toMatchObject(notFound);
    await expect(client.getVault("not-a-key")).rejects.toBeInstanceOf(ApiError);
    await expect(client.getVault("not-a-key")).rejects.toMatchObject({ status: 400, code: "Validation" });
  });

  it("reads a different program when programId is overridden", async () => {
    const { connection, calls } = fakeConnection(await chain(OTHER_PROGRAM));
    const overridden = createDirectClient({ connection, fetch: jupiterOk(), programId: OTHER_PROGRAM.toBase58() });
    const vaultAddress = "6vjAPMeoXJsZV6zxP8Jra88mXEmYBrVCsWasXTNT3q4c";

    expect((await overridden.listVaults()).map((v) => v.address)).toEqual([vaultAddress, VAULT_2.toBase58()]);
    expect(calls[0]).toBe("getProgramAccounts:p2Yicb86aZig616Eav2VWG9vuXR5mEqhtzshZYBxzsV");
    await expect(createDirectClient({ connection, fetch: jupiterOk() }).getVault(vaultAddress)).rejects.toMatchObject({ code: "NotFound" });
    expect(await overridden.getVault(vaultAddress)).toMatchObject({
      address: vaultAddress,
      shareMint: "ErGu4xpLxFzC5PSFmF5d3vynBLqP6scNnk3f34EhnvYR",
      shareSupply: "2380952380",
      idleBalance: "750000000",
      protocol: { status: "reduceOnly", maxEpochOutflowBps: 2500, maxSlippageBps: 1000 },
    });
  });
});
