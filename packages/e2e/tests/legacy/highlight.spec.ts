import { test, expect } from "@playwright/test";

/** Diff lines are syntax-highlighted (highlight.js token spans), per language. */
test("renders syntax-highlighted tokens in the diff", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator(".file-path", { hasText: "calc.js" })).toBeVisible();
  // The fixture's JS (export/function/return) yields highlight.js keyword tokens.
  await expect(page.locator(".code .hljs-keyword").first()).toBeVisible();
});
