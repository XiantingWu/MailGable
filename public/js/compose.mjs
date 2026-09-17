import { $, api, clearError, parseAddresses, renderSendAvailability, showError, state, toast } from "./state.mjs";
import { applyLanguage, t } from "./i18n.mjs";
import { openThread } from "./messages.mjs";

export function renderMailboxOptions() {
  const select = $("compose-from");
  const selected = select.value;
  const senders = state.mailboxes.filter((item) => Number(item.can_send) === 1 && Number(item.active) === 1);
  select.replaceChildren();
  if (!senders.length) {
    const unavailable = new Option(t("noSenders"), "");
    unavailable.disabled = true;
    unavailable.selected = true;
    select.add(unavailable);
    select.disabled = true;
    $("compose-button").disabled = true;
    return;
  }
  select.disabled = false;
  renderSendAvailability();
  for (const mailbox of senders) {
    select.add(new Option(`${mailbox.display_name} <${mailbox.address}>`, mailbox.mailbox_id));
  }
  if ([...select.options].some((option) => option.value === selected)) select.value = selected;
}

export function resetCompose() {
  state.composeMode = "compose";
  state.composeParent = null;
  state.composeKey = `web/${crypto.randomUUID()}`;
  state.composeAttemptedPayload = "";
  $("compose-form").reset();
  $("compose-from").disabled = false;
  $("compose-body").innerHTML = "";
  $("attachment-summary").textContent = "Each attachment: 5 MB maximum; 8 MB total; 10 files maximum.";
  clearError("compose-error");
  renderMailboxOptions();
  applyLanguage();
}

export function openCompose() {
  resetCompose();
  $("compose-dialog").showModal();
  setTimeout(() => $("compose-to").focus(), 0);
}

export function lastIncoming() {
  return [...(state.selectedDetail?.messages || [])].reverse().find((item) => item.direction === "incoming") || null;
}

export function messageReplyAddresses(message) {
  for (const field of ["reply_to_json", "from_json"]) {
    const addresses = parseAddresses(message?.[field]).map((item) => String(item.address || item).trim()).filter(Boolean);
    if (addresses.length) return [...new Set(addresses)];
  }
  return message?.envelope_from ? [String(message.envelope_from).trim()] : [];
}

export function openReply(all) {
  const message = lastIncoming();
  if (!message) return;
  resetCompose();
  state.composeMode = "reply";
  state.composeParent = message;
  applyLanguage();
  $("compose-from").value = state.selectedDetail.thread.mailbox_id || $("compose-from").value;
  $("compose-from").disabled = true;
  const mine = new Set(state.mailboxes.map((item) => item.address.toLowerCase()));
  let recipients = messageReplyAddresses(message);
  if (all) {
    recipients = [...recipients, ...parseAddresses(message.to_json).map((item) => item.address), ...parseAddresses(message.cc_json).map((item) => item.address)];
  }
  recipients = recipients
    .map((item) => String(item || "").trim())
    .filter((item) => item && !mine.has(item.toLowerCase()));
  $("compose-to").value = [...new Map(recipients.map((item) => [item.toLowerCase(), item])).values()].join(", ");
  $("compose-subject").value = /^re:/i.test(message.subject || "") ? message.subject : `Re: ${message.subject || t("noSubject")}`;
  $("compose-dialog").showModal();
  setTimeout(() => $("compose-body").focus(), 0);
}

export function openForward() {
  const message = state.selectedDetail?.messages?.at(-1);
  if (!message) return;
  resetCompose();
  state.composeMode = "forward";
  state.composeParent = message;
  applyLanguage();
  $("compose-from").value = state.selectedDetail.thread.mailbox_id || $("compose-from").value;
  $("compose-subject").value = /^fwd?:/i.test(message.subject || "") ? message.subject : `Fwd: ${message.subject || t("noSubject")}`;
  $("compose-dialog").showModal();
  setTimeout(() => $("compose-to").focus(), 0);
}

export async function filePayload() {
  const files = [...$("compose-attachments").files];
  if (files.length > 10) throw new Error("A message can include at most 10 attachments.");
  let total = 0;
  return Promise.all(files.map((file) => {
    total += file.size;
    if (file.size > 5 * 1024 * 1024 || total > 8 * 1024 * 1024) throw new Error("Attachments exceed the 5 MB / 8 MB limits.");
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve({ filename: file.name, contentType: file.type || "application/octet-stream", content: String(reader.result).split(",")[1] || "" });
      reader.onerror = reject;
      reader.readAsDataURL(file);
    });
  }));
}

export async function submitCompose(event) {
  event.preventDefault();
  clearError("compose-error");
  const button = $("compose-send");
  button.disabled = true;
  button.textContent = t("sending");
  try {
    const payload = {
      from_mailbox_id: $("compose-from").value,
      to: $("compose-to").value,
      cc: $("compose-cc").value,
      bcc: $("compose-bcc").value,
      subject: $("compose-subject").value,
      text: $("compose-body").innerText,
      html: $("compose-body").innerHTML,
      attachments: await filePayload(),
      thread_id: state.composeMode === "reply" ? state.selectedThread : "",
      parent_message_id: state.composeMode === "reply" ? state.composeParent?.message_id : "",
    };
    const serialized = JSON.stringify(payload);
    if (state.composeAttemptedPayload && state.composeAttemptedPayload !== serialized) state.composeKey = `web/${crypto.randomUUID()}`;
    state.composeAttemptedPayload = serialized;
    const path = state.composeMode === "forward" ? `/api/messages/${encodeURIComponent(state.composeParent.message_id)}/forward` : "/api/messages/send";
    const result = await api(path, { method: "POST", headers: { "Idempotency-Key": state.composeKey }, body: serialized });
    $("compose-dialog").close();
    toast(t("sentOk"));
    state.composeKey = "";
    state.composeAttemptedPayload = "";
    await loadThreads(true);
    const index = state.threads.findIndex((item) => item.thread_id === result.thread_id);
    await openThread(result.thread_id, index);
  } catch (error) {
    showError("compose-error", error);
  } finally {
    button.disabled = false;
    button.textContent = t("send");
  }
}