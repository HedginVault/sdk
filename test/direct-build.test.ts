import { BN, BorshInstructionCoder, Program } from "@coral-xyz/anchor";
import {
  type AccountInfo,
  type Connection,
  Keypair,
  PublicKey,
  SendTransactionError,
  type SignatureStatus,
  type TransactionError,
  VersionedTransaction,
} from "@solana/web3.js";
import bs58 from "bs58";
import { describe, expect, it } from "vitest";
import { getAssociatedTokenAddress, getConfigPda, getDelegatePda, getManagerPda, getShareMintPda, getStrategyPda, getVaultPda } from "../src/chain/pda";
import { type DirectActionRequest, createDirectClient } from "../src/direct";
import type { Progress } from "../src/executor";
import idl from "../src/idl/hedge_vault.json";
import type { HedgeVault } from "../src/idl/hedge_vault";
import { keypairSigner } from "../src/signer";

const program = new Program<HedgeVault>(idl as HedgeVault, { connection: {} as Connection });
const accountsCoder = program.coder.accounts;
const instructionCoder = new BorshInstructionCoder(program.idl);

const PROGRAM = new PublicKey(idl.address);
const TOKEN_PROGRAM = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
const TOKEN_2022 = new PublicKey("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb");
const DLMM = new PublicKey("LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo");
const DLMM_EVENT_AUTHORITY = new PublicKey("D1ZN9Wj1fRSUQfCjhvnu1hqDMT7hzjzBBpi12nVniYD6");
const PHOENIX = new PublicKey("EtrnLzgbS7nMMy5fbD42kXiUzGg8XQzJ972Xtk1cjWih");
const PHOENIX_GLOBAL_CONFIG = new PublicKey("2zskx2iyCvb6Stg7RBZkt1f6MrF4dpYtMG3yMvKwqtUZ");
const COMPUTE_BUDGET = new PublicKey("ComputeBudget111111111111111111111111111111");
const key = (n: number) => new PublicKey(Buffer.alloc(32, n));
const USDC = new PublicKey("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
const SOL = new PublicKey("So11111111111111111111111111111111111111112");
const BONK = key(21);
const POSITION = key(22);
const POOL = key(23);
const LIMIT_ORDER = key(24);
const TRADER = key(25);
const BLOCKHASH = key(5).toBase58();
const NOW_MS = 1_760_000_000_000;

const manager = Keypair.fromSeed(new Uint8Array(32).fill(9));
const delegateWallet = Keypair.fromSeed(new Uint8Array(32).fill(8));
const stranger = Keypair.fromSeed(new Uint8Array(32).fill(7));
const VAULT = getVaultPda(1n, PROGRAM);
const NEXT_VAULT = getVaultPda(3n, PROGRAM);
const SHARE_MINT = getShareMintPda(VAULT, PROGRAM);
const DELEGATE = getDelegatePda(VAULT, delegateWallet.publicKey, PROGRAM);
const BONK_STRATEGY = getStrategyPda(VAULT, BONK, PROGRAM);
const DLMM_STRATEGY = getStrategyPda(VAULT, POSITION, PROGRAM);
const LIMIT_STRATEGY = getStrategyPda(VAULT, LIMIT_ORDER, PROGRAM);
const PHOENIX_STRATEGY = getStrategyPda(VAULT, TRADER, PROGRAM);

type AccountName = Parameters<typeof accountsCoder.decode>[0];

/** An IDL account of zeroes with `fields` set, so fixtures list only what the test reads. */
async function encodeAccount(name: AccountName, fields: Record<string, unknown>): Promise<Buffer> {
  const entry = idl.accounts.find((a) => a.name.toLowerCase() === name.toLowerCase());
  if (!entry) throw new Error(`no IDL account ${name}`);
  const zero = Buffer.concat([Buffer.from(entry.discriminator), Buffer.alloc(accountsCoder.size(name) - 8)]);
  return accountsCoder.encode(name, { ...accountsCoder.decode<Record<string, unknown>>(name, zero), ...fields });
}

/** Anchor's `encode` writes into a fixed 1000-byte buffer, too small for DLMM accounts, so these place keys by offset. */
function largeAccount(name: AccountName, keys: [offset: number, key: PublicKey][]): Buffer {
  const entry = idl.accounts.find((a) => a.name.toLowerCase() === name.toLowerCase());
  if (!entry) throw new Error(`no IDL account ${name}`);
  const data = Buffer.alloc(accountsCoder.size(name));
  Buffer.from(entry.discriminator).copy(data);
  for (const [offset, k] of keys) k.toBuffer().copy(data, offset);
  return data;
}

const info = (owner: PublicKey, data: Buffer): AccountInfo<Buffer> => ({ owner, data, lamports: 1, executable: false });

function mintData() {
  const data = Buffer.alloc(82);
  data.writeUInt8(6, 44);
  data.writeUInt8(1, 45);
  return data;
}

const strategy = (strategyType: Record<string, unknown>) => encodeAccount("strategy", { vault: VAULT, strategyType });

async function chain(delegate: { permissions: number; expiresAt: number } = { permissions: 1, expiresAt: 0 }) {
  const limitOrder = Buffer.alloc(64);
  Buffer.from([137, 183, 212, 91, 115, 29, 141, 227]).copy(limitOrder);
  POOL.toBuffer().copy(limitOrder, 8);
  const globalConfig = Buffer.alloc(776);
  Buffer.from([37, 146, 212, 210, 47, 136, 111, 20]).copy(globalConfig);
  USDC.toBuffer().copy(globalConfig, 296);
  const entries: [PublicKey, AccountInfo<Buffer>][] = [
    [VAULT, info(PROGRAM, await encodeAccount("vault", { id: new BN(1), authority: manager.publicKey, depositMint: USDC, shareMint: SHARE_MINT }))],
    [getConfigPda(PROGRAM), info(PROGRAM, await encodeAccount("config", { nextVaultId: new BN(3) }))],
    [getManagerPda(manager.publicKey, PROGRAM), info(PROGRAM, await encodeAccount("manager", { authority: manager.publicKey }))],
    [
      DELEGATE,
      info(PROGRAM, await encodeAccount("delegate", { vault: VAULT, authority: delegateWallet.publicKey, permissions: new BN(delegate.permissions), expiresAt: new BN(delegate.expiresAt) })),
    ],
    [USDC, info(TOKEN_PROGRAM, mintData())],
    [SOL, info(TOKEN_PROGRAM, mintData())],
    [BONK, info(TOKEN_2022, mintData())],
    [BONK_STRATEGY, info(PROGRAM, await strategy({ jupiterSwap: { targetMint: BONK } }))],
    [DLMM_STRATEGY, info(PROGRAM, await strategy({ meteoraDlmm: { position: POSITION } }))],
    [LIMIT_STRATEGY, info(PROGRAM, await strategy({ meteoraDlmmLimitOrder: { limitOrder: LIMIT_ORDER } }))],
    [PHOENIX_STRATEGY, info(PROGRAM, await strategy({ phoenixPerp: { traderAccount: TRADER } }))],
    [POSITION, info(DLMM, largeAccount("positionV2", [[8, POOL]]))],
    [POOL, info(DLMM, largeAccount("lbPair", [[88, SOL], [120, USDC]]))],
    [LIMIT_ORDER, info(DLMM, limitOrder)],
    [PHOENIX_GLOBAL_CONFIG, info(PHOENIX, globalConfig)],
  ];
  return new Map(entries.map(([k, v]) => [k.toBase58(), v]));
}

const CONFIRMED: SignatureStatus = { slot: 1, confirmations: 1, err: null, confirmationStatus: "confirmed" };

interface RpcOptions {
  simulation?: { err: TransactionError; logs: string[] };
  send?: (options: unknown) => Promise<string | undefined>;
  status?: SignatureStatus | null;
  blockhashValid?: boolean;
  landedLogs?: string[];
}

const signatureOf = (bytes: Buffer | Uint8Array) => bs58.encode(VersionedTransaction.deserialize(bytes).signatures[0] ?? new Uint8Array(64));

/** Serves fixture accounts and records every send and status lookup, as an RPC node would see them. */
function fakeConnection(accounts: Map<string, AccountInfo<Buffer>>, options: RpcOptions = {}) {
  const calls: string[] = [];
  const sent: Buffer[] = [];
  const context = { slot: 1 };
  const connection = {
    getAccountInfo: async (k: PublicKey) => accounts.get(k.toBase58()) ?? null,
    getMultipleAccountsInfo: async (keys: PublicKey[]) => keys.map((k) => accounts.get(k.toBase58()) ?? null),
    getRecentPrioritizationFees: async () => [
      { slot: 1, prioritizationFee: 4_000 },
      { slot: 2, prioritizationFee: 6_000 },
    ],
    simulateTransaction: async () => ({
      context,
      value: { err: options.simulation?.err ?? null, logs: options.simulation?.logs ?? [], unitsConsumed: 50_000, accounts: null, returnData: null },
    }),
    getLatestBlockhash: async () => ({ blockhash: BLOCKHASH, lastValidBlockHeight: 100 }),
    sendRawTransaction: async (bytes: Buffer, sendOptions: unknown) => {
      calls.push(`send ${JSON.stringify(sendOptions)}`);
      sent.push(bytes);
      return (await options.send?.(sendOptions)) ?? signatureOf(bytes);
    },
    getSignatureStatuses: async (_: string[], config?: { searchTransactionHistory?: boolean }) => {
      calls.push(config?.searchTransactionHistory ? "status history" : "status");
      return { context, value: [options.status === undefined ? CONFIRMED : options.status] };
    },
    isBlockhashValid: async () => {
      calls.push("isBlockhashValid");
      return { context, value: options.blockhashValid ?? true };
    },
    getTransaction: async () => ({ meta: { logMessages: options.landedLogs ?? [] } }),
  };
  return { connection: connection as unknown as Connection, calls, sent };
}

const plain = (value: unknown): unknown => {
  if (BN.isBN(value)) return (value as BN).toString();
  if (value instanceof PublicKey) return value.toBase58();
  if (Array.isArray(value)) return value.map(plain);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, plain(v)]));
  return value;
};

