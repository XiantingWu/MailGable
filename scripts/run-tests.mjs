import { readdir } from "node:fs/promises";
import { rm } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import process from "node:process";
import { fileURLToPath } from "node:url";

await rm(".test-build", { recursive: true, force: true });
const testCompiler = fileURLToPath(new URL("../node_modules/typescript/bin/tsc", import.meta.url));
const compile = spawnSync(process.execPath, [testCompiler, "-p", "tsconfig.test.json"], { stdio: "inherit" });
if (compile.status !== 0) process.exit(compile.status || 1);
const clientModules = (await readdir("public/js")).filter((name) => name.endsWith(".mjs")).sort();
for (const script of clientModules) {
  const syntax = spawnSync(process.execPath, ["--check", `public/js/${script}`], { stdio: "inherit" });
  if (syntax.status !== 0) process.exit(syntax.status || 1);
}
console.log(`Browser module syntax check passed (${clientModules.length} modules).`);
const tests = spawnSync(process.execPath, [
  "--test",
  "tests/admin-asset-cache.test.mjs",
  "tests/lib.test.mjs",
  "tests/mail.test.mjs",
  "tests/auth-runtime.test.mjs",
  "tests/security-admin-hardening.test.mjs",
  "tests/send-validation.test.mjs",
  "tests/auto-bcc.test.mjs",
  "tests/inbound-forwarding.test.mjs",
  "tests/email-routing-observability.test.mjs",
  "tests/inbound-routing-reconcile.test.mjs",
  "tests/final-consistency.test.mjs",
  "tests/hardening-regressions.test.mjs",
  "tests/ready-regressions.test.mjs",
  "tests/source.test.mjs",
  "tests/english-only.test.mjs",
  "tests/deployment-entry.test.mjs",
  "tests/final-readiness.test.mjs",
  "tests/production-readiness.test.mjs",
  "tests/credential-forwarding.test.mjs",
  "tests/credential-forwarding-launcher.test.mjs",
  "tests/least-privilege-resend-ops.test.mjs",
  "tests/resend-credential-lifecycle-doc.test.mjs",
  "tests/powershell-collection-regressions.test.mjs",
  "tests/routing-status-sidebar.test.mjs",
  "tests/routing-mailbox-sync.test.mjs",
  "tests/runtime-routing-sync.test.mjs",
  "tests/runtime-routing-sync-security.test.mjs",
  "tests/thread-lifecycle.test.mjs",
  "tests/theme.test.mjs",
  "tests/folder-pagination.test.mjs",
  "tests/attachment-batch.test.mjs",
  "tests/quota-error.test.mjs",
  "tests/setup-core.test.mjs",
  "tests/operator-config.test.mjs",
  "tests/migration-doc-match.test.mjs",
  "tests/configure-control-plane.test.mjs",
  "tests/credentials.test.mjs",
  "tests/credential-check.test.mjs",
  "tests/credential-status.test.mjs",
  "tests/credential-rotate.test.mjs",
  "tests/credential-snapshot.test.mjs",
  "tests/clean-shell-e2e.test.mjs",
  "tests/providers.test.mjs",
  "tests/provider-contract.test.mjs",
  "tests/provider-event-duplicate.test.mjs",
  "tests/operator-state.test.mjs",
  "tests/operator-path.test.mjs",
  "tests/provider-failure.test.mjs",
  "tests/central-credentials.test.mjs",
  "tests/central-runner-bypass.test.mjs",
  "tests/provider-secret-minimization.test.mjs",
], { stdio: "inherit" });
process.exit(tests.status || 0);