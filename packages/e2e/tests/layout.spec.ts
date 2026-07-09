import { test, expect } from "./fixtures.js";

/** The thread pane collapses (persisted) and can be resized by dragging. */
test("collapses the thread pane and persists the choice", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator(".thread-pane")).toBeVisible();

  await page.getByRole("button", { name: "Hide threads sidebar" }).click();
  await expect(page.locator(".thread-pane")).toHaveCount(0);

  await page.reload();
  await expect(page.locator(".thread-pane")).toHaveCount(0); // stayed collapsed

  await page.getByRole("button", { name: "Show threads sidebar" }).click();
  await expect(page.locator(".thread-pane")).toBeVisible();
});

test("resizes the thread pane by dragging the handle", async ({ page }) => {
  await page.goto("/");
  const box = await page.locator(".pane-resizer").boundingBox();
  if (!box) throw new Error("no resizer");

  await page.mouse.move(box.x + 3, box.y + 40);
  await page.mouse.down();
  await page.mouse.move(box.x - 120, box.y + 40, { steps: 6 }); // drag left → widen
  await page.mouse.up();

  const width = await page.evaluate(() =>
    Number(localStorage.getItem("diffect-pane-width")),
  );
  // ~120px drag from the 340 default should land near 460; assert a clear delta.
  expect(width).toBeGreaterThan(420);
});

test("resizes the sidebar by dragging its handle", async ({ page }) => {
  await page.goto("/");
  const box = await page.locator(".sidebar-resizer").boundingBox();
  if (!box) throw new Error("no sidebar resizer");

  await page.mouse.move(box.x + 3, box.y + 40);
  await page.mouse.down();
  await page.mouse.move(box.x + 100, box.y + 40, { steps: 6 }); // drag right → widen
  await page.mouse.up();

  const width = await page.evaluate(() =>
    Number(localStorage.getItem("diffect-sidebar-width")),
  );
  // ~100px drag from the 220 default should land near 320.
  expect(width).toBeGreaterThan(280);
});
