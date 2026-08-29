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
import { api, attestedPost, pageShell, nav, href, errText, taskError, isErr } from './core.js';

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
export const branchUrl = (u) => `/u/${u}/standard/branch/`;
export const conformanceUrl = (u) => `/u/${u}/standard/conformance/`;
export const auditUrl = (u) => `/u/${u}/standard/audit/`;

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
 *
 * **The field is `scope`, and this read `d.served` for as long as the pages existed.** So
 * the banner rendered on nothing: every standard page served a blocked team's projection
 * rows with no warning at all — the exact failure `standardScopeWarning` was written to
 * close, reintroduced one layer up by a reader that named the field wrong. `web/shared.js`
 * had it right the whole time (`blockedBanner(d.scope)`), which is what makes this the
 * cheapest kind of defect to have missed and the most embarrassing to explain.
 *
 * `tsc -p web` cannot see it — `d` is a parameter with no type, and `d.served` on an
 * untyped value is `any`. That is why `standard-ui.e2e.ts` now blocks a scope for real and
 * asserts the words appear.
 *
 * @param {{ scope?: { status: string, detail?: string, diagnostic?: { detail?: string } } }} d
 */
const servedNote = (d) => when(!!(d && d.scope), () => html`<div class="attn-banner">
  <span class="attn-n">⚠</span>
  <span>this is not the team's standard: ${d.scope.status === 'blocked' ? 'the shared log is refusing to be read as settled' : 'these rows are behind the log'}${d.scope.detail || (d.scope.diagnostic && d.scope.diagnostic.detail) ? ' — ' + (d.scope.detail || d.scope.diagnostic.detail) : ''}. Sync, then re-read.</span>
</div>`);

/**
 * A comment thread on a proposal.
 *
 * Read-only here; posting is the page's job because only it knows how to reload. The
 * author is rendered with `via` intact — a remark from an agent running as somebody is
 * a different weight of evidence from one that person wrote, and collapsing the two is
 * the misattribution this codebase has already shipped once.
 *
 * **And it shipped again here.** `sharedNotes` FLATTENS a note to `{by, model, at}`; this
 * read `n.author.principal` and `n.createdAt`, which are the record's field names and not
 * the view's — so every comment rendered as `unknown` with a blank date, and the `via`
 * this docstring calls the point was the first thing lost. The e2e asserted the body text
 * and nothing else, which is exactly the assertion that cannot see it.
 */
const thread = (notes) => when(notes && notes.length > 0, () => html`<div class="cmts">
  ${each(notes, (n) => html`<div class="cmt">
    <div class="cmt-h">${n.by || 'unknown'}${n.model ? html` <span class="dim">via ${n.model}</span>` : ''}
      <span class="dim">${(n.at || '').slice(0, 16).replace('T', ' ')}</span>
      ${when(n.kind === 'question', () => html`<span class="qbadge">question</span>`)}
      ${when(!!n.resolved, () => html`<span class="qbadge">resolved</span>`)}
    </div>
    <div class="cmt-b">${n.text}</div>
    ${each(n.answers || [], (a) => html`<div class="cmt-a"><span class="dim">${a.by || 'unknown'}${a.model ? ' via ' + a.model : ''}:</span> ${a.body}</div>`, (a) => a.at + (a.body || '').slice(0, 12))}
  </div>`, (n) => n.id)}
</div>`);

/**
 * @typedef {{ params: { universe: string, id?: string }, query: Record<string, string> }} StdProps
 */

/** One line of who and when, in the shape every record on this surface carries. */
const byline = (who, at) => html`<span class="dim">${(at || '').slice(0, 16).replace('T', ' ')}${who && who.principal ? ' · ' + who.principal : ''}${who && who.via ? ' via ' + (who.via.model || 'agent') : ''}</span>`;

/**
 * A problem, with the four dispositions a PRINCIPAL may pick.
 *
 * The buttons are the whole reason this page exists. `adjudicate` is principal-gated —
 * an agent may establish the disagreement and may never decide it — so before this the
 * hub counted a queue whose only act had nowhere to happen. Same argument as ratification.
 *
 * The reason box is not optional garnish: it is what a later reader has instead of the
 * conversation, and `adjudicate` refuses an empty one.
 *
 * **`requirement-misstated` is first and that is not cosmetic** — see the note on
 * `ProblemDisposition`. Putting `code-wrong` first makes "the code is at fault" the default
 * reading on the one screen where a person decides which side moves.
 */
