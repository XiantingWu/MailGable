import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";

// Setup files run outside the per-test-file storage isolation and may run
// multiple times; applyD1Migrations() only applies migrations that have not
// been applied yet, so calling it here is safe and idempotent.
await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);