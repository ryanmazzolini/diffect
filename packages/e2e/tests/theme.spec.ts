import { test, expect } from "@playwright/test";

/** The theme toggle flips dark/light and the choice survives a reload. */
test("toggles light/dark and persists across reload", async ({ page }) => {
  await page.goto("/");
  const html = page.locator("html");
  await expect(html).toHaveAttribute("data-theme", "dark"); // default

  await expect(page.locator(".theme-toggle")).toHaveText("☀");
  await page.locator(".theme-toggle").click();
  await expect(html).toHaveAttribute("data-theme", "light");
  await expect(page.locator(".theme-toggle")).toHaveText("☾");

  await page.reload();
  await expect(html).toHaveAttribute("data-theme", "light"); // persisted
});
