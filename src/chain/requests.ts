import { BN, BorshInstructionCoder } from "@coral-xyz/anchor";
import {
  ComputeBudgetProgram,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
  TransactionMessage,
  type TransactionError,
  VersionedTransaction,
} from "@solana/web3.js";
import { ApiError, UnsafeTransactionError } from "../errors";
import idl from "../idl/hedge_vault.json";
import { checkPrograms } from "../signer";
import { type VaultAccount, decodeTokenAmount } from "./decode";
import { getAssociatedTokenAddress, getConfigPda, getDepositRequestPda, getShareMintPda, getUnwrapPda, getWithdrawalRequestPda } from "./pda";
import { type ChainContext, getAccounts } from "./reads";

/** A depositor's own request, as the SDK checks it. Amounts are base units of the deposit mint; shares of the share mint. */
export type DepositorRequest =
  | { action: "deposit/create"; vault: PublicKey; amount: bigint }
  | { action: "deposit/cancel"; vault: PublicKey }
  | { action: "deposit/resolve"; vault: PublicKey; depositor?: PublicKey }
  | { action: "withdrawal/create"; vault: PublicKey; shares: bigint }
  | { action: "withdrawal/cancel"; vault: PublicKey }
  | { action: "withdrawal/resolve"; vault: PublicKey; withdrawer?: PublicKey };

export type DepositorAction = DepositorRequest["action"];

/** The one Hedge Vault instruction each action may contain, the account that names the request's owner, and its amount argument. */
const SPECS = {
  "deposit/create": { method: "depositRequestCreate", owner: "depositor", arg: "amount" },
  "deposit/cancel": { method: "depositRequestCancel", owner: "depositor", arg: null },
  "deposit/resolve": { method: "depositRequestResolve", owner: "depositor", arg: null },
  "withdrawal/create": { method: "withdrawalRequestCreate", owner: "withdrawer", arg: "shares" },
  "withdrawal/cancel": { method: "withdrawalRequestCancel", owner: "withdrawer", arg: null },
  "withdrawal/resolve": { method: "withdrawalRequestResolve", owner: "withdrawer", arg: null },
} as const satisfies Record<DepositorAction, { method: string; owner: string; arg: "amount" | "shares" | null }>;

const TOKEN_PROGRAM = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
const ATA_PROGRAM = new PublicKey("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");
const NATIVE_MINT = new PublicKey("So11111111111111111111111111111111111111112");
const ATA_CREATE_IDEMPOTENT = 1;
const TOKEN_SYNC_NATIVE = 17;
const SYSTEM_TRANSFER = 2;
const MAX_COMPUTE_UNITS = 1_400_000;
const U64_MAX = 2n ** 64n - 1n;
const ANCHOR_ACCOUNT_NOT_INITIALIZED = 3012;

const wsolAccount = (owner: PublicKey) => getAssociatedTokenAddress(owner, NATIVE_MINT, TOKEN_PROGRAM);

/** What the builders need from a loaded vault. */
export interface RequestVault {
  key: PublicKey;
  account: VaultAccount;
  tokenProgram: PublicKey;
}

function owner(request: DepositorRequest, payer: PublicKey): PublicKey {
  if (request.action === "deposit/resolve" && request.depositor) return request.depositor;
  if (request.action === "withdrawal/resolve" && request.withdrawer) return request.withdrawer;
  return payer;
}

function amountOf(request: DepositorRequest): bigint | null {
  const value = request.action === "deposit/create" ? request.amount : request.action === "withdrawal/create" ? request.shares : null;
  if (value !== null && (typeof value !== "bigint" || value <= 0n || value > U64_MAX))
    throw new ApiError(400, "Validation", `${SPECS[request.action].arg} must be a positive u64 in base units`);
  return value;
}

/** wSOL already in the payer's wrapped SOL account, which the deposit spends before wrapping more. */
async function wrappedBalance(ctx: ChainContext, payer: PublicKey): Promise<bigint> {
  const [info] = await getAccounts(ctx, [wsolAccount(payer)]);
  return decodeTokenAmount(info?.data);
}

