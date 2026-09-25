/** Standalone questionnaire form. The caller supplies the frozen display and durable submit. */

/** @typedef {{id: string, label: string, description?: string, action?: string}} ChoiceOption */
/** @typedef {{id: string, text: string, context?: string, action?: string}} ListItem */
/** @typedef {{id: string, prompt: string, context?: string, action?: string, kind: 'choice', options: ChoiceOption[], allowOther: boolean}
 *   | {id: string, prompt: string, context?: string, action?: string, kind: 'short'}
 *   | {id: string, prompt: string, context?: string, action?: string, kind: 'list', items: ListItem[]}} QuestionnaireQuestion */
/** @typedef {{id: string, title: string, context?: string, recipient?: string,
 *   sections: {id: string, title: string, context?: string, questions: QuestionnaireQuestion[]}[]}} Questionnaire */
/** @typedef {{questionId: string, kind: 'choice', optionId: string}
 *   | {questionId: string, kind: 'choice', other: string}
 *   | {questionId: string, kind: 'short', text: string}
 *   | {questionId: string, kind: 'list', approveUnmarked: true, marked: {itemId: string, correction: string}[]}} QuestionnaireAnswer */
/** @typedef {{selected: string[], answers: Record<string, any>}} LocalDraft */
/** @typedef {{questionnaire: Questionnaire, version: string, principal: string,
 *   onSubmit: (payload: {questionnaireId: string, version: string, attemptId: string, answers: QuestionnaireAnswer[]}) => Promise<{ok: true, receipt: string} | {error: string}>,
 *   storage?: Storage }} FormOptions */

/** Exact ID/version and principal keep one person's draft out of another's form. */
export const draftStorageKey = (principal, questionnaireId, version) =>
  `codemap.questionnaire.draft.${JSON.stringify([principal, questionnaireId, version])}`;

/** @returns {LocalDraft} */
export function loadQuestionnaireDraft(storage, principal, questionnaireId, version) {
  try {
    const raw = JSON.parse(storage.getItem(draftStorageKey(principal, questionnaireId, version)) || 'null');
    if (raw && Array.isArray(raw.selected) && raw.selected.every((x) => typeof x === 'string')
      && raw.answers && typeof raw.answers === 'object' && !Array.isArray(raw.answers)) return raw;
  } catch { /* Local storage can be unavailable or contain a damaged draft. */ }
  return { selected: [], answers: {} };
}

export function saveQuestionnaireDraft(storage, principal, questionnaireId, version, draft) {
  try { storage.setItem(draftStorageKey(principal, questionnaireId, version), JSON.stringify(draft)); return true; }
  catch { return false; }
}

/** Stage only explicitly selected, complete questions. A selected list is indivisible. */
/** @param {Questionnaire} questionnaire
 * @param {string} version
 * @param {string[]} selected
 * @param {Record<string, any>} drafts
 * @param {string} attemptId */
