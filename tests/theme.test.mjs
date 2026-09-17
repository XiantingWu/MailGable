import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const stateModule = await readFile("public/js/state.mjs", "utf8");
const appModule = await readFile("public/js/app.mjs", "utf8");
const css = await readFile("public/mail.css", "utf8");
const html = await readFile("public/index.html", "utf8");

function resolveTheme(stored) {
  return stored === "dark" ? "dark" : "light";
}

test("theme defaults to light regardless of stored value", () => {
  assert.equal(resolveTheme(null), "light");
  assert.equal(resolveTheme(undefined), "light");
  assert.equal(resolveTheme("light"), "light");
  assert.equal(resolveTheme("dark"), "dark");
  assert.equal(resolveTheme("anything-else"), "light");
});

test("theme toggle persists through the mailbox_theme key", () => {
  assert.match(stateModule, /localStorage\.getItem\("mailbox_theme"\)/);
  assert.match(stateModule, /localStorage\.setItem\("mailbox_theme", state\.theme\)/);
  assert.match(stateModule, /resolveTheme\(localStorage\.getItem\("mailbox_theme"\)\)/);
  assert.match(stateModule, /state\.theme = state\.theme === "dark" \? "light" : "dark"/);
  assert.match(stateModule, /export function resolveTheme\(stored\) \{\s*return stored === "dark" \? "dark" : "light";\s*\}/);
});

test("theme toggle is wired and applied at startup", () => {
  assert.match(appModule, /\$\("theme-toggle"\)\.addEventListener\("click", toggleTheme\)/);
  assert.match(appModule, /applyTheme\(\);/);
});

test("light theme is the CSS default and dark is opt-in via data-theme", () => {
  assert.match(css, /color-scheme:light/);
  assert.doesNotMatch(css, /prefers-color-scheme/);
  assert.match(css, /:root\[data-theme="dark"\]\{color-scheme:dark/);
  assert.match(html, /<meta name="color-scheme" content="light">/);
  assert.match(html, /id="theme-toggle"/);
});