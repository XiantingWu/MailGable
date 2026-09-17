import { $, api, renderSendAvailability, state, toast } from "./state.mjs";
import { applyLanguage, t } from "./i18n.mjs";
import { loadThreads } from "./messages.mjs";
import { renderMailboxOptions } from "./compose.mjs";

let mailboxRefreshInFlight = null;

function setMailboxRefreshBusy(busy) {
  for (const id of ["refresh-button", "sync-status", "routing-sync-button"]) {
    const node = $(id);
    if (node) node.disabled = busy;
  }
}

export async function refreshMailboxView({ notify = false } = {}) {
  if (mailboxRefreshInFlight) return mailboxRefreshInFlight;
  mailboxRefreshInFlight = (async () => {
    setMailboxRefreshBusy(true);
    window.mailboxRoutingStatus?.setSyncing?.();
    let syncError = null;
    try {
      await api("/api/routing-sync", { method: "POST", body: "{}" });
    } catch (error) {
      if (error?.status === 401) throw error;
      syncError = error;
    }

    await Promise.all([loadMailboxes(), loadHealth()]);
    await loadThreads(true);

    if (syncError) {
      window.mailboxRoutingStatus?.setSyncFailure?.();
      if (notify) {
        const fallback = "Cloudflare route sync failed; the last state was preserved.";
        toast(syncError instanceof Error ? `${fallback} ${syncError.message}` : fallback);
      }
      return { synced: false };
    }
    if (notify) toast("Cloudflare routes synchronized.");
    return { synced: true };
  })().finally(() => {
    setMailboxRefreshBusy(false);
    mailboxRefreshInFlight = null;
  });
  return mailboxRefreshInFlight;
}

export async function showMail() {
  $("auth-view").hidden = true;
  $("mail-view").hidden = false;
  applyLanguage();
  await Promise.all([loadConfig(), refreshMailboxView({ notify: false })]);
}

async function loadConfig() {
  try {
    const config = await api("/api/config");
    state.outboundConfigured = config.outbound?.configured === true;
    state.outboundProvider = String(config.outbound?.provider || "none");
    renderSendAvailability();
  } catch {
    state.resendConfigured = false;
  }
}


export async function loadHealth() {
  const routingApi = window.mailboxRoutingStatus;
  if (routingApi?.refresh) {
    await routingApi.refresh();
    return;
  }

  $("system-status").textContent = "Loading routing status…";
  $("sync-status").textContent = "Routing status not loaded";
}

export async function loadMailboxes() {
  const result = await api("/api/mailboxes");
  state.mailboxes = result.mailboxes || [];
  const filter = $("mailbox-filter");
  const selected = filter.value;
  filter.replaceChildren(new Option(t("allMailboxes"), ""));
  for (const mailbox of state.mailboxes) filter.add(new Option(mailbox.address, mailbox.mailbox_id));
  filter.value = selected;
  state.mailbox = filter.value;
  renderMailboxOptions();
}