// Unique operator-state module. Every operator command reads and validates
// the three state files through this module:
//
//   .mailbox/config.json          (non-secret operator intent)
//   .setup-state.json             (resource state discovered by setup)
//   wrangler.deploy.jsonc         (canonical generated deployment config)
//
// validateOperatorState() compares all three against the current Git HEAD
// and fails closed on any mismatch with a stable error code.
import { readFileSync, writeFileSync, renameSync, mkdirSync, rmSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { createHash } from "node:crypto";
import { canonicalOperatorConfig } from "./operator-config.mjs";

export const STATE_FILE = path.join(process.cwd(), ".setup-state.json");
export const CONFIG_FILE = path.join(process.cwd(), ".mailbox", "config.json");
export const GENERATED_FILE = path.join(process.cwd(), "wrangler.deploy.jsonc");
export const OPERATION_JOURNAL_FILE = path.join(process.cwd(), ".mailbox", "provider-operation.json");
export const CREDENTIAL_OPERATION_JOURNAL_FILE = path.join(process.cwd(), ".mailbox", "credential-operation.json");

export const OPERATOR_STATE_SCHEMA_VERSION = 1;

export const OPERATOR_STATE_ERRORS = [
  "operator_state_missing",
  "operator_state_rc_mismatch",
  "operator_state_worker_mismatch",
  "operator_state_d1_mismatch",
  "operator_state_r2_mismatch",
  "operator_state_domain_mismatch",
  "operator_state_zone_mismatch",
  "operator_state_account_mismatch",
  "operator_state_provider_mismatch",
  "operator_state_config_hash_mismatch",
  "generated_config_missing",
  "generated_config_invalid",
];

export class OperatorStateError extends Error {
  constructor(code, detail = "") {
    super(`${code}${detail ? `: ${detail}` : ""}`);
    this.name = "OperatorStateError";
    this.code = code;
    this.detail = detail;
  }
}

// Recursive object key sort, arrays preserved, UTF-8, no whitespace
// dependence — a formatting change never produces a fake mismatch.
export function canonicalJson(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
}

export function sha256Hex(input) {
  return createHash("sha256").update(input, "utf8").digest("hex");
}

export function generatedConfigHash(generated) {
  return sha256Hex(canonicalJson(generated));
}

export function loadSetupState() {
  try {
    const parsed = JSON.parse(readFileSync(STATE_FILE, "utf8"));
    return typeof parsed === "object" && parsed !== null ? parsed : null;
  } catch {
    return null;
  }
}

export function loadGeneratedConfig() {
  try {
    return JSON.parse(readFileSync(GENERATED_FILE, "utf8"));
  } catch {
    return null;
  }
}

// Atomic JSON write: tmp file + validate-by-parse + rename.
export function writeJsonAtomic(file, value) {
  const tmp = `${file}.tmp`;
  mkdirSync(path.dirname(file), { recursive: true });
  const serialized = `${JSON.stringify(value, null, 2)}\n`;
  // Parse-back before rename guarantees the tmp file is valid JSON.
  JSON.parse(serialized);
  writeFileSync(tmp, serialized, "utf8");
  renameSync(tmp, file);
}

export function writeSetupState(state) {
  writeJsonAtomic(STATE_FILE, state);
}

export function writeOperatorConfig(config) {
  writeJsonAtomic(CONFIG_FILE, canonicalOperatorConfig(config));
}

export function writeGeneratedConfig(config) {
  writeJsonAtomic(GENERATED_FILE, config);
}

function d1DatabaseOf(generated) {
  return Array.isArray(generated.d1_databases) ? generated.d1_databases[0] : null;
}

function r2BucketOf(generated) {
  return Array.isArray(generated.r2_buckets) ? generated.r2_buckets[0] : null;
}

function failOn(firstMismatch) {
  throw new OperatorStateError(firstMismatch.code, firstMismatch.detail);
}

// Exact three-way (plus HEAD) validation. Every field must agree across
// setup state, operator config, and the generated config; the state hash
// must equal the hash of the current generated config; rc_sha must equal
// the current HEAD. Any mismatch fails closed.
export function validateOperatorState({ operatorConfig, setupState, generatedConfig, currentSha }) {
  if (!setupState) throw new OperatorStateError("operator_state_missing", "no .setup-state.json — run the full production setup first.");
  if (!generatedConfig) throw new OperatorStateError("generated_config_missing", "no wrangler.deploy.jsonc — run the full production setup first.");
  if (typeof generatedConfig !== "object" || Array.isArray(generatedConfig)) {
    throw new OperatorStateError("generated_config_invalid", "wrangler.deploy.jsonc is not a JSON object.");
  }

  const mismatches = [];
  if (setupState.schema_version !== OPERATOR_STATE_SCHEMA_VERSION) {
    mismatches.push({ code: "operator_state_missing", detail: `unexpected setup-state schema_version ${setupState.schema_version}.` });
  }
  if (setupState.rc_sha !== currentSha) {
    mismatches.push({ code: "operator_state_rc_mismatch", detail: `state rc_sha ${setupState.rc_sha} != HEAD ${currentSha}.` });
  }
  const workerName = setupState.worker_name;
  if (workerName !== operatorConfig.worker_name || workerName !== generatedConfig.name || workerName !== generatedConfig.vars?.MAIL_WORKER_NAME) {
    mismatches.push({ code: "operator_state_worker_mismatch", detail: "worker name differs across state/config/generated." });
  }
  const d1 = d1DatabaseOf(generatedConfig);
  if (!d1) {
    mismatches.push({ code: "operator_state_d1_mismatch", detail: "generated config has no D1 database." });
  } else {
    if (setupState.d1_name !== operatorConfig.d1_name || setupState.d1_name !== d1.database_name) {
      mismatches.push({ code: "operator_state_d1_mismatch", detail: "D1 name differs across state/config/generated." });
    }
    if (setupState.d1_database_id !== d1.database_id) {
      mismatches.push({ code: "operator_state_d1_mismatch", detail: "D1 database id differs between state and generated." });
    }
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(setupState.d1_database_id || "")) {
      mismatches.push({ code: "operator_state_d1_mismatch", detail: "setup state D1 id is not a UUID." });
    }
  }
  const r2 = r2BucketOf(generatedConfig);
  if (!r2) {
    mismatches.push({ code: "operator_state_r2_mismatch", detail: "generated config has no R2 bucket." });
  } else if (setupState.r2_name !== operatorConfig.r2_name || setupState.r2_name !== r2.bucket_name) {
    mismatches.push({ code: "operator_state_r2_mismatch", detail: "R2 name differs across state/config/generated." });
  }
  if (setupState.mail_domain !== operatorConfig.mail_domain || setupState.mail_domain !== generatedConfig.vars?.MAIL_DOMAIN) {
    mismatches.push({ code: "operator_state_domain_mismatch", detail: "mail domain differs across state/config/generated." });
  }
  if (setupState.cloudflare_zone_id !== operatorConfig.cloudflare_zone_id || setupState.cloudflare_zone_id !== generatedConfig.vars?.CLOUDFLARE_ZONE_ID) {
    mismatches.push({ code: "operator_state_zone_mismatch", detail: "zone id differs across state/config/generated." });
  }
  if (setupState.cloudflare_account_id !== operatorConfig.cloudflare_account_id) {
    mismatches.push({ code: "operator_state_account_mismatch", detail: "Cloudflare account id differs between state and operator config." });
  }
  if (setupState.outbound_provider !== operatorConfig.outbound_provider || setupState.outbound_provider !== generatedConfig.vars?.OUTBOUND_PROVIDER) {
    mismatches.push({ code: "operator_state_provider_mismatch", detail: "active provider differs across state/config/generated." });
  }
  const actualHash = generatedConfigHash(generatedConfig);
  if (setupState.config_hash !== actualHash) {
    mismatches.push({ code: "operator_state_config_hash_mismatch", detail: "generated config has been modified or the state hash is stale." });
  }
  if (mismatches.length > 0) failOn(mismatches[0]);
  return {
    ok: true,
    workerName,
    d1Name: setupState.d1_name,
    d1DatabaseId: setupState.d1_database_id,
    r2Name: setupState.r2_name,
    mailDomain: setupState.mail_domain,
    zoneId: setupState.cloudflare_zone_id,
    outboundProvider: setupState.outbound_provider,
    configHash: actualHash,
  };
}

