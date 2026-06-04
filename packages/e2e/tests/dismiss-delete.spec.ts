import { test, expect } from "@playwright/test";

/**
 * A resolved thread collapses to a marker in the diff (feedback never vanishes
 * silently), and a non-open thread can be deleted outright.
 */
test("resolved thread collapses in the diff, then can be deleted", async ({
  page,
}) => {
  await page.goto("/");

  // Create a thread on the changed line.
  const row = page.locator("tbody.diff-table-body tr", { hasText: "TODO" }).first();
  await row.hover();
  await row.locator("button.diff-add-widget").first().click();
  await page.locator(".comment-form textarea").fill("nit: spacing here");
  await page
    .locator(".comment-form")
    .getByRole("button", { name: "Comment" })
    .click();

  // Close it from the inline conversation.
  const thread = page
    .locator(".inline-thread", { hasText: "nit: spacing here" })
    .first();
  await thread.getByRole("button", { name: "Close" }).click();

  // It now shows as a collapsed marker rather than the full conversation.
  await expect(page.locator(".thread-collapsed.status-closed")).toBeVisible();

  // Expand and delete it (Delete now asks for confirmation).
  await page.locator(".thread-collapsed").click();
  page.once("dialog", (d) => d.accept());
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
