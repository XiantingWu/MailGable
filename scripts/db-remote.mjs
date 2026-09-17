#!/usr/bin/env node
// Remote D1 migration through the central Wrangler runner.
//
//   node scripts/db-remote.mjs migrate
//
//   npm run db:migrate:remote
//
// Runs the full operator state gate first (HEAD rc_sha, worker name, D1
// UUID, config hash against .mailbox/config.json / .setup-state.json /
// wrangler.deploy.jsonc) and only then applies D1 migrations --remote via
// runInheritWrangler(), so the central Cloudflare token + account id are
// injected and no direct `wrangler` spawn ever bypasses the operator
// runner.
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { currentGitSha, OperatorStateError as GitStateError } from "./git-state.mjs";
import { loadOperatorConfig } from "./config/operator-config.mjs";
import {
  loadSetupState,
  loadGeneratedConfig,
  validateOperatorState,
  OperatorStateError,
} from "./config/operator-state.mjs";
import { runInheritWrangler } from "./operator-runner.mjs";

const ROOT = process.cwd();
const GENERATED = path.join(ROOT, "wrangler.deploy.jsonc");
const COMMAND = process.argv[2] || "migrate";

function fail(code, message) {
  console.error(`db-remote: [${code}] ${message}`);
  process.exit(1);
}

// Local runner for NON-Wrangler commands only (git rev-parse HEAD).
function runLocalCapture(command, args) {
  const result = spawnSync(command, args, { encoding: "utf8" });
  if (result.status !== 0) {
    return { ok: false, status: result.status, stderr: (result.stderr || "").trim() };
  }
  return { ok: true, stdout: (result.stdout || "").trim() };
}

async function migrate() {
  if (!existsSync(GENERATED)) {
    fail("generated_missing", "wrangler.deploy.jsonc is missing; run `npm run setup` first.");
  }
  const currentSha = await currentGitSha(runLocalCapture);
  try {
    validateOperatorState({
      operatorConfig: loadOperatorConfig(),
      setupState: loadSetupState(),
      generatedConfig: loadGeneratedConfig(),
      currentSha,
    });
  } catch (error) {
    if (error instanceof OperatorStateError || error instanceof GitStateError) {
      fail(error.code, error.detail || "operator state validation failed.");
    }
    throw error;
  }
  if (!(await runInheritWrangler(["d1", "migrations", "apply", "DB", "--remote", "--config", GENERATED]))) {
    fail("migration_failed", "D1 remote migrations failed.");
  }
  console.log("db-remote: D1 remote migrations applied (central runner).");
}

switch (COMMAND) {
  case "migrate":
    await migrate();
    break;
  default:
    console.error("usage: node scripts/db-remote.mjs migrate");
    process.exit(2);
}
