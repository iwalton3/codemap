/** Pure questionnaire presentation and submission rules. The decision fold supplies authority. */
import { createHash } from "node:crypto";
import { canonical } from "./canonical.js";

export interface QuestionBase { id: string; prompt: string; context?: string; action?: string }
export type QuestionnaireQuestion =
  | (QuestionBase & { kind: "choice"; options: { id: string; label: string; description?: string; action?: string }[]; allowOther: boolean })
  | (QuestionBase & { kind: "short" })
  | (QuestionBase & { kind: "list"; items: { id: string; text: string; context?: string; action?: string }[] });
export interface Questionnaire {
  id: string; title: string; context?: string; recipient?: string;
  sections: { id: string; title: string; context?: string; questions: QuestionnaireQuestion[] }[];
}
export type QuestionnaireAnswer =
  | { questionId: string; kind: "choice"; optionId: string }
  | { questionId: string; kind: "choice"; other: string }
  | { questionId: string; kind: "short"; text: string }
  | { questionId: string; kind: "list"; approveUnmarked: true; marked: { itemId: string; correction: string }[] };
export interface SubmissionDraft {
  questionnaireId: string; version: string; attemptId: string; answers: QuestionnaireAnswer[];
}
export interface StagedSubmission {
  questionnaireId: string; version: string; attemptId: string; payloadHash: string;
  answers: QuestionnaireAnswer[];
  /** Explicit consequences of the one submitted list unit, never of a saved draft. */
  listApprovals: { questionId: string; approvedItemIds: string[]; correctedItemIds: string[] }[];
}
export type Validation<T> = { ok: true; value: T } | { ok: false; errors: string[] };

const obj = (x: unknown): x is Record<string, unknown> => !!x && typeof x === "object" && !Array.isArray(x);
const nonempty = (x: unknown): x is string => typeof x === "string" && !!x.trim();
const exact = (x: Record<string, unknown>, keys: string[]) => Object.keys(x).every((k) => keys.includes(k));
const hash = (x: unknown) => createHash("sha256").update(canonical(x)).digest("hex");
const unique = (xs: string[]) => new Set(xs).size === xs.length;

/** Reject ambiguous or incomplete publication before any answer can name it. */
export function validateQuestionnaire(q: unknown): Validation<Questionnaire> {
  const errors: string[] = [];
  if (!obj(q) || !nonempty(q.id) || !nonempty(q.title) || !Array.isArray(q.sections) || !q.sections.length)
    return { ok: false, errors: ["questionnaire needs an id, title and ordered sections"] };
  if (!exact(q, ["id", "title", "context", "recipient", "sections"])) errors.push("questionnaire has unknown display fields");
  if (q.context !== undefined && typeof q.context !== "string") errors.push("questionnaire context must be text");
  if (q.recipient !== undefined && !nonempty(q.recipient)) errors.push("recipient must be a nonempty principal name");
  const sectionIds: string[] = [], questionIds: string[] = [], itemIds: string[] = [];
  for (const section of q.sections) {
    if (!obj(section) || !nonempty(section.id) || !nonempty(section.title) || !Array.isArray(section.questions) || !section.questions.length) {
      errors.push("each section needs an id, title and ordered questions"); continue;
    }
    if (!exact(section, ["id", "title", "context", "questions"])) errors.push(`section ${section.id}: unknown display fields`);
    sectionIds.push(section.id);
    if (section.context !== undefined && typeof section.context !== "string") errors.push(`section ${section.id}: context must be text`);
    for (const question of section.questions) {
      if (!obj(question) || !nonempty(question.id) || !nonempty(question.prompt)) {
        errors.push(`section ${section.id}: each question needs an id and prompt`); continue;
      }
      if (!exact(question, question.kind === "choice" ? ["id", "kind", "prompt", "context", "action", "options", "allowOther"]
        : question.kind === "list" ? ["id", "kind", "prompt", "context", "action", "items"]
          : ["id", "kind", "prompt", "context", "action"])) errors.push(`question ${question.id}: unknown display fields`);
      questionIds.push(question.id);
      if (question.context !== undefined && typeof question.context !== "string") errors.push(`question ${question.id}: context must be text`);
      if (question.action !== undefined && typeof question.action !== "string") errors.push(`question ${question.id}: action must be text`);
      if (question.kind === "choice") {
        if (typeof question.allowOther !== "boolean" || !Array.isArray(question.options) || !question.options.length) {
          errors.push(`question ${question.id}: choice needs options and an explicit Other policy`); continue;
        }
        const optionIds: string[] = [];
        for (const option of question.options) {
          if (!obj(option) || !nonempty(option.id) || !nonempty(option.label)
            || (option.description !== undefined && typeof option.description !== "string")
            || (option.action !== undefined && typeof option.action !== "string")) {
            errors.push(`question ${question.id}: each option needs a stable id and label`); continue;
          }
          if (!exact(option, ["id", "label", "description", "action"])) errors.push(`question ${question.id}: option ${option.id} has unknown display fields`);
          optionIds.push(option.id);
        }
        if (!unique(optionIds)) errors.push(`question ${question.id}: option ids repeat`);
      } else if (question.kind === "list") {
        if (!Array.isArray(question.items) || !question.items.length) { errors.push(`question ${question.id}: list needs items`); continue; }
        for (const item of question.items) {
          if (!obj(item) || !nonempty(item.id) || !nonempty(item.text)
            || (item.context !== undefined && typeof item.context !== "string")
            || (item.action !== undefined && typeof item.action !== "string")) {
            errors.push(`question ${question.id}: each list item needs a stable id and text`); continue;
          }
          if (!exact(item, ["id", "text", "context", "action"])) errors.push(`question ${question.id}: item ${item.id} has unknown display fields`);
          itemIds.push(item.id);
        }
      } else if (question.kind !== "short") errors.push(`question ${question.id}: unknown answer format`);
    }
  }
  if (!unique(sectionIds)) errors.push("section ids repeat");
  if (!unique(questionIds)) errors.push("question ids repeat");
  if (!unique(itemIds)) errors.push("list item ids repeat");
  return errors.length ? { ok: false, errors } : { ok: true, value: q as unknown as Questionnaire };
}

