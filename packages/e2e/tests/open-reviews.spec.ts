import AxeBuilder from "@axe-core/playwright";
import { test, expect, type Page } from "./fixtures.js";
import { openCmCommentForm } from "./helpers.js";

const endpoint = {
  kind: "ref",
  label: "main",
  sha: "1111111111111111111111111111111111111111",
  shortSha: "1111111",
  subject: "Review picker baseline",
  committer: "E2E",
  committedAt: "2026-07-17T16:42:00.000Z",
} as const;

function mockedReview({
  sessionId,
  worktree,
  availability = { state: "available" },
}: {
  sessionId: string;
  worktree: string | null;
  availability?: object;
}) {
  return {
    sessionId,
    scope: {
      target: "main...HEAD",
      kind: "range",
      baseRef: "main",
      headRef: "HEAD",
      baseSha: endpoint.sha,
      branch: "main",
    },
    worktree,
    rangeSemantics: "merge-base",
    availability,
    openThreadCount: 1,
    latestActivity: "2026-07-17T17:00:00.000Z",
    from: endpoint,
    to: {
      ...endpoint,
      label: "HEAD",
      sha: "2222222222222222222222222222222222222222",
      shortSha: "2222222",
      subject: "Clarify review picker",
    },
  };
}

async function createOpenReview(page: Page, body: string) {
  const form = await openCmCommentForm(page);
  await form.locator("textarea").fill(body);
  await form.getByRole("button", { name: "Comment" }).click();
  await expect(page.locator(".inline-thread", { hasText: body }).first()).toBeVisible();
}

async function firstOpenReview(page: Page) {
  return page.evaluate(async () => {
    const workspace = await fetch("/workspace").then((response) => response.json());
    const repo = workspace.repos[0].name as string;
    const reviews = await fetch(
      `/open-reviews?${new URLSearchParams({ workspace: workspace.root, repo })}`,
    ).then((response) => response.json());
    return { repo, review: reviews[0] as { sessionId: string; scope: { target: string } } };
  });
}

test("loads an exact Open review and restores its grouped comments", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator(".file-header").first()).toBeVisible();
  await createOpenReview(page, "return to this exact review");

  await expect.poll(async () => (await firstOpenReview(page)).review?.scope.target ?? null).toBe(
    "main",
  );

  const picker = page.locator(".target-picker");
  const trigger = picker.locator(".review-target-trigger");
  const unstaged = picker.locator(".local-targets").getByRole("button", {
    name: "Unstaged changes",
    exact: true,
  });
  await unstaged.click();
  await expect(unstaged).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator(".thread-pane")).not.toContainText("return to this exact review");
  await createOpenReview(page, "only on the local review");

  await trigger.click();
  const dialog = page.getByRole("dialog", { name: "Review changes" });
  const rows = dialog.getByRole("row", { name: /1 open comment/ });
  await expect(rows).toHaveCount(2);
  const mainRow = dialog.locator(".open-review-row").filter({ hasText: "main" });
  await expect(mainRow).toHaveAttribute("aria-selected", "false");
  await mainRow.focus();
  await mainRow.press("Enter");

  await expect(dialog).toBeHidden();
  await expect(trigger).toBeFocused();
  await expect(unstaged).toHaveAttribute("aria-pressed", "false");
  await expect(page.locator(".thread-pane")).toContainText("return to this exact review");
  await expect(page.locator(".thread-pane")).not.toContainText("only on the local review");
});

test("keeps the loaded review on failure and retries in place", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator(".file-header").first()).toBeVisible();
  await createOpenReview(page, "retry this review");
  const { review } = await firstOpenReview(page);
  expect(review).toBeTruthy();

  const picker = page.locator(".target-picker");
  const staged = picker.locator(".local-targets").getByRole("button", {
    name: "Staged changes",
    exact: true,
  });
  await staged.click();
  await expect(staged).toHaveAttribute("aria-pressed", "true");

  await page.route("**/repos/*/diff?**", async (route) => {
    const target = new URL(route.request().url()).searchParams.get("target");
    if (target === review.scope.target) {
      await route.fulfill({
        status: 500,
        contentType: "application/json",
        body: JSON.stringify({ error: "simulated review failure" }),
      });
      return;
    }
    await route.continue();
  });

  await picker.locator(".review-target-trigger").click();
  const dialog = page.getByRole("dialog", { name: "Review changes" });
  await dialog.getByRole("row", { name: /1 open comment/ }).click();
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole("alert")).toContainText("simulated review failure");
  await expect(staged).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator(".thread-pane")).not.toContainText("retry this review");

  await page.unroute("**/repos/*/diff?**");
  await dialog.getByRole("button", { name: "Retry" }).click();
  await expect(dialog).toBeHidden();
  await expect(staged).toHaveAttribute("aria-pressed", "false");
  await expect(page.locator(".thread-pane")).toContainText("retry this review");
});

