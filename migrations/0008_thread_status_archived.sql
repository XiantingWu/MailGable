-- Public-release normalization: the folder semantics used 'closed' for
-- the Archive folder in the pre-public schema. Rename the value to
-- 'archived' so the public API/DB vocabulary is self-describing.
-- SQLite cannot ALTER a CHECK constraint, so the table is rebuilt with
-- the canonical status vocabulary and existing 'closed' rows migrate to
-- 'archived'. Fresh and upgrade paths are both verified by
-- scripts/verify-migration.mjs and the test suite.
--
-- D1 executes each migration as a single statement batch and manages the
-- transaction itself, so no BEGIN/COMMIT/PRAGMA statements are used here.

CREATE TABLE mail_threads_new (
  thread_id TEXT PRIMARY KEY,
  mailbox_id TEXT,
  subject TEXT NOT NULL DEFAULT '',
  participants_json TEXT NOT NULL DEFAULT '[]',
  last_message_at TEXT NOT NULL,
  unread_count INTEGER NOT NULL DEFAULT 0 CHECK(unread_count >= 0),
  is_replied INTEGER NOT NULL DEFAULT 0 CHECK(is_replied IN (0,1)),
  status TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open','archived','spam','trash')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY(mailbox_id) REFERENCES mailboxes(mailbox_id) ON DELETE SET NULL
);

INSERT INTO mail_threads_new(thread_id,mailbox_id,subject,participants_json,last_message_at,unread_count,is_replied,status,created_at,updated_at)
SELECT thread_id,mailbox_id,subject,participants_json,last_message_at,unread_count,is_replied,
       CASE status WHEN 'closed' THEN 'archived' ELSE status END,
       created_at,updated_at
  FROM mail_threads;

DROP TABLE mail_threads;
ALTER TABLE mail_threads_new RENAME TO mail_threads;

CREATE INDEX IF NOT EXISTS idx_mail_threads_time ON mail_threads(last_message_at DESC);
CREATE INDEX IF NOT EXISTS idx_mail_threads_mailbox ON mail_threads(mailbox_id, last_message_at DESC);
CREATE INDEX IF NOT EXISTS idx_mail_threads_unread ON mail_threads(unread_count, last_message_at DESC);