/** Hash the whole frozen display, including descriptions, order, context and action meaning. */
export function questionnaireVersion(q: Questionnaire): string { return hash(q); }

/** Validate the selected batch as one unit. Nothing here appends or grants authority. */
export function stageSubmission(q: Questionnaire, input: unknown): Validation<StagedSubmission> {
  const publication = validateQuestionnaire(q);
  if (!publication.ok) return publication;
  if (!obj(input) || !nonempty(input.questionnaireId) || !nonempty(input.version)
    || !nonempty(input.attemptId) || !Array.isArray(input.answers) || !input.answers.length
    || !exact(input, ["questionnaireId", "version", "attemptId", "answers"]))
    return { ok: false, errors: ["submission needs exact questionnaire/version, attempt id and selected answers"] };
  const errors: string[] = [];
  const version = questionnaireVersion(q);
  if (input.questionnaireId !== q.id || input.version !== version) errors.push("questionnaire display changed; reload before submitting");
  const questions = new Map(q.sections.flatMap((s) => s.questions.map((x) => [x.id, x] as const)));
  const seen = new Set<string>();
  const answers: QuestionnaireAnswer[] = [];
  const listApprovals: StagedSubmission["listApprovals"] = [];
  for (const raw of input.answers) {
    if (!obj(raw) || !nonempty(raw.questionId) || seen.has(raw.questionId)) { errors.push("selected answers need distinct question ids"); continue; }
    seen.add(raw.questionId);
    const question = questions.get(raw.questionId);
    if (!question || raw.kind !== question.kind) { errors.push(`question ${raw.questionId}: unknown identity or answer format`); continue; }
    if (question.kind === "choice") {
      const hasOption = nonempty(raw.optionId), hasOther = nonempty(raw.other);
      if (hasOption === hasOther || !exact(raw, ["questionId", "kind", "optionId", "other"])) {
        errors.push(`question ${question.id}: select exactly one option or type Other`); continue;
      }
      if (hasOption && (!question.options.some((o) => o.id === raw.optionId) || raw.other !== undefined)) {
        errors.push(`question ${question.id}: selected option is not on the frozen question`); continue;
      }
      if (hasOther && (!question.allowOther || raw.optionId !== undefined)) {
        errors.push(`question ${question.id}: Other is unavailable`); continue;
      }
      answers.push(hasOption ? { questionId: question.id, kind: "choice", optionId: raw.optionId as string }
        : { questionId: question.id, kind: "choice", other: raw.other as string });
    } else if (question.kind === "short") {
      if (!nonempty(raw.text) || !exact(raw, ["questionId", "kind", "text"])) {
        errors.push(`question ${question.id}: short answer needs nonempty text`); continue;
      }
      answers.push({ questionId: question.id, kind: "short", text: raw.text });
    } else {
      if (raw.approveUnmarked !== true || !Array.isArray(raw.marked)
        || !exact(raw, ["questionId", "kind", "approveUnmarked", "marked"])) {
        errors.push(`question ${question.id}: explicitly approve unmarked items when submitting the list`); continue;
      }
      const marks: { itemId: string; correction: string }[] = [];
      const marked = new Set<string>();
      for (const item of raw.marked) {
        if (!obj(item) || !nonempty(item.itemId) || !nonempty(item.correction)
          || !exact(item, ["itemId", "correction"]) || marked.has(item.itemId)
          || !question.items.some((x) => x.id === item.itemId)) {
          errors.push(`question ${question.id}: each marked item needs its own correction and stable id`); continue;
        }
        marked.add(item.itemId);
        marks.push({ itemId: item.itemId, correction: item.correction });
      }
      if (marks.length !== raw.marked.length) continue;
      const byItem = new Map(marks.map((m) => [m.itemId, m] as const));
      answers.push({ questionId: question.id, kind: "list", approveUnmarked: true,
        marked: question.items.map((x) => byItem.get(x.id)).filter((x): x is { itemId: string; correction: string } => !!x) });
      listApprovals.push({ questionId: question.id,
        approvedItemIds: question.items.filter((x) => !marked.has(x.id)).map((x) => x.id),
        correctedItemIds: question.items.filter((x) => marked.has(x.id)).map((x) => x.id) });
    }
  }
  if (errors.length) return { ok: false, errors };
  const byId = new Map(answers.map((a) => [a.questionId, a] as const));
  const ordered = q.sections.flatMap((s) => s.questions.map((x) => byId.get(x.id)).filter((x): x is QuestionnaireAnswer => !!x));
  const payloadHash = hash({ questionnaireId: q.id, version, answers: ordered });
  return { ok: true, value: { questionnaireId: q.id, version, attemptId: input.attemptId,
    payloadHash, answers: ordered, listApprovals } };
}

/** A retried attempt may reuse its receipt only for identical payload identity. */
export function classifyAttempt(previous: { attemptId: string; payloadHash: string } | undefined,
  staged: StagedSubmission): "new" | "retry" | "conflict" {
  if (!previous || previous.attemptId !== staged.attemptId) return "new";
  return previous.payloadHash === staged.payloadHash ? "retry" : "conflict";
}
