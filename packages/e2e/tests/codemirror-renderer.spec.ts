import { execFile } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { test, expect, type Locator, type Page } from "@playwright/test";

const execFileAsync = promisify(execFile);

async function openMathFile(page: Page, target = "work", repo?: string): Promise<Locator> {
  const query = new URLSearchParams();
  if (repo) query.set("repo", repo);
  if (target !== "work") query.set("target", target);
  await page.goto(query.size === 0 ? "/" : `/?${query}`);
  await page.locator(".tree-file", { hasText: "math.js" }).click();
  const file = page.locator(".file", { hasText: "math.js" });
  await expect(file.locator(".cm-diff-host .cm-editor")).toBeVisible();
  return file;
}

async function fixtureRepo(page: Page): Promise<{ name: string; root: string }> {
  const response = await page.request.get("/workspace");
  const workspace = (await response.json()) as { repos: Array<{ name: string; root: string }> };
  const repo = workspace.repos[0];
  if (!repo) throw new Error("fixture repo missing");
  return repo;
}

async function withStagedMathFile(page: Page, run: (file: Locator) => Promise<void>): Promise<void> {
  const repo = await fixtureRepo(page);

  await execFileAsync("git", ["add", "src/util/math.js"], { cwd: repo.root });
  try {
    await run(await openMathFile(page, "staged", repo.name));
  } finally {
    await execFileAsync("git", ["reset", "--", "src/util/math.js"], { cwd: repo.root });
  }
}

async function withDeletedMathFile(page: Page, run: (file: Locator) => Promise<void>): Promise<void> {
  const repo = await fixtureRepo(page);
  const path = "src/util/math.js";
  const absolutePath = join(repo.root, path);
  const original = await readFile(absolutePath, "utf8");

  await execFileAsync("git", ["rm", "-f", path], { cwd: repo.root });
  try {
    await run(await openMathFile(page, "work", repo.name));
  } finally {
    await mkdir(dirname(absolutePath), { recursive: true });
    await writeFile(absolutePath, original);
    await execFileAsync("git", ["reset", "--", path], { cwd: repo.root });
  }
}

test("renders the default CodeMirror diff renderer", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator(".file-header").first()).toBeVisible();
  await expect(page.locator(".cm-diff-host .cm-editor").first()).toBeVisible();
  await expect(page.locator(".cm-diff-host .cm-deletedChunk").first()).toBeVisible();
});

test("split view uses the CodeMirror merge renderer", async ({ page }) => {
  await page.addInitScript(() => localStorage.removeItem("diffect-split-view"));
  await page.goto("/");
  const firstFile = page.locator(".file").first();
  await expect(firstFile.locator(".cm-diff-host .cm-editor").first()).toBeVisible();
  await page.getByRole("button", { name: "Options" }).click();
  await page.getByRole("button", { name: "Split" }).click();

  await expect(firstFile.getByRole("textbox", { name: /old diff editor/ })).toBeVisible();
  await expect(firstFile.getByRole("textbox", { name: /new diff editor/ })).toBeVisible();
});

test("loads GraphQL language support in the CodeMirror diff renderer", async ({ page }) => {
  await page.goto("/");
  await page.locator(".tree-file", { hasText: "schema.graphql" }).click();

  const file = page.locator(".file", { hasText: "schema.graphql" });
  await expect(file.locator(".cm-diff-host .cm-editor")).toBeVisible();
  await expect(file.locator(".cm-line", { hasText: "viewer" })).toBeVisible();
  await expect(file.locator(".cm-line span").first()).toBeVisible();
});

test("explains when CodeMirror skips deleted syntax highlighting", async ({ page }) => {
  await page.goto("/?cm6DeletedSyntaxHighlightMax=1");

  const file = page.locator(".file", { hasText: "math.js" });
  await expect(file.locator(".cm-diff-host .cm-editor")).toBeVisible();
  await expect(file.locator(".cm-diff-notice")).toContainText("plain text");
});

