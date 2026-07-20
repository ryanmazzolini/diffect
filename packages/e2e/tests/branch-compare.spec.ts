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
  await expect(page.locator(".target-request-status")).toHaveCount(0);
});

test("branch picker compares a selected branch to the working tree", async ({ page }) => {
  const requestedTargets: string[] = [];
  page.on("request", (request) => {
    if (!request.url().includes("/diff?")) return;
    requestedTargets.push(new URL(request.url()).searchParams.get("target") ?? "");
  });

  await page.goto("/");
  await expect(page.locator('.file[data-path="calc.js"] .file-path')).toBeVisible();
  await expect.poll(() => requestedTargets).toContain("main");

  const trigger = page.locator(".target-picker .review-target-trigger");
  await expect(trigger).toHaveText("main▾");
  await trigger.click();
  const dialog = page.getByRole("dialog", { name: "Review changes" });
  const branch = dialog.getByRole("button", { name: "Branch: main" });
  const compareControl = dialog.getByRole("button", { name: "Compare: HEAD" });
  await expect(branch).toBeFocused();
  await expect(dialog).not.toContainText("current checkout");
  await expect(dialog).toContainText("Working tree");

  // The approved anchored panel is non-modal: Tab can leave it in either direction.
  await branch.press("Shift+Tab");
  await expect.poll(() => dialog.evaluate((element) => !element.contains(document.activeElement))).toBe(true);
  await compareControl.focus();
  await compareControl.press("Tab");
  await expect.poll(() => dialog.evaluate((element) => !element.contains(document.activeElement))).toBe(true);

  await branch.click();
  const search = page.getByPlaceholder("Find a branch…");
  await expect(page.locator(".ref-results-meta")).toHaveText("Branches");
  await search.fill("feature");
  await expect(page.getByRole("option", { name: "feature", exact: true })).toBeVisible();
  await search.press("Enter");

  await expect(dialog.getByRole("button", { name: "Branch: feature" })).toBeFocused();
  await expect(trigger).toHaveText("feature▾");
  await expect(page.locator('.file[data-path="calc.js"] .file-path')).toBeVisible();

  await dialog.press("Escape");
  await expect(dialog).toBeHidden();
  await expect(trigger).toBeFocused();
});

test("failed branch navigation restores the loaded control and retries", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator('.file[data-path="calc.js"] .file-path')).toBeVisible();
  await page.route("**/repos/*/diff?**", async (route) => {
    const target = new URL(route.request().url()).searchParams.get("target");
    if (target === "feature") {
      await route.fulfill({
        status: 500,
        contentType: "application/json",
        body: JSON.stringify({ error: "simulated branch failure" }),
      });
      return;
    }
    await route.continue();
  });

  const trigger = page.locator(".target-picker .review-target-trigger");
  await trigger.click();
  const dialog = page.getByRole("dialog", { name: "Review changes" });
  await dialog.getByRole("button", { name: "Branch: main" }).click();
  const search = page.getByPlaceholder("Find a branch…");
  await search.fill("feature");
  await page.getByRole("option", { name: "feature", exact: true }).click();

  await expect(dialog.getByRole("alert")).toContainText("simulated branch failure");
  await expect(trigger).toHaveText("main▾");
  await expect(dialog.getByRole("button", { name: "Branch: main" })).toBeVisible();

  await page.unroute("**/repos/*/diff?**");
  await dialog.getByRole("button", { name: "Retry" }).click();
  await expect(trigger).toHaveText("feature▾");
  await expect(dialog.getByRole("button", { name: "Branch: feature" })).toBeVisible();
});

