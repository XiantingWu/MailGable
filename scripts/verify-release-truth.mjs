#!/usr/bin/env node
// Release-truth verification for the single-main repository.
//
// Offline part (safe to run in `npm run check`): asserts documentation no
// longer claims states that the current source contradicts, and that the
// single-main invariants that can be checked without a network hold.
//
// Operator part (`--single-main`): asserts the live single-main invariant
// against the remote — current branch is main, HEAD equals origin/main, the
// remote has exactly one branch (main), and the worktree is clean. This
// requires network access and is an explicit release/operator command, not
// part of the offline unit suite.
import { readFile, readdir } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import path from "node:path";
import process from "node:process";

const SINGLE_MAIN = process.argv.includes("--single-main");
const ROOT = process.cwd();

function read(p) {
  return readFile(path.join(ROOT, p), "utf8");
}

async function exists(p) {
  try {
    await read(p);
    return true;
  } catch {
    return false;
  }
}

function run(command, args) {
  const result = spawnSync(command, args, { encoding: "utf8" });
  return { status: result.status ?? 1, stdout: result.stdout || "" };
}

let failures = [];

async function offlineChecks() {
  const [readme, architecture, roadmap, migrations, deploy, security] = await Promise.all([
    read("README.md"),
    read("docs/ARCHITECTURE.md"),
    read("docs/ROADMAP.md"),
    read("docs/MIGRATIONS.md"),
    read("docs/DEPLOY.md"),
    read("SECURITY.md"),
  ]);

  // Deleted feature branch must not be referenced by operator/release docs.
  if (/refactor\/public-launch-hardening/.test(readme + architecture + roadmap + migrations + deploy + security)) {
    failures.push("stale reference to deleted branch refactor/public-launch-hardening");
  }
  // No "Draft PR head" binding in release tooling docs.
  if (/Draft PR head/i.test(readme + deploy + security)) {
    failures.push("release docs still reference a Draft PR head");
  }
  // No bilingual architecture claim.
  if (/bilingual copy \(zh \/ en\)|zh \/ en/i.test(architecture)) {
    failures.push("architecture still claims bilingual (zh/en) copy");
  }
  // Deployment runtime is Node 22.x, never ">=20".
  if (/Node\.js (≥|>=) ?20\b/.test(readme + deploy + security)) {
    failures.push("deployment docs still say Node.js >=20 instead of 22.x");
  }
  // Cloudflare Email Service is shipped, not future work.
  if (/Cloudflare Email Service provider on the `OutboundProvider` boundary/.test(roadmap)) {
    failures.push("roadmap still lists the shipped Cloudflare Email Service provider as future work");
  }
  if (/| 1\. Cloudflare Email Service provider/.test(roadmap) && !/Outbound providers on the `OutboundProvider` boundary: Resend, Brevo, and/.test(roadmap)) {
    failures.push("roadmap v0.1 does not list the shipped provider matrix");
  }
  // Resend must not be described as the only implementation.
  if (/the only outbound provider|Outbound Provider \/ Resend/i.test(readme + architecture)) {
    failures.push("docs describe Resend as the only provider or only implementation");
  }
  // Migration documentation must cover every committed migration.
  const migrationFiles = (await readdir(path.join(ROOT, "migrations")))
    .filter((name) => /^\d{4}_[a-z0-9_]+\.sql$/i.test(name)).sort();
  const maxFile = migrationFiles.at(-1)?.slice(0, 4);
  if (!maxFile) failures.push("no migration files found");
  for (const file of migrationFiles) {
    if (!new RegExp(`\\| ${file.slice(0, 4)} \\|`).test(migrations)) {
      failures.push(`docs/MIGRATIONS.md does not document migration ${file}`);
    }
  }
  // English-only contract preserved.
  if (await exists("README.zh-CN.md")) failures.push("README.zh-CN.md exists");
  if (/bilingual \(中文|简体中文/.test(readme)) failures.push("README claims a bilingual surface");

  // Ephemeral-SHA anti-pattern: tracked decision documentation must not
  // hard-code a "current/publication candidate" SHA, because any edit that
  // records the current SHA immediately becomes stale. Immutable SHAs in
  // historical qualification records remain allowed.
  for (const doc of ["docs/BRAND_CLEARANCE.md"]) {
    const text = await read(doc);
    if (/(current|latest|publication) candidate sha\s+[0-9a-f]{40}/i.test(text)) {
      failures.push(`${doc} hard-codes an ephemeral candidate SHA (must be derived at runtime)`);
    }
    // Brand-gate single source of truth: exactly one machine-readable
    // canonical decision state, no secondary ranking lists that can drift
    // out of sync with it, and no stale pre-USPTO engineering state.
    const finalBrand = (text.match(/FINAL_BRAND\s*=\s*\S+/g) || []).length;
    const brandGate = (text.match(/BRAND_GATE\s*=\s*\S+/g) || []).length;
    if (finalBrand !== 1) failures.push(`${doc}: FINAL_BRAND must appear exactly once (found ${finalBrand})`);
    if (brandGate !== 1) failures.push(`${doc}: BRAND_GATE must appear exactly once (found ${brandGate})`);
    if (/\bCandidate ranking \(canonical\)\b|^### Candidate ranking/m.test(text)) {
      failures.push(`${doc}: secondary ranking list present (single source of truth required)`);
    }
    if (/^ALTERNATIVES\s*=/m.test(text)) {
      failures.push(`${doc}: duplicate ALTERNATIVES block present (single source of truth required)`);
    }
    if (/\bCurrent engineering ranking\b/.test(text)) {
      failures.push(`${doc}: redundant 'Current engineering ranking' prose present`);
    }
    // Canonical brand state after the owner decision: MailGable is final,
    // MailPerch remains a rejected former provisional brand.
    if (!/FINAL_BRAND\s*=\s*MailGable\b/.test(text)) {
      failures.push(`${doc}: FINAL_BRAND must be MailGable after the owner decision`);
    }
    if (!/BRAND_GATE\s*=\s*RESOLVED\b/.test(text)) {
      failures.push(`${doc}: BRAND_GATE must be RESOLVED`);
    }
    if (!/FINAL_BRAND_STATUS\s*=\s*PRELIMINARY_SEARCH_CLEAR\b/.test(text)) {
      failures.push(`${doc}: FINAL_BRAND_STATUS must be PRELIMINARY_SEARCH_CLEAR`);
    }
    if (!/FORMER_PROVISIONAL_BRAND\s*=\s*MailPerch\b/.test(text)) {
      failures.push(`${doc}: FORMER_PROVISIONAL_BRAND must be MailPerch`);
    }
    if (!/REJECTED\s*=.*\bMailPerch\b/.test(text)) {
      failures.push(`${doc}: REJECTED must retain MailPerch`);
    }
    if (/YELLOW-PRELIMINARY/.test(text)) {
      failures.push(`${doc}: stale YELLOW-PRELIMINARY classification present`);
    }
    // USPTO comparative screen must be recorded as completed.
    if (!/USPTO_SCREEN_POLICY\s*=\s*REQUIRED_BEFORE_FINAL_US_BRAND_SELECTION/.test(text)) {
      failures.push(`${doc}: USPTO screen policy field missing`);
    }
    if (!/USPTO_EXECUTION_STATE\s*=\s*COMPLETED/.test(text)) {
      failures.push(`${doc}: USPTO execution state must be COMPLETED`);
    }
    if (!/INBOXSTEAD_USPTO_RESULT\s*=\s*NO_MATERIAL_SIGNAL/.test(text)) {
      failures.push(`${doc}: INBOXSTEAD_USPTO_RESULT must be NO_MATERIAL_SIGNAL`);
    }
    if (!/MAILDORY_USPTO_RESULT\s*=\s*REVIEW_SIGNAL/.test(text)) {
      failures.push(`${doc}: MAILDORY_USPTO_RESULT must be REVIEW_SIGNAL`);
    }
    if (/USPTO_EXECUTION_STATE\s*=\s*NOT_PERFORMED/.test(text) || /USPTO_RESULT\s*=\s*UNKNOWN/.test(text)) {
      failures.push(`${doc}: stale pre-USPTO NOT_PERFORMED/UNKNOWN state present`);
    }
    if (!/OWNER_BRAND_SELECTION\s*=\s*COMPLETE/.test(text)) {
      failures.push(`${doc}: OWNER_BRAND_SELECTION must be COMPLETE`);
    }
    if (!/LEGAL_CONCLUSION\s*=\s*NONE/.test(text)) {
      failures.push(`${doc}: LEGAL_CONCLUSION must be NONE`);
    }
    if (!/WIPO_SCREEN_POLICY\s*=\s*RECOMMENDED_ADDITIONAL_SIGNAL/.test(text)) {
      failures.push(`${doc}: WIPO screen policy field missing`);
    }
  }

  if (failures.length) {
    for (const failure of failures) console.error(`verify-release-truth: FAIL ${failure}`);
    console.error(`verify-release-truth: ${failures.length} release-truth violation(s) found.`);
    process.exit(1);
  }
  console.log(`verify-release-truth: PASS (offline; migrations documented through ${maxFile}).`);
}

async function singleMainChecks() {
  const branch = run("git", ["branch", "--show-current"]).stdout.trim();
  const head = run("git", ["rev-parse", "HEAD"]).stdout.trim();
  const originMain = run("git", ["rev-parse", "origin/main"]).stdout.trim();
  const remoteBranches = run("git", ["ls-remote", "--heads", "origin"]).stdout
    .split("\n").filter(Boolean).map((line) => line.split("\t")[1]).filter(Boolean);
  const dirty = run("git", ["status", "--porcelain"]).stdout.length > 0;

  const problems = [];
  if (branch !== "main") problems.push(`current branch is '${branch}', expected 'main'`);
  if (head !== originMain) problems.push(`HEAD ${head} != origin/main ${originMain}`);
  if (!(remoteBranches.length === 1 && remoteBranches[0] === "refs/heads/main")) {
    problems.push(`remote branches ${JSON.stringify(remoteBranches)} (expected exactly refs/heads/main)`);
  }
  if (dirty) problems.push("working tree is not clean");
  if (problems.length) {
    for (const problem of problems) console.error(`verify-release-truth: FAIL ${problem}`);
    console.error(`verify-release-truth: single-main invariant violated.`);
    process.exit(1);
  }
  console.log("verify-release-truth: PASS (single-main: branch=main, HEAD==origin/main, remote=main only, worktree clean).");
  console.log("RELEASE IDENTITY (runtime-derived, never persisted to the tree):");
  console.log(`  HEAD_SHA             ${head}`);
  console.log(`  ORIGIN_MAIN_SHA      ${originMain}`);
  console.log(`  REMOTE_BRANCH_COUNT  ${remoteBranches.length}`);
  console.log("  RELEASE_IDENTITY     PASS");
}

if (SINGLE_MAIN) {
  await singleMainChecks();
} else {
  await offlineChecks();
}
