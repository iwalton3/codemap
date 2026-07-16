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
const flowsUrl = (u) => `/u/${u}/flows/`;
const flowUrl = (u, id) => `/u/${u}/flow/${id}/`;
const nodesUrl = (u) => `/u/${u}/nodes/`;
const REV_COLOR = { reviewed: '#7ee787', stale: '#f0a35e', unreviewed: '#3a4250' };
const postReview = (u, targetKind, targetId, level, unmark) =>
  fetch('/api/review', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ u, targetKind, targetId, level, unmark }) });
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
const revDot = (state) => html`<span class="rd ${state === 'reviewed' ? 'done' : state === 'stale' ? 'stale' : ''}"></span>`;

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
      <div class="uni">${each(n.universes, u => html`<button class="${u.id === n.current ? 'active' : ''}" on-click="${() => goTree(u.id, '')}">${u.id}<span class="n">${u.anchors ?? '–'}</span></button>`)}</div>
      <a class="viewlink" on-click="${() => { const u = n.current || (n.universes[0] && n.universes[0].id); if (u) go(nodesUrl(u)); }}">nodes</a>
      <a class="viewlink" on-click="${() => { const u = n.current || (n.universes[0] && n.universes[0].id); if (u) go(flowsUrl(u)); }}">flows</a>
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
    if (p) goTree(p.id, '');
  }
  template() { return html`<main><div class="loading">loading…</div></main>`; }
}
defineComponent('home-page', HomePage);

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
          <span><span class="dot ${(s.coverage === 'cited' || s.coverage === 'covered') ? 'on' : ''}" title="coverage: ${s.coverage}"></span>${s.symbol}${when(s.review, () => html`<span class="rdots" title="logical ${s.review.logical} · code ${s.review.code}">${revDot(s.review.logical)}${revDot(s.review.code)}</span>`)}</span><span class="muted">${s.lines ?? ''}</span></div>`)}</div>`;
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
      ${when(a.annotations && a.annotations.length, () => html`<div class="sec">notes</div>${each(a.annotations, an => html`<md-content text="${an.text}"></md-content>`)}`)}
      <div class="sec">source</div>
      ${when(a.code, () => html`<pre class="hljs"><code>${raw(highlight(a.code, a.lang))}</code></pre>`, () => html`<pre class="code">(unavailable)</pre>`)}
    </div></main>`;
  }
}
defineComponent('anchor-page', AnchorPage);

class NodePage extends Component {
  static props = { params: {}, query: {} };
  constructor(props) { super(props); this.state = { n: null }; }
  load = this.createTask(async () => { nav.current = this.props.params.universe; this.state.n = await api('/api/node', { u: this.props.params.universe, id: this.props.params.id }); });
  mounted() { this.load.run(); }
  propsChanged() { this.load.run(); }
  template() {
    const u = this.props.params.universe, n = this.state.n;
    if (!n || this.load.pending) return html`<main><div class="loading">loading…</div></main>`;
    if (n.error) return html`<main><div class="empty">${n.error}</div></main>`;
    return html`<main><div class="detail">
      <div class="meta">${n.type}${n.universe ? ' · ' + n.universe : ''} · ${n.id}<span class="viewlink" on-click="${() => go(graphUrl(u, n.id))}">◆ graph</span></div>
      <h2>${n.title}</h2>
      <md-content text="${n.summary}"></md-content>
      ${when(n.body && n.body.trim(), () => html`<md-content text="${n.body}"></md-content>`)}
      <div class="sec">anchors</div>
      <div class="chips">${each(n.resolvedAnchors ?? [], a => html`<span class="chip" on-click="${() => a.id && go(anchorUrl(u, a.id))}">${a.symbol ?? a.id}</span>`)}</div>
      ${when(n.edges && n.edges.length, () => html`<div class="sec">edges</div><div class="chips">${each(n.edges, e => html`<span class="chip" on-click="${() => e.toRef && go(nodeUrl(e.toRef.universe, e.toRef.id))}">${e.type}: ${e.toRef ? e.toRef.universe + '::' + (e.toRef.title || e.toRef.id) : e.to}</span>`)}</div>`)}
      ${when(n.inboundCrossUniverse && n.inboundCrossUniverse.length, () => html`<div class="sec">called by (other universes)</div><div class="chips">${each(n.inboundCrossUniverse, i => html`<span class="chip" on-click="${() => go(nodeUrl(i.fromUniverse, i.from))}">${i.fromUniverse}::${i.from} (${i.type})</span>`)}</div>`)}
      ${when(n.annotations && n.annotations.length, () => html`<div class="sec">notes</div>${each(n.annotations, an => html`<md-content text="${an.text}"></md-content>`)}`)}
    </div></main>`;
  }
}
defineComponent('node-page', NodePage);

class SearchPage extends Component {
  static props = { params: {}, query: {} };
  constructor(props) { super(props); this.state = { r: null }; }
  load = this.createTask(async () => {
    nav.current = this.props.params.universe;
    const q = this.props.query.q || '';
    this.state.r = q ? await api('/api/search', { u: this.props.params.universe, q }) : null;
  });
  mounted() { this.load.run(); }
  propsChanged() { this.load.run(); }
  template() {
    const u = this.props.params.universe, r = this.state.r;
    return html`<main>
      <div class="crumbs"><a on-click="${() => goTree(u, '')}">${u}</a> <span class="sep">/</span> search: ${this.props.query.q || ''}</div>
      ${when(!r, () => html`<div class="empty">type a query…</div>`, () => html`<div class="detail">
        <div class="sec">nodes</div><div class="chips">${each(r.nodes ?? [], n => html`<span class="chip" on-click="${() => go(nodeUrl(u, n.id))}">${n.title || n.id}</span>`)}</div>
        <div class="sec">anchors</div><div class="rows">${each(r.anchors ?? [], a => html`<div class="sym" on-click="${() => go(anchorUrl(u, a.id))}"><span class="k">${a.kind}</span><span>${a.symbol}</span><span class="muted">${a.file}</span></div>`)}</div>
      </div>`)}
    </main>`;
  }
}
defineComponent('search-page', SearchPage);

class GraphPage extends Component {
  static props = { params: {}, query: {} };
  constructor(props) { super(props); this.state = { data: null }; }
  load = this.createTask(async () => { nav.current = this.props.params.universe; this.state.data = await api('/api/neighborhood', { u: this.props.params.universe, id: this.props.params.id }); });
  mounted() { this.load.run(); }
  propsChanged() { this.load.run(); }
  onClick(e) {
    const g = e.target.closest('[data-id]');
    if (g) go(graphUrl(this.props.params.universe, g.getAttribute('data-id')));
  }
  gnode(x, y, title, type, center, id, edges) {
    const w = 158, h = 34, color = nodeColor(type);
    const t = title.length > 22 ? title.slice(0, 21) + '…' : title;
    const dir = edges ? edges.map((e) => (e.dir === 'out' ? '▸' : '◂') + e.edgeType).join(' ') : '';
    return html`<g data-id="${id}">
      <rect x="${x - w / 2}" y="${y - h / 2}" width="${w}" height="${h}" rx="8" fill="${center ? '#1c232d' : '#161b22'}" stroke="${color}" stroke-width="${center ? 2.4 : 1.4}"></rect>
      <text x="${x}" y="${y - h / 2 - 5}" fill="${color}" font-size="9.5" text-anchor="middle">${type}</text>
      <text x="${x}" y="${y + 4}" fill="#d7dde5" font-size="11.5" text-anchor="middle" font-family="ui-monospace,monospace">${t}</text>
      ${when(dir, () => html`<text x="${x}" y="${y + h / 2 + 12}" fill="#8b95a3" font-size="9" text-anchor="middle">${dir}</text>`)}
    </g>`;
  }
  template() {
    const u = this.props.params.universe, d = this.state.data;
    if (!d || this.load.pending) return html`<main><div class="loading">loading…</div></main>`;
    if (d.error) return html`<main><div class="empty">${d.error}</div></main>`;
    const W = 940, H = 560, cx = W / 2, cy = H / 2, R = 200;
    const shown = d.neighbors.slice(0, 28);
    const placed = shown.map((n, i) => { const a = -Math.PI / 2 + 2 * Math.PI * i / Math.max(shown.length, 1); return { ...n, x: cx + R * Math.cos(a), y: cy + R * Math.sin(a) }; });
    const types = [...new Set([d.type, ...shown.map((n) => n.type)])];
    // Dynamic SVG straight from the template (vdx now namespaces it correctly).
    return html`<main>
      <div class="crumbs"><a on-click="${() => go(nodeUrl(u, d.id))}">← ${d.title}</a> <span class="sep">·</span> graph (${d.neighbors.length} neighbor${d.neighbors.length === 1 ? '' : 's'})</div>
      <svg viewBox="0 0 ${W} ${H}" class="graph" on-click="${(e) => this.onClick(e)}">
        ${each(placed, (n) => html`<line x1="${cx}" y1="${cy}" x2="${n.x}" y2="${n.y}" stroke="#2a313c" stroke-width="1.5"></line>`, (n) => 'e-' + n.id)}
        ${each(placed, (n) => this.gnode(n.x, n.y, n.title, n.type, false, n.id, n.edges), (n) => n.id)}
        ${this.gnode(cx, cy, d.title, d.type, true, d.id)}
      </svg>
      <div class="legend">${each(types, (t) => html`<span class="k"><span class="sw" style="background:${nodeColor(t)}"></span>${t}</span>`)}</div>
      ${when(d.neighbors.length > 28, () => html`<div class="empty">showing 28 of ${d.neighbors.length} neighbors</div>`)}
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
          <span><span class="rev-dot" style="background:${REV_COLOR[(f.review && f.review.logical.state) || 'unreviewed']}"></span>logical</span>
          <span><span class="rev-dot" style="background:${REV_COLOR[(f.review && f.review.code.state) || 'unreviewed']}"></span>code</span>
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
    const st = (info && info.state) || 'unreviewed';
    const cls = st === 'reviewed' ? 'on' : st === 'stale' ? 'stale' : '';
    const mark = st === 'reviewed' ? ' ✓' : st === 'stale' ? ' ⚠' : '';
    const tip = `${level} ${st}${info && info.by ? ' · by ' + info.by : ''}`;
    return html`<button class="${cls}" title="${tip}" on-click="${(e) => { if (e.stopPropagation) e.stopPropagation(); this.toggle(kind, id, level, st); }}">${level}${mark}</button>`;
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
  async toggle(id, level, state) { await postReview(this.props.params.universe, 'node', id, level, state === 'reviewed'); this.load.run(); }
  revBtn(id, level, state) {
    const cls = state === 'reviewed' ? 'on' : state === 'stale' ? 'stale' : '';
    const mark = state === 'reviewed' ? '✓' : state === 'stale' ? '⚠' : '';
    return html`<button class="${cls}" title="${level}: ${state}" on-click="${(e) => { if (e.stopPropagation) e.stopPropagation(); this.toggle(id, level, state); }}">${level[0].toUpperCase()}${mark}</button>`;
  }
  filtered() {
    const f = this.state.f, q = f.q.toLowerCase();
    return this.state.data.nodes.filter((n) =>
      (!q || n.title.toLowerCase().includes(q) || (n.summary || '').toLowerCase().includes(q) || n.id.toLowerCase().includes(q)) &&
      (!f.type || n.type === f.type) &&
      (!f.domain || n.domain === f.domain) &&
      (!f.gen || (f.gen === 'human' ? !n.generatedBy : n.generatedBy === f.gen)) &&
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
      <div class="crumbs">${u} <span class="sep">·</span> nodes (${d.total}) <span class="sep">·</span> ${d.reviewed} reviewed</div>
      <div class="nfilters">
        <input placeholder="filter title…" on-input="${(e) => this.set('q', e.target.value)}">
        <select on-change="${(e) => this.set('type', e.target.value)}"><option value="">all types</option>${each(opts(d.byType), o => html`<option value="${o.k}">${o.k} (${o.v})</option>`, o => o.k)}</select>
        <select on-change="${(e) => this.set('domain', e.target.value)}"><option value="">all domains</option>${each(opts(d.byDomain), o => html`<option value="${o.k}">${o.k} (${o.v})</option>`, o => o.k)}</select>
        <select on-change="${(e) => this.set('gen', e.target.value)}"><option value="">any source</option><option value="human">human</option><option value="marten">marten</option></select>
        <select on-change="${(e) => this.set('review', e.target.value)}"><option value="">any review</option><option value="unreviewed">unreviewed</option><option value="reviewed">reviewed</option><option value="stale">stale</option></select>
        <select on-change="${(e) => this.setGroup(e.target.value)}"><option value="type">group: type</option><option value="domain">group: domain</option><option value="none">group: none</option></select>
      </div>
      <div class="ncount">${list.length} shown</div>
      ${each(this.groups(list), g => html`<div class="ngroup">
        <div class="ngh"><span class="gdot" style="background:${nodeColor(g[0])}"></span>${g[0]} <span class="n">${g[1].length}</span></div>
        ${each(g[1], n => html`<div class="nrow" on-click="${() => go(nodeUrl(u, n.id))}">
          <span class="nt" style="border-color:${nodeColor(n.type)}">${n.type}</span>
          <span class="ntitle">${n.title || n.id}</span>
          <span class="ndom">${n.domain}</span>
          <span class="nmeta">${n.anchors}a · ${n.edgesIn}↓${n.edgesOut}↑</span>
          ${when(n.generatedBy, () => html`<span class="gen">${n.generatedBy}</span>`)}
          <span class="nrev">${this.revBtn(n.id, 'logical', n.review.logical)}${this.revBtn(n.id, 'code', n.review.code)}</span>
        </div>`, n => n.id)}
      </div>`, g => g[0])}
    </main>`;
  }
}
defineComponent('node-catalog-page', NodeCatalogPage);

const diffUrl = (u) => `/u/${u}/diff/`;
const DTAG = { '+': 'added', '-': 'removed', '~': 'changed' };

class DiffPage extends Component {
  static props = { params: {}, query: {} };
  constructor(props) { super(props); this.state = { snaps: null, diff: null, sel: null, selCode: null, codePending: false }; }
  load = this.createTask(async () => {
    const u = this.props.params.universe; nav.current = u;
    if (!this.state.snaps) this.state.snaps = (await api('/api/snapshots', { u })).snapshots;
    this.state.sel = null; this.state.selCode = null;
    const base = this.props.query.base;
    this.state.diff = base ? await api('/api/diff', { u, base, head: this.props.query.head || '' }) : null;
  });
  mounted() { this.load.run(); }
  propsChanged() { this.load.run(); }

  pick(kind, val) {
    const q = { base: this.props.query.base, head: this.props.query.head };
    q[kind] = val;
    go(diffUrl(this.props.params.universe), q);
  }
  async openCode(b) {
    const u = this.props.params.universe;
    this.state.sel = b; this.state.selCode = null; this.state.codePending = true;
    try {
      this.state.selCode = await api('/api/diff/code', { u, base: this.props.query.base, head: this.props.query.head || '', id: b.id, file: b.file });
    } finally { this.state.codePending = false; }
  }

  // Group the raw symbol changes by file for the structural view.
  byFile(d) {
    const m = new Map();
    const push = (b, tag) => { const g = m.get(b.file) || { file: b.file, items: [] }; g.items.push({ ...b, tag }); m.set(b.file, g); };
    d.added.forEach(b => push(b, '+')); d.removed.forEach(b => push(b, '-')); d.changed.forEach(b => push(b, '~'));
    return [...m.values()].sort((a, z) => a.file.localeCompare(z.file));
  }
  docsFor(id) { return (this.state.diff.impact.nodes || []).filter(n => (n.anchors || []).includes(id)); }

  symRow(b) {
    const sel = this.state.sel && this.state.sel.id === b.id;
    return html`<div class="drow ${DTAG[b.tag]} ${sel ? 'sel' : ''}" on-click="${() => this.openCode(b)}">
      <span class="dt ${DTAG[b.tag]}">${b.tag}</span><span class="dsym">${b.symbol}</span><span class="dk">${b.kind}</span>
    </div>`;
  }

  detail() {
    const u = this.props.params.universe, b = this.state.sel, c = this.state.selCode;
    if (!b) return html`<div class="empty" style="padding:40px">select a changed symbol to see its code & docs</div>`;
    const docs = this.docsFor(b.id);
    return html`<div class="ddetail">
      <div class="dsymhead"><span class="dt ${DTAG[b.tag]}">${b.tag}</span> <b>${b.symbol}</b> <span class="dk">${b.kind}</span></div>
      <div class="meta">${b.file}${c ? ' · ' + (c.hasBase ? 'base' : '∅') + ' → ' + (c.hasHead ? 'head' : '∅') : ''}
        <span class="viewlink" on-click="${() => go(anchorUrl(u, b.id))}">open anchor ›</span></div>
      ${when(docs.length, () => html`<div class="sec">documented by (docs this change may stale)</div>
        <div class="chips">${each(docs, n => html`<span class="chip" on-click="${() => go(nodeUrl(u, n.id))}">${n.title || n.id}</span>`, n => n.id)}</div>`)}
      <div class="sec">code diff</div>
      ${when(this.state.codePending, () => html`<div class="loading">loading code…</div>`)}
      ${when(c, () => html`<pre class="hljs cdiff">${each(c.lines, ln => html`<div class="cl ${DTAG[ln.tag] || 'ctx'}"><span class="g">${ln.tag}</span><code>${raw(highlight(ln.text || ' ', c.lang))}</code></div>`)}</pre>`)}
    </div>`;
  }

  template() {
    const u = this.props.params.universe, d = this.state.diff, snaps = this.state.snaps || [];
    const base = this.props.query.base || '', head = this.props.query.head || '';
    const opt = (s, val) => html`<option value="${s.ref}" selected="${s.ref === val}">${(s.branch || '(detached)')} · ${s.ref.slice(0, 8)} (${s.count})</option>`;
    return html`<main>
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
            ${when(d.impact.reviews.length, () => html`<div class="sec">reviews impacted (${d.impact.reviews.length})</div>
              <div class="chips">${each(d.impact.reviews, r => html`<span class="chip warn">${r.level} · ${r.target.kind} ${r.target.id}</span>`, r => r.id)}</div>`)}

            <div class="sec">structural changes</div>
            ${when(!this.byFile(d).length, () => html`<div class="dim" style="padding:8px 2px">no symbol-level changes</div>`)}
            ${each(this.byFile(d), g => html`<div class="dfile">
              <div class="dfileh" on-click="${() => goTree(u, g.file)}">${g.file} <span class="dim">${g.items.length}</span></div>
              ${each(g.items, b => this.symRow(b), b => b.id + b.tag)}
            </div>`, g => g.file)}
          </div>
          <div class="dright">${this.detail()}</div>
        </div>`)}
    </main>`;
  }

  // Open code for an anchor id referenced by a flow step (look up its brief from the diff).
  openCodeById(id) {
    const d = this.state.diff;
    const b = [...d.changed, ...d.removed, ...d.added].find(x => x.id === id);
    if (b) this.openCode(b);
  }
}
defineComponent('diff-page', DiffPage);

router = enableRouting(document.querySelector('router-outlet'), {
  '/': { component: 'home-page' },
  '/u/:universe/tree/': { component: 'outline-page' },
  '/u/:universe/tree/:path*/': { component: 'outline-page' },
  '/u/:universe/anchor/:id/': { component: 'anchor-page' },
  '/u/:universe/node/:id/': { component: 'node-page' },
  '/u/:universe/graph/:id/': { component: 'graph-page' },
  '/u/:universe/flows/': { component: 'flows-page' },
  '/u/:universe/flow/:id/': { component: 'flow-page' },
  '/u/:universe/nodes/': { component: 'node-catalog-page' },
  '/u/:universe/diff/': { component: 'diff-page' },
  '/u/:universe/search/': { component: 'search-page' },
});
