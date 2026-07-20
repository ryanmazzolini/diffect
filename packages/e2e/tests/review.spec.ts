import { test, expect } from "./fixtures.js";
import { openCmCommentForm } from "./helpers.js";

/**
 * Customer-experience flows against a live diffectd serving the built SPA over a
 * real fixture git repo. These exercise the paths a reviewer actually takes:
 * load the diff, leave a comment, resolve it, and switch the review target.
 */

test("loads the workspace and shows the work diff", async ({ page }) => {
  await page.goto("/");
  // The brand is now a compact "d" logo mark; this is just a shell-loaded smoke check.
  await expect(page.locator(".brand")).toBeVisible();
  // The fixture has a modified calc.js in the default work target.
  await expect(page.locator(".file-path", { hasText: "calc.js" })).toBeVisible();
  await expect(page.locator(".cm-diff-host .cm-editor").first()).toBeVisible();
});

test("creates an inline comment and it appears in the inbox", async ({ page }) => {
  await page.goto("/");
  // Hover the changed line to reveal the comment affordance, then open the form.
  const form = await openCmCommentForm(page);
  await form.locator("textarea").fill("Does this overflow for large ints?");
  await form.getByRole("button", { name: "Comment" }).click();

  // The new thread shows inline and in the thread inbox.
  await expect(
    page.locator(".inline-thread .c-text", { hasText: "overflow for large ints" }).first(),
  ).toBeVisible();
  await expect(page.locator(".thread-pane")).toContainText("overflow for large ints");
});

test("desktop follow mode jumps to the changed file", async ({ page }) => {
  await page.addInitScript(() => {
    window.__TAURI_INTERNALS__ = { invoke: async () => undefined };
  });
  await page.goto("/?shell=desktop");
  await expect(page.getByRole("button", { name: "Follow changes" })).toHaveAttribute("aria-pressed", "true");
  await page.locator(".tree-file", { hasText: "math.js" }).click();
  await expect(page.locator(".tree-file.active")).toContainText("math.js");

  await page.evaluate(async () => {
    const workspace = await fetch("/workspace").then((r) => r.json());
    const repo = workspace.repos[0].name;
    const path = "calc.js";
    const q = new URLSearchParams({ path, target: "work" });
    const content = await fetch(`/repos/${encodeURIComponent(repo)}/file/content?${q}`).then((r) =>
      r.json(),
    );
    const next = content.new.replace("TODO: overflow?", "TODO: followed?");
    const res = await fetch(`/repos/${encodeURIComponent(repo)}/file/content?${q}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content: next }),
    });
    if (!res.ok) throw new Error(await res.text());
  });

  await expect(page.locator(".tree-file.active")).toContainText("calc.js");
  await expect(
    page.locator('.file[data-path="calc.js"] .cm-insertedLine, .file[data-path="calc.js"] .cm-changedLine').first(),
  ).toBeInViewport();

  // Follow consumes the refreshed event even when the diff is semantically
  // unchanged and the live-refresh reconciler preserves the existing object.
  await page.locator(".tree-file", { hasText: "math.js" }).click();
  await expect(page.locator(".tree-file.active")).toContainText("math.js");
  await page.evaluate(async () => {
    const workspace = await fetch("/workspace").then((r) => r.json());
    const repo = workspace.repos[0].name;
    const path = "calc.js";
    const q = new URLSearchParams({ path, target: "work" });
    const content = await fetch(`/repos/${encodeURIComponent(repo)}/file/content?${q}`).then((r) =>
      r.json(),
    );
    const res = await fetch(`/repos/${encodeURIComponent(repo)}/file/content?${q}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content: content.new }),
    });
    if (!res.ok) throw new Error(await res.text());
  });
  await expect(page.locator(".tree-file.active")).toContainText("calc.js");
});

test("thread pane comments jump to their inline thread", async ({ page }) => {
  await page.goto("/");
  await page.locator(".tree-file", { hasText: "math.js" }).click();

  const math = page.locator('.file[data-path="src/util/math.js"]');
  await expect(math.locator(".cm-diff-host .cm-editor")).toBeVisible();
  const form = await openCmCommentForm(page, math);
  await form.locator("textarea").fill("jump back to math");
  await form.getByRole("button", { name: "Comment" }).click();

  await page.locator(".tree-file", { hasText: "calc.js" }).click();
  await expect(page.locator(".tree-file.active")).toContainText("calc.js");
  await expect(
    page.locator(".thread-pane .thread-actions").getByRole("button", { name: /^Open$/ }),
  ).toHaveCount(0);

  await page.locator(".thread-pane .t-comment", { hasText: "jump back to math" }).click();

  await expect(page.locator(".tree-file.active")).toContainText("math.js");
  await expect(
    page.locator(".diff-pane .inline-thread", { hasText: "jump back to math" }).first(),
  ).toBeVisible();
});

test("resolves a thread and the open count drops", async ({ page }) => {
  await page.goto("/");
  // Create a thread first.
  const form = await openCmCommentForm(page);
  await form.locator("textarea").fill("please rename this");
  await form.getByRole("button", { name: "Comment" }).click();

  // Wait for the new thread to render inline — that means the store and the
  // scoped counts have refreshed.
  const thread = page
    .locator(".inline-thread", { hasText: "please rename this" })
    .first();
  await expect(thread).toBeVisible();

  // The open filter shows a live count of open threads for this repo.
  const openCount = page
    .locator(".filter", { hasText: "open" })
    .locator(".filter-count");
  const before = Number(await openCount.innerText());
  expect(before).toBeGreaterThanOrEqual(1);

  // Close via the inline conversation controls.
  await thread.getByRole("button", { name: "Close" }).click();

  // The status filter still defaults to "open", so the closed thread leaves
  // the inline view; switching the filter to "closed" surfaces it again.
  await page.locator(".filter", { hasText: "closed" }).click();
  await expect(
    page.locator(".thread-card.status-closed", { hasText: "please rename this" }),
  ).toBeVisible();
  // …and the open count dropped by one.
  await expect(openCount).toHaveText(String(before - 1));
});

test("switches review target without errors", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator(".file-path", { hasText: "calc.js" })).toBeVisible();
  // Scope to the Topbar's local-mode control: selecting a target also surfaces that
  // review as a sidebar session-item sharing the same accessible name, so an
  // unscoped getByRole would be ambiguous once the diff settles.
  const modes = page.locator(".local-targets");
  // The fixture has no staged changes, so Staged shows the empty state.
  await modes.getByRole("button", { name: "Staged changes", exact: true }).click();
  await expect(page.locator(".empty")).toContainText("No changes");
  // Back to the current branch target restores the diff.
  const targetTrigger = page.locator(".target-picker .review-target-trigger");
  await targetTrigger.click();
  const picker = page.getByRole("dialog", { name: "Review changes" });
  await picker.getByRole("button", { name: /^Branch: main,/ }).click();
  await page.getByRole("option", { name: /^main/ }).click();
  await expect(page.locator(".file-path", { hasText: "calc.js" })).toBeVisible();
});
