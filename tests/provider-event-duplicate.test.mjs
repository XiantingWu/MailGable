// PROVIDER DELIVERY-EVENT DUPLICATE AUDIT (Stage 6/7).
//
// Regression closure for the duplicate-webhook no-op guarantee:
//   - a sequential duplicate (same provider + provider_event_id already
//     processed) must NOT re-mutate mail_messages.status,
//     recipient_status_json, or updated_at — it is a strict no-op
//   - out-of-order events must never downgrade a terminal/delivered state
//   - concurrent duplicates converge to exactly one delivery-event row
//     with deterministic message status and no uncaught unique error
//   - an event whose status update failed BEFORE the final insert is NOT
//     treated as processed: a later retry re-enters the pipeline
//
// The fast path is an existence pre-check; the final INSERT OR IGNORE and
// UNIQUE(provider, provider_event_id) remain the concurrent race guard.
import test from "node:test";
import assert from "node:assert/strict";

const events = await import("../.test-build/src/providers/events.js");
const { normalizeResendEvent, normalizeBrevoEvent, applyDeliveryEvent } = events;

function seedMessage(overrides = {}) {
  return {
    message_id: "msg-1",
    direction: "outgoing",
    status: "sending",
    outbound_provider: "resend",
    provider_message_id: "re_1",
    provider_internet_message_id: "",
    recipient_status_json: "{}",
    updated_at: "2026-09-01T00:00:00.000Z",
    subject: "test",
    ...overrides,
  };
}

// In-memory D1 mock covering every statement applyDeliveryEvent issues.
// `state` exposes the messages map, delivery-event rows, and a mutable
// failStatusUpdate flag for failure-injection.
function makeDb() {
  const messages = new Map();
  const events = [];
  const state = { messages, events, failStatusUpdate: false };
  const db = {
    prepare(sql) {
      return {
        bind(...args) {
          const stmt = {
            async first() {
              if (sql.includes("FROM mail_delivery_events WHERE provider=")) {
                const [provider, eventId] = args;
                return events.find((e) => e.provider === provider && e.provider_event_id === eventId) || null;
              }
              if (sql.includes("SELECT recipient_status_json FROM mail_messages WHERE message_id=")) {
                const m = messages.get(args[0]);
                return m ? { recipient_status_json: m.recipient_status_json } : null;
              }
              if (sql.includes("FROM mail_messages WHERE outbound_provider=")) {
                const [provider, pmid] = args;
                return [...messages.values()].find((m) => m.outbound_provider === provider && m.provider_message_id === pmid) || null;
              }
              if (sql.includes("FROM mail_messages WHERE message_id=?") && sql.includes("direction")) {
                return messages.get(args[0]) || null;
              }
              return null;
            },
            async run() {
              if (sql.startsWith("UPDATE mail_messages")) {
                const m = messages.get(args[4]);
                if (!m || state.failStatusUpdate) return { meta: { changes: 0 } };
                if (m.recipient_status_json !== args[5]) return { meta: { changes: 0 } };
                m.status = args[0];
                m.recipient_status_json = args[1];
                if (args[2]) m.provider_message_id = args[2];
                m.updated_at = args[3];
                return { meta: { changes: 1 } };
              }
              if (sql.startsWith("INSERT OR IGNORE INTO mail_delivery_events")) {
                const [eventId, provider, providerEventId, providerMessageId, messageId, eventType, status, recipientJson, occurredAt, receivedAt] = args;
                if (events.some((e) => e.provider === provider && e.provider_event_id === providerEventId)) {
                  return { meta: { changes: 0 } };
                }
                events.push({
                  event_id: eventId, provider, provider_event_id: providerEventId, provider_message_id: providerMessageId,
                  message_id: messageId, event_type: eventType, status, recipient_json: recipientJson,
                  occurred_at: occurredAt, received_at: receivedAt,
                });
                return { meta: { changes: 1 } };
              }
              return { meta: { changes: 1 } };
            },
          };
          return stmt;
        },
      };
    },
  };
  return { db, state };
}

function countEvents(state, provider, eventId) {
  return state.events.filter((e) => e.provider === provider && e.provider_event_id === eventId).length;
}

test("Resend sequential duplicate is a strict no-op (status, recipient summary, updated_at untouched)", async () => {
  const { db, state } = makeDb();
  state.messages.set("msg-1", seedMessage());
  const payload = { type: "email.delivered", data: { email_id: "re_1", to: "a@example.net" }, created_at: "2026-09-03T12:00:00Z" };
  const first = await applyDeliveryEvent({ DB: db }, normalizeResendEvent(payload, "EVENT_A"));
  assert.equal(first.duplicate, false, "first delivery of EVENT_A is accepted");
  assert.equal(countEvents(state, "resend", "EVENT_A"), 1);
  assert.equal(state.messages.get("msg-1").status, "delivered");
  const before = {
    status: state.messages.get("msg-1").status,
    recipient: state.messages.get("msg-1").recipient_status_json,
    updatedAt: state.messages.get("msg-1").updated_at,
  };

  const replay = await applyDeliveryEvent({ DB: db }, normalizeResendEvent(payload, "EVENT_A"));
  assert.equal(replay.duplicate, true, "identical svix-id replay is a duplicate");
  assert.equal(countEvents(state, "resend", "EVENT_A"), 1, "delivery event count does not increase");
  const after = {
    status: state.messages.get("msg-1").status,
    recipient: state.messages.get("msg-1").recipient_status_json,
    updatedAt: state.messages.get("msg-1").updated_at,
  };
  assert.deepEqual(after, before, "duplicate webhook leaves status, recipient_status_json, and updated_at unchanged");
});

