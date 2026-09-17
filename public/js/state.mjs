export const $ = (id) => document.getElementById(id);
export const API_BASE = "/api/admin/mail";

export function resolveTheme(stored) {
  return stored === "dark" ? "dark" : "light";
}

export const state = {
  csrf: "",
  email: "",
  initialized: false,
  mailboxes: [],
  threads: [],
  selectedThread: "",
  selectedDetail: null,
  detailRequest: 0,
  folder: "inbox",
  mailbox: "",
  cursor: "",
  hasMore: false,
  loading: false,
  composeMode: "compose",
  composeParent: null,
  composeKey: "",
  composeAttemptedPayload: "",
  keyboardIndex: -1,
  outboundConfigured: false,
  outboundProvider: "none",
  theme: resolveTheme(localStorage.getItem("mailbox_theme")),
};

export function applyTheme() {
  document.documentElement.dataset.theme = state.theme;
  const toggle = document.getElementById("theme-toggle");
  if (toggle) toggle.textContent = state.theme === "dark" ? "🌙" : "☀️";
}

export function toggleTheme() {
  state.theme = state.theme === "dark" ? "light" : "dark";
  localStorage.setItem("mailbox_theme", state.theme);
  applyTheme();
}

export class ApiError extends Error {
  constructor(message, status, code) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export async function api(path, options = {}) {
  const target = path.startsWith("/api/") ? `${API_BASE}${path.slice(4)}` : path;
  const headers = new Headers(options.headers || {});
  if (options.body && !headers.has("Content-Type")) headers.set("Content-Type", "application/json");
  if (state.csrf && options.method && options.method.toUpperCase() !== "GET") headers.set("X-CSRF-Token", state.csrf);
  const response = await fetch(target, { credentials: "same-origin", ...options, headers });
  const contentType = response.headers.get("Content-Type") || "";
  if (!response.ok) {
    const data = contentType.includes("json") ? await response.json().catch(() => ({})) : {};
    if (response.status === 401 && !target.includes("/auth/")) await start();
    throw new ApiError(data.error || `${t("requestFailed")} (${response.status})`, response.status, data.code || "request_failed");
  }
  return contentType.includes("json") ? response.json() : response;
}

export function toast(message) {
  const node = document.createElement("div");
  node.className = "toast";
  node.textContent = stripBidi(message);
  $("toast-region").append(node);
  setTimeout(() => node.remove(), 3600);
}

export function showError(id, error) {
  const node = $(id);
  node.textContent = error instanceof Error ? error.message : String(error);
  node.hidden = false;
}

export function clearError(id) {
  $(id).hidden = true;
  $(id).textContent = "";
}

export function formatDate(value) {
  if (!value) return "";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "" : new Intl.DateTimeFormat("en-US", {
    month: "short", day: "numeric", hour: "2-digit", minute: "2-digit",
  }).format(date);
}

export function parseAddresses(value) {
  try {
    const data = JSON.parse(value || "[]");
    return Array.isArray(data) ? data : [];
  } catch {
    return [];
  }
}

export function addressLabel(value, fallback = "") {
  const first = parseAddresses(value)[0];
  return first ? (first.name ? `${first.name} <${first.address}>` : first.address) : fallback;
}

export function stripBidi(value) {
  return String(value ?? "").replace(/[\u202A-\u202E\u2066-\u2069]/g, "");
}

export function escape(value) {
  const node = document.createElement("div");
  node.textContent = stripBidi(value);
  return node.innerHTML;
}

export function formatBytes(value) {
  const number = Number(value || 0);
  if (number < 1024) return `${number} B`;
  if (number < 1024 * 1024) return `${(number / 1024).toFixed(1)} KB`;
  return `${(number / 1024 / 1024).toFixed(1)} MB`;
}

export function parseObject(value) {
  try {
    const data = JSON.parse(value || "{}");
    return data && typeof data === "object" && !Array.isArray(data) ? data : {};
  } catch {
    return {};
  }
}

export function uniqueRows(rows, key) {
  return [...new Map(rows.map((row) => [row[key], row])).values()];
}

export async function download(path, filename) {
  try {
    const response = await api(path);
    const blob = await response.blob();
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = filename || "download";
    anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  } catch (error) {
    toast(error.message);
  }
}
export function renderSendAvailability() {
  const senders = state.mailboxes.filter((item) => Number(item.can_send) === 1 && Number(item.active) === 1);
  const button = document.getElementById("compose-button");
  if (!button) return;
  if (!senders.length || !state.outboundConfigured) {
    button.disabled = true;
    button.title = "Outbound sending is not configured (receive-only mode)";
    return;
  }
  button.disabled = false;
  button.title = "";
}
