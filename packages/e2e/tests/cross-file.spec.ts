import { test, expect } from "./fixtures.js";

test("comment on an unchanged file from the all-files sidebar", async ({ page }) => {
  await page.goto("/");

  // Switch the sidebar from changed files to all tracked files and choose the
  // unchanged README (not in the current diff).
  await page.getByRole("button", { name: "All files" }).click();
  await page.locator(".tree-file", { hasText: "README.md" }).click();

  const preview = page.locator(".full-file-preview", { hasText: "README.md" });
  await expect(preview).toBeVisible();
  await expect(preview).toContainText("not in this diff");

  // Hover a line and open the comment form via the + affordance.
  const row = preview.locator(".full-file-lines tr.line").first();
  await row.hover();
  await row.locator("button.comment-btn").click();
  await preview.locator(".comment-form textarea").fill("typo on this line");
  await preview.locator(".comment-form").getByRole("button", { name: "Comment" }).click();

  // The thread renders inline in the full-file preview and in the inbox.
  await expect(
    preview.locator(".inline-thread .c-text", { hasText: "typo on this line" }).first(),
  ).toBeVisible();
  await expect(page.locator(".thread-pane")).toContainText("typo on this line");
});