/** The one Hedge Vault instruction of a transaction, decoded by the IDL, with its accounts by IDL name. */
function hedgeInstruction(bytes: Buffer) {
  const tx = VersionedTransaction.deserialize(bytes);
  const keys = tx.message.staticAccountKeys;
  const ixs = tx.message.compiledInstructions.filter((ix) => keys[ix.programIdIndex]?.equals(PROGRAM));
  const [ix] = ixs;
  if (!ix || ixs.length !== 1) throw new Error(`expected one hedge_vault instruction, got ${ixs.length}`);
  const decoded = instructionCoder.decode(Buffer.from(ix.data));
  const idlIx = idl.instructions.find((i) => i.name === decoded?.name.replace(/[A-Z]/g, (c: string) => `_${c.toLowerCase()}`));
  if (!decoded || !idlIx) throw new Error("not a hedge_vault instruction");
  const metas = ix.accountKeyIndexes.map((i) => keys[i]?.toBase58());
  const budget = tx.message.compiledInstructions.filter((i) => keys[i.programIdIndex]?.equals(COMPUTE_BUDGET)).map((i) => Buffer.from(i.data));
  return {
    name: decoded.name,
    args: plain(decoded.data),
    accounts: Object.fromEntries(idlIx.accounts.map((a, i) => [a.name, metas[i]])),
    remaining: metas.slice(idlIx.accounts.length),
    payer: keys[0]?.toBase58(),
    blockhash: tx.message.recentBlockhash,
    computeUnitLimit: budget.find((d) => d[0] === 2)?.readUInt32LE(1),
    computeUnitPriceMicroLamports: budget.find((d) => d[0] === 3)?.readBigUInt64LE(1),
  };
}