test("empty repo follows commits and appears only in the base picker", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator('.file[data-path="calc.js"] .file-path')).toBeVisible();

  const trigger = page.locator(".target-picker .review-target-trigger");
  await trigger.click();
  const dialog = page.getByRole("dialog", { name: "Review changes" });
  await dialog.getByRole("button", { name: "Base: main", exact: true }).click();
  const options = page.getByRole("option");
  const optionCount = await options.count();
  expect(optionCount).toBeGreaterThan(1);
  await expect(options.nth(optionCount - 2)).toContainText("base");
  const emptyRepo = options.last();
  await expect(emptyRepo).toHaveAccessibleName("empty repo");
  await emptyRepo.click();
  await expect(dialog.getByRole("button", { name: "Base: empty repo" })).toBeFocused();

  await dialog.getByRole("button", { name: "Compare: HEAD" }).click();
  let search = page.getByPlaceholder("Find a branch, tag, or commit…");
  await search.fill("main");
  await page.getByRole("option", { name: "main", exact: true }).click();

  await expect(trigger).toHaveText("empty repo → main▾");
  await expect(
    page.getByRole("button", { name: /added README\.md 4 additions, 0 deletions/ }),
  ).toBeVisible();
  await expect(page.locator(".error")).toHaveCount(0);

  // The empty repository is a meaningful base, not a valid compare endpoint.
  await dialog.getByRole("button", { name: "Compare: main" }).click();
  search = page.getByPlaceholder("Find a branch, tag, or commit…");
  await search.fill("empty repo");
  await expect(page.getByRole("option", { name: "empty repo" })).toHaveCount(0);
  await expect(page.locator(".ref-empty")).toContainText("No refs or commits match");
});

test("hides empty repo when the recent commit list does not reach the root", async ({ page }) => {
  await page.route("**/repos/*/refs", async (route) => {
    const response = await route.fetch();
    const refs = await response.json();
    await route.fulfill({ response, json: { ...refs, commitsReachRoot: false } });
  });
  await page.goto("/");
  await expect(page.locator('.file[data-path="calc.js"] .file-path')).toBeVisible();

  await page.locator(".target-picker .review-target-trigger").click();
  const dialog = page.getByRole("dialog", { name: "Review changes" });
  await dialog.getByRole("button", { name: "Base: main", exact: true }).click();
  const search = page.getByPlaceholder("Find a branch, tag, or commit…");
  await search.fill("empty repo");
  await expect(page.getByRole("option", { name: "empty repo" })).toHaveCount(0);
});

test("compare ref pickers support keyboard search and live updates", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator('.file[data-path="calc.js"] .file-path')).toBeVisible();
  const trigger = page.locator(".target-picker .review-target-trigger");
  await trigger.click();
  const dialog = page.getByRole("dialog", { name: "Review changes" });

  const compare = dialog.getByRole("button", { name: "Compare: HEAD" });
  await compare.focus();
  await compare.press("Enter");
  let search = page.getByPlaceholder("Find a branch, tag, or commit…");
  await expect(page.locator(".ref-results-meta")).toHaveAttribute("aria-live", "polite");
  await search.fill("base");
  await expect(page.getByRole("option", { name: /^[0-9a-f]+\s+base$/ })).toBeVisible();
  await search.press("Enter");

  const selected = dialog.getByRole("button", { name: /^Compare: [0-9a-f]{7}$/ });
  await expect(selected).toBeFocused();
  await expect(trigger).toHaveText(/^main → [0-9a-f]+▾$/);

  await dialog.getByRole("button", { name: "Base: main", exact: true }).click();
  search = page.getByPlaceholder("Find a branch, tag, or commit…");
  await search.fill("v1");
  await expect(page.getByRole("option", { name: "v1", exact: true })).toBeVisible();
  await search.press("Enter");
  await expect(dialog.getByRole("button", { name: "Base: v1" })).toBeFocused();
});

