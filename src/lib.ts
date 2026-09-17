import { logError } from "./log.js";

// Bindings and vars come from wrangler.jsonc via `npx wrangler types`
// (worker-configuration.d.ts); never hand-write Env. Fields such as
// APP_ORIGIN are declared as vars and may be empty strings.
export type Env = Cloudflare.Env;

export type Row = Record<string, unknown>;

export const SESSION_COOKIE_NAME = "__Host-mailbox_session";

export class AppError extends Error {
  constructor(
    public status: number,
    message: string,
    public code = "request_failed",
  ) {
    super(message);
  }
}

export const encoder = new TextEncoder();
export const decoder = new TextDecoder();
export const now = (): string => new Date().toISOString();
export const uuid = (): string => crypto.randomUUID();

export function asText(value: unknown, max = 10_000): string {
  return typeof value === "string" ? value.slice(0, max) : "";
}

export function asInt(value: unknown, fallback: number, min: number, max: number): number {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  return Number.isSafeInteger(parsed) && parsed >= min && parsed <= max ? parsed : fallback;
}

export function json(data: unknown, status = 200, extra: HeadersInit = {}): Response {
  const headers = new Headers(extra);
  headers.set("Content-Type", "application/json; charset=utf-8");
  headers.set("Cache-Control", "no-store");
  return new Response(JSON.stringify(data), { status, headers });
}

export function createRequestId(request: Request): string {
  const ray = request.headers.get("CF-Ray");
  if (ray && /^[a-f0-9]{16}/i.test(ray)) return ray.slice(0, 16);
  return crypto.randomUUID();
}

export function errorResponse(error: unknown, env: Pick<Env, "LOG_LEVEL"> | undefined = undefined, requestId = ""): Response {
  if (error instanceof AppError) {
    return json({ error: error.message, code: error.code, ...(requestId ? { request_id: requestId } : {}) }, error.status);
  }
  logError(env, "Unhandled mailbox error", { error: error instanceof Error ? error.name : "unknown", request_id: requestId || undefined });
  return json({ error: "The mailbox service is temporarily unavailable.", code: "internal_error", ...(requestId ? { request_id: requestId } : {}) }, 500);
}

export async function readJson(request: Request, maxBytes = 128 * 1024): Promise<Row> {
  const declared = Number.parseInt(request.headers.get("Content-Length") || "0", 10);
  if (Number.isFinite(declared) && declared > maxBytes) throw new AppError(413, "Request body is too large.", "body_too_large");
  const body = await request.arrayBuffer();
  if (body.byteLength > maxBytes) throw new AppError(413, "Request body is too large.", "body_too_large");
  if (!body.byteLength) return {};
  try {
    const parsed = JSON.parse(decoder.decode(body));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("object required");
    return parsed as Row;
  } catch {
    throw new AppError(400, "Request body must be valid JSON.", "invalid_json");
  }
}

export function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunk = 0x8000;
  for (let index = 0; index < bytes.length; index += chunk) {
    binary += String.fromCharCode(...bytes.subarray(index, Math.min(index + chunk, bytes.length)));
  }
  return btoa(binary);
}

export function base64ToBytes(value: string): Uint8Array {
  try {
    const binary = atob(value.replace(/\s/g, ""));
    return Uint8Array.from(binary, (character) => character.charCodeAt(0));
  } catch {
    throw new AppError(400, "An attachment is not valid Base64 data.", "invalid_attachment");
  }
}

export function base64Url(bytes: Uint8Array): string {
  return bytesToBase64(bytes).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

export function base64UrlToBytes(value: string): Uint8Array {
  const standard = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = standard + "=".repeat((4 - standard.length % 4) % 4);
  return base64ToBytes(padded);
}

export function randomToken(size = 32): string {
  const bytes = new Uint8Array(size);
  crypto.getRandomValues(bytes);
  return base64Url(bytes);
}

export function arrayBuffer(value: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(value.byteLength);
  copy.set(value);
  return copy.buffer;
}

export async function sha256Bytes(value: string | Uint8Array): Promise<Uint8Array> {
  const input = typeof value === "string" ? encoder.encode(value) : value;
  return new Uint8Array(await crypto.subtle.digest("SHA-256", arrayBuffer(input)));
}

export async function sha256(value: string | Uint8Array): Promise<string> {
  return base64Url(await sha256Bytes(value));
}

export async function hmacSha256(secret: Uint8Array, value: string): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey("raw", arrayBuffer(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(value)));
}

export function timingSafeEqual(a: string, b: string): boolean {
  const aa = encoder.encode(a);
  const bb = encoder.encode(b);
  let difference = aa.length ^ bb.length;
  const length = Math.max(aa.length, bb.length);
  for (let index = 0; index < length; index += 1) difference |= (aa[index] || 0) ^ (bb[index] || 0);
  return difference === 0;
}

export function validEmail(value: string): boolean {
  return value.length <= 320 && /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(value);
}

