import { describe, expect, it } from "vitest";
import { binPrice, binRangeForPrices } from "../src/dlmm";

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
