// MIGRATION DOCUMENTATION MATCH GATE.
//
// Every committed migrations/*.sql file must be represented in
// docs/MIGRATIONS.md history table, so the documentation cannot silently
// drift behind the schema again (the repository previously documented only
// up to 0008 while 0009/0010/0011 existed).
import test from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";

const root = process.cwd();

test("every migrations/*.sql file is documented in docs/MIGRATIONS.md", async () => {
  const files = (await readdir(path.join(root, "migrations")))
    .filter((name) => /^\d{4}_[a-z0-9_]+\.sql$/i.test(name))
    .sort();
  assert.ok(files.length >= 11, `expected at least 11 migrations, found ${files.length}`);
  const doc = await readFile(path.join(root, "docs/MIGRATIONS.md"), "utf8");
  for (const file of files) {
    const number = file.slice(0, 4);
    assert.match(doc, new RegExp(`\\| ${number} \\|`), `docs/MIGRATIONS.md must document migration ${number} (${file})`);
  }
  const docNumbers = [...doc.matchAll(/^\| (\d{4}) \|/gm)].map((m) => m[1]).sort();
  const fileNumbers = files.map((f) => f.slice(0, 4)).sort();
  assert.deepEqual(docNumbers, fileNumbers, "documented migration set must equal the filesystem migration set");
});
