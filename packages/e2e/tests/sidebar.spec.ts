import { test, expect } from "@playwright/test";

test("sidebar shows the repo and a file tree, toggles and persists", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator(".sidebar")).toBeVisible();
  await expect(page.locator(".repo-item").first()).toBeVisible();

  // The changed-file tree lists the root file and a (collapsed-chain) folder.
  await expect(page.locator(".tree-file", { hasText: "calc.js" })).toBeVisible();
  await expect(page.locator(".tree-dir", { hasText: "src/util" })).toBeVisible();

  // Clicking a file marks it active (and scrolls to it).
  await page.locator(".tree-file", { hasText: "calc.js" }).click();
  await expect(page.locator(".tree-file.active")).toHaveCount(1);

  // Hamburger collapses the sidebar and the choice persists across reload.
  await page.getByRole("button", { name: "Toggle sidebar" }).click();
  await expect(page.locator(".sidebar")).toHaveCount(0);
  await page.reload();
  await expect(page.locator(".sidebar")).toHaveCount(0);
  await page.getByRole("button", { name: "Toggle sidebar" }).click();
  await expect(page.locator(".sidebar")).toBeVisible();
});

test("folders collapse/expand and the state persists per repo", async ({ page }) => {
  await page.goto("/");
  const folder = page.locator(".tree-dir", { hasText: "src/util" });
  const nested = page.locator(".tree-file", { hasText: "math.js" });
  await expect(nested).toBeVisible();

  // Collapse hides the nested file; the choice survives a reload.
  await folder.click();
  await expect(nested).toHaveCount(0);
  await page.reload();
  await expect(nested).toHaveCount(0);

  // Expanding brings it back.
  await page.locator(".tree-dir", { hasText: "src/util" }).click();
  await expect(page.locator(".tree-file", { hasText: "math.js" })).toBeVisible();
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
