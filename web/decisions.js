import { repairPresentation } from './repair-presentation.js';
/**
 * Decision rounds — the questions put to a person, what they ruled, and what is still owed.
 *
 * Its own module for the reason `standard.js` is. It imports only `./core.js` — see
 * `src/import-cycles.test.ts`.
 *
 * The three sections are the three things the owner asked to be able to see (2026-09-23):
 * what waits on me, what I ruled that nobody has carried out, and my words read two ways.
 * Answering here is a person's act, behind the same notice as the standard's five
 * (`PRINCIPAL_NOTICE` in `src/serve.ts`) — the only door besides a verified relay.
 *
 * @typedef {import('./core.js').ApiMap} ApiMap
 */

import { Component, defineComponent, html, when, each } from './vendor/vdx/framework.js';
import { api, attestedPost, pageShell, nav, href, errText, taskError } from './core.js';
import { mountQuestionnaire, loadQuestionnaireDraft } from './questionnaire.js';

/** What an empty list says when the log could not be read: not "nothing" (P3.1 (4)). */
const UNKNOWN = 'unknown — the log can\'t be read';
/** @param {unknown} value */
const comparisonOptionText = (value) => {
  const option = /** @type {Record<string, any>} */ (value || {});
  const shown = option.displayed || option;
  return `${shown.label || option.label || '(unlabelled)'}: ${shown.description || ''}${option.effects?.length ? ' · effect ' + JSON.stringify(option.effects) : ''}`;
};
/** @param {unknown} value */
const comparisonItemText = (value) => {
  const item = /** @type {Record<string, any>} */ (value || {});
  return `${item.id || '(unidentified)'}: ${item.text || JSON.stringify(item)}`;
};

export const decisionsUrl = (u, round) => `/u/${u}/decisions/${round ? round + '/' : ''}`;
export const comparisonUrl = (u, id) => href(decisionsUrl(u), { comparison: id });

/**
 * @typedef {{ params: { universe: string, round?: string }, query: Record<string, string> }} DecProps
 * @typedef {{ d: ApiMap['/api/decisions']|null, r: ApiMap['/api/decisions/round']|null, qlist: ApiMap['/api/decisions/questionnaires']|null, qdetail: ApiMap['/api/decisions/questionnaire']|null, comparison: ApiMap['/api/decisions/comparison']|null, resolutionBrief: ApiMap['/api/decisions/comparison/resolution']|null, busy: string|null, err: string|null, rationale: string, preserve: string, revises: string,
 *   words: Record<string,string>, reasons: Record<string,string>, checked: Record<string,string[]>, revisionFindings: Record<string,string[]>, revisionIssues: Record<string,string[]>,
 *   revisionPresentations: Record<string,{presentation:string,contextHash:string,displayed:any,scopeKey:string}>,
 *   revisionMarked: Record<string,string[]>, revisionCorrections: Record<string,Record<string,string>>,
 *   withdrawalApprovals: Record<string,string> }} DecState
 * @extends {Component<DecProps, DecState>}
 */
class DecisionsPage extends Component {
  static props = { params: {}, query: {} };
  /** @param {DecProps} props */
  constructor(props) {
    super(props);
    /** @type {DecState} */
    this.state = { d: null, r: null, qlist: null, qdetail: null, comparison: null, resolutionBrief: null, busy: null, err: null, rationale: '', preserve: '', revises: '', words: {}, reasons: {}, checked: {}, revisionFindings: {}, revisionIssues: {}, revisionPresentations: {}, revisionMarked: {}, revisionCorrections: {}, withdrawalApprovals: {} };
    /** @type {null|(() => void)} */
    this.qUnmount = null;
  }
  load = this.createTask(async () => {
    const u = this.props.params.universe, round = this.props.params.round, comparisonId = this.props.query.comparison;
    nav.current = u;
    this.qUnmount?.(); this.qUnmount = null;
    const [d, r, qlist, comparison, resolutionBrief] = await Promise.all([
      api('/api/decisions', { u }),
      round ? api('/api/decisions/round', { u, id: round }) : Promise.resolve(null),
      api('/api/decisions/questionnaires', { u }),
      comparisonId ? api('/api/decisions/comparison', { u, id: comparisonId }) : Promise.resolve(null),
      comparisonId ? api('/api/decisions/comparison/resolution', { u, id: comparisonId }) : Promise.resolve(null),
    ]);
    const qdetail = round && r && 'round' in r && r.round.questionnaire
      ? await api('/api/decisions/questionnaire', { u, id: round }) : null;
    this.state.d = d; this.state.r = r; this.state.qlist = qlist; this.state.qdetail = qdetail;
    this.state.comparison = comparison; this.state.resolutionBrief = resolutionBrief;
    if (qdetail && 'questionnaire' in qdetail && qdetail.currentPrincipal && qdetail.status.status !== 'blocked') {
      await this.nextRender();
      const host = this.querySelector('[data-questionnaire-host]');
      if (host instanceof HTMLElement) this.qUnmount = mountQuestionnaire(host, {
        questionnaire: qdetail.questionnaire, publicationId: qdetail.id, version: qdetail.version, principal: qdetail.currentPrincipal,
        onSubmit: async (submission) => {
          const out = await attestedPost('/api/decisions/questionnaire/submit', { u, round: qdetail.round, submission });
          if (!out || out.error || out.ok !== true) return { error: out?.error ?? 'Submission was not confirmed.' };
          setTimeout(() => this.load.run(), 0);
          return { ok: true, receipt: out.submission };
        },
      });
    }
  });
  mounted() { this.load.run(); }
  unmounted() { this.qUnmount?.(); this.qUnmount = null; }
  propsChanged() { this.qUnmount?.(); this.qUnmount = null; this.state.d = null; this.state.r = null; this.state.qdetail = null; this.state.comparison = null; this.state.resolutionBrief = null; this.load.run(); }

  localDraftCount(q, principal) {
    if (!principal) return 0;
    try { return Object.keys(loadQuestionnaireDraft(localStorage, principal, q.id, q.version).answers).length; }
    catch { return 0; }
  }

