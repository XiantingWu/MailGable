import { AppError, type Env, encoder, normalizeEmail, now, type Row } from "./lib.js";

const CLOUDFLARE_API = "https://api.cloudflare.com/client/v4";
const ROUTING_PAGE_SIZE = 50;
const MAX_ROUTING_PAGES = 100;
const ROUTING_FETCH_TIMEOUT_MS = 10_000;

export type RoutingRule = {
  id?: unknown;
  enabled?: unknown;
  matchers?: unknown;
  actions?: unknown;
};

type RoutingMatcher = {
  type?: unknown;
  field?: unknown;
  value?: unknown;
};

type RoutingAction = {
  type?: unknown;
  value?: unknown;
};

type CloudflareRulesPage = {
  success?: unknown;
  result?: unknown;
  result_info?: {
    page?: unknown;
    total_pages?: unknown;
    total_count?: unknown;
  } | null;
};

type RoutingRuntimeEnv = Env & {
  CLOUDFLARE_ROUTING_READ_TOKEN?: string;
  CLOUDFLARE_ZONE_ID?: string;
  MAIL_WORKER_NAME?: string;
};

export type DesiredRoutingMailbox = {
  address: string;
  canReceive: boolean;
};

export type RoutingSyncResult = {
  ok: true;
  source: "cloudflare";
  synced_at: string;
  route_count: number;
  inserted: number;
  changed: number;
  deactivated: number;
};

let routingSyncInFlight: Promise<RoutingSyncResult> | null = null;

