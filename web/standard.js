/**
 * The standard — the requirements surface, and the one place a person adopts a spec.
 *
 * Its own module for the reason `shared.js` is: app.js is past four thousand lines.
 * It imports only `./core.js`, which imports neither of the other two — see
 * `src/import-cycles.test.ts`, and CLAUDE.md § "The web app is typechecked in place".
 *
 * Why this exists at all: the whole standard has been agent-only since it was built.
 * `mcp.ts` carries every tool and `serve.ts` carried none of them, which left
 * RATIFICATION with nowhere to happen — an agent can draft a spec and can never adopt
 * one, because the MCP agent latch is a ratchet. So the queue and the spec page below
 * are not a nicer way to do something already possible; they are the missing half.
 */

import { Component, defineComponent, html, when, each } from './vendor/vdx/framework.js';
import { api, apiPost, pageShell, nav, href, errText, taskError, isErr } from './core.js';

/**
 * The API contract, so a page's state is typed from the ops functions themselves.
 *
 * Without it `@typedef {{ d: any }}` is the easy default, and `any` is how this module
 * kept rendering `requirement.cites` after the field was removed — a blank page on every
 * load that neither `tsc -p web` nor any unit test could see.
 *
 * @typedef {import('./core.js').ApiMap} ApiMap
 */

export const standardUrl = (u) => `/u/${u}/standard/`;
export const rulesUrl = (u) => `/u/${u}/standard/rules/`;
export const specUrl = (u, id) => `/u/${u}/standard/spec/${id}/`;
export const requirementUrl = (u, id) => `/u/${u}/standard/r/${id}/`;

/**
 * How a conformance DISTRIBUTION reads — the counts on the hub.
 *
 * Not used on a rule: a `ServedRequirement` carries no conformance state, and reading one
 * off it rendered every rule grey whatever its real verdict. That went unnoticed because
 * the page's state was typed `any`; the audit history is where a rule's verdict actually
 * lives, and it carries its own dot.
 *
 * `unknown` is deliberately NOT green and never renders as conformant — the standing
 * rule from `docs/requirements-architecture.md`, restated here because a colour is the
 * fastest way to break it.
 */
const CONF_COLOR = {
  conformant: '#7ee787', nonconformant: '#f27b7b', gap: '#f0a35e', debt: '#f0a35e', unknown: '#8b95a3',
};
const confDot = (state) => html`<span class="rev-dot" style="background:${CONF_COLOR[state] ?? CONF_COLOR.unknown}"></span>`;

/**
 * The banner a non-authoritative read carries.
 *
 * `served()` marks every standard response when the shared scope is blocked or behind,
 * and the whole point of that marker is that a reader sees it — dropping it here would
 * reintroduce exactly the hole it was built to close.
 */
const servedNote = (d) => when(!!(d && d.served), () => html`<div class="attn-banner">
  <span class="attn-n">⚠</span>
  <span>this is not the team's standard: ${d.served.status === 'blocked' ? 'the shared log is refusing to be read as settled' : 'these rows are behind the log'}${d.served.detail ? ' — ' + d.served.detail : ''}. Sync, then re-read.</span>
</div>`);

/**
 * A comment thread on a proposal.
 *
 * Read-only here; posting is the page's job because only it knows how to reload. The
 * author is rendered with `via` intact — a remark from an agent running as somebody is
 * a different weight of evidence from one that person wrote, and collapsing the two is
 * the misattribution this codebase has already shipped once.
 */
const thread = (notes) => when(notes && notes.length > 0, () => html`<div class="cmts">
  ${each(notes, (n) => html`<div class="cmt">
    <div class="cmt-h">${n.author && n.author.principal ? n.author.principal : 'unknown'}${n.author && n.author.via ? html` <span class="dim">via ${n.author.via.model || 'agent'}</span>` : ''}
      <span class="dim">${(n.createdAt || '').slice(0, 16).replace('T', ' ')}</span>
      ${when(n.kind === 'question', () => html`<span class="qbadge">question</span>`)}
      ${when(!!n.resolved, () => html`<span class="qbadge">resolved</span>`)}
    </div>
    <div class="cmt-b">${n.text}</div>
    ${each(n.answers || [], (a) => html`<div class="cmt-a"><span class="dim">${a.author && a.author.principal ? a.author.principal : 'unknown'}:</span> ${a.body}</div>`, (a) => a.at + (a.body || '').slice(0, 12))}
  </div>`, (n) => n.id)}
</div>`);