test("keeps nested pickers separate and reachable in a short narrow viewport", async ({ page }) => {
  await page.setViewportSize({ width: 420, height: 220 });
  await page.goto("/");
  const trigger = page.locator(".target-picker .review-target-trigger");
  await trigger.press("Enter");

  const dialog = page.getByRole("dialog", { name: "Review changes" });
  await expect(dialog).toBeVisible();
  const dialogBox = await dialog.boundingBox();
  expect(dialogBox).not.toBeNull();
  expect(dialogBox!.x).toBeGreaterThanOrEqual(0);
  expect(dialogBox!.y).toBeGreaterThanOrEqual(0);
  expect(dialogBox!.x + dialogBox!.width).toBeLessThanOrEqual(420);
  expect(dialogBox!.y + dialogBox!.height).toBeLessThanOrEqual(220);

  const base = dialog.getByRole("button", { name: "Base: main", exact: true });
  await base.scrollIntoViewIfNeeded();
  await base.press("Enter");
  const refPopover = page.locator(".ref-popover");
  await expect(refPopover).toBeVisible();
  const refBox = await refPopover.boundingBox();
  expect(refBox).not.toBeNull();
  expect(refBox!.x).toBeGreaterThanOrEqual(0);
  expect(refBox!.y).toBeGreaterThanOrEqual(0);
  expect(refBox!.x + refBox!.width).toBeLessThanOrEqual(420);
  expect(refBox!.y + refBox!.height).toBeLessThanOrEqual(220);

  const panelsAreSeparated = async () => {
    const [outer, nested] = await Promise.all([dialog.boundingBox(), refPopover.boundingBox()]);
    if (!outer || !nested) return false;
    return nested.y + nested.height <= outer.y || nested.y >= outer.y + outer.height;
  };
  await expect.poll(panelsAreSeparated).toBe(true);

  await page.setViewportSize({ width: 420, height: 180 });
  await expect(page.getByPlaceholder("Find a branch, tag, or commit…")).toBeVisible();
  await expect.poll(panelsAreSeparated).toBe(true);
  const resizedRefBox = await refPopover.boundingBox();
  expect(resizedRefBox).not.toBeNull();
  expect(resizedRefBox!.y).toBeGreaterThanOrEqual(0);
  expect(resizedRefBox!.y + resizedRefBox!.height).toBeLessThanOrEqual(180);
});

test("restores empty repo labels and target-only comparisons", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator('.file[data-path="calc.js"] .file-path')).toBeVisible();
  const fixture = await page.evaluate(async () => {
    const workspace = await fetch("/workspace").then((response) => response.json());
    const repo = workspace.repos[0].name as string;
    const refs = await fetch(`/repos/${encodeURIComponent(repo)}/refs`).then((response) => response.json());
    return { repo, repoStartSha: refs.repoStartSha as string };
  });
  const storePlace = async (target: string, presentation?: object) => {
    await page.evaluate(
      ({ repo, target, presentation }) => {
        const selection = { worktree: null, target, ...(presentation ? { presentation } : {}) };
        sessionStorage.setItem(
          "diffect-place-v1",
          JSON.stringify({
            workspacePath: null,
            repo,
            worktree: null,
            target,
            ...(presentation ? { presentation } : {}),
            file: null,
            selections: { [repo]: selection },
          }),
        );
      },
      { repo: fixture.repo, target, presentation },
    );
  };

  const repoStartTarget = `${fixture.repoStartSha}..main`;
  await storePlace(repoStartTarget, {
    kind: "compare",
    baseRef: fixture.repoStartSha,
    baseLabel: "Repo Start",
    baseIsRepoStart: true,
    compareRef: "main",
    compareLabel: "main",
  });
  await page.reload();
  await expect(page.locator(".target-picker .review-target-trigger")).toHaveText(
    "empty repo → main▾",
  );

  await storePlace(repoStartTarget);
  await page.reload();
  await expect(page.locator(".target-picker .review-target-trigger")).toHaveText(
    "empty repo → main▾",
  );

  await storePlace("main...HEAD");
  await page.reload();
  await expect(page.locator(".target-picker .review-target-trigger")).toHaveText(
    "main → HEAD▾",
  );
});

test("external local target changes cancel a pending live comparison", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator('.file[data-path="calc.js"] .file-path')).toBeVisible();

  const picker = page.locator(".target-picker");
  const trigger = picker.locator(".review-target-trigger");
  const staged = picker.locator(".local-targets").getByRole("button", {
    name: "Staged changes",
    exact: true,
  });
  await trigger.click();
  const dialog = page.getByRole("dialog", { name: "Review changes" });

  await dialog.getByRole("button", { name: "Compare: HEAD" }).click();
  const search = page.getByPlaceholder("Find a branch, tag, or commit…");
  await search.fill("base");
  await page.getByRole("option", { name: /^[0-9a-f]+\s+base$/ }).click();
  await staged.evaluate((button: HTMLButtonElement) => button.click());

  await expect(staged).toHaveAttribute("aria-pressed", "true");
  await expect(trigger).toHaveText("Staged changes▾");
  await page.waitForTimeout(400);
  await expect(staged).toHaveAttribute("aria-pressed", "true");
});
