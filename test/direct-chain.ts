/** A fake RPC node and IDL-encoded accounts for the direct-mode build tests. */
import { BN, BorshInstructionCoder, Program } from "@coral-xyz/anchor";
import {
  type AccountInfo,
  AddressLookupTableAccount,
  type Connection,
  Keypair,
  PublicKey,
  type SignatureStatus,
  type TransactionError,
  VersionedTransaction,
} from "@solana/web3.js";
import bs58 from "bs58";
import { getAssociatedTokenAddress, getConfigPda, getDelegatePda, getManagerPda, getShareMintPda, getStrategyPda, getVaultPda } from "../src/chain/pda";
import { type DirectActionRequest, type DirectClientOptions, createDirectClient } from "../src/direct";
import type { Progress } from "../src/executor";
import idl from "../src/idl/hedge_vault.json";
import type { HedgeVault } from "../src/idl/hedge_vault";
import { keypairSigner } from "../src/signer";

export const program = new Program<HedgeVault>(idl as HedgeVault, { connection: {} as Connection });
export const accountsCoder = program.coder.accounts;
export const instructionCoder = new BorshInstructionCoder(program.idl);

export const PROGRAM = new PublicKey(idl.address);
export const TOKEN_PROGRAM = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
export const TOKEN_2022 = new PublicKey("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb");
export const DLMM = new PublicKey("LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo");
export const DLMM_EVENT_AUTHORITY = new PublicKey("D1ZN9Wj1fRSUQfCjhvnu1hqDMT7hzjzBBpi12nVniYD6");
export const PHOENIX = new PublicKey("EtrnLzgbS7nMMy5fbD42kXiUzGg8XQzJ972Xtk1cjWih");
export const PHOENIX_GLOBAL_CONFIG = new PublicKey("2zskx2iyCvb6Stg7RBZkt1f6MrF4dpYtMG3yMvKwqtUZ");
export const COMPUTE_BUDGET = new PublicKey("ComputeBudget111111111111111111111111111111");
export const key = (n: number) => new PublicKey(Buffer.alloc(32, n));
export const USDC = new PublicKey("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
export const SOL = new PublicKey("So11111111111111111111111111111111111111112");
export const BONK = key(21);
export const POSITION = key(22);
export const POOL = key(23);
export const LIMIT_ORDER = key(24);
export const TRADER = key(25);
export const BLOCKHASH = key(5).toBase58();
export const NOW_MS = 1_760_000_000_000;

export const manager = Keypair.fromSeed(new Uint8Array(32).fill(9));
export const delegateWallet = Keypair.fromSeed(new Uint8Array(32).fill(8));
export const stranger = Keypair.fromSeed(new Uint8Array(32).fill(7));
export const VAULT = getVaultPda(1n, PROGRAM);
export const NEXT_VAULT = getVaultPda(3n, PROGRAM);
export const SHARE_MINT = getShareMintPda(VAULT, PROGRAM);
export const DELEGATE = getDelegatePda(VAULT, delegateWallet.publicKey, PROGRAM);
export const BONK_STRATEGY = getStrategyPda(VAULT, BONK, PROGRAM);
export const DLMM_STRATEGY = getStrategyPda(VAULT, POSITION, PROGRAM);
export const LIMIT_STRATEGY = getStrategyPda(VAULT, LIMIT_ORDER, PROGRAM);
export const PHOENIX_STRATEGY = getStrategyPda(VAULT, TRADER, PROGRAM);

export type AccountName = Parameters<typeof accountsCoder.decode>[0];

/** An IDL account of zeroes with `fields` set, so fixtures list only what the test reads. */
export async function encodeAccount(name: AccountName, fields: Record<string, unknown>): Promise<Buffer> {
  const entry = idl.accounts.find((a) => a.name.toLowerCase() === name.toLowerCase());
  if (!entry) throw new Error(`no IDL account ${name}`);
  const zero = Buffer.concat([Buffer.from(entry.discriminator), Buffer.alloc(accountsCoder.size(name) - 8)]);
  return accountsCoder.encode(name, { ...accountsCoder.decode<Record<string, unknown>>(name, zero), ...fields });
}

/** Anchor's `encode` writes into a fixed 1000-byte buffer, too small for DLMM accounts, so these place keys by offset. */
export function largeAccount(name: AccountName, keys: [offset: number, key: PublicKey][]): Buffer {
  const entry = idl.accounts.find((a) => a.name.toLowerCase() === name.toLowerCase());
  if (!entry) throw new Error(`no IDL account ${name}`);
  const data = Buffer.alloc(accountsCoder.size(name));
  Buffer.from(entry.discriminator).copy(data);
  for (const [offset, k] of keys) k.toBuffer().copy(data, offset);
  return data;
}

export const info = (owner: PublicKey, data: Buffer): AccountInfo<Buffer> => ({ owner, data, lamports: 1, executable: false });

export function mintData() {
  const data = Buffer.alloc(82);
  data.writeUInt8(6, 44);
  data.writeUInt8(1, 45);
  return data;
}

export const strategy = (strategyType: Record<string, unknown>) => encodeAccount("strategy", { vault: VAULT, strategyType });

export async function chain(delegate: { permissions: number; expiresAt: number } = { permissions: 1, expiresAt: 0 }) {
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

export const CONFIRMED: SignatureStatus = { slot: 1, confirmations: 1, err: null, confirmationStatus: "confirmed" };

export interface RpcOptions {
  simulation?: { err: TransactionError; logs: string[] };
  send?: (options: unknown) => Promise<string | undefined>;
  status?: SignatureStatus | null;
  blockhashValid?: boolean;
  landedLogs?: string[];
}

export const signatureOf = (bytes: Buffer | Uint8Array) => bs58.encode(VersionedTransaction.deserialize(bytes).signatures[0] ?? new Uint8Array(64));

/** Serves fixture accounts and records every send and status lookup, as an RPC node would see them. */
export function fakeConnection(accounts: Map<string, AccountInfo<Buffer>>, options: RpcOptions = {}) {
  const calls: string[] = [];
  const sent: Buffer[] = [];
  const context = { slot: 1 };
  const connection = {
    getAccountInfo: async (k: PublicKey) => accounts.get(k.toBase58()) ?? null,
    getMultipleAccountsInfo: async (keys: PublicKey[]) => keys.map((k) => accounts.get(k.toBase58()) ?? null),
    getProgramAccounts: async (owner: PublicKey, config: { filters: { memcmp: { offset: number; bytes: string } }[] }) =>
      [...accounts]
        .filter(([, a]) => a.owner.equals(owner) && config.filters.every(({ memcmp }) => a.data.subarray(memcmp.offset).subarray(0, bs58.decode(memcmp.bytes).length).equals(Buffer.from(bs58.decode(memcmp.bytes)))))
        .map(([k, account]) => ({ pubkey: new PublicKey(k), account })),
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

export const plain = (value: unknown): unknown => {
  if (value instanceof Uint8Array) return Buffer.from(value).toString("base64");
  if (BN.isBN(value)) return (value as BN).toString();
  if (value instanceof PublicKey) return value.toBase58();
  if (Array.isArray(value)) return value.map(plain);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, plain(v)]));
  return value;
};

/** The lookup tables a v0 transaction names, read from the fixture accounts. */
function tablesOf(tx: VersionedTransaction, accounts: Map<string, AccountInfo<Buffer>>): AddressLookupTableAccount[] {
  return tx.message.addressTableLookups.map(({ accountKey }) => {
    const table = accounts.get(accountKey.toBase58());
    if (!table) throw new Error(`no lookup table fixture ${accountKey.toBase58()}`);
    return new AddressLookupTableAccount({ key: accountKey, state: AddressLookupTableAccount.deserialize(table.data) });
  });
}

/** A transaction's payer, budget, top-level programs and lookup tables, with every Hedge Vault instruction decoded by the IDL. */
export function decodeTx(bytes: Buffer, accounts: Map<string, AccountInfo<Buffer>> = new Map()) {
  const tx = VersionedTransaction.deserialize(bytes);
  const keys = tx.message.getAccountKeys({ addressLookupTableAccounts: tablesOf(tx, accounts) });
  const programOf = (ix: { programIdIndex: number }) => keys.get(ix.programIdIndex);
  const budget = tx.message.compiledInstructions.filter((i) => programOf(i)?.equals(COMPUTE_BUDGET)).map((i) => Buffer.from(i.data));
  const hedge = tx.message.compiledInstructions
    .filter((ix) => programOf(ix)?.equals(PROGRAM))
    .map((ix) => {
      const decoded = instructionCoder.decode(Buffer.from(ix.data));
      const idlIx = idl.instructions.find((i) => i.name === decoded?.name.replace(/[A-Z]/g, (c: string) => `_${c.toLowerCase()}`));
      if (!decoded || !idlIx) throw new Error("not a hedge_vault instruction");
      const metas = ix.accountKeyIndexes.map((i) => keys.get(i)?.toBase58());
      return {
        name: decoded.name,
        args: plain(decoded.data),
        accounts: Object.fromEntries(idlIx.accounts.map((a, i) => [a.name, metas[i]])),
        remaining: metas.slice(idlIx.accounts.length),
      };
    });
  return {
    hedge,
    payer: keys.get(0)?.toBase58(),
    blockhash: tx.message.recentBlockhash,
    computeUnitLimit: budget.find((d) => d[0] === 2)?.readUInt32LE(1),
    computeUnitPriceMicroLamports: budget.find((d) => d[0] === 3)?.readBigUInt64LE(1),
    /** Every top-level instruction in order: the Hedge Vault instruction's name, or the program called. */
    programs: tx.message.compiledInstructions.map((i) => {
      const program = programOf(i);
      return program?.equals(PROGRAM) ? (instructionCoder.decode(Buffer.from(i.data))?.name ?? "?") : program?.toBase58();
    }),
    lookupTables: tx.message.addressTableLookups.map((l) => l.accountKey.toBase58()),
  };
}

/** The one Hedge Vault instruction of a transaction, with the transaction's payer and budget. */
export function hedgeInstruction(bytes: Buffer, accounts: Map<string, AccountInfo<Buffer>> = new Map()) {
  const { hedge, ...tx } = decodeTx(bytes, accounts);
  const [ix] = hedge;
  if (!ix || hedge.length !== 1) throw new Error(`expected one hedge_vault instruction, got ${hedge.length}`);
  return { ...ix, ...tx };
}

/** A fixed clock that the executor's sleeps advance. */
export function clock() {
  let now = NOW_MS;
  return { now: () => now, sleep: async (ms: number) => void (now += ms) };
}

export async function run(
  request: DirectActionRequest,
  rpc: RpcOptions = {},
  signer = manager,
  accounts?: Map<string, AccountInfo<Buffer>>,
  client: Omit<DirectClientOptions, "connection"> = {},
) {
  const fixtures = accounts ?? (await chain());
  const fake = fakeConnection(fixtures, rpc);
  const progress: Progress[] = [];
  const outcome = await createDirectClient({ connection: fake.connection, ...client }).execute(request, keypairSigner(signer), {
    ...clock(),
    onProgress: (p) => void progress.push(p),
  });
  const [first] = fake.sent;
  return {
    outcome,
    progress,
    calls: fake.calls,
    sent: fake.sent,
    txs: fake.sent.map((tx) => decodeTx(tx, fixtures)),
    get ix() {
      return first && hedgeInstruction(first, fixtures);
    },
  };
}

export const M = manager.publicKey.toBase58();
export const V = VAULT.toBase58();
export const P = PROGRAM.toBase58();
export const ata = (owner: PublicKey, mint: PublicKey, tokenProgram: PublicKey) => getAssociatedTokenAddress(owner, mint, tokenProgram).toBase58();