test("comments, replies, and closes from the CodeMirror diff renderer", async ({ page }) => {
  await withStagedMathFile(page, async (file) => {
    const editMode = file.locator(".cm-mode-toggle").getByRole("button", { name: "Edit file" });
    await expect(editMode).toBeDisabled();
    await file.locator(".cm-comment-gutter .cm-gutterElement").nth(1).hover();
    await file.locator("button.cm-diff-add-widget[data-side='new']").first().click();
    const form = file.locator(".comment-form");
    await expect(form).toBeVisible();
    await form.locator("textarea").fill("comment via cm6");
    await form.getByRole("button", { name: "Comment" }).click();

    const thread = file.locator(".inline-thread", { hasText: "comment via cm6" }).first();
    await expect(thread).toBeVisible();
    await expect(page.locator(".thread-pane", { hasText: "comment via cm6" })).toBeVisible();

    await thread.getByRole("button", { name: "Reply" }).click();
    await thread.locator(".reply-form textarea").fill("reply via cm6");
    await thread.locator(".reply-form").getByRole("button", { name: "Reply" }).click();
    await expect(thread.locator(".c-text", { hasText: "reply via cm6" })).toBeVisible();

    await thread.getByRole("button", { name: "Close" }).click();
    await page.locator(".filter", { hasText: "closed" }).click();
    await expect(
      page.locator(".thread-card.status-closed", { hasText: "comment via cm6" }),
    ).toBeVisible();
  });
});

test("dragging the CodeMirror comment handle opens a range comment", async ({ page }) => {
  await withStagedMathFile(page, async (file) => {
    const plus = file.locator("button.cm-diff-add-widget[data-side='new']").first();
    await expect(plus).toHaveCSS("opacity", "0");

    const commentGutter = file.locator(".cm-comment-gutter .cm-gutterElement").nth(1);
    await commentGutter.hover();
    await expect(plus).toHaveCSS("opacity", "1");
    await expect
      .poll(() =>
        file.locator("button.cm-diff-add-widget").evaluateAll(
          (buttons) => buttons.filter((button) => getComputedStyle(button).opacity !== "0").length,
        ),
      )
      .toBe(1);
    await file.locator(".cm-comment-gutter .cm-gutterElement").nth(3).hover();
    await expect
      .poll(() =>
        file.locator("button.cm-diff-add-widget").evaluateAll(
          (buttons) => buttons.filter((button) => getComputedStyle(button).opacity !== "0").length,
        ),
      )
      .toBe(1);
    await commentGutter.hover();

    const lineNumbers = file.locator(".cm-lineNumbers .cm-gutterElement");
    const start = await plus.boundingBox();
    const end = await lineNumbers.filter({ hasText: "3" }).first().boundingBox();
    expect(start).not.toBeNull();
    expect(end).not.toBeNull();

    await page.mouse.move(start!.x + start!.width / 2, start!.y + start!.height / 2);
    await page.mouse.down();
    await page.mouse.move(start!.x + start!.width / 2, end!.y + end!.height / 2);
    await expect
      .poll(() => file.locator(".cm-range-commented").first().evaluate((el) => getComputedStyle(el).backgroundColor))
      .not.toBe("rgba(0, 0, 0, 0)");
    await expect
      .poll(() =>
        file.locator("button.cm-diff-add-widget").evaluateAll(
          (buttons) => buttons.filter((button) => getComputedStyle(button).opacity !== "0").length,
        ),
      )
      .toBe(1);
    const rangeSelect = await page.evaluate(() => {
      const probe = document.createElement("div");
      probe.style.backgroundColor = getComputedStyle(document.documentElement).getPropertyValue("--range-select");
      document.body.append(probe);
      const color = getComputedStyle(probe).backgroundColor;
      probe.remove();
      return color;
    });
    await expect
      .poll(() =>
        file.locator("button.cm-diff-add-widget").evaluateAll((buttons) => {
          const visible = buttons.find((button) => getComputedStyle(button).opacity !== "0");
          return visible ? getComputedStyle(visible).backgroundColor : "";
        }),
      )
      .toBe(rangeSelect);
    await page.mouse.up();

    await expect(file.locator(".comment-form-title")).toContainText(/lines \d+ to \d+/);
    await expect
      .poll(() =>
        file.locator("button.cm-diff-add-widget").evaluateAll(
          (buttons) => buttons.filter((button) => getComputedStyle(button).opacity !== "0").length,
        ),
      )
      .toBe(0);
    await expect(file.locator(".cm-selection-widget .comment-form")).toHaveCSS("border-top-width", "0px");
  });
});