/**
 * @typedef {{ params: { universe: string, id?: string }, query: Record<string, string> }} StdProps
 */

/**
 * @typedef {{ status: any, queue: any, err: string|null }} StandardState
 * @extends {Component<StdProps, StandardState>}
 */
class StandardPage extends Component {
  static props = { params: {}, query: {} };
  /** @param {StdProps} props */
  constructor(props) {
    super(props);
    /** @type {StandardState} */
    this.state = { status: null, queue: null, err: null };
  }
  load = this.createTask(async () => {
    const u = this.props.params.universe;
    nav.current = u;
    const [status, queue] = await Promise.all([api('/api/standard', { u }), api('/api/standard/queue', { u })]);
    this.state.status = status; this.state.queue = queue;
  });
  mounted() { this.load.run(); }
  propsChanged() { this.state.status = null; this.load.run(); }
  template() {
    const u = this.props.params.universe, s = this.state.status, q = this.state.queue;
    return pageShell(s && q, taskError(this.load), () => html`
      <div class="crumbs"><b>${u}</b> <span class="sep">·</span> standard</div>
      ${servedNote(s)}
      <div class="sec">ratification queue (${q.specs.length})</div>
      ${when(!q.specs.length, () => html`<div class="empty">no drafts waiting. An agent proposes with <code>draft_spec</code> and <code>add_operation</code>; adopting one is yours.</div>`)}
      ${each(q.specs, (row) => html`<a class="spec-card" href="${href(specUrl(u, row.spec.id))}">
        <div class="ft">${row.spec.title}
          <span class="n">${row.operations} operation${row.operations === 1 ? '' : 's'}</span>
          ${when(row.irreversible, () => html`<span class="qbadge drift" title="at least one operation declares that satisfying it CANNOT be undone">irreversible</span>`)}
          ${when(row.silenced > 0, () => html`<span class="qbadge drift" title="a gap was pre-approved against this spec and binds the moment you adopt it — you are the last person who can refuse it">${row.silenced} pre-silenced</span>`)}
        </div>
        <div class="fs">${row.spec.author && row.spec.author.principal ? row.spec.author.principal : 'unknown'} · ${(row.spec.createdAt || '').slice(0, 10)}</div>
      </a>`, (row) => row.spec.id)}

      <div class="sec">conformance</div>
      <div class="dnav">
        ${each(Object.keys(s.conformance || {}).filter(k => typeof s.conformance[k] === 'number'), (k) => html`<span class="chip">${confDot(k)}${k}: ${s.conformance[k]}</span>`, k => k)}
      </div>

      <div class="dnav"><a class="btnlike" href="${href(rulesUrl(u))}">browse the standard ›</a></div>
    `);
  }
}
defineComponent('standard-page', StandardPage);

/**
 * One spec, rendered for a principal to dispose of.
 *
 * The trade this page makes is the whole design: a principal reads N operations
 * instead of 5,000 lines. So everything needed to decide has to be HERE — the current
 * text beside the proposed one, what a section move would actually take, any gap that
 * binds the moment it is adopted, and what is already watching each rule. If disposing
 * of one means leaving to find the rest, the trade fails at its last step and the
 * process reverts to reading code (`getSpec`'s own doc says this; this is the surface
 * it was describing).
 *
 * @typedef {{ d: any, busy: string|null, err: string|null, reason: string, draft: Record<string,string> }} SpecState
 * @extends {Component<StdProps, SpecState>}
 */
class SpecPage extends Component {
  static props = { params: {}, query: {} };
  /** @param {StdProps} props */
  constructor(props) {
    super(props);
    /** @type {SpecState} */
    this.state = { d: null, busy: null, err: null, reason: '', draft: {} };
  }
  load = this.createTask(async () => {
    nav.current = this.props.params.universe;
    const r = await api('/api/standard/spec', { u: this.props.params.universe, id: this.props.params.id });
    // ops returns `{error}` rather than throwing, and `createTask` only parks what
    // REJECTS — so without this a mistyped id renders `d.spec.title` on an object
    // that has no `spec`, which is a blank page and a console TypeError.
    if (isErr(r)) throw new Error(r.error);
    this.state.d = r;
  });
  mounted() { this.load.run(); }
  propsChanged() { this.state.d = null; this.load.run(); }

