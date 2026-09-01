import type { ParsedTransactionWithMeta, TokenBalance } from "@solana/web3.js";
import { LAMPORTS_PER_SOL, MIN_SOL_DELTA, SOL_MINT } from "./constants.js";

/** Everything the wallet gained (positive) or lost (negative), keyed by mint. */
export type Deltas = Record<string, number>;

function accountKeyIndex(transaction: ParsedTransactionWithMeta, address: string): number {
  const keys = transaction.transaction?.message?.accountKeys ?? [];
  for (let index = 0; index < keys.length; index += 1) {
    const key = keys[index];
    if (!key) continue;
    const pubkey = typeof key.pubkey === "string" ? key.pubkey : key.pubkey?.toBase58();
    if (pubkey === address) return index;
  }
  return -1;
}

function tokenAmount(entry: TokenBalance): number {
  const ui = entry.uiTokenAmount;
  if (!ui) return 0;

  if (ui.uiAmount !== null && ui.uiAmount !== undefined) {
    const value = Number(ui.uiAmount);
    return Number.isFinite(value) ? value : 0;
  }

  // uiAmount can be null for very large raw amounts; fall back to the raw value.
  const raw = Number(ui.amount);
  if (!Number.isFinite(raw)) return 0;
  return raw / 10 ** (ui.decimals ?? 0);
}

function sumByMint(balances: readonly TokenBalance[] | null | undefined, address: string): Map<string, number> {
  const totals = new Map<string, number>();
  for (const entry of balances ?? []) {
    if (entry.owner !== address || !entry.mint) continue;
    totals.set(entry.mint, (totals.get(entry.mint) ?? 0) + tokenAmount(entry));
  }
  return totals;
}

export function computeDeltas(transaction: ParsedTransactionWithMeta, address: string): Deltas {
  const deltas: Deltas = {};
  const meta = transaction.meta;
  if (!meta) return deltas;

  const index = accountKeyIndex(transaction, address);
  if (index >= 0) {
    const pre = meta.preBalances?.[index];
    const post = meta.postBalances?.[index];
    if (pre !== undefined && post !== undefined) {
      const solDelta = (post - pre) / LAMPORTS_PER_SOL;
      if (Math.abs(solDelta) > MIN_SOL_DELTA) {
        deltas[SOL_MINT] = (deltas[SOL_MINT] ?? 0) + solDelta;
      }
    }
  }

  // Wrapped SOL and SPL tokens share the same mint namespace, so a wSOL leg
  // accumulates on top of the native delta above. Without this merge, a swap
  // routed through wrapped SOL would look like a token-to-token swap.
  const before = sumByMint(meta.preTokenBalances, address);
  const after = sumByMint(meta.postTokenBalances, address);

  for (const mint of new Set([...before.keys(), ...after.keys()])) {
    const delta = (after.get(mint) ?? 0) - (before.get(mint) ?? 0);
    if (delta !== 0) {
      deltas[mint] = (deltas[mint] ?? 0) + delta;
    }
  }

  for (const [mint, value] of Object.entries(deltas)) {
    if (value === 0) delete deltas[mint];
  }

  return deltas;
}
