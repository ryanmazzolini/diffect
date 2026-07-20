import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test, expect, type Page } from "./fixtures.js";
import { openCmCommentForm } from "./helpers.js";

async function installScrollSpyCounter(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const state = window as typeof window & { __diffectScrollSpyObservers: number };
    const NativeIntersectionObserver = window.IntersectionObserver;
    state.__diffectScrollSpyObservers = 0;
    window.IntersectionObserver = class extends NativeIntersectionObserver {
      constructor(callback: IntersectionObserverCallback, options?: IntersectionObserverInit) {
        super(callback, options);
        if (options?.rootMargin === "0px 0px -70% 0px") {
          state.__diffectScrollSpyObservers += 1;
        }
      }
    };
  });
}

async function scrollSpyCount(page: Page): Promise<number> {
  return page.evaluate(() =>
    (window as typeof window & { __diffectScrollSpyObservers: number }).__diffectScrollSpyObservers
  );
}

async function moduleAtScrollerTop(page: Page): Promise<string | null> {
  return page.locator(".modmain").evaluate((root) => {
    const marker = root.getBoundingClientRect().top + 1;
    const modules = Array.from(root.querySelectorAll<HTMLElement>(".module[data-repo]"));
    const visible = modules.find((module) => {
      const rect = module.getBoundingClientRect();
      return rect.top <= marker && rect.bottom > marker;
    }) ?? modules.find((module) => module.getBoundingClientRect().top > marker);
    return visible?.getAttribute("data-repo") ?? null;
  });
}

async function lockBetaWhileAlphaIsAtScrollerTop(page: Page): Promise<void> {
  await page.goto("/");
  const scroller = page.locator(".modmain");
  await expect
    .poll(() => scroller.evaluate((element) => element.scrollHeight - element.clientHeight))
    .toBeGreaterThan(0);
  await page.locator(".tree-repo", { hasText: "beta" }).click();
  await expect(page.locator('.module[data-repo="beta"]')).toHaveClass(/focused/);
  await scroller.evaluate((root) => root.scrollTo({ top: 1 }));
  await expect.poll(() => moduleAtScrollerTop(page)).toBe("alpha");
}

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
  await page.goto("/");
  const alpha = page.locator('.module[data-repo="alpha"]');
  const beta = page.locator('.module[data-repo="beta"]');

  // The repo-named file each fixture repo carries lands in its own module only.
  await expect(alpha.locator(".file-path", { hasText: "alpha.js" })).toBeVisible();
  await expect(beta.locator(".file-path", { hasText: "beta.js" })).toBeVisible();
  await expect(alpha.locator(".file-path", { hasText: "beta.js" })).toHaveCount(0);
  await expect(beta.locator(".file-path", { hasText: "alpha.js" })).toHaveCount(0);
});

test("PR Draft keeps one draft per repo", async ({ page }) => {
  await page.goto("/");
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

  await page.locator(".tree-repo", { hasText: "beta" }).click();
  await expect(page.locator('.module[data-repo="beta"]')).toHaveClass(/focused/);
  await expect(page.locator(".module.focused")).toHaveCount(1);

  await page.locator(".tree-repo", { hasText: "alpha" }).click();
  await expect(page.locator('.module[data-repo="alpha"]')).toHaveClass(/focused/);
  await expect(page.locator(".module.focused")).toHaveCount(1);
});

test("wheel scrolling releases programmatic repo focus", async ({ page }) => {
  await lockBetaWhileAlphaIsAtScrollerTop(page);
  await page.locator(".modmain").hover();
  await page.mouse.wheel(0, -10_000);
  await expect.poll(() => moduleAtScrollerTop(page)).toBe("alpha");
  await expect(page.locator('.module[data-repo="alpha"]')).toHaveClass(/focused/);
});

for (const key of ["Home", "ArrowUp"] as const) {
  test(`${key} scrolling releases programmatic repo focus`, async ({ page }) => {
    await lockBetaWhileAlphaIsAtScrollerTop(page);
    await page.getByRole("button", { name: "Collapse beta" }).press(key);
    await expect.poll(() => moduleAtScrollerTop(page)).toBe("alpha");
    await expect(page.locator('.module[data-repo="alpha"]')).toHaveClass(/focused/);
  });
}

