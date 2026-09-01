export type TradeAction = "BUY" | "SELL";

export interface Wallet {
  address: string;
  label: string;
  /** ISO timestamp of when the wallet was added to the watchlist. */
  addedAt: string;
  /** Trades copied from this wallet since it was added. */
  copiedTrades: number;
}

export interface Position {
  symbol: string;
  amount: number;
  avgCostUSD: number;
  lastPriceUSD?: number | null;
  valueUSD?: number | null;
}

export interface TradeLogEntry {
  timestamp: string;
  wallet: string;
  action: TradeAction;
  mint: string;
  symbol: string;
  amount: number;
  price: number;
  valueUSD: number;
  pnl?: number;
  signature: string;
  /** Milliseconds between the websocket notification and the copy landing. */
  latencyMs?: number;
}

export interface Portfolio {
  startingCashUSD: number;
  cashUSD: number;
  holdingsUSD: number;
  totalValueUSD: number;
  updatedAt: string | null;
  positions: Record<string, Position>;
  tradeLog: TradeLogEntry[];
}

export interface Settings {
  positionSizePct: number;
  sellAll: boolean;
}

export interface AppState {
  wallets: Wallet[];
  portfolio: Portfolio;
  settings: Settings;
  /** Signatures already copied, so a reconnect never double-counts a trade. */
  seenSignatures: string[];
  bootstrappedAt: string | null;
}

export interface Classification {
  action: TradeAction | null;
  mint: string | null;
}
