import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test, expect, type Locator, type Page } from "./fixtures.js";

const GENERATED_PREFIX = Array.from(
  { length: 120 },
  (_, index) => `export const generated${index} = ${index};`,
).join("\n");

async function fixtureRoot(page: Page): Promise<string> {
  const workspace = (await page.request.get("/workspace").then((response) => response.json())) as {
    repos: Array<{ root: string }>;
  };
  const root = workspace.repos[0]?.root;
  if (!root) throw new Error("fixture repo missing");
  return root;
}

async function centerReadingAnchor(page: Page): Promise<{ anchor: Locator; top: number }> {
  const anchor = page.locator('.file[data-path="calc.js"] .cm-line', {
    hasText: "return a + b // TODO: overflow?",
  });
  await expect(anchor).toBeVisible();
  await anchor.evaluate((element) => element.scrollIntoView({ block: "center" }));
  return {
    anchor,
    top: await anchor.evaluate((element) => element.getBoundingClientRect().top),
  };
}

async function addGeneratedLines(
  page: Page,
  root: string,
  path: string,
  placement: "before" | "after" = "before",
): Promise<void> {
  const contentRefresh = page.waitForResponse((response) => {
    const url = new URL(response.url());
    return (
      response.request().method() === "GET" &&
      url.pathname.endsWith("/file/content") &&
      url.searchParams.get("path") === path
    );
  });
  const filePath = join(root, ...path.split("/"));
  const original = await readFile(filePath, "utf8");
  const next = placement === "before"
    ? `${GENERATED_PREFIX}\n${original}`
    : `${original}\n${GENERATED_PREFIX}`;
  await writeFile(filePath, next);
  await contentRefresh;
  await page.evaluate(
    () => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))),
  );
}

async function expectReadingAnchorStable(
  anchor: Locator,
  initialTop: number,
  tolerance = 2,
): Promise<void> {
  await expect(anchor).toBeInViewport({ timeout: 1_000 });
  await expect
    .poll(async () => {
      const finalTop = await anchor.evaluate((element) => element.getBoundingClientRect().top);
      return Math.abs(finalTop - initialTop);
    }, { timeout: 1_000 })
    .toBeLessThanOrEqual(tolerance);
}

async function armSplitScrollDrift(
  page: Page,
  pixels: number,
  userIntent = false,
): Promise<Locator> {
  const pane = page.locator(".diff-pane");
  await pane.evaluate((element, options) => {
    const descriptor = Object.getOwnPropertyDescriptor(Element.prototype, "scrollTop");
    if (!descriptor?.get || !descriptor.set) throw new Error("scrollTop descriptor unavailable");
    const scrollRoot = element as HTMLElement;
    let applied = false;
    Object.defineProperty(scrollRoot, "scrollTop", {
      configurable: true,
      get: () => descriptor.get?.call(scrollRoot),
      set: (value: number) => {
        descriptor.set?.call(scrollRoot, value);
        if (applied || value < 1_000) return;
        applied = true;
        requestAnimationFrame(() => {
          if (options.userIntent) {
            scrollRoot.dispatchEvent(new WheelEvent("wheel", { bubbles: true, deltaY: -options.pixels }));
          }
          const shifted = (descriptor.get?.call(scrollRoot) as number) - options.pixels;
          descriptor.set?.call(scrollRoot, shifted);
          scrollRoot.dataset.testSplitScrollDrift = String(shifted);
          delete (scrollRoot as HTMLElement & { scrollTop?: number }).scrollTop;
        });
      },
    });
  }, { pixels, userIntent });
  return pane;
}

async function expectInjectedScrollPreserved(pane: Locator): Promise<void> {
  await expect(pane).toHaveAttribute("data-test-split-scroll-drift", /\d+/);
  await expect.poll(async () => pane.evaluate((element) => {
    const injected = Number((element as HTMLElement).dataset.testSplitScrollDrift);
    return Math.abs((element as HTMLElement).scrollTop - injected);
  })).toBeLessThanOrEqual(1);
}

async function holdAnimationFrames(page: Page): Promise<void> {
  await page.evaluate(() => {
    const nativeRequest = window.requestAnimationFrame.bind(window);
    const nativeCancel = window.cancelAnimationFrame.bind(window);
    const held = new Map<number, FrameRequestCallback>();
    let holding = true;
    let nextHeldId = -1;
    const controlledWindow = window as typeof window & {
      __diffectRafControl?: { release: () => void };
    };
    window.requestAnimationFrame = (callback) => {
      if (!holding) return nativeRequest(callback);
      const id = nextHeldId;
      nextHeldId -= 1;
      held.set(id, callback);
      return id;
    };
    window.cancelAnimationFrame = (id) => {
      if (!held.delete(id)) nativeCancel(id);
    };
    controlledWindow.__diffectRafControl = {
      release() {
        holding = false;
        for (const callback of held.values()) nativeRequest(callback);
        held.clear();
      },
    };
  });
}

async function releaseAnimationFrames(page: Page): Promise<void> {
  await page.evaluate(() => {
    const controlledWindow = window as typeof window & {
      __diffectRafControl?: { release: () => void };
    };
    controlledWindow.__diffectRafControl?.release();
  });
}

test.beforeEach(async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("button", { name: "Follow changes" })).toHaveAttribute(
    "aria-pressed",
    "false",
  );
});

test("live refresh keeps the reading anchor stable with follow off", async ({ page }) => {
  const { anchor, top } = await centerReadingAnchor(page);
  await addGeneratedLines(page, await fixtureRoot(page), "calc.js");
  await expect(page.locator('.file[data-path="calc.js"] .diffstat')).toContainText("+121");
  await expectReadingAnchorStable(anchor, top);
});

