/**
 * Review topics: the list, and one topic's walkthroughs (docs/review-topics.md).
 *
 * A snapshot is read and signed at ITS commit; what main has moved since, how the selector
 * changed and what it now matches that no walk has seen are indicators, never edits.
 *
 * It imports only `./core.js`, which imports neither of the other two — see
 * `src/import-cycles.test.ts`, and CLAUDE.md § "The web app is typechecked in place".
 */
import { Component, defineComponent, html, when, each, raw } from './vendor/vdx/framework.js';
import { api, apiPost, pageShell, nav, href, errText, taskError, isErr, sharedUrl } from './core.js';

/**
 * @typedef {import('./core.js').ApiMap} ApiMap
 * @typedef {{ params: { universe: string, slug?: string }, query: { walk?: string, all?: string } }} PageProps
 */

export const topicsUrl = (u) => `/u/${u}/topics/`;
export const topicUrl = (u, slug, walk) => `/u/${u}/topic/${slug}/` + (walk ? `?walk=${encodeURIComponent(walk)}` : '');

const short = (sha) => (sha ? String(sha).slice(0, 10) : '');
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
/** @param {string} code @param {string} lang */
const highlight = (code, lang) => {
  const hljs = /** @type {any} */ (window).hljs;
  if (hljs && lang && lang !== 'plaintext') { try { return hljs.highlight(code, { language: lang, ignoreIllegals: true }).value; } catch { /* plain */ } }
  return esc(code);
};
const selectorText = (s) => [
  ...(s.paths || []).map((p) => `path ${p}`),
  ...(s.symbols || []).map((x) => `symbol ${x}`),
  ...(s.nodes || []).map((n) => `node ${n}`),
  ...(s.base ? [`since ${short(s.base)}`] : []),
].join(' · ');

class TopicsPage extends Component {
  static props = { params: {}, query: {} };
  /** @param {PageProps} props */
  constructor(props) {
    super(props);
    /** @type {{ d: ApiMap['/api/topics'] | null }} */
    this.state = { d: null };
  }
  load = this.createTask(async () => {
    const u = this.props.params.universe; nav.current = u;
    this.state.d = await api('/api/topics', { u, all: this.props.query.all === '1' ? '1' : '' });
  });
  mounted() { this.load.run(); }
  propsChanged() { this.state.d = null; this.load.run(); }

  template() {
    const u = this.props.params.universe, d = this.state.d;
    return pageShell(d, taskError(this.load) ?? (isErr(d) ? d.error : null), () => {
      const v = /** @type {Exclude<ApiMap['/api/topics'], { error: string }>} */ (d);
      return html`
        <div class="crumbs"><b>${u}</b> <span class="sep">·</span> review topics</div>
        <div class="blintro">
          A topic is a named selector over the code — a business-critical subset, or a merged range —
          walked by an agent into point-in-time walkthroughs that a person reads and signs. Agents
          define and walk them (<code>topic</code>, <code>topic_walkthrough</code>); you read and sign here.
        </div>
        ${when(!v.topics.length, () => html`<div class="dim">no topics yet</div>`)}
        ${each(v.topics, (t) => html`<div class="blrow">
          <div class="blhead">
            <a href="${href(topicUrl(u, t.slug))}"><b>${t.title}</b></a>
            <span class="dim">topic:${t.slug}</span>
            ${when(t.status === 'retired', () => html`<span class="prbadge">retired</span>`)}
            <span class="dim blwho">${t.walks} walkthrough${t.walks === 1 ? '' : 's'}${t.latest ? ` · latest at ${short(t.latest.head)}` : ''}</span>
          </div>
          <div class="bltext dim">${selectorText(t.selector)} — defined by ${t.definedBy.principal}${t.revisions.length ? `, revised ${t.revisions.length}×` : ''}</div>
        </div>`, (t) => t.slug)}
        ${when('retired' in v && v.retired > 0, () => html`<div class="dim"><a href="${href(topicsUrl(u) + '?all=1')}">${v.retired} retired</a></div>`)}
      `;
    });
  }
}
defineComponent('topics-page', TopicsPage);

/**
 * @typedef {Exclude<ApiMap['/api/topic/walkthrough'], { error: string }>} TopicRead
 * @typedef {{ d: TopicRead | null, code: Record<string, ApiMap['/api/topic/code'] | null>, busy: string | null, err: string | null }} TopicState
 */