export function prepareSelectedSubmission(questionnaire, version, selected, drafts, attemptId) {
  const errors = [];
  /** @type {QuestionnaireAnswer[]} */
  const answers = [];
  const ids = new Set(selected);
  if (!selected.length || ids.size !== selected.length) errors.push('Select at least one distinct question to submit.');
  if (!attemptId || !version) errors.push('This submission needs an attempt ID and exact question version.');
  const seen = new Set();
  for (const section of questionnaire.sections) for (const question of section.questions) {
    seen.add(question.id);
    if (!ids.has(question.id)) continue;
    const draft = drafts[question.id];
    if (!draft || draft.kind !== question.kind) { errors.push(`${question.id}: answer this question before submitting.`); continue; }
    if (question.kind === 'choice') {
      if (draft.optionId && question.options.some((o) => o.id === draft.optionId) && !draft.other)
        answers.push({ questionId: question.id, kind: 'choice', optionId: draft.optionId });
      else if (question.allowOther && !draft.optionId && typeof draft.other === 'string' && draft.other.trim())
        answers.push({ questionId: question.id, kind: 'choice', other: draft.other });
      else errors.push(`${question.id}: choose one option or write an Other answer.`);
    } else if (question.kind === 'short') {
      if (typeof draft.text === 'string' && draft.text.trim())
        answers.push({ questionId: question.id, kind: 'short', text: draft.text });
      else errors.push(`${question.id}: write an answer before submitting.`);
    } else {
      const marks = Array.isArray(draft.marked) ? draft.marked : [];
      const marked = new Map(marks.map((m) => [m.itemId, m]));
      if (marked.size !== marks.length || marks.some((m) => !question.items.some((i) => i.id === m.itemId)
        || typeof m.correction !== 'string' || !m.correction.trim()))
        errors.push(`${question.id}: every marked item needs its own correction; no item has been approved yet.`);
      else answers.push({ questionId: question.id, kind: 'list', approveUnmarked: true,
        marked: question.items.filter((i) => marked.has(i.id)).map((i) => ({ itemId: i.id, correction: marked.get(i.id).correction })) });
    }
  }
  for (const id of ids) if (!seen.has(id)) errors.push(`${id}: this question is not in the displayed questionnaire.`);
  return errors.length ? { ok: false, errors } : { ok: true,
    value: { questionnaireId: questionnaire.id, version, attemptId, answers } };
}

const node = (tag, className, text) => {
  const el = document.createElement(tag);
  if (className) el.className = className;
  if (text !== undefined) el.textContent = text;
  return el;
};
const append = (parent, ...children) => { for (const child of children) parent.appendChild(child); return parent; };
const anchorId = (id, version) => `questionnaire-${encodeURIComponent(version.slice(0, 12))}-${encodeURIComponent(id)}`;

/**
 * Mounts a form and returns a disposer. Navigation scrolls to section IDs without changing
 * the app's hash route. Drafts stay on this device; only onSubmit can create a ruling.
 * @param {HTMLElement} host
 * @param {FormOptions} options
 */
