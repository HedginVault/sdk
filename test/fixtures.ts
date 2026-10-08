import type { Holdings, NavHistoryPoint, PhoenixManager, Quote, RequestQueue, Strategy, StrategyHistoryItem, VaultDetail, VaultSummary } from "../src/schemas";

export const VAULT = "Vau1t111111111111111111111111111111111111111";
export const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
export const SOL = "So11111111111111111111111111111111111111112";

export const vaultSummary: VaultSummary = {
  address: VAULT,
  name: "Demo",
  status: "normal",
  depositMint: USDC,
  depositSymbol: "USDC",
  depositDecimals: 6,
  totalAssets: "1500000",
};

export const holdings: Holdings = {
  depositToken: { mint: USDC, symbol: "USDC", decimals: 6 },
  totalValue: "2500000",
  totalUsd: 2.5,
  navTotalAssets: "2400000",
  navDeltaBps: 417,
  partial: true,
  unpriced: ["MYSTERY"],
  tokens: [
    { token: { mint: USDC, symbol: "USDC", decimals: 6 }, amount: "1000000", usd: 1, shareBps: 4000 },
    { token: { mint: SOL, symbol: "SOL", decimals: 9 }, amount: "10000000", usd: 1.5, shareBps: 6000 },
  ],
};

export const strategies: Strategy[] = [
  { type: "jupiter", address: "Strat1", symbol: "SOL", decimals: 9, vaultBalance: "10000000" },
  {
    type: "dlmm",
    address: "Strat2",
    position: "Pos1111111111111111111111111111111111111111",
    tokenX: { mint: SOL, symbol: "SOL", decimals: 9 },
    tokenY: { mint: USDC, symbol: "USDC", decimals: 6 },
    lowerPrice: "140",
    upperPrice: "160",
    activePrice: "150",
    amountX: "500000000",
    amountY: "75000000",
    pendingFeeX: "1000000",
    pendingFeeY: "250000",
  },
  { type: "phoenix", address: "Strat3", equity: "12345678", leverage: null },
  { type: "unreadable", address: "Strat4444444444444444444444444444444444444", protocol: "dlmm", reason: "position account missing" },
];

export const quote: Quote = {
  inAmount: "1000000",
  outAmount: "6666666",
  priceImpactPct: "0.01",
  routeLabels: ["Meteora DLMM", "Whirlpool"],
  slippageBps: 50,
};

export const vaultDetail: VaultDetail = {
  ...vaultSummary,
  status: "normal",
  id: "7",
  navPerShare: "1020000000",
  depositCap: "0",
  performanceFeeBps: 2000,
  managementFeeBps: 200,
  lastNavTs: 1_760_000_000,
  authority: "Mgr1111111111111111111111111111111111111111",
  shareMint: "Shr1111111111111111111111111111111111111111",
  shareSupply: "1470588",
  idleBalance: "1000000",
  unmanagedHoldings: [{ token: { mint: SOL, symbol: "SOL", decimals: 9 }, amount: "5000" }],
  pendingDeposits: "250000",
  pendingWithdrawalShares: "0",
  unclaimedManagerFeeShares: "1200",
  unclaimedPlatformFeeShares: "300",
  epochOutflow: "0",
  highWaterMark: "1020000000",
  navEpoch: "122",
  minDeposit: "1000000",
  minWithdrawalShares: "1",
  depositPaused: false,
  withdrawalPaused: true,
  pendingPerformanceFeeBps: 2000,
  pendingManagementFeeBps: 200,
  feeEffectiveTs: 0,
  openStrategyCount: 3,
  protocol: { status: "normal", maxEpochOutflowBps: 2000, maxSlippageBps: 300 },
};

export const navHistory: NavHistoryPoint[] = [
  { epoch: 121, ts: 1_759_985_600, totalAssets: "1480000", navPerShare: "1006000000", highWaterMark: "1006000000", overridden: false },
  { epoch: 122, ts: null, totalAssets: "1500000", navPerShare: "1020000000", highWaterMark: "1020000000", overridden: true },
];

export const requestQueue: RequestQueue = {
  deposits: [{ owner: "Usr1111111111111111111111111111111111111111", amount: "250000", epoch: "122", createdTs: 1_760_000_100, state: "pending", cancellable: true }],
  withdrawals: [{ owner: "Usr2222222222222222222222222222222222222222", shares: "98039", epoch: "121", createdTs: 1_759_990_000, state: "resolvable", cancellable: false }],
};

export const strategyHistory: StrategyHistoryItem[] = [
  {
    strategy: "Strat5555555555555555555555555555555555555",
    id: 4,
    type: "dlmm",
    protocolAccount: "Pos2222222222222222222222222222222222222222",
    openedTs: 1_759_000_000,
    closedTs: 1_759_500_000,
    openSignature: null,
    closeSignature: "5ig",
    exact: true,
    tokens: [
      { mint: USDC, symbol: "USDC", decimals: 6, contributed: "1000000", returned: "900000", feesGross: "20000", feesTreasury: "2000", feesRetained: "18000", realizedPnl: "-82000" },
      { mint: SOL, symbol: null, decimals: null, contributed: "0", returned: "0", feesGross: "0", feesTreasury: "0", feesRetained: "0", realizedPnl: "0" },
    ],
  },
];

export const phoenixView: PhoenixManager = {
  status: "ready",
  usdcVault: true,
  traderAccount: "Trd1111111111111111111111111111111111111111",
  markets: [{ symbol: "SOL", name: "Solana", category: "crypto", maxLeverage: 20, markPrice: "150.25", tickSize: 1, baseLotsDecimals: 3, takerFee: 0.00035, makerFee: 0 }],
  openOrders: [{ symbol: "SOL", side: "long", price: "140", size: "0.5", priceInTicks: "140000", orderSequenceNumber: "18446744073709551615", reduceOnly: false }],
  withdrawable: "5000000",
  account: { collateral: "10000000", equity: "-250000", initialMargin: "2000000", maintenanceMargin: "1000000", withdrawable: "5000000", riskState: "healthy", liquidationPrices: { SOL: "95.5" } },
};