test("distinguishes discovery failure from an empty list and shows refresh progress", async ({ page }) => {
  let attempts = 0;
  let releaseRefresh: (() => void) | null = null;
  const refreshGate = new Promise<void>((resolve) => {
    releaseRefresh = resolve;
  });
  await page.route("**/open-reviews?**", async (route) => {
    attempts += 1;
    if (attempts === 1) {
      await route.fulfill({
        status: 500,
        contentType: "application/json",
        body: JSON.stringify({ error: "simulated discovery failure" }),
      });
      return;
    }
    await refreshGate;
    await route.fulfill({ contentType: "application/json", body: "[]" });
  });

  await page.goto("/");
  await expect(page.locator(".file-header").first()).toBeVisible();
  await page.locator(".target-picker .review-target-trigger").click();
  const dialog = page.getByRole("dialog", { name: "Review changes" });
  await expect(dialog.getByRole("alert")).toContainText("simulated discovery failure");
  await expect(dialog).not.toContainText("No reviews have open comments.");

  await dialog.getByRole("button", { name: "Refresh" }).click();
  await expect(dialog).toContainText("Loading open reviews…");
  releaseRefresh?.();
  await expect(dialog).toContainText("No reviews have open comments.");
});

test("distinguishes unavailable checkouts and supports keyboard, details, narrow layout, and accessibility", async ({ page, context }) => {
  const primary = mockedReview({ sessionId: "scope-primary", worktree: null });
  const linked = mockedReview({
    sessionId: "scope-linked",
    worktree: "editor-direction",
    availability: { state: "missing-checkout", worktree: "editor-direction" },
  });
  await page.route("**/open-reviews?**", (route) =>
    route.fulfill({ contentType: "application/json", body: JSON.stringify([primary, linked]) }),
  );
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await page.setViewportSize({ width: 420, height: 620 });
  await page.goto("/");
  await page.locator(".target-picker .review-target-trigger").press("ArrowDown");

  const dialog = page.getByRole("dialog", { name: "Review changes" });
  const rows = dialog.getByRole("row", { name: /1 open comment/ });
  await expect(rows).toHaveCount(2);
  await expect(rows.first()).toBeFocused();
  await rows.first().press("ArrowDown");
  await expect(rows.nth(1)).toBeFocused();
  await expect(rows.nth(1)).toContainText("editor-direction");
  await rows.nth(1).press("Enter");
  await expect(dialog.getByRole("alert")).toContainText(
    "Checkout “editor-direction” is no longer available",
  );

  await dialog.getByText("Review details", { exact: true }).click();
  await dialog.getByRole("button", { name: "Copy details" }).click();
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toContain(
    "Target: main...HEAD",
  );

  const box = await dialog.boundingBox();
  expect(box).not.toBeNull();
  expect(box!.x).toBeGreaterThanOrEqual(0);
  expect(box!.x + box!.width).toBeLessThanOrEqual(420);
  await expect(dialog.locator(".open-review-table-scroll")).toHaveCSS("overflow-x", "auto");
  await expect(dialog.locator(".compare-inline-controls").first()).toHaveCSS(
    "grid-template-columns",
    /\d+px/,
  );

  const result = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa"])
    .exclude(".diff")
    .analyze();
  const blocking = result.violations.filter(
    (violation) => violation.impact === "serious" || violation.impact === "critical",
  );
  expect(
    blocking,
    blocking.map((violation) => `${violation.id}: ${violation.help}`).join("\n"),
  ).toEqual([]);
});

test("loads an identical endpoint pair from its exact linked checkout", async ({ page }) => {
  const primary = mockedReview({ sessionId: "scope-primary", worktree: null });
  const linked = mockedReview({ sessionId: "scope-linked", worktree: "editor-direction" });
  await page.route("**/open-reviews?**", (route) =>
    route.fulfill({ contentType: "application/json", body: JSON.stringify([primary, linked]) }),
  );
  await page.goto("/");
  await expect(page.locator(".file-header").first()).toBeVisible();

  const fixture = await page.evaluate(async () => {
    const workspace = await fetch("/workspace").then((response) => response.json());
    const repo = workspace.repos[0].name as string;
    const diff = await fetch(`/repos/${encodeURIComponent(repo)}/diff?target=main`).then((response) => response.json());
    return { repo, diff };
  });
  let requestedWorktree: string | null = null;
  let requestedTarget: string | null = null;
  await page.route("**/repos/*/diff?**", async (route) => {
    const url = new URL(route.request().url());
    if (url.searchParams.get("worktree") !== "editor-direction") {
      await route.continue();
      return;
    }
    requestedWorktree = url.searchParams.get("worktree");
    requestedTarget = url.searchParams.get("target");
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        ...fixture.diff,
        worktree: "editor-direction",
        target: "main...HEAD",
        sessionId: "scope-linked",
      }),
    });
  });

  const trigger = page.locator(".target-picker .review-target-trigger");
  await trigger.click();
  const dialog = page.getByRole("dialog", { name: "Review changes" });
  const linkedRow = dialog.getByRole("row", { name: /editor-direction checkout/ });
  await linkedRow.click();
  await expect(dialog).toBeHidden();
  expect(requestedWorktree).toBe("editor-direction");
  expect(requestedTarget).toBe("main...HEAD");

  await trigger.click();
  await expect(dialog.getByRole("row", { name: /editor-direction checkout/ })).toHaveAttribute(
    "aria-selected",
    "true",
  );
});
