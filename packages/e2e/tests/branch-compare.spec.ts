import { test, expect } from "@playwright/test";

/** The target picker has visible state, local modes, searchable refs, and commits. */
test("target picker applies local modes, compare refs, and commit search", async ({ page }) => {
  await page.goto("/");

  // Scope to the Topbar's local-mode segmented control: selecting a target also
  // surfaces that review as a sidebar session-item with the SAME accessible name
  // (e.g. "Staged changes"), so an unscoped getByRole would be ambiguous once the
  // diff settles. `.local-targets` is the picker group, never the sidebar.
  const modes = page.locator(".local-targets");
  const current = modes.getByRole("button", {
    name: "Current branch main plus working tree changes",
    exact: true,
  });
  const staged = modes.getByRole("button", { name: "Staged changes", exact: true });
  const unstaged = modes.getByRole("button", { name: "Unstaged changes", exact: true });

  await expect(current).toHaveText("main");
  await expect(current).toHaveAttribute("aria-pressed", "true");

  await staged.click();
  await expect(staged).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator(".error")).toHaveCount(0);

  await unstaged.click();
  await expect(unstaged).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator(".error")).toHaveCount(0);

  // Selecting a base applies a GitHub-like base...compare target using HEAD.
  const basePicker = page.locator('.compare .ref-trigger[title^="Base:"]');
  await basePicker.click();
  await page.getByPlaceholder("Find a branch, tag, or commit…").fill("main");
  await page.getByRole("option", { name: /main/ }).first().click();
  await expect(page.locator('.compare .ref-trigger[title="Base: main"]')).toBeVisible();
  await expect(page.locator('.compare .ref-trigger[title="Compare: HEAD"]')).toBeVisible();
  await expect(page.locator(".error")).toHaveCount(0);

  // Commit search results show both short hash and subject.
  const comparePicker = page.locator('.compare .ref-trigger[title^="Compare:"]');
  await comparePicker.click();
  await page.getByPlaceholder("Find a branch, tag, or commit…").fill("base");
  await expect(page.getByRole("option", { name: /^[0-9a-f]+\s+base$/ })).toBeVisible();
});
