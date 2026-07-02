import { test, expect } from "@playwright/test";

test("sidebar shows the file tree, toggles and persists", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator(".sidebar")).toBeVisible();
  await expect(page.locator(".workspace-trigger")).toBeVisible();

  // The changed-file tree lists the root file and a (collapsed-chain) folder.
  await expect(page.locator(".tree-file", { hasText: "calc.js" })).toBeVisible();
  await expect(page.locator(".tree-dir", { hasText: "src/util" })).toBeVisible();

  // Changed files keep a compact status dot; modified is highlighted separately.
  await expect(page.locator('.tree-file:has-text("calc.js") .ft-dot.s-modified')).toBeVisible();

  // Clicking a file marks it active (and scrolls to it).
  await page.locator(".tree-file", { hasText: "calc.js" }).click();
  await expect(page.locator(".tree-file.active")).toHaveCount(1);

  // All files mode includes unchanged tracked files with the same quiet file glyphs.
  await page.getByRole("button", { name: "All files" }).click();
  await expect(page.locator(".tree-file", { hasText: "README.md" })).toBeVisible();
  await expect(page.locator('.tree-file:has-text("README.md") .ft-glyph')).toBeVisible();

  // Hamburger opens the hidden workspace rail, not the file sidebar.
  await page.getByRole("button", { name: "Toggle workspaces" }).click();
  await expect(page.locator(".workspace-rail")).toBeVisible();
  await page.getByRole("button", { name: "Close workspaces" }).click();
  await expect(page.locator(".workspace-rail")).toHaveCount(0);

  // The files sub-sidebar has its own collapse control, persisted across reload.
  await page.getByRole("button", { name: "Hide files sidebar" }).click();
  await expect(page.locator(".sidebar")).toHaveCount(0);
  await page.reload();
  await expect(page.locator(".sidebar")).toHaveCount(0);
  await page.getByRole("button", { name: "Show files sidebar" }).click();
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

