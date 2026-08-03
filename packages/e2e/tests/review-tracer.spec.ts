import AxeBuilder from "@axe-core/playwright";
import { test, expect } from "./fixtures.js";

test("opens the inline composer from pointer line selection", async ({ page }) => {
  await page.goto("/");
  const addedLineNumber = page.locator(
    'diffs-container [data-line-type="change-addition"][data-column-number="1"]',
  );
  await addedLineNumber.click();
  await expect(page.getByLabel("Review comment")).toBeVisible();
  await expect(page.getByText("example.ts:1-1", { exact: true }).last()).toBeVisible();
});

test("creates, links, and reloads one exact Review", async ({ page }) => {
  await page.setViewportSize({ width: 800, height: 600 });
  await page.goto("/");

  await expect(page.getByText("Current changes", { exact: true })).toBeVisible();
  await expect(page.getByText("example.ts", { exact: true }).first()).toBeVisible();

  await page.getByRole("button", { name: "Comment by line" }).click();
  await expect(page.getByRole("region", { name: "Choose comment line range" })).toBeVisible();
  await page.getByLabel("Start line").fill("1");
  await page.getByLabel("End line").fill("1");
  await page.getByRole("button", { name: "Place composer" }).click();

  await expect(page.getByText("example.ts:1-1", { exact: true }).last()).toBeVisible();
  await page.getByLabel("Review comment").fill("Keep the exported answer documented.");
  await page.getByRole("button", { name: "Add comment" }).click();

  await expect(page).toHaveURL(/\/reviews\/rvw_[a-f0-9]{32}/);
  await expect(page.getByText("Keep the exported answer documented.")).toBeVisible();
  await expect(page.getByText("Review", { exact: true })).toBeVisible();

  const reviewId = new URL(page.url()).pathname.split("/").at(-1)!;
  const exact = await page.request.get(`/api/reviews/${reviewId}`);
  expect(exact.status()).toBe(200);
  expect(await exact.json()).toMatchObject({
    review: {
      id: reviewId,
      threads: [
        {
          location: { path: "example.ts", side: "new", startLine: 1, endLine: 1 },
          comments: [{ body: "Keep the exported answer documented." }],
        },
      ],
    },
    link: `http://127.0.0.1:7421/reviews/${reviewId}`,
  });

  await page.route(`**/api/reviews/${reviewId}/diff`, (route) =>
    route.fulfill({
      status: 409,
      contentType: "application/json",
      body: JSON.stringify({
        error: "Review code is unavailable; its conversation is still readable",
      }),
    }),
  );
  await page.reload();
  await expect(page.getByRole("heading", { name: "Code unavailable" })).toBeVisible();
  await expect(page.getByText("Keep the exported answer documented.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Comment by line" })).toHaveCount(0);

  const accessibility = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa"])
    .analyze();
  expect(accessibility.violations).toEqual([]);
});
