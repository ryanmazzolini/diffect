const { chromium, devices } = require('/opt/node22/lib/node_modules/playwright');
const path = require('path');

const shots = [
  { file: 'mockup-1-quiet-precision.html', name: 'm1', screens: ['inbox', 'review', 'peek', 'palette'] },
  { file: 'mockup-2-studio.html',          name: 'm2', screens: ['home', 'files', 'guide', 'sheet'] },
  { file: 'mockup-3-paper.html',           name: 'm3', screens: ['home', 'review', 'files'] },
  { file: 'index.html',                    name: 'index', screens: [null] },
];

(async () => {
  const browser = await chromium.launch();
  for (const vp of [
    { label: 'desktop', viewport: { width: 1440, height: 900 } },
    { label: 'mobile',  viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true,
      deviceScaleFactor: 2 },
  ]) {
    const ctx = await browser.newContext(vp);
    const page = await ctx.newPage();
    for (const m of shots) {
      await page.goto('file://' + path.resolve(__dirname, m.file));
      for (const s of m.screens) {
        if (s) {
          await page.evaluate(sc => {
            document.body.dataset.screen = sc;
            document.querySelectorAll('.switcher button').forEach(b => b.classList.toggle('on', b.dataset.s === sc));
          }, s);
        }
        await page.waitForTimeout(120);
        const out = path.resolve(__dirname, 'shots', `${m.name}-${s || 'page'}-${vp.label}.png`);
        await page.screenshot({ path: out });
        console.log('saved', out);
      }
    }
    await ctx.close();
  }
  await browser.close();
})().catch(e => { console.error(e); process.exit(1); });
