# Resend credential lifecycle

## Routine operations

Routine production `Preflight` and `Deploy` are designed to run without a Resend Full Access key.

Required runtime credentials remain:

- Cloudflare read/deploy token appropriate to the action
- `RESEND_PRODUCTION_SENDING_ACCESS_KEY` for deploy
- mailbox administrator password for deploy

When `RESEND_SETUP_FULL_ACCESS_KEY` is absent, deployment does not call Resend domain or webhook management APIs. It preserves the existing Worker `RESEND_WEBHOOK_SECRET` and fails closed if that secret is absent. The guarded deployment still sends a real Resend smoke message and requires a signed webhook event, so runtime delivery/webhook health is verified without retaining provider-wide management privilege.

## Privileged maintenance

`RESEND_SETUP_FULL_ACCESS_KEY` is temporary and should only be supplied when Resend management is intentionally required, including:

- initial verified-domain/webhook provisioning or repair during guarded deploy
- read-only Resend domain/webhook inventory during preflight
- explicit removal of legacy Resend webhooks during reconciliation

If the key is present in `.dev.vars`, routine Preflight/Deploy may use it for the existing management checks/reconciliation. After the Resend domain and canonical webhook are accepted, remove or blank the key. Future routine deploys must continue without it.

## Failure behavior

A routine deploy without a setup key fails before acceptance when `RESEND_WEBHOOK_SECRET` is missing. Do not create a replacement secret manually. Temporarily provide a Full Access setup key and rerun the guarded deployment so the canonical Resend webhook and its signing secret are reconciled together.

The permanent sending-access key must not be replaced with a Full Access key. Provider management privilege and runtime sending privilege remain separate.
