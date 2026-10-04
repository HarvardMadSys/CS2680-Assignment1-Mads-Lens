/* Claude Code headless frontend.
 *
 * Right pane: the dialogue. Each prompt becomes a "run" (one headless claude
 * process). Events from the stream-json output are rendered as they arrive:
 * assistant text, thinking, tool calls with pending/completed/failed status and
 * their results, subagent activity nested under the Agent call that spawned it,
 * harness lines (hooks, compaction, permission denials), and the final result
 * with cost, duration and turns.
 *
 * Left pane: the Pace strip, then a trajectory summary card (flow thumbnail, LLM
 * turns / tool calls / subagents / failures, most-used tools, wall time) with an
 * Expand button that opens a full-screen modal: a Flow tab (agent-path diagram,
 * rendered by static/flow.js when present) and a Timeline tab (the Cytoscape step
 * graph with search, zoom, fit, direction and follow). Clicking a step closes the
 * modal and jumps to its card. state.tree carries the timing fields the flow model
 * needs (runId/startTs/endTs/ms on runs; ts/msgId/name/toolUseId/endTs/ms on steps).
 *
 * Policy: the composer's collapsible panel sets a per-run budget cap, the allowed
 * built-in tools and deny patterns; it is sent with each run request, echoed back
 * in run_started, shown as badges on the run header and remembered in localStorage.
 *
 * Pace: the strip at the top of the left pane. The token-level stream_event lines
 * (from --include-partial-messages) feed TTFT, TPOT and latency tiles, and a cat
 * that sleeps, sits, walks or runs with the smoothed tokens/s. Those lines render
 * no dialogue content; the full assistant events still do that.
 */
