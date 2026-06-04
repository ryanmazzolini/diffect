import { test, expect } from "@playwright/test";

test("toggles line wrapping and persists the choice", async ({ page }) => {
  await page.goto("/");
  const code = page.locator(".code").first();
  await expect(code).toBeVisible();

  // Wrapping is on by default: long lines wrap instead of scrolling.
  await expect(code).toHaveCSS("white-space", "pre-wrap");

  await page.getByRole("button", { name: "No wrap" }).click();
  await expect(code).toHaveCSS("white-space", "pre");
  // The per-file scroll container takes over horizontal overflow.
  await expect(page.locator(".file-body").first()).toHaveCSS("overflow-x", "auto");

  await page.reload();
  await expect(page.locator(".code").first()).toHaveCSS("white-space", "pre"); // persisted

  await page.getByRole("button", { name: "Wrap", exact: true }).click();
  await expect(page.locator(".code").first()).toHaveCSS("white-space", "pre-wrap");
});

test("no-wrap mode works in split view too", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Split" }).click();
  await page.getByRole("button", { name: "No wrap" }).click();

  // Split table drops fixed layout so columns size to content and scroll.
  const splitCode = page.locator("table.hunk-split td.code").first();
  await expect(splitCode).toHaveCSS("white-space", "pre");
  await expect(page.locator(".file-body").first()).toHaveCSS("overflow-x", "auto");
});
