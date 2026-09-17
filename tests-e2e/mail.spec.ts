import { expect, test } from "@playwright/test";

const ADMIN_EMAIL = "admin@example.com";
const PASSPHRASE = "correct horse battery staple 2026";
const BOOTSTRAP_TOKEN = "test-e2e-bootstrap-token-1234567890";

async function waitForServer(page) {
  // The dev server can crash and auto-restart on CI runners; wait for a
  // healthy response and a short stabilization window before navigating.
  await expect.poll(async () => {
    const response = await page.request.get("/healthz").catch(() => null);
    return response?.ok() ?? false;
  }, { timeout: 60_000, message: "dev server did not become healthy" }).toBe(true);
  await page.waitForTimeout(1_000);
}

async function ensureSignedIn(page) {
  await waitForServer(page);
  const statusResponse = page.waitForResponse(
    (response) => response.url().includes("/api/admin/mail/auth/status"),
    { timeout: 30_000 },
  );
  await page.goto("/admin/mail/");
  // The app chooses between the bootstrap and login paths only after
  // /auth/status resolves. Wait for that response and one render frame so the
  // form path is settled even on slow runners; otherwise the token field can
  // still be hidden (and left empty) when the test fills the form.
  await statusResponse.catch(() => {});
  await page.evaluate(() => new Promise((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(resolve));
  }));
  const bootstrapVisible = await page.locator("#bootstrap-field").isVisible();
  if (bootstrapVisible) {
    await page.locator("#auth-email").fill(ADMIN_EMAIL);
    await page.locator("#auth-password").fill(PASSPHRASE);
    await page.locator("#bootstrap-token").fill(BOOTSTRAP_TOKEN);
    await page.locator("#auth-submit").click();
  } else {
    await page.locator("#auth-email").fill(ADMIN_EMAIL);
    await page.locator("#auth-password").fill(PASSPHRASE);
    await page.locator("#auth-submit").click();
  }
  await page.waitForSelector("#mail-view:not([hidden])", { timeout: 30_000 });
}

test.describe("MailGable admin UI", () => {
  test("bootstrap, light default, dark toggle, folder navigation, compose, and logout", async ({ page }) => {
    await ensureSignedIn(page);

    await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
    const themeToggle = page.locator("#theme-toggle");
    await themeToggle.click();
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
    await page.reload();
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
    await themeToggle.click();
    await expect(page.locator("html")).toHaveAttribute("data-theme", "light");

    await page.locator('[data-folder="sent"]').click();
    await expect(page.locator('[data-folder="sent"]')).toHaveClass(/active/);

    await page.locator("#compose-button").click();
    await expect(page.locator("#compose-dialog")).toBeVisible();
    await expect(page.locator("#compose-to")).toBeVisible();
    await page.locator("#compose-cancel").click();
    await expect(page.locator("#compose-dialog")).not.toBeVisible();

    await page.locator("#logout-button").click();
    await expect(page.locator("#auth-view")).toBeVisible();
  });

  test("rejects an incorrect password during login", async ({ page }) => {
    await waitForServer(page);
    await page.goto("/admin/mail/");
    await page.locator("#auth-email").fill(ADMIN_EMAIL);
    await page.locator("#auth-password").fill("wrong-password-value");
    await page.locator("#auth-submit").click();
    await expect(page.locator("#auth-error")).not.toHaveAttribute("hidden", "");
  });

  test("bidi control characters are stripped from rendered subjects and sender names", async ({ page }) => {
    await ensureSignedIn(page);
    await page.waitForSelector(".thread", { timeout: 30_000 });
    const subjects = await page.locator(".thread-subject").allTextContents();
    expect(subjects.join("\n")).not.toContain("\u202E");
    const senders = await page.locator(".thread-top strong").allTextContents();
    expect(senders.join("\n")).not.toContain("\u202E");
    expect(senders.join("\n")).not.toContain("\u2067");
    const bidiThread = page.locator(".thread", { hasText: "fdp.exe invoice" });
    expect(await bidiThread.count()).toBeGreaterThan(0);
  });

  test("hostile mail HTML triggers zero outbound requests in the sandboxed viewer", async ({ page }) => {
    await ensureSignedIn(page);
    const externalRequests: string[] = [];
    page.on("request", (request) => {
      const host = new URL(request.url()).hostname;
      if (host !== "localhost" && host !== "127.0.0.1" && host !== "::1") externalRequests.push(request.url());
    });

    await page.waitForSelector(".thread", { timeout: 30_000 });
    const hostile = page.locator(".thread", { hasText: "Security test: remote content" });
    await expect(hostile).toHaveCount(1);
    await hostile.click();
    await page.waitForSelector(".message-frame", { timeout: 15_000 });

    // The sandbox must never combine scripts with same-origin access.
    const sandbox = (await page.locator(".message-frame").getAttribute("sandbox")) || "";
    expect(sandbox).not.toContain("allow-scripts");
    expect(sandbox).not.toContain("allow-same-origin");

    // Give any (incorrectly) surviving reference time to fire, then prove zero
    // outbound requests: sanitizer + iframe CSP (`default-src 'none'`) hold.
    await page.waitForTimeout(1_500);
    expect(externalRequests).toEqual([]);

    // The frame document must contain no active remote references (safe
    // https links remain clickable, but every automatic-load vector is gone).
    // The wrapper injects its own trusted `<style>`/`<base>` scaffolding; the
    // sanitized message content must not introduce any of the vectors below.
    const frame = page.frames().find((candidate) => candidate.url().startsWith("about:srcdoc"));
    expect(frame).toBeTruthy();
    const html = await frame!.content();
    for (const vector of ["<script", "<iframe", "<object", "<embed", "<svg", "<link", "@import", "javascript:"]) {
      expect(html.toLowerCase()).not.toContain(vector);
    }
    expect(html).not.toMatch(/\ssrc=/i);
    expect(html).not.toMatch(/\ssrcset=/i);
    expect(html).not.toMatch(/\sstyle=/i);
  });

  test("admin UI stays English even under a zh-CN browser locale", async ({ browser }) => {
    // A zh-CN browser locale must never silently activate a Chinese UI.
    const context = await browser.newContext({ locale: "zh-CN" });
    const page = await context.newPage();
    try {
      await waitForServer(page);
      await page.goto("/admin/mail/");
      await expect(page.locator("html")).toHaveAttribute("lang", "en");
      await expect(page.locator("#auth-view")).toBeVisible();
      await expect(page.locator("#auth-title")).toHaveText("Mail Admin");
      await expect(page.locator("#auth-form label:has-text(\"Administrator email\")")).toBeVisible();
      await expect(page.locator("#auth-form label:has-text(\"Password\")")).toBeVisible();
      await expect(page.locator("#language-toggle")).toHaveCount(0);
      await expect(page.locator("#auth-language")).toHaveCount(0);
      expect(await page.locator("body").innerText()).not.toContain("登录");
    } finally {
      await context.close();
    }
  });

  test("main console folders render in English", async ({ page }) => {
    await ensureSignedIn(page);
    await page.waitForSelector(".folder", { timeout: 30_000 });
    const folders = await page.locator(".folder b").allTextContents();
    for (const expected of ["Inbox", "Sent", "Archive", "Spam", "Trash", "All mail"]) {
      expect(folders).toContain(expected);
    }
    await expect(page.locator("#language-toggle")).toHaveCount(0);
  });
});