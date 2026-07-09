import { test, expect } from "./fixtures.js";
import { openCmCommentForm } from "./helpers.js";

async function startClean(page) {
  await page.goto("/");
  await page.evaluate(() => localStorage.clear());
  await page.reload();
}

test("an in-progress comment draft survives a reload", async ({ page }) => {
  await startClean(page);

  const form = await openCmCommentForm(page);
  await form.locator("textarea").fill("draft that should persist");

  // Reload without submitting; reopen the form on the same line.
  await page.reload();
  const reopened = await openCmCommentForm(page);
  await expect(reopened.locator("textarea")).toHaveValue(
    "draft that should persist",
  );
});

test("keeps an in-progress reply open through a thread refresh", async ({ page }) => {
  await page.goto("/");

  const commentForm = await openCmCommentForm(page);
  await commentForm.locator("textarea").fill("thread with a draft reply");
  await commentForm.getByRole("button", { name: "Comment" }).click();

  const thread = page.locator(".inline-thread", { hasText: "thread with a draft reply" }).first();
  await expect(thread).toBeVisible();
  await thread.getByRole("button", { name: "Reply" }).click();

  await page.reload();

  const reopened = page.locator(".inline-thread", { hasText: "thread with a draft reply" }).first();
  await expect(reopened.locator(".reply-form textarea")).toBeVisible();
  await reopened.locator(".reply-form textarea").fill("reply that should survive");
  await expect
    .poll(() =>
      page.evaluate(() =>
        Object.entries(localStorage).some(
          ([key, value]) => key.startsWith("draft-reply:") && value === "reply that should survive",
        ),
      ),
    )
    .toBe(true);

  await page.reload();

  const restored = page.locator(".inline-thread", { hasText: "thread with a draft reply" }).first();
  await expect(restored.locator(".reply-form textarea")).toHaveValue("reply that should survive");
});

test("restores the active file after reload", async ({ page }) => {
  await startClean(page);

  await page.locator(".tree-file", { hasText: "math.js" }).click();
  await expect(page.locator(".tree-file.active")).toContainText("math.js");

  await page.reload();

  await expect(page.locator(".tree-file.active")).toContainText("math.js");
  await expect(page.locator(".diff-pane .file", { hasText: "math.js" }).first()).toBeVisible();
});