/** A fixed clock that the executor's sleeps advance. */
function clock() {
  let now = NOW_MS;
  return { now: () => now, sleep: async (ms: number) => void (now += ms) };
}

async function run(request: DirectActionRequest, rpc: RpcOptions = {}, signer = manager, accounts?: Map<string, AccountInfo<Buffer>>) {
  const fake = fakeConnection(accounts ?? (await chain()), rpc);
  const progress: Progress[] = [];
  const outcome = await createDirectClient({ connection: fake.connection }).execute(request, keypairSigner(signer), {
    ...clock(),
    onProgress: (p) => void progress.push(p),
  });
  const [first] = fake.sent;
  return { outcome, progress, calls: fake.calls, sent: fake.sent, ix: first && hedgeInstruction(first) };
}

const M = manager.publicKey.toBase58();
const V = VAULT.toBase58();
const P = PROGRAM.toBase58();
const ata = (owner: PublicKey, mint: PublicKey, tokenProgram: PublicKey) => getAssociatedTokenAddress(owner, mint, tokenProgram).toBase58();

const cases: { request: DirectActionRequest; name: string; args: unknown; accounts: Record<string, string>; remaining?: string[] }[] = [
  {
    request: {
      action: "vault/initialize",
      name: "Beta",
      depositMint: USDC.toBase58(),
      performanceFeeBps: 2000,
      managementFeeBps: 200,
      depositCap: "18446744073709551615",
      minDeposit: "1000000",
      minWithdrawalShares: "500000",
    },
    name: "vaultInitialize",
    args: {
      args: {
        name: [...Buffer.from("Beta"), ...Array<number>(28).fill(0)],
        performanceFeeBps: 2000,
        managementFeeBps: 200,
        depositCap: "18446744073709551615",
        minDeposit: "1000000",
        minWithdrawalShares: "500000",
      },
    },
    accounts: {
      authority: M,
      config: getConfigPda(PROGRAM).toBase58(),
      manager: getManagerPda(manager.publicKey, PROGRAM).toBase58(),
      vault: NEXT_VAULT.toBase58(),
      share_mint: getShareMintPda(NEXT_VAULT, PROGRAM).toBase58(),
      vault_token_account: ata(NEXT_VAULT, USDC, TOKEN_PROGRAM),
      deposit_mint: USDC.toBase58(),
      deposit_mint_token_program: TOKEN_PROGRAM.toBase58(),
    },
  },
  {
    request: { action: "vault/update", vault: V, managementFeeBps: 100, depositCap: "5000000", status: "reduceOnly", withdrawalPaused: false },
    name: "vaultUpdate",
    args: {
      args: {
        performanceFeeBps: null,
        managementFeeBps: 100,
        depositCap: "5000000",
        minDeposit: null,
        minWithdrawalShares: null,
        status: { reduceOnly: {} },
        depositPaused: null,
        withdrawalPaused: false,
      },
    },
    accounts: { authority: M, vault: V },
  },
  {
    request: { action: "vault/claim-fee", vault: V },
    name: "vaultClaimManagerFee",
    args: {},
    accounts: { authority: M, vault: V, share_mint: SHARE_MINT.toBase58(), authority_share_token_account: ata(manager.publicKey, SHARE_MINT, TOKEN_PROGRAM) },
  },
  {
    request: { action: "vault/close", vault: V },
    name: "vaultClose",
    args: {},
    accounts: {
      authority: M,
      vault: V,
      deposit_mint: USDC.toBase58(),
      share_mint: SHARE_MINT.toBase58(),
      vault_token_account: ata(VAULT, USDC, TOKEN_PROGRAM),
      deposit_mint_token_program: TOKEN_PROGRAM.toBase58(),
    },
  },
  {
    request: { action: "strategy/close", vault: V, strategy: BONK_STRATEGY.toBase58() },
    name: "vaultCloseStrategy",
    args: {},
    // Anchor fills an absent optional account with the program id.
    accounts: { authority: M, config: getConfigPda(PROGRAM).toBase58(), vault: V, strategy: BONK_STRATEGY.toBase58(), delegate: P },
    remaining: [ata(VAULT, BONK, TOKEN_2022), TOKEN_2022.toBase58()],
  },
  {
    request: { action: "jupiter/initialize", vault: V, targetMint: SOL.toBase58() },
    name: "jupiterInitializeStrategy",
    args: {},
    accounts: { authority: M, vault: V, strategy: getStrategyPda(VAULT, SOL, PROGRAM).toBase58(), destination_mint: SOL.toBase58(), delegate: P },
  },
];

