/**
 * The shell every page is built on: fetch, navigation, the page frame.
 *
 * Extracted from `app.js` to BREAK A CYCLE, not for tidiness. `app.js` imported
 * `shared.js` for its `defineComponent` side effects and `shared.js` imported these
 * helpers back — a real circular import, whose failure mode in this framework is a
 * blank page that logs NOTHING (see `docs/...` and the note that used to sit on the
 * `shared.js` import). It was safe only because `shared.js` happened to touch the
 * bindings inside method bodies rather than at evaluation time, which nothing enforced.
 *
 * The rule that keeps it broken: **this module imports nothing from `app.js` or
 * `shared.js`.** It sits below both, the way `doc-version.ts` sits below the modules
 * that used to cycle through it. `src/import-cycles.test.ts` now walks `web/` and will
 * fail if that is reintroduced.
 */
import { html, when, Store } from './vendor/vdx/framework.js';

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
 *   '/api/standard':            Awaited<ReturnType<Ops['standardStatus']>>,
 *   '/api/standard/spec':       Awaited<ReturnType<Ops['getSpec']>>,
 *   '/api/standard/sections':   Awaited<ReturnType<Ops['requirementSections']>>,
 *   '/api/standard/requirements': Awaited<ReturnType<Ops['listRequirements']>>,
 *   '/api/standard/requirement': Awaited<ReturnType<Ops['getRequirement']>>,
 *   '/api/standard/conformance': Awaited<ReturnType<Ops['conformance']>>,
 *   '/api/standard/queues':     Awaited<ReturnType<Ops['standardQueues']>>,
 *   '/api/standard/health':     Awaited<ReturnType<Ops['standardHealth']>>,
 *   '/api/standard/provisional': Awaited<ReturnType<Ops['provisionalAudits']>>,
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

/**
 * The router, owned here because `go` and `href` are.
 *
 * Assigned by `app.js` on its last line, once `enableRouting` has run. A setter rather
 * than an exported `let` because a live binding read from another module is exactly the
 * evaluation-order hazard this split exists to remove — `href` already has to cope with
 * being called before assignment, and does.
 */
export const setRouter = (r) => { router = r; };
