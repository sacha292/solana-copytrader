import { Connection, PublicKey, type Logs } from "@solana/web3.js";
import { log, describe } from "../logger.js";

export type LogHandler = (address: string, signature: string, detectedAt: number) => void;

const HEALTHCHECK_INTERVAL_MS = 45_000;
const MAX_FAILED_HEALTHCHECKS = 3;

export class SubscriptionManager {
  private readonly connection: Connection;
  private readonly handler: LogHandler;
  private readonly active = new Map<string, number>();
  private healthTimer: NodeJS.Timeout | null = null;
  private failedChecks = 0;

  constructor(connection: Connection, handler: LogHandler) {
    this.connection = connection;
    this.handler = handler;
  }

  get addresses(): string[] {
    return [...this.active.keys()];
  }

  isSubscribed(address: string): boolean {
    return this.active.has(address);
  }

  async subscribe(address: string): Promise<void> {
    if (this.active.has(address)) return;

    let pubkey: PublicKey;
    try {
      pubkey = new PublicKey(address);
    } catch {
      throw new Error(`Adresse Solana invalide: ${address}`);
    }

    const id = this.connection.onLogs(
      pubkey,
      (logs: Logs) => {
        // Stamp arrival immediately so reported latency is the real end-to-end
        // delay, not just the time spent in our own pipeline.
        const detectedAt = Date.now();
        if (logs.err) return;
        if (!logs.signature) return;
        this.handler(address, logs.signature, detectedAt);
      },
      "confirmed",
    );

    this.active.set(address, id);
    log.info(`Subscription ouverte sur ${address.slice(0, 8)}... (id ${id})`);
  }

  async unsubscribe(address: string): Promise<void> {
    const id = this.active.get(address);
    if (id === undefined) return;

    this.active.delete(address);
    try {
      await this.connection.removeOnLogsListener(id);
      log.info(`Subscription fermee sur ${address.slice(0, 8)}...`);
    } catch (error: unknown) {
      log.warn(`Fermeture de subscription echouee (${address.slice(0, 8)}...): ${describe(error)}`);
    }
  }

  /** Bring live subscriptions in line with the watchlist, adding and removing. */
  async sync(addresses: readonly string[]): Promise<void> {
    const wanted = new Set(addresses);

    for (const address of this.addresses) {
      if (!wanted.has(address)) await this.unsubscribe(address);
    }
    for (const address of wanted) {
      if (!this.active.has(address)) await this.subscribe(address);
    }
  }

  /**
   * web3.js reconnects its websocket on its own, but a half-open socket can
   * stay silent forever. Poll a cheap RPC call and rebuild every subscription
   * if the endpoint stops answering.
   */
  startHealthcheck(): void {
    if (this.healthTimer) return;

    this.healthTimer = setInterval(async () => {
      try {
        await this.connection.getSlot("confirmed");
        this.failedChecks = 0;
      } catch (error: unknown) {
        this.failedChecks += 1;
        log.warn(`Healthcheck RPC echoue (${this.failedChecks}/${MAX_FAILED_HEALTHCHECKS}): ${describe(error)}`);

        if (this.failedChecks >= MAX_FAILED_HEALTHCHECKS) {
          this.failedChecks = 0;
          const addresses = this.addresses;
          log.warn(`Reconstruction de ${addresses.length} subscription(s)`);
          for (const address of addresses) await this.unsubscribe(address);
          for (const address of addresses) {
            try {
              await this.subscribe(address);
            } catch (subscribeError: unknown) {
              log.error(`Re-subscription impossible sur ${address.slice(0, 8)}...`, subscribeError);
            }
          }
        }
      }
    }, HEALTHCHECK_INTERVAL_MS);

    this.healthTimer.unref();
  }

  async stop(): Promise<void> {
    if (this.healthTimer) clearInterval(this.healthTimer);
    this.healthTimer = null;
    for (const address of this.addresses) await this.unsubscribe(address);
  }
}
