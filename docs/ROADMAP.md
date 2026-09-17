# Roadmap

MailGable is a maintainer-led project. This roadmap is directional and may change; it does not promise dates or delivery guarantees.

## Now (v0.1 line)

* Public source release: durable archive (D1 metadata + R2 raw MIME), threading, search
* Compose, reply, reply-all, forward with idempotent, archive-before-retry sending
* Outbound providers on the `OutboundProvider` boundary: Resend, Brevo, and Cloudflare Email Service; receive-only mode without an outbound provider
* Delivery state reconciliation via signed provider events (monotonic merge, replay-safe)
* Folder lifecycle: Archive, Spam, Trash, Restore, hard delete with R2 consistency
* Optional inbound forwarding and automatic BCC (`AUTO_BCC_REQUIRED` fail-closed mode)
* Fresh-install deployment guide and the `docs/` handbook
* English-only administrative UI (Unicode email content fully preserved)

## Next

1. Cloudflare Access deployment mode / stronger authentication (JWT-verified identity, WebAuthn)
2. Drafts
3. Contacts
4. PWA / push notifications

## Later

* Roles and mailbox sharing
* Advanced retention policies (per-folder, per-mailbox)
* Additional provider plugins

## Non-goals

* Not an IMAP server
* Not a traditional SMTP MTA
* Not a full Exchange/Google Workspace replacement
* Not end-to-end encrypted mail
* Not malware/antivirus scanning
* Not a multi-tenant SaaS

## How direction is decided

MailGable is maintainer-led: issues, bug reports, and design discussions are welcome inputs, but roadmap decisions are made by the maintainer. See [CONTRIBUTING.md](../CONTRIBUTING.md).
