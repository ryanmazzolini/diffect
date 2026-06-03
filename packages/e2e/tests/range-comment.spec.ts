import { test, expect } from "@playwright/test";

/** Select a span of lines (click + shift-click the gutter) and comment on it. */
test("selects a line range and comments on it", async ({ page }) => {
  await page.goto("/");

  // Use the first two new-side gutters (a range can't span a deletion boundary,
  // since removed lines anchor to the old side).
  const gutters = page.locator("td.ln-clickable");
  await gutters.first().click();
  await gutters.nth(1).click({ modifiers: ["Shift"] });

  // The range is highlighted across multiple rows.
  await expect(page.locator("tr.line-selected").first()).toBeVisible();
  expect(await page.locator("tr.line-selected").count()).toBeGreaterThan(1);

  // Open the comment form on the selection; its placeholder shows a line range.
  const last = page.locator("tr.line-selected").last();
  await last.hover();
  await last.locator("button.comment-btn").click();
  await expect(page.locator(".comment-form textarea")).toHaveAttribute(
    "placeholder",
    /:\d+-\d+$/,
  );

  await page.locator(".comment-form textarea").fill("these lines need a guard");
  await page
    .locator(".comment-form")
    .getByRole("button", { name: "Comment" })
    .click();
  await expect(
    page
      .locator(".inline-thread .body", { hasText: "these lines need a guard" })
      .first(),
  ).toBeVisible();
});

test("comments on a removed line (old-side anchor)", async ({ page }) => {
  await page.goto("/");

  // Removed lines anchor on the old side; the + lives on the deletion row.
  const delRow = page.locator("tr.line-del").first();
  await delRow.scrollIntoViewIfNeeded();
  await delRow.hover();
  await delRow.locator("button.comment-btn").click();

  await expect(page.locator(".comment-form textarea")).toBeVisible();
  await page.locator(".comment-form textarea").fill("why was this removed?");
  await page
    .locator(".comment-form")
    .getByRole("button", { name: "Comment" })
    .click();

  await expect(
    page.locator(".inline-thread .body", { hasText: "why was this removed?" }).first(),
  ).toBeVisible();
});
