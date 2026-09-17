import { readFile, readdir } from "node:fs/promises";
import path from "node:path";

const FORBIDDEN = [
  "source-parts",
  "npm run generate",
  "generate-sources.mjs",
  "REQUIRED_INBOUND_FORWARD_ADDRESSES",
  "REQUIRED_AUTO_BCC_ADDRESSES",
  "Catoracle",
  "Catarot",
];

// Resend-centric phrasing that must not appear in generic outbound docs.
const FORBIDDEN_PATTERNS = [
  { pattern: /Resend is the only outbound provider/i, note: "provider-neutral docs required" },
  { pattern: /23h applies to every provider|23-hour retry window applies to all/i, note: "retry windows are provider-specific" },
  { pattern: /All provider webhooks are cryptographically signed/i, note: "webhook trust models differ per provider" },
  { pattern: /RESEND_API_KEY controls compose/i, note: "compose depends on the configured provider" },
  { pattern: /resend_email_id is the canonical API field/i, note: "API uses provider/provider_message_id" },
];

const ALLOWLIST = [
  { pattern: /CHANGELOG\.md/, text: "source-parts" },
  { pattern: /CONTRIBUTING\.md/, text: "source-parts" },
  { pattern: /docs\/MIGRATIONS\.md/, text: "source-parts" },
  { pattern: /CHANGELOG\.md/, text: "generate" },
  { pattern: /scripts\/README\.md/, text: "run-tests" },
  { pattern: /scripts\/verify-public-docs\.mjs/, text: "generate-sources.mjs" },
];

async function filesUnder(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  const results = [];
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) results.push(...await filesUnder(full));
    else results.push(full);
  }
  return results;
}

const targets = [
  "README.md",
  "CONTRIBUTING.md",
  "SECURITY.md",
  "SUPPORT.md",
  "CHANGELOG.md",
  "package.json",
  "wrangler.jsonc",
  ".dev.vars.example",
  "ops.env.example",
  ...(await filesUnder("docs")),
  ...(await filesUnder("scripts")).filter((name) => name.endsWith(".md")),
  ...(await filesUnder(".github")),
];

const failures = [];
for (const target of targets) {
  let content;
  try {
    content = await readFile(target, "utf8");
  } catch {
    continue;
  }
  for (const term of FORBIDDEN) {
    const lower = content.toLowerCase();
    const termLower = term.toLowerCase();
    if (!lower.includes(termLower)) continue;
    const allowed = ALLOWLIST.some(({ pattern, text }) => pattern.test(target) && lower.includes(text.toLowerCase()));
    if (!allowed) failures.push(`${target}: stale reference '${term}'`);
  }
  for (const { pattern, note } of FORBIDDEN_PATTERNS) {
    if (pattern.test(content)) failures.push(`${target}: ${note}`);
  }
}

if (failures.length) {
  for (const failure of failures) console.error(`verify-public-docs: FAIL ${failure}`);
  console.error(`verify-public-docs: ${failures.length} stale reference(s) found.`);
  process.exit(1);
}

// English-only documentation policy: the repository keeps a single English
// README, never references a Chinese translation, and never claims a
// bilingual product surface. Email payload language is unaffected.
async function exists(target) {
  try {
    await readFile(target, "utf8");
    return true;
  } catch {
    return false;
  }
}
const zhReadmeMissing = !(await exists("README.zh-CN.md"));
const zhReadmeReferenceAbsent = !(await readFile("README.md", "utf8")).includes("README.zh-CN.md");
const bilingualClaimAbsent = !/bilingual|简体中文|中文\(English\)/i.test(await readFile("README.md", "utf8"));
if (!zhReadmeMissing || !zhReadmeReferenceAbsent || !bilingualClaimAbsent) {
  console.error("verify-public-docs: FAIL English-only documentation contract (Chinese README/link/bilingual claim present).");
  process.exit(1);
}
console.log("verify-public-docs: PASS (no stale public references, English-only contract).");