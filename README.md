# @hedginxyz/sdk

TypeScript client for the Hedge Vault manager bot API (V1). It turns the API's
build → sign → send → confirm sequence into one call, and refuses to sign any server-built
transaction that could move funds out of the manager wallet.

The API still builds every transaction. The SDK only calls it, checks what comes back, signs
locally, and tracks the result. The manager key never leaves your process.

## Install

```sh
yarn add @hedginxyz/sdk @solana/web3.js
# or
npm install @hedginxyz/sdk @solana/web3.js
```

Node 18 or later.

`@solana/web3.js` is a peer dependency, so the SDK and your code share one copy of
`Keypair`, `PublicKey`, and `VersionedTransaction`.

## Use

```ts
import { createHedgeClient, keypairFromFile, keypairSigner } from "@hedginxyz/sdk";

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

`getVault()` may omit `unmanagedHoldings`. Check for `undefined` before reading the
array: absent means these holdings are unknown, while `[]` means none were reported.

| Method | Route | Returns |
| --- | --- | --- |
| `listVaults()` | `GET /vaults` | Vaults this key manages. |
| `getVault(vault)` | `GET /vaults/{vault}` | Fees, limits, pending requests, pause flags, NAV epoch. |
| `getHoldings(vault)` | `GET /vaults/{vault}/holdings` | Token balances and their value. |
| `getStrategies(vault)` | `GET /vaults/{vault}/strategies` | Open Jupiter, DLMM position, DLMM limit order, and Phoenix strategies. DLMM positions carry inclusive `lowerBinId`/`upperBinId`, `activeBinId`, and per-bin `bins` on current servers. A strategy type newer than this SDK comes back as `unreadable` with the type in `protocol`. |
| `getNavHistory(vault, limit?)` | `GET /vaults/{vault}/nav?limit=` | Posted NAVs, oldest first. The API defaults to 200. |
| `getRequests(vault)` | `GET /vaults/{vault}/requests` | Queued deposits and withdrawals. |
| `getStrategyHistory(vault)` | `GET /vaults/{vault}/strategy-history` | Closed strategies and their per-mint cash flows. |
| `getPhoenix(vault)` | `GET /vaults/{vault}/phoenix` | Phoenix onboarding status, markets, open orders, margin, armed TP/SL brackets (`tpSl`). |

`getNavHistory` and `getStrategyHistory` fail with `HistoryUnavailable` (HTTP 503) when the
deployment has no history database. In `getPhoenix`, `openOrders`, `withdrawable`, and
`account` are `null` when Phoenix's own API is down.

## Direct mode (no API key)

`createDirectClient` reads vault state straight from Solana through a `Connection` you
bring. It needs no API key and never calls the Manager API. Its methods return the same
types as `createHedgeClient`, so code that only reads can swap one client for the other.

```ts
import { Connection } from "@solana/web3.js";
import { createDirectClient } from "@hedginxyz/sdk";

const hedge = createDirectClient({ connection: new Connection("https://<your-rpc>", "confirmed") });
const vault = await hedge.getVault("<vault address>");
```

Supported so far:

| Method | Reads |
| --- | --- |
| `listVaults()` | Every vault of the program, sorted by id. |
| `getVault(vault)` | The vault, protocol config, deposit and share mints, and idle token account. |
| `getRequests(vault)` | Queued deposit and withdrawal requests for the vault. |
| `getPhoenix(vault)` | Phoenix strategy status, markets, open orders, margin and armed TP/SL, from chain and Phoenix's perp-api. |
| `getPool(vault, lbPair)` | A Meteora DLMM pool's tokens, bin step, active bin and price, from chain. `vault` is unused. |

Differences from the API:

- `listVaults()` returns every vault, not only the vaults your key manages.
- `name` is the on-chain name, or `Vault #<id>` when it is empty. Display names set by an admin live in the app database.
- `getVault()` omits `unmanagedHoldings`. The API omits it too.
- `depositSymbol` comes from Jupiter's token search (`lite-api.jup.ag`, or `api.jup.ag` when you pass `jupiterApiKey`). When Jupiter is down it falls back to a short mint label such as `EPjF…Dt1v`, as the app does.

Options: `programId` points at another deployment of the program, `fetch` replaces the
global `fetch` used for Jupiter and Phoenix, `jupiterHost` replaces the Jupiter host for quotes and swaps, `phoenixApiUrl` replaces Phoenix's perp-api host (`https://perp-api.phoenix.trade`), `protocolLookupTable` names the protocol address lookup table that DLMM zaps use to fit their swap, and `maxComputeUnitPriceMicroLamports` caps the priority fee
`execute` will sign. An address that is not a vault of the program fails with `ApiError` code
`NotFound`, the same code the API uses.

