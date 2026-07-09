import { test, expect } from "./fixtures.js";

test("renders diff rows with the CodeMirror renderer", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  await page.goto("/");

  await expect(page.locator(".file-header").first()).toBeVisible();
  await expect(page.locator(".cm-diff-host .cm-editor").first()).toBeVisible();
  expect(errors, errors.join("\n")).toEqual([]);
});

test("toggles split (side-by-side) CodeMirror view", async ({ page }) => {
  await page.addInitScript(() => localStorage.removeItem("diffect-split-view"));
  await page.goto("/");
  const firstFile = page.locator(".file").first();
  await expect(firstFile.locator(".cm-diff-host .cm-editor").first()).toBeVisible();

  await page.getByRole("button", { name: "Options" }).click();
  await page.getByRole("button", { name: "Split" }).click();

  await expect(firstFile.getByRole("textbox", { name: /old diff editor/ })).toBeVisible();
  await expect(firstFile.getByRole("textbox", { name: /new diff editor/ })).toBeVisible();

  await page.getByRole("button", { name: "Options" }).click();
  await page.getByRole("button", { name: "Unified" }).click();
  await expect(firstFile.getByRole("textbox", { name: /diff editor/ })).toBeVisible();
});

test("toggles line wrapping in CodeMirror", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator(".cm-diff-host .cm-editor").first()).toBeVisible();
  await expect(page.locator(".cm-lineWrapping").first()).toBeVisible();

  await page.getByRole("button", { name: "Options" }).click();
  await page.getByRole("button", { name: "No wrap" }).click();
  await expect(page.locator(".cm-lineWrapping")).toHaveCount(0);

  await page.reload();
  await expect(page.locator(".cm-lineWrapping")).toHaveCount(0);
});

test("keeps the diff view controls reachable while scrolling", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator(".cm-diff-host .cm-editor").first()).toBeVisible();

  const header = page.locator(".rheader");
  const options = page.getByRole("button", { name: "Options" });
  await expect(options).toBeVisible();
  const before = await header.boundingBox();
  expect(before).not.toBeNull();

  await page.locator(".diff-pane").evaluate((el) => {
    el.scrollTop = 700;
  });

  const after = await header.boundingBox();
  expect(after).not.toBeNull();
  expect(Math.abs((after?.y ?? 0) - (before?.y ?? 0))).toBeLessThanOrEqual(1);
  await expect(options).toBeVisible();
  await options.click();
  await expect(page.getByRole("group", { name: "Diff view mode" })).toBeVisible();
  await expect(page.getByRole("button", { name: "No wrap" })).toBeVisible();
});
