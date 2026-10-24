import type { z } from "zod";
import type { BuildAction } from "../actions";
import type { Assembled } from "./assemble";
import type { ActionBody, BuildEnv } from "./context";
import { buildJupiterInitialize, jupiterInitializeInput } from "./jupiter-initialize";
import {
  buildPhoenixCancel,
  buildPhoenixDeposit,
  buildPhoenixInitialize,
  buildPhoenixOrder,
  buildPhoenixSweep,
  buildPhoenixTpSl,
  buildPhoenixWithdraw,
  phoenixAmountInput,
  phoenixCancelInput,
  phoenixOrderInput,
  phoenixTpSlInput,
  phoenixVaultInput,
} from "./phoenix";
import { buildJupiterSwap, buildJupiterSweep, jupiterSwapInput, jupiterSweepInput } from "./jupiter-swap";
import { buildStrategyClose, strategyCloseInput } from "./strategy";
import { buildVaultClaimFee, buildVaultClose, buildVaultInitialize, buildVaultUpdate, vaultInitializeInput, vaultInput, vaultUpdateInput } from "./vault";

/** Actions `createDirectClient().execute` builds locally; every other action still needs `createHedgeClient`. */
export type LocalAction =
  | "vault/initialize"
  | "vault/update"
  | "vault/claim-fee"
  | "vault/close"
  | "strategy/close"
  | "jupiter/initialize"
  | "jupiter/swap"
  | "jupiter/sweep"
  | "phoenix/initialize"
  | "phoenix/deposit"
  | "phoenix/withdraw"
  | "phoenix/sweep"
  | "phoenix/order"
  | "phoenix/tpsl"
  | "phoenix/cancel";

/** One built transaction. `next` can name only a local action, so `execute` never sends a step it cannot continue. */
export type LocalStep = Assembled & {
  vault?: string;
  initializesStrategy?: boolean;
  next?: { [A in LocalAction]: { path: A; body: ActionBody<A> } }[LocalAction];
};

/** `input` parses the untrusted body into the action's public request type; `build` turns it into one transaction. */
export interface LocalBuilder<A extends BuildAction> {
  input: z.ZodType<ActionBody<A>, z.ZodTypeDef, unknown>;
  build(env: BuildEnv, body: ActionBody<A>): Promise<LocalStep>;
}

export type LocalBuilders = { [A in LocalAction]: LocalBuilder<A> };

export const localBuilders = {
  "vault/initialize": { input: vaultInitializeInput, build: buildVaultInitialize },
  "vault/update": { input: vaultUpdateInput, build: buildVaultUpdate },
  "vault/claim-fee": { input: vaultInput, build: buildVaultClaimFee },
  "vault/close": { input: vaultInput, build: buildVaultClose },
  "strategy/close": { input: strategyCloseInput, build: buildStrategyClose },
  "jupiter/initialize": { input: jupiterInitializeInput, build: buildJupiterInitialize },
  "jupiter/swap": { input: jupiterSwapInput, build: buildJupiterSwap },
  "jupiter/sweep": { input: jupiterSweepInput, build: buildJupiterSweep },
  "phoenix/initialize": { input: phoenixVaultInput, build: buildPhoenixInitialize },
  "phoenix/deposit": { input: phoenixAmountInput, build: buildPhoenixDeposit },
  "phoenix/withdraw": { input: phoenixAmountInput, build: buildPhoenixWithdraw },
  "phoenix/sweep": { input: phoenixVaultInput, build: buildPhoenixSweep },
  "phoenix/order": { input: phoenixOrderInput, build: buildPhoenixOrder },
  "phoenix/tpsl": { input: phoenixTpSlInput, build: buildPhoenixTpSl },
  "phoenix/cancel": { input: phoenixCancelInput, build: buildPhoenixCancel },
} satisfies LocalBuilders;

export const isLocalAction = (action: string): action is LocalAction => Object.hasOwn(localBuilders, action);
