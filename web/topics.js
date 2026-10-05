/**
 * Review topics: the list, and one topic's walkthroughs (docs/review-topics.md).
 *
 * A snapshot is read and signed at ITS commit; what main has moved since, how the selector
 * changed and what it now matches that no walk has seen are indicators, never edits.
 *
 * The walkthrough renders through the PR page's own views (`reading.js`), with this page as
 * their host — so a topic reads, signs and files findings the way a pull request does
 * (review round 2026-10-05, R5b). It imports `./core.js` and `./reading.js`, neither of which
 * imports a page — see `src/import-cycles.test.ts`.
 */
import { Component, defineComponent, html, when, each } from './vendor/vdx/framework.js';
import { api, apiPost, pageShell, nav, href, errText, taskError, isErr, sharedUrl } from './core.js';
import { walkFeaturesView, readingOrder, revealStep, unmarkOn, UNCOVERED_ID } from './reading.js';

/**
 * @typedef {import('./core.js').ApiMap} ApiMap
 * @typedef {{ params: { universe: string, slug?: string }, query: { walk?: string, all?: string } }} PageProps
 */

export const topicsUrl = (u) => `/u/${u}/topics/`;
export const topicUrl = (u, slug, walk) => `/u/${u}/topic/${slug}/` + (walk ? `?walk=${encodeURIComponent(walk)}` : '');

const short = (sha) => (sha ? String(sha).slice(0, 10) : '');
const selectorText = (s) => [
  ...(s.paths || []).map((p) => `path ${p}`),
  ...(s.symbols || []).map((x) => `symbol ${x}`),
  ...(s.nodes || []).map((n) => `node ${n}`),
  ...(s.base ? [`since ${short(s.base)}`] : []),
].join(' · ');

/** @extends {Component<PageProps, { d: ApiMap['/api/topics'] | null }>} */
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

/** The topic page's words for the shared walkthrough view (`reading.js` `walkFeaturesView`). */
const TOPIC_WALK_TIPS = {
  moved: "main's tip has changed code this chapter walks since this walkthrough's commit — what was signed here is no longer what main runs",
  unstated: "outside what the topic is about — something the agent found while walking it, and named",
  uncovered: "in the topic's set and in no chapter — nothing here has been explained, so it would be read unviewed and without context",
  missing: (id) => `a symbol this walkthrough cites is not in its commit (${id})`,
};

/**
 * @typedef {Exclude<ApiMap['/api/topic/walkthrough'], { error: string }>} TopicRead
 * @typedef {{
 *   d: TopicRead | null, code: Record<string, any>, pending: Record<string, boolean>,
 *   showDiff: Record<string, boolean>, open: Record<string, boolean>, chapterBusy: Record<string, boolean>,
 *   finding: string | null, raiseErr: { key: string, error: string } | null,
 *   err: string | null, note: string | null,
 * }} TopicState
 */
/** @extends {Component<PageProps, TopicState>} */
class TopicPage extends Component {
  static props = { params: {}, query: {} };
  static blank() {
    return { d: null, code: {}, pending: {}, showDiff: {}, open: {}, chapterBusy: {}, finding: null, raiseErr: null, err: null, note: null };
  }
  /** @param {PageProps} props */
  constructor(props) {
    super(props);
    /** @type {TopicState} */
    this.state = TopicPage.blank();
  }
  load = this.createTask(async () => {
    const u = this.props.params.universe; nav.current = u;
    this.state.d = /** @type {TopicRead} */ (await api('/api/topic/walkthrough', { u, slug: this.props.params.slug, walk: this.props.query.walk || '' }));
  });
  mounted() { this.load.run(); }
  propsChanged() { Object.assign(this.state, TopicPage.blank()); this.load.run(); }

  // --- the host contract of reading.js -------------------------------------------------

