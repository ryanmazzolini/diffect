import { test, expect, type Locator, type Page } from "@playwright/test";

async function openMathFile(page: Page): Promise<Locator> {
  await page.goto("/");
  await page.locator(".tree-file", { hasText: "math.js" }).click();
  const file = page.locator(".file", { hasText: "math.js" });
  await expect(file.locator(".cm-diff-host .cm-editor")).toBeVisible();
  return file;
}

test("renders the default CodeMirror diff renderer", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator(".file-header").first()).toBeVisible();
  await expect(page.locator(".cm-diff-host .cm-editor").first()).toBeVisible();
  await expect(page.locator(".cm-diff-host .cm-deletedChunk").first()).toBeVisible();
});

test("loads GraphQL language support in the CodeMirror diff renderer", async ({ page }) => {
  await page.goto("/");
  await page.locator(".tree-file", { hasText: "schema.graphql" }).click();

  const file = page.locator(".file", { hasText: "schema.graphql" });
  await expect(file.locator(".cm-diff-host .cm-editor")).toBeVisible();
  await expect(file.locator(".cm-line", { hasText: "viewer" })).toBeVisible();
  await expect(file.locator(".cm-line span").first()).toBeVisible();
});

test("explains when CodeMirror skips deleted syntax highlighting", async ({ page }) => {
  await page.goto("/?cm6DeletedSyntaxHighlightMax=1");

  const file = page.locator(".file", { hasText: "math.js" });
  await expect(file.locator(".cm-diff-host .cm-editor")).toBeVisible();
  await expect(file.locator(".cm-diff-notice")).toContainText("plain text");
});

test("comments, replies, and closes from the CodeMirror diff renderer", async ({ page }) => {
  const file = await openMathFile(page);

  await file.locator("button.cm-diff-add-widget[data-side='new']").first().click();
  const form = file.locator(".comment-form");
  await expect(form).toBeVisible();
  await form.locator("textarea").fill("comment via cm6");
  await form.getByRole("button", { name: "Comment" }).click();

  const thread = file.locator(".inline-thread", { hasText: "comment via cm6" }).first();
  await expect(thread).toBeVisible();
  await expect(page.locator(".thread-pane", { hasText: "comment via cm6" })).toBeVisible();

  await thread.getByRole("button", { name: "Reply" }).click();
  await thread.locator(".reply-form textarea").fill("reply via cm6");
  await thread.locator(".reply-form").getByRole("button", { name: "Reply" }).click();
  await expect(thread.locator(".c-text", { hasText: "reply via cm6" })).toBeVisible();

  await thread.getByRole("button", { name: "Close" }).click();
  await page.locator(".filter", { hasText: "closed" }).click();
  await expect(
    page.locator(".thread-card.status-closed", { hasText: "comment via cm6" }),
  ).toBeVisible();
});

test("dragging the CodeMirror comment gutter opens a range comment", async ({ page }) => {
  const file = await openMathFile(page);
  const buttons = file.locator("button.cm-diff-add-widget[data-side='new']");
  await expect(buttons.first()).toBeVisible();
  await expect(buttons.nth(2)).toBeVisible();

  await buttons.first().dragTo(buttons.nth(2));

  await expect(file.locator(".comment-form-title")).toContainText(/lines \d+ to \d+/);
});

test("saves edits from the CodeMirror diff renderer", async ({ page }) => {
  const file = await openMathFile(page);

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
