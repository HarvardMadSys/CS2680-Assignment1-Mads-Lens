// Live-stream stress test: real `claude -p` runs while a scripted reader interacts with the
// page the way a person does. Every second we check that nothing the reader opened has been
// closed by an incoming event. Spends real usage (4 live runs).
//   NODE_PATH=$(npm root -g) node proto/tests/live-stress.js <cwd>
// <cwd> should be a scratch copy of demo-repo (run A edits it). Server at BASE, default http://localhost:8000/.
const { chromium } = require('playwright');
const CWD = process.argv[2];
if (!CWD) { console.error('usage: node proto/tests/live-stress.js <cwd>'); process.exit(2); }
const BASE = process.env.BASE || 'http://localhost:8000/';
const findings = [];
const note = (ok, what, detail) => { findings.push({ ok, what, detail }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${what}${detail ? '  — ' + JSON.stringify(detail) : ''}`); };

async function startLive(page, prompt, opts = {}) {
  await page.selectOption('#mode', 'live'); await page.fill('#cwd', opts.cwd || CWD); await page.fill('#prompt', prompt);
  const resumeDisabled = await page.$eval('#resume', e => e.disabled);
  if (!resumeDisabled) { if (opts.resume) await page.check('#resume'); else await page.uncheck('#resume'); }
  await page.uncheck('#partial'); if (opts.partial) await page.check('#partial');
  const before = await page.evaluate(() => RUNS.length); await page.click('#run');
  await page.waitForFunction(n => RUNS.length > n, before, { timeout: 15000 });
  return page.evaluate(() => RUNS[RUNS.length - 1].id);
}
const state = (page) => page.evaluate(() => { const r = RUNS[RUNS.length - 1]; return { status: r.status, calls: r.calls.size, steps: document.querySelectorAll(`#run-${r.id} .step`).length, sysOpen: !!document.querySelector(`#run-${r.id} details.sysline[open]`), openRows: document.querySelectorAll(`#run-${r.id} .trow.open`).length, drafts: document.querySelectorAll(`#run-${r.id} .draft`).length, elapsed: document.querySelector(`#run-${r.id} .elapsed`)?.textContent, scrollY: window.scrollY, runDisabled: document.querySelector('#run').disabled, stopDisabled: document.querySelector('#stop').disabled }; });
async function waitDone(page, ms = 180000) { const t0 = Date.now(); while (Date.now() - t0 < ms) { const s = await state(page); if (s.status !== 'running') return s; await page.waitForTimeout(1000); } return { timeout: true }; }

(async () => {
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({ viewport: { width: 1360, height: 900 } });
  const page = await ctx.newPage();
  const errors = []; page.on('pageerror', e => errors.push(e.message)); page.on('console', m => { if (m.type() === 'error' && !m.text().includes('favicon')) errors.push(m.text()); });
  await page.goto(BASE, { waitUntil: 'networkidle' }); await page.click('#clear'); await page.waitForTimeout(300);

  // ---- A. debug run; reader opens "system events" and the first tool row while it streams
  await startLive(page, 'Run the tests, find the bug that makes test_parse fail, and fix it with the smallest possible change.');
  await page.waitForTimeout(2500);
  await page.evaluate(() => { const d = document.querySelector('.run:last-of-type details.sysline'); if (d) d.open = true; });
  let rowOpenedAt = null, sysClosed = 0, rowClosed = 0, samples = [], stepsSeen = [], wheeledAt = null;
  for (let i = 0; i < 240; i++) {
    await page.waitForTimeout(1000);
    const s = await state(page); samples.push(s); stepsSeen.push(s.steps);
    if (wheeledAt === null && s.scrollY > 0 && i >= 8) { await page.mouse.move(600, 400); await page.mouse.wheel(0, -150); wheeledAt = i; }   // the reader scrolls up once
    if (!s.sysOpen) sysClosed++;
    if (rowOpenedAt === null && s.calls >= 1) { await page.evaluate(() => { const r = document.querySelector('.run:last-of-type .trow .row-head'); if (r) r.click(); }); rowOpenedAt = i; }
    else if (rowOpenedAt !== null && s.openRows < 1) rowClosed++;
    if (s.status !== 'running') break;
  }
  const A = samples[samples.length - 1];
  note(A.status === 'done', 'A: debug run finished', { status: A.status, calls: A.calls, steps: A.steps, seconds: samples.length });
  note(sysClosed === 0, 'A: "system events" stayed open through every incoming event', { samplesClosed: sysClosed, samples: samples.length });
  note(rowClosed === 0, 'A: expanded tool row stayed open through every incoming event', { samplesClosed: rowClosed });
  note(new Set(stepsSeen).size > 2, 'A: steps appeared progressively (not all at the end)', { stepsOverTime: stepsSeen.join(',') });
  const followed = wheeledAt !== null;
  const afterWheel = wheeledAt !== null ? samples.slice(wheeledAt + 1).map(s => s.scrollY) : [];
  note(followed, 'A: page followed the run the reader just started', { scrollYBeforeWheel: samples.slice(0, (wheeledAt ?? 10) + 1).map(s => s.scrollY) });
  note(afterWheel.length > 0 && afterWheel.every(y => y === afterWheel[0]), 'A: after one wheel-up the page never moved the reader again', { scrollYAfterWheel: [...new Set(afterWheel)] });
  note(samples.some(s => /elapsed/.test(s.elapsed || '')), 'A: elapsed ticker visible while running', { sample: samples[2]?.elapsed });

  // ---- B. resume; meanwhile a second tab reloads mid-run and must show the same run live
  await startLive(page, 'What exactly did you change, and why did the test fail before the fix? Two sentences, no tools.', { resume: true });
  const page2 = await ctx.newPage(); await page2.goto(BASE, { waitUntil: 'networkidle' }); await page2.waitForTimeout(800);
  const restored = await page2.evaluate(() => RUNS.map(r => r.status));
  const B = await waitDone(page);
  await page2.waitForTimeout(1500);
  const restoredAfter = await page2.evaluate(() => RUNS.map(r => r.status));
  const sameSession = await page.evaluate(() => RUNS.length >= 2 && RUNS[RUNS.length - 1].sessionId === RUNS[RUNS.length - 2].sessionId);
  note(B.status === 'done', 'B: resumed run finished', { status: B.status, calls: B.calls });
  note(sameSession, 'B: resumed run kept the session id');
  note(restored.length >= 2, 'B: a page opened mid-run restored the earlier runs', { statusesAtOpen: restored });
  note(restoredAfter[restoredAfter.length - 1] === 'done', 'B: the mid-run page followed the live run to its end', { statusesLater: restoredAfter });
  await page2.close();

  // ---- C. partial tokens: drafts must appear while streaming and vanish at the end
  await startLive(page, 'Read src/logparse/parser.py and explain in three sentences what parse_lines does. Do not modify anything.', { partial: true });
  let draftsSeen = 0; for (let i = 0; i < 60; i++) { await page.waitForTimeout(700); const s = await state(page); if (s.drafts) draftsSeen++; if (s.status !== 'running') break; }
  const C = await state(page);
  note(C.status === 'done', 'C: partial-token run finished', { status: C.status });
  note(draftsSeen > 0, 'C: streaming drafts were visible during the run', { samplesWithDrafts: draftsSeen });
  note(C.drafts === 0, 'C: no draft left behind after the run', { drafts: C.drafts });

  // ---- D. stop button
  await startLive(page, 'Read every file under src/ and tests/ one at a time, then read README.md and sample.log, then summarize the project in three sentences.');
  await page.waitForTimeout(6000);
  const stopDisabledBefore = await page.$eval('#stop', e => e.disabled);
  await page.click('#stop'); await page.waitForTimeout(2500);
  const D = await state(page);
  note(!stopDisabledBefore, 'D: Stop was enabled while running');
  note(D.status === 'stopped', 'D: run marked stopped after Stop', { status: D.status });
  note(!D.runDisabled, 'D: Run re-enabled after Stop');

  // ---- E. fast replay: 108 events at 5 ms each — does rendering keep up without errors?
  const t0 = Date.now();
  await page.evaluate(async () => { const spec = { mode: 'replay', fixture: '07-resume-b.jsonl', prompt: 'fast replay', delay: 0.005 }; const { run_id } = await (await fetch('/api/run', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(spec) })).json(); const run = new Run(run_id, spec); RUNS.push(run); renderRun(run); attachStream(run); });
  const E = await waitDone(page, 30000);
  note(E.status === 'done' && E.calls === 18, 'E: 108-event replay at 5 ms/event rendered completely', { status: E.status, calls: E.calls, ms: Date.now() - t0 });

  note(errors.length === 0, 'no JavaScript errors in the whole session', errors);
  console.log('\nSUMMARY', findings.filter(f => f.ok).length, 'pass /', findings.filter(f => !f.ok).length, 'fail');
  await browser.close();
  process.exit(findings.some(f => !f.ok) ? 1 : 0);
})().catch(e => { console.error('CRASHED', e); process.exit(2); });