const DISPOSITIONS = [
  ['requirement-misstated', 'the rule did not change; our statement of it was incomplete — the commonest real outcome, and the one that evaporates if it is not the easy answer'],
  ['code-wrong', 'the rule stands and the code violates it — closed by a conformant audit'],
  ['requirement-changed', 'the business moved — closed by a ratified spec amending the rule'],
  ['accepted', 'non-conformant and we are living with it — closed by a granted debt'],
];

/**
 * The hub — the conformance distribution, and every queue over it.
 *
 * It used to show six queue COUNTS and open exactly one of them. A count nobody can act
 * on is a scoreboard, not a queue, and the three that carry an act — adjudicate, promote,
 * release — had nowhere at all to happen in a browser. `standardQueues` costs the same as
 * the counts did (`standardStatus` computed these rows and kept only their lengths), so
 * this is the same read with the answer no longer thrown away.
 *
 * @typedef {{ status: ApiMap['/api/standard']|null, q: ApiMap['/api/standard/queues']|null, busy: string|null, err: string|null, reason: Record<string,string> }} StandardState
 * @extends {Component<StdProps, StandardState>}
 */
class StandardPage extends Component {
  static props = { params: {}, query: {} };
  /** @param {StdProps} props */
  constructor(props) {
    super(props);
    /** @type {StandardState} */
    this.state = { status: null, q: null, busy: null, err: null, reason: {} };
  }
  load = this.createTask(async () => {
    const u = this.props.params.universe;
    nav.current = u;
    const [status, q] = await Promise.all([api('/api/standard', { u }), api('/api/standard/queues', { u })]);
    this.state.status = status; this.state.q = q;
  });
  mounted() { this.load.run(); }
  propsChanged() { this.state.status = null; this.load.run(); }

  /**
   * Any of the queue acts. The reply is rendered VERBATIM on failure for the reason
   * `SpecPage.act` gives: a refusal here names what is missing, and summarising it away
   * leaves the one person who can act with nothing to act on.
   */
  async act(key, path, body) {
    if (this.state.busy) return;
    this.state.busy = key; this.state.err = null;
    try {
      const r = await attestedPost(path, { u: this.props.params.universe, ...body });
      if (r && r.error) { this.state.err = r.error; return; }
      this.state.reason = { ...this.state.reason, [key]: '' };
      this.load.run();
    } catch (e) { this.state.err = errText(e); } finally { this.state.busy = null; }
  }

  /** The free-text half of an act, kept per row so two open forms cannot share a draft. */
  why(key, placeholder) {
    return html`<input placeholder="${placeholder}" value="${this.state.reason[key] || ''}"
      on-change="${(e, v) => { this.state.reason = { ...this.state.reason, [key]: v }; }}">`;
  }

