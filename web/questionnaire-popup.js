import { watch } from './vendor/vdx/framework.js';
import { api, attestedPost, errText, nav } from './core.js';
import { mountQuestionnaire } from './questionnaire.js';

/** @typedef {import('./core.js').ApiMap} ApiMap */
/** @typedef {ApiMap['/api/decisions/questionnaires']['questionnaires'][number]} Entry */

/**
 * Persistent chrome. Polling (one request) only updates the badge: the dialog opens when the
 * person clicks it, never on its own, so a questionnaire arriving mid-task takes no focus.
 * What they close stays closed across reloads on this device (plan Phase 4.1).
 */
export function mountQuestionnairePopup(host, interval = 15000) {
  const style = document.createElement('style');
  style.textContent = `
    .questionnaire-notice{position:fixed;right:1rem;bottom:1rem;z-index:30;max-width:calc(100vw - 2rem);padding:.5rem .9rem;font-size:.9rem;box-shadow:0 2px 10px #0008}
    .questionnaire-notice.is-new{border-color:var(--accent,#58a6ff);color:var(--text,#d7dde5)}
    .questionnaire-popup{background:var(--bg,#161b22);color:var(--text,#c9d1d9);border:1px solid #465064;border-radius:.5rem;width:min(850px,calc(100vw - 2rem));max-height:calc(100dvh - 2rem);padding:1rem;box-sizing:border-box;overflow:auto;overflow-wrap:anywhere}
    .questionnaire-popup::backdrop{background:#0009}
    .questionnaire-popup .popup-actions{display:flex;flex-wrap:wrap;gap:.5rem;align-items:center}
    .questionnaire-popup [data-popup-progress]{white-space:pre-wrap}
  `;
  const badge = document.createElement('button');
  badge.className = 'pullbtn questionnaire-notice'; badge.hidden = true;
  const dialog = document.createElement('dialog'); dialog.className = 'questionnaire-popup';
  dialog.setAttribute('aria-label', 'Pending questionnaires');
  const actions = document.createElement('div'); actions.className = 'popup-actions';
  const dismiss = document.createElement('button'); dismiss.className = 'pullbtn'; dismiss.textContent = 'Close — keep draft';
  const link = document.createElement('a'); link.textContent = 'Open decisions';
  actions.append(dismiss, link);
  const status = document.createElement('p'); status.setAttribute('role', 'status');
  const queue = document.createElement('div'); queue.className = 'popup-actions';
  const progress = document.createElement('p'); progress.dataset.popupProgress = '';
  const form = document.createElement('div');
  dialog.append(actions, status, queue, progress, form); host.append(style, badge, dialog);
  let universe = null, epoch = 0, disposed = false, loading = false, opening = 0;
  let principal = null, blocked = true, availability = '', entries = [], allEntries = [];
  /** @type {{key:string, entry:Entry, principal:string}|null} */
  let active = null;
  let unmount = null;
  const DISMISSED = 'codemap.questionnaire.dismissed';
  /** @type {Set<string>} */
  const seen = new Set((() => { try { const v = JSON.parse(localStorage.getItem(DISMISSED) || '[]'); return Array.isArray(v) ? v.filter((x) => typeof x === 'string') : []; } catch { return []; } })());
  const remember = (k) => { seen.add(k); try { localStorage.setItem(DISMISSED, JSON.stringify([...seen].slice(-200))); } catch { /* per-device convenience only */ } };
  const key = (entry) => JSON.stringify([universe, principal, entry.id, entry.version]);
  const onDecisions = () => /^#\/u\/[^/]+\/decisions(?:\/|$)/.test(location.hash);
  const valid = (generation) => !disposed && generation === epoch;
  const close = () => {
    opening++;
    if (active) remember(active.key);
    if (dialog.open) dialog.close();
  };
  const render = () => {
    badge.hidden = !universe || (!entries.length && !availability && !active);
    const fresh = entries.filter((entry) => !seen.has(key(entry)));
    badge.classList.toggle('is-new', !!fresh.length);
    badge.textContent = availability || (fresh.length === 1 && entries.length === 1 ? `New questionnaire: ${fresh[0].title} — answer`
      : `${entries.length} questionnaire${entries.length === 1 ? '' : 's'} waiting for you${fresh.length ? ` (${fresh.length} new)` : ''} — answer`);
    link.href = `#/u/${encodeURIComponent(universe)}/decisions/`;
    status.textContent = availability || (entries.length > 1 ? `${entries.length} questionnaires are waiting. Opening another keeps this draft on this device.` : 'Only explicit submission records an answer. Closing submits nothing.');
    queue.replaceChildren();
    for (const entry of entries) {
      const button = document.createElement('button'); button.className = 'pullbtn'; button.textContent = entry.title;
      button.disabled = blocked || !principal;
      button.addEventListener('click', () => open(entry)); queue.append(button);
    }
    const current = active && allEntries.find((entry) => key(entry) === active.key);
    const person = current?.progress.find((p) => p.principal === principal);
    progress.textContent = active ? person
      ? `${person.counts.submitted} submitted; ${person.counts.unanswered} unanswered; ${person.counts.withdrawn} withdrawn.`
      : availability ? 'Completion could not be refreshed.' : 'No unanswered questions remain for you. Submitted receipts stay below.' : '';
    // Preserve the mounted draft and receipts when status changes.
    for (const control of form.querySelectorAll('button,input,textarea')) {
      if (control instanceof HTMLButtonElement || control instanceof HTMLInputElement || control instanceof HTMLTextAreaElement) {
        if (blocked || !principal || (active && active.principal !== principal)) {
          if (!control.disabled) { control.dataset.popupDisabled = ''; control.disabled = true; }
        } else if ('popupDisabled' in control.dataset) { delete control.dataset.popupDisabled; control.disabled = false; }
      }
    }
  };
  const show = () => { if (!onDecisions() && !dialog.open) dialog.showModal(); };
  async function open(entry) {
    if (blocked || !principal || !universe) { show(); return; }
    const wanted = key(entry);
    if (active?.key === wanted) { show(); return; }
    const generation = epoch, request = ++opening, u = universe, person = principal;
    try {
      const detail = await api('/api/decisions/questionnaire', { u, id: entry.id });
      if (!valid(generation) || request !== opening || onDecisions()) return;
      if (!('questionnaire' in detail)) throw new Error(detail.error);
      if (detail.status.status === 'blocked' || detail.currentPrincipal !== person || detail.version !== entry.version)
        throw new Error('Questionnaire identity, version or availability changed. Refresh pending questions before submitting.');
      unmount?.(); active = { key: wanted, entry, principal: person }; remember(wanted);
      unmount = mountQuestionnaire(form, {
        questionnaire: detail.questionnaire, publicationId: detail.id, version: detail.version, principal: person,
        onSubmit: async (submission) => {
          if (!valid(generation) || blocked || principal !== person || active?.key !== wanted)
            return { error: 'This questionnaire is no longer active. Reopen it in its universe before submitting.' };
          const latest = await api('/api/decisions/questionnaire', { u, id: detail.id });
          if (!valid(generation) || active?.key !== wanted || !('questionnaire' in latest)
            || latest.currentPrincipal !== person || latest.status.status === 'blocked' || latest.version !== detail.version)
            return { error: 'Questionnaire identity, version or availability changed. No submission was sent.' };
          const out = await attestedPost('/api/decisions/questionnaire/submit', { u, round: detail.round, submission });
          if (!valid(generation) || active?.key !== wanted) return { error: 'The view changed while submitting. Check the original universe for its receipt.' };
          if (!out || out.error || out.ok !== true) return { error: out?.error ?? 'Submission was not confirmed.' };
          setTimeout(() => { if (valid(generation)) poll(); }, 0);
          return { ok: true, receipt: out.submission };
        },
      });
      render(); show();
    } catch (error) {
      if (!valid(generation) || request !== opening) return;
      availability = `Questions unavailable: ${errText(error)}`; render(); show();
    }
  }
  async function poll() {
    if (disposed || !universe || loading) return;
    const generation = epoch, u = universe; loading = true;
    try {
      const list = await api('/api/decisions/questionnaires', { u });
      if (!valid(generation)) return;
      principal = list.currentPrincipal; blocked = list.status.status === 'blocked';
      availability = blocked ? 'Questionnaire log blocked — submission unavailable' : !principal ? 'Questions need a local Git identity' : '';
      allEntries = list.questionnaires;
      entries = allEntries.filter((entry) => (!entry.recipient || entry.recipient === principal)
        && (!principal || entry.progress.some((p) => p.principal === principal && p.counts.unanswered > 0)));
      render();
    } catch (error) {
      if (valid(generation)) { blocked = true; availability = `Questions unavailable: ${errText(error)}`; render(); }
    } finally { if (valid(generation)) loading = false; }
  }
  const switchUniverse = (u) => {
    if (u === universe) return;
    epoch++; opening++; close(); unmount?.(); unmount = null; form.replaceChildren(); active = null;
    universe = u; principal = null; entries = []; allEntries = []; blocked = true; availability = ''; loading = false;
    render(); poll();
  };
  const onRoute = () => {
    if (onDecisions()) { close(); unmount?.(); unmount = null; active = null; form.replaceChildren(); render(); }
    else poll();
  };
  const onBadge = () => {
    const next = entries.find((entry) => !seen.has(key(entry))) ?? entries[0];
    if (active && (!next || active.key === key(next))) show(); else if (next && !blocked && principal) open(next); else show();
  };
  const cancel = (event) => { event.preventDefault(); close(); };
  badge.addEventListener('click', onBadge); dismiss.addEventListener('click', close);
  dialog.addEventListener('cancel', cancel); window.addEventListener('hashchange', onRoute);
  const stopWatch = watch(() => nav.current, switchUniverse);
  switchUniverse(nav.current);
  const timer = setInterval(poll, interval);
  return () => {
    disposed = true; epoch++; opening++; clearInterval(timer); stopWatch(); unmount?.();
    badge.removeEventListener('click', onBadge); dismiss.removeEventListener('click', close);
    dialog.removeEventListener('cancel', cancel); window.removeEventListener('hashchange', onRoute);
    if (dialog.open) dialog.close(); host.replaceChildren();
  };
}
