import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  deriveRoutingMailboxPlan,
  syncRoutingMailboxes,
} from "../.test-build/src/routing-sync.js";

class FakeStatement {
  constructor(database, sql, args = []) {
    this.database = database;
    this.sql = sql.replace(/\s+/g, " ").trim();
    this.args = args;
  }

  bind(...args) {
    return new FakeStatement(this.database, this.sql, args);
  }

  async all() {
    if (this.sql.startsWith("SELECT mailbox_id,address,can_receive,can_send,active")) {
      return { results: this.database.rows.map((row) => ({ ...row })) };
    }
    if (this.sql.startsWith("SELECT address,can_receive,can_send FROM mailboxes WHERE active=1 AND routing_managed=1")) {
      return {
        results: this.database.rows
          .filter((row) => Number(row.active) === 1 && Number(row.routing_managed) === 1)
          .sort((left, right) => left.address.localeCompare(right.address))
          .map((row) => ({ address: row.address, can_receive: row.can_receive, can_send: row.can_send })),
      };
    }
    throw new Error(`Unexpected all SQL: ${this.sql}`);
  }

  async run() {
    if (this.sql.startsWith("UPDATE mailboxes SET can_receive=?,can_send=1,active=1,routing_managed=1")) {
      const [canReceive, updatedAt, mailboxId] = this.args;
      const row = this.database.rows.find((item) => item.mailbox_id === mailboxId);
      if (!row) throw new Error(`Missing mailbox ${mailboxId}`);
      row.can_receive = canReceive;
      row.can_send = 1;
      row.active = 1;
      row.routing_managed = 1;
      row.updated_at = updatedAt;
      return { meta: { changes: 1 } };
    }
    if (this.sql.startsWith("INSERT INTO mailboxes")) {
      const [mailboxId, address, displayName, canReceive, createdAt, updatedAt] = this.args;
      this.database.rows.push({
        mailbox_id: mailboxId,
        address,
        display_name: displayName,
        can_receive: canReceive,
        can_send: 1,
        active: 1,
        routing_managed: 1,
        created_at: createdAt,
        updated_at: updatedAt,
      });
      return { meta: { changes: 1 } };
    }
    if (this.sql.startsWith("UPDATE mailboxes SET can_receive=0,can_send=0,active=0")) {
      const [updatedAt, mailboxId] = this.args;
      const row = this.database.rows.find((item) => item.mailbox_id === mailboxId);
      if (!row || Number(row.routing_managed) !== 1) return { meta: { changes: 0 } };
      row.can_receive = 0;
      row.can_send = 0;
      row.active = 0;
      row.updated_at = updatedAt;
      return { meta: { changes: 1 } };
    }
    throw new Error(`Unexpected run SQL: ${this.sql}`);
  }
}

class FakeDatabase {
  constructor(rows = []) {
    this.rows = rows.map((row) => ({ ...row }));
    this.batchCalls = 0;
  }

  prepare(sql) {
    return new FakeStatement(this, sql);
  }

  async batch(statements) {
    this.batchCalls += 1;
    const snapshot = this.rows.map((row) => ({ ...row }));
    try {
      const result = [];
      for (const statement of statements) result.push(await statement.run());
      return result;
    } catch (error) {
      this.rows = snapshot;
      throw error;
    }
  }
}

const envFor = (database) => ({
  DB: database,
  MAIL_DOMAIN: "example.com",
  MAIL_WORKER_NAME: "mailgable-dev",
  CLOUDFLARE_ZONE_ID: "00000000000000000000000000000000",
  CLOUDFLARE_ROUTING_READ_TOKEN: "routing-read-token-sentinel",
});

const workerRule = (id, address, worker = "mailgable-dev") => ({
  id,
  enabled: true,
  matchers: [{ type: "literal", field: "to", value: address }],
  actions: [{ type: "worker", value: [worker] }],
});

const forwardRule = (id, address) => ({
  id,
  enabled: true,
  matchers: [{ type: "literal", field: "to", value: address }],
  actions: [{ type: "forward", value: ["backup@example.com"] }],
});

function cloudflarePage(result, page, totalPages, totalCount = result.length) {
  return new Response(JSON.stringify({
    success: true,
    result,
    result_info: { page, total_pages: totalPages, total_count: totalCount },
  }), { status: 200, headers: { "Content-Type": "application/json" } });
}

test("derives route-managed identities purely from the Cloudflare routing snapshot", () => {
  const plan = deriveRoutingMailboxPlan([
    workerRule("r1", "Support@Example.com"),
    workerRule("r2", "user@example.com"),
    forwardRule("r3", "dev@example.com"),
    { ...workerRule("r4", "disabled@example.com"), enabled: false },
    workerRule("r5", "outside@example.org"),
  ], "example.com", "mailgable-dev");

  assert.deepEqual(plan, [
    { address: "dev@example.com", canReceive: false },
    { address: "support@example.com", canReceive: true },
    { address: "user@example.com", canReceive: true },
  ]);
  assert.deepEqual(
    deriveRoutingMailboxPlan([], "example.com", "mailgable-dev"),
    [],
    "no routes means no desired identities; nothing is hardcoded",
  );
});

