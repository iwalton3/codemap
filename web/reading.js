/**
 * Reading code under review: the source and diff views with their line numbers, inline
 * finding pins and the line-level form that files one, the sign/view buttons, and the
 * reading order. Shared by the pull request page (`app.js`) and the topic page
 * (`topics.js`), so the two read the same way (review round 2026-10-05, R5b).
 *
 * The views take their HOST component `c`: `c.state.finding` (the open line form),
 * `c.state.raiseErr`, `c.load`, and optionally `c.patchAnnotations` and `c.findingContext`.
 *
 * Imports only `./core.js` and the vendored framework, never a page — see
 * `src/import-cycles.test.ts`.
 */
import { html, when, each, raw } from './vendor/vdx/framework.js';
import { href, isErr } from './core.js';

export const anchorUrl = (u, id) => `/u/${u}/anchor/${id}/`;

export const SEV_COLOR = { low: '#8b95a3', medium: '#58a6ff', high: '#f0a35e', critical: '#f27b7b', complete: '#7ee787', untriaged: '#58a6ff' };

// A sign-off whose witness was hashed by ANOTHER build (an older HASH_SCHEME, a
// different grammar) — there is no comparison to make, so it cannot vouch for the
// code on screen. It stays `reviewed` in the store on purpose: a scheme bump must
// not rewrite what people signed. On the review surfaces it is an outstanding job
// all the same — warning-coloured, counted as unsigned, and stopped at by the
// walkthrough — because the recovery is one click (`unmarkOn`) and a reviewer who
// is never sent there never takes it.
export const isUnverifiable = (info) => !!info && info.state === 'reviewed' && info.via === 'unverifiable';

// Clicking a mark clears it, with two exceptions: an agent `checked` mark upgrades
// to a human sign-off, and an unverifiable one re-signs at the live hash — which is
// what its tooltip has always promised. Clearing it would lose the acceptance
// history for a mark that is not even claimed to be wrong.
export const unmarkOn = (state, actor, via) => state === 'reviewed' && actor !== 'agent' && via !== 'unverifiable';

export const VIA_TIP = { reverted: ' — approved before the code moved BACK to this body on this branch; someone undid work', replayed: ' — approval borrowed from a branch this one does not descend from', unverifiable: ' — the mark stands, but the body it covered was hashed by a different build (an older HASH_SCHEME, or another grammar version), so it CANNOT be compared with the code here. Nothing has drifted; re-sign against this build to make it a live claim again.' };

// attestation: 'viewed' (exposure) | 'signed' (sign-off) | undefined (server → signed).
// `ref` (a PR head sha) witnesses the mark against the code actually on screen —
// without it a PR sign-off records the working tree's hash, i.e. code never read.
/**
 * What a sign-off that skipped some symbols tells the person. The server skips a symbol with
 * no code at the commit being signed NOR where the change left the trunk — a deletion is
 * signable — and reports it as `unwitnessed` rather than recording a mark on nothing.
 * @param {string[] | undefined} ids
 */
export const notSignedNote = (ids) => (ids && ids.length
  ? `${ids.length} symbol${ids.length === 1 ? ' was' : 's were'} not signed: neither the pull request's head nor its base holds the code, so there is nothing to vouch for.`
  : null);

// A small severity dot for dense lists (catalog rows, anchor chips) where a chip is too big.
export const sevDot = (sev) => sev && sev !== 'untriaged' && sev !== 'complete'
  ? html`<span class="sevdot" style="background:${SEV_COLOR[sev] || '#3a4250'}" title="severity: ${sev}"></span>` : html``;

// Shared review/triage renderers so every surface (anchor, node, flow, diff) reads the
// same: `viewed` (blue) + `signed` (green) marks, then the stakes buttons + severity chip.
// A green tick earned three different ways is three different claims, so the mark
// says which. `direct` you approved here; `replayed` you approved this exact body
// on another branch (a stack walk, a rebase) — real, but borrowed; `reverted` the
// code moved BACK to a body you approved before it was superseded on this very
// history, which is someone undoing work and is the one worth interrupting for.
export const VIA_MARK = { replayed: ' ↻', reverted: ' ⟲', unverifiable: ' ?' };

export const whereFrom = (p) => (p ? `${p.branch || (p.commit ? p.commit.slice(0, 7) : 'unknown')}${p.at ? ' · ' + p.at.slice(0, 10) : ''}` : 'unknown');