const NETWORK_DOWN = async (): Promise<string> => {
  throw new TypeError("fetch failed");
};

describe.each(cases)("direct execute $request.action", ({ request, name, args, accounts, remaining = [] }) => {
  it("builds the instruction for the vault authority and confirms it", async () => {
    const { outcome, ix, sent, calls } = await run(request);
    const [tx] = sent;
    expect(tx && outcome).toEqual({
      kind: "confirmed",
      signatures: [tx && signatureOf(tx)],
      ...(request.action === "vault/initialize" ? { created: { vault: NEXT_VAULT.toBase58() } } : {}),
    });
    expect(ix?.name).toBe(name);
    expect(ix?.args).toEqual(args);
    expect(ix?.accounts).toMatchObject(accounts);
    expect(ix?.remaining).toEqual(remaining);
    expect(ix?.payer).toBe(M);
    expect(ix?.blockhash).toBe(BLOCKHASH);
    expect(calls).toEqual(['send {"preflightCommitment":"confirmed"}', "status"]);
  });

  it("reports a send lost to a network error as unresolved, not failed", async () => {
    const { outcome, progress, sent } = await run(request, { send: NETWORK_DOWN, status: null });
    const [tx] = sent;
    const signature = tx && signatureOf(tx);
    expect(outcome).toEqual({ kind: "unresolved", signatures: [signature], pending: [signature] });
    expect(progress).toContainEqual({ kind: "sent", signature, status: "unknown" });
  });

  it("reports an expired blockhash after one history lookup", async () => {
    const { outcome, calls } = await run(request, { status: null, blockhashValid: false });
    expect(outcome).toMatchObject({ kind: "failed", code: "Expired" });
    expect(calls.slice(1)).toEqual(["status", "isBlockhashValid", "status history"]);
  });

  it("decodes an on-chain program failure into a readable error", async () => {
    const err = { InstructionError: [2, { Custom: 6033 }] };
    const { outcome } = await run(request, {
      status: { ...CONFIRMED, err },
      landedLogs: [`Program ${P} invoke [1]`, `Program ${P} failed: custom program error: 0x1791`],
    });
    expect(outcome).toMatchObject({ kind: "failed", code: "VaultHasUnclaimedFees", message: "Fees are still unclaimed. Claim them before closing the vault." });
  });
});

