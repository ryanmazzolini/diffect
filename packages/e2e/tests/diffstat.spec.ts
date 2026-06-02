import { test, expect } from "@playwright/test";

test("shows an overall diffstat summary and per-file counts", async ({ page }) => {
  await page.goto("/");

  // Overall summary bar: "<n> file(s) changed" plus the aggregate block.
  const summary = page.locator(".diff-summary");
  await expect(summary).toContainText("changed");
  await expect(summary.locator(".diffstat-add")).toBeVisible();
  await expect(summary.locator(".diffstat-block")).toHaveCount(5);

  // Each file header carries its own +/- counts and a five-square block.
  const header = page.locator(".file-header").first();
  await expect(header.locator(".diffstat-add")).toBeVisible();
  await expect(header.locator(".diffstat-del")).toBeVisible();
  await expect(header.locator(".diffstat-block")).toHaveCount(5);
});
