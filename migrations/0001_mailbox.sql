PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS admins (
  admin_id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE COLLATE NOCASE,
  password_hash TEXT NOT NULL,
  password_salt TEXT NOT NULL,
  password_iterations INTEGER NOT NULL CHECK(password_iterations BETWEEN 50000 AND 1000000),
  disabled INTEGER NOT NULL DEFAULT 0 CHECK(disabled IN (0,1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  last_login_at TEXT
);

CREATE TABLE IF NOT EXISTS admin_sessions (
  session_id TEXT PRIMARY KEY,
  admin_id TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  csrf_token TEXT NOT NULL,
  ip_hash TEXT,
  user_agent_hash TEXT,
  created_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  revoked_at TEXT,
  FOREIGN KEY(admin_id) REFERENCES admins(admin_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_admin_sessions_token ON admin_sessions(token_hash, expires_at);
CREATE INDEX IF NOT EXISTS idx_admin_sessions_expiry ON admin_sessions(expires_at);

CREATE TABLE IF NOT EXISTS auth_attempts (
  attempt_id TEXT PRIMARY KEY,
  scope TEXT NOT NULL CHECK(scope IN ('ip','email')),
  subject_hash TEXT NOT NULL,
  success INTEGER NOT NULL DEFAULT 0 CHECK(success IN (0,1)),
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_auth_attempts_lookup ON auth_attempts(scope, subject_hash, created_at DESC);

CREATE TABLE IF NOT EXISTS mailboxes (
  mailbox_id TEXT PRIMARY KEY,
  address TEXT NOT NULL UNIQUE COLLATE NOCASE,
  display_name TEXT NOT NULL,
  can_receive INTEGER NOT NULL DEFAULT 1 CHECK(can_receive IN (0,1)),
  can_send INTEGER NOT NULL DEFAULT 1 CHECK(can_send IN (0,1)),
  active INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0,1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS mail_threads (
  thread_id TEXT PRIMARY KEY,
  mailbox_id TEXT,
  subject TEXT NOT NULL DEFAULT '',
  participants_json TEXT NOT NULL DEFAULT '[]',
  last_message_at TEXT NOT NULL,
  unread_count INTEGER NOT NULL DEFAULT 0 CHECK(unread_count >= 0),
  is_replied INTEGER NOT NULL DEFAULT 0 CHECK(is_replied IN (0,1)),
  status TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open','closed','spam','trash')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY(mailbox_id) REFERENCES mailboxes(mailbox_id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS idx_mail_threads_time ON mail_threads(last_message_at DESC);
CREATE INDEX IF NOT EXISTS idx_mail_threads_mailbox ON mail_threads(mailbox_id, last_message_at DESC);
CREATE INDEX IF NOT EXISTS idx_mail_threads_unread ON mail_threads(unread_count, last_message_at DESC);

CREATE TABLE IF NOT EXISTS mail_messages (
  message_id TEXT PRIMARY KEY,
  thread_id TEXT NOT NULL,
  mailbox_id TEXT,
  direction TEXT NOT NULL CHECK(direction IN ('incoming','outgoing','outgoing_backup_copy','unknown')),
  envelope_from TEXT,
  envelope_to TEXT NOT NULL,
  from_json TEXT NOT NULL DEFAULT '[]',
  to_json TEXT NOT NULL DEFAULT '[]',
  cc_json TEXT NOT NULL DEFAULT '[]',
  bcc_json TEXT NOT NULL DEFAULT '[]',
  subject TEXT NOT NULL DEFAULT '',
  text_body TEXT,
  html_body TEXT,
  internet_message_id TEXT,
  in_reply_to TEXT,
  references_header TEXT,
  x_mailbox_mail_id TEXT,
  parent_message_id TEXT,
  resend_email_id TEXT,
  idempotency_key TEXT,
  status TEXT NOT NULL DEFAULT 'received',
  is_read INTEGER NOT NULL DEFAULT 0 CHECK(is_read IN (0,1)),
  is_replied INTEGER NOT NULL DEFAULT 0 CHECK(is_replied IN (0,1)),
  received_at TEXT,
  sent_at TEXT,
  raw_r2_key TEXT,
  raw_r2_size INTEGER NOT NULL DEFAULT 0,
  archive_status TEXT NOT NULL DEFAULT 'pending' CHECK(archive_status IN ('pending','archived','partial','failed','not_applicable')),
  last_error TEXT,
  created_by_admin_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY(thread_id) REFERENCES mail_threads(thread_id) ON DELETE RESTRICT,
  FOREIGN KEY(mailbox_id) REFERENCES mailboxes(mailbox_id) ON DELETE SET NULL,
  FOREIGN KEY(parent_message_id) REFERENCES mail_messages(message_id) ON DELETE SET NULL,
  FOREIGN KEY(created_by_admin_id) REFERENCES admins(admin_id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS idx_mail_messages_thread ON mail_messages(thread_id, COALESCE(received_at, sent_at, created_at));
CREATE INDEX IF NOT EXISTS idx_mail_messages_mailbox ON mail_messages(mailbox_id, COALESCE(received_at, sent_at, created_at) DESC);
CREATE INDEX IF NOT EXISTS idx_mail_messages_status ON mail_messages(status, created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS idx_mail_messages_internet_id ON mail_messages(internet_message_id, direction) WHERE internet_message_id IS NOT NULL AND internet_message_id <> '';
CREATE UNIQUE INDEX IF NOT EXISTS idx_mail_messages_resend_id ON mail_messages(resend_email_id) WHERE resend_email_id IS NOT NULL AND resend_email_id <> '';
CREATE UNIQUE INDEX IF NOT EXISTS idx_mail_messages_idempotency ON mail_messages(idempotency_key) WHERE idempotency_key IS NOT NULL AND idempotency_key <> '';
CREATE INDEX IF NOT EXISTS idx_mail_messages_xid ON mail_messages(x_mailbox_mail_id) WHERE x_mailbox_mail_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS mail_attachments (
  attachment_id TEXT PRIMARY KEY,
  message_id TEXT NOT NULL,
  filename TEXT NOT NULL,
  content_type TEXT NOT NULL DEFAULT 'application/octet-stream',
  content_id TEXT,
  disposition TEXT,
  size INTEGER NOT NULL DEFAULT 0 CHECK(size >= 0),
  sha256 TEXT,
  r2_object_key TEXT NOT NULL,
  is_inline INTEGER NOT NULL DEFAULT 0 CHECK(is_inline IN (0,1)),
  created_at TEXT NOT NULL,
  FOREIGN KEY(message_id) REFERENCES mail_messages(message_id) ON DELETE CASCADE,
  UNIQUE(message_id, r2_object_key)
);
CREATE INDEX IF NOT EXISTS idx_mail_attachments_message ON mail_attachments(message_id);

CREATE TABLE IF NOT EXISTS mail_delivery_events (
  event_id TEXT PRIMARY KEY,
  svix_id TEXT UNIQUE,
  message_id TEXT,
  resend_email_id TEXT,
  event_type TEXT NOT NULL,
  status TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  occurred_at TEXT,
  received_at TEXT NOT NULL,
  FOREIGN KEY(message_id) REFERENCES mail_messages(message_id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS idx_mail_delivery_events_message ON mail_delivery_events(message_id, received_at DESC);
CREATE INDEX IF NOT EXISTS idx_mail_delivery_events_resend ON mail_delivery_events(resend_email_id, received_at DESC);

CREATE TABLE IF NOT EXISTS admin_audit_log (
  audit_id TEXT PRIMARY KEY,
  admin_id TEXT,
  action TEXT NOT NULL,
  target_type TEXT,
  target_id TEXT,
  request_id TEXT,
  ip_hash TEXT,
  details_json TEXT,
  created_at TEXT NOT NULL,
  FOREIGN KEY(admin_id) REFERENCES admins(admin_id) ON DELETE SET NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_admin_audit_request ON admin_audit_log(request_id) WHERE request_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_admin_audit_time ON admin_audit_log(created_at DESC);
