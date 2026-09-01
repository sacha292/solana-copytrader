import { log } from "../logger.js";

const JUP_PRICE_URL = "https://lite-api.jup.ag/price/v3";
const JUP_SEARCH_URL = "https://lite-api.jup.ag/tokens/v2/search";

/**
 * bot.py rebuilt its price cache on every 10-minute run. This process never
 * exits, so an unbounded cache would freeze prices forever. A short TTL keeps
 * the original behaviour: a fresh quote for every trading decision.
 */
const PRICE_TTL_MS = Number(process.env.PRICE_TTL_MS ?? 30_000);
const REQUEST_TIMEOUT_MS = 15_000;

interface CachedPrice {
  price: number;
  fetchedAt: number;
}

const priceCache = new Map<string, CachedPrice>();
const symbolCache = new Map<string, string>();

function shortMint(mint: string): string {
  return `${mint.slice(0, 4)}..${mint.slice(-4)}`;
}

async function getJson(url: string): Promise<unknown> {
  const response = await fetch(url, {
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    headers: { accept: "application/json" },
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json();
}

export async function getPrice(mint: string): Promise<number | null> {
  const cached = priceCache.get(mint);
  if (cached && Date.now() - cached.fetchedAt < PRICE_TTL_MS) {
    return cached.price;
  }

  try {
    const payload = await getJson(`${JUP_PRICE_URL}?ids=${encodeURIComponent(mint)}`);
    const entry = (payload as Record<string, { usdPrice?: unknown }> | null)?.[mint];
    const price = Number(entry?.usdPrice);

    if (Number.isFinite(price) && price > 0) {
      priceCache.set(mint, { price, fetchedAt: Date.now() });
      return price;
    }

    log.warn(`no usable price for ${shortMint(mint)}`);
    return null;
  } catch (error: unknown) {
    log.warn(`price lookup failed for ${shortMint(mint)}: ${describe(error)}`);
    // A stale quote beats refusing the trade outright on a transient blip.
    return cached?.price ?? null;
  }
}

/** Refresh several mints at once; Jupiter accepts up to 50 ids per call. */
export async function getPrices(mints: readonly string[]): Promise<Map<string, number>> {
  const result = new Map<string, number>();
  const stale = mints.filter((mint) => {
    const cached = priceCache.get(mint);
    if (cached && Date.now() - cached.fetchedAt < PRICE_TTL_MS) {
      result.set(mint, cached.price);
      return false;
    }
    return true;
  });

  for (let i = 0; i < stale.length; i += 50) {
    const batch = stale.slice(i, i + 50);
    try {
      const payload = (await getJson(
        `${JUP_PRICE_URL}?ids=${batch.map(encodeURIComponent).join(",")}`,
      )) as Record<string, { usdPrice?: unknown }> | null;

      for (const mint of batch) {
        const price = Number(payload?.[mint]?.usdPrice);
        if (Number.isFinite(price) && price > 0) {
          priceCache.set(mint, { price, fetchedAt: Date.now() });
          result.set(mint, price);
        }
      }
    } catch (error: unknown) {
      log.warn(`batch price lookup failed: ${describe(error)}`);
      for (const mint of batch) {
        const cached = priceCache.get(mint);
        if (cached) result.set(mint, cached.price);
      }
    }
  }

  return result;
}

export async function getSymbol(mint: string): Promise<string> {
  const cached = symbolCache.get(mint);
  if (cached) return cached;

  let symbol = shortMint(mint);
  try {
    const payload = await getJson(`${JUP_SEARCH_URL}?query=${encodeURIComponent(mint)}`);
    const results = Array.isArray(payload)
      ? payload
      : ((payload as { tokens?: unknown[] } | null)?.tokens ?? []);

    for (const item of results) {
      const token = item as { id?: string; symbol?: string };
      if (token?.id === mint && token.symbol) {
        symbol = token.symbol;
        break;
      }
    }
  } catch {
    // Fall back to the shortened mint; a missing symbol never blocks a trade.
  }

  symbolCache.set(mint, symbol);
  return symbol;
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
