# Inbound Routing and Backup Forwarding Runbook

## Invariants

* Every literal domain Email Routing rule is API-managed and targets the single canonical Worker.
* Addresses such as `support@`, `contact@`, and `privacy@` are configured as enabled literal routes.
* If a catch-all rule exists, its action targets the same Worker while its enabled state is preserved.
* The Worker accepts mail only for an active D1 mailbox with `can_receive=1`.
* Every accepted inbound message is durably archived in D1/R2 before backup forwarding is attempted.
* D1/R2 plus the admin mailbox are authoritative. External forward copies (e.g., at Hotmail or Yahoo) are independent backup copies, not the primary source of truth for whether the message was received.
* When backup forward targets are configured, the Email Worker uses Cloudflare native `message.forward()` so the original RFC sender, recipient headers, body, attachments, Message-ID, and authentication chain remain native forwarded-mail evidence.
* The Worker calls `forward()` once per verified backup target. Cloudflare owns downstream SMTP delivery, SRS/ARC handling, soft-bounce retry, and final delivery status after `forward()` accepts the request.
* Each forwarded copy receives only additive `X-Mailbox-*` audit headers: archive ID, original envelope recipient, original Message-ID (when present), and backup target. Standard RFC identity headers are never replaced.
* D1 `inbound_forward_attempts.status='accepted'` means only that `message.forward()` returned successfully and Cloudflare accepted that forwarding request. It does **not** mean Hotmail or Yahoo ultimately delivered or displayed the copy. Never report `8/8 accepted` as `8/8 delivered`.
* Cloudflare Email Routing Activity / `emailRoutingAdaptive` is authoritative for downstream routing outcomes such as `delivered` and `deliveryFailed`.
* A D1 target in `accepted` is terminal for Worker-side duplicate suppression: a duplicate Worker invocation does not submit the same target again.
* A synchronous `message.forward()` failure is recorded as `failed`. It is eligible for another attempt if the original message is redelivered.
* Backup failures never delete or roll back an already archived D1/R2 message.

---

## Cloudflare Resources

Canonical resources:
* **Worker**: `mailgable-dev`
* **D1**: `mailgable-db`
* **R2**: `mailgable-r2`

The guarded deployment verifies storage bindings before deploying the Worker and never deletes D1, R2, or archived mail.