  questionnaireReadOnly(q) {
    return html`<div class="op-card"><h2>${q.title}</h2>${when(!!q.context, () => html`<p>${q.context}</p>`)}
      ${when(!!q.recipient, () => html`<p class="dim">Routed to ${q.recipient}. Any team member may answer under their own identity.</p>`)}
      ${each(q.sections, (section) => html`<section><h3>${section.title}</h3>
        ${when(!!section.context, () => html`<p>${section.context}</p>`)}
        ${each(section.questions, (question) => html`<div class="op-card"><h4>${question.id} — ${question.prompt}</h4>
          ${when(!!question.context, () => html`<p class="dim">${question.context}</p>`)}
          ${when(!!question.action, () => html`<p class="dim">Action meaning: ${question.action}</p>`)}
          ${when(question.kind === 'choice', () => html`
            ${each(question.kind === 'choice' ? question.options : [], (option) => html`<div class="fs">${option.label}${option.description ? ' — ' + option.description : ''}${option.action ? '; action: ' + option.action : ''}</div>`, (option) => option.id)}
            ${when(question.kind === 'choice' && question.allowOther, () => html`<div class="fs">Other — write your answer</div>`)}`)}
          ${when(question.kind === 'short', () => html`<div class="fs dim">Write a short answer.</div>`)}
          ${when(question.kind === 'list', () => html`<div class="fs dim">Submitting this list approves every unmarked item. Marked items each need a correction.</div>
            ${each(question.kind === 'list' ? question.items : [], (item) => html`<div class="fs">Mark wrong: ${item.text}
              ${when(!!item.context, () => html`<div class="dim">${item.context}</div>`)}
              ${when(!!item.action, () => html`<div class="dim">Action meaning: ${item.action}</div>`)}</div>`, (item) => item.id)}`)}
        </div>`, (question) => question.id)}
      </section>`, (section) => section.id)}</div>`;
  }

  questionnaireProgress(detail) {
    const principal = detail.currentPrincipal;
    const drafts = this.localDraftCount({ id: detail.id, version: detail.version }, principal);
    return html`<div class="sec">questionnaire progress</div>
      ${each(detail.progress, (person) => html`<div class="fs"><b>${person.principal}</b>: ${person.counts.submitted} submitted,
        ${person.principal === principal ? drafts + ' local draft(s), ' : ''}${person.counts.unanswered} unanswered,
        ${person.counts.withdrawn} withdrawn</div>`, (person) => person.principal)}
      ${when(!!detail.comparisons.length, () => html`<div class="attn-banner">${detail.comparisons.length} comparison(s) still require review; submission completion does not settle them.</div>`)}
      ${when(!!detail.comparisonRecords.length, () => html`<div class="sec">linked answer comparisons</div>
        ${each(detail.comparisonRecords, (c) => html`<div class="fs"><a href="${comparisonUrl(this.props.params.universe, c.id)}">${c.answers.join(' / ')}</a>
          — ${c.state}${c.restrictsWork ? ' · dependent work paused' : ''}</div>`, (c) => c.id)}`)}
      <div class="sec">submitted answer receipts</div>
      ${each(detail.questions, (question) => html`<div class="fs"><b>${question.questionId}</b>:
        ${question.answers.length ? html`${each(question.answers, (answer) => html`<span>${answer.principal} submitted ${answer.id}
          ${answer.source?.submission ? ' (receipt ' + answer.source.submission + ')' : ''}; </span>`, (answer) => answer.id)}` : 'no submitted answer'}
      </div>`, (question) => question.questionId)}`;
  }

  async resolveComparison() {
    const detail = this.state.comparison, brief = this.state.resolutionBrief;
    if (!detail || !('comparison' in detail) || !brief || !('shownHash' in brief) || this.state.busy) return;
    const preserve = this.state.preserve, rationale = this.state.rationale.trim();
    if (!preserve || !rationale) return;
    const prior = detail.comparison.projection.acceptedResolutions.find((x) => x.id === this.state.revises);
    this.state.busy = detail.comparison.request.id; this.state.err = null;
    try {
      const r = await attestedPost('/api/decisions/comparison/resolve', {
        u: this.props.params.universe, request: detail.comparison.request.id, preserve, rationale,
        shownHash: brief.shownHash, executionsHash: brief.executionsHash,
        ...(prior ? { revises: prior.id, shownResolution: {
          id: prior.id, preserve: prior.preserve, receipt: prior.human.receipt } } : {}),
      });
      if (!r || r.error || r.ok !== true) { this.state.err = r?.error || 'Resolution was not recorded.'; return; }
      this.state.rationale = ''; this.state.preserve = ''; this.state.revises = '';
      this.load.run();
    } catch (e) { this.state.err = errText(e); } finally { this.state.busy = null; }
  }