  /**
   * Adopt or withdraw.
   *
   * The reply is rendered verbatim on failure rather than reduced to "failed": a
   * refusal here is the product — it names the operation whose base moved, or what
   * already relies on the spec — and summarizing it away would leave the one person
   * who can act with nothing to act on.
   */
  async act(kind) {
    if (this.state.busy) return;
    this.state.busy = kind; this.state.err = null;
    try {
      const body = { u: this.props.params.universe, specId: this.props.params.id };
      const r = await apiPost(`/api/standard/${kind}`, kind === 'withdraw' ? { ...body, reason: this.state.reason } : body);
      if (r && r.error) { this.state.err = r.error; return; }
      this.load.run();
    } catch (e) { this.state.err = errText(e); } finally { this.state.busy = null; }
  }

  /** Post a comment against a spec or an operation, then reload so it is really there. */
  async say(targetId) {
    const body = (this.state.draft[targetId] || '').trim();
    if (!body || this.state.busy) return;
    this.state.busy = 'comment:' + targetId; this.state.err = null;
    try {
      const r = await apiPost('/api/standard/comment', { u: this.props.params.universe, id: targetId, body });
      if (r && r.error) { this.state.err = r.error; return; }
      this.state.draft = { ...this.state.draft, [targetId]: '' };
      this.load.run();
    } catch (e) { this.state.err = errText(e); } finally { this.state.busy = null; }
  }

  composer(targetId, placeholder) {
    return html`<div class="cmt-new">
      <input placeholder="${placeholder}" value="${this.state.draft[targetId] || ''}"
        on-change="${(e, v) => { this.state.draft = { ...this.state.draft, [targetId]: v }; }}">
      <button class="pullbtn" disabled="${!!this.state.busy}" on-click="${() => this.say(targetId)}">comment</button>
    </div>`;
  }

  op(o, u) {
    const k = o.operation.kind;
    return html`<div class="op-card ${o.contextMoved ? 'moved' : ''}">
      <div class="ft"><span class="qbadge">${k.replace(/_/g, ' ')}</span>
        ${when(o.operation.reversibility === 'irreversible', () => html`<span class="qbadge drift" title="satisfying this cannot be undone — declared before ratification because it changes the decision, and because it makes the rule harder to amend later">irreversible</span>`)}
        ${when(o.contextMoved, () => html`<span class="qbadge drift">cannot be adopted as drafted</span>`)}
      </div>
      <div class="fs"><b>why:</b> ${o.operation.rationale}</div>
      ${when(!!o.before, () => html`<div class="op-before"><span class="dim">now</span> ${o.before.statement}</div>`)}
      ${when(!!o.after, () => html`<div class="op-after"><span class="dim">becomes</span> ${o.after}</div>`)}
      ${when(k === 'add_requirement', () => html`<div class="fs"><b>${o.operation.title}</b> → ${o.operation.section} · <span class="dim">${o.operation.provenance}</span></div>`)}
      ${when(!!o.moves, () => html`<div class="op-move">
        <div class="fs"><b>${o.moves.from}</b> → <b>${o.moves.to}</b> · ${o.moves.members.length} rule${o.moves.members.length === 1 ? '' : 's'} move</div>
        ${when(!!o.moves.blocked, () => html`<div class="op-blocked">${o.moves.blocked}</div>`)}
        ${each(o.moves.members, (m) => html`<div class="op-moverow"><span class="dim">${m.from}</span> → ${m.to} · ${m.title}</div>`, (m) => m.id)}
      </div>`)}
      ${when(o.silencedBy.length > 0, () => html`<div class="op-gap">
        ⚠ arrives pre-classified by ${o.silencedBy.length} acknowledgement${o.silencedBy.length === 1 ? '' : 's'} that bind${o.silencedBy.length === 1 ? 's' : ''} when you adopt it.
        Approving the rule is not approving the classification.
        ${each(o.silencedBy, (a) => html`<div class="op-moverow">${a.basis} · ${a.state} · ${a.rationale}</div>`, (a) => a.id)}
      </div>`)}
      ${when(o.watchedBy.length > 0, () => html`<div class="fs dim">${o.watchedBy.length} pointer${o.watchedBy.length === 1 ? '' : 's'} watching this rule — a ratified amendment means code that was conformant may not be</div>`)}
      ${thread(o.comments)}
      ${this.composer(o.operation.id, 'comment on this operation…')}
    </div>`;
  }

