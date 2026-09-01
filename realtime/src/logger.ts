type Level = "info" | "warn" | "error";

function emit(level: Level, message: string): void {
  const line = `${new Date().toISOString()} [${level}] ${message}`;
  if (level === "error") process.stderr.write(`${line}\n`);
  else process.stdout.write(`${line}\n`);
}

export const log = {
  info: (message: string) => emit("info", message),
  warn: (message: string) => emit("warn", message),
  error: (message: string, error?: unknown) =>
    emit("error", error ? `${message}: ${describe(error)}` : message),
};

export function describe(error: unknown): string {
  if (error instanceof Error) return error.stack ?? error.message;
  return String(error);
}
