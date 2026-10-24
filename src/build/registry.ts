import type { z } from "zod";
import type { BuildAction } from "../actions";
import type { Assembled } from "./assemble";
import type { ActionBody, BuildEnv } from "./context";
import { buildJupiterInitialize, jupiterInitializeInput } from "./jupiter-initialize";
import { buildStrategyClose, strategyCloseInput } from "./strategy";
import { buildVaultClaimFee, buildVaultClose, buildVaultInitialize, buildVaultUpdate, vaultInitializeInput, vaultInput, vaultUpdateInput } from "./vault";

/** Actions `createDirectClient().execute` builds locally; every other action still needs `createHedgeClient`. */
export type LocalAction = "vault/initialize" | "vault/update" | "vault/claim-fee" | "vault/close" | "strategy/close" | "jupiter/initialize";

/** `input` parses the untrusted body into the action's public request type; `build` turns it into one transaction. */
export interface LocalBuilder<A extends BuildAction> {
  input: z.ZodType<ActionBody<A>, z.ZodTypeDef, unknown>;
  build(env: BuildEnv, body: ActionBody<A>): Promise<Assembled & { vault?: string }>;
}

export type LocalBuilders = { [A in LocalAction]: LocalBuilder<A> };

export const localBuilders = {
  "vault/initialize": { input: vaultInitializeInput, build: buildVaultInitialize },
  "vault/update": { input: vaultUpdateInput, build: buildVaultUpdate },
  "vault/claim-fee": { input: vaultInput, build: buildVaultClaimFee },
  "vault/close": { input: vaultInput, build: buildVaultClose },
  "strategy/close": { input: strategyCloseInput, build: buildStrategyClose },
  "jupiter/initialize": { input: jupiterInitializeInput, build: buildJupiterInitialize },
} satisfies LocalBuilders;

export const isLocalAction = (action: string): action is LocalAction => Object.hasOwn(localBuilders, action);
