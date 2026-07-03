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
