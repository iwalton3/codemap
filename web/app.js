/**
 * codemap web UI — router-driven pages over the JSON API (src/serve.ts).
 * Read-only exploration; documenting happens through the agent/MCP.
 *
 * Routes:
 *   /                          → home (redirect to primary universe)
 *   /u/:universe/tree/<path>/  → outline browser (dir → file → symbols)
 *   /u/:universe/anchor/:id/   → anchor + live source
 *   /u/:universe/node/:id/     → documented node (markdown) + links
 *   /u/:universe/search/?q=    → search results
 * (the tree route uses a :path wildcard to capture multi-segment prefixes.)
 */
import { defineComponent, Component, html, when, each, Store, raw } from './vendor/vdx/framework.js';
import { enableRouting } from './vendor/vdx/router.js';

async function api(path, params = {}) {
  const qs = new URLSearchParams(Object.fromEntries(Object.entries(params).filter(([, v]) => v != null && v !== '')));
  const r = await fetch(path + (qs.toString() ? '?' + qs : ''));
  if (!r.ok) throw new Error('HTTP ' + r.status);
  return r.json();
}

// One stable <main> literal for every page. vdx tears down and rebuilds a
// component's whole subtree whenever template()'s top-level literal changes
// identity (see the framework's isSameCompiled) — so returning a *distinct*
// `html<main>…` for the loading, error, and loaded states deletes and re-creates
// the page node on each transition, which resets the window scroll position.
// Routing every page through this single literal keeps the page node stable and
// patches content in place instead. The loading placeholder shows only while
// there is no data yet, so an in-place refetch (mark / verify / triage) never
// collapses the page and loses scroll; pages null out their data in propsChanged
// so a genuine navigation still shows loading and starts back at the top.
const pageShell = (data, error, body) =>
  html`<main>${when(!data, () => html`<div class="loading">loading…</div>`,
    () => when(error, () => html`<div class="empty">${error}</div>`, body))}</main>`;

class NavStore extends Store {
  constructor() { super(); this.state = { universes: [], current: null }; }
  async load() { if (this.state.universes.length) return; this.state.universes = (await api('/api/universes')).universes; }
}
const nav = new NavStore();

let router;
const go = (path, query) => router.navigate(path, query);
const dashUrl = (u) => `/u/${u}/`;
const goTree = (u, prefix) => router.navigate(`/u/${u}/tree/` + (prefix ? prefix + '/' : ''));
const anchorUrl = (u, id) => `/u/${u}/anchor/${id}/`;
const nodeUrl = (u, id) => `/u/${u}/node/${id}/`;
const nodeReviewUrl = (u, id) => `/u/${u}/node/${id}/review/`;
const graphUrl = (u, id) => `/u/${u}/graph/${id}/`;

const barColor = (pct) => pct === 0 ? '#3a4250' : `hsl(${Math.round(pct * 1.2)}, 55%, 48%)`;
const KICON = { dir: '▸', file: '≡' };
const NODE_COLORS = {
  event_family: '#7ee787', aggregate: '#58a6ff', projection: '#f0a35e', command: '#d2a8ff',
  handler: '#79c0ff', module: '#8b95a3', process: '#f778ba', step: '#a5d6ff',
  state: '#e3b341', transition: '#8b95a3', unknown: '#3a4250',
};
const nodeColor = (t) => NODE_COLORS[t] ?? NODE_COLORS.unknown;
const EDGE_COLORS = {
  folds: '#7ee787', projects: '#f0a35e', emits: '#79c0ff', handles: '#d2a8ff',
  touches: '#f778ba', step_of: '#a5d6ff', part_of: '#8b95a3', depends_on: '#58a6ff', calls_api: '#ffab70',
  state_of: '#e3b341', transition_of: '#8b95a3', transitions_to: '#e3b341', from_state: '#8b95a3', on_event: '#79c0ff', initial_state: '#7ee787',
};
const edgeColor = (t) => EDGE_COLORS[t] ?? '#6b7684';
const bugsUrl = (u) => `/u/${u}/bugs/`;
const prsUrl = (u) => `/u/${u}/prs/`;
const prUrl = (u, n) => `/u/${u}/pr/${n}/`;
const SEV_COLOR = { low: '#8b95a3', medium: '#58a6ff', high: '#f0a35e', critical: '#f27b7b', complete: '#7ee787', untriaged: '#58a6ff' };
// Attention priority (mirrors server SEV_RANK) — drives the worklist sort/grouping.
const SEV_RANK = { critical: 5, untriaged: 4, high: 3, medium: 2, low: 1, complete: 0 };
const SEV_ORDER = ['critical', 'untriaged', 'high', 'medium', 'low']; // worklist tiers, top-down (complete excluded)
const flowsUrl = (u) => `/u/${u}/flows/`;
const flowUrl = (u, id) => `/u/${u}/flow/${id}/`;
const nodesUrl = (u) => `/u/${u}/nodes/`;
const matrixUrl = (u) => `/u/${u}/matrix/`;
const pipelineUrl = (u) => `/u/${u}/pipeline/`;
const stateMapUrl = (u) => `/u/${u}/statemap/`;
const REV_COLOR = { reviewed: '#7ee787', stale: '#f0a35e', unreviewed: '#3a4250' };
// Actor-aware review rendering: human review = green (`on`), agent `checked` = blue.
// `via` says how a tick was earned (see markBtnEl): direct, ↻ borrowed from a
// lineage this ref does not descend from, or ⟲ sitting on top of a revert. Every
// surface that draws a review mark takes it, or the summaries quietly disagree
// with the buttons they summarise.
const revCls = (state, actor, via) => state === 'reviewed' ? (via === 'reverted' ? 'reverted' : actor === 'agent' ? 'checked' : 'on') : state === 'stale' ? 'stale' : '';
const revColorA = (info) => {
  const s = info && info.state, a = info && info.actor, v = info && info.via;
  return s === 'reviewed' ? (v === 'reverted' ? '#f0a35e' : a === 'agent' ? '#58a6ff' : '#7ee787') : s === 'stale' ? '#f0a35e' : '#3a4250';
};
const revMark = (state, actor, via) => state === 'reviewed'
  ? (via === 'reverted' ? ' ⟲' : via === 'replayed' ? ' ↻' : actor === 'agent' ? ' ·' : ' ✓')
  : state === 'stale' ? ' ⚠' : '';
const VIA_TIP = { reverted: ' — approved before the code moved BACK to this body on this branch; someone undid work', replayed: ' — approval borrowed from a branch this one does not descend from' };
// Doc-version status (see docs/doc-versioning.md).
const STATUS = { fresh: '#7ee787', stale: '#f0a35e', dangling: '#f27b7b', removed: '#8b95a3', generated: '#6b7684' };
const statusChip = (s, extra) => s && s !== 'generated' ? html`<span class="stchip ${s}" title="doc version: ${s}${extra || ''}">${s}</span>` : html``;
// Trust tier (freshness × who confirmed): verified (human) / checked (agent) / stale.
// unverified + generated are the baseline — not chipped, to keep lists quiet.
const TRUST_TIP = { verified: 'human-reviewed — rely on it', checked: 'agent-checked against code — solid, spot-check if critical', stale: 'code changed — needs re-validation' };
// A clickable chip when `onClick` is given: click a `checked`/`unverified` doc to
// promote it to human-`verified`; click `verified` to drop the human mark. Baseline
// `unverified` only chips when actionable (keeps read-only lists quiet).
const trustChip = (t, onClick) => {
  if (!TRUST_TIP[t] && t !== 'unverified') return html``;
  if (t === 'unverified' && !onClick) return html``;
  const can = onClick && t !== 'stale';
  const act = t === 'verified' ? 'unverify' : 'verify';
  const tip = `trust: ${t}${TRUST_TIP[t] ? ' — ' + TRUST_TIP[t] : ''}${can ? ' · click to ' + act : ''}`;
  return html`<span class="tchip ${t} ${can ? 'clickable' : ''}" title="${tip}" on-click="${can ? (e) => { if (e.stopPropagation) e.stopPropagation(); onClick(act); } : null}">${t}</span>`;
};
const postConfirm = (u, id) => fetch('/api/confirm', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ u, id }) });
const postAckHole = (u, id) => fetch('/api/ack_hole', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ u, id }) });
// attestation: 'viewed' (exposure) | 'signed' (sign-off) | undefined (server → signed).
// `ref` (a PR head sha) witnesses the mark against the code actually on screen —
// without it a PR sign-off records the working tree's hash, i.e. code never read.
const postReview = (u, targetKind, targetId, level, unmark, attestation, ref) =>
  fetch('/api/review', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ u, targetKind, targetId, level, unmark, attestation, ref }) });
// Stakes triage (human source → confirmed tier). `body` = { importance } or { clear:true }.
const postTriage = (u, targetKind, targetId, body) =>
  fetch('/api/triage', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ u, targetKind, targetId, ...body }) });
// Severity = stakes × complexity × review-gap (docs/triage.md). Chip = worst outstanding gap.
const sevChip = (t) => {
  if (!t) return html``;
  const sev = t.severity;
  const label = sev === 'complete' ? 'review-complete' : sev === 'untriaged' ? 'needs triage' : `${sev}${t.bar ? ' · needs ' + t.bar : ''}`;
  const imp = t.importance ? t.importance + (t.likely ? ' (likely)' : '') : 'untriaged';
  return html`<span class="tchip" style="background:${SEV_COLOR[sev] || '#3a4250'};color:#0d1117;font-weight:600" title="stakes: ${imp} · complexity: ${t.complexity || '—'} · severity: ${sev}${t.reason ? ' · ' + t.reason : ''}">${label}</span>`;
};
// A small severity dot for dense lists (catalog rows, anchor chips) where a chip is too big.
const sevDot = (sev) => sev && sev !== 'untriaged' && sev !== 'complete'
  ? html`<span class="sevdot" style="background:${SEV_COLOR[sev] || '#3a4250'}" title="severity: ${sev}"></span>` : html``;
// Tripwire "push": a native browser Notification for newly-fired tripwires — no deps.
// Deduped per universe via localStorage, and self-pruning (a resolved tripwire drops out
// of `seen`, so it re-notifies if it fires again). No-op unless permission is granted.
function notifyTripwires(u, fired) {
  if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return;
  const firedKeys = (fired || []).map(f => f.kind + ':' + f.id);
  let seen = [];
  try { seen = JSON.parse(localStorage.getItem('tw_seen_' + u) || '[]'); } catch { seen = []; }
  const seenSet = new Set(seen);
  const fresh = firedKeys.filter(k => !seenSet.has(k));
  if (fresh.length) {
    const body = (fired || []).filter(f => fresh.includes(f.kind + ':' + f.id)).slice(0, 5).map(f => f.id).join(', ');
    try { new Notification(`codemap — ${fresh.length} tripwire${fresh.length === 1 ? '' : 's'} fired`, { body: `${u}: business-critical code you're watching changed — ${body}`, tag: 'codemap-tripwire-' + u }); } catch { /* ignore */ }
  }
  try { localStorage.setItem('tw_seen_' + u, JSON.stringify(firedKeys)); } catch { /* ignore */ }
}
// Review-complete rollup (Phase 3): "% complete" + a stacked severity bar + what's outstanding.
// The "am I done reviewing this?" readout — stakes-relative, so plumbing never blocks it.
const COV_ORDER = ['complete', 'low', 'medium', 'high', 'untriaged', 'critical'];
const coverageBar = (cov) => {
  if (!cov || !cov.total) return html``;
  const seg = (sev) => { const n = cov.bySeverity[sev] || 0; return n ? html`<span title="${sev}: ${n}" style="display:inline-block;height:9px;width:${Math.max(3, Math.round(n / cov.total * 140))}px;background:${SEV_COLOR[sev] || '#3a4250'}"></span>` : html``; };
  return html`<span class="cov" style="display:inline-flex;align-items:center;gap:6px" title="${cov.complete}/${cov.total} anchors review-complete">
    <b>${cov.completePct}%</b><span style="color:#8b949e">review-complete</span>
    <span style="display:inline-flex;gap:1px;border-radius:2px;overflow:hidden">${each(COV_ORDER, s => seg(s), s => s)}</span>
    ${when(cov.outstanding, () => html`<span style="color:#8b949e">${cov.outstanding} left${cov.worst ? ' · worst ' + cov.worst : ''}</span>`)}
  </span>`;
};
// Shared review/triage renderers so every surface (anchor, node, flow, diff) reads the
// same: `viewed` (blue) + `signed` (green) marks, then the stakes buttons + severity chip.
// A green tick earned three different ways is three different claims, so the mark
// says which. `direct` you approved here; `replayed` you approved this exact body
// on another branch (a stack walk, a rebase) — real, but borrowed; `reverted` the
// code moved BACK to a body you approved before it was superseded on this very
// history, which is someone undoing work and is the one worth interrupting for.
const VIA_MARK = { replayed: ' ↻', reverted: ' ⟲' };
const whereFrom = (p) => (p ? `${p.branch || (p.commit ? p.commit.slice(0, 7) : 'unknown')}${p.at ? ' · ' + p.at.slice(0, 10) : ''}` : 'unknown');
const markBtnEl = (attestation, info, onMark) => {
  const st = (info && info.state) || 'unreviewed';
  const actor = info && info.actor;
  const via = info && info.via;
  const agent = st === 'reviewed' && actor === 'agent'; // agent `checked`, not a human vouch
  const on = attestation === 'signed';
  // A human sign-off is green; an agent-checked vouch (or a viewed mark) is blue.
  const cls = st === 'reviewed'
    ? (via === 'reverted' ? 'reverted' : on && !agent ? 'on' : 'checked')
    : st === 'stale' ? 'stale' : '';
  const mk = st === 'reviewed' ? (VIA_MARK[via] || ' ✓') : st === 'stale' ? ' ⚠' : '';
  const tip = st !== 'reviewed'
    ? `${attestation}: ${st}${st === 'stale' ? ' — code changed, click to re-approve at the live hash' : ' — click to mark'}`
    : via === 'reverted'
      ? `${attestation}: this body was approved on ${whereFrom(info.acceptedAt)}, then superseded on this branch by ${whereFrom(info.revertedFrom)} — the code has since moved BACK. Someone undid work; re-read before trusting the tick.`
      : via === 'replayed'
        ? `${attestation}: replayed — you approved this exact body on ${whereFrom(info.acceptedAt)}, which this branch does not descend from. Same code, approval borrowed from there.`
        : `${attestation}: ${st}${agent ? ' (agent-checked — click to confirm as human)' : ' — click to clear'}`;
  return html`<button class="${cls}" title="${tip}" on-click="${(e) => { if (e.stopPropagation) e.stopPropagation(); onMark(attestation, st, actor); }}">${attestation}${mk}</button>`;
};
const reviewRowEl = (review, viewed, onMark, level = 'code') => {
  const sign = review && review[level], view = viewed && viewed[level];
  // Signing is a stronger act than viewing, so a HUMAN sign-off implies you viewed it:
  // once human-signed, drop the now-redundant viewed button. An agent `checked` vouch
  // is not a human sign-off — keep viewed available so the human can still mark/sign.
  const humanSigned = sign && sign.state === 'reviewed' && sign.actor !== 'agent';
  return html`<span class="rev">${when(!humanSigned, () => markBtnEl('viewed', view, onMark))}${markBtnEl('signed', sign, onMark)}${when(sign && sign.state === 'stale', () => html`<span class="hint" style="margin-left:6px;color:#f0a35e">⚠ sign-off stale</span>`)}</span>`;
};
// A node's code review is DERIVED from the code reviews of the segments it cites
// (server: deriveCodeReview) — a read-only rollup, never a one-click "I signed the
// node's code". You reach "code reviewed" only by reading & signing each segment.
const codeRollupEl = (cr) => {
  if (!cr || !cr.total) return html`<span class="dim" style="font-size:12px">code: no reviewable segments</span>`;
  const c = cr.state === 'reviewed' ? '#7ee787' : cr.state === 'stale' ? '#f0a35e' : '#8b949e';
  const label = cr.state === 'reviewed' ? `code reviewed — all ${cr.total} segment${cr.total === 1 ? '' : 's'} signed`
    : `code: ${cr.signed}/${cr.total} segment${cr.total === 1 ? '' : 's'} signed${cr.stale ? ` · ${cr.stale} stale` : ''}`;
  return html`<span class="rev" style="align-items:center;gap:6px"><span style="display:inline-block;width:9px;height:9px;border-radius:50%;background:${c}"></span><span style="color:${c}">${label}</span>${viaNote(cr)}${when(cr.state !== 'reviewed', () => html`<span class="dim" style="font-size:12px">— read &amp; sign each segment below</span>`)}</span>`;
};
// A rollup that hides how its ticks were earned is the same lie the per-segment
// mark was fixed to stop telling, one level up. `reverted` outranks `replayed`:
// borrowed approval is fine, approval sitting on undone work is not.
const viaNote = (cr) => {
  if (!cr) return html``;
  if (cr.reverted) return html`<span class="viaflag rev-back" title="${cr.reverted} segment(s) approved before the code moved BACK to that body on this branch — someone undid work">⟲ ${cr.reverted} reverted</span>`;
  if (cr.replayed) return html`<span class="viaflag rev-replay" title="${cr.replayed} segment(s) whose approval is borrowed from a branch this one does not descend from">↻ ${cr.replayed} replayed</span>`;
  return html``;
};

// Client-side rollup of a node's cited segments, from the same resolvedAnchors the
// node page renders below — so the summary can't disagree with the list, and it
// still works if the server predates the `codeReview` field. Mirrors server
// deriveCodeReview (reviews.ts). Missing (renamed/removed) anchors are excluded.
const deriveCode = (anchors) => {
  const seg = (anchors || []).filter(a => !a.missing && a.review && a.review.code);
  const total = seg.length;
  const signed = seg.filter(a => a.review.code.state === 'reviewed').length;
  const stale = seg.filter(a => a.review.code.state === 'stale').length;
  const replayed = seg.filter(a => a.review.code.state === 'reviewed' && a.review.code.via === 'replayed').length;
  const reverted = seg.filter(a => a.review.code.state === 'reviewed' && a.review.code.via === 'reverted').length;
  return { state: total === 0 ? 'unreviewed' : stale ? 'stale' : signed === total ? 'reviewed' : 'unreviewed', signed, total, stale, replayed, reverted };
};
// Compact derived-code indicator for dense list rows (catalog, matrix). Read-only
// rollup — code review is per-segment, so it opens the node rather than signing.
const codeMark = (cr) => (!cr || !cr.total) ? 'C'
  : cr.state === 'reviewed' ? (cr.reverted ? 'C⟲' : cr.replayed ? 'C↻' : 'C✓')
    : cr.state === 'stale' ? 'C⚠' : `C ${cr.signed}/${cr.total}`;
const codeTip = (cr) => (!cr || !cr.total) ? 'no reviewable code segments'
  : `code: ${cr.signed}/${cr.total} segment${cr.total === 1 ? '' : 's'} signed${cr.stale ? ' · ' + cr.stale + ' stale' : ''}`
    + (cr.reverted ? ` · ${cr.reverted} sitting on a revert (code moved back to a body signed before it was superseded here)` : '')
    + (cr.replayed ? ` · ${cr.replayed} borrowed from another branch` : '')
    + ' — open to read & sign each';
const codeCellBtn = (cr, onOpen) => {
  const st = cr ? cr.state : 'unreviewed';
  const cls = st === 'reviewed' ? (cr && cr.reverted ? 'reverted' : 'on') : st === 'stale' ? 'stale' : '';
  return html`<button class="${cls}" title="${codeTip(cr)}" on-click="${(e) => { if (e.stopPropagation) e.stopPropagation(); onOpen(); }}">${codeMark(cr)}</button>`;
};
// Two axes: `stakes` (blast radius) and `complexity` (verification difficulty) — set
// independently. onSet receives a patch: { importance } | { complexity } | { clear:true }.
const triageRowEl = (triage, onSet, onTripwire) => {
  const cur = triage && triage.importance, ccur = triage && triage.complexity;
  const sbtn = (imp, label) => html`<button class="${cur === imp ? 'on' : ''}" title="set stakes (blast radius): ${imp}" on-click="${(e) => { if (e.stopPropagation) e.stopPropagation(); onSet({ importance: imp }); }}">${label}</button>`;
  const cbtn = (cx, label, tip) => html`<button class="${ccur === cx ? 'on' : ''}" title="set complexity (review depth): ${cx} — ${tip}" on-click="${(e) => { if (e.stopPropagation) e.stopPropagation(); onSet({ complexity: cx }); }}">${label}</button>`;
  return html`<span class="rev" style="align-items:center;flex-wrap:wrap;gap:6px"><span style="color:#8b949e">stakes:</span>${sbtn('business-critical', 'business-critical')}${sbtn('important', 'important')}${sbtn('low', 'low')}${when(cur, () => html`<button title="clear triage" on-click="${(e) => { if (e.stopPropagation) e.stopPropagation(); onSet({ clear: true }); }}">✕</button>`)}<span style="color:#8b949e;margin-left:6px">complexity:</span>${cbtn('deep', 'deep', 'subtle logic, needs careful thought')}${cbtn('standard', 'standard', 'real but tractable logic')}${cbtn('rote', 'rote', 'a mechanical/checklist verify')}${cbtn('wiring', 'wiring', 'plumbing — a glance clears it')}${sevChip(triage)}${when(cur && onTripwire, () => html`<button class="${triage.tripwire ? 'checked' : ''}" title="${triage.tripwire ? 'tripwire armed — alert if this code changes (click to disarm)' : 'arm tripwire — alert me the instant this code changes'}" on-click="${(e) => { if (e.stopPropagation) e.stopPropagation(); onTripwire(!triage.tripwire); }}">🔔</button>`)}${when(triage && triage.likely, () => html`<span style="color:#58a6ff;font-size:12px" title="agent proposal — click a tier to confirm">· likely</span>`)}</span>`;
};
// `ref` scopes anchor resolution to a PR head, so a finding can land on a symbol
// that exists only on the branch (server: resolveRefs' scopeRef).
const postAnnotate = (u, targetKind, targetId, text, kind, line, ref) =>
  fetch('/api/annotate', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ u, targetKind, targetId, text, kind, line, ref, author: 'human' }) });
const postResolveAnnotation = (u, id, resolved) =>
  fetch('/api/annotation_resolve', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ u, id, resolved }) });

