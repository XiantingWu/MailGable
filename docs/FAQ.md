# FAQ

## Is MailGable a hosted service?

No. MailGable is source code you deploy into your own Cloudflare account. There is no hosted offering, no account signup, and no service endpoint operated by the maintainer.

## What does "self-hosted" mean here?

You run the Worker, D1 database, R2 bucket, and Email Routing rules in your own Cloudflare account. You own the data and the infrastructure; the maintainer does not have access to it.

## What Cloudflare products are required?

Workers, D1, R2, and Email Routing — see [DEPLOY.md](DEPLOY.md) for the full sequence.

## Does it require a paid Cloudflare plan?

Not necessarily for inbound mail: Email Routing is available on the free plan, and a receive-only deployment may fit within free-tier Workers/D1/R2 limits. Outbound sending depends on the provider you choose (Resend, Brevo, or Cloudflare Email Service) and its plan. See [CAPACITY.md](CAPACITY.md).

## How is inbound mail handled?

Cloudflare Email Routing delivers inbound messages to the Worker's `email()` handler. Raw MIME and attachments are archived to R2 with `sha256` integrity, metadata and threading go to D1, and unknown recipients are rejected at the edge. See [ARCHITECTURE.md](ARCHITECTURE.md) and [ROUTING.md](ROUTING.md).

## How is outbound mail handled?

Through a pluggable outbound provider behind the `OutboundProvider` boundary. Delivery is idempotent and provider-pinned, and delivery events are reconciled via signed webhooks or queue events. Receive-only mode is fully supported with no outbound provider. See [providers/](providers).

## Where is email data stored?

In your own Cloudflare account: message metadata and threading in D1, raw MIME and attachments in a private R2 bucket. Nothing is sent to the maintainer.

## Are the screenshots from a live deployment?

No. Screenshots in the README are generated from deterministic demo data; the routing and sync indicators shown are illustrative and do not represent a live deployment. See `scripts/screenshots.mjs`.

## How are security issues reported?

Privately — never in a public issue. Follow [SECURITY.md](../SECURITY.md); prefer GitHub Private Vulnerability Reporting from the repository Security tab.

## Why is there no Dependabot automation?

Dependency upgrades are applied manually by the maintainer behind the full validation gate, so no bot-authored pull requests or contributors appear. The repository also ships without GitHub Actions workflows. See [DEPENDENCIES.md](DEPENDENCIES.md).

## Can I submit a pull request?

Issues, bug reports, feature requests, and documentation suggestions are welcome. MailGable is maintainer-led and unsolicited implementation PRs are generally not merged; please open an issue before substantial code changes. See [CONTRIBUTING.md](../CONTRIBUTING.md).

## Can I use MailGable commercially?

The source is licensed under Apache-2.0, which permits commercial use as long as the license terms are respected. There is no warranty and no commercial support commitment.