function asObject(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function runtimeConfig(env: RoutingRuntimeEnv): { token: string; zoneId: string; domain: string; workerName: string } {
  const token = String(env.CLOUDFLARE_ROUTING_READ_TOKEN || "").trim();
  const zoneId = String(env.CLOUDFLARE_ZONE_ID || "").trim().toLowerCase();
  const domain = String(env.MAIL_DOMAIN || "").trim().toLowerCase();
  const workerName = String(env.MAIL_WORKER_NAME || "").trim();

  if (!token) {
    throw new AppError(503, "Cloudflare routing synchronization is not configured.", "routing_sync_not_configured");
  }
  if (!/^[a-f0-9]{32}$/.test(zoneId)) {
    throw new AppError(503, "Cloudflare routing synchronization has an invalid zone configuration.", "routing_sync_not_configured");
  }
  if (!domain || domain.length > 253 || !/^[a-z0-9.-]+$/.test(domain) || domain.includes("..")) {
    throw new AppError(503, "Cloudflare routing synchronization has an invalid mail domain configuration.", "routing_sync_not_configured");
  }
  if (!workerName || workerName.length > 128) {
    throw new AppError(503, "Cloudflare routing synchronization has an invalid Worker configuration.", "routing_sync_not_configured");
  }
  return { token, zoneId, domain, workerName };
}

function literalDomainAddress(rule: RoutingRule, domain: string): string {
  if (rule.enabled !== true) return "";
  if (!Array.isArray(rule.matchers) || rule.matchers.length !== 1) return "";
  const matcher = asObject(rule.matchers[0]) as RoutingMatcher | null;
  if (!matcher || matcher.type !== "literal" || matcher.field !== "to") return "";
  const address = normalizeEmail(matcher.value);
  if (!address || !address.endsWith(`@${domain}`)) return "";
  const localPart = address.slice(0, -(domain.length + 1));
  if (!localPart || /\s/.test(localPart)) return "";
  return address;
}

function routesToCanonicalWorker(rule: RoutingRule, workerName: string): boolean {
  if (!Array.isArray(rule.actions) || rule.actions.length !== 1) return false;
  const action = asObject(rule.actions[0]) as RoutingAction | null;
  if (!action || action.type !== "worker" || !Array.isArray(action.value) || action.value.length !== 1) return false;
  return String(action.value[0] || "") === workerName;
}

export function deriveRoutingMailboxPlan(
  rules: RoutingRule[],
  domain: string,
  workerName: string,
): DesiredRoutingMailbox[] {
  const normalizedDomain = domain.trim().toLowerCase();
  const desired = new Map<string, DesiredRoutingMailbox>();

  for (const rule of rules) {
    const address = literalDomainAddress(rule, normalizedDomain);
    if (!address) continue;
    const existing = desired.get(address) || { address, canReceive: false };
    existing.canReceive ||= routesToCanonicalWorker(rule, workerName);
    desired.set(address, existing);
  }

  return [...desired.values()].sort((left, right) => left.address.localeCompare(right.address, "en", { sensitivity: "base" }));
}

async function fetchRulesPage(
  token: string,
  zoneId: string,
  page: number,
): Promise<CloudflareRulesPage> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), ROUTING_FETCH_TIMEOUT_MS);
  const url = new URL(`${CLOUDFLARE_API}/zones/${zoneId}/email/routing/rules`);
  url.searchParams.set("page", String(page));
  url.searchParams.set("per_page", String(ROUTING_PAGE_SIZE));
  try {
    const response = await fetch(url.toString(), {
      method: "GET",
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/json",
      },
      cache: "no-store",
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new AppError(
        response.status === 401 || response.status === 403 ? 503 : 502,
        "Cloudflare Email Routing could not be read.",
        response.status === 401 || response.status === 403 ? "routing_sync_permission_denied" : "routing_sync_upstream_failed",
      );
    }
    let payload: CloudflareRulesPage;
    try {
      payload = await response.json() as CloudflareRulesPage;
    } catch {
      throw new AppError(502, "Cloudflare Email Routing returned an invalid response.", "routing_sync_upstream_invalid");
    }
    if (payload.success !== true || !Array.isArray(payload.result)) {
      throw new AppError(502, "Cloudflare Email Routing returned an incomplete response.", "routing_sync_upstream_invalid");
    }
    return payload;
  } catch (error) {
    if (error instanceof AppError) throw error;
    if (error instanceof DOMException && error.name === "AbortError") {
      throw new AppError(504, "Cloudflare Email Routing synchronization timed out.", "routing_sync_timeout");
    }
    throw new AppError(502, "Cloudflare Email Routing is temporarily unavailable.", "routing_sync_upstream_failed");
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchAllRoutingRules(token: string, zoneId: string): Promise<RoutingRule[]> {
  const rules: RoutingRule[] = [];
  const seenIds = new Set<string>();
  let expectedPages: number | null = null;
  let expectedTotal: number | null = null;

  for (let page = 1; page <= (expectedPages || 1); page += 1) {
    const payload = await fetchRulesPage(token, zoneId, page);
    const info = payload.result_info || {};
    const totalPages = Number(info.total_pages ?? 1);
    const reportedPage = Number(info.page ?? page);
    const totalCount = info.total_count == null ? null : Number(info.total_count);

    if (!Number.isInteger(totalPages) || totalPages < 1 || totalPages > MAX_ROUTING_PAGES || reportedPage !== page) {
      throw new AppError(502, "Cloudflare Email Routing pagination is inconsistent.", "routing_sync_upstream_invalid");
    }
    if (expectedPages == null) expectedPages = totalPages;
    else if (totalPages !== expectedPages) {
      throw new AppError(503, "Cloudflare Email Routing changed while synchronization was running. Retry the sync.", "routing_sync_snapshot_changed");
    }
    if (totalCount != null) {
      if (!Number.isInteger(totalCount) || totalCount < 0) {
        throw new AppError(502, "Cloudflare Email Routing pagination is inconsistent.", "routing_sync_upstream_invalid");
      }
      if (expectedTotal == null) expectedTotal = totalCount;
      else if (totalCount !== expectedTotal) {
        throw new AppError(503, "Cloudflare Email Routing changed while synchronization was running. Retry the sync.", "routing_sync_snapshot_changed");
      }
    }

    for (const value of payload.result as unknown[]) {
      const object = asObject(value);
      if (!object) {
        throw new AppError(502, "Cloudflare Email Routing returned an invalid rule.", "routing_sync_upstream_invalid");
      }
      const id = typeof object.id === "string" ? object.id : "";
      if (id) {
        if (seenIds.has(id)) {
          throw new AppError(503, "Cloudflare Email Routing changed while synchronization was running. Retry the sync.", "routing_sync_snapshot_changed");
        }
        seenIds.add(id);
      }
      rules.push(object as RoutingRule);
    }
  }

  if (expectedTotal != null && rules.length !== expectedTotal) {
    throw new AppError(503, "Cloudflare Email Routing changed while synchronization was running. Retry the sync.", "routing_sync_snapshot_changed");
  }
  return rules;
}

async function stableMailboxId(address: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(address.toLowerCase())));
  const hex = [...digest].map((value) => value.toString(16).padStart(2, "0")).join("");
  return `route_${hex.slice(0, 24)}`;
}

