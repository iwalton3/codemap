/**
 * The shared-review page — everyone's findings for a pull request.
 *
 * Its own module rather than more of app.js, which is past three thousand lines.
 * The helpers it needs are exported from there; nothing new is invented here.
 *
 * What this page is FOR, which drives every layout choice: deciding what needs
 * you. So the queue is the default view, `NEEDS-ACK` and `CONTESTED` are the only
 * loud things on the row, and the counts that lead are the ones you would rank by
 * — independent confirmations, not raw agreement.
 */

import { Component, defineComponent, html, when, each } from './vendor/vdx/framework.js';
import { api, apiPost, pageShell, nav, go } from './app.js';

const sevClass = (s) => (s === 'critical' || s === 'high' ? 'bad' : s === 'medium' ? 'warn' : 'dim');

class SharedPage extends Component {
  static props = { params: {}, query: {} };
  constructor(props) {
    super(props);
    // `queue` defaults on: the page exists to answer "what needs me", and showing
    // everything first buries that under findings somebody else already settled.
    this.state = { d: null, queue: true, busy: null, note: null, open: null, draft: '', replyTo: null };
  }

  load = this.createTask(async () => {
    const u = this.props.params.universe;
    nav.current = u;
    this.state.d = await api('/api/shared', { u, pr: this.props.params.pr, queue: this.state.queue ? '1' : null });
  });

  mounted() { this.load.run(); }
  propsChanged(name) { if (name === 'params') { this.state.d = null; this.load.run(); } }

  async act(action, body) {
    this.state.busy = action;
    this.state.note = null;
    try {
      const r = await apiPost(`/api/shared/${action}`, { u: this.props.params.universe, pr: this.props.params.pr, ...body });
      // Errors from ops-shared come back 200 with an `error` field — they are
      // refusals, not failures, and they carry the reason a person needs.
      this.state.note = r.error ?? r.note ?? null;
      await this.load.run();
    } catch (e) {
      this.state.note = String(e.message ?? e);
    } finally {
      this.state.busy = null;
    }
  }

  toggleQueue() { this.state.queue = !this.state.queue; this.load.run(); }

  async sync() {
    this.state.busy = 'sync';
    try {
      const r = await apiPost('/api/shared/sync', { u: this.props.params.universe });
      this.state.note = r.error ?? `received ${r.gained} event(s)${r.pushed ? ', sent yours' : ''}${r.warning ? ` — ${r.warning}` : ''}`;
      await this.load.run();
    } catch (e) { this.state.note = String(e.message ?? e); } finally { this.state.busy = null; }
  }

  marksEl(f) {
    return html`
      ${when(f.needsAck, () => html`<span class="prbadge needsack">needs ack</span>`)}
      ${when(!!f.contested?.length, () => html`<span class="prbadge contested">contested: ${f.contested.map(c => c.field).join(', ')}</span>`)}
      ${when(f.promoted, () => html`<span class="prbadge">promoted</span>`)}
      ${when(f.independentConfirms > 0, () => html`<span class="prbadge ok">${f.independentConfirms} independent</span>`)}
      ${when(f.refutes > 0, () => html`<span class="prbadge warnb">${f.refutes} refuted</span>`)}
      ${when(!!f.pending, () => html`<span class="prbadge ask">asked: ${f.pending.ask}</span>`)}
      ${when(!!f.upstream, () => html`<span class="prbadge">${f.upstream}</span>`)}
      ${when(!!f.bug, () => html`<span class="prbadge">→ bug</span>`)}`;
  }

  /**
   * Both values, side by side, and the two people who wrote them. Never a winner:
   * the fold refuses to pick, and so does this — a person re-states the value.
   */
  contestEl(f) {
    return html`${each(f.contested ?? [], c => html`
      <div class="contest">
        <div class="dim">${c.field} — two people set this without seeing each other</div>
        <div><b>${c.held.by}</b>: ${String(c.held.value)}</div>
        <div><b>${c.incoming.by}</b>: ${String(c.incoming.value)}</div>
        <div class="row">
          <button on-click="${() => this.act('settle', { id: f.id, field: c.field, value: c.held.value })}">keep ${c.held.by}'s</button>
          <button on-click="${() => this.act('settle', { id: f.id, field: c.field, value: c.incoming.value })}">keep ${c.incoming.by}'s</button>
        </div>
      </div>`, c => c.field)}`;
  }

