import { test, expect } from "@playwright/test";
import { openCmCommentForm } from "./helpers.js";

async function startClean(page) {
  await page.goto("/");
  await page.evaluate(() => localStorage.clear());
  await page.reload();
}

test("an in-progress comment draft survives a reload", async ({ page }) => {
  await startClean(page);

  const form = await openCmCommentForm(page);
  await form.locator("textarea").fill("draft that should persist");

  // Reload without submitting; reopen the form on the same line.
  await page.reload();
  const reopened = await openCmCommentForm(page);
  await expect(reopened.locator("textarea")).toHaveValue(
    "draft that should persist",
  );
});

test("restores the active file after reload", async ({ page }) => {
  await startClean(page);

  await page.locator(".tree-file", { hasText: "math.js" }).click();
  await expect(page.locator(".tree-file.active")).toContainText("math.js");

  await page.reload();

  await expect(page.locator(".tree-file.active")).toContainText("math.js");
  await expect(page.locator(".diff-pane .file", { hasText: "math.js" }).first()).toBeVisible();
});
