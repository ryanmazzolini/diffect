import { test, expect } from "@playwright/test";

async function openCommentForm(page) {
  const row = page.locator("tbody.diff-table-body tr", { hasText: "TODO" }).first();
  await row.hover();
  await row.locator("button.diff-add-widget").first().click();
  return page.locator(".comment-form");
}

test("Preview mode renders the markdown", async ({ page }) => {
  await page.goto("/");
  const form = await openCommentForm(page);

  await form.locator("textarea").fill("**bold** and `code`");
  await form.getByRole("button", { name: /Preview code/ }).click();

  await expect(form.locator(".w-md-editor-preview strong", { hasText: "bold" })).toBeVisible();
  await expect(form.locator(".w-md-editor-preview code", { hasText: "code" })).toBeVisible();
});

test("the bold toolbar button wraps the selection", async ({ page }) => {
  await page.goto("/");
  const form = await openCommentForm(page);

  const textarea = form.locator("textarea");
  await textarea.fill("guard");
  await textarea.focus();
  await page.keyboard.press("ControlOrMeta+A");
  await form.getByRole("button", { name: /Add bold text/ }).click();

  await expect(textarea).toHaveValue("**guard**");
});

test("numbered lists continue on enter", async ({ page }) => {
  await page.goto("/");
  const form = await openCommentForm(page);
  const textarea = form.locator("textarea");

  await textarea.fill("1. first");
  await textarea.press("End");
  await textarea.press("Enter");

  await expect(textarea).toHaveValue("1. first\n2. ");
});

test("preview strips unsafe markdown output", async ({ page }) => {
  await page.goto("/");
  const form = await openCommentForm(page);

  await form.locator("textarea").fill(
    '[x](javascript:alert(1))\n\n<img src=x onerror="alert(2)">\n\n<iframe src="javascript:alert(3)"></iframe>',
  );
  await form.getByRole("button", { name: /Preview code/ }).click();

  const html = await form.locator(".w-md-editor-preview").innerHTML();
  expect(html).not.toMatch(/javascript:|onerror|<iframe|<img/i);
});

test("attaching a file inserts a markdown image link", async ({ page }) => {
  await page.goto("/");
  const form = await openCommentForm(page);

  await form.locator('input[type="file"]').setInputFiles({
    name: "pic.png",
    mimeType: "image/png",
    buffer: Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]),
  });

  await expect(form.locator("textarea")).toHaveValue(
    /!\[pic\.png\]\(\/attachments\/[a-f0-9]{64}\.png\)/,
  );
});

test("a comment renders as markdown once posted", async ({ page }) => {
  await page.goto("/");
  const form = await openCommentForm(page);

  await form.locator("textarea").fill("see `parseInt` docs");
  await form.getByRole("button", { name: "Comment" }).click();

  await expect(
    page.locator(".inline-thread .c-text code", { hasText: "parseInt" }).first(),
  ).toBeVisible();
});
