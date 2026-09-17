import {
  $,
  addressLabel,
  api,
  download,
  escape,
  formatBytes,
  formatDate,
  parseAddresses,
  parseObject,
  state,
  toast,
  stripBidi,
  uniqueRows,
} from "./state.mjs";
import { t } from "./i18n.mjs";
import { openReply, openForward } from "./compose.mjs";

export function threadParams(reset) {
  if (reset) state.cursor = "";
  const params = new URLSearchParams({ folder: state.folder, limit: "40" });
  if (state.cursor) params.set("cursor", state.cursor);
  if (state.mailbox) params.set("mailbox", state.mailbox);
  const query = $("search-input").value.trim();
  if (query) params.set("q", query);
  if ($("filter-unread").checked) params.set("unread", "1");
  if ($("filter-replied").checked) params.set("replied", "1");
  if ($("filter-attachment").checked) params.set("attachment", "1");
  if ($("filter-from").value) params.set("date_from", $("filter-from").value);
  if ($("filter-to").value) params.set("date_to", $("filter-to").value);
  return params;
}

export async function loadThreads(reset = false) {
  if (state.loading) return;
  state.loading = true;
  $("list-loading").textContent = t("loading");
  try {
    const result = await api(`/api/threads?${threadParams(reset)}`);
    state.threads = reset ? (result.threads || []) : [...state.threads, ...(result.threads || [])];
    state.hasMore = Boolean(result.has_more);
    state.cursor = result.next_cursor || "";
    renderThreads();
  } catch (error) {
    toast(error.message);
  } finally {
    state.loading = false;
    $("list-loading").textContent = "";
  }
}

export function renderThreads() {
  const list = $("thread-list");
  list.replaceChildren();
  $("list-count").textContent = `${state.threads.length} ${t("threads")}`;
  $("load-more").hidden = !state.hasMore;
  $("inbox-count").textContent = String(state.threads.reduce((sum, row) => sum + Number(row.unread_count || 0), 0) || "");
  if (!state.threads.length) {
    const empty = document.createElement("div");
    empty.className = "empty-state";
    empty.textContent = t("noMessages");
    list.append(empty);
    return;
  }
  state.threads.forEach((row, index) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = `thread${Number(row.unread_count) > 0 ? " unread" : ""}${row.thread_id === state.selectedThread ? " selected" : ""}`;
    button.setAttribute("role", "option");
    button.setAttribute("aria-selected", String(row.thread_id === state.selectedThread));
    const sender = row.direction === "outgoing" ? row.envelope_to : addressLabel(row.from_json, row.envelope_from);
    button.innerHTML = `<div class="thread-top"><strong>${escape(sender || row.mailbox_address || "")}</strong><time>${escape(formatDate(row.last_message_at))}</time></div><div class="thread-subject">${escape(row.subject || t("noSubject"))}</div><p>${escape(String(row.text_body || "").replace(/\s+/g, " ").slice(0, 180))}</p><div class="thread-flags">${Number(row.has_attachment) ? "📎" : ""}${Number(row.is_replied) ? " ↩" : ""}</div>`;
    button.addEventListener("click", () => openThread(row.thread_id, index));
    list.append(button);
  });
}

export async function openThread(threadId, index = -1, { autoMarkRead = true } = {}) {
  const requestId = ++state.detailRequest;
  state.selectedThread = threadId;
  state.keyboardIndex = index;
  renderThreads();
  const pane = $("detail-pane");
  pane.className = "detail-pane";
  pane.innerHTML = `<div class="empty-state">${escape(t("loading"))}</div>`;
  try {
    const detail = await api(`/api/threads/${encodeURIComponent(threadId)}?limit=100`);
    if (requestId !== state.detailRequest || state.selectedThread !== threadId) return;
    state.selectedDetail = detail;
    renderDetail(detail);
    document.querySelector(".workspace").classList.add("detail-open");
    const row = state.threads.find((item) => item.thread_id === threadId);
    if (autoMarkRead && row && Number(row.unread_count) > 0) {
      await api(`/api/threads/${encodeURIComponent(threadId)}/read`, { method: "POST", body: JSON.stringify({ read: true }) });
      if (requestId !== state.detailRequest || state.selectedThread !== threadId) return;
      row.unread_count = 0;
      if (state.selectedDetail?.thread) state.selectedDetail.thread.unread_count = 0;
      renderThreads();
    }
  } catch (error) {
    if (requestId === state.detailRequest && state.selectedThread === threadId) {
      pane.innerHTML = `<div class="empty-state">${escape(error.message)}</div>`;
    }
  }
}

