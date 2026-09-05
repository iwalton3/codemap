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
/**
 * A POST that carries the principal notice.
 *
 * The five acts under `/api/standard/` that only a person may perform need the sentence
 * from `GET /api/standard/attest` sent back. From a browser that is one extra round trip
 * and invisible; from anything else it is a claim about who you are. `PRINCIPAL_NOTICE` in
 * `src/serve.ts` says what it is for and why making it opaque would destroy it.
 */
export async function attestedPost(path, body) {
  const a = await api('/api/standard/attest');
  return apiPost(path, { ...body, attest: `${a.notice} ${a.nonce}` });
}

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
 *   '/api/resolve':             Awaited<ReturnType<Multi['resolveIdAll']>>,
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
 *   '/api/findings/backlog':    Awaited<ReturnType<Shared['findingBacklog']>>,
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
 *   '/api/standard/attest':     { notice: string, nonce: string },
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
 * Navigate WITHOUT leaving the current URL in the history.
 *
 * For a page that exists only to send the reader somewhere else. A search URL carrying an
 * id resolves to one record and jumps; pushing that jump would put the search URL back
 * under the reader's Back button, and pressing it would land on the page that bounces
 * forward again — a trap you can only escape by holding Back. Replacing the entry means
 * Back goes where they actually came from.
 *
 * `href()` builds the target so this cannot drift from `go` on query encoding, and
 * `location.replace` on a `#…` fires `hashchange`, which is how the router hears about it
 * in hash mode. There is no `replace` on vdx's `navigate`, which only ever pushes.
 */
export const goReplace = (path, query) => { window.location.replace(href(path, query)); };

/**
 * The router, owned here because `go` and `href` are.
 *
 * Assigned by `app.js` on its last line, once `enableRouting` has run. A setter rather
 * than an exported `let` because a live binding read from another module is exactly the
 * evaluation-order hazard this split exists to remove — `href` already has to cope with
 * being called before assignment, and does.
 */
export const setRouter = (r) => { router = r; };

/**
 * Show a refusal the user would otherwise never see.
 *
 * The POST helpers in `app.js` fire and reload — nine call sites for `postReview` alone,
 * none of which read the reply. `/api/review` answers `{error}` at HTTP **200**, so the
 * page reloaded to exactly the state it was already in and nothing anywhere said why. That
 * became likelier, not less, once `markReviewed`'s "nothing was witnessed" guard was fixed
 * to consult the ref it witnessed: the refusal is now correct AND invisible.
 *
 * Deliberately not a component. It has no state a page owns, it must work from a plain
 * `fetch` helper defined outside any component, and a refusal has to survive the reload
 * that follows it — an element outside the render tree is the only thing here that does.
 */
export function flashError(message) {
  if (!message) return;
  let el = document.getElementById('flash');
  if (!el) {
    el = document.createElement('div');
    el.id = 'flash';
    el.addEventListener('click', () => el.remove());
    document.body.appendChild(el);
  }
  el.textContent = message;
  // The timer rides on the element rather than a module-level variable, so a second
  // refusal cannot leave the first one's timeout to dismiss it early.
  const box = /** @type {HTMLElement & { _t?: number }} */ (el);
  clearTimeout(box._t);
  // Long, because these are paragraphs: the refusals on this surface explain what to do
  // instead, and a toast that outruns the reading is the same silence with extra steps.
  box._t = setTimeout(() => el.remove(), 20000);
}

/**
 * `fetch` for the fire-and-reload POSTs, with the reply actually read.
 *
 * Returns the parsed body so a caller MAY branch on it, and flashes `{error}` so a caller
 * that does not still cannot swallow a refusal. That default is the point — the bug was
 * nine callers all forgetting the same thing.
 */
export async function postSeen(path, body) {
  try {
    const r = await fetch(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const out = await r.json().catch(() => ({}));
    if (out && out.error) flashError(out.error);
    else if (!r.ok) flashError('HTTP ' + r.status);
    return out;
  } catch (e) {
    flashError(errText(e));
    return { error: errText(e) };
  }
}

// ---------------------------------------------------------------------------
// Ids as handles — copy one, paste one, land on the record
// ---------------------------------------------------------------------------

/**
 * Where a resolved record LIVES, as a route.
 *
 * Here rather than beside the other `*Url` helpers in `app.js` because `shared.js` and
 * `standard.js` render copy buttons too and may not import `app.js` — this module is the
 * one all three sit above. See the cycle note at the top of the file.
 *
 * A finding is reached through its pull request, not by a route of its own: `(pr, id)` is
 * its identity — `ix_findings_identity` is unique on the pair — so a URL naming only the
 * id would be addressing something narrower than the record. An operation is reached
 * through its spec for the same reason it is stored under one.
 *
 * @param {{ universe: string, kind: string, id: string, pr?: string, parent?: string }} r
 * @returns {{ path: string, query: Record<string,string> } | null}
 */
export function entityRoute(r) {
  const u = r.universe;
  switch (r.kind) {
    case 'finding': return r.pr ? { path: `/u/${u}/shared/${r.pr}/`, query: { f: r.id } } : null;
    case 'bug': return { path: `/u/${u}/bugs/`, query: { bug: r.id, state: 'all' } };
    case 'requirement': return { path: `/u/${u}/standard/r/${r.id}/`, query: {} };
    case 'spec': return { path: `/u/${u}/standard/spec/${r.id}/`, query: {} };
    case 'operation': return r.parent ? { path: `/u/${u}/standard/spec/${r.parent}/`, query: {} } : null;
    case 'node': return { path: `/u/${u}/node/${r.id}/`, query: {} };
    case 'anchor': return { path: `/u/${u}/anchor/${r.id}/`, query: {} };
    default: return null;
  }
}

/**
 * Put text on the clipboard, from wherever this page is being served.
 *
 * `navigator.clipboard` needs a SECURE CONTEXT. `http://localhost` is one, so the default
 * `127.0.0.1` bind is fine — but `CODEMAP_HOST` exists, and a UI served on a LAN address
 * over http has no `navigator.clipboard` at all. The fallback is the old `execCommand`
 * dance, which is deprecated and works everywhere that matters; without it the button is
 * silently dead for exactly the person who set `CODEMAP_HOST` to share their map.
 *
 * @param {string} text
 * @returns {Promise<boolean>}
 */
export async function copyText(text) {
  try {
    if (navigator.clipboard && window.isSecureContext) { await navigator.clipboard.writeText(text); return true; }
  } catch { /* fall through — a rejected permission is not a reason to give up */ }
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    // Off-screen rather than hidden: `display:none` cannot be selected, so the copy
    // silently does nothing.
    ta.style.cssText = 'position:fixed;top:-1000px;opacity:0';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    return ok;
  } catch { return false; }
}

