import { test, expect } from "@playwright/test";

/**
 * Customer-experience flows against a live diffectd serving the built SPA over a
 * real fixture git repo. These exercise the paths a reviewer actually takes:
 * load the diff, leave a comment, resolve it, and switch the review target.
 */

test("loads the workspace and shows the work diff", async ({ page }) => {
  await page.goto("/");
  // The brand is now a compact "d" logo mark; this is just a shell-loaded smoke check.
  await expect(page.locator(".brand")).toBeVisible();
  // The fixture has a modified calc.js in the default work target.
  await expect(page.locator(".file-path", { hasText: "calc.js" })).toBeVisible();
  await expect(page.locator("tbody.diff-table-body tr").first()).toBeVisible();
});

test("creates an inline comment and it appears in the inbox", async ({ page }) => {
  await page.goto("/");
  // Hover the changed line to reveal the comment affordance, then open the form.
  const addedLine = page.locator("tbody.diff-table-body tr", { hasText: "TODO" }).first();
  await addedLine.hover();
  await addedLine.locator("button.diff-add-widget").first().click();

  const form = page.locator(".comment-form");
  await expect(form).toBeVisible();
  await form.locator("textarea").fill("Does this overflow for large ints?");
  await form.getByRole("button", { name: "Comment" }).click();

  // The new thread shows inline and in the thread inbox.
  await expect(
    page.locator(".inline-thread .c-text", { hasText: "overflow for large ints" }).first(),
  ).toBeVisible();
  await expect(page.locator(".thread-pane")).toContainText("overflow for large ints");
});

test("resolves a thread and the open count drops", async ({ page }) => {
  await page.goto("/");
  // Create a thread first.
  const row = page.locator("tbody.diff-table-body tr", { hasText: "TODO" }).first();
  await row.hover();
  await row.locator("button.diff-add-widget").first().click();
  await page.locator(".comment-form textarea").fill("please rename this");
  await page.locator(".comment-form").getByRole("button", { name: "Comment" }).click();

  // Wait for the new thread to render inline — that means the store and the
  // scoped counts have refreshed.
  const thread = page
    .locator(".inline-thread", { hasText: "please rename this" })
    .first();
  await expect(thread).toBeVisible();

  // The open filter shows a live count of open threads for this repo.
  const openCount = page
    .locator(".filter", { hasText: "open" })
    .locator(".filter-count");
  const before = Number(await openCount.innerText());
  expect(before).toBeGreaterThanOrEqual(1);

  // Close via the inline conversation controls.
  await thread.getByRole("button", { name: "Close" }).click();

  // The status filter still defaults to "open", so the closed thread leaves
  // the inline view; switching the filter to "closed" surfaces it again.
  await page.locator(".filter", { hasText: "closed" }).click();
  await expect(
    page.locator(".thread-card.status-closed", { hasText: "please rename this" }),
  ).toBeVisible();
  // …and the open count dropped by one.
  await expect(openCount).toHaveText(String(before - 1));
});

test("switches review target without errors", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator(".file-path", { hasText: "calc.js" })).toBeVisible();
  // Scope to the Topbar's local-mode control: selecting a target also surfaces that
  // review as a sidebar session-item sharing the same accessible name, so an
  // unscoped getByRole would be ambiguous once the diff settles.
  const modes = page.locator(".local-targets");
  // The fixture has no staged changes, so Staged shows the empty state.
  await modes.getByRole("button", { name: "Staged changes", exact: true }).click();
  await expect(page.locator(".empty")).toContainText("No changes");
  // Back to all local changes restores the diff.
  await modes.getByRole("button", { name: "All local changes", exact: true }).click();
  await expect(page.locator(".file-path", { hasText: "calc.js" })).toBeVisible();
});
