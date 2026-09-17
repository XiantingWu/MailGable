import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests-e2e",
  timeout: 60_000,
  globalSetup: "./tests-e2e/global-setup.ts",
  use: {
    baseURL: "http://localhost:8788",
  },
});