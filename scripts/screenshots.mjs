#!/usr/bin/env node
// Reproducible synthetic screenshots for the README/social assets.
// Uses a fully isolated local dev server, seeds demo data, and captures
// fixed-viewport screenshots into docs/assets/. Never touches production.
import { readdirSync, statSync } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { chromium } from "@playwright/test";
import path from "node:path";
import process from "node:process";
import { runWrangler, runInheritWrangler } from "./operator-runner.mjs";

function walkSync(dir) {
  const results = [];
  for (const name of readdirSync(dir)) {
    const full = `${dir}/${name}`;
    if (statSync(full).isDirectory()) results.push(...walkSync(full));
    else results.push(full);
  }
  return results;
}

const PORT = 8790;
const ORIGIN = `http://localhost:${PORT}`;
const STATE = path.join(process.cwd(), ".e2e-state");
const ASSETS = path.join(process.cwd(), "docs", "assets");
const BOOTSTRAP_TOKEN = "test-screenshots-bootstrap-token-1234567890";
const PEPPER = "test-screenshots-pepper-0123456789abcdef0123456789abcdef";
const PASSPHRASE = "correct horse battery staple 2026";
const VARS = [
  `ADMIN_BOOTSTRAP_TOKEN:${BOOTSTRAP_TOKEN}`,
  `AUTH_PEPPER:${PEPPER}`,
  "ADMIN_EMAIL:admin@example.com",
  "MAIL_DOMAIN:example.com",
  "PASSWORD_ITERATIONS:8000",
  "LOG_LEVEL:error",
  "OUTBOUND_PROVIDER:resend",
  "RESEND_API_KEY:res_dummy_screenshot_key_not_used",
];

function run(command, args) {
  const result = spawnSync(command, args, { stdio: "inherit" });
  if (result.status !== 0) process.exit(result.status || 1);
}

function findLocalD1() {
  const dir = path.join(STATE, "v3", "d1");
  const files = walkSync(dir).filter((name) => name.endsWith(".sqlite") && !name.endsWith("metadata.sqlite")).sort();
  return files.at(-1);
}

async function terminate(child) {
  if (!child || child.pid === undefined) return;
  const pid = child.pid;
  const killGroup = (signal) => {
    if (process.platform === "win32") {
      try { child.kill(signal); } catch { /* already gone */ }
    } else {
      try { process.kill(-pid, signal); } catch { /* already gone */ }
    }
  };
  const exited = new Promise((resolve) => {
    if (child.exitCode !== null) return resolve();
    child.once("exit", () => resolve());
  });
  killGroup("SIGTERM");
  await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 3000))]);
  // Always escalate: the npx wrapper can exit on SIGTERM while workerd children
  // survive inside the same process group.
  killGroup("SIGKILL");
  await new Promise((resolve) => setTimeout(resolve, 250));
}

async function waitForReady(timeoutMs = 180_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${ORIGIN}/admin/mail/`);
      if (response.ok) return;
    } catch {
      // not up yet
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error("dev server did not become ready");
}

async function main() {
  await rm(STATE, { recursive: true, force: true });
  await mkdir(ASSETS, { recursive: true });

  if (!(await runInheritWrangler(["d1", "migrations", "apply", "DB", "--local", "--config", "wrangler.jsonc", "--persist-to", STATE]))) {
    process.exit(1);
  }
  const server = runWrangler(
    [
      "dev", "--config", "wrangler.jsonc",
      "--port", String(PORT), "--inspector-port", "0", "--persist-to", STATE,
      ...VARS.flatMap((value) => ["--var", value]),
    ],
    { stdio: "inherit", spawnOptions: { detached: process.platform !== "win32" } },
  );
  try {
    await waitForReady();
    run("node", ["scripts/seed-demo.mjs", "--d1", findLocalD1()]);
  } catch (error) {
    await terminate(server);
    throw error;
  }

  // English-only pre-capture assertion: screenshots must come from the
  // canonical English UI (document language en, no language switcher).
  async function assertEnglish(page) {
    const lang = await page.locator("html").getAttribute("lang");
    if (lang !== "en") throw new Error(`screenshot page language is '${lang}', expected 'en'`);
    if ((await page.locator("#language-toggle").count()) !== 0) throw new Error("screenshot page must not contain #language-toggle");
    if ((await page.locator("#auth-language").count()) !== 0) throw new Error("screenshot page must not contain #auth-language");
  }

  // Deterministic demo state: locally there are no Cloudflare credentials, so
  // the routing endpoints would fail and the UI would render a transient
  // "Sync failed" banner. Stub them with the healthy shape so README
  // screenshots always show the normal operating state (synthetic demo data
  // only, like everything else this script seeds).
  const routingStub = async (target) => {
    await target.route("**/routing-sync", (route) =>
      route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true }) }));
    await target.route("**/routing-status", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          sync: { status: "success", finished_at: "2026-09-02 09:00:00" },
          routes: [
            { address: "hello@example.com", route_status: "active" },
            { address: "sales@example.com", route_status: "active" },
          ],
          forwarding: { configured: true, failed_attempts: 0 },
        }),
      }));
  };

  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 }, timezoneId: "America/New_York" });
    await routingStub(page);
    await page.goto(`${ORIGIN}/admin/mail/`);
    await page.locator("#auth-email").fill("admin@example.com");
    await page.locator("#auth-password").fill(PASSPHRASE);
    await page.locator("#bootstrap-token").fill(BOOTSTRAP_TOKEN);
    await page.locator("#auth-submit").click();
    await page.waitForSelector("#mail-view:not([hidden])", { timeout: 30_000 });

    await page.waitForSelector(".thread", { timeout: 30_000 });
    await assertEnglish(page);
    await page.screenshot({ path: path.join(ASSETS, "hero-light.png") });

    await page.locator(".thread").first().click();
    await page.waitForSelector(".message-card", { timeout: 15_000 });
    await assertEnglish(page);
    await page.screenshot({ path: path.join(ASSETS, "thread.png") });

    await page.locator("#compose-button").click();
    await page.waitForSelector("#compose-dialog:not([closed])", { timeout: 15_000 });
    await assertEnglish(page);
    await page.screenshot({ path: path.join(ASSETS, "compose.png") });
    await page.locator("#compose-cancel").click();

    await page.locator("#theme-toggle").click();
    await page.waitForSelector('html[data-theme="dark"]', { timeout: 5_000 });
    await page.locator(".thread").first().click();
    await page.waitForSelector(".message-card", { timeout: 15_000 });
    await assertEnglish(page);
    await page.screenshot({ path: path.join(ASSETS, "hero-dark.png") });

    const mobile = await browser.newPage({ viewport: { width: 390, height: 844 }, timezoneId: "America/New_York" });
    await routingStub(mobile);
    await mobile.goto(`${ORIGIN}/admin/mail/`);
    await mobile.locator("#auth-email").fill("admin@example.com");
    await mobile.locator("#auth-password").fill(PASSPHRASE);
    await mobile.locator("#auth-submit").click();
    await mobile.waitForSelector("#mail-view:not([hidden])", { timeout: 30_000 });
    await mobile.waitForSelector(".thread", { timeout: 30_000 });
    await assertEnglish(mobile);
    await mobile.screenshot({ path: path.join(ASSETS, "mobile.png") });

    console.log(`screenshots written to ${ASSETS}/`);
  } finally {
    await browser.close();
    await terminate(server);
  }
}

await main();