function deliveryPanel(message, events) {
  const recipients = Object.entries(parseObject(message.recipient_status_json));
  const messageEvents = events.filter((event) => event.message_id === message.message_id);
  if (!recipients.length && !messageEvents.length) return null;
  const details = document.createElement("details");
  details.className = "delivery-details";
  const summary = document.createElement("summary");
  summary.textContent = t("recipientStatus");
  details.append(summary);
  if (recipients.length) {
    const list = document.createElement("dl");
    list.className = "recipient-status-list";
    for (const [recipient, status] of recipients) {
      const name = document.createElement("dt");
      name.textContent = recipient;
      const value = document.createElement("dd");
      value.className = `delivery-status status-${String(status).replace(/[^a-z0-9_-]/gi, "-")}`;
      value.textContent = String(status);
      list.append(name, value);
    }
    details.append(list);
  }
  const eventTitle = document.createElement("h4");
  eventTitle.textContent = t("deliveryEvents");
  details.append(eventTitle);
  if (!messageEvents.length) {
    const empty = document.createElement("p");
    empty.className = "delivery-empty";
    empty.textContent = t("noDeliveryEvents");
    details.append(empty);
  } else {
    const list = document.createElement("ol");
    list.className = "delivery-event-list";
    for (const event of messageEvents) {
      const item = document.createElement("li");
      const recipientsForEvent = parseAddresses(event.recipient_json).map((entry) => entry.address || entry).filter(Boolean).join(", ");
      item.textContent = `${event.status || event.event_type || "event"}${recipientsForEvent ? ` · ${recipientsForEvent}` : ""} · ${formatDate(event.occurred_at || event.received_at)}`;
      list.append(item);
    }
    details.append(list);
  }
  return details;
}

function messageCard(message, attachments, events) {
  const article = document.createElement("article");
  article.className = `message-card ${message.direction}`;
  const head = document.createElement("header");
  const from = addressLabel(message.from_json, message.envelope_from);
  const to = parseAddresses(message.to_json).map((item) => item.address).join(", ") || message.envelope_to || "";
  const identity = document.createElement("div");
  identity.className = "message-identity";
  identity.innerHTML = `<strong>${escape(from || message.envelope_from || "")}</strong><small>${escape(to ? `${t("to")}: ${to}` : "")}</small>`;
  const meta = document.createElement("div");
  meta.className = "message-status";
  meta.innerHTML = `<time>${escape(formatDate(message.received_at || message.sent_at || message.created_at))}</time><small class="delivery-status status-${escape(String(message.status || "unknown").replace(/[^a-z0-9_-]/gi, "-"))}">${escape(message.status || "")}</small>`;
  if (message.direction === "outgoing" && message.archive_status === "archived" && ["sending", "retryable_failed"].includes(message.status)) {
    const retry = document.createElement("button");
    retry.type = "button";
    retry.className = "compact retry-send";
    retry.textContent = t("retrySend");
    retry.addEventListener("click", () => retryArchivedMessage(message.message_id, retry));
    meta.append(retry);
  }
  head.append(identity, meta);
  const body = document.createElement("div");
  body.className = "message-body";
  if (message.html_body) {
    const frame = document.createElement("iframe");
    frame.className = "message-frame";
    frame.sandbox = "allow-popups allow-popups-to-escape-sandbox";
    frame.title = "HTML message";
    frame.srcdoc = `<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data: blob:; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'"><base target="_blank"><style>body{font:14px/1.55 -apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;color:#1b1d22;word-break:break-word}img{max-width:100%;height:auto}a{color:#184f91}</style>${message.html_body}`;
    body.append(frame);
  } else {
    const pre = document.createElement("pre");
    pre.textContent = stripBidi(message.text_body || "");
    body.append(pre);
  }
  if (Number(message.body_truncated)) {
    const warning = document.createElement("p");
    warning.className = "compose-note";
    warning.textContent = t("truncated");
    body.append(warning);
  }
  article.append(head, body);
  const files = attachments.filter((item) => item.message_id === message.message_id);
  if (files.length) {
    const wrap = document.createElement("div");
    wrap.className = "attachments";
    for (const file of files) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "attachment";
      button.textContent = `${file.filename} (${formatBytes(file.size)})`;
      button.addEventListener("click", () => download(`/api/attachments/${encodeURIComponent(file.attachment_id)}`, file.filename));
      wrap.append(button);
    }
    article.append(wrap);
  }
  const delivery = deliveryPanel(message, events);
  if (delivery) article.append(delivery);
  return article;
}