describe("direct execute signers", () => {
  it("prices and sizes compute from the RPC sample and the simulation", async () => {
    const { ix } = await run(cases[1]?.request ?? { action: "vault/close", vault: V });
    expect(ix?.computeUnitPriceMicroLamports).toBe(6_000n);
    expect(ix?.computeUnitLimit).toBe(70_000);
  });

  it("refuses vault creation by a wallet that is not a whitelisted manager", async () => {
    const { outcome, sent } = await run(cases[0]?.request ?? { action: "vault/close", vault: V }, {}, stranger);
    expect(outcome).toEqual({ kind: "failed", signatures: [], code: "Forbidden", message: "Connected wallet is not a whitelisted manager" });
    expect(sent).toEqual([]);
  });

  it.each(["vault/update", "vault/claim-fee", "vault/close"] as const)("refuses %s from a delegate, which only the authority may run", async (action) => {
    const request = cases.find((c) => c.request.action === action)?.request;
    if (!request) throw new Error(`no case for ${action}`);
    const { outcome } = await run(request, {}, delegateWallet);
    expect(outcome).toEqual({ kind: "failed", signatures: [], code: "Forbidden", message: "Connected wallet is not the vault authority" });
  });

  it.each(["strategy/close", "jupiter/initialize"] as const)("%s refuses a wallet that is neither authority nor delegate", async (action) => {
    const request = cases.find((c) => c.request.action === action)?.request;
    if (!request) throw new Error(`no case for ${action}`);
    const { outcome } = await run(request, {}, stranger);
    expect(outcome).toEqual({
      kind: "failed",
      signatures: [],
      code: "Forbidden",
      message: "Connected wallet is not the vault authority or one of its delegates",
    });
  });

  it.each(["strategy/close", "jupiter/initialize"] as const)("%s runs for a delegate with Jupiter permission", async (action) => {
    const request = cases.find((c) => c.request.action === action)?.request;
    if (!request) throw new Error(`no case for ${action}`);
    const { outcome, ix } = await run(request, {}, delegateWallet);
    expect(outcome.kind).toBe("confirmed");
    expect(ix?.accounts).toMatchObject({ authority: delegateWallet.publicKey.toBase58(), delegate: DELEGATE.toBase58() });
    expect(ix?.payer).toBe(delegateWallet.publicKey.toBase58());
  });

  it.each(["strategy/close", "jupiter/initialize"] as const)("%s refuses an expired delegate", async (action) => {
    const request = cases.find((c) => c.request.action === action)?.request;
    if (!request) throw new Error(`no case for ${action}`);
    const accounts = await chain({ permissions: 1, expiresAt: NOW_MS / 1000 });
    const { outcome } = await run(request, {}, delegateWallet, accounts);
    expect(outcome).toEqual({
      kind: "failed",
      signatures: [],
      code: "DelegateExpired",
      message: "This wallet's delegate access to the vault has expired",
    });
  });

  it("refuses a delegate whose permissions miss the strategy's protocol", async () => {
    const { outcome } = await run({ action: "strategy/close", vault: V, strategy: DLMM_STRATEGY.toBase58() }, {}, delegateWallet);
    expect(outcome).toEqual({
      kind: "failed",
      signatures: [],
      code: "DelegatePermissionDenied",
      message: "This delegate cannot run Meteora DLMM actions",
    });
  });
});

