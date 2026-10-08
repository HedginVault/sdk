# @hedginvault/sdk

TypeScript client for the Hedge Vault manager bot API (V1). It turns the API's
build → sign → send → confirm sequence into one call, and refuses to sign any server-built
transaction that could move funds out of the manager wallet.

The API still builds every transaction. The SDK only calls it, checks what comes back, signs
locally, and tracks the result. The manager key never leaves your process.

## Install

Not yet published to npm. Until then, consume a packed tarball:

```sh
cd sdk && yarn build && yarn pack --filename ../my-bot/vendor/hedginvault-sdk.tgz
cd ../my-bot && yarn add file:./vendor/hedginvault-sdk.tgz @solana/web3.js
```

`@solana/web3.js` is a peer dependency, so the SDK and your code share one copy of
`Keypair`, `PublicKey`, and `VersionedTransaction`.

## Use

```ts
import { createHedgeClient, keypairFromFile, keypairSigner } from "@hedginvault/sdk";

const hedge = createHedgeClient({ apiKey: process.env.HEDGE_API_KEY! });
const signer = keypairSigner(keypairFromFile("/secure/path/manager.json"));

const [vault] = await hedge.listVaults();
const holdings = await hedge.getHoldings(vault.address);

const outcome = await hedge.execute(
  {
    action: "jupiter/swap",
    vault: vault.address,
    sourceMint: holdings.depositToken.mint,
    destinationMint: "So11111111111111111111111111111111111111112",
    amount: "1000000", // base units: 1 USDC
    slippageBps: 50,
  },
  signer,
  { onProgress: (p) => console.log(p) },
);
```

`outcome.kind` is one of:

| Kind | Meaning | What to do |
| --- | --- | --- |
| `confirmed` | Every transaction landed. | Done. |
| `refused` | The API built a transaction the SDK will not sign. Nothing was sent. | Report it; do not bypass. |
| `failed` | The API rejected the request, or a transaction failed on chain. `code` and `message` say why. | Earlier transactions in a batch may have landed; read state before retrying. |
| `unresolved` | Sent, but the result is unknown after 120 s. `pending` lists the signatures. | Check an explorer. Do not resend blindly. |

## Actions

`jupiter/swap`, `dlmm/open`, `dlmm/add`, `dlmm/remove`, `dlmm/claim-fee`, `dlmm/zap-out`, and
`strategy/close`, with typed bodies (`ActionRequest`). `execute` follows batch order
(`sendConcurrently` groups, confirmation barriers) and `next` continuations
(`dlmm/extend`, `dlmm/add-range`, `dlmm/zap-out/swap`) on its own.

The API key needs `send` plus each builder action it uses.

Helpers for user-facing input: `getToken(vault, mint)` resolves a pasted contract address to
symbol, decimals, and Jupiter verification (app PR #18); `parseUnits("1.5", decimals)` and
`formatUnits` convert amounts without floating point; `binRangeForPrices(pool, min, max)`
turns a human price range into `lowerBinId`/`upperBinId`, with the bin count and which
tokens the range can hold.

To open a position, read the pool first with `getPool(vault, lbPair)` and choose
`lowerBinId` and an exclusive `upperBinId` around its `activeBinId` (requires the app's
`GET /dlmm/pools/{lbPair}` route, app PR #17).

## Safety

Before signing, every transaction in a build must:

- be a v0 transaction paid by the signer's key;
- already carry every other required signature (for example a new DLMM position);
- call only the Hedge Vault program, ComputeBudget, Associated Token Account, Meteora DLMM, or Jupiter at the top level;
- set a priority fee at or below 100,000 microLamports per CU (`maxComputeUnitPriceMicroLamports`).

The whole build is inspected before any of it is sent. After an ambiguous send, the SDK
polls the same receipt and never rebuilds, because a rebuild could execute the action twice.

`TransactionSigner` is an interface, so a hardware wallet or KMS-backed signer can replace
`keypairSigner` without other changes.

## API checker

`hedge-check-api` (or `yarn check-api` in this repo) probes a live API with `HEDGE_API_KEY`
and optional `HEDGE_API_BASE_URL`: auth, routing, validation, error-body hygiene, and every
read endpoint against the schemas this SDK parses. `--build` adds one unsigned swap build
per vault; nothing is signed or sent. A failure here means the API and this SDK disagree.

## Develop

```sh
yarn install --frozen-lockfile
yarn typecheck && yarn test && yarn build
```
