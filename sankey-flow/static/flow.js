/* ==========================================================================
   CCFlow — the trajectory Flow view: a pure data model + a hand-rolled SVG
   agent-path (Sankey-style) renderer. Zero dependencies.

   window.CCFlow = {
     compute(tree, now)          // enriched trajectory tree -> flow dataset (Runs → Actors → Actions → Outcomes)
     create(container, opts)     // -> { update, setMeasure, resize, select, focus, clearFocus, destroy, el, ... }
     applyTheme(root, isDark)    // swap the light/dark --flow-* set on an instance's root
   }

   compute() builds the four-column dataset from the app's trajectory tree;
   create() draws it as a dependency-free SVG (thumbnail and full diagram).
   ========================================================================== */
(function () {
  'use strict';

  // ------------------------------------------------------------------ model constants
  const MAX_RUNS = 12, MAX_SUBAGENTS = 8, MAX_TOOLS = 8;
  const AGENT_TOOLS = new Set(['Agent', 'Task']);
  const FILE_TOOLS = new Set(['Read', 'Write', 'Edit', 'MultiEdit', 'Glob', 'Grep', 'NotebookEdit', 'LS']);
  const WEB_TOOLS = new Set(['WebSearch', 'WebFetch']);
  const toolCategory = (n) => n === 'Bash' ? 'tool-shell'
    : FILE_TOOLS.has(n) ? 'tool-file'
      : WEB_TOOLS.has(n) ? 'tool-web'
        : AGENT_TOOLS.has(n) ? 'subagent' : 'tool-other';
  const outcomeOf = (s) => (s === 'failed' || s === 'stopped') ? s : (s === 'pending' || s === 'running') ? 'pending' : 'completed';
  const OUTCOMES = { completed: ['Completed', 'outcome-ok'], failed: ['Failed', 'outcome-fail'], stopped: ['Stopped', 'outcome-stop'], pending: ['In progress', 'outcome-pending'] };

  /** Collapse whitespace and cut to n chars with an ellipsis (matches the app's truncate). */
  function truncate(text, n) { const s = String(text == null ? '' : text).replace(/\s+/g, ' ').trim(); return s.length <= n ? s : s.slice(0, Math.max(1, n - 1)) + '…'; }

  // ------------------------------------------------------------------ compute()
  function compute(tree, now) {
    if (now == null) now = Date.now();
    const actions = [];                                  // {run, actor, name, category, outcome, ms}
    const actors = new Map([['actor:main', { id: 'actor:main', label: 'Claude', category: 'agent', parent: null, depth: 0, run: null, latencyMs: null }]]);
    const runs = [];
    const llmExtra = { thinking_blocks: 0, text_blocks: 0 };

    // latest wall-clock mark in this lane at or before ts (the "previous event" of an LLM turn)
    const prevEvent = (events, ts) => events.reduce((p, e) => (e != null && (ts == null || e <= ts) && (p == null || e > p)) ? e : p, null);

    function collectLane(run, steps, actorId, laneStart, depth) {
      const events = [laneStart];                         // step.ts and tool endTs seen so far in this lane
      const turns = new Map();                            // msgId -> {prevTs, lastTs, status}
      let anon = 0, prevStep = null;
      for (const step of (steps || [])) {
        const kind = step.kind, ts = step.ts;
        if (kind === 'text' || kind === 'thinking' || kind === 'tool' || kind === 'agent') {
          // -- group blocks into LLM turns by message id
          let key = step.msgId;
          if (!key) { if (prevStep && prevStep.endTs != null && ts != null && prevStep.endTs <= ts) anon++; key = 'anon-' + anon; }
          let turn = turns.get(key);
          if (!turn) turns.set(key, turn = { prevTs: prevEvent(events, ts), lastTs: ts, status: 'completed' });
          else if (ts != null && (turn.lastTs == null || ts > turn.lastTs)) turn.lastTs = ts;
          if (kind === 'thinking') { llmExtra.thinking_blocks++; if (step.status === 'pending' || step.status === 'failed' || step.status === 'stopped') turn.status = step.status; }
          else if (kind === 'text') llmExtra.text_blocks++;
          events.push(ts);
          // -- tool / agent actions
          if (kind === 'tool' || kind === 'agent') {
            const name = (kind === 'agent' || step.name === 'Task') ? 'Agent' : (step.name || 'tool');
            const ms = Math.max(0, step.ms != null ? step.ms : ((step.endTs != null ? step.endTs : now) - (ts != null ? ts : now)));
            actions.push({ run: run.runId, actor: actorId, name, category: toolCategory(name), outcome: outcomeOf(step.status), ms });
            if (step.endTs != null) events.push(step.endTs);
            if (kind === 'agent') {
              const aid = 'actor:' + (step.toolUseId || step.id);
              actors.set(aid, {
                id: aid,
                label: `${step.agentType || 'general-purpose'}: ${truncate(step.description || '', 40)}`.replace(/:\s*$/, ''),
                category: 'subagent', parent: actorId, depth: depth + 1, run: run.runId, latencyMs: ms,
                extra: { agentType: step.agentType, description: step.description, toolUseId: step.toolUseId, status: step.status },
              });
              const subStart = (step.children || []).find((c) => c.kind === 'system' && c.label === 'Subagent prompt' && c.ts != null);
              collectLane(run, step.children, aid, subStart ? subStart.ts : ts, depth + 1);   // nested subagents recurse the same way
            }
          }
          prevStep = step;
        } else if (kind === 'system' && ts != null) events.push(ts);   // prompts / harness lines are marks, not actions
      }
      for (const t of turns.values()) {                    // one LLM-turn action per message
        const last = t.status === 'pending' ? now : t.lastTs;
        const ms = (last != null && t.prevTs != null) ? Math.max(0, last - t.prevTs) : 0;
        actions.push({ run: run.runId, actor: actorId, name: 'LLM turn', category: 'llm', outcome: outcomeOf(t.status), ms });
      }
    }

    for (const run of (tree.children || [])) {             // run nodes are the tree's run nodes
      const ms = run.ms != null ? run.ms : (run.startTs != null ? ((run.status === 'running' ? now : (run.endTs != null ? run.endTs : now)) - run.startTs) : 0);
      runs.push({ runId: run.runId, label: run.label, status: run.status, ms: Math.max(0, ms) });
      collectLane(run, run.children, 'actor:main', run.startTs, 0);
    }

    // ---- aggregate (sum = {calls, ms} per key)
    const agg = (keyFn) => {
      const m = new Map();
      for (const a of actions) { const k = keyFn(a); if (k == null) continue; const c = m.get(k) || { calls: 0, ms: 0 }; c.calls++; c.ms += a.ms; m.set(k, c); }
      return m;
    };
    const byRun = agg((a) => a.run), byActor = agg((a) => a.actor),
      byTool = agg((a) => a.category === 'llm' ? null : a.name), byOutcome = agg((a) => a.outcome);

    // column 0: runs (oldest collapse beyond MAX_RUNS)
    const runNodeOf = {}, runNodes = [];
    let visible = runs;
    if (runs.length > MAX_RUNS) {
      const older = runs.slice(0, runs.length - MAX_RUNS + 1); visible = runs.slice(older.length);
      const n = { id: 'run:earlier', column: 0, label: `Earlier runs (${older.length})`, category: 'run', calls: 0, ms: 0, status: 'completed', extra: { runs: older.map((r) => r.runId) } };
      for (const r of older) { n.calls += (byRun.get(r.runId) || {}).calls || 0; n.ms += r.ms; runNodeOf[r.runId] = n.id; }
      runNodes.push(n);
    }
    for (const r of visible) { const id = 'run:' + r.runId; runNodeOf[r.runId] = id;
      runNodes.push({ id, column: 0, label: r.label, category: 'run', calls: (byRun.get(r.runId) || {}).calls || 0, ms: r.ms, status: r.status }); }

    // column 1: actors (Claude, then subagents in spawn order; collapse beyond MAX_SUBAGENTS)
    const actorNodeOf = { 'actor:main': 'actor:main' };
    const actorNodes = [{ id: 'actor:main', column: 1, label: 'Claude', category: 'agent', calls: (byActor.get('actor:main') || {}).calls || 0, ms: (byActor.get('actor:main') || {}).ms || 0, depth: 0, parent: null }];
    const subs = [...actors.values()].filter((a) => a.id !== 'actor:main');
    const kept = subs.length > MAX_SUBAGENTS ? subs.slice(0, MAX_SUBAGENTS - 1) : subs, rest = subs.slice(kept.length);
    for (const a of kept) { actorNodeOf[a.id] = a.id;
      actorNodes.push({ id: a.id, column: 1, label: a.label, category: 'subagent', calls: (byActor.get(a.id) || {}).calls || 0, ms: a.latencyMs || 0,
        depth: a.depth, parent: a.parent, extra: Object.assign({}, a.extra, { actions_ms: (byActor.get(a.id) || {}).ms || 0 }) }); }
    if (rest.length) {
      const n = { id: 'actor:other-subagents', column: 1, label: `Other subagents (${rest.length})`, category: 'subagent', calls: 0, ms: 0, depth: 1, parent: 'actor:main', extra: { members: [] } };
      for (const a of rest) { n.calls += (byActor.get(a.id) || {}).calls || 0; n.ms += a.latencyMs || 0; n.extra.members.push({ id: a.id, label: a.label }); actorNodeOf[a.id] = n.id; }
      actorNodes.push(n);
    }

    // column 2: actions (LLM turn, then tools by calls desc; collapse beyond MAX_TOOLS)
    const actionNodeOf = { 'LLM turn': 'action:llm' };
    const llm = actions.filter((a) => a.category === 'llm');
    const actionNodes = [{ id: 'action:llm', column: 2, label: 'LLM turn', category: 'llm', calls: llm.length, ms: llm.reduce((s, a) => s + a.ms, 0), extra: Object.assign({}, llmExtra) }];
    const ranked = [...byTool.entries()].sort((x, y) => y[1].calls - x[1].calls || y[1].ms - x[1].ms || x[0].localeCompare(y[0]));
    const top = ranked.length > MAX_TOOLS ? ranked.slice(0, MAX_TOOLS - 1) : ranked, other = ranked.slice(top.length);
    for (const [name, v] of top) { const id = 'action:tool:' + name; actionNodeOf[name] = id; actionNodes.push({ id, column: 2, label: name, category: toolCategory(name), calls: v.calls, ms: v.ms }); }
    if (other.length) {
      const n = { id: 'action:tool:other', column: 2, label: `Other tools (${other.length})`, category: 'tool-other', calls: 0, ms: 0, extra: { members: [] } };
      for (const [name, v] of other) { n.calls += v.calls; n.ms += v.ms; n.extra.members.push({ name, calls: v.calls, ms: v.ms }); actionNodeOf[name] = n.id; }
      actionNodes.push(n);
    }

    // column 3: outcomes that occur
    const outcomeNodes = ['completed', 'failed', 'stopped', 'pending'].filter((o) => byOutcome.has(o))
      .map((o) => ({ id: 'outcome:' + o, column: 3, label: OUTCOMES[o][0], category: OUTCOMES[o][1], calls: byOutcome.get(o).calls, ms: byOutcome.get(o).ms }));

    // links (adjacent columns only)
    const links = new Map();
    const addLink = (s, t, calls, ms) => { const k = s + '→' + t; const l = links.get(k) || { source: s, target: t, calls: 0, ms: 0 }; l.calls += calls; l.ms += ms; links.set(k, l); };
    for (const a of actions) {
      addLink(runNodeOf[a.run], actorNodeOf[a.actor], 1, a.actor === 'actor:main' ? a.ms : 0);   // Run→subagent ms is the Agent latency, added below
      addLink(actorNodeOf[a.actor], actionNodeOf[a.name], 1, a.ms);
      addLink(actionNodeOf[a.name], 'outcome:' + a.outcome, 1, a.ms);
    }
    for (const a of subs) { const l = links.get(runNodeOf[a.run] + '→' + actorNodeOf[a.id]); if (l) l.ms += a.latencyMs || 0; }

    const nodes = [...runNodes, ...actorNodes, ...actionNodes, ...outcomeNodes];
    const order = new Map(nodes.map((n, i) => [n.id, i]));
    const linkList = [...links.values()].sort((x, y) => order.get(x.source) - order.get(y.source) || order.get(x.target) - order.get(y.target));
    const totals = {
      calls: actions.length, ms: runs.reduce((s, r) => s + r.ms, 0), turns: llm.length,
      tools: actions.length - llm.length, subagents: subs.length,
      failures: actions.filter((a) => a.outcome === 'failed').length + runs.filter((r) => r.status === 'failed').length, runs: runs.length,
    };
    const top_tools = ranked.slice(0, MAX_TOOLS).map(([name, v]) => ({ name, calls: v.calls, ms: v.ms }));
    return {
      columns: [{ id: 'runs', title: 'Runs' }, { id: 'actors', title: 'Actors' }, { id: 'actions', title: 'Actions' }, { id: 'outcomes', title: 'Outcomes' }],
      nodes, links: linkList, totals, top_tools,
    };
  }

  // ------------------------------------------------------------------ renderer constants / helpers
  const NS = 'http://www.w3.org/2000/svg';
  const CAT_ORDER = ['run', 'agent', 'subagent', 'llm', 'tool-file', 'tool-shell', 'tool-web', 'tool-other',
    'outcome-ok', 'outcome-fail', 'outcome-stop', 'outcome-pending'];
  const CAT_VAR = { run: '--flow-run', agent: '--flow-agent', subagent: '--flow-subagent', llm: '--flow-llm',
    'tool-shell': '--flow-tool-shell', 'tool-file': '--flow-tool-file', 'tool-web': '--flow-tool-web', 'tool-other': '--flow-tool-other',
    'outcome-ok': '--flow-ok', 'outcome-fail': '--flow-fail', 'outcome-stop': '--flow-stop', 'outcome-pending': '--flow-pending' };
  const CAT_LABEL = { run: 'Run', agent: 'Claude', subagent: 'Subagent', llm: 'LLM turn', 'tool-shell': 'Shell tool', 'tool-file': 'File tool',
    'tool-web': 'Web tool', 'tool-other': 'Other tool', 'outcome-ok': 'Completed', 'outcome-fail': 'Failed', 'outcome-stop': 'Stopped', 'outcome-pending': 'In progress' };
  const STATUS_VAR = { completed: '--flow-ok', failed: '--flow-fail', stopped: '--flow-stop', running: '--flow-pending', pending: '--flow-pending' };
  const PRESETS = {
    full:  { padX: 12, padTop: 36, padBottom: 12, nodeW: 158, minH: 38, gap: 12, minLink: 1.5, rx: 8 },
    thumb: { padX: 2,  padTop: 2,  padBottom: 2,  nodeW: 10,  minH: 3,  gap: 3,  minLink: 1,   rx: 2 },
  };
  const LABEL_FONT_FALLBACK = '600 12.5px system-ui, -apple-system, "Segoe UI", sans-serif';
  const colorOf = (cat) => 'var(' + (CAT_VAR[cat] || '--flow-tool-other') + ')';
  const fmtMs = (ms) => { ms = Math.max(0, Math.round(ms || 0)); if (ms < 1000) return ms + ' ms'; const s = ms / 1000;
    if (s < 60) return (s < 10 ? s.toFixed(1) : String(Math.round(s))) + ' s'; const m = Math.floor(s / 60), r = Math.round(s - m * 60); return m + ' m ' + (r < 10 ? '0' : '') + r + ' s'; };
  const pct = (a, b) => (b > 0 ? Math.round(100 * a / b) + '%' : '–');
  const plural = (n, w) => n + ' ' + w + (n === 1 ? '' : 's');
  const el = (tag, attrs, parent) => { const e = document.createElementNS(NS, tag); if (attrs) for (const k in attrs) e.setAttribute(k, attrs[k]); if (parent) parent.appendChild(e); return e; };
  const div = (cls, parent) => { const d = document.createElement('div'); if (cls) d.className = cls; if (parent) parent.appendChild(d); return d; };
  const setAttrs = (e, attrs) => { for (const k in attrs) e.setAttribute(k, attrs[k]); };
  const lerp = (a, b, t) => a + (b - a) * t;
  const lerpObj = (a, b, t) => { const o = {}; for (const k in b) o[k] = typeof b[k] === 'number' ? lerp(a[k] == null ? b[k] : a[k], b[k], t) : b[k]; return o; };
  const ribbon = (q) => { const xm = (q.x0 + q.x1) / 2; return 'M' + q.x0 + ' ' + q.y0 + 'C' + xm + ' ' + q.y0 + ' ' + xm + ' ' + q.y1 + ' ' + q.x1 + ' ' + q.y1; };
  const measureCtx = document.createElement('canvas').getContext('2d');
  function truncateToWidth(text, font, max) { measureCtx.font = font; if (measureCtx.measureText(text).width <= max) return text;
    let lo = 0, hi = text.length; while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (measureCtx.measureText(text.slice(0, mid) + '…').width <= max) lo = mid; else hi = mid - 1; }
    return text.slice(0, Math.max(1, lo)).replace(/\s+$/, '') + '…'; }
  // up to two lines: greedy first line on word boundaries, truncated remainder on the second
  function wrap2(text, font, max) { measureCtx.font = font; if (measureCtx.measureText(text).width <= max) return [text];
    const words = text.split(' '); let line = words[0], i = 1;
    for (; i < words.length; i++) { const t = line + ' ' + words[i]; if (measureCtx.measureText(t).width > max) break; line = t; }
    if (measureCtx.measureText(line).width > max) return [truncateToWidth(text, font, max)];
    return [line, truncateToWidth(words.slice(i).join(' '), font, max)]; }

  /* ---------- layout: pure function (data, measure, geometry, ordering) -> positioned nodes/links ---------- */
  function layout(data, measure, g, orderOf) {
    const nodes = data.nodes.map((n, i) => Object.assign({}, n, { i, in: [], out: [], v: 0 }));
    const byId = new Map(nodes.map((n) => [n.id, n]));
    const links = [];
    data.links.forEach((l) => { const src = byId.get(l.source), dst = byId.get(l.target); if (!src || !dst) return;
      const L = Object.assign({}, l, { id: l.source + '→' + l.target, src, dst, v: Math.max(0, +l[measure] || 0) }); src.out.push(L); dst.in.push(L); links.push(L); });
    const sum = (arr) => arr.reduce((a, l) => a + l.v, 0);
    // node thickness = max(Σ in, Σ out) (d3-sankey rule); isolated nodes fall back to their own value
    nodes.forEach((n) => { n.v = Math.max(sum(n.in), sum(n.out)); if (!(n.v > 0)) n.v = Math.max(0, +n[measure] || 0); });
    const ncol = data.columns.length;
    const cols = data.columns.map((c, ci) => Object.assign({}, c, { ci, nodes: nodes.filter((n) => n.column === ci) }));
    const rank = (c) => { const r = CAT_ORDER.indexOf(c); return r < 0 ? CAT_ORDER.length : r; };
    const secondary = orderOf || ((n) => -(n.calls || 0));
    // display order: runs stay chronological (col 0 never re-sorted); other columns by category rank then the
    // supplied order (frozen calls order / first-appearance while live); outcomes (last column) by the
    // value-weighted barycenter of their sources so ribbons cross as little as possible.
    cols.forEach((c) => {
      if (c.ci > 0) {
        if (c.ci === ncol - 1) {
          // weight by calls (measure-independent) so the Calls/Time toggle never reorders the outcome column (for the last column too).
          const bary = (n) => { let w = 0, s = 0; n.in.forEach((l) => { w += l.calls; s += l.calls * (l.src.colIdx != null ? l.src.colIdx : 0); }); return w > 0 ? s / w : (1e3 + rank(n.category)); };
          c.nodes.sort((a, b) => bary(a) - bary(b) || rank(a.category) - rank(b.category) || a.i - b.i);
        } else {
          c.nodes.sort((a, b) => rank(a.category) - rank(b.category) || secondary(a) - secondary(b) || a.i - b.i);
        }
      }
      c.nodes.forEach((n, idx) => { n.colIdx = idx; });
    });
    // a column whose nodes are all zero (e.g. a run that has not acted yet) gets unit values so it still draws
    cols.forEach((c) => { if (c.nodes.length && c.nodes.every((n) => !(n.v > 0))) c.nodes.forEach((n) => { n.v0 = 1; }); });
    const val = (n) => n.v0 || n.v;
    const innerH = g.height - g.padTop - g.padBottom;
    const maxNodes = Math.max(1, ...cols.map((c) => c.nodes.length));
    // soft-minimum. Shrink minH (then the gap) so the busiest column always fits `innerH` — never skip a
    // column or let its nodes land outside the SVG (the old pin loop could end with kk <= 0 at 11 nodes / 1200×560).
    let minH = g.minH, gap = g.gap;
    if (maxNodes > 1) {
      const fitH = (innerH - gap * (maxNodes - 1)) / maxNodes;
      if (fitH < minH) {
        if (fitH >= 3) minH = fitH;
        else { gap = Math.max(1, (innerH / maxNodes) * 0.3); minH = Math.max(2, (innerH - gap * (maxNodes - 1)) / maxNodes); }
      }
    } else if (minH > innerH) minH = Math.max(2, innerH);
    g.minH = minH; g.gap = gap;
    // fill more of the height on typical sessions — cap a single tall node at 45 % + 14 %·nodes (≤ 90 %), centred.
    const cap = innerH * Math.min(0.9, 0.45 + 0.14 * maxNodes);
    let k = Infinity;
    cols.forEach((c) => { if (!c.nodes.length) return; const avail = innerH - g.gap * (c.nodes.length - 1); let kk = 0, fixed = 0, rest = c.nodes.slice();
      for (let it = 0; it < 12; it++) { const tot = rest.reduce((a, n) => a + val(n), 0); kk = tot > 0 ? (avail - fixed * g.minH) / tot : 0;
        const small = rest.filter((n) => val(n) * kk < g.minH); if (!small.length || !rest.length) break; fixed += small.length; rest = rest.filter((n) => small.indexOf(n) < 0); }
      if (kk > 0) k = Math.min(k, kk); });
    const maxV = Math.max(0, ...nodes.map(val));
    if (maxV > 0) k = Math.min(k, cap / maxV);
    if (!isFinite(k) || k < 0) k = 0;
    // a minimum ribbon width expressed in value units (before stacking) keeps bundles gap-free; the node
    // box grows to cover its thickest bundle so nothing spills out of the box.
    const minV = k > 0 ? g.minLink / k : 0;
    const bundleV = (arr) => arr.reduce((s, l) => s + Math.max(l.v, minV), 0);
    nodes.forEach((n) => { n.h = Math.max(g.minH, val(n) * k, bundleV(n.in) * k, bundleV(n.out) * k); n.w = g.nodeW; });
    // x per column; initial y = stack centred vertically
    const span = g.width - 2 * g.padX - g.nodeW;
    cols.forEach((c) => { c.x = g.padX + (ncol > 1 ? span * c.ci / (ncol - 1) : span / 2);
      const H = c.nodes.reduce((a, n) => a + n.h, 0) + g.gap * (c.nodes.length - 1); let y = g.padTop + (innerH - H) / 2;
      c.nodes.forEach((n) => { n.x = c.x; n.y = y; y += n.h + g.gap; }); });
    // relax: pull each node toward the value-weighted centre of its neighbours, push overlaps apart symmetrically, clamp
    const center = (n) => n.y + n.h / 2;
    const resolve = (c) => { const ns = c.nodes; if (!ns.length) return;
      for (let pass = 0; pass < ns.length; pass++) { let moved = false;
        for (let i = 1; i < ns.length; i++) { const p = ns[i - 1], n = ns[i], ov = p.y + p.h + g.gap - n.y; if (ov > 0.01) { p.y -= ov / 2; n.y += ov / 2; moved = true; } }
        if (!moved) break; }
      const top = ns[0].y, bot = ns[ns.length - 1].y + ns[ns.length - 1].h; let dy = 0;
      if (top < g.padTop) dy = g.padTop - top; else if (bot > g.padTop + innerH) dy = g.padTop + innerH - bot; if (dy) ns.forEach((n) => { n.y += dy; }); };
    for (let it = 0, a = 1; it < 8; it++, a *= 0.75) {
      cols.forEach((c) => { c.nodes.forEach((n) => { const w = sum(n.in); if (!(w > 0)) return; const ty = n.in.reduce((s, l) => s + center(l.src) * l.v, 0) / w; n.y += (ty - center(n)) * a; }); resolve(c); });
      for (let ci = ncol - 1; ci >= 0; ci--) { const c = cols[ci]; c.nodes.forEach((n) => { const w = sum(n.out); if (!(w > 0)) return; const ty = n.out.reduce((s, l) => s + center(l.dst) * l.v, 0) / w; n.y += (ty - center(n)) * a; }); resolve(c); }
    }
    // centre the whole diagram vertically in the drawing area (the cap can leave slack)
    if (nodes.length) { const minY = Math.min(...nodes.map((n) => n.y)), maxY = Math.max(...nodes.map((n) => n.y + n.h)); const dy = g.padTop + (innerH - (maxY - minY)) / 2 - minY; nodes.forEach((n) => { n.y += dy; }); }
    // ribbons: per node, sort by the other end's y (fewer crossings); stack each bundle centred inside the box
    nodes.forEach((n) => {
      n.out.sort((a, b) => center(a.dst) - center(b.dst) || a.dst.i - b.dst.i); n.in.sort((a, b) => center(a.src) - center(b.src) || a.src.i - b.src.i);
      let y = n.y + (n.h - bundleV(n.out) * k) / 2; n.out.forEach((l) => { l.th = Math.max(l.v, minV) * k; l.y0 = y + l.th / 2; l.x0 = n.x + n.w; y += l.th; });
      y = n.y + (n.h - bundleV(n.in) * k) / 2; n.in.forEach((l) => { l.th = Math.max(l.v, minV) * k; l.y1 = y + l.th / 2; l.x1 = n.x; y += l.th; });
      n.inV = sum(n.in); n.outV = sum(n.out);
    });
    cols.forEach((c) => { c.calls = c.nodes.reduce((a, n) => a + (n.calls || 0), 0); c.ms = c.nodes.reduce((a, n) => a + (n.ms || 0), 0); c.nodes.forEach((n) => { n.col = c; }); });
    return { nodes, links, cols, k };
  }

  /* ---------- instance ---------- */
  function create(container, opts) {
    const o = Object.assign({ width: 800, height: 400, mode: 'auto', measure: 'calls', legend: true, headers: true, interactive: true, animate: true, duration: 320, label: null,
      onSelect: null, onFocus: null }, opts);
    const root = div('flow-root', container);
    const legendEl = o.legend ? div('flow-legend', root) : null;
    const svg = el('svg', { class: 'flow-svg', role: 'img', 'aria-label': o.label || (o.mode === 'thumb' ? 'Trajectory flow preview' : 'Agent path diagram: Runs, Actors, Actions, Outcomes') }, root);
    const gHead = el('g', { class: 'flow-heads' }, svg), gLinks = el('g', { class: 'flow-links' }, svg), gNodes = el('g', { class: 'flow-nodes' }, svg);
    const tip = o.interactive ? div('flow-tip', root) : null; if (tip) tip.hidden = true;
    root.dataset.interactive = String(!!o.interactive);
    const reduceMotion = window.matchMedia ? window.matchMedia('(prefers-reduced-motion: reduce)') : { matches: false };
    const S = { data: null, measure: o.measure, mode: null, g: null, lay: null, nodeEls: new Map(), linkEls: new Map(), sel: null, focus: new Set(),
      raf: 0, t0: 0, seq: new Map(), seqNext: 0, order: null, orderMeasure: null, labelFont: LABEL_FONT_FALLBACK, legendItems: new Map(), headEls: new Map(), emptyEl: null };
    const pickMode = () => (o.mode !== 'auto' ? o.mode : (o.width >= 520 && o.height >= 260 ? 'full' : 'thumb'));
    function sizeSvg() { setAttrs(svg, { width: o.width, height: o.height, viewBox: '0 0 ' + o.width + ' ' + o.height }); root.style.width = '100%'; root.style.height = o.height + 'px'; }
    sizeSvg();
    if (o.interactive) svg.addEventListener('click', (ev) => { if (ev.target === svg) setSelection(null); });

    // build the frozen "by calls" order per non-run column (refreshed only when not live or the measure changes)
    function buildOrder(data) {
      const m = new Map();
      data.columns.forEach((col, ci) => { if (ci === 0) return;
        data.nodes.filter((n) => n.column === ci).slice()
          .sort((a, b) => (b.calls || 0) - (a.calls || 0) || (b.ms || 0) - (a.ms || 0) || String(a.label).localeCompare(String(b.label)))
          .forEach((n, i) => m.set(n.id, i)); });
      return m;
    }

    function update(data, uo) {
      uo = uo || {}; const animate = uo.animate == null ? o.animate : uo.animate;
      S.data = data; S.mode = pickMode(); root.dataset.mode = S.mode;
      const full = S.mode === 'full';
      // read the label font from the live computed style once per update
      S.labelFont = full ? (getComputedStyle(root).font || LABEL_FONT_FALLBACK) : LABEL_FONT_FALLBACK;
      // freeze ordering while a run streams; re-sort by calls once it completes or the measure changes
      data.nodes.forEach((n) => { if (!S.seq.has(n.id)) S.seq.set(n.id, S.seqNext++); });
      const live = data.nodes.some((n) => n.category === 'outcome-pending' || (n.column === 0 && n.status === 'running'));
      if (!live || S.measure !== S.orderMeasure || !S.order) { S.order = buildOrder(data); S.orderMeasure = S.measure; }
      const orderOf = (n) => (S.order.has(n.id) ? S.order.get(n.id) : 1e6 + (S.seq.get(n.id) || 0));
      // borrow: proportional node width (~12 % of width, clamped 100–168 px) in full mode
      const nodeW = full ? Math.max(100, Math.min(168, Math.round(o.width * 0.12))) : PRESETS.thumb.nodeW;
      const g = Object.assign({ width: o.width, height: o.height }, PRESETS[S.mode], { nodeW });
      if (!o.headers || S.mode === 'thumb') g.padTop = g.padBottom;
      S.g = g; const lay = S.lay = layout(data, S.measure, g, orderOf);
      renderHeaders(lay, full); renderLegend(data);
      const seen = new Set();
      lay.links.forEach((l) => { seen.add(l.id); let e = S.linkEls.get(l.id); const to = { x0: l.x0, y0: l.y0, x1: l.x1, y1: l.y1, th: l.th, op: 1 };
        if (!e) { e = el('path', { class: 'flow-link' }, gLinks); e.__g = Object.assign({}, to, { op: 0 }); S.linkEls.set(l.id, e); if (o.interactive) bindLink(e); }
        e.__d = l; e.__from = Object.assign({}, e.__g); e.__to = to; e.__gone = false; e.setAttribute('stroke', colorOf(l.src.category)); });
      S.linkEls.forEach((e, id) => { if (!seen.has(id)) { e.__from = Object.assign({}, e.__g); e.__to = Object.assign({}, e.__g, { op: 0 }); e.__gone = true; } });
      seen.clear();
      lay.nodes.forEach((n) => { seen.add(n.id); let e = S.nodeEls.get(n.id); const to = { x: n.x, y: n.y, w: n.w, h: n.h, op: 1 };
        if (!e) { e = makeNode(); e.__g = Object.assign({}, to, { op: 0 }); S.nodeEls.set(n.id, e); if (o.interactive) bindNode(e); }
        e.__d = n; e.__from = Object.assign({}, e.__g); e.__to = to; e.__gone = false; styleNode(e, n, full); });
      S.nodeEls.forEach((e, id) => { if (!seen.has(id)) { e.__from = Object.assign({}, e.__g); e.__to = Object.assign({}, e.__g, { op: 0 }); e.__gone = true; } });
      if (S.sel && !S.nodeEls.has(S.sel)) S.sel = null;
      applyEmphasis();
      if (animate && lay.nodes.length && !reduceMotion.matches) startTween(); else finishTween();
    }

    function makeNode() { const ge = el('g', { class: 'flow-node' }, gNodes);
      ge.__parts = { box: el('rect', { class: 'box' }, ge), bar: el('rect', { class: 'bar', rx: 1.5, width: 3 }, ge), dot: el('circle', { class: 'dot', r: 3.5 }, ge),
        label: el('text', { class: 'label' }, ge), label2: el('text', { class: 'label' }, ge), sub: el('text', { class: 'sub' }, ge) }; return ge; }
    function styleNode(e, n, full) { const p = e.__parts, c = colorOf(n.category);
      setAttrs(p.box, { fill: c, stroke: c, rx: S.g.rx }); p.bar.setAttribute('fill', c);
      e.classList.toggle('is-pending', n.category === 'outcome-pending' || n.status === 'running');
      // borrow: label auto-hide thresholds — a short box drops its sub line, a very short box drops the label too
      const showLabel = full && n.h >= 16, showSub = full && n.h >= 30, two = showLabel && n.h >= 64;
      p.bar.style.display = full ? '' : 'none';
      p.label.style.display = showLabel ? '' : 'none'; p.label2.style.display = two ? '' : 'none'; p.sub.style.display = showSub ? '' : 'none';
      if (showLabel) { const lines = two ? wrap2(n.label || n.id, S.labelFont, n.w - 30) : [truncateToWidth(n.label || n.id, S.labelFont, n.w - 30)];
        p.label.textContent = lines[0]; p.label2.textContent = lines[1] || ''; e.__lines = lines.length; }
      if (showSub) p.sub.textContent = plural(n.calls || 0, 'call') + ' · ' + fmtMs(n.ms);
      const st = n.status && STATUS_VAR[n.status]; p.dot.style.display = full && st ? '' : 'none'; if (st) p.dot.setAttribute('fill', 'var(' + st + ')');
      if (o.interactive) e.setAttribute('aria-label', `${n.label || n.id}. ${CAT_LABEL[n.category] || n.category}. ${plural(n.calls || 0, 'call')}, ${fmtMs(n.ms)}.`); }
    // enter/exit opacity goes on the presentation attribute so the .is-dim class (CSS) can still win
    function applyNode(e, q) { const p = e.__parts; setAttrs(p.box, { x: q.x, y: q.y, width: q.w, height: q.h }); e.setAttribute('opacity', q.op);
      if (S.mode === 'full') { setAttrs(p.bar, { x: q.x + 6, y: q.y + 6, height: Math.max(0, q.h - 12) }); const two = e.__lines === 2, top = q.y + (q.h - (two ? 45 : 30)) / 2;
        setAttrs(p.label, { x: q.x + 16, y: top + 12 }); setAttrs(p.label2, { x: q.x + 16, y: top + 27 }); setAttrs(p.sub, { x: q.x + 16, y: top + (two ? 42 : 26) }); setAttrs(p.dot, { cx: q.x + q.w - 10, cy: q.y + 10 }); } }
    function applyLink(e, q) { setAttrs(e, { d: ribbon(q), 'stroke-width': q.th, opacity: q.op }); }

    // keyed column headers: keep the <text> nodes, only move / retext them
    function renderHeaders(lay, full) {
      if (!full || !o.headers) { S.headEls.forEach((t) => t.remove()); S.headEls.clear(); if (S.emptyEl) { S.emptyEl.remove(); S.emptyEl = null; } return; }
      const want = new Set(lay.cols.map((c) => c.id));
      S.headEls.forEach((t, id) => { if (!want.has(id)) { t.remove(); S.headEls.delete(id); } });
      lay.cols.forEach((c) => { let t = S.headEls.get(c.id); if (!t) { t = el('text', { class: 'head', y: 16 }, gHead); S.headEls.set(c.id, t); } t.setAttribute('x', c.x); t.textContent = c.title; });
      if (!lay.nodes.length) { if (!S.emptyEl) S.emptyEl = el('text', { class: 'empty' }, gHead); setAttrs(S.emptyEl, { x: o.width / 2, y: o.height / 2 }); S.emptyEl.textContent = 'No activity yet'; }
      else if (S.emptyEl) { S.emptyEl.remove(); S.emptyEl = null; }
    }

    // keyed legend join: reuse the category buttons, refresh swatch colours for the theme, diff on churn
    function renderLegend(data) {
      if (!legendEl) return;
      const cats = CAT_ORDER.filter((c) => data.nodes.some((n) => n.category === c));
      const want = new Set(cats);
      S.legendItems.forEach((b, cat) => { if (!want.has(cat)) { b.remove(); S.legendItems.delete(cat); } });
      let hint = legendEl.querySelector('.flow-legend-hint');
      cats.forEach((c) => {
        let b = S.legendItems.get(c);
        if (!b) { b = document.createElement('button'); b.type = 'button'; b.className = 'flow-legend-item'; b.dataset.cat = c;
          const sw = document.createElement('span'); sw.className = 'sw'; b.__sw = sw; b.append(sw, document.createTextNode(CAT_LABEL[c] || c));
          b.addEventListener('click', () => toggleFocus(c)); S.legendItems.set(c, b); }
        b.__sw.style.background = colorOf(c);
        legendEl.insertBefore(b, hint);
      });
      if (!hint) { hint = document.createElement('span'); hint.className = 'flow-legend-hint'; legendEl.appendChild(hint); }
      hint.textContent = 'ribbon width = ' + (S.measure === 'ms' ? 'time spent' : 'number of calls');
    }

    /* emphasis: three levels — a lit node stays full, an endpoint of a lit ribbon dims to 60 % (is-soft), everything else
       dims to is-dim; lit ribbons raise to the top. Driven by the legend focus set ∧ the selected node. */
    function applyEmphasis() {
      const f = S.focus, sel = S.sel, any = f.size > 0, active = any || !!sel;
      const linkLit = (l) => (!any || f.has(l.src.category) || f.has(l.dst.category)) && (!sel || l.src.id === sel || l.dst.id === sel);
      const nodeHard = (n) => (!any || f.has(n.category)) && (!sel || n.id === sel || n.in.some((l) => l.src.id === sel) || n.out.some((l) => l.dst.id === sel));
      const soft = new Set();
      if (active) S.linkEls.forEach((e) => { const l = e.__d; if (l && linkLit(l)) { soft.add(l.src.id); soft.add(l.dst.id); } });
      S.nodeEls.forEach((e) => { const n = e.__d; if (!n) return; const hard = nodeHard(n); const isSoft = active && !hard && soft.has(n.id);
        e.classList.toggle('is-dim', active && !hard && !isSoft); e.classList.toggle('is-soft', isSoft); e.classList.toggle('is-sel', n.id === sel); });
      S.linkEls.forEach((e) => { const lit = e.__d && linkLit(e.__d); e.classList.toggle('is-dim', active && !lit); e.classList.toggle('is-hot', !!(active && lit)); });
      if (active) S.linkEls.forEach((e) => { if (e.classList.contains('is-hot')) gLinks.appendChild(e); });
      if (legendEl) S.legendItems.forEach((b, cat) => { b.classList.toggle('is-on', f.has(cat)); b.classList.toggle('is-off', any && !f.has(cat)); });
    }

    function setSelection(id) { S.sel = id || null; applyEmphasis(); if (o.onSelect) o.onSelect(S.sel, S.sel && S.lay ? (S.lay.nodes.find((n) => n.id === S.sel) || null) : null); }
    function toggleFocus(cat) { if (S.focus.has(cat)) S.focus.delete(cat); else S.focus.add(cat); applyEmphasis(); if (o.onFocus) o.onFocus([...S.focus]); }

    /* tween: every element carries __from/__to geometry; one rAF loop interpolates and applies */
    function startTween() { S.t0 = performance.now(); if (!S.raf) S.raf = requestAnimationFrame(frame); }
    function frame(now) { const t = Math.min(1, (now - S.t0) / o.duration); step(1 - Math.pow(1 - t, 3)); if (t < 1) S.raf = requestAnimationFrame(frame); else { S.raf = 0; finishTween(); } }
    function step(t) { S.nodeEls.forEach((e) => { if (e.__to) { e.__g = lerpObj(e.__from, e.__to, t); applyNode(e, e.__g); } });
      S.linkEls.forEach((e) => { if (e.__to) { e.__g = lerpObj(e.__from, e.__to, t); applyLink(e, e.__g); } }); }
    function finishTween() { if (S.raf) { cancelAnimationFrame(S.raf); S.raf = 0; } step(1);
      S.nodeEls.forEach((e, id) => { if (e.__gone) { e.remove(); S.nodeEls.delete(id); } });
      S.linkEls.forEach((e, id) => { if (e.__gone) { e.remove(); S.linkEls.delete(id); } }); }

    /* tooltips */
    function tipRow(k, v, extra) { const r = div('r', tip); const a = document.createElement('span'); a.textContent = k; const b = document.createElement('b'); b.textContent = v; r.append(a, b);
      if (extra) { const i = document.createElement('i'); i.textContent = ' ' + extra; b.appendChild(i); } }
    function showNodeTip(n, ev) { if (!tip) return; tip.replaceChildren(); div('t', tip).textContent = n.label; const c = div('c', tip); let cat = CAT_LABEL[n.category] || n.category;
      if (n.status) cat += ' · ' + n.status; if (n.parent) { const p = S.lay.nodes.find((x) => x.id === n.parent); cat += ' · spawned by ' + (p ? p.label : n.parent); } c.textContent = cat;
      tipRow('Calls', String(n.calls || 0), '(' + pct(n.calls || 0, n.col.calls) + ' of column)');
      tipRow(n.category === 'run' ? 'Wall time' : n.category === 'subagent' ? 'Waited' : 'Time', fmtMs(n.ms), '(' + pct(n.ms || 0, n.col.ms) + ')');
      const x = n.extra || {};
      if (x.actions_ms != null) tipRow('Own actions', fmtMs(x.actions_ms));
      if (x.thinking_blocks != null) tipRow('Thinking · text blocks', x.thinking_blocks + ' · ' + x.text_blocks);
      if (x.members && x.members.length) div('m', tip).textContent = x.members.map((m) => m.name || m.label).join(', ');
      if (S.measure === 'ms' && n.in.length && n.out.length && Math.abs(n.inV - n.outV) > 1) div('m', tip).textContent = 'in ' + fmtMs(n.inV) + ' · out ' + fmtMs(n.outV) + ' (latencies overlap)';
      tip.hidden = false; moveTip(ev); }
    function showLinkTip(l, ev) { if (!tip) return; tip.replaceChildren(); div('t', tip).textContent = l.src.label + ' → ' + l.dst.label; div('c', tip).textContent = CAT_LABEL[l.src.category] + ' → ' + CAT_LABEL[l.dst.category];
      const oc = l.src.out.reduce((a, x) => a + (x.calls || 0), 0), om = l.src.out.reduce((a, x) => a + (x.ms || 0), 0);
      tipRow('Calls', String(l.calls || 0), '(' + pct(l.calls || 0, oc) + ' of ' + l.src.label.split(':')[0] + ')'); tipRow('Time', fmtMs(l.ms), '(' + pct(l.ms || 0, om) + ')');
      tip.hidden = false; moveTip(ev); }
    function moveTip(ev) { if (!tip) return; const r = root.getBoundingClientRect(); let x = ev.clientX - r.left + 14, y = ev.clientY - r.top + 14; const tw = tip.offsetWidth, th = tip.offsetHeight;
      if (x + tw > r.width - 4) x = ev.clientX - r.left - tw - 14; if (y + th > r.height - 4) y = ev.clientY - r.top - th - 12; tip.style.transform = 'translate(' + Math.max(0, x) + 'px,' + Math.max(0, y) + 'px)'; }
    function hideTip() { if (tip) tip.hidden = true; }
    // node groups are real buttons — focusable, Enter/Space select, Escape clears
    function bindNode(e) {
      e.setAttribute('tabindex', '0'); e.setAttribute('role', 'button');
      e.addEventListener('mouseenter', (ev) => { showNodeTip(e.__d, ev); e.__d.in.concat(e.__d.out).forEach((l) => { const le = S.linkEls.get(l.id); if (le) le.classList.add('is-hot'); }); });
      e.addEventListener('mousemove', moveTip); e.addEventListener('mouseleave', () => { hideTip(); if (!S.sel && !S.focus.size) S.linkEls.forEach((le) => le.classList.remove('is-hot')); else applyEmphasis(); });
      e.addEventListener('click', (ev) => { ev.stopPropagation(); setSelection(S.sel === e.__d.id ? null : e.__d.id); });
      e.addEventListener('keydown', (ev) => {
        if (ev.key === 'Enter' || ev.key === ' ' || ev.key === 'Spacebar') { ev.preventDefault(); setSelection(S.sel === e.__d.id ? null : e.__d.id); }
        else if (ev.key === 'Escape') { if (S.sel || S.focus.size) { ev.preventDefault(); ev.stopPropagation(); S.focus.clear(); setSelection(null); if (o.onFocus) o.onFocus([]); } }
      });
    }
    function bindLink(e) { e.addEventListener('mouseenter', (ev) => showLinkTip(e.__d, ev)); e.addEventListener('mousemove', moveTip); e.addEventListener('mouseleave', hideTip); }

    function doResize(w, h) { w = Math.max(1, Math.round(w)); h = Math.max(1, Math.round(h)); if (w === o.width && h === o.height) return; o.width = w; o.height = h; sizeSvg(); if (S.data) update(S.data, { animate: false }); }
    // resize() follows the container via a ResizeObserver, sizing both width and height
    const ro = window.ResizeObserver ? new ResizeObserver(() => { const w = container.clientWidth, h = container.clientHeight; if (w >= 10 && h >= 10) doResize(w, h); }) : null;
    if (ro) ro.observe(container);

    return {
      update, el: root, svg,
      setMeasure(m) { if (m === S.measure) return; S.measure = m; if (S.data) update(S.data, { animate: true }); },
      resize(w, h) { o.width = Math.max(1, Math.round(w || o.width)); o.height = Math.max(1, Math.round(h || o.height)); sizeSvg(); if (S.data) update(S.data, { animate: false }); },
      select(id) { setSelection(id); },
      focus(cats) { S.focus = new Set(cats || []); applyEmphasis(); if (o.onFocus) o.onFocus([...S.focus]); },
      clearFocus() { S.focus.clear(); applyEmphasis(); if (o.onFocus) o.onFocus([]); },
      get selection() { return S.sel; }, get focused() { return [...S.focus]; },
      get measure() { return S.measure; }, get layout() { return S.lay; },
      destroy() { finishTween(); if (ro) ro.disconnect(); root.remove(); },
    };
  }

  /* ---------- theme: toggle the dark --flow-* set on an instance root ---------- */
  function applyTheme(root, isDark) { if (root && root.classList) root.classList.toggle('flow-dark', !!isDark); }

  window.CCFlow = { compute, create, applyTheme, layout, fmtMs, CAT_ORDER, CAT_LABEL, CAT_VAR };
})();