  /**
   * The human's half of the loop.
   *
   * An agent that may not close a finding ASKS instead, and until now the only
   * answer available in the browser was to close it silently — which loses the
   * reason and tells the agent nothing. Acting on the ask, or replying to it, is
   * the whole point of the queue.
   */
  askEl(f) {
    const p = f.pending;
    // `invalidate` maps onto the `invalid` state; the others share their names.
    const state = p.ask === 'invalidate' ? 'invalid' : p.ask === 'refute' ? 'refuted' : p.ask === 'resolve' ? 'resolved' : null;
    return html`
      <div class="askbox">
        <div><b>${p.by}</b> asked to <b>${p.ask}</b>: ${p.rationale}</div>
        <div class="row">
          ${when(!!state, () => html`<button on-click="${() => this.act('close', { id: f.id, state, reason: `agreed: ${p.rationale}` })}">agree — ${p.ask}</button>`)}
          ${when(p.ask === 'promote', () => html`<button on-click="${() => this.act('promote', { id: f.id })}">agree — promote</button>`)}
          <button on-click="${() => this.reply(f.id, `declining: `)}">answer instead</button>
        </div>
      </div>`;
  }

  /** Focus the composer with a starting body — declining an ask needs a reason. */
  reply(id, prefix) {
    this.state.open = id;
    this.state.draft = prefix;
    this.state.replyTo = id;
  }

  composerEl(f) {
    const st = this.state;
    return html`
      <div class="composer">
        <textarea
          placeholder="reply to this finding — answer the question, or say why you disagree"
          value="${st.replyTo === f.id ? (st.draft ?? '') : ''}"
          on-input="${(e) => { st.replyTo = f.id; st.draft = e.target.value; }}"></textarea>
        <button
          disabled="${st.busy === 'comment' || !(st.replyTo === f.id && (st.draft ?? '').trim())}"
          on-click="${async () => { const body = st.draft; st.draft = ''; st.replyTo = null; await this.act('comment', { id: f.id, body }); }}"
          >${st.busy === 'comment' ? 'sending…' : 'reply'}</button>
      </div>`;
  }

  detailEl(f) {
    return html`
      <div class="fdetail">
        <div class="ftext">${f.text}</div>
        ${this.contestEl(f)}
        ${when(!!f.pending, () => this.askEl(f))}
        ${when(!!f.outcome, () => html`<div class="dim">${f.outcome.by} reported <b>${f.outcome.result}</b>: ${f.outcome.detail}</div>`)}
        ${each(f.corroboration ?? [], c => html`
          <div class="corr">
            <span class="${c.verdict === 'confirm' ? 'ok' : c.verdict === 'refute' ? 'bad' : 'dim'}">${c.verdict}</span>
            <b>${c.by}</b>${when(!!c.model, () => html` <span class="dim">(${c.model})</span>`)}
            ${when(!c.independent, () => html`<span class="dim" title="same principal as the author — not a second opinion"> · not independent</span>`)}
            <span class="dim">${c.rationale}</span>
          </div>`, (c, i) => `${c.by}:${i}`)}
        ${each(f.thread ?? [], t => html`
          <div class="tcomment"><b>${t.by}</b>${when(!!t.model, () => html` <span class="dim">(${t.model})</span>`)}: ${t.body}</div>`, t => t.id)}
        ${this.composerEl(f)}
        <div class="row">
          <button on-click="${() => this.act('promote', { id: f.id })}">promote</button>
          <button on-click="${() => this.act('close', { id: f.id, state: 'resolved', reason: 'closed from the shared view' })}">resolve</button>
          <button on-click="${() => this.act('close', { id: f.id, state: 'refuted', reason: 'closed from the shared view' })}">refute</button>
        </div>
      </div>`;
  }

  template() {
    const u = this.props.params.universe, pr = this.props.params.pr, d = this.state.d, st = this.state;
    if (!d) return html`<main><div class="loading">loading shared findings…</div></main>`;
    if (d.error) return pageShell(d, d.error, html``);
    return pageShell(d, null, html`
      <div class="crumbs">
        <b>${u}</b> <span class="sep">·</span>
        <a href="#/u/${u}/pr/${pr}/">PR ${pr}</a> <span class="sep">·</span> shared
        <span class="dim">· ${d.total} finding(s) · ${d.waitingOnYou} waiting on a person${d.contested ? ` · ${d.contested} contested` : ''}</span>
      </div>
      <div class="row">
        <button on-click="${() => this.sync()}" disabled="${st.busy === 'sync'}">${st.busy === 'sync' ? 'syncing…' : 'sync'}</button>
        <button on-click="${() => this.toggleQueue()}">${st.queue ? 'showing: needs a person' : 'showing: everything'}</button>
        <a href="#/u/${u}/shared/${pr}/peers/">peers</a>
      </div>
      ${when(!!st.note, () => html`<div class="empty">${st.note}</div>`)}
      ${when(!d.findings.length, () => html`<div class="dim">${st.queue ? 'nothing is waiting on a person.' : 'no shared findings for this pull request.'}</div>`)}
      ${each(d.findings, f => html`
        <div class="frow">
          <div class="row" on-click="${() => { st.open = st.open === f.id ? null : f.id; }}">
            <span class="prbadge">${f.state}</span>
            <span class="${sevClass(f.severity)}">${f.severity ?? '—'}</span>
            <span class="fcomment">${f.comment ?? f.text}</span>
            <span class="dim">${f.author}${f.authorModel ? ` (${f.authorModel})` : ''}</span>
          </div>
          <div class="row">${this.marksEl(f)}</div>
          ${when(st.open === f.id, () => this.detailEl(f))}
        </div>`, f => f.id)}
    `);
  }
}
defineComponent('shared-page', SharedPage);

