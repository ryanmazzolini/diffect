import { test, expect } from "@playwright/test";

test("comment on a file outside the diff, shown as an out-of-diff block", async ({
  page,
}) => {
  await page.goto("/");

  // Open the cross-file picker and choose the unchanged README (not in the diff).
  await page.getByRole("button", { name: "Comment on another file" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.locator(".aw-input").fill("README");
  await dialog.locator(".cf-file", { hasText: "README.md" }).click();

  // Hover a line and open the comment form via the + affordance.
  const row = dialog.locator(".cf-lines tr.line").first();
  await row.hover();
  await row.locator("button.comment-btn").click();
  await dialog.locator(".comment-form textarea").fill("typo on this line");
  await dialog.locator(".comment-form").getByRole("button", { name: "Comment" }).click();

  // The dialog closes and the thread surfaces as an out-of-diff block + in the inbox.
  await expect(page.getByRole("dialog")).toHaveCount(0);
  const block = page.locator(".file.out-of-diff", { hasText: "README.md" });
  await expect(block).toBeVisible();
  await expect(block).toContainText("typo on this line");
  await expect(page.locator(".thread-pane")).toContainText("typo on this line");
});