  problem(p, u, actions) {
    return html`<div class="op-card">
      <div class="ft"><span class="qbadge ${p.disposition ? '' : 'drift'}">${p.disposition || 'un-adjudicated'}</span>
        ${when(!!p.provisional, () => html`<span class="qbadge drift" title="raised from a branch finding — a problem is exactly as shareable as the evidence under it">branch</span>`)}
        ${byline(p.raisedBy, p.raisedAt)}
      </div>
      <div class="fs">${p.summary}</div>
      ${when(!!p.prior, () => html`<div class="fs dim">the auditor's prior — context, never a resolution: ${p.prior}</div>`)}
      ${when(!!p.awaiting, () => html`<div class="fs dim">awaiting: ${p.awaiting}</div>`)}
      <div class="fs"><a href="${href(requirementUrl(u, p.requirementId))}">the rule ›</a></div>
      ${actions ? actions() : ''}
    </div>`;
  }

  template() {
    const u = this.props.params.universe, s = this.state.status, q = this.state.q;
    return pageShell(s && q, taskError(this.load), () => html`
      <div class="crumbs"><b>${u}</b> <span class="sep">·</span> standard</div>
      ${servedNote(s)}
      ${when(!!this.state.err, () => html`<div class="attn-banner"><span class="attn-n">✕</span><span>${this.state.err}</span></div>`)}

      ${when(!!(s.overdue && (s.overdue.scrubs || s.overdue.acknowledgements)), () => html`<div class="attn-banner">
        <span class="attn-n">⏰</span>
        <span>Overdue: ${s.overdue.scrubs ? `${s.overdue.scrubs} rule(s) past their coverage deadline` : ''}${s.overdue.scrubs && s.overdue.acknowledgements ? ', ' : ''}${s.overdue.acknowledgements ? `${s.overdue.acknowledgements} silencer(s) past revalidate-by` : ''}. Nothing runs these on a schedule and nothing will — a good moment is a branch landing or a release. <a href="${href(auditUrl(u))}">what to audit ›</a></span>
      </div>`)}

      <div class="sec">conformance</div>
      <div class="dnav">
        ${each(Object.keys(s.conformance || {}).filter(k => typeof s.conformance[k] === 'number'), (k) => html`<span class="chip">${confDot(k)}${k}: ${s.conformance[k]}</span>`, k => k)}
      </div>
      <div class="dnav">
        <a class="btnlike" href="${href(rulesUrl(u))}">browse the standard ›</a>
        <a class="btnlike" href="${href(conformanceUrl(u))}">where every rule stands ›</a>
        <a class="btnlike" href="${href(auditUrl(u))}">what to audit next ›</a>
        <a class="btnlike" href="${href(branchUrl(u))}">branch findings ›</a>
      </div>

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

      <div class="sec">awaiting adjudication (${q.awaitingAdjudication.length})</div>
      <div class="empty">Which side moves is a business question, so an agent may establish the disagreement and may never decide it. This is deliberately NOT a fix queue — naming the disposition does not do the work.</div>
      ${each(q.awaitingAdjudication, (p) => this.problem(p, u, () => html`<div class="op-actions">
        ${this.why('adj:' + p.id, 'why — this is what a later reader has instead of the conversation')}
        ${each(DISPOSITIONS, (d) => html`<button class="pullbtn" title="${d[1]}"
          disabled="${!!this.state.busy}"
          on-click="${() => this.act('adj:' + p.id, '/api/standard/adjudicate', { problemId: p.id, disposition: d[0], reason: this.state.reason['adj:' + p.id] || '' })}">${d[0]}</button>`, (d) => d[0])}
      </div>`), (p) => p.id)}

      <div class="sec">owed — decided, not yet done (${q.actionable.length})</div>
      ${when(!q.actionable.length, () => html`<div class="empty">nothing adjudicated is outstanding</div>`)}
      ${each(q.actionable, (p) => this.problem(p, u, null), (p) => p.id)}

      <div class="sec">settled without adjudication (${q.settledWithoutAdjudication.length})</div>
      ${when(!q.settledWithoutAdjudication.length, () => html`<div class="empty">none — the andon signal is quiet</div>`)}
      ${when(q.settledWithoutAdjudication.length > 0, () => html`<div class="empty">A business question that got answered by somebody changing code. Read these even when nothing else is wrong: an agent under deadline resolving a business question by guessing produces exactly this, and the guess is almost always "make it agree with the code".</div>`)}
      ${each(q.settledWithoutAdjudication, (p) => this.problem(p, u, null), (p) => p.id)}

      <div class="sec">promotable branch findings (${q.promotableAudits.length})</div>
      ${when(!q.promotableAudits.length, () => html`<div class="empty">nothing to promote. A branch finding is offered here only while the exact code it examined is still present — on the witnesses, never on the merge.</div>`)}
      ${each(q.promotableAudits, (a) => html`<div class="op-card">
        <div class="ft">${confDot('nonconformant')}<b>${a.outcome}</b>
          <span class="qbadge drift">${a.branch || 'branch'}</span> ${byline(a.auditor, a.at)}</div>
        <div class="fs">${a.finding}</div>
        <div class="fs"><a href="${href(requirementUrl(u, a.requirementId))}">the rule ›</a></div>
        <div class="op-actions"><button class="pullbtn" disabled="${!!this.state.busy}"
          title="re-record it as an observation of the codebase. A NEW audit, because the original was taken on a branch and saying otherwise would falsify its own record."
          on-click="${() => this.act('promote:' + a.id, '/api/standard/promote_audit', { auditId: a.id })}">promote</button></div>
      </div>`, (a) => a.id)}

      <div class="sec">silencers past their revalidate-by (${q.acknowledgementsDue.length})</div>
      ${when(!q.acknowledgementsDue.length, () => html`<div class="empty">nothing overdue</div>`)}
      ${each(q.acknowledgementsDue, (a) => html`<div class="op-card moved">
        <div class="ft"><span class="qbadge drift">${a.basis}</span><span class="qbadge">${a.priority}</span>
          <span class="dim">due ${(a.revalidateBy || '').slice(0, 10)}</span> ${byline(a.grantedBy, a.grantedAt)}</div>
        <div class="fs">${a.rationale}</div>
        <div class="fs"><a href="${href(requirementUrl(u, a.requirementId))}">the rule ›</a></div>
        <div class="op-actions">
          ${this.why('rel:' + a.id, 'why it no longer applies')}
          <button class="pullbtn" disabled="${!!this.state.busy}"
            title="releasing is the UNSILENCING direction, so it is open to any actor — granting never is"
            on-click="${() => this.act('rel:' + a.id, '/api/standard/release', { id: a.id, reason: this.state.reason['rel:' + a.id] || '' })}">release</button>
        </div>
      </div>`, (a) => a.id)}
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
      const r = await attestedPost(`/api/standard/${kind}`, kind === 'withdraw' ? { ...body, reason: this.state.reason } : body);
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
      const r = await attestedPost('/api/standard/comment', { u: this.props.params.universe, id: targetId, body });
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
 * @typedef {{ d: ReqData | null, busy: string|null, err: string|null, form: Record<string,string> }} ReqState
 * @extends {Component<StdProps, ReqState>}
 */
class RequirementPage extends Component {
  static props = { params: {}, query: {} };
  /** @param {StdProps} props */
  constructor(props) {
    super(props);
    /** @type {ReqState} */
    this.state = { d: null, busy: null, err: null, form: {} };
  }
  load = this.createTask(async () => {
    nav.current = this.props.params.universe;
    const r = await api('/api/standard/requirement', { u: this.props.params.universe, id: this.props.params.id });
    if (isErr(r)) throw new Error(r.error);
    this.state.d = r;
  });
  mounted() { this.load.run(); }
  propsChanged() { this.state.d = null; this.load.run(); }

  /** The dossier's write acts. Failure renders verbatim — see `SpecPage.act`. */
  async act(key, path, body) {
    if (this.state.busy) return;
    this.state.busy = key; this.state.err = null;
    try {
      const r = await attestedPost(path, { u: this.props.params.universe, ...body });
      if (r && r.error) { this.state.err = r.error; return; }
      this.state.form = {};
      this.load.run();
    } catch (e) { this.state.err = errText(e); } finally { this.state.busy = null; }
  }
  fld(k, placeholder) {
    return html`<input placeholder="${placeholder}" value="${this.state.form[k] || ''}"
      on-change="${(e, v) => { this.state.form = { ...this.state.form, [k]: v }; }}">`;
  }

  template() {
    const u = this.props.params.universe, d = this.state.d;
    return pageShell(d, taskError(this.load), () => html`
      <div class="crumbs"><a class="back" href="${href(standardUrl(u))}">← standard</a> <span class="sep">·</span> ${d.requirement.section}</div>
      ${servedNote(d)}
      ${when(!!this.state.err, () => html`<div class="attn-banner"><span class="attn-n">✕</span><span>${this.state.err}</span></div>`)}
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

      <div class="sec">what discharges it (${d.criteria.criteria.length})</div>
      ${when(!d.criteria.criteria.length, () => html`<div class="empty">no acceptance criteria. Nothing states what would satisfy this rule, or what would refute it.</div>`)}
      ${each(d.criteria.criteria, (c) => html`<div class="op-card ${c.assertionMoved ? 'moved' : ''}">
        <div class="ft"><span class="qbadge">${c.evidenceKind}</span>
          <span class="qbadge ${c.vacuity === 'demonstrated' ? '' : 'drift'}" title="whether anybody has established this check CAN fail — unchecked must never read as demonstrated">${c.vacuity}</span>
          ${when(!!c.assertionMoved, () => html`<span class="qbadge drift" title="the check's own code changed since ratification — the DETECTOR moved, which is a stronger signal than the rule's subject moving">assertion moved</span>`)}
        </div>
        <div class="fs">${c.criterion}</div>
        <div class="fs dim">refuted by: ${c.falsifier}</div>
        <div class="fs dim">${(c.assertedBy || []).length ? (c.assertedBy || []).length + ' asserting check(s)' : 'no check asserts it — a criterion nothing runs is a claim nothing can invalidate'}</div>
      </div>`, (c) => c.id)}

      <div class="sec">what it ranges over</div>
      <div class="op-card">
        <div class="ft"><span class="qbadge ${d.population.state === 'pinned' ? '' : 'drift'}">${d.population.state}</span>
          ${when(!!(d.population.current && d.population.current.pinBroken), () => html`<span class="qbadge drift" title="the lint that enumerates the population was edited since it was pinned — fired, was edited, now quiet">pin broken</span>`)}
        </div>
        ${when(d.population.state === 'absent', () => html`<div class="fs dim">nothing enumerates it. "No code should conform to this yet" then means "I looked and did not find any", which is the claim the pin exists to replace.</div>`)}
        ${when(d.population.state === 'not-expressible', () => html`<div class="fs">${d.population.current ? d.population.current.reason : ''}</div>`)}
        ${when(!!d.population.current && d.population.state === 'pinned', () => html`<div class="fs">${d.population.current.counts.members} member(s) — ${d.population.current.counts.conforms} conform, ${d.population.current.counts.violates} violate, ${d.population.current.counts.undecidable} undecidable · ${(d.population.current.lint || []).length} pinned anchor(s) in the lint</div>`)}
      </div>

      <div class="sec">covering audits — the scrub (${d.scrubs.length})</div>
      ${when(!d.scrubs.length, () => html`<div class="empty">never swept. A scrub selects on a coverage DEADLINE, not on staleness: nobody has looked at this rule as a whole, whether or not anything moved.</div>`)}
      ${each(d.scrubs, (a) => html`<div class="op-card">
        <div class="ft"><span class="qbadge">${a.trigger}</span> <b>${a.outcome}</b> ${byline(a.auditor, a.at)}</div>
        <div class="fs">${a.finding}</div>
      </div>`, (a) => a.id)}

      <div class="sec">how it got here (${d.history.length})</div>
      ${each(d.history, (o) => html`<div class="op-card">
        <div class="ft"><span class="qbadge">${o.kind.replace(/_/g, ' ')}</span> <span class="dim">${o.specId}</span></div>
        <div class="fs">${o.rationale}</div>
      </div>`, (o) => o.id)}

      <div class="sec">yours to do</div>
      <div class="empty">Two acts a PRINCIPAL performs and an agent structurally cannot: granting debt — saying conforming code should exist, does not, and we accept that — and re-filing the rule under another section. Everything else on this page is the product of reading code, which is an agent's job.</div>
      <div class="op-card">
        <div class="ft">accept debt</div>
        ${this.fld('debt-why', 'why we are living with it')}
        ${this.fld('debt-by', 'revalidate by — ISO date, e.g. 2027-01-01')}
        <div class="op-actions">
          ${each(['high', 'medium', 'low'], (pr) => html`<button class="pullbtn" disabled="${!!this.state.busy}"
            title="how SOON — about this instance of not conforming. Not the same field as how bad a violation would be."
            on-click="${() => this.act('debt', '/api/standard/acknowledge_debt', {
              requirementId: d.requirement.id, rationale: this.state.form['debt-why'] || '',
              priority: pr, revalidateBy: this.state.form['debt-by'] || '',
            })}">${pr}</button>`, (pr) => pr)}
        </div>
      </div>
      ${when(!d.requirement.origin, () => html`<div class="op-card">
        <div class="ft">re-file</div>
        ${this.fld('refile-section', 'section — e.g. Credit/Limits')}
        <div class="op-actions"><button class="pullbtn" disabled="${!!this.state.busy}"
          on-click="${() => this.act('refile', '/api/standard/refile', { id: d.requirement.id, section: this.state.form['refile-section'] || '' })}">move it</button></div>
      </div>`)}
      ${when(!!d.requirement.origin, () => html`<div class="op-card">
        <div class="ft">re-file</div>
        <div class="fs dim">Not from here: this rule is the team's, and re-filing one shared rule has no shared act — a local write would be erased by the next sync. Move the whole heading with a <code>move_section</code> operation in a spec.</div>
        <div class="fs dim">Which is the open question <code>requirements-architecture.md</code> § <i>Deliberately open</i> names: if the only way to fix filing is to write a spec about filing, nobody will do it. Reorganizing the standard wants to be a principal act independent of any spec, and on a team store it is not one yet.</div>
      </div>`)}
    `);
  }
}
defineComponent('requirement-page', RequirementPage);

/**
 * Branch findings — audits taken off the default branch, or on a dirty tree.
 *
 * These are NOT the state of the codebase and never become it: nothing folds a provisional
 * audit, so no clone has a row for it and `conformance` cannot count it. What the page is
 * FOR is the thing that was impossible before it: a reviewer, looking at somebody else's
 * branch, seeing that it fails a rule. Findings travel as commit-keyed documents, so a
 * teammate's appear here beside your own.
 *
 * `?commit=` narrows it to one commit — the reviewer's question, and a short sha is fine.
 *
 * @typedef {{ d: ApiMap['/api/standard/provisional']|null, busy: string|null, err: string|null, commit: string }} BranchState
 * @extends {Component<StdProps, BranchState>}
 */
class BranchFindingsPage extends Component {
  static props = { params: {}, query: {} };
  /** @param {StdProps} props */
  constructor(props) {
    super(props);
    /** @type {BranchState} */
    this.state = { d: null, busy: null, err: null, commit: props.query.commit || '' };
  }
  load = this.createTask(async () => {
    const u = this.props.params.universe;
    nav.current = u;
    this.state.d = await api('/api/standard/provisional', { u, commit: this.state.commit || null });
  });
  mounted() { this.load.run(); }
  propsChanged() { this.state.d = null; this.load.run(); }

  async promote(id) {
    if (this.state.busy) return;
    this.state.busy = id; this.state.err = null;
    try {
      const r = await attestedPost('/api/standard/promote_audit', { u: this.props.params.universe, auditId: id });
      if (r && r.error) { this.state.err = r.error; return; }
      this.load.run();
    } catch (e) { this.state.err = errText(e); } finally { this.state.busy = null; }
  }

  template() {
    const u = this.props.params.universe, d = this.state.d;
    return pageShell(d, taskError(this.load), () => html`
      <div class="crumbs"><a class="back" href="${href(standardUrl(u))}">← standard</a> <span class="sep">·</span> branch findings</div>
      ${servedNote(d)}
      ${when(!!this.state.err, () => html`<div class="attn-banner"><span class="attn-n">✕</span><span>${this.state.err}</span></div>`)}
      <div class="empty">Observations of somebody's branch — yours and the team's. They reach no clone's conformance, because nothing folds them; ask for <code>conformance</code> about the branch if you want the verdict rather than the findings. An audit taken on a DIRTY tree never travels at all: its witnesses came off the filesystem while the commit names an unchanged HEAD.</div>
      <div class="dnav">
        <input placeholder="commit — what does codemap know about the code in front of me?" value="${this.state.commit}"
          on-change="${(e, v) => { this.state.commit = v.trim(); }}">
        <button class="pullbtn" on-click="${() => this.load.run()}">look</button>
      </div>

      <div class="sec">findings (${d.audits.length})</div>
      ${when(!d.audits.length, () => html`<div class="empty">${this.state.commit ? 'nothing recorded against that commit' : 'no branch findings — nobody has audited off the default branch, or the trees were dirty when they did'}</div>`)}
      ${each(d.audits, (a) => html`<div class="op-card ${a.superseded ? '' : 'moved'}">
        <div class="ft">${confDot(a.outcome === 'conformant' ? 'conformant' : a.outcome === 'nonconformant' ? 'nonconformant' : 'unknown')}
          <b>${a.outcome}</b>
          <span class="qbadge">${a.trigger || 'ad-hoc'}</span>
          <span class="qbadge drift">${a.branch || 'branch'}</span>
          ${when(!!a.superseded, () => html`<span class="qbadge" title="the code it examined has moved, so it says nothing about what is here now — re-audit rather than promote">superseded</span>`)}
          ${byline(a.auditor, a.at)}
        </div>
        <div class="fs">${a.finding}</div>
        <div class="fs dim">at ${(a.commit || '').slice(0, 12)}${a.evidence && a.evidence.read ? ' · ' + a.evidence.read.length + ' anchor(s) read' : ''}${a.evidence && a.evidence.ran ? ', ' + a.evidence.ran.length + ' command(s) run' : ''}</div>
        <div class="fs"><a href="${href(requirementUrl(u, a.requirementId))}">the rule ›</a></div>
        ${when(a.outcome === 'nonconformant' && !a.superseded, () => html`<div class="op-actions">
          <button class="pullbtn" disabled="${!!this.state.busy}"
            title="only from the default branch, and only while the audited code is verbatim present — promotion is decided on witnesses, never on the merge"
            on-click="${() => this.promote(a.id)}">promote to the codebase</button>
        </div>`)}
      </div>`, (a) => a.id)}
    `);
  }
}
defineComponent('branch-findings-page', BranchFindingsPage);

/**
 * Every rule and where it stands — and the toggle that says WHICH CODE that is about.
 *
 * The route existed and no page fetched it, which the reach sweep found: the hub showed
 * the distribution and there was nowhere to see which rules were in which bucket.
 *
 * `about` is the half worth explaining on the page itself. `codebase` is the team's
 * standard, so it reads the same on every machine; `branch` counts branch findings — this
 * machine's and the team's, on the witness test — and is the reviewer's question about the
 * code checked out here. It leaks nowhere: no queue, no deadline, no release.
 *
 * @typedef {{ d: ApiMap['/api/standard/conformance']|null, about: string, only: string }} ConfState
 * @extends {Component<StdProps, ConfState>}
 */
class ConformancePage extends Component {
  static props = { params: {}, query: {} };
  /** @param {StdProps} props */
  constructor(props) {
    super(props);
    /** @type {ConfState} */
    this.state = { d: null, about: props.query.about === 'branch' ? 'branch' : 'codebase', only: '' };
  }
  load = this.createTask(async () => {
    const u = this.props.params.universe;
    nav.current = u;
    this.state.d = await api('/api/standard/conformance', { u, about: this.state.about });
  });
  mounted() { this.load.run(); }
  propsChanged() { this.state.d = null; this.load.run(); }

  look(about) { if (about !== this.state.about) { this.state.about = about; this.load.run(); } }

  template() {
    const u = this.props.params.universe, d = this.state.d;
    const rows = d ? d.conformance.filter((c) => !this.state.only || c.conformance === this.state.only) : [];
    const tally = (k) => d.conformance.filter((c) => c.conformance === k).length;
    return pageShell(d, taskError(this.load), () => html`
      <div class="crumbs"><a class="back" href="${href(standardUrl(u))}">← standard</a> <span class="sep">·</span> conformance</div>
      ${servedNote(d)}
      <div class="dnav">
        <button class="pullbtn ${this.state.about === 'codebase' ? 'checked' : ''}"
          title="the team's standard — provisional evidence excluded, so this number means the same on every machine"
          on-click="${() => this.look('codebase')}">the codebase</button>
        <button class="pullbtn ${this.state.about === 'branch' ? 'checked' : ''}"
          title="does the code checked out HERE conform — the only read that counts branch findings, yours and the team's"
          on-click="${() => this.look('branch')}">this branch</button>
      </div>
      <div class="empty">${this.state.about === 'branch'
        ? 'Branch findings count here and nowhere else. A verdict on this page is about the code you have checked out, not about the standard — it feeds no queue and releases nothing.'
        : 'The team\'s standard. `unknown` means nobody has checked, and is never the same as fine — a standard that looks satisfied because it is merely unexamined is confidence manufactured at scale.'}</div>
      <div class="dnav">
        ${each(['conformant', 'gap', 'debt', 'unknown'], (k) => html`<button class="chip ${this.state.only === k ? 'checked' : ''}"
          on-click="${() => { this.state.only = this.state.only === k ? '' : k; }}">${confDot(k)}${k}: ${tally(k)}</button>`, (k) => k)}
      </div>

      ${when(!rows.length, () => html`<div class="empty">nothing in that bucket</div>`)}
      ${each(rows, (c) => html`<a class="spec-card" href="${href(requirementUrl(u, c.requirement.id))}">
        <div class="ft">${confDot(c.conformance)} ${c.requirement.title} <span class="dreqs">${c.requirement.section}</span>
          ${when(!!c.wasConformant && c.conformance !== 'conformant', () => html`<span class="qbadge drift" title="met once, and no longer known to be — a regression, which a never-audited rule cannot signal">regressed</span>`)}
          ${when((c.acknowledgements || []).length > 0, () => html`<span class="qbadge">${c.acknowledgements.length} silencer(s)</span>`)}
        </div>
        <div class="fs dim">${c.lastAudit
          ? (c.lastAudit.superseded ? 'last audit is superseded — the code it read has moved' : 'last audit: ' + c.lastAudit.outcome) + ' · ' + (c.lastAudit.at || '').slice(0, 10)
          : 'never audited'}</div>
      </a>`, (c) => c.requirement.id)}
    `);
  }
}
defineComponent('conformance-page', ConformancePage);

/**
 * What to audit next, and what is wrong with the apparatus that decides it.
 *
 * The conformance distribution says what is UNKNOWN and never where to start. These five
 * reads do, and every one of them was MCP-only: pointers that are firing, rules nothing is
 * watching, coverage deadlines, pins whose lint has been edited under them, and criteria
 * nobody has shown can fail.
 *
 * @typedef {{ d: ApiMap['/api/standard/health']|null }} HealthState
 * @extends {Component<StdProps, HealthState>}
 */
class AuditPlanPage extends Component {
  static props = { params: {}, query: {} };
  /** @param {StdProps} props */
  constructor(props) {
    super(props);
    /** @type {HealthState} */
    this.state = { d: null };
  }
  load = this.createTask(async () => {
    const u = this.props.params.universe;
    nav.current = u;
    this.state.d = await api('/api/standard/health', { u });
  });
  mounted() { this.load.run(); }
  propsChanged() { this.state.d = null; this.load.run(); }

  /**
   * A list of rules, linked. GENERIC on purpose: a plain helper takes `any` with
   * `noImplicitAny` off, and that is how `r.lastCovered` — a field `ScrubDue` does not
   * have — typechecked and rendered "last covered never" for every row.
   *
   * @template {{ requirementId: string, title: string, section: string }} R
   * @param {string} u
   * @param {R[]} rows
   * @param {string} empty
   * @param {(r: R) => string} line
   */
  rules(u, rows, empty, line) {
    return html`${when(!rows.length, () => html`<div class="empty">${empty}</div>`)}
      ${each(rows, (r) => html`<a class="spec-card" href="${href(requirementUrl(u, r.requirementId))}">
        <div class="ft">${r.title} <span class="dreqs">${r.section}</span></div>
        <div class="fs dim">${line(r)}</div>
      </a>`, (r) => r.requirementId)}`;
  }

  template() {
    const u = this.props.params.universe, d = this.state.d;
    return pageShell(d, taskError(this.load), () => html`
      <div class="crumbs"><a class="back" href="${href(standardUrl(u))}">← standard</a> <span class="sep">·</span> what to audit next</div>
      ${servedNote(d)}

      <div class="sec">pointers firing (${d.auditQueue.firing.length})</div>
      <div class="empty">Watched code has moved. A pointer is a PRIOR on where to look and never a verdict — it changes queue position, nothing else.</div>
      ${this.rules(u, d.auditQueue.firing, 'nothing watched has moved', (r) => `${r.pointers.length} pointer(s) firing`)}

      <div class="sec">nothing is watching (${d.auditQueue.unwatched.length})</div>
      ${this.rules(u, d.auditQueue.unwatched, 'every rule in force has something pointing at it', () => 'no pointer — a rule with nothing watching it observes nothing, and that is itself the finding')}

      <div class="sec">coverage deadlines (${d.scrub.due.length})</div>
      <div class="empty">A scrub selects on a DEADLINE — this has not been looked at in T, whether or not anything moved — which is why it is a separate queue from the one above.</div>
      ${this.rules(u, d.scrub.due, 'nothing is overdue for a scrub', (r) => `last covered ${r.lastScrubbed ? String(r.lastScrubbed).slice(0, 10) : 'never'}`)}

      <div class="sec">pins whose lint moved (${d.brokenPins.length})</div>
      <div class="empty">The lint that enumerates what a rule ranges over has been edited since it was pinned. That is the <i>fired → edited → quiet</i> case the hash pin exists to catch.</div>
      ${each(d.brokenPins, (p) => html`<a class="spec-card" href="${href(requirementUrl(u, p.requirementId))}">
        <div class="ft">${p.requirementId}</div>
        <div class="fs dim">${(p.drifted || []).length} of ${(p.lint || []).length} pinned anchor(s) moved</div>
      </a>`, (p) => p.id)}

      <div class="sec">checks nobody has shown can fail</div>
      <div class="empty">Citing an assertion makes a claim STRONGER — it turns "nobody edited the cited code" into "green as of the last build". Over a check that cannot fail, that is manufactured confidence with a mechanism attached.</div>
      <div class="dnav">
        ${each(['unasserted', 'unchecked', 'vacuous', 'wrongLayer', 'moved'], (k) => html`<span class="chip">${k}: ${(d.weakAssertions[k] || []).length}</span>`, (k) => k)}
      </div>
      ${each(['vacuous', 'wrongLayer', 'moved', 'unchecked'], (k) => html`${each(d.weakAssertions[k] || [], (c) => html`<a class="spec-card" href="${href(requirementUrl(u, c.requirementId))}">
        <div class="ft"><span class="qbadge drift">${k}</span> ${c.criterion}</div>
        ${when(!!c.falsifier, () => html`<div class="fs dim">refuted by: ${c.falsifier}</div>`)}
      </a>`, (c) => c.id)}`, (k) => k)}

      <div class="sec">baseline sweep</div>
      <div class="empty">Not a queue — every rule in force, with what is known about each. Expensive on purpose: it is the read for a large refactor landing or a high-risk ship. ${d.baseline.population} rule(s) in force.</div>
    `);
  }
}
defineComponent('audit-plan-page', AuditPlanPage);

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
