import { test, expect } from "@playwright/test";

const center = (b: { x: number; y: number; width: number; height: number }) => ({
  x: b.x + b.width / 2,
  y: b.y + b.height / 2,
});

test("drag across the gutter selects a range and auto-opens the form", async ({
  page,
}) => {
  await page.goto("/");

  const g0 = page.locator("td.ln-clickable").first();
  const g3 = page.locator("td.ln-clickable").nth(3);
  const a = center((await g0.boundingBox())!);
  const b = center((await g3.boundingBox())!);

  await page.mouse.move(a.x, a.y);
  await page.mouse.down();
  await page.mouse.move(b.x, b.y, { steps: 8 });
  await page.mouse.up();

  // The range highlights multiple rows and the comment form opened on release
  // (no second click on the + needed).
  expect(await page.locator("tr.line-selected").count()).toBeGreaterThan(1);
  await expect(page.locator(".comment-form textarea")).toBeVisible();
  await expect(page.locator(".comment-form textarea")).toHaveAttribute(
    "placeholder",
    /:\d+-\d+$/,
  );

  // The drag must not have produced a native text selection fighting the range.
  const selected = await page.evaluate(
    () => window.getSelection()?.toString() ?? "",
  );
  expect(selected).toBe("");
});

test("the gutter is keyboard-operable (Enter comments, Shift+Arrow extends)", async ({
  page,
}) => {
  await page.goto("/");

  const gutter = page.locator("td.ln-clickable").first();
  await gutter.focus();
  await page.keyboard.press("Shift+ArrowDown");
  expect(await page.locator("tr.line-selected").count()).toBeGreaterThanOrEqual(2);

  await page.keyboard.press("Enter");
  await expect(page.locator(".comment-form textarea")).toBeVisible();

  // Escape cancels the in-progress comment and clears the highlight.
  await page.keyboard.press("Escape");
  await expect(page.locator(".comment-form")).toHaveCount(0);
  await expect(page.locator("tr.line-selected")).toHaveCount(0);
});
