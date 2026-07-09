import { test, expect } from "./fixtures.js";
import { openCmCommentForm } from "./helpers.js";

/**
 * A resolved thread collapses to a marker in the diff (feedback never vanishes
 * silently), and a non-open thread can be deleted outright.
 */
test("resolved thread collapses in the diff, then can be deleted", async ({
  page,
}) => {
  await page.goto("/");

  // Create a thread on the changed line.
  const form = await openCmCommentForm(page);
  await form.locator("textarea").fill("nit: spacing here");
  await form.getByRole("button", { name: "Comment" }).click();

  // Close it from the inline conversation.
  const thread = page
    .locator(".inline-thread", { hasText: "nit: spacing here" })
    .first();
  await thread.getByRole("button", { name: "Close" }).click();

  // It now shows as a collapsed marker rather than the full conversation.
  const collapsed = page.locator(".thread-collapsed.status-closed", { hasText: "nit: spacing here" });
  await expect(collapsed).toBeVisible();

  // Expand and delete it (Delete now asks for confirmation).
  await collapsed.click();
  const expanded = page.locator(".inline-thread", { hasText: "nit: spacing here" }).first();
  await expect(expanded).toBeVisible();
  page.once("dialog", (d) => d.accept());
  await expanded.getByRole("button", { name: "Delete" }).click({ force: true });

  // Gone from the diff entirely.
  await expect(page.locator(".thread-collapsed", { hasText: "nit: spacing here" })).toHaveCount(0);
  await expect(
    page.locator(".inline-thread", { hasText: "nit: spacing here" }),
  ).toHaveCount(0);
});
