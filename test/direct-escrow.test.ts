import { BN } from "@coral-xyz/anchor";
import type { AccountInfo, PublicKey } from "@solana/web3.js";
import { describe, expect, it } from "vitest";
import { getAssociatedTokenAddress, getStrategyPda, getVaultPda } from "../src/chain/pda";
import {
  BONK, BONK_STRATEGY, DELEGATE, M, NEXT_VAULT, P, POSITION, PROGRAM, TOKEN_2022, TOKEN_PROGRAM, USDC, V, VAULT,
  ata, chain, delegateWallet, encodeAccount, info, manager, run,
} from "./direct-chain";

const CHILD = getVaultPda(2n, PROGRAM);
const C = CHILD.toBase58();
const OTHER_PARENT = getVaultPda(9n, PROGRAM);
const CHILD_BONK_STRATEGY = getStrategyPda(CHILD, BONK, PROGRAM);

function tokenAccount(mint: PublicKey, owner: PublicKey, amount: bigint): Buffer {
  const data = Buffer.alloc(165);
  mint.toBuffer().copy(data, 0);
  owner.toBuffer().copy(data, 32);
  data.writeBigUInt64LE(amount, 64);
  data.writeUInt8(1, 108);
  return data;
}

/** The base chain plus a child vault of VAULT (or of `parent`), and the delegate given every permission when `allPermissions`. */
async function family(o: { parent?: PublicKey; allPermissions?: boolean } = {}) {
  const accounts = await chain({ permissions: o.allPermissions ? 7 : 1, expiresAt: 0 });
  const vault = (fields: Record<string, unknown>) => encodeAccount("vault", { authority: manager.publicKey, depositMint: USDC, ...fields });
  accounts.set(C, info(PROGRAM, await vault({ id: new BN(2), parent: o.parent ?? VAULT })));
  accounts.set(V, info(PROGRAM, await vault({ id: new BN(1), childCount: 1 })));
  return accounts;
}

const set = async (accounts: Map<string, AccountInfo<Buffer>>, address: PublicKey, owner: PublicKey, data: Buffer | Promise<Buffer>) =>
  accounts.set(address.toBase58(), info(owner, await data));

describe("direct escrow/create", () => {
  it("creates the child at the next vault id and funds it in the same transaction", async () => {
    const { outcome, txs } = await run({ action: "escrow/create", vault: V, name: "Desk", fundAmount: "2500000" });
    expect(outcome).toMatchObject({ kind: "confirmed", created: { child: NEXT_VAULT.toBase58() } });
    const [tx] = txs;
    expect(tx?.hedge.map((h) => h.name)).toEqual(["escrowCreate", "escrowTransfer"]);
    expect(tx?.hedge[0]?.args).toEqual({ args: { name: [...Buffer.from("Desk"), ...Array<number>(28).fill(0)] } });
    expect(tx?.hedge[0]?.accounts).toMatchObject({ authority: M, parent: V, child: NEXT_VAULT.toBase58(), child_token_account: ata(NEXT_VAULT, USDC, TOKEN_PROGRAM) });
    expect(tx?.hedge[1]?.args).toEqual({ amount: "2500000" });
    expect(tx?.hedge[1]?.accounts).toMatchObject({
      parent: V,
      source: V,
      destination: NEXT_VAULT.toBase58(),
      mint: USDC.toBase58(),
      source_strategy: P,
      destination_strategy: P,
      delegate: P,
    });
  });

  it("refuses a child vault as parent, which cannot have children", async () => {
    const { outcome, sent } = await run({ action: "escrow/create", vault: C, name: "Nested" }, {}, manager, await family());
    expect(outcome).toMatchObject({ kind: "failed", code: "Validation", message: "A child vault cannot have child vaults" });
    expect(sent).toEqual([]);
  });

  it("refuses a delegate: only the authority creates child vaults", async () => {
    const { outcome } = await run({ action: "escrow/create", vault: V, name: "Desk" }, {}, delegateWallet, await family({ allPermissions: true }));
    expect(outcome).toMatchObject({ kind: "failed", code: "Forbidden" });
  });
});

