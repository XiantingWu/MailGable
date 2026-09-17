import { loadMailModule } from "./helpers/mail-loader.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
const libSource = await readFile("src/lib.ts", "utf8");
const generatedEnv = await readFile("worker-configuration.d.ts", "utf8");
const source = await readFile("src/mail/outbound.ts", "utf8");
const providerSource = await readFile("src/providers/resend.ts", "utf8");
const allSource = source + "\n" + providerSource;

const loaded = await loadMailModule();
const { automaticBccAddresses } = loaded;

test("loads the optional automatic BCC helper", () => {
  assert.equal(typeof automaticBccAddresses, "function");
  assert.deepEqual(automaticBccAddresses({ AUTO_BCC_ADDRESSES: "" }), []);
  assert.deepEqual(automaticBccAddresses({ AUTO_BCC_ADDRESSES: undefined }), []);
  assert.deepEqual(
    automaticBccAddresses({ AUTO_BCC_ADDRESSES: "audit@example.net,archive@example.net" }),
    ["audit@example.net", "archive@example.net"],
  );
  assert.deepEqual(
    automaticBccAddresses({ AUTO_BCC_ADDRESSES: " audit@EXAMPLE.NET ; audit@example.net " }),
    ["audit@example.net"],
    "custom BCC addresses are normalized and deduplicated",
  );
});

test("automatic BCC rejects invalid or too-large address lists but accepts any valid count", () => {
  for (const value of [
    "not-an-email",
    "forward@example.org,not-an-email",
  ]) {
    assert.throws(
      () => automaticBccAddresses({ AUTO_BCC_ADDRESSES: value }),
      (error) => error?.code === "auto_bcc_not_configured",
      value,
    );
  }
  assert.deepEqual(
    automaticBccAddresses({ AUTO_BCC_ADDRESSES: "one@example.com" }),
    ["one@example.com"],
  );
});

test("AUTO_BCC_REQUIRED fails closed only when enforcement is explicitly enabled", () => {
  assert.deepEqual(automaticBccAddresses({ AUTO_BCC_ADDRESSES: "", AUTO_BCC_REQUIRED: "false" }), []);
  assert.throws(
    () => automaticBccAddresses({ AUTO_BCC_ADDRESSES: "", AUTO_BCC_REQUIRED: "true" }),
    (error) => error?.code === "auto_bcc_required_unconfigured",
  );
  assert.deepEqual(
    automaticBccAddresses({ AUTO_BCC_ADDRESSES: "audit@example.net", AUTO_BCC_REQUIRED: "true" }),
    ["audit@example.net"],
  );
});

test("every send plan merges, deduplicates, archives, and hashes the automatic BCC recipients", () => {
  assert.match(allSource, /const automaticBcc = automaticBccAddresses\(env\)/);
  assert.match(allSource, /const requestedBcc = strictRecipientList\(body\.bcc, "BCC"\)/);
  assert.match(allSource, /\.\.\.requestedBcc, \.\.\.automaticBcc/);
  assert.match(allSource, /filter\(\(address\) => !visibleSet\.has\(address\)\)/);
  assert.match(allSource, /body\.bcc = bcc/);
  assert.match(allSource, /JSON\.stringify\(plan\.bcc\.map/);
  assert.match(allSource, /bcc: plan\.bcc\.length \? plan\.bcc : undefined/);
  assert.match(generatedEnv, /AUTO_BCC_REQUIRED: "false"|AUTO_BCC_REQUIRED: string/);
});