  template() {
    const u = this.props.params.universe, d = this.state.d;
    return pageShell(d, taskError(this.load), () => html`
      <div class="crumbs"><a class="back" href="${href(standardUrl(u))}">← standard</a> <span class="sep">·</span> ${d.spec.title}</div>
      ${servedNote(d)}
      <div class="fs dim">${d.spec.status} · proposed by ${d.spec.author && d.spec.author.principal ? d.spec.author.principal : 'unknown'}${d.spec.author && d.spec.author.via ? ' (via ' + (d.spec.author.via.model || 'agent') + ')' : ''}</div>
      ${when(!!d.spec.narrative, () => html`<div class="op-card"><div class="fs dim">background — NON-OPERATIVE, nothing here changes the standard</div><div class="fs">${d.spec.narrative}</div></div>`)}

      <div class="sec">operations (${d.operations.length})</div>
      ${each(d.operations, (o) => this.op(o, u), (o) => o.operation.id)}

      <div class="sec">on this proposal</div>
      ${thread(d.comments)}
      ${this.composer(d.spec.id, 'comment on the proposal as a whole…')}

      ${when(!!this.state.err, () => html`<div class="attn-banner"><span class="attn-n">✕</span> <span>${this.state.err}</span></div>`)}
      ${when(d.spec.status === 'draft', () => html`<div class="op-actions">
        <button class="pullbtn" disabled="${!d.adoptable || !!this.state.busy}"
          title="${d.adoptable ? 'apply every operation, all or nothing' : 'at least one operation was written against a standard that has since moved'}"
          on-click="${() => this.act('ratify')}">${this.state.busy === 'ratify' ? 'adopting…' : '✓ ratify'}</button>
        <input placeholder="reason, if withdrawing…" on-change="${(e, v) => { this.state.reason = v; }}">
        <button class="pullbtn" disabled="${!this.state.reason || !!this.state.busy}"
          title="take the proposal back. A draft may always be withdrawn — it also releases any gap attached to it."
          on-click="${() => this.act('withdraw')}">${this.state.busy === 'withdraw' ? 'withdrawing…' : '✕ withdraw'}</button>
      </div>`)}
    `);
  }
}
defineComponent('spec-page', SpecPage);

/**
 * One audit, in either section.
 *
 * `branch` is passed rather than read off `a.provisional`, because a card in the branch
 * section is a branch finding whatever the record's own field says — the reader of a
 * document is the end that decides that (see `provisional.ts`), not the record.
 *
 * @param {ReqData['audits'][number] & { superseded?: boolean, branch?: string, commit?: string }} a
 * @param {boolean} [branch]
 */
const auditCard = (a, branch) => html`<div class="op-card ${branch ? 'moved' : ''}">
  <div class="ft">${confDot(a.outcome === 'conformant' ? 'conformant' : a.outcome === 'nonconformant' ? 'nonconformant' : 'unknown')}
    <b>${a.outcome}</b>
    <span class="qbadge">${a.trigger || 'ad-hoc'}</span>
    ${when(!!branch, () => html`<span class="qbadge drift" title="taken off the default branch, or on a dirty tree — it is about somebody's branch, not about the codebase">${a.branch || 'branch'}</span>`)}
    ${when(!!(branch && a.superseded), () => html`<span class="qbadge" title="the code it examined has moved, so it says nothing about what is here now">superseded</span>`)}
    <span class="dim">${(a.at || '').slice(0, 16).replace('T', ' ')} · ${a.auditor && a.auditor.principal ? a.auditor.principal : 'unknown'}${a.auditor && a.auditor.via ? ' via ' + (a.auditor.via.model || 'agent') : ''}</span>
  </div>
  <div class="fs">${a.finding}</div>
  ${when(!!(a.evidence && (a.evidence.read || a.evidence.ran)), () => html`<div class="fs dim">evidence: ${(a.evidence.read || []).length} anchor(s) read${(a.evidence.ran || []).length ? ', ' + a.evidence.ran.length + ' command(s) run' : ''}</div>`)}
  ${when(!!(branch && a.commit), () => html`<div class="fs dim">at ${(a.commit || '').slice(0, 12)}</div>`)}
</div>`;

