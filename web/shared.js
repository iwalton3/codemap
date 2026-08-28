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
import { api, apiPost, pageShell, nav, go, href, errText, taskError } from './core.js';

/**
 * What a pending ask reads as on the row.
 *
 * The verb an agent requests and the state a person is approving are different words —
 * `refute` is the act, `refuted` is where the finding lands — and the badge is read by
 * the person deciding, so it names the outcome. Rule from the workflow review: approving
 * one must not require reading the log for an ad-hoc message asking for it.
 */
/**
 * What HAPPENED about a finding, rendered beside what it CLAIMS.
 *
 * `remediation` was on every record and on no surface, so five findings verified fixed
 * at head still read as live defects — the eye lands on `comment`, which is the original
 * defect prose. Reported twice: by Izzie ("I still see 4 findings which don't have
 * comments saying they're fixed") and in `WORKFLOW_ISSUES.md` §1.
 *
 * `outstanding` renders nothing: it is the default, and a badge on every row is a badge
 * nobody reads.
 */
const REMEDIATION_LABEL = {
  'fixed-on-branch': ['fixed on branch', 'ok', 'verified fixed on this branch — the mainline may still carry it, so a linked bug stays open'],
  'fixed-on-default': ['fixed on main', 'ok', 'fixed on the default branch'],
  'deferred': ['deferred', '', 'real, and deliberately not being fixed now'],
  'wont-fix': ["won't fix", '', 'real, and a decision was taken not to fix it'],
};

const PENDING_LABEL = {
  refute: 'refuted', resolve: 'fixed', invalidate: 'invalid',
  withdraw: 'withdrawn', promote: 'promotion',
};

/**
 * The banner for a scope that cannot be answered from authoritatively.
 *
 * The rows are still shown — see PROPOSAL-provenance.md §7: a reviewer who can see
 * what the team wrote is better placed to repair a fork than one staring at an
 * empty page. Which is exactly why this has to be impossible to miss.
 *
 * @param {{status: string, diagnostic?: {reason: string, detail: string, evidence: string[]}}} [scope]
 */
const blockedBanner = (scope) => when(!!scope, () => html`
  <div class="blocked">
    <b>not authoritative</b> — ${scope.diagnostic?.detail ?? 'this scope is blocked'}
    ${when(!!scope.diagnostic?.evidence?.length, () => html`
      <div><code>${scope.diagnostic.evidence.join(', ')}</code></div>`)}
  </div>`);

/**
 * The API shapes come from `ops-shared` ITSELF, not from a hand-written copy —
 * the HTTP layer returns those values verbatim, so a field the ops function
 * stopped returning becomes a typecheck failure here instead of a panel that
 * silently never renders. (It already was one: `relocation` was in the model,
 * the fold and this page, and `view()` never returned it.)
 *
 * `dist/` because a .d.ts costs nothing to read; `npm run typecheck:web` builds
 * first. Each `Ok<>` drops the `{ error }` arm the page has already handled.
 *
 * @typedef {import('../dist/ops-shared.js')} Ops
 * @typedef {Awaited<ReturnType<Ops['sharedFindings']>>} FindingsView
 * @typedef {Exclude<FindingsView, { error: string }>} FindingsOk
 * @typedef {FindingsOk['findings'][number]} Finding
 * @typedef {Awaited<ReturnType<Ops['sharedStatus']>>} PeersView
 * @typedef {Awaited<ReturnType<Ops['sharedNotes']>>} NotesView
 * @typedef {Awaited<ReturnType<Ops['sharedDocs']>>} DocsView
 */

/**
 * @typedef {{ params: { universe: string, pr: string }, query: Record<string, string> }} SharedProps
 * @typedef {{ d: FindingsView | null, queue: boolean, busy: string | null, note: string | null, open: Set<string>, draft: string, replyTo: string | null, showSettled: boolean }} SharedState
 */

const sevClass = (s) => (s === 'critical' || s === 'high' ? 'bad' : s === 'medium' ? 'warn' : 'dim');