class TopicPage extends Component {
  static props = { params: {}, query: {} };
  /** @param {PageProps} props */
  constructor(props) {
    super(props);
    /** @type {TopicState} */
    this.state = { d: null, code: {}, busy: null, err: null };
  }
  load = this.createTask(async () => {
    const u = this.props.params.universe; nav.current = u;
    this.state.d = /** @type {TopicRead} */ (await api('/api/topic/walkthrough', { u, slug: this.props.params.slug, walk: this.props.query.walk || '' }));
  });
  mounted() { this.load.run(); }
  propsChanged() { this.state.d = null; this.state.code = {}; this.state.err = null; this.load.run(); }

  async toggleCode(id) {
    if (this.state.code[id]) { this.state.code = { ...this.state.code, [id]: null }; return; }
    try {
      const c = await api('/api/topic/code', { u: this.props.params.universe, slug: this.props.params.slug, walk: this.state.d.walk, id });
      this.state.code = { ...this.state.code, [id]: c };
    } catch (e) { this.state.code = { ...this.state.code, [id]: { error: errText(e) } }; }
  }

  /** Sign or withdraw, one symbol or a chapter. The page re-reads the walk's own history after. */
  async mark(kind, target, attestation, unmark) {
    const d = this.state.d;
    this.state.busy = target; this.state.err = null;
    try {
      const r = await apiPost(kind === 'chapter' ? '/api/topic/chapter_mark' : '/api/topic/step_mark', {
        u: this.props.params.universe, slug: this.props.params.slug, walk: d.walk,
        ...(kind === 'chapter' ? { chapter: target } : { id: target }), attestation, unmark,
      });
      if (r && r.error) { this.state.err = r.error; return; }
      if (r && r.signoffs) this.state.d = { ...d, signoffs: r.signoffs };
    } catch (e) { this.state.err = errText(e); } finally { this.state.busy = null; }
  }

  signBtn(kind, target, on) {
    return html`<button class="${on ? 'on' : ''}" disabled="${this.state.busy === target}"
      title="${on ? 'signed in THIS walkthrough — click to withdraw' : 'sign: I read this, at this walkthrough’s commit'}"
      on-click="${() => this.mark(kind, target, 'signed', on)}">${on ? '✓ signed' : 'sign'}</button>`;
  }

  symbolEl(id) {
    const d = this.state.d, s = d.signoffs.symbols[id] || {}, c = this.state.code[id];
    const moved = !!d.moved && d.moved.symbols.includes(id);
    return html`<div class="rvstep">
      <div class="blhead">
        <a class="dim" href="${href(`/u/${this.props.params.universe}/anchor/${id}/`)}">${id}</a>
        ${when(moved, () => html`<span class="prbadge" title="main's tip has changed this symbol since this walkthrough's commit">code moved on main</span>`)}
        ${when(!!s.coveredBy && s.signed, () => html`<span class="dim" title="signed through its container">via ${s.coveredBy}</span>`)}
        ${this.signBtn('symbol', id, !!s.signed)}
        <button on-click="${() => this.toggleCode(id)}">${c ? 'hide code' : 'code'}</button>
      </div>
      ${when(!!c, () => this.codeEl(c))}
    </div>`;
  }

  /** @param {ApiMap['/api/topic/code']} c */
  codeEl(c) {
    if (isErr(c)) return html`<pre class="code">${/** @type {{ error: string }} */ (c).error}</pre>`;
    const s = /** @type {Exclude<ApiMap['/api/topic/code'], { error: string }>} */ (c);
    return html`<div class="dim">${s.file} › ${s.symbol}${s.deleted ? ' — deleted by this range; shown at its base' : ''}</div>
      ${when(s.code != null, () => html`<pre class="hljs"><code>${raw(highlight(s.code, s.lang))}</code></pre>`, () => html`<pre class="code">(unavailable)</pre>`)}`;
  }

