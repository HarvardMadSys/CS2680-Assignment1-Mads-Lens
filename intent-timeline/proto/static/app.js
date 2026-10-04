/* Claude Code trajectory viewer.
 *
 * The whole page is one idea: every stream-json line goes through Run.apply(event), which
 * updates a plain JavaScript model (a list of items, a Map of tool calls by id). render(run)
 * then redraws that run from the model. Fold state lives in the model too, so a redraw never
 * loses it. Nothing here knows how the events were produced: live SSE and replayed files
 * arrive through the same EventSource.
 *
 * Read Run.apply first. Everything else is drawing.
 */
'use strict';

/* ------------------------------------------------------------------ tiny DOM helpers */
const $ = (sel, root = document) => root.querySelector(sel);
function el(tag, attrs = {}, ...children) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === null || v === undefined || v === false) continue;
    if (k === 'class') n.className = v;
    else if (k === 'text') n.textContent = v;
    else if (k === 'html') n.innerHTML = v;
    else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
    else n.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) {
    if (c === null || c === undefined || c === false) continue;
    n.append(c.nodeType ? c : document.createTextNode(String(c)));
  }
  return n;
}
/* Tool output often carries terminal colour codes (pytest's red "1 failed", hook banners);
 * in a browser they show up as "[31m". Strip every ANSI escape before anything is drawn. */