// A notes/questions thread for a node or anchor. `c` is the host component (uses
// c._draft — a NON-reactive field so typing doesn't re-render and drop focus —
// and c.load.run() to refresh after a write).
async function submitAnno(c, u, targetKind, targetId, kind) {
  const text = (c._draft || '').trim(); if (!text) return;
  await postAnnotate(u, targetKind, targetId, text, kind);
  c._draft = ''; c.load.run();
}
async function resolveAnno(c, u, id, resolved) { await postResolveAnnotation(u, id, resolved); c.load.run(); }
function annoThread(c, u, targetKind, targetId, items) {
  return html`<div class="sec">notes & questions</div>
    ${each(items || [], a => html`<div class="anno ${a.kind === 'question' ? 'q' : ''} ${a.resolved ? 'resolved' : ''}">
      <div class="annometa">${when(a.kind === 'question', () => html`<span class="qbadge">question${a.resolved ? ' · resolved' : ''}</span>`)}<span class="dim">${a.author || 'agent'}</span>${when(a.kind === 'question', () => html`<button class="annores" on-click="${() => resolveAnno(c, u, a.id, !a.resolved)}">${a.resolved ? 'reopen' : 'resolve'}</button>`)}</div>
      <md-content text="${a.text}"></md-content>
    </div>`, (a, i) => a.id || i)}
    <div class="annoadd">
      <textarea placeholder="leave a note or ask a question about this ${targetKind}…" on-input="${(e) => { c._draft = e.target.value; }}">${c._draft || ''}</textarea>
      <div class="annobtns"><button on-click="${() => submitAnno(c, u, targetKind, targetId, 'note')}">add note</button><button class="q" on-click="${() => submitAnno(c, u, targetKind, targetId, 'question')}">ask question</button></div>
    </div>`;
}
// Line-pinned findings, shared across every code-review surface (review page, flow
// snippets, node segments, file modal). A finding = an anchor note (kind 'note') with
// a line; raising one logs a durable action item and never blocks sign-off. You
// raise one by hovering a code line and clicking 💬 — no line-number input. The one
// open form's key is `c.state.finding` = `anchorId#line`; per-line draft text lives
// in non-reactive `c._fdrafts` (no focus loss with many blocks on a page). Mutations
// reload the host via `c.load.run()` (+ `refreshFile` if the file modal is open).
const findingKey = (anchorId, line) => anchorId + '#' + (line ?? '');
const openFindingForm = (c, anchorId, line) => { c.state.finding = findingKey(anchorId, line); };
const closeFindingForm = (c) => { c.state.finding = null; };
// Review annotations (mirrors the CI review vocab): finding = an issue, pointer = a
// watch-out aid for the reviewer, question = an ask, note = a remark. The ⚑ count is
// action items (findings + questions); pointers/notes render but don't inflate it.
const ANNO_ICON = { finding: '⚑', pointer: '👁', question: '?', note: '✎' };
const openFindingCount = (annotations) => (annotations || []).filter(a => !a.resolved && (a.kind === 'finding' || a.kind === 'question')).length;
async function raiseFinding(c, u, anchorId, line) {
  const key = findingKey(anchorId, line);
  const text = (c._fdrafts?.[key] || '').trim(); if (!text) return;
  await postAnnotate(u, 'anchor', anchorId, text, 'finding', Number.isFinite(line) ? line : undefined, c.state?.prRef);
  if (c._fdrafts) c._fdrafts[key] = '';
  c.state.finding = null;
  await c.load.run(); if (c.refreshFile && c.state.file) await c.refreshFile();
}
async function toggleFinding(c, u, id, resolved) { await postResolveAnnotation(u, id, resolved); await c.load.run(); if (c.refreshFile && c.state.file) await c.refreshFile(); }
const postAssign = (u, id, kind) =>
  fetch('/api/annotation_assign', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ u, id, kind, by: 'me' }) });
async function assignFinding(c, u, id, kind) { await postAssign(u, id, kind); await c.load.run(); if (c.refreshFile && c.state.file) await c.refreshFile(); }

// A finding, plus the two halves of the agent loop: hand it over, and read what
// came back. The agent reports; resolving stays the human's act, so an agent can
// never mark its own work accepted.
const OUTCOME_ICON = { fixed: '✔', answered: '💬', declined: '⊘' };
const findingItemEl = (c, u, f) => {
  const k = f.kind || 'note';
  const a = f.assignment, o = f.outcome;
  return html`<div class="rvfind k-${k} ${f.resolved ? 'resolved' : ''}">
    <span class="rvfpin" title="${k}${f.line ? ' · line ' + f.line : ''}">${ANNO_ICON[k] || '✎'}${f.line ? ' ' + f.line : ''}</span>
    ${when(f.severity, () => html`<span class="rvfsev" style="background:${SEV_COLOR[f.severity] || '#3a4250'}" title="severity: ${f.severity}"></span>`)}
    ${when(f.category, () => html`<span class="rvfcat">${f.category}</span>`)}
    <span class="rvftext">${f.text}</span>
    <span class="dim rvfauthor">${f.author || 'agent'}</span>
    ${when(a && !o, () => html`<span class="asgn pending" title="handed to an agent ${a.at ? 'on ' + a.at.slice(0, 10) : ''} — waiting">→ agent: ${a.kind}…</span>`)}
    ${when(o, () => html`<span class="asgn done r-${o.result}" title="${o.detail}${o.files && o.files.length ? '\n\nfiles: ' + o.files.join(', ') : ''}">${OUTCOME_ICON[o.result] || '·'} ${o.result}</span>`)}
    ${when(!f.resolved && !a, () => html`<span class="asgnacts">
      <button title="ask an agent to work out whether this is real and report back" on-click="${(e) => { if (e.stopPropagation) e.stopPropagation(); assignFinding(c, u, f.id, 'investigate'); }}">→ look into</button>
      <button title="ask an agent to fix it. One file only — anything wider comes back declined with what it would take, to be handed to a real agent instead." on-click="${(e) => { if (e.stopPropagation) e.stopPropagation(); assignFinding(c, u, f.id, 'fix'); }}">→ fix</button>
    </span>`)}
    <button class="annores" on-click="${(e) => { if (e.stopPropagation) e.stopPropagation(); toggleFinding(c, u, f.id, !f.resolved); }}">${f.resolved ? 'reopen' : 'resolve'}</button>
    ${when(o, () => html`<div class="asgndetail">${o.detail}${when(o.files && o.files.length, () => html` <span class="dim">— ${o.files.join(', ')}</span>`)}</div>`)}
  </div>`;
};
const findingForm = (c, u, anchorId, line) => {
  if (!c._fdrafts) c._fdrafts = {};
  const key = findingKey(anchorId, line);
  return html`<div class="rvaddf"><span class="rvfpin">${line ? '↳' + line : '✎'}</span><input class="rvftextin" placeholder="finding / action item — sign-off still allowed" value="${c._fdrafts[key] || ''}" on-input="${(e) => { c._fdrafts[key] = e.target.value; }}" on-keydown="${(e) => { if (e.key === 'Enter') raiseFinding(c, u, anchorId, line); else if (e.key === 'Escape') closeFindingForm(c); }}"><button on-click="${() => raiseFinding(c, u, anchorId, line)}">raise</button><button class="ghost" on-click="${() => closeFindingForm(c)}">cancel</button></div>`;
};
// Render one anchor's source line-by-line (absolute line numbers from `startLine`)
// with a hover 💬 per line that raises a finding pinned to that exact line; existing
// findings render inline under their line, unlocated notes below. `c.load.run()` must
// refresh the annotations this reads (server carries per-anchor `annotations`).
function codeReviewLines(c, u, anchorId, code, lang, startLine, annotations) {
  if (code == null) return html`<pre class="code rvcode">(source unavailable — anchor renamed/removed?)</pre>`;
  const base = startLine || 1;
  const byLine = new Map(); const noLine = [];
  for (const a of (annotations || [])) { if (a.line) { (byLine.get(a.line) || byLine.set(a.line, []).get(a.line)).push(a); } else noLine.push(a); }
  const lines = highlightLines(code, lang);
  return html`<div class="rvpre hljs">
    ${each(lines, (lineHtml, i) => {
      const n = base + i;
      const finds = byLine.get(n) || [];
      return html`<div class="flrow">
        <div class="fline"><span class="flno">${n}</span><span class="fltext">${raw(lineHtml)}</span><button class="flcomment" title="raise a finding on line ${n}" on-click="${() => openFindingForm(c, anchorId, n)}">💬</button></div>
        ${each(finds, f => findingItemEl(c, u, f), f => f.id)}
        ${when(c.state.finding === findingKey(anchorId, n), () => findingForm(c, u, anchorId, n))}
      </div>`;
    }, (lineHtml, i) => i)}
    ${when(noLine.length, () => html`<div class="rvfinds">${each(noLine, f => findingItemEl(c, u, f), f => f.id)}</div>`)}
  </div>`;
}
const highlight = (code, lang) => {
  if (window.hljs && lang && lang !== 'plaintext') { try { return window.hljs.highlight(code, { language: lang, ignoreIllegals: true }).value; } catch {} }
  return String(code).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
};
// Highlight a whole block, then slice into per-line HTML. hljs lexes multi-line
// constructs (block/`/** */` doc comments, verbatim & interpolated strings) as a
// unit; highlighting a line in isolation loses that context, so an apostrophe in
// a comment opens a phantom string and swallows the rest of the line (incl. XML
// `<summary>` tags). We highlight once with full context, then re-open any spans
// still open at each newline so every line stays independently well-formed.
const highlightLines = (code, lang) => {
  const src = highlight(code, lang);
  const out = [], open = []; let cur = '';
  const re = /<span\b[^>]*>|<\/span>|\n|[^<\n]+|</g; let m;
  while ((m = re.exec(src))) {
    const tok = m[0];
    if (tok === '\n') { out.push(cur + '</span>'.repeat(open.length)); cur = open.join(''); }
    else if (tok === '</span>') { open.pop(); cur += tok; }
    else if (tok.slice(0, 5) === '<span') { open.push(tok); cur += tok; }
    else cur += tok; // text, entities, or a stray '<'
  }
  out.push(cur);
  return out;
};
// Map a code diff's lines to full-context highlighted HTML: reconstruct each side
// (removed+context = base, added+context = head), highlight each as one block, and
// slice back per line so continuation lines keep their lexical context.
const diffCodeRows = (lines, lang) => {
  const baseHL = highlightLines(lines.filter(l => l.tag !== '+').map(l => l.text).join('\n'), lang);
  const headHL = highlightLines(lines.filter(l => l.tag !== '-').map(l => l.text).join('\n'), lang);
  let bi = 0, hi = 0;
  return lines.map(l => {
    const html = l.tag === '-' ? baseHL[bi++] : l.tag === '+' ? headHL[hi++] : (bi++, headHL[hi++]);
    return { tag: l.tag, html };
  });
};
const reviewHeat = (rev) => {
  if (!rev || !rev.total) return html`<span class="rheat empty"></span>`;
  const w = (n) => Math.round(100 * n / rev.total);
  const track = (done, stale) => html`<span class="rtrack"><i class="done" style="width:${w(done)}%"></i><i class="stale" style="width:${w(stale)}%"></i></span>`;
  const tip = `logical ${rev.logical}/${rev.total}${rev.logicalStale ? ' (' + rev.logicalStale + ' stale)' : ''} · code ${rev.code}/${rev.total}${rev.codeStale ? ' (' + rev.codeStale + ' stale)' : ''}`
    + (rev.codeReverted ? ` · ${rev.codeReverted} approval(s) sitting on a revert` : '');
  return html`<span class="rheat ${rev.codeReverted ? 'has-reverted' : ''}" title="${tip}">${track(rev.logical, rev.logicalStale)}${track(rev.code, rev.codeStale)}</span>`;
};
const revDot = (state, actor, via) => html`<span class="rd ${state === 'reviewed' ? (via === 'reverted' ? 'reverted' : actor === 'agent' ? 'checked' : 'done') : state === 'stale' ? 'stale' : ''}" title="${state}${via && VIA_TIP[via] ? VIA_TIP[via] : ''}"></span>`;

// --- markdown ----------------------------------------------------------------
// Content is authored by the documenting agent / developers (internal, trusted).
class MdContent extends Component {
  static props = { text: '', untrusted: false };
  // Syntax-highlight any fenced code blocks marked produced (it doesn't itself).
  hl() {
    if (!window.hljs) return;
    this.querySelectorAll('pre code').forEach((el) => {
      if (!el.dataset.highlighted) { try { window.hljs.highlightElement(el); } catch {} }
    });
  }
  afterRender() { this.hl(); }
  async propsChanged() { await this.nextRender(); this.hl(); }
  template() {
    let t = this.props.text || '';
    // Node bodies are authored by the documenting agent or a developer — trusted.
    // Spec prose read off a PR branch is not: it is written by whoever opened the
    // pull request, and marked has had no sanitizer since v5, so inline HTML would
    // execute against this same-origin unauthenticated API. Escaping the angle
    // brackets before parsing kills embedded HTML and leaves markdown intact.
    if (this.props.untrusted) t = t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    return html`<div class="md">${raw(window.marked ? window.marked.parse(t) : t)}</div>`;
  }
}
defineComponent('md-content', MdContent);

// --- header ------------------------------------------------------------------
// The view bar. A third entry is the `views` key gating the link: the matrix,
// pipeline and state map only mean something on a map with an event graph, so on
// a plain repo they're hidden rather than shown leading to empty scaffolding.
// (url builders are wrapped in arrows: `diffUrl` is declared further down the
// file, so naming it directly here would read the binding before its init.)
const VIEW_LINKS = [
  ['nodes', u => nodesUrl(u)], ['matrix', u => matrixUrl(u), 'matrix'], ['pipeline', u => pipelineUrl(u), 'pipeline'],
  ['states', u => stateMapUrl(u), 'states'], ['flows', u => flowsUrl(u)], ['bugs', u => bugsUrl(u)], ['diff', u => diffUrl(u)],
  ['pull requests', u => prsUrl(u), 'prs'],
];
// Ungated links always show. A gated one needs the universe's `views` to say so —
// unknown-yet (nav still loading) hides it so a link can't flash and vanish, while
// a payload with no `views` at all shows everything rather than hiding the UI.
const viewEnabled = (uni, gate) => !gate || (!!uni && (!uni.views || !!uni.views[gate]));

class CodemapHeader extends Component {
  static stores = { nav };
  mounted() { nav.load(); }
  search(e, v) {
    const u = this.stores.nav.current || (this.stores.nav.universes[0] && this.stores.nav.universes[0].id);
    if (u && v) go(`/u/${u}/search/`, { q: v });
  }
  template() {
    const n = this.stores.nav;
    const cur = n.universes.find(x => x.id === n.current) || n.universes[0];
    return html`<header>
      <div class="brand" on-click="${() => go('/')}">codemap<span> · map browser</span></div>
      <div class="uni">${each(n.universes, u => html`<button class="${u.id === n.current ? 'active' : ''}" on-click="${() => go(dashUrl(u.id))}">${u.id}<span class="n">${u.anchors ?? '–'}</span></button>`)}</div>
      ${each(VIEW_LINKS.filter(l => viewEnabled(cur, l[2])), l => html`<a class="viewlink" on-click="${() => { const u = n.current || (n.universes[0] && n.universes[0].id); if (u) go(l[1](u)); }}">${l[0]}</a>`, l => l[0])}
      <div class="search"><input placeholder="search symbols & docs…" on-change="${(e, v) => this.search(e, v)}"></div>
    </header>`;
  }
}
defineComponent('codemap-header', CodemapHeader);

// --- pages -------------------------------------------------------------------
class HomePage extends Component {
  async mounted() {
    await nav.load();
    const p = nav.state.universes.find(u => u.primary) || nav.state.universes[0];
    if (p) go(dashUrl(p.id));
  }
  template() { return html`<main><div class="loading">loading…</div></main>`; }
}
defineComponent('home-page', HomePage);

// --- universe dashboard: the "needs attention" landing page -------------------
class DashboardPage extends Component {
  static props = { params: {}, query: {} };
  constructor(props) { super(props); this.state = { d: null, q: null, lint: null }; }
  load = this.createTask(async () => {
    const u = this.props.params.universe; nav.current = u;
    const [d, q, lint] = await Promise.all([api('/api/dashboard', { u }), api('/api/questions', { u }), api('/api/lint', { u })]);
    this.state.d = d; this.state.q = q; this.state.lint = lint;
    if (d && d.tripwires) notifyTripwires(u, d.tripwires.fired); // push newly-fired tripwires
  });
  mounted() { this.load.run(); }
  propsChanged() { this.state.d = null; this.load.run(); }
  canEnableAlerts() { return typeof Notification !== 'undefined' && Notification.permission === 'default'; }
  async enableAlerts() { try { await Notification.requestPermission(); } catch { /* ignore */ } this.load.run(); }
  async resolveQ(id) { await postResolveAnnotation(this.props.params.universe, id, true); this.load.run(); }
  qTarget(t) { const u = this.props.params.universe; return t.kind === 'node' ? nodeUrl(u, t.id) : anchorUrl(u, t.id); }
  stat(label, value, extra) { return html`<div class="dstat"><div class="dsv">${value}</div><div class="dsl">${label}</div>${when(extra, () => html`<div class="dsx">${extra}</div>`)}</div>`; }
  template() {
    const u = this.props.params.universe, d = this.state.d;
    // Same gating as the header's view bar (`viewEnabled`): the event-graph views
    // only appear once this universe has the nodes behind them.
    const nav2 = [
      ['nodes', () => go(nodesUrl(u))], ['matrix', () => go(matrixUrl(u)), 'matrix'], ['pipeline', () => go(pipelineUrl(u)), 'pipeline'],
      ['states', () => go(stateMapUrl(u)), 'states'], ['flows', () => go(flowsUrl(u))], ['bugs', () => go(bugsUrl(u))], ['diff', () => go(diffUrl(u))],
      ['pull requests', () => go(prsUrl(u)), 'prs'], ['browse files', () => goTree(u, '')],
    ].filter(x => viewEnabled(d, x[2]));
    return pageShell(d, d && d.error, () => html`
      <div class="crumbs"><b>${u}</b> <span class="sep">·</span> overview${when(d.tripwires && d.tripwires.armed && this.canEnableAlerts(), () => html` <span class="sep">·</span> <button title="get a browser notification when a watched tripwire fires" on-click="${() => this.enableAlerts()}">🔔 enable alerts</button>`)}</div>
      ${when(d.attention > 0, () => html`<div class="attn-banner">
        <span class="attn-n">⚠ ${d.attention}</span>
        <span>item${d.attention === 1 ? '' : 's'} need attention:</span>
        ${when(d.docs.stale, () => html`<span class="attn-pill" on-click="${() => go(nodesUrl(u))}">${d.docs.stale} stale doc${d.docs.stale === 1 ? '' : 's'}</span>`)}
        ${when(d.docs.dangling, () => html`<span class="attn-pill bad" on-click="${() => go(nodesUrl(u))}">${d.docs.dangling} dangling</span>`)}
        ${when(d.bugs.possiblyFixed, () => html`<span class="attn-pill" on-click="${() => go(bugsUrl(u), { status: 'open' })}">${d.bugs.possiblyFixed} bug${d.bugs.possiblyFixed === 1 ? '' : 's'} possibly fixed</span>`)}
        ${when(d.reverted, () => html`<span class="attn-pill bad" title="code moved BACK to a body signed before it was superseded here — the tick still reads green, and probably should not">${d.reverted} approval${d.reverted === 1 ? '' : 's'} on reverted code</span>`)}
        ${when(d.tripwires && d.tripwires.fired.length, () => html`<span class="attn-pill bad" title="business-critical code you're watching changed" on-click="${() => go(nodesUrl(u))}">🔔 ${d.tripwires.fired.length} tripwire${d.tripwires.fired.length === 1 ? '' : 's'} fired</span>`)}
        ${when(d.openQuestions, () => html`<span class="attn-pill q">${d.openQuestions} open question${d.openQuestions === 1 ? '' : 's'}</span>`)}
        <span class="attn-hint">re-validate via <code>check_stale</code> / the bugs tab</span>
      </div>`, () => html`<div class="attn-banner ok"><span class="attn-n">✓</span> <span>nothing stale — docs and bugs are current with the code</span></div>`)}

      <div class="dcards">
        <div class="dcard">
          <div class="dch">documentation</div>
          <div class="dstats">
            ${this.stat('documented', d.coverage.docPct + '%', d.coverage.citedPct === undefined ? null
              : d.coverage.citedPct === d.coverage.docPct ? 'all of it cited'
              : d.coverage.citedPct + '% cited · rest swept by `cover`')}
            ${this.stat('open anchors', d.coverage.open, 'the work queue')}
            ${this.stat('doc nodes', d.coverage.nodes)}
          </div>
          <div class="dclink" on-click="${() => go(nodesUrl(u))}">browse nodes ›</div>
        </div>
        <div class="dcard">
          <div class="dch">docs health</div>
          <div class="dstats">
            ${this.stat('fresh', d.docs.fresh)}
            ${this.stat('stale', d.docs.stale, d.docs.stale ? 'code changed' : '')}
            ${this.stat('dangling', d.docs.dangling, d.docs.dangling ? 'code removed' : '')}
          </div>
        </div>
        <div class="dcard">
          <div class="dch">bugs</div>
          <div class="dstats">
            ${this.stat('open', d.bugs.open)}
            ${this.stat('possibly fixed', d.bugs.possiblyFixed, d.bugs.possiblyFixed ? 're-validate' : '')}
            ${this.stat('total', d.bugs.total)}
          </div>
          <div class="dclink" on-click="${() => go(bugsUrl(u))}">triage bugs ›</div>
        </div>
        <div class="dcard">
          <div class="dch">map</div>
          <div class="dstats">
            ${this.stat('anchors', d.coverage.anchors)}
            ${this.stat('edges', d.coverage.edges)}
            ${this.stat('notes', d.annotations)}
          </div>
          <div class="dclink dim">baseline ${d.baselineCommit ? d.baselineCommit.slice(0, 8) : '—'}</div>
        </div>
      </div>

      ${when(this.state.q && this.state.q.questions && this.state.q.questions.length, () => html`<div class="sec">open questions (${this.state.q.open}) <span class="dim">— left during review; answer by improving the doc, then resolve</span></div>
        ${each(this.state.q.questions, qn => html`<div class="dq ${qn.resolved ? 'resolved' : ''}">
          <div class="dqh"><span class="qbadge">${qn.target.kind}</span> <span class="dqt" on-click="${() => go(this.qTarget(qn.target))}">${qn.targetLabel}</span> <span class="dim">${qn.author}</span>
            <button class="annores" on-click="${() => this.resolveQ(qn.id)}">${qn.resolved ? 'reopen' : 'resolve'}</button></div>
          <md-content text="${qn.text}"></md-content>
        </div>`, qn => qn.id)}`)}

      ${when(this.state.lint && this.state.lint.count, () => html`<div class="sec">summary-drift candidates (${this.state.lint.count}) <span class="dim">— summary asserts an absolute the body qualifies; re-read the body, bound the summary if it over-reaches</span></div>
        ${each(this.state.lint.candidates, ln => html`<div class="dq drift">
          <div class="dqh"><span class="qbadge drift" title="summary says “${ln.absolute}”, body says “${ln.qualifier}”">“${ln.absolute}” vs “${ln.qualifier}”</span> <span class="dqt" on-click="${() => go(nodeUrl(u, ln.id))}">${ln.title}</span></div>
          <div class="dim" style="font-size:12.5px">${ln.summary}</div>
        </div>`, ln => ln.id)}`)}

      <div class="sec">explore</div>
      <div class="dnav">${each(nav2, x => html`<button on-click="${x[1]}">${x[0]}</button>`, x => x[0])}</div>
    `);
  }
}
defineComponent('dashboard-page', DashboardPage);

