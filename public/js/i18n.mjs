import { $, state } from "./state.mjs";

// Central English copy registry. The administrative interface and
// repository documentation are maintained in English only; this registry
// provides every static UI string and keeps the no-JS HTML fallback and
// the runtime copy in agreement.
const text = {
  login: "Sign in", setup: "Initialize and sign in", title: "Mail Admin", loginDesc: "Sign in with the administrator account.",
  setupDesc: "First use: create the administrator password.", mail: "Mail", refresh: "Refresh", compose: "Compose",
  logout: "Sign out", settings: "Security", allMailboxes: "All mailboxes", inbox: "Inbox", sent: "Sent",
  archive: "Archive", spam: "Spam", trash: "Trash", all: "All mail", system: "System status",
  checking: "Checking…", healthy: "The dev mailbox database, archive, sending, and webhook configuration is ready",
  incomplete: "Some services are not configured", search: "Search sender, subject, or body", filters: "Filters", unread: "Unread",
  replied: "Replied", attachment: "Has attachment", clear: "Clear", threads: "conversations", select: "Select a message",
  selectDesc: "Message content, attachments, replies, and delivery status appear here.", loadMore: "Load more", loadOlder: "Load earlier messages",
  loadingOlder: "Loading earlier messages…", reply: "Reply", replyAll: "Reply all", forward: "Forward",
  markRead: "Mark read", markUnread: "Mark unread", raw: "Raw message", from: "From identity", to: "To",
  cc: "CC", bcc: "BCC", subject: "Subject", body: "Body", files: "Attachments", cancel: "Cancel",
  send: "Send", sending: "Sending…", noSubject: "(No subject)", noMessages: "No messages match these filters.",
  noSenders: "No sending identity is available. Route a domain mailbox to the canonical Worker and redeploy.",
  loading: "Loading…", sentOk: "Message sent.", readOk: "Status updated.",
  loginOk: "Signed in.", loggedOut: "Signed out.", requestFailed: "Request failed", back: "Back",
  retrySend: "Safe retry", retrying: "Retrying safely…", retryOk: "Message resent with the original idempotency key.",
  recipientStatus: "Recipient status", deliveryEvents: "Delivery events", noDeliveryEvents: "No delivery events yet",
  truncated: "The body preview was truncated for platform storage safety. Download the raw message for the complete content.",
  passwordChanged: "Password changed. Sign in again.", allLoggedOut: "All administrator sessions were signed out.",
  adminEmail: "Administrator email", password: "Password", bootstrapToken: "One-time initialization token",
  openNavigation: "Open navigation", closeNavigation: "Close navigation", mailFolders: "Mail folders",
  shortcutSelect: "Select", messageList: "Message list", messageDetail: "Message detail", dateFrom: "From", dateTo: "To",
  composeNew: "New message", replyMessage: "Reply", forwardMessage: "Forward message",
  multipleAddresses: "Separate multiple addresses with commas", optional: "Optional", bodyPlaceholder: "Enter the message body…",
  retryNote: "After a network error, do not change the message before retrying. The same idempotency key prevents duplicates, and archived messages can also be safely retried after a refresh.",
  close: "Close", changePassword: "Change administrator password", currentPassword: "Current password", newPassword: "New password",
  confirmPassword: "Confirm new password", passwordNote: "After a successful change, every administrator session is revoked and must sign in again.",
  logoutAll: "Sign out all devices", changePasswordButton: "Change password", online: "Online", attention: "Attention", offline: "Offline",
  receiveOnly: "Outbound sending is not configured (receive-only mode)",
  outboundNone: "Not configured",
  outboundResend: "Resend",
  outboundBrevo: "Brevo",
  outboundCloudflare: "Cloudflare Email Service",
  trashThread: "Move to trash", restoreThread: "Restore", archiveThread: "Archive", unarchiveThread: "Unarchive",
  spamThread: "Mark as spam", deleteThread: "Delete permanently", deleteConfirm: "Deleting permanently removes the messages and attachments from storage. This cannot be undone. Continue?",
};

export const t = (key) => text[key] || key;

export function applyLanguage() {
  document.documentElement.lang = "en";
  for (const node of document.querySelectorAll("[data-i18n]")) node.textContent = t(node.dataset.i18n);
  for (const node of document.querySelectorAll("[data-i18n-placeholder]")) node.setAttribute("placeholder", t(node.dataset.i18nPlaceholder));
  for (const node of document.querySelectorAll("[data-i18n-aria]")) node.setAttribute("aria-label", t(node.dataset.i18nAria));
  for (const node of document.querySelectorAll("[data-i18n-data-placeholder]")) node.dataset.placeholder = t(node.dataset.i18nDataPlaceholder);
  $("auth-title").textContent = t("title");
  $("auth-description").textContent = state.initialized ? t("loginDesc") : t("setupDesc");
  $("auth-submit").textContent = state.initialized ? t("login") : t("setup");
  $("refresh-button").textContent = t("refresh");
  $("compose-button").textContent = t("compose");
  $("settings-button").textContent = t("settings");
  $("logout-button").textContent = t("logout");
  $("search-input").placeholder = t("search");
  $("filter-button").textContent = t("filters");
  $("load-more").textContent = t("loadMore");
  $("compose-title").textContent = state.composeMode === "reply" ? t("replyMessage") : state.composeMode === "forward" ? t("forwardMessage") : t("composeNew");
  for (const folder of ["inbox", "sent", "archive", "spam", "trash", "all"]) {
    document.querySelector(`[data-folder="${folder}"] b`).textContent = t(folder);
  }
}
