/**
 * A ruling application's references into the decisions log (docs/sidecar-references.md, rows
 * 29-31 for findings, 78-80 for bugs): the round, the decision and the answer it applies must
 * exist in `decisions/<u>`. Raw events, not the decisions fold, which imports the issue folds.
 * Existence only; whether the answer still has authority is the op's question.
 */
import { readScope, type LogEvent } from "./eventlog.js";
import { questionnaireAnswerId } from "./ruling-application.js";
import type { Refusal } from "./validation.js";

type Data = Record<string, unknown>;

export async function rulingReferences(logRoot: string, universe: string, e: LogEvent): Promise<Refusal[]> {
  const refused = (why: string): Refusal[] => [{ id: e.id, kind: e.kind, cls: "reference", why }];
  const r = (e.data as Data | undefined)?.capsule as { version?: unknown; ruling?: Record<string, unknown> } | undefined;
  const { answerId, roundId, questionId } = r?.ruling ?? {};
  // The fold refuses a capsule without these, and skips a dev-era one.
  if (r?.version !== 3 || typeof answerId !== "string" || typeof roundId !== "string" || typeof questionId !== "string") return [];
  const at = `decisions/${universe}`;
  const events = await readScope(logRoot, at);
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
