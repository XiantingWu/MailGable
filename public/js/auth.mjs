import { $, api, clearError, showError, state, toast } from "./state.mjs";
import { applyLanguage, t } from "./i18n.mjs";
import { showMail } from "./mailbox.mjs";

export function showAuth() {
  $("mail-view").hidden = true;
  $("auth-view").hidden = false;
  $("bootstrap-field").hidden = state.initialized;
  $("auth-password").autocomplete = state.initialized ? "current-password" : "new-password";
  applyLanguage();
}

export async function start() {
  try {
    const status = await api("/api/auth/status");
    state.initialized = Boolean(status.initialized);
    state.csrf = status.csrf_token || "";
    state.email = status.email || "";

    if (status.authenticated) await showMail();
    else showAuth();
  } catch (error) {
    state.initialized = true;
    showAuth();
    showError("auth-error", error);
  }
}

export async function submitAuth(event) {
  event.preventDefault();
  clearError("auth-error");
  const button = $("auth-submit");
  button.disabled = true;
  try {
    const body = JSON.stringify({ email: $("auth-email").value, password: $("auth-password").value });
    const headers = state.initialized ? {} : { "X-Bootstrap-Token": $("bootstrap-token").value };
    const result = await api(state.initialized ? "/api/auth/login" : "/api/auth/bootstrap", { method: "POST", headers, body });
    state.csrf = result.csrf_token || "";
    state.email = result.email || "";
    state.initialized = true;
    $("auth-password").value = "";
    $("bootstrap-token").value = "";
    toast(t("loginOk"));
    await showMail();
  } catch (error) {
    showError("auth-error", error);
  } finally {
    button.disabled = false;
  }
}

export async function logout() {
  try { await api("/api/auth/logout", { method: "POST", body: "{}" }); } catch { /* clear local state regardless */ }
  state.csrf = "";
  state.email = "";
  state.threads = [];
  state.selectedDetail = null;
  toast(t("loggedOut"));
  await start();
}

export function openSecurity() {
  $("security-form").reset();
  clearError("security-error");
  $("security-dialog").showModal();
  setTimeout(() => $("current-password").focus(), 0);
}

export async function submitSecurity(event) {
  event.preventDefault();
  clearError("security-error");
  if ($("new-password").value !== $("confirm-password").value) {
    showError("security-error", new Error("The new passwords do not match."));
    return;
  }
  const button = $("security-save");
  button.disabled = true;
  try {
    await api("/api/auth/password", { method: "POST", body: JSON.stringify({ current_password: $("current-password").value, new_password: $("new-password").value }) });
    $("security-dialog").close();
    state.csrf = "";
    toast(t("passwordChanged"));
    await start();
  } catch (error) {
    showError("security-error", error);
  } finally {
    button.disabled = false;
  }
}

export async function logoutAll() {
  clearError("security-error");
  try {
    await api("/api/auth/logout-all", { method: "POST", body: "{}" });
    $("security-dialog").close();
    state.csrf = "";
    toast(t("allLoggedOut"));
    await start();
  } catch (error) {
    showError("security-error", error);
  }
}