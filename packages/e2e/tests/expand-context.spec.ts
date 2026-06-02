import { test, expect } from "@playwright/test";

/** Collapsed context above a hunk can be unfolded to reveal the surrounding code. */
test("unfolds collapsed context above a hunk", async ({ page }) => {
  await page.goto("/");

  const unfold = page.locator(".unfold-btn").first();
  await expect(unfold).toBeVisible();
  await unfold.click();

  // The fixture's leading constants (k0…) appear as unfolded context lines.
  await expect(
    page.locator(".line-context", { hasText: "k0 = 0" }).first(),
  ).toBeVisible();
  await expect(page.locator(".unfold-btn")).toHaveCount(0); // button consumed
});