describe("direct strategy/close accounts per strategy type", () => {
  it.each([
    {
      type: "DLMM position",
      strategy: DLMM_STRATEGY,
      remaining: [POSITION, DLMM, DLMM_EVENT_AUTHORITY, POOL, getStrategyPda(VAULT, SOL, PROGRAM), PROGRAM],
    },
    {
      type: "DLMM limit order",
      strategy: LIMIT_STRATEGY,
      remaining: [LIMIT_ORDER, DLMM, DLMM_EVENT_AUTHORITY, POOL, getStrategyPda(VAULT, SOL, PROGRAM), PROGRAM],
    },
    {
      type: "Phoenix",
      strategy: PHOENIX_STRATEGY,
      remaining: [TRADER, PHOENIX_GLOBAL_CONFIG, getAssociatedTokenAddress(VAULT, USDC, TOKEN_PROGRAM), TOKEN_PROGRAM],
    },
  ])("passes the $type accounts", async ({ strategy, remaining }) => {
    const { outcome, ix } = await run({ action: "strategy/close", vault: V, strategy: strategy.toBase58() });
    expect(outcome.kind).toBe("confirmed");
    expect(ix?.accounts).toMatchObject({ strategy: strategy.toBase58(), delegate: P });
    expect(ix?.remaining).toEqual(remaining.map((k) => k.toBase58()));
  });

  it("refuses a strategy of another vault before building", async () => {
    const accounts = await chain();
    accounts.set(BONK_STRATEGY.toBase58(), info(PROGRAM, await encodeAccount("strategy", { vault: key(99), strategyType: { jupiterSwap: { targetMint: BONK } } })));
    const { outcome } = await run({ action: "strategy/close", vault: V, strategy: BONK_STRATEGY.toBase58() }, {}, manager, accounts);
    expect(outcome).toEqual({ kind: "failed", signatures: [], code: "Validation", message: "Strategy does not belong to this vault" });
  });
});

