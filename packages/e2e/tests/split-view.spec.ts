import { test, expect } from "@playwright/test";

test("toggles split (side-by-side) view and persists the choice", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator("table.hunk-split")).toHaveCount(0); // unified by default

  await page.getByRole("button", { name: "Split" }).click();
  await expect(page.locator("table.hunk-split").first()).toBeVisible();

  await page.reload();
  await expect(page.locator("table.hunk-split").first()).toBeVisible(); // persisted

  await page.getByRole("button", { name: "Unified" }).click();
  await expect(page.locator("table.hunk-split")).toHaveCount(0);
});

test("comments on a line in split view", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Split" }).click();

  const addCell = page.locator(".hunk-split td.code.line-add").first();
  await addCell.hover();
  await addCell.locator("button.comment-btn").click();
  await page.locator(".comment-form textarea").fill("comment from split view");
  await page
    .locator(".comment-form")
    .getByRole("button", { name: "Comment" })
    .click();

  await expect(
    page.locator(".inline-thread .body", { hasText: "comment from split view" }).first(),
  ).toBeVisible();
});