export const markBtnEl = (attestation, info, onMark, coverLabel) => {
  const st = (info && info.state) || 'unreviewed';
  const actor = info && info.actor;
  const via = info && info.via;
  const agent = st === 'reviewed' && actor === 'agent'; // agent `checked`, not a human vouch
  const on = attestation === 'signed';
  // Earned by signing the symbol that contains this one — the reviewer read these
  // lines inside a larger pane, which is a real mark but not one made about this
  // symbol, so it says so rather than passing for a direct tick.
  const cover = st === 'reviewed' && info && info.coveredBy;
  // A human sign-off is green; an agent-checked vouch (or a viewed mark) is blue.
  const cls = st === 'reviewed'
    ? (via === 'unverifiable' ? 'unverifiable' : via === 'reverted' ? 'reverted' : on && !agent ? 'on' : 'checked')
    : st === 'stale' ? 'stale' : '';
  const mk = st === 'reviewed' ? (VIA_MARK[via] || (cover ? ' ↳' : ' ✓')) : st === 'stale' ? ' ⚠' : '';
  const tip = st !== 'reviewed'
    ? `${attestation}: ${st}${st === 'stale' ? ' — code changed, click to re-approve at the live hash' : ' — click to mark'}`
    : via === 'unverifiable'
      ? `${attestation}: the mark stands, but the body it covered was hashed by a different build — an older HASH_SCHEME, or another grammar version — so it CANNOT be compared with the code here. Nothing has drifted. Click to re-sign against this build.`
    : via === 'reverted'
      ? `${attestation}: this body was approved on ${whereFrom(info.acceptedAt)}, then superseded on this branch by ${whereFrom(info.revertedFrom)} — the code has since moved BACK. Someone undid work; re-read before trusting the tick.`
      : via === 'replayed'
        ? `${attestation}: replayed — you approved this exact body on ${whereFrom(info.acceptedAt)}, which this branch does not descend from. Same code, approval borrowed from there.`
        // `via` first: a borrowed lineage is the louder claim, and it takes the glyph too.
        : cover
          ? `${attestation}: covered — you ${attestation === 'signed' ? 'signed' : 'viewed'} ${coverLabel || 'the symbol that contains this one'}, whose pane shows these lines. Witnessed at this symbol's own hash, so a later edit here stales this mark alone. Click to clear just this one.`
          : `${attestation}: ${st}${agent ? ' (agent-checked — click to confirm as human)' : ' — click to clear'}`;
  return html`<button class="${cls}" title="${tip}" on-click="${(e) => { if (e.stopPropagation) e.stopPropagation(); onMark(attestation, st, actor, via); }}">${attestation}${mk}</button>`;
};

export const reviewRowEl = (review, viewed, onMark, level = 'code', coverLabel) => {
  const sign = review && review[level], view = viewed && viewed[level];
  // Signing is a stronger act than viewing, so a HUMAN sign-off implies you viewed it:
  // once human-signed, drop the now-redundant viewed button. An agent `checked` vouch
  // is not a human sign-off — keep viewed available so the human can still mark/sign.
  const humanSigned = sign && sign.state === 'reviewed' && sign.actor !== 'agent';
  return html`<span class="rev">${when(!humanSigned, () => markBtnEl('viewed', view, onMark, coverLabel))}${markBtnEl('signed', sign, onMark, coverLabel)}${when(sign && (sign.state === 'stale' || isUnverifiable(sign)), () => html`<span class="hint" style="margin-left:6px;color:#f0a35e">⚠ ${isUnverifiable(sign) ? 'sign-off cannot be verified — click to re-sign' : 'sign-off stale'}</span>`)}</span>`;
};

// Editing a finding, and deciding against sending one. Both local: the map moves,
// nothing reaches GitHub until the push button, which is its own act.
export const postRevise = (u, id, patch) =>
  fetch('/api/annotation_revise', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ u, id, by: 'human', ...patch }) });

export const postWithdraw = (u, id, withdraw, reason) =>
  fetch('/api/annotation_withdraw', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ u, id, withdraw, reason, by: 'human' }) });

export const postResolveAnnotation = (u, id, resolved) =>
  fetch('/api/annotation_resolve', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ u, id, resolved }) });

// Line-pinned findings, shared across every code-review surface (review page, flow
// snippets, node segments, file modal). A finding = an anchor note (kind 'note') with
// a line; raising one logs a durable action item and never blocks sign-off. You
// raise one by hovering a code line and clicking 💬 — no line-number input. The one
// open form's key is `c.state.finding` = `anchorId#line`; per-line draft text lives
// in non-reactive `c._fdrafts` (no focus loss with many blocks on a page). Mutations
// reload the host via `c.load.run()` (+ `refreshFile` if the file modal is open).
export const findingKey = (anchorId, line) => anchorId + '#' + (line ?? '');

export const openFindingForm = (c, anchorId, line) => { c.state.finding = findingKey(anchorId, line); };

export const closeFindingForm = (c) => { c.state.finding = null; c.state.raiseErr = null; };

// Review annotations (mirrors the CI review vocab): finding = an issue, pointer = a
// watch-out aid for the reviewer, question = an ask, note = a remark. The ⚑ count is
// action items (findings + questions); pointers/notes render but don't inflate it.
export const ANNO_ICON = { finding: '⚑', pointer: '👁', question: '?', note: '✎' };

export const openFindingCount = (annotations) => (annotations || []).filter(a => !a.resolved && (a.kind === 'finding' || a.kind === 'question')).length;

// Every annotation write reports the anchor it landed on and that anchor's
// annotations afterwards. A host that can update one symbol in place says so by
// implementing `patchAnnotations`, and skips the full reload — on a large pull
// request that reload is seconds of work to learn what became of one finding.
// Hosts without it (the file/anchor views) keep the reload, which is cheap there.
export async function afterAnnotationWrite(c, res) {
  if (res && !res.error && res.target && res.target.kind === 'anchor'
      && c.patchAnnotations && c.patchAnnotations(res.target.id, res.annotations || [])) return;
  await c.load.run();
  if (c.refreshFile && c.state.file) await c.refreshFile();
}

export const asJson = (p) => p.then(r => r.json()).catch(() => null);

/**
 * Raise what you just read, through the same op the agents use.
 *
 * `report_defect` takes a required CONTEXT and no storage, so a person raising something
 * while reading a diff and an agent raising it during a review land in exactly one
 * place. The context comes from where you are standing, which is the one thing the page
 * knows and the caller should not have to state:
 *
 *   on a pull request  -> a FINDING on that pull request
 *   anywhere else      -> a DRIVE-BY, which becomes a bug and outlives the branch
 *
 * The button says which, so nobody is surprised by where it went.
 */
