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
import { defineComponent, Component, html, when, each, Store, raw, watch } from './vendor/vdx/framework.js';
import { enableRouting } from './vendor/vdx/router.js';
// Split-out pages, imported for their `defineComponent` side effects so the route
// table at the bottom can name them.
//
// STATIC, and it must stay static. `await import()` here deadlocks silently:
// shared.js imports this module back, so a top-level await makes each wait for the
// other and app.js never finishes evaluating — no error, no console output, an
// entirely blank page. A static circular import is fine because shared.js only
// touches this module's exports inside method bodies, never at evaluation time.
import './shared.js';

/**
 * A caught value is `unknown`, and a thrown non-Error has no `.message` — which
 * reads as the literal string "undefined" in the banner the user sees.
 * @param {unknown} e
 */
export const errText = (e) => (e instanceof Error ? e.message : String(e));

/**
 * Which node did this event land on? `e.target` is an `EventTarget`, which has no
 * `closest` — and on a graph it is whatever child shape was under the cursor, so
 * every hit test has to walk up to the node group.
 * @param {Event} e
 * @param {string} sel
 * @returns {Element|null}
 */
export const hitTarget = (e, sel) => (e.target instanceof Element ? e.target.closest(sel) : null);

/** POST + JSON, for requests whose payload does not belong in a URL. */
export async function apiPost(path, body) {
  const r = await fetch(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  if (!r.ok) throw new Error('HTTP ' + r.status);
  return r.json();
}
/**
 * What each GET route actually returns, taken from the ops functions THEMSELVES.
 *
 * `serve.ts` returns these values verbatim, so this is the real contract rather
 * than a description of one — a field ops stops returning becomes a typecheck
 * failure at the page that reads it, instead of a panel that renders nothing and
 * says nothing. `api()` is generic over this map, so every call site is typed
 * without a single per-page annotation.
 *
 * It is derived from `serve.ts` and can drift from it; `src/api-map.test.ts`
 * fails when it does, which is the only reason it is safe to keep by hand.
 *
 * @typedef {import('../dist/ops.js')} Ops
 * @typedef {import('../dist/multi.js')} Multi
 * @typedef {import('../dist/ops-shared.js')} Shared
 *
 * @typedef {{
 *   '/api/universes':           Awaited<ReturnType<Multi['listUniverses']>>,
 *   '/api/guide':               { methodology: string },
 *   '/api/dashboard':           Awaited<ReturnType<Ops['dashboard']>>,
 *   '/api/outline':             Awaited<ReturnType<Ops['outline']>>,
 *   '/api/anchor':              Awaited<ReturnType<Ops['getAnchor']>>,
 *   '/api/node':                Awaited<ReturnType<Multi['getNodeEnriched']>>,
 *   '/api/neighborhood':        Awaited<ReturnType<Ops['neighborhood']>>,
 *   '/api/subgraph':            Awaited<ReturnType<Ops['subgraph']>>,
 *   '/api/nodes':               Awaited<ReturnType<Ops['nodeCatalog']>>,
 *   '/api/node_versions':       Awaited<ReturnType<Ops['nodeVersions']>>,
 *   '/api/node_review':         Awaited<ReturnType<Ops['nodeReview']>>,
 *   '/api/file':                Awaited<ReturnType<Ops['fileSource']>>,
 *   '/api/matrix':              Awaited<ReturnType<Ops['eventMatrix']>>,
 *   '/api/pipeline':            Awaited<ReturnType<Ops['pipelineGraph']>>,
 *   '/api/statemap':            Awaited<ReturnType<Ops['stateMap']>>,
 *   '/api/flows':               Awaited<ReturnType<Ops['flows']>>,
 *   '/api/flow':                Awaited<ReturnType<Ops['flow']>>,
 *   '/api/search':              Awaited<ReturnType<Multi['searchAll']> | ReturnType<Ops['search']>>,
 *   '/api/gaps':                Awaited<ReturnType<Ops['findGaps']>>,
 *   '/api/context':             Awaited<ReturnType<Ops['context']>>,
 *   '/api/lint':                Awaited<ReturnType<Ops['lintSummaries']>>,
 *   '/api/bugs':                Awaited<ReturnType<Ops['listBugs']>>,
 *   '/api/bug':                 Awaited<ReturnType<Ops['bugDetail']>>,
 *   '/api/queue':               Awaited<ReturnType<Ops['reviewQueue']>>,
 *   '/api/orphans':             Awaited<ReturnType<Ops['orphanedWork']>>,
 *   '/api/questions':           Awaited<ReturnType<Ops['listQuestions']>>,
 *   '/api/stale':               Awaited<ReturnType<Ops['checkStale']>>,
 *   '/api/index-state':         Awaited<ReturnType<Ops['indexFreshness']>>,
 *   '/api/snapshots':           Awaited<ReturnType<Ops['snapshots']>>,
 *   '/api/diff':                Awaited<ReturnType<Ops['diff']>>,
 *   '/api/diff/code':           Awaited<ReturnType<Ops['diffCode']>>,
 *   '/api/diff/doc':            Awaited<ReturnType<Ops['docDiff']>>,
 *   '/api/pr':                  Awaited<ReturnType<Ops['pr']>>,
 *   '/api/pr/story':            Awaited<ReturnType<Ops['prStoryFor']>>,
 *   '/api/pr/findings':         Awaited<ReturnType<Ops['prOffStoryFindings']>>,
 *   '/api/pr/promote_plan':     Awaited<ReturnType<Ops['prPromotePlan']>>,
 *   '/api/pr/push_plan':        Awaited<ReturnType<Ops['prPushPlan']>>,
 *   '/api/shared':              Awaited<ReturnType<Shared['sharedFindings']>>,
 *   '/api/shared/peers':        Awaited<ReturnType<Shared['sharedStatus']>>,
 *   '/api/shared/hub':          Awaited<ReturnType<Shared['sharedHub']>>,
 *   '/api/shared/triage':       Awaited<ReturnType<Shared['sharedTriage']>>,
 *   '/api/shared/contested':    Awaited<ReturnType<Shared['contestedTriage']>>,
 *   '/api/shared/graph':        Awaited<ReturnType<Shared['sharedGraph']>>,
 *   '/api/shared/walkthroughs': Awaited<ReturnType<Shared['sharedWalkthroughs']>>,
 *   '/api/shared/notes':        Awaited<ReturnType<Shared['sharedNotes']>>,
 *   '/api/shared/docs':         Awaited<ReturnType<Shared['sharedDocs']>>,
 *   '/api/shared/replies':      Awaited<ReturnType<Shared['inboundReplies']>>,
 *   '/api/pr/code':             Awaited<ReturnType<Ops['prCode']>>,
 *   '/api/prs':                 Awaited<ReturnType<Ops['prsFor']>>,
 *   '/api/reverted':            { reverted: Awaited<ReturnType<typeof import('../dist/reviews.js').revertedMarks>> },
 *   '/api/tripwires':           Awaited<ReturnType<Ops['tripwires']>>,
 *   '/api/triage_drift':        Awaited<ReturnType<Ops['triageDriftList']>>,
 *   '/api/changed_since':       Awaited<ReturnType<Ops['changedSince']>>,
 * }} ApiMap
 */

/**
 * @template {keyof ApiMap} P
 * @param {P} path
 * @param {Record<string, string|number|null|undefined>} [params]
 * @returns {Promise<ApiMap[P]>}
 */
export async function api(path, params = {}) {
  const qs = new URLSearchParams(Object.entries(params).filter(([, v]) => v != null && v !== '').map(([k, v]) => [k, String(v)]));
  const r = await fetch(path + (qs.toString() ? '?' + qs : ''));
  if (!r.ok) throw new Error('HTTP ' + r.status);
  return r.json();
}

/**
 * Run a load and turn a rejection into a rendered reason.
 *
 * The three graph pages fetch from a bare `async` method rather than through
 * `createTask`, so nothing else catches one: a 500 left `loading` true forever
 * and the only trace was a console error nobody was watching. Their templates
 * already knew how to show `data.error` — there was just no way for it to be set.
 *
 * @template T
 * @param {() => Promise<T>} fn
 * @returns {Promise<T | { error: string }>}
 */
export const loaded = async (fn) => { try { return await fn(); } catch (e) { return { error: errText(e) }; } };

/**
 * Why a page's load failed, or null.
 *
 * `createTask` never rejects — it parks the failure on `task.error` and resolves
 * undefined — so a page that does not read it leaves its data null and shows the
 * spinner forever. None of the eighteen pages read it.
 *
 * @param {{ error?: unknown } | undefined} task
 * @returns {string | null}
 */
export const taskError = (task) => (task && task.error ? errText(task.error) : null);

/**
 * Narrow an ops reply to its failure arm.
 *
 * An ops function returns `{ error }` or a payload, and TypeScript normalises the
 * two into arms that BOTH carry an `error` key (`error?: undefined` on the good
 * one) — so `if (d.error)` reads fine and narrows nothing, and every field access
 * after it stays an error. A predicate is what actually splits the union.
 *
 * @template T
 * @param {T} v
 * @returns {v is Extract<T, { error: string }>}
 */
export const isErr = (v) => !!v && typeof (/** @type {{ error?: unknown }} */ (v)).error === 'string';

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
export const pageShell = (data, error, body) =>
  html`<main>${when(error, () => html`<div class="empty">${error}</div>`,
    () => when(!data, () => html`<div class="loading">loading…</div>`, body))}</main>`;

class NavStore extends Store {
  constructor() { super(); this.state = { universes: [], current: null }; }
  async load() { if (this.state.universes.length) return; this.state.universes = (await api('/api/universes')).universes; }
}
export const nav = new NavStore();

let router;
export const go = (path, query) => router.navigate(path, query);
/**
 * The href form of `go`, for navigation that should be a real link.
 *
 * A `<div on-click="${() => go(url)}">` cannot be middle-clicked into a tab,
 * cmd-clicked, right-click-copied, hovered for a preview, or announced as a link — all
 * of which people do constantly in a review tool, where you want a symbol open beside
 * the diff.
 *
 * The router is in HASH mode (no `<base href>`), so `location.hash = x` and clicking
 * `<a href="#x">` are the same act: both fire `hashchange`, which is what the router
 * listens on. A pure-navigation site therefore needs NO click handler at all — the
 * browser routes a plain click and handles a modified one natively. vdx's own
 * `router-link` says the same thing from the other side: it calls `preventDefault()`
 * only when `useHTML5`.
 *
 * `router.url()` rather than `'#' + path` deliberately: it is the same function
 * `navigate()` builds its target with, so a link and a programmatic navigation cannot
 * drift on query encoding.
 */
export const href = (path, query) => {
  // The header renders at DEFINITION time, before `enableRouting` assigns `router` on
  // the last line of this file — so unlike `go`, which only ever runs on a click, this
  // is called with no router at all. Caught by the routes e2e as a render error on
  // every page, which is what that suite exists for.
  //
  // The fallback builds the same string the router would: `#path?query`, with the same
  // encoding `stringifyQuery` uses (`URLSearchParams`, empty values dropped). Kept in
  // step by the assertion in `web-url.test`, not by hoping.
  if (router) return router.url(path, query);
  // Mirrors vdx's own `stringifyQuery` exactly: `encodeURIComponent`, and it drops only
  // null/undefined. `URLSearchParams` would differ on both — it encodes a space as `+`
  // and would have dropped empty strings.
  const pairs = [];
  for (const [k, v] of Object.entries(query ?? {})) {
    if (v != null) pairs.push(`${encodeURIComponent(k)}=${encodeURIComponent(v)}`);
  }
  const qs = pairs.join('&');
  return `#${qs ? `${path}?${qs}` : path}`;
};
const dashUrl = (u) => `/u/${u}/`;
const treeUrl = (u, prefix) => `/u/${u}/tree/` + (prefix ? prefix + '/' : '');
const goTree = (u, prefix) => router.navigate(treeUrl(u, prefix));
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
// Up here with its siblings, not beside its page: `VIEW_LINKS` reads it at module
// level now that the nav is links rather than closures, so a later `const` is a TDZ
// error at header render — which is exactly what it was.
const orphansUrl = (u) => `/u/${u}/orphans/`;
const diffUrl = (u) => `/u/${u}/diff/`;
const pipelineUrl = (u) => `/u/${u}/pipeline/`;
const stateMapUrl = (u) => `/u/${u}/statemap/`;
const REV_COLOR = { reviewed: '#7ee787', stale: '#f0a35e', unreviewed: '#3a4250' };
// A sign-off whose witness was hashed by ANOTHER build (an older HASH_SCHEME, a
// different grammar) — there is no comparison to make, so it cannot vouch for the
// code on screen. It stays `reviewed` in the store on purpose: a scheme bump must
// not rewrite what people signed. On the review surfaces it is an outstanding job
// all the same — warning-coloured, counted as unsigned, and stopped at by the
// walkthrough — because the recovery is one click (`unmarkOn`) and a reviewer who
// is never sent there never takes it.
const isUnverifiable = (info) => !!info && info.state === 'reviewed' && info.via === 'unverifiable';
// Clicking a mark clears it, with two exceptions: an agent `checked` mark upgrades
// to a human sign-off, and an unverifiable one re-signs at the live hash — which is
// what its tooltip has always promised. Clearing it would lose the acceptance
// history for a mark that is not even claimed to be wrong.
const unmarkOn = (state, actor, via) => state === 'reviewed' && actor !== 'agent' && via !== 'unverifiable';
// Actor-aware review rendering: human review = green (`on`), agent `checked` = blue.
// `via` says how a tick was earned (see markBtnEl): direct, ↻ borrowed from a
// lineage this ref does not descend from, or ⟲ sitting on top of a revert. Every
// surface that draws a review mark takes it, or the summaries quietly disagree
// with the buttons they summarise.
// `unverifiable` is checked BEFORE `reverted`/agent. It keeps its own class and its
// own glyph — nothing drifted, so it must not claim drift — but it is drawn in the
// warning colour and clicks through to a re-sign, because a mark that cannot be
// checked is work the reviewer still owes. Rendering it as a plain vouch is the
// silent green check CLAUDE.md's north star forbids; rendering it as a MUTED tick
// was the same failure a shade quieter, since nothing ever routed anyone back to it.
const revCls = (state, actor, via) => state === 'reviewed' ? (via === 'unverifiable' ? 'unverifiable' : via === 'reverted' ? 'reverted' : actor === 'agent' ? 'checked' : 'on') : state === 'stale' ? 'stale' : '';
const revColorA = (info) => {
  const s = info && info.state, a = info && info.actor, v = info && info.via;
  return s === 'reviewed' ? (v === 'unverifiable' ? '#f0a35e' : v === 'reverted' ? '#f0a35e' : a === 'agent' ? '#58a6ff' : '#7ee787') : s === 'stale' ? '#f0a35e' : '#3a4250';
};
const revMark = (state, actor, via) => state === 'reviewed'
  ? (via === 'unverifiable' ? ' ?' : via === 'reverted' ? ' ⟲' : via === 'replayed' ? ' ↻' : actor === 'agent' ? ' ·' : ' ✓')
  : state === 'stale' ? ' ⚠' : '';
const VIA_TIP = { reverted: ' — approved before the code moved BACK to this body on this branch; someone undid work', replayed: ' — approval borrowed from a branch this one does not descend from', unverifiable: ' — the mark stands, but the body it covered was hashed by a different build (an older HASH_SCHEME, or another grammar version), so it CANNOT be compared with the code here. Nothing has drifted; re-sign against this build to make it a live claim again.' };
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
// Your unpublished mark and the team's answer disagree. The value beside this chip is
// the PESSIMISTIC reading of the two — safe, and nobody's actual assertion — so showing
// it without saying so would present a merge as a judgement.
const divergeChip = (t) => (t && t.divergence && t.divergence.length)
  ? html`<span class="dchip" title="${t.divergence.map(d => `${d.field}: yours ${d.yours}, the team's ${d.theirs}`).join(' · ')} — the safer of the two is shown. Publish yours, or adopt theirs, to settle it.">⇄ merged</span>`
  : html``;
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
const VIA_MARK = { replayed: ' ↻', reverted: ' ⟲', unverifiable: ' ?' };
const whereFrom = (p) => (p ? `${p.branch || (p.commit ? p.commit.slice(0, 7) : 'unknown')}${p.at ? ' · ' + p.at.slice(0, 10) : ''}` : 'unknown');
const markBtnEl = (attestation, info, onMark, coverLabel) => {
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
const reviewRowEl = (review, viewed, onMark, level = 'code', coverLabel) => {
  const sign = review && review[level], view = viewed && viewed[level];
  // Signing is a stronger act than viewing, so a HUMAN sign-off implies you viewed it:
  // once human-signed, drop the now-redundant viewed button. An agent `checked` vouch
  // is not a human sign-off — keep viewed available so the human can still mark/sign.
  const humanSigned = sign && sign.state === 'reviewed' && sign.actor !== 'agent';
  return html`<span class="rev">${when(!humanSigned, () => markBtnEl('viewed', view, onMark, coverLabel))}${markBtnEl('signed', sign, onMark, coverLabel)}${when(sign && (sign.state === 'stale' || isUnverifiable(sign)), () => html`<span class="hint" style="margin-left:6px;color:#f0a35e">⚠ ${isUnverifiable(sign) ? 'sign-off cannot be verified — click to re-sign' : 'sign-off stale'}</span>`)}</span>`;
};
// A node's code review is DERIVED from the code reviews of the segments it cites
// (server: deriveCodeReview) — a read-only rollup, never a one-click "I signed the
// node's code". You reach "code reviewed" only by reading & signing each segment.
const codeRollupEl = (cr) => {
  if (!cr || !cr.total) return html`<span class="dim" style="font-size:12px">code: no reviewable segments</span>`;
  const c = cr.state === 'reviewed' ? (cr.unverifiable ? '#f0a35e' : '#7ee787') : cr.state === 'stale' ? '#f0a35e' : '#8b949e';
  const label = cr.state === 'reviewed'
    ? (cr.unverifiable
      ? `code signed, but ${cr.unverifiable} of ${cr.total} segment${cr.total === 1 ? '' : 's'} cannot be checked against this build`
      : `code reviewed — all ${cr.total} segment${cr.total === 1 ? '' : 's'} signed`)
    : `code: ${cr.signed}/${cr.total} segment${cr.total === 1 ? '' : 's'} signed${cr.stale ? ` · ${cr.stale} stale` : ''}`;
  return html`<span class="rev" style="align-items:center;gap:6px"><span style="display:inline-block;width:9px;height:9px;border-radius:50%;background:${c}"></span><span style="color:${c}">${label}</span>${viaNote(cr)}${when(cr.state !== 'reviewed', () => html`<span class="dim" style="font-size:12px">— read &amp; sign each segment below</span>`)}</span>`;
};
// A rollup that hides how its ticks were earned is the same lie the per-segment
// mark was fixed to stop telling, one level up. `reverted` outranks `replayed`:
// borrowed approval is fine, approval sitting on undone work is not.
const viaNote = (cr) => {
  if (!cr) return html``;
  if (cr.unverifiable) return html`<span class="viaflag unverifiable" title="${cr.unverifiable} segment(s) whose witness was hashed by another build — the approval stands but cannot be checked here; open and re-sign">? ${cr.unverifiable} unverifiable</span>`;
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
  const unverifiable = seg.filter(a => isUnverifiable(a.review.code)).length;
  return { state: total === 0 ? 'unreviewed' : stale ? 'stale' : signed === total ? 'reviewed' : 'unreviewed', signed, total, stale, replayed, reverted, unverifiable };
};
// Compact derived-code indicator for dense list rows (catalog, matrix). Read-only
// rollup — code review is per-segment, so it opens the node rather than signing.
// Same ranking as a single mark's `via` (reviews.ts `forLevel`): a revert is the one
// worth interrupting for, then an approval that cannot be checked, then a borrowed one.
const codeMark = (cr) => (!cr || !cr.total) ? 'C'
  : cr.state === 'reviewed' ? (cr.reverted ? 'C⟲' : cr.unverifiable ? 'C?' : cr.replayed ? 'C↻' : 'C✓')
    : cr.state === 'stale' ? 'C⚠' : `C ${cr.signed}/${cr.total}`;
const codeTip = (cr) => (!cr || !cr.total) ? 'no reviewable code segments'
  : `code: ${cr.signed}/${cr.total} segment${cr.total === 1 ? '' : 's'} signed${cr.stale ? ' · ' + cr.stale + ' stale' : ''}`
    + (cr.reverted ? ` · ${cr.reverted} sitting on a revert (code moved back to a body signed before it was superseded here)` : '')
    + (cr.unverifiable ? ` · ${cr.unverifiable} hashed by another build, so they cannot be checked here — open and re-sign` : '')
    + (cr.replayed ? ` · ${cr.replayed} borrowed from another branch` : '')
    + ' — open to read & sign each';
// A push plan's held-back findings are two different messages. Raised while reading
// THIS change and unplaceable: the reviewer's problem, now. Raised during another
// review: a standing backlog that stays on the map until its reporter resolves it —
// which is the lifecycle working, not an error. Listing both together buries the first
// under the second, and on a store with real history the second is most of them.
const blockedHere = (plan) => (plan.blocked || []).filter(b => !b.elsewhere);
const blockedElsewhere = (plan) => (plan.blocked || []).filter(b => b.elsewhere);
// "Nothing folds this, nothing projects it" is a CLAIM, and it may only be made when
// this store could have seen the wiring. A teammate's node whose folding edges are
// analyzer output, or a generated node whose analyzer has not run here, is
// `pendingAnalyzer` — which says what to do, where `orphan` says there is nothing to do
// and would be wrong. The server decides; these read its answer without re-deriving it.
const isOrphan = (e) => 'orphan' in e && !!e.orphan;
const pendingAnalyzer = (e) => 'pendingAnalyzer' in e ? (e.pendingAnalyzer ?? '') : null;

const codeCellBtn = (cr, onOpen) => {
  const st = cr ? cr.state : 'unreviewed';
  const cls = st === 'reviewed' ? (cr && cr.reverted ? 'reverted' : cr && cr.unverifiable ? 'unverifiable' : 'on') : st === 'stale' ? 'stale' : '';
  return html`<button class="${cls}" title="${codeTip(cr)}" on-click="${(e) => { if (e.stopPropagation) e.stopPropagation(); onOpen(); }}">${codeMark(cr)}</button>`;
};
// Two axes: `stakes` (blast radius) and `complexity` (verification difficulty) — set
// independently. onSet receives a patch: { importance } | { complexity } | { clear:true }.
const triageRowEl = (triage, onSet, onTripwire) => {
  const cur = triage && triage.importance, ccur = triage && triage.complexity;
  const sbtn = (imp, label) => html`<button class="${cur === imp ? 'on' : ''}" title="set stakes (blast radius): ${imp}" on-click="${(e) => { if (e.stopPropagation) e.stopPropagation(); onSet({ importance: imp }); }}">${label}</button>`;
  const cbtn = (cx, label, tip) => html`<button class="${ccur === cx ? 'on' : ''}" title="set complexity (review depth): ${cx} — ${tip}" on-click="${(e) => { if (e.stopPropagation) e.stopPropagation(); onSet({ complexity: cx }); }}">${label}</button>`;
  return html`<span class="rev" style="align-items:center;flex-wrap:wrap;gap:6px"><span style="color:#8b949e">stakes:</span>${sbtn('business-critical', 'business-critical')}${sbtn('important', 'important')}${sbtn('low', 'low')}${when(cur, () => html`<button title="clear triage" on-click="${(e) => { if (e.stopPropagation) e.stopPropagation(); onSet({ clear: true }); }}">✕</button>`)}<span style="color:#8b949e;margin-left:6px">complexity:</span>${cbtn('deep', 'deep', 'subtle logic, needs careful thought')}${cbtn('standard', 'standard', 'real but tractable logic')}${cbtn('rote', 'rote', 'a mechanical/checklist verify')}${cbtn('wiring', 'wiring', 'plumbing — a glance clears it')}${sevChip(triage)}${divergeChip(triage)}${when(cur && onTripwire, () => html`<button class="${triage.tripwire ? 'checked' : ''}" title="${triage.tripwire ? 'tripwire armed — alert if this code changes (click to disarm)' : 'arm tripwire — alert me the instant this code changes'}" on-click="${(e) => { if (e.stopPropagation) e.stopPropagation(); onTripwire(!triage.tripwire); }}">🔔</button>`)}${when(triage && triage.likely, () => html`<span style="color:#58a6ff;font-size:12px" title="agent proposal — click a tier to confirm">· likely</span>`)}</span>`;
};
// `ref` scopes anchor resolution to a PR head, so a finding can land on a symbol
// that exists only on the branch (server: resolveRefs' scopeRef).
const postAnnotate = (u, targetKind, targetId, text, kind, line, ref, comment) =>
  fetch('/api/annotate', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ u, targetKind, targetId, text, comment, kind, line, ref, author: 'human' }) });
// Editing a finding, and deciding against sending one. Both local: the map moves,
// nothing reaches GitHub until the push button, which is its own act.
const postRevise = (u, id, patch) =>
  fetch('/api/annotation_revise', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ u, id, by: 'human', ...patch }) });
