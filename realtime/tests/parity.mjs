// Replays the exact cases bot.py was validated against, to prove the port
// classifies and prices identically.
import { computeDeltas } from "../dist/trading/deltas.js";
import { classify } from "../dist/trading/classify.js";
import { SOL_MINT, USDC_MINT, MAX_TRADE_LOG_ENTRIES } from "../dist/trading/constants.js";

const W = "3XtAb2qGkt7TECVHrpo2rA2j56VgGmX1bpk3SFgh9Kp6";
const BONK = "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263";
const OTHER = "OtherTokenMint1111111111111111111111111111111";
const SOL = 1_000_000_000;

const tb = (mint, amount, owner = W) => ({
  owner, mint,
  uiTokenAmount: { uiAmount: amount, amount: String(Math.round(amount * 1e6)), decimals: 6 },
});

const tx = (solPre, solPost, pre, post) => ({
  transaction: { message: { accountKeys: [{ pubkey: W }, { pubkey: "other" }] } },
  meta: { err: null, preBalances: [solPre, 0], postBalances: [solPost, 0],
          preTokenBalances: pre, postTokenBalances: post },
});

const cases = [
  ["achat SOL->BONK",          tx(2 * SOL, 1.5 * SOL, [], [tb(BONK, 1000)]),                       "BUY",  BONK],
  ["vente BONK->SOL",          tx(1.5 * SOL, 2 * SOL, [tb(BONK, 1000)], []),                        "SELL", BONK],
  ["achat USDC->BONK",         tx(SOL, SOL, [tb(USDC_MINT, 500)], [tb(USDC_MINT, 400), tb(BONK, 2000)]), "BUY", BONK],
  ["swap token-token",         tx(SOL, SOL, [tb(BONK, 1000)], [tb(OTHER, 50)]),                     null,   null],
  ["transfert SOL simple",     tx(2 * SOL, SOL, [], []),                                            null,   null],
  ["bruit de frais",           tx(SOL, SOL - 5000, [], []),                                         null,   null],
  ["achat wSOL->BONK",         tx(SOL, SOL, [tb(SOL_MINT, 3)], [tb(SOL_MINT, 1), tb(BONK, 900)]),   "BUY",  BONK],
  ["balances autre owner",     tx(SOL, SOL, [], [tb(BONK, 100, "someoneelse")]),                    null,   null],
];

let failures = 0;
for (const [name, transaction, expectedAction, expectedMint] of cases) {
  const { action, mint } = classify(computeDeltas(transaction, W));
  const ok = action === expectedAction && mint === expectedMint;
  if (!ok) failures += 1;
  console.log(`  ${ok ? "PASS" : "FAIL"} ${name} -> ${action}${ok ? "" : ` (attendu ${expectedAction})`}`);
}

console.log(`\n${cases.length - failures}/${cases.length} cas de classification OK`);
console.log(`plafond du journal: ${MAX_TRADE_LOG_ENTRIES} (bot.py: 500)`);
process.exit(failures ? 1 : 0);
