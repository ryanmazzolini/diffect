import { test, expect, type Locator, type Page } from "@playwright/test";

async function clickAddWidget(page: Page, row: Locator) {
  await row.evaluate((el) => el.scrollIntoView({ block: "center" }));
  await row.hover();
  const widget = row.locator("button.diff-add-widget").first();
  const box = await widget.boundingBox();
  expect(box).not.toBeNull();
  await page.mouse.click(box!.x + box!.width / 2, box!.y + box!.height / 2);
}

test("an in-progress comment draft survives a reload", async ({ page }) => {
  await page.goto("/?renderer=git");

  const row = page.locator("tbody.diff-table-body tr", { hasText: "TODO" }).first();
  await clickAddWidget(page, row);
  await page.locator(".comment-form textarea").fill("draft that should persist");

  // Reload without submitting; reopen the form on the same line.
  await page.reload();
  const reopened = page.locator("tbody.diff-table-body tr", { hasText: "TODO" }).first();
  await clickAddWidget(page, reopened);
  await expect(page.locator(".comment-form textarea")).toHaveValue(
    "draft that should persist",
  );
});

test("restores the active file after reload", async ({ page }) => {
  await page.goto("/?renderer=git");

  await page.locator(".tree-file", { hasText: "math.js" }).click();
  await expect(page.locator(".tree-file.active")).toContainText("math.js");

  await page.reload();

  await expect(page.locator(".tree-file.active")).toContainText("math.js");
  await expect(page.locator(".diff-pane .file", { hasText: "math.js" }).first()).toBeVisible();
});
