// diffect UI interaction benchmark — paste into DevTools console on the running app.
//
// Measures the lag you actually feel for each diff control. Two kinds:
//   • toggles      → click→next-paint (synchronous re-render/relayout)
//   • repo switch  → click→DOM-settle (async: network + full-diff remount)
//
// Run on the WORST case: the diffect repo, nothing marked viewed (all files
// expanded). Re-run after each fix and compare the p50 column.
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
  const reportDom = (where) =>
    console.log(
      `%c[${where}] ${domNodes()} nodes under .diff · ${diffBodies()} expanded diff bodies`,
      "font-weight:bold;color:#6a76e0",
    );

  // click→next-paint, for synchronous toggles
  async function bench(label, find, runs = 6) {
    const t = [];
    for (let i = 0; i < runs; i++) {
      const el = find();
      if (!el) return console.warn(`${label}: control not found, skipped`);
      const t0 = performance.now();
      el.click();
      await nextPaint();
      t.push(performance.now() - t0);
      await sleep(150);
    }
    t.shift(); // warm-up
    console.log(
      `${label.padEnd(20)} p50=${med(t).toFixed(0).padStart(4)}ms  ` +
        `min=${Math.min(...t).toFixed(0)}  max=${Math.max(...t).toFixed(0)}  ` +
        `[${t.map((x) => x.toFixed(0)).join(", ")}]`,
    );
  }

  // click→DOM-settle, for async repo/workspace switches (waits for the new diff
  // to finish mounting: timer resets on each mutation, fires after `quiet` ms of
  // calm, which is then subtracted back out).
  const settle = (rootSel, quiet = 250, timeout = 8000) =>
    new Promise((resolve) => {
      const root = document.querySelector(rootSel);
      if (!root) return resolve(0);
      const start = performance.now();
      let timer;
      const finish = (v) => { obs.disconnect(); clearTimeout(hard); resolve(v); };
      const obs = new MutationObserver(() => {
        clearTimeout(timer);
        timer = setTimeout(() => finish(performance.now() - start - quiet), quiet);
      });
      obs.observe(root, { childList: true, subtree: true });
      timer = setTimeout(() => finish(0), quiet); // no mutations → ~0
      const hard = setTimeout(() => finish(performance.now() - start), timeout);
    });

  async function benchSwitch(label, find, runs = 5) {
    const t = [];
    for (let i = 0; i < runs; i++) {
      const el = find();
      if (!el) return console.warn(`${label}: no inactive repo to switch to, skipped`);
      el.click();
      t.push(await settle(".diff-pane"));
      await sleep(400);
    }
    t.shift();
    console.log(
      `${label.padEnd(20)} p50=${med(t).toFixed(0).padStart(4)}ms  ` +
        `min=${Math.min(...t).toFixed(0)}  max=${Math.max(...t).toFixed(0)}  ` +
        `[${t.map((x) => x.toFixed(0)).join(", ")}]`,
    );
  }

  reportDom("baseline");
  console.log("%c-- toggles (click→paint) --", "color:#888");
  await bench("Unified->Split", () => segBtn("Diff view mode", "Split"));
  await bench("Split->Unified", () => segBtn("Diff view mode", "Unified"));
  await bench("No-wrap->Wrap", () => $(".wrap-toggle"));
  await bench("Wrap->No-wrap", () => $(".wrap-toggle"));
  await bench("Tight->Compact", () => segBtn("Density", "Compact"));
  await bench("Compact->Tight", () => segBtn("Density", "Tight"));
  await bench("Theme A", () => $(".theme-toggle"));
  await bench("Theme B", () => $(".theme-toggle"));

  console.log("%c-- repo switch (click→settle) --", "color:#888");
  if (document.querySelectorAll(".repo-item").length < 2) {
    console.warn("repo switch: need >=2 repos in the sidebar to measure; skipped");
  } else {
    await benchSwitch("Repo switch", () => $(".repo-item:not(.active)"));
  }

  reportDom("end");
  console.log("%cdone — note the p50 column", "font-weight:bold");
})();
