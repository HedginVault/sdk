// Copies a sibling program repository's Anchor build output into this SDK so it builds without
// `target/` (e.g. in CI or from npm). Set HEDGE_VAULT_PROGRAM_REPO when the repositories are not siblings.
import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const sdkRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const programRepo = process.env.HEDGE_VAULT_PROGRAM_REPO
  ? resolve(sdkRoot, process.env.HEDGE_VAULT_PROGRAM_REPO)
  : resolve(sdkRoot, "..", "programs");
const target = join(programRepo, "target");
const out = join(sdkRoot, "src", "idl");

const files = [
  ["idl/hedge_vault.json", "hedge_vault.json"],
  ["types/hedge_vault.ts", "hedge_vault.ts"],
];

mkdirSync(out, { recursive: true });
for (const [from, to] of files) {
  const src = join(target, from);
  if (!existsSync(src)) {
    console.error(`missing ${src}; build the program repo first or set HEDGE_VAULT_PROGRAM_REPO`);
    process.exit(1);
  }
  copyFileSync(src, join(out, to));
  console.log(`synced ${from} -> src/idl/${to}`);
}
