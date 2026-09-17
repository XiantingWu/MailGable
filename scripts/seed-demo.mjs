#!/usr/bin/env node
// Seeds synthetic demo data into the LOCAL D1 SQLite database only.
// --remote or any non-local mode is rejected: demo mail must never touch a
// real mailbox. All data uses example-domain addresses and fictional names.
import { DatabaseSync } from "node:sqlite";
function walkSync(dir) {
  const { readdirSync, statSync } = require("node:fs");
  const results = [];
  for (const name of readdirSync(dir)) {
    const full = `${dir}/${name}`;
    if (statSync(full).isDirectory()) results.push(...walkSync(full));
    else results.push(full);
  }
  return results;
}
import { access, readdir } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const args = process.argv.slice(2);
if (args.includes("--remote") || args.includes("--remote=true")) {
  console.error("seed-demo: refusing to run against a remote database. This script is --local only.");
  process.exit(1);
}
if (args.includes("--help") || args.includes("-h")) {
  console.log(`MailGable demo data seeder (local only)

Usage:
  node scripts/seed-demo.mjs [--d1 PATH]

Seeds synthetic mailboxes, threads, messages, attachments, and delivery
events into the LOCAL Wrangler D1 SQLite file. Refuses --remote. All data
uses example-domain addresses.`);
  process.exit(0);
}

const d1ArgIndex = args.indexOf("--d1");
const d1Path = d1ArgIndex >= 0 ? args[d1ArgIndex + 1] : "";

async function findLocalD1() {
  if (d1Path) return d1Path;
  const stateDir = path.join(process.cwd(), ".wrangler", "state", "v3", "d1");
  const entries = await readdir(stateDir).catch(() => []);
  const databases = entries.filter((name) => name.endsWith(".sqlite") && !name.endsWith("metadata.sqlite")).sort();
  if (!databases.length) {
    console.error("seed-demo: no local D1 SQLite found under .wrangler/state/v3/d1. Run 'npm run dev' once first.");
    process.exit(1);
  }
  return path.join(stateDir, databases.at(-1));
}

const databasePath = await findLocalD1();
try {
  await access(databasePath);
} catch {
  console.error(`seed-demo: local D1 SQLite does not exist: ${databasePath}`);
  process.exit(1);
}
const database = new DatabaseSync(databasePath);
const now = "2026-09-02T12:00:00.000Z";

function insertMailbox(mailboxId, address, displayName) {
  database.prepare(
    "INSERT OR IGNORE INTO mailboxes(mailbox_id,address,display_name,can_receive,can_send,active,created_at,updated_at) VALUES(?,?,?,1,1,1,?,?)",
  ).run(mailboxId, address, displayName, now, now);
}

function insertThread(threadId, mailboxId, subject, participants, status, lastAt) {
  database.prepare(
    "INSERT OR IGNORE INTO mail_threads(thread_id,mailbox_id,subject,participants_json,last_message_at,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)",
  ).run(threadId, mailboxId, subject, JSON.stringify(participants), lastAt, status, now, now);
}

