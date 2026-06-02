import { test, expect } from "@playwright/test";

/** The compare picker lists refs and can target a ref range or a raw spec. */
test("compare picker lists refs and applies targets", async ({ page }) => {
  await page.goto("/");

  // base…compare dropdowns are populated from the repo's refs (fixture has main).
  const baseSelect = page.locator('.compare select[title="Base"]');
  await expect(baseSelect).toBeVisible();
  await expect(baseSelect).toContainText("main");

  // Selecting a base forms a base...compare target; the diff reloads, no error.
  await baseSelect.selectOption("main");
  await expect(page.locator(".error")).toHaveCount(0);

  // The raw ref/range escape hatch applies on Enter.
  const raw = page.locator(".raw-target");
  await raw.fill("staged");
  await raw.press("Enter");
  await expect(page.locator(".error")).toHaveCount(0);
});
