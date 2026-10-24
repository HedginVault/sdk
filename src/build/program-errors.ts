import { LangErrorCode, LangErrorMessage } from "@coral-xyz/anchor";
import idl from "../idl/hedge_vault.json";

/**
 * What a failed transaction means to the person who sent it. `message` is always user-facing text;
 * `detail` keeps the program's own wording for the "details" view and the server log. `code` is the
 * program's error name when one is known; callers fall back to their own code otherwise.
 */
export interface TxFailure {
  code?: string;
  message: string;
  detail: string;
}

interface ProgramErrors {
  /** Shown for any code of this program without its own entry. */
  fallback: string;
  /** Codes are per program: the same number means something else in each table. */
  codes: Record<number, readonly [name: string, message: string]>;
}

const TRY_AGAIN = "Refresh the page and try again. If it keeps happening, contact support.";
const GENERIC_FAILURE = `The transaction could not be completed. ${TRY_AGAIN}`;

const VAULT_FALLBACK = `The vault rejected this transaction. ${TRY_AGAIN}`;
const vaultName = new Map(idl.errors.map((e) => [e.code, e.name]));
const vaultMsg = new Map(idl.errors.map((e) => [e.name, e.msg]));

/**
 * Vault errors a depositor, manager or admin can act on. Every other vault code means the app built a
 * wrong transaction or read stale state, which the user cannot fix, so it gets the fallback.
 */
const VAULT_MESSAGES: Record<string, string> = {
  InvalidTransferAmount: "Enter an amount greater than zero.",
  InvalidBasisPoints: "A fee or percentage cannot be more than 100%.",
  InvalidMinimumAmount: "The minimum deposit and minimum withdrawal must both be more than zero.",
  InsufficientFunds: "There are not enough funds for this amount.",
  InvalidAdmin: "Only the protocol admin can do this.",
  InvalidNavUpdater: "Only the NAV updater can do this.",
  InvalidTreasuryAuthority: "Only the treasury authority can do this.",
  InvalidGuardian: "Only the guardian can do this.",
  InvalidPendingAdmin: "Only the pending admin can accept the admin role.",
  ProtocolNotOperational: "Hedgin is paused right now. Try again later.",
  ProtocolNotWithdrawable: "Withdrawals are paused across Hedgin right now. Try again later.",
  InvalidManager: "Only the vault's manager can do this.",
  InvalidManagerAuthority: "Only the vault's manager can do this.",
  VaultNotOperational: "This vault is paused or only allows reducing positions right now.",
  VaultNotWithdrawable: "Withdrawals from this vault are paused right now.",
  DepositCapReached: "This vault is full. It has reached its deposit cap.",
  VaultHasOutstandingShares: "Depositors still hold shares. The vault can close only after every share is withdrawn.",
  VaultHasPendingRequests: "Deposits or withdrawals are still queued. Wait for them to settle or be cancelled.",
  VaultHasUnclaimedFees: "Fees are still unclaimed. Claim them before closing the vault.",
  VaultHasOpenStrategies: "Strategies are still open. Close every strategy before closing the vault.",
  VaultHasAssets: "The vault still holds assets. It can close only when empty.",
  InvalidSharesAmount: "Enter a share amount greater than zero.",
  NoFeeToClaim: "There are no fees to claim yet.",
  InvalidDepositMintExtension: "This token has features the vault does not support. Pick a different deposit token.",
  VaultNavIsZero: "Deposits are closed until the vault's share price is restored.",
  DepositBelowMinimum: "This deposit is below the vault's minimum.",
  WithdrawalBelowMinimum: "This withdrawal is below the vault's minimum. Withdraw more, or withdraw everything.",
  NavAlreadyUpdatedThisEpoch: "The share price was already updated for this period.",
  FeeExceedsTotalAssets: "The fee would be larger than the vault's assets.",
  NavDeviationExceeded: "The new share price moves more than allowed in one update.",
  TotalAssetsBelowIdleBalance: "Total assets cannot be lower than the cash the vault holds.",
  EpochOutflowCapReached: "This period's withdrawal limit is reached. Try again next period.",
  PendingRequestNotResolved: "You have an earlier request still settling. Wait for it to finish before making a new one.",
  RequestNotResolvable: "This request can settle only after the next share price update.",
  RequestNotCancellable: "This request can no longer be cancelled. It will settle at the next share price update.",
  ZeroSharesMinted: "This deposit is too small to receive any shares. Deposit a larger amount.",
  InvalidStrategyMint: "The vault's deposit token cannot be traded as a strategy token.",
  InvalidSwapMints: "Pick two different tokens to swap.",
  SlippageExceedsCap: "Slippage is above the maximum allowed. Lower it and try again.",
  SwapOutputBelowMinimum: "The price moved and the swap would return too little. Try again, or raise the slippage.",
  VaultDepositPaused: "The manager has paused deposits to this vault.",
  VaultWithdrawalPaused: "The manager has paused withdrawals from this vault.",
  InvalidPhoenixDepositMint: "Phoenix trading needs a vault that takes USDC deposits.",
  PhoenixTraderNotReady: "Set up the vault's Phoenix account before trading.",
  PhoenixAccountLiquidatable: "This order would put the Phoenix account at risk of liquidation. Use a smaller size or add collateral.",
  PhoenixOrderUnderfilled: "Not enough of the order could fill at this price. Try a smaller size or a wider price.",
  PhoenixStrategyNotEmpty: "The Phoenix account still holds collateral, positions or a pending withdrawal. Close them first.",
  InvalidPositionBinRange: "This price range is too wide or outside the supported bounds. Pick a narrower range.",
  PairStrategyMissing: "Add a token strategy for the pair's other token first.",
  LimitOrderNotEmpty: "This limit order still holds funds. Cancel it first.",
  InvalidPhoenixConditionalOrder: "Set a trigger price and a size above zero for this order.",
  StrategyTokenAccountNotEmpty: "This strategy still holds tokens. Swap them out before closing it.",
  DelegatePermissionDenied: "Your delegate access does not allow this action.",
  DelegateExpired: "Your delegate access has expired. Ask the manager to renew it.",
  InvalidDelegatePermissions: "Pick at least one permission for the delegate.",
  InvalidDelegateExpiry: "The delegate's expiry must be in the future, or never.",
  VaultHasDelegates: "Remove every delegate before closing the vault.",
};