/**
 * One rule, and everything that has been said about it.
 *
 * A requirement has no `stale` and no trust ladder — it is upstream of the code, so
 * the code moving does not make the rule wrong, it makes it unsatisfied. That is why
 * conformance is a separate line here rather than a status on the record, and why an
 * uncited rule renders as a fact rather than as a defect.
 *
 * `d` is typed from the API map rather than `any`. It was `any`, and that is exactly how
 * `d.requirement.cites.length` survived the field being removed: the page threw on every
 * render and showed a blank screen, which `tsc -p web` could not see and no unit test
 * could either. CLAUDE.md's rule — type a page and you must do it TWICE — is about this.
 *
 * The SUCCESS arm: `load` throws on an `{error}` reply, so by render time it is this one.
 * Narrowing here rather than at every use is what makes the field access checked.
 *
 * @typedef {Extract<ApiMap['/api/standard/requirement'], { requirement: unknown }>} ReqData
 * @typedef {{ d: ReqData | null }} ReqState
 * @extends {Component<StdProps, ReqState>}
 */
class RequirementPage extends Component {
  static props = { params: {}, query: {} };
  /** @param {StdProps} props */
  constructor(props) {
    super(props);
    /** @type {ReqState} */
    this.state = { d: null };
  }
  load = this.createTask(async () => {
    nav.current = this.props.params.universe;
    const r = await api('/api/standard/requirement', { u: this.props.params.universe, id: this.props.params.id });
    if (isErr(r)) throw new Error(r.error);
    this.state.d = r;
  });
  mounted() { this.load.run(); }
  propsChanged() { this.state.d = null; this.load.run(); }
  template() {
    const u = this.props.params.universe, d = this.state.d;
    return pageShell(d, taskError(this.load), () => html`
      <div class="crumbs"><a class="back" href="${href(standardUrl(u))}">← standard</a> <span class="sep">·</span> ${d.requirement.section}</div>
      ${servedNote(d)}
      <div class="op-card">
        <div class="ft"><b>${d.requirement.title}</b>
          ${when(d.requirement.recheckDue, () => html`<span class="qbadge drift" title="watched code has moved since it was last looked at — evidence about the CODE, not a downgrade of the rule">recheck due</span>`)}
          ${when(d.requirement.status === 'retired', () => html`<span class="qbadge">retired</span>`)}
        </div>
        <div class="fs">${d.requirement.statement}</div>
        <div class="fs dim">provenance: ${d.requirement.provenance}</div>
        <div class="fs dim">a rule cites no code — it is upstream of the code, and where the code is lives in the pointers below</div>
      </div>

      <div class="sec">audit history (${d.audits.length})</div>
      ${when(!d.audits.length, () => html`<div class="empty">never audited. A conformance verdict with no audit behind it is <code>unknown</code>, which must never read as conformant.</div>`)}
      ${each(d.audits, (a) => auditCard(a), (a) => a.id)}

      ${when(!!d.provisionalAudits.length, () => html`
        <div class="sec">branch findings (${d.provisionalAudits.length})</div>
        <div class="empty">Observations of somebody's branch — this machine's and the team's. They are NOT the state of the codebase and never become it: nothing folds them, so no clone has a row to count. A finding whose code survives to the default branch is offered for promotion instead.</div>
        ${each(d.provisionalAudits, (a) => auditCard(a, true), (a) => a.id)}
      `)}

      <div class="sec">watching this rule (${d.pointers.length})</div>
      ${when(!d.pointers.length, () => html`<div class="empty">nothing points at it — a pointer is a prior on where to look, never a verdict</div>`)}
      ${each(d.pointers, (p) => html`<div class="op-card">
        <div class="ft"><span class="qbadge">${p.state}</span> <span class="dim">${p.target && p.target.kind} ${p.target && p.target.id}</span></div>
        <div class="fs">${p.rationale}</div>
      </div>`, (p) => p.id)}

      <div class="sec">what has silenced it (${d.acknowledgements.length})</div>
      ${when(!d.acknowledgements.length, () => html`<div class="empty">no gap or debt has ever been granted against it</div>`)}
      ${each(d.acknowledgements, (a) => html`<div class="op-card ${a.state === 'active' ? 'moved' : ''}">
        <div class="ft"><span class="qbadge ${a.state === 'active' ? 'drift' : ''}">${a.basis}</span>
          <span class="qbadge">${a.state}</span>
          <span class="dim">${(a.grantedAt || '').slice(0, 10)}${a.grantedBy && a.grantedBy.principal ? ' · ' + a.grantedBy.principal : ''}</span>
        </div>
        <div class="fs">${a.rationale}</div>
        ${when(!!a.releasedAt, () => html`<div class="fs dim">released ${(a.releasedAt || '').slice(0, 10)} — kept because a waiver somebody lifted is exactly what a reader asking why this went quiet is looking for</div>`)}
      </div>`, (a) => a.id)}

      <div class="sec">problems (${d.problems.length})</div>
      ${each(d.problems, (p) => html`<div class="op-card">
        <div class="ft"><span class="qbadge ${p.disposition ? '' : 'drift'}">${p.disposition || 'un-adjudicated'}</span>
          <span class="dim">${(p.raisedAt || '').slice(0, 10)}</span></div>
        <div class="fs">${p.summary}</div>
      </div>`, (p) => p.id)}

      <div class="sec">how it got here (${d.history.length})</div>
      ${each(d.history, (o) => html`<div class="op-card">
        <div class="ft"><span class="qbadge">${o.kind.replace(/_/g, ' ')}</span> <span class="dim">${o.specId}</span></div>
        <div class="fs">${o.rationale}</div>
      </div>`, (o) => o.id)}
    `);
  }
}
defineComponent('requirement-page', RequirementPage);

