import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const [runtimeSync, configurator, provision, docs, routingUi] = await Promise.all([
  readFile("src/routing-sync.ts", "utf8"),
  readFile("scripts/configure-runtime-routing-sync.ps1", "utf8"),
  readFile("scripts/provision.ps1", "utf8"),
  readFile("docs/runtime-routing-sync.md", "utf8"),
  readFile("public/js/routing.mjs", "utf8"),
]);

test("runtime routing sync is read-only toward Cloudflare", () => {
  assert.match(runtimeSync, /email\/routing\/rules/);
  assert.match(runtimeSync, /method: "GET"/);
  assert.doesNotMatch(runtimeSync, /method:\s*"(?:POST|PUT|PATCH|DELETE)"/);
  assert.doesNotMatch(runtimeSync, /email\/routing[^\n]*(?:POST|PUT|PATCH|DELETE)/i);
  assert.match(runtimeSync, /CLOUDFLARE_ROUTING_READ_TOKEN/);
});

test("runtime routing configurator keeps deploy and routing-read credentials separated", () => {
  assert.match(configurator, /Assert-RoutingReadToken \$routingToken/);
  assert.match(configurator, /\$origin = Get-CanonicalWorkerOrigin/);
  assert.match(configurator, /\$env:CLOUDFLARE_API_TOKEN = \$deployToken[\s\S]*Set-WorkerSecret "CLOUDFLARE_ROUTING_READ_TOKEN" \$routingToken/);
  assert.doesNotMatch(configurator, /Authorization = "Bearer \$deployToken"/);
  assert.match(configurator, /Expected GET \$uri to return the canonical 308 redirect/);
  assert.match(configurator, /expectedHostPattern[\s\S]*workers\\\.dev/);
});

test("routine deployment cannot intentionally delete the runtime routing read secret", () => {
  assert.doesNotMatch(provision, /Remove-WranglerSecret[^\n]*CLOUDFLARE_ROUTING_READ_TOKEN/);
  assert.doesNotMatch(provision, /CLOUDFLARE_ROUTING_READ_TOKEN\s*=\s*\$null/);
  assert.match(docs, /Routine deploys preserve the existing Worker secret/);
});

test("runtime sync remains visibly observable even when the route set is unchanged", () => {
  assert.match(routingUi, /second: "2-digit"/);
  assert.match(routingUi, /syncing: "Syncing Cloudflare…"/);
  assert.match(routingUi, /syncFailed: "Sync failed · last state preserved"/);
  assert.match(docs, /timestamp to seconds/);
  assert.match(docs, /no-op comparison remains visibly observable/);
});

test("runtime sync documentation preserves the fail-safe and least-privilege contract", () => {
  assert.match(docs, /browser never receives a Cloudflare API token/i);
  assert.match(docs, /Email Routing Rules Read/);
  assert.match(docs, /If Cloudflare is unavailable[\s\S]*D1 is not changed/);
  assert.match(docs, /last successful comparison with Cloudflare/);
  assert.match(docs, /subsequent normal guarded deploy preserves the secret/);
});