export function readOperationJournal() {
  try {
    const parsed = JSON.parse(readFileSync(OPERATION_JOURNAL_FILE, "utf8"));
    return typeof parsed === "object" && parsed !== null ? parsed : null;
  } catch {
    return null;
  }
}

export function writeOperationJournal(journal) {
  writeJsonAtomic(OPERATION_JOURNAL_FILE, journal);
}

export function clearOperationJournal() {
  // Cross-platform repeat-safe clear: no .done rename games; subsequent
  // operations never depend on a stale destination.
  rmSync(OPERATION_JOURNAL_FILE, { force: true });
}

// Credential rotation journal (.mailbox/credential-operation.json).
// Contains ONLY non-secret metadata — operation, key, phase, started_at,
// worker_name — never the old/new value, hash, prefix, or suffix. A
// rotation that fails after the local write keeps this journal so
// credentials:recover can converge the Worker from the current local value.
export const CREDENTIAL_OPERATION_SCHEMA_VERSION = 1;

export function readCredentialOperationJournal() {
  try {
    const parsed = JSON.parse(readFileSync(CREDENTIAL_OPERATION_JOURNAL_FILE, "utf8"));
    return typeof parsed === "object" && parsed !== null ? parsed : null;
  } catch {
    return null;
  }
}

export function writeCredentialOperationJournal(journal) {
  writeJsonAtomic(CREDENTIAL_OPERATION_JOURNAL_FILE, journal);
}

export function clearCredentialOperationJournal() {
  rmSync(CREDENTIAL_OPERATION_JOURNAL_FILE, { force: true });
}