export async function threadStatusAction(threadId, action) {
  if (action === "delete" && !confirm(t("deleteConfirm"))) return;
  try {
    await api(`/api/threads/${encodeURIComponent(threadId)}/${action}`, { method: action === "delete" ? "DELETE" : "POST", body: "{}" });
    toast(t("readOk"));
    await loadThreads(true);
    closeDetail();
  } catch (error) {
    toast(error.message);
  }
}

function closeDetail() {
  state.detailRequest += 1;
  state.selectedThread = "";
  state.selectedDetail = null;
  document.querySelector(".workspace").classList.remove("detail-open");
  $("detail-pane").className = "detail-pane empty";
  $("detail-pane").innerHTML = `<div class="empty-state"><div class="empty-icon">✉</div><h2>${escape(t("select"))}</h2><p>${escape(t("selectDesc"))}</p></div>`;
}

export function renderDetail(detail) {
  const pane = $("detail-pane");
  pane.className = "detail-pane";
  pane.replaceChildren();
  const header = document.createElement("header");
  header.className = "detail-head";
  const title = document.createElement("div");
  title.innerHTML = `<h2>${escape(detail.thread.subject || t("noSubject"))}</h2><div class="detail-meta">${escape(detail.thread.mailbox_address || "")} · ${escape(formatDate(detail.thread.last_message_at))}</div>`;
  const actions = document.createElement("div");
  actions.className = "detail-actions";
  const add = (label, fn, className = "compact") => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = className;
    button.textContent = label;
    button.addEventListener("click", fn);
    actions.append(button);
  };
  if (matchMedia("(max-width:720px)").matches) add(t("back"), () => document.querySelector(".workspace").classList.remove("detail-open"));
  add(t("reply"), () => openReply(false));
  add(t("replyAll"), () => openReply(true));
  add(t("forward"), openForward);
  add(Number(detail.thread.unread_count) > 0 ? t("markRead") : t("markUnread"), () => toggleRead(Number(detail.thread.unread_count) === 0));
  const last = detail.messages.at(-1);
  if (last) add(t("raw"), () => download(`/api/messages/${encodeURIComponent(last.message_id)}/raw`, `${last.message_id}.eml`));
  const threadId = detail.thread.thread_id;
  const status = String(detail.thread.status || "open");
  if (status === "trash") {
    add(t("restoreThread"), () => threadStatusAction(threadId, "restore"), "compact primary");
    add(t("deleteThread"), () => threadStatusAction(threadId, "delete"), "compact danger");
  } else {
    if (status === "closed") add(t("unarchiveThread"), () => threadStatusAction(threadId, "unarchive"));
    else add(t("archiveThread"), () => threadStatusAction(threadId, "archive"));
    if (status !== "spam") add(t("spamThread"), () => threadStatusAction(threadId, "spam"));
    add(t("trashThread"), () => threadStatusAction(threadId, "trash"));
  }
  header.append(title, actions);
  pane.append(header);
  if (detail.has_more_messages) {
    const loadOlder = document.createElement("button");
    loadOlder.type = "button";
    loadOlder.className = "load-more detail-load-older";
    loadOlder.textContent = t("loadOlder");
    loadOlder.addEventListener("click", () => loadOlderMessages(loadOlder));
    pane.append(loadOlder);
  }
  const stack = document.createElement("div");
  stack.className = "message-stack";
  for (const message of detail.messages) stack.append(messageCard(message, detail.attachments || [], detail.events || []));
  pane.append(stack);
}

