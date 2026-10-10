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

## Reads

Every read needs the `read` scope and returns the `data` of the API's `{ vault, data }` body,
parsed against the schemas in `src/schemas.ts`. Amounts are base-unit strings.

| Method | Route | Returns |
| --- | --- | --- |
| `listVaults()` | `GET /vaults` | Vaults this key manages. |
| `getVault(vault)` | `GET /vaults/{vault}` | Fees, limits, pending requests, pause flags, NAV epoch. |
| `getHoldings(vault)` | `GET /vaults/{vault}/holdings` | Token balances and their value. |
| `getStrategies(vault)` | `GET /vaults/{vault}/strategies` | Open Jupiter, DLMM, and Phoenix strategies. DLMM positions carry inclusive `lowerBinId`/`upperBinId`, `activeBinId`, and per-bin `bins` on current servers. |
| `getNavHistory(vault, limit?)` | `GET /vaults/{vault}/nav?limit=` | Posted NAVs, oldest first. The API defaults to 200. |
| `getRequests(vault)` | `GET /vaults/{vault}/requests` | Queued deposits and withdrawals. |
| `getStrategyHistory(vault)` | `GET /vaults/{vault}/strategy-history` | Closed strategies and their per-mint cash flows. |
| `getPhoenix(vault)` | `GET /vaults/{vault}/phoenix` | Phoenix onboarding status, markets, open orders, margin. |

`getNavHistory` and `getStrategyHistory` fail with `HistoryUnavailable` (HTTP 503) when the
deployment has no history database. In `getPhoenix`, `openOrders`, `withdrawable`, and
`account` are `null` when Phoenix's own API is down.

## Actions

`execute` runs every builder below, with typed bodies (`ActionRequest`). It follows batch
order (`sendConcurrently` groups, confirmation barriers) and `next` continuations
(`dlmm/extend`, `dlmm/add-range`, `dlmm/zap-out/swap`) on its own.

| Action | Body besides `action` | Notes |
| --- | --- | --- |
| `jupiter/swap` | `vault, sourceMint, destinationMint, amount, slippageBps` | `amount` in source-mint base units. |
| `jupiter/initialize` | `vault, targetMint` | Opens the strategy needed to hold `targetMint`. |
| `dlmm/initialize` | `vault, lbPair`, and `width` or `lowerBinId` + `upperBinId` | Empty position, returned as `created.position`. `width` 1..70; `upperBinId` exclusive. |
| `dlmm/open` | `vault, lbPair, lowerBinId, upperBinId, amountX, amountY, shape, maxActiveBinSlippage` | `upperBinId` exclusive. |
| `dlmm/add` | `vault, position, amountX, amountY, shape, maxActiveBinSlippage`, optional `lowerBinId` + `upperBinId` | Range both ends inclusive, given together, inside the position; adds only to those bins. |
| `dlmm/remove` | `vault, position, bpsToRemove, cursorBinId?`, optional `lowerBinId` + `upperBinId` | Range as in `dlmm/add`; removes `bpsToRemove` only from those bins. |
| `dlmm/flip` | `vault, position, lowerBinId, upperBinId, activeBinId, maxActiveBinSlippage` | One atomic transaction: removes all of the bins (both ends inclusive) and re-adds that token there as Bid-Ask. The range must lie strictly above (token X) or below (token Y) `activeBinId`; build it with `flipRange`. Does not claim fees. |
| `dlmm/claim-fee` | `vault, position, cursorBinId?` | |
| `dlmm/zap-out` | `vault, position, slippageBps, cursorBinId?` | |
| `dlmm/close` | `vault, position` | Removes everything, claims fees, closes the strategy. |
| `strategy/close` | `vault, strategy` | |
| `phoenix/initialize` | `vault` | Then call `onboardPhoenix`. |
| `phoenix/deposit` | `vault, amount` | USDC base units. |
| `phoenix/withdraw` | `vault, amount` | USDC base units. A queued withdrawal needs `phoenix/sweep` later. |
| `phoenix/order` | `vault, symbol, side, size, reduceOnly, order` | `size` is a decimal of the base asset ("0.5"). `order` is `{ type: "market", slippageBps }` (1..2000) or `{ type: "limit", price, postOnly }` (USD decimal). |
| `phoenix/cancel` | `vault, symbol, orders` | `"all"`, or 1..20 `{ priceInTicks, orderSequenceNumber }` from `getPhoenix().openOrders`. |
| `phoenix/sweep` | `vault` | Unwraps a queued Phoenix withdrawal into USDC. |
| `vault/initialize` | `name, depositMint, performanceFeeBps, managementFeeBps, depositCap, minDeposit, minWithdrawalShares` | No `vault`. Needs a key not limited to specific vaults. A confirmed outcome carries the new address as `created.vault`. |
| `vault/update` | `vault` and at least one of `performanceFeeBps, managementFeeBps, depositCap, minDeposit, minWithdrawalShares, status, depositPaused, withdrawalPaused` | |
| `vault/claim-fee` | `vault` | Mints the accrued manager fee shares to the manager. |
| `vault/close` | `vault` | |