/** Who else writes to this sidecar, and whether their codemap agrees with ours. */
class SharedPeersPage extends Component {
  static props = { params: {}, query: {} };
  constructor(props) { super(props); this.state = { d: null }; }
  load = this.createTask(async () => {
    nav.current = this.props.params.universe;
    this.state.d = await api('/api/shared/peers', { u: this.props.params.universe });
  });
  mounted() { this.load.run(); }
  propsChanged(name) { if (name === 'params') this.load.run(); }

  template() {
    const u = this.props.params.universe, d = this.state.d;
    if (!d) return html`<main><div class="loading">loading…</div></main>`;
    if (d.error) return pageShell(d, d.error, html``);
    return pageShell(d, null, html`
      <div class="crumbs"><b>${u}</b> <span class="sep">·</span> sidecar peers</div>
      <div class="dim">${d.sidecar} — you are ${d.you ?? '(no identity configured)'}</div>
      ${when(!!d.blocked, () => html`<div class="empty bad">${d.blocked}</div>`)}
      ${when(!!d.warning, () => html`<div class="empty warn">${d.warning}</div>`)}
      ${when(!d.peers.length, () => html`<div class="dim">nobody has written a manifest yet — sync once.</div>`)}
      ${each(d.peers, p => html`
        <div class="frow"><b>${p.principal}</b> <span class="dim">anchor scheme ${p.anchorScheme} · hash scheme ${p.hashScheme}</span></div>`,
        p => p.principal)}
    `);
  }
}
defineComponent('shared-peers-page', SharedPeersPage);


/**
 * What the TEAM knows about one symbol, embedded on the anchor and node pages.
 *
 * Inline rather than on a page of its own, because the point of sharing notes is
 * that the next person does not pay again to work something out — and they only
 * avoid paying if the note is in front of them when they are reading the code,
 * not one navigation away.
 *
 * Silent when there is no sidecar, and silent when nobody has written anything:
 * an empty "shared notes" heading on every anchor page is noise that teaches
 * people to stop looking.
 */
class SharedNotesPanel extends Component {
  static props = { universe: '', target: '' };
  constructor(props) { super(props); this.state = { d: null, draft: '', replyTo: null, busy: false, note: null }; }
  load = this.createTask(async () => {
    this.state.d = await api('/api/shared/notes', { u: this.props.universe, target: this.props.target });
  });
  mounted() { this.load.run(); }
  propsChanged() { this.state.d = null; this.load.run(); }

  async answer(id) {
    const body = this.state.draft;
    this.state.busy = true;
    try {
      const r = await apiPost('/api/shared/note_answer', { u: this.props.universe, target: this.props.target, id, body });
      this.state.note = r.error ?? null;
      this.state.draft = ''; this.state.replyTo = null;
      await this.load.run();
    } finally { this.state.busy = false; }
  }

  async resolve(id, resolved) {
    const r = await apiPost('/api/shared/note_resolve', { u: this.props.universe, target: this.props.target, id, resolved });
    this.state.note = r.error ?? null;
    await this.load.run();
  }

  template() {
    const st = this.state, d = st.d;
    // `error` here is almost always "no sidecar configured", which is a normal
    // state for a store that has never had one — not something to shout about.
    if (!d || d.error || !d.notes.length) return html`<div></div>`;
    return html`<div class="sharednotes">
      <div class="sec">what the team knows <span class="dim">· ${d.notes.length}</span></div>
      ${when(!!st.note, () => html`<div class="empty">${st.note}</div>`)}
      ${each(d.notes, n => html`
        <div class="snote">
          <div class="row">
            <span class="prbadge">${n.kind}</span>
            ${when(!!n.severity, () => html`<span class="${n.severity === 'critical' || n.severity === 'high' ? 'bad' : 'dim'}">${n.severity}</span>`)}
            <span class="dim">${n.by}${n.model ? ` (${n.model})` : ''}</span>
            ${when(!!n.resolved, () => html`<span class="prbadge ok">resolved</span>`)}
          </div>
          <div class="ftext">${n.text}</div>
          ${each(n.answers, a => html`<div class="tcomment">→ <b>${a.by}</b>: ${a.body}</div>`, (a, i) => `${a.by}:${i}`)}
          <div class="composer">
            <textarea placeholder="answer this"
              value="${st.replyTo === n.id ? st.draft : ''}"
              on-input="${(e) => { st.replyTo = n.id; st.draft = e.target.value; }}"></textarea>
            <button disabled="${st.busy || !(st.replyTo === n.id && st.draft.trim())}"
              on-click="${() => this.answer(n.id)}">answer</button>
            ${when(!n.resolved, () => html`<button on-click="${() => this.resolve(n.id, true)}">resolve</button>`)}
          </div>
        </div>`, n => n.id)}
    </div>`;
  }
}
defineComponent('shared-notes-panel', SharedNotesPanel);

