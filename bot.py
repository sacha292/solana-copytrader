#!/usr/bin/env python3
"""
Solana copy-trading bot (paper trading).

Reads a watchlist of wallets, scans their newest on-chain transactions via the
public Solana RPC, detects buy/sell swaps, and mirrors them into a virtual
USD portfolio. Designed to run as a short-lived GitHub Actions job: all state
lives in JSON files that the workflow commits back to the repository.
"""

import json
import os
import sys
import time
from datetime import datetime, timezone

import requests

ROOT = os.path.dirname(os.path.abspath(__file__))

WATCHLIST_PATH = os.path.join(ROOT, "watchlist.json")
PORTFOLIO_PATH = os.path.join(ROOT, "portfolio.json")
SETTINGS_PATH = os.path.join(ROOT, "settings.json")

DEFAULT_RPC_URL = "https://api.mainnet-beta.solana.com"
JUP_PRICE_URL = "https://lite-api.jup.ag/price/v3"
JUP_SEARCH_URL = "https://lite-api.jup.ag/tokens/v2/search"

SOL_MINT = "So11111111111111111111111111111111111111112"
USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"
USDT_MINT = "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB"
BASE_MINTS = {SOL_MINT, USDC_MINT, USDT_MINT}

# A wallet's native SOL balance moves on every transaction because of fees.
# Only treat it as a real leg of a swap above this threshold.
MIN_SOL_DELTA = 0.005

# Public RPC endpoints are aggressively rate limited; pace every call.
RPC_DELAY_SECONDS = 0.35
MAX_RPC_RETRIES = 4

# Keep the committed trade log bounded so the repository does not grow forever.
MAX_TRADE_LOG_ENTRIES = 500

# Dust threshold below which a position is considered fully closed.
POSITION_DUST = 1e-9


# --------------------------------------------------------------------------
# JSON state helpers
# --------------------------------------------------------------------------

def load_json(path, fallback):
    if not os.path.exists(path):
        return fallback
    with open(path, "r", encoding="utf-8") as handle:
        try:
            return json.load(handle)
        except json.JSONDecodeError as exc:
            log("FATAL: %s is not valid JSON (%s)" % (os.path.basename(path), exc))
            sys.exit(1)


def save_json(path, data):
    with open(path, "w", encoding="utf-8") as handle:
        json.dump(data, handle, indent=2, ensure_ascii=False)
        handle.write("\n")


def log(message):
    print("[%s] %s" % (datetime.now(timezone.utc).strftime("%H:%M:%S"), message), flush=True)


def now_iso():
    return datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


def state_fingerprint(portfolio):
    """Serialise the portfolio ignoring updatedAt.

    The workflow only pushes when a file actually changed. If updatedAt moved on
    every run the file would always differ, so the bot would commit ~144 times a
    day with no real news. Comparing fingerprints lets us hold the timestamp
    still when nothing moved.
    """
    snapshot = dict(portfolio)
    snapshot.pop("updatedAt", None)
    return json.dumps(snapshot, sort_keys=True, default=str)


# --------------------------------------------------------------------------
# Solana RPC
# --------------------------------------------------------------------------

class SolanaRPC(object):
    def __init__(self, url):
        self.url = url
        self.session = requests.Session()
        self.request_id = 0

    def call(self, method, params):
        self.request_id += 1
        payload = {
            "jsonrpc": "2.0",
            "id": self.request_id,
            "method": method,
            "params": params,
        }

        for attempt in range(MAX_RPC_RETRIES):
            time.sleep(RPC_DELAY_SECONDS)
            try:
                response = self.session.post(self.url, json=payload, timeout=30)
            except requests.RequestException as exc:
                log("  RPC %s network error (%s), retry %d" % (method, exc, attempt + 1))
                time.sleep(2 ** attempt)
                continue

            if response.status_code == 429:
                wait = 2 ** attempt
                log("  RPC %s rate limited, waiting %ds" % (method, wait))
                time.sleep(wait)
                continue

            if response.status_code >= 500:
                log("  RPC %s HTTP %d, retry %d" % (method, response.status_code, attempt + 1))
                time.sleep(2 ** attempt)
                continue

            if response.status_code != 200:
                log("  RPC %s HTTP %d, giving up" % (method, response.status_code))
                return None

            try:
                body = response.json()
            except ValueError:
                log("  RPC %s returned non-JSON body" % method)
                return None

            if "error" in body:
                log("  RPC %s error: %s" % (method, body["error"]))
                return None

            return body.get("result")

        log("  RPC %s failed after %d attempts" % (method, MAX_RPC_RETRIES))
        return None

    def get_signatures(self, address, until, limit):
        options = {"limit": limit}
        if until:
            options["until"] = until
        return self.call("getSignaturesForAddress", [address, options])

    def get_transaction(self, signature):
        return self.call(
            "getTransaction",
            [signature, {"encoding": "jsonParsed", "maxSupportedTransactionVersion": 0}],
        )