  comparisonView(detail, brief, principal) {
    if (!detail || !('comparison' in detail)) return html`<div class="attn-banner">${detail?.error || 'Comparison unavailable.'}</div>`;
    const c = detail.comparison, request = c.request, projection = c.projection;
    const state = projection.state;
    const labels = { pending: 'awaiting independent comparison', equivalent: 'equivalent intent',
      incompatible: 'incompatible intent', unclear: 'comparison unclear', disputed: 'judgments or resolutions disputed',
      resolved: 'resolved by human choice' };
    const canAct = detail.status !== 'blocked' && !!principal && !!brief && 'shownHash' in brief
      && ['incompatible', 'disputed', 'resolved'].includes(state);
    const source = (x, chronology) => html`<div class="op-card"><div class="ft"><b>${x.principal}</b> — answer ${x.answerId}</div>
      <div class="fs">Question ${x.questionId} · version ${x.questionVersion}</div>
      <div class="fs">${x.display.prompt}</div>
      ${when(!!x.display.context, () => html`<div class="fs">Context: ${x.display.context}</div>`)}
      <div class="fs">Answer format: ${x.display.answerFormat}</div>
      ${when(!!x.display.action, () => html`<div class="fs">Action described: ${x.display.action}</div>`)}
      ${when(!!x.display.options?.length, () => html`<div class="fs">Options and descriptions:
        ${each(x.display.options || [], (option, i) => html`<div class="fs dim">${comparisonOptionText(option)}</div>`, (option, i) => String(i))}</div>`)}
      ${when(!!x.display.items?.length, () => html`<div class="fs">List items and context:
        ${each(x.display.items || [], (item, i) => html`<div class="fs dim">${comparisonItemText(item)}</div>`, (item, i) => String(i))}</div>`)}
      <div class="fs">Exact answer: <b>${x.words}</b></div>
      <div class="fs dim">Answer version ${x.version}; given ${chronology?.givenAt || 'unknown'}, recorded ${chronology?.recordedAt || 'unknown'}</div>
    </div>`;
    const frontier = projection.acceptedResolutions.filter((x) =>
      !projection.acceptedResolutions.some((later) => later.revises === x.id));
    const mine = frontier.filter((x) => x.human.principal === principal);
    return html`<div class="crumbs"><b>${this.props.params.universe}</b> <span class="sep">·</span>
        <a href="${href(decisionsUrl(this.props.params.universe))}">decisions</a> <span class="sep">·</span> comparison ${request.id}</div>
      ${when(detail.status === 'blocked', () => html`<div class="attn-banner">The decisions log is blocked; authority may be incomplete and resolution is unavailable.</div>`)}
      <div class="sec">${labels[state] || state}</div>
      <div class="fs">${projection.restrictsWork ? 'Dependent work is paused.' : 'This comparison does not restrict dependent work.'}
        ${projection.preservedAnswer ? ' Preserved answer: ' + projection.preservedAnswer : ''}</div>
      <div class="fs dim">Comparison ${request.id}; context ${request.contextHash}</div>
      <div class="sec">affected scope</div>
      ${each(request.issues, (issue) => html`<div class="fs">${issue.kind} ${issue.id} · ${issue.universe} / ${issue.scope}</div>`, (issue) => issue.kind + issue.scope + issue.id)}
      <div class="sec">exact alternatives</div>
      ${source(request.left, detail.sourceChronology.find((x) => x.answer === request.left.answerId))}
      ${source(request.right, detail.sourceChronology.find((x) => x.answer === request.right.answerId))}
      <div class="sec">independent reader judgments</div>
      ${when(!c.judgments.length, () => html`<div class="empty">No reader judgment has been recorded.</div>`)}
      ${each(c.judgments, (j) => html`<div class="op-card"><b>${j.verdict}</b> — ${j.rationale}
        <div class="fs dim">${j.reader.principal} · agent ${j.reader.agent} · session ${j.reader.session} · request ${j.reader.request} · receipt ${j.reader.receipt}</div>
        <div class="fs dim">${projection.history.find((h) => h.id === j.id)?.state || 'unknown'}${projection.history.find((h) => h.id === j.id)?.reason ? ': ' + projection.history.find((h) => h.id === j.id).reason : ''}</div></div>`, (j) => j.id)}
      <div class="sec">executed closures involving these rulings</div>
      ${when(!detail.executions.length, () => html`<div class="empty">None recorded.</div>`)}
      ${each(detail.executions, (run) => html`<div class="op-card"><b>${run.status}</b> · ${run.capsule?.issue.ref.kind || 'issue'} ${run.capsule?.issue.ref.id || 'unknown'}
        <div class="fs">Ruling answer ${run.capsule?.ruling.answerId || 'unknown'}; application ${run.eventId}</div>
        <div class="fs">${run.capsule?.reason || run.reason || ''}</div>
        ${each(run.capsule?.evidence.readers || [], (reader) => html`<div class="fs dim">Reader ${reader.by.principal} · verdict ${reader.verdict} · request ${reader.request} · receipt ${reader.id}: ${reader.rationale}</div>`, (reader) => reader.id)}
        ${when(!!run.capsule?.evidence.arbitrator, () => html`<div class="fs dim">Arbitrator receipt ${run.capsule.evidence.arbitrator.id}: ${run.capsule.evidence.arbitrator.rationale}</div>`)}
      </div>`, (run) => run.eventId)}
      <div class="sec">human resolution history</div>
      ${when(!c.resolutions.length, () => html`<div class="empty">No human resolution has been recorded.</div>`)}
      ${each(c.resolutions, (r) => html`<div class="fs">${r.human.principal} preserved ${r.preserve} · ${r.rationale}
        ${r.revises ? ' · corrects ' + r.revises : ''} · receipt ${r.human.receipt}
        · ${projection.history.find((h) => h.id === r.id)?.state || 'unknown'}
        ${projection.history.find((h) => h.id === r.id)?.reason || ''}</div>`, (r) => r.id)}
      ${when(!principal, () => html`<div class="attn-banner">No local principal identity is configured. Set a Git identity before resolving this comparison.</div>`)}
      ${when(!!brief && 'error' in brief, () => html`<div class="attn-banner">${brief.error}</div>`)}
      ${when(canAct, () => html`<div class="op-card"><h2>${state === 'resolved' && mine.length ? 'Correct a prior resolution' : 'Resolve this disagreement'}</h2>
        <div class="fs">Choose which exact ruling to preserve after reviewing both alternatives, reader judgments and executed closures above.</div>
        <div class="fs dim">Exact context bound to this choice (receipt ${brief.shownHash}):</div>
        <pre class="fs">${JSON.stringify(brief.shown, null, 2)}</pre>
        ${when(state === 'resolved' && !mine.length, () => html`<div class="fs dim">A different choice from another principal will remain a visible dispute.</div>`)}
        ${each([request.left, request.right], (x) => html`<label class="fs"><input type="radio" name="comparison-preserve" value="${x.answerId}"
          checked="${this.state.preserve === x.answerId}" on-change="${() => { this.state.preserve = x.answerId; }}"> Preserve ${x.answerId} (${x.principal}: ${x.words})</label>`, (x) => x.answerId)}
        ${when(!!mine.length, () => html`<label class="fs">Correct one of your prior resolutions:
          <select on-change="${(e) => { this.state.revises = e.target.value; }}">
            <option value="">new independent resolution</option>
            ${each(mine, (r) => html`<option value="${r.id}" selected="${this.state.revises === r.id}">${r.id}: preserve ${r.preserve}</option>`, (r) => r.id)}
          </select></label>`)}
        <label class="fs">Reason for this choice<textarea rows="4" value="${this.state.rationale}"
          on-input="${(e) => { this.state.rationale = e.target.value; }}"></textarea></label>
        <button class="pullbtn" disabled="${!!this.state.busy || !this.state.preserve || !this.state.rationale.trim() || (state === 'resolved' && !!mine.length && !this.state.revises)}"
          on-click="${() => this.resolveComparison()}">${this.state.revises ? 'record corrected resolution' : 'record explicit resolution'}</button>
      </div>`)}
      ${when(!canAct && detail.status !== 'blocked' && !!principal && state !== 'equivalent', () => html`<div class="empty">A recorded independent judgment must establish the disagreement before a human resolution can be submitted.</div>`)}`;
  }