/**
 * Tops the payer's wSOL account up to `amount` from native SOL, as the app does: idempotent create, transfer, sync.
 * The account is left open, since a cancel or a withdrawal pays back into it.
 */
function wrapSol(payer: PublicKey, amount: bigint, wrapped: bigint): TransactionInstruction[] {
  const shortfall = amount - wrapped;
  if (shortfall <= 0n) return [];
  const ata = wsolAccount(payer);
  return [
    new TransactionInstruction({
      programId: ATA_PROGRAM,
      keys: [
        { pubkey: payer, isSigner: true, isWritable: true },
        { pubkey: ata, isSigner: false, isWritable: true },
        { pubkey: payer, isSigner: false, isWritable: false },
        { pubkey: NATIVE_MINT, isSigner: false, isWritable: false },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
        { pubkey: TOKEN_PROGRAM, isSigner: false, isWritable: false },
      ],
      data: Buffer.from([ATA_CREATE_IDEMPOTENT]),
    }),
    SystemProgram.transfer({ fromPubkey: payer, toPubkey: ata, lamports: shortfall }),
    new TransactionInstruction({ programId: TOKEN_PROGRAM, keys: [{ pubkey: ata, isSigner: false, isWritable: true }], data: Buffer.from([TOKEN_SYNC_NATIVE]) }),
  ];
}

async function requestInstructions(ctx: ChainContext, v: RequestVault, payer: PublicKey, request: DepositorRequest): Promise<TransactionInstruction[]> {
  const methods = ctx.program.methods;
  const config = getConfigPda(ctx.programId);
  const vault = v.key;
  const depositMint = v.account.depositMint;
  const depositMintTokenProgram = v.tokenProgram;
  const shareMint = getShareMintPda(vault, ctx.programId);
  const who = owner(request, payer);
  const amount = new BN((amountOf(request) ?? 0n).toString());
  switch (request.action) {
    case "deposit/create":
      return [
        ...(depositMint.equals(NATIVE_MINT) ? wrapSol(payer, request.amount, await wrappedBalance(ctx, payer)) : []),
        await methods.depositRequestCreate(amount).accountsPartial({ depositor: payer, config, vault, depositMint, shareMint, depositMintTokenProgram }).instruction(),
      ];
    case "deposit/cancel":
      return [
        await methods
          .depositRequestCancel()
          .accountsPartial({ depositor: payer, vault, depositRequest: getDepositRequestPda(vault, payer, ctx.programId), depositMint, depositMintTokenProgram })
          .instruction(),
      ];
    case "deposit/resolve":
      return [
        await methods
          .depositRequestResolve()
          .accountsPartial({
            resolver: payer,
            config,
            vault,
            depositor: who,
            depositRequest: getDepositRequestPda(vault, who, ctx.programId),
            depositMint,
            shareMint,
            depositMintTokenProgram,
          })
          .instruction(),
      ];
    case "withdrawal/create":
      return [
        await methods.withdrawalRequestCreate(amount).accountsPartial({ withdrawer: payer, config, vault, depositMint, shareMint, depositMintTokenProgram }).instruction(),
      ];
    case "withdrawal/cancel":
      return [
        await methods
          .withdrawalRequestCancel()
          .accountsPartial({ withdrawer: payer, vault, withdrawalRequest: getWithdrawalRequestPda(vault, payer, ctx.programId), shareMint })
          .instruction(),
      ];
    case "withdrawal/resolve": {
      const withdrawalRequest = getWithdrawalRequestPda(vault, who, ctx.programId);
      return [
        await methods
          .withdrawalRequestResolve()
          .accountsPartial({
            resolver: payer,
            config,
            vault,
            withdrawer: who,
            withdrawalRequest,
            depositMint,
            shareMint,
            depositMintTokenProgram,
            unwrapAccount: depositMint.equals(NATIVE_MINT) ? getUnwrapPda(withdrawalRequest, ctx.programId) : null,
          })
          .instruction(),
      ];
    }
  }
}

