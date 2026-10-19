/**
 * A ruling application's references into the decisions log (docs/sidecar-references.md, rows
 * 29-31 for findings, 78-80 for bugs): the round, the decision and the answer it applies must
 * exist in a decisions scope — the workspace's `law/decisions` or a legacy `decisions/<u>`. Raw
 * events, not the decisions fold, which imports the issue folds.
 * Existence only; whether the answer still has authority is the op's question.
 */
import type { LogEvent, ScopeReader } from "./eventlog.js";
import { questionnaireAnswerId } from "./ruling-application.js";
import type { Refusal } from "./validation.js";

type Data = Record<string, unknown>;

/** Every decisions scope's events — `shared-decisions.ts isDecisionScope`, spelled out because the
 *  issue folds that import this module sit under that one. A decision is cited by id wherever it
 *  was posted. */
const DECISIONS = "the decisions log";
async function decisionEvents(read: ScopeReader): Promise<LogEvent[]> {
  const scopes = (await read.scopes()).filter((s) => s === "law/decisions" || s.startsWith("decisions/"));
  return (await Promise.all(scopes.map((s) => read.read(s)))).flat();
}

export async function rulingReferences(read: ScopeReader, e: LogEvent): Promise<Refusal[]> {
  const refused = (why: string): Refusal[] => [{ id: e.id, kind: e.kind, cls: "reference", why }];
  const r = (e.data as Data | undefined)?.capsule as { version?: unknown; ruling?: Record<string, unknown> } | undefined;
  const { answerId, roundId, questionId } = r?.ruling ?? {};
  // The fold refuses a capsule without these, and skips a dev-era one.
  if (r?.version !== 3 || typeof answerId !== "string" || typeof roundId !== "string" || typeof questionId !== "string") return [];
  const at = DECISIONS;
  const events = await decisionEvents(read);
  const round = events.find((x) => x.kind === "decision.round.posted" && x.id === roundId);
  if (!round) return refused(`no round ${roundId} in ${at}`);
  // A decision's id is `<round event id>:<its label>`.
  const labels = ((round.data as Data | undefined)?.decisions as { id?: unknown }[] | undefined) ?? [];
  const label = labels.map((x) => String(x?.id)).find((l) => `${roundId}:${l}` === questionId);
  if (label === undefined) return refused(`round ${roundId} posted no decision ${questionId}`);
  // An answer names its decision by id, or by label when that label is unique.
  const answered = events.some((x) =>
    ((x.kind === "decision.answer.recorded" || x.kind === "decision.answer.revised") && x.id === answerId
      && [questionId, label].includes((x.data as Data | undefined)?.decision as string))
    || (x.kind === "decision.questionnaire.submitted" && (((x.data as Data | undefined)?.staged as { answers?: { questionId?: unknown }[] } | undefined)?.answers ?? [])
      .some((a) => `${roundId}:${String(a?.questionId)}` === questionId && questionnaireAnswerId(x.id, String(a.questionId)) === answerId)));
  return answered ? [] : refused(`no answer ${answerId} to ${questionId} in ${at}`);
}

/**
 * An operation sign-off's references into the decisions log (rows 139-140): the answer it
 * relays and the decision it answers exist in the scope the capsule names.
 */
export async function signoffReferences(read: ScopeReader, e: LogEvent): Promise<Refusal[]> {
  const r = ((e.data as Data | undefined)?.capsule as { ruling?: Record<string, unknown> } | undefined)?.ruling;
  const { answerId, decisionId, sourceScope } = r ?? {};
  // The fold refuses a capsule without these.
  if (typeof answerId !== "string" || typeof decisionId !== "string" || typeof sourceScope !== "string"
    || (sourceScope !== "law/decisions" && !sourceScope.startsWith("decisions/"))) return [];
  const refused = (why: string): Refusal[] => [{ id: e.id, kind: e.kind, cls: "reference", why }];
  const events = await read.read(sourceScope);
  const decided = events.some((x) => (x.kind === "decision.confirm.posted" && x.id === decisionId)
    || (x.kind === "decision.round.posted" && (((x.data as Data | undefined)?.decisions as { id?: unknown }[] | undefined) ?? [])
      .some((q) => `${x.id}:${String(q?.id)}` === decisionId)));
  if (!decided) return refused(`no decision ${decisionId} in ${sourceScope}`);
  const answered = events.some((x) => x.id === answerId || (x.kind === "decision.questionnaire.submitted"
    && (((x.data as Data | undefined)?.staged as { answers?: { questionId?: unknown }[] } | undefined)?.answers ?? [])
      .some((a) => questionnaireAnswerId(x.id, String(a?.questionId)) === answerId)));
  return answered ? [] : refused(`no answer ${answerId} in ${sourceScope}`);
}

/**
 * A repair sort's references into the decisions log (docs/sidecar-references.md A8): each
 * `decision:<id>` entry in `restsOn` names a decision in a decisions scope, and each release ruling
 * an answer to its decision there (owner, D2). Existence only; whether the answer stands is the
 * op's question, and verification re-checks it through the evidence's `rulingIds`.
 */
export async function repairSortReferences(read: ScopeReader, e: LogEvent): Promise<Refusal[]> {
  const d = e.data as Data | undefined;
  const entries = (Array.isArray(d?.restsOn) ? d.restsOn : []).filter((x): x is string => typeof x === "string" && x.startsWith("decision:")).map((x) => x.slice("decision:".length));
  const rulings = (((d?.release as Data | undefined)?.rulings as { decision?: unknown; answer?: unknown }[] | undefined) ?? [])
    .filter((r) => typeof r?.decision === "string" && typeof r?.answer === "string") as { decision: string; answer: string }[];
  if (!entries.length && !rulings.length) return [];
  const at = DECISIONS;
  const events = await decisionEvents(read);
  // A decision's id is `<round event id>:<its label>`, or a confirm's own event id.
  const labelOf = (id: string): string | undefined => {
    for (const x of events) {
      if (x.kind === "decision.confirm.posted" && x.id === id) return id;
      if (x.kind !== "decision.round.posted") continue;
      const label = (((x.data as Data | undefined)?.decisions as { id?: unknown }[] | undefined) ?? []).map((q) => String(q?.id)).find((l) => `${x.id}:${l}` === id);
      if (label !== undefined) return label;
    }
  };
  const refused = (why: string): Refusal[] => [{ id: e.id, kind: e.kind, cls: "reference", why }];
  for (const id of [...entries, ...rulings.map((r) => r.decision)]) if (labelOf(id) === undefined) return refused(`no decision ${id} in ${at}`);
  for (const r of rulings) {
    const label = labelOf(r.decision)!;
    const answered = events.some((x) => ((x.kind === "decision.answer.recorded" || x.kind === "decision.answer.revised") && x.id === r.answer
      && [r.decision, label].includes((x.data as Data | undefined)?.decision as string))
      || (x.kind === "decision.questionnaire.submitted" && questionnaireAnswerId(x.id, label) === r.answer));
    if (!answered) return refused(`no answer ${r.answer} to ${r.decision} in ${at}`);
  }
  return [];
}
