import { test, expect } from "@playwright/test";

async function openCommentForm(page) {
  const line = page.locator("tr.line-add", { hasText: "TODO" }).first();
  await line.hover();
  await line.locator("button.comment-btn").click();
  return page.locator(".comment-form");
}

test("Preview tab renders the markdown", async ({ page }) => {
  await page.goto("/");
  const form = await openCommentForm(page);

  await form.locator("textarea").fill("**bold** and `code`");
  await form.getByRole("tab", { name: "Preview" }).click();

  await expect(form.locator(".md-preview strong", { hasText: "bold" })).toBeVisible();
  await expect(form.locator(".md-preview code", { hasText: "code" })).toBeVisible();
});

test("the bold toolbar button wraps the selection", async ({ page }) => {
  await page.goto("/");
  const form = await openCommentForm(page);

  const textarea = form.locator("textarea");
  await textarea.fill("guard");
  await textarea.focus();
  await page.keyboard.press("ControlOrMeta+A");
  await form.getByRole("button", { name: "Bold (⌘B)" }).click();

  await expect(textarea).toHaveValue("**guard**");
});

test("a comment renders as markdown once posted", async ({ page }) => {
  await page.goto("/");
  const form = await openCommentForm(page);

  await form.locator("textarea").fill("see `parseInt` docs");
  await form.getByRole("button", { name: "Comment" }).click();

  await expect(
    page.locator(".inline-thread .body code", { hasText: "parseInt" }).first(),
  ).toBeVisible();
});