/** A program error by its IDL name, e.g. `{ InstructionError: [1, { Custom: 6100 }] }` becomes `VaultInSelection`. */
export function describeTransactionError(err: TransactionError): { code: string; message: string } {
  const instruction = typeof err === "object" && err !== null && "InstructionError" in err ? (err as { InstructionError: unknown }).InstructionError : null;
  const detail = Array.isArray(instruction) ? instruction[1] : null;
  const custom = typeof detail === "object" && detail !== null && "Custom" in detail ? (detail as { Custom: unknown }).Custom : null;
  const known = typeof custom === "number" ? idl.errors.find((e) => e.code === custom) : undefined;
  if (known) return { code: known.name, message: known.msg };
  // Anchor's own code; in these six actions only the request account can be missing.
  if (custom === ANCHOR_ACCOUNT_NOT_INITIALIZED) return { code: "RequestNotFound", message: "There is no open request to act on" };
  return { code: "TransactionFailed", message: JSON.stringify(err) };
}

/**
 * Median recent price for the vault's writable account, cut so price × limit stays inside the fee cap.
 * ponytail: RPC prioritization fees, not the Helius estimate the app uses; pass a lower cap if it overpays.
 */
async function priorityPrice(ctx: ChainContext, vault: PublicKey, units: number, maxPriorityFeeLamports: bigint): Promise<bigint> {
  const fees = (await ctx.connection.getRecentPrioritizationFees({ lockedWritableAccounts: [vault] }))
    .map((f) => BigInt(f.prioritizationFee))
    .filter((f) => f > 0n)
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const median = fees[Math.floor(fees.length / 2)] ?? 0n;
  const ceiling = (maxPriorityFeeLamports * 1_000_000n) / BigInt(units);
  return median < ceiling ? median : ceiling;
}

/**
 * Simulates at the 1.4M CU ceiling, then pays for what the simulation used plus headroom, on a fresh blockhash. A legacy
 * `Transaction`, so `sendAndConfirmTransaction` and wallet adapters take it as is.
 */
async function assemble(ctx: ChainContext, payer: PublicKey, vault: PublicKey, instructions: TransactionInstruction[], maxPriorityFeeLamports: bigint) {
  const compile = (blockhash: string, lastValidBlockHeight: number, units: number, microLamports: bigint) =>
    new Transaction({ feePayer: payer, blockhash, lastValidBlockHeight }).add(
      ComputeBudgetProgram.setComputeUnitLimit({ units }),
      ComputeBudgetProgram.setComputeUnitPrice({ microLamports }),
      ...instructions,
    );
  const draft = compile(PublicKey.default.toBase58(), 0, MAX_COMPUTE_UNITS, 0n);
  const sim = await ctx.connection.simulateTransaction(new VersionedTransaction(draft.compileMessage()), { sigVerify: false, replaceRecentBlockhash: true });
  if (sim.value.err) {
    const { code, message } = describeTransactionError(sim.value.err);
    throw new ApiError(422, code, message);
  }
  const units = Math.min(MAX_COMPUTE_UNITS, Math.ceil((sim.value.unitsConsumed ?? MAX_COMPUTE_UNITS) * 1.2) + 1_000);
  const [price, { blockhash, lastValidBlockHeight }] = await Promise.all([
    priorityPrice(ctx, vault, units, maxPriorityFeeLamports),
    ctx.connection.getLatestBlockhash("confirmed"),
  ]);
  return compile(blockhash, lastValidBlockHeight, units, price);
}

const refuse = (reason: string): never => {
  throw new UnsafeTransactionError(reason);
};

/**
 * The depositor policy, stricter than the manager's: one signer, no lookup tables, exactly one Hedge Vault instruction
 * of the requested kind for the requested vault, owner and amount, and the fee cap. Only a SOL deposit may add more:
 * create the signer's own wSOL account, move at most `amount` lamports into it, and sync it.
 */
