PRAGMA foreign_keys = ON;

ALTER TABLE mail_messages ADD COLUMN reply_to_json TEXT NOT NULL DEFAULT '[]';

CREATE INDEX IF NOT EXISTS idx_mail_messages_thread_mailbox
  ON mail_messages(thread_id,mailbox_id,created_at DESC);