const postWithdraw = (u, id, withdraw, reason) =>
  fetch('/api/annotation_withdraw', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ u, id, withdraw, reason, by: 'human' }) });
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
const closeFindingForm = (c) => { c.state.finding = null; c.state.raiseErr = null; };
// Review annotations (mirrors the CI review vocab): finding = an issue, pointer = a
// watch-out aid for the reviewer, question = an ask, note = a remark. The ⚑ count is
// action items (findings + questions); pointers/notes render but don't inflate it.
const ANNO_ICON = { finding: '⚑', pointer: '👁', question: '?', note: '✎' };
const openFindingCount = (annotations) => (annotations || []).filter(a => !a.resolved && (a.kind === 'finding' || a.kind === 'question')).length;
// Every annotation write reports the anchor it landed on and that anchor's
// annotations afterwards. A host that can update one symbol in place says so by
// implementing `patchAnnotations`, and skips the full reload — on a large pull
// request that reload is seconds of work to learn what became of one finding.
// Hosts without it (the file/anchor views) keep the reload, which is cheap there.
async function afterAnnotationWrite(c, res) {
  if (res && !res.error && res.target && res.target.kind === 'anchor'
      && c.patchAnnotations && c.patchAnnotations(res.target.id, res.annotations || [])) return;
  await c.load.run();
  if (c.refreshFile && c.state.file) await c.refreshFile();
}
const asJson = (p) => p.then(r => r.json()).catch(() => null);

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
async function raiseFinding(c, u, anchorId, line) {
  const key = findingKey(anchorId, line);
  const text = (c._fdrafts?.[key] || '').trim(); if (!text) return;
  const pr = c.props && c.props.params && c.props.params.pr;
  // What you type here IS the submitter-facing version: a finding raised in one line
  // while reading a diff is already the short form. The evidence half only diverges
  // once someone investigates, and it is editable in the findings list when it does.
  const body = pr
    ? { u, context: { kind: 'pull_request', pr: String(pr) }, targetKind: 'anchor', targetId: anchorId,
        text, comment: text, ...(Number.isFinite(line) ? { line } : {}), ref: c.state?.prRef }
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
async function toggleFinding(c, u, id, resolved) { await afterAnnotationWrite(c, await asJson(postResolveAnnotation(u, id, resolved))); }
const postAssign = (u, id, kind) =>
  fetch('/api/annotation_assign', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ u, id, kind, by: 'me' }) });
async function assignFinding(c, u, id, kind) { await afterAnnotationWrite(c, await asJson(postAssign(u, id, kind))); }
async function reviseFinding(c, u, id, patch) {
  const res = await asJson(postRevise(u, id, patch));
  if (res && res.error) { c.state.findingErr = { id, error: res.error }; return; }
  c.state.findingErr = null;
  await afterAnnotationWrite(c, res);
}
async function withdrawFinding(c, u, id, withdraw, reason) { await afterAnnotationWrite(c, await asJson(postWithdraw(u, id, withdraw, reason))); }
// Raising an agent's finding to the maintainer. Local only — it makes the finding
// PUBLISHABLE; nothing reaches GitHub until the push button, which is its own act.
const postEscalate = (u, id, escalate) =>
  fetch('/api/annotation_escalate', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ u, id, escalate, by: 'human' }) });
async function escalateFinding(c, u, id, escalate) { await afterAnnotationWrite(c, await asJson(postEscalate(u, id, escalate))); }
const isAgentFinding = (f) => (f.author || 'agent').startsWith('agent');
// Mirrors schema.ts. Only these reach the submitter without being named: `open`
// means nobody has checked it, and refuted/accepted are conclusions ABOUT the
// finding rather than asks of the author.
const DISPOSITIONS = ['open', 'confirmed', 'partial', 'rerated', 'refuted', 'accepted'];
// A verdict shows on the pull request and can gate a merge, so COMMENT stays the
// default and the other two are chosen deliberately, never inherited from a filter.
const REVIEW_EVENTS = [
  { id: 'COMMENT', label: 'comment', why: 'feedback without a verdict' },
  { id: 'APPROVE', label: 'approve', why: 'vote to approve. Shows on the pull request and may satisfy a required review.' },
  { id: 'REQUEST_CHANGES', label: 'request changes', why: 'vote to block. Shows on the pull request and may prevent merging until you clear it.' },
];
const PUSH_VERB = { COMMENT: 'post to GitHub', APPROVE: 'approve on GitHub', REQUEST_CHANGES: 'request changes on GitHub' };
const PUBLISHABLE = new Set(['confirmed', 'partial', 'rerated']);

// A finding, plus the two halves of the agent loop: hand it over, and read what
// came back. The agent reports; resolving stays the human's act, so an agent can
// never mark its own work accepted.
const OUTCOME_ICON = { fixed: '✔', answered: '💬', declined: '⊘' };
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
const findingPinEl = (c, u, f) => {
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
const REMEDIATION_LABEL_APP = {
  'fixed-on-branch': ['fixed on branch', 'verified fixed here — the mainline may still carry it'],
  'fixed-on-default': ['fixed on main', 'fixed on the default branch'],
  'deferred': ['deferred', 'real, and deliberately not being fixed now'],
  'wont-fix': ["won't fix", 'real, and a decision was taken not to fix it'],
};
const PENDING_LABEL_APP = { refute: 'refuted', resolve: 'fixed', invalidate: 'invalid', withdraw: 'withdrawn', promote: 'promotion' };

/** Move a finding's state, and refresh whatever is showing it. */
async function setFindingState(c, u, id, state) {
  const res = await asJson(fetch('/api/shared/act', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ u, action: 'close', id, state, reason: state === 'created' ? 'reopened from the diff' : 'resolved from the diff' }),
  }));
  if (res && res.error) { c.state.raiseErr = { key: id, error: res.error }; return; }
  await c.load.run();
}

