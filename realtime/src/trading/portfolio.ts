import { MAX_TRADE_LOG_ENTRIES, POSITION_DUST } from "./constants.js";
import { getPrice, getPrices, getSymbol } from "./prices.js";
import { log } from "../logger.js";
import type { Portfolio, Settings, TradeAction, TradeLogEntry } from "../types.js";

export interface CopyRequest {
  portfolio: Portfolio;
  settings: Settings;
  mint: string;
  label: string;
  signature: string;
  action: TradeAction;
  /** Websocket notification time, used to report end-to-end latency. */
  detectedAt: number;
}

export type CopyResult =
  | { copied: true; entry: TradeLogEntry }
  | { copied: false; reason: string };

function nowIso(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
}

function recordTrade(portfolio: Portfolio, entry: TradeLogEntry): void {
  portfolio.tradeLog.unshift(entry);
  portfolio.tradeLog.length = Math.min(portfolio.tradeLog.length, MAX_TRADE_LOG_ENTRIES);
}

async function executeBuy(request: CopyRequest): Promise<CopyResult> {
  const { portfolio, settings, mint, label, signature, detectedAt } = request;

  const price = await getPrice(mint);
  if (price === null) return { copied: false, reason: "prix indisponible" };

  const spend = portfolio.cashUSD * (settings.positionSizePct / 100);
  if (spend <= 0 || spend > portfolio.cashUSD) {
    return { copied: false, reason: `cash insuffisant ($${portfolio.cashUSD.toFixed(2)})` };
  }

  const symbol = await getSymbol(mint);
  const amount = spend / price;
  const existing = portfolio.positions[mint];

  if (existing) {
    const totalAmount = existing.amount + amount;
    const priorCost = existing.amount * existing.avgCostUSD;
    portfolio.positions[mint] = {
      ...existing,
      symbol,
      amount: totalAmount,
      avgCostUSD: (priorCost + spend) / totalAmount,
    };
  } else {
    portfolio.positions[mint] = { symbol, amount, avgCostUSD: price };
  }

  portfolio.cashUSD -= spend;

  const entry: TradeLogEntry = {
    timestamp: nowIso(),
    wallet: label,
    action: "BUY",
    mint,
    symbol,
    amount,
    price,
    valueUSD: spend,
    signature,
    latencyMs: Date.now() - detectedAt,
  };
  recordTrade(portfolio, entry);
  log.info(`BUY  ${symbol} ${amount.toFixed(6)} @ $${price} = $${spend.toFixed(2)} (${entry.latencyMs}ms)`);
  return { copied: true, entry };
}

async function executeSell(request: CopyRequest): Promise<CopyResult> {
  const { portfolio, settings, mint, label, signature, detectedAt } = request;

  const position = portfolio.positions[mint];
  if (!position || position.amount <= 0) {
    return { copied: false, reason: "aucune position ouverte" };
  }

  const price = await getPrice(mint);
  if (price === null) return { copied: false, reason: "prix indisponible" };

  const fraction = settings.sellAll ? 1 : settings.positionSizePct / 100;
  const sellAmount = position.amount * fraction;
  if (sellAmount <= 0) return { copied: false, reason: "quantite a vendre nulle" };

  const proceeds = sellAmount * price;
  const pnl = proceeds - sellAmount * position.avgCostUSD;
  const symbol = position.symbol || (await getSymbol(mint));

  portfolio.cashUSD += proceeds;
  const remaining = position.amount - sellAmount;

  if (remaining <= POSITION_DUST) {
    delete portfolio.positions[mint];
  } else {
    portfolio.positions[mint] = { ...position, amount: remaining };
  }

  const entry: TradeLogEntry = {
    timestamp: nowIso(),
    wallet: label,
    action: "SELL",
    mint,
    symbol,
    amount: sellAmount,
    price,
    valueUSD: proceeds,
    pnl,
    signature,
    latencyMs: Date.now() - detectedAt,
  };
  recordTrade(portfolio, entry);
  log.info(
    `SELL ${symbol} ${sellAmount.toFixed(6)} @ $${price} = $${proceeds.toFixed(2)} ` +
      `(PnL $${pnl.toFixed(2)}, ${entry.latencyMs}ms)`,
  );
  return { copied: true, entry };
}

export function copyTrade(request: CopyRequest): Promise<CopyResult> {
  return request.action === "BUY" ? executeBuy(request) : executeSell(request);
}

/** Refresh the USD value of every open position. */
export async function markToMarket(portfolio: Portfolio): Promise<void> {
  const mints = Object.keys(portfolio.positions);
  const prices = mints.length > 0 ? await getPrices(mints) : new Map<string, number>();

  let holdings = 0;
  for (const mint of mints) {
    const position = portfolio.positions[mint];
    if (!position) continue;

    const price = prices.get(mint) ?? position.lastPriceUSD ?? null;
    if (price === null) {
      position.valueUSD = null;
      continue;
    }
    position.lastPriceUSD = price;
    position.valueUSD = position.amount * price;
    holdings += position.valueUSD;
  }

  portfolio.holdingsUSD = holdings;
  portfolio.totalValueUSD = portfolio.cashUSD + holdings;
  portfolio.updatedAt = nowIso();
}