  indicators(d) {
    const sc = d.selectorChanged, forms = ['paths', 'symbols', 'nodes'].filter((k) => sc[k]);
    const notes = [];
    if (forms.length || sc.base) notes.push(html`<div class="attn-banner"><span class="attn-n">Δ</span><span>the topic's selector changed since this walkthrough:
      ${each(forms, (k) => html`<span> ${k} ${sc[k].added.length ? '+' + sc[k].added.join(', +') : ''}${sc[k].removed.length ? ' −' + sc[k].removed.join(', −') : ''};</span>`, (k) => k)}
      ${when(!!sc.base, () => html`<span> range ${short(sc.base.from) || 'none'} → ${short(sc.base.to) || 'none'}</span>`)}</span></div>`);
    if (d.moved && d.moved.chapters.length) notes.push(html`<div class="attn-banner"><span class="attn-n">⟳</span><span>main has moved the code of ${d.moved.symbols.length} symbol(s) in ${d.moved.chapters.length} chapter(s) since this walkthrough's commit — what was read here is no longer main's</span></div>`);
    if (d.newlyMatched && d.newlyMatched.length) notes.push(html`<div class="attn-banner"><span class="attn-n">+</span><span>${d.newlyMatched.length} symbol(s) match the selector now that no walkthrough has seen — the prompt to re-walk</span></div>`);
    const un = d.walkthrough.resolved.unresolved;
    if (un.length) notes.push(html`<div class="attn-banner"><span class="attn-n">?</span><span>${un.length} selector entr${un.length === 1 ? 'y' : 'ies'} named nothing at this commit: ${un.map((x) => x.id).join(', ')}</span></div>`);
    return notes;
  }

  template() {
    const u = this.props.params.universe, d = this.state.d, st = this.state;
    return pageShell(d, taskError(this.load) ?? (isErr(d) ? d.error : null), () => {
      if (!d.walkthrough) return html`<div class="crumbs"><b>${u}</b> <span class="sep">·</span> <a href="${href(topicsUrl(u))}">topics</a> <span class="sep">·</span> ${d.topic.title}</div>
        <div class="dim">no walkthrough of this topic yet — an agent writes one with <code>topic_walkthrough</code></div>`;
      const w = d.walkthrough, t = d.topic;
      return html`
        <div class="crumbs"><b>${u}</b> <span class="sep">·</span> <a href="${href(topicsUrl(u))}">topics</a> <span class="sep">·</span> <b>${t.title}</b>
          <span class="dim">· topic:${t.slug}${t.status === 'retired' ? ' · retired' : ''}</span></div>
        <div class="bltext dim">selector: ${selectorText(t.selector)} — defined by ${t.definedBy.principal}</div>
        <div class="dnav blfilter">
          ${each(d.walkthroughs, (x) => html`<a class="${x.id === d.walk ? 'on' : ''}" href="${href(topicUrl(u, t.slug, x.id))}"
            title="by ${x.author} (${x.by}) at ${x.at}">${short(x.head)}${x.base ? ` (since ${short(x.base)})` : ''} · ${(x.at || '').slice(0, 10)}</a>`, (x) => x.id)}
        </div>
        <div class="dim">walked at <code>${short(w.head)}</code>${w.base ? html` since <code>${short(w.base)}</code>` : ''} by ${d.author} (${w.by}) —
          ${w.resolved.ids.length} symbols in the set, ${w.resolved.outside.length} outside the review lane${d.trunk ? html` · main is <code>${short(d.trunk.sha)}</code>` : ''}</div>
        ${this.indicators(d)}
        ${when(!!st.err, () => html`<div class="attn-banner"><span class="attn-n">✕</span> <span>${st.err}</span></div>`)}
        ${each(w.features, (f) => html`<div class="sec">${f.title}</div>
          <div class="bltext">${f.summary}</div>
          ${each(f.chapters, (c) => html`<div class="blrow">
            <div class="blhead"><b>${c.title}</b>
              ${when(!!d.moved && d.moved.chapters.includes(c.id), () => html`<span class="prbadge">code moved on main</span>`)}
              ${this.signBtn('chapter', c.id, !!(d.signoffs.chapters[c.id] || {}).signed)}
            </div>
            ${each(c.blocks, (b) => (b.kind === 'prose' ? html`<md-content text="${b.text}"></md-content>` : this.symbolEl(b.anchorId)),
              (b, i) => c.id + ':' + i)}
          </div>`, (c) => c.id)}`, (f) => f.id)}
        <div class="sec">findings on this topic <span class="dim">— the topic's, not this walk's</span></div>
        ${when(!d.findings.length, () => html`<div class="dim">none</div>`)}
        ${each(d.findings, (f) => html`<div class="blrow"><div class="blhead">
          <a href="${href(sharedUrl(u, 'topic:' + t.slug))}">${f.id}</a> <span class="dim">${f.state}${f.severity ? ' · ' + f.severity : ''} · ${f.author}</span>
          </div><div class="bltext">${f.comment}</div></div>`, (f) => f.id)}
      `;
    });
  }
}
defineComponent('topic-page', TopicPage);