class OutlinePage extends Component {
  static props = { params: {}, query: {} };
  constructor(props) { super(props); this.state = { data: null }; }
  load = this.createTask(async () => {
    nav.current = this.props.params.universe;
    this.state.data = await api('/api/outline', { u: this.props.params.universe, prefix: this.props.params.path || '' });
  });
  mounted() { this.load.run(); }
  propsChanged() { this.load.run(); }
  crumbs() {
    const u = this.props.params.universe, path = this.props.params.path || '';
    const out = [{ label: u, prefix: '', sep: false }];
    let acc = '';
    for (const p of path.split('/').filter(Boolean)) { acc = acc ? acc + '/' + p : p; out.push({ label: p, prefix: acc, sep: true }); }
    return out;
  }
  body(d, u) {
    if (d.error) return html`<div class="empty">${d.error}</div>`;
    if (d.kind === 'file') {
      return html`<div class="rows">${each(d.symbols, s => html`
        <div class="sym" on-click="${() => go(anchorUrl(u, s.id))}"><span class="k">${s.kind}</span>
          <span><span class="dot ${(s.coverage === 'cited' || s.coverage === 'covered') ? 'on' : ''}" title="coverage: ${s.coverage}"></span>${s.symbol}${when(s.review, () => html`<span class="rdots" title="logical ${s.review.logical} · code ${s.review.code}">${revDot(s.review.logical, s.review.logicalActor, s.review.logicalVia)}${revDot(s.review.code, s.review.codeActor, s.review.codeVia)}</span>`)}</span><span class="muted">${s.lines ?? ''}</span></div>`)}</div>`;
    }
    if (!d.children || !d.children.length) return html`<div class="empty">no anchors here</div>`;
    return html`<div>
      <div class="rlegend"><span class="k"><span class="mini"></span>review heat — top: logical · bottom: code (green reviewed, amber stale) · hatched coverage = swept in by a <code>cover</code> selector, not cited by a doc</span></div>
      <div class="rows">${each(d.children, c => html`
        <div class="row" on-click="${() => goTree(u, c.path)}">
          <span class="ico">${KICON[c.kind]}</span>
          <span class="name ${c.kind}">${c.name}</span>
          <span class="bar" title="${c.docPct}% documented — ${c.cited ?? '?'} cited, ${c.covered ?? '?'} covered by selector, ${c.open} open"><i style="width:${c.docPct}%;background:${barColor(c.docPct)}"></i>${when(c.citedPct !== undefined && c.citedPct < c.docPct, () => html`<b class="swept" style="left:${c.citedPct}%;width:${c.docPct - c.citedPct}%"></b>`)}</span>
          ${reviewHeat(c.review)}
          <span class="muted">${c.anchors} anc</span>
          <span class="muted">${c.nodes ? c.nodes + ' doc' : ''}${c.bugs ? ' · ' + c.bugs + '🐞' : ''}</span>
        </div>`)}</div>
    </div>`;
  }
  template() {
    const u = this.props.params.universe, d = this.state.data;
    return html`<main>
      <div class="crumbs">${each(this.crumbs(), c => html`${when(c.sep, () => html`<span class="sep">/</span>`)}<a on-click="${() => goTree(u, c.prefix)}">${c.label}</a>`)}</div>
      ${when(this.load.pending, () => html`<div class="loading">loading…</div>`, () => d ? this.body(d, u) : '')}
    </main>`;
  }
}
defineComponent('outline-page', OutlinePage);

class AnchorPage extends Component {
  static props = { params: {}, query: {} };
  constructor(props) { super(props); this.state = { a: null }; }
  load = this.createTask(async () => { nav.current = this.props.params.universe; this.state.a = await api('/api/anchor', { u: this.props.params.universe, id: this.props.params.id }); });
  mounted() { this.load.run(); }
  propsChanged() { this.state.a = null; this.load.run(); }
  // Two independent human marks on the source: `viewed` (I've laid eyes on it — blue)
  // and `signed` (I own it — green). A stale sign-off returns to the worklist and can
  // only be cleared by re-signing; clicking a stale mark re-approves at the live hash.
  async mark(attestation, state, actor) {
    const unmark = state === 'reviewed' && actor !== 'agent'; // upgrade an agent check to human, never clear it
    await postReview(this.props.params.universe, 'anchor', this.state.a.id, 'code', unmark, attestation);
    this.load.run();
  }
  // Human triage: sets a *confirmed* tier (raise or lower — a person owns lowering).
  async triage(patch) {
    await postTriage(this.props.params.universe, 'anchor', this.state.a.id, patch);
    this.load.run();
  }
  async armTripwire(on) {
    await postTriage(this.props.params.universe, 'anchor', this.state.a.id, { importance: this.state.a.triage.importance, tripwire: on });
    this.load.run();
  }
  template() {
    const u = this.props.params.universe, a = this.state.a;
    return pageShell(a, a && a.error, () => html`<div class="detail">
      <div class="back" on-click="${() => goTree(u, a.file)}">← ${a.file}</div>
      <h2>${a.symbol}</h2>
      <div class="meta">${a.kind} · ${a.file}:${a.lines} · ${a.present ? 'present' : 'not found (lost)'}</div>
      <div style="margin:8px 0">${reviewRowEl(a.review, a.viewed, (att, st, actor) => this.mark(att, st, actor))}</div>
      <div style="margin:8px 0">${triageRowEl(a.triage, (imp) => this.triage(imp), (on) => this.armTripwire(on))}</div>
      ${when(a.citedBy && a.citedBy.length, () => html`<div class="sec">documented by</div><div class="chips">${each(a.citedBy, n => html`<span class="chip" on-click="${() => go(nodeUrl(u, n.id))}">${n.title || n.id}</span>`)}</div>`)}
      ${when(a.bugs && a.bugs.length, () => html`<div class="sec">bugs</div><div class="chips">${each(a.bugs, b => html`<span class="chip">${b.status} · ${b.title}</span>`)}</div>`)}
      ${annoThread(this, u, 'anchor', a.id, a.annotations)}
      <div class="sec">source</div>
      ${when(a.code, () => html`<pre class="hljs"><code>${raw(highlight(a.code, a.lang))}</code></pre>`, () => html`<pre class="code">(unavailable)</pre>`)}
    </div>`);
  }
}
defineComponent('anchor-page', AnchorPage);

class NodePage extends Component {
  static props = { params: {}, query: {} };
  // `open`/`acode`: per-segment expand state + lazily-fetched source, kept OUT of
  // the node payload so a mark-and-reload never blows away an open code block.
  constructor(props) { super(props); this.state = { n: null, versions: null, open: {}, acode: {}, finding: null }; }
  load = this.createTask(async () => {
    const u = this.props.params.universe, id = this.props.params.id; nav.current = u;
    this.state.n = await api('/api/node', { u, id });
    this.state.versions = this.state.n && !this.state.n.error ? (await api('/api/node_versions', { u, id })).versions : null;
  });
  mounted() { this.load.run(); }
  propsChanged() { this.state.n = null; this.state.versions = null; this.state.open = {}; this.state.acode = {}; this.load.run(); }
  // Signing the node vouches for the DOC (logical), not its code — code review is
  // derived from the per-segment signs below.
  async signNode(attestation, state, actor) { const unmark = state === 'reviewed' && actor !== 'agent'; await postReview(this.props.params.universe, 'node', this.props.params.id, 'logical', unmark, attestation); this.load.run(); }
  // Sign an individual referenced code segment; reload recomputes the node's derived code rollup.
  async markAnchor(id, attestation, state, actor) { const unmark = state === 'reviewed' && actor !== 'agent'; await postReview(this.props.params.universe, 'anchor', id, 'code', unmark, attestation); this.load.run(); }
  toggleSeg(id) { this.state.open = { ...this.state.open, [id]: !this.state.open[id] }; if (this.state.open[id] && !this.state.acode[id]) this.loadSeg(id); }
  async loadSeg(id) { const a = await api('/api/anchor', { u: this.props.params.universe, id }); this.state.acode = { ...this.state.acode, [id]: a }; }
  // One referenced code segment: expand to read its live source, sign it inline.
  anchorReviewRow(a, u) {
    if (a.missing) return html`<div class="anchor-code"><div class="sym">${a.id} <span class="dim">— segment missing (renamed/removed?)</span></div></div>`;
    const open = !!this.state.open[a.id], c = this.state.acode[a.id];
    const nf = (a.annotations || []).filter(x => !x.resolved && (x.kind || 'note') === 'note').length;
    const presetLine = a.lines ? parseInt(String(a.lines).split('-')[0], 10) : undefined;
    return html`<div class="anchor-code">
      <div class="sym" on-click="${() => this.toggleSeg(a.id)}">
        <span style="width:auto">${open ? '▾' : '▸'}</span>${sevDot(a.severity)}<span style="width:auto">${a.symbol ?? a.id}</span><span class="dim" style="width:auto">${a.file ?? ''}${a.lines ? ':' + a.lines : ''}</span>${when(nf, () => html`<span class="rvfbadge" title="${nf} open finding${nf === 1 ? '' : 's'}">⚑ ${nf}</span>`)}
        <span class="rev">${reviewRowEl(a.review, a.viewed, (att, st, actor) => this.markAnchor(a.id, att, st, actor))}<span class="viewlink" on-click="${(e) => { if (e.stopPropagation) e.stopPropagation(); go(anchorUrl(u, a.id)); }}" title="open full anchor page">↗</span></span>
      </div>
      ${when(open, () => !c ? html`<div class="loading" style="padding:6px 0">loading…</div>` : codeReviewLines(this, u, a.id, c.code, c.lang, presetLine, a.annotations))}
    </div>`;
  }
  async triageNode(patch) { await postTriage(this.props.params.universe, 'node', this.props.params.id, patch); this.load.run(); }
  async armTripwireNode(on) { await postTriage(this.props.params.universe, 'node', this.props.params.id, { importance: this.state.n.triage.importance, tripwire: on }); this.load.run(); }
  async confirm() { await postConfirm(this.props.params.universe, this.props.params.id); this.load.run(); }
  async ackHole() { await postAckHole(this.props.params.universe, this.props.params.id); this.load.run(); }
  template() {
    const u = this.props.params.universe, n = this.state.n, versions = this.state.versions;
    return pageShell(n, n && n.error, () => {
    const cr = deriveCode(n.resolvedAnchors);
    return html`<div class="detail">
      <div class="meta">${n.type}${n.universe ? ' · ' + n.universe : ''} · ${n.id} ${statusChip(n.status)}${trustChip(n.trust)}${sevChip(n.triage)}<span class="viewlink" on-click="${() => go(graphUrl(u, n.id))}">◆ graph</span></div>
      <h2>${n.title}${when(n.versionCount > 1, () => html`<span class="vfork" title="${n.versionCount} versions (forked across branches)">⑂${n.versionCount}</span>`)}</h2>
      <div style="margin:6px 0;display:flex;align-items:center;gap:8px;flex-wrap:wrap"><span class="dim" style="font-size:12px">doc sign-off:</span>${reviewRowEl(n.review, n.viewed, (att, st, actor) => this.signNode(att, st, actor), 'logical')}<span class="dim" style="font-size:12px">— vouches for the doc, not its code</span></div>
      <div style="margin:6px 0;display:flex;align-items:center;gap:10px;flex-wrap:wrap">${codeRollupEl(cr)}${when(cr.total, () => html`<button on-click="${() => go(nodeReviewUrl(u, n.id))}">open code review →</button>`)}</div>
      <div style="margin:6px 0">${triageRowEl(n.triage, (imp) => this.triageNode(imp), (on) => this.armTripwireNode(on))}</div>
      ${when(n.status === 'stale', () => html`<div class="vaction"><span>This doc cites code that changed since it was written.</span> <button on-click="${() => this.confirm()}">confirm still accurate</button> <span class="dim">— or edit it (forks a new version).</span></div>`)}
      ${when(n.status === 'dangling', () => html`<div class="vaction bad"><span>Cited code was removed here (${(n.danglingAnchors || []).length} anchor${(n.danglingAnchors || []).length === 1 ? '' : 's'}).</span> <button on-click="${() => this.ackHole()}">ack — remove doc here</button> <span class="dim">(kept on branches where the code exists).</span></div>`)}
      <md-content text="${n.summary}"></md-content>
      ${when(n.body && n.body.trim(), () => html`<md-content text="${n.body}"></md-content>`)}
      <div class="sec">referenced code (${(n.resolvedAnchors || []).length})${when(cr.total, () => html` — <span class="dim">${cr.signed}/${cr.total} signed${cr.stale ? ' · ' + cr.stale + ' stale' : ''}</span>`)} <span class="dim" style="font-weight:400">— read &amp; sign each segment to complete the node's code review</span></div>
      ${each(n.resolvedAnchors ?? [], a => this.anchorReviewRow(a, u), a => a.id)}
      ${when(n.edges && n.edges.length, () => html`<div class="sec">edges</div><div class="chips">${each(n.edges, e => html`<span class="chip" on-click="${() => e.toRef && go(nodeUrl(e.toRef.universe, e.toRef.id))}">${e.type}: ${e.toRef ? e.toRef.universe + '::' + (e.toRef.title || e.toRef.id) : e.to}</span>`)}</div>`)}
      ${when(n.inboundCrossUniverse && n.inboundCrossUniverse.length, () => html`<div class="sec">called by (other universes)</div><div class="chips">${each(n.inboundCrossUniverse, i => html`<span class="chip" on-click="${() => go(nodeUrl(i.fromUniverse, i.from))}">${i.fromUniverse}::${i.from} (${i.type})</span>`)}</div>`)}
      ${when(versions && versions.length > 1, () => html`<div class="sec">versions (${versions.length}) — the one matching this branch wins</div>
        ${each(versions, v => html`<div class="nver ${v.status}"><span class="stchip ${v.status}">${v.status}</span> <span class="nvbranch">${v.createdBranch || '(?)'} @ ${(v.createdCommit || '').slice(0, 8) || '—'}</span> <span class="dim">${v.removed ? '(tombstone)' : v.title}</span></div>`, v => v.versionId)}`)}
      ${annoThread(this, u, 'node', n.id, n.annotations)}
    </div>`;
    });
  }
}
defineComponent('node-page', NodePage);

// --- dedicated code-review page for a node: its referenced segments as a queue --
// Segments come pre-ordered (file, then line) from /api/node_review. Unsigned ones
// are expanded (the queue); signed ones collapse GitHub-style but stay expandable.
// "view file" opens the whole file in a modal with the file's anchors markable in a
// side panel — read a segment in context, then sign it.
class NodeReviewPage extends Component {
  static props = { params: {}, query: {} };
  // `hideSigned` defaults on — the queue is what's left to review; signed segments
  // stay reachable via the toggle. Findings use the shared per-line helpers
  // (`c.state.finding` = open form key, `c._fdrafts` = per-line draft text).
  constructor(props) { super(props); this.state = { d: null, open: {}, hideSigned: true, file: null, filePending: false, activeAnchor: null, finding: null }; }
  load = this.createTask(async () => { nav.current = this.props.params.universe; this.state.d = await api('/api/node_review', { u: this.props.params.universe, id: this.props.params.id }); });
  mounted() { this.load.run(); if (!this._escWired) { this._escWired = true; window.addEventListener('keydown', (e) => { if (e.key === 'Escape') { if (this.state.finding) closeFindingForm(this); else if (this.state.file) this.closeFile(); } }); } }
  propsChanged() { this.state.d = null; this.state.open = {}; this.state.file = null; this.state.activeAnchor = null; this.state.finding = null; this.load.run(); }
  // "done" for the reviewer = a HUMAN sign-off. An agent `checked` mark is a helpful
  // first pass but still needs the human — it stays in the queue (and never hides).
  isDone(s) { const c = s.review && s.review.code; return !!(c && c.state === 'reviewed' && c.actor === 'human'); }
  isChecked(s) { const c = s.review && s.review.code; return !!(c && c.state === 'reviewed' && c.actor === 'agent'); }
  // Effective expand state: signed segments collapse by default, unsigned expand;
  // an explicit toggle overrides.
  isOpen(s) { const v = this.state.open[s.id]; return v === undefined ? !this.isDone(s) : v; }
  toggle(id) { const s = (this.state.d.segments || []).find(x => x.id === id); this.state.open = { ...this.state.open, [id]: !this.isOpen(s) }; }
  setHide(v) { this.state.hideSigned = v; }
  // Only clear your own human vouch; an agent `checked` mark is upgraded to a human sign-off, never wiped.
  async markSeg(id, att, st, actor) { const unmark = st === 'reviewed' && actor !== 'agent'; await postReview(this.props.params.universe, 'anchor', id, 'code', unmark, att); await this.load.run(); if (this.state.file) await this.refreshFile(); }
  async openFile(path, anchorId) { this.state.activeAnchor = anchorId || null; this.state.filePending = true; try { this.state.file = await api('/api/file', { u: this.props.params.universe, path }); } finally { this.state.filePending = false; } this.scrollToAnchor(anchorId); }
  async refreshFile() { if (this.state.file && !this.state.file.error) this.state.file = await api('/api/file', { u: this.props.params.universe, path: this.state.file.file }); }
  closeFile() { this.state.file = null; this.state.activeAnchor = null; }
  setActive(id) { this.state.activeAnchor = id; this.scrollToAnchor(id); }
  scrollToAnchor(id) { if (!id) return; requestAnimationFrame(() => { const el = this.querySelector(`.fline[data-a="${id}"]`); if (el) el.scrollIntoView({ block: 'center' }); }); }
  jumpNext() {
    const seg = (this.state.d.segments || []).find(s => !s.missing && !this.isDone(s));
    if (!seg) return;
    this.state.open = { ...this.state.open, [seg.id]: true };
    requestAnimationFrame(() => { const el = this.querySelector(`.rvseg[data-id="${seg.id}"]`); if (el) el.scrollIntoView({ block: 'center' }); });
  }
  segCard(s, u) {
    if (s.missing) return html`<div class="rvseg missing" data-id="${s.id}"><div class="rvhead"><span class="rvsym">${s.id}</span> <span class="dim">— segment missing (renamed/removed?)</span></div></div>`;
    const done = this.isDone(s), checked = this.isChecked(s), open = this.isOpen(s), nf = openFindingCount(s.annotations);
    return html`<div class="rvseg ${done ? 'done' : ''}" data-id="${s.id}">
      <div class="rvhead" on-click="${() => this.toggle(s.id)}">
        <span class="rvchev">${open ? '▾' : '▸'}</span>
        <span class="rvstate ${done ? 'ok' : checked ? 'checked' : ''}" title="${done ? 'signed' : checked ? 'agent-checked — your sign-off still needed' : 'not reviewed'}">${done ? '✓' : checked ? '·' : '○'}</span>
        <span class="rvsym">${s.symbol}</span>
        <span class="dim rvfile">${s.file}:${s.lines || '?'}</span>
        ${when(nf, () => html`<span class="rvfbadge" title="${nf} open finding${nf === 1 ? '' : 's'}">⚑ ${nf}</span>`)}
        <span class="rev" on-click="${(e) => { if (e.stopPropagation) e.stopPropagation(); }}">${reviewRowEl(s.review, s.viewed, (att, st, actor) => this.markSeg(s.id, att, st, actor))}<button title="read the whole file in context" on-click="${(e) => { if (e.stopPropagation) e.stopPropagation(); this.openFile(s.file, s.id); }}">view file</button><span class="viewlink" on-click="${(e) => { if (e.stopPropagation) e.stopPropagation(); go(anchorUrl(u, s.id)); }}" title="open anchor page">↗</span></span>
      </div>
      ${when(open, () => codeReviewLines(this, u, s.id, s.code, s.lang, s.startLine, s.annotations))}
    </div>`;
  }
  fileLines(f) {
    const u = this.props.params.universe;
    const active = f.anchors.find(a => a.id === this.state.activeAnchor);
    const startOf = new Map();
    for (const a of f.anchors) if (a.startLine && !startOf.has(a.startLine)) startOf.set(a.startLine, a.id);
    // line → findings pinned there, and line → the anchor whose range covers it
    // (only lines inside a reviewed segment are commentable).
    const findsAt = new Map();
    for (const a of f.anchors) for (const an of (a.annotations || [])) if (an.line) { const arr = findsAt.get(an.line) || findsAt.set(an.line, []).get(an.line); arr.push(an); }
    const anchorAtLine = (n) => { const a = f.anchors.find(a => a.startLine && a.endLine && n >= a.startLine && n <= a.endLine); return a ? a.id : null; };
    // Highlight the whole file once (multi-line context intact), then slice per line
    // so line numbers + the active-segment band stay aligned.
    const lines = highlightLines(f.code, f.lang);
    return html`<div class="rvpre hljs">${each(lines, (lineHtml, i) => {
      const n = i + 1;
      const inActive = active && active.startLine && n >= active.startLine && n <= active.endLine;
      const aid = startOf.get(n) || '';
      const canComment = anchorAtLine(n);
      const finds = findsAt.get(n) || [];
      return html`<div class="flrow">
        <div class="fline ${inActive ? 'fhl' : ''}" data-a="${aid}"><span class="flno">${n}</span><span class="fltext">${raw(lineHtml)}</span>${when(canComment, () => html`<button class="flcomment" title="raise a finding on line ${n}" on-click="${() => openFindingForm(this, canComment, n)}">💬</button>`)}</div>
        ${each(finds, fn => findingItemEl(this, u, fn), fn => fn.id)}
        ${when(canComment && this.state.finding === findingKey(canComment, n), () => findingForm(this, u, canComment, n))}
      </div>`;
    }, (lineHtml, i) => i)}</div>`;
  }
  fileModal() {
    if (!this.state.file && !this.state.filePending) return html``;
    const f = this.state.file;
    return html`<div class="modal-bg" on-click="${(e) => { if (e.target.classList.contains('modal-bg')) this.closeFile(); }}">
      <div class="modal">
        <div class="modal-head"><b>${f && !f.error ? f.file : 'file'}</b> <span class="dim">— read in context; sign each segment in the panel →</span><button class="modal-x" on-click="${() => this.closeFile()}">✕</button></div>
        <div class="modal-body rvfilebody">
          ${when(!f, () => html`<div class="loading" style="padding:20px">loading…</div>`,
            () => f.error ? html`<div class="empty" style="padding:20px">${f.error}</div>` : html`
            <div class="rvfilecode">${this.fileLines(f)}</div>
            <div class="rvfileside">
              <div class="sxs-h">segments in this file (${f.anchors.length})</div>
              ${each(f.anchors, a => { const nf = openFindingCount(a.annotations); return html`<div class="rvaside ${a.id === this.state.activeAnchor ? 'active' : ''}">
                <div class="rvasym" on-click="${() => this.setActive(a.id)}">${a.symbol} <span class="dim">${a.startLine ?? '?'}-${a.endLine ?? '?'}</span>${when(nf, () => html`<span class="rvfbadge" title="${nf} open finding${nf === 1 ? '' : 's'}">⚑ ${nf}</span>`)}</div>
                <div class="rvamarks">${reviewRowEl(a.review, a.viewed, (att, st, actor) => this.markSeg(a.id, att, st, actor))}</div>
              </div>`; }, a => a.id)}
            </div>`)}
        </div>
      </div>
    </div>`;
  }
  template() {
    const u = this.props.params.universe, d = this.state.d;
    return pageShell(d, d && d.error, () => {
      const cr = d.codeReview || { signed: 0, total: 0, stale: 0 };
      const segs = d.segments || [];
      const pending = segs.filter(s => !s.missing && !this.isDone(s));
      // Hide only human-signed segments with nothing left open — a signed segment that
      // still has open findings, and any agent-checked-but-unsigned segment, stay visible.
      const shown = this.state.hideSigned ? segs.filter(s => !this.isDone(s) || openFindingCount(s.annotations) > 0) : segs;
      const pct = cr.total ? Math.round(cr.signed / cr.total * 100) : 0;
      return html`
        <div class="crumbs"><a on-click="${() => go(nodeUrl(u, d.id))}">← ${d.title}</a> <span class="sep">·</span> code review</div>
        <div class="rvbar">
          <b style="color:${cr.stale ? '#f0a35e' : pct === 100 ? '#7ee787' : '#8b949e'}">${codeMark(cr)}</b>
          <span>${cr.signed}/${cr.total} segment${cr.total === 1 ? '' : 's'} signed${cr.stale ? ` · ${cr.stale} stale` : ''}</span>
          <span class="rvtrack"><i style="width:${pct}%"></i></span>
          ${when(d.openFindings, () => html`<span class="rvfcount" title="findings raised across this node's segments">⚑ ${d.openFindings} open finding${d.openFindings === 1 ? '' : 's'}</span>`)}
          ${when(pending.length, () => html`<button on-click="${() => this.jumpNext()}">next unsigned ↓</button>`)}
          <label class="mchk"><input type="checkbox" checked="${this.state.hideSigned}" on-change="${(e) => this.setHide(e.target.checked)}"> hide signed</label>
        </div>
        ${when(!segs.length, () => html`<div class="empty">this node cites no code segments</div>`)}
        ${each(shown, s => this.segCard(s, u), s => s.id)}
        ${this.fileModal()}
      `;
    });
  }
}
defineComponent('node-review-page', NodeReviewPage);

