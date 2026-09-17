// Sole local credential source for MailGable operator tooling.
//
// Precedence (highest first):
//   1. explicitly supplied process environment (allowlisted keys only)
//   2. MAILBOX_CREDENTIALS_FILE (path to a credentials env file)
//   3. .mailbox/credentials.env
//
// .dev.vars and .env are intentionally NEVER read here: they belong to
// `npm run dev` / other tooling and must not act as production credential
// sources.
//
// Only CREDENTIAL_SCHEMA keys are ever loaded from the process
// environment; unrelated environment variables are ignored.
import { readFileSync, statSync, chmodSync, mkdirSync, writeFileSync, renameSync } from "node:fs";
import path from "node:path";
import process from "node:process";

export const DEFAULT_CREDENTIALS_FILE = path.join(process.cwd(), ".mailbox", "credentials.env");

// Unique credential schema with lifecycle metadata (Phase 22-23).
// role:
//   operator-local         local management/control-plane only; NEVER a
//                          Worker secret, Worker var, D1 row, argv, or log
//   runtime-persistent     installed as a Worker secret, long-lived
//   runtime-transient      installed temporarily (bootstrap), removable
// provider: common | resend | brevo | cloudflare | routing
export const CREDENTIAL_SCHEMA = [
  { key: "CLOUDFLARE_API_TOKEN", role: "operator-local", provider: "cloudflare" },
  { key: "CLOUDFLARE_ROUTING_READ_TOKEN", role: "runtime-persistent", provider: "routing" },
  { key: "AUTH_PEPPER", role: "runtime-persistent", provider: "common" },
  { key: "ADMIN_BOOTSTRAP_TOKEN", role: "runtime-transient", provider: "common" },
  { key: "RESEND_SETUP_API_KEY", role: "operator-local", provider: "resend" },
  { key: "RESEND_API_KEY", role: "runtime-persistent", provider: "resend" },
  { key: "RESEND_WEBHOOK_SECRET", role: "runtime-persistent", provider: "resend" },
  { key: "BREVO_SETUP_API_KEY", role: "operator-local", provider: "brevo" },
  { key: "BREVO_API_KEY", role: "runtime-persistent", provider: "brevo" },
  { key: "BREVO_WEBHOOK_TOKEN", role: "runtime-persistent", provider: "brevo" },
];

export const CREDENTIAL_KEYS = CREDENTIAL_SCHEMA.map((entry) => entry.key);
export const CREDENTIAL_KEY_SET = new Set(CREDENTIAL_KEYS);

// Phase 17: the three secret sets are distinct.
//  - RUNTIME_UPLOADABLE_SECRETS: may be installed as Worker secrets
//  - PROVIDER_ACTIVATION_REQUIREMENTS: must exist BEFORE provider:set
//  - DELIVERY_EVENT_SECRETS: optional delivery-event capability
export const RUNTIME_UPLOADABLE_SECRETS = new Set(
  CREDENTIAL_SCHEMA.filter((entry) => entry.role === "runtime-persistent" || entry.role === "runtime-transient").map((entry) => entry.key),
);
export const PROVIDER_ACTIVATION_REQUIREMENTS = {
  none: [],
  resend: ["RESEND_API_KEY"],
  brevo: ["BREVO_API_KEY"],
  cloudflare: [],
};
export const DELIVERY_EVENT_SECRETS = {
  resend: ["RESEND_WEBHOOK_SECRET"],
  brevo: ["BREVO_WEBHOOK_TOKEN"],
  cloudflare: [],
};

export const OPERATOR_LOCAL_CREDENTIALS = new Set(
  CREDENTIAL_SCHEMA.filter((entry) => entry.role === "operator-local").map((entry) => entry.key),
);

// Backward-compatible alias for code/docs that still say "setup-only".
export const SETUP_ONLY_CREDENTIALS = OPERATOR_LOCAL_CREDENTIALS;

export const TRANSIENT_CREDENTIALS = new Set(
  CREDENTIAL_SCHEMA.filter((entry) => entry.role === "runtime-transient").map((entry) => entry.key),
);

