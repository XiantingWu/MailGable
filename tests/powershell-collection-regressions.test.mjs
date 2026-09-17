import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";

const collectionScripts = [
  "scripts/preflight-production.ps1",
  "scripts/provision.ps1",
  "scripts/reconcile-legacy-resources.ps1",
  "scripts/restore-email-routing.ps1",
];

test("PowerShell generic collection returns are materialized safely", async () => {
  for (const file of collectionScripts) {
    const source = await readFile(file, "utf8");
    assert.doesNotMatch(source, /return @\(\$all\)/, `${file} uses the invalid generic-list return form`);
    assert.match(source, /return \$all\.ToArray\(\)/, `${file} must materialize its generic list`);
  }
  const preflight = await readFile("scripts/preflight-production.ps1", "utf8");
  assert.doesNotMatch(preflight, /checks=@\(\$checks\)/);
  assert.match(preflight, /checks=\$checks\.ToArray\(\)/);

  const candidates = process.platform === "win32" ? ["pwsh.exe"] : ["pwsh", "pwsh.exe"];
  let shell = "";
  for (const candidate of candidates) {
    const probe = spawnSync(candidate, ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", "exit 0"], { encoding: "utf8" });
    if (!probe.error && probe.status === 0) {
      shell = candidate;
      break;
    }
  }
  assert.ok(shell, "PowerShell Core is required for collection regression tests.");

  const command = "$all = New-Object System.Collections.Generic.List[object]; $all.Add([pscustomobject]@{ name = 'sentinel' }); $result = $all.ToArray(); if ($result.Count -ne 1 -or $result[0].name -ne 'sentinel') { exit 1 }; Write-Output 'COLLECTION_RETURN_OK'";
  const result = spawnSync(shell, ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", command], { encoding: "utf8" });
  assert.equal(result.error, undefined, result.error?.message);
  assert.equal(result.status, 0, `${result.stdout ?? ""}\n${result.stderr ?? ""}`);
  assert.match(result.stdout ?? "", /COLLECTION_RETURN_OK/);
});
