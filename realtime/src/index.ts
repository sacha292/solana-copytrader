import { Connection } from "@solana/web3.js";
import { loadConfig } from "./config.js";
import { SerialQueue } from "./chain/queue.js";
import { SubscriptionManager } from "./chain/subscriptions.js";
import { processSignature } from "./trading/pipeline.js";
import { markToMarket } from "./trading/portfolio.js";
import { Store } from "./store/db.js";
import { bootstrapFromGitHub } from "./store/bootstrap.js";
import { EventHub } from "./server/events.js";
import { broadcastState, createApp, type AppDeps } from "./server/app.js";
import { log, describe } from "./logger.js";

const MARK_TO_MARKET_INTERVAL_MS = 60_000;

async function main(): Promise<void> {
  const config = loadConfig();

  const store = await Store.open(config.DATA_DIR, {
    positionSizePct: config.POSITION_SIZE_PCT,
    sellAll: config.SELL_ALL,
  }, config.STARTING_CASH_USD);

  await bootstrapFromGitHub(store, config.BOOTSTRAP_WATCHLIST_URL, config.BOOTSTRAP_PORTFOLIO_URL);

  const connection = new Connection(config.HELIUS_RPC_URL, {
    commitment: "confirmed",
    wsEndpoint: config.wsEndpoint,
  });

  const hub = new EventHub();
  const queue = new SerialQueue();

  const subscriptions = new SubscriptionManager(connection, (address, signature, detectedAt) => {
    // Fire-and-forget into the serial queue: the websocket callback must never
    // block, but copies must still run strictly one at a time.
    void queue
      .run(() => processSignature(connection, store, address, signature, detectedAt))
      .then((outcome) => {
        if (!outcome.copied || !outcome.entry) return;
        hub.broadcast({ type: "trade", payload: outcome.entry });
        broadcastState(deps);
      })
      .catch((error: unknown) => {
        log.error(`Traitement de ${signature.slice(0, 12)}... echoue`, error);
      });
  });

  const deps: AppDeps = { store, subscriptions, hub, password: config.DASHBOARD_PASSWORD };

  await subscriptions.sync(store.read().wallets.map((wallet) => wallet.address));
  subscriptions.startHealthcheck();
  hub.startHeartbeat();

  const marker = setInterval(() => {
    void queue
      .run(async () => {
        await markToMarket(store.read().portfolio);
        await store.save();
      })
      .then(() => broadcastState(deps))
      .catch((error: unknown) => log.error("Mark-to-market echoue", error));
  }, MARK_TO_MARKET_INTERVAL_MS);
  marker.unref();

  const app = createApp(deps);
  const server = app.listen(config.PORT, "0.0.0.0", () => {
    log.info(`Serveur en ecoute sur :${config.PORT}`);
    log.info(`${subscriptions.addresses.length} subscription(s) websocket active(s)`);
  });

  const shutdown = async (signal: string): Promise<void> => {
    log.info(`${signal} recu, arret en cours`);
    clearInterval(marker);
    hub.stop();
    server.close();
    await subscriptions.stop();
    await store.save();
    process.exit(0);
  };

  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));

  process.on("unhandledRejection", (reason: unknown) => {
    log.error("Rejet non gere", reason);
  });
}

main().catch((error: unknown) => {
  log.error("Demarrage impossible", error);
  process.stderr.write(`${describe(error)}\n`);
  process.exit(1);
});
