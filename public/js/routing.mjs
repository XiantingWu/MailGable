const endpoint = "/api/admin/mail/routing-status";
let current = null;
let inFlight = null;

function element(id) {
  return document.getElementById(id);
}

function copy() {
  return {
    title: "Routing status",
    loading: "Loading…",
    notSynced: "Not synchronized",
    noRoutes: "No synchronized mailbox routes",
    failed: "Routing status unavailable",
    synced: "Synced",
    syncAttention: "Sync needs attention",
    syncing: "Syncing Cloudflare…",
    syncFailed: "Sync failed · last state preserved",
    syncAction: "Sync Cloudflare mailbox routes now",
    mailboxRoutes: "Mailbox routes",
    mailboxUnit: "mailboxes",
    active: "Receive and send",
    send_only: "Send only",
    receive_only: "Receive only",
    inactive: "Inactive",
    unknown: "Unknown",
    backupSection: "External backup",
    backup: "External forwarding",
    backupHealthy: "Worker requests healthy · verify final delivery in Cloudflare",
    backupAttention: "failed request(s) · investigate",
    backupUnconfigured: "Not configured",
  };
}

function formatDate(value) {
  if (!value) return "";
  const raw = String(value).trim();
  const normalized = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(raw)
    ? `${raw.replace(" ", "T")}Z`
    : raw;
  const date = new Date(normalized);
  if (Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(date);
}

function setTone(status) {
  const sync = element("sync-status");
  const dot = element("routing-status-dot");
  if (sync) sync.dataset.state = status || "unknown";
  if (dot) dot.dataset.state = status || "unknown";
}

function setActionLabels() {
  const labels = copy();
  for (const id of ["sync-status", "routing-sync-button"]) {
    const node = element(id);
    if (!node) continue;
    node.setAttribute("aria-label", labels.syncAction);
    node.title = labels.syncAction;
  }
}

function sectionLabel(text, count = null, countLabel = "") {
  const row = document.createElement("div");
  row.className = "routing-section-label";

  const label = document.createElement("span");
  label.textContent = text;
  row.append(label);

  if (Number.isInteger(count)) {
    const badge = document.createElement("span");
    badge.className = "routing-section-count";
    badge.textContent = String(count);
    if (countLabel) badge.setAttribute("aria-label", countLabel);
    row.append(badge);
  }
  return row;
}

function mailboxRow(route, labels) {
  const state = String(route.route_status || "unknown");
  const addressValue = String(route.address || "").trim();
  if (!addressValue) return null;

  const row = document.createElement("div");
  row.className = "routing-route";
  row.dataset.state = state;
  row.setAttribute("role", "listitem");
  row.setAttribute("aria-label", `${addressValue}: ${labels[state] || labels.unknown}`);

  const main = document.createElement("div");
  main.className = "routing-route-main";

  const dot = document.createElement("span");
  dot.className = "routing-route-dot";
  dot.dataset.state = state;
  dot.setAttribute("aria-hidden", "true");

  const address = document.createElement("span");
  address.className = "routing-address";
  address.textContent = addressValue;
  address.title = addressValue;

  const status = document.createElement("span");
  status.className = "routing-route-status";
  status.textContent = labels[state] || labels.unknown;

  main.append(dot, address);
  row.append(main, status);
  return row;
}

function forwardingRow(data, labels) {
  const forwarding = data?.forwarding;
  if (!forwarding) return null;
  const configured = forwarding.configured === true;
  const failures = Number(forwarding.failed_attempts || 0);
  const state = !configured ? "inactive" : failures > 0 ? "attention" : "active";

  const row = document.createElement("div");
  row.className = "routing-route routing-backup-route";
  row.dataset.state = state;
  row.setAttribute("role", "listitem");

  const main = document.createElement("div");
  main.className = "routing-route-main";

  const dot = document.createElement("span");
  dot.className = "routing-route-dot";
  dot.dataset.state = state;
  dot.setAttribute("aria-hidden", "true");

  const address = document.createElement("span");
  address.className = "routing-address";
  address.textContent = labels.backup;
  address.title = labels.backup;

  const status = document.createElement("span");
  status.className = "routing-route-status";
  if (!configured) status.textContent = labels.backupUnconfigured;
  else if (failures > 0) status.textContent = `${failures} ${labels.backupAttention}`;
  else status.textContent = labels.backupHealthy;

  row.setAttribute("aria-label", `${labels.backup}: ${status.textContent}`);
  main.append(dot, address);
  row.append(main, status);
  return row;
}

function normalizedRoutes(data) {
  return (Array.isArray(data?.routes) ? data.routes : [])
    .filter((route) => String(route?.address || "").trim())
    .slice()
    .sort((left, right) => String(left.address).localeCompare(String(right.address), undefined, { sensitivity: "base" }));
}

function render(data) {
  current = data;
  const labels = copy();
  const title = element("routing-status-title");
  const sync = element("sync-status");
  const container = element("system-status");
  if (title) title.textContent = labels.title;
  setActionLabels();
  if (!sync || !container) return;

  const syncData = data?.sync || null;
  const syncTime = formatDate(syncData?.finished_at || syncData?.started_at);
  const syncState = String(syncData?.status || "unknown");
  sync.textContent = syncData
    ? `${syncState === "success" ? labels.synced : labels.syncAttention}${syncTime ? ` · ${syncTime}` : ""}`
    : labels.notSynced;
  setTone(syncState);

  const routes = normalizedRoutes(data);
  const backup = forwardingRow(data, labels);
  container.replaceChildren();

  const fragment = document.createDocumentFragment();
  fragment.append(sectionLabel(labels.mailboxRoutes, routes.length, `${routes.length} ${labels.mailboxUnit}`));

  const routeList = document.createElement("div");
  routeList.className = "routing-mailbox-list";
  routeList.setAttribute("role", "list");
  routeList.setAttribute("aria-label", labels.mailboxRoutes);

  if (!routes.length) {
    const empty = document.createElement("p");
    empty.className = "routing-empty";
    empty.textContent = labels.noRoutes;
    routeList.append(empty);
  } else {
    for (const route of routes) {
      const row = mailboxRow(route, labels);
      if (row) routeList.append(row);
    }
  }
  fragment.append(routeList);

  if (backup) {
    fragment.append(sectionLabel(labels.backupSection));
    const backupList = document.createElement("div");
    backupList.className = "routing-backup-list";
    backupList.setAttribute("role", "list");
    backupList.setAttribute("aria-label", labels.backupSection);
    backupList.append(backup);
    fragment.append(backupList);
  }

  container.append(fragment);
}

function setSyncing() {
  const labels = copy();
  const sync = element("sync-status");
  if (sync) sync.textContent = labels.syncing;
  setActionLabels();
  setTone("syncing");
}

function setSyncFailure() {
  const labels = copy();
  const sync = element("sync-status");
  if (sync) sync.textContent = labels.syncFailed;
  setActionLabels();
  setTone("failed");
}

function renderFailure() {
  const labels = copy();
  const title = element("routing-status-title");
  const sync = element("sync-status");
  const container = element("system-status");
  if (title) title.textContent = labels.title;
  if (sync) sync.textContent = labels.failed;
  if (container) {
    container.replaceChildren();
    const error = document.createElement("p");
    error.className = "routing-empty routing-error";
    error.textContent = labels.failed;
    container.append(error);
  }
  setActionLabels();
  setTone("failed");
}

async function refresh() {
  if (inFlight) return inFlight;
  const labels = copy();
  const title = element("routing-status-title");
  const container = element("system-status");
  if (title) title.textContent = labels.title;
  if (container && !current) container.textContent = labels.loading;

  inFlight = fetch(endpoint, {
    credentials: "same-origin",
    headers: { Accept: "application/json" },
    cache: "no-store",
  }).then(async (response) => {
    if (!response.ok) throw new Error(`routing_status_${response.status}`);
    const data = await response.json();
    render(data);
    return data;
  }).catch(() => {
    renderFailure();
    return null;
  }).finally(() => {
    inFlight = null;
  });
  return inFlight;
}

const routingStatusApi = {
  refresh,
  render: () => current && render(current),
  setSyncing,
  setSyncFailure,
};
window.mailboxRoutingStatus = routingStatusApi;

export function initRouting() {
  element("system-status")?.setAttribute("aria-live", "polite");
  element("sync-status")?.setAttribute("aria-live", "polite");
  setActionLabels();
}