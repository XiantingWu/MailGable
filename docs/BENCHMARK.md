# Benchmark

Measured results from `scripts/seed-scale.mjs` (local SQLite, same schema and
query shapes as D1). These are **relative comparisons** on local hardware —
absolute timings on Cloudflare D1 will differ, but query *plans* (the 
important part) transfer directly.

Run: `node scripts/seed-scale.mjs --rows <N>` (local only; `--remote` is rejected).

## Thread-list query plans

Every measurement returns `PLAN: SCAN t USING INDEX idx_mail_threads_cursor` —
thread lists and search read the **denormalized `mail_threads` summary
directly** and never scan the full `mail_messages` table.

## Results (macOS, Node 24, local SQLite)

| Scenario | 1,000 | 10,000 | 50,000 |
| :--- | :--- | :--- | :--- |
| Inbox first page (40) | 0.2 ms | 0.2 ms | 0.2 ms |
| All Mail first page (40) | 0.1 ms | 0.1 ms | 0.1 ms |
| Search "invoice" (first page) | 0.1 ms | 0.1 ms | 0.1 ms |
| Full message table scan on list/search | **none** | **none** | **none** |

## Notes

* Search uses `instr(lower(...))` over subject + latest preview only. At
  these sizes it is not a bottleneck; if 100k+ mailboxes become a measured
  problem, an FTS5 derived index is the planned step (rebuildable from
  canonical tables + R2; see `docs/CAPACITY.md`).
* Pagination uses the `last_message_at DESC, thread_id DESC` cursor —
  no OFFSET, stable across same timestamps, reachable beyond 10k rows.

## Caveats

* Rows-read accounting on D1 is per-cloud; budget model in
  `docs/CAPACITY.md`.
* These figures are not an SLA and should be re-measured against a real
  D1 database during the private live smoke.