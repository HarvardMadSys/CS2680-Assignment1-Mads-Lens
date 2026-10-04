// Replay one fixture in headless Chrome, report console errors, screenshot the result.
//   NODE_PATH=$(npm root -g) node proto/tests/replay-shot.js <fixture.jsonl> <out.png> [waitSeconds] [width]
// Needs the server running (BASE, default http://localhost:8000/) and the global playwright package with its Chromium.
const { chromium } = require('playwright');
const BASE = process.env.BASE || 'http://localhost:8000/';
(async () => {
  const [fixture, out, waitS = '4', width = '1400'] = process.argv.slice(2);
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: parseInt(width), height: 900 } });
  const errors = [];
  page.on('console', m => { if ((m.type() === 'error' || m.type() === 'warning') && !m.text().includes('favicon')) errors.push(`${m.type()}: ${m.text()}`); });
  page.on('pageerror', e => errors.push(`pageerror: ${e.message}`));
  await page.goto(BASE, { waitUntil: 'networkidle' });
  await page.selectOption('#mode', 'replay');
  await page.selectOption('#fixture', fixture);
  const before = await page.evaluate(() => RUNS.length);
  await page.click('#run');
  await page.waitForFunction((n) => RUNS.length > n, before, { timeout: 15000 });
  await page.waitForTimeout(parseFloat(waitS) * 1000);
  const summary = await page.evaluate(() => {
    const r = RUNS[RUNS.length - 1];
    return { status: r.status, items: r.items.length, calls: r.calls.size, error: r.error,
             result: r.result && { cost: r.result.total_cost_usd, turns: r.result.num_turns, subtype: r.result.subtype },
             outline: document.querySelectorAll('.o-step, .o-call').length, subagents: document.querySelectorAll('.subagent').length, sys: r.sys };
  });
  console.log(JSON.stringify(summary, null, 1));
  console.log('console problems:', errors.length ? errors : 'none');
  await page.screenshot({ path: out, fullPage: true });
  console.log('screenshot ->', out);
  await browser.close();
})().catch(e => { console.error('FAILED', e); process.exit(1); });
