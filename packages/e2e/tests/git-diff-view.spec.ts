import { test, expect } from "@playwright/test";

// Core coverage for the git-diff-view-backed renderer: that it renders rows,
// supports our inline comment flow (add-widget → CommentForm → thread), and
// honours the split/wrap toggles. Replaces the hand-rolled-DOM specs now in
// tests/legacy/ (see tests/legacy/README.md).

test("renders diff rows via git-diff-view", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  await page.goto("/");
  await page.waitForSelector(".file-path");

  const body = page.locator("[data-component='git-diff-view']").first();
  await expect(body).toBeVisible();
  await expect(page.locator("tbody.diff-table-body tr").first()).toBeVisible();
  expect(errors, errors.join("\n")).toEqual([]);
});

test("comments on a line through the add-widget", async ({ page }) => {
  await page.goto("/");
  await page.waitForSelector("tbody.diff-table-body tr");

  const row = page.locator("tbody.diff-table-body tr").first();
  await row.hover();
  await row.locator("button.diff-add-widget").first().click();

  await expect(page.locator(".comment-form textarea")).toBeVisible();
  await page.locator(".comment-form textarea").fill("comment via git-diff-view");
  await page.locator(".comment-form").getByRole("button", { name: "Comment" }).click();

  // Renders back inline (renderExtendLine) and in the thread pane.
  await expect(
    page.locator(".inline-thread .body", { hasText: "comment via git-diff-view" }).first(),
  ).toBeVisible();
  await expect(
    page.locator(".thread-list .body, .thread-pane", { hasText: "comment via git-diff-view" }).first(),
  ).toBeVisible();
});

test("toggles split (side-by-side) view", async ({ page }) => {
  await page.goto("/");
  await page.waitForSelector("tbody.diff-table-body tr");
  await expect(page.locator(".diff-line-old-content")).toHaveCount(0); // unified default

  await page.getByRole("button", { name: "Split" }).click();
  await expect(page.locator(".diff-line-old-content").first()).toBeVisible();

  await page.getByRole("button", { name: "Unified" }).click();
  await expect(page.locator(".diff-line-old-content")).toHaveCount(0);
});

test("toggles line wrapping", async ({ page }) => {
  await page.goto("/");
  await page.waitForSelector("tbody.diff-table-body tr");
  await expect(page.locator(".unified-diff-view-wrap").first()).toBeVisible(); // wrap default

  await page.getByRole("button", { name: "No wrap" }).click();
  await expect(page.locator(".unified-diff-view-normal").first()).toBeVisible();

  await page.reload();
  await expect(page.locator(".unified-diff-view-normal").first()).toBeVisible(); // persisted
});
