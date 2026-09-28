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
/** `selected` holds the lists the person has marked as reviewed: submitting a list approves
 *  every unmarked item, so a list is never ready by default.
 *  @typedef {{selected: string[], answers: Record<string, any>}} LocalDraft */
/** @typedef {{questionnaire: Questionnaire, publicationId: string, version: string, principal: string,
 *   onSubmit: (payload: {questionnaireId: string, version: string, attemptId: string, answers: QuestionnaireAnswer[]}) => Promise<{ok: true, receipt: string} | {error: string}>,
 *   storage?: Storage }} FormOptions */

/** Publication ID, version and principal isolate each local draft. */
export const draftStorageKey = (principal, publicationId, version) =>
  `codemap.questionnaire.draft.${JSON.stringify([principal, publicationId, version])}`;

/** @returns {LocalDraft} */
export function loadQuestionnaireDraft(storage, principal, publicationId, version) {
  try {
    const raw = JSON.parse(storage.getItem(draftStorageKey(principal, publicationId, version)) || 'null');
    if (raw && Array.isArray(raw.selected) && raw.selected.every((x) => typeof x === 'string')
      && raw.answers && typeof raw.answers === 'object' && !Array.isArray(raw.answers)) return raw;
  } catch { /* Local storage can be unavailable or contain a damaged draft. */ }
  return { selected: [], answers: {} };
}

