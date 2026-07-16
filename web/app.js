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
const graphUrl = (u, id) => `/u/${u}/graph/${id}/`;

const barColor = (pct) => pct === 0 ? '#3a4250' : `hsl(${Math.round(pct * 1.2)}, 55%, 48%)`;
const KICON = { dir: '▸', file: '≡' };
const NODE_COLORS = {
  event_family: '#7ee787', aggregate: '#58a6ff', projection: '#f0a35e', command: '#d2a8ff',
  handler: '#79c0ff', module: '#8b95a3', process: '#f778ba', step: '#a5d6ff', unknown: '#3a4250',
};
const nodeColor = (t) => NODE_COLORS[t] ?? NODE_COLORS.unknown;
const EDGE_COLORS = {
  folds: '#7ee787', projects: '#f0a35e', emits: '#79c0ff', handles: '#d2a8ff',
  touches: '#f778ba', step_of: '#a5d6ff', part_of: '#8b95a3', depends_on: '#58a6ff', calls_api: '#ffab70',
};
const edgeColor = (t) => EDGE_COLORS[t] ?? '#6b7684';
const bugsUrl = (u) => `/u/${u}/bugs/`;
const SEV_COLOR = { low: '#8b95a3', medium: '#58a6ff', high: '#f0a35e', critical: '#f27b7b' };
const flowsUrl = (u) => `/u/${u}/flows/`;
const flowUrl = (u, id) => `/u/${u}/flow/${id}/`;
const nodesUrl = (u) => `/u/${u}/nodes/`;
const matrixUrl = (u) => `/u/${u}/matrix/`;
const pipelineUrl = (u) => `/u/${u}/pipeline/`;
const REV_COLOR = { reviewed: '#7ee787', stale: '#f0a35e', unreviewed: '#3a4250' };
// Actor-aware review rendering: human review = green (`on`), agent `checked` = blue.
const revCls = (state, actor) => state === 'reviewed' ? (actor === 'agent' ? 'checked' : 'on') : state === 'stale' ? 'stale' : '';
const revColorA = (info) => { const s = info && info.state, a = info && info.actor; return s === 'reviewed' ? (a === 'agent' ? '#58a6ff' : '#7ee787') : s === 'stale' ? '#f0a35e' : '#3a4250'; };
const revMark = (state, actor) => state === 'reviewed' ? (actor === 'agent' ? ' ·' : ' ✓') : state === 'stale' ? ' ⚠' : '';
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
const postReview = (u, targetKind, targetId, level, unmark) =>
  fetch('/api/review', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ u, targetKind, targetId, level, unmark }) });
const postAnnotate = (u, targetKind, targetId, text, kind) =>
  fetch('/api/annotate', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ u, targetKind, targetId, text, kind, author: 'human' }) });
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
const highlight = (code, lang) => {
  if (window.hljs && lang && lang !== 'plaintext') { try { return window.hljs.highlight(code, { language: lang, ignoreIllegals: true }).value; } catch {} }
  return String(code).replace(/&/g, '&amp;').replace(/</g, '&lt;');
};
const reviewHeat = (rev) => {
  if (!rev || !rev.total) return html`<span class="rheat empty"></span>`;
  const w = (n) => Math.round(100 * n / rev.total);
  const track = (done, stale) => html`<span class="rtrack"><i class="done" style="width:${w(done)}%"></i><i class="stale" style="width:${w(stale)}%"></i></span>`;
  const tip = `logical ${rev.logical}/${rev.total}${rev.logicalStale ? ' (' + rev.logicalStale + ' stale)' : ''} · code ${rev.code}/${rev.total}${rev.codeStale ? ' (' + rev.codeStale + ' stale)' : ''}`;
  return html`<span class="rheat" title="${tip}">${track(rev.logical, rev.logicalStale)}${track(rev.code, rev.codeStale)}</span>`;
};
const revDot = (state, actor) => html`<span class="rd ${state === 'reviewed' ? (actor === 'agent' ? 'checked' : 'done') : state === 'stale' ? 'stale' : ''}"></span>`;

// --- markdown ----------------------------------------------------------------
// Content is authored by the documenting agent / developers (internal, trusted).
class MdContent extends Component {
  static props = { text: '' };
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
    const t = this.props.text || '';
    return html`<div class="md">${raw(window.marked ? window.marked.parse(t) : t)}</div>`;
  }
}
defineComponent('md-content', MdContent);

