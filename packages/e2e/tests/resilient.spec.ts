import { test, expect } from "@playwright/test";

test("an in-progress comment draft survives a reload", async ({ page }) => {
  await page.goto("/");

  const row = page.locator("tbody.diff-table-body tr", { hasText: "TODO" }).first();
  await row.hover();
  await row.locator("button.diff-add-widget").first().click();
  await page.locator(".comment-form textarea").fill("draft that should persist");

  // Reload without submitting; reopen the form on the same line.
  await page.reload();
  const reopened = page.locator("tbody.diff-table-body tr", { hasText: "TODO" }).first();
  await reopened.hover();
  await reopened.locator("button.diff-add-widget").first().click();
  await expect(page.locator(".comment-form textarea")).toHaveValue(
    "draft that should persist",
  );
});
