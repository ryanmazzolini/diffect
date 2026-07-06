import { test, expect } from "@playwright/test";

test("marking a file viewed collapses it and updates the count", async ({ page }) => {
  await page.goto("/?renderer=git");
  const calc = page.locator(".file", { hasText: "calc.js" });
  await expect(calc.locator("[data-component='git-diff-view']").first()).toBeVisible();

  await calc.getByRole("checkbox", { name: "Viewed" }).check();
  await expect(calc.locator("[data-component='git-diff-view']")).toHaveCount(0); // body collapsed
  // Review progress (now in the sidebar) reflects the newly-viewed file.
  await expect(page.locator(".review-progress-count")).toHaveText("1/3");
});

test("j/k move the active file", async ({ page }) => {
  await page.goto("/?renderer=git");
  await expect(page.locator(".tree-file").first()).toBeVisible();

  // Files are in tree order (folders first), so src/util/math.js precedes calc.js.
  // k clamps to the first file; j advances to the next.
  await page.keyboard.press("k");
  await expect(page.locator(".tree-file.active")).toContainText("math.js");
  await page.keyboard.press("j");
  await expect(page.locator(".tree-file.active")).toContainText("calc.js");
});