export function normalizeEmail(value: unknown): string {
  const raw = asText(value, 320).trim();
  const match = raw.match(/<([^<>]+)>/);
  return (match?.[1] || raw).trim().toLowerCase();
}

export function emailList(value: unknown, max = 50): string[] {
  const source = Array.isArray(value) ? value.flatMap((item) => emailList(item, max)) : asText(value, 30_000).split(/[;,\n]+/);
  return [...new Set(source.map(normalizeEmail).filter(validEmail))].slice(0, max);
}

export function safeFilename(value: unknown): string {
  const result = asText(value, 180)
    .normalize("NFKC")
    .replace(/[\\/\u0000-\u001f<>:"|?*]+/g, "_")
    .replace(/^\.+$/, "attachment")
    .trim();
  return (result || "attachment").slice(0, 160);
}

export function safeSegment(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 120) || "unknown";
}

export function truncateUtf8(value: string, maxBytes: number): string {
  if (maxBytes <= 0 || !value) return "";
  if (encoder.encode(value).byteLength <= maxBytes) return value;
  let low = 0;
  let high = value.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    let end = middle;
    const code = value.charCodeAt(end - 1);
    if (code >= 0xd800 && code <= 0xdbff) end -= 1;
    const size = encoder.encode(value.slice(0, end)).byteLength;
    if (size <= maxBytes) low = middle;
    else high = middle - 1;
  }
  let end = low;
  const code = value.charCodeAt(end - 1);
  if (code >= 0xd800 && code <= 0xdbff) end -= 1;
  while (end > 0 && encoder.encode(value.slice(0, end)).byteLength > maxBytes) end -= 1;
  return value.slice(0, end);
}

const BIDI_CONTROL_PATTERN = /[\u202A-\u202E\u2066-\u2069]/g;

export function stripBidiControls(value: string): string {
  return value.replace(BIDI_CONTROL_PATTERN, "");
}

export function safeDisplayText(value: unknown, max = 10_000): string {
  return stripBidiControls(asText(value, max).replace(/[\r\n\t]+/g, " ").trim());
}

export function safeDisplayFilename(value: unknown): string {
  return stripBidiControls(safeFilename(value));
}

export function safeExternalHref(value: string): string | null {
  const trimmed = value.trim();
  if (/^(https:\/\/|mailto:)/i.test(trimmed)) return trimmed;
  return null;
}

export function sanitizeHtml(value: string): string {
  let result = value.slice(0, 1_000_000)
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<\s*(script|style|iframe|object|embed|form|base|meta|link|svg|math|template|foreignObject)[^>]*>[\s\S]*?<\s*\/\s*\1\s*>/gi, "")
    .replace(/<\s*\/?\s*(script|style|iframe|object|embed|form|base|meta|link|svg|math|template|foreignObject)[^>]*>/gi, "")
    .replace(/\s+on[a-z0-9_-]+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, "");
  // Remove every dangerous URI attribute (javascript:, data:, vbscript:,
  // protocol-relative, and all non-href navigation sources). Remote images
  // are blocked by default, so every src/srcset attribute is removed.
  result = result.replace(/\s+(src|srcset|action|formaction|poster|background|xlink:href)\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, "");
  result = result.replace(/\s+(target|rel|download)\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, "");
  result = result.replace(/\s+href\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, (match, quoted) => {
    const value = quoted.slice(1, -1);
    if (safeExternalHref(value)) {
      return ` href=${quoted} target="_blank" rel="noopener noreferrer nofollow"`;
    }
    return "";
  });
  return result
    .replace(/\s+style\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, "");
}

