import type { IdlAccounts } from "@coral-xyz/anchor";
import { PublicKey, type TransactionInstruction } from "@solana/web3.js";
import { z } from "zod";
import { type ConfigAccount, decodeTokenAmount } from "../chain/decode";
import { getAssociatedTokenAddress, getConfigPda, getStrategyPda } from "../chain/pda";
import { decodeVault } from "../chain/reads";
import { ApiError } from "../errors";
import type { HedgeVault } from "../idl/hedge_vault";
import type { Quote } from "../schemas";
import { assemble, type Assembled, fitsInTransaction } from "./assemble";
import { amountString, assertOperator, type BuildEnv, DELEGATE_JUPITER, delegateFor, loadVaultCtx, type Operator, pubkey, tokenProgramOf, type VaultCtx } from "./context";
import { jupiterInitializeIx } from "./jupiter-initialize";
import { jupiterSwapIx, quoteSwap, type SwapMints } from "./jupiter-route";
import { closeJupiterStrategyIx } from "./strategy";

const DLMM_PROGRAM_ID = new PublicKey("LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo");
const LIMIT_ORDER_DISCRIMINATOR = Buffer.from([137, 183, 212, 91, 115, 29, 141, 227]);
const STRATEGY_VAULT_OFFSET = 8;
const TOKEN_ACCOUNT_SPAN = 165;
const TRANSFER_FEE_AMOUNT_EXTENSION = 2;

const slippageBps = z.number().int().min(1).max(10_000);

export const jupiterSwapInput = z.object({ vault: pubkey, sourceMint: pubkey, destinationMint: pubkey, amount: amountString, slippageBps });
export const jupiterSweepInput = z.object({ vault: pubkey, mint: pubkey, slippageBps });

/** A swap step, and the local continuation that follows it. */
export type SwapStep = Assembled & {
  initializesStrategy?: boolean;
  next?: { path: "jupiter/swap"; body: z.infer<typeof jupiterSwapInput> } | { path: "jupiter/sweep"; body: z.infer<typeof jupiterSweepInput> };
};

/** Zero is a legacy unset value; the program then applies DEFAULT_MAX_SLIPPAGE_BPS (10%). */
const maxSlippageBps = (env: Pick<BuildEnv, "program">, info: { data: Buffer } | null | undefined) => {
  if (!info) throw new Error("Protocol config account is missing");
  return env.program.coder.accounts.decode<ConfigAccount>("config", info.data).maxSlippageBps || 1_000;
};

/** Token-2022 fees withheld in a token account, which the token program refuses to close. */
function withheldTransferFee(data: Buffer): bigint {
  // Base account, then one account-type byte, then type-length-value extensions.
  for (let at = TOKEN_ACCOUNT_SPAN + 1; at + 4 <= data.length; ) {
    const type = data.readUInt16LE(at);
    const length = data.readUInt16LE(at + 2);
    if (type === TRANSFER_FEE_AMOUNT_EXTENSION && length >= 8 && at + 12 <= data.length) return data.readBigUInt64LE(at + 4);
    at += 4 + length;
  }
  return 0n;
}

/** An open DLMM position or limit-order strategy and its pair mints; `null` when they could not be read. */
interface OpenPairStrategy {
  strategy: string;
  mints: string[] | null;
}

/** Every DLMM action needs the Jupiter strategy of each non-deposit pair mint; an unreadable pair counts as using every mint. */
const mintStillUsed = (open: OpenPairStrategy[], mint: string) => open.some((s) => s.mints === null || s.mints.includes(mint));

