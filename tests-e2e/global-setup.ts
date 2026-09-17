import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { rm } from "node:fs/promises";
import path from "node:path";

const STATE = ".e2e-state";

const PORT = 8788;
const BASE = `http://localhost:${PORT}/admin/mail/`;
const WRANGLER = path.join(process.cwd(), "node_modules", "wrangler", "bin", "wrangler.js");
const VARS = [
  "ADMIN_BOOTSTRAP_TOKEN:test-e2e-bootstrap-token-1234567890",
  "AUTH_PEPPER:test-e2e-pepper-0123456789abcdef0123456789abcdef",
  "ADMIN_EMAIL:admin@example.com",
  "MAIL_DOMAIN:example.com",
  "PASSWORD_ITERATIONS:8000",
  "LOG_LEVEL:error",
  "RESEND_API_KEY:res_dummy_e2e_key_not_used",
  "OUTBOUND_PROVIDER:resend",
];
let server: ChildProcess | null = null;
let stopped = false;
let restartTimer: ReturnType<typeof setTimeout> | null = null;

function startServer(): ChildProcess {
  const child = spawn(
    process.execPath,
    [
      WRANGLER, "dev", "--config", "wrangler.jsonc",
      "--port", String(PORT),
      "--inspector-port", "0",
      "--persist-to", ".e2e-state",
      ...VARS.flatMap((value) => ["--var", value]),
    ],
    { stdio: "inherit", detached: process.platform !== "win32" },
  );
  child.on("exit", () => {
    server = null;
    if (stopped) return;
    console.log("e2e: dev server exited; restarting in 1s...");
    restartTimer = setTimeout(() => { server = startServer(); }, 1000);
  });
  return child;
}

async function terminate(child: ChildProcess | null) {
  if (!child || child.pid === undefined) return;
  const pid = child.pid;
  const killGroup = (signal: NodeJS.Signals) => {
    if (process.platform === "win32") {
      try { child.kill(signal); } catch { /* already gone */ }
    } else {
      try { process.kill(-pid, signal); } catch { /* already gone */ }
    }
  };
  const exited = new Promise<void>((resolve) => {
    if (child.exitCode !== null) return resolve();
    child.once("exit", () => resolve());
  });
  killGroup("SIGTERM");
  await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 3000))]);
  // Always escalate: the wrapper can exit on SIGTERM while workerd children
  // survive inside the same process group.
  killGroup("SIGKILL");
  await new Promise((resolve) => setTimeout(resolve, 250));
}

async function waitForReady(timeoutMs = 180_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(BASE);
      if (response.ok) return;
    } catch {
      // not up yet
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error("MailGable e2e dev server did not become ready in time.");
}

export default async function () {
  await rm(".e2e-state", { recursive: true, force: true });
  const migrate = spawnSync(
    process.execPath,
    [WRANGLER, "d1", "migrations", "apply", "DB", "--local", "--config", "wrangler.jsonc", "--persist-to", ".e2e-state"],
    { stdio: "inherit" },
  );
  if (migrate.status !== 0) throw new Error("e2e D1 migrations failed.");
  // Mailboxes and demo threads are provided by scripts/seed-demo.mjs below;
  // do not pre-seed addresses here (they would collide with the demo data).
  const d1Dir = path.join(STATE, "v3", "d1");
  const { readdirSync } = await import("node:fs");
  const d1Files = readdirSync(d1Dir, { recursive: true }).map((name) => path.join(d1Dir, String(name))).filter((name) => name.endsWith(".sqlite") && !name.endsWith("metadata.sqlite"));
  const demoSeed = spawnSync(
    "node",
    ["scripts/seed-demo.mjs", "--d1", d1Files.sort().at(-1)],
    { stdio: "inherit" },
  );
  if (demoSeed.status !== 0) throw new Error("e2e demo seed failed.");
  server = startServer();
  await waitForReady();
  // Playwright runs the function returned from globalSetup as the global
  // teardown; a named export alone would never be invoked and the dev server
  // (plus its workerd children) would leak after the run.
  return teardown;
}

async function teardown() {
  stopped = true;
  if (restartTimer) clearTimeout(restartTimer);
  const child = server;
  server = null;
  await terminate(child);
}
