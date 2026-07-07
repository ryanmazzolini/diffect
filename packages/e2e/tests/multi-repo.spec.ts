import { test, expect } from "@playwright/test";

/**
 * The multi-repo "modules view". This project runs against a daemon seeded by
 * fixture-server.mjs with FIXTURE_MULTI=1 (see playwright.config's MULTI_PORT):
 * a workspace holding two sibling repos, alpha and beta. The assertions cover the
 * N≥2 chrome and that per-repo state stays isolated — the diff, the focus, and a
 * comment's scope each belong to exactly one module. The single-repo specs cover
 * the N=1 behaviour these must not regress.
 */

test("renders the workspace identity and one module per repo", async ({ page }) => {
  await page.goto("/?renderer=git");
  // N≥2 keeps the workspace picker/path in the topbar plus a repo count.
  await expect(page.locator(".workspace-trigger")).toBeVisible();
  await expect(page.locator(".workspace-path")).toBeVisible();
  await expect(page.locator(".repo-count")).toHaveText("2 repos");

  // One stacked module per repo, each labelled with its repo name.
  await expect(page.locator('.module[data-repo="alpha"]')).toBeVisible();
  await expect(page.locator('.module[data-repo="beta"]')).toBeVisible();
  await expect(page.locator('.module[data-repo="alpha"] .mod-name')).toHaveText("alpha");
  await expect(page.locator('.module[data-repo="beta"] .mod-name')).toHaveText("beta");

  // The sidebar lists both repos.
  await expect(page.locator(".tree-repo")).toHaveCount(2);
});

test("each module shows only its own repo's diff", async ({ page }) => {
  await page.goto("/?renderer=git");
  const alpha = page.locator('.module[data-repo="alpha"]');
  const beta = page.locator('.module[data-repo="beta"]');

  // The repo-named file each fixture repo carries lands in its own module only.
  await expect(alpha.locator(".file-path", { hasText: "alpha.js" })).toBeVisible();
  await expect(beta.locator(".file-path", { hasText: "beta.js" })).toBeVisible();
  await expect(alpha.locator(".file-path", { hasText: "beta.js" })).toHaveCount(0);
  await expect(beta.locator(".file-path", { hasText: "alpha.js" })).toHaveCount(0);
});

test("PR Draft keeps one draft per repo", async ({ page }) => {
  await page.goto("/?renderer=git");
  await page.getByRole("tab", { name: "PR Draft" }).click();
  const alpha = page.locator(".pr-draft-card", { hasText: "alpha" });
  const beta = page.locator(".pr-draft-card", { hasText: "beta" });

  await expect(alpha).toBeVisible();
  await expect(beta).toBeVisible();
  await alpha.getByPlaceholder("PR title").fill("Alpha PR");
  await alpha.getByPlaceholder("Summarize the change, validation, risks, and screenshots.").fill("alpha body");
  await alpha.getByRole("button", { name: "Save" }).click();

  await expect(beta.getByPlaceholder("PR title")).toHaveValue("");
  await beta.getByPlaceholder("PR title").fill("Beta PR");
  await beta.getByPlaceholder("Summarize the change, validation, risks, and screenshots.").fill("beta body");
  await beta.getByRole("button", { name: "Save" }).click();

  await expect(alpha.getByPlaceholder("PR title")).toHaveValue("Alpha PR");
  await expect(alpha.getByPlaceholder("Summarize the change, validation, risks, and screenshots.")).toHaveValue(
    "alpha body",
  );
  await expect
    .poll(() =>
      page.evaluate(async () => {
        const draft = await fetch("/pr-draft?repo=beta").then((r) => r.json());
        return `${draft.repo}\n${draft.title}\n${draft.body}`;
      }),
    )
    .toBe("beta\nBeta PR\nbeta body");
});

test("selecting a repo in the sidebar focuses its module", async ({ page }) => {
  await page.goto("/?renderer=git");
  // Wait until the stacked content actually overflows the scroll container. Until
  // the modules have height, selecting a repo can't scroll its module to the top,
  // and the scroll-spy would just re-pick the topmost one — a sub-second load race,
  // not the steady-state behaviour this asserts.
  await expect
    .poll(() =>
      page.evaluate(() => {
        const m = document.querySelector(".modmain");
        return m ? m.scrollHeight - m.clientHeight : 0;
      }),
    )
    .toBeGreaterThan(0);
  // Exactly one module is focused at rest; which one depends on discovery order,
  // so don't assume — just drive focus explicitly and assert it follows.
  await expect(page.locator(".module.focused")).toHaveCount(1);

  await page.locator(".tree-repo", { hasText: "beta" }).click();
  await expect(page.locator('.module[data-repo="beta"]')).toHaveClass(/focused/);
  await expect(page.locator(".module.focused")).toHaveCount(1);

  await page.locator(".tree-repo", { hasText: "alpha" }).click();
  await expect(page.locator('.module[data-repo="alpha"]')).toHaveClass(/focused/);
  await expect(page.locator(".module.focused")).toHaveCount(1);
});

