import { $, applyTheme, formatBytes, state, toggleTheme } from "./state.mjs";
import { applyLanguage, t } from "./i18n.mjs";
import { start, submitAuth, logout, openSecurity, submitSecurity, logoutAll } from "./auth.mjs";
import { refreshMailboxView } from "./mailbox.mjs";
import { loadThreads, openThread, renderDetail, renderThreads, setFolder, closeSidebar } from "./messages.mjs";
import { openCompose, openReply, submitCompose } from "./compose.mjs";
import { initRouting } from "./routing.mjs";

let searchTimer;
function scheduleSearch() {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => loadThreads(true), 280);
}

function bind() {
  $("auth-form").addEventListener("submit", submitAuth);
  $("logout-button").addEventListener("click", logout);
  const syncNow = () => refreshMailboxView({ notify: true });
  $("refresh-button").addEventListener("click", syncNow);
  $("sync-status").addEventListener("click", syncNow);
  $("routing-sync-button").addEventListener("click", syncNow);
  $("compose-button").addEventListener("click", openCompose);
  $("settings-button").addEventListener("click", openSecurity);
  $("compose-close").addEventListener("click", () => $("compose-dialog").close());
  $("compose-cancel").addEventListener("click", () => $("compose-dialog").close());
  $("compose-form").addEventListener("submit", submitCompose);
  $("security-close").addEventListener("click", () => $("security-dialog").close());
  $("security-cancel").addEventListener("click", () => $("security-dialog").close());
  $("security-form").addEventListener("submit", submitSecurity);
  $("logout-all-button").addEventListener("click", logoutAll);
  $("load-more").addEventListener("click", () => loadThreads(false));
  $("search-input").addEventListener("input", scheduleSearch);
  $("mailbox-filter").addEventListener("change", (event) => { state.mailbox = event.target.value; loadThreads(true); });
  $("filter-button").addEventListener("click", () => {
    const panel = $("filter-panel");
    panel.hidden = !panel.hidden;
    $("filter-button").setAttribute("aria-expanded", String(!panel.hidden));
  });
  ["filter-unread", "filter-replied", "filter-attachment", "filter-from", "filter-to"].forEach((id) => $(id).addEventListener("change", () => loadThreads(true)));
  $("clear-filters").addEventListener("click", () => {
    ["filter-unread", "filter-replied", "filter-attachment"].forEach((id) => { $(id).checked = false; });
    ["filter-from", "filter-to"].forEach((id) => { $(id).value = ""; });
    loadThreads(true);
  });
  document.querySelectorAll(".folder").forEach((item) => item.addEventListener("click", () => setFolder(item.dataset.folder)));
  $("menu-toggle").addEventListener("click", () => { $("sidebar").classList.add("open"); $("sidebar-backdrop").hidden = false; });
  $("sidebar-backdrop").addEventListener("click", closeSidebar);
  $("theme-toggle").addEventListener("click", toggleTheme);
  $("compose-attachments").addEventListener("change", () => {
    $("attachment-summary").textContent = [...$("compose-attachments").files].map((file) => `${file.name} (${formatBytes(file.size)})`).join(" · ") || "Each attachment: 5 MB maximum; 8 MB total.";
  });
  document.addEventListener("keydown", (event) => {
    if ($("compose-dialog").open || $("security-dialog").open || !$("auth-view").hidden) return;
    if (["INPUT", "TEXTAREA", "SELECT"].includes(document.activeElement?.tagName) || document.activeElement?.isContentEditable) return;
    if (event.key.toLowerCase() === "c") { event.preventDefault(); openCompose(); }
    else if (event.key.toLowerCase() === "r" && state.selectedThread) { event.preventDefault(); openReply(false); }
    else if (event.key.toLowerCase() === "j" || event.key === "ArrowDown") {
      event.preventDefault();
      const index = Math.min(state.threads.length - 1, state.keyboardIndex + 1);
      if (state.threads[index]) openThread(state.threads[index].thread_id, index);
    } else if (event.key.toLowerCase() === "k" || event.key === "ArrowUp") {
      event.preventDefault();
      const index = Math.max(0, state.keyboardIndex - 1);
      if (state.threads[index]) openThread(state.threads[index].thread_id, index);
    }
  });
  const splitter = $("splitter");
  let dragging = false;
  splitter.addEventListener("pointerdown", (event) => { dragging = true; splitter.setPointerCapture(event.pointerId); });
  splitter.addEventListener("pointermove", (event) => {
    if (!dragging) return;
    const left = document.querySelector(".workspace").getBoundingClientRect().left;
    const width = Math.max(320, Math.min(560, event.clientX - left));
    document.documentElement.style.setProperty("--list-width", `${width}px`);
    localStorage.setItem("mailbox_list_width", String(width));
  });
  splitter.addEventListener("pointerup", () => { dragging = false; });
  const width = Number(localStorage.getItem("mailbox_list_width"));
  if (width >= 320 && width <= 560) document.documentElement.style.setProperty("--list-width", `${width}px`);
}

bind();
applyTheme();
applyLanguage();
initRouting();
start();