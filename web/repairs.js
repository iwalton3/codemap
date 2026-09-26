/** @typedef {import('./core.js').ApiMap} ApiMap */
import { Component, defineComponent, html, when, each } from './vendor/vdx/framework.js';
import { api, pageShell, nav, href, taskError, sharedUrl, reviewLabel } from './core.js';

export const repairsUrl = (u, review) => `/u/${u}/repairs/${encodeURIComponent(String(review))}/`;
const identityText = (identity) => `${identity.principal} · ${identity.harness} · session ${identity.session}${identity.child ? ' · child ' + identity.child : ''}`;
/**
 * @typedef {{ params: { universe: string, review: string } }} RepairProps
 * @typedef {{ d: ApiMap['/api/repairs']|null }} RepairState
 * @extends {Component<RepairProps, RepairState>}
 */
class RepairsPage extends Component {
  static props = { params: {} };
  /** @param {RepairProps} props */
  constructor(props) {
    super(props);
    /** @type {RepairState} */
    this.state = { d: null };
  }
  load = this.createTask(async () => {
    const { universe, review } = this.props.params;
    nav.current = universe;
    this.state.d = await api('/api/repairs', { u: universe, review });
  });
  mounted() { this.load.run(); }
  propsChanged() { this.state.d = null; this.load.run(); }

