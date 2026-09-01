import { z } from "zod";

const envSchema = z.object({
  HELIUS_RPC_URL: z
    .string()
    .url("HELIUS_RPC_URL doit etre une URL valide")
    .refine((value) => value.startsWith("https://"), "HELIUS_RPC_URL doit etre en https"),
  DASHBOARD_PASSWORD: z
    .string()
    .min(8, "DASHBOARD_PASSWORD doit faire au moins 8 caracteres"),
  PORT: z.coerce.number().int().positive().default(8080),
  DATA_DIR: z.string().default("./data"),
  POSITION_SIZE_PCT: z.coerce.number().positive().max(100).default(10),
  SELL_ALL: z
    .enum(["true", "false"])
    .default("true")
    .transform((value) => value === "true"),
  STARTING_CASH_USD: z.coerce.number().positive().default(1000),
  /** Raw files imported once on first boot to carry over the old bot's state. */
  BOOTSTRAP_WATCHLIST_URL: z
    .string()
    .url()
    .default(
      "https://raw.githubusercontent.com/sacha292/solana-copytrader/main/watchlist.json",
    ),
  BOOTSTRAP_PORTFOLIO_URL: z
    .string()
    .url()
    .default(
      "https://raw.githubusercontent.com/sacha292/solana-copytrader/main/portfolio.json",
    ),
});

export type Config = z.infer<typeof envSchema> & { wsEndpoint: string };

export function loadConfig(): Config {
  const parsed = envSchema.safeParse(process.env);

  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((issue) => `  - ${issue.path.join(".")}: ${issue.message}`)
      .join("\n");
    throw new Error(`Configuration invalide:\n${issues}`);
  }

  // Helius serves websockets on the same host over wss.
  const wsEndpoint = parsed.data.HELIUS_RPC_URL.replace(/^https:/, "wss:");
  return { ...parsed.data, wsEndpoint };
}
