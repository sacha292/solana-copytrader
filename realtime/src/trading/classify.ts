import { BASE_MINTS } from "./constants.js";
import type { Deltas } from "./deltas.js";
import type { Classification } from "../types.js";

const NOTHING: Classification = { action: null, mint: null };

/** Map balance deltas onto a BUY, a SELL, or nothing worth copying. */
export function classify(deltas: Deltas): Classification {
  const entries = Object.entries(deltas);

  const spentBase = entries.filter(([mint, d]) => BASE_MINTS.has(mint) && d < 0);
  const receivedBase = entries.filter(([mint, d]) => BASE_MINTS.has(mint) && d > 0);
  const spentToken = entries.filter(([mint, d]) => !BASE_MINTS.has(mint) && d < 0);
  const receivedToken = entries.filter(([mint, d]) => !BASE_MINTS.has(mint) && d > 0);

  const largest = (candidates: [string, number][]): string =>
    candidates.reduce((best, current) =>
      Math.abs(current[1]) > Math.abs(best[1]) ? current : best,
    )[0];

  if (spentBase.length > 0 && receivedToken.length > 0) {
    return { action: "BUY", mint: largest(receivedToken) };
  }

  if (spentToken.length > 0 && receivedBase.length > 0) {
    return { action: "SELL", mint: largest(spentToken) };
  }

  return NOTHING;
}