const teamNoteEl = (n) => html`<div class="rvfind rvteam k-${n.kind} ${n.resolved ? 'resolved' : ''}">
  <span class="rvfpin" title="${n.kind} · ${n.by}${n.line ? ' · line ' + n.line : ''}">${ANNO_ICON[n.kind] || '✎'}${n.line ? ' ' + n.line : ''}</span>
  ${when(n.severity, () => html`<span class="rvfsev" style="background:${SEV_COLOR[n.severity] || '#3a4250'}" title="severity: ${n.severity}"></span>`)}
  ${when(n.category, () => html`<span class="rvfcat">${n.category}</span>`)}
  <span class="rvftext">${n.text}</span>
  <span class="rvfacts">
    <span class="dim rvfauthor" title="the team's — answer it with shared_notes on this symbol">${n.by}</span>
    ${when(n.resolved, () => html`<span class="prbadge ok">resolved</span>`)}
  </span>
</div>`;
const findingItemEl = (c, u, f) => {
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
const findingForm = (c, u, anchorId, line) => {
  if (!c._fdrafts) c._fdrafts = {};
  const key = findingKey(anchorId, line);
  const err = c.state.raiseErr && c.state.raiseErr.key === key ? c.state.raiseErr.error : null;
  return html`<div class="rvaddf"><span class="rvfpin">${line ? '↳' + line : '✎'}</span><input class="rvftextin" placeholder="finding / action item — sign-off still allowed" value="${c._fdrafts[key] || ''}" on-input="${(e) => { c._fdrafts[key] = e.target.value; }}" on-keydown="${(e) => { if (e.key === 'Enter') raiseFinding(c, u, anchorId, line); else if (e.key === 'Escape') closeFindingForm(c); }}"><button title="${c.props && c.props.params && c.props.params.pr ? 'files a finding on this pull request' : 'files a bug — you are not in a pull request review, so this outlives the branch'}" on-click="${() => raiseFinding(c, u, anchorId, line)}">${c.props && c.props.params && c.props.params.pr ? 'raise' : 'file as bug'}</button><button class="ghost" on-click="${() => closeFindingForm(c)}">cancel</button>${when(err, () => html`<span class="rvferr">${err}</span>`)}</div>`;
};
/**
 * Group a symbol's team notes the way the local ones are grouped: by pinned line, with
 * the unpinned ones collected for the block below the code.
 *
 * @returns {[Map<number, any[]>, any[]]}
 */
function pinTeamNotes(shared) {
  const byLine = new Map(); const noLine = [];
  for (const n of (shared || [])) { if (n.line) { (byLine.get(n.line) || byLine.set(n.line, []).get(n.line)).push(n); } else noLine.push(n); }
  return [byLine, noLine];
}
// Render one anchor's source line-by-line (absolute line numbers from `startLine`)
// with a hover 💬 per line that raises a finding pinned to that exact line; existing
// findings render inline under their line, unlocated notes below. The `annotations`
// this reads are refreshed either by `c.load.run()` or, where the host implements
// it, by `c.patchAnnotations` updating just this anchor (see afterAnnotationWrite).
function codeReviewLines(c, u, anchorId, code, lang, startLine, annotations, shared, findings) {
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
// Exposed for the e2e suite: the multi-line highlighting rule is only observable
// in a browser with hljs loaded.
if (typeof window !== 'undefined') window.__diffCodeRows = diffCodeRows;

const reviewHeat = (rev) => {
  if (!rev || !rev.total) return html`<span class="rheat empty"></span>`;
  const w = (n) => Math.round(100 * n / rev.total);
  const track = (done, stale) => html`<span class="rtrack"><i class="done" style="width:${w(done)}%"></i><i class="stale" style="width:${w(stale)}%"></i></span>`;
  const tip = `logical ${rev.logical}/${rev.total}${rev.logicalStale ? ' (' + rev.logicalStale + ' stale)' : ''} · code ${rev.code}/${rev.total}${rev.codeStale ? ' (' + rev.codeStale + ' stale)' : ''}`
    + (rev.codeReverted ? ` · ${rev.codeReverted} approval(s) sitting on a revert` : '');
  return html`<span class="rheat ${rev.codeReverted ? 'has-reverted' : ''}" title="${tip}">${track(rev.logical, rev.logicalStale)}${track(rev.code, rev.codeStale)}</span>`;
};
const revDot = (state, actor, via) => html`<span class="rd ${state === 'reviewed' ? (via === 'unverifiable' ? 'unverifiable' : via === 'reverted' ? 'reverted' : actor === 'agent' ? 'checked' : 'done') : state === 'stale' ? 'stale' : ''}" title="${state}${via && VIA_TIP[via] ? VIA_TIP[via] : ''}"></span>`;

// --- markdown ----------------------------------------------------------------
// Content is authored by the documenting agent / developers (internal, trusted).
class MdContent extends Component {
  static props = { text: '', untrusted: false };
  // Syntax-highlight any fenced code blocks marked produced (it doesn't itself).
  hl() {
    if (!window.hljs) return;
    /** @type {NodeListOf<HTMLElement>} */ (this.querySelectorAll('pre code')).forEach((el) => {
      if (!el.dataset.highlighted) { try { window.hljs?.highlightElement(el); } catch {} }
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
/**
 * Route parameters, across every route — optional because each route binds only
 * its own. Naming them is what makes `params.univrse` a typo rather than a string.
 *
 * @typedef {{ universe: string, id?: string, pr?: string, path?: string }} RouteParams
 * @typedef {{ params: RouteParams, query: Record<string, string> }} PageProps
 *
 * The inline finding form is driven by module-level helpers that take the hosting
 * component, so these two live on whichever page hosts it.
 * @typedef {{ finding: string | null, raiseErr?: { key: string, error: string } | null }} FindingFormState
 *
 * Search renders one group per universe. `all=1` makes the server call a
 * different ops function, so the single-universe reply is wrapped into the same
 * shape by hand — this is the type that says those two agree.
 * @typedef {Extract<ApiMap['/api/search'], { results: unknown }>['results']} SearchGroups
 */

/**
 * A bare array literal infers `(string | ((u: string) => string))[]`, so `l[1](u)`
 * is not callable and an index typo is silent. Naming the tuple is what makes a
 * wrong position a compile error.
 *
 * @typedef {[label: string, href: (u: string) => string, gate?: string]} ViewLink
 * @type {ViewLink[]}
 */
const VIEW_LINKS = [
  ['nodes', u => nodesUrl(u)], ['matrix', u => matrixUrl(u), 'matrix'], ['pipeline', u => pipelineUrl(u), 'pipeline'],
  ['states', u => stateMapUrl(u), 'states'], ['flows', u => flowsUrl(u)], ['bugs', u => bugsUrl(u)], ['orphans', u => orphansUrl(u)], ['diff', u => diffUrl(u)], ['shared', u => `/u/${u}/shared/`],
  ['pull requests', u => prsUrl(u), 'prs'],
];
// Ungated links always show. A gated one needs the universe's `views` to say so —
// unknown-yet (nav still loading) hides it so a link can't flash and vanish, while
// a payload with no `views` at all shows everything rather than hiding the UI.
const viewEnabled = (uni, gate) => !gate || (!!uni && (!uni.views || !!uni.views[gate]));

/** @extends {Component<{}, {pulling: boolean, note: string|null}>} */
class CodemapHeader extends Component {
  static stores = { nav };
  constructor(props) {
    super(props);
    /** @type {{pulling: boolean, note: string|null}} */
    this.state = { pulling: false, note: null };
  }
  mounted() { nav.load(); }
  /**
   * Receive the team's shared state from wherever you happen to be standing.
   *
   * PULL, never sync, and that is the whole reason `sharedPull` exists. This button is
   * in the chrome of every page; one that also published would send your findings to
   * the team as a side effect of wanting to see theirs, from a page that gave no hint
   * it was about to. Sending stays on the shared hub, where it is the subject.
   */
  async pull() {
    const n = this.stores.nav;
    const u = n.current || (n.universes[0] && n.universes[0].id);
    if (!u || this.state.pulling) return;
    this.state.pulling = true;
    this.state.note = null;
    try {
      // SYNC, not pull. There is no case in practice where somebody wants the team's
      // state and does not want their own to travel — a pull-only button meant the
      // findings an agent had just filed sat unpublished until somebody remembered a
      // different button on a different page. `sharedSync` pulls FIRST either way, so
      // this is the pull that was here plus the push nobody was choosing to skip.
      const r = await apiPost('/api/shared/sync', { u });
      // ops-shared refusals come back 200 with an `error` — a reason, not a failure.
      if (r.error) { this.state.note = r.error; return; }
      // A full reload, for the reason `CheckoutBanner.rebaseline` gives: what arrived
      // changes the answer of every shared query on the page, and chrome has no way to
      // re-run the current page's own load. Only when something actually arrived —
      // reloading on an empty pull would throw away scroll position to show the same
      // page back.
      if (r.gained) { location.reload(); return; }
      // A push with nothing to receive is still work done, and saying "up to date"
      // about it reads as "nothing happened".
      this.state.note = r.pushed ? 'sent; nothing new to receive' : 'up to date';
    } catch (e) { this.state.note = errText(e); } finally { this.state.pulling = false; }
  }
  search(e, v) {
    const u = this.stores.nav.current || (this.stores.nav.universes[0] && this.stores.nav.universes[0].id);
    if (u && v) go(`/u/${u}/search/`, { q: v });
  }
  template() {
    const n = this.stores.nav;
    const cur = n.universes.find(x => x.id === n.current) || n.universes[0];
    return html`<header>
      <a class="brand" href="${href('/')}">codemap<span> · map browser</span></a>
      <div class="uni">${each(n.universes, u => html`<a class="${u.id === n.current ? 'active' : ''}" href="${href(dashUrl(u.id))}">${u.id}<span class="n">${u.anchors ?? '–'}</span></a>`)}</div>
      ${each(VIEW_LINKS.filter(l => viewEnabled(cur, l[2])), l => html`<a class="viewlink" href="${href(l[1](n.current || (n.universes[0] && n.universes[0].id) || ''))}">${l[0]}</a>`, l => l[0])}
      <div class="search"><input placeholder="search symbols & docs…" on-change="${(e, v) => this.search(e, v)}"></div>
      ${when(!!cur && !!cur.sidecar, () => html`${when(!!this.state.note, () => html`<span class="pullnote" title="${this.state.note}">${this.state.note}</span>`)}
        <button class="pullbtn" disabled="${this.state.pulling}"
          title="send and receive the team's shared review state — findings, docs, notes, triage. Pull happens first, always, so the guard against publishing something somebody already published has seen what they published."
          on-click="${() => this.pull()}">${this.state.pulling ? 'syncing…' : '⇅ sync'}</button>`)}
    </header>`;
  }
}
defineComponent('codemap-header', CodemapHeader);

/**
 * "The index is baselined on another branch."
 *
 * Every doc verdict, review witness and finding placement on every page resolves
 * against `@work`, so switching to a pull-request branch changes what the whole UI
 * MEANS — silently, until now. `checkStale` has re-baselined on a branch change for
 * a long time, but it writes, so nothing that merely renders could afford to call
 * it; `/api/index-state` is the cheap read that lets a surface ask.
 *
 * Chrome rather than `pageShell`, deliberately. Putting it in the shell would make
 * every page fetch and render it — the same per-surface bridge that the shared-doc
 * reads turned into, one page at a time.
 *
 * @extends {Component<{}, {d: any, busy: boolean}>}
 */
class CheckoutBanner extends Component {
  static stores = { nav };
  constructor(props) {
    super(props);
    /** @type {{d: any, busy: boolean}} */
    this.state = { d: null, busy: false };
    /** Which universe the state above describes, so one fetch happens per switch. */
    this.asked = null;
  }
  // `watch`, not a lifecycle hook. The universe arrives from the router rather than
  // from a prop, so `propsChanged` never fires, and `afterRender` is ONE-SHOT — it
  // ran before any page had set the universe and never again, which is a quiet way
  // to ship a banner that can never appear.
  mounted() {
    watch(() => this.stores.nav.current, (u) => this.sync(u));
    this.sync(this.stores.nav.current);
  }
  async sync(u) {
    if (!u || u === this.asked) return;
    this.asked = u;
    this.state.d = await api('/api/index-state', { u }).catch(() => null);
  }
  async rebaseline() {
    this.state.busy = true;
    try {
      await apiPost('/api/rebaseline', { u: this.stores.nav.current });
      // A full reload, and it is the honest option: re-baselining changes the answer
      // of every query on the page, and this component sits in the chrome with no
      // way to re-run the current page's own load.
      location.reload();
    } finally { this.state.busy = false; }
  }
  template() {
    const u = this.stores.nav.current;
    const d = this.state.d, st = this.state;
    if (!u || !d || !d.moved) return html`<div></div>`;
    return html`<div class="checkout-banner">
      <b>baselined elsewhere</b>
      the index was built on <code>${d.baselinedOn}</code>; this checkout is on
      <code>${d.branch}</code>. Every doc verdict, review mark and finding on these
      pages is resolved against the code from <code>${d.baselinedOn}</code>.
      <button on-click="${() => this.rebaseline()}" disabled="${st.busy}">${st.busy ? 're-baselining…' : `re-baseline on ${d.branch}`}</button>
    </div>`;
  }
}
defineComponent('codemap-checkout', CheckoutBanner);

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
/**
 * @typedef {{ d: ApiMap['/api/dashboard'] | null, q: ApiMap['/api/questions'] | null, lint: ApiMap['/api/lint'] | null }} DashboardState
 * @extends {Component<PageProps, DashboardState>}
 */
class DashboardPage extends Component {
  static props = { params: {}, query: {} };
  /** @param {PageProps} props */
  constructor(props) {
    super(props);
    /** @type {DashboardState} */
    this.state = { d: null, q: null, lint: null };
  }
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
    // Same shape as the header's `VIEW_LINKS` now — a URL, not a closure — so both
    // renderers are real links and neither builds a function per render.
    /** @type {[label: string, url: string, gate?: string][]} */
    const navAll = [
      ['nodes', nodesUrl(u)], ['matrix', matrixUrl(u), 'matrix'], ['pipeline', pipelineUrl(u), 'pipeline'],
      ['states', stateMapUrl(u), 'states'], ['flows', flowsUrl(u)], ['bugs', bugsUrl(u)], ['orphans', orphansUrl(u)],
      ['pull requests', prsUrl(u), 'prs'], ['browse files', treeUrl(u, '')],
    ];
    const nav2 = navAll.filter(x => viewEnabled(d, x[2]));
    return pageShell(d, taskError(this.load), () => html`
      <div class="crumbs"><b>${u}</b> <span class="sep">·</span> overview${when(d.tripwires && d.tripwires.armed && this.canEnableAlerts(), () => html` <span class="sep">·</span> <button title="get a browser notification when a watched tripwire fires" on-click="${() => this.enableAlerts()}">🔔 enable alerts</button>`)}</div>
      ${when(d.attention > 0, () => html`<div class="attn-banner">
        <span class="attn-n">⚠ ${d.attention}</span>
        <span>item${d.attention === 1 ? '' : 's'} need attention:</span>
        ${when(d.docs.stale, () => html`<a class="attn-pill" href="${href(nodesUrl(u))}">${d.docs.stale} stale doc${d.docs.stale === 1 ? '' : 's'}</a>`)}
        ${when(d.docs.dangling, () => html`<a class="attn-pill bad" href="${href(nodesUrl(u))}">${d.docs.dangling} dangling</a>`)}
        ${when(d.bugs.possiblyFixed, () => html`<a class="attn-pill" href="${href(bugsUrl(u), { status: 'open' })}">${d.bugs.possiblyFixed} bug${d.bugs.possiblyFixed === 1 ? '' : 's'} possibly fixed</a>`)}
        ${when(d.reverted, () => html`<span class="attn-pill bad" title="code moved BACK to a body signed before it was superseded here — the tick still reads green, and probably should not">${d.reverted} approval${d.reverted === 1 ? '' : 's'} on reverted code</span>`)}
        ${when(d.tripwires && d.tripwires.fired.length, () => html`<a class="attn-pill bad" title="business-critical code you're watching changed" href="${href(nodesUrl(u))}">🔔 ${d.tripwires.fired.length} tripwire${d.tripwires.fired.length === 1 ? '' : 's'} fired</a>`)}
        ${when(d.openQuestions, () => html`<span class="attn-pill q">${d.openQuestions} open question${d.openQuestions === 1 ? '' : 's'}</span>`)}
        <span class="attn-hint">re-validate via <code>check_stale</code> / the bugs tab</span>
      </div>`, () => html`<div class="attn-banner ok"><span class="attn-n">✓</span> <span>${d.bugs.unverifiable
        ? `nothing stale — but ${d.bugs.unverifiable} bug${d.bugs.unverifiable === 1 ? '' : 's'} cannot be checked against this index`
        : 'nothing stale — docs and bugs are current with the code'}</span></div>`)}

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
          <a class="dclink" href="${href(nodesUrl(u))}">browse nodes ›</a>
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
            ${when(d.bugs.unverifiable, () => this.stat("can't check", d.bugs.unverifiable, 'ids from another build'))}
            ${this.stat('total', d.bugs.total)}
          </div>
          <a class="dclink" href="${href(bugsUrl(u))}">triage bugs ›</a>
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
          <div class="dqh"><span class="qbadge">${qn.target.kind}</span> <a class="dqt" href="${href(this.qTarget(qn.target))}">${qn.targetLabel}</a> <span class="dim">${qn.author}</span>
            <button class="annores" on-click="${() => this.resolveQ(qn.id)}">${qn.resolved ? 'reopen' : 'resolve'}</button></div>
          <md-content text="${qn.text}"></md-content>
        </div>`, qn => qn.id)}`)}

      ${when(this.state.lint && this.state.lint.count, () => html`<div class="sec">summary-drift candidates (${this.state.lint.count}) <span class="dim">— summary asserts an absolute the body qualifies; re-read the body, bound the summary if it over-reaches</span></div>
        ${each(this.state.lint.candidates, ln => html`<div class="dq drift">
          <div class="dqh"><span class="qbadge drift" title="summary says “${ln.absolute}”, body says “${ln.qualifier}”">“${ln.absolute}” vs “${ln.qualifier}”</span> <a class="dqt" href="${href(nodeUrl(u, ln.id))}">${ln.title}</a></div>
          <div class="dim" style="font-size:12.5px">${ln.summary}</div>
        </div>`, ln => ln.id)}`)}

      <div class="sec">explore</div>
      <div class="dnav">${each(nav2, x => html`<a class="btnlike" href="${href(x[1])}">${x[0]}</a>`, x => x[0])}</div>
    `);
  }
}
defineComponent('dashboard-page', DashboardPage);

/**
 * @typedef {{ data: ApiMap['/api/outline'] | null }} OutlineState
 * @extends {Component<PageProps, OutlineState>}
 */
class OutlinePage extends Component {
  static props = { params: {}, query: {} };
  /** @param {PageProps} props */
  constructor(props) {
    super(props);
    /** @type {OutlineState} */
    this.state = { data: null };
  }
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
        <a class="sym" href="${href(anchorUrl(u, s.id))}"><span class="k">${s.kind}</span>
          <span><span class="dot ${(s.coverage === 'cited' || s.coverage === 'covered') ? 'on' : ''}" title="coverage: ${s.coverage}"></span>${s.symbol}${when(s.review, () => html`<span class="rdots" title="logical ${s.review.logical} · code ${s.review.code}">${revDot(s.review.logical, s.review.logicalActor, s.review.logicalVia)}${revDot(s.review.code, s.review.codeActor, s.review.codeVia)}</span>`)}</span><span class="muted">${s.lines ?? ''}</span></a>`)}</div>`;
    }
    if (!d.children || !d.children.length) return html`<div class="empty">no anchors here</div>`;
    return html`<div>
      <div class="rlegend"><span class="k"><span class="mini"></span>review heat — top: logical · bottom: code (green reviewed, amber stale) · hatched coverage = swept in by a <code>cover</code> selector, not cited by a doc</span></div>
      <div class="rows">${each(d.children, c => html`
        <a class="row" href="${href(treeUrl(u, c.path))}">
          <span class="ico">${KICON[c.kind]}</span>
          <span class="name ${c.kind}">${c.name}</span>
          <span class="bar" title="${c.docPct}% documented — ${c.cited ?? '?'} cited, ${c.covered ?? '?'} covered by selector, ${c.open} open"><i style="width:${c.docPct}%;background:${barColor(c.docPct)}"></i>${when(c.citedPct !== undefined && c.citedPct < c.docPct, () => html`<b class="swept" style="left:${c.citedPct}%;width:${c.docPct - c.citedPct}%"></b>`)}</span>
          ${reviewHeat(c.review)}
          <span class="muted">${c.anchors} anc</span>
          <span class="muted">${c.nodes ? c.nodes + ' doc' : ''}${c.bugs ? ' · ' + c.bugs + '🐞' : ''}</span>
        </a>`)}</div>
    </div>`;
  }
  template() {
    const u = this.props.params.universe, d = this.state.data;
    return html`<main>
      <div class="crumbs">${each(this.crumbs(), c => html`${when(c.sep, () => html`<span class="sep">/</span>`)}<a href="${href(treeUrl(u, c.prefix))}">${c.label}</a>`)}</div>
      ${when(this.load.pending, () => html`<div class="loading">loading…</div>`, () => d ? this.body(d, u) : '')}
    </main>`;
  }
}
defineComponent('outline-page', OutlinePage);

/**
 * @typedef {{ a: ApiMap['/api/anchor'] | null }} AnchorState
 * @extends {Component<PageProps, AnchorState>}
 */
class AnchorPage extends Component {
  static props = { params: {}, query: {} };
  /** @param {PageProps} props */
  constructor(props) {
    super(props);
    /** @type {AnchorState} */
    this.state = { a: null };
  }
  load = this.createTask(async () => { nav.current = this.props.params.universe; this.state.a = await api('/api/anchor', { u: this.props.params.universe, id: this.props.params.id }); });
  mounted() { this.load.run(); }
  propsChanged() { this.state.a = null; this.load.run(); }
  // Two independent human marks on the source: `viewed` (I've laid eyes on it — blue)
  // and `signed` (I own it — green). A stale sign-off returns to the worklist and can
  // only be cleared by re-signing; clicking a stale mark re-approves at the live hash.
  async mark(attestation, state, actor, via) {
    const a = this.loadedAnchor(); if (!a) return;
    const unmark = unmarkOn(state, actor, via); // upgrade an agent check to human, re-sign an unverifiable one, never clear either
    await postReview(this.props.params.universe, 'anchor', a.id, 'code', unmark, attestation);
    this.load.run();
  }
  // Human triage: sets a *confirmed* tier (raise or lower — a person owns lowering).
  async triage(patch) {
    const a = this.loadedAnchor(); if (!a) return;
    await postTriage(this.props.params.universe, 'anchor', a.id, patch);
    this.load.run();
  }
  async armTripwire(on) {
    const a = this.loadedAnchor(); if (!a) return;
    await postTriage(this.props.params.universe, 'anchor', a.id, { importance: a.triage.importance, tripwire: on });
    this.load.run();
  }
  /** The anchor if one is on screen — these handlers hang off buttons it renders. */
  loadedAnchor() { const a = this.state.a; return !a || isErr(a) ? null : a; }
  template() {
    const u = this.props.params.universe, a = this.state.a;
    const err = taskError(this.load) ?? (isErr(a) ? a.error : null);
    if (err || !a || isErr(a)) return pageShell(null, err, html``);
    return pageShell(a, null, () => html`<div class="detail">
      <a class="back" href="${href(treeUrl(u, a.file))}">← ${a.file}</a>
      <h2>${a.symbol}</h2>
      <div class="meta">${a.kind} · ${a.file}:${a.lines} · ${a.present ? 'present' : 'not found (lost)'}</div>
      <div style="margin:8px 0">${reviewRowEl(a.review, a.viewed, (att, st, actor, via) => this.mark(att, st, actor, via))}</div>
      <div style="margin:8px 0">${triageRowEl(a.triage, (imp) => this.triage(imp), (on) => this.armTripwire(on))}</div>
      ${when(a.citedBy && a.citedBy.length, () => html`<div class="sec">documented by</div><div class="chips">${each(a.citedBy, n => html`<a class="chip" href="${href(nodeUrl(u, n.id))}">${n.title || n.id}</a>`)}</div>`)}
      ${when(a.bugs && a.bugs.length, () => html`<div class="sec">bugs</div><div class="chips">${each(a.bugs, b => html`<span class="chip">${b.state} · ${b.title}</span>`)}</div>`)}
      ${when(a.findings && a.findings.length, () => html`
        <div class="sec">findings on this symbol</div>
        ${each(a.findings, f => html`<div class="afind sev-${f.severity || 'low'}">
          <div class="tfmeta">
            <a href="#/u/${u}/shared/${f.pr}/">PR ${f.pr}</a>
            <span>${f.severity ?? '—'}</span>
            <span>${f.state}</span>
            ${when(!!f.category, () => html`<span>${f.category}</span>`)}
            <span>${f.author}</span>
            ${when(!f.shared, () => html`<span class="dim" title="filed here, not yet sent to the team">local</span>`)}
          </div>
          <div class="afindtext">${f.text}</div>
        </div>`, f => f.id)}`)}
      ${annoThread(this, u, 'anchor', a.id, a.annotations)}
      <shared-notes-panel universe="${u}" target="${a.id}"></shared-notes-panel>
      <div class="sec">source</div>
      ${when(a.code, () => html`<pre class="hljs"><code>${raw(highlight(a.code, a.lang))}</code></pre>`, () => html`<pre class="code">(unavailable)</pre>`)}
    </div>`);
  }
}
defineComponent('anchor-page', AnchorPage);

/**
 * @typedef {FindingFormState & { n: ApiMap['/api/node'] | null, versions: ApiMap['/api/node_versions']['versions'] | null, open: Record<string, boolean>, acode: Record<string, ApiMap['/api/anchor']> }} NodeState
 * @extends {Component<PageProps, NodeState>}
 */
class NodePage extends Component {
  static props = { params: {}, query: {} };
  // `open`/`acode`: per-segment expand state + lazily-fetched source, kept OUT of
  // the node payload so a mark-and-reload never blows away an open code block.
  /** @param {PageProps} props */
  constructor(props) {
    super(props);
    /** @type {NodeState} */
    this.state = { n: null, versions: null, open: {}, acode: {}, finding: null };
  }
  load = this.createTask(async () => {
    const u = this.props.params.universe, id = this.props.params.id; nav.current = u;
    this.state.n = await api('/api/node', { u, id });
    this.state.versions = this.state.n && !this.state.n.error ? (await api('/api/node_versions', { u, id })).versions : null;
  });
  mounted() { this.load.run(); }
  propsChanged() { this.state.n = null; this.state.versions = null; this.state.open = {}; this.state.acode = {}; this.load.run(); }
  // Signing the node vouches for the DOC (logical), not its code — code review is
  // derived from the per-segment signs below.
  async signNode(attestation, state, actor, via) { const unmark = unmarkOn(state, actor, via); await postReview(this.props.params.universe, 'node', this.props.params.id, 'logical', unmark, attestation); this.load.run(); }
  // Sign an individual referenced code segment; reload recomputes the node's derived code rollup.
  async markAnchor(id, attestation, state, actor, via) { const unmark = unmarkOn(state, actor, via); await postReview(this.props.params.universe, 'anchor', id, 'code', unmark, attestation); this.load.run(); }
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
        <span class="rev">${reviewRowEl(a.review, a.viewed, (att, st, actor, via) => this.markAnchor(a.id, att, st, actor, via))}<a class="viewlink" href="${href(anchorUrl(u, a.id))}" on-click="${(e) => { if (e.stopPropagation) e.stopPropagation(); }}" title="open full anchor page">↗</a></span>
      </div>
      ${when(open, () => !c ? html`<div class="loading" style="padding:6px 0">loading…</div>`
        : isErr(c) ? html`<div class="empty">${c.error}</div>`
          : codeReviewLines(this, u, a.id, c.code, c.lang, presetLine, a.annotations, a.sharedNotes))}
    </div>`;
  }
  async triageNode(patch) { await postTriage(this.props.params.universe, 'node', this.props.params.id, patch); this.load.run(); }
  async armTripwireNode(on) { await postTriage(this.props.params.universe, 'node', this.props.params.id, { importance: this.state.n.triage.importance, tripwire: on }); this.load.run(); }
  async confirm() { await postConfirm(this.props.params.universe, this.props.params.id); this.load.run(); }
  async ackHole() { await postAckHole(this.props.params.universe, this.props.params.id); this.load.run(); }
  template() {
    const u = this.props.params.universe, n = this.state.n, versions = this.state.versions;
    return pageShell(n, taskError(this.load) ?? (n && n.error), () => {
    const cr = deriveCode(n.resolvedAnchors);
    return html`<div class="detail">
      <div class="meta">${n.type}${n.universe ? ' · ' + n.universe : ''} · ${n.id} ${statusChip(n.status)}${trustChip(n.trust)}${sevChip(n.triage)}${divergeChip(n.triage)}<a class="viewlink" href="${href(graphUrl(u, n.id))}">◆ graph</a></div>
      <h2>${n.title}${when(n.versionCount > 1, () => html`<span class="vfork" title="${n.versionCount} versions (forked across branches)">⑂${n.versionCount}</span>`)}</h2>
      <div style="margin:6px 0;display:flex;align-items:center;gap:8px;flex-wrap:wrap"><span class="dim" style="font-size:12px">doc sign-off:</span>${reviewRowEl(n.review, n.viewed, (att, st, actor, via) => this.signNode(att, st, actor, via), 'logical')}<span class="dim" style="font-size:12px">— vouches for the doc, not its code</span></div>
      <div style="margin:6px 0;display:flex;align-items:center;gap:10px;flex-wrap:wrap">${codeRollupEl(cr)}${when(cr.total, () => html`<a class="btnlike" href="${href(nodeReviewUrl(u, n.id))}">open code review →</a>`)}</div>
      <div style="margin:6px 0">${triageRowEl(n.triage, (imp) => this.triageNode(imp), (on) => this.armTripwireNode(on))}</div>
      ${when(n.status === 'stale', () => html`<div class="vaction"><span>This doc cites code that changed since it was written.</span> <button on-click="${() => this.confirm()}">confirm still accurate</button> <span class="dim">— or edit it (forks a new version).</span></div>`)}
      ${when(n.status === 'unverifiable', () => html`<div class="vaction"><span>Whether the code changed since this was written cannot be decided here — it is not a claim that anything drifted. Either it was confirmed under an older hashing scheme, or it cites anchor ids a different build derived.</span> <button on-click="${() => this.confirm()}">confirm at the current code</button> <span class="dim">— which clears the first cause. For the second there is no live hash to add: re-document it against the symbols you have.</span></div>`)}
      ${when(n.status === 'dangling', () => html`<div class="vaction bad"><span>Cited code was removed here (${(n.danglingAnchors || []).length} anchor${(n.danglingAnchors || []).length === 1 ? '' : 's'}).</span> <button on-click="${() => this.ackHole()}">ack — remove doc here</button> <span class="dim">(kept on branches where the code exists).</span></div>`)}
      <md-content text="${n.summary}"></md-content>
      ${when(n.body && n.body.trim(), () => html`<md-content text="${n.body}"></md-content>`)}
      <div class="sec">referenced code (${(n.resolvedAnchors || []).length})${when(cr.total, () => html` — <span class="dim">${cr.signed}/${cr.total} signed${cr.stale ? ' · ' + cr.stale + ' stale' : ''}</span>`)} <span class="dim" style="font-weight:400">— read &amp; sign each segment to complete the node's code review</span></div>
      ${each(n.resolvedAnchors ?? [], a => this.anchorReviewRow(a, u), a => a.id)}
      ${when(n.edges && n.edges.length, () => html`<div class="sec">edges</div><div class="chips">${each(n.edges, e => html`<span class="chip" on-click="${() => e.toRef && go(nodeUrl(e.toRef.universe, e.toRef.id))}">${e.type}: ${e.toRef ? e.toRef.universe + '::' + (e.toRef.title || e.toRef.id) : e.to}</span>`)}</div>`)}
      ${when(n.inboundCrossUniverse && n.inboundCrossUniverse.length, () => html`<div class="sec">called by (other universes)</div><div class="chips">${each(n.inboundCrossUniverse, i => html`<a class="chip" href="${href(nodeUrl(i.fromUniverse, i.from))}">${i.fromUniverse}::${i.from} (${i.type})</a>`)}</div>`)}
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
/**
 * @typedef {FindingFormState & { d: ApiMap['/api/node_review'] | null, open: Record<string, boolean>, hideSigned: boolean, file: ApiMap['/api/file'] | null, filePending: boolean, activeAnchor: string | null }} NodeReviewState
 * @extends {Component<PageProps, NodeReviewState>}
 */
class NodeReviewPage extends Component {
  static props = { params: {}, query: {} };
  // `hideSigned` defaults on — the queue is what's left to review; signed segments
  // stay reachable via the toggle. Findings use the shared per-line helpers
  // (`c.state.finding` = open form key, `c._fdrafts` = per-line draft text).
  /** @param {PageProps} props */
  constructor(props) {
    super(props);
    /** @type {NodeReviewState} */
    this.state = { d: null, open: {}, hideSigned: true, file: null, filePending: false, activeAnchor: null, finding: null };
  }
  load = this.createTask(async () => { nav.current = this.props.params.universe; this.state.d = await api('/api/node_review', { u: this.props.params.universe, id: this.props.params.id }); });
  mounted() { this.load.run(); if (!this._escWired) { this._escWired = true; window.addEventListener('keydown', (e) => { if (e.key === 'Escape') { if (this.state.finding) closeFindingForm(this); else if (this.state.file) this.closeFile(); } }); } }
  propsChanged() { this.state.d = null; this.state.open = {}; this.state.file = null; this.state.activeAnchor = null; this.state.finding = null; this.load.run(); }
  // "done" for the reviewer = a HUMAN sign-off. An agent `checked` mark is a helpful
  // first pass but still needs the human — it stays in the queue (and never hides).
  isDone(s) { const c = s.review && s.review.code; return !!(c && c.state === 'reviewed' && c.actor === 'human' && !isUnverifiable(c)); }
  isChecked(s) { const c = s.review && s.review.code; return !!(c && c.state === 'reviewed' && c.actor === 'agent'); }
  // Effective expand state: signed segments collapse by default, unsigned expand;
  // an explicit toggle overrides.
  isOpen(s) { const v = this.state.open[s.id]; return v === undefined ? !this.isDone(s) : v; }
  toggle(id) { const s = (this.state.d.segments || []).find(x => x.id === id); this.state.open = { ...this.state.open, [id]: !this.isOpen(s) }; }
  setHide(v) { this.state.hideSigned = v; }
  // Only clear your own human vouch; an agent `checked` mark is upgraded to a human sign-off, never wiped.
  async markSeg(id, att, st, actor, via) { const unmark = unmarkOn(st, actor, via); await postReview(this.props.params.universe, 'anchor', id, 'code', unmark, att); await this.load.run(); if (this.state.file) await this.refreshFile(); }
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
        <span class="rev" on-click="${(e) => { if (e.stopPropagation) e.stopPropagation(); }}">${reviewRowEl(s.review, s.viewed, (att, st, actor, via) => this.markSeg(s.id, att, st, actor, via))}<button title="read the whole file in context" on-click="${(e) => { if (e.stopPropagation) e.stopPropagation(); this.openFile(s.file, s.id); }}">view file</button><a class="viewlink" href="${href(anchorUrl(u, s.id))}" on-click="${(e) => { if (e.stopPropagation) e.stopPropagation(); }}" title="open anchor page">↗</a></span>
      </div>
      ${when(open, () => codeReviewLines(this, u, s.id, s.code, s.lang, s.startLine, s.annotations, s.sharedNotes, s.findings))}
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
                <div class="rvamarks">${reviewRowEl(a.review, a.viewed, (att, st, actor, via) => this.markSeg(a.id, att, st, actor, via))}</div>
              </div>`; }, a => a.id)}
            </div>`)}
        </div>
      </div>
    </div>`;
  }
  template() {
    const u = this.props.params.universe, d = this.state.d;
    return pageShell(d, taskError(this.load) ?? (d && d.error), () => {
      const cr = d.codeReview || { signed: 0, total: 0, stale: 0, unverifiable: 0 };
      const segs = d.segments || [];
      const pending = segs.filter(s => !s.missing && !this.isDone(s));
      // Hide only human-signed segments with nothing left open — a signed segment that
      // still has open findings, and any agent-checked-but-unsigned segment, stay visible.
      const shown = this.state.hideSigned ? segs.filter(s => !this.isDone(s) || openFindingCount(s.annotations) > 0) : segs;
      const pct = cr.total ? Math.round(cr.signed / cr.total * 100) : 0;
      return html`
        <div class="crumbs"><a href="${href(nodeUrl(u, d.id))}">← ${d.title}</a> <span class="sep">·</span> code review</div>
        <div class="rvbar">
          <b style="color:${cr.stale || cr.unverifiable ? '#f0a35e' : pct === 100 ? '#7ee787' : '#8b949e'}">${codeMark(cr)}</b>
          <span>${cr.signed}/${cr.total} segment${cr.total === 1 ? '' : 's'} signed${cr.stale ? ` · ${cr.stale} stale` : ''}${cr.unverifiable ? ` · ${cr.unverifiable} unverifiable` : ''}</span>
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

/**
 * @typedef {{ groups: SearchGroups | null }} SearchState
 * @extends {Component<PageProps, SearchState>}
 */
class SearchPage extends Component {
  static props = { params: {}, query: {} };
  static stores = { nav };
  /** @param {PageProps} props */
  constructor(props) {
    super(props);
    /** @type {SearchState} */
    this.state = { groups: null };
  }
  // scope: "all" universes (default) or "one" (the current universe). In the URL
  // so back/forward and deep-links carry it.
  scope() { return this.props.query.scope === 'one' ? 'one' : 'all'; }
  load = this.createTask(async () => {
    nav.current = this.props.params.universe;
    const q = this.props.query.q || '';
    if (!q) { this.state.groups = null; return; }
    // `all=1` makes the server answer with one group per universe; without it the
    // reply is this universe's hits, wrapped into the same shape. Reading the shape
    // rather than re-deriving it from `scope()` keeps the two branches honest.
    const u = this.props.params.universe;
    const r = await api('/api/search', { u, q, all: this.scope() === 'all' ? 1 : null });
    this.state.groups = 'results' in r ? r.results : [{ universe: u, ...r }];
  });
  mounted() { nav.load(); this.load.run(); }
  propsChanged() { this.load.run(); }
  setScope(s) { go(`/u/${this.props.params.universe}/search/`, { q: this.props.query.q || '', scope: s }); }
  group(g) {
    const u = g.universe, hits = (g.nodes?.length || 0) + (g.anchors?.length || 0);
    return html`<div class="detail" style="margin-bottom:12px">
      <div class="dch"><a class="uref" href="${href(dashUrl(u))}">${u}</a> <span class="dim">· ${hits} hit${hits === 1 ? '' : 's'}</span></div>
      ${when(g.nodes && g.nodes.length, () => html`<div class="sec">nodes</div><div class="chips">${each(g.nodes, n => html`<a class="chip" href="${href(nodeUrl(u, n.id))}">${n.title || n.id}</a>`, n => n.id)}</div>`)}
      ${when(g.anchors && g.anchors.length, () => html`<div class="sec">anchors</div><div class="rows">${each(g.anchors, a => html`<a class="sym" href="${href(anchorUrl(u, a.id))}"><span class="k">${a.kind}</span><span>${a.symbol}</span><span class="muted">${a.file}</span></a>`, a => a.id)}</div>`)}
      ${when(!hits, () => html`<div class="dim" style="padding:4px 0">no matches</div>`)}
    </div>`;
  }
  template() {
    const u = this.props.params.universe, groups = this.state.groups, multi = (this.stores.nav.universes || []).length > 1;
    return html`<main>
      <div class="crumbs"><a href="${href(dashUrl(u))}">${u}</a> <span class="sep">/</span> search: ${this.props.query.q || ''}</div>
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
/**
/**
 * `err` is a field of its own rather than an `{ error }` value parked in `data`:
 * every method here reads `data.nodes` directly, and a union there is a narrowing
 * obligation at each one.
 */
/**
 * @typedef {{ data: ApiMap['/api/subgraph'] | null, err: string | null, loading: boolean }} GraphState
 * @extends {Component<PageProps, GraphState>}
 */
class GraphPage extends Component {
  static props = { params: {}, query: {} };
  /** @param {PageProps} props */
  constructor(props) {
    super(props);
    /** @type {GraphState} */
    this.state = { data: null, err: null, loading: true };
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
    const d = await loaded(() => api('/api/subgraph', { u: this.props.params.universe, ids: ids.join(','), expand: expand || '' }));
    if (isErr(d)) { this.state.err = d.error; this.state.data = null; this.state.loading = false; return; }
    this.state.err = null;
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
    const svg = /** @type {SVGSVGElement|null} */ (this.querySelector('svg.explorer')); if (!svg) return;
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
    const svg = /** @type {SVGSVGElement|null} */ (this.querySelector('svg.explorer')); if (!svg) return;
    const data = this.state.data;
    const typeOf = new Map(data.nodes.map((n) => [n.id, n.type]));
    const typeShown = (id) => !this._hidden.node.has(typeOf.get(id));
    const visEdges = data.edges.filter((e) => !this._hidden.edge.has(e.type) && typeShown(e.from) && typeShown(e.to));
    const connected = new Set();
    for (const e of visEdges) { connected.add(e.from); connected.add(e.to); }
    const visNodes = data.nodes.filter((n) => typeShown(n.id) && connected.has(n.id));
    const visIds = new Set(visNodes.map((n) => n.id));
    this._visNodes = visNodes; this._visEdges = visEdges; this._visIds = visIds;
    /** @type {NodeListOf<SVGElement>} */ (svg.querySelectorAll('.gn')).forEach((el) => { el.style.display = visIds.has(el.getAttribute('data-id')) ? '' : 'none'; });
    /** @type {NodeListOf<SVGElement>} */ (svg.querySelectorAll('.ge')).forEach((el) => { el.style.display = (visIds.has(el.getAttribute('data-from')) && visIds.has(el.getAttribute('data-to')) && !this._hidden.edge.has(el.getAttribute('data-type'))) ? '' : 'none'; });
  }
  showSel() {
    const panel = /** @type {HTMLElement|null} */ (this.querySelector('.gsel')); if (!panel) return;
    const n = this.state.data.nodes.find((x) => x.id === this._selected);
    if (!n) { panel.style.display = 'none'; return; }
    panel.style.display = '';
    panel.querySelector('.gseltitle').textContent = `${n.title} · ${n.type}` + (n.hidden ? ` · ${n.hidden} more` : ' · fully expanded');
  }
  restore() { this.cacheEls(); this.fit(); this.applyFilters(); this.applyPositions(); this.showSel(); }
  fit() {
    const svg = /** @type {SVGSVGElement|null} */ (this.querySelector('svg.explorer')); if (!svg) return;
    const cw = svg.clientWidth || 900, ch = svg.clientHeight || 620;
    if (!this._view.set) { this._view = { x: cw / 2, y: ch / 2, s: 1, set: true }; }
    this.applyTransform();
  }
  fitBounds() {
    const svg = /** @type {SVGSVGElement|null} */ (this.querySelector('svg.explorer')); if (!svg) return;
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
    const svg = /** @type {SVGSVGElement|null} */ (this.querySelector('svg.explorer')); if (!svg) return;
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
    const svg = /** @type {SVGSVGElement|null} */ (this.querySelector('svg.explorer')); if (!svg) return;
    if (!this._winWired) {
      this._winWired = true;
      window.addEventListener('mousemove', (e) => { const drag = this._drag; if (!drag) return; if (Math.abs(e.clientX - drag.sx) + Math.abs(e.clientY - drag.sy) > 3) drag.moved = true; this._view.x = drag.ox + (e.clientX - drag.sx); this._view.y = drag.oy + (e.clientY - drag.sy); this.applyTransform(); });
      window.addEventListener('mouseup', () => { const drag = this._drag; if (drag && drag.moved) { this._panned = true; setTimeout(() => { this._panned = false; }, 0); } this._drag = null; const s = this.querySelector('svg.explorer'); if (s) s.classList.remove('grabbing'); });
    }
    if (svg._cmWired) return; svg._cmWired = true;
    svg.addEventListener('mousedown', (e) => { if (hitTarget(e, '.gn')) return; this._drag = { sx: e.clientX, sy: e.clientY, ox: this._view.x, oy: this._view.y, moved: false }; svg.classList.add('grabbing'); });
    svg.addEventListener('wheel', (e) => { e.preventDefault(); const r = svg.getBoundingClientRect(), mx = e.clientX - r.left, my = e.clientY - r.top, f = e.deltaY < 0 ? 1.12 : 0.89, v = this._view, ns = Math.max(0.15, Math.min(3, v.s * f)); v.x = mx - (mx - v.x) * (ns / v.s); v.y = my - (my - v.y) * (ns / v.s); v.s = ns; this.applyTransform(); }, { passive: false });
    svg.addEventListener('mouseover', (e) => { const g = hitTarget(e, '.gn'); if (g) this.hover(g.getAttribute('data-id')); });
    svg.addEventListener('mouseout', (e) => { const g = hitTarget(e, '.gn'); if (g) this.hover(null); });
    svg.addEventListener('click', (e) => { if (this._panned) return; const g = hitTarget(e, '.gn'); if (!g) return; const id = g.getAttribute('data-id'); this._selected = id; this.showSel(); this.fetchData([...this._ids], id); });
  }
  toggleFilter(kind, t, e) { const s = this._hidden[kind]; if (s.has(t)) s.delete(t); else s.add(t); if (e && e.currentTarget) e.currentTarget.classList.toggle('off'); this.applyFilters(); this.runSim(); }
  template() {
    const u = this.props.params.universe, d = this.state.data;
    if (this.state.err) return html`<main><div class="empty">${this.state.err}</div></main>`;
    if (this.state.loading || !d) return html`<main><div class="loading">loading…</div></main>`;
    const node = (n) => {
      const t = n.title.length > 30 ? n.title.slice(0, 29) + '…' : n.title;
      const w = Math.max(56, Math.round(t.length * 6.3) + 18), hw = w / 2;
      const rev = n.review.code === 'reviewed' || n.review.logical === 'reviewed';
      return html`<g class="gn ${n.type} ${rev ? 'rev' : ''} ${n.id === this._selected ? 'sel' : ''}" data-id="${n.id}" data-type="${n.type}">
      <rect x="${-hw}" y="-9" width="${w}" height="18" rx="9"></rect><text x="0" y="4">${t}</text>${when(n.hidden > 0, () => html`<circle class="more" cx="${hw}" cy="-9" r="6"></circle><text class="morec" x="${hw}" y="-6">${n.hidden}</text>`)}
    </g>`; };
    return html`<main class="wide">
      <div class="crumbs"><a href="${href(nodeUrl(u, this.props.params.id))}">← detail</a> <span class="sep">·</span> graph explorer <span class="dim">· ${d.nodes.length} nodes</span></div>
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

/**
 * @typedef {{ data: ApiMap['/api/flows'] | null }} FlowsState
 * @extends {Component<PageProps, FlowsState>}
 */
class FlowsPage extends Component {
  static props = { params: {}, query: {} };
  /** @param {PageProps} props */
  constructor(props) {
    super(props);
    /** @type {FlowsState} */
    this.state = { data: null };
  }
  load = this.createTask(async () => { nav.current = this.props.params.universe; this.state.data = await api('/api/flows', { u: this.props.params.universe }); });
  mounted() { this.load.run(); }
  propsChanged() { this.state.data = null; this.load.run(); }
  template() {
    const u = this.props.params.universe, d = this.state.data;
    return pageShell(d, taskError(this.load), () => html`
      <div class="crumbs">${u} <span class="sep">·</span> flows (${d.flows.length})</div>
      ${when(!d.flows.length, () => html`<div class="empty">no flows (process nodes) documented in this universe yet</div>`)}
      ${each(d.flows, (f) => html`<a class="flow-card" href="${href(flowUrl(u, f.id))}">
        <div class="ft">${f.title} <span class="n">${f.steps} step${f.steps === 1 ? '' : 's'}</span></div>
        <div class="fs">${f.summary}</div>
        <div class="progress">
          <span><span class="rev-dot" style="background:${revColorA(f.review && f.review.logical)}"></span>logical</span>
          <span><span class="rev-dot" style="background:${revColorA(f.review && f.review.code)}"></span>code</span>
          <span>steps: ${f.stepReview.logical}/${f.stepReview.total} logical · ${f.stepReview.code}/${f.stepReview.total} code${f.stepReview.stale ? ' · ' + f.stepReview.stale + ' ⚠' : ''}</span>
        </div>
      </a>`, (f) => f.id)}
    `);
  }
}
defineComponent('flows-page', FlowsPage);

/**
 * @typedef {FindingFormState & { data: ApiMap['/api/flow'] | null, onlyChanged: boolean }} FlowState
 * @extends {Component<PageProps, FlowState>}
 */
class FlowPage extends Component {
  static props = { params: {}, query: {} };
  /** @param {PageProps} props */
  constructor(props) {
    super(props);
    /** @type {FlowState} */
    this.state = { data: null, onlyChanged: false, finding: null };
  }
  load = this.createTask(async () => { nav.current = this.props.params.universe; this.state.data = await api('/api/flow', { u: this.props.params.universe, id: this.props.params.id }); });
  mounted() { this.load.run(); }
  propsChanged() { this.state.data = null; this.load.run(); }
  setOnlyChanged(v) { this.state.onlyChanged = v; }
  // `actor` is passed only by the logical vouch button: only clear your own human
  // review — never wipe an agent's check (mark it human instead). Other callers
  // (viewed exposure, anchor code) leave it undefined → normal toggle.
  async toggle(kind, id, level, state, attestation, actor, via) { const unmark = state === 'reviewed' && (actor === undefined || actor === 'human') && via !== 'unverifiable'; await postReview(this.props.params.universe, kind, id, level, unmark, attestation); this.load.run(); }
  revBtn(kind, id, level, info) {
    // `via` is threaded through, and it had never been: this surface called
    // `revCls`/`revMark` with two arguments, so `reverted`, `replayed` and
    // `unverifiable` all rendered here as an ordinary green tick. Every surface that
    // draws a review mark takes `via`, or the summaries disagree with the buttons.
    const st = (info && info.state) || 'unreviewed', actor = info && info.actor, via = info && info.via;
    const cls = revCls(st, actor, via);
    const tip = `${level} ${st}${st === 'reviewed' && actor === 'agent' ? ' (agent-checked — click to confirm as human)' : ''}${info && info.by ? ' · by ' + info.by : ''}${via && VIA_TIP[via] ? VIA_TIP[via] : ''}`;
    return html`<button class="${cls}" title="${tip}" on-click="${(e) => { if (e.stopPropagation) e.stopPropagation(); this.toggle(kind, id, level, st, undefined, actor, via); }}">${level}${revMark(st, actor, via)}</button>`;
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
    const col = st === 'reviewed' ? (cr && cr.unverifiable ? '#f0a35e' : cr && cr.actor === 'agent' ? '#58a6ff' : '#7ee787') : st === 'stale' ? '#f0a35e' : '#8b949e';
    return html`<span title="${codeTip(cr)}" style="border:1px solid ${col}55;color:${col};border-radius:6px;padding:3px 9px;font-size:12px;cursor:default">${codeMark(cr)}</span>`;
  }
  codeBlock(a) {
    if (a.missing) return html`<div class="anchor-code"><div class="sym">${a.id} — anchor missing (renamed/removed?)</div></div>`;
    if (!a.code) return html`<div class="anchor-code"><div class="sym">${a.symbol} — code unavailable</div></div>`;
    const nf = openFindingCount(a.annotations);
    return html`<div class="anchor-code">
      <div class="sym">${a.symbol} · ${a.file}:${a.lines}${when(nf, () => html`<span class="rvfbadge" title="${nf} open finding${nf === 1 ? '' : 's'}">⚑ ${nf}</span>`)}${reviewRowEl(a.review, a.viewed, (att, st, actor, via) => this.toggle('anchor', a.id, 'code', st, att, actor, via))}</div>
      ${codeReviewLines(this, this.props.params.universe, a.id, a.code, a.lang, a.startLine, a.annotations, a.sharedNotes)}
    </div>`;
  }
  template() {
    const u = this.props.params.universe, d = this.state.data;
    const err = taskError(this.load) ?? (isErr(d) ? d.error : null);
    if (err || !d || isErr(d)) return pageShell(null, err, html``);
    return pageShell(d, null, () => {
    const ch = d.changed || { signed: [], viewed: [] };
    const nChanged = new Set([...ch.signed, ...ch.viewed]).size;
    // Targeted diff: only steps that drifted under a mark you'd made. Never-reviewed
    // steps aren't "changed since you looked", so the filter leaves them out.
    const steps = this.state.onlyChanged ? d.steps.filter((s) => s.changed && (s.changed.signed || s.changed.viewed)) : d.steps;
    return html`
      <div class="crumbs"><a href="${href(flowsUrl(u))}">← flows</a> <span class="sep">·</span> ${d.title}</div>
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
          ${when(s.touches && s.touches.length, () => html`<div class="chips">${each(s.touches, (t) => html`<a class="chip" href="${href(nodeUrl(u, t.id))}">↳ ${t.title}</a>`, (t) => t.id)}</div>`)}
          ${each(s.anchors, (a) => this.codeBlock(a), (a) => a.id)}
        </div>
      </div>`, (s) => s.id)}
    `;
    });
  }
}
defineComponent('flow-page', FlowPage);

// --- node catalog: browse/filter/mark-reviewed every logical node -------------
/**
 * @typedef {{ data: ApiMap['/api/nodes'] | null, tw: ApiMap['/api/tripwires'] | null, f: { q: string, type: string, domain: string, status: string, gen: string, review: string, severity: string }, group: string }} NodeCatalogState
 * @extends {Component<PageProps, NodeCatalogState>}
 */
class NodeCatalogPage extends Component {
  static props = { params: {}, query: {} };
  /** @param {PageProps} props */
  constructor(props) {
    super(props);
    /** @type {NodeCatalogState} */
    this.state = { data: null, tw: null, f: { q: '', type: '', domain: '', status: '', gen: '', review: '', severity: '' }, group: 'type' };
  }
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
  async toggle(id, level, state, actor, via) { const unmark = unmarkOn(state, actor, via); await postReview(this.props.params.universe, 'node', id, level, unmark); this.load.run(); }
  async deriveStakes() { await postTriage(this.props.params.universe, null, null, { derive: true }); this.load.run(); }
  // Human review = green (`on`); an agent `checked` review = blue, so it never reads
  // as fully-verified. A web toggle always records a human review.
  revBtn(id, level, state, actor, via) {
    const agent = state === 'reviewed' && actor === 'agent';
    const cls = revCls(state, actor, via);
    const mark = revMark(state, actor, via).trim();
    const tip = `${level}: ${state}${agent ? ' (agent-checked — click to confirm as human)' : ''}${via && VIA_TIP[via] ? VIA_TIP[via] : ''}`;
    return html`<button class="${cls}" title="${tip}" on-click="${(e) => { if (e.stopPropagation) e.stopPropagation(); this.toggle(id, level, state, actor, via); }}">${level[0].toUpperCase()}${mark}</button>`;
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
      <a class="ntitle" href="${href(nodeUrl(u, n.id))}" on-click="${(e) => { if (e.stopPropagation) e.stopPropagation(); }}">${n.title || n.id}${when(n.versionCount > 1, () => html`<span class="vfork" title="${n.versionCount} versions (forked)">⑂${n.versionCount}</a>`)}</span>
      ${statusChip(n.status)}${trustChip(n.trust, (act) => this.verify(n.id, act))}${sevChip(n.triage)}${divergeChip(n.triage)}
      <span class="ndom">${n.domain}</span>
      <span class="nmeta">${n.anchors}a · ${n.edgesIn}↓${n.edgesOut}↑</span>
      ${when(n.generatedBy, () => html`<span class="gen">${n.generatedBy}</span>`)}
      <span class="nrev">${this.revBtn(n.id, 'logical', n.review.logical, n.reviewBy && n.reviewBy.logical, n.reviewVia && n.reviewVia.logical)}${this.codeCell(n)}</span>
    </div>`;
  }
  template() {
    const u = this.props.params.universe, d = this.state.data;
    return pageShell(d, taskError(this.load), () => {
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
        ${each(this.state.tw.fired, f => html` <a class="chip" href="${href(f.target.kind === 'anchor' ? anchorUrl(u, f.target.id) : nodeUrl(u, f.target.id))}">${f.target.id.slice(0, 14)}</a>`, f => f.target.kind + f.target.id)}
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
/**
 * @typedef {{ data: ApiMap['/api/matrix'] | null, f: { q: string, domain: string, orphan: boolean } }} MatrixState
 * @extends {Component<PageProps, MatrixState>}
 */
class MatrixPage extends Component {
  static props = { params: {}, query: {} };
  /** @param {PageProps} props */
  constructor(props) {
    super(props);
    /** @type {MatrixState} */
    this.state = { data: null, f: { q: '', domain: '', orphan: false } };
  }
  load = this.createTask(async () => { nav.current = this.props.params.universe; this.state.data = await api('/api/matrix', { u: this.props.params.universe }); });
  mounted() { this.load.run(); }
  propsChanged() { this.state.data = null; this.load.run(); }
  set(k, v) { this.state.f = { ...this.state.f, [k]: v }; }
  // Clicking a review button records a HUMAN vouch. Only clear when it's already
  // your own human review — never wipe an agent's check; mark it human instead.
  async toggle(id, level, state, actor, via) { const unmark = unmarkOn(state, actor, via); await postReview(this.props.params.universe, 'node', id, level, unmark); this.load.run(); }
  // Human review = green (`on`); an agent `checked` review = blue, so it never reads
  // as fully-verified. A web toggle always records a human review.
  revBtn(id, level, state, actor, via) {
    const agent = state === 'reviewed' && actor === 'agent';
    const cls = revCls(state, actor, via);
    const mark = revMark(state, actor, via).trim();
    const tip = `${level}: ${state}${agent ? ' (agent-checked — click to confirm as human)' : ''}${via && VIA_TIP[via] ? VIA_TIP[via] : ''}`;
    return html`<button class="${cls}" title="${tip}" on-click="${(e) => { if (e.stopPropagation) e.stopPropagation(); this.toggle(id, level, state, actor, via); }}">${level[0].toUpperCase()}${mark}</button>`;
  }
  filtered() {
    const f = this.state.f, q = f.q.toLowerCase();
    return this.state.data.events.filter((e) =>
      (!q || e.title.toLowerCase().includes(q)) && (!f.domain || e.domain === f.domain) && (!f.orphan || isOrphan(e)));
  }
  template() {
    const u = this.props.params.universe, d = this.state.data;
    return pageShell(d, taskError(this.load), () => {
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
          ${each(d.sinks, s => html`<a class="msink ${s.type}" href="${href(nodeUrl(u, s.id))}" title="${s.title} (${s.type})">${s.title}</a>`, s => s.id)}
          <span class="mrevh">review</span>
        </div>
        ${each(rows, e => html`<div class="mrow ${isOrphan(e) ? 'orphan' : ''} ${pendingAnalyzer(e) !== null ? 'pending-analyzer' : ''}" title="${pendingAnalyzer(e) !== null ? `nothing here folds or projects this — but its wiring is analyzer output${pendingAnalyzer(e) ? ` (${pendingAnalyzer(e)})` : ''}, which never travels between clones because every clone regenerates it. Run the analyzer to resolve it.` : ''}">
          <a class="mev" href="${href(nodeUrl(u, e.id))}"><b>${e.title}</b><small>${e.domain} · ${e.emitters}↑</small></a>
          ${each(d.sinks, s => html`<span class="mcell">${when(e.cells[s.id], () => html`<i class="cdot ${e.cells[s.id]}" title="${e.cells[s.id]}"></i>`)}</span>`, s => s.id)}
          <span class="mrevh"><span class="nrev">${this.revBtn(e.id, 'logical', e.review.logical, e.reviewBy && e.reviewBy.logical, e.reviewVia && e.reviewVia.logical)}${codeCellBtn(e.codeReview, () => go(nodeUrl(u, e.id)))}</span></span>
        </div>`, e => e.id)}
      </div>
    `;
    });
  }
}
defineComponent('matrix-page', MatrixPage);

// --- layered event pipeline: command→handler→event→aggregate→projection -------
const PIPE = { COLW: 300, NODEW: 224, ROWH: 22, NODEH: 16 };
/**
 * @typedef {{ data: ApiMap['/api/pipeline'] | null, err: string | null, loading: boolean, domain: string }} PipelineState
 * @extends {Component<PageProps, PipelineState>}
 */
class PipelinePage extends Component {
  static props = { params: {}, query: {} };
  /** @param {PageProps} props */
  constructor(props) {
    super(props);
    /** @type {PipelineState} */
    this.state = { data: null, err: null, loading: true, domain: '' };
    this._view = { x: 10, y: 36, s: 1 };
  }
  async fetchData() {
    this._adj = null; nav.current = this.props.params.universe;
    if (!this.state.data) this.state.loading = true; // don't blank an existing graph on reload
    const data = await loaded(() => api('/api/pipeline', { u: this.props.params.universe, domain: this.state.domain || '' }));
    if (isErr(data)) { this.state.err = data.error; this.state.data = null; this.state.loading = false; return; }
    this.state.err = null; this.state.data = data; this.state.loading = false;
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
    const svg = /** @type {SVGSVGElement|null} */ (this.querySelector('svg.pipeline')); if (!svg) return;
    if (!id) { svg.classList.remove('hovering'); svg.querySelectorAll('.hl').forEach((el) => el.classList.remove('hl')); return; }
    const near = this.adjacency().get(id) || new Set();
    svg.classList.add('hovering');
    svg.querySelectorAll('.pn').forEach((el) => el.classList.toggle('hl', el.getAttribute('data-id') === id || near.has(el.getAttribute('data-id'))));
    svg.querySelectorAll('.pe').forEach((el) => el.classList.toggle('hl', el.getAttribute('data-from') === id || el.getAttribute('data-to') === id));
  }
  setup() {
    const svg = /** @type {SVGSVGElement|null} */ (this.querySelector('svg.pipeline')); if (!svg) return;
    this.fit();
    // Window listeners once per component; svg listeners keyed on the element so
    // they re-attach if the <svg> is ever recreated (drag state is shared).
    if (!this._winWired) {
      this._winWired = true;
      window.addEventListener('mousemove', (e) => { const drag = this._drag; if (!drag) return; if (Math.abs(e.clientX - drag.sx) + Math.abs(e.clientY - drag.sy) > 3) drag.moved = true; this._view.x = drag.ox + (e.clientX - drag.sx); this._view.y = drag.oy + (e.clientY - drag.sy); this.applyTransform(); });
      window.addEventListener('mouseup', () => { const drag = this._drag; if (drag && drag.moved) { this._panned = true; setTimeout(() => { this._panned = false; }, 0); } this._drag = null; const s = this.querySelector('svg.pipeline'); if (s) s.classList.remove('grabbing'); });
    }
    if (svg._cmWired) return; svg._cmWired = true;
    svg.addEventListener('mousedown', (e) => { if (hitTarget(e, '.pn')) return; this._drag = { sx: e.clientX, sy: e.clientY, ox: this._view.x, oy: this._view.y, moved: false }; svg.classList.add('grabbing'); });
    svg.addEventListener('wheel', (e) => { e.preventDefault(); const r = svg.getBoundingClientRect(); const mx = e.clientX - r.left, my = e.clientY - r.top; const f = e.deltaY < 0 ? 1.12 : 0.89; const v = this._view; const ns = Math.max(0.15, Math.min(3, v.s * f)); v.x = mx - (mx - v.x) * (ns / v.s); v.y = my - (my - v.y) * (ns / v.s); v.s = ns; this.applyTransform(); }, { passive: false });
    svg.addEventListener('mouseover', (e) => { const g = hitTarget(e, '.pn'); if (g) this.hover(g.getAttribute('data-id')); });
    svg.addEventListener('mouseout', (e) => { const g = hitTarget(e, '.pn'); if (g) this.hover(null); });
  }
  onClick(e) { if (this._panned) return; const g = hitTarget(e, '.pn'); if (g) go(nodeUrl(this.props.params.universe, g.getAttribute('data-id'))); }
  template() {
    const u = this.props.params.universe, d = this.state.data;
    if (this.state.err) return html`<main><div class="empty">${this.state.err}</div></main>`;
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
/**
 * @typedef {{ data: ApiMap['/api/statemap'] | null, err: string | null, loading: boolean, agg: string }} StatemapState
 * @extends {Component<PageProps, StatemapState>}
 */
class StatemapPage extends Component {
  static props = { params: {}, query: {} };
  /** @param {PageProps} props */
  constructor(props) {
    super(props);
    /** @type {StatemapState} */
    this.state = { data: null, err: null, loading: true, agg: '' };
    this._view = { x: 10, y: 36, s: 1 };
  }
  async fetchData() {
    nav.current = this.props.params.universe;
    if (!this.state.data) this.state.loading = true;
    const data = await loaded(() => api('/api/statemap', { u: this.props.params.universe }));
    if (isErr(data)) { this.state.err = data.error; this.state.data = null; this.state.loading = false; return; }
    this.state.err = null; this.state.data = data; this.state.loading = false;
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
    const svg = /** @type {SVGSVGElement|null} */ (this.querySelector('svg.statemap')); if (!svg) return;
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
    const svg = /** @type {SVGSVGElement|null} */ (this.querySelector('svg.statemap')); if (!svg) return;
    if (!id) { svg.classList.remove('hovering'); svg.querySelectorAll('.hl').forEach((el) => el.classList.remove('hl')); return; }
    const near = (this._adj && this._adj.get(id)) || new Set();
    svg.classList.add('hovering');
    svg.querySelectorAll('.pn').forEach((el) => el.classList.toggle('hl', el.getAttribute('data-id') === id || near.has(el.getAttribute('data-id'))));
    svg.querySelectorAll('.pe').forEach((el) => el.classList.toggle('hl', el.getAttribute('data-from') === id || el.getAttribute('data-to') === id));
  }
  setup() {
    const svg = /** @type {SVGSVGElement|null} */ (this.querySelector('svg.statemap')); if (!svg) return;
    this.fit();
    if (!this._winWired) {
      this._winWired = true;
      window.addEventListener('mousemove', (e) => { const drag = this._drag; if (!drag) return; if (Math.abs(e.clientX - drag.sx) + Math.abs(e.clientY - drag.sy) > 3) drag.moved = true; this._view.x = drag.ox + (e.clientX - drag.sx); this._view.y = drag.oy + (e.clientY - drag.sy); this.applyTransform(); });
      window.addEventListener('mouseup', () => { const drag = this._drag; if (drag && drag.moved) { this._panned = true; setTimeout(() => { this._panned = false; }, 0); } this._drag = null; const s = this.querySelector('svg.statemap'); if (s) s.classList.remove('grabbing'); });
    }
    if (svg._cmWired) return; svg._cmWired = true;
    svg.addEventListener('mousedown', (e) => { if (hitTarget(e, '.pn')) return; this._drag = { sx: e.clientX, sy: e.clientY, ox: this._view.x, oy: this._view.y, moved: false }; svg.classList.add('grabbing'); });
    svg.addEventListener('wheel', (e) => { e.preventDefault(); const r = svg.getBoundingClientRect(); const mx = e.clientX - r.left, my = e.clientY - r.top; const f = e.deltaY < 0 ? 1.12 : 0.89; const v = this._view; const ns = Math.max(0.15, Math.min(3, v.s * f)); v.x = mx - (mx - v.x) * (ns / v.s); v.y = my - (my - v.y) * (ns / v.s); v.s = ns; this.applyTransform(); }, { passive: false });
    svg.addEventListener('mouseover', (e) => { const g = hitTarget(e, '.pn'); if (g) this.hover(g.getAttribute('data-id')); });
    svg.addEventListener('mouseout', (e) => { const g = hitTarget(e, '.pn'); if (g) this.hover(null); });
  }
  onClick(e) { if (this._panned) return; const g = hitTarget(e, '.pn'); if (g) go(nodeUrl(this.props.params.universe, g.getAttribute('data-open'))); }
  template() {
    const u = this.props.params.universe, d = this.state.data;
    // Before the emptiness check, not after: a failed load has no `machines` either,
    // and "no state machines yet" is a confident false statement about the repo.
    if (this.state.err) return html`<main><div class="empty">${this.state.err}</div></main>`;
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

// --- bugs: the team's defect list, re-validated against live code --------------
//
// A bug is a shared object now: it travels on the sidecar, people comment on it, and it
// can carry a link to whatever tracker the team uses. What does NOT travel is the
// verdict — `possiblyFixed` is a join against THIS checkout's index, computed on every
// read, and a bug whose code vanished is queued rather than closed.
const BUG_STATES = ['issued', 'created', 'resolved', 'withdrawn', 'refuted', 'invalid'];
// `migrateBugsBlob` records an unknown author as the empty principal and an unknown time
// as the epoch, deliberately: a legacy bug carries neither, and inventing them is the
// false provenance the witness fields exist to prevent. Rendering those sentinels as a
// name and a date tells that lie one layer up — this is where they stay unknown.
const unknownAt = (at) => !at || String(at).slice(0, 4) === '1970';
const byline = (by, via, at) => (by ? by + (via ? ' · ' + via : '') : 'author not recorded')
  + (unknownAt(at) ? ' · date not recorded' : ' · ' + String(at).slice(0, 10));
/**
 * @typedef {{ data: ApiMap['/api/bugs'] | null, detail: ApiMap['/api/bug'] | null,
 *   detailPending: boolean, note: string | null, busy: string | null, draft: string,
 *   tracking: boolean }} BugsState
 * @extends {Component<PageProps, BugsState>}
 */
class BugsPage extends Component {
  static props = { params: {}, query: {} };
  /** @param {PageProps} props */
  constructor(props) {
    super(props);
    /** @type {BugsState} */
    this.state = { data: null, detail: null, detailPending: false, note: null, busy: null, draft: '', tracking: false };
  }
  // Filter (state) and selection (bug) both live in the URL, so back/forward walk the
  // triage and any bug is deep-linkable.
  load = this.createTask(async () => {
    const u = this.props.params.universe; nav.current = u;
    this.state.data = await api('/api/bugs', { u, state: this.props.query.state || '', queue: this.props.query.queue || '' });
    await this.applySel();
  });
  mounted() { this._q = { ...this.props.query }; this._u = this.props.params.universe; this.load.run(); }
  propsChanged(name) {
    if (name !== 'query' && name !== 'params') return;
    const q = this.props.query, prev = this._q || {}, u = this.props.params.universe;
    this._q = { ...q };
    if (u !== this._u || q.state !== prev.state || q.queue !== prev.queue) { this._u = u; this.load.run(); }
    else if (q.bug !== prev.bug) this.applySel();
  }
  async applySel() {
    const id = this.props.query.bug;
    if (!id) { this.state.detail = null; return; }
    this.state.detailPending = true;
    try { this.state.detail = await api('/api/bug', { u: this.props.params.universe, id }); }
    finally { this.state.detailPending = false; }
  }
  pickState(s) { go(bugsUrl(this.props.params.universe), s === 'queue' ? { queue: '1' } : (s ? { state: s } : {})); }
  pickBug(id) { go(bugsUrl(this.props.params.universe), { state: this.props.query.state, queue: this.props.query.queue, bug: id }); }

  /**
   * Every write goes through here, and every one of them can be REFUSED — the ratchet
   * says an agent may not close what somebody stood behind, and the log's own fold says
   * an agent may not re-point a tracking link. The refusal is the answer, so it is shown
   * rather than swallowed into a silent reload.
   */
  async act(action, body, label) {
    const u = this.props.params.universe, d = this.state.detail;
    // `isErr`, not `d.error`: both arms carry the key, so truthiness narrows nothing.
    if (!d || isErr(d)) return;
    const id = d.id;
    this.state.busy = label || action;
    this.state.note = null;
    try {
      const r = await apiPost(`/api/bug/${action}`, { u, id, ...body });
      this.state.note = r.error ?? r.note ?? null;
      await this.load.run();
    } catch (e) { this.state.note = errText(e); } finally { this.state.busy = null; }
  }
  async comment() {
    const body = this.state.draft.trim();
    if (!body) return;
    await this.act('comment', { body }, 'comment');
    if (!this.state.note) this.state.draft = '';
  }
  async track(form) {
    const key = (form.key.value || '').trim(), url = (form.url.value || '').trim();
    await this.act('track', { system: (form.system.value || 'jira').trim() || 'jira', key, url }, 'track');
    if (!this.state.note || /^tracked/.test(this.state.note)) this.state.tracking = false;
  }
  async publish() {
    const u = this.props.params.universe;
    this.state.busy = 'publish';
    try {
      const r = await apiPost('/api/bug/publish', { u });
      this.state.note = r.error ?? `${r.published} published — run \`codemap sync\` to send them`;
      await this.load.run();
    } catch (e) { this.state.note = errText(e); } finally { this.state.busy = null; }
  }

  bugRow(b) {
    const sel = this.props.query.bug === b.id;
    return html`<div class="brow ${b.state} ${sel ? 'sel' : ''}" on-click="${() => this.pickBug(b.id)}">
      <span class="sevdot" style="background:${SEV_COLOR[b.severity] || SEV_COLOR.medium}" title="severity: ${b.severity}"></span>
      <div class="bmain">
        <div class="btitle">${b.title}</div>
        <div class="bsub">
          <span class="bchip ${b.state}">${b.state}</span>
          ${when(b.waitingOnYou, () => html`<span class="bchip poss" title="promoted, corroborated, contested or asked about — this one needs a person">needs you</span>`)}
          ${when(b.possiblyFixed, () => html`<span class="bchip poss" title="cited code changed since filing — possibly fixed">possibly fixed</span>`,
            () => when(b.codeChanged, () => html`<span class="bchip changed" title="cited code changed since filing">code changed</span>`))}
          ${when(b.tracked, () => html`<span class="bchip" title="${b.tracking.map(t => t.system + ' ' + (t.key || t.url)).join(', ')}">tracked</span>`)}
          <span class="bmeta">${b.anchors.length}a${b.comments ? ' · ' + b.comments + '💬' : ''}${b.shared ? '' : ' · local'}</span>
        </div>
      </div>
    </div>`;
  }

  /** The thread. What the old free-text `history` was standing in for, with authors. */
  threadEl(b) {
    return html`<div class="sec">discussion (${b.thread.length})</div>
      <div class="bhist">${each(b.thread, c => html`<div class="bcomment">
        <div class="dim">${byline(c.by, c.via, c.at)}</div>
        <md-content text="${c.body}"></md-content>
      </div>`, c => c.id)}</div>
      <div class="bcompose">
        <textarea class="bdraft" rows="3" placeholder="say something on this bug…"
          value="${this.state.draft}" on-input="${(e) => { this.state.draft = e.target.value; }}"></textarea>
        <button disabled="${!this.state.draft.trim() || this.state.busy === 'comment'}" on-click="${() => this.comment()}">comment</button>
      </div>`;
  }

  /**
   * Where this bug lives outside codemap. Being in a tracker is NOT being fixed — the
   * witness is still what decides that here — so this never changes the state.
   */
  trackEl(b) {
    return html`<div class="sec">external tracking</div>
      ${when(!b.tracking.length, () => html`<div class="dim">not tracked anywhere outside codemap</div>`)}
      ${each(b.tracking, t => html`<div class="btrack">
        <span class="bchip">${t.system}</span>
        ${when(!!t.url, () => html`<a href="${t.url}" target="_blank" rel="noreferrer">${t.key || t.url}</a>`,
          () => html`<span>${t.key}</span>`)}
      </div>`, t => t.system)}
      ${when(this.state.tracking, () => html`<form class="btrackform" on-submit="${(e) => { e.preventDefault(); this.track(e.target); }}">
        <input name="system" placeholder="jira" value="jira" size="6">
        <input name="key" placeholder="ACME-1234" size="12">
        <input name="url" placeholder="https://…" size="28">
        <button type="submit" disabled="${this.state.busy === 'track'}">link</button>
        <button type="button" on-click="${() => { this.state.tracking = false; }}">cancel</button>
      </form>`, () => html`<div class="bactions"><button on-click="${() => { this.state.tracking = true; }}">link a ticket</button></div>`)}`;
  }

  detail() {
    const u = this.props.params.universe, b = this.state.detail;
    if (this.state.detailPending && !b) return html`<div class="loading">loading…</div>`;
    if (!b) return html`<div class="empty" style="padding:40px">select a bug on the left</div>`;
    if (isErr(b)) return html`<div class="empty">${b.error}</div>`;
    return html`<div class="ddetail">
      <div class="dsymhead"><span class="sevdot" style="background:${SEV_COLOR[b.severity] || SEV_COLOR.medium}"></span> <b>${b.title}</b> <span class="bchip ${b.state}">${b.state}</span>${when(b.possiblyFixed, () => html`<span class="bchip poss">possibly fixed</span>`)}</div>
      <div class="meta">${b.severity} · ${b.id}${b.createdCommit ? ' · filed @ ' + b.createdCommit.slice(0, 8) : ''}${b.shared ? ' · shared' : ' · local only'}${b.filedAt && !unknownAt(b.filedAt) ? ' · originally ' + b.filedAt.slice(0, 10) : ''}</div>
      ${when(!!b.from, () => html`<div class="meta">accepted from finding ${b.from.finding} on <a class="lk" href="${href(`/u/${u}/pr/${b.from.pr}/`)}">PR ${b.from.pr}</a></div>`)}
      ${when(!!b.pending, () => html`<div class="attn-banner"><span>${b.pending.by} asked to <b>${b.pending.ask}</b>: ${b.pending.rationale}</span></div>`)}
      <div class="drev">
        <span class="dim">state:</span>
        <span class="rev">${each(BUG_STATES, s => html`<button class="${b.state === s ? 'on' : ''}" disabled="${this.state.busy === 'state'}" on-click="${() => this.act('update', { state: s }, 'state')}">${s}</button>`, s => s)}</span>
        <button class="bwit" title="re-snapshot the cited code's hashes as the current witness (clears stale)" on-click="${() => this.act('update', { refreshWitnesses: true }, 'witness')}">refresh witnesses</button>
        ${when(!b.promotion, () => html`<button title="surface this for the whole team" on-click="${() => this.act('promote', {}, 'promote')}">promote</button>`,
          () => html`<span class="bchip">promoted by ${b.promotion.by}</span>`)}
      </div>
      ${when(!!this.state.note, () => html`<div class="note">${this.state.note}</div>`)}
      <md-content text="${b.text}"></md-content>

      ${when(!!b.contestedFields.length, () => html`<div class="sec warn">contested</div>
        ${each(b.contestedFields, c => html`<div class="contest">
          <div class="dim">${c.field} — two people set this without seeing each other</div>
          <div><b>${c.held.by}</b>: ${String(c.held.value)}</div>
          <div><b>${c.incoming.by}</b>: ${String(c.incoming.value)}</div>
          <div class="bactions">
            <button on-click="${() => this.act('settle', { field: c.field, value: c.held.value }, 'settle')}">keep ${c.held.by}'s</button>
            <button on-click="${() => this.act('settle', { field: c.field, value: c.incoming.value }, 'settle')}">keep ${c.incoming.by}'s</button>
          </div>
        </div>`, c => c.field)}`)}

      <div class="sec">cited code (${b.anchors.length})${when(b.staleAnchors, () => html` · <span class="warn">${b.staleAnchors} stale</span>`)}</div>
      ${each(b.anchors, a => html`<a class="banchor ${a.stale ? 'stale' : ''} ${a.present ? '' : 'gone'} ${a.removed ? 'dropped' : ''}" href="${href(anchorUrl(u, a.id))}">
        <span class="basym">${a.symbol}</span>
        <span class="bafile">${a.file || '(unresolved)'}${a.lines ? ':' + a.lines : ''}</span>
        ${when(!!a.removed, () => html`<span class="bchip" title="dropped by ${a.removed.by}: ${a.removed.reason}">dropped</span>`,
          () => when(a.unverifiable, () => html`<span class="bchip" title="this anchor id was minted by a build whose ids are derived differently — it is not resolvable here, which is not the same as gone">can't check</span>`,
            () => when(!a.present, () => html`<span class="bchip changed" title="anchor no longer found (renamed/removed)">lost</span>`,
              () => when(a.stale, () => html`<span class="bchip changed" title="code changed since the bug's witness — re-validate">stale</span>`))))}
      </a>`, a => a.id)}

      ${when(!!b.corroboration.length, () => html`<div class="sec">second opinions (${b.corroboration.length})</div>
        ${each(b.corroboration, c => html`<div class="bcomment">
          <div class="dim"><b>${c.verdict}</b> — ${c.by}${c.via ? ' · ' + c.via : ''}${c.independent ? ' · independent' : ''}</div>
          <div>${c.rationale}</div>
        </div>`, c => c.by + (c.via || ''))}`)}

      ${this.trackEl(b)}
      ${this.threadEl(b)}
    </div>`;
  }
  template() {
    const u = this.props.params.universe, d = this.state.data;
    // `createTask` never rejects — it parks the failure on `task.error`. A page that
    // ignores that shows its spinner forever, which is what this branch is for.
    const err = taskError(this.load);
    if (err || !d) return html`<main>${when(!!err, () => html`<div class="empty">${err}</div>`,
      () => html`<div class="loading">loading…</div>`)}</main>`;
    const counts = d.counts || {};
    const cur = this.props.query.queue ? 'queue' : (this.props.query.state || '');
    const chip = (val, label, n) => html`<button class="${cur === val ? 'on' : ''}" on-click="${() => this.pickState(val)}">${label}${when(n != null, () => html` <span class="n">${n}</span>`)}</button>`;
    const unshared = d.bugs.filter(b => !b.shared).length;
    return html`<main class="wide">
      <div class="crumbs">${u} <span class="sep">·</span> bugs (${d.bugs.length}${cur ? ' shown' : ''})${when(d.shared > 0, () => html` <span class="sep">·</span> ${d.shared} shared`)}</div>
      <div class="dtoggle bugfilter"><span class="dim">state</span>
        ${chip('', 'all')}${chip('queue', 'needs you', d.waitingOnYou)}${each(BUG_STATES, s => chip(s, s, counts[s]), s => s)}
      </div>
      ${when(!!unshared, () => html`<div class="attn-banner">
        <span>${unshared} bug${unshared === 1 ? '' : 's'} ${unshared === 1 ? 'is' : 'are'} only on this machine — filed before the sidecar was configured.</span>
        <button disabled="${this.state.busy === 'publish'}" on-click="${() => this.publish()}">publish to the team</button>
      </div>`)}
      ${when(!!this.state.note && !this.props.query.bug, () => html`<div class="note">${this.state.note}</div>`)}
      <div class="dgrid">
        <div class="dleft">
          ${when(!d.bugs.length, () => html`<div class="dim" style="padding:8px 2px">no bugs${cur ? ' matching “' + cur + '”' : ''} — report them via the <code>report_bug</code> MCP tool, or accept a pull-request finding into one</div>`)}
          ${each(d.bugs, b => this.bugRow(b), b => b.id)}
        </div>
        <div class="dright">${this.detail()}</div>
      </div>
    </main>`;
  }
}
defineComponent('bugs-page', BugsPage);


/**
 * What is pointing at code the working tree no longer has.
 *
 * `/api/orphans` has been served since the sweep was built and nothing consumed it,
 * so the only way to see this was the CLI — which is also what the PR findings
 * panel's `stranded` count pointed at, from inside the browser.
 *
 * `locate` is a button rather than part of the load: it indexes the commit each
 * stranded record names, seconds per commit, and a page must not spend that
 * unasked. What it has NOT checked is on screen either way.
 *
 * @typedef {{ data: ApiMap['/api/orphans'] | null, locating: boolean, kind: string }} OrphansState
 * @extends {Component<PageProps, OrphansState>}
 */
class OrphansPage extends Component {
  static props = { params: {}, query: {} };
  /** @param {PageProps} props */
  constructor(props) {
    super(props);
    /** @type {OrphansState} */
    this.state = { data: null, locating: false, kind: '' };
  }
  load = this.createTask(async () => {
    nav.current = this.props.params.universe;
    this.state.data = await api('/api/orphans', { u: this.props.params.universe });
  });
  mounted() { this.load.run(); }
  propsChanged(name) { if (name === 'params') { this.state.data = null; this.load.run(); } }

  async locate() {
    this.state.locating = true;
    try {
      const got = await api('/api/orphans', { u: this.props.params.universe, locate: '1' }).catch(() => null);
      if (got && !isErr(got)) this.state.data = got;
    } finally { this.state.locating = false; }
  }

  row(x) {
    const u = this.props.params.universe;
    return html`<div class="orow">
      <div class="oloc">
        <code>${x.file ? x.file.split('/').pop() + (x.line ? ':' + x.line : '') : '—'}</code>
        <span class="dim">${x.symbol ? x.symbol.split(' › ').pop() : x.id}</span>
      </div>
      <div class="obody">
        <span class="okind k-${x.kind}">${x.kind}</span>
        <span class="olabel">${x.label}</span>
        ${when(x.posted, () => html`<span class="bchip poss" title="live on pull request #${x.posted.pr} as a review comment — a third party can see it">posted #${x.posted.pr}</span>`)}
        ${when(x.why, () => html`<span class="dim owhy" title="why nothing was found for it">${x.why}</span>`)}
        ${when(x.at, () => html`<span class="dim oat" title="where it was read">${String(x.at).slice(0, 12)}</span>`)}
      </div>
      ${when(x.file && x.symbol, () => html`<a class="ghost" title="open the anchor if this build still has it" href="${href(anchorUrl(u, x.id))}">open</a>`)}
    </div>`;
  }

  group(label, rows, note) {
    const f = this.state.kind;
    const shown = f ? rows.filter(x => x.kind === f) : rows;
    // Reviews are counted, not listed, unless asked for by name: a repository's
    // history necessarily strands `viewed` marks, and hundreds of them would bury
    // the handful of findings that are actually unreachable work.
    const work = f ? shown : shown.filter(x => x.kind !== 'review');
    const marks = shown.length - work.length;
    if (!shown.length) return html``;
    return html`<div class="ogroup">
      <div class="ogh">${label} <b>${shown.length}</b> <span class="dim">${note}</span></div>
      ${each(work, x => this.row(x), x => x.kind + x.ref + x.id)}
      ${when(marks, () => html`<div class="dim orest">…and ${marks} review mark${marks === 1 ? '' : 's'}, not listed — mostly imported history over deleted or renamed code</div>`)}
    </div>`;
  }

  template() {
    const d = this.state.data;
    return pageShell(d, taskError(this.load), () => {
      if (!d.total) return html`<div class="empty">nothing is pointing at missing code.</div>`;
      const l = d.locatable;
      const KINDS = ['annotation', 'bug', 'review'];
      return html`<div class="orphans">
        <div class="ohead">
          <b>${d.total}</b> reference${d.total === 1 ? '' : 's'} to code the working tree does not have
          <span class="ofilters">
            <button class="${this.state.kind ? 'ghost' : 'on'}" on-click="${() => { this.state.kind = ''; }}">all</button>
            ${each(KINDS, k => html`<button class="${this.state.kind === k ? 'on' : 'ghost'}" on-click="${() => { this.state.kind = k; }}">${k}</button>`, k => k)}
          </span>
        </div>
        ${when(l, () => html`<div class="olocate">
          <span>${l.records} of them name a commit${l.notAsked ? ` — ${l.notAsked} not read (cap ${l.cap})` : ''}.</span>
          <button class="on" disabled="${this.state.locating}" title="index each of those commits and say what its id named there — seconds per commit" on-click="${() => this.locate()}">${this.state.locating ? 'reading…' : `read those ${l.commits} commit${l.commits === 1 ? '' : 's'}`}</button>
        </div>`)}
        ${this.group('off-tree', d.offTree, 'exists on a branch — check that ref out, or work against it')}
        ${this.group('retained', d.retained, 'gone from the tree; last known state kept, still re-anchorable')}
        ${this.group('located', d.located || [], 'no copy here, but its own commit still names it')}
        ${this.group('lost', d.lost, 'no copy here, and nothing found')}
      </div>`;
    });
  }
}
defineComponent('orphans-page', OrphansPage);

/**
 * The shared hub — is this universe connected, and what of mine has the team not seen?
 *
 * The two things a browser user could not previously do: JOIN a team (publish the docs,
 * notes and stakes this store already holds) and RECOVER from a fork. Both were terminal
 * commands, while day-to-day review was already on every surface.
 *
 * Counts come from the publish ops' own DRY RUN, never recomputed here — those rules
 * have real exclusions (graph triage never travels; `process` docs are refused; a target
 * the team already answered differently is held back) and a second implementation would
 * drift from what the button does.
 *
 * @typedef {{ d: ApiMap['/api/shared/hub'] | null, busy: string | null, result: any }} HubState
 * @extends {Component<PageProps, HubState>}
 */
class SharedHubPage extends Component {
  static props = { params: {}, query: {} };
  /** @param {PageProps} props */
  constructor(props) {
    super(props);
    /** @type {HubState} */
    this.state = { d: null, busy: null, result: null };
  }
  load = this.createTask(async () => {
    nav.current = this.props.params.universe;
    this.state.d = await api('/api/shared/hub', { u: this.props.params.universe });
  });
  mounted() { this.load.run(); }
  propsChanged() { this.state.d = null; this.state.result = null; this.load.run(); }

  async act(action, label) {
    this.state.busy = action;
    this.state.result = null;
    try {
      const r = await fetch(`/api/shared/${action}`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ u: this.props.params.universe }),
      }).then(x => x.json()).catch(() => ({ error: 'the request did not reach the server' }));
      this.state.result = { label, ...r };
    } finally {
      this.state.busy = null;
      await this.load.run();
    }
  }

  /** One publishable kind. `n` is from the op's dry run, so it is what the button does. */
  kindRow(kind, label, info, action) {
    if (info && info.error) return html`<div class="hubrow"><b>${label}</b> <span class="bad">${info.error}</span></div>`;
    const n = info ? (info.wouldPublish ?? 0) : 0;
    const held = info && info.heldBack ? info.heldBack.length : 0;
    // `skippedGraph` (triage) and `skippedGenerated` (docs, wiring) are the same
    // fact under two names: content every machine regenerates, so it never travels.
    const skipped = info ? (info.skippedGraph ?? info.skippedGenerated ?? 0) : 0;
    return html`<div class="hubrow">
      <b>${label}</b>
      <span class="${n ? 'warn' : 'dim'}">${n} unpublished</span>
      ${when(skipped, () => html`<span class="dim" title="regenerated on every machine, so it never travels">· ${skipped} local-only</span>`)}
      ${when(held, () => html`<span class="warn" title="the team already answered these differently — publishing them would silently supersede a mark nobody compared">· ${held} need a per-target decision</span>`)}
      ${when(n, () => html`<button disabled="${!!this.state.busy}" on-click="${() => this.act(action, label)}">publish ${n}</button>`)}
    </div>`;
  }

  template() {
    const u = this.props.params.universe, d = this.state.d;
    // Narrowed here rather than inside the slots: `when(...)` takes a callback, so TS
    // cannot carry a guard into it, and the ApiMap union has an error arm without any
    // of these fields. That union is the point — it is what fails the build at the page
    // when an op stops returning something.
    const ok = d && !isErr(d) ? d : null;
    return pageShell(d, taskError(this.load), () => html`
      <div class="crumbs">${u} <span class="sep">·</span> shared</div>
      ${when(!ok, () => html`<div class="empty">${(d && d.error) || 'no sidecar configured for this universe'}</div>`)}
      ${when(!!ok, () => html`
        <div class="hubhead">
          <div><span class="dim">sidecar</span> <code>${ok.sidecar}</code></div>
          <div><span class="dim">you</span> ${ok.you || '—'} <span class="sep">·</span>
            <span class="dim">team</span> ${(ok.peers || []).length} <a href="${href(`/u/${u}/shared/0/peers/`)}">peers ›</a></div>
          <button disabled="${!!this.state.busy}" on-click="${() => this.act('sync', 'sync')}">${this.state.busy === 'sync' ? 'syncing…' : 'sync now'}</button>
        </div>

        ${when(!!(ok.prs && ok.prs.length), () => html`
          <div class="hubsec">pull requests with findings</div>
          ${each(ok.prs, p => html`<a class="hubpr" href="${href(`/u/${u}/shared/${p.pr}/`)}">
            <b>PR ${p.pr}</b>
            <span class="dim">${p.total} finding${p.total === 1 ? '' : 's'}</span>
            ${when(!!p.waiting, () => html`<span class="warn">${p.waiting} waiting on a person</span>`)}
            ${when(!!p.unshared, () => html`<span class="dim" title="filed here and not sent to the team">${p.unshared} not shared</span>`)}
            <span class="hubgo">›</span>
          </a>`, p => p.pr)}`)}

        ${when(ok.blocked && ok.blocked.length, () => html`<div class="hubblocked">
          <b class="bad">${ok.blocked.length} scope(s) cannot be read</b>
          ${each(ok.blocked, b => html`<div class="hubrow dim"><code>${b.scope}</code> — ${b.reason}</div>`, b => b.scope)}
          ${when(ok.forked, () => html`<div class="hubheal">
            <b>This sidecar has forked</b> — two clones wrote under one writer id. Repairing unions
            both sides (nothing is discarded), rotates this clone's id and acknowledges the evidence.
            <button class="bad" disabled="${!!this.state.busy}" on-click="${() => this.act('heal', 'repair')}">${this.state.busy === 'heal' ? 'repairing…' : 'repair this fork'}</button>
          </div>`)}
        </div>`)}

        <div class="sec">what the team has not seen</div>
        ${this.kindRow('docs', 'docs', ok.unpublished && ok.unpublished.docs, 'publish_docs')}
        ${this.kindRow('notes', 'notes', ok.unpublished && ok.unpublished.notes, 'publish_notes')}
        ${this.kindRow('triage', 'stakes', ok.unpublished && ok.unpublished.triage, 'publish_triage')}
        ${this.kindRow('graph', 'wiring', ok.unpublished && ok.unpublished.graph, 'publish_graph')}

        ${when(this.state.result, () => html`<div class="hubresult ${this.state.result.error ? 'err' : ''}">
          <b>${this.state.result.label}</b>: ${this.state.result.error || this.state.result.note || 'done'}
        </div>`)}
      `)}
    `);
  }
}
defineComponent('shared-hub-page', SharedHubPage);

const DTAG = { '+': 'added', '-': 'removed', '~': 'changed' };

/**
 * `sel` and `selDoc` are the right-hand selection — one changed symbol, or one
 * doc the change may have staled. Both are entries out of the diff payload, so
 * they are described structurally by what this page reads off them.
 *
 * @typedef {Extract<ApiMap['/api/diff'], { impact: unknown }>} DiffOk
 * @typedef {DiffOk['impact']['nodes'][number]} DiffNode
 * @typedef {DiffOk['changed'][number] & { tag: string }} DiffBrief
 *
 * @typedef {{
 *   snaps: ApiMap['/api/snapshots']['snapshots'] | null,
 *   diff: DiffOk | null,
 *   diffErr: string | null,
 *   sel: DiffBrief | null,
 *   selCode: ApiMap['/api/diff/code'] | null,
 *   codePending: boolean,
 *   view: string,
 *   selDoc: DiffNode | null,
 *   docDiff: ApiMap['/api/diff/doc'] | null,
 *   docPending?: boolean,
 *   modal: boolean,
 * }} DiffState
 * @extends {Component<PageProps, DiffState>}
 */
class DiffPage extends Component {
  static props = { params: {}, query: {} };
  /** @param {PageProps} props */
  constructor(props) {
    super(props);
    /** @type {DiffState} */
    this.state = { snaps: null, diff: null, diffErr: null, sel: null, selCode: null, codePending: false, view: 'doc', selDoc: null, docDiff: null, modal: false };
  }
  // The base/head/sel selection lives entirely in the URL query, so the browser
  // back/forward buttons walk the review history and any drill-down is deep-linkable.
  // `load` (re)fetches the diff when base/head change; a sel-only change just
  // re-resolves the right-hand detail via applySel().
  load = this.createTask(async () => {
    const u = this.props.params.universe; nav.current = u;
    if (!this.state.snaps) this.state.snaps = (await api('/api/snapshots', { u })).snapshots;
    this.state.sel = null; this.state.selCode = null; this.state.selDoc = null; this.state.docDiff = null;
    const base = this.props.query.base;
    const got = base ? await api('/api/diff', { u, base, head: this.props.query.head || '' }) : null;
    this.state.diffErr = isErr(got) ? got.error : null;
    this.state.diff = isErr(got) ? null : got;
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
    if (!type || !id || !this.state.diff) {
      this.state.sel = null; this.state.selCode = null; this.state.selDoc = null; this.state.docDiff = null;
      return;
    }
    if (type === 'doc') await this.loadDoc(id);
    else if (type === 'sym') await this.loadCode(id);
  }
  async loadCode(id) {
    const u = this.props.params.universe, d = this.state.diff;
    const tagged = [
      ...d.changed.map((x) => ({ ...x, tag: '~' })),
      ...d.removed.map((x) => ({ ...x, tag: '-' })),
      ...d.added.map((x) => ({ ...x, tag: '+' })),
    ];
    const b = tagged.find(x => x.id === id) || { id, symbol: id.slice(0, 10), file: '', kind: '', tag: '~' };
    this.state.selDoc = null; this.state.docDiff = null; this.state.sel = b; this.state.selCode = null; this.state.codePending = true;
    try {
      this.state.selCode = await api('/api/diff/code', { u, base: this.props.query.base, head: this.props.query.head || '', id: b.id, file: b.file });
    } finally { this.state.codePending = false; }
  }
  async loadDoc(id) {
    const u = this.props.params.universe;
    const unreviewed = { logical: 'unreviewed', code: 'unreviewed' };
    const n = (this.state.diff.impact.nodes || []).find(x => x.id === id) || {
      id, title: id, type: '', summary: '', anchors: [], status: 'removed', versionCount: 0, severity: '',
      review: { ...unreviewed }, reviewBy: { logical: null, code: null }, reviewVia: {}, viewed: { ...unreviewed },
    };
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
    if (base) {
      const got = await api('/api/diff', { u, base, head: this.props.query.head || '' });
      this.state.diffErr = isErr(got) ? got.error : null;
      this.state.diff = isErr(got) ? null : got;
    }
  }
  async confirmDoc(id) { await postConfirm(this.props.params.universe, id); await this.reloadDiff(); }
  async ackDoc(id) { await postAckHole(this.props.params.universe, id); await this.reloadDiff(); }
  setView(v) { this.state.view = v; }
  briefIndex() { const d = this.state.diff, m = new Map(); for (const b of [...d.changed, ...d.removed, ...d.added]) m.set(b.id, b); return m; }
  docActions(n) {
    return html`${statusChip(n.status)}${sevChip(n.triage || { severity: n.severity, importance: null })}${when(n.versionCount > 1, () => html`<span class="vfork" title="${n.versionCount} versions">⑂${n.versionCount}</span>`)}<span class="ddacts">
      ${when(n.status === 'stale' || n.status === 'unverifiable', () => html`<button title="${n.status === 'unverifiable' ? 're-witness at the current code — its hashes predate a scheme bump, so drift cannot be decided' : 'confirm the doc still holds at this code'}" on-click="${(e) => { if (e.stopPropagation) e.stopPropagation(); this.confirmDoc(n.id); }}">confirm</button>`)}
      ${when(n.status === 'dangling', () => html`<button class="bad" title="cited code was removed here — ack" on-click="${(e) => { if (e.stopPropagation) e.stopPropagation(); this.ackDoc(n.id); }}">ack-hole</button>`)}
      <span class="rev">${this.revBtn('node', n.id, 'logical', n.review.logical, () => this.reloadDiff(), n.reviewBy && n.reviewBy.logical, n.reviewVia && n.reviewVia.logical)}</span></span>`;
  }
  revBtn(kind, id, level, state, after, actor, via) {
    const cls = revCls(state, actor, via);
    const tip = `${level}: ${state}${state === 'reviewed' && actor === 'agent' ? ' (agent-checked)' : ''}${via && VIA_TIP[via] ? VIA_TIP[via] : ''}`;
    return html`<button class="${cls}" title="${tip}" on-click="${async (e) => { if (e.stopPropagation) e.stopPropagation(); await postReview(this.props.params.universe, kind, id, level, state === 'reviewed' && via !== 'unverifiable'); await after(); }}">${level}${revMark(state, actor, via)}</button>`;
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
      <a class="dbugh" href="${href(bugsUrl(u), { bug: bug.id })}">
        <span class="sevdot" style="background:${SEV_COLOR[bug.severity] || SEV_COLOR.medium}" title="severity: ${bug.severity}"></span>
        <span class="dbugt">${bug.title}</span>
        ${when(bug.possiblyFixed, () => html`<span class="bchip poss" title="open bug on code that changed — this diff may fix it">possibly fixed</span>`)}
        ${when(bug.removed, () => html`<span class="bchip changed" title="cited code was removed in this diff">code removed</span>`)}
        <span class="bchip ${bug.status}">${bug.status}</span>
      </a>
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
      <div class="meta"><a class="viewlink" href="${href(nodeUrl(u, n.id))}">open doc ›</a></div>
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
        <a class="viewlink" href="${href(anchorUrl(u, b.id))}">open anchor ›</a></div>
      ${when(c && c.review, () => html`<div class="drev"><span class="dim">mark this change reviewed:</span>
        <span class="rev">${this.revBtn('anchor', b.id, 'logical', c.review.logical, () => this.loadCode(b.id), c.reviewBy && c.reviewBy.logical, c.reviewVia && c.reviewVia.logical)}${this.revBtn('anchor', b.id, 'code', c.review.code, () => this.loadCode(b.id), c.reviewBy && c.reviewBy.code, c.reviewVia && c.reviewVia.code)}</span></div>`)}
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

      ${when(!!this.state.diffErr, () => html`<div class="empty">${this.state.diffErr}</div>`)}
      ${when(!!d, () => html`
        <div class="dsummary">
          <span><b>${d.base.label}</b> <span class="dim">${(d.base.sha || '').slice(0, 8)}</span></span>
          <span class="arrow">→</span>
          <span><b>${d.head.label}</b></span>
          <span class="dcounts"><i class="added">+${d.added.length}</i> <i class="removed">−${d.removed.length}</i> <i class="changed">~${d.changed.length}</i>${when((d.unverifiable || []).length, () => html` <i class="unverifiable" title="indexed by a different grammar or parser build than the base, so a hash difference says nothing about the code — re-snapshot the base to decide it">?${d.unverifiable.length}</i>`)}</span>
        </div>
        ${when((d.unverifiable || []).length, () => html`<div class="dsummary" style="border-top:1px solid #222;padding-top:6px;color:#c8a24a">
          ${d.unverifiable.length} symbol(s) could not be compared — this working tree and the base were
          indexed by different builds, so their hashes are not comparable. Nothing here is a claim that code changed.
        </div>`)}
        ${when(d.coverage && d.coverage.total, () => html`<div class="dsummary" style="border-top:1px solid #222;padding-top:6px">${coverageBar(d.coverage)}</div>`)}

        <div class="dgrid">
          <div class="dleft">
            ${when(d.impact.flows.length, () => html`<div class="sec">flows changed (${d.impact.flows.length})</div>
              ${each(d.impact.flows, f => html`<div class="dflow">
                <a class="dflowt" href="${href(flowUrl(u, f.id))}">⇒ ${f.title}</a>
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
      <a class="dfileh" href="${href(treeUrl(u, g.file))}">${g.file} <span class="dim">${g.items.length}</span></a>
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
function diffReviewLines(c, u, anchorId, lines, lang, startLine, annotations, shared, findings) {
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

// --- PR walkthrough ----------------------------------------------------------
// "Tell me the story of this change." Chapters come from the spec markdown the PR
// itself ships (server: pr-story.ts), each bound to the symbols that implement it
// and ordered command → handler → event → aggregate → read-model. A chapter whose
// spec describes the *system* rather than this change is marked promotable; the
// rest are an executive summary and stay ephemeral.

// Put a symbol on screen after signing the previous one, moving as little as
// possible: the reviewer's eye is already somewhere on the page, so a jump they
// did not ask for costs more attention than a short scroll saves. Three cases —
// it already fits (do nothing), it fits but hangs off an edge (nudge just enough),
// or it is taller than the viewport, where the top is what matters and the
// walkthrough prose introducing it is worth keeping in frame if it can be.
const REVEAL_PAD = 10;          // breathing room under the sticky header
const REVEAL_MIN_READ = 160;    // enough of a too-tall symbol to start reading it
function revealStep(anchorId) {
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
// Exposed for the e2e suite: the rule is geometry against a real viewport.
if (typeof window !== 'undefined') window.__revealStep = revealStep;

const UNCOVERED_ID = '__uncovered';   // the catch-all section, keyed like a chapter

/**
 * Every symbol in the order the PAGE renders it. A walkthrough regroups the derived
 * chapters into features and re-orders them, so advancing along `story.chapters`
 * sent the reviewer to a symbol nowhere near the one they had just signed — a
 * different chapter of a different feature.
 */
function readingOrder(story, steps) {
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
// Exposed for the e2e suite, alongside the scroll rule it feeds.
if (typeof window !== 'undefined') window.__readingOrder = readingOrder;

const CHANGE_COLOR = { added: '#7ee787', changed: '#f0a35e', removed: '#f85149' };
const LAYER_NAME = ['command', 'handler', 'event', 'aggregate', 'read-model', 'job'];

/** @extends {Component<PageProps, PrStoryState>} */
class PrStoryPage extends Component {
  static props = { params: {}, query: {} };
  // Subscribed for one field: whether this universe has a sidecar, so the push/pull
  // control appears only where it means something. Read-tracking makes that reactive —
  // `nav` loads after the first render, and a plain module read would decide "no
  // sidecar" once, before the answer existed, and never revisit it.
  static stores = { nav };
  // Everything this page holds about ONE pull request. `propsChanged` restores it
  // wholesale on a navigation: keeping any of it across PRs is how the previous
  // PR's chapters stayed on screen until the fetch landed, and — worse — how
  // `promoted` marked a chapter "✓ in the map" on a PR that never promoted it,
  // linking to the other PR's node. Chapter ids are `spec-<path>-<heading>` and
  // are NOT PR-scoped, so two pull requests touching one spec file share them.
  /**
   * `promote` and `push` are workflow objects built up across several steps —
   * planned, edited, sent — so their fields are optional by construction rather
   * than by accident.
   *
   * A findings row comes from one of two places, and they are not the same shape:
   * a walkthrough step carries an `Annotation`, while a finding on code the pull
   * request does not touch comes off the review queue and is the only one that
   * knows its own file and symbol — hence the `in` test where those are read.
   *
   * @typedef {import('../dist/schema.js').Annotation} Annotation
   * @typedef {import('../dist/ops.js').QueueItem} QueueItem
   * @typedef {import('../dist/pr-story.js').StoryStep} StoryStep
   * @typedef {import('../dist/pr-story.js').StoryChapter} StoryChapter
   * @typedef {{ f: Annotation | QueueItem, step: StoryStep | null, chapter: StoryChapter | null }} FindingRow
   *
   * @typedef {Exclude<ApiMap['/api/pr/story'], { error: string }>} PrStory
   * @typedef {Extract<ApiMap['/api/pr/promote_plan'], { promotion: unknown }>} PromotePlan
   * @typedef {{ chapter: string, loading?: boolean, error?: string, plan?: PromotePlan['promotion'],
   *   existing?: PromotePlan['existing'], id?: string, title?: string, summary?: string, saving?: boolean }} PromoteState
   * @typedef {{ what: string, loading?: boolean, error?: string, plan?: any,
   *   sending?: boolean, done?: any }} PushState
   *
   * @typedef {FindingFormState & {
   *   story: PrStory | null,
   *   storyErr: string | null,
   *   open: Record<string, boolean>,
   *   code: Record<string, ApiMap['/api/pr/code'] | null>,
   *   pending: Record<string, boolean>,
   *   prRef: string | null,
   *   showDiff: Record<string, boolean>,
   *   promote: PromoteState | null,
   *   promoted: Record<string, unknown>,
   *   showCovered: boolean,
   *   deriving: boolean,
   *   derived: any,
   *   pulling: boolean,
   *   pulled: any,
   *   push: PushState | null,
   *   markError: string | null,
   *   showFindings: boolean,
   *   chapterBusy: Record<string, boolean>,
   *   offStory: ApiMap['/api/pr/findings'] | null,
   *   shared: ApiMap['/api/shared'] | null,
   *   teamOpen: string | null,
   *   pushDraft: { summary: string, event: string } | null,
   *   pick: Set<string> | null,
   *   editFinding: { id: string, comment: string, disposition: string, publishPath?: string } | null,
   *   findingErr: { id: string, error: string } | null,
   *   resolveSync: { loading?: boolean, error?: string, plan?: any, running?: boolean, done?: any, dir?: string } | null,
   *   showElsewhere: boolean,
   *   sharedBusy: boolean,
   *   sharedNote: string | null,
   * }} PrStoryState
   *
   * @returns {PrStoryState}
   */
  static blank() {
    return {
      story: null, storyErr: null, open: {}, code: {}, pending: {}, finding: null, prRef: null, showDiff: {},
      promote: null, promoted: {}, showCovered: false, deriving: false, derived: null,
      pulling: false, pulled: null, push: null, markError: null, showFindings: false, chapterBusy: {},
      offStory: null,
      shared: null,
      teamOpen: null,
      // These five were assigned but never listed here, and `propsChanged` merges
      // rather than replaces — so they were the fields that DID survive a move to
      // another pull request. `pushDraft` is the summary and APPROVE/REQUEST_CHANGES
      // verdict about to be published, and `pick` the findings selected to go with
      // it; both are covered by the push fingerprint. `src/pr-story-state.test.ts`
      // fails if a new field is added without one here.
      pushDraft: null, pick: null, editFinding: null, findingErr: null, resolveSync: null,
      // Other reviews' held-back findings are collapsed by default; this opens them.
      showElsewhere: false,
      sharedBusy: false, sharedNote: null,
    };
  }
  constructor(props) { super(props); this.state = PrStoryPage.blank(); }
  load = this.createTask(async () => {
    const u = this.props.params.universe; nav.current = u;
    const got = await api('/api/pr/story', { u, pr: this.props.params.pr });
    this.state.storyErr = isErr(got) ? got.error : null;
    const story = isErr(got) ? null : got;
    this.state.story = story;
    this.state.prRef = story ? story.refs.head : null;
    // Open the first chapter that still has unsigned work — the queue, not chapter 1.
    if (story && !Object.keys(this.state.open).length) {
      const first = story.chapters.find(c => c.steps.some(s => !this.stepSigned(s)));
      if (first) this.state.open = { [first.id]: true };
    }
    // Expanded code panes carry their own copy of a step's annotations, so a
    // reload that only refreshed the story left a finding you just raised — or
    // just handed to an agent — invisible until the pane was collapsed and
    // reopened. Refresh whatever is open alongside it.
    await this.refreshOpenCode();
    await this.loadShared();
    if (this.state.offStory) await this.loadOffStory();
  });

  /**
   * The team's findings for this pull request, from the canonical table.
   *
   * Loaded with the PAGE and not with the findings panel, because the panel's own
   * button carries the count — and a count that waits for the panel to be opened is
   * how a pull request with ten shared findings displayed `findings (0)`.
   *
   * Read-only here: corroborating, acknowledging and accepting as a bug live on the
   * shared page, and a second copy of that surface is one more thing to keep in step.
   */
  async loadShared() {
    const team = await api('/api/shared', { u: this.props.params.universe, pr: this.props.params.pr }).catch(() => null);
    this.state.shared = isErr(team) ? null : team;
  }

  /**
   * Where a team finding sits, from the story this page already has.
   *
   * The shared view carries the anchor id, not a path — resolving it needs the index,
   * and the walkthrough has already done that for every symbol the pull request
   * touches. A finding on code the PR does not touch resolves to nothing, which is
   * honest: there is no line here to send anybody to.
   */
  teamLoc(f) {
    if (f.target?.kind !== 'anchor') return null;
    for (const c of (this.state.story && this.state.story.chapters) || []) {
      for (const st of c.steps) if (st.anchorId === f.target.id) return { step: st, chapter: c };
    }
    return null;
  }

  /**
   * One team finding, GitHub code-scanning-alert shaped: title on a line of its own,
   * location and provenance muted underneath, evidence behind a click.
   *
   * The whole row is the toggle; the location stops propagation so it can jump to the
   * symbol instead. Reads `comment` for the title because that is the submitter-facing
   * sentence and `text` is the evidence — showing the evidence first is what made every
   * row a wall.
   */
  teamFindingEl(f) {
    const st = this.state;
    const open = st.teamOpen === f.id;
    const loc = this.teamLoc(f);
    const sev = f.severity || 'low';
    return html`<div class="tfind sev-${sev} ${f.tier === 'settled' ? 'tf-settled' : ''} ${open ? 'tf-open' : ''}"
      on-click="${() => { st.teamOpen = open ? null : f.id; }}">
      <div class="tfhead">
        <span class="tfsev">${sev}</span>
        <span class="tftitle">${f.comment || f.text}</span>
      </div>
      <div class="tfmeta">
        ${when(!!loc, () => html`<span class="tfloc" title="open this symbol in the walkthrough"
          on-click="${(e) => { e.stopPropagation(); this.gotoFinding({ f, step: loc.step, chapter: loc.chapter }); }}"
          >${loc.step.file.split('/').pop()}${f.line ? ':' + f.line : ''}</span>`)}
        ${when(!loc, () => html`<span class="dim" title="not on a symbol this pull request changes">not in this diff</span>`)}
        ${when(!!f.category, () => html`<span>${f.category}</span>`)}
        <span>${f.author}${f.authorModel ? ` (${f.authorModel})` : ''}</span>
        ${when(!!f.confirms, () => html`<span class="tfvote ok" title="confirmations">+${f.confirms}</span>`)}
        ${when(!!f.refutes, () => html`<span class="tfvote bad" title="refutations">−${f.refutes}</span>`)}
        ${when(!!f.needsAck, () => html`<span class="warn">needs a person</span>`)}
        ${when(!!REMEDIATION_LABEL_APP[f.remediation], () => html`<span class="prbadge ok" title="${REMEDIATION_LABEL_APP[f.remediation][1]}">${REMEDIATION_LABEL_APP[f.remediation][0]}</span>`)}
        ${when(!!f.pending, () => html`<span class="prbadge ask" title="${f.pending.by} asked for this — ${f.pending.rationale}">${PENDING_LABEL_APP[f.pending.ask] || f.pending.ask} pending</span>`)}
        ${when(!!f.bug, () => html`<span class="dim">kept as a bug</span>`)}
      </div>
      ${when(open, () => html`<div class="tfbody">${f.text}</div>`)}
    </div>`;
  }

  /** Open findings the team holds — the half of the count that is not local. */
  /**
   * Does this universe publish findings to a team?
   *
   * If it does, raw comment push is off — the findings live on the sidecar, and posting
   * them to the branch as well makes the GitHub copy the one people reply to and the
   * sidecar copy the one that goes stale. `planPrPush` and `executePrPush` both enforce
   * it; this only stops the page offering a button that would come back empty.
   *
   * The signal is the shared read's own `universe`, which is null exactly when no
   * sidecar is configured — not a separate flag that could disagree with it.
   */
  hasSidecar() {
    const d = this.state.shared;
    return !!d && !isErr(d) && !!d.universe;
  }

  sharedOpenCount() {
    const d = this.state.shared;
    if (!d || isErr(d)) return 0;
    return d.findings.filter(f => f.tier !== 'settled').length;
  }

  /**
   * Send this store's findings to the team and take theirs, then re-read the page.
   *
   * `sync` here rather than `pull`: a pull request is where you have just written
   * findings FOR the team, so both halves are the point — unlike the chrome's button,
   * which fires from pages that have nothing to do with publishing.
   *
   * `load.run()` rather than a reload: this page holds expanded code panes and an open
   * chapter, and the task already refreshes their annotations alongside the story, so
   * a teammate's arriving finding shows up without throwing away where you were.
   */
  async syncShared() {
    if (this.state.sharedBusy) return;
    this.state.sharedBusy = true;
    this.state.sharedNote = null;
    try {
      const r = await apiPost('/api/shared/sync', { u: this.props.params.universe });
      this.state.sharedNote = r.error
        ?? `received ${r.gained} event(s)${r.pushed ? ', sent yours' : ''}${r.warning ? ` — ${r.warning}` : ''}`;
      if (!r.error) await this.load.run();
    } catch (e) { this.state.sharedNote = errText(e); } finally { this.state.sharedBusy = false; }
  }

  async refreshOpenCode() {
    const open = Object.entries(this.state.code).filter(([, v]) => v && !isErr(v)).map(([id]) => id);
    if (!open.length) return;
    const fresh = { ...this.state.code };
    for (const id of open) {
      try { fresh[id] = await api('/api/pr/code', { u: this.props.params.universe, pr: this.props.params.pr, id }); } catch { /* keep the stale pane rather than blanking it */ }
    }
    this.state.code = fresh;
  }
  mounted() { this.load.run(); }
  propsChanged(name) {
    if (name !== 'params') return;
    // `pageShell`'s contract: a real navigation nulls the page's data so it shows
    // loading and resets scroll, rather than rendering the last PR's content.
    Object.assign(this.state, PrStoryPage.blank());
    // Not reactive, so `blank()` cannot reach them — but they outlive a navigation
    // just the same. A promote plan still in flight would otherwise reopen its form
    // on the NEXT pull request (chapter ids are shared across PRs touching one spec),
    // and an unsent finding draft would follow its anchor across too.
    this._promoteToken = null;
    this._pushToken = null;
    this._fdrafts = {};
    this.load.run();
  }

  toggleChapter(id) { this.state.open = { ...this.state.open, [id]: !this.state.open[id] }; }
  async openStep(step) {
    const id = step.anchorId;
    if (this.state.code[id]) { this.state.code = { ...this.state.code, [id]: null }; return; }
    this.state.pending = { ...this.state.pending, [id]: true };
    try {
      const c = await api('/api/pr/code', { u: this.props.params.universe, pr: this.props.params.pr, id });
      this.state.code = { ...this.state.code, [id]: c };
    } catch (e) {
      // `api()` throws on any non-2xx. Without this the pane cleared `pending`,
      // left `code[id]` undefined and raised an unhandled rejection: "loading
      // source…" flashed and then nothing, which is indistinguishable from a symbol
      // that genuinely has no body.
      this.state.code = { ...this.state.code, [id]: { error: `could not load this symbol's source: ${errText(e)}` } };
    } finally { this.state.pending = { ...this.state.pending, [id]: false }; }
  }
  /**
   * The walkthrough supplies STRUCTURE; the story supplies the STEPS. Every symbol
   * keeps its diff, review state and findings whichever way it is grouped, and a PR
   * nobody has walked yet renders exactly as it did before.
   */
  stepsByAnchor() {
    // Memoised on the story object: `patchStep` replaces it wholesale, so identity
    // is a sound cache key — and this is called per rendered step (for the cover
    // label), which on a 500-symbol pull request is quadratic without it.
    if (this._sbaOf === this.state.story && this._sba) return this._sba;
    const m = new Map();
    for (const c of (this.state.story && this.state.story.chapters) || []) for (const s of c.steps) m.set(s.anchorId, s);
    this._sbaOf = this.state.story; this._sba = m;
    return m;
  }

  /** The symbol a step's mark was borrowed from, named rather than left as an id. */
  coverLabel(step) {
    const by = (step.review && step.review.coveredBy) || (step.viewedMark && step.viewedMark.coveredBy);
    if (!by) return null;
    const owner = this.stepsByAnchor().get(by);
    return owner ? (owner.symbol.split(' › ').pop() || owner.symbol) : null;
  }

  async markChapter(chapterId, attestation, unmark) {
    this.state.chapterBusy = { ...this.state.chapterBusy, [chapterId]: true };
    const res = await fetch('/api/pr/chapter_mark', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ u: this.props.params.universe, pr: this.props.params.pr, chapter: chapterId, attestation, unmark }),
    }).then(x => x.json()).catch(() => null);
    this.state.chapterBusy = { ...this.state.chapterBusy, [chapterId]: false };
    if (!res || res.error) { this.state.markError = (res && res.error) || 'the chapter mark did not reach the server'; return; }
    this.state.markError = null;
    // Patch each symbol from the server's own marks, for the same reason a single
    // sign-off does: the state has nuance (replayed, sitting on a revert) a client
    // must not invent.
    for (const [id, mark] of Object.entries(res.marks || {})) this.patchStep(id, mark);
  }

  walkBlockEl(u, block, steps) {
    if (block.kind === 'prose') return html`<div class="wkprose"><md-content text="${block.text}" untrusted="${true}"></md-content></div>`;
    const step = steps.get(block.anchorId);
    if (!step) return html`<div class="wkprose warn">a symbol this walkthrough cites is no longer in the pull request (${block.anchorId})</div>`;
    return this.stepEl(u, step);
  }

  walkChapterEl(u, ch, steps, stale) {
    const ids = ch.blocks.filter(b => b.kind === 'symbol').map(b => b.anchorId);
    const mine = ids.map(id => steps.get(id)).filter(Boolean);
    const signed = mine.filter(s => this.stepSigned(s)).length;
    const viewed = mine.filter(s => s.viewed).length;
    const busy = !!this.state.chapterBusy[ch.id];
    const open = this.state.open[ch.id] !== false;          // chapters start open — this is the reading order
    return html`<section class="prchapter wkchapter ${stale ? 'stale' : ''}">
      <div class="prchead" on-click="${() => this.toggleChapter(ch.id)}">
        <span class="prtwisty">${open ? '▾' : '▸'}</span>
        <b>${ch.title}</b>
        <span class="dim">${signed}/${mine.length} signed${viewed ? ` · ${viewed} viewed` : ''}</span>
        ${when(stale, () => html`<span class="warn" title="the code this chapter walks has changed since it was written — it needs re-walking">stale</span>`)}
        <span class="wkacts" on-click="${(e) => { if (e.stopPropagation) e.stopPropagation(); }}">
          <button disabled="${busy}" title="mark every symbol in this chapter viewed — a shortcut, the same per-symbol marks underneath" on-click="${() => this.markChapter(ch.id, 'viewed', viewed === mine.length)}">${viewed === mine.length && mine.length ? 'unview all' : 'view all'}</button>
          <button class="on" disabled="${busy}" title="sign off every symbol in this chapter" on-click="${() => this.markChapter(ch.id, 'signed', signed === mine.length)}">${signed === mine.length && mine.length ? 'unsign all' : 'sign all'}</button>
        </span>
      </div>
      ${when(open, () => html`<div class="prcbody">${each(ch.blocks, (b, i) => this.walkBlockEl(u, b, steps), (b, i) => b.kind === 'symbol' ? 's' + b.anchorId : 'p' + i)}</div>`)}
    </section>`;
  }

  walkthroughEl(u, st) {
    const w = st.walkthrough;
    const steps = this.stepsByAnchor();
    const stale = new Set(w.stale || []);
    const uncovered = (w.coverage && w.coverage.uncovered) || [];
    return html`
      ${when(!!w.sharedBy, () => html`<div class="wkbanner wkteam">Read from <b>${w.sharedBy}</b>'s walkthrough of this pull request, from the team's sidecar — not one written here.${when((w.otherReadings || []).length > 0, () => html` <span class="dim">${(w.otherReadings || []).length} other reading(s): ${(w.otherReadings || []).map(o => o.mine ? 'yours' : o.by).join(', ')}.</span>`)}</div>`)}
      ${when(!w.sharedBy && (w.otherReadings || []).length > 0, () => html`<div class="wkbanner dim">Your own walkthrough. ${(w.otherReadings || []).length} other reading(s) of this pull request: ${(w.otherReadings || []).map(o => o.by).join(', ')}.</div>`)}
      ${when(w.headMoved, () => html`<div class="warn wkbanner">This walkthrough was written against a different commit (${String(w.head).slice(0, 12)}). Every chapter is suspect — ask an agent to re-walk the pull request.</div>`)}
      ${each(w.features, f => html`<section class="wkfeature">
        <div class="wkfhead">
          <b>${f.title}</b>
          ${when(f.unstated, () => html`<span class="wkunstated" title="not part of this pull request's stated purpose — a drive-by the agent found and named">not in the spec</span>`)}
          <span class="dim">${f.chapters.length} chapter(s)</span>
        </div>
        <div class="wkfsummary"><md-content text="${f.summary}" untrusted="${true}"></md-content></div>
        ${each(f.chapters, c => this.walkChapterEl(u, c, steps, stale.has(c.id)), c => c.id)}
      </section>`, f => f.id)}
      ${when(uncovered.length, () => html`<section class="prchapter wkuncovered">
        <div class="prchead" on-click="${() => this.toggleChapter(UNCOVERED_ID)}">
          <span class="prtwisty">${this.state.open[UNCOVERED_ID] ? '▾' : '▸'}</span>
          <b>Not in the walkthrough</b>
          <span class="dim">${uncovered.length} symbol(s)</span>
          <span class="warn" title="nothing here has been explained — this is what you would end up reading on GitHub, unviewed and without context">unaccounted for</span>
        </div>
        ${when(this.state.open[UNCOVERED_ID], () => html`<div class="prcbody">${each(uncovered.filter(id => steps.get(id)), id => this.stepEl(u, steps.get(id)), id => id)}</div>`)}
      </section>`)}`;
  }

  walkOrder() { return readingOrder(this.state.story, this.stepsByAnchor()); }

  /**
   * Done with this symbol. `step.reviewed` alone is not it: an unverifiable
   * sign-off is `reviewed` server-side (see `isUnverifiable`) yet vouches for a
   * body this build cannot compare, so counting it as signed advances the
   * walkthrough past the one symbol that still wants a click.
   */
  stepSigned(step) { return !!step && step.reviewed && !isUnverifiable(step.review); }

  /** The next symbol still needing attention, in reading order. */
  nextUnsignedAfter(anchorId, flat = this.walkOrder()) {
    const i = flat.findIndex(x => x.step.anchorId === anchorId);
    if (i < 0) return null;
    return flat.slice(i + 1).find(x => !this.stepSigned(x.step)) || null;
  }

  /**
   * Update one symbol's findings in place — the walkthrough's half of the fast
   * path for raising, handing off, resolving and raising to the maintainer.
   * Returns true when it handled it, so the caller can skip the story reload.
   */
  patchAnnotations(anchorId, annotations) {
    const st = this.state.story;
    if (!st) return false;
    // A finding on a symbol the pull request does not touch sits in no chapter, so
    // there is nothing here to patch — and claiming otherwise skipped the reload
    // that would have shown the write. Resolving one looked like a dead button.
    if (!st.chapters.some(c => c.steps.some(s => s.anchorId === anchorId))) return false;
    this.state.story = { ...st, chapters: st.chapters.map(c => (
      c.steps.some(s => s.anchorId === anchorId)
        ? { ...c, steps: c.steps.map(s => s.anchorId === anchorId ? { ...s, annotations } : s) }
        : c
    )) };
    // The open code pane renders findings from its OWN copy, so it needs the same
    // update or the finding appears in the header count and nowhere else.
    const code = this.state.code[anchorId];
    if (code) this.state.code = { ...this.state.code, [anchorId]: { ...code, annotations } };
    return true;
  }

  /** Update one symbol in the loaded story, leaving everything else alone. */
  patchStep(id, mark) {
    const st = this.state.story;
    if (!st || !mark) return;
    this.state.story = { ...st, chapters: st.chapters.map(c => (
      c.steps.some(s => s.anchorId === id)
        ? { ...c, steps: c.steps.map(s => s.anchorId === id ? { ...s, ...mark, anchorId: s.anchorId } : s) }
        : c
    )) };
  }

  async markStep(step, attestation, state, actor, via) {
    const id = step.anchorId;
    const unmark = unmarkOn(state, actor, via);
    // No story reload. Re-deriving the whole pull request to learn one symbol's new
    // state is seconds of work on a big PR; the write hands the resulting marks back,
    // and they are the SERVER's marks rather than a guess — the state has nuance
    // (replayed, sitting on a revert, covered by a container) the client has no
    // business inventing. Several come back because signing a symbol also signs what
    // this pull request changed inside it.
    const res = await fetch('/api/pr/step_mark', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ u: this.props.params.universe, pr: this.props.params.pr, id, attestation, unmark }),
    }).then(r => r.json()).catch(() => null);
    if (!res || res.error) { this.state.markError = (res && res.error) || 'the sign-off did not reach the server'; return; }
    this.state.markError = null;
    for (const [mid, mark] of Object.entries(res.marks || {})) this.patchStep(mid, mark);
    // Taking a sign-off back is a correction, not progress — stay put. (The code
    // pane is not re-fetched either way: signing changes review state, not the
    // source or its annotations.)
    if (unmark) return;

    // Signing is the "done with this one" gesture, so move the walkthrough on:
    // collapse what was just signed, and open the next symbol still needing
    // attention rather than making the reviewer hunt for it.
    const flat = this.walkOrder();
    const next = this.nextUnsignedAfter(id, flat);
    const code = { ...this.state.code, [id]: null };
    const open = { ...this.state.open };
    const here = flat.find(x => x.step.anchorId === id);
    const mine = here ? flat.filter(x => x.chapter.id === here.chapter.id) : [];
    if (here && here.chapter.id !== UNCOVERED_ID && mine.every(x => this.stepSigned(x.step)))
      open[here.chapter.id] = false;                                       // chapter finished — fold it away
    if (next) open[next.chapter.id] = true;
    this.state.code = code;
    this.state.open = open;
    if (!next) return;
    if (!this.state.code[next.step.anchorId]) await this.openStep(next.step);
    // Bring it into view if it is not already there — the previous symbol collapsing
    // often leaves the next one off-screen, and the point of advancing is not having
    // to go looking for it. A frame after the state change, so vdx has rendered the
    // row being measured.
    requestAnimationFrame(() => revealStep(next.step.anchorId));
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

  // Publishing to GitHub is two steps, always. The first shows exactly what would
  // leave the machine; nothing is sent until the second. `what` is 'comments' or
  // 'viewed' — different acts: comments argue for a change and notify the author,
  // viewed state only says which files someone read.
  async openPush(what) {
    if (this.state.push && this.state.push.what === what) { this._pushToken = null; this.state.push = null; return; }
    // Same token guard as `openPromote`, and for the same reason: the toggle-off
    // check runs against state the in-flight request will overwrite, so a dismissed
    // panel reopened when the response landed. Clicking "comments" then "viewed"
    // hits one endpoint, so without this the later click could be overwritten by the
    // earlier response — on the one surface that writes to somebody else's repo.
    const token = Symbol('push');
    this._pushToken = token;
    this.state.push = { what, loading: true };
    // `api()` throws on any non-2xx; with no catch the panel sat on "working out
    // what would be sent…" for ever and the rejection went unhandled.
    const draft = this.state.pushDraft || { summary: '', event: 'COMMENT' };
    const r = await apiPost('/api/pr/push_plan', {
      u: this.props.params.universe, pr: this.props.params.pr,
      summary: draft.summary || undefined, event: draft.event,
      ids: [...(this.state.pick || [])],
    }).catch((e) => ({ error: `could not work out what would be sent: ${e && e.message ? e.message : e}` }));
    if (this._pushToken !== token) return;
    if (r.error) { this.state.push = { what, error: r.error }; return; }
    this.state.push = { what, plan: r };
  }

  /**
   * Re-plan whenever the summary or the verdict changes.
   *
   * The plan's fingerprint covers both, so the server refuses a publish whose text
   * differs from the one on screen. Re-planning is what keeps the preview and the
   * publish the same document rather than two that agree by luck.
   */
  async repushPlan(patch) {
    this.state.pushDraft = { ...(this.state.pushDraft || { summary: '', event: 'COMMENT' }), ...patch };
    const p = this.state.push;
    if (!p || !p.plan) return;
    clearTimeout(this._pushPlanTimer);
    this._pushPlanTimer = setTimeout(() => {
      const what = this.state.push && this.state.push.what;
      if (what) this.openPushRefresh(what);
    }, 250);
  }
  async openPushRefresh(what) {
    const token = Symbol('push');
    this._pushToken = token;
    const draft = this.state.pushDraft || { summary: '', event: 'COMMENT' };
    const r = await apiPost('/api/pr/push_plan', {
      u: this.props.params.universe, pr: this.props.params.pr,
      summary: draft.summary || undefined, event: draft.event,
      ids: [...(this.state.pick || [])],
    }).catch((e) => ({ error: `could not work out what would be sent: ${e && e.message ? e.message : e}` }));
    if (this._pushToken !== token) return;
    if (r.error) { this.state.push = { what, error: r.error }; return; }
    this.state.push = { what, plan: r };
  }
  async confirmPush() {
    const p = this.state.push;
    if (!p || !p.plan || p.sending) return;
    this.state.push = { ...p, sending: true };
    const res = await fetch('/api/pr/push', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        u: this.props.params.universe, pr: this.props.params.pr,
        // The fingerprint of the plan on screen. If anything moved since, the server
        // refuses rather than publishing something nobody read.
        fingerprint: p.plan.fingerprint,
        comments: p.what === 'comments',
        markViewed: p.what === 'viewed',
        summary: (this.state.pushDraft && this.state.pushDraft.summary) || undefined,
        event: (this.state.pushDraft && this.state.pushDraft.event) || 'COMMENT',
        ids: [...(this.state.pick || [])],
      }),
    }).then(x => x.json());
    if (res.error) { this.state.push = { ...p, sending: false, error: res.error }; return; }
    this.state.push = { ...p, sending: false, done: res };
    await this.load.run();
  }

  async openPromote(ch) {
    // Toggling off also invalidates any plan still in flight for it.
    if (this.state.promote && this.state.promote.chapter === ch.id) { this._promoteToken = null; this.state.promote = null; return; }
    // A token, because the toggle-off check runs against state the in-flight
    // request is about to overwrite: two quick clicks closed the form, then the
    // first response reassigned `promote` and reopened one the user had dismissed.
    const token = Symbol('promote');
    this._promoteToken = token;
    this.state.promote = { chapter: ch.id, loading: true };
    const r = await api('/api/pr/promote_plan', { u: this.props.params.universe, pr: this.props.params.pr, chapter: ch.id })
      .catch((e) => ({ error: `could not plan the promotion: ${e && e.message ? e.message : e}` }));
    if (this._promoteToken !== token) return;                       // superseded or dismissed
    if ('error' in r) { this.state.promote = { chapter: ch.id, error: r.error }; return; }
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
  /**
   * Every finding on this pull request, in one place.
   *
   * Raising an agent's finding to the maintainer and resolving one are decisions
   * about a LIST — "which of these do I stand behind?" — but the only place to make
   * them was inside an expanded symbol's code pane, which meant opening each symbol
   * in turn to find them. Grouped by what the push would do with them, because that
   * is the question being answered.
   */
  togglePick(id) {
    const next = new Set(this.state.pick || []);
    if (next.has(id)) next.delete(id); else next.add(id);
    this.state.pick = next;
  }

  /** Opening the list also loads the findings the story cannot show. */
  async toggleFindings() {
    this.state.showFindings = !this.state.showFindings;
    if (!this.state.showFindings || this.state.offStory) return;
    await this.loadOffStory();
  }

  /**
   * `load` has to refresh these too: every write on an off-story row falls back to a
   * story reload, and leaving this frozen meant resolving or withdrawing an orphan
   * changed nothing on screen.
   */
  async loadOffStory() {
    // `null` on failure rather than a stub: a `{ findings: [] }` of our own is a
    // different shape from the real reply, and reading rows off that union is what
    // made every row here untyped.
    const got = await api('/api/pr/findings', { u: this.props.params.universe, pr: this.props.params.pr }).catch(() => null);
    this.state.offStory = isErr(got) ? null : got;
  }

  /**
   * Findings this pull request owns that sit on no symbol in it. Which those are is
   * `prOffStoryFindings`'s decision, not this page's — the test that used to live
   * here ("is the target missing?") is true of every orphan on the map.
   *
   * @returns {FindingRow[]}
   */
  offStoryFindings() {
    const rows = (this.state.offStory && this.state.offStory.findings) || [];
    return rows.map(q => ({ f: q, step: null, chapter: null }));
  }

  /** @returns {FindingRow[]} */
  allFindings() {
    /** @type {FindingRow[]} */
    const out = [];
    for (const c of (this.state.story && this.state.story.chapters) || []) {
      for (const st of c.steps) {
        for (const f of st.annotations || []) {
          // Every kind, not just findings. Pointers were filtered out here and so
          // were never OFFERED for publishing — six of them on the first real batch
          // had been investigated, confirmed and given submitter-facing text, and
          // the highest-rated item in the whole review was invisible. What triage
          // concluded is what decides; the kind it was filed under is history.
          if (f.kind === 'note') continue;
          out.push({ f, step: st, chapter: c });
        }
      }
    }
    const rank = { critical: 0, high: 1, medium: 2, low: 3 };
    return out.sort((a, b) => (rank[a.f.severity] ?? 4) - (rank[b.f.severity] ?? 4)
      || a.step.file.localeCompare(b.step.file) || (a.f.line || 0) - (b.f.line || 0));
  }

  /** Open the symbol a finding sits on and put it on screen. */
  async gotoFinding(entry) {
    this.state.open = { ...this.state.open, [entry.chapter.id]: true };
    if (!this.state.code[entry.step.anchorId]) await this.openStep(entry.step);
    requestAnimationFrame(() => document.getElementById(`step-${entry.step.anchorId}`)?.scrollIntoView({ block: 'start', behavior: 'smooth' }));
  }

  /**
   * The findings list, grouped by WHAT WILL HAPPEN TO EACH rather than by who wrote
   * it. The question this panel exists to answer is "what goes to the submitter when
   * I press push", and the reasons one does not are the actionable part: a missing
   * comment is one edit away, a disposition nobody set is one click.
   */
  findingsPanelEl(u) {
    if (!this.state.showFindings) return html``;
    const all = this.allFindings();
    const off = this.offStoryFindings();
    const team = (this.state.shared && !isErr(this.state.shared) && this.state.shared.findings) || [];
    // They used to be listed here, on every pull request alike. A count is not a
    // workflow — `/api/orphans` has no page yet — but it keeps them from going back
    // to being found one at a time by tripping over them.
    const stray = (this.state.offStory && this.state.offStory.stranded) || 0;
    const strayEl = () => html`<div class="prfstray dim" title="open findings whose target is not in the working tree, posted to no pull request and settled by nobody — a rename, another branch, or code that is simply gone">
      ${stray} open finding${stray === 1 ? ' points' : 's point'} at code no longer in the tree and belong${stray === 1 ? 's' : ''} to no pull request — <code>codemap orphans</code>
    </div>`;
    // `team` counts here too. It did not, and the guard fired first: a pull request
    // with ten shared findings and no local ones rendered "No findings raised on this
    // pull request yet" over the top of them, which is the sentence this whole change
    // exists to stop being printed.
    if (!all.length && !off.length && !team.length) return html`<div class="prfindings dim">No findings raised on this pull request yet.${when(stray, strayEl)}</div>`;
    const live = all.filter(e => !e.f.resolved && !e.f.withdrawn && !e.f.postedRef);
    const elected = live.filter(e => !isAgentFinding(e.f) || e.f.escalated);
    // An orphan you resolve or withdraw leaves the orphan group by the same route an
    // on-story finding does. Left in, the group asking for a publish path went on
    // counting the ones already dealt with, which is the same as not resolving them.
    const settled = all.concat(off.filter(e => e.f.resolved || e.f.withdrawn));
    /** @type {[label: string, rows: FindingRow[]][]} */
    const allGroups = [
      ['not on a symbol this pull request changes — these need a publish path, or their code is gone', off.filter(e => !e.f.resolved && !e.f.withdrawn)],
      ['goes out on the next push', elected.filter(e => PUBLISHABLE.has(e.f.disposition) && (e.f.comment || '').trim())],
      ['needs the submitter-facing version before it can go', elected.filter(e => PUBLISHABLE.has(e.f.disposition) && !(e.f.comment || '').trim())],
      ['nobody has said what this turned out to be — set a disposition', elected.filter(e => !e.f.disposition || e.f.disposition === 'open')],
      ['held back: refuted or accepted — publish one deliberately if it closes a concern out', elected.filter(e => e.f.disposition === 'refuted' || e.f.disposition === 'accepted')],
      ['an agent\'s — raise one to include it', live.filter(e => isAgentFinding(e.f) && !e.f.escalated)],
      ['already on the pull request', all.filter(e => e.f.postedRef)],
      ['withdrawn — kept here, not sent', settled.filter(e => e.f.withdrawn && !e.f.resolved)],
      ['resolved locally — not sent', settled.filter(e => e.f.resolved)],
    ];
    const groups = allGroups.filter(g => g[1].length);
    const picked = [...(this.state.pick || [])];
    return html`<div class="prfindings">
      ${when(!!team.length, () => html`<div class="prfgroup">
        <div class="prfgh">the team's, on the sidecar <b>${team.length}</b>
          <a href="#/u/${u}/shared/${this.props.params.pr}/">open shared review ›</a></div>
        ${each(team, f => this.teamFindingEl(f), f => f.id)}
      </div>`)}
      ${when(picked.length, () => html`<div class="prfpicked">
        <b>${picked.length}</b> picked — publishing these sends exactly them, whatever their disposition.
        <button class="on" on-click="${() => this.openPush('comments')}">review what would be sent</button>
        <button class="ghost" on-click="${() => { this.state.pick = new Set(); }}">clear</button>
      </div>`)}
      ${when(stray, strayEl)}
      ${each(groups, g => html`<div class="prfgroup">
        <div class="prfgh">${g[0]} <b>${g[1].length}</b></div>
        ${each(g[1], e => html`<div class="prfrow">
          ${when(e.step, () => html`<div class="prfloc" title="open this symbol" on-click="${() => this.gotoFinding(e)}">
            <code>${e.step.file.split('/').pop()}${e.f.line ? ':' + e.f.line : ''}</code>
            <span class="dim">${e.step.symbol.split(' › ').pop()}</span>
          </div>`)}
          ${when(!e.step, () => html`<div class="prfloc dim" title="not on a symbol this pull request changes — there is nothing here to open">
            <code>${('file' in e.f && e.f.file || '?').split('/').pop()}${e.f.line ? ':' + e.f.line : ''}</code>
            <span>${('symbol' in e.f && e.f.symbol || '').split(' › ').pop()}</span>
          </div>`)}
          <div class="prfbody">
            ${findingItemEl(this, u, e.f)}
            ${this.findingEditorEl(u, e.f)}
          </div>
          ${when(!e.f.resolved && !e.f.postedRef, () => html`<label class="prfpick" title="publish exactly the picked findings, whatever their disposition — this is how a refutation worth closing out gets sent">
            <input type="checkbox" checked="${this.state.pick && this.state.pick.has(e.f.id)}" on-change="${() => this.togglePick(e.f.id)}">
          </label>`)}
        </div>`, e => e.f.id)}
      </div>`, g => g[0])}
    </div>`;
  }

  /**
   * Editing the half the submitter reads.
   *
   * Two fields, kept apart on screen because they are two documents: `text` is the
   * evidence and stays on the map, `comment` is what the person fixing it reads. The
   * character count is live because the cap is REFUSED rather than trimmed — finding
   * that out on save, having written 1,400 characters, is the wrong time.
   */
  findingEditorEl(u, f) {
    const ed = this.state.editFinding;
    const err = this.state.findingErr && this.state.findingErr.id === f.id ? this.state.findingErr.error : null;
    if (!ed || ed.id !== f.id) {
      return html`<div class="prfcmt">
        ${when(f.comment, () => html`<span class="prfcmttext" title="what the submitter reads">${f.comment}</span>`)}
        ${when(!f.comment, () => html`<span class="dim">no submitter-facing version yet</span>`)}
        ${when(f.kind && f.kind !== 'finding', () => html`<span class="prfkind" title="filed as a ${f.kind}. What triage concluded is what decides whether it goes out.">${f.kind}</span>`)}
        <span class="prfdisp d-${f.disposition || 'open'}">${f.disposition || 'open'}</span>
        ${when(f.targetResolved === false, () => html`<span class="warn" title="the code this points at is not in the working tree${f.targetAt ? ' — last seen at ' + f.targetAt : ' and was not retained'}. It cannot be placed on the diff; set a publish path.">⚠ target gone</span>`)}
        ${when(f.publishPath, () => html`<span class="dim" title="published against this file, because the code it is about is not in the diff">→ <code>${f.publishPath}</code></span>`)}
        ${when(f.withdrawn && f.withdrawn.reason, () => html`<span class="dim" title="withdrawn by ${f.withdrawn.by}">withdrawn: ${f.withdrawn.reason}</span>`)}
        ${when(f.revisions && f.revisions.length, () => html`<span class="dim" title="${f.revisions.map(r => `${r.at.slice(0, 10)} ${r.by}`).join('\n')}">· revised ${f.revisions.length}×</span>`)}
        <button class="ghost" on-click="${() => { this.state.findingErr = null; this.state.editFinding = { id: f.id, comment: f.comment || '', disposition: f.disposition || 'open', publishPath: f.publishPath || '' }; }}">✎ edit</button>
        ${when(!f.resolved && !f.postedRef, () => html`<button class="ghost" title="${f.withdrawn ? 'put it back in the batch' : 'decide against sending this one. It stays on the map; you will be asked why.'}" on-click="${() => {
          if (f.withdrawn) return withdrawFinding(this, u, f.id, false, null);
          // Asked for, not required: "withdrawn" with no reason is indistinguishable
          // from "forgotten", and the usual reason names what superseded it.
          const reason = prompt('Why is this not going out? (e.g. "duplicate of finding_x, already on the PR")') ;
          if (reason !== null) withdrawFinding(this, u, f.id, true, reason);
        }}">${f.withdrawn ? 'un-withdraw' : 'withdraw'}</button>`)}
      </div>`;
    }
    const over = ed.comment.length > 800;
    return html`<div class="prfedit">
      <label>what the submitter reads <span class="${over ? 'warn' : 'dim'}">${ed.comment.length}/800</span>
        <textarea rows="3" placeholder="What is broken (one sentence, as a defect). Where — file:line and the smallest quote that proves it. The ask." value="${ed.comment}"
          on-input="${(e) => { this.state.editFinding = { ...this.state.editFinding, comment: e.target.value }; }}"></textarea></label>
      <div class="prfeditrow">
        <label>disposition
          <select on-change="${(e) => { this.state.editFinding = { ...this.state.editFinding, disposition: e.target.value }; }}">
            ${each(DISPOSITIONS, d => html`<option value="${d}" selected="${ed.disposition === d}">${d}</option>`, d => d)}
          </select></label>
        <label title="only when this is about code the pull request does not touch: the file IN THE DIFF nearest to the problem. GitHub takes a comment nowhere else."
          >publish on <input placeholder="(same file as the symbol)" value="${ed.publishPath}"
          on-input="${(e) => { this.state.editFinding = { ...this.state.editFinding, publishPath: e.target.value }; }}"></label>
      </div>
      ${when(err, () => html`<div class="warn">${err}</div>`)}
      <div class="prfeditacts">
        <button class="on" disabled="${over}" on-click="${async () => {
          const patch = { comment: ed.comment, disposition: ed.disposition, publishPath: ed.publishPath };
          this.state.editFinding = null;
          await reviseFinding(this, u, f.id, patch);
        }}">save</button>
        <button class="ghost" on-click="${() => { this.state.findingErr = null; this.state.editFinding = null; }}">cancel</button>
      </div>
    </div>`;
  }

  /**
   * The reviewer's own words, and their verdict.
   *
   * The generated body says how much was signed and which lanes it landed in. That
   * is context, not feedback — without somewhere to say what you actually think of
   * the change, your verdict had to go somewhere other than the tool holding the
   * review. Both re-plan on change, so the preview and the publish are one document.
   */
  pushSummaryEl() {
    const d = this.state.pushDraft || { summary: '', event: 'COMMENT' };
    return html`<div class="pushsum">
      <label>your summary, to the author <span class="dim">— goes above the stats, in your words</span>
        <textarea rows="4" placeholder="What you make of this change overall. Blocking concerns, what you checked, what you are trusting." value="${d.summary}"
          on-input="${(e) => this.repushPlan({ summary: e.target.value })}"></textarea></label>
      <div class="pushevent">
        ${each(REVIEW_EVENTS, ev => html`<label class="${d.event === ev.id ? 'on' : ''}" title="${ev.why}">
          <input type="radio" name="pushevent" checked="${d.event === ev.id}" on-change="${() => this.repushPlan({ event: ev.id })}"> ${ev.label}
        </label>`, ev => ev.id)}
      </div>
    </div>`;
  }

  async openResolveSync() {
    if (this.state.resolveSync) { this._syncToken = null; this.state.resolveSync = null; return; }
    const token = Symbol('sync');
    this._syncToken = token;
    this.state.resolveSync = { loading: true };
    const r = await apiPost('/api/pr/resolve_plan', { u: this.props.params.universe, pr: this.props.params.pr })
      .catch((e) => ({ error: `could not read the pull request's conversations: ${e && e.message ? e.message : e}` }));
    if (this._syncToken !== token) return;
    this.state.resolveSync = r.error ? { error: r.error } : { plan: r };
  }

  async runResolveSync(dir, anyone) {
    const st = this.state.resolveSync;
    if (!st || !st.plan || st.running) return;
    this.state.resolveSync = { ...st, running: true };
    const r = await apiPost(`/api/pr/resolve_${dir}`, { u: this.props.params.universe, pr: this.props.params.pr, anyone })
      .catch((e) => ({ error: String(e && e.message ? e.message : e) }));
    this.state.resolveSync = r.error ? { error: r.error } : { plan: r.plan, done: r.result, dir };
  }

  /**
   * Which conversations are settled, on each side.
   *
   * The two directions are deliberately separate buttons: closing threads on
   * somebody else's pull request and recording their resolutions as your own
   * agreement are different acts, and only one of them is outward-facing.
   */
  resolveSyncEl() {
    const st = this.state.resolveSync;
    if (!st) return html``;
    if (st.error) return html`<div class="prpromo err">${st.error}</div>`;
    if (!st.plan) return html`<div class="prpromo dim">reading the pull request's conversations…</div>`;
    if (st.done) {
      const d = st.done;
      return html`<div class="prpromo">
        <div><b>Synced.</b> ${st.dir === 'push' ? `${d.resolved.length} conversation(s) resolved on GitHub` : `${d.closed.length} finding(s) closed here`}</div>
        ${each(d.skipped || [], s => html`<div class="warn">${s.why}</div>`, s => s.annotationId)}
        ${each(d.errors || [], e => html`<div class="warn">${e}</div>`, (e, i) => String(i))}
        <div class="prpromoacts"><button class="ghost" on-click="${() => { this.state.resolveSync = null; }}">close</button></div>
      </div>`;
    }
    const p = st.plan;
    return html`<div class="prpromo">
      <div><b>${p.inSync}</b> conversation(s) already agree.</div>
      ${when(p.toResolve.length, () => html`
        <div class="pushblocked">
          <b>${p.toResolve.length} settled here, still open on the pull request</b> — the submitter's threads stay open until someone closes them.
          ${each(p.toResolve, t => html`<div class="pushrow"><code>${t.path || '?'}${t.line ? ':' + t.line : ''}</code> <span class="dim">${t.label}</span></div>`, t => t.annotationId)}
          <div class="prpromoacts"><button class="on" disabled="${!!st.running}" on-click="${() => this.runResolveSync('push', false)}">resolve these on GitHub</button></div>
        </div>`)}
      ${when(p.toClose.length, () => html`
        <div class="pushblocked">
          <b>${p.toClose.length} resolved on the pull request, still open here</b>
          ${each(p.toClose, t => html`<div class="pushrow"><span class="dim">by ${t.resolvedBy || '?'}</span> ${t.label}</div>`, t => t.annotationId)}
          <div class="prpromoacts">
            <button class="on" disabled="${!!st.running}" on-click="${() => this.runResolveSync('pull', false)}">close the ones you resolved</button>
            <button class="ghost" disabled="${!!st.running}" on-click="${() => this.runResolveSync('pull', true)}" title="including ones the pull request's author resolved — their click is not your agreement, so this is deliberate">accept anyone's</button>
          </div>
        </div>`)}
      ${when(p.unmatched.length, () => html`<div class="dim">${p.unmatched.length} posted finding(s) have no thread on this pull request any more.</div>`)}
      <div class="prpromoacts"><button class="ghost" on-click="${() => { this.state.resolveSync = null; }}">close</button></div>
    </div>`;
  }

  // What would leave the machine, before anything does. Deliberately verbose: this
  // is the one surface in codemap that writes to somebody else's repository.
  pushPanelEl() {
    const p = this.state.push;
    if (!p) return html``;
    if (p.error) return html`<div class="prpromo err">${p.error}</div>`;
    if (!p.plan) return html`<div class="prpromo dim">working out what would be sent…</div>`;
    if (p.done) {
      const d = p.done;
      return html`<div class="prpromo">
        <div><b>Sent.</b> ${when(d.result.postedComments, () => html`${d.result.postedComments} inline comment(s)`)}${when(d.result.reviewUrl, () => html` · <a href="${d.result.reviewUrl}" target="_blank" rel="noreferrer">open the review ↗</a>`)}
        ${when(d.result.markedViewed.length, () => html`${d.result.markedViewed.length} file(s) ticked viewed`)}</div>
        ${each(d.result.errors || [], e => html`<div class="warn">${e}</div>`, (e, i) => String(i))}
        <div class="prpromoacts"><button class="ghost" on-click="${() => { this.state.push = null; }}">close</button></div>
      </div>`;
    }
    const plan = p.plan, sk = plan.skipped;
    const comments = p.what === 'comments';
    // The comment half is off (a sidecar publishes findings), so this modal is the
    // SIGN-OFF push and nothing else: your summary and your verdict. Everything below
    // describes what would be posted as comments, which is now nothing — showing the
    // held-back counts here would be answering a question nobody asked.
    const verdictOnly = comments && !!plan.commentPush;
    return html`<div class="prpromo">
      ${when(verdictOnly, () => html`
        <div>Your verdict and summary go to <a href="${plan.pr.url}" target="_blank" rel="noreferrer">#${plan.pr.number}</a>.
          <span class="dim">Findings are not posted as comments — ${plan.commentPush.why}</span></div>
        ${this.pushSummaryEl()}`)}
      ${when(comments && !verdictOnly, () => html`
        <div><b>${plan.comments.length}</b> inline comment(s)${plan.deferred.length ? `, ${plan.deferred.length} folded into the review body (their line is not in the diff)` : ''} would go to <a href="${plan.pr.url}" target="_blank" rel="noreferrer">#${plan.pr.number}</a>.</div>
        ${this.pushSummaryEl()}
        ${each(plan.comments, c => html`<div class="pushrow">
          <code>${c.path}:${c.line}</code> <span class="dim">${c.body.split('\n')[0]}</span>
          ${when(c.citesLine, () => html`<span class="warn" title="the comment's own text points at a different line — check it before posting; GitHub will not let you move it afterwards">⚠ body says :${c.citesLine}</span>`)}
        </div>`, c => c.annotationId)}
        ${each(plan.deferred, d => html`<div class="pushrow"><code>${d.path}</code> <span class="dim">[body] ${d.why}</span></div>`, d => d.annotationId)}
        ${when(blockedHere(plan).length, () => html`
          <div class="pushblocked">
            <b>${blockedHere(plan).length} finding(s) you elected cannot be placed on this diff</b> — they stay on the map, and are NOT in this review.
            ${each(blockedHere(plan), b => html`<div class="pushrow"><code>${b.file || b.symbol || '?'}</code> ${b.label} <span class="dim">— ${b.why}</span></div>`, b => b.annotationId)}
          </div>`)}
        ${when(blockedElsewhere(plan).length, () => html`
          <div class="pushelsewhere">
            <span class="dim">${blockedElsewhere(plan).length} open finding(s) from other reviews are on this map and not in this diff — untouched, and still yours to resolve.</span>
            <button class="ghost" on-click="${() => { this.state.showElsewhere = !this.state.showElsewhere; }}">${this.state.showElsewhere ? 'hide' : 'show'}</button>
            ${when(this.state.showElsewhere, () => html`${each(blockedElsewhere(plan), b => html`<div class="pushrow dim"><code>${b.file || b.symbol || '?'}</code> ${b.label}${b.elsewhere && b.elsewhere.pr ? ` · PR #${b.elsewhere.pr}` : ''}</div>`, b => b.annotationId)}`)}
          </div>`)}
        <div class="dim">
          ${when(sk.notElected, () => html`${sk.notElected} held back — an agent raised them and you have not. Use <b>▲ raise</b> on a finding to include it.<br>`)}
          ${when(sk.notPublishable, () => html`${sk.notPublishable} held back by disposition — untriaged, refuted or accepted. Set one in the findings list to include it.<br>`)}
          ${when(sk.noComment, () => html`${sk.noComment} have no submitter-facing version written, so they are not sent — publishing the evidence instead is the thing this avoids.<br>`)}
          ${when(sk.evidenceMoved, () => html`${sk.evidenceMoved} written against a different version of the code — listed above.<br>`)}
          ${when(plan.unverified && plan.unverified.length, () => html`${plan.unverified.length} predate witnessing, so codemap cannot confirm they were written against <b>this</b> pull request. They are in this review.<br>`)}
          ${when(sk.withdrawn, () => html`${sk.withdrawn} withdrawn.<br>`)}
          ${when(sk.alreadyPushed, () => html`${sk.alreadyPushed} already sent on an earlier push — a re-run never duplicates a comment.<br>`)}
          ${when(sk.resolved, () => html`${sk.resolved} resolved locally, so not sent.<br>`)}
        </div>`)}
      ${when(!comments, () => html`
        <div><b>${plan.viewedPaths.length}</b> file(s) would be ticked <b>viewed</b> on <a href="${plan.pr.url}" target="_blank" rel="noreferrer">#${plan.pr.number}</a> — every reviewable symbol in them is signed off here.</div>
        ${each(plan.viewedPaths, f => html`<div class="pushrow"><code>${f}</code></div>`, f => f)}`)}
      <div class="prpromoacts">
        <button class="on" disabled="${!!p.sending || (comments ? !(plan.comments.length || plan.deferred.length || plan.summary || plan.event !== 'COMMENT') : !plan.viewedPaths.length)}" on-click="${() => this.confirmPush()}">${p.sending ? 'sending…' : (comments ? (PUSH_VERB[plan.event] || 'post to GitHub') : 'tick these on GitHub')}</button>
        <button class="ghost" on-click="${() => { this.state.push = null; }}">cancel</button>
        <span class="dim">${plan.event === 'COMMENT' ? 'this notifies the pull request\'s author' : 'this is a VERDICT on the pull request, and shows on it as one'}</span>
      </div>
    </div>`;
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
        <button class="ghost" on-click="${() => { this._promoteToken = null; this.state.promote = null; }}">cancel</button>
        <span class="dim">cites ${p.plan.anchors.length} symbol(s) at this PR's head</span>
      </div>
    </div>`;
  }

  // A changed symbol opens on its diff — the delta is the review, and the rest of
  // the body is context the reviewer did not ask for. Added and removed symbols
  // have no meaningful "before", so those open on the source itself.
  showsDiff(step) {
    const code = this.state.code[step.anchorId];
    if (!code || isErr(code) || !code.lines || !code.lines.length) return false;
    const override = this.state.showDiff[step.anchorId];
    return override === undefined ? step.change === 'changed' : !!override;
  }

  // A removed symbol's source is the body the PR DELETES — `head` is null for it.
  // Falling through to `head` rendered "(source unavailable)" over a step that
  // still carried a sign-off button, i.e. an attestation to code never shown.
  sourceOf(code) {
    return code.head != null
      ? { text: code.head, startLine: code.startLine }
      : { text: code.base, startLine: code.baseStartLine };
  }

  stepEl(u, step) {
    const held = this.state.code[step.anchorId];
    // One narrowed binding, rather than the same union unpicked at each of the
    // fourteen reads below.
    const code = isErr(held) ? null : held;
    const finds = openFindingCount(step.annotations);
    const src = code ? this.sourceOf(code) : null;
    return html`<div class="prstep ${this.stepSigned(step) ? 'done' : ''}" id="step-${step.anchorId}">
      <div class="prsthead" on-click="${() => this.openStep(step)}">
        <span class="prlayer" title="position on the command → read-model spine">${LAYER_NAME[step.layer] || 'code'}</span>
        <span class="prchg" style="color:${CHANGE_COLOR[step.change] || '#8b949e'}">${step.change}</span>
        ${sevDot(step.severity)}
        <code class="prsig">${step.signature || step.symbol}</code>
        <span class="dim prfile">${step.file.split('/').pop()}</span>
        ${when(finds, () => html`<span class="prfind" title="${finds} open finding(s)">⚑${finds}</span>`)}
        <span class="prrev" on-click="${(e) => { if (e.stopPropagation) e.stopPropagation(); }}">${reviewRowEl({ code: step.review || { state: step.reviewed ? 'reviewed' : 'unreviewed' } }, { code: step.viewedMark || { state: step.viewed ? 'reviewed' : 'unreviewed' } }, (att, st, actor, via) => this.markStep(step, att, st, actor, via), 'code', this.coverLabel(step))}</span>
      </div>
      ${when(this.state.pending[step.anchorId], () => html`<div class="dim prload">loading source…</div>`)}
      ${when(!!code, () => html`<div class="prsbody">
        <div class="prstools">
          <span class="dim">${code.file}</span>
          ${when(src && src.text != null && code.lines && code.lines.length, () => html`<button class="ghost" on-click="${() => { this.state.showDiff = { ...this.state.showDiff, [step.anchorId]: !this.showsDiff(step) }; }}">${this.showsDiff(step) ? 'show full source' : 'show diff'}</button>`)}
          ${when(code.lineEndingsChanged, () => html`<span class="crlf" title="one side uses CRLF and the other LF. The diff below is normalised so a line-ending flip does not read as a full rewrite — but the change is real and will show in the file diff on GitHub.">⚠ line endings changed</span>`)}
          <a class="viewlink" title="open the full anchor page" href="${href(anchorUrl(u, step.anchorId))}">↗</a>
        </div>
        ${when(this.showsDiff(step),
          () => diffReviewLines(this, u, step.anchorId, code.lines, code.lang, code.startLine, code.annotations, code.sharedNotes, step.findings),
          () => codeReviewLines(this, u, step.anchorId, src.text, code.lang, src.startLine, code.annotations, code.sharedNotes, step.findings))}
      </div>`)}
      ${when(isErr(held), () => html`<div class="prsbody dim">${isErr(held) ? held.error : ''}</div>`)}
    </div>`;
  }

  chapterEl(u, ch) {
    const open = !!this.state.open[ch.id];
    const done = ch.steps.filter(s => this.stepSigned(s)).length;
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
    const failed = taskError(this.load) ?? this.state.storyErr;
    if (failed) return pageShell(null, failed, html``);
    if (!st) return html`<main><div class="loading">loading pull request…</div></main>`;
    const signed = st.chapters.reduce((n, c) => n + c.steps.filter(s => this.stepSigned(s)).length, 0);
    return pageShell(st, null, html`
      <div class="prhead">
        <h2>#${st.pr.number} ${st.pr.title}</h2>
        <div class="dim">${st.pr.author} · ${st.pr.headRef} → ${st.pr.baseRef} ·
          <a href="${st.pr.url}" target="_blank" rel="noreferrer">open on GitHub ↗</a></div>
        ${when(!!(this.stores.nav.universes.find(x => x.id === u) || {}).sidecar, () => html`<div class="bactions">
          <button disabled="${this.state.sharedBusy}"
            title="send your findings on this pull request to the team's sidecar and receive theirs, then re-read this page. Nothing goes to GitHub — that is the push panel."
            on-click="${() => this.syncShared()}">${this.state.sharedBusy ? 'syncing…' : '⇅ push / pull findings'}</button>
          ${when(!!this.state.sharedNote, () => html`<span class="dim">${this.state.sharedNote}</span>`)}
        </div>`)}
        <div class="prstats">
          <span><b>${signed}</b>/${st.totals.steps} symbols signed</span>
          <span><b>${st.totals.chapters}</b> chapters</span>
          <span title="lines in the review queue vs total changed"><b>${st.totals.queueLines}</b>/${st.totals.changedLines} lines to review</span>
          ${when(st.undocumented, () => html`<span class="warn" title="changed symbols no spec section accounts for">${st.undocumented} unspecified</span>`)}
          ${when(st.specWithoutCode.filter(g => g.reason === 'absent').length, () => html`<span class="warn" title="spec sections naming code that is nowhere in this universe — a sibling repo's half of the spec, or unbuilt">${st.specWithoutCode.filter(g => g.reason === 'absent').length} spec not in this repo</span>`)}
          ${when(st.refs.baseAheadOfMergeBase, () => html`<span class="dim" title="the PR is diffed against its merge-base, not the tip of ${st.pr.baseRef} — otherwise those commits would read as part of this change">${st.pr.baseRef} moved ${st.refs.baseAheadOfMergeBase} commits since branch</span>`)}
          ${when(st.refs.baseAheadOfMergeBase === null, () => html`<span class="dim" title="git could not count commits between the merge-base and ${st.pr.baseRef} — usually an unfetched remote-tracking ref. Silence here would read as 'the base has not moved'.">whether ${st.pr.baseRef} moved is unknown</span>`)}
        </div>
        ${when(st.laneProblems && st.laneProblems.length, () => html`<div class="warn">
          <b>.codemaplanes</b> — these lines do nothing, so files you meant to reroute are in their default lane:
          ${each(st.laneProblems, p => html`<div>${p}</div>`, (p, i) => String(i))}
        </div>`)}
        <div class="prlanes">${each(st.lanes, l => html`<span class="prlane l-${l.review}" title="${l.why}"><b>${l.lane}</b> ${l.lines} lines · ${l.files} files · ${l.review}</span>`, l => l.lane)}</div>
        <div class="prderive">
          <button on-click="${() => this.deriveTriage()}" title="propose stakes and complexity for this PR's symbols. Symbols the branch adds are not in the live index, so the graph-wide derivation cannot see them at all.">${this.state.deriving ? 'deriving…' : 'derive stakes for this PR'}</button>
          ${when(this.state.derived && this.state.derived.error, () => html`<span class="warn">${this.state.derived.error}</span>`)}
          <button on-click="${() => this.pullViewed()}" title="import GitHub's per-file viewed ticks. They land as viewed, never signed — a tick is one click on a whole file, not a vouch for its contents.">${this.state.pulling ? 'importing…' : 'import viewed from GitHub'}</button>
          ${when(this.state.pulled && this.state.pulled.error, () => html`<span class="warn">${this.state.pulled.error}</span>`)}
          ${when(this.state.pulled && !this.state.pulled.error, () => html`<span class="dim">${this.state.pulled.files.viewedOnGitHub}/${this.state.pulled.files.total} files ticked on GitHub → ${this.state.pulled.anchors.marked} symbol(s) marked <b>viewed</b>${this.state.pulled.anchors.alreadySigned ? `; ${this.state.pulled.anchors.alreadySigned} already signed and left alone` : ''}.</span>`)}
          ${when(this.state.derived && !this.state.derived.error, () => html`<span class="dim">${this.state.derived.applied} newly proposed${this.state.derived.refused ? `, ${this.state.derived.refused} already at or above this tier` : ''} — of ${this.state.derived.considered} with a signal. Every one is <b>likely</b>: confirm or lower it yourself.</span>`)}
        </div>
        ${when(this.state.markError, () => html`<div class="warn">sign-off failed: ${this.state.markError}</div>`)}
        <div class="prderive prpush">
          <button class="${this.state.showFindings ? 'on' : ''}" on-click="${() => this.toggleFindings()}" title="every finding on this PR in one list — raise or resolve without opening each symbol">${this.state.showFindings ? 'hide findings' : `findings (${this.allFindings().filter(e => !e.f.resolved).length + this.sharedOpenCount()})`}</button>
          <button on-click="${() => this.openPush('comments')}" title="${this.hasSidecar() ? 'post your verdict and summary to the pull request. Findings are NOT posted as comments — they live on the team\'s sidecar. Shows you exactly what would be sent first.' : 'post your findings to the pull request as review comments. Yours go out; an agent\'s only if you raised it. Shows you exactly what would be sent first.'}">${this.hasSidecar() ? 'push review verdict to GitHub' : 'push comments to GitHub'}</button>
          <button on-click="${() => this.openPush('viewed')}" title="tick the per-file viewed boxes on GitHub for files you have fully signed off here, so both tools agree about what has been read.">push viewed state to GitHub</button>
          <button on-click="${() => this.openResolveSync()}" title="compare which of your posted findings are settled here against which conversations are resolved on the pull request — for when the submitter fixed it and left the comment open.">sync resolved state</button>
        </div>
        ${this.findingsPanelEl(u)}
        ${this.pushPanelEl()}
        ${this.resolveSyncEl()}
      </div>
      ${when(!st.totals.steps, () => html`<section class="prchapter"><div class="prcbody prempty">
        <b>Nothing in the review queue.</b>
        <div class="dim">Every changed file in this PR falls outside the code lane, so there are no symbols to walk through.
        That is a verdict, not a failure — the lane strip above shows where the ${st.totals.changedLines} changed lines went.
        Tests and generated files are still read by the first-pass agent, which can promote one into your queue if it matters.</div>
      </div></section>`)}
      ${when(st.walkthrough,
        () => this.walkthroughEl(u, st),
        // No agent has walked this one: the spec-derived grouping is the fallback,
        // and it says so rather than presenting itself as a reading guide.
        () => html`
          ${when(st.totals.steps > 40, () => html`<div class="wkbanner dim">
            ${st.totals.steps} symbols, grouped by the spec sections that name them — which is not a
            reading order. Ask an agent to <b>map out PR ${st.pr.number}</b> for a walkthrough:
            features, chapters you can sign off in one go, and anything the spec does not mention.
          </div>`)}
          ${each(st.chapters, c => this.chapterEl(u, c), c => c.id)}`)}
      ${this.specGapEl(st)}
    `);
  }
}
defineComponent('pr-story-page', PrStoryPage);

// The PR inbox. Deliberately cheap: it renders `gh pr list` metadata only, because
// triaging a PR means snapshotting both its sides, and doing that for every open PR
// just to draw a list would cost seconds per row. The numbers arrive on the
// walkthrough itself.
/**
 * @typedef {{ d: ApiMap['/api/prs'] | null }} PrInboxState
 * @extends {Component<PageProps, PrInboxState>}
 */
class PrInboxPage extends Component {
  static props = { params: {}, query: {} };
  /** @param {PageProps} props */
  constructor(props) {
    super(props);
    /** @type {PrInboxState} */
    this.state = { d: null };
  }
  load = this.createTask(async () => {
    const u = this.props.params.universe; nav.current = u;
    this.state.d = await api('/api/prs', { u });
  });
  mounted() { this.load.run(); }
  propsChanged(name) { if (name === 'params') this.load.run(); }

  template() {
    const u = this.props.params.universe, d = this.state.d;
    const failed = taskError(this.load) ?? (isErr(d) ? d.error : null);
    if (failed) return pageShell(null, failed, html``);
    if (!d || isErr(d)) return html`<main><div class="loading">loading pull requests…</div></main>`;
    return pageShell(d, null, html`
      <div class="crumbs"><b>${u}</b> <span class="sep">·</span> pull requests <span class="dim">· ${d.prs.length} open</span></div>
      ${when(!d.prs.length, () => html`<div class="dim">no open pull requests.</div>`)}
      ${each(d.prs, p => html`<a class="prrow" href="${href(prUrl(u, p.number))}">
        <span class="prnum">#${p.number}</span>
        <span class="prtitle">${p.title}</span>
        ${when(p.draft, () => html`<span class="prbadge orphan">draft</span>`)}
        <span class="dim prmeta">${p.author}</span>
        <span class="dim prmeta">${p.headRef} → ${p.baseRef}</span>
        <span class="prsize" title="${p.changedFiles} files changed"><span class="pradd">+${p.additions}</span> <span class="prdel">−${p.deletions}</span></span>
      </a>`, p => p.number)}
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
  '/u/:universe/orphans/': { component: 'orphans-page' },
  '/u/:universe/diff/': { component: 'diff-page' },
  '/u/:universe/prs/': { component: 'pr-inbox-page' },
  '/u/:universe/pr/:pr/': { component: 'pr-story-page' },
  '/u/:universe/search/': { component: 'search-page' },
  '/u/:universe/shared/:pr/': { component: 'shared-page' },
  '/u/:universe/shared/:pr/peers/': { component: 'shared-peers-page' },
  '/u/:universe/shared/': { component: 'shared-hub-page' },
  '/u/:universe/shared-docs/': { component: 'shared-docs-page' },
});
