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

/** What an empty list says when the log could not be read: not "nothing" (P3.1 (4)). */
const UNKNOWN = 'unknown — the log can\'t be read';

export const decisionsUrl = (u, round) => `/u/${u}/decisions/${round ? round + '/' : ''}`;

/**
 * @typedef {{ params: { universe: string, round?: string }, query: Record<string, string> }} DecProps
 * @typedef {{ d: ApiMap['/api/decisions']|null, r: ApiMap['/api/decisions/round']|null, busy: string|null, err: string|null,
 *   words: Record<string,string>, checked: Record<string,string[]> }} DecState
 * @extends {Component<DecProps, DecState>}
 */
class DecisionsPage extends Component {
  static props = { params: {}, query: {} };
  /** @param {DecProps} props */
  constructor(props) {
    super(props);
    /** @type {DecState} */
    this.state = { d: null, r: null, busy: null, err: null, words: {}, checked: {} };
  }
  load = this.createTask(async () => {
    const u = this.props.params.universe, round = this.props.params.round;
    nav.current = u;
    const [d, r] = await Promise.all([api('/api/decisions', { u }), round ? api('/api/decisions/round', { u, id: round }) : Promise.resolve(null)]);
    this.state.d = d; this.state.r = r;
  });
  mounted() { this.load.run(); }
  propsChanged() { this.state.d = null; this.state.r = null; this.load.run(); }

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

  toggle(decision, label) {
    const now = this.state.checked[decision] || [];
    this.state.checked = { ...this.state.checked, [decision]: now.includes(label) ? now.filter((x) => x !== label) : [...now, label] };
  }

