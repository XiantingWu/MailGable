#!/usr/bin/env node
// Regenerates worker-configuration.d.ts from wrangler.jsonc and appends the
// runtime-secret extension block (src/env-extensions.d.ts), so typecheck is
// stable in CI environments without a local .dev.vars.
//
//   node scripts/refresh-env-types.mjs            write in place
//   node scripts/refresh-env-types.mjs --check    fail if the committed file
//                                                 would change
import { readFile, writeFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import { runCaptureWrangler } from "./operator-runner.mjs";

const TARGET = "worker-configuration.d.ts";
const EXTENSION = "src/env-extensions.d.ts";
const check = process.argv.includes("--check");

async function withDevVarsIsolated(fn) {
  // wrangler types merges .dev.vars values into literal types. Isolate any
  // local .dev.vars so generation is byte-identical in every environment
  // (CI has no .dev.vars).
  const devVars = ".dev.vars";
  const backup = ".dev.vars.refresh-bak";
  let moved = false;
  try {
    await rm(backup, { force: true });
    try {
      await writeFile(backup, await readFile(devVars, "utf8"));
      await rm(devVars);
      moved = true;
    } catch {
      // no .dev.vars present
    }
    return await fn();
  } finally {
    if (moved) {
      await writeFile(devVars, await readFile(backup, "utf8"));
      await rm(backup, { force: true });
    }
  }
}

async function build() {
  await rm(TARGET, { force: true });
  await withDevVarsIsolated(async () => {
    const generated = await runCaptureWrangler(["types", TARGET, "--config", "wrangler.jsonc"]);
    if (!generated.ok) {
      process.stderr.write(generated.stderr || generated.stdout || "");
      process.exit(1);
    }
  });
  const extension = await readFile(EXTENSION, "utf8");
  await writeFile(TARGET, `${(await readFile(TARGET, "utf8")).trimEnd()}\n\n${extension}\n`, "utf8");
}

if (!check) {
  await build();
  console.log(`refresh-env-types: regenerated ${TARGET} (with env extensions).`);
  process.exit(0);
}

const directory = await mkdtemp(path.join(tmpdir(), "mailgable-env-types-"));
const original = path.join(directory, "worker-configuration.d.ts");
try {
  await writeFile(original, await readFile(TARGET, "utf8"));
  await build();
  const before = await readFile(original, "utf8");
  const after = await readFile(TARGET, "utf8");
  if (before !== after) {
    console.error("refresh-env-types: FAIL worker-configuration.d.ts is out of date. Run `node scripts/refresh-env-types.mjs` and commit the result.");
    process.exit(1);
  }
  console.log("refresh-env-types: PASS worker-configuration.d.ts is current.");
} finally {
  await rm(directory, { recursive: true, force: true });
}