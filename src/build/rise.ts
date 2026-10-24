export type Rise = typeof import("@ellipsis-labs/rise", { with: { "resolution-mode": "import" } });

let rise: Promise<Rise> | undefined;

/** Rise ships ES modules only; a lazy `import()` keeps `require("@hedginxyz/sdk")` working on Node without require(esm). */
export const loadRise = (): Promise<Rise> => (rise ??= import("@ellipsis-labs/rise"));
