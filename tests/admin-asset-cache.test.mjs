import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const html = await readFile("public/index.html", "utf8");
const worker = await readFile("src/index.ts", "utf8");

test("admin HTML references versioned CSS and JavaScript assets", () => {
  assert.match(html, /href="\/admin\/mail\/mail\.css\?v=[^"]+"/);
  assert.match(html, /href="\/admin\/mail\/mail-ready\.css\?v=[^"]+"/);
  assert.match(html, /<script type="module" src="\/admin\/mail\/js\/app\.mjs\?v=[^"]+"><\/script>/);
});

test("admin asset responses disable browser caching", () => {
  assert.match(worker, /headers\.set\("Cache-Control", "private, no-store, max-age=0"\)/);
  assert.match(worker, /headers\.set\("Pragma", "no-cache"\)/);
  assert.match(worker, /headers\.set\("Expires", "0"\)/);
  assert.match(worker, /return new Response\(asset\.body, \{ status: asset\.status, statusText: asset\.statusText, headers \}\)/);
});