export function saveQuestionnaireDraft(storage, principal, publicationId, version, draft) {
  try { storage.setItem(draftStorageKey(principal, publicationId, version), JSON.stringify(draft)); return true; }
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
const append = (parent, ...children) => { for (const child of children) if (child) parent.appendChild(child); return parent; };
const anchorId = (id, version) => `questionnaire-${encodeURIComponent(version.slice(0, 12))}-${encodeURIComponent(id)}`;

const STYLE = `
  .questionnaire-form{--q-gap:1rem;display:flex;flex-direction:column;gap:var(--q-gap);max-width:52rem;margin:0 auto;min-width:0;overflow-wrap:anywhere;color:var(--text,#d7dde5)}
  .questionnaire-form *{box-sizing:border-box;min-width:0}
  .questionnaire-form .q-head h2{margin:0 0 .25rem;font-size:1.35rem;line-height:1.3}
  .questionnaire-form .q-head p{margin:.25rem 0;line-height:1.5}
  .questionnaire-form .q-muted{color:var(--dim,#8b95a3);font-size:.9rem;line-height:1.45}
  .questionnaire-form .q-progress{display:flex;flex-direction:column;gap:.35rem}
  .questionnaire-form .q-bar{height:.4rem;border-radius:1rem;background:var(--panel2,#1c232d);overflow:hidden}
  .questionnaire-form .q-bar>span{display:block;height:100%;background:var(--accent,#58a6ff);transition:width .2s}
  .questionnaire-form .q-nav{display:flex;gap:.4rem;overflow-x:auto;padding-bottom:.2rem;scrollbar-width:thin}
  .questionnaire-form .q-nav button{flex:0 0 auto}
  .questionnaire-form .q-section>h3{margin:.5rem 0 .25rem;font-size:1.05rem}
  .questionnaire-form .q-card{background:var(--panel,#161b22);border:1px solid var(--border,#2a313c);border-radius:.6rem;padding:1rem;margin:.75rem 0;display:flex;flex-direction:column;gap:.75rem}
  .questionnaire-form .q-card[data-state="ready"]{border-color:var(--accent,#58a6ff)}
  .questionnaire-form .q-card[data-state="submitted"]{border-color:var(--accent2,#7ee787)}
  .questionnaire-form .q-card-head{display:flex;justify-content:space-between;align-items:center;gap:.5rem}
  .questionnaire-form .q-num{font-weight:600;color:var(--dim,#8b95a3);font-size:.85rem}
  .questionnaire-form .q-chip{font-size:.75rem;padding:.1rem .5rem;border-radius:1rem;border:1px solid var(--border,#2a313c);color:var(--dim,#8b95a3);white-space:nowrap}
  .questionnaire-form [data-state="ready"] .q-chip{color:var(--accent,#58a6ff);border-color:var(--accent,#58a6ff)}
  .questionnaire-form [data-state="submitted"] .q-chip{color:var(--accent2,#7ee787);border-color:var(--accent2,#7ee787)}
  .questionnaire-form .q-prompt{white-space:pre-wrap;line-height:1.55;margin:0;font-size:1rem}
  .questionnaire-form .q-options{display:flex;flex-direction:column;gap:.5rem}
  .questionnaire-form .q-option{display:flex;gap:.65rem;align-items:flex-start;padding:.65rem .75rem;border:1px solid var(--border,#2a313c);border-radius:.5rem;cursor:pointer;background:var(--panel2,#1c232d)}
  .questionnaire-form .q-option:has(input:checked){border-color:var(--accent,#58a6ff)}
  .questionnaire-form .q-option input{margin-top:.2rem;flex:0 0 auto;width:1.05rem;height:1.05rem}
  .questionnaire-form .q-option-text{display:flex;flex-direction:column;gap:.2rem}
  .questionnaire-form .q-option-text b{font-weight:600}
  .questionnaire-form textarea{display:block;width:100%;min-height:4.5rem;resize:vertical;padding:.55rem .65rem;border-radius:.45rem;border:1px solid var(--border,#2a313c);background:var(--bg,#0e1116);color:inherit;font:inherit;line-height:1.45}
  .questionnaire-form textarea:focus{outline:2px solid var(--accent,#58a6ff);outline-offset:1px}
  .questionnaire-form .q-item{padding:.65rem .75rem;border:1px solid var(--border,#2a313c);border-radius:.5rem;background:var(--panel2,#1c232d);display:flex;flex-direction:column;gap:.45rem}
  .questionnaire-form .q-item[data-marked]{border-color:var(--warn,#f0a35e)}
  .questionnaire-form .q-item-head{display:flex;justify-content:space-between;align-items:flex-start;gap:.75rem}
  .questionnaire-form .q-toggle{display:flex;gap:.4rem;align-items:center;white-space:nowrap;cursor:pointer}
  .questionnaire-form .q-reviewed{display:flex;gap:.5rem;align-items:flex-start;cursor:pointer;line-height:1.45}
  .questionnaire-form .q-card-foot{display:flex;justify-content:flex-end;gap:.5rem;flex-wrap:wrap}
  .questionnaire-form button.pullbtn{white-space:normal;padding:.45rem .8rem;font-size:.9rem}
  .questionnaire-form button.q-primary{background:var(--accent,#58a6ff);color:#0e1116;border-color:var(--accent,#58a6ff);font-weight:600}
  .questionnaire-form button.q-primary:disabled{background:var(--panel2,#1c232d);color:var(--dim,#8b95a3);border-color:var(--border,#2a313c)}
  .questionnaire-form .q-bottom{position:sticky;bottom:0;display:flex;flex-wrap:wrap;gap:.5rem;align-items:center;justify-content:space-between;padding:.75rem;background:var(--panel,#161b22);border:1px solid var(--border,#2a313c);border-radius:.6rem}
  .questionnaire-form .q-message{margin:0}
  .questionnaire-form .q-error{color:var(--bad,#f27b7b)}
  @media (max-width:600px){
    .questionnaire-form{--q-gap:.75rem}
    .questionnaire-form .q-card{padding:.8rem}
    .questionnaire-form .q-item-head{flex-direction:column;gap:.35rem}
    .questionnaire-form .q-bottom{flex-direction:column;align-items:stretch}
    .questionnaire-form .q-bottom button{width:100%}
  }
`;

/**
 * Mounts a form and returns a disposer. Drafts save on this device as you type; only a submit
 * button records an answer, and only for questions whose answer is complete ("ready").
 * @param {HTMLElement} host
 * @param {FormOptions} options
 */
export function mountQuestionnaire(host, options) {
  const { questionnaire: q, publicationId, version, principal, onSubmit } = options;
  let storage;
  try { storage = options.storage ?? window.localStorage; }
  catch { storage = { getItem: () => null, setItem: () => { throw new Error('Local draft storage unavailable'); } }; }
  /** @type {LocalDraft} */
  let draft = loadQuestionnaireDraft(storage, principal, publicationId, version);
  /** @type {{attemptId: string, payload: string}|null} */
  let pending = null;
  let busy = false;
  const submitted = new Set();
  const questions = q.sections.flatMap((section) => section.questions);
  const persisted = node('span', 'q-muted', 'Draft saves on this device as you type. Nothing is sent until you submit.');
  const persist = () => {
    persisted.textContent = saveQuestionnaireDraft(storage, principal, publicationId, version, draft)
      ? 'Draft saved on this device. Nothing is sent until you submit.'
      : 'This browser could not save the draft. Nothing was sent.';
  };
  const ready = (id) => {
    const question = questions.find((x) => x.id === id);
    if (!question || submitted.has(id)) return false;
    if (question.kind === 'list' && !draft.selected.includes(id)) return false;
    return prepareSelectedSubmission(q, version, [id], draft.answers, 'check').ok;
  };

  const root = node('div', 'questionnaire-form');
  append(root, node('style', '', STYLE));
  const head = append(node('header', 'q-head'), node('h2', '', q.title), q.context ? node('p', '', q.context) : null,
    node('p', 'q-muted', q.recipient ? `Asked of ${q.recipient}. Anyone on the team may answer, as themselves.` : 'Anyone on the team may answer, as themselves.'));
  append(root, head);

  const progressText = node('span', 'q-muted');
  const bar = node('div', 'q-bar'); const fill = node('span'); append(bar, fill);
  append(root, append(node('div', 'q-progress'), progressText, bar));

  if (q.sections.length > 1) {
    const nav = node('nav', 'q-nav'); nav.setAttribute('aria-label', 'Questionnaire sections');
    for (const section of q.sections) {
      const button = node('button', 'pullbtn', section.title); button.type = 'button';
      button.addEventListener('click', () => root.querySelector(`#${CSS.escape(anchorId(section.id, version))}`)?.scrollIntoView({ block: 'start' }));
      append(nav, button);
    }
    append(root, nav);
  }

  /** @type {Map<string, {card: HTMLElement, chip: HTMLElement, one: HTMLButtonElement, clear: () => void}>} */
  const cards = new Map();
  const sendAll = /** @type {HTMLButtonElement} */ (node('button', 'pullbtn q-primary'));
  sendAll.type = 'button';
  const message = node('p', 'q-message'); message.setAttribute('role', 'status'); message.setAttribute('aria-live', 'polite');

  const refresh = () => {
    const readyIds = questions.map((x) => x.id).filter(ready);
    const done = submitted.size;
    progressText.textContent = `${readyIds.length} ready to submit · ${done} submitted here · ${questions.length} question${questions.length === 1 ? '' : 's'}`;
    fill.style.width = `${Math.round(((readyIds.length + done) / Math.max(questions.length, 1)) * 100)}%`;
    const lists = readyIds.some((id) => questions.find((x) => x.id === id)?.kind === 'list');
    sendAll.textContent = readyIds.length
      ? `Submit ${readyIds.length} ready answer${readyIds.length === 1 ? '' : 's'}${lists ? ' (approves unmarked list items)' : ''}`
      : 'Answer a question to submit it';
    sendAll.disabled = busy || !readyIds.length;
    for (const [id, c] of cards) {
      const state = submitted.has(id) ? 'submitted' : ready(id) ? 'ready' : 'draft';
      c.card.dataset.state = state;
      c.chip.textContent = state === 'submitted' ? 'Submitted' : state === 'ready' ? 'Ready' : 'Not answered';
      c.one.disabled = busy || state !== 'ready';
    }
  };
  const setAnswer = (id, answer) => { draft.answers[id] = answer; persist(); refresh(); };
  const setReviewed = (id, on) => {
    draft.selected = on ? [...new Set([...draft.selected, id])] : draft.selected.filter((x) => x !== id);
    persist(); refresh();
  };

  const submit = async (ids) => {
    if (busy || !ids.length) return;
    message.className = 'q-message'; message.textContent = '';
    const attemptId = pending?.attemptId ?? crypto.randomUUID();
    const staged = prepareSelectedSubmission(q, version, ids, draft.answers, attemptId);
    if (!staged.ok) { message.className = 'q-message q-error'; message.textContent = staged.errors.join(' '); return; }
    // A changed payload is a new attempt; resending the same one reuses its id, so a retry
    // after a lost response cannot record the answer twice.
    if (pending && pending.payload !== JSON.stringify(staged.value)) staged.value.attemptId = crypto.randomUUID();
    pending = { attemptId: staged.value.attemptId, payload: JSON.stringify(staged.value) };
    busy = true; refresh();
    try {
      const result = await onSubmit(staged.value);
      if (!result || !('ok' in result) || result.ok !== true) throw new Error(result && 'error' in result ? result.error : 'Submission was not confirmed.');
      message.textContent = `Submitted ${ids.length} answer${ids.length === 1 ? '' : 's'}. Receipt: ${result.receipt}. To change one later, revise or withdraw it on the decisions page.`;
      draft.selected = draft.selected.filter((id) => !ids.includes(id));
      for (const id of ids) { delete draft.answers[id]; submitted.add(id); cards.get(id)?.clear(); }
      persist(); pending = null;
    } catch (e) { message.className = 'q-message q-error'; message.textContent = e instanceof Error ? e.message : String(e); }
    finally { busy = false; refresh(); }
  };

  let number = 0;
  const sections = node('div', 'q-sections');
  for (const section of q.sections) {
    const sectionNode = node('section', 'q-section');
    sectionNode.id = anchorId(section.id, version);
    if (q.sections.length > 1 || section.title) append(sectionNode, node('h3', '', section.title));
    if (section.context) append(sectionNode, node('p', 'q-muted', section.context));
    for (const question of section.questions) {
      number++;
      const card = node('article', 'q-card');
      card.id = anchorId(question.id, version);
      card.dataset.questionId = question.id;
      const chip = node('span', 'q-chip');
      append(card, append(node('div', 'q-card-head'), node('span', 'q-num', `Question ${number}`), chip));
      append(card, node('p', 'q-prompt', question.prompt));
      if (question.context) append(card, node('p', 'q-muted', question.context));
      if (question.action) append(card, node('p', 'q-muted', `What your answer does: ${question.action}`));
      const inputs = [];
      if (question.kind === 'choice') {
        const options = node('div', 'q-options'); options.setAttribute('role', 'radiogroup');
        for (const option of question.options) {
          const radio = node('input'); radio.type = 'radio'; radio.name = `${q.id}-${question.id}`;
          radio.checked = draft.answers[question.id]?.optionId === option.id;
          radio.addEventListener('change', () => setAnswer(question.id, { kind: 'choice', optionId: option.id }));
          const text = append(node('span', 'q-option-text'), node('b', '', option.label),
            option.description ? node('span', 'q-muted', option.description) : null,
            option.action ? node('span', 'q-muted', `Does: ${option.action}`) : null);
          append(options, append(node('label', 'q-option'), radio, text));
          inputs.push(radio);
        }
        if (question.allowOther) {
          const otherRadio = node('input'); otherRadio.type = 'radio'; otherRadio.name = `${q.id}-${question.id}`;
          otherRadio.checked = draft.answers[question.id]?.other !== undefined;
          const otherText = node('textarea'); otherText.placeholder = 'Your own answer';
          otherText.value = draft.answers[question.id]?.other ?? '';
          otherText.hidden = !otherRadio.checked;
          otherRadio.addEventListener('change', () => { otherText.hidden = false; otherText.focus(); setAnswer(question.id, { kind: 'choice', other: otherText.value }); });
          otherText.addEventListener('input', () => { otherRadio.checked = true; setAnswer(question.id, { kind: 'choice', other: otherText.value }); });
          for (const radio of inputs) radio.addEventListener('change', () => { otherText.hidden = true; });
          append(options, append(node('label', 'q-option'), otherRadio, append(node('span', 'q-option-text'), node('b', '', 'Other'), node('span', 'q-muted', 'Answer in your own words'))), otherText);
          inputs.push(otherRadio, otherText);
        }
        append(card, options);
      } else if (question.kind === 'short') {
        const text = node('textarea'); text.value = draft.answers[question.id]?.text ?? '';
        text.setAttribute('aria-label', `Answer to question ${number}`);
        text.addEventListener('input', () => setAnswer(question.id, { kind: 'short', text: text.value }));
        append(card, text); inputs.push(text);
      } else {
        append(card, node('p', 'q-muted', 'Every item you leave unmarked is approved when this list is submitted. Mark an item wrong to give a correction instead.'));
        const items = node('div', 'q-options');
        const existing = () => draft.answers[question.id]?.marked ?? [];
        for (const item of question.items) {
          const row = node('div', 'q-item');
          const marked = node('input'); marked.type = 'checkbox';
          marked.checked = existing().some((m) => m.itemId === item.id);
          const correction = node('textarea'); correction.placeholder = `Correction for ${item.text}`;
          correction.value = existing().find((m) => m.itemId === item.id)?.correction ?? '';
          correction.hidden = !marked.checked; correction.disabled = !marked.checked;
          if (marked.checked) row.dataset.marked = '';
          const update = () => {
            const rest = existing().filter((m) => m.itemId !== item.id);
            setAnswer(question.id, { kind: 'list', marked: marked.checked ? [...rest, { itemId: item.id, correction: correction.value }] : rest });
          };
          marked.addEventListener('change', () => {
            correction.hidden = !marked.checked; correction.disabled = !marked.checked;
            if (marked.checked) { row.dataset.marked = ''; correction.focus(); } else delete row.dataset.marked;
            update();
          });
          correction.addEventListener('input', update);
          const text = append(node('span', 'q-option-text'), node('span', '', item.text),
            item.context ? node('span', 'q-muted', item.context) : null, item.action ? node('span', 'q-muted', `Does: ${item.action}`) : null);
          append(row, append(node('div', 'q-item-head'), text, append(node('label', 'q-toggle'), marked, document.createTextNode(' Mark wrong'))), correction);
          append(items, row); inputs.push(marked, correction);
        }
        append(card, items);
        const reviewed = node('input'); reviewed.type = 'checkbox'; reviewed.checked = draft.selected.includes(question.id);
        reviewed.addEventListener('change', () => {
          if (reviewed.checked && !draft.answers[question.id]) draft.answers[question.id] = { kind: 'list', marked: [] };
          setReviewed(question.id, reviewed.checked);
        });
        append(card, append(node('label', 'q-reviewed'), reviewed, document.createTextNode(' I have reviewed every item in this list')));
        inputs.push(reviewed);
      }
      const one = /** @type {HTMLButtonElement} */ (node('button', 'pullbtn', question.kind === 'list'
        ? 'Submit this list (approves unmarked items)' : 'Submit this answer'));
      one.type = 'button'; one.addEventListener('click', () => submit([question.id]));
      append(card, append(node('div', 'q-card-foot'), one));
      cards.set(question.id, { card, chip, one, clear: () => {
        for (const input of inputs) {
          if (input instanceof HTMLInputElement) input.checked = false;
          else if (input instanceof HTMLTextAreaElement) { input.value = ''; if (input.placeholder.startsWith('Correction for')) { input.hidden = true; input.disabled = true; } }
        }
        for (const row of card.querySelectorAll('[data-marked]')) delete (/** @type {HTMLElement} */ (row)).dataset.marked;
      } });
      append(sectionNode, card);
    }
    append(sections, sectionNode);
  }
  append(root, sections);
  sendAll.addEventListener('click', () => submit(questions.map((x) => x.id).filter(ready)));
  append(root, append(node('div', 'q-bottom'), persisted, sendAll), message);
  refresh();
  host.replaceChildren(root);
  return () => { if (host.contains(root)) host.removeChild(root); };
}