export async function raiseFinding(c, u, anchorId, line) {
  const key = findingKey(anchorId, line);
  const text = (c._fdrafts?.[key] || '').trim(); if (!text) return;
  const pr = c.props && c.props.params && c.props.params.pr;
  // A host that is a review of its own (a topic walk) names its context; the PR page's is its number.
  const ctx = c.findingContext ? c.findingContext() : pr ? { kind: 'pull_request', pr: String(pr) } : null;
  // What you type here IS the submitter-facing version: a finding raised in one line
  // while reading a diff is already the short form. The evidence half only diverges
  // once someone investigates, and it is editable in the findings list when it does.
  const body = ctx
    ? { u, context: ctx, targetKind: 'anchor', targetId: anchorId,
        text, comment: text, ...(Number.isFinite(line) ? { line } : {}), ...(pr ? { ref: c.state?.prRef } : {}) }
    : { u, context: { kind: 'drive_by', rationale: 'raised while reading this symbol' },
        title: text.split('\n')[0].slice(0, 120), text, anchors: [anchorId] };
  const res = await asJson(fetch('/api/defect', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  }));
  // A refusal must not take the typed text with it. Both of them (over-length, and
  // an opening that grades the finding instead of describing the code) are asking
  // for a rewrite of what is in the box — which is hard to do once the box is empty.
  if (res && res.error) { c.state.raiseErr = { key, error: res.error }; return; }
  c.state.raiseErr = null;
  if (c._fdrafts) c._fdrafts[key] = '';
  c.state.finding = null;
  await afterAnnotationWrite(c, res);
}

export async function toggleFinding(c, u, id, resolved) { await afterAnnotationWrite(c, await asJson(postResolveAnnotation(u, id, resolved))); }

export const postAssign = (u, id, kind) =>
  fetch('/api/annotation_assign', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ u, id, kind, by: 'me' }) });

export async function assignFinding(c, u, id, kind) { await afterAnnotationWrite(c, await asJson(postAssign(u, id, kind))); }

export async function reviseFinding(c, u, id, patch) {
  const res = await asJson(postRevise(u, id, patch));
  if (res && res.error) { c.state.findingErr = { id, error: res.error }; return; }
  c.state.findingErr = null;
  await afterAnnotationWrite(c, res);
}

export async function withdrawFinding(c, u, id, withdraw, reason) { await afterAnnotationWrite(c, await asJson(postWithdraw(u, id, withdraw, reason))); }

// Raising an agent's finding to the maintainer. Local only — it makes the finding
// PUBLISHABLE; nothing reaches GitHub until the push button, which is its own act.
export const postEscalate = (u, id, escalate) =>
  fetch('/api/annotation_escalate', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ u, id, escalate, by: 'human' }) });

export async function escalateFinding(c, u, id, escalate) { await afterAnnotationWrite(c, await asJson(postEscalate(u, id, escalate))); }

export const isAgentFinding = (f) => (f.author || 'agent').startsWith('agent');

// A finding, plus the two halves of the agent loop: hand it over, and read what
// came back. The agent reports; resolving stays the human's act, so an agent can
// never mark its own work accepted.
export const OUTCOME_ICON = { fixed: '✔', answered: '💬', declined: '⊘' };

/**
 * Somebody ELSE's note, pinned to the code. Read-only by construction.
 *
 * A `pointer` is a review aid — "watch out for X when reading this block" — and its
 * value is being here, at the line, while you read the diff. It used to render only if
 * this machine wrote it. Deliberately not a `findingItemEl`: that offers assign,
 * escalate and resolve, and a fold-owned note is not locally mutable, so those buttons
 * would be writes that cannot land. `shared_notes` on the anchor is where you answer one.
 */
/**
 * A FINDING, pinned to the line it is about.
 *
 * Findings reached this page only through a collapsed panel, while local annotations
 * rendered inline — so raising one from the diff (the ✎ button calls `report_defect`,
 * which files a canonical finding) put nothing at the line it was typed at and read as
 * a no-op. Its own store had replaced the one with the good surface.
 *
 * `resolve` / `reopen` are here because a closed finding had no way back from any
 * shared surface: the op allows a person to move it anywhere, and only the UI was
 * missing. Everything richer — corroboration, asks, the thread — stays on the findings
 * panel and the shared view; this is the reading position, not the triage position.
 */
export const findingPinEl = (c, u, f) => {
  const closed = f.state === 'resolved' || f.state === 'refuted' || f.state === 'invalid' || f.state === 'withdrawn';
  return html`<div class="rvfind k-finding ${closed ? 'resolved' : ''}">
    <span class="rvfpin" title="finding${f.line ? ' · line ' + f.line : ''}">⚑${f.line ? ' ' + f.line : ''}</span>
    ${when(f.severity, () => html`<span class="rvfsev" style="background:${SEV_COLOR[f.severity] || '#3a4250'}" title="severity: ${f.severity}"></span>`)}
    ${when(f.category, () => html`<span class="rvfcat">${f.category}</span>`)}
    <span class="rvftext">${f.text}</span>
    <span class="rvfacts">
      <span class="dim rvfauthor">${f.by}${f.shared ? ' · team' : ''}</span>
      ${when(!!REMEDIATION_LABEL_APP[f.remediation], () => html`<span class="prbadge ok" title="${REMEDIATION_LABEL_APP[f.remediation][1]}">${REMEDIATION_LABEL_APP[f.remediation][0]}</span>`)}
      ${when(!!f.pending, () => html`<span class="prbadge ask" title="${f.pending.by} asked for this — ${f.pending.rationale}">${PENDING_LABEL_APP[f.pending.ask] || f.pending.ask} pending</span>`)}
      ${when(closed && !!f.closedReason, () => html`<span class="dim" title="${f.closedReason}">closed</span>`)}
      <button class="annores" on-click="${(e) => { if (e.stopPropagation) e.stopPropagation(); setFindingState(c, u, f.id, closed ? 'created' : 'resolved'); }}">${closed ? 'reopen' : 'resolve'}</button>
    </span>
  </div>`;
};