  provenance(record) {
    return html`<div class="fs dim">Recorded by ${record.actor.principal} · ${record.at} · event ${record.eventId}</div>`;
  }
  coverage(refs) {
    return html`${each(refs, (ref) => html`<div class="fs">Finding ${ref.findingId} · claims ${ref.claimIds.join(', ')}
      ${when('result' in ref, () => html`<span class="qbadge drift">reported ${ref.result}</span> — ${ref.reason}`)}
      ${when('claimResults' in ref, () => html`${each(ref.claimResults || [], (claim) => html`<div class="fs dim">Claim ${claim.claimId}: reported ${claim.result} — ${claim.reason}</div>`, (claim) => claim.claimId)}`)}
    </div>`, (ref) => ref.findingId)}`;
  }
  executions(label, runs) {
    return html`<h4>${label}</h4>
      ${when(!runs.length, () => html`<div class="fs dim">No execution recorded.</div>`)}
      ${each(runs, (run) => html`<div class="op-card execution-result"><div class="fs"><strong>${run.outcome}</strong>${Number.isInteger(run.exitCode) ? ' · exit ' + run.exitCode : ''} · ${run.id}</div>
        <div class="fs dim">Phase ${run.phase} · commit ${run.commit} · environment ${run.environment}</div>
        ${when(!!run.mutation, () => html`<div class="fs">Mutation: ${run.mutation}</div>`)}
        ${when(!!run.reversedHunks?.length, () => html`<div class="fs">Reversed hunks: ${run.reversedHunks.join(', ')}</div>`)}
        <pre>${run.command}</pre>
        ${when(!!run.reason, () => html`<div class="fs">Reason: ${run.reason}</div>`)}
        ${when(run.stdout !== undefined, () => html`<details><summary>Recorded stdout</summary><pre>${run.stdout}</pre></details>`)}
        ${when(run.stderr !== undefined, () => html`<details><summary>Recorded stderr</summary><pre>${run.stderr}</pre></details>`)}
      </div>`, (run, i) => run.id + ':' + i)}`;
  }
  verificationHistory(verification, summaries) {
    return html`<div class="sec">Independent verification history (${verification.requests.length})</div>
      <div class="fs dim">Sealed runs preserve their exact checked claims and code. Unknown neither closes nor automatically reopens a finding. A separate application checks whether the result still applies.</div>
      ${each(verification.requests, (request) => html`<div class="op-card verification-request"><h3>${request.id}</h3>
        ${each(summaries.filter(summary => summary.requestId === request.id), (summary) => html`<div class="fs verification-summary">Finding ${summary.findingId}: ${summary.verdict} · ${summary.complete ? 'complete bounded coverage at checked inputs' : 'incomplete bounded coverage'} · ${summary.grade === 'inspection' ? 'weaker inspection grade' : summary.grade + ' grade'}${summary.reasons.length ? ' — ' + summary.reasons.join('; ') : ''}
          ${each(summary.staleReasons || [], (reason) => html`<div class="fs qbadge drift">Stale verification: ${reason}. Historical evidence cannot establish current applicability.</div>`, (reason) => reason)}
        </div>`, (summary) => summary.findingId)}
        <div class="fs">Orchestrator: ${identityText(request.capsule.orchestrator)}</div>
        <div class="fs">Capsule ${request.capsuleHash} · sort ${request.capsule.sort.id} · evidence ${request.capsule.evidence.id}</div>
        <div class="fs">Checked commit ${request.capsule.code.fixCommit} · code ${request.capsule.code.availability}${request.capsule.code.reason ? ': ' + request.capsule.code.reason : ''}</div>
        ${this.coverage(request.capsule.sort.coverage)}
        <details><summary>Exact verification scope and ruling context</summary>
          ${each(request.capsule.claims, (claim) => html`<div class="fs">${claim.id} · finding ${claim.findingId}: ${claim.text}</div>`, (claim) => claim.id)}
          <pre>${request.capsule.rulingContext}</pre><pre>${request.capsule.code.diff}</pre>
        </details>
        ${each(verification.runs.filter(run => run.requestId === request.id), (run) => html`<div class="op-card verification-run"><h4>Sealed verifier slot ${run.slot} · ${run.id}</h4>
          <div class="fs">${identityText(run.identity)} · connection ${run.connectionId}</div>
          ${each(run.results, (result) => html`<div class="claim-verdict"><div class="fs">Finding ${result.findingId} · claim ${result.claimId} · <strong>${result.verdict}</strong> · ${result.grade === 'inspection' ? 'weaker inspection grade' : result.grade + ' grade'}: ${result.reason}</div>
            ${this.executions('Independent execution results', result.executions)}
            ${each(result.inspected, (inspection) => html`<div class="fs">Inspected ${inspection.source} at ${inspection.commit}: ${inspection.reasoning}</div>`, (inspection, i) => i)}
            ${when(!!result.noCheckReason, () => html`<div class="fs">No-check reason: ${result.noCheckReason}</div>`)}
          </div>`, (result) => result.findingId + ':' + result.claimId)}
        </div>`, (run) => run.id)}
        ${when(verification.runs.filter(run => run.requestId === request.id).length < 2, () => html`<div class="fs">Unknown — two sealed independent runs are required. Partial coverage cannot resolve a whole finding.</div>`)}
        ${each(verification.arbitrations.filter(arbitration => arbitration.requestId === request.id), (arbitration) => html`<div class="fs">Arbitration ${arbitration.id} by ${identityText(arbitration.identity)}
          ${each(arbitration.addresses, (address) => html`<div class="fs">Finding ${address.findingId} · claim ${address.claimId}: ${address.verdict} — ${address.reason}</div>`, (address) => address.findingId + ':' + address.claimId)}
        </div>`, (arbitration) => arbitration.id)}
        ${when(!verification.applications.some(application => application.requestId === request.id), () => html`<div class="fs dim">${summaries.some(summary => summary.requestId === request.id && summary.historicalClosure) ? 'No currently eligible application receipt; the recorded historical closure remains above.' : 'Not applied. A verification receipt alone does not close a finding.'}</div>`)}
        ${each(verification.applications.filter(application => application.requestId === request.id), (application) => html`<div class="fs verification-application">Recorded application ${application.id}: finding ${application.findingId} · ${application.outcome} · opening ${application.openEpoch} — ${application.reason}</div>`, (application) => application.id)}
      </div>`, (request) => request.id)}
      ${when(!!verification.rejected.length, () => html`<h4>Rejected verification attempts</h4>${each(verification.rejected, (rejection) => html`<div class="fs">${rejection.eventId}: ${rejection.reason}</div>`, (rejection) => rejection.eventId)}`)}`;
  }
  template() {
    const d = this.state.d;
    const detail = d && !('error' in d) ? d : null;
    const { universe, review } = this.props.params;
    return pageShell(d, taskError(this.load) || (d && 'error' in d ? d.error : null), () => html`
      <div class="crumbs"><b>${universe}</b> <span class="sep">·</span> <a href="${href(sharedUrl(universe, review))}">${reviewLabel(review)}</a> <span class="sep">·</span> repair records</div>
      <div class="attn-banner repair-closure-gate">Repair closure is gated by independent sealed verification and separate application checks. Reported coverage and passing runs do not resolve findings.</div>
      ${when(!!detail, () => html`
        ${when(detail.status === 'blocked', () => html`<div class="attn-banner">The repair scope is blocked. Stored records may be incomplete: ${detail.diagnostic?.detail || 'unreadable log'}</div>`)}
        <div class="sec">Repair lifecycle (${detail.lifecycles.length})</div>
        ${each(detail.lifecycles, (lifecycle) => html`<div class="op-card repair-lifecycle"><h3>Finding ${lifecycle.findingId} · ${lifecycle.state}</h3>
          <div class="fs">${lifecycle.applied ? 'Applied to canonical finding' : 'Verification not yet applied'} · ${lifecycle.currentProof ? 'Current proof at checked source' : 'Historical or incomplete proof'} · ${lifecycle.grade === 'inspection' ? 'weaker inspection grade' : lifecycle.grade + ' grade'}</div>
          ${when(!!lifecycle.code, () => html`<div class="fs">Exact checked commit ${lifecycle.code.checkedCommit} · default commit ${lifecycle.code.defaultCommit || 'unavailable'} · landing ${lifecycle.code.landing} · source ${lifecycle.code.source} · default source ${lifecycle.code.defaultSource}</div>
            ${each(lifecycle.code.reasons, (reason) => html`<div class="fs dim">${reason}</div>`, (reason) => reason)}`)}
          <div class="fs">Unresolved or checked scope: ${each(lifecycle.claims, (claim) => html`<div class="fs">${claim.id}: ${claim.text}</div>`, (claim) => claim.id)}</div>
          <div class="fs">Verifiers: ${lifecycle.verifiers.map(identityText).join('; ') || 'no qualifying independent verdict'}</div>
          <div class="fs">Ruling IDs: ${lifecycle.rulingIds.join(', ') || 'none recorded'}</div>
          ${each(lifecycle.attention, (reason) => html`<div class="fs qbadge drift repair-lifecycle-attention">Repair needs attention: ${reason}</div>`, (reason) => reason)}
        </div>`, (lifecycle) => lifecycle.requestId + ':' + lifecycle.findingId)}
        <div class="sec">As-filed claims (${detail.records.claims.length})</div>
        ${when(!detail.records.claims.length, () => html`<div class="empty">${detail.status === 'blocked' ? 'Unknown — the log cannot be read.' : 'No original claims recorded in this review.'}</div>`)}
        ${each(detail.records.claims, (claim) => html`<div class="op-card original-claim"><div class="fs"><strong>${claim.id}</strong> · finding ${claim.findingId}${claim.parentId ? ' · decomposed from ' + claim.parentId : ' · original as filed'}</div><p>${claim.text}</p><div class="fs dim">Source event ${claim.eventId}</div>${when(!!claim.asFiled, () => html`<details><summary>Exact as-filed snapshot</summary><pre>${JSON.stringify(claim.asFiled, null, 2)}</pre></details>`)}${when(!!claim.witness, () => html`<details><summary>As-filed witness</summary><pre>${JSON.stringify(claim.witness, null, 2)}</pre></details>`)}</div>`, (claim) => claim.id)}
        <div class="sec">Sort version history (${detail.records.sorts.length})</div>
        ${each(detail.records.sorts, (record) => html`<div class="op-card sort-version"><h3>${record.input.id} · ${record.input.classification} · ${record.input.kind}</h3>
          <div class="fs">${record.current ? 'current sort' : 'historical sort'} · ${record.input.provenance} · ${record.eligible ? 'sort eligible for future verification' : 'sort held'}</div>
          <div class="fs">Source: ${record.input.source}</div>
          ${when(!!record.input.prior, () => html`<div class="fs">Revises ${record.input.prior}: ${record.input.reason}</div>`)}
          ${this.provenance(record)}${this.coverage(record.input.coverage)}
          ${when(!!record.input.predicate, () => html`<p>Pattern predicate: ${record.input.predicate}</p><div class="fs">Original sites: ${(record.input.sites || []).join(', ')}</div>`)}
          ${when(!!record.input.refutationSubtype, () => html`<div class="fs">Refutation subtype: ${record.input.refutationSubtype}</div>`)}
          <div class="fs">Depends on: ${record.input.restsOn.join(', ') || 'none recorded'}</div>
          ${each(record.holds, (hold) => html`<div class="fs qbadge drift">${hold}</div>`, (hold) => hold)}
          ${each(record.input.assessments, (assessment) => html`<div class="fs">Sorter ${identityText(assessment.identity)} · ${assessment.classification}: ${assessment.reason}${when(!!assessment.receipt, () => html`<details><summary>${assessment.receipt.seal ? 'Sealed sorter receipt' : 'Reported receipt'} ${assessment.receipt.id} · ${assessment.receipt.source}</summary><pre>${assessment.receipt.content}</pre></details>`)}</div>`, (assessment, i) => i)}
          ${each(record.input.disagreements, (disagreement) => html`<div class="fs">Disagreement ${disagreement.id}: ${disagreement.text}</div>`, (disagreement) => disagreement.id)}
          ${when(!!record.input.arbitration, () => html`<div class="fs">Arbitration by ${identityText(record.input.arbitration.identity)} · addresses ${record.input.arbitration.addresses.join(', ')}: ${record.input.arbitration.reason}${when(!!record.input.arbitration.receipt, () => html`<details><summary>${record.input.arbitration.receipt.seal ? 'Sealed arbitration receipt' : 'Reported arbitration receipt'}</summary><pre>${record.input.arbitration.receipt.content}</pre></details>`)}</div>`)}
        </div>`, (record) => record.eventId)}
        <div class="sec">Structured repair evidence (${detail.records.evidence.length})</div>
        <div class="fs dim">Commands below are evidence data. This page does not execute them. Regression runs alone do not demonstrate a repair.</div>
        ${each(detail.records.evidence, (record) => html`<div class="op-card repair-evidence"><h3>${record.input.id} · sort ${record.input.sortId}</h3>${this.provenance(record)}
          ${each(record.staleReasons || [], (reason) => html`<div class="fs qbadge drift">Stale evidence: ${reason}</div>`, (reason) => reason)}
          ${each(detail.coverage[record.input.id] || [], (finding) => html`<div class="fs">Finding ${finding.findingId}: <strong>coverage ${finding.completeness}</strong></div>`, (finding) => finding.findingId)}
          ${each(record.staleReasons, (reason) => html`<div class="fs qbadge drift">Stale evidence: ${reason}</div>`, (reason) => reason)}
          <div class="fs">Witness ${record.input.witnessCommit}</div><div class="fs">Base ${record.input.baseCommit}</div><div class="fs">Fix ${record.input.fixCommit}</div>
          ${this.coverage(record.input.coverage)}
          <div class="fs dim">Coverage is a report for these exact claims. Uncovered claims remain unresolved; partial coverage cannot resolve a whole finding.</div>
          ${this.executions('Finding reproducer', record.input.reproducer)}
          ${this.executions('Change falsifier', record.input.changeFalsifier)}
          ${this.executions('Regression runs', record.input.regression)}
          <h4>Pattern enumeration</h4>
          ${when(!!record.input.patternEnumeration, () => html`<div class="fs">Method: ${record.input.patternEnumeration.method}</div><div class="fs">Expected sites: ${record.input.patternEnumeration.expected.join(', ')}</div><div class="fs">Actual sites: ${record.input.patternEnumeration.actual.join(', ')}</div>`)}
          ${when(!record.input.patternEnumeration, () => html`<div class="fs dim">No pattern enumeration recorded.</div>`)}
          <h4>Inspected evidence · weaker inspection grade</h4>
          ${each(record.input.inspected, (inspection) => html`<div class="fs">${inspection.source} at ${inspection.commit}: ${inspection.reasoning}</div>`, (inspection, i) => i)}
          ${when(!record.input.inspected.length, () => html`<div class="fs dim">No inspection recorded.</div>`)}
          <h4>No-check reason</h4><div class="fs">${record.input.noCheckReason || 'No reason recorded.'}</div>
          <h4>Diff attribution</h4>
          ${each(record.input.attribution, (attribution) => html`<div class="fs">${attribution.file} · claims ${attribution.claimIds.join(', ')}<pre>${attribution.hunk}</pre></div>`, (attribution, i) => i)}
          <div class="fs">Ruling IDs: ${record.input.rulingIds.join(', ') || 'none recorded'}</div>
        </div>`, (record) => record.eventId)}
        <div class="sec">Trusted repair participants (${detail.records.participants.length})</div>
        ${each(detail.records.participants, (record) => html`<div class="op-card"><div class="fs">${record.input.role} · repair ${record.input.repairId} · ${identityText(record.input.identity)} · ${record.input.trust}</div>${this.provenance(record)}</div>`, (record) => record.eventId)}
        <div class="sec">Recorded closure history (${detail.historicalClosures.length})</div>
        ${each(detail.historicalClosures, (closure) => html`<div class="op-card historical-repair-closure"><div class="fs">Recorded historical closure ${closure.applicationId}: finding ${closure.findingId} · ${closure.outcome} · current finding state ${closure.state}. Request ${closure.requestId}. The completed act remains history.</div>
          ${each(closure.attention, (reason) => html`<div class="fs qbadge drift repair-closure-attention">Closure needs attention: ${reason}</div>`, (reason) => reason)}
        </div>`, (closure) => closure.applicationId)}
        ${when(!!detail.verification, () => this.verificationHistory(detail.verification, detail.verificationResults))}
        ${when(!!detail.records.rejected.length, () => html`<div class="sec">Rejected records</div>${each(detail.records.rejected, (rejection) => html`<div class="fs">${rejection.eventId}: ${rejection.reason}</div>`, (rejection) => rejection.eventId)}`)}
      `)}
    `);
  }
}
defineComponent('repairs-page', RepairsPage);
