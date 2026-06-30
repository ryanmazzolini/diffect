import { test, expect } from "@playwright/test";

test("edits, autosaves, persists, and copies PR Draft", async ({ page, context }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await page.goto("/");

  await page.getByRole("tab", { name: "PR Draft" }).click();
  await page.getByPlaceholder("PR title").fill("Add PR Draft");
  await page
    .getByPlaceholder("Summarize the change, validation, risks, and screenshots.")
    .fill("## Summary\n- Added local PR Draft");
  await page.getByRole("tab", { name: "Preview" }).click();
  await expect(page.locator(".pr-draft-panel .w-md-editor-preview h2", { hasText: "Summary" })).toBeVisible();
  await page.getByRole("tab", { name: "Write" }).click();
  await page.getByRole("tab", { name: "Diff" }).click();
  await page.getByRole("tab", { name: "PR Draft" }).click();
  await expect(page.getByPlaceholder("PR title")).toHaveValue("Add PR Draft");
  await expect(
    page.getByPlaceholder("Summarize the change, validation, risks, and screenshots."),
  ).toHaveValue("## Summary\n- Added local PR Draft");
  await expect
    .poll(() =>
      page.evaluate(async () => {
        const draft = await fetch("/pr-draft").then((r) => r.json());
        return `${draft.title}\n---\n${draft.body}`;
      }),
    )
    .toBe("Add PR Draft\n---\n## Summary\n- Added local PR Draft");

  await page.getByRole("button", { name: "Copy PR body" }).click();
  await expect(page.getByText("Copied")).toBeVisible();
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(
    "## Summary\n- Added local PR Draft",
  );

  await page.reload();
  await page.getByRole("tab", { name: "PR Draft" }).click();
  await expect(page.getByPlaceholder("PR title")).toHaveValue("Add PR Draft");
  await expect(
    page.getByPlaceholder("Summarize the change, validation, risks, and screenshots."),
  ).toHaveValue("## Summary\n- Added local PR Draft");
});