class SearchPage extends Component {
  static props = { params: {}, query: {} };
  static stores = { nav };
  constructor(props) { super(props); this.state = { groups: null }; }
  // scope: "all" universes (default) or "one" (the current universe). In the URL
  // so back/forward and deep-links carry it.
  scope() { return this.props.query.scope === 'one' ? 'one' : 'all'; }
  load = this.createTask(async () => {
    nav.current = this.props.params.universe;
    const q = this.props.query.q || '';
    if (!q) { this.state.groups = null; return; }
    if (this.scope() === 'all') {
      this.state.groups = (await api('/api/search', { u: this.props.params.universe, q, all: 1 })).results || [];
    } else {
      const r = await api('/api/search', { u: this.props.params.universe, q });
      this.state.groups = [{ universe: this.props.params.universe, ...r }];
    }
  });
  mounted() { nav.load(); this.load.run(); }
  propsChanged() { this.load.run(); }
  setScope(s) { go(`/u/${this.props.params.universe}/search/`, { q: this.props.query.q || '', scope: s }); }
  group(g) {
    const u = g.universe, hits = (g.nodes?.length || 0) + (g.anchors?.length || 0);
    return html`<div class="detail" style="margin-bottom:12px">
      <div class="dch"><span class="uref" on-click="${() => go(dashUrl(u))}">${u}</span> <span class="dim">· ${hits} hit${hits === 1 ? '' : 's'}</span></div>
      ${when(g.nodes && g.nodes.length, () => html`<div class="sec">nodes</div><div class="chips">${each(g.nodes, n => html`<span class="chip" on-click="${() => go(nodeUrl(u, n.id))}">${n.title || n.id}</span>`, n => n.id)}</div>`)}
      ${when(g.anchors && g.anchors.length, () => html`<div class="sec">anchors</div><div class="rows">${each(g.anchors, a => html`<div class="sym" on-click="${() => go(anchorUrl(u, a.id))}"><span class="k">${a.kind}</span><span>${a.symbol}</span><span class="muted">${a.file}</span></div>`, a => a.id)}</div>`)}
      ${when(!hits, () => html`<div class="dim" style="padding:4px 0">no matches</div>`)}
    </div>`;
  }
  template() {
    const u = this.props.params.universe, groups = this.state.groups, multi = (this.stores.nav.universes || []).length > 1;
    return html`<main>
      <div class="crumbs"><a on-click="${() => go(dashUrl(u))}">${u}</a> <span class="sep">/</span> search: ${this.props.query.q || ''}</div>
      ${when(multi, () => html`<div class="dtoggle"><span class="dim">scope</span>
        <button class="${this.scope() === 'all' ? 'on' : ''}" on-click="${() => this.setScope('all')}">all universes</button>
        <button class="${this.scope() === 'one' ? 'on' : ''}" on-click="${() => this.setScope('one')}">${u} only</button>
      </div>`)}
      ${when(!groups, () => html`<div class="empty">type a query…</div>`, () => html`${each(groups, g => this.group(g), g => g.universe)}`)}
    </main>`;
  }
}
defineComponent('search-page', SearchPage);

// Force-directed graph explorer — pan/zoom, hover-trace, type filters, click-to-expand.
class GraphPage extends Component {
  static props = { params: {}, query: {} };
  constructor(props) {
    super(props);
    this.state = { data: null, loading: true };
    this._pos = new Map(); this._view = { x: 0, y: 0, s: 1 };
    this._hidden = { edge: new Set(), node: new Set() };
    this._selected = null; this._ids = new Set();
  }
  mounted() { const seed = this.props.params.id; this._selected = seed; this.fetchData([seed], seed); }
  propsChanged() { const seed = this.props.params.id; this._ids = new Set(); this._selected = seed; this.fetchData([seed], seed); }
  unmounted() { cancelAnimationFrame(this._raf); }

  async fetchData(ids, expand) {
    nav.current = this.props.params.universe;
    if (!this.state.data) this.state.loading = true; // keep the graph mounted on expand/reload
    const d = await api('/api/subgraph', { u: this.props.params.universe, ids: ids.join(','), expand: expand || '' });
    if (d.error) { this.state.data = d; this.state.loading = false; return; }
    this._ids = new Set(d.nodes.map((n) => n.id));
    this.state.data = d; this.state.loading = false;
    this.ensurePositions(expand);
    await this.nextRender();
    this.restore(); this.setup(); this.runSim();
  }
  ensurePositions(expandId) {
    const anchor = expandId && this._pos.get(expandId);
    for (const n of this.state.data.nodes) {
      if (this._pos.has(n.id)) continue;
      const a = Math.random() * 6.283, r = 40 + Math.random() * 80;
      this._pos.set(n.id, { x: (anchor ? anchor.x : 0) + Math.cos(a) * r, y: (anchor ? anchor.y : 0) + Math.sin(a) * r, dx: 0, dy: 0 });
    }
  }
  cacheEls() {
    const svg = this.querySelector('svg.explorer'); if (!svg) return;
    this._nodeEls = new Map([...svg.querySelectorAll('.gn')].map((el) => [el.getAttribute('data-id'), el]));
    this._edgeEls = [...svg.querySelectorAll('.ge')].map((el) => ({ el, from: el.getAttribute('data-from'), to: el.getAttribute('data-to') }));
  }
  applyPositions() {
    if (!this._nodeEls) return;
    for (const [id, el] of this._nodeEls) { const p = this._pos.get(id); if (p) el.setAttribute('transform', `translate(${p.x},${p.y})`); }
    for (const e of this._edgeEls) { const a = this._pos.get(e.from), b = this._pos.get(e.to); if (a && b) { e.el.setAttribute('x1', a.x); e.el.setAttribute('y1', a.y); e.el.setAttribute('x2', b.x); e.el.setAttribute('y2', b.y); } }
  }
  applyTransform() { const g = this.querySelector('.vp'); if (g) { const v = this._view; g.setAttribute('transform', `translate(${v.x},${v.y}) scale(${v.s})`); } }
  // Compute the visible subgraph: edges whose type is shown and both endpoints'
  // types are shown, then only the nodes those edges still connect (so a node
  // left disconnected by a filter drops out too). Caches _visNodes/_visEdges for
  // the sim + hover, and hides the rest via display:none.
  applyFilters() {
    const svg = this.querySelector('svg.explorer'); if (!svg) return;
    const data = this.state.data;
    const typeOf = new Map(data.nodes.map((n) => [n.id, n.type]));
    const typeShown = (id) => !this._hidden.node.has(typeOf.get(id));
    const visEdges = data.edges.filter((e) => !this._hidden.edge.has(e.type) && typeShown(e.from) && typeShown(e.to));
    const connected = new Set();
    for (const e of visEdges) { connected.add(e.from); connected.add(e.to); }
    const visNodes = data.nodes.filter((n) => typeShown(n.id) && connected.has(n.id));
    const visIds = new Set(visNodes.map((n) => n.id));
    this._visNodes = visNodes; this._visEdges = visEdges; this._visIds = visIds;
    svg.querySelectorAll('.gn').forEach((el) => { el.style.display = visIds.has(el.getAttribute('data-id')) ? '' : 'none'; });
    svg.querySelectorAll('.ge').forEach((el) => { el.style.display = (visIds.has(el.getAttribute('data-from')) && visIds.has(el.getAttribute('data-to')) && !this._hidden.edge.has(el.getAttribute('data-type'))) ? '' : 'none'; });
  }
  showSel() {
    const panel = this.querySelector('.gsel'); if (!panel) return;
    const n = this.state.data.nodes.find((x) => x.id === this._selected);
    if (!n) { panel.style.display = 'none'; return; }
    panel.style.display = '';
    panel.querySelector('.gseltitle').textContent = `${n.title} · ${n.type}` + (n.hidden ? ` · ${n.hidden} more` : ' · fully expanded');
  }
  restore() { this.cacheEls(); this.fit(); this.applyFilters(); this.applyPositions(); this.showSel(); }
  fit() {
    const svg = this.querySelector('svg.explorer'); if (!svg) return;
    const cw = svg.clientWidth || 900, ch = svg.clientHeight || 620;
    if (!this._view.set) { this._view = { x: cw / 2, y: ch / 2, s: 1, set: true }; }
    this.applyTransform();
  }
  fitBounds() {
    const svg = this.querySelector('svg.explorer'); if (!svg) return;
    const nodes = this._visNodes && this._visNodes.length ? this._visNodes : this.state.data.nodes;
    if (!nodes.length) return;
    let mnx = 1e9, mny = 1e9, mxx = -1e9, mxy = -1e9;
    for (const n of nodes) { const p = this._pos.get(n.id); mnx = Math.min(mnx, p.x); mny = Math.min(mny, p.y); mxx = Math.max(mxx, p.x); mxy = Math.max(mxy, p.y); }
    const cw = svg.clientWidth || 900, ch = svg.clientHeight || 620, pad = 90;
    const s = Math.max(0.2, Math.min(1.4, Math.min(cw / (mxx - mnx + pad), ch / (mxy - mny + pad))));
    this._view = { x: cw / 2 - ((mnx + mxx) / 2) * s, y: ch / 2 - ((mny + mxy) / 2) * s, s, set: true };
    this.applyTransform();
  }
  adjacency() { const m = new Map(); const add = (a, b) => { let s = m.get(a); if (!s) { s = new Set(); m.set(a, s); } s.add(b); }; for (const e of (this._visEdges || this.state.data.edges)) { add(e.from, e.to); add(e.to, e.from); } return m; }
  hover(id) {
    const svg = this.querySelector('svg.explorer'); if (!svg) return;
    if (!id) { svg.classList.remove('hovering'); svg.querySelectorAll('.hl').forEach((el) => el.classList.remove('hl')); return; }
    const near = this.adjacency().get(id) || new Set();
    svg.classList.add('hovering');
    svg.querySelectorAll('.gn').forEach((el) => el.classList.toggle('hl', el.getAttribute('data-id') === id || near.has(el.getAttribute('data-id'))));
    svg.querySelectorAll('.ge').forEach((el) => el.classList.toggle('hl', el.getAttribute('data-from') === id || el.getAttribute('data-to') === id));
  }
  runSim() {
    cancelAnimationFrame(this._raf);
    // Lay out only what's visible, so filtered-out nodes don't distort the graph.
    const nodes = this._visNodes && this._visNodes.length ? this._visNodes : this.state.data.nodes;
    const edges = this._visEdges || this.state.data.edges, pos = this._pos, N = nodes.length;
    if (!N) { this.applyPositions(); return; }
    const k = Math.sqrt((900 * 620) / Math.max(N, 1)) * 0.85;
    let temp = 70, iter = 0;
    const tick = () => {
      for (const n of nodes) { const p = pos.get(n.id); p.dx = 0; p.dy = 0; }
      for (let i = 0; i < N; i++) { const a = pos.get(nodes[i].id);
        for (let j = i + 1; j < N; j++) { const b = pos.get(nodes[j].id);
          let dx = a.x - b.x, dy = a.y - b.y, dist = Math.hypot(dx, dy) || 0.01, f = (k * k) / dist, ux = dx / dist, uy = dy / dist;
          a.dx += ux * f; a.dy += uy * f; b.dx -= ux * f; b.dy -= uy * f; } }
      for (const e of edges) { const a = pos.get(e.from), b = pos.get(e.to); if (!a || !b) continue;
        let dx = a.x - b.x, dy = a.y - b.y, dist = Math.hypot(dx, dy) || 0.01, f = (dist * dist) / k, ux = dx / dist, uy = dy / dist;
        a.dx -= ux * f; a.dy -= uy * f; b.dx += ux * f; b.dy += uy * f; }
      for (const n of nodes) { const p = pos.get(n.id); p.dx += -p.x * 0.012; p.dy += -p.y * 0.012;
        const d = Math.hypot(p.dx, p.dy) || 0.01, m = Math.min(d, temp); p.x += (p.dx / d) * m; p.y += (p.dy / d) * m; }
      temp *= 0.965; iter++;
      this.applyPositions();
      if (iter < 300 && temp > 0.6) this._raf = requestAnimationFrame(tick); else this.fitBounds();
    };
    tick();
  }
  setup() {
    const svg = this.querySelector('svg.explorer'); if (!svg) return;
    if (!this._winWired) {
      this._winWired = true;
      window.addEventListener('mousemove', (e) => { const drag = this._drag; if (!drag) return; if (Math.abs(e.clientX - drag.sx) + Math.abs(e.clientY - drag.sy) > 3) drag.moved = true; this._view.x = drag.ox + (e.clientX - drag.sx); this._view.y = drag.oy + (e.clientY - drag.sy); this.applyTransform(); });
      window.addEventListener('mouseup', () => { const drag = this._drag; if (drag && drag.moved) { this._panned = true; setTimeout(() => { this._panned = false; }, 0); } this._drag = null; const s = this.querySelector('svg.explorer'); if (s) s.classList.remove('grabbing'); });
    }
    if (svg._cmWired) return; svg._cmWired = true;
    svg.addEventListener('mousedown', (e) => { if (e.target.closest('.gn')) return; this._drag = { sx: e.clientX, sy: e.clientY, ox: this._view.x, oy: this._view.y, moved: false }; svg.classList.add('grabbing'); });
    svg.addEventListener('wheel', (e) => { e.preventDefault(); const r = svg.getBoundingClientRect(), mx = e.clientX - r.left, my = e.clientY - r.top, f = e.deltaY < 0 ? 1.12 : 0.89, v = this._view, ns = Math.max(0.15, Math.min(3, v.s * f)); v.x = mx - (mx - v.x) * (ns / v.s); v.y = my - (my - v.y) * (ns / v.s); v.s = ns; this.applyTransform(); }, { passive: false });
    svg.addEventListener('mouseover', (e) => { const g = e.target.closest('.gn'); if (g) this.hover(g.getAttribute('data-id')); });
    svg.addEventListener('mouseout', (e) => { const g = e.target.closest('.gn'); if (g) this.hover(null); });
    svg.addEventListener('click', (e) => { if (this._panned) return; const g = e.target.closest('.gn'); if (!g) return; const id = g.getAttribute('data-id'); this._selected = id; this.showSel(); this.fetchData([...this._ids], id); });
  }
  toggleFilter(kind, t, e) { const s = this._hidden[kind]; if (s.has(t)) s.delete(t); else s.add(t); if (e && e.currentTarget) e.currentTarget.classList.toggle('off'); this.applyFilters(); this.runSim(); }
  template() {
    const u = this.props.params.universe, d = this.state.data;
    if (this.state.loading || !d) return html`<main><div class="loading">loading…</div></main>`;
    if (d.error) return html`<main><div class="empty">${d.error}</div></main>`;
    const node = (n) => {
      const t = n.title.length > 30 ? n.title.slice(0, 29) + '…' : n.title;
      const w = Math.max(56, Math.round(t.length * 6.3) + 18), hw = w / 2;
      const rev = n.review.code === 'reviewed' || n.review.logical === 'reviewed';
      return html`<g class="gn ${n.type} ${rev ? 'rev' : ''} ${n.id === this._selected ? 'sel' : ''}" data-id="${n.id}" data-type="${n.type}">
      <rect x="${-hw}" y="-9" width="${w}" height="18" rx="9"></rect><text x="0" y="4">${t}</text>${when(n.hidden > 0, () => html`<circle class="more" cx="${hw}" cy="-9" r="6"></circle><text class="morec" x="${hw}" y="-6">${n.hidden}</text>`)}
    </g>`; };
    return html`<main class="wide">
      <div class="crumbs"><a on-click="${() => go(nodeUrl(u, this.props.params.id))}">← detail</a> <span class="sep">·</span> graph explorer <span class="dim">· ${d.nodes.length} nodes</span></div>
      <div class="gtools">
        <span class="gfl">edges:</span>${each(d.edgeTypes, (t) => html`<span class="gchip ${this._hidden.edge.has(t) ? 'off' : ''}" style="border-color:${edgeColor(t)}" on-click="${(e) => this.toggleFilter('edge', t, e)}">${t}</span>`, (t) => 'e' + t)}
        <span class="gfl">nodes:</span>${each(d.nodeTypes, (t) => html`<span class="gchip ${this._hidden.node.has(t) ? 'off' : ''}" style="border-color:${nodeColor(t)}" on-click="${(e) => this.toggleFilter('node', t, e)}">${t}</span>`, (t) => 'n' + t)}
        <span class="dim">drag to pan · scroll zoom · click a node to expand · hover to trace</span>
      </div>
      <svg class="explorer">
        <g class="vp">
          ${each(d.edges, (e) => html`<line class="ge ${e.type}" data-from="${e.from}" data-to="${e.to}" data-type="${e.type}"></line>`, (e) => e.from + '~' + e.type + '~' + e.to)}
          ${each(d.nodes, node, (n) => n.id)}
        </g>
      </svg>
      <div class="gsel" style="display:none">
        <span class="gseltitle"></span>
        <button class="gopen" on-click="${() => this._selected && go(nodeUrl(u, this._selected))}">open detail ›</button>
        <button class="greset" on-click="${() => { this._ids = new Set(); this.fetchData([this.props.params.id], this.props.params.id); }}">reset</button>
      </div>
    </main>`;
  }
}
defineComponent('graph-page', GraphPage);

class FlowsPage extends Component {
  static props = { params: {}, query: {} };
  constructor(props) { super(props); this.state = { data: null }; }
  load = this.createTask(async () => { nav.current = this.props.params.universe; this.state.data = await api('/api/flows', { u: this.props.params.universe }); });
  mounted() { this.load.run(); }
  propsChanged() { this.state.data = null; this.load.run(); }
  template() {
    const u = this.props.params.universe, d = this.state.data;
    return pageShell(d, null, () => html`
      <div class="crumbs">${u} <span class="sep">·</span> flows (${d.flows.length})</div>
      ${when(!d.flows.length, () => html`<div class="empty">no flows (process nodes) documented in this universe yet</div>`)}
      ${each(d.flows, (f) => html`<div class="flow-card" on-click="${() => go(flowUrl(u, f.id))}">
        <div class="ft">${f.title} <span class="n">${f.steps} step${f.steps === 1 ? '' : 's'}</span></div>
        <div class="fs">${f.summary}</div>
        <div class="progress">
          <span><span class="rev-dot" style="background:${revColorA(f.review && f.review.logical)}"></span>logical</span>
          <span><span class="rev-dot" style="background:${revColorA(f.review && f.review.code)}"></span>code</span>
          <span>steps: ${f.stepReview.logical}/${f.stepReview.total} logical · ${f.stepReview.code}/${f.stepReview.total} code${f.stepReview.stale ? ' · ' + f.stepReview.stale + ' ⚠' : ''}</span>
        </div>
      </div>`, (f) => f.id)}
    `);
  }
}
defineComponent('flows-page', FlowsPage);

