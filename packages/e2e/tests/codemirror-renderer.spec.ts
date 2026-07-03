import { test, expect } from "@playwright/test";

test("renders the opt-in CodeMirror diff renderer", async ({ page }) => {
  await page.goto("/?renderer=cm6");
  await expect(page.locator(".file-header").first()).toBeVisible();
  await expect(page.locator(".cm-diff-host .cm-editor").first()).toBeVisible();
  await expect(page.locator(".cm-diff-host .cm-deletedChunk").first()).toBeVisible();
});

test("loads GraphQL language support in the CodeMirror diff renderer", async ({ page }) => {
  await page.goto("/?renderer=cm6");
  await page.locator(".tree-file", { hasText: "schema.graphql" }).click();

  const file = page.locator(".file", { hasText: "schema.graphql" });
  await expect(file.locator(".cm-diff-host .cm-editor")).toBeVisible();
  await expect(file.locator(".cm-line", { hasText: "viewer" })).toBeVisible();
  await expect(file.locator(".cm-line span").first()).toBeVisible();
});

test("explains when CodeMirror skips deleted syntax highlighting", async ({ page }) => {
  await page.goto("/?renderer=cm6&cm6DeletedSyntaxHighlightMax=1");

  const file = page.locator(".file", { hasText: "math.js" });
  await expect(file.locator(".cm-diff-host .cm-editor")).toBeVisible();
  await expect(file.locator(".cm-diff-notice")).toContainText("plain text");
});

test("saves edits from the CodeMirror diff renderer", async ({ page }) => {
  await page.goto("/?renderer=cm6");

  const file = page.locator(".file", { hasText: "math.js" });
  await expect(file.locator(".cm-diff-host .cm-editor")).toBeVisible();
  await expect(file.locator(".edit-mode-badge")).toHaveText("Editable");
  await file.locator(".cm-line", { hasText: "return x * x // TODO" }).click();
  await page.keyboard.press("End");
  await page.keyboard.insertText("!");

  await expect(file.getByRole("button", { name: "Save" })).toBeEnabled();
  const saved = page.waitForResponse(
    (response) => response.url().includes("/file/content") && response.request().method() === "PUT",
  );
  await page.keyboard.press("ControlOrMeta+S");
  expect((await saved).ok()).toBe(true);

  await page.reload();
  await page.locator(".tree-file", { hasText: "math.js" }).click();
  const refreshed = page.locator(".file", { hasText: "math.js" });
  await expect(refreshed.locator(".cm-line", { hasText: "return x * x // TODO!" })).toBeVisible();
});
