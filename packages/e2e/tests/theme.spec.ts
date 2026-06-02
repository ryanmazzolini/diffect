import { test, expect } from "@playwright/test";

/** The theme toggle flips dark/light and the choice survives a reload. */
test("toggles light/dark and persists across reload", async ({ page }) => {
  await page.goto("/");
  const html = page.locator("html");
  await expect(html).toHaveAttribute("data-theme", "dark"); // default

  // In dark mode the toggle offers the sun (switch to light); in light, the moon.
  await expect(page.locator('.theme-toggle [data-icon="sun"]')).toBeVisible();
  await page.locator(".theme-toggle").click();
  await expect(html).toHaveAttribute("data-theme", "light");
  await expect(page.locator('.theme-toggle [data-icon="moon"]')).toBeVisible();

  await page.reload();
  await expect(html).toHaveAttribute("data-theme", "light"); // persisted
});