/**
 * The standard as a reference — sections first, then the rules filed in one.
 *
 * Section-first rather than one long list, because that is what the record is FOR: a
 * reader who needs the rule governing an area without knowing which spec introduced
 * it. Loading every rule up front would also be the wrong shape at the size this is
 * meant to reach (the seeding estimate is ~150 rules for one repo).
 *
 * @typedef {{ sections: any, rules: any }} RulesState
 * @extends {Component<StdProps, RulesState>}
 */
class RulesPage extends Component {
  static props = { params: {}, query: {} };
  /** @param {StdProps} props */
  constructor(props) {
    super(props);
    /** @type {RulesState} */
    this.state = { sections: null, rules: null };
  }
  load = this.createTask(async () => {
    const u = this.props.params.universe, section = this.props.query.section;
    nav.current = u;
    this.state.sections = await api('/api/standard/sections', { u });
    this.state.rules = section ? await api('/api/standard/requirements', { u, section }) : null;
  });
  mounted() { this.load.run(); }
  propsChanged() { this.state.sections = null; this.state.rules = null; this.load.run(); }
  template() {
    const u = this.props.params.universe, sec = this.state.sections, chosen = this.props.query.section;
    return pageShell(sec, taskError(this.load), () => html`
      <div class="crumbs"><a class="back" href="${href(standardUrl(u))}">← standard</a> <span class="sep">·</span> requirements</div>
      ${servedNote(sec)}
      ${when(!sec.sections.length, () => html`<div class="empty">the standard is empty — nothing has been ratified yet. An agent proposes with <code>draft_spec</code>; adopting one is yours.</div>`)}
      <div class="dnav">
        ${each(sec.sections, (x) => html`<a class="btnlike ${x.section === chosen ? 'on' : ''}" href="${href(rulesUrl(u), { section: x.section })}">${x.section} <span class="n">${x.count}</span></a>`, (x) => x.section)}
      </div>
      ${when(!!this.state.rules, () => html`
        <div class="sec">${chosen} (${this.state.rules.requirements.length})</div>
        ${each(this.state.rules.requirements, (r) => html`<a class="spec-card" href="${href(requirementUrl(u, r.id))}">
          <div class="ft">${r.title}
            ${when(r.recheckDue, () => html`<span class="qbadge drift">recheck due</span>`)}
            ${when(r.status === 'retired', () => html`<span class="qbadge">retired</span>`)}
          </div>
          <div class="fs">${r.statement}</div>
        </a>`, (r) => r.id)}
      `)}
    `);
  }
}
defineComponent('rules-page', RulesPage);
