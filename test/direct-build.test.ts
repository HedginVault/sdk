import { SendTransactionError } from "@solana/web3.js";
import { describe, expect, it } from "vitest";
import { getAssociatedTokenAddress, getConfigPda, getManagerPda, getShareMintPda, getStrategyPda } from "../src/chain/pda";
import { type DirectActionRequest, createDirectClient } from "../src/direct";
import { keypairSigner } from "../src/signer";
import {
  BLOCKHASH, BONK, BONK_STRATEGY, CONFIRMED, DELEGATE, DLMM, DLMM_EVENT_AUTHORITY, DLMM_STRATEGY, LIMIT_ORDER, LIMIT_STRATEGY, M, NEXT_VAULT, NOW_MS,
  P, PHOENIX_GLOBAL_CONFIG, PHOENIX_STRATEGY, POOL, POSITION, PROGRAM, SHARE_MINT, SOL, TOKEN_2022, TOKEN_PROGRAM, TRADER, USDC, V, VAULT,
  ata, chain, delegateWallet, encodeAccount, fakeConnection, info, key, manager, run, signatureOf, stranger,
} from "./direct-chain";


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
      // @ts-expect-error dlmm/claim-fee still needs createHedgeClient
      { action: "dlmm/claim-fee", vault: V, position: POSITION.toBase58() },
      keypairSigner(manager),
    );
    expect(outcome).toEqual({ kind: "failed", signatures: [], code: "NotFound", message: "dlmm/claim-fee has no local builder; use createHedgeClient" });
  });
});