test("fetches every Cloudflare page before atomically applying the routing mailbox plan", async () => {
  const database = new FakeDatabase([
    { mailbox_id: "support-existing", address: "support@example.com", can_receive: 0, can_send: 1, active: 1, routing_managed: 1 },
    { mailbox_id: "obsolete", address: "obsolete@example.com", can_receive: 1, can_send: 1, active: 1, routing_managed: 1 },
    { mailbox_id: "manual", address: "manual@example.com", can_receive: 1, can_send: 1, active: 1, routing_managed: 0 },
  ]);
  const env = envFor(database);
  const requests = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    requests.push({ page: Number(url.searchParams.get("page")), authorization: new Headers(init?.headers).get("Authorization") });
    if (url.searchParams.get("page") === "1") {
      return cloudflarePage([workerRule("r1", "support@example.com")], 1, 2, 3);
    }
    return cloudflarePage([
      workerRule("r2", "user@example.com"),
      forwardRule("r3", "dev@example.com"),
    ], 2, 2, 3);
  };

  try {
    const result = await syncRoutingMailboxes(env);
    assert.equal(result.ok, true);
    assert.equal(result.source, "cloudflare");
    assert.equal(result.route_count, 3);
    assert.equal(result.inserted, 2);
    assert.equal(result.changed, 1);
    assert.equal(result.deactivated, 1);
    assert.equal(database.batchCalls, 1);
    assert.deepEqual(requests.map((item) => item.page), [1, 2]);
    assert.ok(requests.every((item) => item.authorization === "Bearer routing-read-token-sentinel"));

    const activeManaged = database.rows
      .filter((row) => Number(row.active) === 1 && Number(row.routing_managed) === 1)
      .sort((left, right) => left.address.localeCompare(right.address));
    assert.deepEqual(activeManaged.map((row) => [row.address, row.can_receive, row.can_send]), [
      ["dev@example.com", 0, 1],
      ["support@example.com", 1, 1],
      ["user@example.com", 1, 1],
    ]);

    assert.equal(database.rows.find((row) => row.mailbox_id === "obsolete")?.active, 0);
    assert.equal(database.rows.find((row) => row.mailbox_id === "manual")?.active, 1, "non-routing-managed identities must be untouched");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("does not mutate D1 when the Cloudflare snapshot cannot be fetched completely", async () => {
  const originalRows = [
    { mailbox_id: "existing", address: "support@example.com", can_receive: 1, can_send: 1, active: 1, routing_managed: 1 },
  ];
  const database = new FakeDatabase(originalRows);
  const env = envFor(database);
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    if (url.searchParams.get("page") === "1") {
      return cloudflarePage([workerRule("r1", "support@example.com")], 1, 2, 2);
    }
    return new Response("upstream failure", { status: 503 });
  };

  try {
    await assert.rejects(
      syncRoutingMailboxes(env),
      (error) => error?.code === "routing_sync_upstream_failed",
    );
    assert.equal(database.batchCalls, 0);
    assert.deepEqual(database.rows, originalRows);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("fails closed before Cloudflare or D1 access when the runtime read credential is missing", async () => {
  const database = new FakeDatabase([]);
  const env = { ...envFor(database), CLOUDFLARE_ROUTING_READ_TOKEN: "" };
  const originalFetch = globalThis.fetch;
  let fetchCalled = false;
  globalThis.fetch = async () => {
    fetchCalled = true;
    throw new Error("must not fetch");
  };
  try {
    await assert.rejects(
      syncRoutingMailboxes(env),
      (error) => error?.code === "routing_sync_not_configured",
    );
    assert.equal(fetchCalled, false);
    assert.equal(database.batchCalls, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("admin UI performs active sync on page entry, refresh, and both routing status controls", async () => {
  const [indexSource, mailboxJs, appJs, html, configurator] = await Promise.all([
    readFile("src/index.ts", "utf8"),
    readFile("public/js/mailbox.mjs", "utf8"),
    readFile("public/js/app.mjs", "utf8"),
    readFile("public/index.html", "utf8"),
    readFile("scripts/configure-runtime-routing-sync.ps1", "utf8"),
  ]);

  assert.match(indexSource, /method === "POST" && pathname === "\/api\/routing-sync"/);
  assert.match(indexSource, /requireSession\(request, env, true\)/);
  assert.match(indexSource, /syncRoutingMailboxes\(env\)/);
  assert.match(indexSource, /"routing_sync"/);

  assert.match(mailboxJs, /await api\("\/api\/routing-sync", \{ method: "POST", body: "\{\}" \}\)/);
  assert.match(mailboxJs, /export async function showMail\(\)[\s\S]*\[loadConfig\(\), refreshMailboxView\(\{ notify: false \}\)\]/);
  assert.match(mailboxJs, /state\.mailbox = filter\.value/);
  assert.match(mailboxJs, /setSyncFailure/);
  assert.match(appJs, /\$\("refresh-button"\)\.addEventListener\("click", syncNow\)/);
  assert.match(appJs, /\$\("sync-status"\)\.addEventListener\("click", syncNow\)/);
  assert.match(appJs, /\$\("routing-sync-button"\)\.addEventListener\("click", syncNow\)/);
  assert.match(html, /<button id="sync-status"[^>]*type="button"/);
  assert.match(html, /<button id="routing-sync-button"[^>]*type="button"/);

  assert.match(configurator, /Email Routing Rules Read/);
  assert.match(configurator, /CLOUDFLARE_ROUTING_READ_TOKEN/);
  assert.match(configurator, /wrangler secret put \$Name/);
  assert.doesNotMatch(configurator, /Write-Host[^\n]*(?:\$routingToken|\$deployToken|CLOUDFLARE_API_TOKEN\s*=)/);
});