test("comments on expanded unchanged CodeMirror lines", async ({ page }) => {
  await page.goto("/");
  await page.locator(".tree-file", { hasText: "calc.js" }).click();
  const file = page.locator(".file", { hasText: "calc.js" });
  await expect(file.locator(".cm-mode-toggle").getByRole("button", { name: "Comment on diff" })).toHaveClass(/active/);

  await file.locator(".cm-collapsedLines").click();
  const unchangedLine = file.locator(".cm-line", { hasText: "export const k10 = 10;" });
  await expect(unchangedLine).toBeVisible();
  await unchangedLine.hover();

  const plus = file.locator("button.cm-diff-add-widget.cm-hover-line[data-side='new'][data-line='11']");
  await expect(plus).toHaveCSS("opacity", "1");
  await plus.click();
  await expect(file.locator(".comment-form")).toBeVisible();
  await expect(file.locator(".cm-range-commented")).toHaveCount(1);
});

test("old-side CodeMirror comments highlight deleted lines", async ({ page }) => {
  await withStagedMathFile(page, async (file) => {
    await file.locator(".cm-deletedLine").first().hover();
    await file.locator("button.cm-diff-add-widget.cm-hover-line[data-side='old']").click();

    await expect(file.locator(".comment-form")).toBeVisible();
    await expect(file.locator(".cm-deletedLine.cm-range-commented-deleted")).toBeVisible();
    await expect
      .poll(() =>
        file
          .locator(".cm-deletedLine.cm-range-commented-deleted")
          .first()
          .evaluate((el) => getComputedStyle(el).backgroundColor),
      )
      .not.toBe("rgba(0, 0, 0, 0)");
  });
});

test("deleted CodeMirror files disable edit but allow old-side comments", async ({ page }) => {
  await withDeletedMathFile(page, async (file) => {
    await expect(file.locator(".status-deleted")).toHaveText("deleted");
    const edit = file.locator(".cm-mode-toggle").getByRole("button", { name: "Edit file" });
    await expect(edit).toBeDisabled();
    await expect(edit).toHaveAttribute("title", "Deleted files can’t be edited here");

    await file.locator(".cm-deletedLine", { hasText: "return x * x" }).hover();
    await file.locator("button.cm-diff-add-widget.cm-hover-line[data-side='old'][data-line='3']").click();
    await expect(file.locator(".comment-form")).toBeVisible();
    await expect(file.locator(".cm-deletedLine.cm-range-commented-deleted")).toHaveCount(1);
    await expect(file.locator(".cm-deletedLine.cm-range-commented-deleted")).toContainText("return x * x");
  });
});

test("saves edits from the CodeMirror diff renderer", async ({ page }) => {
  const file = await openMathFile(page);

  await expect(file.locator(".cm-mode-toggle").getByRole("button", { name: "Comment on diff" })).toHaveClass(/active/);
  await file.locator(".cm-comment-gutter .cm-gutterElement").nth(1).hover();
  await expect(file.locator("button.cm-diff-add-widget").first()).toHaveCSS("opacity", "1");

  await expect(file.locator(".file-header")).not.toHaveClass(/edit-mode/);
  const edit = file.getByRole("button", { name: "Edit file" });
  await edit.click();
  await expect(edit).toHaveClass(/active/);
  await expect(file.locator(".file-header")).toHaveClass(/edit-mode/);
  await expect(file.locator(".cm-diff-editbar")).toHaveCount(0);
  await expect(file.locator(".cm-diff-save-pill")).toBeVisible();
  await expect(file.locator("button.cm-diff-add-widget")).toHaveCount(0);
  await file.locator(".cm-line", { hasText: "return x * x // TODO" }).click();
  await page.keyboard.press("End");
  await page.keyboard.insertText("!");
  await expect(file.locator(".cm-line", { hasText: "return x * x // TODO!" })).toBeVisible();
  await page.keyboard.press("ControlOrMeta+Z");
  await expect(file.locator(".cm-line", { hasText: "return x * x // TODO!" })).toHaveCount(0);
  await page.keyboard.press("ControlOrMeta+Shift+Z");
  await expect(file.locator(".cm-line", { hasText: "return x * x // TODO!" })).toBeVisible();
  await expect(file.locator(".cm-cursor-secondary")).toHaveCount(0);

  await expect(file.getByRole("button", { name: "Save" })).toBeEnabled();
  const saved = page.waitForResponse(
    (response) => response.url().includes("/file/content") && response.request().method() === "PUT",
  );
  await page.keyboard.press("ControlOrMeta+S");
  expect((await saved).ok()).toBe(true);

  await page.reload();
  await page.locator(".tree-file", { hasText: "math.js" }).click();
  const refreshed = page.locator(".file", { hasText: "math.js" });
  await expect(refreshed.locator(".cm-line", { hasText: "return x * x // TODO!" })).toBeVisible();
});
