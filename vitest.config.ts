import path from "node:path";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig(async () => {
  const migrations = await readD1Migrations(path.join(process.cwd(), "migrations"));

  return {
    plugins: [
      cloudflareTest({
        wrangler: {
          configPath: "./wrangler.jsonc",
          environment: "production",
        },
        miniflare: {
          bindings: {
            TEST_MIGRATIONS: migrations,
            AUTH_PEPPER: "test-pepper-".repeat(4),
            ADMIN_BOOTSTRAP_TOKEN: "test-bootstrap-token-with-sufficient-entropy",
            RESEND_API_KEY: "",
            RESEND_WEBHOOK_SECRET: "",
            CLOUDFLARE_ROUTING_READ_TOKEN: "",
            ADMIN_EMAIL: "admin@example.com",
            MAIL_DOMAIN: "example.com",
            PASSWORD_ITERATIONS: "8000",
            SESSION_HOURS: "12",
            LOG_LEVEL: "error",
            APP_ORIGIN: "https://example.com",
          },
        },
      }),
    ],
    test: {
      include: ["tests-worker/**/*.test.ts"],
      setupFiles: ["./tests-worker/apply-migrations.ts"],
    },
  };
});