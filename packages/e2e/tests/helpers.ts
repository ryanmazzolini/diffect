import { expect, type Locator, type Page } from "@playwright/test";

export async function ensureUnifiedDiff(page: Page): Promise<void> {
  await page.getByRole("button", { name: "Options" }).click();
  await page.getByRole("button", { name: "Unified" }).click();
  await expect(page.getByRole("button", { name: "Options" })).toHaveAttribute("aria-expanded", "false");
}

export async function openCmCommentForm(
  page: Page,
  root: Locator = page.locator("body"),
  lineText = "TODO",
): Promise<Locator> {
  await ensureUnifiedDiff(page);
  const line = root.locator(".cm-line", { hasText: lineText }).first();
  await expect(line).toBeVisible();
  const lineBox = await line.boundingBox();
  expect(lineBox).not.toBeNull();
  await page.mouse.move(lineBox!.x + 8, lineBox!.y + lineBox!.height / 2);

  const hoverWidget = root.locator("button.cm-diff-add-widget.cm-hover-line").first();
  const widget = (await hoverWidget.count()) > 0
    ? hoverWidget
    : root.locator("button.cm-diff-add-widget").first();
  await widget.evaluate((button) => {
    const rect = button.getBoundingClientRect();
    const init = {
      bubbles: true,
      cancelable: true,
      clientX: rect.left + rect.width / 2,
      clientY: rect.top + rect.height / 2,
    };
    for (const type of ["pointerdown", "mousedown", "pointerup", "mouseup", "click"]) {
      button.dispatchEvent(new MouseEvent(type, init));
    }
  });

  const form = root.locator(".comment-form").first();
  await expect(form).toBeVisible();
  return form;
}
