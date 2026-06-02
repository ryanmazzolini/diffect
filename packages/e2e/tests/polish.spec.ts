import { test, expect } from "@playwright/test";

test("marking a file viewed collapses it and updates the count", async ({ page }) => {
  await page.goto("/");
  const calc = page.locator(".file", { hasText: "calc.js" });
  await expect(calc.locator("table.hunk").first()).toBeVisible();

  await calc.getByRole("checkbox", { name: "Viewed" }).check();
  await expect(calc.locator("table.hunk")).toHaveCount(0); // body collapsed
  await expect(page.locator(".viewed-count")).toContainText("1/2 viewed");
});

test("j/k move the active file", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator(".tree-file").first()).toBeVisible();

  // k clamps to the first file; j advances to the next.
  await page.keyboard.press("k");
  await expect(page.locator(".tree-file.active")).toContainText("calc.js");
  await page.keyboard.press("j");
  await expect(page.locator(".tree-file.active")).toContainText("math.js");
});