/** 3 RPC: the vault's strategies, its positions and limit orders, then their pools. */
async function readOpenPairStrategies(env: BuildEnv, vault: PublicKey): Promise<OpenPairStrategy[]> {
  const coder = env.program.coder.accounts;
  const rows = await env.connection.getProgramAccounts(env.programId, {
    filters: [{ memcmp: coder.memcmp("strategy") }, { memcmp: { offset: STRATEGY_VAULT_OFFSET, bytes: vault.toBase58() } }],
  });
  const pairs = rows.flatMap(({ pubkey: strategy, account }) => {
    const { strategyType } = coder.decode<IdlAccounts<HedgeVault>["strategy"]>("strategy", account.data);
    if (strategyType.meteoraDlmm) return [{ strategy, account: strategyType.meteoraDlmm.position, isLimitOrder: false }];
    if (strategyType.meteoraDlmmLimitOrder) return [{ strategy, account: strategyType.meteoraDlmmLimitOrder.limitOrder, isLimitOrder: true }];
    return [];
  });
  if (pairs.length === 0) return [];
  const infos = await env.connection.getMultipleAccountsInfo(pairs.map((p) => p.account));
  const lbPairs = pairs.map((p, i): PublicKey | null => {
    const info = infos[i];
    if (!info?.owner.equals(DLMM_PROGRAM_ID)) return null;
    if (p.isLimitOrder)
      return info.data.length >= 40 && info.data.subarray(0, 8).equals(LIMIT_ORDER_DISCRIMINATOR) ? new PublicKey(info.data.subarray(8, 40)) : null;
    try {
      return coder.decode<IdlAccounts<HedgeVault>["positionV2"]>("positionV2", info.data).lbPair;
    } catch {
      return null;
    }
  });
  const unique = [...new Set(lbPairs.flatMap((k) => (k ? [k.toBase58()] : [])))].map((k) => new PublicKey(k));
  const pairInfos = unique.length ? await env.connection.getMultipleAccountsInfo(unique) : [];
  const mintsOf = new Map(
    unique.map((k, i) => {
      const info = pairInfos[i];
      if (!info) return [k.toBase58(), null];
      const pair = coder.decode<IdlAccounts<HedgeVault>["lbPair"]>("lbPair", info.data);
      return [k.toBase58(), [pair.tokenXMint.toBase58(), pair.tokenYMint.toBase58()]];
    }),
  );
  return pairs.map((p, i) => {
    const lbPair = lbPairs[i];
    return { strategy: p.strategy.toBase58(), mints: (lbPair && mintsOf.get(lbPair.toBase58())) ?? null };
  });
}

/**
 * The close of the source strategy when the swap sells the vault's whole balance of a target mint,
 * so no empty strategy is left behind. `null` while an open LP position or limit order still needs
 * the strategy, or the token account holds withheld transfer fees. 1-4 RPC.
 */
async function closeEmptiedStrategyIx(env: BuildEnv, vault: VaultCtx, operator: Operator, mints: SwapMints, amount: bigint) {
  if (mints.source.equals(vault.depositMint)) return null;
  const info = await env.connection.getAccountInfo(getAssociatedTokenAddress(vault.key, mints.source, mints.sourceTokenProgram));
  if (!info || decodeTokenAmount(info.data) !== amount || withheldTransferFee(info.data) > 0n) return null;
  if (mintStillUsed(await readOpenPairStrategies(env, vault.key), mints.source.toBase58())) return null;
  return closeJupiterStrategyIx(env, vault, operator, mints.source, mints.sourceTokenProgram);
}

/** The vault, its operator check, and the slippage cap: 4 RPC. Checks the Jupiter permission before any Jupiter call. */
async function loadSwapCtx(env: BuildEnv, address: string, mintKeys: PublicKey[], requestedSlippageBps: number) {
  const vault = await loadVaultCtx(env, address);
  const operator = await assertOperator(env, vault, env.payer);
  const delegate = delegateFor(operator, DELEGATE_JUPITER);
  const [config, ...mintInfos] = await env.connection.getMultipleAccountsInfo([getConfigPda(env.programId), ...mintKeys]);
  return { vault, operator, delegate, mintInfos, slippageBps: Math.min(requestedSlippageBps, maxSlippageBps(env, config)) };
}

export async function buildJupiterSwap(env: BuildEnv, b: z.infer<typeof jupiterSwapInput>): Promise<SwapStep> {
  const source = new PublicKey(b.sourceMint);
  const destination = new PublicKey(b.destinationMint);
  if (source.equals(destination)) throw new ApiError(400, "Validation", "sourceMint and destinationMint must differ");
  const { vault, operator, delegate, mintInfos, slippageBps } = await loadSwapCtx(env, b.vault, [source, destination], b.slippageBps);
  const mints: SwapMints = {
    source,
    destination,
    sourceTokenProgram: tokenProgramOf(source, mintInfos[0] ?? null),
    destinationTokenProgram: tokenProgramOf(destination, mintInfos[1] ?? null),
  };

  // Every non-deposit side needs its strategy before `jupiter_swap`; the first swap into a token creates it.
  const targets = [source, destination].filter((mint) => !mint.equals(vault.account.depositMint));
  const strategies = await env.connection.getMultipleAccountsInfo(targets.map((mint) => getStrategyPda(vault.key, mint, env.programId)));
  const inits = await Promise.all(targets.filter((_, i) => !strategies[i]).map((mint) => jupiterInitializeIx(env, vault, operator, mint)));

  const amount = BigInt(b.amount);
  const { ix, lookupTables, setup } = await jupiterSwapIx(env, vault, delegate, mints, amount, slippageBps);
  const closeIx = await closeEmptiedStrategyIx(env, vault, operator, mints, amount);
  // The close rides behind the swap, or follows as a sweep (a bare close by then) when it does not fit.
  const swapAndClose = async (ixs: TransactionInstruction[], initializesStrategy: boolean): Promise<SwapStep> => {
    const fits = closeIx !== null && fitsInTransaction(env.payer, [...ixs, closeIx], lookupTables);
    return {
      ...(await assemble(env, fits && closeIx ? [...ixs, closeIx] : ixs, lookupTables)),
      initializesStrategy,
      ...(closeIx && !fits && { next: { path: "jupiter/sweep", body: { vault: b.vault, mint: b.sourceMint, slippageBps } } }),
    };
  };

  if (inits.length === 0) return swapAndClose([...setup, ix], false);
  if (fitsInTransaction(env.payer, [...inits, ...setup, ix], lookupTables)) return swapAndClose([...inits, ...setup, ix], true);
  return { ...(await assemble(env, inits)), initializesStrategy: true, next: { path: "jupiter/swap", body: b } };
}

