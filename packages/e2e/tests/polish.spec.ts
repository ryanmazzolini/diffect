import { test, expect } from "./fixtures.js";

test("j/k move the active file", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator(".tree-file").first()).toBeVisible();

  // Files are in tree order (folders first), so src/util/math.js precedes calc.js.
  // k clamps to the first file; j advances to the next.
  await page.keyboard.press("k");
  await expect(page.locator(".tree-file.active")).toContainText("math.js");
  await page.keyboard.press("j");
  await expect(page.locator(".tree-file.active")).toContainText("calc.js");
});