class FlowPage extends Component {
  static props = { params: {}, query: {} };
  constructor(props) { super(props); this.state = { data: null, onlyChanged: false, finding: null }; }
  load = this.createTask(async () => { nav.current = this.props.params.universe; this.state.data = await api('/api/flow', { u: this.props.params.universe, id: this.props.params.id }); });
  mounted() { this.load.run(); }
  propsChanged() { this.state.data = null; this.load.run(); }
  setOnlyChanged(v) { this.state.onlyChanged = v; }
  // `actor` is passed only by the logical vouch button: only clear your own human
  // review — never wipe an agent's check (mark it human instead). Other callers
  // (viewed exposure, anchor code) leave it undefined → normal toggle.
  async toggle(kind, id, level, state, attestation, actor) { const unmark = state === 'reviewed' && (actor === undefined || actor === 'human'); await postReview(this.props.params.universe, kind, id, level, unmark, attestation); this.load.run(); }
  revBtn(kind, id, level, info) {
    const st = (info && info.state) || 'unreviewed', actor = info && info.actor;
    const cls = revCls(st, actor);
    const tip = `${level} ${st}${st === 'reviewed' && actor === 'agent' ? ' (agent-checked — click to confirm as human)' : ''}${info && info.by ? ' · by ' + info.by : ''}`;
    return html`<button class="${cls}" title="${tip}" on-click="${(e) => { if (e.stopPropagation) e.stopPropagation(); this.toggle(kind, id, level, st, undefined, actor); }}">${level}${revMark(st, actor)}</button>`;
  }
  // `viewed` exposure toggle (code level) alongside the signed-vouch level buttons.
  viewBtn(kind, id, info) {
    const st = (info && info.state) || 'unreviewed';
    const cls = st === 'reviewed' ? 'checked' : st === 'stale' ? 'stale' : '';
    const mark = st === 'reviewed' ? ' ✓' : st === 'stale' ? ' ⚠' : '';
    const tip = `viewed: ${st}${st === 'stale' ? ' — changed since you looked' : st === 'unreviewed' ? ' — click to mark looked-at' : ''}`;
    return html`<button class="${cls}" title="${tip}" on-click="${(e) => { if (e.stopPropagation) e.stopPropagation(); this.toggle(kind, id, 'code', st, 'viewed'); }}">view${mark}</button>`;
  }
  revBtns(kind, id, review, viewed, codeReview) {
    return html`<span class="rev">${this.revBtn(kind, id, 'logical', review && review.logical)}${this.codeInd(codeReview)}${this.viewBtn(kind, id, viewed && viewed.code)}</span>`;
  }
  // Code review is DERIVED from the step's cited segments — the per-anchor code
  // buttons below are the real sign controls, so this is a read-only rollup.
  codeInd(cr) {
    const st = cr ? cr.state : 'unreviewed';
    const col = st === 'reviewed' ? (cr && cr.actor === 'agent' ? '#58a6ff' : '#7ee787') : st === 'stale' ? '#f0a35e' : '#8b949e';
    return html`<span title="${codeTip(cr)}" style="border:1px solid ${col}55;color:${col};border-radius:6px;padding:3px 9px;font-size:12px;cursor:default">${codeMark(cr)}</span>`;
  }
  codeBlock(a) {
    if (a.missing) return html`<div class="anchor-code"><div class="sym">${a.id} — anchor missing (renamed/removed?)</div></div>`;
    if (!a.code) return html`<div class="anchor-code"><div class="sym">${a.symbol} — code unavailable</div></div>`;
    const nf = openFindingCount(a.annotations);
    return html`<div class="anchor-code">
      <div class="sym">${a.symbol} · ${a.file}:${a.lines}${when(nf, () => html`<span class="rvfbadge" title="${nf} open finding${nf === 1 ? '' : 's'}">⚑ ${nf}</span>`)}${reviewRowEl(a.review, a.viewed, (att, st, actor) => this.toggle('anchor', a.id, 'code', st, att, actor))}</div>
      ${codeReviewLines(this, this.props.params.universe, a.id, a.code, a.lang, a.startLine, a.annotations)}
    </div>`;
  }
  template() {
    const u = this.props.params.universe, d = this.state.data;
    return pageShell(d, d && d.error, () => {
    const ch = d.changed || { signed: [], viewed: [] };
    const nChanged = new Set([...ch.signed, ...ch.viewed]).size;
    // Targeted diff: only steps that drifted under a mark you'd made. Never-reviewed
    // steps aren't "changed since you looked", so the filter leaves them out.
    const steps = this.state.onlyChanged ? d.steps.filter((s) => s.changed && (s.changed.signed || s.changed.viewed)) : d.steps;
    return html`
      <div class="crumbs"><a on-click="${() => go(flowsUrl(u))}">← flows</a> <span class="sep">·</span> ${d.title}</div>
      ${when(nChanged > 0, () => html`<div class="diff-banner" style="margin:10px 0;padding:8px 12px;border-left:3px solid #f0a35e;background:#2a2016;border-radius:4px">
        ⟳ <b>${ch.signed.length}</b> step${ch.signed.length === 1 ? '' : 's'} changed since you signed${when(ch.viewed.length > 0, () => html` · <b>${ch.viewed.length}</b> since you viewed`)} — re-review just these.
        <button style="margin-left:10px" on-click="${() => this.setOnlyChanged(!this.state.onlyChanged)}">${this.state.onlyChanged ? 'show all steps' : 'show only changed'}</button>
      </div>`)}
      <div class="detail">
        <div style="display:flex;align-items:center;gap:12px"><h2 style="margin:0">${d.title}</h2>${this.revBtns('node', d.id, d.review, d.viewed, d.codeReview)}</div>
        ${when(d.coverage, () => html`<div style="margin:6px 0">${coverageBar(d.coverage)}</div>`)}
        <md-content text="${d.summary}"></md-content>
      </div>
      ${each(steps, (s) => html`<div class="flow-step" style="${s.changed && (s.changed.signed || s.changed.viewed) ? 'border-left:3px solid #f0a35e;padding-left:9px' : ''}">
        <div class="shead"><span class="num">${s.order + 1}</span><span class="stitle">${s.title}</span>${when(s.changed && s.changed.signed, () => html`<span class="badge" title="a mark you signed here went stale" style="color:#f0a35e;font-size:12px">⚠ changed since signed</span>`)}${when(s.changed && !s.changed.signed && s.changed.viewed, () => html`<span class="badge" title="a mark you viewed here went stale" style="color:#f0a35e;font-size:12px">⚠ changed since viewed</span>`)}${this.revBtns('node', s.id, s.review, s.viewed, s.codeReview)}</div>
        <div class="sbody">
          <md-content text="${s.summary}"></md-content>
          ${when(s.touches && s.touches.length, () => html`<div class="chips">${each(s.touches, (t) => html`<span class="chip" on-click="${() => go(nodeUrl(u, t.id))}">↳ ${t.title}</span>`, (t) => t.id)}</div>`)}
          ${each(s.anchors, (a) => this.codeBlock(a), (a) => a.id)}
        </div>
      </div>`, (s) => s.id)}
    `;
    });
  }
}
defineComponent('flow-page', FlowPage);

// --- node catalog: browse/filter/mark-reviewed every logical node -------------
class NodeCatalogPage extends Component {
  static props = { params: {}, query: {} };
  constructor(props) { super(props); this.state = { data: null, tw: null, f: { q: '', type: '', domain: '', gen: '', review: '', severity: '' }, group: 'type' }; }
  load = this.createTask(async () => { nav.current = this.props.params.universe; const u = this.props.params.universe; this.state.data = await api('/api/nodes', { u }); this.state.tw = await api('/api/tripwires', { u }); });
  mounted() { this._u = this.props.params.universe; this.load.run(); }
  // Reload only when the universe changes; the `view` toggle lives in the URL query
  // (durable on back/forward) and just re-renders — no refetch.
  propsChanged() { const u = this.props.params.universe; if (u !== this._u) { this._u = u; this.state.data = null; this.load.run(); } }
  view() { return this.props.query.view === 'todo' ? 'todo' : 'catalog'; }
  setView(v) { go(nodesUrl(this.props.params.universe), v === 'todo' ? { view: 'todo' } : {}); }
  set(k, v) { this.state.f = { ...this.state.f, [k]: v }; }
  setGroup(v) { this.state.group = v; }
  async verify(id, act) { await postReview(this.props.params.universe, 'node', id, 'logical', act === 'unverify'); this.load.run(); }
  // Clicking a review button records a HUMAN vouch. Only clear when it's already
  // your own human review — never wipe an agent's check; mark it human instead.
  async toggle(id, level, state, actor) { const unmark = state === 'reviewed' && actor === 'human'; await postReview(this.props.params.universe, 'node', id, level, unmark); this.load.run(); }
  async deriveStakes() { await postTriage(this.props.params.universe, null, null, { derive: true }); this.load.run(); }
  // Human review = green (`on`); an agent `checked` review = blue, so it never reads
  // as fully-verified. A web toggle always records a human review.
  revBtn(id, level, state, actor) {
    const agent = state === 'reviewed' && actor === 'agent';
    const cls = state === 'reviewed' ? (agent ? 'checked' : 'on') : state === 'stale' ? 'stale' : '';
    const mark = state === 'reviewed' ? (agent ? '·' : '✓') : state === 'stale' ? '⚠' : '';
    return html`<button class="${cls}" title="${level}: ${state}${agent ? ' (agent-checked — click to confirm as human)' : ''}" on-click="${(e) => { if (e.stopPropagation) e.stopPropagation(); this.toggle(id, level, state, actor); }}">${level[0].toUpperCase()}${mark}</button>`;
  }
  // Code review is per-segment (derived) — the list can't read code, so this is a
  // read-only rollup that opens the node to review its referenced segments.
  codeCell(n) { return codeCellBtn(n.codeReview, () => go(nodeUrl(this.props.params.universe, n.id))); }
  filtered() {
    const f = this.state.f, q = f.q.toLowerCase();
    return this.state.data.nodes.filter((n) =>
      (!q || n.title.toLowerCase().includes(q) || (n.summary || '').toLowerCase().includes(q) || n.id.toLowerCase().includes(q)) &&
      (!f.type || n.type === f.type) &&
      (!f.domain || n.domain === f.domain) &&
      (!f.gen || (f.gen === 'human' ? !n.generatedBy : n.generatedBy === f.gen)) &&
      (!f.status || n.status === f.status) &&
      (!f.severity || n.severity === f.severity) &&
      (!f.review ||
        (f.review === 'unreviewed' ? (n.review.logical === 'unreviewed' && n.review.code === 'unreviewed')
          : f.review === 'reviewed' ? (n.review.logical === 'reviewed' || n.review.code === 'reviewed')
            : f.review === 'stale' ? (n.review.logical === 'stale' || n.review.code === 'stale') : true)));
  }
  groups(list) {
    if (this.state.group === 'none') return [['all', list]];
    const key = this.state.group;
    const m = new Map();
    for (const n of list) { const k = n[key] || '(none)'; let a = m.get(k); if (!a) { a = []; m.set(k, a); } a.push(n); }
    return [...m.entries()].sort((a, b) => b[1].length - a[1].length);
  }
  // Worklist: outstanding nodes (not review-complete), ranked by severity so you can
  // attack by priority. Grouped by severity tier, highest first.
  worklist(list) {
    const out = list.filter((n) => n.triage && n.triage.severity !== 'complete');
    const m = new Map();
    for (const n of out) { const s = n.triage.severity; let a = m.get(s); if (!a) { a = []; m.set(s, a); } a.push(n); }
    for (const arr of m.values()) arr.sort((a, b) => (a.title || a.id).localeCompare(b.title || b.id));
    return SEV_ORDER.filter((s) => m.has(s)).map((s) => [s, m.get(s)]);
  }
  nodeRow(n, u) {
    return html`<div class="nrow" on-click="${() => go(nodeUrl(u, n.id))}">
      <span class="nt" style="border-color:${nodeColor(n.type)}">${n.type}</span>
      <span class="ntitle">${n.title || n.id}${when(n.versionCount > 1, () => html`<span class="vfork" title="${n.versionCount} versions (forked)">⑂${n.versionCount}</span>`)}</span>
      ${statusChip(n.status)}${trustChip(n.trust, (act) => this.verify(n.id, act))}${sevChip(n.triage)}
      <span class="ndom">${n.domain}</span>
      <span class="nmeta">${n.anchors}a · ${n.edgesIn}↓${n.edgesOut}↑</span>
      ${when(n.generatedBy, () => html`<span class="gen">${n.generatedBy}</span>`)}
      <span class="nrev">${this.revBtn(n.id, 'logical', n.review.logical, n.reviewBy && n.reviewBy.logical)}${this.codeCell(n)}</span>
    </div>`;
  }
  template() {
    const u = this.props.params.universe, d = this.state.data;
    return pageShell(d, null, () => {
    const list = this.filtered();
    const opts = (o) => Object.entries(o).sort((a, b) => b[1] - a[1]).map(([k, v]) => ({ k, v }));
    const todo = this.view() === 'todo';
    const wl = todo ? this.worklist(list) : null;
    const outstanding = todo ? wl.reduce((s, g) => s + g[1].length, 0) : 0;
    return html`
      <div class="crumbs">${u} <span class="sep">·</span> nodes (${d.total}) <span class="sep">·</span> ${d.reviewed} reviewed${when(d.byStatus && (d.byStatus.stale || d.byStatus.dangling), () => html` <span class="sep">·</span> <b class="bad">${(d.byStatus.stale || 0) + (d.byStatus.dangling || 0)} need review</b>`)}</div>
      <div class="dtoggle"><span class="dim">view</span>
        <button class="${!todo ? 'on' : ''}" on-click="${() => this.setView('catalog')}">catalog</button>
        <button class="${todo ? 'on' : ''}" on-click="${() => this.setView('todo')}" title="outstanding items ranked by severity — attack by priority">worklist</button>
      </div>
      <div class="nfilters">
        <input placeholder="filter title…" on-input="${(e) => this.set('q', e.target.value)}">
        <select on-change="${(e) => this.set('type', e.target.value)}"><option value="">all types</option>${each(opts(d.byType), o => html`<option value="${o.k}">${o.k} (${o.v})</option>`, o => o.k)}</select>
        <select on-change="${(e) => this.set('domain', e.target.value)}"><option value="">all domains</option>${each(opts(d.byDomain), o => html`<option value="${o.k}">${o.k} (${o.v})</option>`, o => o.k)}</select>
        <select on-change="${(e) => this.set('status', e.target.value)}"><option value="">any status</option>${each(opts(d.byStatus || {}), o => html`<option value="${o.k}">${o.k} (${o.v})</option>`, o => o.k)}</select>
        <select on-change="${(e) => this.set('gen', e.target.value)}"><option value="">any source</option><option value="human">human</option><option value="marten">marten</option></select>
        <select on-change="${(e) => this.set('review', e.target.value)}"><option value="">any review</option><option value="unreviewed">unreviewed</option><option value="reviewed">reviewed</option><option value="stale">stale</option></select>
        <select on-change="${(e) => this.set('severity', e.target.value)}"><option value="">any severity</option>${each(opts(d.bySeverity || {}), o => html`<option value="${o.k}">${o.k} (${o.v})</option>`, o => o.k)}</select>
        ${when(!todo, () => html`<select on-change="${(e) => this.setGroup(e.target.value)}"><option value="type">group: type</option><option value="domain">group: domain</option><option value="none">group: none</option></select>`)}
      </div>
      ${when(d.coverage, () => html`<div style="margin:4px 0 8px">${coverageBar(d.coverage)}</div>`)}
      ${when(this.state.tw && this.state.tw.fired && this.state.tw.fired.length, () => html`<div class="diff-banner" style="margin:6px 0;padding:8px 12px;border-left:3px solid #f85149;background:#2a1618;border-radius:4px">
        🔔 <b>${this.state.tw.fired.length}</b> tripwire${this.state.tw.fired.length === 1 ? '' : 's'} fired — business-critical code you're watching has changed:
        ${each(this.state.tw.fired, f => html` <span class="chip" on-click="${() => go(f.target.kind === 'anchor' ? anchorUrl(u, f.target.id) : nodeUrl(u, f.target.id))}">${f.target.id.slice(0, 14)}</span>`, f => f.target.kind + f.target.id)}
      </div>`)}
      <div class="ncount">${todo ? `${outstanding} outstanding, ranked by priority` : `${list.length} shown`} <button style="margin-left:10px" title="graph-derive likely stakes across the map (safe: only proposals a human confirms)" on-click="${() => this.deriveStakes()}">⚙ derive stakes</button></div>
      ${when(todo,
        () => html`${when(!outstanding, () => html`<div class="empty">nothing outstanding — everything shown is review-complete 🎉</div>`)}${each(wl, g => html`<div class="ngroup">
          <div class="ngh"><span class="gdot" style="background:${SEV_COLOR[g[0]] || '#3a4250'}"></span>${g[0] === 'untriaged' ? 'needs triage' : g[0]} <span class="n">${g[1].length}</span></div>
          ${each(g[1], n => this.nodeRow(n, u), n => n.id)}
        </div>`, g => g[0])}`,
        () => html`${each(this.groups(list), g => html`<div class="ngroup">
          <div class="ngh"><span class="gdot" style="background:${nodeColor(g[0])}"></span>${g[0]} <span class="n">${g[1].length}</span></div>
          ${each(g[1], n => this.nodeRow(n, u), n => n.id)}
        </div>`, g => g[0])}`)}
    `;
    });
  }
}
defineComponent('node-catalog-page', NodeCatalogPage);

// --- event wiring matrix: events × aggregates/projections, orphans surfaced ---
class MatrixPage extends Component {
  static props = { params: {}, query: {} };
  constructor(props) { super(props); this.state = { data: null, f: { q: '', domain: '', orphan: false } }; }
  load = this.createTask(async () => { nav.current = this.props.params.universe; this.state.data = await api('/api/matrix', { u: this.props.params.universe }); });
  mounted() { this.load.run(); }
  propsChanged() { this.state.data = null; this.load.run(); }
  set(k, v) { this.state.f = { ...this.state.f, [k]: v }; }
  // Clicking a review button records a HUMAN vouch. Only clear when it's already
  // your own human review — never wipe an agent's check; mark it human instead.
  async toggle(id, level, state, actor) { const unmark = state === 'reviewed' && actor === 'human'; await postReview(this.props.params.universe, 'node', id, level, unmark); this.load.run(); }
  // Human review = green (`on`); an agent `checked` review = blue, so it never reads
  // as fully-verified. A web toggle always records a human review.
  revBtn(id, level, state, actor) {
    const agent = state === 'reviewed' && actor === 'agent';
    const cls = state === 'reviewed' ? (agent ? 'checked' : 'on') : state === 'stale' ? 'stale' : '';
    const mark = state === 'reviewed' ? (agent ? '·' : '✓') : state === 'stale' ? '⚠' : '';
    return html`<button class="${cls}" title="${level}: ${state}${agent ? ' (agent-checked — click to confirm as human)' : ''}" on-click="${(e) => { if (e.stopPropagation) e.stopPropagation(); this.toggle(id, level, state, actor); }}">${level[0].toUpperCase()}${mark}</button>`;
  }
  filtered() {
    const f = this.state.f, q = f.q.toLowerCase();
    return this.state.data.events.filter((e) =>
      (!q || e.title.toLowerCase().includes(q)) && (!f.domain || e.domain === f.domain) && (!f.orphan || e.orphan));
  }
  template() {
    const u = this.props.params.universe, d = this.state.data;
    return pageShell(d, null, () => {
    // Reachable by deep link even when the nav hides it — say why it's blank.
    if (!d.events.length) return html`
      <div class="crumbs">${u} <span class="sep">·</span> event matrix</div>
      <div class="empty">no event families in this map — the matrix needs <code>event_family</code> nodes (run <code>codemap analyze marten --emit</code> on an event-sourced repo, or document them by hand)</div>`;
    const rows = this.filtered();
    const domains = [...new Set(d.events.map((e) => e.domain))].sort();
    return html`
      <div class="crumbs">${u} <span class="sep">·</span> event matrix</div>
      <div class="mstats">${d.stats.events} events · ${d.stats.aggregates} aggregate${d.stats.aggregates === 1 ? '' : 's'} · ${d.stats.projections} projection${d.stats.projections === 1 ? '' : 's'} · <b class="${d.stats.orphans ? 'bad' : 'ok'}">${d.stats.orphans} orphan${d.stats.orphans === 1 ? '' : 's'}</b> <span class="mlegend"><i class="cdot folds"></i> folds → aggregate &nbsp; <i class="cdot projects"></i> projects → read-model</span></div>
      <div class="nfilters">
        <input placeholder="filter event…" on-input="${(e) => this.set('q', e.target.value)}">
        <select on-change="${(e) => this.set('domain', e.target.value)}"><option value="">all domains</option>${each(domains, dm => html`<option value="${dm}">${dm}</option>`, dm => dm)}</select>
        <label class="mchk"><input type="checkbox" on-change="${(e) => this.set('orphan', e.target.checked)}"> orphans only</label>
      </div>
      <div class="mwrap">
        <div class="mhead">
          <span class="mev">event <em>· domain · emitters↑</em></span>
          ${each(d.sinks, s => html`<span class="msink ${s.type}" on-click="${() => go(nodeUrl(u, s.id))}" title="${s.title} (${s.type})">${s.title}</span>`, s => s.id)}
          <span class="mrevh">review</span>
        </div>
        ${each(rows, e => html`<div class="mrow ${e.orphan ? 'orphan' : ''}">
          <span class="mev" on-click="${() => go(nodeUrl(u, e.id))}"><b>${e.title}</b><small>${e.domain} · ${e.emitters}↑</small></span>
          ${each(d.sinks, s => html`<span class="mcell">${when(e.cells[s.id], () => html`<i class="cdot ${e.cells[s.id]}" title="${e.cells[s.id]}"></i>`)}</span>`, s => s.id)}
          <span class="mrevh"><span class="nrev">${this.revBtn(e.id, 'logical', e.review.logical, e.reviewBy && e.reviewBy.logical)}${codeCellBtn(e.codeReview, () => go(nodeUrl(u, e.id)))}</span></span>
        </div>`, e => e.id)}
      </div>
    `;
    });
  }
}
defineComponent('matrix-page', MatrixPage);

// --- layered event pipeline: command→handler→event→aggregate→projection -------
const PIPE = { COLW: 300, NODEW: 224, ROWH: 22, NODEH: 16 };
class PipelinePage extends Component {
  static props = { params: {}, query: {} };
  constructor(props) { super(props); this.state = { data: null, loading: true, domain: '' }; this._view = { x: 10, y: 36, s: 1 }; }
  async fetchData() {
    this._adj = null; nav.current = this.props.params.universe;
    if (!this.state.data) this.state.loading = true; // don't blank an existing graph on reload
    const data = await api('/api/pipeline', { u: this.props.params.universe, domain: this.state.domain || '' });
    this.state.data = data; this.state.loading = false;
    await this.nextRender();
    this.setup();
  }
  mounted() { this.fetchData(); }
  propsChanged() { this.fetchData(); }
  setDomain(v) { this.state.domain = v; this.fetchData(); }

