/** Base-unit integer string, e.g. "1000000" for 1 USDC. Never a JavaScript number. */
export type BaseUnitString = string;

export type DlmmShape = "spot" | "curve" | "bidAsk";

/**
 * One manager action, typed per V1 builder. `payer` is never sent: the API sets it from the key.
 * Continuation builders (`dlmm/extend`, `dlmm/add-range`, `dlmm/zap-out/swap`) are followed
 * automatically by `execute` from each step's `next`.
 */
export type ActionRequest =
  | {
      action: "jupiter/swap";
      vault: string;
      sourceMint: string;
      destinationMint: string;
      amount: BaseUnitString;
      slippageBps: number;
    }
  | {
      action: "dlmm/open";
      vault: string;
      lbPair: string;
      lowerBinId: number;
      /** Exclusive. */
      upperBinId: number;
      amountX: BaseUnitString;
      amountY: BaseUnitString;
      shape: DlmmShape;
      maxActiveBinSlippage: number;
    }
  | {
      action: "dlmm/add";
      vault: string;
      position: string;
      amountX: BaseUnitString;
      amountY: BaseUnitString;
      shape: DlmmShape;
      maxActiveBinSlippage: number;
    }
  | { action: "dlmm/remove"; vault: string; position: string; bpsToRemove: number; cursorBinId?: number }
  | { action: "dlmm/claim-fee"; vault: string; position: string; cursorBinId?: number }
  | { action: "dlmm/zap-out"; vault: string; position: string; slippageBps: number; cursorBinId?: number }
  | { action: "strategy/close"; vault: string; strategy: string };

export type BuildAction = ActionRequest["action"];

export interface BuildRequest {
  /** A builder name, or a `next.path` returned by a previous build. */
  action: string;
  body: Record<string, unknown>;
}

export function toBuildRequest(request: ActionRequest): BuildRequest {
  const { action, ...body } = request;
  return { action, body };
}