# --------------------------------------------------------------------------
# Jupiter price + metadata
# --------------------------------------------------------------------------

class JupiterClient(object):
    def __init__(self):
        self.session = requests.Session()
        self.price_cache = {}
        self.symbol_cache = {}

    def get_price(self, mint):
        if mint in self.price_cache:
            return self.price_cache[mint]

        try:
            response = self.session.get(JUP_PRICE_URL, params={"ids": mint}, timeout=20)
            response.raise_for_status()
            payload = response.json()
        except (requests.RequestException, ValueError) as exc:
            log("  price lookup failed for %s: %s" % (mint[:8], exc))
            return None

        entry = payload.get(mint) if isinstance(payload, dict) else None
        price = None
        if isinstance(entry, dict):
            raw = entry.get("usdPrice")
            if raw is not None:
                try:
                    price = float(raw)
                except (TypeError, ValueError):
                    price = None

        if price is not None and price > 0:
            self.price_cache[mint] = price
            return price

        log("  no usable price for %s" % mint[:8])
        return None

    def get_symbol(self, mint):
        if mint in self.symbol_cache:
            return self.symbol_cache[mint]

        symbol = mint[:4] + ".." + mint[-4:]
        try:
            response = self.session.get(JUP_SEARCH_URL, params={"query": mint}, timeout=20)
            response.raise_for_status()
            payload = response.json()
        except (requests.RequestException, ValueError):
            payload = None

        results = payload if isinstance(payload, list) else (payload or {}).get("tokens", [])
        for item in results or []:
            if isinstance(item, dict) and item.get("id") == mint and item.get("symbol"):
                symbol = item["symbol"]
                break

        self.symbol_cache[mint] = symbol
        return symbol


# --------------------------------------------------------------------------
# Transaction analysis
# --------------------------------------------------------------------------

def account_key_index(transaction, address):
    """Find the wallet's position in accountKeys (jsonParsed gives dicts)."""
    message = (transaction.get("transaction") or {}).get("message") or {}
    for index, key in enumerate(message.get("accountKeys") or []):
        pubkey = key.get("pubkey") if isinstance(key, dict) else key
        if pubkey == address:
            return index
    return -1


def token_amount(entry):
    ui = (entry or {}).get("uiTokenAmount") or {}
    value = ui.get("uiAmount")
    if value is None:
        raw = ui.get("amount")
        decimals = ui.get("decimals") or 0
        if raw is None:
            return 0.0
        try:
            return float(raw) / (10 ** int(decimals))
        except (TypeError, ValueError):
            return 0.0
    try:
        return float(value)
    except (TypeError, ValueError):
        return 0.0


def compute_deltas(transaction, address):
    """Return {mint: delta} for everything the wallet gained or lost."""
    deltas = {}
    meta = transaction.get("meta") or {}

    index = account_key_index(transaction, address)
    if index >= 0:
        pre = meta.get("preBalances") or []
        post = meta.get("postBalances") or []
        if index < len(pre) and index < len(post):
            sol_delta = (post[index] - pre[index]) / 1e9
            if abs(sol_delta) > MIN_SOL_DELTA:
                deltas[SOL_MINT] = deltas.get(SOL_MINT, 0.0) + sol_delta

    # Wrapped-SOL and SPL token movements share the same mint namespace, so
    # they accumulate on top of the native delta computed above.
    before = {}
    for entry in meta.get("preTokenBalances") or []:
        if entry.get("owner") == address and entry.get("mint"):
            before[entry["mint"]] = before.get(entry["mint"], 0.0) + token_amount(entry)

    after = {}
    for entry in meta.get("postTokenBalances") or []:
        if entry.get("owner") == address and entry.get("mint"):
            after[entry["mint"]] = after.get(entry["mint"], 0.0) + token_amount(entry)

    for mint in set(before) | set(after):
        delta = after.get(mint, 0.0) - before.get(mint, 0.0)
        if delta != 0.0:
            deltas[mint] = deltas.get(mint, 0.0) + delta

    return {mint: value for mint, value in deltas.items() if value != 0.0}


