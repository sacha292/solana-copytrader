import path from "node:path";
import { fileURLToPath } from "node:url";
import express, { type Express, type Request, type Response } from "express";
import { PublicKey } from "@solana/web3.js";
import { z } from "zod";
import { requirePassword } from "./auth.js";
import type { EventHub } from "./events.js";
import { log, describe } from "../logger.js";
import type { Store } from "../store/db.js";
import type { SubscriptionManager } from "../chain/subscriptions.js";
import type { Wallet } from "../types.js";

const PUBLIC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "public");

const addWalletSchema = z.object({
  address: z
    .string()
    .trim()
    .min(32, "Adresse trop courte")
    .max(48, "Adresse trop longue")
    .refine((value) => {
      try {
        // Rejects checksum-invalid or off-curve strings before we subscribe.
        new PublicKey(value);
        return true;
      } catch {
        return false;
      }
    }, "Adresse Solana invalide"),
  label: z.string().trim().min(1, "Label requis").max(40, "Label trop long"),
});

export interface AppDeps {
  store: Store;
  subscriptions: SubscriptionManager;
  hub: EventHub;
  password: string;
}

function snapshot(deps: AppDeps) {
  const state = deps.store.read();
  return {
    wallets: state.wallets.map((wallet) => ({
      ...wallet,
      live: deps.subscriptions.isSubscribed(wallet.address),
    })),
    portfolio: state.portfolio,
    settings: state.settings,
  };
}

export function broadcastState(deps: AppDeps): void {
  deps.hub.broadcast({ type: "state", payload: snapshot(deps) });
}

export function createApp(deps: AppDeps): Express {
  const app = express();
  app.set("trust proxy", 1);
  app.use(express.json({ limit: "16kb" }));

  app.use((_request, response, next) => {
    response.setHeader("X-Content-Type-Options", "nosniff");
    response.setHeader("X-Frame-Options", "DENY");
    response.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
    next();
  });

  app.get("/healthz", (_request, response) => {
    response.json({ success: true, data: { status: "ok" } });
  });

  app.get("/api/state", (_request, response) => {
    response.json({ success: true, data: snapshot(deps) });
  });

  app.get("/api/events", (request: Request, response: Response) => {
    deps.hub.add(response);
    response.write(`event: state\ndata: ${JSON.stringify(snapshot(deps))}\n\n`);
    request.on("close", () => response.end());
  });

  // Lets the dashboard validate a password before storing it locally.
  app.post("/api/auth/check", requirePassword(deps.password), (_request, response) => {
    response.json({ success: true, data: { ok: true } });
  });

  app.post("/api/wallets", requirePassword(deps.password), async (request, response) => {
    const parsed = addWalletSchema.safeParse(request.body);
    if (!parsed.success) {
      response.status(400).json({
        success: false,
        error: parsed.error.issues.map((issue) => issue.message).join(", "),
      });
      return;
    }

    const state = deps.store.read();
    const { address, label } = parsed.data;

    if (state.wallets.some((wallet) => wallet.address === address)) {
      response.status(409).json({ success: false, error: "Ce wallet est deja suivi" });
      return;
    }

    const wallet: Wallet = {
      address,
      label,
      addedAt: new Date().toISOString(),
      copiedTrades: 0,
    };

    try {
      await deps.subscriptions.subscribe(address);
    } catch (error: unknown) {
      log.error("Subscription impossible", error);
      response.status(502).json({ success: false, error: `Subscription impossible: ${describe(error)}` });
      return;
    }

    state.wallets.push(wallet);
    await deps.store.save();
    broadcastState(deps);

    log.info(`Wallet ajoute: ${label} (${address.slice(0, 8)}...)`);
    response.status(201).json({ success: true, data: wallet });
  });

  app.delete("/api/wallets/:address", requirePassword(deps.password), async (request, response) => {
    const address = request.params.address;
    if (!address) {
      response.status(400).json({ success: false, error: "Adresse manquante" });
      return;
    }

    const state = deps.store.read();
    const index = state.wallets.findIndex((wallet) => wallet.address === address);

    if (index === -1) {
      response.status(404).json({ success: false, error: "Wallet introuvable" });
      return;
    }

    await deps.subscriptions.unsubscribe(address);
    const [removed] = state.wallets.splice(index, 1);
    await deps.store.save();
    broadcastState(deps);

    log.info(`Wallet retire: ${removed?.label} (${address.slice(0, 8)}...)`);
    response.json({ success: true, data: removed });
  });

  app.use(express.static(PUBLIC_DIR, { extensions: ["html"], maxAge: "5m" }));

  app.use((_request, response) => {
    response.status(404).json({ success: false, error: "Not found" });
  });

  return app;
}