  stepsByAnchor() {
    const d = this.state.d;
    if (this._sbaOf === d && this._sba) return this._sba;
    this._sbaOf = d; this._sba = new Map(Object.entries((d && d.steps) || {}));
    return this._sba;
  }
  stepSigned(step) { return !!step && !!step.reviewed; }
  coverLabel(step) {
    const by = (step.review && step.review.coveredBy) || (step.viewedMark && step.viewedMark.coveredBy);
    const owner = by ? this.stepsByAnchor().get(by) : null;
    return owner ? owner.symbol.split(' › ').pop() : null;
  }
  /** What a cited container covers in this walk: shown under it, signed through it. */
  membersOf(id) {
    const c = (this.state.d.walkthrough.covers || []).find((x) => x.container === id);
    const steps = this.stepsByAnchor();
    return c ? c.members.map((m) => steps.get(m.anchorId)).filter(Boolean) : [];
  }
  findingContext() { return { kind: 'topic', topic: this.props.params.slug, walk: this.state.d.walk }; }
  // Chapters start open (the reading order); the unaccounted-for section starts closed.
  isOpen(id) { return id === UNCOVERED_ID ? !!this.state.open[id] : this.state.open[id] !== false; }
  toggleChapter(id) { this.state.open = { ...this.state.open, [id]: !this.isOpen(id) }; }

  async openStep(step) {
    const id = step.anchorId;
    if (this.state.code[id]) { this.state.code = { ...this.state.code, [id]: null }; return; }
    this.state.pending = { ...this.state.pending, [id]: true };
    try {
      const c = await api('/api/topic/code', { u: this.props.params.universe, slug: this.props.params.slug, walk: this.state.d.walk, id });
      this.state.code = { ...this.state.code, [id]: c };
    } catch (e) {
      this.state.code = { ...this.state.code, [id]: { error: `could not load this symbol's source: ${errText(e)}` } };
    } finally { this.state.pending = { ...this.state.pending, [id]: false }; }
  }

  /**
   * Sign or withdraw, then re-read the marks from the walk's own history in the response.
   * A response for a walk the page has since left is dropped (R28): writing it back would
   * put walk 1's state under walk 2's URL.
   */
  async post(path, body) {
    const walk = this.state.d.walk;
    this.state.err = null;
    try {
      const r = await apiPost(path, { u: this.props.params.universe, slug: this.props.params.slug, walk, ...body });
      if (!this.state.d || this.state.d.walk !== walk) return null;
      if (r && r.error) { this.state.err = r.error; return null; }
      const missed = (r && r.unwitnessed) || [];
      this.state.note = missed.length ? `${missed.length} symbol(s) not signed: this walkthrough's commit holds no code for them, so there is nothing to vouch for.` : null;
      if (r && r.signoffs) this.applySignoffs(r.signoffs);
      return r;
    } catch (e) { this.state.err = errText(e); return null; }
  }

  /** Each step's marks from this walk's sign-off state, as the server derived them. */
  applySignoffs(signoffs) {
    const d = this.state.d;
    const mark = (on, coveredBy) => (on ? { state: 'reviewed', actor: 'human', ...(coveredBy ? { coveredBy } : {}) } : { state: 'unreviewed' });
    const steps = Object.fromEntries(Object.entries(d.steps || {}).map(([id, s]) => {
      const o = signoffs.symbols[id] || {};
      return [id, { ...s, reviewed: !!o.signed, viewed: !!o.viewed, review: mark(o.signed, o.coveredBy), viewedMark: mark(o.viewed) }];
    }));
    this.state.d = /** @type {TopicRead} */ ({ ...d, signoffs, steps: /** @type {TopicRead['steps']} */ (/** @type {unknown} */ (steps)) });
  }