export const PERSISTENT_RUNTIME_SECRETS = new Set(
  CREDENTIAL_SCHEMA.filter((entry) => entry.role === "runtime-persistent").map((entry) => entry.key),
);

export const COMMON_RUNTIME_SECRETS = CREDENTIAL_SCHEMA
  .filter((entry) => (entry.provider === "common" || entry.provider === "routing") && entry.role === "runtime-persistent")
  .map((entry) => entry.key);

export const PROVIDER_RUNTIME_SECRETS = {
  none: [],
  resend: ["RESEND_API_KEY", "RESEND_WEBHOOK_SECRET"],
  brevo: ["BREVO_API_KEY", "BREVO_WEBHOOK_TOKEN"],
  cloudflare: [],
};

// Wrangler secrets.required per provider (Phase 24-25). Wrangler hard-fails
// deployment when a required secret is missing, so ONLY secrets without
// which the Worker cannot start belong here:
//   - AUTH_PEPPER always
//   - the provider send key when that provider is active
// Never: routing token (optional capability), webhook secrets (delivery
// event capability), bootstrap (transient), setup-only keys.
export function requiredSecretsFor(provider) {
  return ["AUTH_PEPPER", ...(PROVIDER_ACTIVATION_REQUIREMENTS[provider] || [])];
}

export function credentialRequiresFor(provider) {
  return PROVIDER_RUNTIME_SECRETS[provider] || [];
}

