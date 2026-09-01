import type { Connection, ParsedTransactionWithMeta } from "@solana/web3.js";
import { classify } from "./classify.js";
import { computeDeltas } from "./deltas.js";
import { copyTrade, markToMarket } from "./portfolio.js";
import { log, describe } from "../logger.js";
import type { Store } from "../store/db.js";
import type { TradeLogEntry } from "../types.js";

/**
 * At `confirmed` the transaction is often not queryable for a second or two.
 * Retry briefly rather than dropping a trade we just detected.
 */
const FETCH_ATTEMPTS = 5;
const FETCH_BACKOFF_MS = 700;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function fetchTransaction(
  connection: Connection,
  signature: string,
): Promise<ParsedTransactionWithMeta | null> {
  for (let attempt = 1; attempt <= FETCH_ATTEMPTS; attempt += 1) {
    try {
      const transaction = await connection.getParsedTransaction(signature, {
        maxSupportedTransactionVersion: 0,
        commitment: "confirmed",
      });
      if (transaction) return transaction;
    } catch (error: unknown) {
      log.warn(`getParsedTransaction ${signature.slice(0, 12)}... : ${describe(error)}`);
    }
    if (attempt < FETCH_ATTEMPTS) await sleep(FETCH_BACKOFF_MS * attempt);
  }
  return null;
}

export interface ProcessOutcome {
  copied: boolean;
  entry?: TradeLogEntry;
}

/**
 * Full copy path for one detected signature. Must be called inside the serial
 * queue: it reads and writes shared portfolio state.
 */
export async function processSignature(
  connection: Connection,
  store: Store,
  address: string,
  signature: string,
  detectedAt: number,
): Promise<ProcessOutcome> {
  const state = store.read();

  if (store.hasSeen(signature)) return { copied: false };

  const wallet = state.wallets.find((candidate) => candidate.address === address);
  if (!wallet) return { copied: false };

  const transaction = await fetchTransaction(connection, signature);
  if (!transaction) {
    log.warn(`Transaction ${signature.slice(0, 12)}... introuvable, abandon`);
    return { copied: false };
  }

  if (transaction.meta?.err) return { copied: false };

  const deltas = computeDeltas(transaction, address);
  const { action, mint } = classify(deltas);
  if (!action || !mint) return { copied: false };

  // Mark before executing: a crash mid-copy must not replay the same trade.
  store.markSeen(signature);

  const result = await copyTrade({
    portfolio: state.portfolio,
    settings: state.settings,
    mint,
    label: wallet.label,
    signature,
    action,
    detectedAt,
  });

  if (!result.copied) {
    log.info(`SKIP ${action} ${mint.slice(0, 8)}... : ${result.reason}`);
    await store.save();
    return { copied: false };
  }

  wallet.copiedTrades += 1;
  await markToMarket(state.portfolio);
  await store.save();

  return { copied: true, entry: result.entry };
}