test("a comment posted in a module is scoped to that repo", async ({ page }) => {
  await page.goto("/?renderer=git");
  const beta = page.locator('.module[data-repo="beta"]');
  await expect(beta).toBeVisible();
  // Beta's diff bodies start as off-screen placeholders (scroll-windowing) and
  // only mount once scrolled into the container's viewport. Wait for the content
  // to gain height first — scrolling is a no-op until then — then bring beta in
  // and let its rows mount before reaching for a line.
  await expect
    .poll(() =>
      page.evaluate(() => {
        const m = document.querySelector(".modmain");
        return m ? m.scrollHeight - m.clientHeight : 0;
      }),
    )
    .toBeGreaterThan(0);
  await beta.evaluate((el) => el.scrollIntoView({ block: "center" }));
  const row = beta.locator("tbody.diff-table-body tr", { hasText: "TODO" }).first();
  await expect(row).toBeVisible();
  await row.hover();
  await row.locator("button.diff-add-widget").first().click();

  const form = page.locator(".comment-form");
  await expect(form).toBeVisible();
  await form.locator("textarea").fill("scoped to beta only");
  await form.getByRole("button", { name: "Comment" }).click();

  // It shows inline under beta, and in the union inbox tagged with the beta chip.
  await expect(
    beta.locator(".inline-thread .c-text", { hasText: "scoped to beta only" }).first(),
  ).toBeVisible();
  const card = page
    .locator(".thread-pane .thread-card", { hasText: "scoped to beta only" })
    .first();
  await expect(card).toBeVisible();
  await expect(card.locator(".repo-chip")).toHaveText("beta");
});

test("collapsing a module hides its diff body but not its sibling", async ({ page }) => {
  await page.goto("/?renderer=git");
  const alpha = page.locator('.module[data-repo="alpha"]');
  await expect(alpha.locator(".mod-body")).toBeVisible();

  // The caret collapses just this module.
  await alpha.getByRole("button", { name: "Collapse alpha" }).click();
  await expect(alpha).toHaveClass(/collapsed/);
  await expect(alpha.locator(".mod-body")).toHaveCount(0);
  // Beta is untouched.
  await expect(page.locator('.module[data-repo="beta"] .mod-body')).toBeVisible();
});

test("multi-repo topbar sheds per-repo controls", async ({ page }) => {
  await page.goto("/?renderer=git");

  // N≥2 sheds the topbar's per-repo controls — the base…compare picker now lives
  // in each module header. Global view preferences live in the topbar Options menu.
  await expect(page.locator(".rheader .target-picker")).toHaveCount(0);
  await expect(page.locator(".rheader .metaitem")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Options" })).toBeVisible();
});

test("a module's ref picker popover escapes the module scroll clip", async ({ page }) => {
  await page.goto("/?renderer=git");
  const alpha = page.locator('.module[data-repo="alpha"]');
  await expect(alpha).toBeVisible();

  // Open alpha's base picker from its module header.
  await alpha.locator('.compare .ref-trigger[title^="Base:"]').click();

  // The popover is portaled to the body, NOT left inside `.modmain` (whose
  // overflow:auto would clip it to a ~51px sliver). So it exists once globally
  // but zero times under the scroll container.
  const popover = page.locator(".ref-popover");
  await expect(popover).toBeVisible();
  await expect(page.locator(".modmain .ref-popover")).toHaveCount(0);
  // And it renders at full height, not clipped to the header band.
  const box = await popover.boundingBox();
  expect(box).not.toBeNull();
  expect(box.height).toBeGreaterThan(100);

  // The portaled popover stays interactive: typing + clicking an option inside it
  // must not register as an outside click (which would close it before the option
  // is chosen). At rest this module shows the default "All local changes" mode, so
  // exactly one local mode is active.
  await expect(alpha.locator(".target-mode.active")).toHaveCount(1);
  await page.getByPlaceholder("Find a branch, tag, or commit…").fill("main");
  await page.getByRole("option", { name: /main/ }).first().click();

  // Choosing a base…compare target switches the module off every local mode and
  // closes the popover — only possible if the in-popover click actually selected
  // an option (i.e. the portal-aware click-outside guard let it through). Focus
  // returns to the trigger rather than being stranded at the body.
  const baseTrigger = alpha.locator('.compare .ref-trigger[title="Base: main"]');
  await expect(baseTrigger).toBeVisible();
  await expect(alpha.locator(".target-mode.active")).toHaveCount(0);
  await expect(page.locator(".ref-popover")).toHaveCount(0);
  await expect(baseTrigger).toBeFocused();
  await expect(page.locator(".ref-search-error")).toHaveCount(0);

  // Escape also dismisses the popover and hands focus back to the trigger.
  await baseTrigger.click();
  await expect(page.locator(".ref-popover")).toBeVisible();
  await page.getByPlaceholder("Find a branch, tag, or commit…").press("Escape");
  await expect(page.locator(".ref-popover")).toHaveCount(0);
  await expect(baseTrigger).toBeFocused();
});