function displayName(address: string): string {
  const localPart = address.split("@")[0] || "";
  const words = localPart.replace(/[._+\-]+/g, " ").trim().split(/\s+/).filter(Boolean);
  if (!words.length) return "Mailbox";
  const title = words.map((word) => `${word.slice(0, 1).toUpperCase()}${word.slice(1).toLowerCase()}`).join(" ");
  return `${title} Mailbox`;
}


function bool(value: unknown): boolean {
  return Number(value || 0) === 1;
}

async function applyRoutingPlan(env: Env, plan: DesiredRoutingMailbox[]): Promise<Pick<RoutingSyncResult, "inserted" | "changed" | "deactivated">> {
  const current = await env.DB.prepare(
    "SELECT mailbox_id,address,can_receive,can_send,active,COALESCE(routing_managed,0) AS routing_managed FROM mailboxes ORDER BY address",
  ).all<Row>();
  const rows = current.results || [];
  const byAddress = new Map<string, Row>();
  for (const row of rows) {
    const address = normalizeEmail(row.address);
    if (address) byAddress.set(address, row);
  }

  const desiredSet = new Set(plan.map((item) => item.address));
  const timestamp = now();
  const statements: D1PreparedStatement[] = [];
  let inserted = 0;
  let changed = 0;
  let deactivated = 0;

  for (const item of plan) {
    const existing = byAddress.get(item.address);
    const canReceive = item.canReceive ? 1 : 0;
    if (existing) {
      if (
        bool(existing.can_receive) !== item.canReceive
        || !bool(existing.can_send)
        || !bool(existing.active)
        || !bool(existing.routing_managed)
      ) changed += 1;
      statements.push(env.DB.prepare(
        "UPDATE mailboxes SET can_receive=?,can_send=1,active=1,routing_managed=1,updated_at=? WHERE mailbox_id=?",
      ).bind(canReceive, timestamp, String(existing.mailbox_id)));
    } else {
      statements.push(env.DB.prepare(
        "INSERT INTO mailboxes(mailbox_id,address,display_name,can_receive,can_send,active,routing_managed,created_at,updated_at) VALUES(?,?,?,?,1,1,1,?,?)",
      ).bind(await stableMailboxId(item.address), item.address, displayName(item.address), canReceive, timestamp, timestamp));
      inserted += 1;
    }
  }

  for (const row of rows) {
    const address = normalizeEmail(row.address);
    if (bool(row.routing_managed) && address && !desiredSet.has(address)) {
      statements.push(env.DB.prepare(
        "UPDATE mailboxes SET can_receive=0,can_send=0,active=0,updated_at=? WHERE mailbox_id=? AND routing_managed=1",
      ).bind(timestamp, String(row.mailbox_id)));
      deactivated += 1;
    }
  }

  try {
    if (statements.length) await env.DB.batch(statements);
  } catch {
    throw new AppError(503, "Routing mailbox synchronization could not be committed.", "routing_sync_database_failed");
  }

  const verified = await env.DB.prepare(
    "SELECT address,can_receive,can_send FROM mailboxes WHERE active=1 AND routing_managed=1 ORDER BY address",
  ).all<Row>();
  const actual = (verified.results || []).map((row) => ({
    address: normalizeEmail(row.address),
    canReceive: bool(row.can_receive),
    canSend: bool(row.can_send),
  }));
  if (
    actual.length !== plan.length
    || actual.some((row, index) => (
      row.address !== plan[index]?.address
      || row.canReceive !== plan[index]?.canReceive
      || !row.canSend
    ))
  ) {
    throw new AppError(503, "Routing mailbox synchronization did not pass its consistency check.", "routing_sync_verify_failed");
  }

  return { inserted, changed, deactivated };
}

async function performRoutingSync(env: RoutingRuntimeEnv): Promise<RoutingSyncResult> {
  const config = runtimeConfig(env);
  const rules = await fetchAllRoutingRules(config.token, config.zoneId);
  const plan = deriveRoutingMailboxPlan(rules, config.domain, config.workerName);
  const changes = await applyRoutingPlan(env, plan);
  return {
    ok: true,
    source: "cloudflare",
    synced_at: now(),
    route_count: plan.length,
    ...changes,
  };
}

export async function syncRoutingMailboxes(env: Env): Promise<RoutingSyncResult> {
  if (routingSyncInFlight) return routingSyncInFlight;
  const task = performRoutingSync(env as RoutingRuntimeEnv);
  routingSyncInFlight = task;
  try {
    return await task;
  } finally {
    if (routingSyncInFlight === task) routingSyncInFlight = null;
  }
}