test("Brevo sequential duplicate produces one deterministic id and no message mutation", async () => {
  const { db, state } = makeDb();
  state.messages.set("msg-1", seedMessage({ outbound_provider: "brevo", provider_message_id: "brevo-9" }));
  const payload = {
    event: "delivered", "message-id": "brevo-9", email: "a@example.net",
    ts_event: "2026-09-03T12:00:00Z", tags: [],
  };
  const first = await applyDeliveryEvent({ DB: db }, await normalizeBrevoEvent(payload, "tok", "tok"));
  assert.equal(first.duplicate, false);
  assert.equal(state.messages.get("msg-1").status, "delivered");
  const before = state.messages.get("msg-1").updated_at;

  const replay = await applyDeliveryEvent({ DB: db }, await normalizeBrevoEvent(payload, "tok", "tok"));
  assert.equal(replay.duplicate, true, "same provider message + recipient + event + timestamp dedupe");
  assert.equal(countEvents(state, "brevo", (await normalizeBrevoEvent(payload, "tok", "tok")).providerEventId), 1);
  assert.equal(state.messages.get("msg-1").updated_at, before, "duplicate Brevo event is a no-op");
});

test("out-of-order: delivered then deferred never downgrades", async () => {
  const { db, state } = makeDb();
  state.messages.set("msg-1", seedMessage());
  const delivered = { type: "email.delivered", data: { email_id: "re_1", to: "a@example.net" } };
  const deferred = { type: "email.deferred", data: { email_id: "re_1", to: "a@example.net" } };
  await applyDeliveryEvent({ DB: db }, normalizeResendEvent(delivered, "EV_D"));
  await applyDeliveryEvent({ DB: db }, normalizeResendEvent(deferred, "EV_DF"));
  assert.equal(state.messages.get("msg-1").status, "delivered", "a later deferred never downgrades delivered");
});

test("out-of-order: bounced then delivered never reverses a terminal failure", async () => {
  const { db, state } = makeDb();
  state.messages.set("msg-1", seedMessage());
  await applyDeliveryEvent({ DB: db }, normalizeResendEvent({ type: "email.bounced", data: { email_id: "re_1", to: "a@example.net" } }, "EV_B"));
  assert.equal(state.messages.get("msg-1").status, "bounced");
  await applyDeliveryEvent({ DB: db }, normalizeResendEvent({ type: "email.delivered", data: { email_id: "re_1", to: "a@example.net" } }, "EV_D2"));
  assert.equal(state.messages.get("msg-1").status, "bounced", "delivered replay cannot undo a terminal bounce");
});

test("out-of-order: complained replay delivered never rolls back", async () => {
  const { db, state } = makeDb();
  state.messages.set("msg-1", seedMessage());
  await applyDeliveryEvent({ DB: db }, normalizeResendEvent({ type: "email.complained", data: { email_id: "re_1", to: "a@example.net" } }, "EV_C"));
  assert.equal(state.messages.get("msg-1").status, "complained");
  await applyDeliveryEvent({ DB: db }, normalizeResendEvent({ type: "email.delivered", data: { email_id: "re_1", to: "a@example.net" } }, "EV_D3"));
  assert.equal(state.messages.get("msg-1").status, "complained", "complaint is monotonic");
});

test("concurrent duplicate converges to one event row with deterministic status and no uncaught error", async () => {
  const { db, state } = makeDb();
  state.messages.set("msg-1", seedMessage());
  const event = normalizeResendEvent({ type: "email.delivered", data: { email_id: "re_1", to: "a@example.net" } }, "EV_CONC");
  const results = await Promise.all([applyDeliveryEvent({ DB: db }, event), applyDeliveryEvent({ DB: db }, event)]);
  assert.equal(countEvents(state, "resend", "EV_CONC"), 1, "exactly one delivery-event row survives the race");
  assert.equal(state.messages.get("msg-1").status, "delivered", "message status is deterministic");
  assert.deepEqual([...new Set(results.map((r) => r.duplicate))].sort(), [false, true], "one accepted, one duplicate");
});

test("failure before the final insert leaves the event reprocessable on retry", async () => {
  const { db, state } = makeDb();
  state.messages.set("msg-1", seedMessage());
  state.failStatusUpdate = true;
  const event = normalizeResendEvent({ type: "email.delivered", data: { email_id: "re_1", to: "a@example.net" } }, "EV_FAIL");
  await assert.rejects(
    () => applyDeliveryEvent({ DB: db }, event),
    (error) => error.code === "webhook_concurrent_update",
    "status update failure propagates before the final insert",
  );
  assert.equal(countEvents(state, "resend", "EV_FAIL"), 0, "no event row was written");

  state.failStatusUpdate = false;
  const retry = await applyDeliveryEvent({ DB: db }, event);
  assert.equal(retry.duplicate, false, "the retry re-enters the pipeline and is not skipped as processed");
  assert.equal(countEvents(state, "resend", "EV_FAIL"), 1, "the event is finally recorded");
  assert.equal(state.messages.get("msg-1").status, "delivered", "the retry converges the message state");
});
