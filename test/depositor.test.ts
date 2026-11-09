import { BN, BorshInstructionCoder } from "@coral-xyz/anchor";
import {
  type AccountInfo,
  ComputeBudgetProgram,
  type Connection,
  type GetProgramAccountsConfig,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  VersionedTransaction,
} from "@solana/web3.js";
import bs58 from "bs58";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getConfigPda, getMetadataPda, getShareMintPda } from "../src/chain/pda";
import { accountsCoder, hedgeProgram } from "../src/chain/reads";
import { type DepositorRequest, inspectDepositorTransaction } from "../src/chain/requests";
import { HedgeVault } from "../src/hedge-vault";
import { ApiError, UnsafeTransactionError } from "../src/errors";
import { DEFAULT_MAX_PRIORITY_FEE_LAMPORTS } from "../src/signer";
import idl from "../src/idl/hedge_vault.json";

const coder = accountsCoder({} as Connection);

const PROGRAM = new PublicKey("r2ahBQ6gbPCJ9FxBymYcXuwXi8NmenRry7SE7QR7FAt");
const OTHER_PROGRAM = new PublicKey(Buffer.alloc(32, 12));
const TOKEN_PROGRAM = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
const key = (n: number) => new PublicKey(Buffer.alloc(32, n));
const HUSD = key(7);
const USDC = new PublicKey("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
const MANAGER = key(9);
const VAULT_1 = key(31);
const VAULT_2 = key(32);
const CHILD = key(33);
const EPOCH = 14_400;

const nameBytes = (s: string) => [...Buffer.from(s), ...Array<number>(32 - s.length).fill(0)];

/** An IDL account of zeroes with `fields` set, so fixtures list only what the test reads and survive reserved-byte changes. */
async function encode(name: "vault" | "config" | "depositRequest" | "withdrawalRequest", fields: Record<string, unknown>): Promise<Buffer> {
  const entry = idl.accounts.find((a) => a.name.toLowerCase() === name.toLowerCase());
  if (!entry) throw new Error(`no IDL account ${name}`);
  const zero = Buffer.concat([Buffer.from(entry.discriminator), Buffer.alloc(coder.size(name) - 8)]);
  return coder.encode(name, { ...coder.decode<Record<string, unknown>>(name, zero), ...fields });
}

const vaultFields = (id: number, overrides: Record<string, unknown> = {}) => ({
  id: new BN(id),
  authority: MANAGER,
  name: nameBytes("Alpha"),
  parent: PublicKey.default,
  depositMint: HUSD,
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
  performanceFeeBps: 2000,
  managementFeeBps: 200,
  status: { normal: {} },
  withdrawalPaused: 1,
  minDeposit: new BN(1_000_000),
  minWithdrawalShares: new BN(500_000),
  shareSupply: new BN("2380952380"),
  feeEffectiveTs: new BN(1_760_000_000),
  pendingPerformanceFeeBps: 1500,
  pendingManagementFeeBps: 100,
  openStrategyCount: 2,
  ...overrides,
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

const ataOf = (owner: PublicKey, mint: PublicKey) =>
  PublicKey.findProgramAddressSync([owner.toBuffer(), TOKEN_PROGRAM.toBuffer(), mint.toBuffer()], new PublicKey("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL"))[0];

/** Serves accounts by address and applies getProgramAccounts memcmp filters as an RPC node would. */
function fakeConnection(accounts: Map<string, AccountInfo<Buffer>>, rpc: Record<string, unknown> = {}) {
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
    ...rpc,
  };
  return { connection: connection as unknown as Connection, calls };
}

const jupiterOk = () =>
  vi.fn(async (_url: string | URL | Request, _init?: RequestInit) =>
    new Response(JSON.stringify([{ id: HUSD.toBase58(), symbol: "HUSD", name: "Hedge USD", icon: null }]), { status: 200 }),
  );

async function chain(programId = PROGRAM) {
  return new Map<string, AccountInfo<Buffer>>([
    [VAULT_1.toBase58(), account(programId, await encode("vault", vaultFields(1)))],
    [VAULT_2.toBase58(), account(programId, await encode("vault", vaultFields(2, { name: nameBytes(""), depositMint: USDC, totalAssets: new BN(0), status: { paused: {} }, selection: 1 })))],
    [CHILD.toBase58(), account(programId, await encode("vault", vaultFields(3, { name: nameBytes("Child"), parent: VAULT_1 })))],
    [getConfigPda(programId).toBase58(), account(programId, await encode("config", { status: { reduceOnly: {} }, maxEpochOutflowBps: 2500, maxSlippageBps: 0 }))],
    [HUSD.toBase58(), account(TOKEN_PROGRAM, mintData(6, 10n ** 12n))],
    [USDC.toBase58(), account(TOKEN_PROGRAM, mintData(6, 10n ** 15n))],
    // The share mint's own supply differs from the vault's share counter; the counter is what the program prices from.
    [getShareMintPda(VAULT_1, programId).toBase58(), account(TOKEN_PROGRAM, mintData(6, 9_999n))],
    [ataOf(VAULT_1, HUSD).toBase58(), account(TOKEN_PROGRAM, tokenAccountData(750_000_000n))],
    [ataOf(CHILD, HUSD).toBase58(), account(TOKEN_PROGRAM, tokenAccountData(5_000_000n))],
  ]);
}

describe("HedgeVault reads", () => {
  it("reads a vault detail from chain with every field", async () => {
    const { connection } = fakeConnection(await chain());
    const fetch = jupiterOk();

    expect((await HedgeVault.create(connection, VAULT_1, { fetch })).state).toEqual({
      address: VAULT_1.toBase58(),
      name: "Alpha",
      status: "normal",
      depositMint: HUSD.toBase58(),
      depositSymbol: "HUSD",
      depositDecimals: 6,
      totalAssets: "2500000000",
      approvalRequired: false,
      parent: null,
      childCount: 0,
      selection: false,
      id: "1",
      navPerShare: "1050000000",
      depositCap: "18446744073709551615",
      performanceFeeBps: 2000,
      managementFeeBps: 200,
      lastNavTs: 1000 * EPOCH + 300,
      authority: MANAGER.toBase58(),
      shareMint: getShareMintPda(VAULT_1, PROGRAM).toBase58(),
      shareSupply: "2380952380",
      shareSymbol: null,
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
    (await HedgeVault.create(connection, VAULT_1, { fetch, jupiterApiKey: "jup-key" })).state;
    expect(fetch).toHaveBeenCalledWith(`https://api.jup.ag/tokens/v2/search?query=${HUSD.toBase58()}`, { headers: { "x-api-key": "jup-key" } });
  });

  it("lists vaults that take deposits sorted by id, without child vaults", async () => {
    const { connection, calls } = fakeConnection(await chain());

    expect(await HedgeVault.getAll(connection, { fetch: jupiterOk() })).toEqual([
      {
        address: VAULT_1.toBase58(),
        name: "Alpha",
        status: "normal",
        depositMint: HUSD.toBase58(),
        depositSymbol: "HUSD",
        depositDecimals: 6,
        totalAssets: "2500000000",
        approvalRequired: false,
        parent: null,
        childCount: 0,
        selection: false,
      },
      {
        address: VAULT_2.toBase58(),
        name: "Vault #2",
        status: "paused",
        depositMint: USDC.toBase58(),
        depositSymbol: "USDC",
        depositDecimals: 6,
        totalAssets: "0",
        approvalRequired: false,
        parent: null,
        childCount: 0,
        selection: true,
      },
    ]);
    expect(calls).toEqual([`getProgramAccounts:${PROGRAM.toBase58()}`, "getMultipleAccountsInfo"]);
  });

  it("decodes a frozen vault", async () => {
    const accounts = await chain();
    accounts.set(VAULT_1.toBase58(), account(PROGRAM, await encode("vault", vaultFields(1, { status: { frozen: {} } }))));
    const { connection } = fakeConnection(accounts);
    expect((await HedgeVault.create(connection, VAULT_1, { fetch: jupiterOk() })).state.status).toBe("frozen");
  });

  it("reads a child vault by address, with no share symbol", async () => {
    const { connection } = fakeConnection(await chain());
    expect((await HedgeVault.create(connection, CHILD, { fetch: jupiterOk() })).state).toMatchObject({
      name: "Child",
      parent: VAULT_1.toBase58(),
      shareSymbol: null,
      idleBalance: "5000000",
    });
  });

  it("falls back to a short mint symbol when Jupiter is down or answers garbage", async () => {
    const { connection } = fakeConnection(await chain());
    const down = vi.fn(async () => new Response("bad gateway", { status: 502 }));
    expect(((await HedgeVault.create(connection, VAULT_1, { fetch: down })).state).depositSymbol).toBe(
      `${HUSD.toBase58().slice(0, 4)}…${HUSD.toBase58().slice(-4)}`,
    );
    const unreachable = vi.fn(async () => {
      throw new TypeError("fetch failed");
    });
    const [first] = await HedgeVault.getAll(connection, { fetch: unreachable });
    expect(first?.depositSymbol).toBe(`${HUSD.toBase58().slice(0, 4)}…${HUSD.toBase58().slice(-4)}`);
    const garbage = vi.fn(async () => new Response(JSON.stringify({ tokens: "nope" }), { status: 200 }));
    expect(((await HedgeVault.create(connection, VAULT_1, { fetch: garbage })).state).depositDecimals).toBe(6);
  });

  it("reads the share symbol from the share mint's Metaplex metadata", async () => {
    const accounts = await chain();
    const shareMint = getShareMintPda(VAULT_1, PROGRAM);
    const str = (s: string, cap: number) => {
      const out = Buffer.alloc(4 + cap);
      out.writeUInt32LE(cap);
      out.write(s, 4);
      return out;
    };
    const metadata = Buffer.concat([Buffer.from([4]), key(5).toBuffer(), shareMint.toBuffer(), str("Alpha Shares", 32), str("hALPHA", 10)]);
    accounts.set(getMetadataPda(shareMint).toBase58(), account(new PublicKey("metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s"), metadata));
    const { connection } = fakeConnection(accounts);
    expect(((await HedgeVault.create(connection, VAULT_1, { fetch: jupiterOk() })).state).shareSymbol).toBe("hALPHA");
  });

  it("leaves out a vault whose deposit mint is gone instead of failing the list", async () => {
    const accounts = await chain();
    accounts.delete(USDC.toBase58());
    const { connection } = fakeConnection(accounts);
    expect((await HedgeVault.getAll(connection, { fetch: jupiterOk() })).map((v) => v.address)).toEqual([VAULT_1.toBase58()]);
  });

  it("rejects addresses that are not vaults of the program", async () => {
    const accounts = await chain();
    accounts.set(key(30).toBase58(), account(OTHER_PROGRAM, accounts.get(VAULT_1.toBase58())?.data ?? Buffer.alloc(0)));
    const { connection } = fakeConnection(accounts);
    const load = (vault: PublicKey) => HedgeVault.create(connection, vault, { fetch: jupiterOk() });
    const notFound = { name: "ApiError", status: 404, code: "NotFound", message: "Vault not found" };

    await expect(load(getConfigPda(PROGRAM))).rejects.toMatchObject(notFound);
    await expect(load(HUSD)).rejects.toMatchObject(notFound);
    await expect(load(key(30))).rejects.toMatchObject(notFound);
    await expect(load(key(99))).rejects.toMatchObject(notFound);
    await expect(load(HUSD)).rejects.toBeInstanceOf(ApiError);
  });

  it("reads a different program when programId is overridden", async () => {
    const { connection, calls } = fakeConnection(await chain(OTHER_PROGRAM));
    const opt = { fetch: jupiterOk(), programId: OTHER_PROGRAM };

    expect((await HedgeVault.getAll(connection, opt)).map((v) => v.address)).toEqual([VAULT_1.toBase58(), VAULT_2.toBase58()]);
    expect(calls[0]).toBe(`getProgramAccounts:${OTHER_PROGRAM.toBase58()}`);
    await expect(HedgeVault.create(connection, VAULT_1, { fetch: jupiterOk() })).rejects.toMatchObject({ code: "NotFound" });
    expect((await HedgeVault.create(connection, VAULT_1, opt)).state).toMatchObject({
      shareMint: getShareMintPda(VAULT_1, OTHER_PROGRAM).toBase58(),
      protocol: { status: "reduceOnly", maxSlippageBps: 1000 },
    });
  });
});

const DEPOSITOR = Keypair.generate();
const USER = DEPOSITOR.publicKey;
const STRANGER = key(40);
const SOL_VAULT = key(34);
const NATIVE = new PublicKey("So11111111111111111111111111111111111111112");
const COMPUTE = ComputeBudgetProgram.programId;

/** The transaction-side RPC: records what was simulated, and answers as a node would. */
function txRpc(overrides: Record<string, unknown> = {}) {
  const simulated: VersionedTransaction[] = [];
  const rpc = {
    simulateTransaction: async (tx: VersionedTransaction) => {
      simulated.push(tx);
      return { value: { err: null, unitsConsumed: 50_000, logs: [] } };
    },
    getRecentPrioritizationFees: async () => [0, 2_000, 4_000, 9_000].map((prioritizationFee, slot) => ({ slot, prioritizationFee })),
    getLatestBlockhash: async () => ({ blockhash: key(5).toBase58(), lastValidBlockHeight: 100 }),
    ...overrides,
  };
  return { rpc, simulated };
}

async function solChain() {
  const accounts = await chain();
  accounts.set(SOL_VAULT.toBase58(), account(PROGRAM, await encode("vault", vaultFields(4, { depositMint: NATIVE }))));
  accounts.set(NATIVE.toBase58(), account(TOKEN_PROGRAM, mintData(9, 0n)));
  accounts.set(ataOf(USER, NATIVE).toBase58(), account(TOKEN_PROGRAM, tokenAccountData(300n)));
  return accounts;
}

async function load(vault: PublicKey, accounts: Map<string, AccountInfo<Buffer>>, rpc: Record<string, unknown>, opt: { maxPriorityFeeLamports?: bigint } = {}) {
  const fake = fakeConnection(accounts, rpc);
  return { vault: await HedgeVault.create(fake.connection, vault, { fetch: jupiterOk(), ...opt }), ...fake };
}

const vaultIx = (tx: Transaction) => {
  const ix = tx.instructions.find((i) => i.programId.equals(PROGRAM));
  if (!ix) throw new Error("no Hedge Vault instruction");
  return { ix, decoded: new BorshInstructionCoder(hedgeProgram({} as Connection).idl).decode(Buffer.from(ix.data)) };
};

describe("HedgeVault actions", () => {
  it("deposit returns an unsigned, simulated transaction paid by the user with a capped priority fee", async () => {
    const { rpc, simulated } = txRpc();
    const { vault } = await load(VAULT_1, await chain(), rpc, { maxPriorityFeeLamports: 100n });

    const tx = await vault.deposit({ user: USER, amount: new BN(5_000_000) });

    expect(simulated).toHaveLength(1);
    expect(tx.feePayer?.equals(USER)).toBe(true);
    expect(tx).toMatchObject({ recentBlockhash: key(5).toBase58(), lastValidBlockHeight: 100 });
    expect(tx.signatures.every((s) => s.signature === null)).toBe(true);
    expect(tx.instructions.map((i) => i.programId.toBase58())).toEqual([COMPUTE.toBase58(), COMPUTE.toBase58(), PROGRAM.toBase58()]);
    const { ix, decoded } = vaultIx(tx);
    expect(decoded?.name).toBe("depositRequestCreate");
    expect(String((decoded?.data as { amount: BN }).amount)).toBe("5000000");
    expect(ix.keys[0]?.pubkey.equals(USER)).toBe(true);
    // Simulation used 50k CU, so the limit is 61k; the 4000 µL median would cost 244 lamports, over the 100 lamport cap.
    const [limit, price] = tx.instructions.slice(0, 2).map((i) => Buffer.from(i.data));
    expect(limit?.readUInt32LE(1)).toBe(61_000);
    expect(price?.readBigUInt64LE(1)).toBe((100n * 1_000_000n) / 61_000n);
  });

  it("wraps only the native SOL the wSOL account is short by", async () => {
    const { vault } = await load(SOL_VAULT, await solChain(), txRpc().rpc);

    const tx = await vault.deposit({ user: USER, amount: new BN(1_000) });

    const transfer = tx.instructions.find((i) => i.programId.equals(SystemProgram.programId));
    expect(Buffer.from(transfer?.data ?? []).readBigUInt64LE(4)).toBe(700n);
    expect(transfer?.keys[1]?.pubkey.equals(ataOf(USER, NATIVE))).toBe(true);
    expect(tx.instructions).toHaveLength(6);
  });

  it("cancels the user's own withdrawal request and nobody else's", async () => {
    const { vault } = await load(VAULT_1, await chain(), txRpc().rpc);

    const tx = await vault.cancelWithdrawal({ user: USER });

    const { ix, decoded } = vaultIx(tx);
    const request = PublicKey.findProgramAddressSync([Buffer.from("withdrawal_request"), VAULT_1.toBuffer(), USER.toBuffer()], PROGRAM)[0];
    expect(decoded?.name).toBe("withdrawalRequestCancel");
    expect(ix.keys[0]?.pubkey.equals(USER)).toBe(true);
    expect(ix.keys[2]?.pubkey.equals(request)).toBe(true);
  });

  it("answers a vault in selection before simulating, and names a program error from simulation", async () => {
    const selection = txRpc();
    const { vault: selected } = await load(VAULT_2, await chain(), selection.rpc);
    await expect(selected.deposit({ user: USER, amount: new BN(1) })).rejects.toMatchObject({ code: "VaultInSelection", status: 403 });
    expect(selection.simulated).toHaveLength(0);

    const { vault } = await load(VAULT_1, await chain(), txRpc({ simulateTransaction: async () => ({ value: { err: { InstructionError: [2, { Custom: 6100 }] }, logs: [] } }) }).rpc);
    await expect(vault.withdraw({ user: USER, shares: new BN(10) })).rejects.toMatchObject({ code: "VaultInSelection", message: "Vault is in selection, only its manager can deposit" });
    const missing = await load(VAULT_1, await chain(), txRpc({ simulateTransaction: async () => ({ value: { err: { InstructionError: [2, { Custom: 3012 }] }, logs: [] } }) }).rpc);
    await expect(missing.vault.cancelDeposit({ user: USER })).rejects.toMatchObject({ code: "RequestNotFound" });
  });

  it("rejects an amount that is not a positive u64 BN before simulating", async () => {
    const { rpc, simulated } = txRpc();
    const { vault } = await load(VAULT_1, await chain(), rpc);
    for (const amount of [new BN(0), new BN(-5), new BN(2).pow(new BN(64)), 5 as unknown as BN])
      await expect(vault.deposit({ user: USER, amount })).rejects.toMatchObject({ code: "Validation" });
    await expect(vault.withdraw({ user: USER, shares: new BN(0) })).rejects.toMatchObject({ code: "Validation" });
    expect(simulated).toHaveLength(0);
  });

  it("refuses a transaction that differs from the request or moves funds elsewhere", async () => {
    const { vault, connection } = await load(VAULT_1, await chain(), txRpc().rpc);
    const request = { action: "deposit/create", vault: VAULT_1, amount: 5n } as const;
    const tx = await vault.deposit({ user: USER, amount: new BN(5) });
    const ctx = { program: hedgeProgram(connection), programId: PROGRAM };
    const inspect = (t: Transaction, r: DepositorRequest = request) => () =>
      inspectDepositorTransaction(ctx, new VersionedTransaction(t.compileMessage()), USER, r, DEFAULT_MAX_PRIORITY_FEE_LAMPORTS);

    expect(inspect(tx)).not.toThrow();
    expect(inspect(tx, { ...request, amount: 6n })).toThrow(UnsafeTransactionError);
    expect(inspect(tx, { ...request, vault: VAULT_2 })).toThrow("different vault");
    expect(inspect(tx, { action: "deposit/cancel", vault: VAULT_1 })).toThrow("Expected only depositRequestCancel");
    const drain = new Transaction({ feePayer: USER, blockhash: key(5).toBase58(), lastValidBlockHeight: 100 }).add(
      ...tx.instructions,
      SystemProgram.transfer({ fromPubkey: USER, toPubkey: STRANGER, lamports: 1 }),
    );
    expect(inspect(drain)).toThrow("Unexpected instruction");
  });
});

describe("HedgeVault.getPositionByUser", () => {
  const NOW = (1000 * EPOCH + 500) * 1000;
  afterEach(() => vi.useRealTimers());

  it("reads the user's shares, their value at NAV, and request states", async () => {
    vi.useFakeTimers({ now: NOW, toFake: ["Date"] });
    const accounts = await chain();
    accounts.set(ataOf(USER, getShareMintPda(VAULT_1, PROGRAM)).toBase58(), account(TOKEN_PROGRAM, tokenAccountData(2_000_000_000n)));
    const request = (epoch: number, fields: Record<string, unknown>) => ({ authority: USER, vault: VAULT_1, epoch: new BN(epoch), createdTs: new BN(1_000), approved: 0, ...fields });
    accounts.set(
      PublicKey.findProgramAddressSync([Buffer.from("deposit_request"), VAULT_1.toBuffer(), USER.toBuffer()], PROGRAM)[0].toBase58(),
      account(PROGRAM, await encode("depositRequest", request(999, { amount: new BN(40_000_000) }))),
    );
    accounts.set(
      PublicKey.findProgramAddressSync([Buffer.from("withdrawal_request"), VAULT_1.toBuffer(), USER.toBuffer()], PROGRAM)[0].toBase58(),
      account(PROGRAM, await encode("withdrawalRequest", request(1000, { shares: new BN(7_000_000) }))),
    );
    const { vault, calls } = await load(VAULT_1, accounts, txRpc().rpc);
    calls.length = 0;

    const p = await vault.getPositionByUser(USER);

    expect(calls).toEqual(["getMultipleAccountsInfo"]);
    expect(p.shares.toString()).toBe("2000000000");
    // navPerShare 1.05 (1_050_000_000 per 10^9 shares).
    expect(p.valueAtNav.toString()).toBe("2100000000");
    expect(p.depositRequest).toMatchObject({ state: "resolvable", cancellable: false, awaitingApproval: false, createdTs: 1_000 });
    expect(p.depositRequest?.amount.toString()).toBe("40000000");
    expect(p.withdrawalRequest).toMatchObject({ state: "pending", cancellable: true });
    expect(p.withdrawalRequest?.shares.toString()).toBe("7000000");
  });

  it("returns zero shares and no requests for a wallet that never deposited, and frozen once a new epoch starts unvalued", async () => {
    vi.useFakeTimers({ now: NOW + EPOCH * 1000, toFake: ["Date"] });
    const accounts = await chain();
    accounts.set(
      PublicKey.findProgramAddressSync([Buffer.from("deposit_request"), VAULT_1.toBuffer(), USER.toBuffer()], PROGRAM)[0].toBase58(),
      account(PROGRAM, await encode("depositRequest", { authority: USER, vault: VAULT_1, epoch: new BN(999), createdTs: new BN(1), approved: 0, amount: new BN(1) })),
    );
    const { vault } = await load(VAULT_1, accounts, txRpc().rpc);

    expect((await vault.getPositionByUser(USER)).depositRequest).toMatchObject({ state: "frozen", cancellable: false });
    const stranger = await vault.getPositionByUser(STRANGER);
    expect(stranger.shares.isZero() && stranger.valueAtNav.isZero()).toBe(true);
    expect(stranger).toMatchObject({ depositRequest: null, withdrawalRequest: null });
  });
});
