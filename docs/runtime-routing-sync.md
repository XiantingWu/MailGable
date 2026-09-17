# Runtime Routing Synchronization Architecture

## Security and Operational Contract

Runtime routing sync coordinates active Cloudflare Email Routing rules with mailbox sender identities in D1:
* **Read-Only Cloudflare Operations**: Runtime sync reads Email Routing rules via Cloudflare REST API without modifying Cloudflare rules. The browser never receives a Cloudflare API token.
* **Least Privilege**: The runtime sync token requires only `Email Routing Rules Read` permissions for the zone.
* **Fail-Closed Behavior**: If Cloudflare is unavailable or the API response is incomplete, D1 is not changed.
* **Auditability & Observability**: Sync timestamps are formatted with timestamp to seconds so a no-op comparison remains visibly observable. The last successful comparison with Cloudflare is persisted in D1 and exposed via authenticated management APIs.
* **Secret Preservation**: Routine deploys preserve the existing Worker secret (`CLOUDFLARE_ROUTING_READ_TOKEN`), and a subsequent normal guarded deploy preserves the secret.