### Direct execution

`execute` on the direct client builds the transaction itself from chain state, then
inspects, signs, sends and confirms it through your `Connection`. It uses the same signing
policy and returns the same `Outcome` as `createHedgeClient().execute`. The signer's key is
the fee payer and the acting manager.

```ts
const outcome = await hedge.execute({ action: "vault/claim-fee", vault: "<vault address>" }, keypairSigner(keypair));
```

These actions build locally:

| Action | Who may sign |
| --- | --- |
| `vault/initialize` | A whitelisted manager. |
| `vault/update` | The vault authority. |
| `vault/claim-fee` | The vault authority. |
| `vault/close` | The vault authority. |
| `strategy/close` | The vault authority, or a delegate with the strategy's protocol permission. |
| `jupiter/initialize` | The vault authority, or a delegate with Jupiter permission. |
| `jupiter/swap` | The vault authority, or a delegate with Jupiter permission. |
| `jupiter/sweep` | The vault authority, or a delegate with Jupiter permission. |
| `phoenix/initialize` | The vault authority, or a delegate with Phoenix permission. |
| `phoenix/deposit` | The vault authority, or a delegate with Phoenix permission. |
| `phoenix/withdraw` | The vault authority, or a delegate with Phoenix permission. |
| `phoenix/sweep` | The vault authority, or a delegate with Phoenix permission. |
| `phoenix/order` | The vault authority, or a delegate with Phoenix permission. |
| `phoenix/tpsl` | The vault authority, or a delegate with Phoenix permission. |
| `phoenix/cancel` | The vault authority, or a delegate with Phoenix permission. |
| `dlmm/initialize`, `dlmm/open`, `dlmm/add`, `dlmm/remove`, `dlmm/flip`, `dlmm/claim-fee`, `dlmm/zap-out`, `dlmm/close` | The vault authority, or a delegate with Meteora DLMM permission. |
| `dlmm/limit-order/place`, `dlmm/limit-order/cancel` | The vault authority, or a delegate with Meteora DLMM permission. |

`jupiter/swap` and `jupiter/sweep` call Jupiter's Swap API (`lite-api.jup.ag`, or `api.jup.ag`
with `x-api-key` when you pass `jupiterApiKey`; `jupiterHost` overrides the host) for the quote
and the route's instructions, and cap `slippageBps` at the protocol's `maxSlippageBps`, as the
API does. A Jupiter error or malformed response fails the build with an `ApiError`, before
anything is signed. Their `next` continuations (`jupiter/swap` after a strategy-only
transaction, `jupiter/sweep` when a strategy close does not fit behind the route) are local
actions too, so `execute` follows them without the API. `getQuote(request)` returns the same
`Quote` as the HTTP client.

The Phoenix actions read Phoenix's accounts from chain. `phoenix/order`, `phoenix/tpsl` and
`phoenix/cancel` also look up the market by symbol in Phoenix's perp-api market list. A
Phoenix error or malformed response fails the build with an `ApiError` before anything is
signed. `onboardPhoenix(vault, signer)` registers the vault's trader after
`phoenix/initialize`: Phoenix builds the transaction, the signer signs it as fee payer under
the onboarding policy below, the SDK submits it to Phoenix (which co-signs and broadcasts
it), and the SDK confirms it through your `Connection`. A submit whose reply is lost is
polled on chain, never resubmitted.

The DLMM actions read the pool, position and bin arrays from chain with Meteora's SDK
(`@meteora-ag/dlmm`, loaded on first use). Wide positions build as one batch that `execute`
inspects whole before sending: `dlmm/open` initializes, extends and funds chunk by chunk, and
withdrawals, claims and closes go range by range. Later steps of a batch skip simulation and
are checked by the send's preflight, as the API does. The continuations `dlmm/extend`,
`dlmm/add-range`, `dlmm/zap-out/swap`, and `jupiter/sweep` after a zap-out build locally too.
A delegate needs Jupiter permission as well for a zap's swap or a missing pair-token strategy.
`dlmm/zap-out` and `dlmm/remove` with `slippageBps` put a token-ledger Jupiter swap in the same
transaction; without `protocolLookupTable` they still build, only larger, and fail with
`TransactionTooLarge` naming the option when nothing fits.

Every `ActionRequest` builds locally. Reads not in the table above, such as `searchPools` and
`getToken`, still need `createHedgeClient`. The program is the final check: the signer checks above only give a clear error
before simulation. A send lost to an RPC error is polled by its signature, never resent.

