import { test, expect } from "@playwright/test";

/**
 * A dismissed thread collapses to a marker in the diff (feedback never vanishes
 * silently), and a non-open thread can be deleted outright.
 */
test("dismissed thread collapses in the diff, then can be deleted", async ({
  page,
}) => {
  await page.goto("/");

  // Create a thread on the changed line.
  const line = page.locator("tr.line-add", { hasText: "TODO" }).first();
  await line.hover();
  await line.locator("button.comment-btn").click();
  await page.locator(".comment-form textarea").fill("nit: spacing here");
  await page
    .locator(".comment-form")
    .getByRole("button", { name: "Comment" })
    .click();

  // Dismiss it from the inline conversation.
  const thread = page
    .locator(".inline-thread", { hasText: "nit: spacing here" })
    .first();
  await thread.getByRole("button", { name: "Dismiss" }).click();

  // It now shows as a collapsed marker rather than the full conversation.
  await expect(page.locator(".thread-collapsed.status-dismissed")).toBeVisible();

  // Expand and delete it.
  await page.locator(".thread-collapsed").click();
  await page
    .locator(".inline-thread", { hasText: "nit: spacing here" })
    .first()
    .getByRole("button", { name: "Delete" })
    .click();

  // Gone from the diff entirely.
  await expect(page.locator(".thread-collapsed")).toHaveCount(0);
  await expect(
    page.locator(".inline-thread", { hasText: "nit: spacing here" }),
  ).toHaveCount(0);
});
