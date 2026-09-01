import type { Response } from "express";
import { log } from "../logger.js";

export type ServerEvent =
  | { type: "state"; payload: unknown }
  | { type: "trade"; payload: unknown };

/** Server-Sent Events hub: pushes portfolio changes to open dashboards. */
export class EventHub {
  private readonly clients = new Set<Response>();
  private heartbeat: NodeJS.Timeout | null = null;

  add(response: Response): void {
    response.setHeader("Content-Type", "text/event-stream");
    response.setHeader("Cache-Control", "no-cache, no-transform");
    response.setHeader("Connection", "keep-alive");
    // Proxies buffer streamed bodies by default and would delay every event.
    response.setHeader("X-Accel-Buffering", "no");
    response.flushHeaders();
    response.write(": connected\n\n");

    this.clients.add(response);
    response.on("close", () => {
      this.clients.delete(response);
    });
  }

  broadcast(event: ServerEvent): void {
    const frame = `event: ${event.type}\ndata: ${JSON.stringify(event.payload)}\n\n`;
    for (const client of this.clients) {
      try {
        client.write(frame);
      } catch (error: unknown) {
        this.clients.delete(client);
        log.warn(`Client SSE retire: ${String(error)}`);
      }
    }
  }

  /** Comment frames keep idle proxies from closing the stream. */
  startHeartbeat(intervalMs = 25_000): void {
    if (this.heartbeat) return;
    this.heartbeat = setInterval(() => {
      for (const client of this.clients) {
        try {
          client.write(": ping\n\n");
        } catch {
          this.clients.delete(client);
        }
      }
    }, intervalMs);
    this.heartbeat.unref();
  }

  stop(): void {
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.heartbeat = null;
    for (const client of this.clients) client.end();
    this.clients.clear();
  }
}
