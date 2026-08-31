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
 * Where an operation files in the standard.
 *
 * A criterion is absent on purpose — it has no section of its own, it files with the rule
 * it tests, and `grouped` resolves that before it gets here.
 */
const sectionOf = (o) => o.operation.section
  || (o.before && o.before.section)
  || o.operation.fromSection
  || '';

/**
 * Operations as the standard they describe: Area → Topic → rule, each rule carrying the
 * criteria that test it.
 *
 * This page rendered `ord` order, flat, with the section printed as trailing text AFTER
 * the statement. For an amendment against a standing standard that is honest — a spec IS a
 * set of operations, never a stored diff. For a BASELINE it is 32 undifferentiated cards
 * with no prior standard to diff against, which is what the first real one looked like.
 *
 * Both halves of the hierarchy were already in the data: `section` is a `/`-delimited path
 * (`docs/requirements-architecture.md`), and a criterion names its rule in
 * `targetOperationId`.
 *
 * A criterion whose target is NOT in this proposal — it tests a rule ratified earlier —
 * stays a top-level card rather than disappearing, which is why the parent lookup is a
 * membership test and not an assumption.
 */
function grouped(operations) {
  const byId = new Map(operations.map((o) => [o.operation.id, o]));
  const crits = new Map();
  const nested = new Set();
  for (const o of operations) {
    const t = o.operation.kind === 'add_criterion' ? o.operation.targetOperationId : null;
    const parent = t ? byId.get(t) : undefined;
    // Nest ONLY under a rule that is itself rendered at top level, so nesting can never
    // consume a card. Without the kind check a criterion naming another criterion is
    // filed under a parent that is itself nested and gets no children pass — and one
    // naming ITSELF is marked nested and is its own parent, so neither renders at all.
    //
    // `addOperation` refuses both, and `case "spec.operation"` in `shared-standard.ts`
    // stores an operation verbatim — so a teammate's clone can hold one its own MCP call
    // never saw. At ratification the fold does not APPLY such a criterion (it now marks
    // the whole spec `conflicted` rather than adopting the rest without it), but the draft
    // still renders here first, and this is the screen a reader signs off from: an
    // operation that does not render is one they adopt without ever having seen it.
    if (!parent || parent.operation.kind !== 'add_requirement') continue;
    if (!crits.has(t)) crits.set(t, []);
    // The parent's title travels with it so a COLLAPSED criterion still names the rule it
    // tests. Without it the header reads "criterion" and the nesting is the only clue —
    // which is no clue at all once the card above it is collapsed too.
    crits.get(t).push({ ...o, parentTitle: parent.operation.title });
    nested.add(o.operation.id);
  }
  const areas = new Map();
  for (const o of operations) {
    if (nested.has(o.operation.id)) continue;
    const path = sectionOf(o);
    const cut = path.indexOf('/');
    const area = (cut < 0 ? path : path.slice(0, cut)) || 'unfiled';
    const topic = cut < 0 ? '' : path.slice(cut + 1);
    if (!areas.has(area)) areas.set(area, new Map());
    const topics = areas.get(area);
    if (!topics.has(topic)) topics.set(topic, []);
    topics.get(topic).push({ ...o, criteria: crits.get(o.operation.id) || [] });
  }
  return [...areas].map(([area, topics]) => ({
    area,
    n: [...topics.values()].reduce((t, x) => t + x.length, 0),
    topics: [...topics].map(([topic, ops]) => ({ topic, ops })),
  }));
}

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
 * Two views over the same operations, and the default is the spec's STATUS. A draft is
 * here to be signed off, so it opens with the review machinery on each rule; a ratified
 * spec has no act left to perform, so it opens as the document it became. The toggle is
 * additive either way — reading view hides chrome, never an operation.
 *
 * @typedef {{ d: any, busy: string|null, err: string|null, reason: string, draft: Record<string,string>, editing: string|null, form: Record<string,string>, review: any, reading: boolean|null, selected: string|null }} SpecState
 * @extends {Component<StdProps, SpecState>}
 */
