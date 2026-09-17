import { execFileSync } from "node:child_process";

const ALLOWED_NAME = "XiantingWu";
const ALLOWED_EMAIL = "319609216+XiantingWu@users.noreply.github.com";
const FORBIDDEN_TRAILERS = [
  "Co-authored-by:",
  "on-behalf-of:",
  "Generated-by:",
  "Created-by:",
  "Assisted-by:",
  "AI-generated-by:",
];
const FORBIDDEN_BODIES = [
  "OpenAI",
  "Anthropic",
  "GitHub Copilot",
  "Cursor",
  "Codex",
  "Claude Code",
];

const git = (...args) => execFileSync("git", args, { encoding: "utf8" });

const arg = process.argv.slice(2);
const headOnly = arg.includes("--head-only");
const rangeIndex = arg.indexOf("--range");
const range = rangeIndex >= 0 ? arg[rangeIndex + 1] : null;

let fmt;
if (headOnly) {
  fmt = git("show", "-s", "--format=%H%x09%an%x09%ae%x09%cn%x09%ce%n%B%n---", "HEAD");
} else if (range) {
  fmt = git("log", "--format=%H%x09%an%x09%ae%x09%cn%x09%ce%n%B%n---", range);
} else {
  fmt = git("log", "--all", "--format=%H%x09%an%x09%ae%x09%cn%x09%ce%n%B%n---");
}

let failures = [];
let commitCount = 0;
let totalCommits = 0;

for (const block of fmt.split("\n---\n")) {
  const lines = block.trim().split("\n");
  if (!lines.length || !lines[0].trim()) continue;
  totalCommits += 1;
  const [hash, an, ae, cn, ce] = lines[0].split("\t");
  const message = lines.slice(1).join("\n");
  const problems = [];
  const checkIdentity = (label, name, email) => {
    if (name !== ALLOWED_NAME) problems.push(`${label} name '${name}' != '${ALLOWED_NAME}'`);
    if (email !== ALLOWED_EMAIL) problems.push(`${label} email '${email}' != '${ALLOWED_EMAIL}'`);
  };
  // GitHub's PR merge bot creates merge commits as a platform artifact
  // (author = the PR author's account, committer = GitHub bot). These are
  // not person-authored commits and are exempt from the identity policy,
  // but still subject to the forbidden-trailer/body checks below.
  const platformCommitter = cn === "GitHub" && ce === "noreply@github.com";
  const githubMergeBot = /^Merge pull request #\d+/m.test(message) && platformCommitter;
  // GitHub squash/rebase merges keep the PR author as the commit author and
  // record the platform as the committer. Accept them only when the author is
  // the allowed identity; the committer is a platform artifact, not a person.
  const githubSquashMerge = platformCommitter && an === ALLOWED_NAME && ae === ALLOWED_EMAIL;
  if (!githubMergeBot && !githubSquashMerge) {
    checkIdentity("author", an, ae);
    checkIdentity("committer", cn, ce);
  }
  for (const trailer of FORBIDDEN_TRAILERS) {
    if (new RegExp("^" + trailer, "mi").test(message)) problems.push(`forbidden trailer '${trailer}'`);
  }
  for (const body of FORBIDDEN_BODIES) {
    if (new RegExp("^" + body + ":", "mi").test(message)) problems.push(`forbidden attribution body '${body}'`);
  }
  commitCount += 1;
  if (problems.length) {
    failures.push(`commit ${hash.slice(0, 12)}: ${problems.join("; ")}`);
  }
}

if (failures.length) {
  for (const failure of failures) console.error(`verify-attribution: FAIL ${failure}`);
  console.error(`verify-attribution: ${failures.length} of ${commitCount} commits violate the XiantingWu-only attribution policy.`);
  process.exit(1);
}

console.log(`verify-attribution: PASS (${commitCount} commits, XiantingWu-only, no forbidden trailers).`);