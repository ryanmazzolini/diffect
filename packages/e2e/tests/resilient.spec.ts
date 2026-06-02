import { test, expect } from "@playwright/test";

test("an in-progress comment draft survives a reload", async ({ page }) => {
  await page.goto("/");

  const line = page.locator("tr.line-add", { hasText: "TODO" }).first();
  await line.hover();
  await line.locator("button.comment-btn").click();
  await page.locator(".comment-form textarea").fill("draft that should persist");

  // Reload without submitting; reopen the form on the same line.
  await page.reload();
  const reopened = page.locator("tr.line-add", { hasText: "TODO" }).first();
  await reopened.hover();
  await reopened.locator("button.comment-btn").click();
  await expect(page.locator(".comment-form textarea")).toHaveValue(
    "draft that should persist",
  );
});