/**
 * The team's docs, each resolved against THIS checkout.
 *
 * The status is computed from the citations rather than taken from the fact that
 * a version resolved: `winningVersionAt` returns the least-bad version and always
 * returns one, so "a version came back" is not "this describes your code".
 */
const docFresh = (v) => {
  const present = (v.citations ?? []).filter(c => c.present);
  return present.length > 0 && present.every(c => c.matches);
};
/**
 * Confirmed under an older HASH_SCHEME, so it cannot be compared to this body.
 * Deliberately NOT shown as stale: a migration re-hashes everything, and reading
 * that as "the code changed" is the false staleness the scheme exists to prevent.
 */
const docUnverified = (v) => !docFresh(v) && (v.citations ?? []).some(c => c.present && c.unverifiable);
const docState = (v) => docFresh(v) ? 'fresh' : docUnverified(v) ? 'unverified' : 'stale';

class SharedDocsPage extends Component {
  static props = { params: {}, query: {} };
  constructor(props) { super(props); this.state = { d: null, busy: null, note: null, open: null }; }
  load = this.createTask(async () => {
    nav.current = this.props.params.universe;
    this.state.d = await api('/api/shared/docs', { u: this.props.params.universe });
  });
  mounted() { this.load.run(); }
  propsChanged(name) { if (name === 'params') { this.state.d = null; this.load.run(); } }

  async confirm(nodeId) {
    this.state.busy = nodeId;
    try {
      const r = await apiPost('/api/shared/doc_confirm', { u: this.props.params.universe, nodeId });
      this.state.note = r.error ?? `confirmed against ${r.confirmed} symbol(s) here`;
      await this.load.run();
    } finally { this.state.busy = null; }
  }

  template() {
    const u = this.props.params.universe, d = this.state.d, st = this.state;
    if (!d) return html`<main><div class="loading">loading shared docs…</div></main>`;
    if (d.error) return pageShell(d, d.error, html``);
    return pageShell(d, null, html`
      <div class="crumbs"><b>${u}</b> <span class="sep">·</span> shared docs
        <span class="dim">· ${d.total}, resolved against this checkout</span></div>
      ${when(!!st.note, () => html`<div class="empty">${st.note}</div>`)}
      ${when(!d.docs.length, () => html`<div class="dim">nothing shared yet — run <code>codemap publish-docs</code>.</div>`)}
      ${each(d.docs, row => html`
        <div class="frow">
          <div class="row" on-click="${() => { st.open = st.open === row.nodeId ? null : row.nodeId; }}">
            ${when(!!row.resolved, () => html`<span class="prbadge ${docFresh(row.resolved) ? 'ok' : docUnverified(row.resolved) ? '' : 'warnb'}">${docState(row.resolved)}</span>`)}
            <span class="fcomment">${row.resolved ? row.resolved.title : row.nodeId}</span>
            <span class="dim">${row.resolved?.by ?? ''} · v${row.versions}</span>
          </div>
          ${when(st.open === row.nodeId && !!row.resolved, () => html`
            <div class="fdetail">
              <div class="dim">${row.resolved.summary}</div>
              <div class="ftext">${row.resolved.body}</div>
              ${each(row.resolved.citations, c => html`
                <div class="corr">
                  <span class="${c.present ? (c.matches ? 'ok' : c.unverifiable ? 'dim' : 'warn') : 'bad'}">${c.present ? (c.matches ? 'matches' : c.unverifiable ? 'confirmed under an older hash scheme' : 'drifted') : 'not in this checkout'}</span>
                  <span class="dim">${c.anchorId} · ${c.accepted} accepted hash(es)</span>
                </div>`, c => c.anchorId)}
              <div class="row">
                <button disabled="${st.busy === row.nodeId}"
                  on-click="${() => this.confirm(row.nodeId)}"
                  >${st.busy === row.nodeId ? 'confirming…' : 'still true here'}</button>
              </div>
            </div>`)}
        </div>`, row => row.nodeId)}
    `);
  }
}
defineComponent('shared-docs-page', SharedDocsPage);
