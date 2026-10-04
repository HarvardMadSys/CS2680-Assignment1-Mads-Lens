// Drive THREE LIVE runs (real `claude -p`) through the page: a normal run, a resumed run, and a
// run against a directory that does not exist. Polls the page model while each runs, so the
// output proves events render as they arrive (items grow before status leaves "running").
//   NODE_PATH=$(npm root -g) node proto/tests/live-shot.js <out.png> <cwd>
// <cwd> should be a scratch copy of demo-repo (e.g. cp -R demo-repo /tmp/demo-repo).
// Spends real usage (about $1 for the three runs). Server at BASE, default http://localhost:8000/.
const { chromium } = require('playwright');
const BASE = process.env.BASE || 'http://localhost:8000/';
(async () => {
  const [out, cwdArg] = process.argv.slice(2);
  const cwd = cwdArg;
  if (!out || !cwd) { console.error('usage: node proto/tests/live-shot.js <out.png> <cwd>'); process.exit(2); }
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1400, height: 1000 } });
  const errors = [];
  page.on('pageerror', e => errors.push('pageerror: ' + e.message));
  page.on('console', m => { if (m.type() === 'error' && !m.text().includes('favicon')) errors.push(m.text()); });
  await page.goto(BASE, { waitUntil: 'networkidle' });

  async function runAndWait(prompt, opts = {}) {
    await page.selectOption('#mode', 'live');
    await page.fill('#cwd', opts.cwd || cwd);
    await page.fill('#prompt', prompt);
    const resumeDisabled = await page.$eval('#resume', e => e.disabled);
    if (!resumeDisabled) { if (opts.resume) await page.check('#resume'); else await page.uncheck('#resume'); }
    const before = await page.evaluate(() => RUNS.length);
    const t0 = Date.now(); let firstEventAt = null; const snapshots = [];
    await page.click('#run');
    await page.waitForFunction((n) => RUNS.length > n, before, { timeout: 15000 });
    while (Date.now() - t0 < 170000) {
      const s = await page.evaluate(() => { const r = RUNS[RUNS.length - 1]; return { status: r.status, items: r.items.length, calls: r.calls.size, error: r.error, sid: r.sessionId, cost: r.result && r.result.total_cost_usd, turns: r.result && r.result.num_turns, resumed: !!r.spec.resume }; });
      if (!firstEventAt && (s.items || s.calls || s.error || s.sid)) firstEventAt = Date.now() - t0;
      snapshots.push(`${((Date.now() - t0) / 1000).toFixed(0)}s ${s.status} items=${s.items} calls=${s.calls}`);
      if (s.status !== 'running') return { ...s, resumeWasDisabled: resumeDisabled, firstEventMs: firstEventAt, totalMs: Date.now() - t0, snapshots };
      await page.waitForTimeout(1500);
    }
    return { timeout: true, snapshots };
  }
  const r1 = await runAndWait('List the files under src/ and tell me in one sentence what this package does. Do not modify anything.');
  console.log('RUN 1 live:', JSON.stringify(r1, null, 1));
  const r2 = await runAndWait('Which file did you just say defines the CLI entry point? Answer in one sentence without using any tools.', { resume: true });
  console.log('RUN 2 resume:', JSON.stringify(r2, null, 1));
  console.log('same session as run 1?', r1.sid && r1.sid === r2.sid);
  const r3 = await runAndWait('Say hello.', { cwd: '/nonexistent/dir' });
  console.log('RUN 3 bad cwd:', JSON.stringify(r3, null, 1));
  await page.screenshot({ path: out, fullPage: true });
  console.log('console errors:', errors.length ? errors : 'none');
  await browser.close();
})().catch(e => { console.error('FAILED', e); process.exit(1); });
