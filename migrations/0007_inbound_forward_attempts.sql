CREATE TABLE IF NOT EXISTS inbound_forward_attempts (
  message_id TEXT NOT NULL,
  target TEXT NOT NULL COLLATE NOCASE,
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','in_flight','accepted','failed')),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK(attempts >= 0),
  last_error TEXT,
  last_attempt_at TEXT,
  accepted_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (message_id, target),
  FOREIGN KEY (message_id) REFERENCES mail_messages(message_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_inbound_forward_attempts_status
  ON inbound_forward_attempts(status, updated_at);