  async markStep(step, attestation, state, actor, via) {
    const id = step.anchorId;
    const unmark = unmarkOn(state, actor, via);
    const r = await this.post('/api/topic/step_mark', { id, attestation, unmark });
    if (!r || unmark || attestation !== 'signed' || (r.unwitnessed || []).includes(id)) return;
    // Signing is "done with this one", as on the PR page: fold a finished chapter away and
    // open the next symbol still to sign.
    const flat = readingOrder({ walkthrough: { ...this.state.d.walkthrough, coverage: this.state.d.coverage } }, this.stepsByAnchor());
    const i = flat.findIndex((x) => x.step.anchorId === id);
    const next = flat.slice(i + 1).find((x) => !this.stepSigned(x.step)) || null;
    const open = { ...this.state.open };
    const here = flat[i];
    if (here && here.chapter.id !== UNCOVERED_ID && flat.filter((x) => x.chapter.id === here.chapter.id).every((x) => this.stepSigned(x.step))) open[here.chapter.id] = false;
    if (next) open[next.chapter.id] = true;
    this.state.open = open;
    this.state.code = { ...this.state.code, [id]: null };
    if (!next) return;
    if (!this.state.code[next.step.anchorId]) await this.openStep(next.step);
    requestAnimationFrame(() => revealStep(next.step.anchorId));
  }

  async markChapter(chapterId, attestation, unmark) {
    this.state.chapterBusy = { ...this.state.chapterBusy, [chapterId]: true };
    try { await this.post('/api/topic/chapter_mark', { chapter: chapterId, attestation, unmark }); }
    finally { this.state.chapterBusy = { ...this.state.chapterBusy, [chapterId]: false }; }
  }

  /** Jump from a finding to the symbol it is about: open its chapter and its code, and bring it into view. */
  async jumpTo(anchorId) {
    const step = this.stepsByAnchor().get(anchorId);
    if (!step) return;
    const at = readingOrder({ walkthrough: { ...this.state.d.walkthrough, coverage: this.state.d.coverage } }, this.stepsByAnchor())
      .find((x) => x.step.anchorId === anchorId);
    if (at) this.state.open = { ...this.state.open, [at.chapter.id]: true };
    if (!this.state.code[anchorId]) await this.openStep(step);
    requestAnimationFrame(() => revealStep(anchorId));
  }

  // --- the page ------------------------------------------------------------------------

  indicators(d) {
    const sc = d.selectorChanged, forms = ['paths', 'symbols', 'nodes'].filter((k) => sc[k]);
    const un = d.walkthrough.resolved.unresolved;
    // One list through `each()`: a raw array of templates in a slot throws in vdx (R1).
    const notes = [
      ...(forms.length || sc.base ? [{ k: 'sel', n: 'Δ', t: html`<span>the topic's selector changed since this walkthrough:
        ${each(forms, (k) => html`<span> ${k} ${sc[k].added.length ? '+' + sc[k].added.join(', +') : ''}${sc[k].removed.length ? ' −' + sc[k].removed.join(', −') : ''};</span>`, (k) => k)}
        ${when(!!sc.base, () => html`<span> range ${short(sc.base.from) || 'none'} → ${short(sc.base.to) || 'none'}</span>`)}</span>` }] : []),
      ...(d.moved && d.moved.chapters.length ? [{ k: 'moved', n: '⟳', t: html`<span>main has moved the code of ${d.moved.symbols.length} symbol(s) in ${d.moved.chapters.length} chapter(s) since this walkthrough's commit — what was read here is no longer main's</span>` }] : []),
      ...(d.newlyMatched && d.newlyMatched.length ? [{ k: 'new', n: '+', t: html`<span>${d.newlyMatched.length} symbol(s) match the selector now that no walkthrough has seen — the prompt to re-walk</span>` }] : []),
      ...(un.length ? [{ k: 'un', n: '?', t: html`<span>${un.length} selector entr${un.length === 1 ? 'y' : 'ies'} named nothing at this commit: ${un.map((x) => `${x.kind} ${x.id}`).join(', ')}</span>` }] : []),
    ];
    return each(notes, (x) => html`<div class="attn-banner"><span class="attn-n">${x.n}</span>${x.t}</div>`, (x) => x.k);
  }