export function mountQuestionnaire(host, options) {
  const { questionnaire: q, version, principal, onSubmit } = options;
  let storage;
  try { storage = options.storage ?? window.localStorage; }
  catch { storage = { getItem: () => null, setItem: () => { throw new Error('Local draft storage unavailable'); } }; }
  /** @type {LocalDraft} */
  let draft = loadQuestionnaireDraft(storage, principal, q.id, version);
  /** @type {{attemptId: string, payload: string}|null} */
  let pending = null;
  let busy = false;
  const persist = () => saveQuestionnaireDraft(storage, principal, q.id, version, draft);
  const root = node('div', 'questionnaire-form');
  const style = node('style', '', `.questionnaire-form{display:grid;gap:1rem}.questionnaire-form .q-section{border-top:1px solid #465064;padding-top:1rem}.questionnaire-form .q-question{border:1px solid #465064;border-radius:.5rem;padding:1rem;margin:.75rem 0}.questionnaire-form .q-items{display:grid;gap:.5rem}.questionnaire-form textarea{display:block;width:100%;min-height:4rem}.questionnaire-form .q-error{color:#f27b7b}.questionnaire-form .q-nav{display:flex;flex-wrap:wrap;gap:.5rem}.questionnaire-form .q-actions{display:flex;flex-wrap:wrap;gap:.5rem}`);
  append(root, style);
  append(root, node('h2', '', q.title));
  if (q.context) append(root, node('p', '', q.context));
  if (q.recipient) append(root, node('p', 'dim', `Routed to ${q.recipient}. Any team member may answer under their own identity.`));
  const notice = node('p', 'dim', 'Draft saved on this device only. Saving or leaving the page submits and approves nothing.');
  append(root, notice);
  const message = node('div', 'q-message');
  const nav = node('nav', 'q-nav');
  nav.setAttribute('aria-label', 'Questionnaire sections');
  for (const section of q.sections) {
    const button = node('button', 'pullbtn', section.title);
    button.type = 'button';
    button.addEventListener('click', () => root.querySelector(`#${CSS.escape(anchorId(section.id, version))}`)?.scrollIntoView());
    append(nav, button);
  }
  append(root, nav);
  const selectedCount = node('p', 'dim');
  /** @type {HTMLButtonElement|null} */
  let send = null;
  const count = () => {
    selectedCount.textContent = `${draft.selected.length} question${draft.selected.length === 1 ? '' : 's'} selected for explicit submission.`;
    if (send) {
      const includesList = q.sections.some((section) => section.questions.some((question) =>
        question.kind === 'list' && draft.selected.includes(question.id)));
      send.textContent = includesList
        ? 'Submit selected questions — approve unmarked items in selected lists' : 'Submit selected questions';
    }
  };
  count(); append(root, selectedCount);
  const setAnswer = (id, answer) => { draft.answers[id] = answer; persist(); };
  const select = (id, selected) => {
    draft.selected = selected ? [...new Set([...draft.selected, id])] : draft.selected.filter((x) => x !== id);
    persist(); count();
  };
  const submit = async (ids) => {
    if (busy) return;
    message.textContent = '';
    const attemptId = pending?.attemptId ?? crypto.randomUUID();
    const staged = prepareSelectedSubmission(q, version, ids, draft.answers, attemptId);
    if (!staged.ok) { message.className = 'q-message q-error'; message.textContent = staged.errors.join(' '); return; }
    const payload = JSON.stringify(staged.value);
    if (pending && pending.payload !== payload) {
      staged.value.attemptId = crypto.randomUUID();
    }
    pending = { attemptId: staged.value.attemptId, payload: JSON.stringify(staged.value) };
    busy = true;
    try {
      const result = await onSubmit(staged.value);
      if (!result || !('ok' in result) || result.ok !== true) throw new Error(result && 'error' in result ? result.error : 'Submission was not confirmed.');
      message.className = 'q-message';
      message.textContent = `Submitted ${ids.length} question${ids.length === 1 ? '' : 's'}. Receipt: ${result.receipt}`;
      draft.selected = draft.selected.filter((id) => !ids.includes(id));
      for (const id of ids) delete draft.answers[id];
      persist(); count(); pending = null;
      for (const id of ids) {
        const card = root.querySelector(`[data-question-id="${CSS.escape(id)}"]`);
        const checkbox = card?.querySelector('input[data-select-question]');
        if (checkbox instanceof HTMLInputElement) checkbox.checked = false;
        for (const input of card?.querySelectorAll('input') ?? []) {
          if (input instanceof HTMLInputElement && input !== checkbox) input.checked = false;
        }
        for (const area of card?.querySelectorAll('textarea') ?? []) {
          if (area instanceof HTMLTextAreaElement) { area.value = ''; area.disabled = !!area.placeholder.startsWith('Correction for'); }
        }
        if (card) append(card, node('p', 'dim', `Submitted. Receipt: ${result.receipt}. Enter a new answer to submit again.`));
      }
    } catch (e) { message.className = 'q-message q-error'; message.textContent = e instanceof Error ? e.message : String(e); }
    finally { busy = false; }
  };
  const sections = node('div', 'q-sections');
  for (const section of q.sections) {
    const sectionNode = node('section', 'q-section');
    sectionNode.id = anchorId(section.id, version);
    append(sectionNode, node('h3', '', section.title));
    if (section.context) append(sectionNode, node('p', 'dim', section.context));
    for (const question of section.questions) {
      const card = node('article', 'q-question');
      card.id = anchorId(question.id, version);
      card.dataset.questionId = question.id;
      const heading = node('h4', '', question.prompt);
      append(card, heading);
      if (question.context) append(card, node('p', 'dim', question.context));
      if (question.action) append(card, node('p', 'dim', `Action meaning: ${question.action}`));
      const picked = node('input'); picked.type = 'checkbox'; picked.dataset.selectQuestion = 'true';
      picked.checked = draft.selected.includes(question.id);
      picked.addEventListener('change', () => select(question.id, picked.checked));
      append(card, append(node('label'), picked, document.createTextNode(' Select this question for submission')));
      if (question.kind === 'choice') {
        for (const option of question.options) {
          const radio = node('input'); radio.type = 'radio'; radio.name = `${q.id}-${question.id}`;
          radio.checked = draft.answers[question.id]?.optionId === option.id;
          radio.addEventListener('change', () => setAnswer(question.id, { kind: 'choice', optionId: option.id }));
          append(card, append(node('label'), radio, document.createTextNode(` ${option.label}${option.description ? ` — ${option.description}` : ''}${option.action ? `; action: ${option.action}` : ''}`)));
        }
        if (question.allowOther) {
          const otherRadio = node('input'); otherRadio.type = 'radio'; otherRadio.name = `${q.id}-${question.id}`;
          otherRadio.checked = draft.answers[question.id]?.other !== undefined;
          const otherText = node('textarea'); otherText.placeholder = 'Your own answer';
          otherText.value = draft.answers[question.id]?.other ?? '';
          otherRadio.addEventListener('change', () => setAnswer(question.id, { kind: 'choice', other: otherText.value }));
          otherText.addEventListener('input', () => { otherRadio.checked = true; setAnswer(question.id, { kind: 'choice', other: otherText.value }); });
          append(card, append(node('label'), otherRadio, document.createTextNode(' Other — write your answer')), otherText);
        }
      } else if (question.kind === 'short') {
        const text = node('textarea'); text.value = draft.answers[question.id]?.text ?? '';
        text.addEventListener('input', () => setAnswer(question.id, { kind: 'short', text: text.value }));
        append(card, text);
      } else {
        append(card, node('p', 'dim', 'Submitting this list approves every unmarked item. Marked items each need a correction.'));
        const items = node('div', 'q-items');
        for (const item of question.items) {
          const row = node('div');
          const marked = node('input'); marked.type = 'checkbox';
          const existing = () => draft.answers[question.id]?.marked ?? [];
          marked.checked = existing().some((m) => m.itemId === item.id);
          const correction = node('textarea'); correction.placeholder = `Correction for ${item.text}`;
          correction.value = existing().find((m) => m.itemId === item.id)?.correction ?? '';
          correction.disabled = !marked.checked;
          const update = () => {
            const rest = existing().filter((m) => m.itemId !== item.id);
            setAnswer(question.id, { kind: 'list', marked: marked.checked
              ? [...rest, { itemId: item.id, correction: correction.value }] : rest });
          };
          marked.addEventListener('change', () => { correction.disabled = !marked.checked; update(); });
          correction.addEventListener('input', update);
          append(row, append(node('label'), marked, document.createTextNode(` Mark wrong: ${item.text}`)));
          if (item.context) append(row, node('p', 'dim', item.context));
          if (item.action) append(row, node('p', 'dim', `Action meaning: ${item.action}`));
          append(row, correction); append(items, row);
        }
        append(card, items);
      }
      const one = node('button', 'pullbtn', question.kind === 'list'
        ? 'Submit this list: approve unmarked items and send marked corrections' : 'Submit this answer');
      one.type = 'button'; one.addEventListener('click', () => submit([question.id]));
      append(card, one); append(sectionNode, card);
    }
    append(sections, sectionNode);
  }
  append(root, sections);
  const actions = node('div', 'q-actions');
  const save = node('button', 'pullbtn', 'Save draft on this device'); save.type = 'button';
  save.addEventListener('click', () => { notice.textContent = persist()
    ? 'Draft saved on this device only. No answer or approval was submitted.'
    : 'This browser could not save the draft. No answer or approval was submitted.'; });
  send = node('button', 'pullbtn', 'Submit selected questions'); send.type = 'button';
  count();
  send.addEventListener('click', () => submit([...draft.selected]));
  append(actions, save, send); append(root, actions, message);
  host.replaceChildren(root);
  return () => { if (host.contains(root)) host.removeChild(root); };
}
