import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const doc = await readFile("docs/resend-credential-lifecycle.md", "utf8");

test("Resend credential lifecycle keeps management and runtime privileges separate", () => {
  assert.match(doc, /Routine production `Preflight` and `Deploy` are designed to run without a Resend Full Access key/);
  assert.match(doc, /RESEND_PRODUCTION_SENDING_ACCESS_KEY/);
  assert.match(doc, /fails closed if that secret is absent/);
  assert.match(doc, /remove or blank the key/);
  assert.match(doc, /must not be replaced with a Full Access key/);
});