// Phase 21: proper serialization with escaping. CR/LF in a secret value is
// rejected outright (never silently modified).
export function serializeCredentialEnv(credentials) {
  const lines = [];
  for (const key of Object.keys(credentials).sort((a, b) => a.localeCompare(b))) {
    if (!CREDENTIAL_KEY_SET.has(key)) {
      throw new Error(`credential_key_unknown: '${key}' is not part of the credential schema.`);
    }
    const value = String(credentials[key]);
    if (/[\r\n]/.test(value)) {
      throw new Error(`credential_value_invalid: ${key} contains a line break.`);
    }
    const escaped = value
      .replace(/\\/g, "\\\\")
      .replace(/"/g, '\\"');
    lines.push(`${key}="${escaped}"`);
  }
  return lines.length > 0 ? lines.join("\n") + "\n" : "";
}

export function parseCredentialEnv(content) {
  const result = {};
  let sawEntry = false;
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    // KEY="escaped value" or KEY=value; backslash escapes \" and \\
    const match = trimmed.match(/^([A-Z0-9_]+)=(?:"((?:[^"\\]|\\.)*)"|([^"\s]*))$/);
    if (!match) throw new Error("malformed credentials line (expected KEY=\"value\")");
    sawEntry = true;
    const [, key, quoted, bare] = match;
    if (!CREDENTIAL_KEY_SET.has(key)) {
      throw new Error(`credential_key_unknown: '${key}' is not part of the credential schema.`);
    }
    const value = quoted === undefined ? bare : quoted.replace(/\\(["\\])/g, "$1");
    if (Object.prototype.hasOwnProperty.call(result, key)) {
      throw new Error(`duplicate credentials key: ${key}`);
    }
    result[key] = value;
  }
  return sawEntry ? result : {};
}

export function parseCredentialsEnv(content) {
  return parseCredentialEnv(content);
}

export function loadCredentials({ env = process.env, credentialsFile = "" } = {}) {
  const file = credentialsFile || env.MAILBOX_CREDENTIALS_FILE || DEFAULT_CREDENTIALS_FILE;
  const fromFile = {};
  try {
    statSync(file);
    fromFile.parse = parseCredentialsEnv(readFileSync(file, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") {
      fromFile.parse = {};
    } else {
      throw error;
    }
  }
  const fromProcess = {};
  for (const key of CREDENTIAL_KEYS) {
    const value = env[key];
    if (typeof value === "string" && value.length > 0) fromProcess[key] = value;
  }
  return { ...fromFile.parse, ...fromProcess };
}

// Per-key provenance for status reporting: "file" (the central store, or a
// custom MAILBOX_CREDENTIALS_FILE — the path itself is never reported),
// "env" (process environment, wins over the file), or "absent". Values,
// prefixes, suffixes, hashes, and lengths are never returned.
export function credentialSources({ env = process.env, credentialsFile = "" } = {}) {
  const file = credentialsFile || env.MAILBOX_CREDENTIALS_FILE || DEFAULT_CREDENTIALS_FILE;
  const fileKeys = new Set();
  try {
    const parsed = parseCredentialsEnv(readFileSync(file, "utf8"));
    for (const key of Object.keys(parsed)) fileKeys.add(key);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  const sources = {};
  for (const key of CREDENTIAL_KEYS) {
    if (typeof env[key] === "string" && env[key].length > 0) {
      sources[key] = "env";
    } else if (fileKeys.has(key)) {
      sources[key] = "file";
    } else {
      sources[key] = "absent";
    }
  }
  return sources;
}

export function setCredentialsFilePermissions(file) {
  try {
    statSync(file);
  } catch {
    return; // file absent; caller decides
  }
  try {
    chmodSync(file, 0o600);
  } catch {
    console.warn("credentials: could not enforce 0600 permissions on " + file);
  }
}

export function sanitizeKeyName(key) {
  return key.replace(/[^A-Z0-9_]/g, "_");
}

export function providerActiveCredentials(provider, credentials) {
  const names = [...COMMON_RUNTIME_SECRETS, ...(PROVIDER_RUNTIME_SECRETS[provider] || [])];
  const result = {};
  for (const name of names) {
    if (credentials[name]) result[name] = credentials[name];
  }
  return result;
}

// Phase 50: atomic credential write — serialize to a tmp file (0600),
// parse-back as a round-trip check, then rename over the canonical file.
// A crash mid-write can never leave a half-written credential store.
export function writeCredentialsFile(credentials, { credentialsFile = "" } = {}) {
  const file = credentialsFile || DEFAULT_CREDENTIALS_FILE;
  const serialized = serializeCredentialEnv(credentials);
  const tmp = `${file}.tmp`;
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(tmp, serialized, "utf8");
  chmodSync(tmp, 0o600);
  // Round-trip guarantee before the rename.
  const roundTrip = parseCredentialsEnv(serialized);
  const expected = {};
  for (const key of Object.keys(credentials)) {
    if (credentials[key] !== undefined && credentials[key] !== null && credentials[key] !== "") expected[key] = String(credentials[key]);
  }
  const normalized = {};
  for (const [key, value] of Object.entries(roundTrip)) {
    if (expected[key] !== undefined) normalized[key] = value;
  }
  for (const key of Object.keys(expected)) {
    if (roundTrip[key] !== expected[key]) throw new Error(`credentials: round-trip mismatch for ${key}.`);
  }
  renameSync(tmp, file);
  return file;
}

// Safe credential setter: updates one value through the atomic writer.
// The value is never printed to stdout. Only a missing file (ENOENT) is
// treated as an empty store; ANY other read or parse failure (permission,
// malformed syntax, duplicate key, disk I/O) hard-fails BEFORE writing, so
// a broken store can never be silently overwritten with a single key.
export function setCredential(name, value, { credentialsFile = "" } = {}) {
  const file = credentialsFile || DEFAULT_CREDENTIALS_FILE;
  const key = String(name).toUpperCase();
  if (!CREDENTIAL_KEY_SET.has(key)) {
    throw new Error(`credential_key_unknown: '${key}' is not part of the credential schema.`);
  }
  let existing = {};
  try {
    existing = parseCredentialsEnv(readFileSync(file, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") {
      existing = {};
    } else {
      throw new Error(`credentials: refusing to modify '${file}' because it cannot be read safely (${error.message}).`);
    }
  }
  existing[key] = String(value);
  writeCredentialsFile(existing, { credentialsFile: file });
  return file;
}