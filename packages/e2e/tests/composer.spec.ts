import { test, expect } from "./fixtures.js";
import { openCmCommentForm } from "./helpers.js";

test("Preview mode renders the markdown", async ({ page }) => {
  await page.goto("/");
  const form = await openCmCommentForm(page);

  await form.locator("textarea").fill("**bold** and `code`");
  await form.getByRole("tab", { name: "Preview" }).click();

  await expect(form.locator(".w-md-editor-preview strong", { hasText: "bold" })).toBeVisible();
  await expect(form.locator(".w-md-editor-preview code", { hasText: "code" })).toBeVisible();
});

test("the bold toolbar button wraps the selection", async ({ page }) => {
  await page.goto("/");
  const form = await openCmCommentForm(page);

  const textarea = form.locator("textarea");
  await textarea.fill("guard");
  await textarea.focus();
  await page.keyboard.press("ControlOrMeta+A");
  await form.getByRole("button", { name: /Add bold text/ }).click();

  await expect(textarea).toHaveValue("**guard**");
});

test("numbered lists continue on enter", async ({ page }) => {
  await page.goto("/");
  const form = await openCmCommentForm(page);
  const textarea = form.locator("textarea");

  await textarea.fill("1. first");
  await textarea.press("End");
  await textarea.press("Enter");

  await expect(textarea).toHaveValue("1. first\n2. ");
});

test("home/end stay inside the markdown editor", async ({ page }) => {
  await page.goto("/");
  const form = await openCmCommentForm(page);
  const textarea = form.locator("textarea");
  const pane = page.locator(".diff-pane");

  await textarea.fill("first\nsecond");
  await textarea.focus();
  const before = await pane.evaluate((el) => el.scrollTop);
  await textarea.press("End");
  await textarea.press("Home");

  await expect.poll(() => pane.evaluate((el) => el.scrollTop)).toBe(before);
});

test("preview strips unsafe markdown output", async ({ page }) => {
  await page.goto("/");
  const form = await openCmCommentForm(page);

  await form.locator("textarea").fill(
    '[x](javascript:alert(1))\n\n<img src=x onerror="alert(2)">\n\n<iframe src="javascript:alert(3)"></iframe>',
  );
  await form.getByRole("tab", { name: "Preview" }).click();

  const html = await form.locator(".w-md-editor-preview").innerHTML();
  expect(html).not.toMatch(/javascript:|onerror|<iframe|<img/i);
});

test("attaching a file inserts a markdown image link", async ({ page }) => {
  await page.goto("/");
  const form = await openCmCommentForm(page);

  await form.locator('input[type="file"]').setInputFiles({
    name: "pic.png",
    mimeType: "image/png",
    buffer: Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]),
  });

  await expect(form.locator("textarea")).toHaveValue(
    /!\[pic\.png\]\(\/attachments\/[a-f0-9]{64}\.png\)/,
  );
});

test("dropping an image inserts a markdown image link", async ({ page }) => {
  await page.goto("/");
  const form = await openCmCommentForm(page);

  await form.locator("textarea").evaluate((textarea) => {
    const data = new DataTransfer();
    data.items.add(
      new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47, 4, 5, 6])], "drop.png", {
        type: "image/png",
      }),
    );
    for (const type of ["dragenter", "dragover", "drop"]) {
      textarea.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: data }));
    }
  });

  await expect(form.locator("textarea")).toHaveValue(
    /!\[drop\.png\]\(\/attachments\/[a-f0-9]{64}\.png\)/,
  );
});

test("a comment renders as markdown once posted", async ({ page }) => {
  await page.goto("/");
  const form = await openCmCommentForm(page);

  await form.locator("textarea").fill("see `parseInt` docs");
  await form.getByRole("button", { name: "Comment" }).click();

  await expect(
    page.locator(".inline-thread .c-text code", { hasText: "parseInt" }).first(),
  ).toBeVisible();
});