describe("direct execute transport", () => {
  const close: DirectActionRequest = { action: "vault/close", vault: V };

  it("fails a build whose simulation the program rejects, sending nothing", async () => {
    const { outcome, sent } = await run(close, {
      simulation: { err: { InstructionError: [2, { Custom: 6031 }] }, logs: [`Program ${P} failed: custom program error: 0x178f`] },
    });
    expect(outcome).toEqual({
      kind: "failed",
      signatures: [],
      code: "VaultHasOutstandingShares",
      message: "Depositors still hold shares. The vault can close only after every share is withdrawn.",
    });
    expect(sent).toEqual([]);
  });

  it("rejects an invalid body before any RPC", async () => {
    const { outcome } = await run({ action: "vault/update", vault: V });
    expect(outcome).toEqual({ kind: "failed", signatures: [], code: "Validation", message: "body: no fields to update" });
  });

  it("decodes a preflight failure as a failed send", async () => {
    const preflight = new SendTransactionError({
      action: "send",
      signature: "",
      transactionMessage: "Transaction simulation failed: Error processing Instruction 2: custom program error: 0x1795",
      logs: [`Program ${P} failed: custom program error: 0x1795`],
    });
    const { outcome } = await run(close, {
      send: async () => {
        throw preflight;
      },
    });
    expect(outcome).toEqual({ kind: "failed", signatures: [], code: "NoFeeToClaim", message: "There are no fees to claim yet." });
  });

  it("resends without preflight when the provider's preflight crashes internally", async () => {
    const { outcome, calls } = await run(close, {
      send: async (options) => {
        if (JSON.stringify(options).includes("skipPreflight")) return undefined;
        throw new SendTransactionError({ action: "send", signature: "", transactionMessage: "Internal error during preflight" });
      },
    });
    expect(outcome.kind).toBe("confirmed");
    expect(calls.slice(0, 2)).toEqual(['send {"preflightCommitment":"confirmed"}', 'send {"skipPreflight":true}']);
  });

  it("keeps a receipt for a send lost to a network error and confirms it once it lands", async () => {
    const { outcome, progress, sent } = await run(close, { send: NETWORK_DOWN });
    const [tx] = sent;
    const signature = tx && signatureOf(tx);
    expect(outcome).toEqual({ kind: "confirmed", signatures: [signature] });
    expect(progress).toContainEqual({ kind: "sent", signature, status: "unknown" });
  });

  it("treats a provider rate limit on send as an unknown outcome", async () => {
    const { outcome } = await run(close, {
      status: null,
      send: async () => {
        throw new SendTransactionError({ action: "send", signature: "", transactionMessage: "429 Too Many Requests" });
      },
    });
    expect(outcome.kind).toBe("unresolved");
  });

  it("keeps polling while the status is only processed", async () => {
    const { outcome } = await run(close, { status: { ...CONFIRMED, confirmationStatus: "processed" } });
    expect(outcome.kind).toBe("unresolved");
  });

  it("does not compile an action without a local builder, and refuses it at runtime", async () => {
    const fake = fakeConnection(await chain());
    const client = createDirectClient({ connection: fake.connection });
    const outcome = await client.execute(
      // @ts-expect-error jupiter/swap still needs createHedgeClient
      { action: "jupiter/swap", vault: V, sourceMint: USDC.toBase58(), destinationMint: SOL.toBase58(), amount: "1", slippageBps: 50 },
      keypairSigner(manager),
    );
    expect(outcome).toEqual({ kind: "failed", signatures: [], code: "NotFound", message: "jupiter/swap has no local builder; use createHedgeClient" });
  });
});
