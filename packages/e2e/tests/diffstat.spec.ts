import { test, expect } from "./fixtures.js";

test("shows an overall diffstat summary and per-file counts", async ({ page }) => {
  await page.goto("/");
  await page.waitForSelector(".file-header");

  // The aggregate diffstat lives in the module header as quiet +/- totals.
  const summary = page.locator(".rheader .diffstat");
  await expect(summary.locator(".diffstat-add")).toBeVisible();
  await expect(summary.locator(".diffstat-del")).toBeVisible();
  await expect(summary.locator(".diffstat-block")).toHaveCount(0);

  // Each file header carries its own quiet +/- counts too.
  const header = page.locator(".file-header").first();
  await expect(header.locator(".diffstat-add")).toBeVisible();
  await expect(header.locator(".diffstat-del")).toBeVisible();
  await expect(header.locator(".diffstat-block")).toHaveCount(0);
});
