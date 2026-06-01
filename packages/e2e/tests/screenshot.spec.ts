import { test } from "@playwright/test";

/** Capture the main review surface for a visual/design pass (not an assertion). */
test("capture review UI screenshot", async ({ page }) => {
  await page.goto("/");
  await page.waitForSelector(".file-path");

  // Leave a comment so the screenshot shows the full conversation surface.
  const line = page.locator("tr.line-add", { hasText: "TODO" }).first();
  await line.hover();
  await line.locator("button.comment-btn").click();
  await page
    .locator(".comment-form textarea")
    .fill("N+1 risk here — batch this lookup.");
  await page.locator(".comment-form select").selectOption("must-fix");
  await page.locator(".comment-form").getByRole("button", { name: "Comment" }).click();
  await page.waitForSelector(".inline-thread");

  await page.screenshot({ path: "screenshots/review.png", fullPage: true });
});
