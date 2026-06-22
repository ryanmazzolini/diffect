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
  await page.goto("/");
  // N≥2 swaps the bare repo path for a workspace crumb plus a repo count.
  await expect(page.locator(".workspace-crumb")).toBeVisible();
  await expect(page.locator(".repo-count")).toHaveText("2 repos");
  await expect(page.locator(".workspace-path")).toHaveCount(0);

  // One stacked module per repo, each labelled with its repo name.
  await expect(page.locator('.module[data-repo="alpha"]')).toBeVisible();
  await expect(page.locator('.module[data-repo="beta"]')).toBeVisible();
  await expect(page.locator('.module[data-repo="alpha"] .mod-name')).toHaveText("alpha");
  await expect(page.locator('.module[data-repo="beta"] .mod-name')).toHaveText("beta");

  // The sidebar lists both repos.
  await expect(page.locator(".repo-item")).toHaveCount(2);
});

test("each module shows only its own repo's diff", async ({ page }) => {
  await page.goto("/");
  const alpha = page.locator('.module[data-repo="alpha"]');
  const beta = page.locator('.module[data-repo="beta"]');

  // The repo-named file each fixture repo carries lands in its own module only.
  await expect(alpha.locator(".file-path", { hasText: "alpha.js" })).toBeVisible();
  await expect(beta.locator(".file-path", { hasText: "beta.js" })).toBeVisible();
  await expect(alpha.locator(".file-path", { hasText: "beta.js" })).toHaveCount(0);
  await expect(beta.locator(".file-path", { hasText: "alpha.js" })).toHaveCount(0);
});

test("selecting a repo in the sidebar focuses its module", async ({ page }) => {
  await page.goto("/");
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

  await page.locator(".repo-item", { hasText: "beta" }).click();
  await expect(page.locator('.module[data-repo="beta"]')).toHaveClass(/focused/);
  await expect(page.locator(".module.focused")).toHaveCount(1);

  await page.locator(".repo-item", { hasText: "alpha" }).click();
  await expect(page.locator('.module[data-repo="alpha"]')).toHaveClass(/focused/);
  await expect(page.locator(".module.focused")).toHaveCount(1);
});

test("a comment posted in a module is scoped to that repo", async ({ page }) => {
  await page.goto("/");
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
  await page.goto("/");
  const alpha = page.locator('.module[data-repo="alpha"]');
  await expect(alpha.locator(".mod-body")).toBeVisible();

  // The caret collapses just this module.
  await alpha.getByRole("button", { name: "Collapse alpha" }).click();
  await expect(alpha).toHaveClass(/collapsed/);
  await expect(alpha.locator(".mod-body")).toHaveCount(0);
  // Beta is untouched.
  await expect(page.locator('.module[data-repo="beta"] .mod-body')).toBeVisible();
});

test("the module rail mirrors the modules, jumps between them, and the topbar sheds its per-repo controls", async ({ page }) => {
  await page.goto("/");
  // The passive rail sits atop the sidebar: one row per repo, titled with the count.
  const rail = page.locator(".module-rail");
  await expect(rail).toBeVisible();
  await expect(rail.locator(".mr-title")).toContainText("Modules · 2");
  await expect(rail.locator(".mr-row")).toHaveCount(2);
  await expect(rail.locator(".mr-row .mr-name").nth(0)).toHaveText("alpha");
  await expect(rail.locator(".mr-row .mr-name").nth(1)).toHaveText("beta");
  // The workspace rollup summarises the whole view.
  await expect(rail.locator(".mr-rollup .rollup-bar")).toBeVisible();

  // N≥2 sheds the topbar's per-repo controls — the base…compare picker now lives in
  // each module header and viewed progress in the headers + rail. The global
  // diff-display segments (unified/split, density) stay. (Both remain at N=1.)
  await expect(page.locator(".rh-subbar .target-picker")).toHaveCount(0);
  await expect(page.locator(".rh-subbar .metaitem")).toHaveCount(0);
  await expect(page.locator(".rh-subbar .seg")).toHaveCount(2);

  // A rail row jumps to (focuses) its module, exactly like a sidebar repo click.
  // Guard on the stack actually overflowing first, else the scroll is a no-op and
  // the scroll-spy just re-picks the topmost module (a sub-second load race).
  await expect
    .poll(() =>
      page.evaluate(() => {
        const m = document.querySelector(".modmain");
        return m ? m.scrollHeight - m.clientHeight : 0;
      }),
    )
    .toBeGreaterThan(0);
  await rail.locator(".mr-row", { hasText: "beta" }).click();
  await expect(page.locator('.module[data-repo="beta"]')).toHaveClass(/focused/);
  await expect(rail.locator(".mr-row.here .mr-name")).toHaveText("beta");
});

test("a module's ref picker popover escapes the module scroll clip", async ({ page }) => {
  await page.goto("/");
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

test("a module's status crumb walks its review lifecycle", async ({ page }) => {
  await page.goto("/");
  const alpha = page.locator('.module[data-repo="alpha"]');
  const crumb = alpha.locator(".status-crumb");
  const railDot = page
    .locator(".module-rail .mr-row", { hasText: "alpha" })
    .locator(".mr-dot");

  // Idle: alpha has a diff but no comments yet.
  await expect(crumb).toContainText("Not started");

  // Post a comment on alpha → in progress, reflected in both the crumb and rail dot.
  // Wait for the stack to gain height first (rows only mount once scrolled in).
  await expect
    .poll(() =>
      page.evaluate(() => {
        const m = document.querySelector(".modmain");
        return m ? m.scrollHeight - m.clientHeight : 0;
      }),
    )
    .toBeGreaterThan(0);
  await alpha.evaluate((el) => el.scrollIntoView({ block: "start" }));
  const row = alpha.locator("tbody.diff-table-body tr", { hasText: "TODO" }).first();
  await expect(row).toBeVisible();
  await row.hover();
  await row.locator("button.diff-add-widget").first().click();
  const form = page.locator(".comment-form");
  await expect(form).toBeVisible();
  await form.locator("textarea").fill("crumb walk");
  await form.getByRole("button", { name: "Comment" }).click();

  await expect(crumb).toContainText("In progress");
  await expect(crumb.locator(".sc-dot.progress")).toBeVisible();
  await expect(railDot).toHaveClass(/progress/);

  // Close the thread → ready (all resolved), with a Mark complete affordance.
  const card = page
    .locator(".thread-pane .thread-card", { hasText: "crumb walk" })
    .first();
  await card.getByRole("button", { name: "Close", exact: true }).first().click();
  await expect(crumb).toContainText("Ready");
  await expect(crumb.locator(".sc-dot.ready")).toBeVisible();
  await expect(railDot).toHaveClass(/ready/);

  // Mark complete from the crumb → archived, with a Revive affordance.
  await crumb.getByRole("button", { name: "Mark complete" }).click();
  await expect(crumb).toContainText("Archived");
  await expect(crumb.locator(".sc-dot.arch")).toBeVisible();
  await expect(crumb.getByRole("button", { name: "Revive" })).toBeVisible();
});