describe("direct escrow/fund and escrow/defund", () => {
  it("creates the child's Jupiter strategy before moving a tracked token into it", async () => {
    const { outcome, txs } = await run({ action: "escrow/fund", vault: V, child: C, amount: "40", mint: BONK.toBase58() }, {}, manager, await family());
    expect(outcome).toMatchObject({ kind: "confirmed" });
    const [tx] = txs;
    expect(tx?.hedge.map((h) => h.name)).toEqual(["jupiterInitializeStrategy", "escrowTransfer"]);
    expect(tx?.hedge[0]?.accounts).toMatchObject({ vault: C, destination_mint: BONK.toBase58() });
    expect(tx?.hedge[1]?.accounts).toMatchObject({
      source: V,
      destination: C,
      mint: BONK.toBase58(),
      source_token_account: ata(VAULT, BONK, TOKEN_2022),
      destination_token_account: ata(CHILD, BONK, TOKEN_2022),
      source_strategy: BONK_STRATEGY.toBase58(),
      destination_strategy: CHILD_BONK_STRATEGY.toBase58(),
      token_program: TOKEN_2022.toBase58(),
    });
  });

  it("refuses a token the sending vault does not track", async () => {
    const { outcome } = await run({ action: "escrow/defund", vault: V, child: C, amount: "40", mint: BONK.toBase58() }, {}, manager, await family());
    expect(outcome).toMatchObject({ kind: "failed", code: "Validation", message: "The sending vault does not hold this token" });
  });

  it("refuses a child of another vault", async () => {
    const { outcome } = await run({ action: "escrow/defund", vault: V, child: C, amount: "1" }, {}, manager, await family({ parent: OTHER_PARENT }));
    expect(outcome).toMatchObject({ kind: "failed", code: "Validation", message: "child does not belong to this vault" });
  });

  it("accepts any live delegate of the parent, as the program does: no value leaves the family", async () => {
    const { outcome, txs } = await run({ action: "escrow/defund", vault: V, child: C, amount: "1" }, {}, delegateWallet, await family());
    expect(outcome).toMatchObject({ kind: "confirmed" });
    expect(txs[0]?.hedge[0]?.accounts).toMatchObject({ authority: delegateWallet.publicKey.toBase58(), source: C, destination: V, delegate: DELEGATE.toBase58() });
  });
});

describe("direct escrow/transfer", () => {
  it("refuses the same source and destination before reading the chain", async () => {
    const { outcome, reads } = await run({ action: "escrow/transfer", vault: V, source: C, destination: C, amount: "1" }, {}, manager, await family());
    expect(outcome).toMatchObject({ kind: "failed", code: "Validation" });
    expect(reads).toEqual([]);
  });

  it("moves between the parent and a child in either direction", async () => {
    const { txs } = await run({ action: "escrow/transfer", vault: V, source: C, destination: V, amount: "7" }, {}, manager, await family());
    expect(txs[0]?.hedge[0]?.accounts).toMatchObject({ parent: V, source: C, destination: V, source_token_account: ata(CHILD, USDC, TOKEN_PROGRAM) });
  });
});

describe("direct escrow/close", () => {
  it("closes alone without defundFirst", async () => {
    const { txs } = await run({ action: "escrow/close", vault: V, child: C }, {}, manager, await family());
    expect(txs[0]?.hedge.map((h) => h.name)).toEqual(["escrowClose"]);
    expect(txs[0]?.hedge[0]?.accounts).toMatchObject({ parent: V, child: C, child_token_account: ata(CHILD, USDC, TOKEN_PROGRAM), usdc_token_account: P });
  });

  it("returns every token, closes the emptied strategy, then closes the child", async () => {
    const accounts = await family();
    await set(accounts, CHILD_BONK_STRATEGY, PROGRAM, encodeAccount("strategy", { vault: CHILD, strategyType: { jupiterSwap: { targetMint: BONK } } }));
    await set(accounts, getAssociatedTokenAddress(CHILD, BONK, TOKEN_2022), TOKEN_2022, tokenAccount(BONK, CHILD, 40n));
    await set(accounts, getAssociatedTokenAddress(CHILD, USDC, TOKEN_PROGRAM), TOKEN_PROGRAM, tokenAccount(USDC, CHILD, 900n));
    const { outcome, txs } = await run({ action: "escrow/close", vault: V, child: C, defundFirst: true }, {}, manager, accounts);
    expect(outcome).toMatchObject({ kind: "confirmed" });
    const hedge = txs[0]?.hedge ?? [];
    expect(hedge.map((h) => h.name)).toEqual(["escrowTransfer", "vaultCloseStrategy", "escrowTransfer", "escrowClose"]);
    expect(hedge[0]?.args).toEqual({ amount: "40" });
    expect(hedge[0]?.accounts).toMatchObject({ source: C, destination: V, mint: BONK.toBase58() });
    expect(hedge[1]?.accounts).toMatchObject({ vault: C, strategy: CHILD_BONK_STRATEGY.toBase58() });
    expect(hedge[2]?.args).toEqual({ amount: "900" });
    expect(hedge[2]?.accounts).toMatchObject({ source: C, destination: V, mint: USDC.toBase58() });
  });

  it("refuses to defund a child that still has an LP position", async () => {
    const accounts = await family();
    await set(accounts, getStrategyPda(CHILD, POSITION, PROGRAM), PROGRAM, encodeAccount("strategy", { vault: CHILD, strategyType: { meteoraDlmm: { position: POSITION } } }));
    const { outcome, sent } = await run({ action: "escrow/close", vault: V, child: C, defundFirst: true }, {}, manager, accounts);
    expect(outcome).toMatchObject({ kind: "failed", code: "Validation", message: "Close the child vault's positions, orders and Phoenix account first" });
    expect(sent).toEqual([]);
  });

  it("refuses a delegate", async () => {
    const { outcome } = await run({ action: "escrow/close", vault: V, child: C }, {}, delegateWallet, await family({ allPermissions: true }));
    expect(outcome).toMatchObject({ kind: "failed", code: "Forbidden" });
  });
});

