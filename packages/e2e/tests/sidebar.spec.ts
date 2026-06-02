import { test, expect } from "@playwright/test";

test("sidebar lists the repo and files, toggles and persists", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator(".sidebar")).toBeVisible();
  await expect(page.locator(".repo-item").first()).toBeVisible();
  await expect(page.locator(".file-item", { hasText: "calc.js" })).toBeVisible();

  // Clicking a file marks it active (and scrolls to it).
  await page.locator(".file-item", { hasText: "calc.js" }).click();
  await expect(page.locator(".file-item.active")).toHaveCount(1);

  // Hamburger collapses the sidebar and the choice persists across reload.
  await page.getByRole("button", { name: "Toggle sidebar" }).click();
  await expect(page.locator(".sidebar")).toHaveCount(0);
  await page.reload();
  await expect(page.locator(".sidebar")).toHaveCount(0);
  await page.getByRole("button", { name: "Toggle sidebar" }).click();
  await expect(page.locator(".sidebar")).toBeVisible();
});

test("add-workspace prompts for a path", async ({ page }) => {
  await page.goto("/");
  let prompted = false;
  page.on("dialog", (d) => {
    prompted = true;
    void d.dismiss();
  });
  await page.locator(".sidebar-add").click();
  await expect.poll(() => prompted).toBe(true);
});