const anchorFrameworkName = new Map(Object.entries(LangErrorCode).map(([name, code]) => [code, name]));
const STALE_ACCOUNT = `Something on the page is out of date. ${TRY_AGAIN}`;

const TOKEN_CODES: ProgramErrors["codes"] = {
  1: ["InsufficientFunds", "There are not enough tokens for this amount. Check your balance and try again."],
  3: ["MintMismatch", STALE_ACCOUNT],
  4: ["OwnerMismatch", STALE_ACCOUNT],
  17: ["AccountFrozen", "This token account is frozen by the token's issuer, so it cannot move funds."],
};
const TOKEN: ProgramErrors = { fallback: `The token program rejected this transfer. ${TRY_AGAIN}`, codes: TOKEN_CODES };

/** Programs the vault calls. A program not listed here gets `GENERIC_FAILURE`. */
const PROGRAMS: Record<string, ProgramErrors> = {
  "11111111111111111111111111111111": {
    fallback: `The transfer of SOL failed. ${TRY_AGAIN}`,
    codes: {
      0: ["AccountAlreadyInUse", STALE_ACCOUNT],
      1: ["ResultWithNegativeLamports", "There is not enough SOL in your wallet to cover this transaction. Add SOL and try again."],
    },
  },
  TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA: TOKEN,
  TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb: TOKEN,
  ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL: { fallback: STALE_ACCOUNT, codes: {} },
  JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4: {
    fallback: "Jupiter could not complete this swap. Try again, or try a different amount.",
    codes: {
      6001: ["SlippageToleranceExceeded", "The price moved past your slippage tolerance. Try again, or raise the slippage."],
      6017: ["ExactOutAmountNotMatched", "The price moved before the swap ran. Try again."],
      6024: ["InsufficientFunds", "There are not enough tokens for this swap."],
    },
  },
  LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo: {
    fallback: "Meteora rejected this action. Refresh the pool and try again.",
    codes: {
      6003: ["ExceededAmountSlippageTolerance", "The pool price moved past your slippage tolerance. Try again, or raise the slippage."],
      6004: ["ExceededBinSlippageTolerance", "The pool price moved out of your range before this landed. Try again."],
      6007: ["ZeroLiquidity", "There is no liquidity to remove in this range."],
      6012: ["PairInsufficientLiquidity", "The pool does not have enough liquidity for this amount."],
      6030: ["NonEmptyPosition", "This position still holds liquidity. Remove it before closing."],
      6039: ["InsufficientOutAmount", "This would return too little at the current pool price. Try again."],
      6042: ["PoolDisabled", "This pool is disabled by Meteora."],
      6055: ["LiquidityLocked", "This liquidity is locked and cannot be removed yet."],
      6104: ["InsufficientInAmount", "The amount is too small for this pool."],
      6109: ["CancelNonEmptyLimitOrder", "This limit order still holds funds. Withdraw them first."],
    },
  },
  EtrnLzgbS7nMMy5fbD42kXiUzGg8XQzJ972Xtk1cjWih: {
    fallback: "Phoenix rejected this order. Check the size, price and collateral, then try again.",
    codes: {},
  },
  EMBERpYNE6ehWmXymZZS2skiFmCa9V5dp14e1iduM5qy: {
    fallback: "The Phoenix withdrawal could not be processed. Try again shortly.",
    codes: {},
  },
  RiSeVw3ZjNfsaXPRb4mgaqYaEEt41pNNJoDvVh7pgQj: {
    fallback: "Phoenix's risk check rejected this order. Try a smaller size or add collateral.",
    codes: {},
  },
};

