import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const ui = await readFile("public/js/routing.mjs", "utf8");
const css = await readFile("public/routing-status.css", "utf8");
const html = await readFile("public/index.html", "utf8");

test("routing sidebar derives mailbox rows from API data instead of hardcoded addresses", () => {
  assert.match(ui, /Array\.isArray\(data\?\.routes\)/);
  assert.match(ui, /function normalizedRoutes\(data\)/);
  assert.match(ui, /String\(left\.address\)\.localeCompare/);
  assert.match(ui, /function mailboxRow\(route, labels\)/);
  assert.match(ui, /route\.route_status/);
  assert.match(ui, /route\.address/);
  assert.match(ui, /routing-mailbox-list/);
  assert.match(ui, /role", "list"/);
  const forbiddenPattern = new RegExp(["@", "cato", "racle", "tech\\.com"].join(""));
  assert.doesNotMatch(ui, forbiddenPattern);
});


test("routing sidebar keeps mailbox routing separate from external backup request health", () => {
  const mailboxSection = ui.indexOf("labels.mailboxRoutes");
  const backupSection = ui.indexOf("labels.backupSection", mailboxSection + 1);
  assert.ok(mailboxSection >= 0, "mailbox route section is missing");
  assert.ok(backupSection > mailboxSection, "external backup section must render after mailbox routes");
  assert.match(ui, /function forwardingRow\(data, labels\)/);
  assert.match(ui, /backup: "External forwarding"/);
  assert.match(ui, /Worker requests healthy · verify final delivery in Cloudflare/);
  assert.doesNotMatch(ui, /Hotmail|Yahoo/i);
});

test("routing sidebar uses accessible stacked mailbox rows with bounded scrolling", () => {
  assert.match(html, /<button id="routing-sync-button" class="routing-sync-button" type="button"><strong id="routing-status-title">Routing status<\/strong><span id="routing-status-dot"/);
  assert.match(css, /\.system-card \.routing-sync-button\{[^}]*display:flex[^}]*justify-content:space-between/);
  assert.match(css, /\.system-card \.routing-status\{[^}]*max-height:min\(38vh,320px\)[^}]*overflow-y:auto/);
  assert.match(css, /\.system-card \.routing-route\{display:grid;gap:2px/);
  assert.match(css, /\.system-card \.routing-route-main\{display:flex/);
  assert.match(css, /\.routing-address\{[^}]*text-overflow:ellipsis[^}]*white-space:nowrap/);
  assert.match(css, /\.routing-route-status\{[^}]*font-size:10px[^}]*overflow-wrap:anywhere/);
  assert.match(css, /\.routing-route-dot\[data-state="active"\]/);
  assert.match(css, /\.routing-route-dot\[data-state="send_only"\],\.routing-route-dot\[data-state="receive_only"\]/);
  assert.match(css, /\.routing-route-dot\[data-state="attention"\]/);
});

test("routing sidebar remains interactive and accessible", () => {
  assert.match(ui, /mailboxRoutes: "Mailbox routes"/);
  assert.match(ui, /backupSection: "External backup"/);
  assert.match(ui, /syncing: "Syncing Cloudflare…"/);
  assert.match(ui, /syncing: "Syncing Cloudflare…"/);
  assert.match(ui, /syncFailed: "Sync failed · last state preserved"/);
  assert.match(ui, /setAttribute\("aria-live", "polite"\)/);
  assert.match(ui, /setAttribute\("aria-label", `\$\{addressValue\}: \$\{labels\[state\] \|\| labels\.unknown\}`\)/);
  assert.match(ui, /setActionLabels\(\)/);
  assert.match(css, /button\.status-pill\{[^}]*cursor:pointer/);
  assert.match(css, /data-state="syncing"/);
});
