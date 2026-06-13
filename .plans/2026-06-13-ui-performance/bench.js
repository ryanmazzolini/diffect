// diffect UI interaction benchmark — paste into DevTools console on the running app.
//
// Measures click→next-paint latency (the lag you actually feel) for each diff
// control, over 5 timed runs (first run dropped as warm-up). Also prints the live
// DOM size so you can see what each toggle is reconciling.
//
// Run it on the WORST case: the diffect repo, nothing marked viewed (so all files
// are expanded). Re-run after each fix and compare p50.
(async () => {
  const nextPaint = () =>
    new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const med = (a) => [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)];
  const $ = (sel) => document.querySelector(sel);
  const segBtn = (group, txt) =>
    [...document.querySelectorAll(`.seg[aria-label="${group}"] button`)].find(
      (b) => b.textContent.trim() === txt,
    );

  const domNodes = () => document.querySelectorAll(".diff *").length;
  const diffBodies = () => document.querySelectorAll(".diff-tailwindcss-wrapper").length;

  async function bench(label, click, runs = 6) {
    const t = [];
    for (let i = 0; i < runs; i++) {
      const el = click();
      if (!el) {
        console.warn(`${label}: control not found, skipped`);
        return;
      }
      const t0 = performance.now();
      el.click();
      await nextPaint();
      t.push(performance.now() - t0);
      await sleep(150);
    }
    t.shift(); // warm-up
    console.log(
      `${label.padEnd(22)} p50=${med(t).toFixed(0).padStart(4)}ms  ` +
        `min=${Math.min(...t).toFixed(0)}  max=${Math.max(...t).toFixed(0)}  ` +
        `[${t.map((x) => x.toFixed(0)).join(", ")}]`,
    );
  }

  console.log(
    `%cbaseline DOM: ${domNodes()} nodes under .diff · ${diffBodies()} expanded diff bodies`,
    "font-weight:bold",
  );
  console.log("interaction           p50      spread");

  await bench("Unified→Split", () => segBtn("Diff view mode", "Split"));
  await bench("Split→Unified", () => segBtn("Diff view mode", "Unified"));
  await bench("No-wrap→Wrap", () => $(".wrap-toggle"));
  await bench("Wrap→No-wrap", () => $(".wrap-toggle"));
  await bench("Tight→Compact", () => segBtn("Density", "Compact"));
  await bench("Compact→Tight", () => segBtn("Density", "Tight"));
  await bench("Theme toggle A", () => $(".theme-toggle"));
  await bench("Theme toggle B", () => $(".theme-toggle"));

  console.log("%cdone — note the p50 column", "font-weight:bold");
})();
