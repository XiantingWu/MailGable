ALTER TABLE mailboxes
  ADD COLUMN routing_managed INTEGER NOT NULL DEFAULT 0
  CHECK(routing_managed IN (0,1));

CREATE INDEX IF NOT EXISTS idx_mailboxes_routing_managed
  ON mailboxes(routing_managed, active, address);