export const COMPUTE_LIMIT_MESSAGE = "This action is too large for one transaction. Try a smaller amount or range.";

/** Failures with no custom program code: the runtime refused the transaction itself. */
const RUNTIME: ReadonlyArray<readonly [RegExp, string]> = [
  [/AccountNotFound|no record of a prior credit/i, "Your wallet needs some SOL to pay the network fee. Add SOL and try again."],
  [/InsufficientFundsForFee/i, "There is not enough SOL in your wallet to pay the network fee. Add SOL and try again."],
  [/InsufficientFundsForRent|insufficient funds for rent/i, "There is not enough SOL in your wallet to open the accounts this needs. Add SOL and try again."],
  [/BlockhashNotFound|Blockhash not found/i, "The transaction took too long to approve and expired. Try again."],
  [/AlreadyProcessed|already been processed/i, "This transaction was already sent. Check your wallet activity before trying again."],
  [/ComputationalBudgetExceeded|exceeded CUs meter|computational budget exceeded/i, COMPUTE_LIMIT_MESSAGE],
  [/WouldExceed\w*CostLimit/i, "The network is busy right now. Try again in a moment."],
  [/"InsufficientFunds"|insufficient (funds|lamports)/i, "There are not enough funds for this transaction. Check your balance and try again."],
];

const FAILED_RE = /^Program (\w+) failed: custom program error: 0x([0-9a-f]+)/i;
const ANCHOR_RE = /Error Code: (\w+)\. Error Number: (\d+)\. Error Message: (.*?)\.?$/;

/** Programs built with Anchor besides Hedge Vault, whose codes below 6000 are Anchor's own account checks. */
const ANCHOR_PROGRAMS = new Set(["JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4", "LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo"]);

/**
 * The program's own name and wording for a code, read off its AnchorError log line. Matched by number,
 * never by name: the same name means different things in different programs.
 */
function anchorLogFor(logs: string[], code: number) {
  for (const line of logs) {
    const m = ANCHOR_RE.exec(line);
    if (m && Number(m[2]) === code) return { name: m[1], message: m[3] };
  }
}

function describeCode(program: string, code: number, logs: string[], vaultProgram: string): TxFailure {
  const hex = `0x${code.toString(16)}`;
  const logged = anchorLogFor(logs, code);
  if (program === vaultProgram && code >= 6000) {
    // A code the deployed program has but this IDL copy does not yet: its log line still names it.
    const name = vaultName.get(code) ?? logged?.name;
    const raw = (name && vaultMsg.get(name)) ?? logged?.message;
    return { code: name ?? `Custom${hex}`, message: (name && VAULT_MESSAGES[name]) ?? VAULT_FALLBACK, detail: raw ?? `Vault error ${hex}` };
  }
  const anchorName = code < 6000 && (program === vaultProgram || ANCHOR_PROGRAMS.has(program)) ? anchorFrameworkName.get(code) : undefined;
  if (anchorName) return { code: anchorName, message: STALE_ACCOUNT, detail: `${LangErrorMessage.get(code) ?? anchorName} (${program})` };
  const known = PROGRAMS[program];
  const entry = known?.codes[code];
  return {
    code: entry?.[0] ?? logged?.name ?? `Custom${hex}`,
    message: entry?.[1] ?? known?.fallback ?? GENERIC_FAILURE,
    detail: logged ? `${logged.message} (${program})` : `Program ${program} failed with custom error ${hex}`,
  };
}

/**
 * Reads a failed transaction's logs and runtime error. The first `failed: custom program error` line is
 * the innermost program, the one that raised the code, so its own table decides the meaning.
 */
export function describeTxFailure(logs: string[], runtimeError: string, vaultProgram: string): TxFailure {
  for (const line of logs) {
    const m = FAILED_RE.exec(line);
    if (m?.[1] && m[2]) return describeCode(m[1], parseInt(m[2], 16), logs, vaultProgram);
  }
  const text = [runtimeError, ...logs].join("\n");
  const match = RUNTIME.find(([re]) => re.test(text));
  return { message: match?.[1] ?? GENERIC_FAILURE, detail: runtimeError };
}