  pos() { const m = new Map(); for (const n of this.state.data.nodes) m.set(n.id, { x: n.layer * PIPE.COLW, y: n.row * PIPE.ROWH }); return m; }
  applyTransform() { const g = this.querySelector('.vp'); if (g) { const v = this._view; g.setAttribute('transform', `translate(${v.x},${v.y}) scale(${v.s})`); } }
  fit() {
    const svg = this.querySelector('svg.pipeline'); if (!svg || !this.state.data) return;
    const cw = svg.clientWidth || 960, ch = svg.clientHeight || 640;
    const contentW = (this.state.data.layerCounts.length - 1) * PIPE.COLW + PIPE.NODEW;
    const maxRows = Math.max(1, ...this.state.data.layerCounts);
    const contentH = maxRows * PIPE.ROWH + PIPE.NODEH;
    const s = Math.min(cw / (contentW + 40), ch / (contentH + 60), 1.2);
    this._view = { s, x: Math.max(10, (cw - contentW * s) / 2), y: 40 };
    this.applyTransform();
  }
  adjacency() {
    if (this._adj) return this._adj;
    const m = new Map(); const add = (a, b) => { let s = m.get(a); if (!s) { s = new Set(); m.set(a, s); } s.add(b); };
    for (const e of this.state.data.edges) { add(e.from, e.to); add(e.to, e.from); }
    this._adj = m; return m;
  }
  hover(id) {
    const svg = this.querySelector('svg.pipeline'); if (!svg) return;
    if (!id) { svg.classList.remove('hovering'); svg.querySelectorAll('.hl').forEach((el) => el.classList.remove('hl')); return; }
    const near = this.adjacency().get(id) || new Set();
    svg.classList.add('hovering');
    svg.querySelectorAll('.pn').forEach((el) => el.classList.toggle('hl', el.getAttribute('data-id') === id || near.has(el.getAttribute('data-id'))));
    svg.querySelectorAll('.pe').forEach((el) => el.classList.toggle('hl', el.getAttribute('data-from') === id || el.getAttribute('data-to') === id));
  }
  setup() {
    const svg = this.querySelector('svg.pipeline'); if (!svg) return;
    this.fit();
    // Window listeners once per component; svg listeners keyed on the element so
    // they re-attach if the <svg> is ever recreated (drag state is shared).
    if (!this._winWired) {
      this._winWired = true;
      window.addEventListener('mousemove', (e) => { const drag = this._drag; if (!drag) return; if (Math.abs(e.clientX - drag.sx) + Math.abs(e.clientY - drag.sy) > 3) drag.moved = true; this._view.x = drag.ox + (e.clientX - drag.sx); this._view.y = drag.oy + (e.clientY - drag.sy); this.applyTransform(); });
      window.addEventListener('mouseup', () => { const drag = this._drag; if (drag && drag.moved) { this._panned = true; setTimeout(() => { this._panned = false; }, 0); } this._drag = null; const s = this.querySelector('svg.pipeline'); if (s) s.classList.remove('grabbing'); });
    }
    if (svg._cmWired) return; svg._cmWired = true;
    svg.addEventListener('mousedown', (e) => { if (e.target.closest('.pn')) return; this._drag = { sx: e.clientX, sy: e.clientY, ox: this._view.x, oy: this._view.y, moved: false }; svg.classList.add('grabbing'); });
    svg.addEventListener('wheel', (e) => { e.preventDefault(); const r = svg.getBoundingClientRect(); const mx = e.clientX - r.left, my = e.clientY - r.top; const f = e.deltaY < 0 ? 1.12 : 0.89; const v = this._view; const ns = Math.max(0.15, Math.min(3, v.s * f)); v.x = mx - (mx - v.x) * (ns / v.s); v.y = my - (my - v.y) * (ns / v.s); v.s = ns; this.applyTransform(); }, { passive: false });
    svg.addEventListener('mouseover', (e) => { const g = e.target.closest('.pn'); if (g) this.hover(g.getAttribute('data-id')); });
    svg.addEventListener('mouseout', (e) => { const g = e.target.closest('.pn'); if (g) this.hover(null); });
  }
  onClick(e) { if (this._panned) return; const g = e.target.closest('.pn'); if (g) go(nodeUrl(this.props.params.universe, g.getAttribute('data-id'))); }
  template() {
    const u = this.props.params.universe, d = this.state.data;
    if (this.state.loading || !d) return html`<main><div class="loading">loading…</div></main>`;
    // Reachable by deep link even when the nav hides it — say why it's blank.
    if (!d.nodes.length) return html`<main>
      <div class="crumbs">${u} <span class="sep">·</span> event pipeline</div>
      <div class="empty">nothing to lay out — the pipeline needs command / handler / event / aggregate / projection nodes (run <code>codemap analyze marten --emit</code> on an event-sourced repo, or document them by hand)</div>
    </main>`;
    const pos = this.pos();
    const edge = (e) => { const a = pos.get(e.from), b = pos.get(e.to); const sx = a.x + PIPE.NODEW, sy = a.y + PIPE.NODEH / 2, tx = b.x, ty = b.y + PIPE.NODEH / 2, c = PIPE.COLW * 0.4; return html`<path class="pe ${e.type}" data-from="${e.from}" data-to="${e.to}" d="M${sx},${sy} C${sx + c},${sy} ${tx - c},${ty} ${tx},${ty}"></path>`; };
    const node = (n) => { const p = pos.get(n.id); const t = n.title.length > 34 ? n.title.slice(0, 33) + '…' : n.title;
      const rev = n.review.code === 'reviewed' || n.review.logical === 'reviewed';
      const human = (n.review.logical === 'reviewed' && n.reviewBy && n.reviewBy.logical === 'human') || (n.review.code === 'reviewed' && n.reviewBy && n.reviewBy.code === 'human');
      return html`<g class="pn ${n.type} ${rev ? 'rev' : ''}" data-id="${n.id}" transform="translate(${p.x},${p.y})">
      <rect width="${PIPE.NODEW}" height="${PIPE.NODEH}" rx="3"></rect><text x="6" y="11">${t}</text>${when(rev, () => html`<circle class="revdot ${human ? '' : 'checked'}" cx="${PIPE.NODEW - 7}" cy="8" r="3"></circle>`)}
    </g>`; };
    return html`<main class="wide">
      <div class="crumbs">${u} <span class="sep">·</span> event pipeline</div>
      <div class="nfilters">
        <select on-change="${(e) => this.setDomain(e.target.value)}"><option value="">all domains (${d.nodes.length} nodes)</option>${each(d.domains, dm => html`<option value="${dm}">${dm}</option>`, dm => dm)}</select>
        <span class="dim">drag to pan · scroll to zoom · hover a node to trace its wiring · click to open</span>
      </div>
      <svg class="pipeline" on-click="${(e) => this.onClick(e)}">
        <g class="vp" transform="translate(10,40)">
          ${each(d.layerNames.map((nm, i) => ({ nm, i, c: d.layerCounts[i] })), h => html`<text class="plabel" x="${h.i * PIPE.COLW}" y="-16">${h.nm} · ${h.c}</text>`, h => h.nm)}
          ${each(d.edges, edge, e => e.from + '~' + e.type + '~' + e.to)}
          ${each(d.nodes, node, n => n.id)}
        </g>
      </svg>
    </main>`;
  }
}
defineComponent('pipeline-page', PipelinePage);

// --- per-aggregate state machines: states + transitions, enrichment-aware -----
// States sit at their BFS layer (server-computed); transitions are placed
// client-side at the midpoint of their source→target span. A transition with no
// authored from_state edge hangs off the "?" gutter; a dynamic one with no
// static target parks in a right-hand column. Dashed = needs enrichment.
// COLW - NODEW must exceed TW so a transition fits between adjacent columns.
const SMAP = { COLW: 380, NODEW: 170, NODEH: 34, ROWH: 64, TW: 150, TH: 22, GUT: 110 };
const smapCurve = (sx, sy, tx, ty) => { const c = Math.max(30, Math.abs(tx - sx) * 0.4); return `M${sx},${sy} C${sx + c},${sy} ${tx - c},${ty} ${tx},${ty}`; };
class StatemapPage extends Component {
  static props = { params: {}, query: {} };
  constructor(props) { super(props); this.state = { data: null, loading: true, agg: '' }; this._view = { x: 10, y: 36, s: 1 }; }
  async fetchData() {
    nav.current = this.props.params.universe;
    if (!this.state.data) this.state.loading = true;
    const data = await api('/api/statemap', { u: this.props.params.universe });
    this.state.data = data; this.state.loading = false;
    await this.nextRender();
    this.setup();
  }
  mounted() { this.fetchData(); }
  propsChanged() { this.fetchData(); }
  machine() {
    const d = this.state.data; if (!d || !d.machines.length) return null;
    return d.machines.find((m) => m.aggregate.id === this.state.agg) || d.machines[0];
  }
  setAgg(v) { this.state.agg = v; this.nextRender().then(() => this.fit()); }
  layout() {
    const m = this.machine(); if (!m) return null;
    const S = SMAP;
    const spos = new Map();
    const layerOf = new Map();
    for (const st of m.states) { spos.set(st.id, { x: st.layer * S.COLW, y: st.row * S.ROWH }); layerOf.set(st.id, st.layer); }
    const maxLayer = Math.max(0, ...m.states.map((s) => s.layer));
    const placed = [];
    const bump = new Map(); let dynRow = 0;
    for (const t of m.transitions) {
      const dashed = !t.enriched || t.dynamic;
      let x, y, gutter = !t.sources.length;
      if (t.targets.length) {
        const tl = Math.min(...t.targets.map((id) => layerOf.get(id) ?? 1));
        const ty = t.targets.reduce((a, id) => a + ((spos.get(id) || { y: 0 }).y), 0) / t.targets.length;
        // midpoint of the horizontal GAP between source right edge and target left
        // edge (gutter transitions get a virtual source one column-gap to the left)
        const tgtLeft = tl * S.COLW;
        const srcRight = t.sources.length
          ? Math.max(...t.sources.map((id) => layerOf.get(id) ?? 0)) * S.COLW + S.NODEW
          : tgtLeft - (S.COLW - S.NODEW);
        x = (srcRight + tgtLeft) / 2 - S.TW / 2;
        y = ty + (S.NODEH - S.TH) / 2;
        // same-layer source→target (or backwards) would sit on the column itself:
        // drop between the rows instead of covering a state box
        if (x + S.TW > tgtLeft && srcRight > tgtLeft) { x = tgtLeft + (S.NODEW - S.TW) / 2; y += S.NODEH; }
      } else {
        x = (maxLayer + 1) * S.COLW; y = dynRow++ * (S.TH + 10);
      }
      const k = Math.round(x / 20) + ':' + Math.round(y / 12);
      const c = bump.get(k) || 0; bump.set(k, c + 1);
      y += c * (S.TH + 6);
      placed.push({ t, x, y, gutter, dashed });
    }
    return { m, spos, placed, maxLayer };
  }
  applyTransform() { const g = this.querySelector('.vp'); if (g) { const v = this._view; g.setAttribute('transform', `translate(${v.x},${v.y}) scale(${v.s})`); } }
  fit() {
    const svg = this.querySelector('svg.statemap'); if (!svg) return;
    const L = this.layout(); if (!L) return;
    const cw = svg.clientWidth || 960, ch = svg.clientHeight || 640;
    let maxX = SMAP.NODEW, maxY = SMAP.NODEH;
    for (const p of L.spos.values()) { maxX = Math.max(maxX, p.x + SMAP.NODEW); maxY = Math.max(maxY, p.y + SMAP.NODEH); }
    for (const p of L.placed) { maxX = Math.max(maxX, p.x + SMAP.TW); maxY = Math.max(maxY, p.y + SMAP.TH); }
    const s = Math.min(cw / (maxX + SMAP.GUT + 60), ch / (maxY + 80), 1.2);
    this._view = { s, x: Math.max(20, (cw - maxX * s) / 2), y: 50 };
    this.applyTransform();
  }
  hover(id) {
    const svg = this.querySelector('svg.statemap'); if (!svg) return;
    if (!id) { svg.classList.remove('hovering'); svg.querySelectorAll('.hl').forEach((el) => el.classList.remove('hl')); return; }
    const near = (this._adj && this._adj.get(id)) || new Set();
    svg.classList.add('hovering');
    svg.querySelectorAll('.pn').forEach((el) => el.classList.toggle('hl', el.getAttribute('data-id') === id || near.has(el.getAttribute('data-id'))));
    svg.querySelectorAll('.pe').forEach((el) => el.classList.toggle('hl', el.getAttribute('data-from') === id || el.getAttribute('data-to') === id));
  }
  setup() {
    const svg = this.querySelector('svg.statemap'); if (!svg) return;
    this.fit();
    if (!this._winWired) {
      this._winWired = true;
      window.addEventListener('mousemove', (e) => { const drag = this._drag; if (!drag) return; if (Math.abs(e.clientX - drag.sx) + Math.abs(e.clientY - drag.sy) > 3) drag.moved = true; this._view.x = drag.ox + (e.clientX - drag.sx); this._view.y = drag.oy + (e.clientY - drag.sy); this.applyTransform(); });
      window.addEventListener('mouseup', () => { const drag = this._drag; if (drag && drag.moved) { this._panned = true; setTimeout(() => { this._panned = false; }, 0); } this._drag = null; const s = this.querySelector('svg.statemap'); if (s) s.classList.remove('grabbing'); });
    }
    if (svg._cmWired) return; svg._cmWired = true;
    svg.addEventListener('mousedown', (e) => { if (e.target.closest('.pn')) return; this._drag = { sx: e.clientX, sy: e.clientY, ox: this._view.x, oy: this._view.y, moved: false }; svg.classList.add('grabbing'); });
    svg.addEventListener('wheel', (e) => { e.preventDefault(); const r = svg.getBoundingClientRect(); const mx = e.clientX - r.left, my = e.clientY - r.top; const f = e.deltaY < 0 ? 1.12 : 0.89; const v = this._view; const ns = Math.max(0.15, Math.min(3, v.s * f)); v.x = mx - (mx - v.x) * (ns / v.s); v.y = my - (my - v.y) * (ns / v.s); v.s = ns; this.applyTransform(); }, { passive: false });
    svg.addEventListener('mouseover', (e) => { const g = e.target.closest('.pn'); if (g) this.hover(g.getAttribute('data-id')); });
    svg.addEventListener('mouseout', (e) => { const g = e.target.closest('.pn'); if (g) this.hover(null); });
  }
  onClick(e) { if (this._panned) return; const g = e.target.closest('.pn'); if (g) go(nodeUrl(this.props.params.universe, g.getAttribute('data-open'))); }
  template() {
    const u = this.props.params.universe, d = this.state.data;
    if (this.state.loading || !d) return html`<main><div class="loading">loading…</div></main>`;
    if (!d.machines || !d.machines.length) return html`<main>
      <div class="crumbs">${u} <span class="sep">·</span> state map</div>
      <div class="empty">no state machines yet — run <code>codemap analyze marten --emit</code> on a repo whose aggregates carry a status enum</div>
    </main>`;
    const S = SMAP, L = this.layout(), m = L.m;
    const adj = new Map(); const link = (a, b) => { let s = adj.get(a); if (!s) { s = new Set(); adj.set(a, s); } s.add(b); };
    for (const p of L.placed) {
      for (const sid of p.t.sources) { link(sid, p.t.id); link(p.t.id, sid); }
      for (const tid of p.t.targets) { link(tid, p.t.id); link(p.t.id, tid); }
    }
    this._adj = adj;
    const epaths = [];
    for (const p of L.placed) {
      const dash = p.dashed ? ' dashed' : '';
      if (p.t.sources.length) {
        for (const sid of p.t.sources) { const sp = L.spos.get(sid); if (sp) epaths.push({ k: sid + '~' + p.t.id, from: sid, to: p.t.id, cls: 'pe from_state' + dash, d: smapCurve(sp.x + S.NODEW, sp.y + S.NODEH / 2, p.x, p.y + S.TH / 2) }); }
      } else {
        epaths.push({ k: '?~' + p.t.id, from: '?', to: p.t.id, cls: 'pe gutter' + dash, d: smapCurve(p.x - S.GUT * 0.6, p.y + S.TH / 2, p.x, p.y + S.TH / 2) });
      }
      for (const tid of p.t.targets) { const tp = L.spos.get(tid); if (tp) epaths.push({ k: p.t.id + '~' + tid, from: p.t.id, to: tid, cls: 'pe transitions_to' + dash, d: smapCurve(p.x + S.TW, p.y + S.TH / 2, tp.x, tp.y + S.NODEH / 2) }); }
    }
    const stateNode = (st) => { const p = L.spos.get(st.id);
      return html`<g class="pn state ${m.unreachable.includes(st.id) ? 'dashed' : ''}" data-id="${st.id}" data-open="${st.id}" transform="translate(${p.x},${p.y})">
        <rect width="${S.NODEW}" height="${S.NODEH}" rx="10"></rect>
        ${when(st.initial, () => html`<circle class="initdot" cx="10" cy="${S.NODEH / 2}" r="3"></circle>`)}
        <text x="${st.initial ? 20 : 12}" y="${S.NODEH / 2 + 3}">${st.member}</text>
      </g>`; };
    const trNode = (p) => { const t = p.t; const label = t.event ? t.event.title : t.title; const short = label.length > 20 ? label.slice(0, 19) + '…' : label;
      const trust = t.enrichment ? t.enrichment.trust : null;
      return html`<g class="pn transition ${p.dashed ? 'dashed' : ''}" data-id="${t.id}" data-open="${t.enrichment ? t.enrichment.id : t.id}" transform="translate(${p.x},${p.y})">
        <rect width="${S.TW}" height="${S.TH}" rx="4"></rect>
        <text x="6" y="${S.TH / 2 + 3}">${short}${t.dynamic ? ' → ?' : ''}</text>
        ${when(trust, () => html`<circle class="trustdot ${trust}" cx="${S.TW - 7}" cy="${S.TH / 2}" r="3"></circle>`)}
      </g>`; };
    return html`<main class="wide">
      <div class="crumbs">${u} <span class="sep">·</span> state map <span class="sep">·</span> ${m.aggregate.title}</div>
      <div class="nfilters">
        <select on-change="${(e, v) => this.setAgg(v)}">${each(d.machines, (mm) => html`<option value="${mm.aggregate.id}" selected="${mm.aggregate.id === m.aggregate.id}">${mm.aggregate.title} · ${mm.states.length} states, ${mm.transitions.length} transitions</option>`, (mm) => mm.aggregate.id)}</select>
        <span class="dim">${m.unenriched.length} unenriched · ${m.unreachable.length} unreachable${m.hasDynamic ? ' · has dynamic transitions' : ''} · dashed = needs enrichment · click a transition to open its doc</span>
      </div>
      <svg class="pipeline statemap" on-click="${(e) => this.onClick(e)}">
        <g class="vp" transform="translate(10,40)">
          ${when(L.placed.some((p) => p.gutter && p.t.targets.length), () => html`<text class="plabel" x="${-S.GUT}" y="-16">? source unknown</text>`)}
          ${when(L.placed.some((p) => !p.t.targets.length), () => html`<text class="plabel" x="${(L.maxLayer + 1) * S.COLW}" y="-16">dynamic · target unknown</text>`)}
          ${each(epaths, (p) => html`<path class="${p.cls}" data-from="${p.from}" data-to="${p.to}" d="${p.d}"></path>`, (p) => p.k)}
          ${each(m.states, stateNode, (st) => st.id)}
          ${each(L.placed, trNode, (p) => p.t.id)}
        </g>
      </svg>
    </main>`;
  }
}
defineComponent('statemap-page', StatemapPage);

// --- bugs: triage MCP-reported findings, re-validate against live code --------
const BUG_STATUSES = ['open', 'fixed', 'wontfix', 'invalid'];
class BugsPage extends Component {
  static props = { params: {}, query: {} };
  constructor(props) { super(props); this.state = { data: null, detail: null, detailPending: false }; }
  // Filter (status) and selection (bug) both live in the URL, so back/forward
  // walk the triage and any bug is deep-linkable.
  load = this.createTask(async () => {
    const u = this.props.params.universe; nav.current = u;
    this.state.data = await api('/api/bugs', { u, status: this.props.query.status || '' });
    await this.applySel();
  });
  mounted() { this._q = { ...this.props.query }; this._u = this.props.params.universe; this.load.run(); }
  propsChanged(name) {
    if (name !== 'query' && name !== 'params') return;
    const q = this.props.query, prev = this._q || {}, u = this.props.params.universe;
    this._q = { ...q };
    if (u !== this._u || q.status !== prev.status) { this._u = u; this.load.run(); }
    else if (q.bug !== prev.bug) this.applySel();
  }
  async applySel() {
    const id = this.props.query.bug;
    if (!id) { this.state.detail = null; return; }
    this.state.detailPending = true;
    try { this.state.detail = await api('/api/bug', { u: this.props.params.universe, id }); }
    finally { this.state.detailPending = false; }
  }
  pickStatus(s) { go(bugsUrl(this.props.params.universe), s ? { status: s } : {}); }
  pickBug(id) { go(bugsUrl(this.props.params.universe), { status: this.props.query.status, bug: id }); }
  async act(patch) {
    const u = this.props.params.universe, id = this.state.detail && this.state.detail.id;
    if (!id) return;
    await fetch('/api/bug/update', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ u, id, ...patch }) });
    await this.load.run();
  }

  bugRow(b) {
    const sel = this.props.query.bug === b.id;
    return html`<div class="brow ${b.status} ${sel ? 'sel' : ''}" on-click="${() => this.pickBug(b.id)}">
      <span class="sevdot" style="background:${SEV_COLOR[b.severity] || SEV_COLOR.medium}" title="severity: ${b.severity}"></span>
      <span class="btitle">${b.title}</span>
      ${when(b.possiblyFixed, () => html`<span class="bchip poss" title="cited code changed since filing — possibly fixed">possibly fixed</span>`,
        () => when(b.codeChanged, () => html`<span class="bchip changed" title="cited code changed since filing">code changed</span>`))}
      <span class="bchip ${b.status}">${b.status}</span>
      <span class="bmeta">${b.anchors.length}a</span>
    </div>`;
  }
  detail() {
    const u = this.props.params.universe, b = this.state.detail;
    if (this.state.detailPending && !b) return html`<div class="loading">loading…</div>`;
    if (!b) return html`<div class="empty" style="padding:40px">select a bug on the left</div>`;
    if (b.error) return html`<div class="empty">${b.error}</div>`;
    const closed = b.status !== 'open';
    return html`<div class="ddetail">
      <div class="dsymhead"><span class="sevdot" style="background:${SEV_COLOR[b.severity] || SEV_COLOR.medium}"></span> <b>${b.title}</b> <span class="bchip ${b.status}">${b.status}</span>${when(b.possiblyFixed, () => html`<span class="bchip poss">possibly fixed</span>`)}</div>
      <div class="meta">${b.severity} · ${b.id}${b.createdCommit ? ' · filed @ ' + b.createdCommit.slice(0, 8) : ''}</div>
      <div class="drev">
        <span class="dim">set status:</span>
        <span class="rev">${each(BUG_STATUSES, s => html`<button class="${b.status === s ? 'on' : ''}" on-click="${() => this.act({ status: s })}">${s}</button>`, s => s)}</span>
        <button class="bwit" title="re-snapshot the cited code's hashes as the current witness (clears stale)" on-click="${() => this.act({ refreshWitnesses: true })}">refresh witnesses</button>
      </div>
      <md-content text="${b.description}"></md-content>
      <div class="sec">cited code (${b.anchors.length})${when(b.staleAnchors, () => html` · <span class="warn">${b.staleAnchors} stale</span>`)}</div>
      ${each(b.anchors, a => html`<div class="banchor ${a.stale ? 'stale' : ''} ${a.present ? '' : 'gone'}" on-click="${() => go(anchorUrl(u, a.id))}">
        <span class="basym">${a.symbol}</span>
        <span class="bafile">${a.file || '(unresolved)'}${a.lines ? ':' + a.lines : ''}</span>
        ${when(!a.present, () => html`<span class="bchip changed" title="anchor no longer found (renamed/removed)">lost</span>`,
          () => when(a.stale, () => html`<span class="bchip changed" title="code changed since the bug's witness — re-validate">stale</span>`))}
      </div>`, a => a.id)}
      ${when(b.history && b.history.length, () => html`<div class="sec">history</div>
        <div class="bhist">${each(b.history, (h, i) => html`<div class="hline">${h}</div>`, (h, i) => i + h)}</div>`)}
    </div>`;
  }
  template() {
    const u = this.props.params.universe, d = this.state.data;
    if (!d || (this.load.pending && !d)) return html`<main><div class="loading">loading…</div></main>`;
    const counts = d.counts || {};
    const cur = this.props.query.status || '';
    const chip = (val, label) => html`<button class="${cur === val ? 'on' : ''}" on-click="${() => this.pickStatus(val)}">${label}${when(counts[val] != null, () => html` <span class="n">${counts[val]}</span>`)}</button>`;
    return html`<main class="wide">
      <div class="crumbs">${u} <span class="sep">·</span> bugs (${d.bugs.length}${cur ? ' shown' : ''})</div>
      <div class="dtoggle bugfilter"><span class="dim">status</span>
        ${chip('', 'all')}${each(BUG_STATUSES, s => chip(s, s), s => s)}
      </div>
      <div class="dgrid">
        <div class="dleft">
          ${when(!d.bugs.length, () => html`<div class="dim" style="padding:8px 2px">no bugs${cur ? ' with status “' + cur + '”' : ''} — report them via the <code>report_bug</code> MCP tool</div>`)}
          ${each(d.bugs, b => this.bugRow(b), b => b.id)}
        </div>
        <div class="dright">${this.detail()}</div>
      </div>
    </main>`;
  }
}
defineComponent('bugs-page', BugsPage);

