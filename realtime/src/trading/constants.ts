export const SOL_MINT = "So11111111111111111111111111111111111111112";
export const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
export const USDT_MINT = "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB";

export const BASE_MINTS: ReadonlySet<string> = new Set([SOL_MINT, USDC_MINT, USDT_MINT]);

/**
 * A wallet's native SOL balance moves on every transaction because of fees.
 * Only treat it as a real leg of a swap above this threshold.
 */
export const MIN_SOL_DELTA = 0.005;

export const LAMPORTS_PER_SOL = 1_000_000_000;

/** Dust threshold below which a position is considered fully closed. */
export const POSITION_DUST = 1e-9;

/** Keep the persisted trade log bounded. */
export const MAX_TRADE_LOG_ENTRIES = 500;

/** How many copied signatures to remember for de-duplication. */
export const MAX_SEEN_SIGNATURES = 2000;