// --- header ------------------------------------------------------------------
class CodemapHeader extends Component {
  static stores = { nav };
  mounted() { nav.load(); }
  search(e, v) {
    const u = this.stores.nav.current || (this.stores.nav.universes[0] && this.stores.nav.universes[0].id);
    if (u && v) go(`/u/${u}/search/`, { q: v });
  }
  template() {
    const n = this.stores.nav;
    return html`<header>
      <div class="brand" on-click="${() => go('/')}">codemap<span> · map browser</span></div>
      <div class="uni">${each(n.universes, u => html`<button class="${u.id === n.current ? 'active' : ''}" on-click="${() => go(dashUrl(u.id))}">${u.id}<span class="n">${u.anchors ?? '–'}</span></button>`)}</div>
      <a class="viewlink" on-click="${() => { const u = n.current || (n.universes[0] && n.universes[0].id); if (u) go(nodesUrl(u)); }}">nodes</a>
      <a class="viewlink" on-click="${() => { const u = n.current || (n.universes[0] && n.universes[0].id); if (u) go(matrixUrl(u)); }}">matrix</a>
      <a class="viewlink" on-click="${() => { const u = n.current || (n.universes[0] && n.universes[0].id); if (u) go(pipelineUrl(u)); }}">pipeline</a>
      <a class="viewlink" on-click="${() => { const u = n.current || (n.universes[0] && n.universes[0].id); if (u) go(flowsUrl(u)); }}">flows</a>
      <a class="viewlink" on-click="${() => { const u = n.current || (n.universes[0] && n.universes[0].id); if (u) go(bugsUrl(u)); }}">bugs</a>
      <a class="viewlink" on-click="${() => { const u = n.current || (n.universes[0] && n.universes[0].id); if (u) go(diffUrl(u)); }}">diff</a>
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
  });
  mounted() { this.load.run(); }
  propsChanged() { this.load.run(); }
  async resolveQ(id) { await postResolveAnnotation(this.props.params.universe, id, true); this.load.run(); }
  qTarget(t) { const u = this.props.params.universe; return t.kind === 'node' ? nodeUrl(u, t.id) : anchorUrl(u, t.id); }
  stat(label, value, extra) { return html`<div class="dstat"><div class="dsv">${value}</div><div class="dsl">${label}</div>${when(extra, () => html`<div class="dsx">${extra}</div>`)}</div>`; }
  template() {
    const u = this.props.params.universe, d = this.state.d;
    if (!d || this.load.pending) return html`<main><div class="loading">loading…</div></main>`;
    if (d.error) return html`<main><div class="empty">${d.error}</div></main>`;
    const nav2 = [
      ['nodes', () => go(nodesUrl(u))], ['matrix', () => go(matrixUrl(u))], ['pipeline', () => go(pipelineUrl(u))],
      ['flows', () => go(flowsUrl(u))], ['bugs', () => go(bugsUrl(u))], ['diff', () => go(diffUrl(u))], ['browse files', () => goTree(u, '')],
    ];
    return html`<main>
      <div class="crumbs"><b>${u}</b> <span class="sep">·</span> overview</div>
      ${when(d.attention > 0, () => html`<div class="attn-banner">
        <span class="attn-n">⚠ ${d.attention}</span>
        <span>item${d.attention === 1 ? '' : 's'} need attention:</span>
        ${when(d.docs.stale, () => html`<span class="attn-pill" on-click="${() => go(nodesUrl(u))}">${d.docs.stale} stale doc${d.docs.stale === 1 ? '' : 's'}</span>`)}
        ${when(d.docs.dangling, () => html`<span class="attn-pill bad" on-click="${() => go(nodesUrl(u))}">${d.docs.dangling} dangling</span>`)}
        ${when(d.bugs.possiblyFixed, () => html`<span class="attn-pill" on-click="${() => go(bugsUrl(u), { status: 'open' })}">${d.bugs.possiblyFixed} bug${d.bugs.possiblyFixed === 1 ? '' : 's'} possibly fixed</span>`)}
        ${when(d.openQuestions, () => html`<span class="attn-pill q">${d.openQuestions} open question${d.openQuestions === 1 ? '' : 's'}</span>`)}
        <span class="attn-hint">re-validate via <code>check_stale</code> / the bugs tab</span>
      </div>`, () => html`<div class="attn-banner ok"><span class="attn-n">✓</span> <span>nothing stale — docs and bugs are current with the code</span></div>`)}

      <div class="dcards">
        <div class="dcard">
          <div class="dch">documentation</div>
          <div class="dstats">
            ${this.stat('documented', d.coverage.docPct + '%')}
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
    </main>`;
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
          <span><span class="dot ${(s.coverage === 'cited' || s.coverage === 'covered') ? 'on' : ''}" title="coverage: ${s.coverage}"></span>${s.symbol}${when(s.review, () => html`<span class="rdots" title="logical ${s.review.logical} · code ${s.review.code}">${revDot(s.review.logical, s.review.logicalActor)}${revDot(s.review.code, s.review.codeActor)}</span>`)}</span><span class="muted">${s.lines ?? ''}</span></div>`)}</div>`;
    }
    if (!d.children || !d.children.length) return html`<div class="empty">no anchors here</div>`;
    return html`<div>
      <div class="rlegend"><span class="k"><span class="mini"></span>review heat — top: logical · bottom: code (green reviewed, amber stale)</span></div>
      <div class="rows">${each(d.children, c => html`
        <div class="row" on-click="${() => goTree(u, c.path)}">
          <span class="ico">${KICON[c.kind]}</span>
          <span class="name ${c.kind}">${c.name}</span>
          <span class="bar" title="${c.docPct}% documented"><i style="width:${c.docPct}%;background:${barColor(c.docPct)}"></i></span>
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
  propsChanged() { this.load.run(); }
  template() {
    const u = this.props.params.universe, a = this.state.a;
    if (!a || this.load.pending) return html`<main><div class="loading">loading…</div></main>`;
    if (a.error) return html`<main><div class="empty">${a.error}</div></main>`;
    return html`<main><div class="detail">
      <div class="back" on-click="${() => goTree(u, a.file)}">← ${a.file}</div>
      <h2>${a.symbol}</h2>
      <div class="meta">${a.kind} · ${a.file}:${a.lines} · ${a.present ? 'present' : 'not found (lost)'}</div>
      ${when(a.citedBy && a.citedBy.length, () => html`<div class="sec">documented by</div><div class="chips">${each(a.citedBy, n => html`<span class="chip" on-click="${() => go(nodeUrl(u, n.id))}">${n.title || n.id}</span>`)}</div>`)}
      ${when(a.bugs && a.bugs.length, () => html`<div class="sec">bugs</div><div class="chips">${each(a.bugs, b => html`<span class="chip">${b.status} · ${b.title}</span>`)}</div>`)}
      ${annoThread(this, u, 'anchor', a.id, a.annotations)}
      <div class="sec">source</div>
      ${when(a.code, () => html`<pre class="hljs"><code>${raw(highlight(a.code, a.lang))}</code></pre>`, () => html`<pre class="code">(unavailable)</pre>`)}
    </div></main>`;
  }
}
defineComponent('anchor-page', AnchorPage);

class NodePage extends Component {
  static props = { params: {}, query: {} };
  constructor(props) { super(props); this.state = { n: null, versions: null }; }
  load = this.createTask(async () => {
    const u = this.props.params.universe, id = this.props.params.id; nav.current = u;
    this.state.n = await api('/api/node', { u, id });
    this.state.versions = this.state.n && !this.state.n.error ? (await api('/api/node_versions', { u, id })).versions : null;
  });
  mounted() { this.load.run(); }
  propsChanged() { this.load.run(); }
  async verify(act) { await postReview(this.props.params.universe, 'node', this.props.params.id, 'logical', act === 'unverify'); this.load.run(); }
  async confirm() { await postConfirm(this.props.params.universe, this.props.params.id); this.load.run(); }
  async ackHole() { await postAckHole(this.props.params.universe, this.props.params.id); this.load.run(); }
  template() {
    const u = this.props.params.universe, n = this.state.n, versions = this.state.versions;
    if (!n || this.load.pending) return html`<main><div class="loading">loading…</div></main>`;
    if (n.error) return html`<main><div class="empty">${n.error}</div></main>`;
    return html`<main><div class="detail">
      <div class="meta">${n.type}${n.universe ? ' · ' + n.universe : ''} · ${n.id} ${statusChip(n.status)}${trustChip(n.trust, (act) => this.verify(act))}<span class="viewlink" on-click="${() => go(graphUrl(u, n.id))}">◆ graph</span></div>
      <h2>${n.title}${when(n.versionCount > 1, () => html`<span class="vfork" title="${n.versionCount} versions (forked across branches)">⑂${n.versionCount}</span>`)}</h2>
      ${when(n.status === 'stale', () => html`<div class="vaction"><span>This doc cites code that changed since it was written.</span> <button on-click="${() => this.confirm()}">confirm still accurate</button> <span class="dim">— or edit it (forks a new version).</span></div>`)}
      ${when(n.status === 'dangling', () => html`<div class="vaction bad"><span>Cited code was removed here (${(n.danglingAnchors || []).length} anchor${(n.danglingAnchors || []).length === 1 ? '' : 's'}).</span> <button on-click="${() => this.ackHole()}">ack — remove doc here</button> <span class="dim">(kept on branches where the code exists).</span></div>`)}
      <md-content text="${n.summary}"></md-content>
      ${when(n.body && n.body.trim(), () => html`<md-content text="${n.body}"></md-content>`)}
      <div class="sec">anchors</div>
      <div class="chips">${each(n.resolvedAnchors ?? [], a => html`<span class="chip" on-click="${() => a.id && go(anchorUrl(u, a.id))}">${a.symbol ?? a.id}</span>`)}</div>
      ${when(n.edges && n.edges.length, () => html`<div class="sec">edges</div><div class="chips">${each(n.edges, e => html`<span class="chip" on-click="${() => e.toRef && go(nodeUrl(e.toRef.universe, e.toRef.id))}">${e.type}: ${e.toRef ? e.toRef.universe + '::' + (e.toRef.title || e.toRef.id) : e.to}</span>`)}</div>`)}
      ${when(n.inboundCrossUniverse && n.inboundCrossUniverse.length, () => html`<div class="sec">called by (other universes)</div><div class="chips">${each(n.inboundCrossUniverse, i => html`<span class="chip" on-click="${() => go(nodeUrl(i.fromUniverse, i.from))}">${i.fromUniverse}::${i.from} (${i.type})</span>`)}</div>`)}
      ${when(versions && versions.length > 1, () => html`<div class="sec">versions (${versions.length}) — the one matching this branch wins</div>
        ${each(versions, v => html`<div class="nver ${v.status}"><span class="stchip ${v.status}">${v.status}</span> <span class="nvbranch">${v.createdBranch || '(?)'} @ ${(v.createdCommit || '').slice(0, 8) || '—'}</span> <span class="dim">${v.removed ? '(tombstone)' : v.title}</span></div>`, v => v.versionId)}`)}
      ${annoThread(this, u, 'node', n.id, n.annotations)}
    </div></main>`;
  }
}
defineComponent('node-page', NodePage);

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
  propsChanged() { this.load.run(); }
  template() {
    const u = this.props.params.universe, d = this.state.data;
    if (!d || this.load.pending) return html`<main><div class="loading">loading…</div></main>`;
    return html`<main>
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
    </main>`;
  }
}
defineComponent('flows-page', FlowsPage);

class FlowPage extends Component {
  static props = { params: {}, query: {} };
  constructor(props) { super(props); this.state = { data: null }; }
  load = this.createTask(async () => { nav.current = this.props.params.universe; this.state.data = await api('/api/flow', { u: this.props.params.universe, id: this.props.params.id }); });
  mounted() { this.load.run(); }
  propsChanged() { this.load.run(); }
  async toggle(kind, id, level, state) { await postReview(this.props.params.universe, kind, id, level, state === 'reviewed'); this.load.run(); }
  revBtn(kind, id, level, info) {
    const st = (info && info.state) || 'unreviewed', actor = info && info.actor;
    const cls = revCls(st, actor);
    const tip = `${level} ${st}${st === 'reviewed' && actor === 'agent' ? ' (agent-checked)' : ''}${info && info.by ? ' · by ' + info.by : ''}`;
    return html`<button class="${cls}" title="${tip}" on-click="${(e) => { if (e.stopPropagation) e.stopPropagation(); this.toggle(kind, id, level, st); }}">${level}${revMark(st, actor)}</button>`;
  }
  revBtns(kind, id, review) {
    return html`<span class="rev">${each(['logical', 'code'], (lvl) => this.revBtn(kind, id, lvl, review && review[lvl]), (lvl) => lvl)}</span>`;
  }
  codeBlock(a) {
    if (a.missing) return html`<div class="anchor-code"><div class="sym">${a.id} — anchor missing (renamed/removed?)</div></div>`;
    if (!a.code) return html`<div class="anchor-code"><div class="sym">${a.symbol} — code unavailable</div></div>`;
    return html`<div class="anchor-code">
      <div class="sym">${a.symbol} · ${a.file}:${a.lines}<span class="rev">${this.revBtn('anchor', a.id, 'code', a.review && a.review.code)}</span></div>
      <pre class="hljs"><code>${raw(highlight(a.code, a.lang))}</code></pre>
    </div>`;
  }
  template() {
    const u = this.props.params.universe, d = this.state.data;
    if (!d || this.load.pending) return html`<main><div class="loading">loading…</div></main>`;
    if (d.error) return html`<main><div class="empty">${d.error}</div></main>`;
    return html`<main>
      <div class="crumbs"><a on-click="${() => go(flowsUrl(u))}">← flows</a> <span class="sep">·</span> ${d.title}</div>
      <div class="detail">
        <div style="display:flex;align-items:center;gap:12px"><h2 style="margin:0">${d.title}</h2>${this.revBtns('node', d.id, d.review)}</div>
        <md-content text="${d.summary}"></md-content>
      </div>
      ${each(d.steps, (s) => html`<div class="flow-step">
        <div class="shead"><span class="num">${s.order + 1}</span><span class="stitle">${s.title}</span>${this.revBtns('node', s.id, s.review)}</div>
        <div class="sbody">
          <md-content text="${s.summary}"></md-content>
          ${when(s.touches && s.touches.length, () => html`<div class="chips">${each(s.touches, (t) => html`<span class="chip" on-click="${() => go(nodeUrl(u, t.id))}">↳ ${t.title}</span>`, (t) => t.id)}</div>`)}
          ${each(s.anchors, (a) => this.codeBlock(a), (a) => a.id)}
        </div>
      </div>`, (s) => s.id)}
    </main>`;
  }
}
defineComponent('flow-page', FlowPage);

// --- node catalog: browse/filter/mark-reviewed every logical node -------------
class NodeCatalogPage extends Component {
  static props = { params: {}, query: {} };
  constructor(props) { super(props); this.state = { data: null, f: { q: '', type: '', domain: '', gen: '', review: '' }, group: 'type' }; }
  load = this.createTask(async () => { nav.current = this.props.params.universe; this.state.data = await api('/api/nodes', { u: this.props.params.universe }); });
  mounted() { this.load.run(); }
  propsChanged() { this.load.run(); }
  set(k, v) { this.state.f = { ...this.state.f, [k]: v }; }
  setGroup(v) { this.state.group = v; }
  async verify(id, act) { await postReview(this.props.params.universe, 'node', id, 'logical', act === 'unverify'); this.load.run(); }
  async toggle(id, level, state) { await postReview(this.props.params.universe, 'node', id, level, state === 'reviewed'); this.load.run(); }
  // Human review = green (`on`); an agent `checked` review = blue, so it never reads
  // as fully-verified. A web toggle always records a human review.
  revBtn(id, level, state, actor) {
    const agent = state === 'reviewed' && actor === 'agent';
    const cls = state === 'reviewed' ? (agent ? 'checked' : 'on') : state === 'stale' ? 'stale' : '';
    const mark = state === 'reviewed' ? (agent ? '·' : '✓') : state === 'stale' ? '⚠' : '';
    return html`<button class="${cls}" title="${level}: ${state}${agent ? ' (agent-checked — click to verify)' : ''}" on-click="${(e) => { if (e.stopPropagation) e.stopPropagation(); this.toggle(id, level, state); }}">${level[0].toUpperCase()}${mark}</button>`;
  }
  filtered() {
    const f = this.state.f, q = f.q.toLowerCase();
    return this.state.data.nodes.filter((n) =>
      (!q || n.title.toLowerCase().includes(q) || (n.summary || '').toLowerCase().includes(q) || n.id.toLowerCase().includes(q)) &&
      (!f.type || n.type === f.type) &&
      (!f.domain || n.domain === f.domain) &&
      (!f.gen || (f.gen === 'human' ? !n.generatedBy : n.generatedBy === f.gen)) &&
      (!f.status || n.status === f.status) &&
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
  template() {
    const u = this.props.params.universe, d = this.state.data;
    if (!d || this.load.pending) return html`<main><div class="loading">loading…</div></main>`;
    const list = this.filtered();
    const opts = (o) => Object.entries(o).sort((a, b) => b[1] - a[1]).map(([k, v]) => ({ k, v }));
    return html`<main>
      <div class="crumbs">${u} <span class="sep">·</span> nodes (${d.total}) <span class="sep">·</span> ${d.reviewed} reviewed${when(d.byStatus && (d.byStatus.stale || d.byStatus.dangling), () => html` <span class="sep">·</span> <b class="bad">${(d.byStatus.stale || 0) + (d.byStatus.dangling || 0)} need review</b>`)}</div>
      <div class="nfilters">
        <input placeholder="filter title…" on-input="${(e) => this.set('q', e.target.value)}">
        <select on-change="${(e) => this.set('type', e.target.value)}"><option value="">all types</option>${each(opts(d.byType), o => html`<option value="${o.k}">${o.k} (${o.v})</option>`, o => o.k)}</select>
        <select on-change="${(e) => this.set('domain', e.target.value)}"><option value="">all domains</option>${each(opts(d.byDomain), o => html`<option value="${o.k}">${o.k} (${o.v})</option>`, o => o.k)}</select>
        <select on-change="${(e) => this.set('status', e.target.value)}"><option value="">any status</option>${each(opts(d.byStatus || {}), o => html`<option value="${o.k}">${o.k} (${o.v})</option>`, o => o.k)}</select>
        <select on-change="${(e) => this.set('gen', e.target.value)}"><option value="">any source</option><option value="human">human</option><option value="marten">marten</option></select>
        <select on-change="${(e) => this.set('review', e.target.value)}"><option value="">any review</option><option value="unreviewed">unreviewed</option><option value="reviewed">reviewed</option><option value="stale">stale</option></select>
        <select on-change="${(e) => this.setGroup(e.target.value)}"><option value="type">group: type</option><option value="domain">group: domain</option><option value="none">group: none</option></select>
      </div>
      <div class="ncount">${list.length} shown</div>
      ${each(this.groups(list), g => html`<div class="ngroup">
        <div class="ngh"><span class="gdot" style="background:${nodeColor(g[0])}"></span>${g[0]} <span class="n">${g[1].length}</span></div>
        ${each(g[1], n => html`<div class="nrow" on-click="${() => go(nodeUrl(u, n.id))}">
          <span class="nt" style="border-color:${nodeColor(n.type)}">${n.type}</span>
          <span class="ntitle">${n.title || n.id}${when(n.versionCount > 1, () => html`<span class="vfork" title="${n.versionCount} versions (forked)">⑂${n.versionCount}</span>`)}</span>
          ${statusChip(n.status)}${trustChip(n.trust, (act) => this.verify(n.id, act))}
          <span class="ndom">${n.domain}</span>
          <span class="nmeta">${n.anchors}a · ${n.edgesIn}↓${n.edgesOut}↑</span>
          ${when(n.generatedBy, () => html`<span class="gen">${n.generatedBy}</span>`)}
          <span class="nrev">${this.revBtn(n.id, 'logical', n.review.logical, n.reviewBy && n.reviewBy.logical)}${this.revBtn(n.id, 'code', n.review.code, n.reviewBy && n.reviewBy.code)}</span>
        </div>`, n => n.id)}
      </div>`, g => g[0])}
    </main>`;
  }
}
defineComponent('node-catalog-page', NodeCatalogPage);

// --- event wiring matrix: events × aggregates/projections, orphans surfaced ---
class MatrixPage extends Component {
  static props = { params: {}, query: {} };
  constructor(props) { super(props); this.state = { data: null, f: { q: '', domain: '', orphan: false } }; }
  load = this.createTask(async () => { nav.current = this.props.params.universe; this.state.data = await api('/api/matrix', { u: this.props.params.universe }); });
  mounted() { this.load.run(); }
  propsChanged() { this.load.run(); }
  set(k, v) { this.state.f = { ...this.state.f, [k]: v }; }
  async toggle(id, level, state) { await postReview(this.props.params.universe, 'node', id, level, state === 'reviewed'); this.load.run(); }
  // Human review = green (`on`); an agent `checked` review = blue, so it never reads
  // as fully-verified. A web toggle always records a human review.
  revBtn(id, level, state, actor) {
    const agent = state === 'reviewed' && actor === 'agent';
    const cls = state === 'reviewed' ? (agent ? 'checked' : 'on') : state === 'stale' ? 'stale' : '';
    const mark = state === 'reviewed' ? (agent ? '·' : '✓') : state === 'stale' ? '⚠' : '';
    return html`<button class="${cls}" title="${level}: ${state}${agent ? ' (agent-checked — click to verify)' : ''}" on-click="${(e) => { if (e.stopPropagation) e.stopPropagation(); this.toggle(id, level, state); }}">${level[0].toUpperCase()}${mark}</button>`;
  }
  filtered() {
    const f = this.state.f, q = f.q.toLowerCase();
    return this.state.data.events.filter((e) =>
      (!q || e.title.toLowerCase().includes(q)) && (!f.domain || e.domain === f.domain) && (!f.orphan || e.orphan));
  }
  template() {
    const u = this.props.params.universe, d = this.state.data;
    if (!d || this.load.pending) return html`<main><div class="loading">loading…</div></main>`;
    const rows = this.filtered();
    const domains = [...new Set(d.events.map((e) => e.domain))].sort();
    return html`<main>
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
          <span class="mrevh"><span class="nrev">${this.revBtn(e.id, 'logical', e.review.logical, e.reviewBy && e.reviewBy.logical)}${this.revBtn(e.id, 'code', e.review.code, e.reviewBy && e.reviewBy.code)}</span></span>
        </div>`, e => e.id)}
      </div>
    </main>`;
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
    return html`${statusChip(n.status)}${when(n.versionCount > 1, () => html`<span class="vfork" title="${n.versionCount} versions">⑂${n.versionCount}</span>`)}<span class="ddacts">
      ${when(n.status === 'stale', () => html`<button title="confirm the doc still holds at this code" on-click="${(e) => { if (e.stopPropagation) e.stopPropagation(); this.confirmDoc(n.id); }}">confirm</button>`)}
      ${when(n.status === 'dangling', () => html`<button class="bad" title="cited code was removed here — ack" on-click="${(e) => { if (e.stopPropagation) e.stopPropagation(); this.ackDoc(n.id); }}">ack-hole</button>`)}
      <span class="rev">${this.revBtn('node', n.id, 'logical', n.review.logical, () => this.reloadDiff(), n.reviewBy && n.reviewBy.logical)}</span></span>`;
  }
  revBtn(kind, id, level, state, after, actor) {
    const cls = revCls(state, actor);
    const tip = `${level}: ${state}${state === 'reviewed' && actor === 'agent' ? ' (agent-checked)' : ''}`;
    return html`<button class="${cls}" title="${tip}" on-click="${async (e) => { if (e.stopPropagation) e.stopPropagation(); await postReview(this.props.params.universe, kind, id, level, state === 'reviewed'); await after(); }}">${level}${revMark(state, actor)}</button>`;
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
      ${when(c, () => html`<pre class="hljs cdiff">${each(c.lines, ln => html`<div class="cl ${DTAG[ln.tag] || 'ctx'}"><span class="g">${ln.tag}</span><code>${raw(highlight(ln.text || ' ', c.lang))}</code></div>`)}</pre>`)}
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

router = enableRouting(document.querySelector('router-outlet'), {
  '/': { component: 'home-page' },
  '/u/:universe/': { component: 'dashboard-page' },
  '/u/:universe/tree/': { component: 'outline-page' },
  '/u/:universe/tree/:path*/': { component: 'outline-page' },
  '/u/:universe/anchor/:id/': { component: 'anchor-page' },
  '/u/:universe/node/:id/': { component: 'node-page' },
  '/u/:universe/graph/:id/': { component: 'graph-page' },
  '/u/:universe/flows/': { component: 'flows-page' },
  '/u/:universe/flow/:id/': { component: 'flow-page' },
  '/u/:universe/nodes/': { component: 'node-catalog-page' },
  '/u/:universe/matrix/': { component: 'matrix-page' },
  '/u/:universe/pipeline/': { component: 'pipeline-page' },
  '/u/:universe/bugs/': { component: 'bugs-page' },
  '/u/:universe/diff/': { component: 'diff-page' },
  '/u/:universe/search/': { component: 'search-page' },
});
