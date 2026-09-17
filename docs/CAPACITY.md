# Capacity

What MailGable can realistically hold and process on Cloudflare's Free and Paid D1 plans. These are **engineering estimates from the implementation limits**, not marketing claims; benchmark results are recorded in `docs/BENCHMARK.md` as they are produced.

## Storage model

| Data | Location | Size behavior |
| :--- | :--- | :--- |
| Raw MIME (authoritative) | R2 | up to 20 MB per message (bounded) |
| Attachments | R2 | 8 MB per attachment / 15 MB total inbound; 5 MB / 8 MB outbound |
| Body previews | D1 | text preview ≤ 300 KB, sanitized HTML ≤ 600 KB per message |
| Metadata/threading/events | D1 | small, bounded rows |

## D1 Free plan envelope (2026-09 limits)

* 500 MB storage per database
* 5,000,000 rows read / 100,000 rows written per day (hard-enforced since 2026-09-01)
* 50 D1 queries per invocation

A single 600 KB HTML preview is ~40 KB of D1 storage (UTF-8); roughly **10,000–12,000 large-preview messages** fill the Free D1 storage budget, while typical text mail is far smaller. Exceeding daily row budgets returns an error that MailGable maps to `503 database_quota_exceeded`.

## Query budget controls

* Thread lists read the **denormalized `mail_threads` summary** — no window scan over the full message table, and cursor pagination instead of OFFSET.
* Attachment metadata inserts are **batched** (8 rows/query, ≤ 100 bound parameters) so the 50-attachment envelope costs ≤ 7 D1 queries.
* `References` threading resolves in **one** batched query instead of one query per reference.
* Retention and trash purge are **bounded** (50 threads per scheduled run, oldest first).

## Worst-case bounded message

Roughly: 20 MB raw (R2) + 15 MB attachments (R2) + ~900 KB previews (D1). R2 storage is the practical cost driver; D1 stores bounded previews, not full bodies.

## Recommendations

* Light/self-hosted use on the Free plan is supported; monitor D1 usage from the dashboard.
* High-volume or long-retention deployments should plan for the Paid D1 tier.
* `docs/BENCHMARK.md` records measured rows-read/duration/query plans for 1k/10k/50k scenarios as they are produced.

## See also

* [Data retention](DATA_RETENTION.md)
* [Troubleshooting](TROUBLESHOOTING.md) (D1 quota section)