import { describe, expect, it } from "vitest";
import { type ActionRequest, toBuildRequest } from "../src/actions";
import { binPrice, binRangeForPrices, flipRange, flipSide } from "../src/dlmm";

const pool = { activeBinId: 0, activePrice: "100", binStep: 100 };

describe("binRangeForPrices", () => {
  it("covers the requested prices with the fewest bins", () => {
    const range = binRangeForPrices(pool, 99, 103);
    expect(range).toMatchObject({ lowerBinId: -2, upperBinId: 4, binCount: 6, sides: "both" });
    expect(range.lowPrice).toBeLessThanOrEqual(99);
    expect(range.highPrice).toBeGreaterThanOrEqual(103);
  });

  it("snaps prices that sit exactly on a bin", () => {
    expect(binRangeForPrices(pool, binPrice(pool, -3), binPrice(pool, 2))).toMatchObject({ lowerBinId: -3, upperBinId: 3, binCount: 6 });
  });

  it("reports which tokens a range can take", () => {
    expect(binRangeForPrices(pool, 90, 95).sides).toBe("y");
    expect(binRangeForPrices(pool, 105, 110).sides).toBe("x");
  });

  it("works for small-priced pools", () => {
    const meme = { activeBinId: -5000, activePrice: "0.00001234", binStep: 25 };
    const range = binRangeForPrices(meme, 0.000011, 0.000013);
    expect(range.sides).toBe("both");
    expect(range.lowPrice).toBeLessThanOrEqual(0.000011);
    expect(range.highPrice).toBeGreaterThanOrEqual(0.000013);
  });

  it("rejects invalid or too-wide ranges", () => {
    expect(() => binRangeForPrices(pool, 0, 10)).toThrow("Prices must be positive numbers");
    expect(() => binRangeForPrices(pool, 10, 10)).toThrow("Min price must be below max price");
    expect(() => binRangeForPrices({ ...pool, binStep: 1 }, 1, 1000)).toThrow(/needs \d+ bins; the maximum is 1400/);
  });
});

describe("flipSide", () => {
  it("flips the non-deposit token", () => {
    expect(flipSide("SOL", "USDC")).toBe("x");
    expect(flipSide("USDC", "USDC")).toBe("y");
  });
});

describe("flipRange", () => {
  const selection = { lowerBinId: -3, upperBinId: 4 };

  it("keeps the bins strictly above the active bin for X", () => {
    expect(flipRange(selection, 0, "x")).toEqual({ lowerBinId: 1, upperBinId: 4 });
    expect(flipRange({ lowerBinId: 2, upperBinId: 4 }, 0, "x")).toEqual({ lowerBinId: 2, upperBinId: 4 });
  });

  it("keeps the bins strictly below the active bin for Y", () => {
    expect(flipRange(selection, 0, "y")).toEqual({ lowerBinId: -3, upperBinId: -1 });
    expect(flipRange({ lowerBinId: -3, upperBinId: -2 }, 0, "y")).toEqual({ lowerBinId: -3, upperBinId: -2 });
  });

  it("returns null when the side has no bins", () => {
    expect(flipRange(selection, 4, "x")).toBeNull();
    expect(flipRange(selection, -3, "y")).toBeNull();
    expect(flipRange({ lowerBinId: 0, upperBinId: 0 }, 0, "x")).toBeNull();
  });
});

describe("bin-range actions", () => {
  it("send the inclusive range in the body", () => {
    const remove: ActionRequest = { action: "dlmm/remove", vault: "V", position: "P", bpsToRemove: 10_000, lowerBinId: 1, upperBinId: 4 };
    expect(toBuildRequest(remove)).toEqual({
      action: "dlmm/remove",
      body: { vault: "V", position: "P", bpsToRemove: 10_000, lowerBinId: 1, upperBinId: 4 },
    });
    // @ts-expect-error both ends or neither
    const half: ActionRequest = { action: "dlmm/remove", vault: "V", position: "P", bpsToRemove: 10_000, lowerBinId: 1 };
    expect(half.action).toBe("dlmm/remove");
  });
});