/** Sells the vault's entire balance of `mint` to the deposit mint and closes its strategy, atomically when both fit. */
export async function buildJupiterSweep(env: BuildEnv, b: z.infer<typeof jupiterSweepInput>): Promise<SwapStep> {
  const mint = new PublicKey(b.mint);
  const { vault, operator, delegate, mintInfos, slippageBps } = await loadSwapCtx(env, b.vault, [mint], b.slippageBps);
  if (mint.equals(vault.depositMint)) throw new ApiError(400, "Validation", "mint must differ from the vault deposit mint");
  const tokenProgram = tokenProgramOf(mint, mintInfos[0] ?? null);

  const [[ataInfo, strategyInfo], openPairStrategies] = await Promise.all([
    env.connection.getMultipleAccountsInfo([getAssociatedTokenAddress(vault.key, mint, tokenProgram), getStrategyPda(vault.key, mint, env.programId)]),
    readOpenPairStrategies(env, vault.key),
  ]);
  if (mintStillUsed(openPairStrategies, mint.toBase58()))
    throw new ApiError(409, "MintInUse", "An open LP position or limit order still uses this token; close it first");
  if (!strategyInfo) throw new ApiError(409, "NothingToSweep", "The vault has no Jupiter strategy for this token");

  const balance = decodeTokenAmount(ataInfo?.data);
  const closeIx = await closeJupiterStrategyIx(env, vault, operator, mint, tokenProgram);
  if (balance === 0n) return assemble(env, [closeIx]);

  let swap: Awaited<ReturnType<typeof jupiterSwapIx>>;
  try {
    const mints = { source: mint, destination: vault.depositMint, sourceTokenProgram: tokenProgram, destinationTokenProgram: vault.tokenProgram };
    swap = await jupiterSwapIx(env, vault, delegate, mints, balance, slippageBps);
  } catch (e) {
    if (e instanceof ApiError && e.code === "JupiterQuoteFailed")
      throw new ApiError(422, "SweepUnroutable", "Jupiter found no route for this leftover token; it stays in the vault");
    throw e;
  }
  const ixs = [...swap.setup, swap.ix];
  if (fitsInTransaction(env.payer, [...ixs, closeIx], swap.lookupTables)) return assemble(env, [...ixs, closeIx], swap.lookupTables);
  if (!fitsInTransaction(env.payer, ixs, swap.lookupTables)) throw new ApiError(422, "TransactionTooLarge", "Selling this token does not fit in one transaction");
  // A long route leaves no room for the close: it follows as a second sweep, a bare close by then.
  return { ...(await assemble(env, ixs, swap.lookupTables)), next: { path: "jupiter/sweep", body: { vault: b.vault, mint: b.mint, slippageBps } } };
}

export const quoteInput = z.object({ vault: pubkey, inputMint: pubkey, outputMint: pubkey, amount: amountString, slippageBps });

/** 1 RPC and 1 HTTP: the app's `/jupiter/quote`, slippage capped by the protocol config. */
export async function readQuote(env: Pick<BuildEnv, "connection" | "programId" | "program" | "fetch" | "jupiter">, request: unknown): Promise<Quote> {
  const parsed = quoteInput.safeParse(request);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new ApiError(400, "Validation", `${issue?.path.join(".") || "request"}: ${issue?.message ?? "invalid"}`);
  }
  const q = parsed.data;
  const inputMint = new PublicKey(q.inputMint);
  const outputMint = new PublicKey(q.outputMint);
  if (inputMint.equals(outputMint)) throw new ApiError(400, "Validation", "inputMint and outputMint must differ");
  // A quote is only ever built into a `jupiter_swap` of this vault, so an unknown vault fails before Jupiter is called.
  const [vaultInfo, configInfo] = await env.connection.getMultipleAccountsInfo([new PublicKey(q.vault), getConfigPda(env.programId)]);
  decodeVault({ programId: env.programId, coder: env.program.coder.accounts }, vaultInfo ?? null);
  const slippage = Math.min(q.slippageBps, maxSlippageBps(env, configInfo));
  const { view } = await quoteSwap(env, inputMint, outputMint, BigInt(q.amount), slippage);
  return { ...view, slippageBps: slippage };
}
