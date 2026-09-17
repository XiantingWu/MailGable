// Verifies the provider-specific generated deployment configs against the
// real wrangler schema:
//
//   node scripts/verify-provider-configs.mjs
//
// Builds synthetic production configs for none/resend/brevo/cloudflare and
// runs `wrangler deploy --dry-run` on each, so bindings (send_email,
// queues consumer, vars, custom domain) are validated by wrangler itself,
// not just by unit tests.
import { writeFileSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { runCaptureWrangler } from "./operator-runner.mjs";
import {
  buildSetupPlan,
  buildGeneratedConfig,
  parseSetupArgs,
  validateProductionInputs,
} from "./setup-core.mjs";

const ROOT = process.cwd();
const TEMPLATE = path.join(ROOT, "wrangler.jsonc");
const VALID_INPUTS = {
  mailDomain: "mailgable-test.dev",
  adminEmail: "admin@mailgable-test.dev",
  zoneId: "a".repeat(32),
  accountId: "a".repeat(32),
  appOrigin: "https://mail.mailgable-test.dev",
  workerName: "mailbox-test",
};

const providers = ["none", "resend", "brevo", "cloudflare"];
let failures = 0;

for (const provider of providers) {
  const args = { ...parseSetupArgs([]), ...VALID_INPUTS, mode: "production", outboundProvider: provider };
  const validated = validateProductionInputs(args);
  if (!validated.ok) {
    console.error(`provider-config: ${provider} FAIL (validate: ${validated.code} ${validated.detail || ""})`);
    failures += 1;
    continue;
  }
  const template = JSON.parse(readFileSync(TEMPLATE, "utf8"));
  const plan = buildSetupPlan(template, args, "db-id", {});
  const config = buildGeneratedConfig(template, plan);
  config.main = path.join(ROOT, config.main);
  if (config.assets?.directory) config.assets.directory = path.join(ROOT, config.assets.directory);
  const dir = path.join(ROOT, ".wrangler-provider-configs");
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `wrangler.${provider}.jsonc`);
  writeFileSync(file, JSON.stringify(config, null, 2), "utf8");
  const dry = await runCaptureWrangler(["deploy", "--dry-run", "--config", file, "--outdir", path.join(dir, `out-${provider}`)]);
  if (!dry.ok) {
    failures += 1;
    const reason = (dry.stderr || "").split("\n").filter(Boolean).slice(-3).join(" | ");
    console.error(`provider-config: ${provider} FAIL (${reason})`);
  } else {
    console.log(`provider-config: ${provider} PASS (wrangler dry-run accepted bindings and vars)`);
  }
}

if (failures > 0) {
  console.error(`provider-config: ${failures}/${providers.length} configs failed validation.`);
  process.exit(1);
}
console.log(`provider-config: ${providers.length}/${providers.length} generated configs accepted by wrangler.`);