(() => {
  'use strict';

  // ------------------------------------------------------------------ helpers
  const $ = (sel, root = document) => root.querySelector(sel);

  function el(tag, attrs = {}, ...children) {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (v == null || v === false) continue;
      if (k === 'class') n.className = v;
      else if (k === 'text') n.textContent = v;
      else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
      else n.setAttribute(k, v === true ? '' : v);
    }
    for (const c of children) if (c != null) n.append(c);
    return n;
  }

  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const truncate = (s, n) => { s = String(s ?? '').replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, Math.max(1, n - 1)) + '…' : s; };
  const firstLine = (s) => String(s ?? '').split('\n').find((l) => l.trim())?.trim() || '';
  const shortPath = (p) => { if (!p) return ''; const parts = String(p).split('/').filter(Boolean); return parts.length > 2 ? '…/' + parts.slice(-2).join('/') : String(p); };
  const humanize = (s) => String(s || '').replace(/[_-]+/g, ' ').replace(/^\w/, (c) => c.toUpperCase());
  const fmtCost = (usd) => (usd == null ? '' : `$${Number(usd).toFixed(4)}`);
  function fmtDur(ms) {
    if (ms == null || Number.isNaN(ms)) return '';
    if (ms < 1000) return `${Math.round(ms)} ms`;
    if (ms < 60000) return `${(ms / 1000).toFixed(1)} s`;
    const m = Math.floor(ms / 60000);
    return `${m} min ${Math.round((ms % 60000) / 1000)} s`;
  }
  let uidCounter = 0;
  const nextUid = () => ++uidCounter;

  /** Text from a tool_result content field (string or list of blocks). */
  function extractText(content) {
    if (content == null) return '';
    if (typeof content === 'string') return content;
    if (Array.isArray(content)) {
      return content.map((b) => {
        if (typeof b === 'string') return b;
        if (b.type === 'text') return b.text || '';
        if (b.type === 'image') return '[image]';
        if (b.type === 'document') return '[document]';
        return '';
      }).filter(Boolean).join('\n');
    }
    return JSON.stringify(content);
  }

  /** Compact "key: value" summary of an event's scalar fields (never raw JSON). */
  function summarizeScalars(ev, skip = ['type', 'subtype', 'uuid', 'session_id', 'parent_tool_use_id', 'timestamp']) {
    return Object.entries(ev)
      .filter(([k, v]) => !skip.includes(k) && (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean'))
      .slice(0, 5)
      .map(([k, v]) => `${humanize(k).toLowerCase()}: ${truncate(v, 60)}`)
      .join(' · ');
  }

  // ------------------------------------------------------------- status chips
  const STATUS_ICON = { pending: '', running: '', completed: '✓', failed: '✕', stopped: '■' };
  const STATUS_COLOR = { pending: 'warning', running: 'warning', completed: 'success', failed: 'error', stopped: 'neutral' };
  function statusSpan(status, reason) { const s = el('span'); setStatus(s, status, reason); return s; }
  function setStatus(span, status, reason) {
    const color = STATUS_COLOR[status] || 'neutral';
    span.className = `chip badge badge-sm badge-soft badge-${color} gap-1 whitespace-nowrap s-${status}`;
    const icon = STATUS_ICON[status]
      ? el('span', { class: 'font-bold', text: STATUS_ICON[status] })
      : el('span', { class: 'loading loading-spinner loading-xs', 'aria-hidden': 'true' });
    span.replaceChildren(icon, document.createTextNode(status));
    if (reason) span.title = reason; else span.removeAttribute('title');
  }

  // ------------------------------------------------------------ markdown-lite
  function inline(s) {
    let t = esc(s);
    t = t.replace(/`([^`]+)`/g, '<code>$1</code>');
    t = t.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    t = t.replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
    return t;
  }
  function renderMarkdown(src) {
    const lines = String(src ?? '').split('\n');
    const out = [];
    let para = [];
    let list = null;
    const flushPara = () => { if (para.length) { out.push(`<p>${inline(para.join(' '))}</p>`); para = []; } };
    const flushList = () => { if (list) { out.push(`<${list.tag}>${list.items.map((x) => `<li>${inline(x)}</li>`).join('')}</${list.tag}>`); list = null; } };
    let i = 0;
    while (i < lines.length) {
      const line = lines[i];
      if (/^\s*```/.test(line)) {
        flushPara(); flushList();
        const buf = []; i++;
        while (i < lines.length && !/^\s*```/.test(lines[i])) buf.push(lines[i++]);
        i++;
        out.push(`<pre class="code">${esc(buf.join('\n'))}</pre>`);
        continue;
      }
      if (/^\s*\|.*\|\s*$/.test(line)) {
        flushPara(); flushList();
        const rows = [];
        while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i])) rows.push(lines[i++]);
        const cells = (r) => r.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim());
        const body = rows.filter((r) => !/^\s*\|?\s*:?-{2,}/.test(r));
        if (body.length) {
          const [head, ...rest] = body;
          out.push('<table><thead><tr>' + cells(head).map((c) => `<th>${inline(c)}</th>`).join('') + '</tr></thead><tbody>' +
            rest.map((r) => '<tr>' + cells(r).map((c) => `<td>${inline(c)}</td>`).join('') + '</tr>').join('') + '</tbody></table>');
        }
        continue;
      }
      const h = /^(#{1,6})\s+(.*)$/.exec(line);
      if (h) { flushPara(); flushList(); const lvl = Math.min(h[1].length + 2, 6); out.push(`<h${lvl}>${inline(h[2])}</h${lvl}>`); i++; continue; }
      const ul = /^\s*[-*•]\s+(.*)$/.exec(line);
      const ol = /^\s*\d+[.)]\s+(.*)$/.exec(line);
      if (ul || ol) {
        flushPara();
        const tag = ul ? 'ul' : 'ol';
        if (!list || list.tag !== tag) { flushList(); list = { tag, items: [] }; }
        list.items.push((ul || ol)[1]);
        i++; continue;
      }
      if (!line.trim()) { flushPara(); flushList(); i++; continue; }
      if (list) flushList();
      para.push(line.trim());
      i++;
    }
    flushPara(); flushList();
    const div = el('div', { class: 'md' });
    div.innerHTML = out.join('');
    return div;
  }

  // -------------------------------------------------------------- DOM handles
  const transcript = $('#transcript');
  const cwdInput = $('#cwd');
  const cwdRoots = $('#cwd-roots');
  const cwdChildren = $('#cwd-children');
  const cwdUp = $('#cwd-up');
  const promptBox = $('#prompt');
  const runBtn = $('#run');
  const stopBtn = $('#stop');
  const note = $('#composer-note');
  const policyBox = $('#policy');
  const policyTitle = $('#policy-title');
  const policyBudget = $('#policy-budget');
  const policyBudgetWrap = $('#policy-budget-wrap');
  const policyToolsEl = $('#policy-tools');
  const policyToolsNote = $('#policy-tools-note');
  const policyDeny = $('#policy-deny');
  const paceEls = { ttft: $('#pace-ttft'), ttftDesc: $('#pace-ttft-desc'), tpot: $('#pace-tpot'), tpotDesc: $('#pace-tpot-desc'), latency: $('#pace-latency'), latencyDesc: $('#pace-latency-desc') };
  const catEl = $('#cat');
  const catStateEl = $('#cat-state');
  const graphEl = $('#tree');
  const treeEmpty = $('#tree-empty');
  // Trajectory summary card (left pane) and the full-screen modal it expands into.
  const trajectoryExpand = $('#trajectory-expand');
  const trajEls = { turns: $('#traj-turns'), tools: $('#traj-tools'), subagents: $('#traj-subagents'), failures: $('#traj-failures'),
    topTools: $('#traj-top-tools'), wall: $('#traj-wall'), session: $('#trajectory-session'), counts: $('#trajectory-counts') };
  const trajectoryModal = $('#trajectory-modal');
  const flowPanel = $('#flow-panel');
  const timelinePanel = $('#timeline-panel');
  const tabFlow = $('#tab-flow');
  const tabTimeline = $('#tab-timeline');
  const timelineSearch = $('#timeline-search');
  const timelineMatches = $('#timeline-matches');
  const badge = $('#session-badge');
  const newSessionBtn = $('#new-session');
  const sessionsBtn = $('#sessions');
  const sessionsDialog = $('#sessions-dialog');
  const sessionsList = $('#sessions-list');
  const sessionsAll = $('#sessions-all');
  const sessionsFilter = $('#sessions-filter');
  const sessionsScope = $('#sessions-scope');

  // -------------------------------------------------------------------- state
  const state = {
    sessionId: null,
    sessionCwd: null,
    dir: { path: null, parent: null }, // directory currently shown in the picker
    runs: [],
    currentRun: null,
    tree: { id: 'root', kind: 'session', label: 'Session', status: 'idle', children: [] },
  };
  const KIND_GLYPH = { session: '◎', run: '▶', text: '✎', thinking: '∿', tool: '⚙', agent: '⧉', system: 'ⓘ', result: '⚑' };

  function setNote(text, tone) { note.textContent = text || ''; note.className = `note text-xs ${tone === 'warn' ? 'text-error' : 'opacity-70'}`; }
  function setBusy(busy) {
    runBtn.disabled = busy;
    stopBtn.hidden = !busy;
    setDirPickerDisabled(busy || !!state.sessionId);
    newSessionBtn.disabled = busy;
    sessionsBtn.disabled = busy;
  }
  function setDirPickerDisabled(disabled) {
    cwdInput.disabled = disabled;
    cwdRoots.disabled = disabled;
    cwdUp.disabled = disabled || !state.dir.parent;
    cwdChildren.disabled = disabled || cwdChildren.options.length <= 1;
  }
  function updateSessionBadge() {
    if (!state.sessionId) { badge.hidden = true; newSessionBtn.hidden = true; return; }
    badge.hidden = false;
    newSessionBtn.hidden = false;
    const sid = $('#session-id'); sid.textContent = state.sessionId.slice(0, 8) + '…'; sid.title = state.sessionId;
    const cwd = $('#session-cwd'); cwd.textContent = shortPath(state.sessionCwd); cwd.title = state.sessionCwd || '';
    state.tree.label = `Session ${state.sessionId.slice(0, 8)}`;
    renderTree();
    // The session is bound to the directory claude reported; show it and lock the picker.
    if (state.sessionCwd && state.sessionCwd !== state.dir.path && !state.sessionCwdMissing) browseTo(state.sessionCwd, { remember: false });
    setDirPickerDisabled(true);
  }
  const scrollToBottom = () => { transcript.scrollTop = transcript.scrollHeight; };

  // ------------------------------------------------------------------- policy
  // What the next run may spend and use. Sent as {max_budget_usd, tools, deny} with POST /api/run;
  // the server turns it into --max-budget-usd / --tools / --disallowedTools (see app.py).
  const POLICY_KEY = 'cc-frontend-policy';
  const BUILTIN_TOOLS = ['Bash', 'Read', 'Write', 'Edit', 'Glob', 'Grep', 'WebSearch', 'WebFetch', 'Task', 'Skill', 'NotebookEdit',
    'TodoWrite', 'TaskCreate', 'TaskUpdate', 'TaskList', 'TaskGet', 'ToolSearch', 'AskUserQuestion', 'EnterPlanMode', 'ExitPlanMode',
    'SendMessage', 'TaskOutput', 'TaskStop'];
  const TOOL_LABELS = { Task: 'Task (subagents)' };
  const READ_ONLY_TOOLS = ['Read', 'Glob', 'Grep', 'WebSearch', 'WebFetch', 'TodoWrite', 'TaskList', 'TaskGet', 'ToolSearch'];
  const TOOL_NAME_RE = /^[A-Za-z][A-Za-z0-9_]*$/;
  const BUDGET_MAX_USD = 1000;
  const DENY_MAX_RULES = 50;
  const DENY_MAX_LEN = 200;
  // tools: null = every built-in tool (flag omitted); [] = none; otherwise the checked names.
  const policy = { maxBudgetUsd: null, tools: null, deny: [], knownTools: [...BUILTIN_TOOLS] };

  const isBuiltinName = (n) => typeof n === 'string' && TOOL_NAME_RE.test(n) && !n.startsWith('mcp__');
  const fmtCap = (usd) => `$${Math.abs(usd * 100 - Math.round(usd * 100)) < 1e-9 ? usd.toFixed(2) : String(usd)}`;
  const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

  /** The policy object exactly as the server expects it. */
  function currentPolicy() {
    const b = policy.maxBudgetUsd;
    return {
      max_budget_usd: b != null && Number.isFinite(b) ? b : null,
      tools: policy.tools === null ? null : [...policy.tools],
      deny: [...policy.deny],
    };
  }

  /** Short summary pieces ("$1.00 cap", "5 of 20 tools", "2 deny rules"); empty when nothing is limited. */
  function policyParts(p, total) {
    const parts = [];
    if (p.max_budget_usd != null) parts.push(`${fmtCap(p.max_budget_usd)} cap`);
    if (Array.isArray(p.tools)) {
      if (total != null) parts.push(`${p.tools.length} of ${total} tools`);
      else parts.push(p.tools.length ? plural(p.tools.length, 'tool') : 'no tools');
    }
    if (p.deny?.length) parts.push(plural(p.deny.length, 'deny rule'));
    return parts;
  }

  /** Ghost badges for a run header; nothing at all when the run had no limits. */
  function policyBadges(p) {
    if (!p) return [];
    const out = [];
    if (p.max_budget_usd != null) out.push(el('span', { class: 'badge badge-ghost badge-xs', text: `${fmtCap(p.max_budget_usd)} cap`, title: `--max-budget-usd ${p.max_budget_usd}` }));
    if (Array.isArray(p.tools)) {
      out.push(el('span', { class: 'badge badge-ghost badge-xs', text: p.tools.length ? plural(p.tools.length, 'tool') : 'no tools',
        title: p.tools.length ? `--tools ${p.tools.join(',')}` : '--tools "" (no built-in tools)' }));
    }
    if (p.deny?.length) out.push(el('span', { class: 'badge badge-ghost badge-xs', text: plural(p.deny.length, 'deny rule'), title: `--disallowedTools ${p.deny.join(' · ')}` }));
    return out;
  }

  /** First problem with the current policy, or null. Mirrors the server's checks so errors show before the round trip. */
  function budgetError() {
    const b = policy.maxBudgetUsd;
    if (b == null) return null;
    if (!Number.isFinite(b)) return 'The budget cap must be a number of dollars (leave it empty for no cap).';
    if (b <= 0) return 'The budget cap must be greater than $0.';
    if (b > BUDGET_MAX_USD) return `The budget cap must be at most $${BUDGET_MAX_USD}.`;
    return null;
  }
  function policyError() {
    const budgetProblem = budgetError();
    if (budgetProblem) return budgetProblem;
    if (policy.deny.length > DENY_MAX_RULES) return `At most ${DENY_MAX_RULES} deny patterns are allowed.`;
    const long = policy.deny.find((d) => d.length > DENY_MAX_LEN);
    if (long) return `Deny patterns must be at most ${DENY_MAX_LEN} characters: "${truncate(long, 40)}".`;
    const dash = policy.deny.find((d) => d.startsWith('-'));
    if (dash) return `Deny patterns cannot start with "-": "${truncate(dash, 40)}".`;
    return null;
  }

  /** Split "Bash(git push *), Edit" on commas, but not on commas inside parentheses. */
  function parseDeny(text) {
    const out = [];
    let depth = 0;
    let cur = '';
    for (const ch of String(text || '')) {
      if (ch === '(') depth++;
      else if (ch === ')') depth = Math.max(0, depth - 1);
      if (ch === ',' && depth === 0) { out.push(cur); cur = ''; continue; }
      cur += ch;
    }
    out.push(cur);
    const seen = new Set();
    return out.map((s) => s.trim()).filter((s) => s && !seen.has(s) && seen.add(s));
  }

  function savePolicy() {
    const p = currentPolicy();
    const extra = policy.knownTools.filter((n) => !BUILTIN_TOOLS.includes(n));
    try { localStorage.setItem(POLICY_KEY, JSON.stringify({ ...p, extra_tools: extra })); } catch { /* storage unavailable */ }
  }

  function loadPolicy() {
    let saved = null;
    try { saved = JSON.parse(localStorage.getItem(POLICY_KEY) || 'null'); } catch { saved = null; }
    if (!saved || typeof saved !== 'object') return;
    const b = saved.max_budget_usd;
    policy.maxBudgetUsd = typeof b === 'number' && Number.isFinite(b) && b > 0 && b <= BUDGET_MAX_USD ? b : null;
    if (Array.isArray(saved.extra_tools)) for (const n of saved.extra_tools) if (isBuiltinName(n) && !policy.knownTools.includes(n)) policy.knownTools.push(n);
    policy.tools = Array.isArray(saved.tools) ? saved.tools.filter((n) => typeof n === 'string' && policy.knownTools.includes(n)) : null;
    policy.deny = Array.isArray(saved.deny) ? parseDeny(saved.deny.filter((d) => typeof d === 'string').join(',')) : [];
    normalizeTools();
  }

  /** "Every known tool checked" is the same as no restriction. */
  function normalizeTools() {
    if (Array.isArray(policy.tools) && policy.tools.length === policy.knownTools.length && policy.knownTools.every((n) => policy.tools.includes(n))) policy.tools = null;
  }

  function renderToolGrid() {
    const allowed = policy.tools === null ? null : new Set(policy.tools);
    policyToolsEl.replaceChildren(...policy.knownTools.map((name) => {
      const box = el('input', { type: 'checkbox', class: 'checkbox checkbox-xs', value: name });
      box.checked = allowed === null || allowed.has(name);
      const extra = !BUILTIN_TOOLS.includes(name);
      return el('label', { class: `tool${extra ? ' extra' : ''}`, title: extra ? `${name} — reported by the last session start` : name },
        box, el('span', { class: 'truncate', text: TOOL_LABELS[name] || name }));
    }));
    updatePolicyTitle();
  }

  function readToolsFromGrid() {
    const boxes = [...policyToolsEl.querySelectorAll('input[type="checkbox"]')];
    const checked = boxes.filter((b) => b.checked).map((b) => b.value);
    policy.tools = checked.length === boxes.length ? null : checked;
  }

  function applyToolPreset(kind) {
    if (kind === 'all') policy.tools = null;
    else if (kind === 'none') policy.tools = [];
    else policy.tools = READ_ONLY_TOOLS.filter((t) => policy.knownTools.includes(t));
    normalizeTools();
    renderToolGrid();
    savePolicy();
  }

  /** The CLI's init event lists the real built-in tools: add any names the grid does not know yet (MCP tools are skipped). */
  function mergeKnownTools(names) {
    if (!Array.isArray(names)) return;
    const extra = names.filter((n) => isBuiltinName(n) && !policy.knownTools.includes(n));
    if (!extra.length) return;
    policy.knownTools.push(...extra);
    renderToolGrid();
    savePolicy();
  }

  function readBudgetInput() {
    const raw = policyBudget.value.trim();
    if (raw === '') policy.maxBudgetUsd = policyBudget.validity?.badInput ? NaN : null;
    else policy.maxBudgetUsd = Number(raw);
  }
  function setBudget(value) {
    policy.maxBudgetUsd = value;
    policyBudget.value = value == null ? '' : String(value);
    savePolicy();
    updatePolicyTitle();
  }

  function updatePolicyTitle() {
    const p = currentPolicy();
    const total = policy.knownTools.length;
    const budgetBad = !!budgetError();
    if (budgetBad) p.max_budget_usd = null; // never summarize a cap that would be rejected
    const parts = policyParts(p, total);
    if (budgetBad) parts.unshift('invalid cap');
    policyTitle.textContent = `Policy · ${parts.length ? parts.join(' · ') : 'no limits'}`;
    policyToolsNote.textContent = policy.tools === null ? `all ${total} allowed (no --tools flag)` : `${policy.tools.length} of ${total} allowed`;
    policyBudgetWrap.classList.toggle('input-error', budgetBad);
    for (const b of policyBox.querySelectorAll('[data-budget]')) {
      const v = b.dataset.budget === '' ? null : Number(b.dataset.budget);
      b.classList.toggle('btn-active', v === (p.max_budget_usd ?? null));
    }
    const readOnly = READ_ONLY_TOOLS.filter((t) => policy.knownTools.includes(t));
    const isReadOnly = Array.isArray(policy.tools) && policy.tools.length === readOnly.length && readOnly.every((t) => policy.tools.includes(t));
    for (const b of policyBox.querySelectorAll('[data-tools]')) {
      const k = b.dataset.tools;
      b.classList.toggle('btn-active', k === 'all' ? policy.tools === null : k === 'none' ? Array.isArray(policy.tools) && !policy.tools.length : isReadOnly);
    }
  }

  function initPolicy() {
    loadPolicy();
    policyBudget.value = policy.maxBudgetUsd == null ? '' : String(policy.maxBudgetUsd);
    policyDeny.value = policy.deny.join(', ');
    renderToolGrid();
    policyBudget.addEventListener('input', () => { readBudgetInput(); savePolicy(); updatePolicyTitle(); });
    for (const b of policyBox.querySelectorAll('[data-budget]')) b.addEventListener('click', () => setBudget(b.dataset.budget === '' ? null : Number(b.dataset.budget)));
    for (const b of policyBox.querySelectorAll('[data-tools]')) b.addEventListener('click', () => applyToolPreset(b.dataset.tools));
    policyToolsEl.addEventListener('change', () => { readToolsFromGrid(); savePolicy(); updatePolicyTitle(); });
    policyDeny.addEventListener('input', () => { policy.deny = parseDeny(policyDeny.value); savePolicy(); updatePolicyTitle(); });
    // Enter in these inputs must not submit the prompt (the form's implicit submission).
    for (const input of [policyBudget, policyDeny]) input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); input.blur(); } });
    // Same for the tool checkboxes: Enter toggles the box instead of starting a (paid) run.
    policyToolsEl.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter') return;
      e.preventDefault();
      if (e.target && e.target.type === 'checkbox') e.target.click();
    });
  }

  // --------------------------------------------------------------------- pace
  // Speed metrics for the live run, from the token-level stream_event lines that --include-partial-messages
  // adds. Only top-level events count (parent_tool_use_id null); subagent streams are ignored.
  //   request start : run_started, then every top-level tool_result (that is when Claude calls the API again)
  //   TTFT          : request start -> first content_block_start / content_block_delta of the reply
  //   TPOT          : (latest delta - first delta) / max(1, tokens - 1), tokens = usage.output_tokens from the
  //                   message_delta event once it has arrived, until then chars / 4 of the deltas so far
  //   latency       : last tool call (tool_use -> tool_result) and last turn (request start -> end of the reply:
  //                   the message_delta that carries stop_reason; the CLI emits no message_stop)
  // stream_event lines carry no timestamp, so they are timed on arrival; run_started and tool results use
  // their own timestamps. Replayed sessions have no deltas: their tiles stay "—" and the cat keeps sleeping.
  // Cat: no live run -> sleep; live run but no delta in the last 1.5 s -> sit; streaming under 25 tokens/s
  // (EMA, alpha 0.3) -> walk; 25 and up -> run; --cat-speed = clamp(tokens/s / 25, 0.6, 2.5).
  const CAT_RUN_TPS = 25;
  const CAT_IDLE_MS = 1500;
  const CAT_SPEED_MIN = 0.6, CAT_SPEED_MAX = 2.5;
  const TPS_EMA_ALPHA = 0.3;
  const CHARS_PER_TOKEN = 4;
  const CAT_WORD = { sleep: 'sleeping', sit: 'waiting', walk: 'walking', run: 'running' };
  const DASH = '—';
  const fmtMs = (ms) => (ms < 10 ? ms.toFixed(1) : String(Math.round(ms)));

  function newPace() {
    return {
      requestStart: null, requests: 0,
      firstTokenAt: null, firstDeltaAt: null, lastDeltaAt: null, chars: 0, usageTokens: null, tokens: 0,
      ttft: null, ttftRequest: 0, ttftSum: 0, ttftCount: 0, cliTtft: null,
      tpot: null, tps: null, tpsEma: null,
      lastTool: null, lastToolMs: null, lastTurnMs: null,
    };
  }

  /** Event time in ms: the event's own timestamp (ISO string, or epoch seconds on run_started) when present, else arrival time. */
  function evTime(ev) {
    const t = ev?.timestamp;
    if (typeof t === 'number' && Number.isFinite(t)) return t < 1e12 ? t * 1000 : t;
    if (typeof t === 'string') { const ms = Date.parse(t); if (!Number.isNaN(ms)) return ms; }
    return Date.now();
  }

  /** A new API request begins: run start, or the last tool result went back to Claude. */
  function paceRequestStart(run, at) {
    const p = run.pace;
    if (!p) return;
    p.requestStart = at;
    p.requests++;
    resetPaceMessage(p);
    schedulePace(run);
    evalCat();
  }
  function resetPaceMessage(p) {
    p.firstTokenAt = p.firstDeltaAt = p.lastDeltaAt = null;
    p.chars = 0; p.usageTokens = null; p.tokens = 0;
  }
  function paceFirstToken(p, now) {
    if (p.firstTokenAt != null) return;
    p.firstTokenAt = now;
    if (p.requestStart != null && p.ttftRequest !== p.requests) { // one TTFT per request, even if the API retried mid-reply
      p.ttft = Math.max(0, now - p.requestStart);
      p.ttftRequest = p.requests;
      p.ttftSum += p.ttft;
      p.ttftCount++;
    }
  }
  function paceDelta(p, delta, now) {
    paceFirstToken(p, now);
    if (p.firstDeltaAt == null) p.firstDeltaAt = now;
    p.lastDeltaAt = now;
    const piece = delta?.text ?? delta?.thinking ?? delta?.partial_json ?? '';
    p.chars += String(piece).length;
    paceRecompute(p);
  }
  /** TPOT / tokens/s for the message in flight; keeps the previous values until there is enough of it to measure. */
  function paceRecompute(p) {
    p.tokens = p.usageTokens != null ? p.usageTokens : Math.max(1, Math.round(p.chars / CHARS_PER_TOKEN));
    if (p.firstDeltaAt == null || p.lastDeltaAt == null || p.lastDeltaAt <= p.firstDeltaAt || p.tokens < 2) return;
    p.tpot = (p.lastDeltaAt - p.firstDeltaAt) / Math.max(1, p.tokens - 1);
    p.tps = 1000 / p.tpot;
    p.tpsEma = p.tpsEma == null ? p.tps : TPS_EMA_ALPHA * p.tps + (1 - TPS_EMA_ALPHA) * p.tpsEma;
  }
  function paceToolLatency(run, tool, ms) {
    const p = run.pace;
    if (!p) return;
    p.lastTool = tool.name;
    p.lastToolMs = ms;
    schedulePace(run);
  }

  function onStreamEvent(run, ev) {
    const p = run.pace;
    if (!p || ev.parent_tool_use_id) return; // replays have no deltas; subagent streams are ignored
    const inner = ev.event || {};
    const now = Date.now();
    switch (inner.type) {
      case 'message_start':
        if (p.requestStart == null) paceRequestStart(run, now); // stream joined late (no run_started seen): count it as a request
        else resetPaceMessage(p);
        if (typeof ev.ttft_ms === 'number') p.cliTtft = ev.ttft_ms; // the CLI's own measurement, shown on hover
        break;
      case 'content_block_start': paceFirstToken(p, now); break;
      case 'content_block_delta': paceDelta(p, inner.delta, now); break;
      case 'message_delta': {
        const out = inner.usage?.output_tokens;
        if (typeof out === 'number' && out > 0) { p.usageTokens = out; paceRecompute(p); }
        // The CLI sends no message_stop; message_delta (with the stop_reason) is the last event of the reply.
        if (inner.delta?.stop_reason && p.requestStart != null) p.lastTurnMs = Math.max(0, now - p.requestStart);
        break;
      }
      case 'message_stop': if (p.requestStart != null) p.lastTurnMs = Math.max(0, now - p.requestStart); break;
      default: return; // content_block_stop, ping, ...: nothing to measure
    }
    schedulePace(run);
    evalCat();
  }

  let paceScheduled = false;
  function schedulePace(run) {
    if (paceScheduled) return;
    paceScheduled = true;
    requestAnimationFrame(() => { paceScheduled = false; if (state.currentRun === run) renderPace(run); });
  }
  /** Fill the three tiles from run.pace; a run without pace data (replay, or no run at all) shows dashes. */
  function renderPace(run) {
    const p = run?.pace;
    const set = (node, text) => { if (node.textContent !== text) node.textContent = text; };
    if (!p) {
      set(paceEls.ttft, DASH); set(paceEls.ttftDesc, 'to first token'); paceEls.ttft.removeAttribute('title');
      set(paceEls.tpot, DASH); set(paceEls.tpotDesc, 'tokens/s');
      set(paceEls.latency, DASH); set(paceEls.latencyDesc, 'last tool · last turn');
      return;
    }
    set(paceEls.ttft, p.ttft != null ? fmtDur(p.ttft) : DASH);
    set(paceEls.ttftDesc, p.ttftCount > 1 ? `avg ${fmtDur(p.ttftSum / p.ttftCount)} · ${p.ttftCount} requests`
      : p.ttft != null ? 'to first token' : p.requests ? 'waiting for the first token…' : 'to first token');
    if (p.cliTtft != null) paceEls.ttft.title = `Claude Code measured ${Math.round(p.cliTtft)} ms for this message`; else paceEls.ttft.removeAttribute('title');
    set(paceEls.tpot, p.tpot != null ? `${fmtMs(p.tpot)} ms/token` : DASH);
    set(paceEls.tpotDesc, p.tpsEma != null ? `${p.tpsEma.toFixed(1)} tokens/s${p.usageTokens == null && p.tokens > 1 ? ' (est.)' : ''}` : 'tokens/s');
    set(paceEls.latency, p.lastToolMs != null ? fmtDur(p.lastToolMs) : DASH);
    const turn = p.lastTurnMs != null ? `turn ${fmtDur(p.lastTurnMs)}` : 'last turn';
    set(paceEls.latencyDesc, `${p.lastTool || 'last tool'} · ${turn}`);
  }

  let catState = null, catSpeed = null;
  function setCat(st, speed) {
    if (st !== catState) {
      catState = st;
      catEl.dataset.state = st;
      catEl.setAttribute('aria-label', `cat, ${CAT_WORD[st]}`);
      catStateEl.textContent = CAT_WORD[st];
    }
    const sp = Math.round(speed * 10) / 10; // 0.1 steps: fewer mid-stride duration changes
    if (sp !== catSpeed) { catSpeed = sp; catEl.style.setProperty('--cat-speed', String(sp)); }
  }
  /** The cat's state machine; called on every measured event and every 500 ms. */
  function evalCat() {
    const run = state.currentRun;
    const p = run && !run.finished && !run.replay ? run.pace : null;
    if (!p) { setCat('sleep', 1); return; }
    if (p.lastDeltaAt == null || Date.now() - p.lastDeltaAt > CAT_IDLE_MS) { setCat('sit', 1); return; }
    const tps = p.tpsEma ?? 0;
    setCat(tps < CAT_RUN_TPS ? 'walk' : 'run', Math.min(CAT_SPEED_MAX, Math.max(CAT_SPEED_MIN, tps / CAT_RUN_TPS)));
  }

  // ------------------------------------------------------------- run lifecycle
  /** Start a run card. opts.replay marks a turn rebuilt from a stored transcript (no live process). */
  function createRun(id, prompt, cwd, opts = {}) {
    $('#welcome')?.remove();
    const index = state.runs.length + 1;
    const run = {
      id, index, prompt, cwd,
      replay: !!opts.replay,
      status: 'running', finished: false, resultSeen: false,
      startedAt: performance.now(),
      tools: new Map(),          // tool_use id -> tool entry
      pendingThinking: new Map(), // parent_tool_use_id|'root' -> thinking card
      msgIds: new Set(),
      stderr: [],
      policy: opts.policy || null, // {max_budget_usd, tools, deny} this run was started with (null for replays)
      pace: opts.replay ? null : newPace(), // TTFT / TPOT / latency bookkeeping (replays have no stream events)
    };
    run.node = { id: `run-${id}`, kind: 'run', label: `Run ${index}: ${truncate(prompt, 48)}`, status: 'running', children: [], cardId: `run-${id}` };
    run.node.runId = id;                                        // flow model: "run:<runId>"
    run.node.startTs = Date.parse(opts.when) || Date.now();    // wall clock start (the prompt's timestamp for replays)
    state.tree.children.push(run.node);
    state.tree.status = 'running';

    run.statusEl = statusSpan('running');
    run.metaEl = el('span', { class: 'meta opacity-60', text: run.replay ? 'from transcript' : '' });
    run.policyEl = el('span', { class: 'run-policy inline-flex flex-wrap items-center gap-1' }, ...policyBadges(run.policy));
    run.turnsEl = el('span', { class: 'meta opacity-60' });
    run.timerEl = el('span', { class: `meta opacity-60 tabular-nums${run.replay ? ' when' : ' font-mono'}`, text: run.replay ? fmtWhen(opts.when) : '' });
    const head = el('header', { class: 'run-head flex flex-wrap items-center gap-2 text-xs' },
      el('span', { class: 'run-badge badge badge-neutral badge-sm', text: `Run ${index}` }), run.statusEl, run.metaEl, run.policyEl, run.turnsEl, run.timerEl);
    const user = el('div', { class: 'msg user chat chat-end' }, el('div', { class: 'bubble chat-bubble chat-bubble-primary whitespace-pre-wrap break-words', text: prompt }));
    run.stepsEl = el('div', { class: 'run-steps flex flex-col gap-2' });
    run.statsEl = el('div', { class: 'stats stats-horizontal flex-wrap bg-base-100 border border-base-300 shadow-sm' });
    run.footEl = el('footer', { class: 'run-foot flex flex-col gap-2', hidden: true }, run.statsEl);
    run.card = el('article', { class: 'run flex flex-col gap-2', id: `run-${id}` }, head, user, run.stepsEl, run.footEl);
    transcript.append(run.card);
    scrollToBottom();

    if (!run.replay) run.timer = setInterval(() => { run.timerEl.textContent = fmtDur(performance.now() - run.startedAt); }, 500);
    state.runs.push(run);
    state.currentRun = run;
    if (!run.replay) setBusy(true);
    renderPace(run);
    evalCat();
    renderTree();
    return run;
  }

  /** Latest timestamp carried by any step in a subtree (a replayed run's end when the transcript gave no duration). */
  function lastTsIn(node) {
    let last = null;
    for (const c of node.children || []) {
      for (const t of [c.ts, c.endTs, lastTsIn(c)]) if (t != null && (last == null || t > last)) last = t;
    }
    return last;
  }

  function finishRun(run, status, reason) {
    if (run.finished) return;
    run.finished = true;
    run.status = status;
    clearInterval(run.timer);
    if (!run.replay) run.timerEl.textContent = fmtDur(performance.now() - run.startedAt);
    setStatus(run.statusEl, status, reason);
    run.node.status = status;
    // Wall clock for the flow model: onResult / finishReplayTurn set these from the event; anything else ends now.
    if (run.node.endTs == null) run.node.endTs = run.replay ? (lastTsIn(run.node) ?? run.node.startTs) : Date.now();
    if (run.node.ms == null) run.node.ms = Math.max(0, run.node.endTs - run.node.startTs);
    if (reason && status !== 'completed') {
      run.statsEl.hidden = !run.statsEl.childElementCount;
      run.footEl.hidden = false;
      run.footEl.append(el('div', { class: `reason alert ${status === 'stopped' ? 'alert-warning' : 'alert-error'} alert-soft text-sm py-2` },
        el('span', { class: 'font-semibold', text: 'Why' }), el('span', { class: 'break-words', text: reason })));
    }
    // Anything still pending can no longer complete.
    for (const tool of run.tools.values()) {
      if (tool.status === 'pending') {
        setToolStatus(tool, status === 'stopped' ? 'stopped' : 'failed', 'the run ended before this tool call returned');
        // Close its wall clock too, so the flow model counts the abandoned call instead of leaving ms undefined.
        if (tool.node && tool.node.endTs == null) { tool.node.endTs = run.node.endTs; tool.node.ms = Math.max(0, run.node.endTs - (tool.node.ts ?? run.node.endTs)); }
      }
    }
    for (const t of run.pendingThinking.values()) { setStatus(t.statusEl, status === 'stopped' ? 'stopped' : 'failed'); t.node.status = status === 'stopped' ? 'stopped' : 'failed'; }
    run.pendingThinking.clear();
    state.tree.status = state.runs.some((r) => !r.finished) ? 'running' : status;
    setBusy(false);
    if (state.currentRun === run) renderPace(run); // the tiles keep the run's final numbers
    evalCat(); // back to sleep
    renderTree();
    scrollToBottom();
  }

  async function submitPrompt() {
    const prompt = promptBox.value.trim();
    if (!prompt) { promptBox.focus(); return; }
    if (state.currentRun && !state.currentRun.finished) return;
    const cwd = state.sessionCwd || cwdInput.value.trim() || state.dir.path;
    if (!cwd) { setNote('Choose a working directory first.', 'warn'); return; }
    if (state.sessionCwdMissing) { setNote(`This session's directory no longer exists (${cwd}), so it cannot be continued. Start a new session instead.`, 'warn'); return; }
    const policyProblem = policyError();
    if (policyProblem) { setNote(policyProblem, 'warn'); policyBox.open = true; return; }
    const runPolicy = currentPolicy();
    let res;
    try {
      res = await fetch('/api/run', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt, cwd, session_id: state.sessionId, policy: runPolicy }),
      });
    } catch (err) { setNote(`Could not reach the server: ${err.message}`, 'warn'); return; }
    if (!res.ok) { const body = await res.json().catch(() => ({})); setNote(body.error || `Server error ${res.status}`, 'warn'); return; }
    const { run_id } = await res.json();
    promptBox.value = '';
    setNote('');
    const run = createRun(run_id, prompt, cwd, { policy: runPolicy });
    run.es = new EventSource(`/api/stream/${run_id}`);
    run.es.onmessage = (m) => { let ev; try { ev = JSON.parse(m.data); } catch { return; } handleEvent(run, ev); };
    run.es.addEventListener('end', () => { run.es.close(); if (!run.finished) finishRun(run, 'failed', 'the event stream ended before a result arrived'); });
    run.es.onerror = () => { if (!run.finished) setNote('Connection to the server lost, retrying…', 'warn'); };
  }

  async function stopCurrentRun() {
    const run = state.currentRun;
    if (!run || run.finished) return;
    stopBtn.disabled = true;
    try { await fetch(`/api/stop/${run.id}`, { method: 'POST' }); } finally { stopBtn.disabled = false; }
  }

  /** Clear the dialogue, tree and session identity (shared by New session and loading a past session). */
  function resetConversation(welcomeText) {
    for (const r of state.runs) { r.es?.close(); clearInterval(r.timer); }
    state.runs = [];
    state.currentRun = null;
    state.sessionId = null;
    state.sessionCwd = null;
    state.sessionCwdMissing = false;
    state.tree = { id: 'root', kind: 'session', label: 'Session', status: 'idle', children: [] };
    state.graphFitPending = true;
    state.graphLayoutPending = false;
    resetSearch();
    clearFlowHighlight(); // a legend focus or node selection must not survive into the next session
    if (cy) { cy.elements().remove(); hideTip(); }
    transcript.replaceChildren(el('div', { id: 'welcome', class: 'empty text-sm opacity-60', text: welcomeText }));
    updateSessionBadge();
    setNote('');
    renderPace(null);
    evalCat();
    renderTree();
  }

  function newSession() {
    if (state.currentRun && !state.currentRun.finished) return;
    resetConversation('New session. Pick a working directory and run a prompt.');
    setDirPickerDisabled(false);
  }

  // -------------------------------------------------------- previous sessions
  let sessionsCache = [];

  function fmtWhen(iso) {
    if (!iso) return '';
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return String(iso);
    return d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  }

  async function openSessions() {
    if (state.currentRun && !state.currentRun.finished) return;
    sessionsFilter.value = '';
    if (!sessionsDialog.open) sessionsDialog.showModal();
    await refreshSessions();
    sessionsFilter.focus();
  }

  let sessionsReq = 0; // overlapping refreshes (dialog opened, then "all directories" ticked) must not let a stale response land
  async function refreshSessions() {
    const reqId = ++sessionsReq;
    const scopePath = state.sessionCwd || state.dir.path || '';
    const all = sessionsAll.checked;
    sessionsScope.textContent = 'Loading…';
    sessionsList.replaceChildren();
    let data;
    try {
      const res = await fetch(`/api/sessions?all=${all ? 1 : 0}&path=${encodeURIComponent(scopePath)}`);
      data = await res.json();
      if (reqId !== sessionsReq) return; // a newer refresh superseded this one
      if (!res.ok) throw new Error(data.error || res.statusText);
    } catch (err) { if (reqId === sessionsReq) sessionsScope.textContent = `Could not list sessions: ${err.message}`; return; }
    sessionsCache = data.sessions || [];
    const n = sessionsCache.length;
    sessionsScope.textContent = all
      ? `${n} session${n === 1 ? '' : 's'} across all directories (from ${data.store})`
      : `${n} session${n === 1 ? '' : 's'} whose working directory is ${scopePath}`;
    renderSessionRows();
  }

  function renderSessionRows() {
    const q = sessionsFilter.value.trim().toLowerCase();
    const rows = sessionsCache.filter((s) => !q || `${s.title || ''} ${s.first_prompt || ''} ${s.cwd || ''} ${s.session_id}`.toLowerCase().includes(q));
    sessionsList.replaceChildren(...rows.map((s) => {
      const current = s.session_id === state.sessionId;
      const meta = el('div', { class: 's-meta flex flex-wrap items-center gap-1.5 text-xs opacity-70 mt-1' },
        el('span', { class: 'cwd font-mono', text: shortPath(s.cwd), title: s.cwd || '' }),
        el('span', { class: 'badge badge-ghost badge-xs', text: fmtWhen(s.modified) }),
        el('span', { class: 'badge badge-ghost badge-xs', text: `${s.prompts} prompt${s.prompts === 1 ? '' : 's'} · ${s.assistant_messages} turn${s.assistant_messages === 1 ? '' : 's'}` }),
        s.subagents ? el('span', { class: 'badge badge-secondary badge-soft badge-xs', text: `${s.subagents} subagent${s.subagents === 1 ? '' : 's'}` }) : null,
        s.cost_usd != null ? el('span', { class: 'badge badge-ghost badge-xs', text: fmtCost(s.cost_usd) }) : null,
        s.continued_in ? el('span', { class: 'badge badge-warning badge-soft badge-xs', text: 'continued later' }) : null);
      const row = el('li', {
        class: `session-row list-row items-center cursor-pointer rounded-box hover:bg-base-200 focus:bg-base-200 outline-none${current ? ' current ring-1 ring-primary' : ''}`,
        role: 'button', tabindex: '0', title: s.first_prompt || '',
      },
        el('div', { class: 'list-col-grow min-w-0' }, el('div', { class: 's-title font-semibold truncate', text: s.title || '(untitled)' }), meta),
        el('div', { class: 's-id font-mono text-[11px] opacity-50', text: s.session_id.slice(0, 8), title: s.session_id }),
        el('span', { class: 'btn btn-ghost btn-xs', text: current ? 'current' : 'open' }));
      const go = () => { sessionsDialog.close(); loadSession(s); };
      row.addEventListener('click', go);
      row.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); go(); } });
      return row;
    }));
    if (!rows.length) {
      sessionsList.append(el('li', { class: 'empty p-4 text-sm opacity-60', text: q ? 'No sessions match the filter.' : 'No sessions for this directory yet. Tick "all directories" to see every session on this machine.' }));
    }
  }

  /** Rebuild a past session in the dialogue and tree, then make it the active session for follow-ups. */
  async function loadSession(s) {
    if (state.currentRun && !state.currentRun.finished) return;
    setNote(`Loading session ${s.session_id.slice(0, 8)}…`);
    let data;
    try {
      const res = await fetch(`/api/sessions/${encodeURIComponent(s.session_id)}`);
      data = await res.json();
      if (!res.ok) throw new Error(data.error || res.statusText);
    } catch (err) { setNote(`Could not load session: ${err.message}`, 'warn'); return; }

    resetConversation('');
    state.sessionId = data.session_id;
    state.sessionCwd = data.cwd || s.cwd || state.dir.path;
    if (state.sessionCwd) {
      const exists = await browseTo(state.sessionCwd, { remember: true });
      if (!exists) { state.sessionCwdMissing = true; cwdInput.value = state.sessionCwd; cwdInput.title = state.sessionCwd; }
    }
    updateSessionBadge();

    let run = null;
    let prompts = 0;
    for (const ev of data.events) {
      if (ev.type === 'replay_prompt') {
        prompts++;
        run = createRun(`${data.session_id}-${prompts}`, ev.text, state.sessionCwd, { replay: true, when: ev.timestamp });
        continue;
      }
      if (!run) continue;
      if (ev.type === 'replay_turn_end') { finishReplayTurn(run, ev); continue; }
      handleEvent(run, ev);
    }
    if (run && !run.finished) finishReplayTurn(run, {});
    $('#welcome')?.remove();
    state.graphFitPending = true;
    renderTree();
    scrollToBottom();
    const first = data.events.find((e) => e.type === 'replay_prompt');
    const bits = [`Loaded ${prompts} prompt${prompts === 1 ? '' : 's'} from “${data.title || data.session_id.slice(0, 8)}”`];
    if (first?.timestamp) bits.push(`started ${fmtWhen(first.timestamp)}`);
    if (data.cost_usd != null) bits.push(`${fmtCost(data.cost_usd)} so far`);
    if (state.sessionCwdMissing) {
      setNote(`${bits.join(' · ')}. Its directory no longer exists, so it can be reviewed but not continued.`, 'warn');
    } else {
      setNote(`${bits.join(' · ')}. Your next prompt continues this session.`);
    }
    promptBox.focus();
  }

  function finishReplayTurn(run, ev) {
    const stats = [];
    if (ev.assistant_messages != null) stats.push(['Turns', String(ev.assistant_messages)]);
    if (ev.duration_ms != null) stats.push(['Duration', fmtDur(ev.duration_ms)]);
    if (ev.output_tokens != null) stats.push(['Tokens', `${ev.output_tokens.toLocaleString()} out · ${(ev.context_tokens || 0).toLocaleString()} context`]);
    if (ev.thinking_tokens) stats.push(['Thinking', `${ev.thinking_tokens.toLocaleString()} tokens`]);
    if (stats.length) renderStats(run, stats);
    const turnsLabel = ev.assistant_messages != null ? ` · ${ev.assistant_messages} turns` : '';
    run.node.endTs = Date.parse(ev.ended) || lastTsIn(run.node) || run.node.startTs;
    run.node.children.push({ id: `n-${nextUid()}`, kind: 'result', status: 'completed', children: [], cardId: run.card.id, label: `Completed${turnsLabel}${ev.duration_ms != null ? ' · ' + fmtDur(ev.duration_ms) : ''}`, ts: run.node.endTs });
    run.node.ms = ev.duration_ms ?? Math.max(0, run.node.endTs - run.node.startTs);
    finishRun(run, 'completed', null);
  }

  // ---------------------------------------------------------- event dispatch
  function handleEvent(run, ev) {
    switch (ev.type) {
      case 'run_started': onRunStarted(run, ev); break;
      case 'system': onSystem(run, ev); break;
      case 'assistant': onAssistant(run, ev); break;
      case 'user': onUser(run, ev); break;
      case 'result': onResult(run, ev); break;
      case 'stderr': run.stderr.push(ev.text); addSystemLine(run, null, 'stderr', ev.text, 'warn'); break;
      case 'stdout': addSystemLine(run, null, 'output', ev.text, 'muted'); break;
      case 'run_exit': onRunExit(run, ev); break;
      case 'stream_event': onStreamEvent(run, ev); return; // token deltas feed the pace strip only; no dialogue content, no graph redraw
      case 'tool_progress': onToolProgress(run, ev); break;
      default: addSystemLine(run, ev.parent_tool_use_id, humanize(ev.type), summarizeScalars(ev), 'muted');
    }
    renderTree();
  }

  /** Where a step belongs: under the Agent tool call that spawned it, or at the run root. */
  function containerFor(run, parentToolUseId) {
    if (parentToolUseId) {
      const t = run.tools.get(parentToolUseId);
      if (t) return { host: t.childrenEl, node: t.node };
    }
    return { host: run.stepsEl, node: run.node };
  }

  function onRunStarted(run, ev) {
    paceRequestStart(run, evTime(ev)); // the first API request starts with the process
    run.metaEl.textContent = ev.resume ? 'continuing session' : 'new session';
    run.metaEl.title = (ev.command || []).join(' ');
    if (ev.policy && typeof ev.policy === 'object') { // the server's effective policy wins over what we sent
      run.policy = ev.policy;
      run.policyEl.replaceChildren(...policyBadges(ev.policy));
    }
    const bits = [`in ${ev.cwd}`];
    if (ev.resume) bits.push('--resume ' + ev.resume.slice(0, 8) + '…');
    bits.push(...policyParts(run.policy || {}));
    addSystemLine(run, null, 'Started claude', bits.join(' · '), 'muted');
  }

  function onSystem(run, ev) {
    const st = ev.subtype;
    const parent = ev.parent_tool_use_id;
    switch (st) {
      case 'init':
        state.sessionId = ev.session_id;
        state.sessionCwd = ev.cwd;
        updateSessionBadge();
        mergeKnownTools(ev.tools); // learn built-in tool names the policy grid did not list
        addSystemLine(run, null, 'Session ready', `${ev.model} · ${ev.permissionMode} · ${(ev.tools || []).length} tools · ${(ev.mcp_servers || []).length} MCP servers · ${(ev.agents || []).length} agent types`, 'info');
        break;
      case 'hook_started': addSystemLine(run, parent, 'Hook started', ev.hook_name, 'muted'); break;
      case 'hook_progress': addSystemLine(run, parent, 'Hook output', `${ev.hook_name || ''} ${ev.output || ev.stdout || ''}`.trim(), 'muted'); break;
      case 'hook_response':
        addSystemLine(run, parent, 'Hook finished', `${ev.hook_name} · exit ${ev.exit_code} · ${ev.outcome}${ev.stderr ? ' · ' + firstLine(ev.stderr) : ''}`, ev.exit_code === 0 ? 'muted' : 'warn');
        break;
      case 'thinking_tokens': onThinkingTokens(run, ev); break;
      case 'compact_boundary': addSystemLine(run, parent, 'Context compacted', 'earlier conversation was summarized to free context', 'info', { tree: true, divider: true, ts: evTime(ev) }); break;
      case 'permission_denied': addSystemLine(run, parent, 'Permission denied', summarizeScalars(ev) || 'a tool call was refused', 'warn', { tree: true, ts: evTime(ev) }); break;
      case 'permission_retry': addSystemLine(run, parent, 'Retrying after denial', summarizeScalars(ev), 'muted'); break;
      case 'api_error': addSystemLine(run, parent, 'API error', summarizeScalars(ev), 'warn', { tree: true, ts: evTime(ev) }); break;
      case 'api_retry': addSystemLine(run, parent, 'API retry', summarizeScalars(ev), 'warn'); break;
      case 'model_fallback': case 'model_consent_fallback': case 'model_refusal_fallback': case 'model_refusal_no_fallback':
        addSystemLine(run, parent, humanize(st), summarizeScalars(ev), 'warn', { tree: true, ts: evTime(ev) }); break;
      case 'task_started': case 'task_progress': case 'task_notification': case 'task_updated': case 'task_summary':
        onTaskEvent(run, ev); break;
      case 'memory_recall': case 'memory_saved':
        addSystemLine(run, parent, humanize(st), summarizeScalars(ev), 'muted'); break;
      case 'turn_starting': case 'turn_duration': case 'status': case 'informational': case 'notification': case 'session_state_changed':
      case 'background_tasks_changed': case 'stop_hook_summary': case 'post_turn_summary': case 'local_command': case 'commands_changed':
      case 'vcs_state_changed': case 'file_snapshot':
        break; // low-value housekeeping: keep the dialogue readable
      default:
        addSystemLine(run, parent, humanize(st), summarizeScalars(ev), 'muted');
    }
  }

  /** Background-task events describe a subagent's progress: show them on its card, not as separate lines. */
  function onTaskEvent(run, ev) {
    const tool = ev.tool_use_id ? run.tools.get(ev.tool_use_id) : null;
    if (tool) {
      if (tool.status !== 'pending') { tool.progressEl.textContent = ''; return; }
      if (ev.subtype === 'task_notification') tool.progressEl.textContent = ev.status && ev.status !== 'completed' ? humanize(ev.status) : '';
      else if (ev.description) tool.progressEl.textContent = ev.description;
      return;
    }
    if (ev.subtype === 'task_progress' || ev.subtype === 'task_updated') return; // too chatty with nothing to attach to
    addSystemLine(run, ev.parent_tool_use_id, humanize(ev.subtype).replace('Task', 'Background task'), ev.description || ev.summary || summarizeScalars(ev), 'info');
  }

  function addSystemLine(run, parentId, title, detail, tone = 'muted', opts = {}) {
    const { host, node } = containerFor(run, parentId);
    const uid = nextUid();
    let line;
    if (opts.divider) {
      line = el('div', { class: `sysline tone-${tone} divider ${tone === 'warn' ? 'divider-error' : 'divider-info'} text-xs my-1`, id: `c-${uid}`, title: detail || '', text: detail ? `${title} · ${detail}` : title });
    } else {
      const toneCls = tone === 'warn' ? 'text-error' : tone === 'info' ? 'opacity-90' : 'opacity-60';
      line = el('div', { class: `sysline tone-${tone} flex items-baseline gap-2 text-xs px-1 ${toneCls}`, id: `c-${uid}`, title: detail || '' },
        el('span', { class: 'glyph', text: tone === 'warn' ? '⚠' : 'ⓘ' }),
        el('span', { class: `sys-title font-semibold whitespace-nowrap${tone === 'info' ? ' text-info' : ''}`, text: title }),
        detail ? el('span', { class: tone === 'warn' ? 'sys-detail min-w-0 whitespace-pre-wrap break-words' : 'sys-detail min-w-0 truncate', text: detail }) : null);
    }
    host.append(line);
    scrollToBottom();
    if (opts.tree) { // opts.treeLabel overrides the node label (the flow model looks for the exact label "Subagent prompt"); opts.ts is the event time
      node.children.push({ id: `n-${uid}`, kind: 'system', label: opts.treeLabel || `${title}${detail ? ': ' + truncate(detail, 40) : ''}`, status: tone === 'warn' ? 'failed' : 'idle', children: [], cardId: `c-${uid}`, ts: opts.ts ?? Date.now() });
    }
  }

  // ---------------------------------------------------------------- thinking
  function thinkingKey(ev) { return ev.parent_tool_use_id || 'root'; }
  /** `ev` is the event that revealed the thinking (thinking_tokens or the assistant message): it dates the step and, for assistant messages, names its API turn. */
  function createThinkingCard(run, parentId, ev) {
    const { host, node } = containerFor(run, parentId);
    const uid = nextUid();
    const t = { uid, tokens: 0 };
    t.statusEl = statusSpan('pending');
    t.tokenEl = el('span', { class: 'meta text-xs opacity-60' });
    t.bodyEl = el('div', { class: 'card-body p-3 pt-0 gap-2', hidden: true });
    t.card = el('div', { class: 'card thinking card-border bg-base-100 border-l-4 border-l-neutral', id: `c-${uid}` },
      el('div', { class: 'card-head flex flex-wrap items-center gap-2 px-3 py-2' },
        el('span', { class: 'glyph opacity-60', text: KIND_GLYPH.thinking }),
        el('span', { class: 'title badge badge-sm badge-neutral badge-soft font-semibold', text: 'Thinking' }),
        el('span', { class: 'summary text-sm opacity-70 flex-1 min-w-0 truncate' }), t.tokenEl, t.statusEl),
      t.bodyEl);
    host.append(t.card);
    t.node = { id: `n-${uid}`, kind: 'thinking', label: 'Thinking', status: 'pending', children: [], cardId: `c-${uid}`, ts: Date.parse(ev?.timestamp) || Date.now(), msgId: ev?.message?.id };
    node.children.push(t.node);
    scrollToBottom();
    return t;
  }
  function onThinkingTokens(run, ev) {
    const key = thinkingKey(ev);
    let t = run.pendingThinking.get(key);
    if (!t) { t = createThinkingCard(run, ev.parent_tool_use_id, ev); run.pendingThinking.set(key, t); }
    t.tokens = ev.estimated_tokens ?? t.tokens;
    t.tokenEl.textContent = `≈${t.tokens} tokens`;
    t.node.label = `Thinking · ≈${t.tokens} tokens`;
  }
  function finalizeThinking(run, ev, block) {
    const key = thinkingKey(ev);
    let t = run.pendingThinking.get(key);
    if (!t) t = createThinkingCard(run, ev.parent_tool_use_id, ev);
    run.pendingThinking.delete(key);
    setStatus(t.statusEl, 'completed');
    t.node.status = 'completed';
    if (ev.message?.id) t.node.msgId = ev.message.id; // a card opened by thinking_tokens learns its API turn here
    if (t.node.ts == null) t.node.ts = Date.parse(ev.timestamp) || Date.now();
    const text = block.type === 'thinking' ? (block.thinking || '') : '';
    if (text.trim()) {
      t.bodyEl.hidden = false;
      t.bodyEl.replaceChildren(el('details', { class: 'fold' }, el('summary', { text: 'show reasoning' }), renderMarkdown(text)));
    } else {
      t.card.querySelector('.summary').textContent = 'reasoning content is redacted by the API';
    }
    if (!t.tokens) { t.tokenEl.textContent = ''; }
    t.node.label = t.tokens ? `Thinking · ≈${t.tokens} tokens` : 'Thinking';
  }

  // --------------------------------------------------------------- assistant
  function onAssistant(run, ev) {
    const msg = ev.message || {};
    if (msg.id && !ev.parent_tool_use_id) { run.msgIds.add(msg.id); run.turnsEl.textContent = `${run.msgIds.size} API turn${run.msgIds.size === 1 ? '' : 's'}`; }
    for (const block of msg.content || []) {
      if (block.type === 'text') { if (block.text && block.text.trim()) addAssistantText(run, ev, block.text); }
      else if (block.type === 'thinking' || block.type === 'redacted_thinking') finalizeThinking(run, ev, block);
      else if (block.type === 'tool_use') addToolCall(run, ev, block);
    }
  }

  function addAssistantText(run, ev, text) {
    const { host, node } = containerFor(run, ev.parent_tool_use_id);
    const uid = nextUid();
    host.append(el('div', { class: 'msg assistant chat chat-start', id: `c-${uid}` }, el('div', { class: 'bubble chat-bubble max-w-[92%] break-words' }, renderMarkdown(text))));
    node.children.push({ id: `n-${uid}`, kind: 'text', label: truncate(text, 60), status: 'idle', children: [], cardId: `c-${uid}`, ts: Date.parse(ev.timestamp) || Date.now(), msgId: ev.message?.id });
    scrollToBottom();
  }

  // -------------------------------------------------------------- tool calls
  function bodyOf(...parts) {
    const kept = parts.filter(Boolean);
    return kept.length ? el('div', { class: 'card-body p-3 pt-0 gap-2' }, ...kept) : null;
  }
  function kv(pairs) {
    const tbody = el('tbody');
    for (const [k, v] of pairs) {
      if (v == null || v === '') continue;
      tbody.append(el('tr', {}, el('th', { class: 'opacity-60 whitespace-nowrap w-28', text: k }), el('td', { class: 'break-all', text: String(v) })));
    }
    return tbody.childElementCount ? el('table', { class: 'kv table table-xs' }, tbody) : null;
  }
  const pre = (s, cls = '') => el('pre', { class: `code ${cls}`.trim(), text: s ?? '' });
  const fold = (label, content) => el('details', { class: 'fold collapse collapse-arrow bg-base-200 rounded-box' },
    el('summary', { class: 'collapse-title text-xs min-h-0 py-2 pr-8', text: label }),
    el('div', { class: 'collapse-content px-2 pb-2' }, content));
  function renderStats(run, stats) {
    run.statsEl.replaceChildren(...stats.map(([k, v]) => el('div', { class: 'stat px-4 py-2' },
      el('div', { class: 'stat-title text-xs', text: k }), el('div', { class: 'stat-value text-base font-semibold', text: v }))));
    run.statsEl.hidden = !stats.length;
    run.footEl.hidden = false;
  }

  /** Human summary + detail body for a tool call, by tool name. */
  function describeTool(name, input) {
    switch (name) {
      case 'Bash': return { summary: input.description || firstLine(input.command), body: bodyOf(pre(input.command || '')) };
      case 'Read': return { summary: shortPath(input.file_path), body: bodyOf(kv([['file', input.file_path], ['offset', input.offset], ['limit', input.limit]])) };
      case 'Write': return { summary: shortPath(input.file_path), body: bodyOf(kv([['file', input.file_path], ['size', `${(input.content || '').length} chars`]]), fold('content', pre(input.content || ''))) };
      case 'Edit': return { summary: shortPath(input.file_path), body: bodyOf(kv([['file', input.file_path], ['replace all', input.replace_all ? 'yes' : null]]), el('div', { class: 'edit-diff flex flex-col gap-1' }, pre(input.old_string || '', 'del'), pre(input.new_string || '', 'add'))) };
      case 'NotebookEdit': return { summary: shortPath(input.notebook_path), body: bodyOf(kv([['notebook', input.notebook_path], ['cell', input.cell_id], ['mode', input.edit_mode]]), fold('source', pre(input.new_source || ''))) };
      case 'Glob': return { summary: input.pattern, body: bodyOf(kv([['pattern', input.pattern], ['path', input.path]])) };
      case 'Grep': return { summary: input.pattern, body: bodyOf(kv([['pattern', input.pattern], ['path', input.path], ['glob', input.glob], ['mode', input.output_mode]])) };
      case 'WebSearch': return { summary: input.query, body: null };
      case 'WebFetch': return { summary: input.url, body: bodyOf(kv([['url', input.url], ['prompt', input.prompt]])) };
      case 'Agent': case 'Task':
        return { summary: `${input.subagent_type || 'general-purpose'} · ${input.description || ''}`, body: bodyOf(kv([['type', input.subagent_type || 'general-purpose'], ['model', input.model], ['background', input.run_in_background ? 'yes' : null], ['isolation', input.isolation]]), fold('prompt', pre(input.prompt || ''))) };
      case 'Skill': return { summary: `/${input.skill}${input.args ? ' ' + input.args : ''}`, body: null };
      case 'AskUserQuestion': return { summary: input.questions?.[0]?.question || 'question for the user', body: bodyOf(el('ul', { class: 'list-disc pl-5 text-sm' }, ...(input.questions || []).map((q) => el('li', { text: q.question })))) };
      case 'TodoWrite': {
        const todos = input.todos || [];
        const done = todos.filter((t) => t.status === 'completed').length;
        return { summary: `${done}/${todos.length} todos completed`, body: bodyOf(el('ul', { class: 'todos' }, ...todos.map((t) => el('li', { class: `todo ${t.status}`, text: `${t.status === 'completed' ? '✓' : t.status === 'in_progress' ? '◔' : '○'} ${t.content}` })))) };
      }
      case 'TaskCreate': return { summary: input.subject, body: bodyOf(kv([['description', input.description]])) };
      case 'TaskUpdate': return { summary: `task ${input.taskId ?? ''} → ${input.status || 'updated'}`, body: null };
      case 'TaskList': case 'TaskGet': return { summary: input.taskId ? `task ${input.taskId}` : 'task list', body: null };
      case 'EnterPlanMode': return { summary: 'entering plan mode', body: null };
      case 'ExitPlanMode': return { summary: 'plan ready for review', body: input.plan ? bodyOf(fold('plan', renderMarkdown(input.plan))) : null };
      case 'SendMessage': return { summary: `to ${input.to || input.recipient || 'agent'}`, body: bodyOf(pre(input.message || input.content || '')) };
      case 'ToolSearch': return { summary: input.query, body: null };
      case 'EnterWorktree': case 'ExitWorktree': return { summary: input.name || input.action || name, body: null };
      default: {
        const scalars = Object.entries(input).filter(([, v]) => typeof v !== 'object').slice(0, 6);
        if (name.startsWith('mcp__')) {
          const [, server, ...rest] = name.split('__');
          return { summary: `${server} · ${rest.join('__')}`, body: bodyOf(kv(scalars)) };
        }
        const firstStr = Object.values(input).find((v) => typeof v === 'string');
        return { summary: firstStr ? truncate(firstStr, 80) : Object.keys(input).join(', '), body: bodyOf(kv(scalars)) };
      }
    }
  }

  function addToolCall(run, ev, block) {
    const { host, node } = containerFor(run, ev.parent_tool_use_id);
    const name = block.name || 'tool';
    const isAgent = name === 'Agent' || name === 'Task';
    const uid = nextUid();
    const { summary, body } = describeTool(name, block.input || {});
    const tool = { id: block.id, name, uid, isAgent, status: 'pending', startedAt: Date.parse(ev.timestamp) || Date.now() };
    tool.statusEl = statusSpan('pending');
    tool.durEl = el('span', { class: 'meta dur text-xs opacity-60 tabular-nums' });
    tool.progressEl = el('span', { class: 'tool-progress basis-full text-xs text-warning truncate' });
    tool.resultEl = el('div', { class: 'card-result px-3 pb-3', hidden: true });
    tool.childrenEl = el('div', { class: 'children flex flex-col gap-2 mx-3 mb-3 ml-6 pl-3 border-l-2 border-base-300' });
    tool.card = el('div', { class: `card tool card-border bg-base-100 border-l-4 ${isAgent ? 'agent border-l-secondary' : 'border-l-accent'}`, id: `c-${uid}`, 'data-status': 'pending' },
      el('div', { class: 'card-head flex flex-wrap items-center gap-2 px-3 py-2' },
        el('span', { class: `glyph ${isAgent ? 'text-secondary' : 'text-accent'}`, text: isAgent ? KIND_GLYPH.agent : KIND_GLYPH.tool }),
        el('span', { class: `title badge badge-sm badge-soft font-semibold ${isAgent ? 'badge-secondary' : 'badge-accent'}`, text: isAgent ? 'Subagent' : name }),
        el('span', { class: 'summary text-sm opacity-80 flex-1 min-w-0 truncate', text: summary || '', title: summary || '' }),
        tool.durEl, tool.statusEl, tool.progressEl),
      body, tool.resultEl, tool.childrenEl);
    host.append(tool.card);
    tool.node = { id: `n-${uid}`, kind: isAgent ? 'agent' : 'tool', label: `${isAgent ? 'Subagent' : name}: ${truncate(summary, 40)}`, status: 'pending', children: [], cardId: `c-${uid}`,
      ts: tool.startedAt, msgId: ev.message?.id, name, toolUseId: block.id }; // flow model: action time, API turn, tool name, "actor:<toolUseId>" for agents
    if (isAgent) { const input = block.input || {}; tool.node.agentType = input.subagent_type || 'general-purpose'; tool.node.description = input.description || ''; }
    node.children.push(tool.node);
    run.tools.set(block.id, tool);
    scrollToBottom();
  }

  function setToolStatus(tool, status, reason) {
    tool.status = status;
    tool.progressEl.textContent = '';
    setStatus(tool.statusEl, status, reason);
    tool.card.dataset.status = status;
    tool.node.status = status;
    if (reason && status !== 'completed') {
      tool.resultEl.hidden = false;
      tool.resultEl.prepend(el('div', { class: 'reason text-error text-sm mb-1 break-words', text: `✕ ${reason}` }));
    }
  }

  function onToolProgress(run, ev) {
    const tool = run.tools.get(ev.tool_use_id);
    if (!tool) return;
    tool.durEl.textContent = ev.elapsed_time_seconds != null ? `${Math.round(ev.elapsed_time_seconds)} s` : fmtDur(Date.now() - tool.startedAt);
  }

  // --------------------------------------------------------------- tool results
  function onUser(run, ev) {
    const content = ev.message?.content;
    const blocks = typeof content === 'string' ? [{ type: 'text', text: content }] : (content || []);
    let sawResult = false;
    for (const block of blocks) {
      if (block.type === 'tool_result') { onToolResult(run, ev, block); sawResult = true; }
      else if (block.type === 'text' && block.text) {
        // A subagent's prompt also becomes a tree step so the subagent lane has a start mark for the flow model
        // (kept out of the Cytoscape graph by walkChain); the run-level "Input to Claude" line stays dialogue-only.
        if (ev.parent_tool_use_id) addSystemLine(run, ev.parent_tool_use_id, 'Subagent prompt', block.text, 'muted', { tree: true, treeLabel: 'Subagent prompt', ts: evTime(ev) });
        else addSystemLine(run, null, 'Input to Claude', block.text, 'muted');
      }
    }
    if (sawResult && !ev.parent_tool_use_id) paceRequestStart(run, evTime(ev)); // Claude now calls the API again
  }

  function onToolResult(run, ev, block) {
    const tool = run.tools.get(block.tool_use_id);
    const text = extractText(block.content);
    if (!tool) { addSystemLine(run, ev.parent_tool_use_id, 'Tool result', text, 'muted'); return; }
    const failed = !!block.is_error;
    const endedAt = Date.parse(ev.timestamp) || Date.now();
    tool.node.endTs = endedAt;
    tool.node.ms = Math.max(0, endedAt - tool.startedAt);
    tool.durEl.textContent = fmtDur(endedAt - tool.startedAt);
    paceToolLatency(run, tool, Math.max(0, endedAt - tool.startedAt));
    setToolStatus(tool, failed ? 'failed' : 'completed', failed ? (firstLine(text) || 'the tool reported an error') : null);
    renderToolResult(tool, text, ev.tool_use_result, failed);
    scrollToBottom();
  }

  function limitedPre(text, cls) {
    const LIMIT = 1500;
    if (text.length <= LIMIT) return pre(text, cls);
    const wrap = el('div');
    const p = pre(text.slice(0, LIMIT) + '\n…', cls);
    const btn = el('button', { class: 'show-more btn btn-xs btn-ghost mt-1', type: 'button', text: `Show all (${text.length.toLocaleString()} chars)` });
    btn.addEventListener('click', () => { p.textContent = text; btn.remove(); });
    wrap.append(p, btn);
    return wrap;
  }

  function renderToolResult(tool, text, structured, failed) {
    tool.resultEl.hidden = false;
    if (tool.isAgent) {
      const s = structured && typeof structured === 'object' ? structured : {};
      const bits = [];
      if (s.status) bits.push(s.status.replace('_', ' '));
      if (s.totalToolUseCount != null) bits.push(`${s.totalToolUseCount} tool calls`);
      if (s.totalDurationMs != null) bits.push(fmtDur(s.totalDurationMs));
      if (s.totalTokens != null) bits.push(`${s.totalTokens.toLocaleString()} tokens`);
      if (s.agentType) bits.push(s.agentType);
      if (bits.length) tool.resultEl.append(el('div', { class: 'agent-summary text-xs opacity-70 mb-1', text: bits.join(' · ') }));
      tool.resultEl.append(el('div', { class: 'result-label text-[11px] uppercase tracking-wide opacity-60 mb-1', text: 'Subagent report' }));
      tool.resultEl.append(text.trim() ? renderMarkdown(text) : el('div', { class: 'meta text-xs opacity-60', text: '(no text returned)' }));
      return;
    }
    tool.resultEl.append(el('div', { class: 'result-label text-[11px] uppercase tracking-wide opacity-60 mb-1', text: failed ? 'Error' : 'Result' }));
    if (text.trim()) tool.resultEl.append(limitedPre(text, failed ? 'error' : ''));
    else tool.resultEl.append(el('div', { class: 'meta text-xs opacity-60', text: '(no output)' }));
    if (structured && typeof structured === 'object') {
      if (structured.stderr && !failed) tool.resultEl.append(el('div', { class: 'result-label text-[11px] uppercase tracking-wide opacity-60 mb-1 mt-2', text: 'stderr' }), limitedPre(structured.stderr, 'muted'));
      if (structured.interrupted) tool.resultEl.append(el('div', { class: 'reason text-error text-sm mt-1', text: '✕ interrupted' }));
    }
  }

  // ----------------------------------------------------------------- results
  function describeResultFailure(ev, run) {
    let errors = Array.isArray(ev.errors) ? ev.errors.map(String) : [];
    // The cap comes from the run's policy; fall back to the amount Claude quotes ("Reached maximum budget ($0.01)").
    let cap = run?.policy?.max_budget_usd;
    if (cap == null) { const m = /\$\s*([\d.]+)/.exec(errors.join(' ')); if (m) cap = Number(m[1]); }
    const reasons = {
      error_max_turns: 'hit the maximum number of turns',
      error_max_budget_usd: cap != null && Number.isFinite(cap) ? `hit the cost budget (${fmtCap(cap)})` : 'hit the cost budget',
      error_during_execution: 'error during execution',
      error_max_structured_output_retries: 'could not produce valid structured output',
    };
    const parts = [];
    if (ev.subtype && ev.subtype !== 'success') parts.push(reasons[ev.subtype] || humanize(ev.subtype));
    if (ev.subtype === 'error_max_budget_usd') errors = errors.filter((e) => !/maximum budget/i.test(e)); // already said above
    if (errors.length) parts.push(errors.join('; '));
    if (ev.api_error_status) parts.push(`API status ${ev.api_error_status}`);
    if (!parts.length && ev.is_error && typeof ev.result === 'string') parts.push(firstLine(ev.result));
    return parts.join(' — ') || 'unknown error';
  }

  function onResult(run, ev) {
    run.resultSeen = true;
    if (ev.session_id) { state.sessionId = ev.session_id; updateSessionBadge(); }
    const ok = ev.subtype === 'success' && !ev.is_error;
    const reason = ok ? null : describeResultFailure(ev, run);
    const stats = [
      ['Cost', fmtCost(ev.total_cost_usd)],
      ['Duration', fmtDur(ev.duration_ms)],
      ['API time', fmtDur(ev.duration_api_ms)],
      ['Turns', String(ev.num_turns ?? run.msgIds.size)],
    ];
    const u = ev.usage || {};
    let outTokens = u.output_tokens != null ? u.output_tokens : null;
    let inTokens = (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0);
    if (!outTokens && !inTokens && ev.modelUsage && typeof ev.modelUsage === 'object') {
      // Budget-capped results (error_max_budget_usd) zero out `usage`; the per-model breakdown still has the real counts.
      outTokens = 0; inTokens = 0;
      for (const m of Object.values(ev.modelUsage)) {
        if (!m || typeof m !== 'object') continue;
        outTokens += m.outputTokens || 0;
        inTokens += (m.inputTokens || 0) + (m.cacheReadInputTokens || 0) + (m.cacheCreationInputTokens || 0);
      }
    }
    if (outTokens != null) stats.push(['Tokens', `${outTokens.toLocaleString()} out · ${inTokens.toLocaleString()} in`]);
    if (ev.subagent_stats?.spawned) stats.push(['Subagents', String(ev.subagent_stats.spawned)]);
    if (Array.isArray(ev.permission_denials) && ev.permission_denials.length) stats.push(['Permission denials', String(ev.permission_denials.length)]);
    const p = run.pace; // the pace tiles' final values, when the run streamed anything
    if (p?.ttft != null) stats.push(['TTFT', fmtDur(p.ttft)]);
    if (p?.tpot != null) stats.push(['TPOT', `${fmtMs(p.tpot)} ms/token`]);
    renderStats(run, stats);
    const endTs = evTime(ev);
    run.node.children.push({
      id: `n-${nextUid()}`, kind: 'result', status: ok ? 'completed' : 'failed', children: [], cardId: run.card.id,
      label: `${ok ? 'Completed' : 'Failed'} · ${fmtCost(ev.total_cost_usd)} · ${fmtDur(ev.duration_ms)} · ${ev.num_turns} turns`, ts: endTs,
    });
    run.node.endTs = endTs;
    run.node.ms = ev.duration_ms ?? Math.max(0, endTs - run.node.startTs);
    finishRun(run, ok ? 'completed' : 'failed', reason);
  }

  function onRunExit(run, ev) {
    if (ev.error) { finishRun(run, 'failed', ev.error); return; }
    if (run.finished) {
      if (ev.exit_code !== 0 && !ev.stopped) addSystemLine(run, null, 'Process exited', `code ${ev.exit_code}`, 'warn');
      return;
    }
    if (ev.stopped) { finishRun(run, 'stopped', 'stopped by you'); return; }
    const tail = (ev.stderr_tail || []).slice(-3).join(' | ');
    if (ev.exit_code !== 0) finishRun(run, 'failed', `claude exited with code ${ev.exit_code}${tail ? ': ' + tail : ''}`);
    else finishRun(run, 'completed', null);
    if (ev.exit_code === 0 && !run.resultSeen) addSystemLine(run, null, 'Note', 'the process ended without a result event', 'warn');
  }

  // -------------------------------------------------------- trajectory graph
  // Cytoscape.js draws state.tree as a directed graph. The session, its runs and each run's steps
  // form one spine in time order; each subagent's steps branch off inside a dashed compound box.
  // Colors are read from the active daisyUI theme, so the graph follows light/dark with the page.
  // The graph's container (#tree) lives in the Timeline tab of the full-screen #trajectory-modal, so
  // `cy` is created lazily the first time that tab is shown; elements are synced on every tick, but
  // layout / fit / follow only run while the tab is visible (Cytoscape needs a sized container).
  let cy = null;
  let graphDir = 'TB';
  const graphFollow = $('#graph-follow');
  const graphTip = $('#graph-tip');
  const graphDirBtn = $('#graph-dir');

  // Cytoscape cannot parse daisyUI's oklch() colors, so paint them on a 1px canvas and read back hex.
  const colorCanvas = document.createElement('canvas');
  colorCanvas.width = colorCanvas.height = 1;
  const colorCtx = colorCanvas.getContext('2d', { willReadFrequently: true });
  function paint(color, base = null, alpha = 1) {
    colorCtx.globalAlpha = 1;
    colorCtx.fillStyle = base || '#ffffff';
    colorCtx.fillRect(0, 0, 1, 1);
    colorCtx.fillStyle = '#888888'; // stays if `color` is unparsable, which makes a bad value obvious
    colorCtx.fillStyle = color;
    colorCtx.globalAlpha = alpha;
    colorCtx.fillRect(0, 0, 1, 1);
    colorCtx.globalAlpha = 1;
    const [r, g, b] = colorCtx.getImageData(0, 0, 1, 1).data;
    return '#' + [r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('');
  }
  function themeColor(name, fallback) {
    const raw = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    return paint(raw || fallback);
  }
  function themePalette() {
    const base100 = themeColor('--color-base-100', '#ffffff');
    const P = {
      base100,
      base200: themeColor('--color-base-200', '#f3f4f6'),
      base300: themeColor('--color-base-300', '#e5e7eb'),
      content: themeColor('--color-base-content', '#1f2937'),
      neutral: themeColor('--color-neutral', '#374151'),
      neutralContent: themeColor('--color-neutral-content', '#ffffff'),
      primary: themeColor('--color-primary', '#4f46e5'),
      secondary: themeColor('--color-secondary', '#db2777'),
      accent: themeColor('--color-accent', '#0d9488'),
      info: themeColor('--color-info', '#0284c7'),
      success: themeColor('--color-success', '#16a34a'),
      warning: themeColor('--color-warning', '#f59e0b'),
      error: themeColor('--color-error', '#dc2626'),
    };
    P.tint = (c) => paint(c, base100, 0.22);
    P.muted = paint(P.content, base100, 0.62);
    return P;
  }

  // Node boxes are sized from their label (Cytoscape's `width: label` is deprecated): ~6.2px per
  // character at 11px, wrapped at 150px, 13px per line.
  const LABEL_CHAR_W = 6.2, LABEL_LINE_H = 13, LABEL_MAX_W = 150;
  function labelBox(ele) {
    const len = String(ele.data('label') || '').length;
    const raw = len * LABEL_CHAR_W;
    return { w: Math.min(LABEL_MAX_W, Math.max(36, raw)) + 4, h: Math.max(1, Math.ceil(raw / LABEL_MAX_W)) * LABEL_LINE_H + 2 };
  }

  function graphStyle(P) {
    const font = getComputedStyle(document.body).fontFamily || 'system-ui, sans-serif';
    return [
      { selector: 'node', style: {
        shape: 'round-rectangle', 'background-color': P.base100, 'border-width': 1.5, 'border-color': P.base300,
        label: 'data(label)', color: P.content, 'font-family': font, 'font-size': 11, 'text-wrap': 'wrap', 'text-max-width': LABEL_MAX_W,
        'text-overflow-wrap': 'anywhere', // URLs and other unbroken tokens (WebFetch labels) must wrap inside the box labelBox() sized
        'text-valign': 'center', 'text-halign': 'center', width: (ele) => labelBox(ele).w, height: (ele) => labelBox(ele).h,
        padding: 7, 'text-events': 'yes', 'min-zoomed-font-size': 6,
      } },
      { selector: 'node[kind = "session"]', style: { 'background-color': P.neutral, color: P.neutralContent, 'border-color': P.neutral, 'font-weight': 'bold' } },
      { selector: 'node[kind = "run"]', style: { 'border-color': P.primary, 'border-width': 2.5, 'font-weight': 'bold' } },
      { selector: 'node[kind = "tool"]', style: { shape: 'rectangle', 'border-color': P.accent } },
      { selector: 'node[kind = "agent"]', style: { 'border-color': P.secondary, 'border-width': 2.5 } },
      { selector: 'node[kind = "thinking"]', style: { shape: 'ellipse', 'font-style': 'italic', color: P.muted, padding: 5 } },
      { selector: 'node[kind = "text"]', style: { 'border-style': 'dotted', color: P.muted } },
      { selector: 'node[kind = "result"]', style: { shape: 'round-tag', 'border-color': P.info } },
      { selector: 'node[kind = "system"]', style: { shape: 'round-hexagon', 'border-color': P.warning } },
      { selector: 'node[status = "running"], node[status = "pending"]', style: { 'background-color': P.tint(P.warning), 'border-style': 'dashed' } },
      { selector: 'node[status = "completed"]', style: { 'background-color': P.tint(P.success) } },
      { selector: 'node[status = "failed"]', style: { 'background-color': P.tint(P.error), 'border-color': P.error } },
      { selector: 'node[status = "stopped"]', style: { 'background-color': P.tint(P.neutral) } },
      { selector: ':parent', style: {
        shape: 'round-rectangle', 'background-color': P.base200, 'background-opacity': 0.55, 'border-color': P.secondary, 'border-style': 'dashed',
        'border-width': 1.5, label: 'data(label)', 'text-valign': 'top', 'text-halign': 'center', 'text-margin-y': -4, 'font-size': 10,
        'font-weight': 'normal', color: P.muted, padding: 14,
      } },
      { selector: 'edge', style: { width: 1.5, 'line-color': P.base300, 'target-arrow-color': P.base300, 'target-arrow-shape': 'triangle', 'arrow-scale': 0.8, 'curve-style': 'bezier' } },
      { selector: 'edge[kind = "branch"]', style: { 'line-style': 'dashed', 'line-color': P.secondary, 'target-arrow-color': P.secondary } },
      // Timeline search: matching steps stand out, everything else fades.
      { selector: 'node.hit', style: { 'font-weight': 'bold', 'border-color': P.primary, 'border-width': 3 } },
      { selector: '.dim', style: { opacity: 0.25 } },
      { selector: 'node:selected', style: { 'border-color': P.primary, 'border-width': 3, 'overlay-color': P.primary, 'overlay-opacity': 0.1, 'overlay-padding': 4 } },
    ];
  }

  /** Flatten state.tree into graph nodes and edges: runs chained in order, steps chained within a run, subagents boxed. */
  function collectGraph() {
    const nodes = [];
    const edges = [];
    const root = state.tree;
    nodes.push({ id: root.id, label: root.label, kind: root.kind, status: 'root', cardId: '' });
    let prev = root.id;
    for (const run of root.children) {
      nodes.push({ id: run.id, label: run.label, kind: run.kind, status: run.status, cardId: run.cardId || '' });
      edges.push({ id: `e-${run.id}`, source: prev, target: run.id, kind: 'main' });
      prev = walkChain(run, run.id, null, nodes, edges);
    }
    return { nodes, edges };
  }
  /** Chain `node.children` after `prevId` (inside compound `groupId` when set); returns the chain's last id. */
  const isLaneMark = (c) => c.kind === 'system' && c.label === 'Subagent prompt'; // a start mark for the flow model, not a graph step
  function walkChain(node, prevId, groupId, nodes, edges) {
    for (const child of node.children) {
      if (isLaneMark(child)) continue;
      const data = { id: child.id, label: child.label, kind: child.kind, status: child.status, cardId: child.cardId || '' };
      if (groupId) data.parent = groupId;
      nodes.push(data);
      edges.push({ id: `e-${child.id}`, source: prevId, target: child.id, kind: groupId && prevId === node.id ? 'branch' : 'main' });
      // Only box the subagent once it has a real step; a lane with just the prompt mark would make an empty compound node (Cytoscape errors on those).
      if (child.kind === 'agent' && child.children.some((c) => !isLaneMark(c))) {
        const gid = `grp-${child.id}`;
        const group = { id: gid, label: truncate(child.label.replace(/^Subagent:\s*/, ''), 40), kind: 'group', status: 'group', cardId: child.cardId || '' };
        if (groupId) group.parent = groupId;
        nodes.push(group);
        walkChain(child, child.id, gid, nodes, edges); // the branch lives in the box; the main chain continues from the agent node
      }
      prevId = child.id;
    }
    return prevId;
  }

  /** Bring the Cytoscape graph in line with state.tree. Returns true when elements were added or removed. */
  function syncGraph() {
    const { nodes, edges } = collectGraph();
    const nodeIds = new Set(nodes.map((n) => n.id));
    const edgeIds = new Set(edges.map((e) => e.id));
    const stale = cy.elements().filter((e) => !(e.isNode() ? nodeIds.has(e.id()) : edgeIds.has(e.id())));
    let changed = false;
    if (stale.length) { stale.remove(); changed = true; }
    const toAdd = [];
    for (const n of nodes) {
      const existing = cy.getElementById(n.id);
      if (existing.length) {
        if (existing.data('label') !== n.label) existing.data('label', n.label);
        if (existing.data('status') !== n.status) existing.data('status', n.status);
      } else {
        toAdd.push({ group: 'nodes', data: n });
      }
    }
    for (const e of edges) if (!cy.getElementById(e.id).length) toAdd.push({ group: 'edges', data: e });
    if (toAdd.length) { cy.add(toAdd); changed = true; }
    return changed;
  }

  function runGraphLayout() {
    let layout;
    try {
      layout = cy.layout({ name: 'dagre', rankDir: graphDir, nodeSep: 18, rankSep: 34, edgeSep: 10, padding: 20, fit: false, animate: false, nodeDimensionsIncludeLabels: true });
    } catch {
      layout = cy.layout({ name: 'breadthfirst', directed: true, roots: `#${state.tree.id}`, spacingFactor: 1.05, padding: 20, fit: false, animate: false });
    }
    layout.run();
  }
  /** Fit everything, but never below a legible zoom: long trajectories start at the root instead. */
  const MIN_LEGIBLE_ZOOM = 0.55;
  function fitGraph() {
    if (!cy || !cy.nodes().length) return;
    cy.fit(cy.elements(), 24);
    if (cy.zoom() >= MIN_LEGIBLE_ZOOM) return;
    cy.zoom(MIN_LEGIBLE_ZOOM);
    cy.center(cy.getElementById(state.tree.id));
    // center() put the root mid-viewport; shift the view so the root sits near the start edge instead.
    const shift = graphDir === 'TB' ? { x: 0, y: -(graphEl.clientHeight / 2 - 40) } : { x: -(graphEl.clientWidth / 2 - 70), y: 0 };
    cy.panBy(shift);
  }
  function followNewest() {
    if (!cy || !graphFollow.checked) return;
    if (cy.nodes().length <= 30) { fitGraph(); return; }
    const newest = cy.nodes().filter((n) => !n.isParent()).last();
    if (newest.length) cy.animate({ center: { eles: newest }, duration: 150 });
  }

  function initGraph() {
    cy = cytoscape({
      container: graphEl, elements: [], style: graphStyle(themePalette()), layout: { name: 'preset' },
      minZoom: 0.15, maxZoom: 3, boxSelectionEnabled: false,
    });
    cy.on('tap', 'node', (evt) => { const n = evt.target; if (!n.isParent()) focusCard(n.data('cardId'), n); });
    cy.on('mouseover', 'node', (evt) => showTip(evt.target));
    cy.on('mouseout', 'node', hideTip);
    cy.on('drag', 'node', hideTip);
    cy.on('pan zoom', hideTip);
    window.trajectoryGraph = cy; // handy for poking at the graph from the console
  }
  window.trajectoryTree = () => state.tree; // read-only debug handle: the enriched tree the flow model computes from
  /** Theme changed (radios or prefers-color-scheme): re-read the Cytoscape palette and swap the CCFlow light/dark set. */
  function restyleGraph() { if (cy) cy.style().fromJson(graphStyle(themePalette())).update(); applyFlowTheme(); }

  function showTip(node) {
    if (node.isParent()) return;
    const d = node.data();
    graphTip.textContent = d.status && d.status !== 'root' ? `${d.label}\n${d.kind} · ${d.status}` : d.label;
    const p = node.renderedPosition();
    graphTip.style.left = `${p.x}px`;
    graphTip.style.top = `${p.y - node.renderedOuterHeight() / 2 - 6}px`;
    graphTip.hidden = false;
  }
  function hideTip() { graphTip.hidden = true; }

  // ---- Timeline search: steps whose label contains the query get .hit, the rest .dim; Enter cycles through the hits.
  let searchQuery = '';
  let searchHits = [];
  let searchIndex = -1;
  function resetSearch() {
    searchQuery = ''; searchHits = []; searchIndex = -1;
    if (timelineSearch) timelineSearch.value = '';
    if (timelineMatches) timelineMatches.textContent = '';
    if (cy) cy.elements().removeClass('hit dim');
  }
  function applySearch() {
    if (!cy) return;
    const q = searchQuery;
    const steps = cy.nodes().filter((n) => !n.isParent());
    searchHits = [];
    cy.batch(() => {
      if (!q) { cy.elements().removeClass('hit dim'); return; }
      steps.forEach((n) => {
        const hit = String(n.data('label') || '').toLowerCase().includes(q);
        n.toggleClass('hit', hit);
        n.toggleClass('dim', !hit);
        if (hit) searchHits.push(n);
      });
      cy.nodes(':parent').removeClass('hit dim');
      cy.edges().forEach((e) => e.toggleClass('dim', !(e.source().hasClass('hit') || e.target().hasClass('hit'))));
    });
    if (searchIndex >= searchHits.length) searchIndex = -1;
    timelineMatches.textContent = q ? `${searchHits.length} of ${steps.length}` : '';
  }
  function nextSearchHit() {
    if (!cy || !searchHits.length) return;
    searchIndex = (searchIndex + 1) % searchHits.length;
    const n = searchHits[searchIndex];
    cy.$(':selected').unselect();
    n.select();
    cy.animate({ center: { eles: n }, duration: 200 });
    timelineMatches.textContent = `${searchIndex + 1}/${searchHits.length} of ${cy.nodes().filter((x) => !x.isParent()).length}`;
  }
  function zoomGraph(factor) {
    if (!cy) return;
    cy.zoom({ level: cy.zoom() * factor, renderedPosition: { x: graphEl.clientWidth / 2, y: graphEl.clientHeight / 2 } });
  }

  // ---- Summary card (left pane) --------------------------------------------------------------------------
  /**
   * Fill the summary card and the modal header from {turns, tools, subagents, failures, topTools:[{name, calls}], wallMs, empty}.
   * pushFlow() calls this with CCFlow.compute(...).totals / top_tools; the shape is the contract.
   */
  let topToolsSig = null;
  function updateTrajectorySummary(s) {
    const empty = !!s.empty;
    const set = (node, text) => { if (node.textContent !== text) node.textContent = text; };
    const num = (v) => (empty || v == null ? DASH : String(v));
    set(trajEls.turns, num(s.turns));
    set(trajEls.tools, num(s.tools));
    set(trajEls.subagents, num(s.subagents));
    set(trajEls.failures, num(s.failures));
    trajEls.failures.classList.toggle('text-error', !empty && s.failures > 0);
    const top = empty ? [] : (s.topTools || []).slice(0, 4);
    const sig = top.map((t) => `${t.name}:${t.calls}`).join('|');
    if (sig !== topToolsSig) {
      topToolsSig = sig;
      trajEls.topTools.replaceChildren(...top.map((t) => el('span', { class: 'badge badge-ghost badge-xs', text: `${t.name} ×${t.calls}`, title: `${t.name}: ${plural(t.calls, 'call')}` })));
    }
    set(trajEls.wall, !empty && s.wallMs > 0 ? `wall ${fmtDur(s.wallMs)}` : '');
    trajectoryExpand.disabled = empty;
    treeEmpty.hidden = !empty;
    // Modal header: session id and the headline counts.
    const runs = state.tree.children.length;
    set(trajEls.session, state.sessionId ? state.sessionId.slice(0, 8) : 'no session');
    set(trajEls.counts, empty ? '' : `${plural(runs, 'run')} · ${plural(s.turns || 0, 'turn')} · ${plural(s.tools || 0, 'tool call')}`);
  }

  // ---- CCFlow: the Flow view (summary thumbnail + full diagram in the modal) --------------------------------
  const hasFlow = typeof CCFlow !== 'undefined';
  let thumbFlow = null, fullFlow = null, lastFlow = null, flowClearBtn = null, flowHighlightActive = false;

  /** getComputedStyle(document.documentElement).colorScheme is 'dark' under the dark theme; 'auto' falls back to the OS. */
  function flowIsDark() {
    const cs = (getComputedStyle(document.documentElement).colorScheme || '').trim();
    if (cs === 'dark') return true;
    if (cs === 'light') return false;
    return window.matchMedia('(prefers-color-scheme: dark)').matches;
  }
  function applyFlowTheme() { if (!hasFlow) return; const dark = flowIsDark(); if (thumbFlow) CCFlow.applyTheme(thumbFlow.el, dark); if (fullFlow) CCFlow.applyTheme(fullFlow.el, dark); const tb = $('#flow-toolbar'); if (tb) tb.classList.toggle('flow-dark', dark); }

  /** Create the thumbnail (left pane) and the full diagram (modal) once; wire the toolbar and set the theme. */
  function initFlow() {
    if (!hasFlow) return;
    thumbFlow = CCFlow.create($('#flow-thumb'), { width: 240, height: 120, mode: 'thumb', legend: false, headers: false, interactive: false, animate: true });
    const fr = $('#flow-root');
    fullFlow = CCFlow.create(fr, { width: fr.clientWidth || 1200, height: fr.clientHeight || 560, mode: 'full', legend: true, headers: true, interactive: true,
      onSelect: onFlowSelect, onFocus: onFlowFocus });
    buildFlowToolbar();
    applyFlowTheme();
  }

  /** Fill #flow-toolbar: Calls|Time measure radios → setMeasure, the component's legend chips, a Clear-highlight button, a hint. */
  function buildFlowToolbar() {
    const tb = $('#flow-toolbar'); if (!tb || !fullFlow) return;
    tb.replaceChildren();
    const measure = el('div', { class: 'join', role: 'radiogroup', 'aria-label': 'Ribbon width measure' },
      el('input', { type: 'radio', name: 'flow-measure', class: 'btn btn-xs join-item', 'aria-label': 'Calls', value: 'calls', checked: true, onchange: () => fullFlow.setMeasure('calls') }),
      el('input', { type: 'radio', name: 'flow-measure', class: 'btn btn-xs join-item', 'aria-label': 'Time', value: 'ms', onchange: () => fullFlow.setMeasure('ms') }));
    flowClearBtn = el('button', { type: 'button', class: 'btn btn-xs btn-ghost', hidden: true, text: 'Clear highlight', onclick: clearFlowHighlight });
    const hint = el('span', { class: 'text-xs opacity-60 ml-auto', text: 'hover for counts · click a node to trace it · legend chips isolate categories' });
    tb.append(measure);
    const legend = fullFlow.el.querySelector('.flow-legend'); // the component's keyed legend chips live in the toolbar
    if (legend) tb.append(legend);
    tb.append(flowClearBtn, hint);
  }

  function flowActive() { return !!(fullFlow && (fullFlow.selection || (fullFlow.focused && fullFlow.focused.length) || flowHighlightActive)); }
  function updateFlowClear() { if (flowClearBtn) flowClearBtn.hidden = !flowActive(); }
  function onFlowFocus() { updateFlowClear(); }

  /** A node was selected in the diagram: trace it in-diagram (the component does that) and highlight it in the transcript. */
  function onFlowSelect(sel, node) {
    if (!sel || !node) { clearTranscriptHighlight(); updateFlowClear(); return; }
    const id = node.id;
    if (id === 'action:tool:other') { clearTranscriptHighlight(); highlightToolCards((node.extra && node.extra.members || []).map((m) => m.name)); }
    else if (id.indexOf('action:tool:') === 0) { clearTranscriptHighlight(); highlightToolCards(node.label); }
    else if (id === 'action:llm') { clearTranscriptHighlight(); highlightAssistantBubbles(); }
    else if (node.category === 'run' || id.indexOf('run:') === 0) { focusRunNode(id); }               // close the modal, jump to the run card
    else if (node.category === 'subagent' && node.extra && node.extra.toolUseId) { focusSubagent(node.extra.toolUseId); }
    else clearTranscriptHighlight();                                                                    // Claude / outcomes / collapsed: in-diagram trace only
    updateFlowClear();
  }

  function focusRunNode(id) {
    if (id === 'run:earlier') { clearTranscriptHighlight(); return; }
    focusCard('run-' + id.slice('run:'.length));
  }
  function focusSubagent(toolUseId) {
    for (const r of state.runs) { const t = r.tools.get(toolUseId); if (t && t.card) { focusCard(t.card.id); return; } }
    clearTranscriptHighlight();
  }
  /** action:tool:<Name> (or the "Other tools" members list) → outline matching tool cards, fade the rest (Agent matches subagent cards). */
  function highlightToolCards(names) {
    const wanted = new Set(Array.isArray(names) ? names : [names]);
    let any = false;
    document.querySelectorAll('.card.tool').forEach((card) => {
      const titleEl = card.querySelector('.title');
      const match = (wanted.has('Agent') && card.classList.contains('agent')) || !!(titleEl && wanted.has(titleEl.textContent));
      card.classList.toggle('flow-hit', match); card.classList.toggle('flow-dim', !match); if (match) any = true;
    });
    flowHighlightActive = any || document.querySelectorAll('.card.tool').length > 0;
    updateFlowClear();
  }
  function highlightAssistantBubbles() {
    let any = false;
    document.querySelectorAll('.msg.assistant').forEach((m) => { m.classList.add('flow-hit'); any = true; });
    flowHighlightActive = any;
    updateFlowClear();
  }
  function clearTranscriptHighlight() {
    document.querySelectorAll('.flow-hit').forEach((n) => n.classList.remove('flow-hit'));
    document.querySelectorAll('.flow-dim').forEach((n) => n.classList.remove('flow-dim'));
    flowHighlightActive = false;
  }
  /** Clear button / Escape: drop the transcript highlight and clear the diagram's selection + category focus. */
  function clearFlowHighlight() {
    clearTranscriptHighlight();
    if (fullFlow) { fullFlow.select(null); fullFlow.clearFocus(); }
    updateFlowClear();
  }

  let flowTimer = 0, flowLast = 0;
  /** Recompute the flow frame and push it to the summary card, the thumbnail and (when visible) the full diagram. */
  function pushFlow() {
    flowLast = performance.now();
    if (!hasFlow) { updateTrajectorySummary({ empty: !state.tree.children.length }); return; }
    const flow = CCFlow.compute(state.tree, Date.now());
    lastFlow = flow;
    updateTrajectorySummary({ turns: flow.totals.turns, tools: flow.totals.tools, subagents: flow.totals.subagents, failures: flow.totals.failures,
      topTools: flow.top_tools, wallMs: flow.totals.ms, empty: !state.tree.children.length });
    if (thumbFlow) thumbFlow.update(flow, { animate: false });
    if (fullFlow && trajectoryModal.open && !flowPanel.hidden) fullFlow.update(flow);
  }
  /** 250 ms trailing throttle: a burst of stream ticks collapses to ≤ 4 flow refreshes per second. */
  function refreshFlow() {
    const now = performance.now();
    if (now - flowLast >= 250) { if (flowTimer) { clearTimeout(flowTimer); flowTimer = 0; } pushFlow(); }
    else if (!flowTimer) { flowTimer = setTimeout(() => { flowTimer = 0; pushFlow(); }, 250 - (now - flowLast)); }
  }

  // ---- Full-screen modal: Flow tab (the flow.js view fills #flow-toolbar and renders into #flow-root) + Timeline tab (#tree)
  const DEFAULT_TRAJECTORY_TAB = 'flow';
  const timelineVisible = () => trajectoryModal.open && !timelinePanel.hidden;

  /** Expand → open the modal on `tab` ('flow' | 'timeline'). */
  function openTrajectory(tab = DEFAULT_TRAJECTORY_TAB) {
    if (!state.tree.children.length) return;
    if (!trajectoryModal.open) trajectoryModal.showModal();
    setTrajectoryTab(tab);
  }
  function closeTrajectory() { if (trajectoryModal.open) trajectoryModal.close(); }
  function setTrajectoryTab(tab) {
    const flow = tab === 'flow';
    for (const [btn, on] of [[tabFlow, flow], [tabTimeline, !flow]]) { btn.classList.toggle('tab-active', on); btn.setAttribute('aria-selected', on ? 'true' : 'false'); }
    flowPanel.hidden = !flow;
    timelinePanel.hidden = flow;
    if (!flow) {
      if (trajectoryModal.open) showTimeline();
    } else if (fullFlow) {
      // The Flow panel is un-hidden now, so #flow-root has a real size: fit the diagram to it and draw the latest frame.
      const fr = $('#flow-root');
      fullFlow.resize(fr.clientWidth, fr.clientHeight);
      const flowData = hasFlow ? CCFlow.compute(state.tree, Date.now()) : lastFlow;
      if (flowData) { lastFlow = flowData; fullFlow.update(flowData, { animate: false }); }
    }
  }
  /** The Timeline panel just became visible: create the graph if needed, lay out what changed while hidden, fit. */
  function showTimeline() {
    let firstShow = false;
    if (!cy) {
      if (typeof cytoscape !== 'function') { timelineMatches.textContent = 'The graph library did not load; the trajectory cannot be drawn.'; return; }
      initGraph();
      syncGraph();
      state.graphLayoutPending = true;
      firstShow = true;
    }
    cy.resize();
    const laidOut = state.graphLayoutPending;
    if (laidOut) { runGraphLayout(); state.graphLayoutPending = false; }
    // Fit only when there is a reason to; a plain Flow→Timeline switch keeps the user's pan/zoom.
    if (firstShow || laidOut || state.graphFitPending) { fitGraph(); state.graphFitPending = false; }
    if (searchQuery) applySearch();
  }

  let treeScheduled = false;
  function renderTree() {
    if (treeScheduled) return;
    treeScheduled = true;
    requestAnimationFrame(() => { treeScheduled = false; drawGraph(); });
  }

  /** One rAF-batched tick: refresh the summary card, sync the graph's elements, and (only while visible) lay out / fit / follow. */
  function drawGraph() {
    const hasRuns = state.tree.children.length > 0;
    // CCFlow.compute() drives the summary card, the thumbnail and (when the Flow tab is open) the full diagram, on a
    // 250 ms trailing throttle. Runs before the empty-state early-return so the thumbnail clears on reset too.
    refreshFlow();
    if (!hasRuns) { if (cy) { cy.elements().remove(); hideTip(); } closeTrajectory(); return; }
    if (!cy) return; // created lazily by showTimeline(): its container has no size until the modal opens
    const changed = syncGraph();
    if (changed) { state.graphLayoutPending = true; if (searchQuery) applySearch(); }
    if (!timelineVisible()) return; // layout / fit / follow wait for a sized container (see showTimeline)
    if (state.graphLayoutPending) { cy.resize(); runGraphLayout(); state.graphLayoutPending = false; }
    if (state.graphFitPending) { fitGraph(); state.graphFitPending = false; }
    else if (changed) followNewest();
  }

  /** Select a graph node (if given), close the modal (the card is behind it), then scroll to the card and flash it. */
  function focusCard(cardId, node) {
    if (cy) { cy.$(':selected').unselect(); if (node) node.select(); }
    closeTrajectory();
    const card = cardId && document.getElementById(cardId);
    if (!card) return;
    card.scrollIntoView({ behavior: 'smooth', block: 'center' });
    card.classList.remove('flash');
    void card.offsetWidth; // restart the animation
    card.classList.add('flash');
  }

  trajectoryExpand.addEventListener('click', () => openTrajectory());
  tabFlow.addEventListener('click', () => setTrajectoryTab('flow'));
  tabTimeline.addEventListener('click', () => setTrajectoryTab('timeline'));
  trajectoryModal.addEventListener('close', hideTip);
  // Escape on the Flow tab clears an active selection / category focus first (keep the modal open); otherwise let it close.
  // (The Timeline search box handles its own Escape.)
  trajectoryModal.addEventListener('cancel', (e) => { if (!flowPanel.hidden && flowActive()) { e.preventDefault(); clearFlowHighlight(); } });
  timelineSearch.addEventListener('input', () => { searchQuery = timelineSearch.value.trim().toLowerCase(); searchIndex = -1; applySearch(); });
  timelineSearch.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); nextSearchHit(); return; }
    // A search input swallows Escape to clear itself, which would keep the dialog open: clear the query first, close on the next press.
    if (e.key === 'Escape') {
      e.preventDefault();
      if (timelineSearch.value) { timelineSearch.value = ''; searchQuery = ''; searchIndex = -1; applySearch(); }
      else closeTrajectory();
    }
  });
  $('#graph-fit').addEventListener('click', fitGraph);
  $('#graph-zoom-in').addEventListener('click', () => zoomGraph(1.25));
  $('#graph-zoom-out').addEventListener('click', () => zoomGraph(1 / 1.25));
  graphDirBtn.addEventListener('click', () => {
    graphDir = graphDir === 'TB' ? 'LR' : 'TB';
    graphDirBtn.textContent = graphDir === 'TB' ? 'Top-down' : 'Left-right';
    if (cy && cy.nodes().length && timelineVisible()) { runGraphLayout(); fitGraph(); }
    else if (cy) state.graphLayoutPending = true;
  });
  new ResizeObserver(() => { if (cy && timelineVisible()) cy.resize(); }).observe(graphEl.parentElement);
  const darkMedia = window.matchMedia('(prefers-color-scheme: dark)');
  if (darkMedia.addEventListener) darkMedia.addEventListener('change', restyleGraph);

  // -------------------------------------------------------- directory picker
  const CWD_KEY = 'cc-frontend-cwd';

  /** Show one level of the file system in the picker. Returns false if the path is not a directory. */
  async function browseTo(path, { remember = true } = {}) {
    const url = '/api/dirs' + (path ? `?path=${encodeURIComponent(path)}` : '');
    let res, data;
    try { res = await fetch(url); data = await res.json(); }
    catch (err) { setNote(`Could not load directories: ${err.message}`, 'warn'); return false; }
    if (!res.ok || data.missing) {
      setNote(data.error || `Not a directory: ${path}`, 'warn');
      cwdInput.value = state.dir.path || '';
      return false;
    }
    state.dir = { path: data.path, parent: data.parent };
    cwdInput.value = data.path;
    cwdInput.title = data.path;
    if (!cwdRoots.options.length) {
      cwdRoots.replaceChildren(el('option', { value: '', text: 'Jump to…' }),
        ...data.roots.map((r) => el('option', { value: r.path, text: r.label, title: r.path })));
    }
    cwdRoots.value = data.roots.some((r) => r.path === data.path) ? data.path : '';
    const name = data.path.split('/').filter(Boolean).pop() || data.path;
    cwdChildren.replaceChildren(
      el('option', { value: '', text: data.children.length ? `Open a subfolder of ${name} (${data.children.length})…` : `${name} has no visible subfolders` }),
      ...data.children.map((c) => el('option', { value: c.path, text: c.name, title: c.path })));
    const locked = !!state.sessionId || (state.currentRun && !state.currentRun.finished);
    setDirPickerDisabled(!!locked);
    setNote('');
    if (remember) { try { localStorage.setItem(CWD_KEY, data.path); } catch { /* storage unavailable */ } }
    return true;
  }

  function commitTypedPath() {
    const typed = cwdInput.value.trim();
    if (typed && typed !== state.dir.path) browseTo(typed);
  }

  cwdRoots.addEventListener('change', () => { if (cwdRoots.value) browseTo(cwdRoots.value); });
  cwdChildren.addEventListener('change', () => { if (cwdChildren.value) browseTo(cwdChildren.value); });
  cwdUp.addEventListener('click', () => { if (state.dir.parent) browseTo(state.dir.parent); });
  cwdInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); commitTypedPath(); } });
  cwdInput.addEventListener('change', commitTypedPath);

  // -------------------------------------------------------------------- boot
  async function loadInitialDir() {
    let saved = null;
    try { saved = localStorage.getItem(CWD_KEY); } catch { /* storage unavailable */ }
    if (saved && await browseTo(saved)) return;
    await browseTo(null); // server default: the scratch workspace next to the app
  }

  // Theme radios (daisyUI theme-controller): remember the choice across reloads.
  const THEME_KEY = 'cc-frontend-theme';
  const themeRadios = [...document.querySelectorAll('input[name="theme"]')];
  try {
    const savedTheme = localStorage.getItem(THEME_KEY);
    const match = themeRadios.find((r) => r.value === savedTheme);
    if (match) match.checked = true;
  } catch { /* storage unavailable */ }
  for (const r of themeRadios) r.addEventListener('change', () => { try { localStorage.setItem(THEME_KEY, r.value); } catch { /* ignore */ } restyleGraph(); });

  $('#composer').addEventListener('submit', (e) => { e.preventDefault(); submitPrompt(); });
  promptBox.addEventListener('keydown', (e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); submitPrompt(); } });
  stopBtn.addEventListener('click', stopCurrentRun);
  newSessionBtn.addEventListener('click', newSession);
  sessionsBtn.addEventListener('click', openSessions);
  sessionsAll.addEventListener('change', refreshSessions);
  sessionsFilter.addEventListener('input', renderSessionRows);

  initPolicy();
  loadInitialDir();
  renderPace(null);
  evalCat();
  setInterval(evalCat, 500); // the cat sits down 1.5 s after the last token even when no event arrives
  initFlow();                 // create the thumbnail + full diagram once, before the first renderTree() tick feeds them
  renderTree();
})();
