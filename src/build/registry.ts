import type { z } from "zod";
import type { ContinuationRequest } from "../actions";
import type { Assembled } from "./assemble";
import type { ActionBody, BuildEnv } from "./context";
import {
  buildDlmmAdd,
  buildDlmmAddRange,
  buildDlmmClaimFee,
  buildDlmmClose,
  buildDlmmExtend,
  buildDlmmFlip,
  buildDlmmInitialize,
  buildDlmmOpen,
  buildDlmmRemove,
  dlmmAddInput,
  dlmmAddRangeInput,
  dlmmClaimFeeInput,
  dlmmCloseInput,
  dlmmFlipInput,
  dlmmInitializeInput,
  dlmmOpenInput,
  dlmmRemoveInput,
  dlmmWideStepInput,
} from "./dlmm";
import { buildDlmmLimitOrderCancel, buildDlmmLimitOrderPlace, dlmmLimitOrderCancelInput, dlmmLimitOrderPlaceInput } from "./dlmm-limit-order";
import { buildDlmmZapOut, buildDlmmZapOutSwap, dlmmZapOutInput, dlmmZapOutSwapInput } from "./dlmm-zap";
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
  | "phoenix/cancel"
  | "dlmm/initialize"
  | "dlmm/open"
  | "dlmm/add"
  | "dlmm/remove"
  | "dlmm/flip"
  | "dlmm/claim-fee"
  | "dlmm/zap-out"
  | "dlmm/close"
  | "dlmm/limit-order/place"
  | "dlmm/limit-order/cancel"
  | ContinuationRequest["action"];

/** One built transaction. `next` can name only a local action, so `execute` never sends a step it cannot continue. */
export type LocalStep = Assembled & {
  vault?: string;
  initializesStrategy?: boolean;
  /** The DLMM position or limit order the step creates, with its strategy and inclusive range, as the API reports them. */
  position?: string;
  lowerBinId?: number;
  upperBinId?: number;
  limitOrder?: string;
  strategy?: string;
  cancelledBins?: number[];
  closesStrategy?: boolean;
  next?: { [A in LocalAction]: { path: A; body: ActionBody<A> } }[LocalAction];
};

/**
 * `input` parses the untrusted body into the action's request type; `build` turns it into one
 * transaction, or a batch that `execute` inspects whole before sending any of it.
 */
export interface LocalBuilder<A extends LocalAction> {
  input: z.ZodType<ActionBody<A>, z.ZodTypeDef, unknown>;
  build(env: BuildEnv, body: ActionBody<A>): Promise<LocalStep | LocalStep[]>;
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
  "dlmm/initialize": { input: dlmmInitializeInput, build: buildDlmmInitialize },
  "dlmm/open": { input: dlmmOpenInput, build: buildDlmmOpen },
  "dlmm/add": { input: dlmmAddInput, build: buildDlmmAdd },
  "dlmm/add-range": { input: dlmmAddRangeInput, build: buildDlmmAddRange },
  "dlmm/extend": { input: dlmmWideStepInput, build: buildDlmmExtend },
  "dlmm/remove": { input: dlmmRemoveInput, build: buildDlmmRemove },
  "dlmm/flip": { input: dlmmFlipInput, build: buildDlmmFlip },
  "dlmm/claim-fee": { input: dlmmClaimFeeInput, build: buildDlmmClaimFee },
  "dlmm/zap-out": { input: dlmmZapOutInput, build: buildDlmmZapOut },
  "dlmm/zap-out/swap": { input: dlmmZapOutSwapInput, build: buildDlmmZapOutSwap },
  "dlmm/close": { input: dlmmCloseInput, build: buildDlmmClose },
  "dlmm/limit-order/place": { input: dlmmLimitOrderPlaceInput, build: buildDlmmLimitOrderPlace },
  "dlmm/limit-order/cancel": { input: dlmmLimitOrderCancelInput, build: buildDlmmLimitOrderCancel },
} satisfies LocalBuilders;

export const isLocalAction = (action: string): action is LocalAction => Object.hasOwn(localBuilders, action);
