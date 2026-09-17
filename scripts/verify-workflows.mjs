// Repository automation hygiene gate: the source tree ships without
// GitHub Actions workflows, and the toolchain pins stay authoritative.
//
// Checks:
//   - no workflow files exist under .github/workflows/
//   - no .github/dependabot.yml (owner decision: no dependency bot)
//   - .nvmrc and .node-version both pin exactly 22.23.2
//
//   node scripts/verify-workflows.mjs
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";

const WORKFLOW_DIR = path.join(process.cwd(), ".github", "workflows");
const DEPENDABOT = path.join(process.cwd(), ".github", "dependabot.yml");
const failures = [];

let workflowFiles = [];
try {
  workflowFiles = readdirSync(WORKFLOW_DIR).filter((name) => name.endsWith(".yml") || name.endsWith(".yaml"));
} catch {
  workflowFiles = [];
}
for (const name of workflowFiles) {
  failures.push(`.github/workflows/${name}: workflow files are not shipped with this repository`);
}

if (existsSync(DEPENDABOT)) {
  failures.push("dependabot.yml must not exist (dependency updates are applied manually)");
}

for (const pinFile of [".nvmrc", ".node-version"]) {
  try {
    const value = readFileSync(path.join(process.cwd(), pinFile), "utf8").trim();
    if (value !== "22.23.2") failures.push(`${pinFile}: expected exactly 22.23.2, found '${value}'`);
  } catch {
    failures.push(`${pinFile}: toolchain pin file is missing`);
  }
}

if (failures.length) {
  for (const failure of failures) console.error(`verify-workflows: FAIL ${failure}`);
  console.error(`verify-workflows: ${failures.length} automation hygiene violation(s) found.`);
  process.exit(1);
}
console.log(
  "verify-workflows: PASS (no workflows, no dependency bot, Node 22.23.2 pinned).",
);
