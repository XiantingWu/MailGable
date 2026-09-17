import test from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";

const providers = await joinedDir("src/providers", ".ts");
const mail = (await joinedDir("src/mail", ".ts")) + "\n" + providers;
async function joinedDir(dir, ext) {
  const names = (await readdir(dir)).filter((name) => name.endsWith(ext)).sort();
  return (await Promise.all(names.map((name) => readFile(`${dir}/${name}`, "utf8")))).join("\n");
}

const worker = await readFile("src/index.ts", "utf8");
const ui = await joinedDir("public/js", ".mjs");
const html = await readFile("public/index.html", "utf8");
const readyCss = await readFile("public/mail-ready.css", "utf8");

test("reply threading and sending stay inside one mailbox identity", () => {
  assert.match(mail, /AND mailbox_id=\?/);
  assert.doesNotMatch(mail, /AND \(mailbox_id=\? OR direction='outgoing'\)/);
  assert.match(mail, /reply_mailbox_mismatch/);
  assert.match(mail, /String\(parent\.mailbox_id \|\| ""\) !== String\(mailbox\.mailbox_id \|\| ""\)/);
});

test("recipient and attachment limits fail explicitly", () => {
  assert.match(mail, /export function strictRecipientList/);
  assert.match(mail, /too_many_recipients/);
  assert.match(mail, /value\.length > 10/);
  assert.match(mail, /too_many_attachments/);
  assert.match(mail, /forward_attachments_exceed_limits/);
  assert.doesNotMatch(ui, /files = \[\.\.\.\$\("compose-attachments"\)\.files\]\.slice\(0, 10\)/);
  assert.match(ui, /files\.length > 10/);
});

test("provider retry is bounded and survives browser refresh", () => {
  assert.match(mail, /AbortSignal\.timeout\(15_000\)/);
  assert.match(mail, /status === 429/);
  assert.match(mail, /export async function retryMessage/);
  assert.match(mail, /storedSendPlan/);
  assert.match(mail, /PostalMime\.parse\(rawBytes/);
  assert.match(mail, /status=CASE WHEN status IN \('sending','retryable_failed'\) THEN 'sent' ELSE status END/);
  assert.doesNotMatch(mail, /retryMessage[\s\S]*?SET status='sent',resend_email_id/);
  assert.match(worker, /const retry = pathMatch\(pathname/);
  assert.match(worker, /return retryMessage\(request, env, session/);
  assert.match(ui, /retryArchivedMessage/);
  assert.match(ui, /\/retry`/);
});

test("delivery state and corrected DOM styles are visible", () => {
  assert.match(ui, /recipient_status_json/);
  assert.match(ui, /delivery-event-list/);
  assert.match(ui, /messageCard\(message, detail\.attachments \|\| \[\], detail\.events \|\| \[\]\)/);
  assert.match(html, /mail-ready\.css/);
  assert.match(worker, /\/mail-ready\.css/);
  assert.match(readyCss, /\.thread-top/);
  assert.match(readyCss, /\.recipient-status-list/);
});
