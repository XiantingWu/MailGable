import {
  asText,
  json,
  safeDisplayText,
  normalizeEmail,
  type Env,
  type Row,
} from "../lib.js";

export function validateMailboxDomain(address: string, env: Env): boolean {
  const domain = (env.MAIL_DOMAIN || "example.com").trim().toLowerCase();
  return address.endsWith(`@${domain}`);
}

export function displayFrom(mailbox: Row, env: Env): string {
  const name = safeDisplayText(mailbox.display_name || env.MAIL_DISPLAY_NAME || "MailGable", 200).replace(/[<>]/g, " ");
  const address = normalizeEmail(mailbox.address);
  return `${name} <${address}>`;
}

export async function mailboxByAddress(env: Env, address: string): Promise<Row | null> {
  return env.DB.prepare("SELECT * FROM mailboxes WHERE address=? COLLATE NOCASE AND active=1 LIMIT 1")
    .bind(normalizeEmail(address)).first<Row>();
}

export async function mailboxById(env: Env, id: string): Promise<Row | null> {
  return env.DB.prepare("SELECT * FROM mailboxes WHERE mailbox_id=? AND active=1 LIMIT 1").bind(id).first<Row>();
}

export async function listMailboxes(env: Env): Promise<Response> {
  const result = await env.DB.prepare("SELECT mailbox_id,address,display_name,can_receive,can_send,active FROM mailboxes WHERE active=1 ORDER BY address").all<Row>();
  return json({ mailboxes: result.results || [] });
}