const stripAnsi = (t) => String(t ?? '').replace(/\u001b\[[0-9;?]*[ -\/]*[@-~]/g, '').replace(/\u001b[@-Z\\-_]/g, '');
const md = (text) => DOMPurify.sanitize(marked.parse(stripAnsi(text || ''), { gfm: true, breaks: false }));
const trunc = (s, n) => (s = String(s ?? ''), s.length > n ? s.slice(0, n - 1) + '…' : s);
const fmtMs = (ms) => ms == null ? '—' : ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)} s`;
const fmtUsd = (x) => x == null ? '—' : '$' + Number(x).toFixed(4);
const fmtTok = (n) => n == null ? '—' : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
const shortPath = (p) => (p || '').split('/').filter(Boolean).slice(-2).join('/');

/* ------------------------------------------------------------------ per-tool summaries
 * tool_use.input has a different shape for every tool; one line per tool is what the
 * outline and the collapsed card show. Unknown tools fall back to the JSON. */
function toolSummary(name, input) {
  if (!input || typeof input !== 'object') return '';
  switch (name) {
    case 'Read': case 'Edit': case 'Write': case 'MultiEdit': return shortPath(input.file_path);
    case 'NotebookEdit': return shortPath(input.notebook_path);
    case 'Bash': return input.description ? `${input.description}  ·  ${trunc(input.command, 50)}` : trunc(input.command, 70);
    case 'Task': case 'Agent': return `${input.subagent_type ? `[${input.subagent_type}] ` : ''}${input.description || ''}`;
    case 'Grep': return `/${input.pattern}/ in ${shortPath(input.path) || '.'}`;
    case 'Glob': return `${input.pattern} in ${shortPath(input.path) || '.'}`;
    case 'WebFetch': return input.url || '';
    case 'WebSearch': return input.query || '';
    case 'Skill': return input.skill || '';
    default: return trunc(JSON.stringify(input), 70);
  }
}

/* tool_result.content is a string for most tools and an array of blocks (text, image) for
 * some (Read on an image, Agent hand-backs). Normalize to a list we can draw. */
function normalizeResult(content) {
  if (content == null) return [];
  if (typeof content === 'string') return [{ type: 'text', text: stripAnsi(content) }];
  if (Array.isArray(content)) return content.map(b => {
    if (b && b.type === 'image' && b.source && b.source.type === 'base64')
      return { type: 'image', src: `data:${b.source.media_type};base64,${b.source.data}` };
    if (b && b.type === 'text') return { type: 'text', text: stripAnsi(b.text) };
    return { type: 'text', text: JSON.stringify(b, null, 1) };
  });
  return [{ type: 'text', text: JSON.stringify(content, null, 1) }];
}

/* ================================================================== the model */
class Run {
  constructor(id, spec) {
    this.id = id; this.spec = spec;
    this.status = 'running';          // running | done | failed | stopped
    this.startedAt = Date.now();
    this.sessionId = null; this.model = null; this.cwd = spec.cwd || null; this.version = null;
    this.permissionMode = null; this.toolCount = null;
    this.result = null; this.error = null; this.exitCode = null; this.command = null;
    this.items = [];                  // main agent bucket (parent_tool_use_id == null)
    this.calls = new Map();           // tool_use id -> call
    this.tasks = new Map();           // task_id -> call (system/task_* events use task_id)
    this.messages = new Map();        // message.id -> assistant group (blocks of one API message)
    this.sys = {};                    // counts of hook_started, thinking_tokens, ... (noise)
    this.thinkingTokens = 0; this.rateLimit = null; this.statusText = null;
    this.el = null; this._dirty = false; this.folded = false;
  }

  /* Where does an event go? Main list, or the children of the tool call that spawned it. */
  bucketOf(parentId) {
    if (!parentId) return this.items;
    const call = this.getOrCreateCall(parentId, null, null);
    call.isSubagent = true; call.childEvents = (call.childEvents || 0) + 1;
    return call.children;
  }

  getOrCreateCall(id, name, input, parentId) {
    let call = this.calls.get(id);
    if (!call) {
      call = { kind: 'call', id, name: name || '?', input: input || {}, status: 'pending', result: null, parentId: parentId || null, t0: null, t1: null,
               resultMeta: null, isError: false, denyReason: null, children: [], isSubagent: false,
               task: null, open: false, resultOpen: false, subOpen: true, subTouched: false,
               rawUse: null, rawResult: null, startedAt: Date.now(), endedAt: null, placeholder: !name };
      this.calls.set(id, call);
      if (!name) { // parent referenced before its tool_use arrived: keep a placeholder in the main list
        call.name = 'subagent'; this.items.push(call);
      }
    } else if (name && call.placeholder) { call.name = name; call.input = input || {}; call.placeholder = false; if (parentId !== undefined) call.parentId = parentId || null; }
    return call;
  }

  /* -------------------------------------------------------------- apply one event */
  apply(e) {
    const t = e.type;
    this.lastEventAt = Date.now();
    if (e.timestamp) { const ms = Date.parse(e.timestamp); if (ms) { if (!this.tStart || ms < this.tStart) this.tStart = ms; if (!this.tLast || ms > this.tLast) this.tLast = ms; } }
    if (t === 'assistant') this.onAssistant(e);
    else if (t === 'user') this.onUser(e);
    else if (t === 'system') this.onSystem(e);
    else if (t === 'stream_event') this.onStream(e);
    else if (t === 'result') this.onResult(e);
    else if (t === 'rate_limit_event') this.rateLimit = e.rate_limit_info || null;
    else if (t === 'server') this.onServer(e);
    else this.sys[t] = (this.sys[t] || 0) + 1;
    scheduleRender(this);
  }

  /* One API message arrives as several assistant events (one content block each) sharing
   * message.id. Group them so the page shows one message, not five. */
  onAssistant(e) {
    this.statusText = null;                       // a message arriving means the status phase is over
    this.thinkingSince = null;
    const bucket = this.bucketOf(e.parent_tool_use_id);
    const mid = e.message.id;
    let g = this.messages.get(mid);
    if (!g) {
      g = { kind: 'assistant', msgId: mid, model: e.message.model, blocks: [], drafts: new Map(), usage: null, streaming: false, raw: [] };
      this.messages.set(mid, g); bucket.push(g);
    }
    g.raw.push(e);
    for (const b of e.message.content || []) {
      if (b.type === 'tool_use') {
        const call = this.getOrCreateCall(b.id, b.name, b.input, e.parent_tool_use_id);
        call.rawUse = e; if (e.timestamp) call.t0 = Date.parse(e.timestamp);
        g.blocks.push({ type: 'tool_use', call });
        for (const [idx, d] of g.drafts) if (d.type === 'tool_use' && d.id === b.id) g.drafts.delete(idx);
      } else {
        g.blocks.push(b);            // text | thinking | anything new
        for (const [idx, d] of g.drafts) if (d.type === b.type) { g.drafts.delete(idx); break; }
      }
    }
  }

  /* tool_result blocks live inside type:"user" events; pair them by tool_use_id only. */
  onUser(e) {
    const bucket = this.bucketOf(e.parent_tool_use_id);
    const content = e.message && e.message.content;
    if (typeof content === 'string') { this.placeUserText(bucket, e.parent_tool_use_id, content); return; }
    for (const b of content || []) {
      if (b.type === 'tool_result') {
        const call = this.getOrCreateCall(b.tool_use_id, null, null);
        if (call.placeholder) { call.name = '(result before its tool_use)'; call.placeholder = false; }
        call.result = normalizeResult(b.content);
        call.resultMeta = e.tool_use_result ?? null;
        call.isError = !!b.is_error;
        if (call.status !== 'denied') call.status = b.is_error ? 'error' : 'ok';
        call.endedAt = Date.now(); call.rawResult = e; if (e.timestamp) call.t1 = Date.parse(e.timestamp);
        if (call.isSubagent && !call.subTouched && !inViewport(`call-${call.id}`)) call.subOpen = false;   // fold a finished subagent only if it is off-screen
      } else if (b.type === 'text') {
        this.placeUserText(bucket, e.parent_tool_use_id, b.text);
      } else {
        bucket.push({ kind: 'user_text', text: JSON.stringify(b) });
      }
    }
  }

  /* Three kinds of type:"user" text are the harness talking, not the person: the prompt handed
   * to a subagent (first text in its bucket), skill text injected right after a Skill tool_result,
   * and the summary that follows a compact_boundary. Attach each to the thing it belongs to. */
  placeUserText(bucket, parentId, text) {
    text = stripAnsi(text);
    if (parentId) { const call = this.calls.get(parentId); if (call && !call.brief) { call.brief = text; return; } }
    const lastCall = this.lastCallIn(bucket);
    if (lastCall && lastCall.name === 'Skill' && lastCall.result && !lastCall.injected) { lastCall.injected = text; return; }
    const last = bucket[bucket.length - 1];
    if (last && last.kind === 'divider' && !last.summary) { last.summary = text; return; }
    bucket.push({ kind: 'user_text', text });
  }
  lastCallIn(bucket) {
    for (let i = bucket.length - 1; i >= 0; i--) {
      const it = bucket[i];
      if (it.kind === 'call') return it;
      if (it.kind === 'assistant') { for (let j = it.blocks.length - 1; j >= 0; j--) if (it.blocks[j].type === 'tool_use') return it.blocks[j].call; return null; }
      return null;
    }
    return null;
  }

  onSystem(e) {
    const st = e.subtype;
    switch (st) {
      case 'init':
        this.sessionId = e.session_id; this.model = e.model; this.cwd = e.cwd; this.version = e.claude_code_version;
        this.permissionMode = e.permissionMode; this.toolCount = (e.tools || []).length; break;
      case 'permission_denied': {
        const call = this.getOrCreateCall(e.tool_use_id, e.tool_name, null);
        call.status = 'denied'; call.denyReason = stripAnsi(e.decision_reason || e.message || 'permission denied'); break;
      }
      case 'task_started': {
        const call = this.getOrCreateCall(e.tool_use_id, null, null);
        call.isSubagent = true;
        call.task = { id: e.task_id, description: e.description, type: e.subagent_type, prompt: e.prompt,
                      status: 'running', progress: null, usage: null, summary: null };
        this.tasks.set(e.task_id, call); break;
      }
      case 'task_progress': {
        const call = this.tasks.get(e.task_id) || this.calls.get(e.tool_use_id);
        if (call && call.task) call.task.progress = { text: e.description, usage: e.usage, lastTool: e.last_tool_name };
        break;
      }
      case 'task_notification': {
        const call = this.tasks.get(e.task_id) || this.calls.get(e.tool_use_id);
        if (call && call.task) { call.task.status = e.status; call.task.usage = e.usage; call.task.summary = stripAnsi(e.summary); }
        break;
      }
      case 'task_updated': {
        const call = this.tasks.get(e.task_id);
        if (call && call.task && e.patch && e.patch.status) call.task.status = e.patch.status;
        break;
      }
      case 'compact_boundary':
        this.bucketOf(e.parent_tool_use_id).push({ kind: 'divider', label: 'context compacted', detail: e.compact_metadata || null, raw: e });
        break;
      case 'thinking_tokens':
        this.thinkingTokens = e.estimated_tokens ?? this.thinkingTokens; this.thinkingAt = Date.now(); if (!this.thinkingSince) this.thinkingSince = Date.now(); this.sys[st] = (this.sys[st] || 0) + 1; break;
      case 'status':
        this.statusText = e.status || null; this.sys[st] = (this.sys[st] || 0) + 1; break;
      case 'compact_boundary_reset__unused': break;
      default:
        this.sys[st] = (this.sys[st] || 0) + 1;          // hook_started, hook_response, ...
    }
  }

  /* --include-partial-messages: content arrives as deltas before the full block. Keep a draft
   * per (message, block index); the real assistant event replaces it. tool_use input comes
   * as input_json_delta fragments that are NOT valid JSON until the block stops. */
  onStream(e) {
    const ev = e.event || {}; const bucket = this.bucketOf(e.parent_tool_use_id);
    if (ev.type === 'message_start') {
      const m = ev.message || {}; const mid = m.id;
      if (mid && !this.messages.has(mid)) {
        const g = { kind: 'assistant', msgId: mid, model: m.model, blocks: [], drafts: new Map(), usage: null, streaming: true, raw: [] };
        this.messages.set(mid, g); bucket.push(g);
      }
      this._openMsg = mid; return;
    }
    const g = this.messages.get(this._openMsg); if (!g) return;
    if (ev.type === 'content_block_start') {
      const cb = ev.content_block || {};
      g.drafts.set(ev.index, { type: cb.type, id: cb.id, name: cb.name, text: '', json: '' });
    } else if (ev.type === 'content_block_delta') {
      const d = g.drafts.get(ev.index); const delta = ev.delta || {};
      if (!d) return;
      if (delta.type === 'text_delta') d.text += delta.text || '';
      else if (delta.type === 'input_json_delta') d.json += delta.partial_json || '';
      else if (delta.type === 'thinking_delta') d.text += delta.thinking || '';
    } else if (ev.type === 'content_block_stop') {
      g.drafts.delete(ev.index);
    } else if (ev.type === 'message_delta') {
      g.usage = ev.usage || g.usage;          // the final usage for this message
    } else if (ev.type === 'message_stop') {
      g.streaming = false; g.drafts.clear();
    }
  }

  onResult(e) {
    this.result = e;
    this.sessionId = e.session_id || this.sessionId;
    this.status = e.is_error ? 'failed' : 'done';
    if (e.is_error) this.error = (e.errors && e.errors.join('\n')) || `result.subtype = ${e.subtype}`;
    for (const c of this.calls.values()) if (c.status === 'pending') { c.status = 'error'; c.denyReason = 'run ended before a result arrived'; }
  }

  onServer(e) {
    if (e.subtype === 'spawn') { this.command = e.command; if (e.prompt && !this.spec.prompt) this.spec.prompt = e.prompt; if (e.cwd && !this.cwd) this.cwd = e.cwd; }
    else if (e.subtype === 'error') { if (this.status !== 'stopped') { this.status = 'failed'; this.error = e.message + (e.stderr ? '\n' + e.stderr : ''); } }
    else if (e.subtype === 'exit') { this.exitCode = e.code; if (this.status === 'running') { this.status = 'failed'; this.error = this.error || `process exited with code ${e.code}`; } }
    else if (e.subtype === 'stopped') { this.status = 'stopped'; this.error = 'stopped by user'; for (const c of this.calls.values()) if (c.status === 'pending') { c.status = 'error'; c.denyReason = 'run stopped'; } }
    else if (e.subtype === 'stderr') this.items.push({ kind: 'server', text: e.text });
  }

  streamEnded() {                      // SSE closed: if nothing declared an end, that is a failure
    if (this.status === 'running') { this.status = 'failed'; this.error = this.error || 'stream ended without a result event'; scheduleRender(this); }
  }

  /* Walk every tool call depth-first, for the outline. */
  *walkCalls(items = this.items, depth = 0) {
    for (const it of items) {
      if (it.kind === 'call') { yield { call: it, depth }; if (it.children.length) yield* this.walkCalls(it.children, depth + 1); }
      else if (it.kind === 'assistant') for (const b of it.blocks) if (b.type === 'tool_use') { yield { call: b.call, depth }; if (b.call.children.length) yield* this.walkCalls(b.call.children, depth + 1); }
    }
  }
}

function inViewport(id) {
  const t = document.getElementById(id); if (!t) return false;
  const r = t.getBoundingClientRect();
  return r.bottom > 0 && r.top < window.innerHeight;
}

/* ================================================================== rendering */
const RUNS = [];
const pendingRender = new Set();
function scheduleRender(run) {
  pendingRender.add(run);
  if (pendingRender.size === 1) requestAnimationFrame(() => {
    const sel = document.getSelection();
    const holding = sel && !sel.isCollapsed && sel.anchorNode ? RUNS.find(r => r.el && r.el.contains(sel.anchorNode)) : null;
    for (const r of pendingRender) if (r !== holding) renderRun(r);
    pendingRender.clear();
    if (holding) { pendingRender.add(holding); setTimeout(() => scheduleRender(holding), 600); }
    renderOutline(); updateComposer();
    if (FOLLOW) scrollToLatest(); else { if (scrollable() && !atBottom()) UNSEEN++; updateFollowButton(); }
    if (FOLLOW) followOutline();
  });
}

/* Following the live end of the page is the USER's intent, not a geometry test. Default OFF:
 * a reader looking at the first lines is never dragged away when the page outgrows the
 * window. Scrolling to the bottom, or the "latest" button, turns following on; any scroll
 * that leaves the bottom turns it off. Programmatic scrolls are flagged so they do not count. */
let FOLLOW = false, UNSEEN = 0, PROGRAMMATIC = false;
const scrollable = () => document.documentElement.scrollHeight > window.innerHeight + 8;
const atBottom = () => window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 8;
function scrollToLatest() {
  const target = document.documentElement.scrollHeight - window.innerHeight;
  if (Math.abs(window.scrollY - target) > 1) { PROGRAMMATIC = true; window.scrollTo(0, target); }
}
// Scrolling up is an intent even when the page is too short to move: wheel/touch/keys fire anyway.
window.addEventListener('wheel', (e) => { if (e.deltaY < 0 && FOLLOW) { FOLLOW = false; UNSEEN = 0; updateFollowButton(); } }, { passive: true });
window.addEventListener('keydown', (e) => { if (FOLLOW && (e.key === 'ArrowUp' || e.key === 'PageUp' || e.key === 'Home') && !/INPUT|TEXTAREA|SELECT/.test(document.activeElement?.tagName)) { FOLLOW = false; UNSEEN = 0; updateFollowButton(); } });
let touchY = null;
window.addEventListener('touchstart', (e) => { touchY = e.touches[0].clientY; }, { passive: true });
window.addEventListener('touchmove', (e) => { if (touchY !== null && e.touches[0].clientY > touchY + 8 && FOLLOW) { FOLLOW = false; UNSEEN = 0; updateFollowButton(); } }, { passive: true });
window.addEventListener('scroll', () => {
  if (PROGRAMMATIC) { PROGRAMMATIC = false; return; }
  const bottom = atBottom();
  if (bottom && !FOLLOW) { FOLLOW = true; UNSEEN = 0; updateFollowButton(); }
  else if (!bottom && FOLLOW) { FOLLOW = false; UNSEEN = 0; updateFollowButton(); }
}, { passive: true });
function updateFollowButton() {
  let b = document.getElementById('follow');
  if (!b) {
    b = el('button', { id: 'follow', class: 'follow', type: 'button', onclick: () => { FOLLOW = true; UNSEEN = 0; scrollToLatest(); updateFollowButton(); } });
    document.body.append(b);
  }
  b.hidden = FOLLOW || !scrollable() || atBottom();
  if (b.hidden) UNSEEN = 0;
  b.textContent = UNSEEN ? `↓ latest · ${UNSEEN} new` : '↓ latest';
}

/* ---- steps: the unit a reader thinks in -------------------------------------------------
 * A step is one stated intention (the assistant's text) plus every tool call made until the
 * next statement. Usually that is one API message; tool-only messages (the agent working
 * without narrating) fold into the step whose intention they serve. */
function deriveSteps(items) {
  const out = []; let cur = null;
  const open = () => { cur = { kind: 'step', groups: [], texts: [], calls: [] }; out.push(cur); };
  for (const it of items) {
    if (it.kind === 'assistant') {
      const texts = it.blocks.filter(b => b.type === 'text').map(b => b.text);
      const calls = it.blocks.filter(b => b.type === 'tool_use').map(b => b.call);
      if (texts.length || !cur) open();
      cur.groups.push(it); cur.texts.push(...texts); cur.calls.push(...calls);
    } else if (it.kind === 'call') {            // placeholder parent created before its tool_use arrived
      if (!cur) open();
      cur.groups.push(it); cur.calls.push(it);
    } else { out.push(it); cur = null; }        // user turn, divider, server line: breaks the step
  }
  return out;
}
const stepKey = (s) => (s.groups[0] && s.groups[0].msgId) || (s.calls[0] && s.calls[0].id) || Math.random().toString(36).slice(2);
const stepStatus = (s) => s.calls.some(c => c.status === 'pending') ? 'pending' : s.calls.some(c => c.status === 'error') ? 'error' : s.calls.some(c => c.status === 'denied') ? 'denied' : 'ok';
function firstSentence(t) {
  const flat = (t || '').replace(/[`*_#>]/g, '').replace(/\s+/g, ' ').trim();
  const m = flat.match(/^.{12,}?[.!?。！？](\s|$)/);
  return (m ? m[0] : flat).trim();
}
/* First paragraph that is prose (not a heading, list or table row): what a report SAYS. */
function firstProse(t) {
  const blocks = (t || '').split(/\n\s*\n/).map(b => b.trim()).filter(Boolean);
  const prose = blocks.find(b => b.length > 40 && !/^([-*#>|]|\d+\.)/.test(b));
  return firstSentence(prose || blocks[blocks.length - 1] || t);
}
/* When the agent acted without saying why, borrow the tools' own descriptions. */
const impliedIntent = (s) => s.calls.map(c => c.name === 'Bash' && c.input.description ? c.input.description : `${c.name} ${callLabel(c)}`).slice(0, 3).join(' · ');

/* ---- one line per tool call: what (label), what came back (outcome) ------------------ */
function callLabel(c) {
  const i = c.input || {};
  if (c.name === 'Bash') return i.description || trunc(i.command, 70);
  return toolSummary(c.name, i);
}
function resultText(c) { return (c.result || []).filter(p => p.type === 'text').map(p => p.text).join('\n'); }
function callOutcome(c) {
  if (c.status === 'pending') return '';
  if (c.status === 'denied') return trunc(c.denyReason, 70);
  if ((c.result || []).some(p => p.type === 'image')) return 'image';
  const text = resultText(c);
  const lines = text.split('\n').filter(l => l.trim().length);
  if (c.isError) return trunc(lines[lines.length - 1] || 'failed', 80);     // the raw last line; the next step's heading is the model's reading of it
  switch (c.name) {
    case 'Read': return `${lines.length} lines`;
    case 'Write': return `wrote ${String(c.input.content || '').split('\n').length} lines`;
    case 'Edit': return `+${String(c.input.new_string || '').split('\n').length} −${String(c.input.old_string || '').split('\n').length}`;
    case 'Glob': return `${lines.length} files`;
    case 'Grep': return `${lines.length} matches`;
    case 'Skill': return 'loaded';
    case 'Task': case 'Agent': {
      if (c.task && c.task.summary) return trunc(firstProse(c.task.summary), 80);
      const u = c.task && (c.task.usage || (c.task.progress && c.task.progress.usage));
      return u ? `${fmtTok(u.total_tokens)} tok · ${u.tool_uses} tools · ${fmtMs(u.duration_ms)}` : 'done';
    }
    case 'Bash': {
      const py = text.match(/(\d+ (?:passed|failed|errors?|skipped|xfailed|warnings?)(?:, \d+ (?:passed|failed|errors?|skipped|xfailed|warnings?))*) in [\d.]+s/);
      if (py) return py[1];                                    // pytest's own summary line
      if (!lines.length) return 'ok · no output';
      return `${trunc(lines[0], 56)}${lines.length > 1 ? ` · ${lines.length} lines` : ''}`;
    }
    default: return lines.length ? `${lines.length} lines` : 'ok';
  }
}

/* ================================================================== drawing */
const pill = (name, extra = '') => el('span', { class: `pill t-${name}${extra ? ' ' + extra : ''}` }, name);
function statusWord(status) {              // the demo's vocabulary: ✓ · ● pending · ✕ failed
  const map = { ok: '✓', done: '✓ finished', pending: 'pending', running: 'running', error: '✕ error', failed: '✕ failed', denied: '⊘ refused', stopped: '■ stopped' };
  const w = el('span', { class: `st ${status}` });
  if (status === 'pending' || status === 'running') w.append(el('span', { class: 'blink' }));
  w.append(map[status] || status);
  return w;
}
const countEvents = (run) => run.calls.size + [...run.messages.values()].length;
function aliveText(run) {
  const since = run.lastEventAt ? Math.round((Date.now() - run.lastEventAt) / 1000) : null;
  const thinking = run.thinkingAt && Date.now() - run.thinkingAt < 4000;   // thinking_tokens heartbeats keep arriving while the model thinks
  if (run.statusText && !thinking) return run.statusText;                  // e.g. "requesting", "compacting"
  if (run.statusText && /compact/i.test(run.statusText)) return run.statusText;
  if (thinking) { const secs = run.thinkingSince ? Math.max(1, Math.round((Date.now() - run.thinkingSince) / 1000)) : 1; return `thinking for ${secs} s · ≈${fmtTok(run.thinkingTokens)} tokens so far · content not exposed by Claude Code`; }
  const what = run.items.length ? 'working' : 'starting';
  return `${what}${since !== null && since >= 2 ? ` · ${since} s since the last event` : ''}`;
}

function renderRun(run) {
  // Native <details> keep their open state only in the DOM; remember it across the redraw.
  const openKeys = new Set(run.el ? [...run.el.querySelectorAll('details[open][data-k]')].map(d => d.dataset.k) : []);
  const card = el('section', { class: `run ${run.status}${run.folded ? ' folded' : ''}`, id: `run-${run.id}` });
  card.append(renderRunHead(run));
  if (run.error) card.append(el('div', { class: 'run-error' }, run.error.startsWith('Error') ? run.error : `Error: ${run.error}`));
  const steps = deriveSteps(run.items);
  if (run.folded) {
    const n = countEvents(run);
    card.append(el('button', { class: 'fold-runs', type: 'button', onclick: () => { run.folded = false; renderRun(run); } }, `▸ ${n} events, folded`));
    const last = [...steps].reverse().find(s => s.kind === 'step' && !s.calls.length && s.texts.length);
    if (last) card.append(el('div', { class: 'timeline' }, el('div', { class: 'answer' }, el('div', { class: 'msg-text', html: md(last.texts.join('\n\n')) }))));
  } else {
    const sysBits = [run.model && `model ${run.model}`, run.permissionMode && `permissions ${run.permissionMode}`, run.version && `claude ${run.version}`].filter(Boolean).concat(Object.entries(run.sys).map(([k, v]) => `${k} ×${v}`));
    if (run.thinkingTokens) sysBits.push(`thinking ≈${fmtTok(run.thinkingTokens)} tok`);
    if (run.statusText) sysBits.push(`status: ${run.statusText}`);
    const sysTotal = Object.values(run.sys).reduce((a, b) => a + b, 0);
    const sysline = sysBits.length ? el('details', { class: 'sysline', 'data-k': 'sys' },
      el('summary', {}, `system events · ${sysTotal}${run.rateLimit ? ` · rate limit ${Math.round((run.rateLimit.unifiedWindows?.five_hour?.utilization || 0) * 100)}%` : ''}`),
      el('div', { class: 'sysbits' }, ...sysBits.map(t => el('span', {}, t)))) : null;
    const body = el('div', { class: 'timeline' }, sysline, ...renderItems(run, run.items, true));
    if (run.status === 'running') body.append(el('div', { class: `alive${run.thinkingAt && Date.now() - run.thinkingAt < 4000 ? ' thinking' : ''}` }, el('span', { class: 'blink' }), el('span', { class: 'alive-text' }, aliveText(run)), el('span', { class: 'dots' }, el('i'), el('i'), el('i'))));
    card.append(body);
    if (run.calls.size) card.append(renderTimelineBox(run));
    if (run.status !== 'running' && run.result) card.append(renderSummary(run));
    if (steps.some(x => x.kind === 'step' && x.calls.length)) card.append(el('button', { class: 'fold-runs', type: 'button', onclick: () => { run.folded = true; renderRun(run); } }, `▾ fold this run`));
  }
  for (const d of card.querySelectorAll('details[data-k]')) if (openKeys.has(d.dataset.k)) d.open = true;
  const empty = $('#runs .empty'); if (empty) empty.remove();
  if (run.el) run.el.replaceWith(card); else $('#runs').append(card);
  run.el = card;
  drawTimeline(run);                     // needs the card in the document to know its width
}

/* ================================================================== where the time went */
const FAMILY = (name) => /^(Bash|Edit|Write|MultiEdit|NotebookEdit)$/.test(name) ? 'shell' : /^(Read|Grep|Glob)$/.test(name) ? 'read' : /^(Task|Agent)$/.test(name) ? 'task' : 'misc';

/* Lanes: the main agent, then one lane per subagent. Within a lane, a call is on the critical
 * path when it pushes the lane's finish time forward; a call fully covered by a longer parallel
 * one is not (that is the time parallelism saved). Gaps between calls on the main lane are the
 * model thinking. */
function timelineModel(run) {
  // "now" is the wall clock for a live run, but the recording's own clock for a replay
  const now = run.spec.mode === 'replay' ? (run.tLast || Date.now()) : Date.now();
  const calls = [...run.calls.values()].filter(c => !c.placeholder && c.t0);
  if (!calls.length) return null;
  const t0 = run.tStart || Math.min(...calls.map(c => c.t0));
  const tEnd = run.result && run.tStart ? Math.max(run.tLast || 0, run.tStart + (run.result.duration_ms || 0)) : Math.max(run.tLast || now, now);
  const end = (c) => c.t1 || (run.status === 'running' ? Math.max(c.t0, run.tLast || now) : (run.tLast || c.t0));
  const lanes = [{ id: 'main', label: 'main agent', calls: calls.filter(c => !c.parentId) }];
  for (const c of calls) if (c.isSubagent) lanes.push({ id: c.id, label: (c.task && c.task.description) || c.input.description || 'subagent', calls: calls.filter(k => k.parentId === c.id) });
  for (const lane of lanes) {
    lane.calls.sort((a, b) => a.t0 - b.t0);
    let frontier = null; lane.gaps = []; let busy = 0; let sum = 0;
    for (const c of lane.calls) {
      const e = end(c); sum += e - c.t0;
      if (frontier === null || c.t0 >= frontier) { if (frontier !== null && c.t0 - frontier > 250) lane.gaps.push([frontier, c.t0]); c.critical = true; busy += e - c.t0; frontier = e; }
      else if (e > frontier) { c.critical = true; busy += e - frontier; frontier = e; }
      else c.critical = false;
    }
    lane.busy = busy; lane.overlapSaved = sum - busy; lane.finish = frontier;
    // parallel calls get their own sub-row instead of being drawn on top of each other
    const rowEnds = [];
    for (const c of lane.calls) { const e = end(c); let r = rowEnds.findIndex(x => x <= c.t0 + 50); if (r < 0) { r = rowEnds.length; rowEnds.push(0); } rowEnds[r] = e; c.row = r; }
    lane.rows = Math.max(1, rowEnds.length);
  }
  const main = lanes[0];
  main.liveGap = run.status === 'running' && !main.calls.some(c => !c.t1) && main.finish && now > main.finish ? [main.finish, now] : null;
  return { t0, tEnd, lanes, end };
}

function renderTimelineBox(run) {
  return el('details', { class: 'tl', 'data-k': 'timeline', open: run.status !== 'running' || null },
    el('summary', {}, 'timeline · where the time went'),
    el('div', { class: 'tl-legend' },
      ...[['shell', 'Bash / Edit / Write'], ['read', 'Read / Grep / Glob'], ['task', 'Task (subagent)'], ['misc', 'Skill / other']].map(([k, t]) => el('span', { class: 'lg' }, el('i', { class: `sw ${k}` }), t)),
      el('span', { class: 'lg' }, el('i', { class: 'sw gap' }), 'model thinking'),
      el('span', { class: 'lg' }, el('i', { class: 'sw faded' }), 'overlapped by a parallel call'),
      el('span', { class: 'lg' }, el('i', { class: 'sw refused' }), 'refused'),
      el('span', { class: 'lg' }, el('i', { class: 'sw error' }), 'error')),
    el('div', { class: 'tl-svg' }),
    el('div', { class: 'tl-totals muted' }));
}

function svgEl(tag, attrs = {}, ...children) {
  const n = document.createElementNS('http://www.w3.org/2000/svg', tag);
  for (const [k, v] of Object.entries(attrs)) if (v !== null && v !== undefined) n.setAttribute(k, v);
  for (const c of children) n.append(c);
  return n;
}
const niceStep = (spanMs, maxTicks = 8) => [1, 2, 5, 10, 15, 30, 60, 120, 300, 600].map(s => s * 1000).find(st => spanMs / st <= maxTicks) || 600000;

function drawTimeline(run) {
  const box = run.el && run.el.querySelector('.tl-svg'); if (!box) return;
  const m = timelineModel(run); if (!m) return;
  const W = Math.max(320, box.clientWidth || 800), GUT = 128, PAD = 12, AX = 18, ROW = 18, LANEPAD = 6;
  const span = Math.max(1000, m.tEnd - m.t0);
  const x = (t) => GUT + (Math.min(Math.max(t, m.t0), m.tEnd) - m.t0) / span * (W - GUT - PAD);
  const laneH = (lane) => lane.rows * ROW + LANEPAD;
  const H = AX + m.lanes.reduce((a, l) => a + laneH(l), 0) + 6;
  const svg = svgEl('svg', { viewBox: `0 0 ${W} ${H}`, width: W, height: H, class: 'tl-chart', role: 'img', 'aria-label': 'timeline of tool calls per agent' });
  const defs = svgEl('defs'); const pat = svgEl('pattern', { id: 'hatch', width: 6, height: 6, patternUnits: 'userSpaceOnUse', patternTransform: 'rotate(45)' });
  pat.append(svgEl('rect', { width: 6, height: 6, class: 'hatch-bg' }), svgEl('rect', { width: 2, height: 6, class: 'hatch-fg' })); defs.append(pat); svg.append(defs);
  const step = niceStep(span);
  for (let t = 0; t <= span; t += step) {
    const px = x(m.t0 + t);
    svg.append(svgEl('line', { x1: px, x2: px, y1: AX - 4, y2: H - 4, class: 'grid' }));
    svg.append(svgEl('text', { x: px, y: AX - 7, class: 'tick', 'text-anchor': 'middle' }, `${t / 1000}s`));
  }
  let y = AX;
  for (const lane of m.lanes) {
    const h = laneH(lane);
    if (lane.id !== 'main') svg.append(svgEl('line', { x1: GUT - 4, x2: W - PAD, y1: y, y2: y, class: 'grid' }));
    svg.append(svgEl('text', { x: GUT - 8, y: y + 15, class: 'lane', 'text-anchor': 'end' }, trunc(lane.label, 20)));
    const mid = y + 3 + ROW / 2;
    if (lane.id === 'main') for (const [a, b] of lane.gaps) svg.append(svgEl('rect', { x: x(a), y: mid - 2, width: Math.max(1, x(b) - x(a)), height: 4, rx: 2, class: 'gap' }, svgEl('title', {}, `model thinking · ${fmtMs(b - a)}`)));
    if (lane.id === 'main' && lane.liveGap) { const [a, b] = lane.liveGap; svg.append(svgEl('rect', { x: x(a), y: mid - 3, width: Math.max(2, x(b) - x(a)), height: 6, rx: 3, class: 'gap live' }, svgEl('title', {}, `thinking now · ${fmtMs(b - a)} so far`))); }
    for (const c of lane.calls) {
      const e = m.end(c); const bad = c.status === 'error' || c.status === 'denied';
      const w = Math.max(bad ? 8 : 3, x(e) - x(c.t0));            // a refused call lasts 30 ms; it must still be visible
      const by = y + 3 + (c.row || 0) * ROW;
      const r = svgEl('rect', { x: x(c.t0), y: by, width: w, height: 13, rx: 3, class: `bar ${FAMILY(c.name)}${c.critical ? '' : ' faded'}${bad ? ' bad ' + c.status : ''}${c.status === 'pending' ? ' live' : ''}` });
      r.append(svgEl('title', {}, `${c.name} · ${callLabel(c)} · ${fmtMs(e - c.t0)}${c.critical ? '' : ' · overlapped'} · ${c.status === 'denied' ? 'refused: ' : c.status === 'error' ? 'error: ' : ''}${callOutcome(c) || c.status}`));
      r.addEventListener('click', () => jumpTo(`call-${c.id}`));
      svg.append(r);
      if (bad) { svg.append(svgEl('rect', { x: x(c.t0), y: by, width: w, height: 13, rx: 3, fill: 'url(#hatch)', class: 'bar-hatch' })); svg.append(svgEl('text', { x: x(c.t0) + w / 2, y: by - 1, class: `bad-mark ${c.status}`, 'text-anchor': 'middle' }, '✕')); }
      if (w >= 34) svg.append(svgEl('text', { x: x(c.t0) + 4, y: by + 10, class: 'bar-label' }, trunc(c.isSubagent ? ((c.task && c.task.description) || c.input.description || 'Task') : c.name, Math.max(4, Math.floor(w / 6.5)))));
    }
    y += h;
  }
  box.replaceChildren(svg);
  const main = m.lanes[0]; const wall = m.tEnd - m.t0;
  const think = main.gaps.reduce((a, [p, q]) => a + (q - p), 0);
  const saved = m.lanes.reduce((a, l) => a + l.overlapSaved, 0);
  const totals = run.el.querySelector('.tl-totals');
  const rest = Math.max(0, wall - main.busy - think);     // before the first call and after the last: startup, planning, the final answer
  const nDenied = [...run.calls.values()].filter(c => c.status === 'denied').length, nErr = [...run.calls.values()].filter(c => c.status === 'error').length;
  if (totals) { totals.replaceChildren(el('span', {}, `wall ${fmtMs(wall)} = tools on the critical path ${fmtMs(main.busy)} + model thinking between calls ${fmtMs(think)} + startup and final answer ${fmtMs(rest)}${saved > 500 ? ` · parallel calls saved ${fmtMs(saved)}` : ''}`),
    nDenied ? el('span', { class: 'st denied' }, ` · ${nDenied} refused`) : '', nErr ? el('span', { class: 'st error' }, ` · ${nErr} errors`) : '', el('span', {}, ' · click a bar to jump to the call')); }
}

/* Run summary once a run ends: what Claude Code's /cost shows, then what this page adds. */
function renderSummary(run) {
  const r = run.result || {};
  const calls = [...run.calls.values()].filter(c => !c.placeholder);
  const by = (st) => calls.filter(c => c.status === st).length;
  const subs = calls.filter(c => c.isSubagent);
  const subTok = subs.reduce((a, c) => a + ((c.task && c.task.usage && c.task.usage.total_tokens) || 0), 0);
  const subMs = subs.reduce((a, c) => a + ((c.task && c.task.usage && c.task.usage.duration_ms) || 0), 0);
  const files = new Map();
  for (const c of calls) {
    if (c.status !== 'ok') continue;
    if (c.name === 'Edit' && c.input.file_path) { const f = files.get(c.input.file_path) || { add: 0, del: 0 }; f.add += String(c.input.new_string || '').split('\n').length; f.del += String(c.input.old_string || '').split('\n').length; files.set(c.input.file_path, f); }
    if (c.name === 'Write' && c.input.file_path) { const f = files.get(c.input.file_path) || { add: 0, del: 0 }; f.add += String(c.input.content || '').split('\n').length; files.set(c.input.file_path, f); }
  }
  const steps = deriveSteps(run.items).filter(s => s.kind === 'step' && s.calls.length).length;
  const models = Object.entries(r.modelUsage || {}).map(([name, u]) => `${name.replace(/\[1m\]$/, '')} ${fmtUsd(u.costUSD)}`);
  const row = (k, v) => el('div', { class: 'sum-row' }, el('span', { class: 'k' }, k), el('span', { class: 'v' }, v));
  const box = el('details', { class: 'summary', 'data-k': 'summary', open: true }, el('summary', {}, `run summary · ${run.status === 'done' ? 'finished' : run.status}`));
  if (!r.num_turns && !calls.length) {            // failed before the agent ever started: only the reason matters
    box.append(row('what happened', 'the agent never started a turn'));
    if (r.errors && r.errors.length) box.append(row('errors', r.errors.join('; ')));
    return box;
  }
  box.append(row('cost', `${fmtUsd(r.total_cost_usd)}${models.length > 1 ? `  (${models.join(' · ')})` : ''}`));
  box.append(row('duration', `${fmtMs(r.duration_ms)} wall · ${fmtMs(r.duration_api_ms)} in the API · ${r.num_turns ?? '—'} turns`));
  if (r.usage) box.append(row('tokens', `${fmtTok((r.usage.input_tokens || 0) + (r.usage.cache_read_input_tokens || 0) + (r.usage.cache_creation_input_tokens || 0))} in (${fmtTok(r.usage.cache_read_input_tokens)} from cache) · ${fmtTok(r.usage.output_tokens)} out`));
  box.append(row('work', `${steps} steps · ${calls.length} tool calls (${by('ok')} ok · ${by('denied')} refused · ${by('error')} errors)`));
  if (subs.length) box.append(row('subagents', `${subs.length} spawned · ${fmtTok(subTok)} tokens · ${fmtMs(subMs)} of agent time${r.subagent_stats ? ` · ${r.subagent_stats.completed}/${r.subagent_stats.spawned} completed` : ''}`));
  if (files.size) box.append(row('files changed', [...files.entries()].map(([f, d]) => `${shortPath(f)} +${d.add}${d.del ? ` −${d.del}` : ''}`).join(' · ')));
  else box.append(row('files changed', 'none'));
  if (r.errors && r.errors.length) box.append(row('errors', r.errors.join('; ')));
  return box;
}

/* You + prompt on one line with the run's status word; a quiet monospace caption underneath
 * carrying the run's numbers (cost, duration, turns) plus where and what ran. */
function renderRunHead(run) {
  const head = el('div', { class: 'you' }, pill('You'), el('div', { class: 'prompt' }, run.spec.prompt || '(no prompt)'), statusWord(run.status));
  const pieces = [];
  const r = run.result;
  if (r) {
    pieces.push(el('b', {}, fmtUsd(r.total_cost_usd)), el('b', {}, fmtMs(r.duration_ms)), el('b', {}, `${r.num_turns ?? '—'} turns`));
    if (r.usage) pieces.push(el('span', {}, `${fmtTok((r.usage.input_tokens || 0) + (r.usage.cache_read_input_tokens || 0) + (r.usage.cache_creation_input_tokens || 0))} in / ${fmtTok(r.usage.output_tokens)} out`));
    if (r.subagent_stats && r.subagent_stats.spawned) pieces.push(el('span', {}, `${r.subagent_stats.completed}/${r.subagent_stats.spawned} subagents`));
  } else if (run.status === 'running') {
    pieces.push(el('span', { class: 'elapsed' }, `${fmtMs(Date.now() - run.startedAt)} elapsed`), el('span', {}, `${run.calls.size} tool calls`));
  }
  if (run.sessionId) pieces.push(el('span', { title: run.sessionId }, `${run.spec.resume ? 'resumed session' : 'session'} ${run.sessionId.slice(0, 8)}…`));
  if (run.cwd) pieces.push(el('span', { title: run.cwd }, shortPath(run.cwd)));
  if (run.spec.mode === 'replay') pieces.push(el('span', { class: 'muted', title: run.spec.recorded_flags || '' }, `replay · ${run.spec.fixture}`));
  const cap = el('div', { class: 'caption', title: [run.model, run.permissionMode && `permissions: ${run.permissionMode}`, run.version && `claude ${run.version}`].filter(Boolean).join(' · ') });
  pieces.forEach((x, i) => { if (i) cap.append(el('span', { class: 'sep' }, '·')); cap.append(x); });
  const wrap = el('div', {}, head);
  if (pieces.length) wrap.append(cap);
  return wrap;
}

function renderItems(run, items, isMain) {
  let n = 0;
  const steps = deriveSteps(items);
  return steps.map((it, idx) => {
    if (it.kind === 'step') { if (it.calls.length) n++; return renderStep(run, it, n, isMain && idx === steps.length - 1); }
    if (it.kind === 'user_text') return el('details', { class: 'note', 'data-k': `user-${idx}-${items === run.items ? 'main' : 'sub'}` }, el('summary', {}, `user turn · ${trunc(it.text.replace(/\s+/g, ' '), 90)}`), el('div', { class: 'msg-text', html: md(it.text) }));
    if (it.kind === 'divider') {
      const meta = it.detail || {};
      const line = el('div', { class: 'divider' }, `— ${it.label}${meta.trigger ? ` (${meta.trigger})` : ''}${meta.pre_tokens ? ` · ${fmtTok(meta.pre_tokens)} → ${fmtTok(meta.post_tokens)} tok` : ''} —`);
      if (it.summary) line.append(el('details', { class: 'note', 'data-k': `sum-${idx}` }, el('summary', {}, 'what the model now remembers of the earlier history (its own summary; read it when it seems to have forgotten something)'), el('div', { class: 'msg-text', html: md(it.summary) })));
      return line;
    }
    if (it.kind === 'server') return el('div', { class: 'serverline' }, it.text);
    return null;
  });
}

/* A step: "Step n" + the intention, tool rows beneath. A step without tool calls is plain
 * narration; the last one of the main agent is the answer. */
function renderStep(run, s, n, isLast) {
  const acts = s.calls.length > 0;
  const st = acts ? stepStatus(s) : '';
  const box = el('section', { class: `step ${st}${acts ? '' : ' narration'}`, id: `step-${stepKey(s)}` });
  const intent = s.texts.join('\n\n');
  const head = el('div', { class: 'step-head' });
  if (acts) head.append(el('span', { class: 'step-n' }, `Step ${n}`));
  else head.append(el('span', { class: 'step-n' }, isLast && run.status !== 'running' ? 'answer' : ''));
  head.append(intent ? el('div', { class: 'msg-text intent', html: md(intent) }) : el('div', { class: 'intent implied' }, impliedIntent(s)));
  box.append(head);
  for (const c of s.calls) box.append(renderCallRow(run, c));
  for (const g of s.groups) if (g.kind === 'assistant') for (const [, d] of g.drafts) box.append(renderDraft(d));
  const out = s.groups.filter(g => g.kind === 'assistant' && g.usage).reduce((a, g) => a + (g.usage.output_tokens || 0), 0);
  if (out) box.append(el('div', { class: 'msg-meta' }, `out ${fmtTok(out)} tok`));
  return box;
}

function renderDraft(d) {        // --include-partial-messages: content still streaming in
  if (d.type === 'text') return el('div', { class: 'msg-text draft' }, el('span', {}, d.text), el('span', { class: 'caret' }));
  if (d.type === 'thinking') return el('div', { class: 'thinking draft' }, 'thinking…');
  return el('div', { class: 'trow pending' }, el('div', { class: 'row-head' }, pill(d.name || 'tool'), el('span', { class: 'arg' }, d.json || 'building input…'), statusWord('pending')));
}

/* [pill] argument ………… outcome   ✓/pending/✕   ms  — Bash shows its description as the
 * argument and the command itself on a second faint line. */
function renderCallRow(run, c) {
  const row = el('div', { class: `trow ${c.status}${c.open ? ' open' : ''}`, id: `call-${c.id}` });
  const bad = c.status === 'error' || c.status === 'denied';
  const plain = (c.name === 'Bash' && c.input.description) || c.isSubagent;
  row.append(el('div', { class: 'row-head', onclick: () => { c.open = !c.open; renderRun(run); } },
    pill(c.isSubagent ? 'Task' : c.name),
    el('span', { class: `arg${plain ? ' plain' : ''}` }, callLabel(c)),
    el('span', { class: `outcome${bad ? ' bad' : /\b\d+ (failed|errors?)\b/.test(callOutcome(c)) ? ' warn' : ''}` }, callOutcome(c)),
    statusWord(c.status),
    el('span', { class: 'ms' }, c.endedAt ? fmtMs(c.endedAt - c.startedAt) : '')));
  if (c.name === 'Bash' && c.input.command) row.append(el('div', { class: 'cmd' }, c.input.command));
  if (c.injected) row.append(el('details', { class: 'note injected', 'data-k': `inj-${c.id}` }, el('summary', {}, `skill text injected into the conversation · ${fmtTok(c.injected.length)} chars`), el('div', { class: 'msg-text', html: md(c.injected) })));
  if (c.open) row.append(renderCallBody(run, c));
  else if (!c.isSubagent && c.status !== 'denied' && !NO_PREVIEW.has(c.name)) { const pv = renderPreview(run, c); if (pv) row.append(pv); }
  if (c.isSubagent) row.append(renderSubagent(run, c));
  return row;
}

/* Deliberate cut: a closed row still shows the first lines of its result (the tail, for an
 * error) and says how much is hidden. Click the row for everything. */
const PREVIEW_OK = 4, PREVIEW_ERR = 6;
const NO_PREVIEW = new Set(['Skill', 'Edit', 'Write']);   // their outcome line already says everything
function renderPreview(run, c) {
  const parts = c.result || [];
  const img = parts.find(p => p.type === 'image');
  if (img) return el('img', { class: 'result-img small', src: img.src, alt: 'tool result image' });
  const text = resultText(c);
  if (!text.trim()) return null;
  const lines = text.replace(/\s+$/, '').split('\n');
  const shown = c.isError ? lines.slice(-PREVIEW_ERR) : lines.slice(0, PREVIEW_OK);
  const box = el('div', { class: 'preview' }, el('pre', { class: `block slim${c.isError ? ' err' : ''}` }, shown.join('\n')));
  const hidden = lines.length - shown.length;
  if (hidden > 0) box.append(el('button', { class: 'fold', type: 'button', onclick: () => { c.open = true; renderRun(run); } }, `▸ ${hidden} more lines, folded`));
  return box;
}

/* Expanded result: cut at 60 lines with a count, never a scrollbox that hides the length. */
const FULL_CUT = 60;
function renderFullText(run, c, text, cls) {
  const lines = text.split('\n');
  if (lines.length <= FULL_CUT || c.resultOpen) return [el('pre', { class: cls }, text)];
  return [el('pre', { class: cls }, lines.slice(0, FULL_CUT).join('\n')),
          el('button', { class: 'fold', type: 'button', onclick: () => { c.resultOpen = true; renderRun(run); } }, `▸ show all ${lines.length} lines`)];
}

function renderCallBody(run, c) {
  const body = el('div', { class: 'call-body' });
  body.append(el('h4', {}, 'input'));
  if (c.name === 'Edit' && c.input && 'old_string' in c.input) {
    body.append(el('div', { class: 'kv' }, el('span', { class: 'k' }, 'file'), el('span', {}, c.input.file_path)));
    body.append(el('pre', { class: 'block err' }, '- ' + c.input.old_string), el('pre', { class: 'block' }, '+ ' + c.input.new_string));
  } else if (c.name === 'Bash') {
    body.append(el('pre', { class: 'block' }, c.input.command || ''));
  } else if (c.name === 'Write') {
    body.append(el('div', { class: 'kv' }, el('span', { class: 'k' }, 'file'), el('span', {}, c.input.file_path)), el('pre', { class: 'block' }, trunc(c.input.content, 3000)));
  } else {
    body.append(el('pre', { class: 'block' }, JSON.stringify(c.input, null, 1)));
  }
  if (!c.isSubagent) {
    body.append(el('h4', {}, c.isError ? 'result (error)' : 'result'));
    if (!c.result) body.append(el('div', { class: 'muted' }, c.status === 'pending' ? 'waiting…' : '(no result)'));
    else for (const part of c.result) body.append(...(part.type === 'image' ? [el('img', { class: 'result-img', src: part.src, alt: 'tool result image' })] : renderFullText(run, c, part.text, `block${c.isError ? ' err' : ''}`)));
  }
  body.append(el('details', { class: 'raw', 'data-k': `raw-${c.id}` }, el('summary', {}, 'raw events'), el('pre', { class: 'block' }, JSON.stringify({ tool_use: c.rawUse, tool_result: c.rawResult }, null, 1))));
  return body;
}

/* The harness prefixes every subagent report with a fixed disclaimer paragraph ending in
 * "The report follows:"; the reader wants the report. */
const stripHandback = (t) => String(t || '').replace(/^\s*\[Subagent hand-back\][\s\S]*?The report follows:\s*/i, '').replace(/^ {2}/gm, '');

/* A subagent hangs off its Task row as a tree: ▾/▸ toggle, the brief it was given, its own
 * steps, and its final report. Collapsed it reads "· N events collapsed". */
function renderSubagent(run, c) {
  const t = c.task || {};
  const stat = c.status === 'pending' ? 'running' : c.status === 'error' ? 'failed' : 'done';
  const nCalls = [...run.walkCalls(c.children)].length;
  const nEvents = c.childEvents || c.children.length;
  const u = t.usage || (t.progress && t.progress.usage);
  const prog = c.status === 'pending' ? (t.progress ? `${t.progress.lastTool ? t.progress.lastTool + ': ' : ''}${t.progress.text || ''}` : 'starting…')
             : u ? `${fmtTok(u.total_tokens)} tok · ${u.tool_uses} tool calls · ${fmtMs(u.duration_ms)}` : '';
  const box = el('div', { class: `subagent ${stat}` });
  box.append(el('div', { class: 'subagent-head', onclick: () => { c.subOpen = !c.subOpen; c.subTouched = true; renderRun(run); } },
    el('span', { class: 'tri' }, c.subOpen ? '▼' : '▶'),
    el('span', {}, c.subOpen ? `${t.type ? t.type + ' subagent' : 'subagent'} trajectory` : `· ${nEvents} events collapsed — ${t.description || 'subagent'}`),
    el('span', { class: 'prog' }, prog)));
  const brief = c.brief || t.prompt;
  if (c.subOpen && brief) box.append(el('details', { class: 'note', 'data-k': `brief-${c.id}` }, el('summary', {}, `task brief · ${trunc(firstSentence(brief), 90)}`), el('div', { class: 'msg-text', html: md(brief) })));
  if (c.subOpen) box.append(el('div', { class: 'timeline' }, ...renderItems(run, c.children, false)));
  if (c.result && c.result.length) {
    const rep = el('details', { class: 'note', 'data-k': `rep-${c.id}`, open: true }, el('summary', {}, c.isError ? 'subagent failed — report' : `report from ${t.description || 'the subagent'}`));
    for (const part of c.result) rep.append(part.type === 'image' ? el('img', { class: 'result-img', src: part.src }) : el('div', { class: 'msg-text', html: md(stripHandback(part.text)) }));
    box.append(rep);
  }
  return box;
}

/* ------------------------------------------------------------------ outline: a chain of pills */
function jumpTo(id) {
  const t = document.getElementById(id); if (!t) return;
  t.scrollIntoView({ behavior: 'smooth', block: 'center' });
  t.animate([{ outline: '2px solid var(--accent)' }, { outline: '2px solid transparent' }], 1200);
}
function outlineChain(run, items, frag) {
  let n = 0;
  for (const s of deriveSteps(items)) {
    if (s.kind !== 'step' || !s.calls.length) continue;
    n++;
    const key = stepKey(s);
    frag.append(el('div', { class: `o-step ${stepStatus(s)}`, onclick: () => jumpTo(`step-${key}`) }, el('span', { class: 'n' }, String(n)), el('span', { class: 'txt' }, firstSentence(s.texts[0]) || impliedIntent(s))));
    const calls = el('div', { class: 'o-calls' });
    for (const c of s.calls) {
      calls.append(el('span', { class: `o-call ${c.status}`, title: `${c.name} ${callLabel(c)} — ${callOutcome(c)}`, onclick: () => jumpTo(`call-${c.id}`) }, pill(c.isSubagent ? 'Task' : c.name, 'sm')));
    }
    frag.append(calls);
    for (const c of s.calls) if (c.isSubagent && c.children.length) {
      const branch = el('div', { class: `o-branch ${c.status}` },
        el('div', { class: 'o-branch-head', onclick: () => jumpTo(`call-${c.id}`) }, el('span', { class: 'elbow' }, '↳'), pill('Task', 'sm'), el('span', { class: 'txt' }, trunc((c.task && c.task.description) || c.input.description || 'subagent', 26))));
      outlineChain(run, c.children, branch); frag.append(branch);
    }
  }
  return n;
}
function followOutline() {
  const box = $('#outline'); const live = RUNS.find(r => r.status === 'running'); if (!box || !live) return;
  const steps = box.querySelectorAll(`.outline-run:nth-child(${RUNS.indexOf(live) + 1}) .o-step`);
  const last = steps[steps.length - 1]; if (last) last.scrollIntoView({ block: 'nearest' });
}
function renderOutline() {
  const body = $('#outline-body'); body.innerHTML = '';
  if (!RUNS.length) { body.append(el('p', { class: 'muted' }, 'No runs yet.')); return; }
  RUNS.forEach((run, i) => {
    const sec = el('div', { class: 'outline-run' });
    sec.append(el('div', { class: 'outline-title', onclick: () => run.el && run.el.scrollIntoView({ behavior: 'smooth', block: 'start' }) }, pill('You', 'sm'), el('span', { class: 'muted' }, trunc(run.spec.prompt, 34))));
    const chain = el('div', { class: 'chain' });
    const n = outlineChain(run, run.items, chain);
    if (n) sec.append(chain); else sec.append(el('div', { class: 'muted', style: 'font-size:11.5px' }, run.status === 'running' ? 'waiting…' : 'no tool calls'));
    body.append(sec);
  });
}

/* ================================================================== wiring: composer + SSE */
let CONFIG = {}, FIXTURES = {};
/* Replay: the recorded prompt goes into the prompt box, so the You line shows the task the
 * agent was actually given (the stream never echoes it; record.sh saved it in the .meta file). */
function fillRecordedPrompt() {
  if ($('#mode').value !== 'replay') return;
  const f = FIXTURES[$('#fixture').value];
  $('#prompt').value = (f && f.prompt) || '';
  $('#prompt').placeholder = f && !f.prompt ? '(prompt not recorded — this recording has no .meta file)' : '';
}
async function init() {
  try {
    CONFIG = await (await fetch('/api/config')).json();
    $('#cwd').value = CONFIG.default_cwd || '';
    const fx = await (await fetch('/api/fixtures')).json();
    const sel = $('#fixture'); sel.innerHTML = '';
    for (const f of fx.fixtures) { FIXTURES[f.name] = f; sel.append(el('option', { value: f.name }, f.name)); }
    sel.addEventListener('change', fillRecordedPrompt);
    $('#server-state').textContent = 'server ok'; $('#server-state').className = 'chip ok';
  } catch (e) {
    $('#server-state').textContent = 'server unreachable'; $('#server-state').className = 'chip err';
  }
  $('#mode').addEventListener('change', () => { updateComposer(); fillRecordedPrompt(); });
  $('#resume').addEventListener('change', updateComposer);
  $('#toggle-outline').addEventListener('click', () => $('#outline').classList.toggle('open'));
  $('#composer').addEventListener('submit', onSubmit);
  $('#stop').addEventListener('click', onStop);
  $('#clear').addEventListener('click', onClear);
  $('#prompt').addEventListener('keydown', (ev) => { if ((ev.metaKey || ev.ctrlKey) && ev.key === 'Enter') $('#composer').requestSubmit(); });
  setInterval(() => { for (const r of RUNS) if (r.status === 'running' && r.el) { const e = r.el.querySelector('.elapsed'); if (e) e.textContent = `${fmtMs(Date.now() - r.startedAt)} elapsed`; const a = r.el.querySelector('.alive-text'); if (a) a.textContent = aliveText(r); const al = r.el.querySelector('.alive'); if (al) al.classList.toggle('thinking', !!(r.thinkingAt && Date.now() - r.thinkingAt < 4000)); if (r.thinkingAt && Date.now() - r.thinkingAt < 4000) drawTimeline(r); } }, 1000);
  await restoreRuns();
  updateComposer();
}

/* A reload must not lose the conversation: the server still holds every run of this process,
 * and subscribing to a finished run replays its whole backlog at once. */
async function restoreRuns() {
  let list = [];
  try { list = (await (await fetch('/api/runs')).json()).runs || []; } catch (e) { return; }
  list.sort((a, b) => (a.started || 0) - (b.started || 0));
  list.forEach((info, i) => {
    const run = new Run(info.id, info.spec || {});
    if (info.started) run.startedAt = info.started * 1000;
    run.folded = i < list.length - 1;
    RUNS.push(run); renderRun(run); attachStream(run);
  });
  if (list.length) renderOutline();
}

function attachStream(run, attempt = 0) {
  const es = new EventSource(`/api/events/${run.id}`);
  es.onmessage = (m) => { try { run.apply(JSON.parse(m.data)); } catch (err) { run.items.push({ kind: 'server', text: `bad event: ${err}` }); scheduleRender(run); } };
  es.addEventListener('done', () => { es.close(); run.streamEnded(); scheduleRender(run); });
  es.onerror = async () => {
    es.close();
    if (run.status !== 'running') return;
    /* The connection dropped mid-run (server restarted?). If the server still knows the run,
     * rebuild it from the backlog it replays; only give up when it really is gone. */
    let known = false;
    for (let tries = 0; tries < 6 && !known; tries++) {          // the server may need a few seconds to come back
      await new Promise(r => setTimeout(r, 1500 + 1000 * tries));
      try { known = ((await (await fetch('/api/runs')).json()).runs || []).some(r => r.id === run.id); } catch (e) { known = false; }
    }
    if (known && attempt < 2) {
      const fresh = new Run(run.id, run.spec); fresh.startedAt = run.startedAt; fresh.folded = run.folded; fresh.el = run.el;
      RUNS[RUNS.indexOf(run)] = fresh; renderRun(fresh); attachStream(fresh, attempt + 1);
    } else {
      run.status = 'failed';
      run.error = 'lost the connection to the server while the run was in progress (was it restarted?). The agent itself may have finished; its session file is under ~/.claude/projects.';
      scheduleRender(run);
    }
  };
}

function lastSessionId() {
  for (let i = RUNS.length - 1; i >= 0; i--) if (RUNS[i].sessionId && RUNS[i].status !== 'running' && RUNS[i].spec.mode !== 'replay') return RUNS[i].sessionId;
  return null;
}

function updateComposer() {
  const replay = $('#mode').value === 'replay';
  $('#fixture-wrap').hidden = !replay; $('#cwd-wrap').hidden = replay; $('#partial-wrap').hidden = replay;
  const sid = lastSessionId();
  $('#resume').disabled = replay || !sid; $('#resume-id').textContent = sid ? sid.slice(0, 8) + '…' : '';
  if (!replay) $('#prompt').placeholder = sid && $('#resume').checked ? 'type a follow-up…' : 'What should the agent do in that directory?  e.g. find the bug that makes test_parse fail and fix it';
  const running = RUNS.some(r => r.status === 'running');
  $('#stop').disabled = !running;
  $('#run').disabled = running && !replay;      // one live run at a time; replays may overlap
}

async function onSubmit(ev) {
  ev.preventDefault();
  const mode = $('#mode').value;
  const spec = { mode, prompt: $('#prompt').value.trim(), cwd: $('#cwd').value.trim(),
                 resume: (!$('#resume').disabled && $('#resume').checked) ? lastSessionId() : null,
                 partial: $('#partial').checked, fixture: $('#fixture').value };
  if (mode === 'live' && !spec.prompt) { $('#prompt').focus(); return; }
  if (mode === 'replay') { const f = FIXTURES[spec.fixture] || {}; spec.prompt = spec.prompt || f.prompt || '(prompt not recorded — stream-json does not echo it)'; spec.cwd = f.cwd || spec.cwd; }
  const res = await fetch('/api/run', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(spec) });
  const { run_id } = await res.json();
  for (const r of RUNS) if (r.status !== 'running') { r.folded = true; renderRun(r); }   // older exchanges fold away
  const run = new Run(run_id, spec); RUNS.push(run); renderRun(run); renderOutline(); updateComposer();
  $('#prompt').value = '';
  attachStream(run);
  FOLLOW = true; UNSEEN = 0; updateFollowButton();   // a run just submitted: follow it until the reader scrolls up
}

/* Clean slate for a live demo: finished runs are dropped on the server too, so a reload
 * does not bring them back. A run that is still going stays. */
async function onClear() {
  await fetch('/api/clear', { method: 'POST' });
  for (const r of RUNS) if (r.status !== 'running' && r.el) r.el.remove();
  RUNS.splice(0, RUNS.length, ...RUNS.filter(r => r.status === 'running'));
  if (!RUNS.length) $('#runs').append(el('p', { class: 'empty muted' }, 'Clean slate. Type a request below and press Run, or pick a recording to replay.'));
  FOLLOW = false; UNSEEN = 0; updateFollowButton(); renderOutline(); updateComposer();
  window.scrollTo(0, 0);
}

async function onStop() {
  const run = [...RUNS].reverse().find(r => r.status === 'running'); if (!run) return;
  await fetch(`/api/stop/${run.id}`, { method: 'POST' });
  run.status = 'stopped'; run.error = run.error || 'stopped by user'; scheduleRender(run);
}

init();