export async function loadOlderMessages(button) {
  const threadId = state.selectedThread;
  const detail = state.selectedDetail;
  if (!threadId || !detail?.has_more_messages) return;
  const original = button.textContent;
  button.disabled = true;
  button.textContent = t("loadingOlder");
  try {
    const offset = detail.messages?.length || 0;
    const older = await api(`/api/threads/${encodeURIComponent(threadId)}?limit=100&offset=${offset}`);
    if (state.selectedThread !== threadId || state.selectedDetail !== detail) return;
    state.selectedDetail = {
      ...detail,
      messages: uniqueRows([...(older.messages || []), ...(detail.messages || [])], "message_id"),
      attachments: uniqueRows([...(older.attachments || []), ...(detail.attachments || [])], "attachment_id"),
      events: uniqueRows([...(detail.events || []), ...(older.events || [])], "event_id"),
      total_messages: older.total_messages ?? detail.total_messages,
      has_more_messages: Boolean(older.has_more_messages),
      next_message_offset: older.next_message_offset ?? null,
    };
    renderDetail(state.selectedDetail);
  } catch (error) {
    toast(error.message);
    button.disabled = false;
    button.textContent = original;
  }
}

export async function toggleRead(markUnread) {
  try {
    await api(`/api/threads/${encodeURIComponent(state.selectedThread)}/read`, { method: "POST", body: JSON.stringify({ read: !markUnread }) });
    const row = state.threads.find((item) => item.thread_id === state.selectedThread);
    if (row) row.unread_count = markUnread ? Math.max(1, Number(row.unread_count || 0)) : 0;
    if (state.selectedDetail?.thread) state.selectedDetail.thread.unread_count = markUnread ? 1 : 0;
    toast(t("readOk"));
    await openThread(state.selectedThread, state.keyboardIndex, { autoMarkRead: !markUnread });
  } catch (error) {
    toast(error.message);
  }
}

export async function retryArchivedMessage(messageId, button) {
  const original = button.textContent;
  button.disabled = true;
  button.textContent = t("retrying");
  try {
    await api(`/api/messages/${encodeURIComponent(messageId)}/retry`, { method: "POST", body: "{}" });
    toast(t("retryOk"));
    await loadThreads(true);
    await openThread(state.selectedThread, state.keyboardIndex);
  } catch (error) {
    toast(error.message);
  } finally {
    button.disabled = false;
    button.textContent = original;
  }
}

export function setFolder(folder) {
  state.detailRequest += 1;
  state.folder = folder;
  document.querySelectorAll(".folder").forEach((item) => item.classList.toggle("active", item.dataset.folder === folder));
  state.selectedThread = "";
  state.selectedDetail = null;
  document.querySelector(".workspace").classList.remove("detail-open");
  $("detail-pane").className = "detail-pane empty";
  $("detail-pane").innerHTML = `<div class="empty-state"><div class="empty-icon">✉</div><h2>${escape(t("select"))}</h2><p>${escape(t("selectDesc"))}</p></div>`;
  loadThreads(true);
  closeSidebar();
}

export function closeSidebar() {
  $("sidebar").classList.remove("open");
  $("sidebar-backdrop").hidden = true;
}