  /** Every answer goes through here. A refusal is shown verbatim: it names what is wrong. */
  async answer(decision, body) {
    if (this.state.busy) return;
    this.state.busy = decision; this.state.err = null;
    try {
      const r = await attestedPost('/api/decisions/answer', { u: this.props.params.universe, decision, ...body });
      if (r && r.error) { this.state.err = r.error; return; }
      if (r && r.recorded === false) { this.state.err = r.why; return; }
      this.load.run();
    } catch (e) { this.state.err = errText(e); } finally { this.state.busy = null; }
  }

  async withdraw(decision, answer) {
    if (this.state.busy) return;
    this.state.busy = decision; this.state.err = null;
    try {
      const r = await attestedPost('/api/decisions/withdraw', {
        u: this.props.params.universe, decision, ...(answer ? { answer } : {}), reason: this.state.reasons[decision] || '',
      });
      if (r && r.error) { this.state.err = r.error; return; }
      this.load.run();
    } catch (e) { this.state.err = errText(e); } finally { this.state.busy = null; }
  }

  async approveWithdrawal(decision, answer) {
    if (this.state.busy) return;
    this.state.busy = decision; this.state.err = null;
    try {
      const r = await attestedPost('/api/decisions/withdraw/approve', {
        u: this.props.params.universe, decision, ...(answer ? { answer } : {}), reason: this.state.reasons[decision] || '',
      });
      if (r?.error) { this.state.err = r.error; return; }
      this.state.withdrawalApprovals = { ...this.state.withdrawalApprovals, [decision]: r.approval };
    } catch (e) { this.state.err = errText(e); } finally { this.state.busy = null; }
  }

  revisionScope(d) {
    const findings = d.kind === 'words' ? [d.id] : this.state.revisionFindings[d.id] || [];
    const issues = (d.currentByIssue || []).filter((entry) => (this.state.revisionIssues[d.id] || [])
      .includes(JSON.stringify(entry.issue))).map((entry) => entry.issue);
    const revises = d.kind === 'words' ? (d.standing ? [d.standing.id] : [])
      : [...new Set([...findings.map((f) => d.currentByFinding?.[f]),
        ...(d.currentByIssue || []).filter((entry) => issues.includes(entry.issue)).map((entry) => entry.answer)].filter(Boolean))];
    return { findings, issues, revises, scopeKey: JSON.stringify({ findings, issues, revises }) };
  }

  revisionListItems(d, scope) {
    const question = d.presentation?.question;
    if (question?.kind !== 'list') return [];
    const issueKey = (issue) => JSON.stringify([issue.kind, issue.universe, issue.scope, issue.id]);
    const issues = new Set(scope.issues.map(issueKey));
    return question.items.filter((item) => d.options.find((option) => option.label === item.text)?.effects.some((effect) =>
      effect.findings.some((finding) => scope.findings.includes(finding))
      || (effect.issues || []).some((issue) => issues.has(issueKey(issue)))));
  }

  async presentRevision(d) {
    if (this.state.busy) return;
    const scope = this.revisionScope(d);
    if ((!scope.findings.length && !scope.issues.length) || !scope.revises.length) return;
    this.state.busy = d.id; this.state.err = null;
    try {
      const r = await attestedPost('/api/decisions/revise/present', {
        u: this.props.params.universe, decision: d.id, revises: scope.revises,
        findings: scope.findings, issues: scope.issues,
      });
      if (r?.error) { this.state.err = r.error; return; }
      this.state.revisionPresentations = { ...this.state.revisionPresentations,
        [d.id]: { presentation: r.presentation, contextHash: r.contextHash, displayed: r.displayed, scopeKey: scope.scopeKey } };
    } catch (e) { this.state.err = errText(e); } finally { this.state.busy = null; }
  }

  async revise(d, option) {
    if (this.state.busy) return;
    const scope = this.revisionScope(d), shown = this.state.revisionPresentations[d.id];
    if (!shown || shown.scopeKey !== scope.scopeKey) return;
    const items = this.revisionListItems(d, scope);
    const isList = d.presentation?.question.kind === 'list';
    const marked = (this.state.revisionMarked[d.id] || []).filter((id) => items.some((item) => item.id === id));
    const corrections = this.state.revisionCorrections[d.id] || {};
    if (isList && (!items.length || marked.some((id) => !corrections[id]?.trim()))) {
      this.state.err = 'Every marked list item needs its own correction.'; return;
    }
    this.state.busy = d.id; this.state.err = null;
    try {
      const r = await attestedPost('/api/decisions/revise', {
        u: this.props.params.universe, decision: d.id, revises: scope.revises,
        findings: scope.findings, issues: scope.issues,
        seen: { presentation: shown.presentation, contextHash: shown.contextHash },
        ...(isList ? { list: { items: items.map((item) => item.id), approveUnmarked: true,
          marked: items.filter((item) => marked.includes(item.id)).map((item) => ({ itemId: item.id, correction: corrections[item.id] })) } }
          : option ? { option } : { words: this.state.words[d.id] || '' }),
      });
      if (r?.error) { this.state.err = r.error; return; }
      this.state.revisionPresentations = { ...this.state.revisionPresentations, [d.id]: undefined };
      this.load.run();
    } catch (e) { this.state.err = errText(e); } finally { this.state.busy = null; }
  }

