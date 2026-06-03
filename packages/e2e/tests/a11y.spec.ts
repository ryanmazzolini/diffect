import { test, expect } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";

/**
 * Automated accessibility scan of the loaded diff in both themes. We gate on
 * serious/critical violations (color-contrast, ARIA, focus) — the cheapest way
 * to catch a11y regressions continuously.
 */
for (const theme of ["dark", "light"] as const) {
  test(`no serious/critical a11y violations (${theme} theme)`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: theme });
    await page.goto("/");
    await expect(page.locator(".file-header").first()).toBeVisible();

    const builder = () => new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa"]);
    // Contrast IS enforced on the app shell (topbar/sidebar/modals/filters)…
    const shell = await builder().exclude(".diff").analyze();
    // …but not inside the diff body, where GitHub-Primer syntax colors on tinted
    // add/del backgrounds can't all meet AA without abandoning the palette. Every
    // other serious/critical rule (ARIA, names, roles, focus) stays gated there.
    const diff = await builder().include(".diff").disableRules(["color-contrast"]).analyze();
    const blocking = [...shell.violations, ...diff.violations].filter(
      (v) => v.impact === "serious" || v.impact === "critical",
    );
    expect(
      blocking,
      blocking.map((v) => `${v.id}: ${v.help}`).join("\n"),
    ).toEqual([]);
  });
}

test("no serious/critical a11y violations in split view", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Split" }).click();
  await expect(page.locator("table.hunk-split").first()).toBeVisible();

  const builder = () => new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa"]);
  const shell = await builder().exclude(".diff").analyze();
  const diff = await builder().include(".diff").disableRules(["color-contrast"]).analyze();
  const blocking = [...shell.violations, ...diff.violations].filter(
    (v) => v.impact === "serious" || v.impact === "critical",
  );
  expect(blocking, blocking.map((v) => `${v.id}: ${v.help}`).join("\n")).toEqual([]);
});
