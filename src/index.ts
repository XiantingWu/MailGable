import {
  audit,
  authStatus,
  bootstrap,
  changePassword,
  cleanupAuth,
  login,
  logout,
  logoutAll,
  requireSession,
} from "./auth.js";
import {
  attachmentResponse,
  cleanupMail,
  configStatus,
  forwardMessage,
  getThread,
  handleInbound,
  handleResendWebhook,
  listMailboxes,
  listThreads,
  markThread,
  publicHealth,
  rawMessageResponse,
  retryMessage,
  routingStatus,
  sendMessage,
  storageProbe,
} from "./mail.js";
import { AppError, createRequestId, Env, errorResponse, json, securityHeaders } from "./lib.js";
import { syncRoutingMailboxes } from "./routing-sync.js";
import { deleteThreadData, setThreadStatus } from "./mail/index.js";
import { handleBrevoWebhook, handleCloudflareQueueEvent } from "./mail/delivery-events.js";

const APP_PATH = "/admin/mail";
const API_PATH = "/api/admin/mail";
const ALLOWED_ASSETS = new Set([
  "/index.html",
  "/mail.css",
  "/mail-ready.css",
  "/routing-status.css",
  "/404.html",
  "/js/app.mjs",
  "/js/state.mjs",
  "/js/i18n.mjs",
  "/js/auth.mjs",
  "/js/mailbox.mjs",
  "/js/messages.mjs",
  "/js/compose.mjs",
  "/js/routing.mjs",
]);

function pathMatch(pathname: string, pattern: RegExp): RegExpMatchArray | null {
  return pathname.match(pattern);
}

function isPathOrChild(pathname: string, base: string): boolean {
  return pathname === base || pathname.startsWith(`${base}/`);
}

function internalApiPath(pathname: string): string {
  if (!isPathOrChild(pathname, API_PATH)) return pathname;
  return `/api${pathname.slice(API_PATH.length)}`;
}

function decodePath(value: string): string {
  try { return decodeURIComponent(value); }
  catch { throw new AppError(400, "Path contains invalid encoding.", "invalid_path"); }
}

async function handleApi(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const pathname = internalApiPath(url.pathname);
  const method = request.method.toUpperCase();

  if (method === "GET" && pathname === "/api/auth/status") return authStatus(request, env);
  if (method === "POST" && pathname === "/api/auth/bootstrap") return bootstrap(request, env);
  if (method === "POST" && pathname === "/api/auth/login") return login(request, env);

  if (method === "POST" && pathname === "/api/auth/logout") {
    await requireSession(request, env, true);
    return logout(request, env);
  }
  if (method === "POST" && pathname === "/api/auth/logout-all") {
    const session = await requireSession(request, env, true);
    return logoutAll(request, env, session);
  }
  if (method === "POST" && pathname === "/api/auth/password") {
    const session = await requireSession(request, env, true);
    return changePassword(request, env, session);
  }
  if (method === "GET" && pathname === "/api/config") {
    await requireSession(request, env);
    return configStatus(env);
  }
  if (method === "GET" && pathname === "/api/routing-status") {
    await requireSession(request, env);
    return routingStatus(env);
  }
  if (method === "POST" && pathname === "/api/routing-sync") {
    const session = await requireSession(request, env, true);
    const result = await syncRoutingMailboxes(env);
    await audit(request, env, session, "routing_sync", "mailboxes", String(env.MAIL_DOMAIN || ""), {
      source: result.source,
      route_count: result.route_count,
      inserted: result.inserted,
      changed: result.changed,
      deactivated: result.deactivated,
    });
    return json(result);
  }
  if (method === "POST" && pathname === "/api/ops/storage-probe") {
    await requireSession(request, env, true);
    return storageProbe(env);
  }
  if (method === "GET" && pathname === "/api/mailboxes") {
    await requireSession(request, env);
    return listMailboxes(env);
  }
  if (method === "GET" && pathname === "/api/threads") {
    await requireSession(request, env);
    return listThreads(request, env);
  }
  const threadDetail = pathMatch(pathname, /^\/api\/threads\/([^/]+)$/);
  if (method === "GET" && threadDetail) {
    await requireSession(request, env);
    return getThread(request, env, decodePath(threadDetail[1]!));
  }
  const threadRead = pathMatch(pathname, /^\/api\/threads\/([^/]+)\/read$/);
  if (method === "POST" && threadRead) {
    const session = await requireSession(request, env, true);
    return markThread(request, env, session, decodePath(threadRead[1]!));
  }
  const threadStatus = pathMatch(pathname, /^\/api\/threads\/([^/]+)\/(archive|unarchive|spam|trash|restore)$/);
  if (method === "POST" && threadStatus) {
    const session = await requireSession(request, env, true);
    const action = threadStatus[2]!;
    const statusMap: Record<string, "open" | "archived" | "spam" | "trash"> = {
      archive: "archived",
      unarchive: "open",
      spam: "spam",
      trash: "trash",
      restore: "open",
    };
    const threadId = decodePath(threadStatus[1]!);
    const updated = await setThreadStatus(env, threadId, statusMap[action]!);
    await audit(request, env, session, `thread_${action}`, "thread", threadId);
    return json({ ok: true, thread_id: threadId, status: updated.status });
  }
  const threadDelete = pathMatch(pathname, /^\/api\/threads\/([^/]+)$/);
  if (method === "DELETE" && threadDelete) {
    const session = await requireSession(request, env, true);
    const threadId = decodePath(threadDelete[1]!);
    const result = await deleteThreadData(env, threadId);
    await audit(request, env, session, "thread_delete", "thread", threadId, {
      deleted_r2_keys: result.deleted_keys,
    });
    return json({ ok: true, thread_id: threadId, deleted_r2_keys: result.deleted_keys });
  }
  if (method === "POST" && pathname === "/api/messages/send") {
    const session = await requireSession(request, env, true);
    return sendMessage(request, env, session);
  }
  const retry = pathMatch(pathname, /^\/api\/messages\/([^/]+)\/retry$/);
  if (method === "POST" && retry) {
    const session = await requireSession(request, env, true);
    return retryMessage(request, env, session, decodePath(retry[1]!));
  }
  const forward = pathMatch(pathname, /^\/api\/messages\/([^/]+)\/forward$/);
  if (method === "POST" && forward) {
    const session = await requireSession(request, env, true);
    return forwardMessage(request, env, session, decodePath(forward[1]!));
  }
  const attachment = pathMatch(pathname, /^\/api\/attachments\/([^/]+)$/);
  if (method === "GET" && attachment) {
    await requireSession(request, env);
    return attachmentResponse(env, decodePath(attachment[1]!));
  }
  const raw = pathMatch(pathname, /^\/api\/messages\/([^/]+)\/raw$/);
  if (method === "GET" && raw) {
    await requireSession(request, env);
    return rawMessageResponse(env, decodePath(raw[1]!));
  }

  throw new AppError(404, "API route not found.", "not_found");
}

