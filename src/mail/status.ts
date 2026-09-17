import {
  asText,
  json,
  type Env,
  type Row,
} from "../lib.js";
import { MAX_OUTGOING_ATTACHMENT_BYTES, MAX_OUTGOING_TOTAL_ATTACHMENT_BYTES, MAX_THREAD_PAGE } from "./constants.js";
import { inboundForwardAddresses } from "../inbound-forwarding.js";
import { getOutboundProvider } from "../providers/registry.js";

export async function routingStatus(env: Env): Promise<Response> {
  const [result, latest, forwardFailures] = await Promise.all([
    env.DB.prepare(
      `SELECT mailbox_id,address,display_name,can_receive,can_send,active,updated_at
         FROM mailboxes
        WHERE routing_managed=1 AND active=1
        ORDER BY address`,
    ).all<Row>(),
    env.DB.prepare(
      "SELECT MAX(datetime(updated_at)) AS finished_at FROM mailboxes WHERE routing_managed=1 AND active=1",
    ).first<Row>(),
    env.DB.prepare(
      "SELECT COUNT(*) AS count FROM inbound_forward_attempts WHERE status='failed'",
    ).first<Row>(),
  ]);
  const routes: Array<Row & { route_status: string }> = (result.results || []).map((row) => {
    const canReceive = Number(row.can_receive || 0) === 1;
    const canSend = Number(row.can_send || 0) === 1;
    const status = canReceive && canSend ? "active" : canSend ? "send_only" : canReceive ? "receive_only" : "inactive";
    return { ...row, route_status: status };
  });
  const everyManagedRouteReady = routes.length > 0 && routes.every((route) => (
    Number(route.can_receive || 0) === 1 && Number(route.can_send || 0) === 1
  ));
  let forwardingReady = true;
  try { inboundForwardAddresses(env); }
  catch { forwardingReady = false; }
  const unresolvedForwardFailures = Number(forwardFailures?.count || 0);
  const finishedAt = asText(latest?.finished_at, 100);
  const ready = everyManagedRouteReady;
  return json({
    sync: finishedAt ? { status: ready ? "success" : "attention", finished_at: finishedAt } : null,
    forwarding: {
      configured: forwardingReady,
      failed_attempts: unresolvedForwardFailures,
    },
    routes,
  });
}

export async function publicHealth(): Promise<Response> {
  return json({ ok: true });
}

export async function configStatus(env: Env): Promise<Response> {
  let forwardingConfigured = true;
  let forwardingAddressCount = 0;
  try {
    forwardingAddressCount = inboundForwardAddresses(env).length;
  } catch {
    forwardingConfigured = false;
  }
  const [mailboxCount, adminCount] = await Promise.all([
    env.DB.prepare("SELECT COUNT(*) AS count FROM mailboxes WHERE active=1").first<Row>(),
    env.DB.prepare("SELECT COUNT(*) AS count FROM admins WHERE disabled=0").first<Row>(),
  ]);
  const provider = getOutboundProvider(env);
  const providerId = (env.OUTBOUND_PROVIDER || "none").toLowerCase();
  const outbound = provider
    ? {
        provider: provider.id,
        configured: true,
        delivery_events: provider.capabilities.deliveryEvents,
        safe_retry_window_minutes: provider.capabilities.safeRetryWindowMs === null ? null : Math.round(provider.capabilities.safeRetryWindowMs / 60_000),
      }
    : { provider: providerId, configured: false, delivery_events: "none", safe_retry_window_minutes: null };
  return json({
    ok: true,
    deployment: "mailgable",
    database: true,
    archive: Boolean(env.MAIL_R2),
    outbound,
    forwarding: forwardingConfigured ? { configured: true, addresses: forwardingAddressCount } : { configured: false },
    auth: Boolean(env.AUTH_PEPPER && Number(adminCount?.count || 0) > 0),
    mailboxes: Number(mailboxCount?.count || 0),
    limits: {
      outgoing_attachment_each_mb: MAX_OUTGOING_ATTACHMENT_BYTES / 1024 / 1024,
      outgoing_attachment_total_mb: MAX_OUTGOING_TOTAL_ATTACHMENT_BYTES / 1024 / 1024,
      thread_page: MAX_THREAD_PAGE,
    },
  });
}