  toggleRevision(decision, finding) {
    const now = this.state.revisionFindings[decision] || [];
    this.state.revisionFindings = { ...this.state.revisionFindings,
      [decision]: now.includes(finding) ? now.filter((x) => x !== finding) : [...now, finding] };
    this.state.revisionPresentations = { ...this.state.revisionPresentations, [decision]: undefined };
  }

  toggleRevisionIssue(decision, issue) {
    const key = JSON.stringify(issue), now = this.state.revisionIssues[decision] || [];
    this.state.revisionIssues = { ...this.state.revisionIssues,
      [decision]: now.includes(key) ? now.filter((x) => x !== key) : [...now, key] };
    this.state.revisionPresentations = { ...this.state.revisionPresentations, [decision]: undefined };
  }

  toggle(decision, label) {
    const now = this.state.checked[decision] || [];
    this.state.checked = { ...this.state.checked, [decision]: now.includes(label) ? now.filter((x) => x !== label) : [...now, label] };
  }

  /** One decision: its question as asked, its standing answer, and — if it wants one — the controls. */
  decision(d, blocked, questionnaire = false) {
    // Blocked, answering is refused anyway (P3.1 (4)): no controls that cannot work.
    const s = d.standing, busy = this.state.busy === d.id;
    const retired = d.answers.some((answer) => !!answer.withdrawn);
    const inactive = blocked || !!d.cancellation || !!d.withdrawn || retired || !!d.confirms?.invalid || !!d.resolutionInvalid;
    const replaced = inactive;
    const checked = this.state.checked[d.id] || [];
    const revisionScope = this.revisionScope(d), presentation = this.state.revisionPresentations[d.id];
    const reviewed = !!presentation && presentation.scopeKey === revisionScope.scopeKey;
    return html`<div class="op-card ${replaced ? 'moved' : ''}">
      <div class="ft"><b>${d.ref}</b> <span class="qbadge">${d.kind}</span>
        ${when(!!d.confirm, () => html`<span class="qbadge ${d.confirm.state === 'open' ? '' : 'drift'}">confirm of your words on ${d.confirm.of ?? '(gone)'}: ${d.confirm.state}</span>`)}
        ${when(!!d.withdrawn || retired, () => html`<span class="qbadge drift">withdrawn</span>`)}
        ${when(!!s, () => html`<span class="qbadge ${s.verified ? '' : 'drift'}">${s.verified ? 'answered' : 'answered, unverified'}</span>`)}
      </div>
      <div class="fs">${d.payload.question}</div>
      ${each(d.options, (o) => html`<div class="fs dim">• <b>${o.label}</b>${d.confirms?.invalid ? ' — inactive' : o.effects.length ? ' — ' + o.effects.map((e) => `${e.on === 'settle' ? 'close as ' + e.as : 'fix'}: ${[...e.findings, ...(e.issues || []).map((issue) => issue.id)].join(', ')}`).join('; ') : ''}</div>`, (o) => o.label)}
      ${when(!!d.cancellation, () => html`<div class="fs dim">Cancelled: ${d.cancellation.reason}</div>`)}
      ${when(!!d.withdrawn, () => html`<div class="fs dim">Withdrawn: ${d.withdrawn.reason} (${d.withdrawn.id})</div>`)}
      ${when(retired, () => html`<div class="fs dim">Ruling withdrawn. Ask a fresh question for any new instruction.</div>`)}
      ${each((d.withdrawals || []).filter((w) => w.state === 'conflict'), (w) => html`<div class="fs dim">Withdrawal pending conflict (${w.id}): ${w.reason}. Answer(s) ${(w.conflictingAnswers || []).join(', ') || 'another withdrawal'} need resolution before work continues.</div>`, (w) => w.id)}
      ${each(d.answers.filter((a) => a.cancelled), (a) => html`<div class="fs dim">Previous answer: “${a.words}” — ${a.cancelled.reason}${a.reading ? '; reading ' + a.reading.id + ' retained as history' : ''}</div>`, (a) => a.id)}
      ${when(!!d.resolutionInvalid, () => html`<div class="fs dim">This resolution is invalid: ${d.resolutionInvalid}. Ask a valid question showing both exact answers.</div>`)}
      ${when(!!d.confirms?.invalid, () => html`<div class="fs dim">Invalid confirmation: ${d.confirms.invalid}. Its options cannot act on findings; ask a valid question.</div>`)}
      ${when(!!s, () => html`<div class="fs">you said: <b>${s.words}</b>${s.options.length ? ' → ' + s.options.join(', ') : ''}${s.park ? ' → parked until ' + s.park : ''}</div>`)}
      ${when(!!(s && s.flags), () => html`<div class="fs dim">${(s.flags || []).join('; ')}</div>`)}
      ${when(!!(d.possiblySuperseded && d.possiblySuperseded.length), () => html`<div class="fs"><span class="qbadge drift">possibly superseded</span>
        your later words may change this — until they are read or you confirm, the ruling above stands:
        ${each(d.possiblySuperseded || [], (p) => html`<div class="fs dim">“${p.words}” (${p.state})</div>`, (p) => p.answer)}</div>`)}
      ${when(!blocked && !d.withdrawn && !retired && !d.confirms, () => html`<div class="op-actions">
        <input placeholder="reason for withdrawal" value="${this.state.reasons[d.id] || ''}"
          on-change="${(e, v) => { this.state.reasons = { ...this.state.reasons, [d.id]: v }; this.state.withdrawalApprovals = { ...this.state.withdrawalApprovals, [d.id]: undefined }; }}">
        <button class="pullbtn" disabled="${busy || !(this.state.reasons[d.id] || '').trim()}"
          on-click="${() => this.withdraw(d.id, s?.id)}">${s ? 'withdraw this ruling' : 'withdraw unanswered question'}</button>
        <button class="pullbtn" disabled="${busy || !(this.state.reasons[d.id] || '').trim()}"
          on-click="${() => this.approveWithdrawal(d.id, s?.id)}">approve exact withdrawal for an agent</button>
        ${when(!!this.state.withdrawalApprovals[d.id], () => html`<div class="fs dim">Approved withdrawal receipt: <code>${this.state.withdrawalApprovals[d.id]}</code>. Give this ID and the same reason to the agent.</div>`)}
      </div>`)}
      ${when(!inactive && (d.kind === 'options' || d.kind === 'bulk') && (Object.values(d.currentByFinding || {}).some(Boolean) || (d.currentByIssue || []).some((entry) => !!entry.answer)), () => html`<div class="op-actions">
        <div class="fs dim">Select the exact findings or bugs to revise. Earlier answers stay in history.</div>
        ${when(d.kind === 'bulk' && d.presentation?.question.kind !== 'list', () => html`<div class="fs dim">Select a ruling for the chosen scope.</div>`)}
        ${each(Object.keys(d.currentByFinding || {}), (f) => html`<label><input type="checkbox"
          checked="${(this.state.revisionFindings[d.id] || []).includes(f)}"
          on-change="${() => this.toggleRevision(d.id, f)}"> finding ${f} (current: ${d.currentByFinding[f] || 'unanswered'})</label>`, (f) => f)}
        ${each(d.currentByIssue || [], (entry) => html`<label><input type="checkbox"
          checked="${(this.state.revisionIssues[d.id] || []).includes(JSON.stringify(entry.issue))}"
          on-change="${() => this.toggleRevisionIssue(d.id, entry.issue)}"> ${entry.issue.kind} ${entry.issue.id} (current: ${entry.answer || 'unanswered'})</label>`, (entry) => JSON.stringify(entry.issue))}
        <button class="pullbtn" disabled="${busy || (!revisionScope.findings.length && !revisionScope.issues.length) || !revisionScope.revises.length}"
          on-click="${() => this.presentRevision(d)}">review exact revision context</button>
        ${when(reviewed, () => html`<div class="fs dim">Revision context shown for ${revisionScope.revises.join(', ')}. Receipt ${presentation.presentation}. Review the question and sources before choosing a new answer.</div>
          <pre class="fs">${JSON.stringify(presentation.displayed, null, 2)}</pre>`)}
        ${when(d.presentation?.question.kind === 'list' && reviewed, () => html`
          <div class="fs dim">Review every item in this scope. Unmarked items are approved; each marked item needs a correction.</div>
          ${each(this.revisionListItems(d, revisionScope), (item) => html`<div class="op-card">
            <label><input type="checkbox" checked="${(this.state.revisionMarked[d.id] || []).includes(item.id)}"
              on-change="${() => { const current = this.state.revisionMarked[d.id] || [];
                this.state.revisionMarked = { ...this.state.revisionMarked, [d.id]: current.includes(item.id)
                  ? current.filter((id) => id !== item.id) : [...current, item.id] }; }}"> Mark wrong: ${item.text}</label>
            ${when(!!item.context, () => html`<div class="fs dim">${item.context}</div>`)}
            ${when(!!item.action, () => html`<div class="fs dim">Action meaning: ${item.action}</div>`)}
            <textarea placeholder="Correction for ${item.text}" disabled="${!(this.state.revisionMarked[d.id] || []).includes(item.id)}"
              on-input="${(e, value) => { this.state.revisionCorrections = { ...this.state.revisionCorrections,
                [d.id]: { ...(this.state.revisionCorrections[d.id] || {}), [item.id]: value } }; }}">${this.state.revisionCorrections[d.id]?.[item.id] || ''}</textarea>
          </div>`, (item) => item.id)}
          <button class="pullbtn" disabled="${busy || !(this.revisionListItems(d, revisionScope).length)
            || (this.state.revisionMarked[d.id] || []).filter((id) => this.revisionListItems(d, revisionScope).some((item) => item.id === id))
              .some((id) => !(this.state.revisionCorrections[d.id]?.[id] || '').trim())}"
            on-click="${() => this.revise(d)}">revise reviewed list</button>`)}
        ${when(d.presentation?.question.kind !== 'list', () => html`${each(d.options, (o) => html`<button class="pullbtn" disabled="${busy || !reviewed}"
          on-click="${() => this.revise(d, o.label)}">revise selected to ${o.label}</button>`, (o) => o.label)}`)}
      </div>`)}
      ${when(!inactive && d.kind === 'words' && !!s, () => html`<div class="op-actions">
        <input placeholder="revised answer" value="${this.state.words[d.id] || ''}"
          on-change="${(e, v) => { this.state.words = { ...this.state.words, [d.id]: v }; }}">
        <button class="pullbtn" disabled="${busy}" on-click="${() => this.presentRevision(d)}">review exact revision context</button>
        ${when(reviewed, () => html`<pre class="fs">${JSON.stringify(presentation.displayed, null, 2)}</pre>`)}
        <button class="pullbtn" disabled="${busy || !reviewed || !(this.state.words[d.id] || '').trim()}"
          on-click="${() => this.revise(d)}">revise answer</button>
      </div>`)}
      ${when(d.answers.length > 0, () => html`<details><summary>answer history (${d.answers.length})</summary>
        ${each(d.answers.filter((a) => a.sourceReceipt), (a) => html`<div class="fs dim native-source">${a.id}: ${a.sourceReceipt.harness} ${a.sourceReceipt.version} · source user ${a.sourceReceipt.creatorUserId} · message ${a.sourceReceipt.entryId} · turn ${a.sourceReceipt.turnId}</div>`, (a) => a.id)}
        ${each(d.answers, (a) => html`<div class="fs dim">${a.id}: ${a.words}${a.revision ? ' — revises ' + a.revision.of.join(', ') + ' for ' + [...a.revision.findings, ...(a.revision.issues || []).map((issue) => issue.id)].join(', ') : ''}${a.questionnaire?.approvals ? ' — approved: ' + a.questionnaire.approvals.join(', ') : ''}${a.questionnaire?.corrections?.length ? ' — corrections: ' + a.questionnaire.corrections.map((c) => c.itemId + ': ' + c.text + ' (' + c.verdict + ')').join('; ') : ''}${a.revisionInvalid ? ' — invalid: ' + a.revisionInvalid : ''}${a.withdrawn ? ' — withdrawn: ' + a.withdrawn.reason : ''}</div>`, (a) => a.id)}
      </details>`)}
      ${when(!replaced && !questionnaire && d.kind === 'options', () => html`<div class="op-actions">
        ${each(d.options, (o) => html`<button class="pullbtn" disabled="${busy}" on-click="${() => this.answer(d.id, o.park ? { park: o.park } : { option: o.label })}">${o.label}</button>`, (o) => o.label)}
      </div>`)}
      ${when(!replaced && !questionnaire && d.kind === 'bulk', () => html`<div class="op-actions">
        <span class="dim">check any to rule on separately; the rest are approved</span>
        ${each(d.options.filter((o) => !o.approveAll), (o) => html`<label><input type="checkbox" checked="${checked.includes(o.label)}" on-change="${() => this.toggle(d.id, o.label)}"> ${o.label}</label>`, (o) => o.label)}
        <button class="pullbtn" disabled="${busy}" on-click="${() => this.answer(d.id, { checked: checked.length ? checked : [d.options.find((o) => o.approveAll).label] })}">${checked.length ? `rule ${checked.length} separately, approve the rest` : 'approve all'}</button>
      </div>`)}
      ${when(!replaced && !questionnaire && d.kind !== 'bulk', () => html`<div class="op-actions">
        <input placeholder="${d.kind === 'words' ? 'your answer' : 'or say it in your own words…'}" value="${this.state.words[d.id] || ''}"
          on-change="${(e, v) => { this.state.words = { ...this.state.words, [d.id]: v }; }}">
        <button class="pullbtn" disabled="${busy || !(this.state.words[d.id] || '').trim()}" on-click="${() => this.answer(d.id, { words: this.state.words[d.id] })}">send</button>
      </div>`)}
    </div>`;
  }

  views(v) {
    const u = this.props.params.universe;
    // A blocked log serves what was stored: never let it read as "nothing waits on you".
    const blocked = v.status === 'blocked';
    return html`
      ${when(blocked, () => html`<div class="attn-banner"><span class="attn-n">!</span><span>The decisions log cannot be read, so these lists may be wrong and answering is refused: ${v.diagnostic?.detail ?? 'unreadable'}</span></div>`)}
      ${when(!blocked && v.diagnostic?.reason === 'malformed-event', () => html`<div class="attn-banner"><span class="attn-n">!</span><span>${v.diagnostic.detail}</span></div>`)}
      <div class="sec">waiting on you (${v.waitingOnYou.length})</div>
      ${when(!v.waitingOnYou.length, () => html`<div class="empty">${blocked ? UNKNOWN : 'nothing — every question is answered'}</div>`)}
      ${each(v.waitingOnYou, (w) => html`<div class="fs"><a href="${href(decisionsUrl(u, w.round))}">${w.round} ${w.ref}</a> — ${w.why}</div>`, (w, i) => w.decision + i)}

      <div class="sec">recorded answer comparisons (${v.comparisons.length})</div>
      ${when(!v.comparisons.length, () => html`<div class="empty">No comparison request has been recorded yet.</div>`)}
      ${each(v.comparisons, (c) => html`<div class="fs"><a href="${comparisonUrl(u, c.id)}">${c.answers.join(' / ')}</a>
        — ${c.state}${c.restrictsWork ? ' · dependent work paused' : ''}
        ${c.issues.map((issue) => issue.kind + ' ' + issue.id).join(', ')}</div>`, (c) => c.id)}
      <div class="sec">human intent to check (${'intentCandidates' in v ? v.intentCandidates.length : 0})</div>
      <div class="empty">These are mechanically detected candidates. Compare the exact words and ask the person which intent to preserve before acting; a relayer's event history does not prove what the person knew.</div>
      ${each('intentCandidates' in v ? v.intentCandidates : [], (c) => html`<div class="op-card"><div class="fs">Answers ${c.answers.join(' and ')} may conflict on ${c.findings.join(', ') || 'this question'}.</div>
        ${when(c.nomination, () => html`<div class="fs dim">Nominated: ${c.nomination?.reason}</div>`)}
        ${each(c.sources, (source) => html`<div class="fs"><strong>${source.principal}</strong> (${source.via}): “${source.words}” → ${source.options.join(', ')}
          <div class="dim">Question shown: ${source.question.question}</div>
          ${each(source.question.options, (option) => html`<div class="dim">${option.label}: ${option.description ?? ''}</div>`, (option) => option.label)}
          ${each(source.effects, (option) => html`<div class="dim">${option.label} acts on: ${JSON.stringify(option.effects)}</div>`, (option) => option.label)}
        </div>`, (source, i) => c.answers[i])}</div>`, (c) => c.answers.join('/'))}
      <div class="sec">ruled, not carried out (${v.ruledNotCarriedOut.length})</div>
      <div class="empty">You ruled; the finding is still open. A close waits for the verifier; a fix is somebody's work.</div>
      ${when(!v.ruledNotCarriedOut.length && blocked, () => html`<div class="empty">${UNKNOWN}</div>`)}
      ${each(v.ruledNotCarriedOut, (x) => html`<div class="fs"><a href="${href(decisionsUrl(u, x.round))}">${x.round} ${x.ref}</a> — ${x.finding}: ${x.on === 'settle' ? 'close as ' + x.as : 'fix'} <span class="dim">(ruled by ${x.ruler})</span></div>`, (x) => x.decision + x.finding)}

      <div class="sec">parked (${v.parked.length})</div>
      ${when(!v.parked.length, () => html`<div class="empty">${blocked ? UNKNOWN : 'none'}</div>`)}
      ${each(v.parked, (x) => html`<div class="fs"><a href="${href(decisionsUrl(u, x.round))}">${x.round} ${x.ref}</a> — until ${x.until}${x.findings.length ? ': ' + x.findings.join(', ') : ''} <span class="dim">(it comes back to you the day after)</span></div>`, (x) => x.decision)}

      <div class="sec">your words, read two ways (${v.readingsInDispute.length})</div>
      ${when(!v.readingsInDispute.length, () => html`<div class="empty">${blocked ? UNKNOWN : 'none'}</div>`)}
      ${each(v.readingsInDispute, (x) => html`<div class="op-card"><div class="fs"><a href="${href(decisionsUrl(u, x.round))}">${x.round} ${x.ref}</a>: “${x.words}”</div>
        <div class="fs dim">one reading: ${x.reader}</div><div class="fs dim">the other: ${x.session}</div></div>`, (x) => x.answer)}

      ${when('possiblySuperseded' in v && v.possiblySuperseded.length > 0, () => html`<div class="sec">rulings your later words may change (${'possiblySuperseded' in v ? v.possiblySuperseded.length : 0})</div>
        ${each('possiblySuperseded' in v ? v.possiblySuperseded : [], (x) => html`<div class="fs"><a href="${href(decisionsUrl(u, x.round))}">${x.round} ${x.ref}</a> — ${x.words.map((p) => `“${p.words}” (${p.state})`).join('; ')}</div>`, (x) => x.decision)}`)}
      ${when(v.awaitingReading.length > 0, () => html`<div class="fs dim">${v.awaitingReading.length} answer(s) in your own words are waiting for an agent to read them.</div>`)}`;
  }

  template() {
    const u = this.props.params.universe, d = this.state.d, r = this.state.r;
    // Narrowed here, once: a closure below does not keep a narrowing made outside it.
    const list = d && 'rounds' in d ? d : null, one = r && 'round' in r ? r : null;
    const qdetail = this.state.qdetail, qlist = this.state.qlist;
    const comparison = this.state.comparison, resolutionBrief = this.state.resolutionBrief;
    const questionnaire = qdetail && 'questionnaire' in qdetail ? qdetail : null;
    const failed = d && 'error' in d ? d.error : (r && 'error' in r ? r.error : (qdetail && 'error' in qdetail ? qdetail.error : null));
    return pageShell(d, taskError(this.load) || failed, () => html`
      ${when(!!this.state.err, () => html`<div class="attn-banner"><span class="attn-n">✕</span><span>${this.state.err}</span></div>`)}
      ${when(!!this.props.query.comparison, () => this.comparisonView(comparison, resolutionBrief, qlist?.currentPrincipal))}
      ${when(!this.props.query.comparison, () => html`<div class="crumbs"><b>${u}</b> <span class="sep">·</span> <a href="${href(decisionsUrl(u))}">decisions</a>${one ? html` <span class="sep">·</span> ${one.round.label ?? one.round.id}` : ''}</div>
      ${when(!!one, () => html`
        <div class="dim">${one.round.source}${one.round.pr ? ' · PR ' + one.round.pr : ''}${one.round.prevalidated ? ' · pre-validated: ' + one.round.prevalidated.sortedBy : ''}</div>
        ${each(one.round.notes || [], (n) => html`<div class="fs dim">decided rather than asked: ${n}</div>`, (n, i) => 'n' + i)}
        ${when(!!questionnaire, () => html`
          ${when(questionnaire.status.status === 'blocked', () => html`<div class="attn-banner">The questionnaire log is blocked. Submitted answers and completion may be incomplete; submission is unavailable.</div>`)}
          ${when(!questionnaire.currentPrincipal, () => html`<div class="attn-banner">No local principal identity is configured. The questionnaire is readable, but drafts and submission need a Git identity.</div>`)}
          ${when(questionnaire.currentPrincipal && questionnaire.status.status !== 'blocked', () => html`<div data-questionnaire-host></div>`)}
          ${when(!questionnaire.currentPrincipal || questionnaire.status.status === 'blocked', () => this.questionnaireReadOnly(questionnaire.questionnaire))}
          ${this.questionnaireProgress(questionnaire)}
          <div class="sec">submitted rulings and revisions</div>
          ${each(one.decisions, (x) => this.decision(x, one.status === 'blocked' || !questionnaire.currentPrincipal, true), (x) => x.id)}`)}
        ${when(!questionnaire, () => html`${each(one.decisions, (x) => this.decision(x, one.status === 'blocked'), (x) => x.id)}`)}
        ${each(one.repairs || [], (repair) => repairPresentation(repair), (repair) => repair.key)}
        ${this.views(one)}`)}
      ${when(!one && !!list, () => html`
        ${this.views(list)}
        ${when(!!qlist && !!qlist.questionnaires.length, () => html`<div class="sec">questionnaires (${qlist.questionnaires.length})</div>
          ${each(qlist.questionnaires, (x) => html`<div class="fs"><a href="${href(decisionsUrl(u, x.round))}">${x.title}</a>
            ${x.recipient ? ' · routed to ' + x.recipient : ''}
            ${qlist.currentPrincipal ? ' · ' + (x.progress.find((p) => p.principal === qlist.currentPrincipal)?.counts.submitted ?? 0) + ' submitted by you' : ''}
            ${qlist.currentPrincipal ? ' · ' + this.localDraftCount(x, qlist.currentPrincipal) + ' local draft(s)' : ''}
          </div>`, (x) => x.id)}`)}
        <div class="sec">rounds (${list.rounds.length})</div>
        ${each(list.rounds, (x) => html`<div class="fs"><a href="${href(decisionsUrl(u, x.id))}">${x.id}</a> — ${x.source}, ${x.decisions} question(s)</div>`, (x) => x.id)}`)}
      `)}
    `);
  }
}
defineComponent('decisions-page', DecisionsPage);