  findingsEl(u, d, t) {
    const steps = this.stepsByAnchor();
    return html`<div class="sec">findings on this topic <span class="dim">— the topic's, not this walk's</span></div>
      ${when(!d.findings.length, () => html`<div class="dim">none</div>`)}
      ${each(d.findings, (f) => html`<div class="blrow"><div class="blhead">
        <a href="${href(sharedUrl(u, 'topic:' + t.slug), { f: f.id })}">${f.id}</a>
        <span class="dim">${f.state}${f.severity ? ' · ' + f.severity : ''} · ${f.author}</span>
        ${when(f.target.kind === 'anchor' && steps.has(f.target.id), () => html`<button class="ghost" title="open the symbol this is about"
          on-click="${() => this.jumpTo(f.target.id)}">${steps.get(f.target.id).symbol.split(' › ').pop()} ›</button>`)}
        </div><div class="bltext">${f.comment}</div></div>`, (f) => f.id)}`;
  }

  template() {
    const u = this.props.params.universe, d = this.state.d, st = this.state;
    // The read can answer `{ error }` though TopicRead excludes it: the route returns the op verbatim.
    return pageShell(d, taskError(this.load) ?? (isErr(d) ? /** @type {{ error: string }} */ (/** @type {unknown} */ (d)).error : null), () => {
      if (!d.walkthrough) return html`<div class="crumbs"><b>${u}</b> <span class="sep">·</span> <a href="${href(topicsUrl(u))}">topics</a> <span class="sep">·</span> ${d.topic.title}</div>
        <div class="dim">no walkthrough of this topic yet — an agent writes one with <code>topic_walkthrough</code></div>`;
      const w = d.walkthrough, t = d.topic, steps = this.stepsByAnchor();
      const queue = w.resolved.ids.filter((id) => steps.has(id));
      const signed = queue.filter((id) => this.stepSigned(steps.get(id))).length;
      return html`
        <div class="crumbs"><b>${u}</b> <span class="sep">·</span> <a href="${href(topicsUrl(u))}">topics</a> <span class="sep">·</span> <b>${t.title}</b>
          <span class="dim">· topic:${t.slug}${t.status === 'retired' ? ' · retired' : ''}</span></div>
        <div class="bltext dim">selector: ${selectorText(t.selector)} — defined by ${t.definedBy.principal}</div>
        <div class="dnav blfilter tpicker">
          ${each(d.walkthroughs, (x) => html`<a class="${x.id === d.walk ? 'on' : ''}" href="${href(topicUrl(u, t.slug, x.id))}"
            title="by ${x.author} (${x.by}) at ${x.at}">${short(x.head)}${x.base ? ` (since ${short(x.base)})` : ''} · ${(x.at || '').slice(0, 10)}</a>`, (x) => x.id)}
        </div>
        <div class="dim">walked at <code>${short(w.head)}</code>${w.base ? html` since <code>${short(w.base)}</code>` : ''} by ${d.author} (${w.by}) —
          ${w.resolved.ids.length} symbols in the set, ${w.resolved.outside.length} outside the review lane${d.trunk ? html` · main is <code>${short(d.trunk.sha)}</code>` : ''}</div>
        <div class="prstats">
          <span><b>${signed}</b>/${queue.length} symbols signed</span>
          <span><b>${w.features.reduce((n, f) => n + f.chapters.length, 0)}</b> chapters</span>
          ${when(d.coverage.uncovered.length, () => html`<span class="warn">${d.coverage.uncovered.length} unaccounted for</span>`)}
        </div>
        ${this.indicators(d)}
        ${when(!!st.err, () => html`<div class="attn-banner"><span class="attn-n">✕</span> <span>${st.err}</span></div>`)}
        ${when(!!st.note, () => html`<div class="warn marknote">${st.note}</div>`)}
        ${walkFeaturesView(this, u, w, {
          stale: new Set(),
          moved: new Set((d.moved && d.moved.chapters) || []),
          uncovered: d.coverage.uncovered,
          tips: TOPIC_WALK_TIPS,
        })}
        ${this.findingsEl(u, d, t)}
      `;
    });
  }
}
defineComponent('topic-page', TopicPage);
