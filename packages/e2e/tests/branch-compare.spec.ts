import { test, expect } from "./fixtures.js";

/** Switching equivalent local targets must not blank and rebuild the mounted editor. */
test("local target switches keep the current diff mounted while content loads", async ({ page }) => {
  let releaseContent: (() => void) | null = null;
  const contentGate = new Promise<void>((resolve) => {
    releaseContent = resolve;
  });
  let contentRequested = false;
  await page.route("**/repos/*/file/content?**", async (route) => {
    const target = new URL(route.request().url()).searchParams.get("target");
    if (target === "unstaged") {
      contentRequested = true;
      await contentGate;
    }
    await route.continue();
  });

  await page.goto("/");
  const editor = page.locator('.file[data-path="calc.js"] .cm-content');
  await expect(editor).toContainText("TODO: overflow?");
  await editor.evaluate((element) => element.setAttribute("data-target-sentinel", "stable"));

  const modes = page.locator(".local-targets");
  await modes.getByRole("button", { name: "Unstaged changes", exact: true }).click();
  await expect.poll(() => contentRequested).toBe(true);

  try {
    await expect(editor).toHaveAttribute("data-target-sentinel", "stable", { timeout: 1_000 });
  } finally {
    releaseContent?.();
  }
  await expect(editor).toContainText("TODO: overflow?");
  await expect(editor).toHaveAttribute("data-target-sentinel", "stable");
});

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
