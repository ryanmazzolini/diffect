import { test, expect } from "./fixtures.js";

/** With no stored choice, the first load follows the OS color-scheme preference. */
test("defaults to the OS color scheme on first load", async ({ page }) => {
  await page.emulateMedia({ colorScheme: "light" });
  await page.goto("/");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
});

/** The theme toggle flips dark/light and the choice survives a reload. */
test("toggles light/dark and persists across reload", async ({ page }) => {
  await page.emulateMedia({ colorScheme: "dark" });
  await page.goto("/");
  const html = page.locator("html");
  await expect(html).toHaveAttribute("data-theme", "dark"); // matches OS pref

  // In dark mode the toggle offers the sun (switch to light); in light, the moon.
  await expect(page.locator('.theme-toggle [data-icon="sun"]')).toBeVisible();
  await page.locator(".theme-toggle").click();
  await expect(html).toHaveAttribute("data-theme", "light");
  await expect(page.locator('.theme-toggle [data-icon="moon"]')).toBeVisible();

  await page.reload();
  await expect(html).toHaveAttribute("data-theme", "light"); // persisted
});