class SpecPage extends Component {
  static props = { params: {}, query: {} };
  /** @param {StdProps} props */
  constructor(props) {
    super(props);
    /** @type {SpecState} */
    this.state = { d: null, busy: null, err: null, reason: '', draft: {}, editing: null, form: {}, review: null, reading: null, selected: null };
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

  /**
   * The review loop, in the browser: pull, see what moved, sign off, ratify.
   *
   * Four buttons rather than one "approve", because they are four different acts and the
   * one that matters is the second — the diff. A single button would collapse the loop
   * back into the click this whole mechanism exists to make impossible to do blind.
   *
   * The ratify button is disabled while anything is unsigned, and that is a courtesy
   * rather than the control: `ratifySpec` refuses server-side whatever this page sends,
   * and `foldStandard` refuses the event again on every clone that receives it.
   */
  async loop(kind, act, body) {
    if (this.state.busy) return;
    this.state.busy = kind; this.state.err = null;
    try {
      const r = await attestedPost(`/api/standard/${act}`, { u: this.props.params.universe, ...body });
      if (r && r.error) { this.state.err = r.error; return; }
      if (act === 'review') this.state.review = r.review;
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

  /**
   * Correcting a DRAFT, from the browser.
   *
   * The whole of the rule is on the server — `revise_spec`, `revise_operation` and
   * `remove_operation` refuse a ratified spec, an operation somebody else's pending gap or
   * comment hangs off, and a kind change, and `foldStandard` refuses the same events again.
   * So this form invents nothing and hides nothing: it is refused server-side whatever it
   * sends, and it renders the refusal verbatim like every other act on this page.
   *
   * A person needs it for the case the MCP surface cannot serve: an agent drafts, goes
   * away, and the principal about to adopt the thing is the one who spots the wrong branch
   * name in the narrative. Their alternative was refusing the whole proposal.
   */
  async correct(kind, act, body) {
    if (this.state.busy) return;
    this.state.busy = kind; this.state.err = null;
    try {
      const r = await attestedPost(`/api/standard/${act}`, { u: this.props.params.universe, ...body });
      if (r && r.error) { this.state.err = r.error; return; }
      this.state.editing = null; this.state.form = {};
      this.load.run();
    } catch (e) { this.state.err = errText(e); } finally { this.state.busy = null; }
  }

  /** Open an editor over one target, seeded with what it currently says. */
  edit(target, seed) {
    this.state.err = null;
    this.state.editing = this.state.editing === target ? null : target;
    this.state.form = this.state.editing ? { ...seed } : {};
  }

  set(k, v) { this.state.form = { ...this.state.form, [k]: v }; }

  field(k, label, rows) {
    return rows
      ? html`<label class="fs"><span class="dim">${label}</span>
          <textarea rows="${rows}" value="${this.state.form[k] || ''}"
            on-input="${(e) => this.set(k, e.target.value)}"></textarea></label>`
      : html`<label class="fs"><span class="dim">${label}</span>
          <input value="${this.state.form[k] || ''}" on-input="${(e) => this.set(k, e.target.value)}"></label>`;
  }

  /**
   * Which fields an operation of this kind actually has.
   *
   * Not one form with every field: `kind` is the one thing revision cannot change, so a
   * form offering `toSection` on an `amend_statement` would only ever produce a refusal.
   */
  opFields(kind) {
    if (kind === 'add_requirement') return [['title', 'title'], ['section', 'section'], ['statement', 'statement', 3], ['provenance', 'provenance']];
    if (kind === 'amend_statement') return [['statement', 'new statement', 3]];
    if (kind === 'add_criterion') return [['criterion', 'criterion', 2], ['falsifier', 'falsifier', 2]];
    if (kind === 'move_section') return [['fromSection', 'from'], ['toSection', 'to']];
    return [];
  }

  /**
   * This reader's standing on one operation, as a badge for the card's HEADER row.
   *
   * Split from the detail below it because the state is one word and the detail is a table:
   * on its own row the word cost a full line per card, and there are thirty-two of them.
   */
  signState(o) {
    const r = this.state.d.review;
    const moved = !!r && (r.moved || []).some((m) => m.id === o.operation.id);
    const unread = !!r && (r.unwitnessed || []).some((u) => u.id === o.operation.id);
    return html`<span class="signstate">
      ${when(!!r && moved, () => html`<span class="qbadge drift">changed since you read it</span>`)}
      ${when(!!r && unread, () => html`<span class="qbadge drift">not read</span>`)}
      ${when(!!r && !moved && !unread, () => html`<span class="qbadge ok">✓ signed off</span>`)}
    </span>`;
  }

  /**
   * WHAT moved since this reader signed.
   *
   * Never collapsed behind the click, unlike the thread and the history: it is the one
   * thing on the card saying a signature they already gave no longer covers what is there.
   */
  movedNote(o) {
    const r = this.state.d.review;
    const moved = r && (r.moved || []).find((m) => m.id === o.operation.id);
    return when(!!moved, () => html`<div class="op-blocked">changed since you read it on ${(moved.readAt || '').slice(0, 10)} —
      ${each(moved.changed, (c) => html`<div class="op-moverow"><b>${c.field}</b> <span class="dim">was</span> ${c.was || '—'} <span class="dim">now</span> ${c.now || '—'}</div>`, (c) => c.field)}</div>`);
  }

  /**
   * Open a card's correction history and its composer.
   *
   * An existing comment THREAD is never collapsed — only the empty composer under it, and
   * the correction history, which the header advertises as `corrected N×`. A thread that
   * left no trace when closed would be an objection the ratifier never learns exists, and
   * the empty box asking for one is what was actually costing a row on all thirty-two
   * cards. Same line the reading-view toggle draws: hide the act, never the fact.
   *
   * The target is the heading SPAN, not the card. A card-wide handler has to guess which
   * clicks were not meant for it — `closest('button, input, textarea, a, label, .op-move')`
   * — and that list is only correct for the controls that exist on the day it is written;
   * the next `<select>` inside a card starts toggling it. A span with no interactive
   * children cannot have the problem, and the chevron makes it visible, which the whole
   * card never was.
   */
  pick(id) { this.state.selected = this.state.selected === id ? null : id; }

  /** The loop's own row: pull-and-diff, the framing, the bulk act, and how much is left. */
  reviewBar(d) {
    const r = d.review;
    const outstanding = r ? (r.unwitnessed || []).length + (r.moved || []).length + (r.framing ? 1 : 0) : 0;
    return html`<div class="op-card">
      <div class="ft"><span class="qbadge ${outstanding ? 'drift' : ''}">${outstanding ? outstanding + ' left to read' : 'you have read all of it'}</span>
        ${when((d.reviewers || []).length > 0, () => html`<span class="fs dim">also read by ${each(d.reviewers, (x) => html`<span>${x.principal} (${x.signed}) </span>`, (x) => x.principal)}</span>`)}
      </div>
      ${when(!!r && !!r.framing, () => html`<div class="op-blocked">
        ${r.framing.state === 'unwitnessed' ? 'you have not read the title and background' : 'the title or background changed after you read it'}
        ${each(r.framing.changed || [], (c) => html`<div class="op-moverow"><b>${c.field}</b> <span class="dim">was</span> ${c.was || '—'} <span class="dim">now</span> ${c.now || '—'}</div>`, (c) => c.field)}
      </div>`)}
      ${when(!!this.state.review, () => html`<div class="fs dim">pulled — ${((this.state.review.unwitnessed || []).length + (this.state.review.moved || []).length + (this.state.review.framing ? 1 : 0))} outstanding as of that read</div>`)}
      <div class="op-edit">
        <button class="pullbtn" disabled="${!!this.state.busy}"
          title="take the team's changes first — law is shared, so adopting on a stale fold binds everyone against a standard they have already moved past"
          on-click="${() => this.loop('review', 'review', { specId: d.spec.id })}">${this.state.busy === 'review' ? 'pulling…' : '↻ pull & show what moved'}</button>
        <button class="pullbtn" disabled="${!!this.state.busy}"
          on-click="${() => this.loop('framing', 'sign_off_framing', { specId: d.spec.id })}">sign off title &amp; background</button>
        <button class="pullbtn" disabled="${!!this.state.busy}"
          title="one approval per operation is written — the count is checked, so a bulk act reads as bulk"
          on-click="${() => this.loop('bulk', 'sign_off_section', { specId: d.spec.id, axis: 'spec', count: d.operations.length })}">sign off all ${d.operations.length} operation${d.operations.length === 1 ? '' : 's'}</button>
      </div>
    </div>`;
  }

  composer(targetId, placeholder) {
    return html`<div class="cmt-new">
      <input placeholder="${placeholder}" value="${this.state.draft[targetId] || ''}"
        on-change="${(e, v) => { this.state.draft = { ...this.state.draft, [targetId]: v }; }}">
      <button class="pullbtn" disabled="${!!this.state.busy}" on-click="${() => this.say(targetId)}">comment</button>
    </div>`;
  }

  /** The form minus its own scratch fields: `_reason` is the revision's, `_why` the removal's. */
  opForm() {
    const out = {};
    for (const k of Object.keys(this.state.form)) if (!k.startsWith('_')) out[k] = this.state.form[k];
    return out;
  }

  /** Review view for a draft, document view for a ratified spec, until the reader says otherwise. */
  isReading(d) { return this.state.reading === null ? d.spec.status !== 'draft' : this.state.reading; }

  /**
   * Reading view hides ACTS, never CONTENT.
   *
   * The sign-off row, the correction form and the composer are things to DO, and reading a
   * baseline end to end is not the moment to do them. A teammate's comment and a correction
   * that already happened stay in both views — putting either behind a toggle would hide an
   * objection from the person deciding, which is the failure this whole surface exists
   * against.
   *
   * The page-level ratify/withdraw bar stays in both too: it is the disposition of the
   * proposal rather than chrome on a rule, and it is what the reader came to do.
   */
  viewToggle(d) {
    const reading = this.isReading(d);
    return html`<div class="dtoggle">
      <button class="${reading ? '' : 'on'}" title="every operation with the machinery to sign it off"
        on-click="${() => { this.state.reading = false; }}">review</button>
      <button class="${reading ? 'on' : ''}" title="the standard this proposes, without the acts"
        on-click="${() => { this.state.reading = true; }}">read as a document</button>
    </div>`;
  }

  /**
   * What the operation SAYS — the half that differs by kind.
   *
   * `add_criterion` had no arm here at all, and that was not a gap in polish. `getSpec`
   * fills `after` only for the kinds that carry a statement, so a criterion rendered as a
   * kind badge and a rationale with its criterion, its falsifier, its evidence kind and the
   * rule it tests ALL invisible — the only way to read one was to open the correction form,
   * which does have the fields. Ten of the thirty-two cards on the first real baseline were
   * that empty card.
   *
   * `add_requirement` leads with the rule and not with `why:`. What a reader has to weigh
   * is the statement; the rationale is the argument for it and reads second.
   *
   * **Every field `operationContent` signs has to render here.** That function
   * (`schema.ts`) is what a sign-off hashes, so a field it includes and this omits is a
   * field the reader signs without seeing — and the gate this subsystem is built on is
   * that a ratifier signs what they READ. It had four: `requirementId` (the rule an amend
   * or a standing-rule criterion is about — rendered by `op` rather than here, since every
   * kind that carries one shows it the same way), the exact `assertedBy` anchors rather
   * than a count of them, `evidence`, and `reversibility` whenever it was not
   * `irreversible`. Two criteria differing only in their pinned anchors rendered
   * identically and signed differently.
   */
  /**
   * One line naming the operation, for the header row that opens the card.
   *
   * Per kind, because only `add_requirement` has a `title` — and a disclosure control with
   * nothing to disclose ABOUT is how you get a page of identical chevrons.
   */
  heading(o) {
    const op = o.operation;
    if (op.kind === 'add_requirement') return op.title;
    if (op.kind === 'add_criterion') {
      const rule = o.parentTitle || (o.before && o.before.title);
      return rule ? `criterion of ${rule}` : 'criterion';
    }
    if (op.kind === 'move_section') return `${op.fromSection} → ${op.toSection}`;
    const rule = o.before ? o.before.title : 'the rule';
    return op.kind === 'retire_requirement' ? `retire: ${rule}` : `amend: ${rule}`;
  }

  opBody(o) {
    const op = o.operation;
    if (op.kind === 'add_criterion') {
      return html`<div class="op-body">
        <div class="fs dim">holds when</div>
        <div class="fs prose">${op.criterion}</div>
        <div class="fs dim">falsified by</div>
        <div class="fs prose">${op.falsifier}</div>
        <div class="fs dim">checked by <b>${op.evidenceKind || 'unstated'}</b></div>
        ${when(!!o.before, () => html`<div class="fs dim">attaches to <b>${o.before.title}</b></div>`)}
        ${when((op.assertedBy || []).length > 0, () => html`<div class="fs dim mono">pins ${op.assertedBy.join(', ')}</div>`)}
      </div>`;
    }
    if (op.kind === 'add_requirement') {
      return html`<div class="op-body">
        <div class="op-after prose">${op.statement}</div>
        <div class="fs dim prose">${op.provenance}</div>
      </div>`;
    }
    return html`<div class="op-body">
      ${when(!!o.before, () => html`<div class="op-before"><span class="dim">now</span> ${o.before.statement}</div>`)}
      ${when(!!o.after, () => html`<div class="op-after"><span class="dim">becomes</span> ${o.after}</div>`)}
    </div>`;
  }

  op(o, u) {
    const k = o.operation.kind;
    const d = this.state.d;
    const reading = this.isReading(d);
    const draft = d.spec.status === 'draft';
    const editing = this.state.editing === o.operation.id;
    const open = this.state.selected === o.operation.id;
    const revs = o.operation.revisions || [];
    const cmts = o.comments || [];
    return html`<div class="op-card ${k === 'add_criterion' ? 'crit' : ''} ${o.contextMoved ? 'moved' : ''} ${open ? 'sel' : ''}"
      >
      <div class="ft">
        <span class="op-head" title="${open ? 'collapse' : 'open its history and comments'}"
          on-click="${() => this.pick(o.operation.id)}"><span class="chev">${open ? '▾' : '▸'}</span> ${this.heading(o)}</span>
        ${when(!reading, () => html`<span class="qbadge">${k.replace(/_/g, ' ')}</span>`)}
        ${when(o.operation.reversibility === 'irreversible', () => html`<span class="qbadge drift" title="satisfying this cannot be undone — declared before ratification because it changes the decision, and because it makes the rule harder to amend later">irreversible</span>`)}
        ${when(o.contextMoved, () => html`<span class="qbadge drift">cannot be adopted as drafted</span>`)}
        <span class="ftgap"></span>
        ${when(!open && revs.length > 0, () => html`<span class="qbadge mute" title="click the card to read what changed and why">corrected ${revs.length}×</span>`)}
        ${when(!reading && draft, () => this.signState(o))}
        ${when(!reading && draft, () => html`<button class="pullbtn" disabled="${!!this.state.busy}"
          title="record that you read THIS text. A later edit invalidates it and says which field moved."
          on-click="${() => this.loop('sign:' + o.operation.id, 'sign_off_operation', { operationId: o.operation.id })}">sign off</button>`)}
        ${when(!reading && draft && !editing, () => html`<button class="pullbtn" title="correct this operation"
          on-click="${() => this.edit(o.operation.id, {
            title: o.operation.title, section: o.operation.section, statement: o.operation.statement,
            provenance: o.operation.provenance, criterion: o.operation.criterion, falsifier: o.operation.falsifier,
            fromSection: o.operation.fromSection, toSection: o.operation.toSection, rationale: o.operation.rationale,
          })}">correct</button>`)}
      </div>
      ${this.opBody(o)}
      ${when(!!o.operation.requirementId, () => html`<div class="fs dim mono">rule ${o.operation.requirementId}</div>`)}
      <div class="fs dim prose"><b>why:</b> ${o.operation.rationale}</div>
      ${when(!!o.operation.evidence, () => html`<div class="fs dim prose">provoked by ${o.operation.evidence}</div>`)}
      ${when(o.operation.reversibility !== 'irreversible', () => html`<div class="fs dim">reversibility: ${o.operation.reversibility}</div>`)}
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
      ${when(!reading && draft, () => this.movedNote(o))}
      ${when(editing, () => html`<div class="op-move">
        ${each(this.opFields(k), (f) => this.field(f[0], f[1], f[2]), (f) => f[0])}
        ${this.field('rationale', 'why the rule exists — this survives adoption and is read years from now', 2)}
        ${this.field('_reason', 'why you are CORRECTING it — kept on the revision, never on the rule', 2)}
        <div class="op-edit">
          <button class="pullbtn" disabled="${!!this.state.busy}"
            on-click="${() => this.correct('rev:' + o.operation.id, 'revise_operation', { operationId: o.operation.id, ...this.opForm(), reason: this.state.form._reason })}">save</button>
          <button class="pullbtn" on-click="${() => this.edit(o.operation.id, {})}">cancel</button>
        </div>
        <input placeholder="reason, if removing this operation…" value="${this.state.form._why || ''}"
          on-input="${(e) => this.set('_why', e.target.value)}">
        <button class="pullbtn" disabled="${!this.state.form._why || !!this.state.busy}"
          title="pull it out of the proposal. It stops applying and stays readable as history, with your reason on it."
          on-click="${() => this.correct('rm:' + o.operation.id, 'remove_operation', { operationId: o.operation.id, reason: this.state.form._why })}">remove operation</button>
      </div>`)}
      ${thread(cmts)}
      ${when(open, () => html`<div class="op-detail">
        ${each(revs, (r) => html`<div class="fs dim prose">corrected ${(r.at || '').slice(0, 10)} by ${r.by.principal}${r.reason ? ' — ' + r.reason : ''}</div>`, (r) => r.at)}
        ${when(!reading, () => this.composer(o.operation.id, 'comment on this operation…'))}
      </div>`)}
    </div>`;
  }

  template() {
    const u = this.props.params.universe, d = this.state.d;
    return pageShell(d, taskError(this.load), () => {
      const groups = grouped(d.operations);
      return html`
      <div class="crumbs"><a class="back" href="${href(standardUrl(u))}">← standard</a> <span class="sep">·</span> ${d.spec.title}</div>
      ${servedNote(d)}
      <div class="fs dim">${d.spec.status} · proposed by ${d.spec.author && d.spec.author.principal ? d.spec.author.principal : 'unknown'}${d.spec.author && d.spec.author.via ? ' (via ' + (d.spec.author.via.model || 'agent') + ')' : ''}</div>
      ${when(!!d.spec.narrative, () => html`<div class="op-card"><div class="fs dim">background — NON-OPERATIVE, nothing here changes the standard</div><div class="fs prose">${d.spec.narrative}</div></div>`)}
      ${when((d.spec.revisions || []).length > 0, () => html`<div class="fs dim prose">corrected ${d.spec.revisions.length} time${d.spec.revisions.length === 1 ? '' : 's'} while a draft — last by ${d.spec.revisions[d.spec.revisions.length - 1].by.principal} on ${(d.spec.revisions[d.spec.revisions.length - 1].at || '').slice(0, 10)}${d.spec.revisions[d.spec.revisions.length - 1].reason ? ' — ' + d.spec.revisions[d.spec.revisions.length - 1].reason : ''}</div>`)}
      ${when(d.spec.status === 'draft' && this.state.editing !== 'spec', () => html`<div class="op-edit">
        <button class="pullbtn" title="fix the proposal's own words. A draft binds nothing, so correcting one is authoring it — and a correction left in a comment is read AFTER the wrong framing."
          on-click="${() => this.edit('spec', { title: d.spec.title, narrative: d.spec.narrative || '' })}">correct title / background</button>
      </div>`)}
      ${when(this.state.editing === 'spec', () => html`<div class="op-card">
        ${this.field('title', 'title')}
        ${this.field('narrative', 'background — NON-OPERATIVE', 4)}
        ${this.field('_reason', 'why you are CORRECTING it — kept on the revision, never in the text', 2)}
        <div class="op-edit">
          <button class="pullbtn" disabled="${!!this.state.busy}"
            on-click="${() => this.correct('revspec', 'revise_spec', { specId: d.spec.id, title: this.state.form.title, narrative: this.state.form.narrative, reason: this.state.form._reason })}">save</button>
          <button class="pullbtn" on-click="${() => this.edit('spec', {})}">cancel</button>
        </div>
      </div>`)}

      ${when(d.spec.status === 'draft' && !this.isReading(d), () => html`<div class="sec">your review</div>`)}
      ${when(d.spec.status === 'draft' && !this.isReading(d), () => this.reviewBar(d))}

      <div class="sec">what this proposes — ${d.operations.length} operation${d.operations.length === 1 ? '' : 's'} over ${groups.length} area${groups.length === 1 ? '' : 's'}</div>
      ${this.viewToggle(d)}
      ${each(groups, (g) => html`<div class="op-areagroup">
        <div class="op-area">${g.area} <span class="n">${g.n} rule${g.n === 1 ? '' : 's'}</span></div>
        ${each(g.topics, (t) => html`<div class="op-topicgroup">
          ${when(!!t.topic, () => html`<div class="op-topic">${t.topic}</div>`)}
          ${each(t.ops, (o) => html`<div class="op-group">
            ${this.op(o, u)}
            ${each(o.criteria, (c) => this.op(c, u), (c) => c.operation.id)}
          </div>`, (o) => o.operation.id)}
        </div>`, (t) => t.topic)}
      </div>`, (g) => g.area)}

      ${when((d.removed || []).length > 0, () => html`<div class="sec">pulled from this proposal (${d.removed.length})</div>`)}
      ${each(d.removed || [], (o) => html`<div class="op-card"><div class="ft"><span class="qbadge">${o.kind.replace(/_/g, ' ')}</span> <span class="dim">withdrawn from the proposal</span></div>
        <div class="fs">${o.statement || o.criterion || o.title || (o.fromSection ? o.fromSection + ' → ' + o.toSection : '')}</div>
        <div class="fs dim">${o.removed.by.principal} · ${(o.removed.at || '').slice(0, 10)} · ${o.removed.reason}</div>
      </div>`, (o) => o.id)}

      <div class="sec">on this proposal</div>
      ${when(!!d.commentsUnavailable, () => html`<div class="fs dim">comments could not be read: ${d.commentsUnavailable}. An empty thread here is not agreement.</div>`)}
      ${thread(d.comments)}
      ${this.composer(d.spec.id, 'comment on the proposal as a whole…')}

      ${when(!!this.state.err, () => html`<div class="attn-banner"><span class="attn-n">✕</span> <span>${this.state.err}</span></div>`)}
      ${when(d.spec.status === 'draft', () => html`<div class="op-actions">
        <button class="pullbtn" disabled="${!d.adoptable || !d.signedOff || !!this.state.busy}"
          title="${!d.adoptable ? 'at least one operation was written against a standard that has since moved' : !d.signedOff ? 'adoption is all-or-nothing, so your signature covers every operation — sign off what you have read first' : 'apply every operation, all or nothing'}"
          on-click="${() => this.act('ratify')}">${this.state.busy === 'ratify' ? 'adopting…' : '✓ ratify'}</button>
        <input placeholder="reason, if withdrawing…"
          on-input="${(e) => { this.state.reason = e.target.value; }}">
        <button class="pullbtn" disabled="${!this.state.reason || !!this.state.busy}"
          title="take the proposal back. A draft may always be withdrawn — it also releases any gap attached to it."
          on-click="${() => this.act('withdraw')}">${this.state.busy === 'withdraw' ? 'withdrawing…' : '✕ withdraw'}</button>
      </div>`)}
    `;
    });
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
        <input placeholder="commit sha…" title="what does codemap already know about the code in front of me?"
          value="${this.state.commit}" on-change="${(e, v) => { this.state.commit = v.trim(); }}">
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