test("a user scroll during refresh overrides reading-anchor restoration", async ({ page }) => {
  const { anchor } = await centerReadingAnchor(page);
  const root = await fixtureRoot(page);
  await holdAnimationFrames(page);

  const contentRefresh = page.waitForResponse((response) => {
    const url = new URL(response.url());
    return (
      response.request().method() === "GET" &&
      url.pathname.endsWith("/file/content") &&
      url.searchParams.get("path") === "calc.js"
    );
  });
  const calcPath = join(root, "calc.js");
  const original = await readFile(calcPath, "utf8");
  await writeFile(calcPath, `${GENERATED_PREFIX}\n${original}`);
  await contentRefresh;
  await expect(page.locator('.file[data-path="calc.js"] .cm-content')).toContainText("generated0");

  const pane = page.locator(".diff-pane");
  const userScrollTop = await pane.evaluate((element) => {
    element.scrollTop = 0;
    return element.scrollTop;
  });
  await releaseAnimationFrames(page);
  await page.waitForTimeout(100);

  await expect.poll(() => pane.evaluate((element) => element.scrollTop)).toBe(userScrollTop);
  await expect(anchor).not.toBeInViewport();
});

test("scroll intent before coarse refresh measurement cancels restoration", async ({ page }) => {
  const { anchor } = await centerReadingAnchor(page);
  const root = await fixtureRoot(page);
  await holdAnimationFrames(page);

  const contentRefresh = page.waitForResponse((response) => {
    const url = new URL(response.url());
    return (
      response.request().method() === "GET" &&
      url.pathname.endsWith("/file/content") &&
      url.searchParams.get("path") === "calc.js"
    );
  });
  const calcPath = join(root, "calc.js");
  const original = await readFile(calcPath, "utf8");
  await writeFile(calcPath, `${GENERATED_PREFIX}\n${original}`);
  await contentRefresh;
  await expect(page.locator('.file[data-path="calc.js"] .cm-content')).toContainText("generated0");

  const pane = page.locator(".diff-pane");
  const userScrollTop = await pane.evaluate((element) => element.scrollTop);
  await pane.dispatchEvent("wheel", { deltaY: 1 });
  await releaseAnimationFrames(page);
  await page.waitForTimeout(100);

  await expect.poll(() => pane.evaluate((element) => element.scrollTop)).toBe(userScrollTop);
  await expect(anchor).not.toBeInViewport();
});

test("live refresh keeps the reading anchor stable in split view", async ({ page }) => {
  await page.getByRole("button", { name: "Options" }).click();
  await page.getByRole("button", { name: "Split" }).click();
  const { anchor, top } = await centerReadingAnchor(page);
  await addGeneratedLines(page, await fixtureRoot(page), "calc.js");
  await expect(page.locator('.file[data-path="calc.js"] .diffstat')).toContainText("+121");
  await expectReadingAnchorStable(anchor, top);
});

test("split refresh settles a small MergeView alignment drift", async ({ page }) => {
  await page.getByRole("button", { name: "Options" }).click();
  await page.getByRole("button", { name: "Split" }).click();
  const { anchor, top } = await centerReadingAnchor(page);
  const pane = await armSplitScrollDrift(page, 5);

  await addGeneratedLines(page, await fixtureRoot(page), "calc.js");
  await expect(page.locator('.file[data-path="calc.js"] .diffstat')).toContainText("+121");
  await expect(pane).toHaveAttribute("data-test-split-scroll-drift", /\d+/);
  await expectReadingAnchorStable(anchor, top);
});

test("split refresh leaves a small intentional user scroll alone", async ({ page }) => {
  await page.getByRole("button", { name: "Options" }).click();
  await page.getByRole("button", { name: "Split" }).click();
  await centerReadingAnchor(page);
  const pane = await armSplitScrollDrift(page, 5, true);

  await addGeneratedLines(page, await fixtureRoot(page), "calc.js");
  await expect(page.locator('.file[data-path="calc.js"] .diffstat')).toContainText("+121");
  await expectInjectedScrollPreserved(pane);
});

test("split refresh leaves a larger intervening scroll alone", async ({ page }) => {
  await page.getByRole("button", { name: "Options" }).click();
  await page.getByRole("button", { name: "Split" }).click();
  await centerReadingAnchor(page);
  const pane = await armSplitScrollDrift(page, 12);

  await addGeneratedLines(page, await fixtureRoot(page), "calc.js");
  await expect(page.locator('.file[data-path="calc.js"] .diffstat')).toContainText("+121");
  await expectInjectedScrollPreserved(pane);
});

test("live refresh keeps the reading anchor stable when an earlier file changes", async ({ page }) => {
  const { anchor, top } = await centerReadingAnchor(page);
  await addGeneratedLines(page, await fixtureRoot(page), "src/util/math.js");
  await expect(page.locator('.file[data-path="src/util/math.js"] .diffstat')).toContainText("+121");
  await expectReadingAnchorStable(anchor, top, 4);
});

test("live refresh anchors the reading point when an earlier file grows below it", async ({ page }) => {
  const { anchor, top } = await centerReadingAnchor(page);
  await addGeneratedLines(page, await fixtureRoot(page), "src/util/math.js", "after");
  await expect(page.locator('.file[data-path="src/util/math.js"] .diffstat')).toContainText("+122");
  await expectReadingAnchorStable(anchor, top, 4);
});