def classify(deltas):
    """Map balance deltas onto a BUY, a SELL, or nothing worth copying."""
    spent_base = [m for m, d in deltas.items() if m in BASE_MINTS and d < 0]
    received_base = [m for m, d in deltas.items() if m in BASE_MINTS and d > 0]
    spent_token = [m for m, d in deltas.items() if m not in BASE_MINTS and d < 0]
    received_token = [m for m, d in deltas.items() if m not in BASE_MINTS and d > 0]

    if spent_base and received_token:
        mint = max(received_token, key=lambda m: abs(deltas[m]))
        return "BUY", mint

    if spent_token and received_base:
        mint = max(spent_token, key=lambda m: abs(deltas[m]))
        return "SELL", mint

    return None, None


# --------------------------------------------------------------------------
# Virtual portfolio
# --------------------------------------------------------------------------

def record_trade(portfolio, entry):
    portfolio.setdefault("tradeLog", []).insert(0, entry)
    del portfolio["tradeLog"][MAX_TRADE_LOG_ENTRIES:]


def execute_buy(portfolio, settings, jupiter, mint, label, signature):
    price = jupiter.get_price(mint)
    if price is None:
        log("  SKIP buy %s: no price available" % mint[:8])
        return False

    size_pct = float(settings.get("positionSizePct", 10))
    spend = portfolio["cashUSD"] * (size_pct / 100.0)
    if spend <= 0 or spend > portfolio["cashUSD"]:
        log("  SKIP buy %s: insufficient cash (%.2f USD)" % (mint[:8], portfolio["cashUSD"]))
        return False

    symbol = jupiter.get_symbol(mint)
    amount = spend / price

    positions = portfolio.setdefault("positions", {})
    position = positions.get(mint)
    if position:
        total_amount = position["amount"] + amount
        prior_cost = position["amount"] * position["avgCostUSD"]
        position["amount"] = total_amount
        position["avgCostUSD"] = (prior_cost + spend) / total_amount
        position["symbol"] = symbol
    else:
        positions[mint] = {"symbol": symbol, "amount": amount, "avgCostUSD": price}

    portfolio["cashUSD"] -= spend

    record_trade(portfolio, {
        "timestamp": now_iso(),
        "wallet": label,
        "action": "BUY",
        "mint": mint,
        "symbol": symbol,
        "amount": amount,
        "price": price,
        "valueUSD": spend,
        "signature": signature,
    })
    log("  BUY  %s %.6f @ $%.8f = $%.2f" % (symbol, amount, price, spend))
    return True


def execute_sell(portfolio, settings, jupiter, mint, label, signature):
    positions = portfolio.setdefault("positions", {})
    position = positions.get(mint)
    if not position or position["amount"] <= 0:
        log("  SKIP sell %s: no open position" % mint[:8])
        return False

    price = jupiter.get_price(mint)
    if price is None:
        log("  SKIP sell %s: no price available" % mint[:8])
        return False

    if settings.get("sellAll", True):
        fraction = 1.0
    else:
        fraction = float(settings.get("positionSizePct", 10)) / 100.0

    sell_amount = position["amount"] * fraction
    if sell_amount <= 0:
        log("  SKIP sell %s: computed sell amount is zero" % mint[:8])
        return False

    proceeds = sell_amount * price
    pnl = proceeds - (sell_amount * position["avgCostUSD"])

    portfolio["cashUSD"] += proceeds
    position["amount"] -= sell_amount
    symbol = position.get("symbol") or jupiter.get_symbol(mint)
    if position["amount"] <= POSITION_DUST:
        del positions[mint]

    record_trade(portfolio, {
        "timestamp": now_iso(),
        "wallet": label,
        "action": "SELL",
        "mint": mint,
        "symbol": symbol,
        "amount": sell_amount,
        "price": price,
        "valueUSD": proceeds,
        "pnl": pnl,
        "signature": signature,
    })
    log("  SELL %s %.6f @ $%.8f = $%.2f (PnL $%.2f)" % (symbol, sell_amount, price, proceeds, pnl))
    return True


