import { test, expect } from "@playwright/test";

test("shows an overall diffstat summary and per-file counts", async ({ page }) => {
  await page.goto("/");
  await page.waitForSelector(".file-header");

  // The aggregate diffstat lives in the topbar identity row (+/- totals and the
  // five-square block); the old standalone summary bar was folded into it.
  const summary = page.locator(".rheader .diffstat");
  await expect(summary.locator(".diffstat-add")).toBeVisible();
  await expect(summary.locator(".diffstat-del")).toBeVisible();
  await expect(summary.locator(".diffstat-block")).toHaveCount(5);

  // Each file header carries its own +/- counts and a five-square block.
  const header = page.locator(".file-header").first();
  await expect(header.locator(".diffstat-add")).toBeVisible();
  await expect(header.locator(".diffstat-del")).toBeVisible();
  await expect(header.locator(".diffstat-block")).toHaveCount(5);
});
