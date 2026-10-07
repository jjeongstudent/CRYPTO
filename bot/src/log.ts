type Level = "debug" | "info" | "warn" | "error";

const ORDER: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };
let threshold: number = ORDER[(process.env.LOG_LEVEL as Level) ?? "info"] ?? ORDER.info;

export function setLogLevel(level: Level): void {
  threshold = ORDER[level];
}

function emit(level: Level, msg: string, fields?: Record<string, unknown>): void {
  if (ORDER[level] < threshold) return;
  const extra = fields
    ? " " +
      Object.entries(fields)
        .map(([k, v]) => `${k}=${typeof v === "bigint" ? v.toString() : typeof v === "object" ? JSON.stringify(v, bigintJson) : String(v)}`)
        .join(" ")
    : "";
  const line = `${new Date().toISOString()} ${level.toUpperCase().padEnd(5)} ${msg}${extra}`;
  if (level === "error" || level === "warn") console.error(line);
  else console.log(line);
}

export function bigintJson(_key: string, value: unknown): unknown {
  return typeof value === "bigint" ? value.toString() : value;
}

export const log = {
  debug: (msg: string, fields?: Record<string, unknown>) => emit("debug", msg, fields),
  info: (msg: string, fields?: Record<string, unknown>) => emit("info", msg, fields),
  warn: (msg: string, fields?: Record<string, unknown>) => emit("warn", msg, fields),
  error: (msg: string, fields?: Record<string, unknown>) => emit("error", msg, fields),
};