async function assetResponse(request: Request, env: Env, pathname: string): Promise<Response> {
  if (request.method !== "GET" && request.method !== "HEAD") {
    return json({ error: "Method not allowed." }, 405, { Allow: "GET, HEAD" });
  }
  const suffix = pathname.slice(APP_PATH.length);
  const assetPath = suffix === "/" || suffix === "" ? "/index.html" : suffix;
  if (!ALLOWED_ASSETS.has(assetPath)) throw new AppError(404, "Page not found.", "not_found");
  const assetUrl = new URL("https://assets.invalid");
  assetUrl.pathname = assetPath;
  const asset = await env.ASSETS.fetch(new Request(assetUrl.toString(), { method: request.method }));
  const headers = new Headers(asset.headers);
  headers.set("Cache-Control", "private, no-store, max-age=0");
  headers.set("Pragma", "no-cache");
  headers.set("Expires", "0");
  return new Response(asset.body, { status: asset.status, statusText: asset.statusText, headers });
}

export function classifyD1QuotaError(error: unknown): AppError | null {
  if (error instanceof AppError) return null;
  const message = error instanceof Error ? error.message : String(error);
  if (/D1_QUOTA_EXCEEDED|rows written.*limit|database.*quota/i.test(message)) {
    return new AppError(503, "Database quota reached. Check Cloudflare D1 usage and query plans.", "database_quota_exceeded");
  }
  return null;
}

async function fetchHandler(request: Request, env: Env): Promise<Response> {
  const requestId = createRequestId(request);
  const working = new Request(request);
  working.headers.set("X-MailGable-Request-ID", requestId);
  try {
    const url = new URL(working.url);
    if (url.pathname === "/healthz" && working.method === "GET") {
      return securityHeaders(await publicHealth(), requestId);
    }
    if (url.pathname === "/webhooks/resend" && working.method === "POST") {
      return securityHeaders(await handleResendWebhook(working, env), requestId);
    }
    if (url.pathname === "/webhooks/brevo" && working.method === "POST") {
      return securityHeaders(await handleBrevoWebhook(working, env), requestId);
    }
    if (isPathOrChild(url.pathname, API_PATH)) return securityHeaders(await handleApi(working, env), requestId);
    if (url.pathname === APP_PATH) {
      const target = new URL(working.url);
      target.pathname = `${APP_PATH}/`;
      return securityHeaders(Response.redirect(target.toString(), 308), requestId);
    }
    if (url.pathname.startsWith(`${APP_PATH}/`)) {
      return securityHeaders(await assetResponse(working, env, url.pathname), requestId);
    }
    throw new AppError(404, "Page not found.", "not_found");
  } catch (error) {
    return securityHeaders(errorResponse(classifyD1QuotaError(error) || error, env, requestId), requestId);
  }
}

export default {
  fetch: fetchHandler,
  email: handleInbound,
  async queue(batch: MessageBatch<unknown>, env: Env, ctx: ExecutionContext): Promise<void> {
    await handleCloudflareQueueEvent({ messages: batch.messages as unknown as Array<{ body: unknown }> }, env);
  },
  async scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(Promise.all([cleanupAuth(env), cleanupMail(env)]).then(() => undefined));
  },
} satisfies ExportedHandler<Env>;
