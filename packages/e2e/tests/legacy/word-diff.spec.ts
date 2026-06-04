import { test, expect } from "@playwright/test";

/**
 * Intra-line (word-level) diff: a replaced line tints only the words that
 * actually changed, not the whole line.
 */
test("tints only the changed words within a replaced line", async ({ page }) => {
  await page.goto("/");

  // The fixture appends "// TODO…" to a line, so the added comment is the only
  // tinted span on the add side.
  await expect(
    page.locator(".line-add .diff-word", { hasText: "TODO" }).first(),
  ).toBeVisible();

  // The paired removed line is otherwise unchanged, so it gets no word tint.
  await expect(page.locator(".line-del .diff-word")).toHaveCount(0);
});
