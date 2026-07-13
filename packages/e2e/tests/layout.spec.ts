import { test, expect } from "./fixtures.js";

test("keeps module context on one row when space allows", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.goto("/");
  const header = page.locator(".module.single .mod-head");
  await expect(header).toBeVisible();

  const [headerBox, repoBox, targetBox, statBox] = await Promise.all([
    header.boundingBox(),
    header.locator(".mh-repo").boundingBox(),
    header.locator(".mh-target").boundingBox(),
    header.locator(".mh-stat").boundingBox(),
  ]);
  expect(headerBox).not.toBeNull();
  expect(repoBox).not.toBeNull();
  expect(targetBox).not.toBeNull();
  expect(statBox).not.toBeNull();
  expect(headerBox!.height).toBeLessThanOrEqual(48);
  const centers = [repoBox!, targetBox!, statBox!].map((box) => box.y + box.height / 2);
  expect(Math.max(...centers) - Math.min(...centers)).toBeLessThan(2);

  await page.setViewportSize({ width: 850, height: 720 });
  await expect.poll(async () => (await header.boundingBox())?.height ?? 0).toBeGreaterThan(70);
  const [narrowHeader, narrowRepo, narrowTarget, trigger, localModes, stickyTop] = await Promise.all([
    header.boundingBox(),
    header.locator(".mh-repo").boundingBox(),
    header.locator(".mh-target").boundingBox(),
    header.locator(".review-target-trigger").boundingBox(),
    header.locator(".local-targets").boundingBox(),
    page.locator(".file-header").first().evaluate((element) =>
      Number.parseFloat(window.getComputedStyle(element).top),
    ),
  ]);
  expect(narrowHeader).not.toBeNull();
  expect(narrowRepo).not.toBeNull();
  expect(narrowTarget).not.toBeNull();
  expect(trigger).not.toBeNull();
  expect(localModes).not.toBeNull();
  expect(narrowTarget!.y).toBeGreaterThanOrEqual(narrowRepo!.y + narrowRepo!.height);
  expect(trigger!.x + trigger!.width).toBeLessThanOrEqual(localModes!.x);
  expect(narrowHeader!.height).toBeLessThanOrEqual(stickyTop + 2);
});

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