## Actions

`execute` runs every builder below, with typed bodies (`ActionRequest`). It follows batch
order (`sendConcurrently` groups, confirmation barriers) and `next` continuations
(`dlmm/extend`, `dlmm/add-range`, `dlmm/zap-out/swap`, `jupiter/sweep`) on its own.

| Action | Body besides `action` | Notes |
| --- | --- | --- |
| `jupiter/swap` | `vault, sourceMint, destinationMint, amount, slippageBps` | `amount` in source-mint base units. |
| `jupiter/sweep` | `vault, mint, slippageBps` | One transaction: sells the vault's whole `mint` balance to the deposit mint, then closes `mint`'s Jupiter strategy. 409 while an open DLMM position or limit order uses `mint`. |
| `jupiter/initialize` | `vault, targetMint` | Opens the strategy needed to hold `targetMint`. |
| `dlmm/initialize` | `vault, lbPair`, and `width` or `lowerBinId` + `upperBinId` | Empty position, returned as `created.position`. `width` 1..70; `upperBinId` exclusive. |
| `dlmm/open` | `vault, lbPair, lowerBinId, upperBinId, amountX, amountY, shape, maxActiveBinSlippage` | `upperBinId` exclusive. |
| `dlmm/add` | `vault, position, amountX, amountY, shape, maxActiveBinSlippage`, optional `lowerBinId` + `upperBinId` | Range both ends inclusive, given together, inside the position; adds only to those bins. |
| `dlmm/remove` | `vault, position, bpsToRemove, cursorBinId?`, optional `lowerBinId` + `upperBinId` | Range as in `dlmm/add`; removes `bpsToRemove` only from those bins. |
| `dlmm/flip` | `vault, position, lowerBinId, upperBinId, activeBinId, maxActiveBinSlippage` | One atomic transaction: removes all of the bins (both ends inclusive) and re-adds that token there as Bid-Ask. The range must lie strictly above (token X) or below (token Y) `activeBinId`; build it with `flipRange`. Does not claim fees. |
| `dlmm/claim-fee` | `vault, position, cursorBinId?` | |
| `dlmm/zap-out` | `vault, position, slippageBps, cursorBinId?` | When eligible, the last transaction continues to `jupiter/sweep` for the leftover non-deposit token. |
| `dlmm/close` | `vault, position` | Removes everything, claims fees, closes the strategy. |
| `dlmm/limit-order/place` | `vault, lbPair, side, bins` | `side` `ask` sells token X in bins above the active bin, `bid` sells token Y below it. `bins` is `[{ binId, amount }]`, strictly increasing, amounts in the sold token. May build two transactions. |
| `dlmm/limit-order/cancel` | `vault, limitOrder, bins?` | Without `bins`, cancels every bin and closes the strategy, paying unfilled amounts, proceeds, and fees back to the vault. |
| `strategy/close` | `vault, strategy` | |
| `phoenix/initialize` | `vault` | Then call `onboardPhoenix`. |
| `phoenix/deposit` | `vault, amount` | USDC base units. |
| `phoenix/withdraw` | `vault, amount` | USDC base units. A queued withdrawal needs `phoenix/sweep` later. |
| `phoenix/order` | `vault, symbol, side, size, reduceOnly, order, tpSl?, disarmTpSl?` | `size` is a decimal of the base asset ("0.5"). `order` is `{ type: "market", slippageBps }` (1..2000) or `{ type: "limit", price, postOnly }` (USD decimal). `tpSl` (`{ takeProfit, stopLoss }`, USD decimals or `null`) arms a bracket on the resulting position; market orders only, not reduce-only. `disarmTpSl` cancels the armed bracket, for a full close. |
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
| Follow a `next` continuation | its name too: `dlmm/extend`, `dlmm/add-range`, `dlmm/zap-out/swap`, or `jupiter/sweep` |
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

`src/idl/` is generated by the program's `anchor build`. Run `yarn sync-idl` to copy it from
`../programs` (or set `HEDGE_VAULT_PROGRAM_REPO`); never edit it by hand.

## Release

Publishing runs in GitHub Actions (`.github/workflows/publish.yml`) through npm trusted
publishing, so no npm token is stored anywhere. To release:

```sh
npm version patch   # or minor / major; commits and tags vX.Y.Z
git push --follow-tags
```

The workflow checks that the tag matches `package.json`, then `npm publish` runs typecheck,
tests, and the build before uploading. Run `npm pack --dry-run` first to see exactly which
files ship.
