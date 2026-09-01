import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { MAX_SEEN_SIGNATURES } from "../trading/constants.js";
import { log } from "../logger.js";
import type { AppState, Settings } from "../types.js";

export class Store {
  private readonly file: string;
  private state: AppState;
  /** Serialises writes so two rapid trades cannot interleave a save. */
  private writeChain: Promise<void> = Promise.resolve();

  private constructor(file: string, state: AppState) {
    this.file = file;
    this.state = state;
  }

  static async open(dataDir: string, settings: Settings, startingCash: number): Promise<Store> {
    await mkdir(dataDir, { recursive: true });
    const file = path.join(dataDir, "state.json");

    let state: AppState;
    try {
      state = JSON.parse(await readFile(file, "utf8")) as AppState;
      log.info(`Etat charge depuis ${file}`);
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") {
        throw new Error(`state.json illisible (${file}): ${String(error)}`);
      }
      log.info("Aucun etat existant, demarrage a vide");
      state = {
        wallets: [],
        portfolio: {
          startingCashUSD: startingCash,
          cashUSD: startingCash,
          holdingsUSD: 0,
          totalValueUSD: startingCash,
          updatedAt: null,
          positions: {},
          tradeLog: [],
        },
        settings,
        seenSignatures: [],
        bootstrappedAt: null,
      };
    }

    // Env always wins for settings so they can be changed via `fly secrets`.
    state.settings = settings;
    state.seenSignatures ??= [];
    state.wallets ??= [];

    return new Store(file, state);
  }

  read(): AppState {
    return this.state;
  }

  /** Atomic write: a crash mid-save can never leave a truncated state file. */
  save(): Promise<void> {
    this.writeChain = this.writeChain.then(async () => {
      const temporary = `${this.file}.tmp`;
      await writeFile(temporary, `${JSON.stringify(this.state, null, 2)}\n`, "utf8");
      await rename(temporary, this.file);
    });
    return this.writeChain;
  }

  hasSeen(signature: string): boolean {
    return this.state.seenSignatures.includes(signature);
  }

  markSeen(signature: string): void {
    if (this.hasSeen(signature)) return;
    this.state.seenSignatures.unshift(signature);
    this.state.seenSignatures.length = Math.min(
      this.state.seenSignatures.length,
      MAX_SEEN_SIGNATURES,
    );
  }
}
