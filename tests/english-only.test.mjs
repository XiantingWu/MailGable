// ENGLISH-ONLY PRODUCT SURFACE REGRESSION GATE.
//
// MailGable repository documentation and administrative UI are maintained
// in English only. This gate prevents accidental re-introduction of a
// Chinese localization surface (README, HTML lang, locale dictionary,
// language switcher, browser auto-detection, locale state, locale
// filenames). Email payload language is intentionally unaffected: Unicode
// user content remains fully supported and is excluded from this scan.
import test from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";

async function exists(p) {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

async function joined(dir, ext) {
  const names = (await readdir(dir)).filter((name) => name.endsWith(ext)).sort();
  return (await Promise.all(names.map((name) => readFile(path.join(dir, name), "utf8")))).join("\n");
}

const root = process.cwd();
const indexHtml = await readFile(path.join(root, "public/index.html"), "utf8");
const uiJs = (await joined(path.join(root, "public/js"), ".mjs"));

test("English-only: Chinese README and its reference are absent", async () => {
  assert.equal(await exists(path.join(root, "README.zh-CN.md")), false, "README.zh-CN.md must not exist");
  const readme = await readFile(path.join(root, "README.md"), "utf8");
  assert.ok(!readme.includes("README.zh-CN.md"), "README must not reference a translation file");
  assert.doesNotMatch(readme, /bilingual|简体中文/, "README must not claim a bilingual product surface");
});

test("English-only: index.html declares lang=en and has no language switcher", () => {
  assert.match(indexHtml, /<html lang="en">/);
  assert.doesNotMatch(indexHtml, /lang="zh-CN"/);
  assert.ok(!indexHtml.includes("id=\"auth-language\""), "auth-language button must not exist");
  assert.ok(!indexHtml.includes("id=\"language-toggle\""), "language-toggle button must not exist");
  assert.match(indexHtml, />Administrator email</);
  assert.match(indexHtml, />Password</);
  assert.match(indexHtml, />Inbox</);
  assert.match(indexHtml, />Sent</);
  assert.match(indexHtml, />Archive</);
  assert.match(indexHtml, />Spam</);
  assert.match(indexHtml, />Trash</);
});

test("English-only: frontend modules carry no Chinese locale state or dictionary", () => {
  assert.doesNotMatch(uiJs, /mailbox_lang/, "mailbox_lang preference must be absent");
  assert.doesNotMatch(uiJs, /navigator\.language/, "browser locale auto-detection must be absent");
  assert.doesNotMatch(uiJs, /state\.lang/, "language state must be absent");
  assert.doesNotMatch(uiJs, /zh-CN/, "zh-CN locale must be absent");
  assert.doesNotMatch(uiJs, /language-toggle/, "language-toggle handler must be absent");
  assert.doesNotMatch(uiJs, /auth-language/, "auth-language handler must be absent");
  assert.match(uiJs, /document\.documentElement\.lang = "en"/, "document language must be permanently English");
});

test("English-only: first-party product surface contains no Han script copy", async () => {
  const surface = [
    "README.md", "CHANGELOG.md", "CONTRIBUTING.md", "SECURITY.md", "SUPPORT.md",
    indexHtml, uiJs,
    await joined(path.join(root, "docs"), ".md"),
  ].join("\n");
  const han = /\p{Script=Han}/u;
  assert.doesNotMatch(surface, han, "no Han characters in the first-party product/docs surface");
});

test("English-only: no locale-artifact filenames in the tracked tree", async () => {
  const { spawnSync } = await import("node:child_process");
  const tracked = spawnSync("git", ["ls-files"], { cwd: root, encoding: "utf8" }).stdout.split("\n");
  const forbidden = [
    (name) => /^README\.zh(-CN)?\.md$/i.test(name),
    (name) => /(^|\/)zh(-CN)?\//i.test(name),
    (name) => /(^|\/)(locales?|i18n)\/zh(-CN)?/i.test(name),
  ];
  const offenders = tracked.filter((name) => name && forbidden.some((pred) => pred(name)));
  assert.deepEqual(offenders, [], "no Chinese locale-artifact filenames may exist");
});

test("English-only: Unicode email capability tests remain present (capability preserved)", async () => {
  const lib = await readFile(path.join(root, "tests/lib.test.mjs"), "utf8");
  const auth = await readFile(path.join(root, "tests/auth-runtime.test.mjs"), "utf8");
  assert.match(lib, /[\p{Script=Han}\p{Emoji}]/u, "Unicode email-content handling stays tested");
  assert.match(auth, /\.repeat\(15\)/, "Unicode passphrase code-point policy stays tested");
});
