// Final pass: replay every recording, click everything a reader can click, and report anything
// broken or ugly by a mechanical test: JS errors, horizontal overflow, "undefined"/"NaN" leaking
// into the UI, empty outcomes/status words, and the composer's enable/disable logic.
//   NODE_PATH=$(npm root -g) node proto/tests/verify-all.js      (server at BASE, default http://localhost:8000/)
// Clears finished runs on that server first. Screenshots go to proto/screenshots/verify/ (git-ignored).
const { chromium } = require('playwright');
const BASE = process.env.BASE || 'http://localhost:8000/';
(async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1360, height: 900 } });
  const errors = []; page.on('pageerror', e => errors.push(e.message)); page.on('console', m => { if (m.type() === 'error' && !m.text().includes('favicon')) errors.push(m.text()); });
  await page.goto(BASE, { waitUntil: 'networkidle' }); await page.click('#clear'); await page.waitForTimeout(200);
  const fixtures = (await (await page.request.get(BASE + 'api/fixtures')).json()).fixtures.map(f => f.name);
  const report = [];
  for (const f of fixtures) {
    await page.click('#clear'); await page.waitForTimeout(150);
    await page.evaluate(async (f) => { const spec = { mode: 'replay', fixture: f, prompt: '', delay: 0.003 }; const { run_id } = await (await fetch('/api/run', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(spec) })).json(); const run = new Run(run_id, spec); RUNS.push(run); renderRun(run); attachStream(run); }, f);
    await page.waitForFunction(() => RUNS.at(-1).status !== 'running', null, { timeout: 30000 }); await page.waitForTimeout(400);
    // click everything: subagent heads, every tool row, every details, the timeline, the outline
    for (let i = 0; i < 3; i++) await page.evaluate(() => { for (const h of document.querySelectorAll('.subagent-head')) if (h.textContent.includes('collapsed')) h.click(); });
    await page.evaluate(() => { for (const r of document.querySelectorAll('.trow .row-head')) r.click(); });
    await page.waitForTimeout(150);
    await page.evaluate(() => { for (const d of document.querySelectorAll('details')) d.open = true; });
    await page.waitForTimeout(150);
    const stats = await page.evaluate(() => {
      const run = RUNS.at(-1);
      const uiText = [...document.querySelectorAll('.row-head, .caption, .sum-row, .tl-totals, .step-n, .o-step, .you, .subagent-head, .alive, .fold, .preview .fold')].map(e => e.textContent).join(' | ');
      const leaks = (uiText.match(/\bundefined\b|\bNaN\b|\[object |null\b/g) || []).length;
      const finished = [...run.calls.values()].filter(c => !c.placeholder && c.status !== 'pending');
      const emptyOutcome = finished.filter(c => !callOutcome(c)).map(c => c.name);
      const emptyStatus = [...document.querySelectorAll('.row-head .st')].filter(s => !s.textContent.trim()).length;
      return { status: run.status, calls: run.calls.size, steps: document.querySelectorAll('.step').length, overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth, leaks, emptyOutcome, emptyStatus,
               summaryRows: document.querySelectorAll('.sum-row').length, timelineBars: document.querySelectorAll('.tl-chart .bar').length, openRows: document.querySelectorAll('.trow.open').length, prompt: document.querySelector('.you .prompt')?.textContent.slice(0, 50) };
    });
    // outline jump + timeline bar jump change the scroll position
    const y0 = await page.evaluate(() => window.scrollY);
    await page.evaluate(() => { const s = document.querySelectorAll('.o-step'); if (s.length) s[s.length - 1].click(); });
    await page.waitForTimeout(500);
    const yOutline = await page.evaluate(() => window.scrollY);
    await page.evaluate(() => { const b = document.querySelector('.tl-chart .bar'); if (b) b.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    await page.waitForTimeout(500);
    const yBar = await page.evaluate(() => window.scrollY);
    stats.outlineJumped = yOutline !== y0 || stats.steps <= 1; stats.barJumped = yBar !== yOutline || stats.timelineBars === 0;
    await page.screenshot({ path: `proto/screenshots/verify/${f.replace('.jsonl', '')}.png`, fullPage: true });
    report.push({ f, ...stats });
    console.log(f.padEnd(28), JSON.stringify(stats));
  }
  // composer logic
  await page.click('#clear'); await page.waitForTimeout(150);
  const comp = await page.evaluate(() => ({ stopDisabledIdle: document.querySelector('#stop').disabled, resumeDisabledIdle: document.querySelector('#resume').disabled, followHidden: document.getElementById('follow')?.hidden ?? true }));
  await page.selectOption('#mode', 'live'); const live = await page.evaluate(() => ({ cwdShown: !document.querySelector('#cwd-wrap').hidden, fixtureHidden: document.querySelector('#fixture-wrap').hidden, partialShown: !document.querySelector('#partial-wrap').hidden }));
  await page.selectOption('#mode', 'replay'); const rep = await page.evaluate(() => ({ cwdHidden: document.querySelector('#cwd-wrap').hidden, fixtureShown: !document.querySelector('#fixture-wrap').hidden, promptPrefilled: document.querySelector('#prompt').value.length > 0 }));
  console.log('composer', JSON.stringify({ comp, live, rep }));
  console.log('JS errors:', errors.length ? errors : 'none');
  const bad = report.filter(r => r.status !== 'done' && r.status !== 'failed' || r.overflow > 0 || r.leaks || r.emptyOutcome.length || r.emptyStatus || !r.outlineJumped || !r.barJumped);
  console.log('\nPROBLEMS:', bad.length ? JSON.stringify(bad, null, 1) : 'none');
  await browser.close();
})().catch(e => { console.error('CRASHED', e); process.exit(2); });
