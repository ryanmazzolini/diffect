import { test, expect } from "@playwright/test";

test("renders the opt-in CodeMirror diff renderer", async ({ page }) => {
  await page.goto("/?renderer=cm6");
  await expect(page.locator(".file-header").first()).toBeVisible();
  await expect(page.locator(".cm-diff-host .cm-editor").first()).toBeVisible();
  await expect(page.locator(".cm-diff-host .cm-inlineChangedLine").first()).toBeVisible();
});
