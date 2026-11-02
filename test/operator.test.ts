import { BN } from "@coral-xyz/anchor";
import { type AccountInfo, type Connection, PublicKey } from "@solana/web3.js";
import { describe, expect, it } from "vitest";
import { assertOperator, type BuildEnv, type VaultCtx } from "../src/build/context";
import type { VaultAccount } from "../src/chain/decode";
import { getDelegatePda } from "../src/chain/pda";
import { hedgeProgram } from "../src/chain/reads";
import { delegateWallet, encodeAccount, info, manager, NOW_MS, PROGRAM } from "./direct-chain";

const key = (n: number) => new PublicKey(Buffer.alloc(32, n));
const PARENT = key(60);
const CHILD = key(61);
const OWN_DELEGATE = getDelegatePda(CHILD, delegateWallet.publicKey, PROGRAM);
const PARENT_DELEGATE = getDelegatePda(PARENT, delegateWallet.publicKey, PROGRAM);

const delegate = async (vault: PublicKey, permissions: number, expiresAt: number) =>
  info(PROGRAM, await encodeAccount("delegate", { vault, authority: delegateWallet.publicKey, permissions: new BN(permissions), expiresAt: new BN(expiresAt) }));

async function check(parent: PublicKey, accounts: Map<string, AccountInfo<Buffer>>) {
  const reads: string[] = [];
  const connection = {
    getAccountInfo: async (address: PublicKey) => {
      reads.push(address.toBase58());
      return accounts.get(address.toBase58()) ?? null;
    },
  } as unknown as Connection;
  const program = hedgeProgram(connection, PROGRAM);
  const account = program.coder.accounts.decode<VaultAccount>("vault", await encodeAccount("vault", { id: new BN(3), authority: manager.publicKey, parent }));
  const vault = { key: CHILD, account } as VaultCtx;
  const env = { connection, programId: PROGRAM, program, now: () => NOW_MS } as unknown as BuildEnv;
  return { result: assertOperator(env, vault, delegateWallet.publicKey), reads };
}

describe("assertOperator", () => {
  const live = NOW_MS / 1000 + 60;
  const expired = NOW_MS / 1000;

  it("accepts a live delegate of a child vault's parent", async () => {
    const { result, reads } = await check(PARENT, new Map([[PARENT_DELEGATE.toBase58(), await delegate(PARENT, 2, live)]]));
    await expect(result).resolves.toEqual({ delegate: PARENT_DELEGATE, permissions: 2 });
    expect(reads).toEqual([OWN_DELEGATE.toBase58(), PARENT_DELEGATE.toBase58()]);
  });

  it("prefers the child vault's own live delegate", async () => {
    const accounts = new Map([
      [OWN_DELEGATE.toBase58(), await delegate(CHILD, 1, 0)],
      [PARENT_DELEGATE.toBase58(), await delegate(PARENT, 2, 0)],
    ]);
    const { result, reads } = await check(PARENT, accounts);
    await expect(result).resolves.toEqual({ delegate: OWN_DELEGATE, permissions: 1 });
    expect(reads).toEqual([OWN_DELEGATE.toBase58()]);
  });

  it("falls through an expired own delegate to the parent's live one", async () => {
    const accounts = new Map([
      [OWN_DELEGATE.toBase58(), await delegate(CHILD, 1, expired)],
      [PARENT_DELEGATE.toBase58(), await delegate(PARENT, 4, live)],
    ]);
    await expect((await check(PARENT, accounts)).result).resolves.toEqual({ delegate: PARENT_DELEGATE, permissions: 4 });
  });

  it("refuses an expired own delegate when the parent has none", async () => {
    const { result } = await check(PARENT, new Map([[OWN_DELEGATE.toBase58(), await delegate(CHILD, 1, expired)]]));
    await expect(result).rejects.toMatchObject({ status: 403, code: "DelegateExpired", message: "This wallet's delegate access to the vault has expired" });
  });

  it("refuses a wallet with no delegate on either vault", async () => {
    const { result } = await check(PARENT, new Map());
    await expect(result).rejects.toMatchObject({ status: 403, code: "Forbidden", message: "Connected wallet is not the vault authority or one of its delegates" });
  });

  it("never reads a parent delegate for a vault without a parent", async () => {
    const { result, reads } = await check(PublicKey.default, new Map([[getDelegatePda(PublicKey.default, delegateWallet.publicKey, PROGRAM).toBase58(), await delegate(PublicKey.default, 1, 0)]]));
    await expect(result).rejects.toMatchObject({ code: "Forbidden" });
    expect(reads).toEqual([OWN_DELEGATE.toBase58()]);
  });

  it("ignores an account at the delegate address that the program does not own", async () => {
    const { result } = await check(PARENT, new Map([[PARENT_DELEGATE.toBase58(), info(key(70), (await delegate(PARENT, 2, 0)).data)]]));
    await expect(result).rejects.toMatchObject({ code: "Forbidden" });
  });
});
