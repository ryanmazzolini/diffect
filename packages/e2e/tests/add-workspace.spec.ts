import { test, expect } from "@playwright/test";

test("add-workspace dialog lists recommendations and adds on select", async ({
  page,
}) => {
  await page.goto("/");
  await page.locator(".workspace-trigger").click();
  await page.locator(".workspace-add").click();

  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText("Add workspace");

  // The fixture seeds one Claude session, so a recommendation card shows.
  const rec = dialog.locator(".aw-rec").first();
  await expect(rec).toBeVisible();

  // Selecting it registers the workspace and closes the dialog.
  await rec.click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
});

test("add-workspace dialog opens the folder browser and Esc closes", async ({
  page,
}) => {
  await page.goto("/");
  await page.locator(".workspace-trigger").click();
  await page.locator(".workspace-add").click();

  await page.getByRole("button", { name: "Browse…" }).click();
  await expect(page.locator(".aw-browser")).toBeVisible();

  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);
});
