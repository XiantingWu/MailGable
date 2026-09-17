-- Denormalized thread list model.
--
-- mail_threads becomes the read model for thread lists so that listing no
-- longer window-scans the full mail_messages table. The summary columns are
-- maintained by refreshThread() on every message lifecycle change, and this
-- migration backfills existing data once.
--
-- has_attachment is maintained by message/attachment lifecycle operations.

ALTER TABLE mail_threads ADD COLUMN latest_message_id TEXT;
ALTER TABLE mail_threads ADD COLUMN latest_direction TEXT;
ALTER TABLE mail_threads ADD COLUMN latest_sender_json TEXT;
ALTER TABLE mail_threads ADD COLUMN latest_envelope_from TEXT;
ALTER TABLE mail_threads ADD COLUMN latest_recipient TEXT;
ALTER TABLE mail_threads ADD COLUMN latest_preview TEXT;
ALTER TABLE mail_threads ADD COLUMN latest_message_status TEXT;
ALTER TABLE mail_threads ADD COLUMN has_incoming INTEGER NOT NULL DEFAULT 0;
ALTER TABLE mail_threads ADD COLUMN has_outgoing INTEGER NOT NULL DEFAULT 0;
ALTER TABLE mail_threads ADD COLUMN has_attachment INTEGER NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS idx_mail_threads_cursor
  ON mail_threads(last_message_at DESC, thread_id DESC);

UPDATE mail_threads
   SET latest_message_id = (
         SELECT m.message_id FROM mail_messages m
          WHERE m.thread_id = mail_threads.thread_id
          ORDER BY COALESCE(m.received_at,m.sent_at,m.created_at) DESC, m.created_at DESC LIMIT 1
       ),
       latest_direction = (
         SELECT m.direction FROM mail_messages m
          WHERE m.thread_id = mail_threads.thread_id
          ORDER BY COALESCE(m.received_at,m.sent_at,m.created_at) DESC, m.created_at DESC LIMIT 1
       ),
       latest_sender_json = (
         SELECT COALESCE(m.from_json,'[]') FROM mail_messages m
          WHERE m.thread_id = mail_threads.thread_id
          ORDER BY COALESCE(m.received_at,m.sent_at,m.created_at) DESC, m.created_at DESC LIMIT 1
       ),
       latest_envelope_from = (
         SELECT m.envelope_from FROM mail_messages m
          WHERE m.thread_id = mail_threads.thread_id
          ORDER BY COALESCE(m.received_at,m.sent_at,m.created_at) DESC, m.created_at DESC LIMIT 1
       ),
       latest_recipient = (
         SELECT COALESCE(m.envelope_to,'') FROM mail_messages m
          WHERE m.thread_id = mail_threads.thread_id
          ORDER BY COALESCE(m.received_at,m.sent_at,m.created_at) DESC, m.created_at DESC LIMIT 1
       ),
       latest_preview = (
         SELECT substr(COALESCE(m.text_body,''),1,800) FROM mail_messages m
          WHERE m.thread_id = mail_threads.thread_id
          ORDER BY COALESCE(m.received_at,m.sent_at,m.created_at) DESC, m.created_at DESC LIMIT 1
       ),
       latest_message_status = (
         SELECT m.status FROM mail_messages m
          WHERE m.thread_id = mail_threads.thread_id
          ORDER BY COALESCE(m.received_at,m.sent_at,m.created_at) DESC, m.created_at DESC LIMIT 1
       ),
       has_incoming = EXISTS(
         SELECT 1 FROM mail_messages m WHERE m.thread_id = mail_threads.thread_id AND m.direction='incoming'
       ),
       has_outgoing = EXISTS(
         SELECT 1 FROM mail_messages m WHERE m.thread_id = mail_threads.thread_id AND m.direction='outgoing'
       ),
       has_attachment = EXISTS(
         SELECT 1 FROM mail_attachments a JOIN mail_messages m ON m.message_id=a.message_id
          WHERE m.thread_id = mail_threads.thread_id
       ),
       updated_at = updated_at;