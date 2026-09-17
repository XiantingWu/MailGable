import type { Address, Attachment, Email } from "postal-mime";
import {
  AppError,
  asText,
  base64ToBytes,
  bytesToBase64,
  encoder,
  normalizeEmail,
  truncateUtf8,
  validEmail,
} from "../lib.js";
import { MAX_HEADER_ADDRESSES, MAX_INCOMING_ATTACHMENT_BYTES } from "./constants.js";
import type { ParsedAddress } from "./types.js";

export function addressArray(value: Address | Address[] | undefined): ParsedAddress[] {
  const list = Array.isArray(value) ? value : value ? [value] : [];
  const result: ParsedAddress[] = [];
  for (const item of list) {
    if (result.length >= MAX_HEADER_ADDRESSES) break;
    if ("group" in item && Array.isArray(item.group)) {
      result.push(...addressArray(item.group).slice(0, MAX_HEADER_ADDRESSES - result.length));
    } else if ("address" in item && validEmail(String(item.address || ""))) {
      result.push({ name: asText(item.name, 200), address: normalizeEmail(item.address) });
    }
  }
  return result.slice(0, MAX_HEADER_ADDRESSES);
}

export function safeHeaderValue(value: unknown, max: number): string {
  return asText(value, max).replace(/[\r\n]+/g, " ").trim();
}

export function safeMimeType(value: unknown): string {
  const type = safeHeaderValue(value, 200).toLowerCase();
  return /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/.test(type) ? type : "application/octet-stream";
}

export function normalizeInternetMessageId(value: unknown): string {
  const raw = safeHeaderValue(value, 998);
  const bracketed = raw.match(/<[^<>\s]+>/)?.[0];
  if (bracketed) return bracketed;
  return /^[^<>\s@]+@[^<>\s@]+$/.test(raw) ? `<${raw}>` : "";
}

export function header(mail: Email, name: string): string {
  return asText(mail.headers.find((item) => item.key.toLowerCase() === name.toLowerCase())?.value, 8_000).trim();
}

export function references(value: string): string[] {
  return [...value.matchAll(/<[^<>\s]+>/g)].map((match) => match[0]).slice(-30);
}

export function messageTime(row: import("../lib.js").Row): string {
  return String(row.received_at || row.sent_at || row.created_at || new Date().toISOString());
}

export function attachmentBytes(item: Attachment): Uint8Array {
  if (item.content instanceof Uint8Array) return item.content;
  if (item.content instanceof ArrayBuffer) return new Uint8Array(item.content);
  const value = asText(item.content, MAX_INCOMING_ATTACHMENT_BYTES * 2);
  if (item.encoding === "base64") {
    try { return base64ToBytes(value); } catch { return new Uint8Array(); }
  }
  return encoder.encode(value);
}

export function previewBody(value: string, maxBytes: number): { value: string; truncated: boolean } {
  const limited = truncateUtf8(value, maxBytes);
  return { value: limited, truncated: limited.length !== value.length };
}

export function htmlToText(html: string): string {
  return html
    .replace(/<\s*br\s*\/?>/gi, "\n")
    .replace(/<\s*\/\s*(p|div|li|h[1-6]|blockquote)\s*>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, "\"")
    .replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function mimeHeader(value: string): string {
  return /^[\x20-\x7E]*$/.test(value) ? value : `=?UTF-8?B?${bytesToBase64(encoder.encode(value))}?=`;
}

export function wrapBase64(value: string): string {
  return value.match(/.{1,76}/g)?.join("\r\n") || "";
}

export function recipientTokens(value: unknown): string[] {
  const pending = Array.isArray(value) ? [...value] : [value];
  const tokens: string[] = [];
  while (pending.length) {
    const item = pending.shift();
    if (Array.isArray(item)) {
      pending.unshift(...item);
      continue;
    }
    if (item === undefined || item === null || item === "") continue;
    if (typeof item !== "string") throw new AppError(400, "Recipient fields must contain email addresses.", "invalid_recipient");
    if (item.length > 30_000) throw new AppError(400, "Recipient input is too long.", "too_many_recipients");
    tokens.push(...item.split(/[;,\n]+/).map((entry) => entry.trim()).filter(Boolean));
    if (tokens.length > 51) break;
  }
  return tokens;
}

export function strictRecipientList(value: unknown, label = "Recipient"): string[] {
  const tokens = recipientTokens(value);
  if (tokens.length > 50) throw new AppError(400, "A message can have at most 50 recipients.", "too_many_recipients");
  const invalid = tokens.filter((entry) => !validEmail(normalizeEmail(entry)));
  if (invalid.length) {
    const preview = invalid.slice(0, 3).join(", ");
    throw new AppError(400, `${label} contains an invalid email address: ${preview}`, "invalid_recipient");
  }
  return [...new Set(tokens.map(normalizeEmail))];
}

export function boundedBody(value: unknown, maxBytes: number, label: string): string {
  if (value === undefined || value === null || value === "") return "";
  if (typeof value !== "string") throw new AppError(400, `${label} must be text.`, "invalid_body");
  if (encoder.encode(value).byteLength > maxBytes) {
    throw new AppError(413, `${label} is too large and was not truncated.`, "message_body_too_large");
  }
  return value;
}

export function dateFilter(value: string, end = false): string | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  return end ? `${value}T23:59:59.999Z` : `${value}T00:00:00.000Z`;
}