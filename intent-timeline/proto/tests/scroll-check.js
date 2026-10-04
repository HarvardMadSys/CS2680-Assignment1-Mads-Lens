// Prove the page does NOT yank the reader down while a replay streams in:
// start a long replay, scroll to the top, sample scrollY for a few seconds, then use the
// "latest" button to jump back. usage: NODE_PATH=$(npm root -g) node proto/tests/scroll-check.js
// (server at BASE, default http://localhost:8000/)
const { chromium } = require('playwright');
const BASE = process.env.BASE || 'http://localhost:8000/';
(async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1200, height: 700 } });
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  await page.goto(BASE, { waitUntil: 'networkidle' });
  await page.selectOption('#mode', 'replay'); await page.selectOption('#fixture', '07-resume-b.jsonl');
  const before = await page.evaluate(() => RUNS.length); await page.click('#run');
  await page.waitForFunction(n => RUNS.length > n, before);
  await page.waitForTimeout(3000);                                   // let the page outgrow the viewport
  const grew = await page.evaluate(() => document.documentElement.scrollHeight > window.innerHeight);
  await page.mouse.move(600, 400); await page.mouse.wheel(0, -100000); await page.waitForTimeout(300);
  const ys = [];
  for (let i = 0; i < 8; i++) { await page.waitForTimeout(400); ys.push(await page.evaluate(() => window.scrollY)); }
  const btn = await page.evaluate(() => { const b = document.getElementById('follow'); return b && !b.hidden ? b.textContent : null; });
  if (btn) await page.click('#follow');
  await page.waitForTimeout(400);
  const after = await page.evaluate(() => ({ y: window.scrollY, atBottom: window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 8, following: FOLLOW }));
  await page.waitForTimeout(1500);
  const still = await page.evaluate(() => ({ atBottom: window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 8 }));
  console.log(JSON.stringify({ pageOutgrewViewport: grew, scrollYWhileReadingTop: ys, followButtonText: btn, afterClick: after, stillAtBottomLater: still, errors }, null, 1));
  await browser.close();
})().catch(e => { console.error('FAILED', e); process.exit(1); });