/** Shared with `shared.js`; duplicated rather than imported — these are separate bundles. */
export const REMEDIATION_LABEL_APP = {
  'fixed-on-branch': ['fixed on branch', 'verified fixed here — the mainline may still carry it'],
  'fixed-on-default': ['fixed on main', 'fixed on the default branch'],
  'deferred': ['deferred', 'real, and deliberately not being fixed now'],
  'wont-fix': ["won't fix", 'real, and a decision was taken not to fix it'],
};

export const PENDING_LABEL_APP = { refute: 'refuted', resolve: 'fixed', invalidate: 'invalid', withdraw: 'withdrawn', promote: 'promotion' };

/**
 * Move a finding's state, and refresh whatever is showing it.
 *
 * The action is the PATH — `serve.ts` reads it off the URL and has no `act` case, so
 * this posted to a route that answered `unknown shared action "act"` for as long as it
 * existed. Resolve and reopen on the diff page have therefore never worked. Guarded now
 * by `api-map.test.ts`, which scans these strings against the server's own switch.
 */
export async function setFindingState(c, u, id, state) {
  const res = await asJson(fetch('/api/shared/close', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ u, id, state, reason: state === 'created' ? 'reopened from the diff' : 'resolved from the diff' }),
  }));
  if (res && res.error) { c.state.raiseErr = { key: id, error: res.error }; return; }
  await c.load.run();
}

export const teamNoteEl = (n) => html`<div class="rvfind rvteam k-${n.kind} ${n.resolved ? 'resolved' : ''}">
  <span class="rvfpin" title="${n.kind} · ${n.by}${n.line ? ' · line ' + n.line : ''}">${ANNO_ICON[n.kind] || '✎'}${n.line ? ' ' + n.line : ''}</span>
  ${when(n.severity, () => html`<span class="rvfsev" style="background:${SEV_COLOR[n.severity] || '#3a4250'}" title="severity: ${n.severity}"></span>`)}
  ${when(n.category, () => html`<span class="rvfcat">${n.category}</span>`)}
  <span class="rvftext">${n.text}</span>
  <span class="rvfacts">
    <span class="dim rvfauthor" title="the team's — answer it with shared_notes on this symbol">${n.by}</span>
    ${when(n.resolved, () => html`<span class="prbadge ok">resolved</span>`)}
  </span>
</div>`;

export const findingItemEl = (c, u, f) => {
  const k = f.kind || 'note';
  const a = f.assignment, o = f.outcome;
  return html`<div class="rvfind k-${k} ${f.resolved ? 'resolved' : ''}">
    <span class="rvfpin" title="${k}${f.line ? ' · line ' + f.line : ''}">${ANNO_ICON[k] || '✎'}${f.line ? ' ' + f.line : ''}</span>
    ${when(f.severity, () => html`<span class="rvfsev" style="background:${SEV_COLOR[f.severity] || '#3a4250'}" title="severity: ${f.severity}"></span>`)}
    ${when(f.category, () => html`<span class="rvfcat">${f.category}</span>`)}
    <span class="rvftext">${f.text}</span>
    <span class="rvfacts">
      <span class="dim rvfauthor">${f.author || 'agent'}</span>
      ${when(a && !o, () => html`<span class="asgn pending" title="handed to an agent ${a.at ? 'on ' + a.at.slice(0, 10) : ''} — waiting">→ agent: ${a.kind}…</span>`)}
      ${when(o, () => html`<span class="asgn done r-${o.result}" title="${o.detail}${o.files && o.files.length ? '\n\nfiles: ' + o.files.join(', ') : ''}">${OUTCOME_ICON[o.result] || '·'} ${o.result}</span>`)}
      ${when(!f.resolved && !a, () => html`<span class="asgnacts">
        <button title="ask an agent to work out whether this is real and report back" on-click="${(e) => { if (e.stopPropagation) e.stopPropagation(); assignFinding(c, u, f.id, 'investigate'); }}">→ look into</button>
        <button title="ask an agent to fix it. One file only — anything wider comes back declined with what it would take, to be handed to a real agent instead." on-click="${(e) => { if (e.stopPropagation) e.stopPropagation(); assignFinding(c, u, f.id, 'fix'); }}">→ fix</button>
      </span>`)}
      ${when(!f.resolved && isAgentFinding(f), () => html`<button class="rvfraise ${f.escalated ? 'on' : ''}" title="${f.escalated ? 'raised to the maintainer — it will go out with the next push (click to take it back)' : 'raise to the maintainer: an agent proposed this, and publishing it posts under YOUR account. Nothing is sent until you push.'}" on-click="${(e) => { if (e.stopPropagation) e.stopPropagation(); escalateFinding(c, u, f.id, !f.escalated); }}">${f.escalated ? '▲ raised' : '▲ raise'}</button>`)}
      ${when(!f.resolved && !isAgentFinding(f), () => html`<span class="rvfraise mine" title="you wrote this one — it goes out with the next push">▲ yours</span>`)}
      <button class="annores" on-click="${(e) => { if (e.stopPropagation) e.stopPropagation(); toggleFinding(c, u, f.id, !f.resolved); }}">${f.resolved ? 'reopen' : 'resolve'}</button>
    </span>
    ${when(o, () => html`<div class="asgndetail">${o.detail}${when(o.files && o.files.length, () => html` <span class="dim">— ${o.files.join(', ')}</span>`)}</div>`)}
  </div>`;
};

