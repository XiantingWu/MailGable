// Unique Git HEAD resolver for operator tooling.
//
// All commands (setup, provider:set, provider:remove, setup:deploy,
// setup:migrate, setup:remove-bootstrap, live-validation) resolve the
// current commit SHA through currentGitSha() — never by parsing
// .git/HEAD (which is a symlink target / ref: prefix and breaks on
// detached HEAD and worktrees).
export class OperatorStateError extends Error {
  constructor(code, detail = "") {
    super(`${code}${detail ? `: ${detail}` : ""}`);
    this.name = "OperatorStateError";
    this.code = code;
    this.detail = detail;
  }
}

export async function currentGitSha(runCapture) {
  const result = await runCapture("git", ["rev-parse", "HEAD"]);
  if (!result.ok) {
    throw new OperatorStateError("git_head_unavailable", (result.stderr || "").slice(0, 200));
  }
  const sha = String(result.stdout || "").trim();
  if (!/^[0-9a-f]{40}$/i.test(sha)) {
    throw new OperatorStateError("git_head_invalid", `'${sha.slice(0, 12)}' is not a 40-hex commit SHA.`);
  }
  return sha;
}