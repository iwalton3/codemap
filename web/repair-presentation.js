import { html, when, each } from './vendor/vdx/framework.js';

export const repairStateLabel = (state) => ({
  'verified-at-commit': 'Verified at an unmerged commit',
  'verified-repair-landed': 'Verified repair landed',
  'factually-refuted': 'Factual refutation',
  'partly-repaired': 'Partly repaired',
  'decision-needed': 'Decision needed',
  'human-accepted': 'Explicit human acceptance',
  'human-ruling-applied': 'Human ruling applied',
}[state] || state);

export function repairPresentation(repair) {
  if (!repair) return html``;
  return html`<div class="repair-presentation">
    ${when(repair.status === 'blocked' || repair.status === 'unavailable', () => html`<div class="repair-lifecycle-attention">Repair history is blocked; current proof is unknown: ${repair.diagnostic || 'unreadable scope'}</div>`)}
    <div class="repair-status fs">Current finding: ${repairStateLabel(repair.state)}</div>
    ${each(repair.lifecycles || [], (l) => html`<div class="repair-lifecycle"><b>${repairStateLabel(l.state)}</b> · ${l.grade} grade · ${l.applied ? 'historical closure applied' : 'not applied'}
      <div class="fs">Checked commit ${l.code?.checkedCommit || 'unknown'} · landing ${l.code?.landing || 'unknown'} · ${l.currentProof ? 'current proof' : 'historical or incomplete proof'}</div>
      <div class="fs">Evidence ${l.evidenceId} · request ${l.requestId} · rulings ${l.rulingIds.join(', ') || 'none'}</div>
      <div class="fs">Verifiers ${l.verifiers.map(v => v.child ? `${v.principal} / subagent ${v.child}` : `${v.principal} / session ${v.session}`).join('; ') || 'none qualifying'}</div>
      ${each(l.claims, (claim) => html`<div class="fs">Claim ${claim.id}: ${claim.text}</div>`, (claim) => claim.id)}
      ${each(l.attention, (reason) => html`<div class="repair-lifecycle-attention qbadge drift">Repair needs attention: ${reason}</div>`, (reason) => reason)}
    </div>`, (l) => l.requestId + ':' + l.findingId)}
    ${each(repair.executions || [], (run) => html`<div class="repair-execution fs">Human ruling ${!!run.capsule?.acceptance ? 'explicit acceptance' : 'application'}: ${run.status} · ${run.at} · ${run.eventId}${run.reason ? ' · ' + run.reason : ''}</div>`, (run) => run.eventId)}
    ${when(repair.historicalClosure?.attention?.length, () => html`<div class="fs">Historical closure retained ${repair.historicalClosure.applicationId}</div>${each(repair.historicalClosure.attention, (reason) => html`<div class="repair-lifecycle-attention">Closure needs attention: ${reason}</div>`, (reason) => reason)}`)}
  </div>`;
}