  /** One decision: its question as asked, its standing answer, and — if it wants one — the controls. */
  decision(d, blocked) {
    // Blocked, answering is refused anyway (P3.1 (4)): no controls that cannot work.
    const s = d.standing, busy = this.state.busy === d.id;
    const moved = !!d.replacedBy, inactive = blocked || !!d.cancellation || !!d.confirms?.invalid || !!d.resolutionInvalid;
    const replaced = moved || inactive;
    const checked = this.state.checked[d.id] || [];
    return html`<div class="op-card ${replaced ? 'moved' : ''}">
      <div class="ft"><b>${d.ref}</b> <span class="qbadge">${d.kind}</span>
        ${when(!!d.confirm, () => html`<span class="qbadge ${d.confirm.state === 'open' ? '' : 'drift'}">confirm of your words on ${d.confirm.of ?? '(gone)'}: ${d.confirm.state}</span>`)}
        ${when(moved, () => html`<span class="qbadge drift">replaced by ${d.replacedBy}</span>`)}
        ${when(!!s, () => html`<span class="qbadge ${s.verified ? '' : 'drift'}">${s.verified ? 'answered' : 'answered, unverified'}</span>`)}
      </div>
      <div class="fs">${d.payload.question}</div>
      ${each(d.options, (o) => html`<div class="fs dim">• <b>${o.label}</b>${d.confirms?.invalid ? ' — inactive' : o.effects.length ? ' — ' + o.effects.map((e) => `${e.on === 'settle' ? 'close as ' + e.as : 'fix'}: ${e.findings.join(', ')}`).join('; ') : ''}</div>`, (o) => o.label)}
      ${when(!!d.cancellation, () => html`<div class="fs dim">Cancelled: ${d.cancellation.reason}</div>`)}
      ${each(d.answers.filter((a) => a.cancelled), (a) => html`<div class="fs dim">Previous answer: “${a.words}” — ${a.cancelled.reason}${a.reading ? '; reading ' + a.reading.id + ' retained as history' : ''}</div>`, (a) => a.id)}
      ${when(!!d.resolutionInvalid, () => html`<div class="fs dim">This resolution is invalid: ${d.resolutionInvalid}. Ask a valid question showing both exact answers.</div>`)}
      ${when(!!d.confirms?.invalid, () => html`<div class="fs dim">Invalid confirmation: ${d.confirms.invalid}. Its options cannot act on findings; ask a valid question.</div>`)}
      ${when(!!s, () => html`<div class="fs">you said: <b>${s.words}</b>${s.options.length ? ' → ' + s.options.join(', ') : ''}${s.park ? ' → parked until ' + s.park : ''}</div>`)}
      ${when(!!(s && s.flags), () => html`<div class="fs dim">${(s.flags || []).join('; ')}</div>`)}
      ${when(!!(d.possiblySuperseded && d.possiblySuperseded.length), () => html`<div class="fs"><span class="qbadge drift">possibly superseded</span>
        your later words may change this — until they are read or you confirm, the ruling above stands:
        ${each(d.possiblySuperseded || [], (p) => html`<div class="fs dim">“${p.words}” (${p.state})</div>`, (p) => p.answer)}</div>`)}
      ${when(!replaced && d.kind === 'options', () => html`<div class="op-actions">
        ${each(d.options, (o) => html`<button class="pullbtn" disabled="${busy}" on-click="${() => this.answer(d.id, o.park ? { park: o.park } : { option: o.label })}">${o.label}</button>`, (o) => o.label)}
      </div>`)}
      ${when(!replaced && d.kind === 'bulk', () => html`<div class="op-actions">
        <span class="dim">check any to rule on separately; the rest are approved</span>
        ${each(d.options.filter((o) => !o.approveAll), (o) => html`<label><input type="checkbox" checked="${checked.includes(o.label)}" on-change="${() => this.toggle(d.id, o.label)}"> ${o.label}</label>`, (o) => o.label)}
        <button class="pullbtn" disabled="${busy}" on-click="${() => this.answer(d.id, { checked: checked.length ? checked : [d.options.find((o) => o.approveAll).label] })}">${checked.length ? `rule ${checked.length} separately, approve the rest` : 'approve all'}</button>
      </div>`)}
      ${when(!replaced && d.kind !== 'bulk', () => html`<div class="op-actions">
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
      <div class="sec">waiting on you (${v.waitingOnYou.length})</div>
      ${when(!v.waitingOnYou.length, () => html`<div class="empty">${blocked ? UNKNOWN : 'nothing — every question is answered'}</div>`)}
      ${each(v.waitingOnYou, (w) => html`<div class="fs"><a href="${href(decisionsUrl(u, w.round))}">${w.round} ${w.ref}</a> — ${w.why}</div>`, (w, i) => w.decision + i)}

      <div class="sec">human intent to check (${'intentCandidates' in v ? v.intentCandidates.length : 0})</div>
      <div class="empty">These are mechanically detected candidates. Compare the exact words and ask the person which intent to preserve before acting; a relayer's event history does not prove what the person knew.</div>
      ${each('intentCandidates' in v ? v.intentCandidates : [], (c) => html`<div class="op-card"><div class="fs">Answers ${c.answers.join(' and ')} may conflict on ${c.findings.join(', ') || 'this question'}.</div>
        ${each(c.sources, (source) => html`<div class="fs dim">${source.principal} (${source.via}): “${source.words}” → ${source.options.join(', ')}</div>`, (source, i) => c.answers[i])}</div>`, (c) => c.answers.join('/'))}
      <div class="sec">ruled, not carried out (${v.ruledNotCarriedOut.length})</div>
      <div class="empty">You ruled; the finding is still open. A close waits for the verifier; a fix is somebody's work.</div>
      ${when(!v.ruledNotCarriedOut.length && blocked, () => html`<div class="empty">${UNKNOWN}</div>`)}
      ${each(v.ruledNotCarriedOut, (x) => html`<div class="fs"><a href="${href(decisionsUrl(u, x.round))}">${x.round} ${x.ref}</a> — ${x.finding}: ${x.on === 'settle' ? 'close as ' + x.as : 'fix'} <span class="dim">(ruled by ${x.ruler}${x.replacedBy ? '; the question was replaced, and this holds until the replacement is answered' : ''})</span></div>`, (x) => x.decision + x.finding)}

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
    const failed = d && 'error' in d ? d.error : (r && 'error' in r ? r.error : null);
    return pageShell(d, taskError(this.load) || failed, () => html`
      <div class="crumbs"><b>${u}</b> <span class="sep">·</span> <a href="${href(decisionsUrl(u))}">decisions</a>${one ? html` <span class="sep">·</span> ${one.round.id}` : ''}</div>
      ${when(!!this.state.err, () => html`<div class="attn-banner"><span class="attn-n">✕</span><span>${this.state.err}</span></div>`)}
      ${when(!!one, () => html`
        <div class="dim">${one.round.source}${one.round.pr ? ' · PR ' + one.round.pr : ''}${one.round.prevalidated ? ' · pre-validated: ' + one.round.prevalidated.sortedBy : ''}</div>
        ${each(one.round.notes || [], (n) => html`<div class="fs dim">decided rather than asked: ${n}</div>`, (n, i) => 'n' + i)}
        ${each(one.decisions, (x) => this.decision(x, one.status === 'blocked'), (x) => x.id)}
        ${this.views(one)}`)}
      ${when(!one && !!list, () => html`
        ${this.views(list)}
        <div class="sec">rounds (${list.rounds.length})</div>
        ${each(list.rounds, (x) => html`<div class="fs"><a href="${href(decisionsUrl(u, x.id))}">${x.id}</a> — ${x.source}, ${x.decisions} question(s)</div>`, (x) => x.id)}`)}
    `);
  }
}
defineComponent('decisions-page', DecisionsPage);