### Phoenix onboarding

After `phoenix/initialize` confirms, register the vault's trader with Phoenix:

```ts
const outcome = await hedge.onboardPhoenix(vault.address, signer);
```

Phoenix must co-sign this transaction, so it cannot go through `execute`. `onboardPhoenix`
builds it, checks it with the onboarding policy below, signs it as fee payer, and submits it
to `/transactions/phoenix/onboard/submit`, where Phoenix adds its signature and sends it. It
then polls `/transactions/status` like `execute` and returns the same `Outcome`.

### Key scopes

| To do this | The key needs |
| --- | --- |
| Any read | `read` |
| Run a builder with `execute` | `send` and the action's own name, e.g. `phoenix/order` or `dlmm/flip` |
| Follow a `next` continuation | its name too: `dlmm/extend`, `dlmm/add-range`, or `dlmm/zap-out/swap` |
| `onboardPhoenix` | `send` and `phoenix/onboard` |
| `vault/initialize` | `send` and `vault/initialize`, on a key not limited to specific vaults |

Helpers for user-facing input: `getToken(vault, mint)` resolves a pasted contract address to
symbol, decimals, and Jupiter verification (app PR #18); `parseUnits("1.5", decimals)` and
`formatUnits` convert amounts without floating point; `binRangeForPrices(pool, min, max)`
turns a human price range into `lowerBinId`/`upperBinId`, with the bin count and which
tokens the range can hold; `flipSide(tokenXMint, depositMint)` and `flipRange(selection, activeBinId, side)`
pick the non-deposit token and the bins of a selection that `dlmm/flip` can take.

To open a position, read the pool first with `getPool(vault, lbPair)` and choose
`lowerBinId` and an exclusive `upperBinId` around its `activeBinId` (requires the app's
`GET /dlmm/pools/{lbPair}` route, app PR #17).

## Safety

Before signing, every transaction in a build must:

- be a v0 transaction paid by the signer's key;
- already carry every other required signature (for example a new DLMM position);
- call only the Hedge Vault program, ComputeBudget, Associated Token Account, Meteora DLMM, or Jupiter at the top level;
- set a priority fee at or below 100,000 microLamports per CU (`maxComputeUnitPriceMicroLamports`).

`onboardPhoenix` uses a separate, narrower policy. The transaction must be v0, paid by the
signer's key, and call only the Phoenix program (`EtrnLzgbS7nMMy5fbD42kXiUzGg8XQzJ972Xtk1cjWih`)
at the top level, with no ComputeBudget instruction and so no priority fee. It is the only path
that signs while another signature (Phoenix's) is still missing. `execute` refuses a direct
Phoenix call and a missing co-signature as before.

The whole build is inspected before any of it is sent. After an ambiguous send, the SDK
polls the same receipt and never rebuilds, because a rebuild could execute the action twice.

`TransactionSigner` is an interface, so a hardware wallet or KMS-backed signer can replace
`keypairSigner` without other changes.

## API checker

`hedge-check-api` (or `yarn check-api` in this repo) probes a live API with `HEDGE_API_KEY`
and optional `HEDGE_API_BASE_URL`: auth, routing, validation, error-body hygiene, and every
read endpoint against the schemas this SDK parses. History reads are skipped when the
deployment has no history database, and the Phoenix read is skipped when Phoenix is down. `--build` adds one unsigned swap build
per vault; nothing is signed or sent. A failure here means the API and this SDK disagree.

## Develop

```sh
yarn install --frozen-lockfile
yarn typecheck && yarn test && yarn build
```
