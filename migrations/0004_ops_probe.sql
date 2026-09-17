PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS mail_ops_probes (
  probe_id TEXT PRIMARY KEY,
  payload_hash TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_mail_ops_probes_created_at
  ON mail_ops_probes(created_at);