# --------------------------------------------------------------------------
# Main loop
# --------------------------------------------------------------------------

def process_wallet(wallet, rpc, jupiter, portfolio, settings):
    """Scan one wallet. Returns True if the watchlist entry changed."""
    address = wallet.get("address")
    label = wallet.get("label") or (address[:6] if address else "unknown")
    if not address:
        log("Skipping watchlist entry without an address")
        return False

    log("Wallet %s (%s...)" % (label, address[:8]))
    limit = int(settings.get("signatureLimit", 15))
    signatures = rpc.get_signatures(address, wallet.get("lastSignature"), limit)

    if signatures is None:
        log("  could not fetch signatures, leaving cursor untouched")
        return False

    if not signatures:
        log("  no new transactions")
        return False

    # First time we see this wallet: anchor the cursor, do not replay history.
    if not wallet.get("lastSignature"):
        wallet["lastSignature"] = signatures[0]["signature"]
        log("  first sync, anchored at %s..." % signatures[0]["signature"][:16])
        return True

    log("  %d new signature(s)" % len(signatures))

    # The RPC returns newest first; replay chronologically so that weighted
    # average cost is computed in the order the trades actually happened.
    for item in reversed(signatures):
        signature = item.get("signature")
        if not signature:
            continue

        transaction = rpc.get_transaction(signature)
        if not transaction:
            log("  %s... unavailable, skipping" % signature[:16])
            continue

        if (transaction.get("meta") or {}).get("err"):
            continue

        deltas = compute_deltas(transaction, address)
        action, mint = classify(deltas)
        if not action:
            continue

        if action == "BUY":
            execute_buy(portfolio, settings, jupiter, mint, label, signature)
        else:
            execute_sell(portfolio, settings, jupiter, mint, label, signature)

    wallet["lastSignature"] = signatures[0]["signature"]
    return True


def mark_to_market(portfolio, jupiter):
    """Refresh the cached USD value of every open position for the dashboard."""
    positions = portfolio.get("positions") or {}
    holdings_value = 0.0

    for mint, position in positions.items():
        price = jupiter.get_price(mint)
        if price is None:
            price = position.get("lastPriceUSD")
        if price is None:
            position["valueUSD"] = None
            continue
        position["lastPriceUSD"] = price
        position["valueUSD"] = position["amount"] * price
        holdings_value += position["valueUSD"]

    portfolio["holdingsUSD"] = holdings_value
    portfolio["totalValueUSD"] = portfolio["cashUSD"] + holdings_value
    portfolio["updatedAt"] = now_iso()


def main():
    settings = load_json(SETTINGS_PATH, {})
    watchlist = load_json(WATCHLIST_PATH, [])
    portfolio = load_json(PORTFOLIO_PATH, {"cashUSD": 1000, "positions": {}, "tradeLog": []})

    portfolio.setdefault("cashUSD", 1000)
    portfolio.setdefault("positions", {})
    portfolio.setdefault("tradeLog", [])
    portfolio.setdefault("startingCashUSD", portfolio["cashUSD"])

    if not isinstance(watchlist, list):
        log("FATAL: watchlist.json must be a JSON array")
        sys.exit(1)

    previous_updated_at = portfolio.get("updatedAt")
    fingerprint_before = state_fingerprint(portfolio)

    rpc = SolanaRPC(settings.get("rpcUrl") or DEFAULT_RPC_URL)
    jupiter = JupiterClient()

    log("Scanning %d wallet(s)" % len(watchlist))
    watchlist_changed = False
    for wallet in watchlist:
        if process_wallet(wallet, rpc, jupiter, portfolio, settings):
            watchlist_changed = True

    mark_to_market(portfolio, jupiter)

    if state_fingerprint(portfolio) == fingerprint_before:
        portfolio["updatedAt"] = previous_updated_at
        log("Nothing moved since the last run")

    if watchlist_changed:
        save_json(WATCHLIST_PATH, watchlist)
    save_json(PORTFOLIO_PATH, portfolio)

    log("Total $%.2f  |  cash $%.2f  |  holdings $%.2f  |  %d position(s)" % (
        portfolio["totalValueUSD"],
        portfolio["cashUSD"],
        portfolio["holdingsUSD"],
        len(portfolio["positions"]),
    ))


if __name__ == "__main__":
    main()