/**
 * Typing a page takes BOTH annotations, and each one covers only its own half:
 * `@extends` types `this.props`, while `this.state` is typed by the `@type` on
 * the constructor assignment — which shadows the inherited `state: S`, so the
 * type argument alone leaves every state read unchecked. Verified by probe;
 * annotate one and you get a page that looks typed and is half `any`.
 *
 * @extends {Component<SharedProps, SharedState>}
 */
class SharedPage extends Component {
  static props = { params: {}, query: {} };
  constructor(props) {
    super(props);
    // `queue` defaults on: the page exists to answer "what needs me", and showing
    // everything first buries that under findings somebody else already settled.
    /** @type {SharedState} */
    this.state = { d: null, queue: true, busy: null, note: null, open: new Set(), draft: '', replyTo: null, showSettled: false };
  }

  load = this.createTask(async () => {
    const u = this.props.params.universe;
    nav.current = u;
    this.state.d = await api('/api/shared', { u, pr: this.props.params.pr, queue: this.state.queue ? '1' : null });
  });

  mounted() { this.load.run(); }
  propsChanged(name) { if (name === 'params') { this.state.d = null; this.load.run(); } }

  /**
   * Promote a finding into a bug. Its own path rather than an `act`, because it writes
   * the BUGS scope and lands on a different route — and because the id it mints is
   * derived from the finding, so two people doing this offline converge on one bug.
   */
  async acceptAsBug(id) {
    this.state.busy = 'accept';
    this.state.note = null;
    try {
      const r = await apiPost('/api/bug/accept', { u: this.props.params.universe, pr: this.props.params.pr, finding: id });
      this.state.note = r.error ?? r.note ?? null;
      await this.load.run();
    } catch (e) { this.state.note = errText(e); } finally { this.state.busy = null; }
  }

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
      this.state.note = errText(e);
    } finally {
      this.state.busy = null;
    }
  }

  toggleQueue() { this.state.queue = !this.state.queue; this.load.run(); }

  /**
   * Open or close every finding on screen.
   *
   * Triage reads all of them, and one-at-a-time expansion is the workflow fighting the
   * page. A NEW Set each time: reactivity here is read-tracking, so mutating in place
   * changes nothing on screen.
   */
  toggleAll() {
    const d = this.state.d;
    const ids = (d && d.findings || []).map(f => f.id);
    this.state.open = this.state.open.size >= ids.length && ids.length ? new Set() : new Set(ids);
  }

  async sync() {
    this.state.busy = 'sync';
    try {
      const r = await apiPost('/api/shared/sync', { u: this.props.params.universe });
      this.state.note = r.error ?? `received ${r.gained} event(s)${r.pushed ? ', sent yours' : ''}${r.warning ? ` — ${r.warning}` : ''}`;
      await this.load.run();
    } catch (e) { this.state.note = errText(e); } finally { this.state.busy = null; }
  }

  /** @param {Finding} f */
  marksEl(f) {
    return html`
      ${when(!f.published, () => html`<span class="prbadge warnb"
        title="on this map only — the team cannot see it. Publish with codemap publish-findings."
        >not published</span>`)}
      ${when(f.needsAck, () => html`<span class="prbadge needsack">needs ack</span>`)}
      ${when(!!f.contested?.length, () => html`<span class="prbadge contested">contested: ${f.contested.map(c => c.field).join(', ')}</span>`)}
      ${when(f.promoted, () => html`<span class="prbadge">promoted</span>`)}
      ${when(f.independentConfirms > 0, () => html`<span class="prbadge ok">${f.independentConfirms} independent</span>`)}
      ${when(f.confirms > f.independentConfirms, () => html`<span class="prbadge ok" title="confirmed, but by the same principal as the author — not a second opinion">+${f.confirms - f.independentConfirms} confirmed</span>`)}
      ${when(f.refutes > 0, () => html`<span class="prbadge warnb">${f.refutes} refuted</span>`)}
      ${when(!!REMEDIATION_LABEL[f.remediation], () => html`<span class="prbadge ${REMEDIATION_LABEL[f.remediation][1]}" title="${REMEDIATION_LABEL[f.remediation][2]}${f.remediatedAt ? ` — ${f.remediatedAt.by}${f.remediatedAt.detail ? ': ' + f.remediatedAt.detail : ''}` : ''}">${REMEDIATION_LABEL[f.remediation][0]}</span>`)}
      ${when(!!f.pending, () => html`<span class="prbadge ask" title="${f.pending.by} asked for this and it is yours to apply — ${f.pending.rationale}">${PENDING_LABEL[f.pending.ask] || f.pending.ask} pending</span>`)}
      ${when(!!f.upstream, () => html`<span class="prbadge">${f.upstream}</span>`)}
      ${when(!!f.bug, () => html`<span class="prbadge">→ bug</span>`)}
      ${when(f.target?.where === 'offTree', () => html`<span class="prbadge" title="the symbol is on another branch — nothing to do here">elsewhere</span>`)}
      ${when(f.target?.where === 'retained' || f.target?.where === 'lost', () => html`<span class="prbadge warnb">target ${f.target.where}</span>`)}
      ${when(!!f.relocation && !f.relocation.applied, () => html`<span class="prbadge ask">relocation proposed</span>`)}`;
  }

  /**
   * Both values, side by side, and the two people who wrote them. Never a winner:
   * the fold refuses to pick, and so does this — a person re-states the value.
   */
  contestEl(f) {
    // One person's two machines can disagree, and then both sides carry the same
    // name. Say which clone, or the reader is shown a disagreement they cannot
    // tell apart. See PROPOSAL-provenance.md §4.
    const side = (x, other) => x.by === other.by && x.writer ? `${x.by} · ${x.writer}` : x.by;
    return html`${each(f.contested ?? [], c => html`
      <div class="contest">
        <div class="dim">${c.field} — ${c.held.by === c.incoming.by
          ? 'set on two machines without either seeing the other'
          : 'two people set this without seeing each other'}</div>
        <div><b>${side(c.held, c.incoming)}</b>: ${String(c.held.value)}</div>
        <div><b>${side(c.incoming, c.held)}</b>: ${String(c.incoming.value)}</div>
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
    // `withdraw` retires the record with the claim intact — the duplicate case. Without
    // it here the ask lands in the queue with no button, which is a request a person
    // can read and not act on.
    const state = p.ask === 'invalidate' ? 'invalid' : p.ask === 'refute' ? 'refuted'
      : p.ask === 'resolve' ? 'resolved' : p.ask === 'withdraw' ? 'withdrawn' : null;
    return html`
      <div class="askbox">
        <div><b>${p.by}</b> asked to <b>${p.ask}</b>: ${p.rationale}</div>
        <div class="row">
          ${when(!!state, () => html`<button on-click="${() => this.act('close', { id: f.id, state, reason: `agreed: ${p.rationale}` })}">agree — ${p.ask}</button>`)}
          ${when(p.ask === 'promote', () => html`<button on-click="${() => this.act('promote', { id: f.id })}">agree — promote</button>`)}
          <button title="say no, with a reason — this clears the badge and the queue entry, which replying does not"
            on-click="${() => this.declineAsk(f.id, p)}">decline</button>
          <button on-click="${() => this.reply(f.id, `declining: `)}">answer instead</button>
        </div>
      </div>`;
  }

  /**
   * Say no to an ask, and mean it.
   *
   * "answer instead" posts a comment, which touches neither `pending` nor the queue — so
   * a declined ask kept its `refuted pending` badge and its `waitingOnYou` slot forever.
   * The reason is required by the op, so it is prompted for rather than defaulted: an
   * ask declined without one is indistinguishable from one nobody got to.
   */
  async declineAsk(id, p) {
    const reason = window.prompt(`Decline ${p.by}'s request to ${p.ask}?\n\nSay why — it stays on the record.`, '');
    if (reason === null || !reason.trim()) return;
    await this.act('decline', { id, reason });
  }

  /** Focus the composer with a starting body — declining an ask needs a reason. */
  reply(id, prefix) {
    this.state.open = new Set(this.state.open).add(id);
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

  /** @param {Finding} f */
  detailEl(f) {
    return html`
      <div class="fdetail">
        <div class="row factions">
          <button on-click="${() => this.act('promote', { id: f.id })}">promote</button>
          <button on-click="${() => this.act('close', { id: f.id, state: 'resolved', reason: 'closed from the shared view' })}">resolve</button>
          <button on-click="${() => this.act('close', { id: f.id, state: 'refuted', reason: 'closed from the shared view' })}">refute</button>
          ${when(!!f.bug, () => html`<a class="btnlike" href="${href(`/u/${this.props.params.universe}/bugs/`, { bug: f.bug })}">open bug</a>`,
            () => html`<button title="keep this as a bug once the pull request closes"
              disabled="${this.state.busy === 'accept'}"
              on-click="${() => this.acceptAsBug(f.id)}">accept as bug</button>`)}
        </div>
        <div class="ftext">${f.text}</div>
        ${this.contestEl(f)}
        ${when(!!f.pending, () => this.askEl(f))}
        ${when(!!f.relocation && !f.relocation.applied, () => html`
          <div class="askbox">
            <div><b>${f.relocation.by}</b>${f.relocation.model ? ` (${f.relocation.model})` : ''} says the target
              ${f.relocation.kind === 'moved' ? `moved to ${f.relocation.to}` : 'is gone'}: ${f.relocation.rationale}</div>
            <div class="row">
              <button on-click="${() => this.act('relocate', { id: f.id, kind: f.relocation.kind, to: f.relocation.to, rationale: f.relocation.rationale, apply: true })}"
                >apply</button>
            </div>
          </div>`)}
        ${when(f.target?.where === 'retained' || f.target?.where === 'lost', () => html`
          <div class="dim">target is ${f.target.where}${f.target.lastFile ? ` — last seen in ${f.target.lastFile}` : ''}</div>`)}
        ${when(!!f.closedReason, () => html`<div class="dim"><b>closed</b>: ${f.closedReason}${when(!!f.closedGranting, () => html` <span class="dim">— granting ${f.closedGranting.by}'s request to ${f.closedGranting.ask}</span>`)}</div>`)}
        ${each(f.asks ?? [], a => html`
          <div class="dim"><b>${a.by}</b> asked to <b>${a.ask}</b>: ${a.rationale}${when(!!a.settled, () => html` <span class="dim">— ${a.settled.as}${a.settled.by ? ' by ' + a.settled.by : ''}${a.settled.reason ? ': ' + a.settled.reason : ''}</span>`)}</div>`, (a, i) => `ask${i}`)}
        ${each(f.outcomes?.length ? f.outcomes : (f.outcome ? [f.outcome] : []), o => html`
          <div class="dim">${o.by} reported <b>${o.result}</b>: ${o.detail}</div>`, (o, i) => `out${i}`)}
        ${each(f.corroboration ?? [], c => html`
          <div class="corr">
            <span class="${c.verdict === 'confirm' ? 'ok' : c.verdict === 'partial' ? 'ok' : c.verdict === 'refute' ? 'bad' : 'dim'}"
              title="${c.verdict === 'partial' ? 'real, but not as filed — the rationale says which part' : ''}">${c.verdict}</span>
            <b>${c.by}</b>${when(!!c.model, () => html` <span class="dim">(${c.model})</span>`)}
            ${when(!c.independent, () => html`<span class="dim" title="same principal as the author — not a second opinion"> · not independent</span>`)}
            ${when(!!c.ref, () => html`<span class="dim" title="the commit this verdict was formed on — a verdict is a claim about CODE, and this says which"> · at ${c.ref.slice(0, 8)}</span>`)}
            <span class="dim">${c.rationale}</span>
          </div>`, (c, i) => `${c.by}:${i}`)}
        ${each(f.thread ?? [], t => html`
          <div class="tcomment"><b>${t.by}</b>${when(!!t.model, () => html` <span class="dim">(${t.model})</span>`)}: ${t.body}</div>`, t => t.id)}
        ${this.composerEl(f)}
      </div>`;
  }

  /**
   * One finding's row.
   *
   * The submitter-facing text WRAPS and gets its own line. It used to share a flex row
   * with the badges and ellipsis away — on a dedicated findings page, with no way to
   * expand it, that made the one sentence the page exists to show the one thing you
   * could not read.
   */
  rowEl(f) {
    const st = this.state;
    const open = st.open.has(f.id);
    const toggle = () => {
      const next = new Set(st.open);
      if (open) next.delete(f.id); else next.add(f.id);
      st.open = next;
    };
    return html`
      <div class="frow ${open ? 'fopen' : ''}">
        <div class="fmeta" on-click="${toggle}">
          <span class="fcaret">${open ? '▾' : '▸'}</span>
          <span class="prbadge">${f.state}</span>
          <span class="${sevClass(f.severity)}">${f.severity ?? '\u2014'}</span>
          ${when(!!f.category, () => html`<span class="rvfcat">${f.category}</span>`)}
          ${this.marksEl(f)}
          <span class="fauthor dim">${f.author}${f.authorModel ? ` (${f.authorModel})` : ''}</span>
        </div>
        <div class="fcomment" on-click="${toggle}">${f.comment ?? f.text}</div>
        ${when(open, () => this.detailEl(f))}
      </div>`;
  }

  /**
   * The open tiers, in the order `findingTier` defines. Grouped HERE and not in a
   * slot: `each` refuses a bare `.map()`, and the server has already sorted, so
   * filtering per tier preserves the reading order inside each one.
   *
   * @returns {[string, Finding[]][]}
   */
  groups() {
    const rows = (this.state.d && this.state.d.findings) || [];
    const of = (t) => rows.filter(f => f.tier === t);
    return /** @type {[string, Finding[]][]} */ ([
      ['confirmed — somebody stood behind these', of('confirmed')],
      ['not confirmed yet', of('unconfirmed')],
      ['refuted or withdrawn, not closed out', of('doubted')],
    ]).filter(g => g[1].length);
  }

  template() {
    const u = this.props.params.universe, pr = this.props.params.pr, d = this.state.d, st = this.state;
    const failed = taskError(this.load);
    if (failed) return pageShell(null, failed, html``);
    if (!d) return html`<main><div class="loading">loading shared findings…</div></main>`;
    // No error arm any more: reading a pull request's findings works without a sidecar,
    // so the only failure left is the request itself, which `taskError` has above. The
    // ApiMap union is what caught this branch going dead.
    const settled = d.findings.filter(f => f.tier === 'settled');
    return pageShell(d, null, html`
      <div class="crumbs">
        <b>${u}</b> <span class="sep">·</span>
        <a href="#/u/${u}/pr/${pr}/">PR ${pr}</a> <span class="sep">·</span> shared
        <span class="dim">· ${d.total} finding(s) · ${d.waitingOnYou} waiting on a person${d.contested ? ` · ${d.contested} contested` : ''}</span>
      </div>
      <div class="sharedbar">
        <button on-click="${() => this.sync()}" disabled="${st.busy === 'sync'}">${st.busy === 'sync' ? 'syncing…' : 'sync'}</button>
        <button on-click="${() => this.toggleQueue()}">${st.queue ? 'showing: needs a person' : 'showing: everything'}</button>
        ${when(!!d.findings.length, () => html`<button on-click="${() => this.toggleAll()}"
          >${st.open.size >= d.findings.length ? 'collapse all' : 'expand all'}</button>`)}
        <a href="#/u/${u}/shared/${pr}/peers/">peers</a>
      </div>
      ${blockedBanner(d.scope)}
      ${when(!!st.note, () => html`<div class="empty">${st.note}</div>`)}
      ${when(!d.findings.length, () => html`<div class="dim">${st.queue ? 'nothing is waiting on a person.' : 'no shared findings for this pull request.'}</div>`)}
      ${each(this.groups(), g => html`
        <div class="fgroup"><span class="dim">${g[0]}</span> <span class="dim">· ${g[1].length}</span></div>
        ${each(g[1], f => this.rowEl(f), f => f.id)}`, g => g[0])}
      ${when(!!settled.length, () => html`
        <div class="fgroup settled" on-click="${() => { st.showSettled = !st.showSettled; }}">
          <span class="dim">${st.showSettled ? '▾' : '▸'} ${settled.length} settled — resolved or invalid</span>
        </div>
        ${when(st.showSettled, () => html`${each(settled, f => this.rowEl(f), f => f.id)}`)}`)}
    `);
  }
}
defineComponent('shared-page', SharedPage);