export const findingForm = (c, u, anchorId, line) => {
  if (!c._fdrafts) c._fdrafts = {};
  const key = findingKey(anchorId, line);
  const err = c.state.raiseErr && c.state.raiseErr.key === key ? c.state.raiseErr.error : null;
  return html`<div class="rvaddf"><span class="rvfpin">${line ? '↳' + line : '✎'}</span><input class="rvftextin" placeholder="finding / action item — sign-off still allowed" value="${c._fdrafts[key] || ''}" on-input="${(e) => { c._fdrafts[key] = e.target.value; }}" on-keydown="${(e) => { if (e.key === 'Enter') raiseFinding(c, u, anchorId, line); else if (e.key === 'Escape') closeFindingForm(c); }}"><button title="${c.findingContext ? 'files a finding on this review' : c.props && c.props.params && c.props.params.pr ? 'files a finding on this pull request' : 'files a bug — you are not in a pull request review, so this outlives the branch'}" on-click="${() => raiseFinding(c, u, anchorId, line)}">${c.findingContext || (c.props && c.props.params && c.props.params.pr) ? 'raise' : 'file as bug'}</button><button class="ghost" on-click="${() => closeFindingForm(c)}">cancel</button>${when(err, () => html`<span class="rvferr">${err}</span>`)}</div>`;
};

/**
 * Group a symbol's team notes the way the local ones are grouped: by pinned line, with
 * the unpinned ones collected for the block below the code.
 *
 * @returns {[Map<number, any[]>, any[]]}
 */
export function pinTeamNotes(shared) {
  const byLine = new Map(); const noLine = [];
  for (const n of (shared || [])) { if (n.line) { (byLine.get(n.line) || byLine.set(n.line, []).get(n.line)).push(n); } else noLine.push(n); }
  return [byLine, noLine];
}

// Render one anchor's source line-by-line (absolute line numbers from `startLine`)
// with a hover 💬 per line that raises a finding pinned to that exact line; existing
// findings render inline under their line, unlocated notes below. The `annotations`
// this reads are refreshed either by `c.load.run()` or, where the host implements
// it, by `c.patchAnnotations` updating just this anchor (see afterAnnotationWrite).
export function codeReviewLines(c, u, anchorId, code, lang, startLine, annotations, shared, findings) {
  if (code == null) return html`<pre class="code rvcode">(source unavailable — anchor renamed/removed?)</pre>`;
  const base = startLine || 1;
  const byLine = new Map(); const noLine = [];
  for (const a of (annotations || [])) { if (a.line) { (byLine.get(a.line) || byLine.set(a.line, []).get(a.line)).push(a); } else noLine.push(a); }
  const [teamByLine, teamNoLine] = pinTeamNotes(shared);
  const [findByLine, findNoLine] = pinTeamNotes(findings);
  const lines = highlightLines(code, lang);
  return html`<div class="rvpre hljs">
    ${each(lines, (lineHtml, i) => {
      const n = base + i;
      const finds = byLine.get(n) || [];
      return html`<div class="flrow">
        <div class="fline"><span class="flno">${n}</span><span class="fltext">${raw(lineHtml)}</span><button class="flcomment" title="raise a finding on line ${n}" on-click="${() => openFindingForm(c, anchorId, n)}">💬</button></div>
        ${each(finds, f => findingItemEl(c, u, f), f => f.id)}
        ${each(findByLine.get(n) || [], f => findingPinEl(c, u, f), f => f.id)}
        ${each(teamByLine.get(n) || [], t => teamNoteEl(t), t => t.id)}
        ${when(c.state.finding === findingKey(anchorId, n), () => findingForm(c, u, anchorId, n))}
      </div>`;
    }, (lineHtml, i) => i)}
    ${when(noLine.length || teamNoLine.length || findNoLine.length, () => html`<div class="rvfinds">${each(noLine, f => findingItemEl(c, u, f), f => f.id)}${each(findNoLine, f => findingPinEl(c, u, f), f => f.id)}${each(teamNoLine, t => teamNoteEl(t), t => t.id)}</div>`)}
  </div>`;
}

export const highlight = (code, lang) => {
  if (window.hljs && lang && lang !== 'plaintext') { try { return window.hljs.highlight(code, { language: lang, ignoreIllegals: true }).value; } catch {} }
  return String(code).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
};