function insertMessage({
  messageId, threadId, mailboxId, direction, envelopeFrom, envelopeTo,
  subject, text = "", html = "", status, read, receivedAt, rawKey, archiveStatus,
  fromJson, toJson, resendId = null, recipientStatus = null,
}) {
  database.prepare(
    `INSERT OR IGNORE INTO mail_messages(
      message_id,thread_id,mailbox_id,direction,envelope_from,envelope_to,from_json,to_json,subject,text_body,html_body,
      status,is_read,received_at,raw_r2_key,raw_r2_size,archive_status,resend_email_id,recipient_status_json,created_at,updated_at
    ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(
    messageId, threadId, mailboxId, direction, envelopeFrom, envelopeTo,
    JSON.stringify(fromJson), JSON.stringify(toJson), subject, text, html,
    status, read, receivedAt, rawKey, 1024, archiveStatus, resendId, recipientStatus ?? "{}", now, now,
  );
}

function insertAttachment(attachmentId, messageId, filename, contentType, size, key) {
  database.prepare(
    "INSERT OR IGNORE INTO mail_attachments(attachment_id,message_id,filename,content_type,size,sha256,r2_object_key,is_inline,created_at) VALUES(?,?,?,?,?,?,?,0,?)",
  ).run(attachmentId, messageId, filename, contentType, size, "a".repeat(43), key, now);
}

function insertEvent(eventId, messageId, type, status, recipient) {
  database.prepare(
    "INSERT OR IGNORE INTO mail_delivery_events(event_id,message_id,event_type,status,recipient_json,payload_json,occurred_at,received_at) VALUES(?,?,?,?,?,?,?,?)",
  ).run(eventId, messageId, type, status, JSON.stringify([recipient]), "{}", now, now);
}

insertMailbox("hello", "hello@example.com", "Hello");
insertMailbox("sales", "sales@example.com", "Sales");

insertThread("t-inbox", "hello", "Billing question about your Pro plan", ["alice@example.net"], "open", now);
insertMessage({
  messageId: "msg-billing", threadId: "t-inbox", mailboxId: "hello", direction: "incoming",
  envelopeFrom: "alice@example.net", envelopeTo: "hello@example.com",
  subject: "Billing question about your Pro plan",
  text: "Hi team,\n\nI noticed a charge on my invoice from last month and I have a couple of questions about my Pro plan.\n\n1. When does the new pricing apply?\n2. Can you send me the latest invoice as PDF?\n\nThanks!\nAlice",
  html: "<h2>Billing question</h2><p>Hi team,</p><p>I noticed a charge on my invoice from last month and I have a couple of questions about my Pro plan.</p><ol><li>When does the new pricing apply?</li><li>Can you send me the latest invoice as PDF?</li></ol><p>Thanks!<br>Alice</p>",
  status: "received", read: 1, receivedAt: now,
  rawKey: "incoming/hello/2026/09/msg-billing/original-demo.eml", archiveStatus: "archived",
  fromJson: [{ name: "Alice Customer", address: "alice@example.net" }],
  toJson: [{ name: "Hello", address: "hello@example.com" }],
});
insertAttachment("att-invoice", "msg-billing", "invoice-july-2026.pdf", "application/pdf", 42 * 1024, "incoming/hello/2026/09/msg-billing/attachments/att-invoice-invoice-july-2026.pdf");

insertThread("t-sent", "hello", "Re: Billing question about your Pro plan", ["alice@example.net"], "open", now);
insertMessage({
  messageId: "msg-reply", threadId: "t-sent", mailboxId: "hello", direction: "outgoing",
  envelopeFrom: "hello@example.com", envelopeTo: "alice@example.net",
  subject: "Re: Billing question about your Pro plan",
  text: "Hi Alice,\n\nThanks for reaching out. The new pricing applies from September 1st, and I have attached the latest invoice.\n\nBest,\nThe Hello team",
  status: "delivered", read: 1, receivedAt: now, resendId: "resend_demo_1",
  rawKey: "outgoing/hello/2026/09/msg-reply/original-demo.eml", archiveStatus: "archived",
  recipientStatus: JSON.stringify({ "alice@example.net": "delivered" }),
  fromJson: [{ name: "Hello", address: "hello@example.com" }],
  toJson: [{ name: "Alice Customer", address: "alice@example.net" }],
});
insertEvent("evt-1", "msg-reply", "email.delivered", "delivered", "alice@example.net");

insertThread("t-archive", "hello", "Welcome to MailGable example.com", ["support@example.net"], "archived", "2026-08-01T09:00:00.000Z");
insertMessage({
  messageId: "msg-welcome", threadId: "t-archive", mailboxId: "hello", direction: "incoming",
  envelopeFrom: "support@example.net", envelopeTo: "hello@example.com",
  subject: "Welcome to MailGable example.com",
  text: "Welcome! Your domain inbox is ready.",
  status: "received", read: 1, receivedAt: "2026-08-01T09:00:00.000Z",
  rawKey: "incoming/hello/2026/08/msg-welcome/original-demo.eml", archiveStatus: "archived",
  fromJson: [{ name: "Support", address: "support@example.net" }],
  toJson: [{ name: "Hello", address: "hello@example.com" }],
});

insertThread("t-spam", "hello", "Limited time offer!!!", [], "spam", "2026-08-10T07:00:00.000Z");
insertMessage({
  messageId: "msg-spam", threadId: "t-spam", mailboxId: "hello", direction: "incoming",
  envelopeFrom: "winner@example.net", envelopeTo: "hello@example.com",
  subject: "Limited time offer!!!",
  text: "You have been selected!",
  status: "received", read: 0, receivedAt: "2026-08-10T07:00:00.000Z",
  rawKey: "incoming/hello/2026/08/msg-spam/original-demo.eml", archiveStatus: "archived",
  fromJson: [{ name: "Winner", address: "winner@example.net" }],
  toJson: [{ name: "Hello", address: "hello@example.com" }],
});

insertThread("t-bidi", "hello", "Urgent\u202Efdp.exe invoice", ["bidi@example.net"], "open", "2026-09-02T11:00:00.000Z");
insertMessage({
  messageId: "msg-bidi", threadId: "t-bidi", mailboxId: "hello", direction: "incoming",
  envelopeFrom: "bidi@example.net", envelopeTo: "hello@example.com",
  subject: "Urgent\u202Efdp.exe invoice",
  text: "Review this attachment.",
  status: "received", read: 0, receivedAt: "2026-09-02T11:00:00.000Z",
  rawKey: "incoming/hello/2026/09/msg-bidi/original-demo.eml", archiveStatus: "archived",
  fromJson: [{ name: "Bidi Sender\u2067", address: "bidi@example.net" }],
  toJson: [{ name: "Hello", address: "hello@example.com" }],
});

insertThread("t-trash", "sales", "Old partnership proposal", ["partner@example.net"], "trash", "2026-07-20T10:00:00.000Z");
insertMessage({
  messageId: "msg-partner", threadId: "t-trash", mailboxId: "sales", direction: "incoming",
  envelopeFrom: "partner@example.net", envelopeTo: "sales@example.com",
  subject: "Old partnership proposal",
  text: "This thread was trashed and will be purged after the trash retention window.",
  status: "received", read: 1, receivedAt: "2026-07-20T10:00:00.000Z",
  rawKey: "incoming/sales/2026/07/msg-partner/original-demo.eml", archiveStatus: "archived",
  fromJson: [{ name: "Partner", address: "partner@example.net" }],
  toJson: [{ name: "Sales", address: "sales@example.com" }],
});

insertThread("t-hostile", "hello", "Security test: remote content", ["phish@example.net"], "open", "2026-09-02T12:00:00.000Z");
insertMessage({
  messageId: "msg-hostile", threadId: "t-hostile", mailboxId: "hello", direction: "incoming",
  envelopeFrom: "phish@example.net", envelopeTo: "hello@example.com",
  subject: "Security test: remote content",
  text: "Remote-content corpus used by the E2E proof: opening this message must trigger zero outbound requests.",
  html: [
    '<h2>Remote-content corpus</h2>',
    '<img src="https://remote.example/tracker.png?pixel=1">',
    '<img src="https://remote.example/one.png" srcset="https://remote.example/two.png 2x">',
    '<div style="background:url(https://remote.example/bg.png)">styled</div>',
    '<style>@import url("https://remote.example/style.css");</style>',
    '<link rel="stylesheet" href="https://remote.example/link.css">',
    '<svg><image href="https://remote.example/svg.png"></image></svg>',
    '<iframe src="https://remote.example/frame.html"></iframe>',
    '<object data="https://remote.example/obj"></object>',
    '<embed src="https://remote.example/embed.swf">',
    '<meta http-equiv="refresh" content="0;url=https://remote.example/refresh">',
    '<video poster="https://remote.example/poster.png"></video>',
    '<body background="https://remote.example/body.png">',
    '<form action="https://remote.example/post"><input type="image" src="https://remote.example/input.png"></form>',
    '<script>fetch("https://remote.example/script.js")</script>',
    '<a href="https://remote.example/nav">remote navigation</a>',
    '<a href="javascript:alert(1)">script link</a>',
  ].join(""),
  status: "received", read: 1, receivedAt: "2026-09-02T12:00:00.000Z",
  rawKey: "incoming/hello/2026/09/msg-hostile/original-demo.eml", archiveStatus: "archived",
  fromJson: [{ name: "Phish", address: "phish@example.net" }],
  toJson: [{ name: "Hello", address: "hello@example.com" }],
});

database.exec(`
UPDATE mail_threads
   SET latest_message_id = (SELECT m.message_id FROM mail_messages m WHERE m.thread_id = mail_threads.thread_id ORDER BY COALESCE(m.received_at,m.sent_at,m.created_at) DESC LIMIT 1),
       latest_direction = (SELECT m.direction FROM mail_messages m WHERE m.thread_id = mail_threads.thread_id ORDER BY COALESCE(m.received_at,m.sent_at,m.created_at) DESC LIMIT 1),
       latest_sender_json = COALESCE((SELECT m.from_json FROM mail_messages m WHERE m.thread_id = mail_threads.thread_id ORDER BY COALESCE(m.received_at,m.sent_at,m.created_at) DESC LIMIT 1),'[]'),
       latest_envelope_from = (SELECT m.envelope_from FROM mail_messages m WHERE m.thread_id = mail_threads.thread_id ORDER BY COALESCE(m.received_at,m.sent_at,m.created_at) DESC LIMIT 1),
       latest_recipient = COALESCE((SELECT m.envelope_to FROM mail_messages m WHERE m.thread_id = mail_threads.thread_id ORDER BY COALESCE(m.received_at,m.sent_at,m.created_at) DESC LIMIT 1),''),
       latest_preview = COALESCE((SELECT substr(COALESCE(m.text_body,''),1,800) FROM mail_messages m WHERE m.thread_id = mail_threads.thread_id ORDER BY COALESCE(m.received_at,m.sent_at,m.created_at) DESC LIMIT 1),''),
       latest_message_status = (SELECT m.status FROM mail_messages m WHERE m.thread_id = mail_threads.thread_id ORDER BY COALESCE(m.received_at,m.sent_at,m.created_at) DESC LIMIT 1),
       has_incoming = CASE WHEN EXISTS(SELECT 1 FROM mail_messages m WHERE m.thread_id = mail_threads.thread_id AND m.direction='incoming') THEN 1 ELSE 0 END,
       has_outgoing = CASE WHEN EXISTS(SELECT 1 FROM mail_messages m WHERE m.thread_id = mail_threads.thread_id AND m.direction='outgoing') THEN 1 ELSE 0 END,
       has_attachment = CASE WHEN EXISTS(SELECT 1 FROM mail_attachments a JOIN mail_messages m ON m.message_id=a.message_id WHERE m.thread_id = mail_threads.thread_id) THEN 1 ELSE 0 END
`);
database.close();
console.log("seed-demo: synthetic example-domain data inserted into the local D1 database.");
console.log("seed-demo: remember to run 'npm run dev' before opening the admin UI to see it.");