/** Who else writes to this sidecar, and whether their codemap agrees with ours. */
/** @extends {Component<SharedProps, { d: PeersView | null }>} */
class SharedPeersPage extends Component {
  static props = { params: {}, query: {} };
  /** @param {SharedProps} props */
  constructor(props) { super(props); /** @type {{ d: PeersView | null }} */ this.state = { d: null }; }
  load = this.createTask(async () => {
    nav.current = this.props.params.universe;
    this.state.d = await api('/api/shared/peers', { u: this.props.params.universe });
  });
  mounted() { this.load.run(); }
  propsChanged(name) { if (name === 'params') this.load.run(); }

  template() {
    const u = this.props.params.universe, d = this.state.d;
    const failed = taskError(this.load);
    if (failed) return pageShell(null, failed, html``);
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
/**
 * @typedef {{ d: NotesView | null, draft: string, replyTo: string | null, busy: boolean, note: string | null }} NotesState
 * @extends {Component<{ universe: string, target: string }, NotesState>}
 */
class SharedNotesPanel extends Component {
  static props = { universe: '', target: '' };
  constructor(props) { super(props); /** @type {NotesState} */ this.state = { d: null, draft: '', replyTo: null, busy: false, note: null }; }
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
      ${blockedBanner(d.scope)}
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
/**
 * The verdict comes from `evalVersion`, through the payload.
 *
 * This used to re-derive it here — one of three copies of the rule — and the copies
 * drifted: this one filtered to PRESENT citations first, so one matching plus one
 * missing rendered green, and none of them could tell an id this build cannot
 * derive from a symbol that is gone.
 *
 * `unverifiable` is deliberately not `stale`: "the code changed" and "nobody can
 * say" call for different actions, and only one of them is the reader's.
 */
const docState = (v) => {
  const s = v.status;
  return s === 'fresh' ? 'fresh' : s === 'unverifiable' ? 'unverified' : s === 'removed' ? 'removed' : 'stale';
};

/**
 * @typedef {{ d: DocsView | null, busy: string | null, note: string | null, open: string | null }} DocsState
 * @extends {Component<SharedProps, DocsState>}
 */
class SharedDocsPage extends Component {
  static props = { params: {}, query: {} };
  constructor(props) { super(props); /** @type {DocsState} */ this.state = { d: null, busy: null, note: null, open: null }; }
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
    const failed = taskError(this.load);
    if (failed) return pageShell(null, failed, html``);
    if (!d) return html`<main><div class="loading">loading shared docs…</div></main>`;
    if (d.error) return pageShell(d, d.error, html``);
    return pageShell(d, null, html`
      <div class="crumbs"><b>${u}</b> <span class="sep">·</span> shared docs
        <span class="dim">· ${d.total}, resolved against this checkout</span></div>
      ${blockedBanner(d.scope)}
      ${when(!!st.note, () => html`<div class="empty">${st.note}</div>`)}
      ${when(!d.docs.length, () => html`<div class="dim">nothing shared yet — run <code>codemap publish-docs</code>.</div>`)}
      ${each(d.docs, row => html`
        <div class="frow">
          <div class="row" on-click="${() => { st.open = st.open === row.nodeId ? null : row.nodeId; }}">
            ${when(!!row.resolved, () => html`<span class="prbadge ${docState(row.resolved) === 'fresh' ? 'ok' : docState(row.resolved) === 'stale' ? 'warnb' : ''}">${docState(row.resolved)}</span>`)}
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