test("desktop follow mode focuses the changed repo and hunk", async ({ page }) => {
  await page.goto("/?shell=desktop");
  await expect(page.getByRole("button", { name: "Follow changes" })).toHaveAttribute("aria-pressed", "true");
  await page.locator(".tree-repo", { hasText: "alpha" }).click();
  await expect(page.locator('.module[data-repo="alpha"]')).toHaveClass(/focused/);

  await page.evaluate(async () => {
    const workspace = await fetch("/workspace").then((r) => r.json());
    const repo = workspace.repos.find((r: { name: string }) => r.name === "beta")?.name;
    if (!repo) throw new Error("beta repo missing");
    const path = "beta.js";
    const q = new URLSearchParams({ path, target: "work" });
    const content = await fetch(`/repos/${encodeURIComponent(repo)}/file/content?${q}`).then((r) =>
      r.json(),
    );
    const next = content.new.replace("TODO beta", "TODO followed beta");
    const res = await fetch(`/repos/${encodeURIComponent(repo)}/file/content?${q}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content: next }),
    });
    if (!res.ok) throw new Error(await res.text());
  });

  await expect(page.locator('.module[data-repo="beta"]')).toHaveClass(/focused/);
  await expect(page.locator(".tree-file.active")).toContainText("beta.js");
  await expect(
    page.locator('.file[data-path="beta.js"] .cm-insertedLine, .file[data-path="beta.js"] .cm-changedLine').first(),
  ).toBeInViewport();
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
  // Re-scroll until beta's body actually mounts: sibling editors above grow as
  // they finish mounting, which can push beta back out of the viewport after a
  // single scrollIntoView.
  await expect
    .poll(async () => {
      await beta.evaluate((el) => el.scrollIntoView({ block: "center" }));
      return beta.locator(".cm-line").count();
    })
    .toBeGreaterThan(0);
  const form = await openCmCommentForm(page, beta);
  await form.locator("textarea").fill("scoped to beta only");
  await form.getByRole("button", { name: "Comment" }).click();

  // It appears in the union inbox tagged with beta. Discovery refreshes may
  // re-window an off-screen module, so bring beta back before asserting its
  // inline rendering rather than assuming its CodeMirror body stayed mounted.
  const card = page
    .locator(".thread-pane .thread-card", { hasText: "scoped to beta only" })
    .first();
  await expect(card).toBeVisible();
  await expect(card.locator(".repo-chip")).toHaveText("beta");
  await beta.evaluate((element) => element.scrollIntoView({ block: "center" }));
  await expect(
    beta.locator(".inline-thread .c-text", { hasText: "scoped to beta only" }).first(),
  ).toBeVisible();
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

test("multi-repo topbar sheds per-repo controls", async ({ page }) => {
  await page.goto("/");

  // N≥2 sheds the topbar's per-repo controls — the base…compare picker now lives
  // in each module header. Global view preferences live in the topbar Options menu.
  await expect(page.locator(".rheader .target-picker")).toHaveCount(0);
  await expect(page.locator(".rheader .metaitem")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Options" })).toBeVisible();
});

test("a disk update refreshes only the affected repo", async ({ page }) => {
  await installScrollSpyCounter(page);
  await page.goto("/");
  await expect(page.locator('.module[data-repo="alpha"] .file-path', { hasText: "alpha.js" })).toBeVisible();
  await expect(page.locator('.module[data-repo="beta"] .file-path', { hasText: "beta.js" })).toBeVisible();
  const alphaEditor = page.locator('.module[data-repo="alpha"] .file[data-path="alpha.js"] .cm-content');
  await expect(alphaEditor).toContainText("TODO alpha");
  await alphaEditor.evaluate((element) => {
    element.setAttribute("data-refresh-sentinel", "stable");
  });
  const scrollSpyBaseline = await scrollSpyCount(page);

  const workspace = await page.request.get("/workspace").then((response) => response.json()) as {
    repos: Array<{ name: string; root: string }>;
  };
  const alpha = workspace.repos.find((repo) => repo.name === "alpha");
  if (!alpha) throw new Error("alpha fixture repo missing");

  const refreshedRepos: string[] = [];
  const metadataRequests: string[] = [];
  page.on("request", (request) => {
    const pathname = new URL(request.url()).pathname;
    const match = pathname.match(/^\/repos\/([^/]+)\/diff$/);
    if (match?.[1]) refreshedRepos.push(decodeURIComponent(match[1]));
    if (pathname === "/workspace" || pathname === "/workspaces") metadataRequests.push(pathname);
  });

  const file = join(alpha.root, "alpha.js");
  const original = await readFile(file, "utf8");
  for (const replacement of ["TODO first", "TODO second", "TODO final"]) {
    await writeFile(file, original.replace("TODO alpha", replacement));
    await new Promise((resolve) => setTimeout(resolve, 150));
  }

  await expect.poll(() => refreshedRepos.filter((repo) => repo === "alpha").length).toBeGreaterThan(0);
  await page.waitForTimeout(1_000);
  expect(refreshedRepos.filter((repo) => repo === "alpha")).toHaveLength(1);
  expect(refreshedRepos.filter((repo) => repo === "beta")).toHaveLength(0);
  expect(metadataRequests).toHaveLength(0);
  await expect(alphaEditor).toContainText("TODO final");
  await expect(alphaEditor).toHaveAttribute("data-refresh-sentinel", "stable");
  await expect.poll(() => scrollSpyCount(page)).toBe(scrollSpyBaseline);

  await page.getByRole("button", { name: "Options" }).click();
  await page.getByRole("button", { name: "Split" }).click();
  const splitEditor = page.getByRole("textbox", { name: "alpha.js new diff editor" });
  await expect(splitEditor).toContainText("TODO final");
  await splitEditor.evaluate((element) => {
    element.setAttribute("data-refresh-sentinel", "stable");
  });
  await writeFile(file, original.replace("TODO alpha", "TODO split"));
  await expect(splitEditor).toContainText("TODO split");
  await expect(splitEditor).toHaveAttribute("data-refresh-sentinel", "stable");
});

test("a semantic no-op disk event leaves the active diff mounted", async ({ page }) => {
  await installScrollSpyCounter(page);
  await page.goto("/");
  await expect(page.locator('.module[data-repo="alpha"] .file-path', { hasText: "alpha.js" })).toBeVisible();
  await page.locator(".tree-repo", { hasText: "alpha" }).click();

  const workspace = await page.request.get("/workspace").then((response) => response.json()) as {
    repos: Array<{ name: string; root: string }>;
  };
  const alpha = workspace.repos.find((repo) => repo.name === "alpha");
  if (!alpha) throw new Error("alpha fixture repo missing");
  const baseline = await scrollSpyCount(page);

  let refreshes = 0;
  page.on("request", (request) => {
    if (new URL(request.url()).pathname === "/repos/alpha/diff") refreshes += 1;
  });
  const file = join(alpha.root, "alpha.js");
  const content = await readFile(file, "utf8");
  await writeFile(file, content);

  await expect.poll(() => refreshes).toBeGreaterThan(0);
  await page.waitForTimeout(300);
  await expect.poll(() => scrollSpyCount(page)).toBe(baseline);
});

test("disk updates in one repo do not delay another repo", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator('.module[data-repo="alpha"] .file-path', { hasText: "alpha.js" })).toBeVisible();
  await expect(page.locator('.module[data-repo="beta"] .file-path', { hasText: "beta.js" })).toBeVisible();

  const workspace = await page.request.get("/workspace").then((response) => response.json()) as {
    repos: Array<{ name: string; root: string }>;
  };
  const alpha = workspace.repos.find((repo) => repo.name === "alpha");
  const beta = workspace.repos.find((repo) => repo.name === "beta");
  if (!alpha || !beta) throw new Error("multi-repo fixture missing");

  const refreshedRepos: string[] = [];
  page.on("request", (request) => {
    const match = new URL(request.url()).pathname.match(/^\/repos\/([^/]+)\/diff$/);
    if (match?.[1]) refreshedRepos.push(decodeURIComponent(match[1]));
  });

  const alphaFile = join(alpha.root, "alpha.js");
  const betaFile = join(beta.root, "beta.js");
  const [alphaContent, betaContent] = await Promise.all([
    readFile(alphaFile, "utf8"),
    readFile(betaFile, "utf8"),
  ]);
  await writeFile(betaFile, betaContent.replace("TODO beta", "TODO simultaneous"));
  const alphaBurst = (async () => {
    for (const replacement of ["TODO one", "TODO two", "TODO three", "TODO final"]) {
      await writeFile(alphaFile, alphaContent.replace("TODO alpha", replacement));
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
  })();

  // Alpha's continuing writes must not postpone beta's settled refresh.
  await page.waitForTimeout(600);
  expect(refreshedRepos.filter((repo) => repo === "beta")).toHaveLength(1);
  await alphaBurst;
  await expect.poll(() => new Set(refreshedRepos).size).toBe(2);
  expect(refreshedRepos.filter((repo) => repo === "alpha")).toHaveLength(1);
  expect(refreshedRepos.filter((repo) => repo === "beta")).toHaveLength(1);
});

test("live refresh keeps the reading anchor stable in a stacked module", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("button", { name: "Follow changes" })).toHaveAttribute(
    "aria-pressed",
    "false",
  );
  const anchor = page.locator('.module[data-repo="alpha"] .file[data-path="alpha.js"] .cm-line', {
    hasText: "return REPO // TODO alpha",
  });
  await expect(anchor).toBeVisible();
  await anchor.evaluate((element) => element.scrollIntoView({ block: "center" }));
  const initialTop = await anchor.evaluate((element) => element.getBoundingClientRect().top);

  const workspace = await page.request.get("/workspace").then((response) => response.json()) as {
    repos: Array<{ name: string; root: string }>;
  };
  const alpha = workspace.repos.find((repo) => repo.name === "alpha");
  if (!alpha) throw new Error("alpha fixture repo missing");

  const contentRefresh = page.waitForResponse((response) => {
    const url = new URL(response.url());
    return (
      response.request().method() === "GET" &&
      url.pathname.endsWith("/file/content") &&
      url.searchParams.get("path") === "alpha.js"
    );
  });
  const alphaPath = join(alpha.root, "alpha.js");
  const original = await readFile(alphaPath, "utf8");
  const generated = Array.from(
    { length: 120 },
    (_, index) => `export const generated${index} = ${index};`,
  ).join("\n");
  await writeFile(alphaPath, `${generated}\n${original}`);
  await contentRefresh;
  await expect(
    page.locator('.module[data-repo="alpha"] .file[data-path="alpha.js"] .diffstat'),
  ).toContainText("+121");

  await expect(anchor).toBeInViewport({ timeout: 1_000 });
  await expect
    .poll(async () => {
      const finalTop = await anchor.evaluate((element) => element.getBoundingClientRect().top);
      return Math.abs(finalTop - initialTop);
    }, { timeout: 1_000 })
    .toBeLessThanOrEqual(2);
});

test("a module's ref picker popover escapes the module scroll clip", async ({ page }) => {
  await page.goto("/");
  const alpha = page.locator('.module[data-repo="alpha"]');
  await expect(alpha).toBeVisible();
  const targetTrigger = alpha.locator(".review-target-trigger");

  // The task menu itself is portaled out of `.modmain`.
  await targetTrigger.click();
  const dialog = page.getByRole("dialog", { name: "Review changes" });
  await expect(dialog).toBeVisible();
  await expect(page.locator(".modmain .review-target-popover")).toHaveCount(0);

  const baseTrigger = dialog.getByRole("button", { name: /^Base: main,/ });
  await baseTrigger.click();

  // The nested ref search stays under the body-level task popover, so the module
  // scroll container cannot clip it.
  const popover = page.locator(".ref-popover");
  await expect(popover).toBeVisible();
  await expect(page.locator(".modmain .ref-popover")).toHaveCount(0);
  const box = await popover.boundingBox();
  expect(box).not.toBeNull();
  expect(box.height).toBeGreaterThan(100);

  await page.getByPlaceholder("Find a branch, tag, or commit…").fill("main");
  await page.getByRole("option", { name: /main/ }).first().click();
  await expect(baseTrigger).toBeFocused();
  await expect(page.locator(".ref-popover")).toHaveCount(0);

  // Ref choices apply live while the single task popover remains open.
  await expect(targetTrigger).toHaveText("main → HEAD▾");
  await expect(dialog).toBeVisible();
  await expect(page.locator(".ref-search-error")).toHaveCount(0);

  // Escape from nested search returns to its trigger; Escape again closes the
  // whole task popover and restores the module trigger.
  await baseTrigger.click();
  await page.getByPlaceholder("Find a branch, tag, or commit…").press("Escape");
  await expect(baseTrigger).toBeFocused();
  await baseTrigger.press("Escape");
  await expect(dialog).toBeHidden();
  await expect(targetTrigger).toBeFocused();
});