export function escapeHtml(value: unknown): string {
  return asText(value, 1_000_000)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function cookieMap(request: Request): Map<string, string> {
  const result = new Map<string, string>();
  for (const part of (request.headers.get("Cookie") || "").split(";")) {
    const index = part.indexOf("=");
    if (index <= 0) continue;
    try {
      result.set(part.slice(0, index).trim(), decodeURIComponent(part.slice(index + 1).trim()));
    } catch {
      continue;
    }
  }
  return result;
}

export function sessionCookie(token: string, maxAgeSeconds: number): string {
  return `${SESSION_COOKIE_NAME}=${encodeURIComponent(token)}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${maxAgeSeconds}`;
}

export function clearSessionCookie(): string {
  return sessionCookie("", 0);
}

export function requireAuthPepper(env: Pick<Env, "AUTH_PEPPER">): string {
  const pepper = env.AUTH_PEPPER;
  if (!pepper || typeof pepper !== "string" || encoder.encode(pepper).byteLength < 32) {
    throw new AppError(503, "AUTH_PEPPER is not configured. Authentication is disabled.", "auth_not_configured");
  }
  if (encoder.encode(pepper).byteLength > 512) {
    throw new AppError(503, "AUTH_PEPPER exceeds the maximum supported length.", "auth_not_configured");
  }
  return pepper;
}

export async function requestIpHash(request: Request, env: Env): Promise<string> {
  const pepper = requireAuthPepper(env);
  const ip = request.headers.get("CF-Connecting-IP") || "unknown";
  return sha256(`${pepper}|${ip}`);
}

export async function userAgentHash(request: Request, env: Env): Promise<string> {
  const pepper = requireAuthPepper(env);
  return sha256(`${pepper}|${request.headers.get("User-Agent") || ""}`);
}

export function securityHeaders(response: Response, requestId = ""): Response {
  const headers = new Headers(response.headers);
  if (requestId) headers.set("X-Request-ID", requestId);
  headers.set("X-Content-Type-Options", "nosniff");
  headers.set("X-Frame-Options", "DENY");
  headers.set("Referrer-Policy", "no-referrer");
  headers.set("Permissions-Policy", "camera=(), microphone=(), geolocation=(), payment=(), usb=()");
  headers.set("Cross-Origin-Opener-Policy", "same-origin");
  headers.set("Cross-Origin-Resource-Policy", "same-origin");
  headers.set("Strict-Transport-Security", "max-age=31536000");
  headers.set("X-Robots-Tag", "noindex, nofollow");
  headers.set("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'");
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

export function requireOrigin(request: Request, env: Env): void {
  const origin = request.headers.get("Origin");
  const url = new URL(request.url);
  const inferred = url.origin;
  const loopback = ["localhost", "127.0.0.1", "::1"].includes(url.hostname);
  const expected = env.APP_ORIGIN || (loopback ? inferred : "");
  if (!expected) {
    throw new AppError(503, "APP_ORIGIN is not configured for this origin. Authentication is disabled.", "origin_not_configured");
  }
  if (!origin || origin !== expected) throw new AppError(403, "Request origin is not allowed.", "origin_denied");
}

export function parseJson<T>(value: unknown, fallback: T): T {
  try { return JSON.parse(asText(value, 1_000_000)) as T; } catch { return fallback; }
}

export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const source = value as Record<string, unknown>;
  return `{${Object.keys(source).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(source[key])}`).join(",")}}`;
}

export function replySubject(subject: string): string {
  return /^\s*re:/i.test(subject) ? subject.trim() : `Re: ${subject || "(No subject)"}`;
}

export function forwardSubject(subject: string): string {
  return /^\s*fwd?:/i.test(subject) ? subject.trim() : `Fwd: ${subject || "(No subject)"}`;
}

const DELIVERY_STATUS_RANK: Record<string, number> = {
  sending: 0,
  sent: 1,
  delivery_delayed: 2,
  delivered: 3,
  opened: 4,
  clicked: 5,
  failed: 6,
  suppressed: 7,
  bounced: 8,
  complained: 9,
};
const NEGATIVE_DELIVERY_STATUSES = new Set(["bounced", "complained", "failed", "suppressed"]);

export function aggregateDeliveryStatus(summary: Record<string, string>): string {
  const values = Object.values(summary);
  if (!values.length) return "sent";
  const hasNegative = values.some((value) => NEGATIVE_DELIVERY_STATUSES.has(value));
  const hasNonNegative = values.some((value) => !NEGATIVE_DELIVERY_STATUSES.has(value));
  if (hasNegative && hasNonNegative) return "partially_failed";
  if (hasNegative) {
    if (values.includes("complained")) return "complained";
    if (values.includes("bounced")) return "bounced";
    if (values.includes("suppressed")) return "suppressed";
    return "failed";
  }
  return values.reduce((best, value) => (DELIVERY_STATUS_RANK[value] || 0) > (DELIVERY_STATUS_RANK[best] || 0) ? value : best, "sent");
}

export async function verifySvixSignature(
  raw: string,
  headers: Headers,
  secret: string,
  nowSeconds = Math.floor(Date.now() / 1000),
): Promise<boolean> {
  const id = headers.get("svix-id") || "";
  const timestamp = headers.get("svix-timestamp") || "";
  const signature = headers.get("svix-signature") || "";
  const parsedTimestamp = Number.parseInt(timestamp, 10);
  if (!id || !Number.isFinite(parsedTimestamp) || Math.abs(nowSeconds - parsedTimestamp) > 5 * 60 || !signature) return false;
  const rawSecret = secret.startsWith("whsec_") ? secret.slice(6) : secret;
  let secretBytes: Uint8Array;
  try { secretBytes = base64UrlToBytes(rawSecret); }
  catch { throw new AppError(503, "Webhook secret is invalid.", "webhook_not_configured"); }
  const expected = bytesToBase64(await hmacSha256(secretBytes, `${id}.${timestamp}.${raw}`));
  return signature.split(/\s+/).some((entry) => {
    const [version, value] = entry.split(",", 2);
    return version === "v1" && Boolean(value) && timingSafeEqual(value!, expected);
  });
}