/**
 * The copy-id button, one implementation for every surface that shows an id.
 *
 * It copies the ID, not a URL, and that is the whole point rather than a shortcut.
 * Everyone runs the web UI locally, so a copied link carries a port that is only true for
 * whoever copied it — paste `http://localhost:4311/...` into a pull request and the
 * teammate on 4310 gets a dead link. An id has no port in it: it pastes into a PR comment,
 * a chat message or a prompt, and resolves in any clone, at any port, on any surface. It
 * is the property a commit hash has and a link does not.
 *
 * Confirmation is on the BUTTON and lasts a moment, because a copy that silently did
 * nothing (see `copyText` on secure contexts) is indistinguishable from one that worked.
 *
 * @param {string} id
 * @param {string} [title]
 */
export const copyIdButton = (id, title) => html`<button class="copyid" title="${title || `copy ${id}`}"
  on-click="${(/** @type {Event} */ e) => {
    // The button sits INSIDE rows that own a click — the bug list selects, the finding
    // row toggles open. Without this, copying an id also navigates or collapses the very
    // record you were pointing at.
    e.stopPropagation();
    const btn = e.currentTarget;
    if (!(btn instanceof HTMLElement)) return;
    copyText(id).then((ok) => {
      // Straight to the element rather than through component state: this button is
      // rendered by a dozen surfaces, none of which should have to hold a field for it.
      btn.classList.add(ok ? 'ok' : 'bad');
      setTimeout(() => btn.classList.remove('ok', 'bad'), 1200);
    });
  }}">⧉</button>`;

/**
 * Does this query look like a MINTED handle, rather than a word somebody is searching for?
 *
 * The guard that stops the search box teleporting people. Node ids are human-readable
 * slugs — `accept-a-price`, `admin-observability-over-the-whole-stack` — so an
 * unrestricted prefix resolve turns a search for `accept` into a jump to a document,
 * and the reader never sees the results they asked for.
 *
 * A minted handle is a short kind tag, an underscore, then an alphanumeric body:
 * `f_`, `bug_`, `finding_`, `a_`, `sp_`, `op_`, `req_`. Slugs carry no underscore, so
 * they fall out. An EXACT id still jumps whatever its shape — see `jumpTarget` — because
 * a complete id is not a guess about what somebody meant.
 *
 * @param {string} q
 */
export const looksLikeId = (q) => /^[a-z]{1,8}_[0-9a-z][0-9a-z_-]*$/i.test(q.trim());

/**
 * Worth ASKING the server to resolve — a filter on wasted round trips, not on jumping.
 *
 * Deliberately weaker than `looksLikeId`: whitespace means prose, and prose is never an
 * id. Everything past this goes to `jumpTarget`, which owns the actual rule. Making this
 * the strict test instead is what made `jumpTarget`'s exact-match branch unreachable —
 * both callers had already applied the first of its two conditions, so a pasted node id
 * like `accept-a-price`, which is exact and carries no kind tag, could never jump.
 *
 * @param {string} q
 */
export const worthResolving = (q) => { const t = q.trim(); return !!t && !/\s/.test(t); };

/**
 * Should this resolution take the reader somewhere, and where?
 *
 * Two ways to earn a jump and they are different claims: the query is handle-SHAPED, so
 * resolving its prefix is what the person meant; or the match is EXACT, so there is
 * nothing to guess about. Everything else stays on the results page.
 *
 * @param {string} q
 * @param {{ match?: { universe: string, kind: string, id: string, pr?: string, parent?: string } | null } | null | undefined} r
 */
export function jumpTarget(q, r) {
  const m = r && r.match;
  if (!m) return null;
  if (!looksLikeId(q) && m.id !== q.trim()) return null;
  return entityRoute(m);
}