export function inspectDepositorTransaction(
  ctx: Pick<ChainContext, "program" | "programId">,
  tx: VersionedTransaction,
  payer: PublicKey,
  request: DepositorRequest,
  maxPriorityFeeLamports: bigint,
): void {
  const { message } = tx;
  if (message.addressTableLookups.length > 0) refuse("Expected a transaction without lookup tables");
  if (!message.staticAccountKeys[0]?.equals(payer) || message.header.numRequiredSignatures !== 1) refuse("The signer must be the only signer and the fee payer");
  const spec = SPECS[request.action];
  const accounts = ctx.program.idl.instructions.find((i) => i.name === spec.method)?.accounts ?? [];
  const keyOf = (ix: TransactionInstruction, name: string) => ix.keys[accounts.findIndex((a) => a.name === name)]?.pubkey;
  const coder = new BorshInstructionCoder(ctx.program.idl);
  const wsol = wsolAccount(payer);
  const amount = amountOf(request);
  let vaultInstructions = 0;
  let wrappedLamports = 0n;
  for (const ix of TransactionMessage.decompile(message).instructions) {
    const data = Buffer.from(ix.data);
    const key = (i: number) => ix.keys[i]?.pubkey;
    if (ix.programId.equals(ctx.programId)) {
      vaultInstructions++;
      const decoded = coder.decode(data);
      if (decoded?.name !== spec.method) refuse(`Expected only ${spec.method}, found ${decoded?.name ?? "an unknown Hedge Vault instruction"}`);
      if (!keyOf(ix, "vault")?.equals(request.vault)) refuse("Instruction is for a different vault");
      if (!keyOf(ix, spec.owner)?.equals(owner(request, payer))) refuse(`Instruction is for a different ${spec.owner}`);
      const arg: unknown = spec.arg && decoded ? (decoded.data as Record<string, unknown>)[spec.arg] : null;
      // The IDL decodes a u64 as BN, whose String() is its decimal value.
      if (spec.arg && String(arg) !== String(amount)) refuse(`Instruction ${spec.arg} does not match the request`);
    } else if (ix.programId.equals(ComputeBudgetProgram.programId)) {
      continue;
    } else if (request.action !== "deposit/create") {
      refuse(`Unexpected program ${ix.programId.toBase58()}`);
    } else if (ix.programId.equals(ATA_PROGRAM) && data.equals(Buffer.from([ATA_CREATE_IDEMPOTENT])) && key(0)?.equals(payer) && key(1)?.equals(wsol)) {
      continue;
    } else if (ix.programId.equals(SystemProgram.programId) && data.length === 12 && data.readUInt32LE(0) === SYSTEM_TRANSFER && key(0)?.equals(payer) && key(1)?.equals(wsol)) {
      wrappedLamports += data.readBigUInt64LE(4);
    } else if (ix.programId.equals(TOKEN_PROGRAM) && data.equals(Buffer.from([TOKEN_SYNC_NATIVE])) && key(0)?.equals(wsol)) {
      continue;
    } else {
      refuse(`Unexpected instruction for ${ix.programId.toBase58()}`);
    }
  }
  if (vaultInstructions !== 1) refuse("Expected exactly one Hedge Vault instruction");
  if (amount !== null && wrappedLamports > amount) refuse("Wraps more SOL than the deposit");
  checkPrograms(tx, () => true, { manager: payer, programId: ctx.programId.toBase58(), maxPriorityFeeLamports });
}

/** Builds, simulates and checks one request paid by `payer`. Unsigned. */
export async function buildDepositorTransaction(
  ctx: ChainContext,
  vault: RequestVault,
  request: DepositorRequest,
  payer: PublicKey,
  maxPriorityFeeLamports: bigint,
): Promise<Transaction> {
  amountOf(request);
  const tx = await assemble(ctx, payer, vault.key, await requestInstructions(ctx, vault, payer, request), maxPriorityFeeLamports);
  inspectDepositorTransaction(ctx, new VersionedTransaction(tx.compileMessage()), payer, request, maxPriorityFeeLamports);
  return tx;
}
