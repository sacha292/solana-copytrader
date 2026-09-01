// Same money assertions bot.py passed: weighted average cost, realised PnL,
// partial sells, and the guards that refuse a trade.
// Jupiter is stubbed at the fetch layer, so the real parsing code runs too.
process.env.PRICE_TTL_MS = "0";

const { copyTrade } = await import("../dist/trading/portfolio.js");

const M = "TestMint111111111111111111111111111111111111";
const S = { positionSizePct: 10, sellAll: true };

let stubbedPrice = 1;
globalThis.fetch = async (url) => {
  const target = String(url);
  if (target.includes("/tokens/v2/search")) {
    return new Response(JSON.stringify([{ id: M, symbol: "TEST" }]), { status: 200 });
  }
  if (stubbedPrice === null) return new Response(JSON.stringify({}), { status: 200 });
  return new Response(JSON.stringify({ [M]: { usdPrice: stubbedPrice } }), { status: 200 });
};

const fresh = () => ({
  startingCashUSD: 1000, cashUSD: 1000, holdingsUSD: 0,
  totalValueUSD: 1000, updatedAt: null, positions: {}, tradeLog: [],
});

let failures = 0;
let counter = 0;
const check = (name, condition, detail = "") => {
  if (!condition) failures += 1;
  console.log(`  ${condition ? "PASS" : "FAIL"} ${name}${condition ? "" : `  ${detail}`}`);
};

const run = (portfolio, action, settings = S) =>
  copyTrade({ portfolio, settings, mint: M, label: "w", signature: `sig${counter++}`,
              action, detectedAt: Date.now() });

// Two buys at different prices -> weighted average cost.
const p = fresh();
stubbedPrice = 1;  await run(p, "BUY");   // $100 -> 100 units @ $1
stubbedPrice = 2;  await run(p, "BUY");   // $90  -> 45 units  @ $2
const pos = p.positions[M];
check("cash apres 2 achats = 810", Math.abs(p.cashUSD - 810) < 1e-9, String(p.cashUSD));
check("quantite = 145", Math.abs(pos.amount - 145) < 1e-9, String(pos.amount));
check("cout moyen = 190/145", Math.abs(pos.avgCostUSD - 190 / 145) < 1e-9, String(pos.avgCostUSD));

// Full sell at $3: proceeds 435, cost 190, pnl +245.
stubbedPrice = 3;  await run(p, "SELL");
check("position fermee (sellAll)", !(M in p.positions));
check("cash final = 1245", Math.abs(p.cashUSD - 1245) < 1e-9, String(p.cashUSD));
check("pnl realise = +245", Math.abs(p.tradeLog[0].pnl - 245) < 1e-9, String(p.tradeLog[0].pnl));
check("journal antichronologique", p.tradeLog[0].action === "SELL");
check("latence mesuree", typeof p.tradeLog[0].latencyMs === "number");

// Partial sell when sellAll = false.
const p2 = fresh();
stubbedPrice = 1;  await run(p2, "BUY");
await run(p2, "SELL", { positionSizePct: 10, sellAll: false });
check("vente partielle laisse 90", Math.abs(p2.positions[M].amount - 90) < 1e-9,
      String(p2.positions[M]?.amount));

// Guards.
const p3 = fresh();
const noPosition = await run(p3, "SELL");
check("vente sans position refusee", noPosition.copied === false);
stubbedPrice = null;
const noPrice = await run(p3, "BUY");
check("achat sans prix refuse", noPrice.copied === false);
check("cash intact apres refus", p3.cashUSD === 1000, String(p3.cashUSD));

console.log(`\n${failures} echec(s)`);
process.exit(failures ? 1 : 0);
