import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { SDK_VERSION, isNewerVersion } from "../src/version";

describe("SDK_VERSION", () => {
  it("matches package.json, so the User-Agent names the published version", () => {
    const pkg: unknown = JSON.parse(readFileSync(join(__dirname, "../package.json"), "utf8"));
    expect(pkg).toMatchObject({ version: SDK_VERSION });
  });
});

describe("isNewerVersion", () => {
  it("compares each part numerically", () => {
    expect([
      isNewerVersion("0.10.0", "0.9.9"),
      isNewerVersion("1.0.0", "0.99.99"),
      isNewerVersion("0.4.2", "0.4.1"),
      isNewerVersion("0.4.1", "0.4.1"),
      isNewerVersion("0.4.0", "0.4.1"),
      isNewerVersion("0.4", "0.4.1"),
      isNewerVersion("v0.5.0", "0.4.1"),
    ]).toEqual([true, true, true, false, false, false, false]);
  });
});
