import { z } from "zod";
import { log } from "../logger.js";
import type { Store } from "./db.js";
import type { Portfolio, Wallet } from "../types.js";

const legacyWalletSchema = z.object({
  address: z.string().min(32),
  label: z.string().optional(),
  lastSignature: z.string().nullable().optional(),
});

const legacyPortfolioSchema = z.object({
  startingCashUSD: z.number().optional(),
  cashUSD: z.number(),
  holdingsUSD: z.number().optional(),
  totalValueUSD: z.number().optional(),
  updatedAt: z.string().nullable().optional(),
  positions: z
    .record(
      z.object({
        symbol: z.string(),
        amount: z.number(),
        avgCostUSD: z.number(),
        lastPriceUSD: z.number().nullable().optional(),
        valueUSD: z.number().nullable().optional(),
      }),
    )
    .default({}),
  tradeLog: z.array(z.record(z.unknown())).default([]),
});

async function fetchJson(url: string): Promise<unknown> {
  const response = await fetch(url, { signal: AbortSignal.timeout(20_000) });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json();
}

/**
 * Carry the GitHub Actions bot's state over on first boot only. Later restarts
 * must not re-import, or the disk state would be clobbered by a stale snapshot.
 */
export async function bootstrapFromGitHub(
  store: Store,
  watchlistUrl: string,
  portfolioUrl: string,
): Promise<void> {
  const state = store.read();
  if (state.bootstrappedAt) {
    log.info("Import initial deja effectue, ignore");
    return;
  }

  try {
    const [rawWatchlist, rawPortfolio] = await Promise.all([
      fetchJson(watchlistUrl),
      fetchJson(portfolioUrl),
    ]);

    const wallets = z.array(legacyWalletSchema).parse(rawWatchlist);
    const portfolio = legacyPortfolioSchema.parse(rawPortfolio);

    const now = new Date().toISOString();
    state.wallets = wallets.map<Wallet>((entry) => ({
      address: entry.address,
      label: entry.label || entry.address.slice(0, 6),
      addedAt: now,
      copiedTrades: 0,
    }));

    const imported: Portfolio = {
      startingCashUSD: portfolio.startingCashUSD ?? portfolio.cashUSD,
      cashUSD: portfolio.cashUSD,
      holdingsUSD: portfolio.holdingsUSD ?? 0,
      totalValueUSD: portfolio.totalValueUSD ?? portfolio.cashUSD,
      updatedAt: portfolio.updatedAt ?? null,
      positions: portfolio.positions,
      tradeLog: [],
    };
    state.portfolio = imported;
    state.bootstrappedAt = now;

    await store.save();
    log.info(
      `Import initial: ${state.wallets.length} wallet(s), ` +
        `cash $${imported.cashUSD.toFixed(2)}, ` +
        `${Object.keys(imported.positions).length} position(s)`,
    );
  } catch (error: unknown) {
    // A failed import must not stop the service; the operator can add wallets
    // by hand from the dashboard.
    log.error("Import initial impossible, demarrage a vide", error);
    state.bootstrappedAt = new Date().toISOString();
    await store.save();
  }
}
