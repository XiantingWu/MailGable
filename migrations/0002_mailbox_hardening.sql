PRAGMA foreign_keys = ON;

ALTER TABLE mail_messages ADD COLUMN request_hash TEXT;
ALTER TABLE mail_messages ADD COLUMN provider_internet_message_id TEXT;
ALTER TABLE mail_messages ADD COLUMN sent_copy_r2_key TEXT;
ALTER TABLE mail_messages ADD COLUMN sent_copy_r2_size INTEGER NOT NULL DEFAULT 0;
ALTER TABLE mail_messages ADD COLUMN body_truncated INTEGER NOT NULL DEFAULT 0 CHECK(body_truncated IN (0,1));
ALTER TABLE mail_messages ADD COLUMN recipient_status_json TEXT NOT NULL DEFAULT '{}';
ALTER TABLE mail_delivery_events ADD COLUMN recipient_json TEXT NOT NULL DEFAULT '[]';

DROP INDEX IF EXISTS idx_mail_messages_internet_id;
CREATE INDEX IF NOT EXISTS idx_mail_messages_internet_id
  ON mail_messages(internet_message_id,direction,mailbox_id)
  WHERE internet_message_id IS NOT NULL AND internet_message_id <> '';
CREATE INDEX IF NOT EXISTS idx_mail_messages_provider_internet_id
  ON mail_messages(provider_internet_message_id)
  WHERE provider_internet_message_id IS NOT NULL AND provider_internet_message_id <> '';
CREATE INDEX IF NOT EXISTS idx_mail_messages_thread_direction
  ON mail_messages(thread_id,direction,created_at DESC);