const diffUrl = (u) => `/u/${u}/diff/`;
const DTAG = { '+': 'added', '-': 'removed', '~': 'changed' };

class DiffPage extends Component {
  static props = { params: {}, query: {} };
  constructor(props) { super(props); this.state = { snaps: null, diff: null, sel: null, selCode: null, codePending: false, view: 'doc', selDoc: null, docDiff: null, modal: false }; }
  // The base/head/sel selection lives entirely in the URL query, so the browser
  // back/forward buttons walk the review history and any drill-down is deep-linkable.
  // `load` (re)fetches the diff when base/head change; a sel-only change just
  // re-resolves the right-hand detail via applySel().
  load = this.createTask(async () => {
    const u = this.props.params.universe; nav.current = u;
    if (!this.state.snaps) this.state.snaps = (await api('/api/snapshots', { u })).snapshots;
    this.state.sel = null; this.state.selCode = null; this.state.selDoc = null; this.state.docDiff = null;
    const base = this.props.query.base;
    this.state.diff = base ? await api('/api/diff', { u, base, head: this.props.query.head || '' }) : null;
    await this.applySel();
  });
  mounted() { this._q = { ...this.props.query }; this._u = this.props.params.universe; this.load.run(); }
  propsChanged(name) {
    if (name !== 'query' && name !== 'params') return;
    const q = this.props.query, prev = this._q || {}, u = this.props.params.universe;
    this._q = { ...q };
    if (u !== this._u || q.base !== prev.base || q.head !== prev.head) { this._u = u; this.load.run(); }
    else if (q.sel !== prev.sel) this.applySel();
  }

  pick(kind, val) {
    // Changing base/head invalidates any drill-down, so `sel` is intentionally dropped.
    const q = { base: this.props.query.base, head: this.props.query.head };
    q[kind] = val;
    go(diffUrl(this.props.params.universe), q);
  }
  // Navigate to a drill-down (pushes browser history). `type` is 'doc' | 'sym'.
  pickSel(type, id) {
    go(diffUrl(this.props.params.universe), { base: this.props.query.base, head: this.props.query.head, sel: type + ':' + id });
  }
  // Resolve the right-hand detail from the `sel` query param against the loaded diff.
  async applySel() {
    const sel = this.props.query.sel || '', i = sel.indexOf(':');
    const type = i === -1 ? '' : sel.slice(0, i), id = i === -1 ? '' : sel.slice(i + 1);
    if (!type || !id || !this.state.diff || this.state.diff.error) {
      this.state.sel = null; this.state.selCode = null; this.state.selDoc = null; this.state.docDiff = null;
      return;
    }
    if (type === 'doc') await this.loadDoc(id);
    else if (type === 'sym') await this.loadCode(id);
  }
  async loadCode(id) {
    const u = this.props.params.universe, d = this.state.diff;
    const b = [...d.changed, ...d.removed, ...d.added].find(x => x.id === id) || { id, symbol: id.slice(0, 10), file: '', kind: '', tag: '~' };
    this.state.selDoc = null; this.state.docDiff = null; this.state.sel = b; this.state.selCode = null; this.state.codePending = true;
    try {
      this.state.selCode = await api('/api/diff/code', { u, base: this.props.query.base, head: this.props.query.head || '', id: b.id, file: b.file });
    } finally { this.state.codePending = false; }
  }
  async loadDoc(id) {
    const u = this.props.params.universe;
    const n = (this.state.diff.impact.nodes || []).find(x => x.id === id) || { id, title: id, status: 'removed', anchors: [], review: {} };
    this.state.sel = null; this.state.selCode = null; this.state.selDoc = n; this.state.docDiff = null; this.state.docPending = true;
    try {
      this.state.docDiff = await api('/api/diff/doc', { u, base: this.props.query.base, head: this.props.query.head || '', id });
    } finally { this.state.docPending = false; }
  }
  openModal() {
    this.state.modal = true;
    if (!this._escWired) { this._escWired = true; window.addEventListener('keydown', (e) => { if (e.key === 'Escape' && this.state.modal) this.closeModal(); }); }
  }
  closeModal() { this.state.modal = false; }
  docText(s) { return s.removed ? '_(removed on this branch)_' : `# ${s.title}\n\n${s.summary || ''}\n\n${s.body || ''}`; }
  async reloadDiff() {
    const u = this.props.params.universe, base = this.props.query.base;
    if (base) this.state.diff = await api('/api/diff', { u, base, head: this.props.query.head || '' });
  }
  async confirmDoc(id) { await postConfirm(this.props.params.universe, id); await this.reloadDiff(); }
  async ackDoc(id) { await postAckHole(this.props.params.universe, id); await this.reloadDiff(); }
  setView(v) { this.state.view = v; }
  briefIndex() { const d = this.state.diff, m = new Map(); for (const b of [...d.changed, ...d.removed, ...d.added]) m.set(b.id, b); return m; }
  docActions(n) {
    return html`${statusChip(n.status)}${sevChip(n.triage || { severity: n.severity, importance: null })}${when(n.versionCount > 1, () => html`<span class="vfork" title="${n.versionCount} versions">⑂${n.versionCount}</span>`)}<span class="ddacts">
      ${when(n.status === 'stale', () => html`<button title="confirm the doc still holds at this code" on-click="${(e) => { if (e.stopPropagation) e.stopPropagation(); this.confirmDoc(n.id); }}">confirm</button>`)}
      ${when(n.status === 'dangling', () => html`<button class="bad" title="cited code was removed here — ack" on-click="${(e) => { if (e.stopPropagation) e.stopPropagation(); this.ackDoc(n.id); }}">ack-hole</button>`)}
      <span class="rev">${this.revBtn('node', n.id, 'logical', n.review.logical, () => this.reloadDiff(), n.reviewBy && n.reviewBy.logical, n.reviewVia && n.reviewVia.logical)}</span></span>`;
  }
  revBtn(kind, id, level, state, after, actor, via) {
    const cls = revCls(state, actor, via);
    const tip = `${level}: ${state}${state === 'reviewed' && actor === 'agent' ? ' (agent-checked)' : ''}${via && VIA_TIP[via] ? VIA_TIP[via] : ''}`;
    return html`<button class="${cls}" title="${tip}" on-click="${async (e) => { if (e.stopPropagation) e.stopPropagation(); await postReview(this.props.params.universe, kind, id, level, state === 'reviewed'); await after(); }}">${level}${revMark(state, actor, via)}</button>`;
  }

  // Group the raw symbol changes by file for the structural view.
  byFile(d) {
    const m = new Map();
    const push = (b, tag) => { const g = m.get(b.file) || { file: b.file, items: [] }; g.items.push({ ...b, tag }); m.set(b.file, g); };
    d.added.forEach(b => push(b, '+')); d.removed.forEach(b => push(b, '-')); d.changed.forEach(b => push(b, '~'));
    return [...m.values()].sort((a, z) => a.file.localeCompare(z.file));
  }
  docsFor(id) { return (this.state.diff.impact.nodes || []).filter(n => (n.anchors || []).includes(id)); }
  bugsFor(id) { return (this.state.diff.impact.bugs || []).filter(bug => (bug.anchors || []).includes(id)); }
  // A bug rolled into the diff impact: click through to triage it in the bugs tab.
  bugRow(bug) {
    const u = this.props.params.universe, bi = this.briefIndex();
    return html`<div class="dbug ${bug.possiblyFixed ? 'poss' : ''}">
      <div class="dbugh" on-click="${() => go(bugsUrl(u), { bug: bug.id })}">
        <span class="sevdot" style="background:${SEV_COLOR[bug.severity] || SEV_COLOR.medium}" title="severity: ${bug.severity}"></span>
        <span class="dbugt">${bug.title}</span>
        ${when(bug.possiblyFixed, () => html`<span class="bchip poss" title="open bug on code that changed — this diff may fix it">possibly fixed</span>`)}
        ${when(bug.removed, () => html`<span class="bchip changed" title="cited code was removed in this diff">code removed</span>`)}
        <span class="bchip ${bug.status}">${bug.status}</span>
      </div>
      <div class="chips">${each(bug.anchors, aid => { const b = bi.get(aid); const s = this.state.sel && this.state.sel.id === aid; return html`<span class="chip mini ${s ? 'sel' : ''}" on-click="${() => this.openCodeById(aid)}">${b ? b.symbol : aid.slice(0, 10)}</span>`; }, aid => aid)}</div>
    </div>`;
  }

  symRow(b) {
    const sel = this.state.sel && this.state.sel.id === b.id;
    return html`<div class="drow ${DTAG[b.tag]} ${sel ? 'sel' : ''}" on-click="${() => this.pickSel('sym', b.id)}">
      <span class="dt ${DTAG[b.tag]}">${b.tag}</span><span class="dsym">${b.symbol}</span><span class="dk">${b.kind}</span>
    </div>`;
  }

  docDetail() {
    const u = this.props.params.universe, n = this.state.selDoc, dd = this.state.docDiff;
    return html`<div class="ddetail">
      <div class="dsymhead">📄 <b>${n.title || n.id}</b> ${statusChip(n.status)}${when(n.versionCount > 1, () => html`<span class="vfork">⑂${n.versionCount}</span>`)}</div>
      <div class="meta"><span class="viewlink" on-click="${() => go(nodeUrl(u, n.id))}">open doc ›</span></div>
      <div class="drev">${this.docActions(n)}</div>
      ${when(this.state.docPending, () => html`<div class="loading">loading…</div>`)}
      ${when(dd && dd.forked, () => html`<div class="sec">doc changes · ${dd.base.branch || 'base'} → ${dd.head.branch || 'head'} <span class="viewlink" on-click="${() => this.openModal()}">⛶ side-by-side</span></div>
        <pre class="hljs cdiff docdiff">${each(dd.lines, ln => html`<div class="cl ${DTAG[ln.tag] || 'ctx'}"><span class="g">${ln.tag}</span><code>${ln.text || ' '}</code></div>`)}</pre>`)}
      ${when(dd && !dd.forked && dd.doc, () => html`<div class="sec">document <span class="dim">· unchanged across this diff</span></div>
        <md-content text="${((dd.doc.summary || '') + (dd.doc.body ? '\n\n' + dd.doc.body : '')) || '_(empty)_'}"></md-content>`)}
      ${when(dd && !dd.forked && !dd.doc, () => html`<div class="dim" style="padding:8px 2px">${dd.error || dd.note || 'this doc is identical on both branches — no prose change'}</div>`)}
      <div class="sec">changed code it cites</div>
      <div class="chips">${each(n.anchors, aid => { const b = this.briefIndex().get(aid); return html`<span class="chip mini" on-click="${() => this.openCodeById(aid)}">${b ? b.symbol : aid.slice(0, 10)}</span>`; }, aid => aid)}</div>
    </div>`;
  }
  detail() {
    if (this.state.selDoc) return this.docDetail();
    const u = this.props.params.universe, b = this.state.sel, c = this.state.selCode;
    if (!b) return html`<div class="empty" style="padding:40px">select a doc or changed symbol on the left</div>`;
    const docs = this.docsFor(b.id);
    return html`<div class="ddetail">
      <div class="dsymhead"><span class="dt ${DTAG[b.tag]}">${b.tag}</span> <b>${b.symbol}</b> <span class="dk">${b.kind}</span></div>
      <div class="meta">${b.file}${c ? ' · ' + (c.hasBase ? 'base' : '∅') + ' → ' + (c.hasHead ? 'head' : '∅') : ''}
        <span class="viewlink" on-click="${() => go(anchorUrl(u, b.id))}">open anchor ›</span></div>
      ${when(c && c.review, () => html`<div class="drev"><span class="dim">mark this change reviewed:</span>
        <span class="rev">${this.revBtn('anchor', b.id, 'logical', c.review.logical, () => this.loadCode(b.id), c.reviewBy && c.reviewBy.logical)}${this.revBtn('anchor', b.id, 'code', c.review.code, () => this.loadCode(b.id), c.reviewBy && c.reviewBy.code)}</span></div>`)}
      <div class="sec">code diff</div>
      ${when(this.state.codePending, () => html`<div class="loading">loading code…</div>`)}
      ${when(c, () => html`<pre class="hljs cdiff">${each(diffCodeRows(c.lines, c.lang), row => html`<div class="cl ${DTAG[row.tag] || 'ctx'}"><span class="g">${row.tag}</span><code>${raw(row.html || ' ')}</code></div>`, (row, i) => i)}</pre>`)}
      ${when(docs.length, () => html`<div class="sec">affected docs (${docs.length})</div>
        ${each(docs, n => html`<div class="ddoc">
          <div class="ddoch"><span class="ddoct" on-click="${() => this.pickSel('doc', n.id)}">${n.title || n.id}</span>${this.docActions(n)}</div>
          <md-content text="${n.summary}"></md-content>
        </div>`, n => n.id)}`)}
      ${when(this.bugsFor(b.id).length, () => html`<div class="sec">bugs on this symbol (${this.bugsFor(b.id).length})</div>
        ${each(this.bugsFor(b.id), bug => this.bugRow(bug), bug => bug.id)}`)}
    </div>`;
  }

  template() {
    const u = this.props.params.universe, d = this.state.diff, snaps = this.state.snaps || [];
    const base = this.props.query.base || '', head = this.props.query.head || '';
    const opt = (s, val) => html`<option value="${s.ref}" selected="${s.ref === val}">${(s.branch || '(detached)')} · ${s.ref.slice(0, 8)} (${s.count})</option>`;
    return html`<main class="wide">
      <div class="crumbs">${u} <span class="sep">·</span> branch diff</div>
      <div class="dpick">
        <label>base
          <select on-change="${(e) => this.pick('base', e.target.value)}">
            <option value="" selected="${!base}">select a cached snapshot…</option>
            ${each(snaps, s => opt(s, base), s => s.ref)}
          </select></label>
        <span class="arrow">→</span>
        <label>head
          <select on-change="${(e) => this.pick('head', e.target.value)}">
            <option value="" selected="${!head}">working tree (live)</option>
            ${each(snaps, s => opt(s, head), s => 'h' + s.ref)}
          </select></label>
        ${when(!snaps.length, () => html`<span class="dim">no snapshots yet — run <code>codemap init</code> / <code>snapshot</code> on the branches</span>`)}
      </div>

      ${when(d && d.error, () => html`<div class="empty">${d.error}</div>`)}
      ${when(d && !d.error, () => html`
        <div class="dsummary">
          <span><b>${d.base.label}</b> <span class="dim">${(d.base.sha || '').slice(0, 8)}</span></span>
          <span class="arrow">→</span>
          <span><b>${d.head.label}</b></span>
          <span class="dcounts"><i class="added">+${d.added.length}</i> <i class="removed">−${d.removed.length}</i> <i class="changed">~${d.changed.length}</i></span>
        </div>
        ${when(d.coverage && d.coverage.total, () => html`<div class="dsummary" style="border-top:1px solid #222;padding-top:6px">${coverageBar(d.coverage)}</div>`)}

        <div class="dgrid">
          <div class="dleft">
            ${when(d.impact.flows.length, () => html`<div class="sec">flows changed (${d.impact.flows.length})</div>
              ${each(d.impact.flows, f => html`<div class="dflow">
                <div class="dflowt" on-click="${() => go(flowUrl(u, f.id))}">⇒ ${f.title}</div>
                ${each(f.steps, s => html`<div class="dstep"><span class="stn">${s.title}</span>
                  <span class="chips">${each(s.anchors, aid => html`<span class="chip mini" on-click="${() => this.openCodeById(aid)}">${aid.slice(0, 10)}</span>`, aid => aid)}</span>
                </div>`, s => s.id)}
              </div>`, f => f.id)}`)}

            ${when(d.impact.bugs && d.impact.bugs.length, () => html`<div class="sec">bugs on changed code (${d.impact.bugs.length})</div>
              ${each(d.impact.bugs, bug => this.bugRow(bug), bug => bug.id)}`)}

            <div class="dtoggle"><span class="dim">changes</span>
              <button class="${this.state.view === 'doc' ? 'on' : ''}" on-click="${() => this.setView('doc')}">by doc (${d.impact.nodes.length})</button>
              <button class="${this.state.view === 'file' ? 'on' : ''}" on-click="${() => this.setView('file')}">by file</button>
            </div>
            ${when(this.state.view === 'doc', () => this.docForward(), () => this.byFileView())}
          </div>
          <div class="dright">${this.detail()}</div>
        </div>`)}
      ${when(this.state.modal && this.state.docDiff && this.state.docDiff.forked, () => { const dd = this.state.docDiff; return html`<div class="modal-bg" on-click="${(e) => { if (e.target.classList.contains('modal-bg')) this.closeModal(); }}">
        <div class="modal">
          <div class="modal-head"><b>${this.state.selDoc.title || this.state.selDoc.id}</b> <span class="dim">— doc versions side by side</span><button class="modal-x" on-click="${() => this.closeModal()}">✕</button></div>
          <div class="modal-body sxs">
            <div class="sxs-col"><div class="sxs-h">${dd.base.branch || 'base'} <span class="dim">@ ${(dd.base.commit || '').slice(0, 8) || '—'}</span></div><md-content text="${this.docText(dd.base)}"></md-content></div>
            <div class="sxs-col"><div class="sxs-h">${dd.head.branch || 'head'} <span class="dim">@ ${(dd.head.commit || '').slice(0, 8) || '—'}</span></div><md-content text="${this.docText(dd.head)}"></md-content></div>
          </div>
        </div>
      </div>`; })}
    </main>`;
  }

  // Open code for an anchor id referenced by a flow step (navigate → deep-linkable).
  openCodeById(id) { this.pickSel('sym', id); }
  // Doc-forward: the affected docs (broad view) with per-doc status/actions and the
  // changed symbols each cites (click a symbol to drill into its code diff).
  docForward() {
    const u = this.props.params.universe, d = this.state.diff, bi = this.briefIndex();
    const order = { dangling: 0, stale: 1, removed: 2, fresh: 3, generated: 4 };
    const docs = [...d.impact.nodes].sort((a, b) => (order[a.status] ?? 9) - (order[b.status] ?? 9) || a.title.localeCompare(b.title));
    if (!docs.length) return html`<div class="dim" style="padding:8px 2px">no documented code changed in this diff</div>`;
    return html`${each(docs, n => html`<div class="dfdoc ${n.status} ${this.state.selDoc && this.state.selDoc.id === n.id ? 'sel' : ''}">
      <div class="dfdh"><span class="dfdt" on-click="${() => this.pickSel('doc', n.id)}">${n.title || n.id}</span>${this.docActions(n)}</div>
      <div class="chips">${each(n.anchors, aid => { const b = bi.get(aid); const s = this.state.sel && this.state.sel.id === aid; return html`<span class="chip mini ${s ? 'sel' : ''}" on-click="${() => this.openCodeById(aid)}">${b ? b.symbol : aid.slice(0, 10)}</span>`; }, aid => aid)}</div>
    </div>`, n => n.id)}`;
  }
  byFileView() {
    const u = this.props.params.universe, d = this.state.diff, bf = this.byFile(d);
    if (!bf.length) return html`<div class="dim" style="padding:8px 2px">no symbol-level changes</div>`;
    return html`${each(bf, g => html`<div class="dfile">
      <div class="dfileh" on-click="${() => goTree(u, g.file)}">${g.file} <span class="dim">${g.items.length}</span></div>
      ${each(g.items, b => this.symRow(b), b => b.id + b.tag)}
    </div>`, g => g.file)}`;
  }
}
defineComponent('diff-page', DiffPage);

// Unified diff rendering, with the same per-line finding affordance as the full
// source view — a reviewer looking at what changed is exactly who wants to raise
// something, so the diff must not be a read-only dead end.
//
// A finding pins to a HEAD line number, so the counter advances on context and
// added lines only. Removed lines have no line in the head file at all: they are
// still shown (they are half the change) but carry no 💬, because the alternative
// is inventing a line number that points at unrelated code.
//
// Highlighted per line rather than as a block: the +/- signs are not part of the
// language, so a whole-block highlight would lex them as syntax.
function diffReviewLines(c, u, anchorId, lines, lang, startLine, annotations) {
  if (!lines || !lines.length) return html`<pre class="code rvcode">(no diff available)</pre>`;
  const byLine = new Map(); const noLine = [];
  for (const a of (annotations || [])) { if (a.line) { (byLine.get(a.line) || byLine.set(a.line, []).get(a.line)).push(a); } else noLine.push(a); }
  let head = (startLine || 1) - 1;
  const rows = lines.map((l) => {
    const n = l.tag === '-' ? null : ++head;
    return { tag: l.tag, text: l.text, n };
  });
  return html`<div class="rvpre hljs prdiff">
    ${each(rows, (r, i) => {
      const finds = r.n ? (byLine.get(r.n) || []) : [];
      return html`<div class="flrow">
        <div class="dline ${r.tag === '+' ? 'add' : r.tag === '-' ? 'del' : ''}">
          <span class="dsign">${r.tag}</span>
          <span class="flno">${r.n ?? ''}</span>
          <span class="fltext">${raw(highlight(r.text, lang))}</span>
          ${when(r.n, () => html`<button class="flcomment" title="raise a finding on line ${r.n}" on-click="${() => openFindingForm(c, anchorId, r.n)}">💬</button>`)}
        </div>
        ${each(finds, f => findingItemEl(c, u, f), f => f.id)}
        ${when(r.n && c.state.finding === findingKey(anchorId, r.n), () => findingForm(c, u, anchorId, r.n))}
      </div>`;
    }, (r, i) => i)}
    ${when(noLine.length, () => html`<div class="rvfinds">${each(noLine, f => findingItemEl(c, u, f), f => f.id)}</div>`)}
  </div>`;
}

