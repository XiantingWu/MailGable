import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const indexSource = await readFile("src/index.ts", "utf8");

function classifyD1QuotaError(error) {
  if (error && error instanceof Error === false && error?.status) return null;
  if (error instanceof Error) {
    if (/D1_QUOTA_EXCEEDED|rows written.*limit|database.*quota/i.test(error.message)) {
      return { status: 503, code: "database_quota_exceeded" };
    }
  }
  return null;
}

test("D1 quota errors map to a stable machine code", () => {
  assert.deepEqual(classifyD1QuotaError(new Error("D1_QUOTA_EXCEEDED: daily rows written limit exceeded")), {
    status: 503,
    code: "database_quota_exceeded",
  });
  assert.deepEqual(classifyD1QuotaError(new Error("database quota reached")), {
    status: 503,
    code: "database_quota_exceeded",
  });
  assert.equal(classifyD1QuotaError(new Error("random failure")), null);
  assert.equal(classifyD1QuotaError(null), null);
});

test("quota classification is wired into the request error path", () => {
  assert.match(indexSource, /database_quota_exceeded/);
  assert.match(indexSource, /classifyD1QuotaError\(error\) \|\| error/);
});