// Highlight a whole block, then slice into per-line HTML. hljs lexes multi-line
// constructs (block/`/** */` doc comments, verbatim & interpolated strings) as a
// unit; highlighting a line in isolation loses that context, so an apostrophe in
// a comment opens a phantom string and swallows the rest of the line (incl. XML
// `<summary>` tags). We highlight once with full context, then re-open any spans
// still open at each newline so every line stays independently well-formed.
export const highlightLines = (code, lang) => {
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
export const diffCodeRows = (lines, lang) => {
  const baseHL = highlightLines(lines.filter(l => l.tag !== '+').map(l => l.text).join('\n'), lang);
  const headHL = highlightLines(lines.filter(l => l.tag !== '-').map(l => l.text).join('\n'), lang);
  let bi = 0, hi = 0;
  return lines.map(l => {
    const html = l.tag === '-' ? baseHL[bi++] : l.tag === '+' ? headHL[hi++] : (bi++, headHL[hi++]);
    return { tag: l.tag, html };
  });
};

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
export function diffReviewLines(c, u, anchorId, lines, lang, startLine, annotations, shared, findings) {
  if (!lines || !lines.length) return html`<pre class="code rvcode">(no diff available)</pre>`;
  const byLine = new Map(); const noLine = [];
  for (const a of (annotations || [])) { if (a.line) { (byLine.get(a.line) || byLine.set(a.line, []).get(a.line)).push(a); } else noLine.push(a); }
  const [teamByLine, teamNoLine] = pinTeamNotes(shared);
  const [findByLine, findNoLine] = pinTeamNotes(findings);
  let head = (startLine || 1) - 1;
  // Highlight through `diffCodeRows`, which reconstructs each SIDE and highlights it
  // as one block. Lexing a line on its own loses the multi-line context that a block
  // comment, an XML doc comment or a verbatim string needs, so those re-lexed as
  // code — the +/- column this used to blame for it is exactly what diffCodeRows
  // already strips.
  const hl = diffCodeRows(lines, lang);
  const rows = lines.map((l, i) => {
    const n = l.tag === '-' ? null : ++head;
    return { tag: l.tag, text: l.text, html: hl[i] ? hl[i].html : null, n };
  });
  return html`<div class="rvpre hljs prdiff">
    ${each(rows, (r, i) => {
      const finds = r.n ? (byLine.get(r.n) || []) : [];
      return html`<div class="flrow">
        <div class="dline ${r.tag === '+' ? 'add' : r.tag === '-' ? 'del' : ''}">
          <span class="dsign">${r.tag}</span>
          <span class="flno">${r.n ?? ''}</span>
          <span class="fltext">${raw(r.html != null ? r.html : highlight(r.text, lang))}</span>
          ${when(r.n, () => html`<button class="flcomment" title="raise a finding on line ${r.n}" on-click="${() => openFindingForm(c, anchorId, r.n)}">💬</button>`)}
        </div>
        ${each(finds, f => findingItemEl(c, u, f), f => f.id)}
        ${each(r.n ? (findByLine.get(r.n) || []) : [], f => findingPinEl(c, u, f), f => f.id)}
        ${each(r.n ? (teamByLine.get(r.n) || []) : [], t => teamNoteEl(t), t => t.id)}
        ${when(r.n && c.state.finding === findingKey(anchorId, r.n), () => findingForm(c, u, anchorId, r.n))}
      </div>`;
    }, (r, i) => i)}
    ${when(noLine.length || teamNoLine.length || findNoLine.length, () => html`<div class="rvfinds">${each(noLine, f => findingItemEl(c, u, f), f => f.id)}${each(findNoLine, f => findingPinEl(c, u, f), f => f.id)}${each(teamNoLine, t => teamNoteEl(t), t => t.id)}</div>`)}
  </div>`;
}

// Put a symbol on screen after signing the previous one, moving as little as
// possible: the reviewer's eye is already somewhere on the page, so a jump they
// did not ask for costs more attention than a short scroll saves. Three cases —
// it already fits (do nothing), it fits but hangs off an edge (nudge just enough),
// or it is taller than the viewport, where the top is what matters and the
// walkthrough prose introducing it is worth keeping in frame if it can be.
export const REVEAL_PAD = 10;          // breathing room under the sticky header

export const REVEAL_MIN_READ = 160;    // enough of a too-tall symbol to start reading it

export function revealStep(anchorId) {
  const el = document.getElementById(`step-${anchorId}`);
  if (!el) return;
  const hdr = document.querySelector('header');
  const top = hdr ? hdr.getBoundingClientRect().bottom : 0;
  const viewH = window.innerHeight - top;
  const r = el.getBoundingClientRect();
  const to = (y) => window.scrollTo({ top: Math.max(0, window.scrollY + y), behavior: 'smooth' });

  if (r.height <= viewH - REVEAL_PAD) {
    if (r.top >= top && r.bottom <= window.innerHeight) return;              // already whole on screen
    if (r.bottom > window.innerHeight)                                       // hanging off the bottom
      return to(Math.min(r.bottom - window.innerHeight + REVEAL_PAD, r.top - top - REVEAL_PAD));
    return to(r.top - top - REVEAL_PAD);                                     // tucked under the header
  }

  // Too tall to frame. Align the prose block that introduces it instead, when the
  // pair still leaves a readable slice of the symbol below it.
  // Any preceding block that is not itself a symbol: walkthrough prose, a chapter's
  // spec section, the placeholder for a symbol that left the PR.
  const prev = el.previousElementSibling;
  const prose = prev && !prev.classList.contains('prstep') ? prev.getBoundingClientRect() : null;
  const anchorTop = prose && (r.top - prose.top) + REVEAL_MIN_READ <= viewH ? prose.top : r.top;
  if (anchorTop >= top && r.top <= window.innerHeight - REVEAL_MIN_READ) return;
  to(anchorTop - top - REVEAL_PAD);
}

export const UNCOVERED_ID = '__uncovered';   // the catch-all section, keyed like a chapter

/**
 * Every symbol in the order the PAGE renders it. A walkthrough regroups the derived
 * chapters into features and re-orders them, so advancing along `story.chapters`
 * sent the reviewer to a symbol nowhere near the one they had just signed — a
 * different chapter of a different feature.
 */
export function readingOrder(story, steps) {
  const flat = [];
  if (!story) return flat;
  if (story.walkthrough) {
    for (const f of story.walkthrough.features || [])
      for (const c of f.chapters || [])
        for (const b of c.blocks || [])
          if (b.kind === 'symbol' && steps.get(b.anchorId)) flat.push({ chapter: c, step: steps.get(b.anchorId) });
    // The unaccounted-for symbols render last and are still work to do.
    const cov = (story.walkthrough.coverage && story.walkthrough.coverage.uncovered) || [];
    for (const id of cov) if (steps.get(id)) flat.push({ chapter: { id: UNCOVERED_ID }, step: steps.get(id) });
    return flat;
  }
  for (const c of story.chapters || []) for (const step of c.steps) flat.push({ chapter: c, step });
  return flat;
}

export const CHANGE_COLOR = { added: '#7ee787', changed: '#f0a35e', removed: '#f85149' };

export const LAYER_NAME = ['command', 'handler', 'event', 'aggregate', 'read-model', 'job'];

// --- a walkthrough, read --------------------------------------------------------
// The PR page and the topic page render a walkthrough through these, over a HOST that
// supplies: `state.code` / `state.pending` / `state.showDiff` / `state.open` /
// `state.chapterBusy` keyed by anchor or chapter id, and `stepsByAnchor()`, `stepSigned(step)`,
// `coverLabel(step)`, `openStep(step)`, `markStep(step, attestation, state, actor, via)`,
// `toggleChapter(id)`, `markChapter(id, attestation, unmark)`. Optional: `membersOf(id)`, the
// steps a cited container covers, rendered under it (a topic's class covers its members).

/** Whether a step's open pane shows the diff rather than the whole source. */
export function showsDiff(c, step) {
  const code = /** @type {any} */ (c.state.code[step.anchorId]);
  if (!code || typeof code.error === 'string' || !code.lines || !code.lines.length) return false;
  const override = c.state.showDiff[step.anchorId];
  return override === undefined ? step.change === 'changed' : !!override;
}

// A removed symbol's source is the body the change DELETES — `head` is null for it.
// Falling through to `head` rendered "(source unavailable)" over a step that
// still carried a sign-off button, i.e. an attestation to code never shown.
export function sourceOf(code) {
  return code.head != null
    ? { text: code.head, startLine: code.startLine }
    : { text: code.base, startLine: code.baseStartLine };
}

export function stepView(c, u, step) {
  const held = c.state.code[step.anchorId];
  // One narrowed binding, rather than the same union unpicked at each of the
  // fourteen reads below.
  const code = isErr(held) ? null : held;
  const finds = openFindingCount(step.annotations);
  const src = code ? sourceOf(code) : null;
  return html`<div class="prstep ${c.stepSigned(step) ? 'done' : ''}" id="step-${step.anchorId}">
    <div class="prsthead" on-click="${() => c.openStep(step)}">
      <span class="prlayer" title="position on the command → read-model spine">${LAYER_NAME[step.layer] || step.kind || 'code'}</span>
      ${when(!!step.change, () => html`<span class="prchg" style="color:${CHANGE_COLOR[step.change] || '#8b949e'}">${step.change}</span>`)}
      ${sevDot(step.severity)}
      <code class="prsig">${step.signature || step.symbol}</code>
      <span class="dim prfile">${step.file.split('/').pop()}</span>
      ${when(finds, () => html`<span class="prfind" title="${finds} open finding(s)">⚑${finds}</span>`)}
      ${when(!!step.moved, () => html`<span class="warn" title="main's tip has changed this symbol since this walkthrough's commit">code moved on main</span>`)}
      <span class="prrev" on-click="${(e) => { if (e.stopPropagation) e.stopPropagation(); }}">${reviewRowEl({ code: step.review || { state: step.reviewed ? 'reviewed' : 'unreviewed' } }, { code: step.viewedMark || { state: step.viewed ? 'reviewed' : 'unreviewed' } }, (att, st, actor, via) => c.markStep(step, att, st, actor, via), 'code', c.coverLabel(step))}</span>
    </div>
    ${when(c.state.pending[step.anchorId], () => html`<div class="dim prload">loading source…</div>`)}
    ${when(!!code, () => html`<div class="prsbody">
      <div class="prstools">
        <span class="dim">${code.file}</span>
        ${when(src && src.text != null && code.lines && code.lines.length, () => html`<button class="ghost" on-click="${() => { c.state.showDiff = { ...c.state.showDiff, [step.anchorId]: !showsDiff(c, step) }; }}">${showsDiff(c, step) ? 'show full source' : 'show diff'}</button>`)}
        ${when(code.lineEndingsChanged, () => html`<span class="crlf" title="one side uses CRLF and the other LF. The diff below is normalised so a line-ending flip does not read as a full rewrite — but the change is real and will show in the file diff on GitHub.">⚠ line endings changed</span>`)}
        <a class="viewlink" title="open the full anchor page" href="${href(anchorUrl(u, step.anchorId))}">↗</a>
      </div>
      ${when(showsDiff(c, step),
        () => diffReviewLines(c, u, step.anchorId, code.lines, code.lang, code.startLine, code.annotations, code.sharedNotes, step.findings),
        () => codeReviewLines(c, u, step.anchorId, src.text, code.lang, src.startLine, code.annotations, code.sharedNotes, step.findings))}
    </div>`)}
    ${when(isErr(held), () => html`<div class="prsbody dim">${isErr(held) ? held.error : ''}</div>`)}
  </div>`;
}

function walkBlockView(c, u, block, steps, missingTip) {
  if (block.kind === 'prose') return html`<div class="wkprose"><md-content text="${block.text}" untrusted="${true}"></md-content></div>`;
  const step = steps.get(block.anchorId);
  if (!step) return html`<div class="wkprose warn">${missingTip(block.anchorId)}</div>`;
  const members = c.membersOf ? c.membersOf(block.anchorId) : [];
  if (!members.length) return stepView(c, u, step);
  return html`${stepView(c, u, step)}<div class="wkmembers" title="covered by ${step.symbol}: signing it signs these">${each(members, (m) => stepView(c, u, m), (m) => m.anchorId)}</div>`;
}

/** Every symbol a chapter accounts for: the ones it cites, and what its cited containers cover. */
const chapterSteps = (c, ch, steps) => {
  const cited = ch.blocks.filter((b) => b.kind === 'symbol').map((b) => steps.get(b.anchorId)).filter(Boolean);
  return [...cited, ...(c.membersOf ? cited.flatMap((s) => c.membersOf(s.anchorId)) : [])];
};

export function walkChapterView(c, u, ch, steps, stale, movedOnMain, tips) {
  const mine = chapterSteps(c, ch, steps);
  const signed = mine.filter((s) => c.stepSigned(s)).length;
  const viewed = mine.filter((s) => s.viewed).length;
  const busy = !!c.state.chapterBusy[ch.id];
  const open = c.state.open[ch.id] !== false;          // chapters start open — this is the reading order
  return html`<section class="prchapter wkchapter ${stale ? 'stale' : ''}">
    <div class="prchead" on-click="${() => c.toggleChapter(ch.id)}">
      <span class="prtwisty">${open ? '▾' : '▸'}</span>
      <b>${ch.title}</b>
      <span class="dim">${signed}/${mine.length} signed${viewed ? ` · ${viewed} viewed` : ''}</span>
      ${when(stale, () => html`<span class="warn" title="the code this chapter walks has changed since it was written — it needs re-walking">stale</span>`)}
      ${when(movedOnMain, () => html`<span class="warn" title="${tips.moved}">code moved on main</span>`)}
      <span class="wkacts" on-click="${(e) => { if (e.stopPropagation) e.stopPropagation(); }}">
        <button disabled="${busy}" title="mark every symbol in this chapter viewed — a shortcut, the same per-symbol marks underneath" on-click="${() => c.markChapter(ch.id, 'viewed', viewed === mine.length)}">${viewed === mine.length && mine.length ? 'unview all' : 'view all'}</button>
        <button class="on" disabled="${busy}" title="sign off every symbol in this chapter" on-click="${() => c.markChapter(ch.id, 'signed', signed === mine.length)}">${signed === mine.length && mine.length ? 'unsign all' : 'sign all'}</button>
      </span>
    </div>
    ${when(open, () => html`<div class="prcbody">${each(ch.blocks, (b, i) => walkBlockView(c, u, b, steps, tips.missing), (b, i) => b.kind === 'symbol' ? 's' + b.anchorId : 'p' + i)}</div>`)}
  </section>`;
}

/**
 * The features, their chapters, and what the walkthrough leaves unaccounted for.
 * `opts.stale` / `opts.moved` are chapter-id sets; `opts.uncovered` anchor ids; `opts.tips` the
 * host's own words for what moved, what is unstated, what is unaccounted for and what went missing.
 */
export function walkFeaturesView(c, u, w, opts) {
  const steps = c.stepsByAnchor();
  const uncovered = opts.uncovered || [];
  return html`
    ${each(w.features, f => html`<section class="wkfeature">
      <div class="wkfhead">
        <b>${f.title}</b>
        ${when(f.unstated, () => html`<span class="wkunstated" title="${opts.tips.unstated}">not in the spec</span>`)}
        <span class="dim">${f.chapters.length} chapter(s)</span>
      </div>
      <div class="wkfsummary"><md-content text="${f.summary}" untrusted="${true}"></md-content></div>
      ${each(f.chapters, ch => walkChapterView(c, u, ch, steps, opts.stale.has(ch.id), opts.moved.has(ch.id), opts.tips), ch => ch.id)}
    </section>`, f => f.id)}
    ${when(uncovered.length, () => html`<section class="prchapter wkuncovered">
      <div class="prchead" on-click="${() => c.toggleChapter(UNCOVERED_ID)}">
        <span class="prtwisty">${c.state.open[UNCOVERED_ID] ? '▾' : '▸'}</span>
        <b>Not in the walkthrough</b>
        <span class="dim">${uncovered.length} symbol(s)</span>
        <span class="warn" title="${opts.tips.uncovered}">unaccounted for</span>
      </div>
      ${when(c.state.open[UNCOVERED_ID], () => html`<div class="prcbody">${each(uncovered.filter(id => steps.get(id)), id => stepView(c, u, steps.get(id)), id => id)}</div>`)}
    </section>`)}`;
}