// --- PR walkthrough ----------------------------------------------------------
// "Tell me the story of this change." Chapters come from the spec markdown the PR
// itself ships (server: pr-story.ts), each bound to the symbols that implement it
// and ordered command → handler → event → aggregate → read-model. A chapter whose
// spec describes the *system* rather than this change is marked promotable; the
// rest are an executive summary and stay ephemeral.
const CHANGE_COLOR = { added: '#7ee787', changed: '#f0a35e', removed: '#f85149' };
const LAYER_NAME = ['command', 'handler', 'event', 'aggregate', 'read-model', 'job'];

class PrStoryPage extends Component {
  static props = { params: {}, query: {} };
  constructor(props) { super(props); this.state = { story: null, open: {}, code: {}, pending: {}, finding: null, prRef: null, showBase: {}, promote: null, promoted: {}, showCovered: false, deriving: false, derived: null, pulling: false, pulled: null }; }
  load = this.createTask(async () => {
    const u = this.props.params.universe; nav.current = u;
    const story = await api('/api/pr/story', { u, pr: this.props.params.pr });
    this.state.story = story;
    this.state.prRef = story && story.refs ? story.refs.head : null;
    // Open the first chapter that still has unsigned work — the queue, not chapter 1.
    if (story && story.chapters && !Object.keys(this.state.open).length) {
      const first = story.chapters.find(c => c.steps.some(s => !s.reviewed));
      if (first) this.state.open = { [first.id]: true };
    }
    // Expanded code panes carry their own copy of a step's annotations, so a
    // reload that only refreshed the story left a finding you just raised — or
    // just handed to an agent — invisible until the pane was collapsed and
    // reopened. Refresh whatever is open alongside it.
    await this.refreshOpenCode();
  });

  async refreshOpenCode() {
    const open = Object.entries(this.state.code).filter(([, v]) => v && !v.error).map(([id]) => id);
    if (!open.length) return;
    const fresh = { ...this.state.code };
    for (const id of open) {
      try { fresh[id] = await api('/api/pr/code', { u: this.props.params.universe, pr: this.props.params.pr, id }); } catch { /* keep the stale pane rather than blanking it */ }
    }
    this.state.code = fresh;
  }
  mounted() { this.load.run(); }
  propsChanged(name) { if (name === 'params') { this.state.open = {}; this.state.code = {}; this.load.run(); } }

  toggleChapter(id) { this.state.open = { ...this.state.open, [id]: !this.state.open[id] }; }
  async openStep(step) {
    const id = step.anchorId;
    if (this.state.code[id]) { this.state.code = { ...this.state.code, [id]: null }; return; }
    this.state.pending = { ...this.state.pending, [id]: true };
    try {
      const c = await api('/api/pr/code', { u: this.props.params.universe, pr: this.props.params.pr, id });
      this.state.code = { ...this.state.code, [id]: c };
    } finally { this.state.pending = { ...this.state.pending, [id]: false }; }
  }
  async markStep(id, attestation, state, actor) {
    const unmark = state === 'reviewed' && actor !== 'agent';
    await postReview(this.props.params.universe, 'anchor', id, 'code', unmark, attestation, this.state.prRef);
    await this.load.run();
    if (this.state.code[id]) { const c = await api('/api/pr/code', { u: this.props.params.universe, pr: this.props.params.pr, id }); this.state.code = { ...this.state.code, [id]: c }; }
  }

  // Promotion is deliberately two-step: the plan says what would be written and
  // why that shape, and nothing lands until it is confirmed. An auto-promoted map
  // is worse than one with no chapters in it.
  // Stakes for symbols the branch ADDS cannot come from the graph — they are not in
  // the live index at all — so the PR-scoped derivation is offered here, where the
  // symbols in question are on screen.
  async deriveTriage() {
    this.state.deriving = true;
    const r = await fetch('/api/pr/triage', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ u: this.props.params.universe, pr: this.props.params.pr }),
    }).then(x => x.json());
    this.state.deriving = false;
    this.state.derived = r.error ? { error: r.error } : r;
    if (!r.error) await this.load.run();
  }

  // GitHub's per-file tick is weaker than a codemap sign-off: one click on a whole
  // file, no record of what was in it. It imports as `viewed` and never `signed` —
  // "eyes were on it", which is exactly what the checkbox can honestly claim.
  async pullViewed() {
    this.state.pulling = true;
    const r = await fetch('/api/pr/pull_viewed', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ u: this.props.params.universe, pr: this.props.params.pr }),
    }).then(x => x.json());
    this.state.pulling = false;
    this.state.pulled = r.error ? { error: r.error } : r;
    if (!r.error) await this.load.run();
  }

  async openPromote(ch) {
    if (this.state.promote && this.state.promote.chapter === ch.id) { this.state.promote = null; return; }
    this.state.promote = { chapter: ch.id, loading: true };
    const r = await api('/api/pr/promote_plan', { u: this.props.params.universe, pr: this.props.params.pr, chapter: ch.id });
    if (r.error) { this.state.promote = { chapter: ch.id, error: r.error }; return; }
    this.state.promote = { chapter: ch.id, plan: r.promotion, existing: r.existing, id: r.promotion.id, title: r.promotion.title, summary: r.promotion.summarySource === 'title' ? '' : r.promotion.summary };
  }
  async confirmPromote(ch) {
    const p = this.state.promote;
    // `saving` also guards: a second click while the POST is in flight wrote a
    // second doc version of the same node from one user action.
    if (!p || !p.plan || p.saving) return;
    const id = (p.id || '').trim();
    this.state.promote = { ...p, saving: true };
    const res = await fetch('/api/pr/promote', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        u: this.props.params.universe, pr: this.props.params.pr, chapter: ch.id,
        // An emptied box is not a request for a node called "" — the plan's own
        // value is what the human was shown, so that is what it falls back to.
        id: id && id !== p.plan.id ? id : undefined,
        title: (p.title || '').trim() || p.plan.title,
        summary: (p.summary || '').trim() || p.plan.summary,
        type: p.plan.type,
      }),
    }).then(x => x.json());
    if (res.error) { this.state.promote = { ...p, saving: false, error: res.error }; return; }
    this.state.promoted = { ...this.state.promoted, [ch.id]: res.promoted };
    this.state.promote = null;
  }
  promoteFormEl(u, ch) {
    const p = this.state.promote;
    if (!p || p.chapter !== ch.id) return html``;
    if (p.error) return html`<div class="prpromo err">${p.error}</div>`;
    if (!p.plan) return html`<div class="prpromo dim">planning…</div>`;
    // Promotion UPSERTS, and which node it lands on is the one thing here that
    // cannot be undone — so the id is shown and editable, and a node this section
    // did not write is called out before the button rather than refused after it.
    // `prPromote` refuses either way; this is so the human is not surprised.
    const clash = p.existing && !p.existing.ours;
    return html`<div class="prpromo">
      <div class="dim">${p.plan.rationale}</div>
      ${when(clash, () => html`<div class="prpromo-clash">⚠ a node <code>${p.existing.id}</code> already exists ("${p.existing.title}") and was not promoted from this section. Promoting onto it would rewrite it — give the id below an unused name.</div>`)}
      ${when(p.existing && p.existing.ours, () => html`<div class="dim">updates <code>${p.existing.id}</code>, promoted from this section before.</div>`)}
      <label>id<input value="${p.id}" on-input="${(e) => { this.state.promote = { ...this.state.promote, id: e.target.value }; }}"></label>
      <label>title<input value="${p.title}" on-input="${(e) => { this.state.promote = { ...this.state.promote, title: e.target.value }; }}"></label>
      <label>summary${when(p.plan.summarySource === 'title', () => html`<span class="dim"> — the spec has no sentence describing the system; write one</span>`)}
        <input placeholder="${p.plan.summary}" value="${p.summary}" on-input="${(e) => { this.state.promote = { ...this.state.promote, summary: e.target.value }; }}"></label>
      ${when(p.plan.steps, () => html`<div class="dim">flow steps: ${p.plan.steps.map(s => `${s.title} (${s.anchors.length})`).join(' → ')}</div>`)}
      <div class="prpromoacts">
        <button class="on" disabled="${!!p.saving}" on-click="${() => this.confirmPromote(ch)}">${p.saving ? 'promoting…' : `promote as ${p.plan.type}`}</button>
        <button class="ghost" on-click="${() => { this.state.promote = null; }}">cancel</button>
        <span class="dim">cites ${p.plan.anchors.length} symbol(s) at this PR's head</span>
      </div>
    </div>`;
  }

  // A changed symbol opens on its diff — the delta is the review, and the rest of
  // the body is context the reviewer did not ask for. Added and removed symbols
  // have no meaningful "before", so those open on the source itself.
  showsDiff(step) {
    const code = this.state.code[step.anchorId];
    if (!code || !code.base || !code.head) return false;
    const override = this.state.showBase[step.anchorId];
    return override === undefined ? step.change === 'changed' : !!override;
  }

  stepEl(u, step) {
    const code = this.state.code[step.anchorId];
    const finds = openFindingCount(step.annotations);
    const showBase = this.state.showBase[step.anchorId];
    return html`<div class="prstep ${step.reviewed ? 'done' : ''}">
      <div class="prsthead" on-click="${() => this.openStep(step)}">
        <span class="prlayer" title="position on the command → read-model spine">${LAYER_NAME[step.layer] || 'code'}</span>
        <span class="prchg" style="color:${CHANGE_COLOR[step.change] || '#8b949e'}">${step.change}</span>
        ${sevDot(step.severity)}
        <code class="prsig">${step.signature || step.symbol}</code>
        <span class="dim prfile">${step.file.split('/').pop()}</span>
        ${when(finds, () => html`<span class="prfind" title="${finds} open finding(s)">⚑${finds}</span>`)}
        <span class="prrev" on-click="${(e) => { if (e.stopPropagation) e.stopPropagation(); }}">${reviewRowEl({ code: step.review || { state: step.reviewed ? 'reviewed' : 'unreviewed' } }, { code: step.viewedMark || { state: step.viewed ? 'reviewed' : 'unreviewed' } }, (att, st, actor) => this.markStep(step.anchorId, att, st, actor))}</span>
      </div>
      ${when(this.state.pending[step.anchorId], () => html`<div class="dim prload">loading source…</div>`)}
      ${when(code && !code.error, () => html`<div class="prsbody">
        <div class="prstools">
          <span class="dim">${code.file}</span>
          ${when(code.base && code.head, () => html`<button class="ghost" on-click="${() => { this.state.showBase = { ...this.state.showBase, [step.anchorId]: !this.state.showBase[step.anchorId] }; }}">${this.showsDiff(step) ? 'show full source' : 'show diff'}</button>`)}
          ${when(code.lineEndingsChanged, () => html`<span class="crlf" title="one side uses CRLF and the other LF. The diff below is normalised so a line-ending flip does not read as a full rewrite — but the change is real and will show in the file diff on GitHub.">⚠ line endings changed</span>`)}
          <span class="viewlink" title="open the full anchor page" on-click="${() => go(anchorUrl(u, step.anchorId))}">↗</span>
        </div>
        ${when(this.showsDiff(step),
          () => diffReviewLines(this, u, step.anchorId, code.lines, code.lang, code.startLine, code.annotations),
          () => codeReviewLines(this, u, step.anchorId, code.head, code.lang, code.startLine, code.annotations))}
      </div>`)}
      ${when(code && code.error, () => html`<div class="prsbody dim">${code.error}</div>`)}
    </div>`;
  }

  chapterEl(u, ch) {
    const open = !!this.state.open[ch.id];
    const done = ch.steps.filter(s => s.reviewed).length;
    return html`<section class="prchapter ${ch.source}">
      <div class="prchead" on-click="${() => this.toggleChapter(ch.id)}">
        <span class="prtwisty">${open ? '▾' : '▸'}</span>
        <b class="prctitle">${ch.title}</b>
        ${when(ch.source === 'spec', () => html`<span class="prbadge spec" title="derived from ${ch.specPath}">spec</span>`)}
        ${when(ch.durable && !this.state.promoted[ch.id], () => html`<button class="prbadge durable" title="this section describes the system, not just this change — promote it into the map" on-click="${(e) => { if (e.stopPropagation) e.stopPropagation(); this.openPromote(ch); }}">promote →</button>`)}
        ${when(this.state.promoted[ch.id], () => html`<span class="prbadge promoted" title="now a node in the map" on-click="${(e) => { if (e.stopPropagation) e.stopPropagation(); go(nodeUrl(u, this.state.promoted[ch.id])); }}">✓ in the map ↗</span>`)}
        ${when(ch.source !== 'spec', () => html`<span class="prbadge orphan" title="no spec section in this PR names these symbols">unspecified</span>`)}
        <span class="dim prcount">${done}/${ch.steps.length} signed</span>
      </div>
      ${this.promoteFormEl(u, ch)}
      ${when(open, () => html`<div class="prcbody">
        ${when(ch.source === 'spec' && ch.prose, () => html`<md-content text="${ch.prose}" untrusted="${true}"></md-content>`)}
        ${when(ch.source !== 'spec', () => html`<div class="dim prorphan">${ch.prose}</div>`)}
        ${each(ch.steps, s => this.stepEl(u, s), s => s.anchorId)}
      </div>`)}
    </section>`;
  }

  // Grouped by why, because undifferentiated this list is unreadable: on a
  // back-end PR most entries are the front-end half of the same spec cluster, and
  // most of the rest are sections a sibling section already documented.
  specGapEl(st) {
    const gaps = st.specWithoutCode || [];
    if (!gaps.length) return html``;
    const by = (r) => gaps.filter(g => g.reason === r);
    const REASON = {
      absent: ['not in this repo', 'Nothing by these names exists in this universe — implemented in a sibling repo, or genuinely not built.'],
      unchanged: ['already here, untouched', 'These symbols exist in this universe; this PR did not change them.'],
      covered: ['documented by another section', 'Their symbols ARE in this PR — a sibling section claimed them first, since a symbol appears in one chapter only.'],
    };
    const group = (r) => {
      const list = by(r);
      if (!list.length) return html``;
      const openIt = r !== 'covered' || this.state.showCovered;
      return html`<div class="prgap g-${r}">
        <div class="prgaph" on-click="${() => { if (r === 'covered') this.state.showCovered = !this.state.showCovered; }}">
          <b>${list.length}</b> ${REASON[r][0]}${when(r === 'covered', () => html`<span class="dim"> ${this.state.showCovered ? '▾' : '▸'}</span>`)}
        </div>
        ${when(openIt, () => html`<div class="dim prorphan">${REASON[r][1]}</div>
          ${each(list, x => html`<div class="prswc"><code>${x.heading}</code><span class="dim"> — ${x.specPath.split('/').pop()}${x.names && x.names.length ? ' · ' + x.names.slice(0, 3).join(', ') : ''}</span></div>`, x => x.specPath + x.heading)}`)}
      </div>`;
    };
    return html`<section class="prchapter">
      <div class="prchead"><b class="prctitle">Spec sections with no code in this PR</b><span class="dim prcount">${gaps.length}</span></div>
      <div class="prcbody">${group('absent')}${group('unchanged')}${group('covered')}</div>
    </section>`;
  }

  template() {
    const st = this.state.story, u = this.props.params.universe;
    // pageShell renders `loading` whenever data is falsy, so passing null alongside
    // an error made every failure here an eternal "loading…". Pass the payload.
    if (!st) return html`<main><div class="loading">loading pull request…</div></main>`;
    if (st.error) return pageShell(st, st.error, html``);
    const signed = st.chapters.reduce((n, c) => n + c.steps.filter(s => s.reviewed).length, 0);
    return pageShell(st, null, html`
      <div class="prhead">
        <h2>#${st.pr.number} ${st.pr.title}</h2>
        <div class="dim">${st.pr.author} · ${st.pr.headRef} → ${st.pr.baseRef} ·
          <a href="${st.pr.url}" target="_blank" rel="noreferrer">open on GitHub ↗</a></div>
        <div class="prstats">
          <span><b>${signed}</b>/${st.totals.steps} symbols signed</span>
          <span><b>${st.totals.chapters}</b> chapters</span>
          <span title="lines in the review queue vs total changed"><b>${st.totals.queueLines}</b>/${st.totals.changedLines} lines to review</span>
          ${when(st.undocumented, () => html`<span class="warn" title="changed symbols no spec section accounts for">${st.undocumented} unspecified</span>`)}
          ${when(st.specWithoutCode.filter(g => g.reason === 'absent').length, () => html`<span class="warn" title="spec sections naming code that is nowhere in this universe — a sibling repo's half of the spec, or unbuilt">${st.specWithoutCode.filter(g => g.reason === 'absent').length} spec not in this repo</span>`)}
          ${when(st.refs.baseAheadOfMergeBase, () => html`<span class="dim" title="the PR is diffed against its merge-base, not the tip of ${st.pr.baseRef} — otherwise those commits would read as part of this change">${st.pr.baseRef} moved ${st.refs.baseAheadOfMergeBase} commits since branch</span>`)}
        </div>
        <div class="prlanes">${each(st.lanes, l => html`<span class="prlane l-${l.review}" title="${l.why}"><b>${l.lane}</b> ${l.lines} lines · ${l.files} files · ${l.review}</span>`, l => l.lane)}</div>
        <div class="prderive">
          <button on-click="${() => this.deriveTriage()}" title="propose stakes and complexity for this PR's symbols. Symbols the branch adds are not in the live index, so the graph-wide derivation cannot see them at all.">${this.state.deriving ? 'deriving…' : 'derive stakes for this PR'}</button>
          ${when(this.state.derived && this.state.derived.error, () => html`<span class="warn">${this.state.derived.error}</span>`)}
          <button on-click="${() => this.pullViewed()}" title="import GitHub's per-file viewed ticks. They land as viewed, never signed — a tick is one click on a whole file, not a vouch for its contents.">${this.state.pulling ? 'importing…' : 'import viewed from GitHub'}</button>
          ${when(this.state.pulled && this.state.pulled.error, () => html`<span class="warn">${this.state.pulled.error}</span>`)}
          ${when(this.state.pulled && !this.state.pulled.error, () => html`<span class="dim">${this.state.pulled.files.viewedOnGitHub}/${this.state.pulled.files.total} files ticked on GitHub → ${this.state.pulled.anchors.marked} symbol(s) marked <b>viewed</b>${this.state.pulled.anchors.alreadySigned ? `; ${this.state.pulled.anchors.alreadySigned} already signed and left alone` : ''}.</span>`)}
          ${when(this.state.derived && !this.state.derived.error, () => html`<span class="dim">${this.state.derived.applied} newly proposed${this.state.derived.refused ? `, ${this.state.derived.refused} already at or above this tier` : ''} — of ${this.state.derived.considered} with a signal. Every one is <b>likely</b>: confirm or lower it yourself.</span>`)}
        </div>
      </div>
      ${when(!st.totals.steps, () => html`<section class="prchapter"><div class="prcbody prempty">
        <b>Nothing in the review queue.</b>
        <div class="dim">Every changed file in this PR falls outside the code lane, so there are no symbols to walk through.
        That is a verdict, not a failure — the lane strip above shows where the ${st.totals.changedLines} changed lines went.
        Tests and generated files are still read by the first-pass agent, which can promote one into your queue if it matters.</div>
      </div></section>`)}
      ${each(st.chapters, c => this.chapterEl(u, c), c => c.id)}
      ${this.specGapEl(st)}
    `);
  }
}
defineComponent('pr-story-page', PrStoryPage);

// The PR inbox. Deliberately cheap: it renders `gh pr list` metadata only, because
// triaging a PR means snapshotting both its sides, and doing that for every open PR
// just to draw a list would cost seconds per row. The numbers arrive on the
// walkthrough itself.
class PrInboxPage extends Component {
  static props = { params: {}, query: {} };
  constructor(props) { super(props); this.state = { d: null }; }
  load = this.createTask(async () => {
    const u = this.props.params.universe; nav.current = u;
    this.state.d = await api('/api/prs', { u });
  });
  mounted() { this.load.run(); }
  propsChanged(name) { if (name === 'params') this.load.run(); }

  template() {
    const u = this.props.params.universe, d = this.state.d;
    if (!d) return html`<main><div class="loading">loading pull requests…</div></main>`;
    if (d.error) return pageShell(d, d.error, html``);
    return pageShell(d, null, html`
      <div class="crumbs"><b>${u}</b> <span class="sep">·</span> pull requests <span class="dim">· ${d.prs.length} open</span></div>
      ${when(!d.prs.length, () => html`<div class="dim">no open pull requests.</div>`)}
      ${each(d.prs, p => html`<div class="prrow" on-click="${() => go(prUrl(u, p.number))}">
        <span class="prnum">#${p.number}</span>
        <span class="prtitle">${p.title}</span>
        ${when(p.draft, () => html`<span class="prbadge orphan">draft</span>`)}
        <span class="dim prmeta">${p.author}</span>
        <span class="dim prmeta">${p.headRef} → ${p.baseRef}</span>
        <span class="prsize" title="${p.changedFiles} files changed"><span class="pradd">+${p.additions}</span> <span class="prdel">−${p.deletions}</span></span>
      </div>`, p => p.number)}
    `);
  }
}
defineComponent('pr-inbox-page', PrInboxPage);



router = enableRouting(document.querySelector('router-outlet'), {
  '/': { component: 'home-page' },
  '/u/:universe/': { component: 'dashboard-page' },
  '/u/:universe/tree/': { component: 'outline-page' },
  '/u/:universe/tree/:path*/': { component: 'outline-page' },
  '/u/:universe/anchor/:id/': { component: 'anchor-page' },
  '/u/:universe/node/:id/': { component: 'node-page' },
  '/u/:universe/node/:id/review/': { component: 'node-review-page' },
  '/u/:universe/graph/:id/': { component: 'graph-page' },
  '/u/:universe/flows/': { component: 'flows-page' },
  '/u/:universe/flow/:id/': { component: 'flow-page' },
  '/u/:universe/nodes/': { component: 'node-catalog-page' },
  '/u/:universe/matrix/': { component: 'matrix-page' },
  '/u/:universe/pipeline/': { component: 'pipeline-page' },
  '/u/:universe/statemap/': { component: 'statemap-page' },
  '/u/:universe/bugs/': { component: 'bugs-page' },
  '/u/:universe/diff/': { component: 'diff-page' },
  '/u/:universe/prs/': { component: 'pr-inbox-page' },
  '/u/:universe/pr/:pr/': { component: 'pr-story-page' },
  '/u/:universe/search/': { component: 'search-page' },
});
