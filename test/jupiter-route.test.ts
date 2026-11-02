import { AddressLookupTableAccount, Keypair, PublicKey, TransactionInstruction } from "@solana/web3.js";
import { describe, expect, it } from "vitest";
import { fitsInTransaction, MAX_TX_ACCOUNTS } from "../src/build/assemble";
import { jupiterConfig } from "../src/build/jupiter-api";
import { routeMaxAccounts, routesBestFirst, separateSwapPays, slippageWithin } from "../src/build/jupiter-route";
import { ApiError } from "../src/errors";

const key = (n: number) => new PublicKey(Buffer.alloc(32, n));
const payer = Keypair.fromSeed(new Uint8Array(32).fill(9)).publicKey;

describe("slippageWithin", () => {
  const minOut = { inAmount: "1000000", minOutAmount: "990000" };

  it("tightens the route's slippage to what keeps the approved floor", () => {
    // Floor 990_000 for the same input; (1_000_000 - 990_000) * 10_000 / 1_000_000 = 100 bps.
    expect(slippageWithin(1_000_000n, 1_000_000n, minOut, 300)).toBe(100);
  });

  it("keeps the asked slippage when it is already tighter than the floor needs", () => {
    expect(slippageWithin(1_000_000n, 1_000_000n, minOut, 50)).toBe(50);
  });

  it("scales the floor to the amount swapped, rounding it up", () => {
    // 990_000 * 333_333 / 1_000_000 = 329_999.67, so the floor is 330_000: (340_000 - 330_000) * 10_000 / 340_000 = 294.1, floored.
    expect(slippageWithin(340_000n, 333_333n, minOut, 1_000)).toBe(294);
  });

  it("takes no slippage at exactly the floor", () => {
    expect(slippageWithin(990_000n, 1_000_000n, minOut, 300)).toBe(0);
  });

  it("fails with QuoteMoved one unit below the floor", () => {
    expect(() => slippageWithin(989_999n, 1_000_000n, minOut, 300)).toThrow(
      new ApiError(409, "QuoteMoved", "The price moved past your slippage since the quote. Review the new quote and try again."),
    );
  });
});

describe("separateSwapPays", () => {
  it("needs at least 25 bps more output", () => {
    expect(separateSwapPays(1_000_000n, 1_002_500n)).toBe(true);
    expect(separateSwapPays(1_000_000n, 1_002_499n)).toBe(false);
  });
});

describe("routesBestFirst", () => {
  const quote = (outAmount: string, label: string) => ({ inAmount: "100", outAmount, priceImpactPct: "0", routePlan: [{ swapInfo: { label } }] });

  /** Answers each cap's quote from `byCap`, an error status for a missing one. */
  const jupiter = (byCap: Record<string, ReturnType<typeof quote>>) => {
    const fetch: typeof globalThis.fetch = async (input) => {
      const cap = new URL(String(input)).searchParams.get("maxAccounts") ?? "";
      const body = byCap[cap];
      return body ? new Response(JSON.stringify(body)) : new Response("down", { status: 500 });
    };
    return { fetch, jupiter: jupiterConfig() };
  };
  const quoteAt = (env: ReturnType<typeof jupiter>, caps: number[]) => routesBestFirst(env, key(1), key(2), 100n, 50, caps);

  it("puts the higher-paying route first, whichever cap found it", async () => {
    const routes = await quoteAt(jupiter({ 40: quote("900", "Thin"), 44: quote("1000", "Deep") }), [40, 44]);
    expect(routes.map((r) => [r.view.routeLabels, r.view.outAmount])).toEqual([
      [["Deep"], "1000"],
      [["Thin"], "900"],
    ]);
  });

  it("keeps one of two caps that found the same route", async () => {
    const same = quote("1000", "Deep");
    expect(await quoteAt(jupiter({ 40: same, 44: same }), [40, 44])).toHaveLength(1);
  });

  it("skips a cap that failed while another answered, and throws the first error when none did", async () => {
    expect((await quoteAt(jupiter({ 44: quote("1000", "Deep") }), [40, 44])).map((r) => r.view.outAmount)).toEqual(["1000"]);
    await expect(quoteAt(jupiter({}), [40, 44])).rejects.toMatchObject({ code: "JupiterQuoteFailed" });
  });
});

describe("routeMaxAccounts", () => {
  it("leaves the route what the rest of the transaction does not lock, sharing four accounts and keeping five hops", () => {
    expect(routeMaxAccounts(19)).toBe(MAX_TX_ACCOUNTS - 15 - 5);
  });
});

describe("fitsInTransaction", () => {
  const addresses = Array.from({ length: 100 }, (_, i) => key(i + 1));
  const table = new AddressLookupTableAccount({
    key: key(250),
    state: { deactivationSlot: 0xffff_ffff_ffff_ffffn, lastExtendedSlot: 0, lastExtendedSlotStartIndex: 0, addresses },
  });
  /** One instruction reading `count` table accounts: a few hundred bytes, far inside the packet. */
  const reading = (count: number) =>
    new TransactionInstruction({ programId: key(200), keys: addresses.slice(0, count).map((pubkey) => ({ pubkey, isSigner: false, isWritable: false })), data: Buffer.alloc(0) });

  it("accepts a transaction locking 64 accounts: payer, compute budget, program and 61 looked up", () => {
    expect(fitsInTransaction(payer, [reading(61)], [table])).toBe(true);
  });

  it("rejects one locking 65, though its bytes fit the packet", () => {
    expect(fitsInTransaction(payer, [reading(62)], [table])).toBe(false);
  });
});
