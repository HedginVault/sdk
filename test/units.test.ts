import { describe, expect, it } from "vitest";
import { formatUnits, parseUnits } from "../src/units";

describe("parseUnits", () => {
  it("converts display amounts to base units exactly", () => {
    expect(parseUnits("1.5", 6)).toBe("1500000");
    expect(parseUnits("1,000", 6)).toBe("1000000000");
    expect(parseUnits(".25", 9)).toBe("250000000");
    expect(parseUnits("7", 0)).toBe("7");
    expect(parseUnits("123456789012345.678901", 6)).toBe("123456789012345678901");
  });
  it("refuses to round away digits the token cannot hold", () => {
    expect(() => parseUnits("0.0000001", 6)).toThrow('This token has 6 decimals; "0.0000001" has more');
  });
  it("rejects things that are not amounts", () => {
    for (const bad of ["", ".", "-1", "1e6", "abc", "1.2.3"]) expect(() => parseUnits(bad, 6)).toThrow(/is not a number/);
  });
});

describe("formatUnits", () => {
  it("round-trips with parseUnits", () => {
    for (const display of ["0.000001", "1", "1.5", "42.123456"]) expect(formatUnits(parseUnits(display, 6), 6)).toBe(display);
  });
});
