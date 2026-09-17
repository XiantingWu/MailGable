import { asText, type Env } from "./lib.js";

export type LogLevel = "error" | "info" | "debug";

const LEVEL_RANK: Record<LogLevel, number> = { error: 0, info: 1, debug: 2 };
const REDACTED_FIELDS = new Set([
  "authorization",
  "password",
  "token",
  "secret",
  "api_key",
  "session",
  "cookie",
  "raw",
  "body",
]);

export function logLevel(env: Pick<Env, "LOG_LEVEL"> | undefined): LogLevel {
  const value = asText(env?.LOG_LEVEL, 20).trim().toLowerCase();
  return value === "debug" ? "debug" : value === "info" ? "info" : "error";
}

export function redactFields(fields: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(fields)) {
    const name = key.toLowerCase();
    result[key] = REDACTED_FIELDS.has(name) || name.includes("secret") || name.includes("token") || name.includes("password")
      ? "[redacted]"
      : value;
  }
  return result;
}

function write(env: Pick<Env, "LOG_LEVEL"> | undefined, level: LogLevel, message: string, fields: Record<string, unknown> = {}): void {
  if (LEVEL_RANK[level] > LEVEL_RANK[logLevel(env)]) return;
  const entry = JSON.stringify({ level, message, ...redactFields(fields) });
  if (level === "error") console.error(entry);
  else console.log(entry);
}

export function logError(env: Pick<Env, "LOG_LEVEL"> | undefined, message: string, fields: Record<string, unknown> = {}): void {
  write(env, "error", message, fields);
}

export function logInfo(env: Pick<Env, "LOG_LEVEL"> | undefined, message: string, fields: Record<string, unknown> = {}): void {
  write(env, "info", message, fields);
}

export function logDebug(env: Pick<Env, "LOG_LEVEL"> | undefined, message: string, fields: Record<string, unknown> = {}): void {
  write(env, "debug", message, fields);
}