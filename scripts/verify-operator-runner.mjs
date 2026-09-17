// Static gate: no authenticated/remote Cloudflare Wrangler invocation may
// bypass the central credential runner.
//
// Every scripts/*.mjs file (except operator-runner.mjs, which owns the
// Wrangler spawn layer, and this gate itself) must route authenticated
// Wrangler through runWrangler / runCaptureWrangler / runInheritWrangler.
// package.json scripts (and .github/workflows, when present) must never
// invoke an authenticated Wrangler command directly.
//
//   node scripts/verify-operator-runner.mjs
//
// Allowed Wrangler usage (non-authenticated / non-mutating allowlist):
//   wrangler dev
//   wrangler deploy --dry-run
//   wrangler d1 migrations apply DB --local
//   wrangler types
// Forbidden anywhere outside operator-runner.mjs:
//   spawn("npx", ["wrangler", ...])          (and spawnSync/exec/execFile)
//   run("npx", ["wrangler", ...])            (any local spawn wrapper)
//   package.json / workflows:
//     wrangler deploy                        (real remote deploy)
//     wrangler d1 ... --remote
//     wrangler secret ...
//     wrangler queues ...
//     wrangler r2 ...
//
// Exits non-zero with the count on any bypass and otherwise prints:
//   DIRECT AUTHENTICATED WRANGLER SPAWN OUTSIDE OPERATOR-RUNNER = 0
//   PACKAGE AUTHENTICATED WRANGLER BYPASS = 0
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import process from "node:process";

const SCRIPTS_DIR = path.join(process.cwd(), "scripts");
const SELF = "verify-operator-runner.mjs";
const EXCLUDED = new Set(["operator-runner.mjs", SELF]);
const ALLOWED_RUNNERS = new Set(["runWrangler", "runCaptureWrangler", "runInheritWrangler"]);
const SPAWN_FUNCTIONS = new Set(["spawn", "spawnSync", "exec", "execSync", "execFile", "execFileSync"]);

function walkScripts(dir) {
  const files = [];
  for (const entry of readdirSync(dir).sort()) {
    const full = path.join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) files.push(...walkScripts(full));
    else if (entry.endsWith(".mjs") && !EXCLUDED.has(entry)) files.push(full);
  }
  return files;
}

function stripComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/^\s*\/\/.*$/gm, "");
}

// Extract every function call as { callee, args } using a balanced-paren
// scanner that respects string literals, so a ")" inside a string never
// truncates the call.
function findCalls(source) {
  const calls = [];
  const re = /\b([A-Za-z_$][\w$]*)\s*\(/g;
  let match;
  while ((match = re.exec(source)) !== null) {
    const callee = match[1];
    const open = match.index + match[0].length - 1;
    let depth = 0;
    let i = open;
    let inString = null;
    for (; i < source.length; i++) {
      const ch = source[i];
      if (inString) {
        if (ch === "\\") { i += 1; continue; }
        if (ch === inString) inString = null;
        continue;
      }
      if (ch === '"' || ch === "'" || ch === "`") { inString = ch; continue; }
      if (ch === "(") depth += 1;
      else if (ch === ")") {
        depth -= 1;
        if (depth === 0) break;
      }
    }
    calls.push({ callee, args: source.slice(open + 1, i) });
  }
  return calls;
}

function firstStringArg(args) {
  const head = args.split(",")[0].trim();
  return head === '"npx"' || head === "'npx'" ? "npx" : null;
}

// A shell command fragment that invokes Wrangler in an authenticated /
// mutating way. Local dev, local D1 migrate, `types`, and `--dry-run` are
// the explicit non-authenticated allowlist.
function isAuthenticatedWranglerCommand(command) {
  if (!/\bwrangler\b/.test(command)) return false;
  if (/\bwrangler dev\b/.test(command)) return false;
  if (/\bwrangler d1 migrations apply\b[^]*--local/.test(command)) return false;
  if (/\bwrangler deploy\b[^]*--dry-run/.test(command)) return false;
  if (/\bwrangler types\b/.test(command)) return false;
  return true;
}

function scriptViolations(file, source) {
  const code = stripComments(source);
  const found = [];
  for (const { callee, args } of findCalls(code)) {
    if (SPAWN_FUNCTIONS.has(callee)) {
      if (args.includes('"npx"') || args.includes("'npx'") || args.includes('"wrangler"') || args.includes("'wrangler'") || /npx\s+wrangler/.test(args)) {
        found.push(`${file}: ${callee}() spawns npx/wrangler directly — route through operator-runner.mjs (runWrangler/runCaptureWrangler/runInheritWrangler).`);
      }
      continue;
    }
    if (ALLOWED_RUNNERS.has(callee)) continue;
    const command = firstStringArg(args);
    if (command === "npx") {
      found.push(`${file}: ${callee}() receives "npx" as its command — a Wrangler bypass; route through operator-runner.mjs.`);
    }
  }
  return found;
}

function packageViolations(pkg) {
  const found = [];
  const scripts = pkg.scripts || {};
  for (const [name, command] of Object.entries(scripts)) {
    if (isAuthenticatedWranglerCommand(String(command))) {
      found.push(`package.json: scripts.${name} = "${command}" invokes authenticated Wrangler directly — route through operator-runner.mjs.`);
    }
  }
  return found;
}

function workflowViolations(file, content) {
  const found = [];
  for (const line of content.split(/\r?\n/)) {
    if (isAuthenticatedWranglerCommand(line)) {
      found.push(`${file}: '${line.trim()}' invokes authenticated Wrangler directly — route through operator-runner.mjs.`);
    }
  }
  return found;
}

const pkg = JSON.parse(readFileSync(path.join(process.cwd(), "package.json"), "utf8"));

let scriptFailures = 0;
for (const file of walkScripts(SCRIPTS_DIR).sort()) {
  const source = readFileSync(file, "utf8");
  for (const violation of scriptViolations(file, source)) {
    console.error(`verify-operator-runner: FAIL ${violation}`);
    scriptFailures += 1;
  }
}

let packageFailures = 0;
for (const violation of packageViolations(pkg)) {
  console.error(`verify-operator-runner: FAIL ${violation}`);
  packageFailures += 1;
}

const workflowsDir = path.join(process.cwd(), ".github", "workflows");
let workflowFiles = [];
try {
  workflowFiles = readdirSync(workflowsDir).filter((name) => name.endsWith(".yml") || name.endsWith(".yaml")).sort();
} catch {
  workflowFiles = [];
}
for (const name of workflowFiles) {
  const file = path.join("", ".github", "workflows", name);
  const content = readFileSync(path.join(workflowsDir, name), "utf8");
  for (const violation of workflowViolations(file, content)) {
    console.error(`verify-operator-runner: FAIL ${violation}`);
    packageFailures += 1;
  }
}

if (scriptFailures > 0 || packageFailures > 0) {
  console.error(`verify-operator-runner: ${scriptFailures} direct authenticated Wrangler spawn(s) outside operator-runner.mjs; ${packageFailures} package/workflow authenticated Wrangler bypass(es).`);
  process.exit(1);
}

console.log(`DIRECT AUTHENTICATED WRANGLER SPAWN OUTSIDE OPERATOR-RUNNER = 0`);
console.log(`PACKAGE AUTHENTICATED WRANGLER BYPASS = 0`);
console.log(`verify-operator-runner: PASS (scripts, package.json, and ${workflowFiles.length} workflow(s) route every authenticated Wrangler invocation through the central runner).`);
