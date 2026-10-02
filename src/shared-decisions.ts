/**
 * Decision rounds, folded from `decisions/<universe>`.
 *
 * Five events: `decision.round.posted`, `decision.confirm.posted`, `decision.question.logged`,
 * `decision.answer.recorded` and `decision.reading.recorded`. The rules are the owner's, word
 * for word in docs/decision-rounds-worked-cases.md and the review rounds' `owner.md` files;
 * the C/H/S-numbers below are theirs.
 *
 * **A ruling is not its carrying-out.** The answer is the person's ruling and stands as given.
 * Carrying it out — closing a finding — is the verifier's act (I9) or a person's in session, in
 * the FINDINGS scope. So this record never stores "carried out": the finding record is the one
 * authority for that, and `ruledNotCarriedOut` joins the two at read time.
 *
 * **Which answer stands is derived from the set, never from recording order** (owner, 2026-09-23,
 * plan A2). The fold records each answer's facts; `standing` ranks them when read: verified
 * before unverified, then the later GIVEN, then the later in the log. Nothing here marks an
 * answer "superseded" — a flag set in recording order is how the same two events gave two
 * rulings in two orders.
 *
 * **Verification happens before the log** (owner: "verification needs to happen before it ends
 * up in the fold"). A logged question, a relayed message or a reader's `submit_verdict` was checked
 * against the transcript on the machine that asked; a clone cannot re-read that transcript and
 * trusts the logger for it. Everything that travels is checked here.
 */
import { registerKinds, registerReferences, tipReader, type ScopeReader } from "./eventlog.js";
import { createHash } from "node:crypto";
import { comparisonContextHash, deriveComparison, validateComparisonRequest, type AnswerSource, type CanonicalIssue, type ComparisonProjection, type ComparisonRequest, type ReaderJudgment, type HumanResolution } from "./decision-comparison.js";
import { readSets, readScope, registerDoor, scopesOnDisk, type DoorFold, type LogEvent, type ReadSets } from "./eventlog.js";
import { emitEventChecked } from "./write.js";
import { foldJudged, shaped, type Refusal } from "./validation.js";
import { decisionDevEra, decisionEventShape } from "./log-shape.js";
import { isAgentActor } from "./identity.js";
import { questionnaireAnswerId } from "./ruling-application.js";
import { canonicalIssueKey, type CanonicalIssueReference } from "./decision-issues.js";
import { questionnaireVersion, stageSubmission, validateQuestionnaire, type Questionnaire, type QuestionnaireAnswer, type StagedSubmission } from "./questionnaire.js";
import { canonical, codeUnitOrder, normalizeQuestion, sameQuestion } from "./transcript.js";
import { ISO_DATE, type Actor, type AskedQuestion, type Decision, type DecisionEffect, type DecisionOption, type DecisionRound, type LoggedQuestion } from "./schema.js";

export const decisionScope = (universe: string): string => `decisions/${universe}`;

export const loggedQuestionOnce = (q: Pick<LoggedQuestion, "session" | "toolUseId">): string => `q:${q.session}\0${q.toolUseId}`;

/** How an answer reached the log. */
export type AnswerVia =
  /** An `AskUserQuestion` call, logged by `log_question`. */
  | { kind: "question"; question: string }
  /** The person's whole typed message, copied from the transcript by its entry id, with
   *  when they typed it and the round the relaying agent says it answered (H5). */
  | { kind: "message"; session: string; entryId: string; text: string; at: string; round: string }
  /** Verified transcript relay of an exact, fully displayed revision question. */
  | { kind: "revision-relay"; proof: {
    session: string; toolUseId: string; entryId: string; answeredAt: string;
    question: AskedQuestion; answer: string } }
  /** An agent's words the transcript could not confirm. Unblocks only (C8). */
  | { kind: "unverified"; words: string }
  /** The person on the page. `checked` is a bulk decision's items to rule on separately. */
  | { kind: "direct"; option?: string; park?: string; words?: string; checked?: string[] };

export interface Mapping { decision: string; option: string | null }

/** One effect an answer ruled, finding by finding. */
export interface Ruled { finding: string; on: "settle" | "unblock"; as?: "refuted" | "accepted" }

export interface FoldedAnswer {
  id: string;
  by: Actor;
  at: string;
  via: AnswerVia["kind"] | "questionnaire";
  /** The words are the person's (C8): an unverified answer's settles wait for them. */
  verified: boolean;
  /** When the person gave it — the transcript entry's time, or the page's — never when it
   *  was recorded: between two verified answers, the later GIVEN stands (H7.9). */
  givenAt: string;
  /** Log position of the event that made it: breaks a tie in `givenAt` (S0.5). */
  seq: number;
  /** Original answer event for a reading copied onto another question. */
  sourceAnswer?: string;
  /** A verified choice keeps this source visible but removes it from actionable ranking. */
  resolvedOutBy?: string;
  /** Human comparison choice excludes this answer only on the named issue scope. */
  comparisonLostOn?: (CanonicalIssue & { by: string })[];
  /** A verified informed revision by another principal replaces this source only here. */
  revisedOutOn?: ({ kind: "finding" | "bug" | "decision"; id: string; universe?: string; scope?: string; by: string })[];
  /** Changed source response: historical evidence remains, pending authority does not. */
  cancelled?: { by: string; reason: string };
  /** An explicit withdrawal retired this source and every older answer by its principal. */
  withdrawn?: { by: string; reason: string };
  /** A human correction of named source answer(s), limited to these findings. */
  revision?: { of: string[]; findings: string[]; issues?: CanonicalIssueReference[];
    resolves?: { answers: [string, string]; priorResolution: string; shownHash: string } };
  revisionInvalid?: string;
  /** Source receipt for a selected question in one atomic stakeholder submission. */
  questionnaire?: { id: string; publication?: string; version: string; submission: string; attemptId: string; payloadHash: string;
    questionId: string; answer: QuestionnaireAnswer; approvals?: string[];
    corrections?: { itemId: string; text: string; verdict: "pending" }[] };
  /** What it was given through, so one call or message answers a decision once (B1.4). */
  once?: string;
  /** The person's words as recorded — never an agent's summary of them. */
  words: string;
  /** Identity of the response before interpretation (selected options versus free text). */
  responseHash: string;
  /** The options (or bulk items) this answer ruled, directly or through a binding. */
  options: string[];
  /** What those options rule, finding by finding. */
  ruled: Ruled[];
  /** Settles it chose but could not rule, because it is unverified (C8). They wait for you. */
  unruled: string[];
  park?: string;
  /** An unverified park: it applies nothing and waits for you (owner: "an awaits you flag"). */
  parkWaits?: string;
  /** Bulk items checked to be ruled on separately; each waits for a decision of its own. */
  separately?: string[];
  /** Words waiting for a binding — unread, read as unclear, or read two ways. Outside the
   *  ranking until bound (plan A2): typed words compete only once something binds them. */
  free: boolean;
  /** Bound, and bound to no option here (`D<n> → (none)`): it ranks, rules nothing, and
   *  waits on the person (S0.5). */
  nothing?: true;
  /** Bound, and about OTHER questions only: it answers nothing here and never ranks here. */
  elsewhere?: true;
  relayedBy?: string;
  /** The reader's verdict, parsed by codemap from the reader's own `submit_verdict` call (plan B1, Q2.2). */
  reading?: {
    id: string; agree: boolean;
    reader: { agent: string; maps: Mapping[]; launchedAt: string };
    session: { reading: string; maps: Mapping[] };
    asks?: string;
    /** The reader could not tell which question the words answer, and why: nothing binds (H5). */
    unclear?: string;
  };
  /** Bound by a person's pick on a confirm of these words: `answer` is that pick, `by` its
   *  confirmer, who rules through it (R3). `by` on the answer stays the words' author. */
  confirmed?: { answer: string; at: string; maps: Mapping[]; by: Actor };
  /** Who rules through these words: the confirmer when a confirm bound them. Read it with `rulerOf`. */
  ruledBy?: Actor;
  /** Two people answered the same reading of these words differently: held unbound (R3). */
  confirmDispute?: { readings: Mapping[][]; picks: string[] };
  /** Readings the person said were not what they meant — never offered again. */
  rejected?: Mapping[][];
  /** Accepted, but looks errant — shown, never silently applied as if ordinary (R19). */
  flags?: string[];
}

export interface WithdrawalRecord {
  id: string; by: Actor; at: string; reason: string; answer?: string;
  /** `settled`: the same withdrawal was already in place — a no-op, not a refusal (owner, Q5). */
  knownAnswers: string[]; state: "applied" | "refused" | "settled";
  /** Why the fold refused it: kept visible, never silently dropped. */
  refused?: string;
  /** The relayed question the person answered "Withdraw it" on. */
  relay?: string;
}

// --- withdrawal (owner, 2026-09-28: "Readers for unanswered, me for rulings, allow relay via
// verified question system and agents to report ruling conflicts and possible erroneous rulings")

export const WITHDRAW_IT = "Withdraw it", KEEP_IT = "Keep it";

/** The verified question that asks a person whether to retire their ruling. `report_ruling`
 *  posts it; the fold checks a relayed withdrawal against exactly this text. */
export function withdrawalQuestion(d: Pick<FoldedDecision, "id" | "ref" | "payload">, ruling: Pick<FoldedAnswer, "id" | "by" | "words" | "ruledBy">,
  reason: string, ref: string): AskedQuestion {
  return {
    question: `${ref}: Withdraw ${rulerOf(ruling).principal}'s ruling ${ruling.id} on ${d.ref} (${d.id})? `
      + `The question was ${JSON.stringify(d.payload.question)}; the ruling said ${JSON.stringify(ruling.words)}. `
      + `Reported as possibly wrong or in conflict: ${JSON.stringify(reason)}`,
    options: [{ label: WITHDRAW_IT, description: "Retire this ruling; a new instruction needs a fresh question" },
      { label: KEEP_IT, description: "The ruling stands" }],
    multiSelect: false,
  };
}

/** One reader's recorded verdict on withdrawing an unanswered question. */
export interface WithdrawalReviewReceipt { id: string; session: string; launch: string; briefHash: string; verdict: "sound" | "unsound"; rationale: string }
export interface WithdrawalReview { readers: WithdrawalReviewReceipt[]; arbitrator?: WithdrawalReviewReceipt }

/** What a reader judges: the question, as posted, and the reason given for withdrawing it. */
export const withdrawalBriefContent = (d: Pick<FoldedDecision, "id" | "payload">, reason: string, rationales?: string[]) =>
  ({ purpose: "withdraw-unanswered-question", decision: d.id, question: d.payload, reason, ...(rationales ? { rationales } : {}) });
export const withdrawalBriefHash = (content: unknown): string => "sha256:" + createHash("sha256").update(canonical(content)).digest("hex");

/** Two blind readers who find the withdrawal sound, or a third who arbitrates their disagreement
 *  having read both rationales — the ruling-application shape (A6). */
export function withdrawalReviewRefusal(d: Pick<FoldedDecision, "id" | "payload">, reason: string, review: unknown): string | null {
  const r = review as WithdrawalReview | undefined;
  const receipt = (x: WithdrawalReviewReceipt | undefined, hash: string) => !!x && [x.id, x.session, x.launch, x.rationale].every((v) => str(v))
    && (x.verdict === "sound" || x.verdict === "unsound") && x.briefHash === hash;
  const brief = withdrawalBriefHash(withdrawalBriefContent(d, reason));
  if (!r || !Array.isArray(r.readers) || r.readers.length !== 2 || !r.readers.every((x) => receipt(x, brief)))
    return "an agent withdraws an unanswered question only with two readers' recorded verdicts on this exact brief";
  const [a, b] = r.readers as [WithdrawalReviewReceipt, WithdrawalReviewReceipt];
  if (a.session === b.session || a.launch === b.launch || a.id === b.id) return "the two readers were not independently launched";
  if (a.verdict === "sound" && b.verdict === "sound") return r.arbitrator ? "no disagreement needs an arbitrator" : null;
  if (a.verdict === "unsound" && b.verdict === "unsound") return "both readers found the withdrawal unsound";
  const arb = r.arbitrator;
  if (!receipt(arb, withdrawalBriefHash(withdrawalBriefContent(d, reason, [a.rationale, b.rationale])))
    || [a, b].some((x) => x.session === arb!.session || x.launch === arb!.launch))
    return "the readers disagree: a third reader must arbitrate, having read both rationales";
  return arb!.verdict === "sound" ? null : "the arbitrator found the withdrawal unsound";
}

export interface ComparisonNomination {
  id: string; by: Actor; at: string; answers: [string, string]; findings: string[]; issues?: CanonicalIssueReference[]; reason: string;
}

export interface FoldedDecision extends Decision {
  hash: string;
  /** Frozen stakeholder form context for this decision, when it was published on a questionnaire. */
  presentation?: { questionnaire: { id: string; title: string; context?: string; recipient?: string };
    section: Questionnaire["sections"][number]; question: Questionnaire["sections"][number]["questions"][number] };
  /** When THIS decision was posted — not its round: a round can grow after it is posted, so
   *  "posted before the words" is judged per decision. Empty when the event carried no time. */
  postedAt: string;
  postingEvent: string;
  answers: FoldedAnswer[];
  /** Decisions posted since, citing an answer here as their origin (C1, bulk items). */
  followUps?: string[];
  /** A confirm-this-reading question. `invalid` says why it is not one codemap could have
   *  written: then it has no authority to act (owner, 2026-09-24 Q3), and `never` says the words
   *  it names were never recorded at all (Q2.3 (4)). `picked` is the latest verified pick on it
   *  that carries a confirm's meaning: the request is answered (Q1.3). */
  confirms?: Confirms & { invalid?: string; never?: true; picked?: string };
  resolutionInvalid?: string;
  cancellation?: { by: string; reason: string };
  /** An explicit withdrawal of an unanswered question. */
  withdrawn?: { id: string; by: Actor; at: string; reason: string };
  /** Every well-formed withdrawal act, including a refused one with its reason. */
  withdrawals?: WithdrawalRecord[];
  nominations?: ComparisonNomination[];
}

export interface FoldedComparison {
  request: ComparisonRequest;
  judgments: ReaderJudgment[];
  resolutions: HumanResolution[];
  projection: ComparisonProjection;
}

export interface SharedDecisions {
  rounds: DecisionRound[];
  decisions: FoldedDecision[];
  questions: LoggedQuestion[];
  comparisons: FoldedComparison[];
}

const isObject = (v: unknown): v is Record<string, any> => !!v && typeof v === "object" && !Array.isArray(v);
const str = (v: unknown): string | undefined => (typeof v === "string" && v.trim() ? v : undefined);

const validIssue = (value: unknown): value is CanonicalIssueReference => {
  if (!value || typeof value !== "object") return false;
  const x = value as Record<string, unknown>;
  if (!str(x.id) || !str(x.universe) || !str(x.scope)) return false;
  if (x.kind === "bug") return x.scope === `bugs/${x.universe}`;
  return x.kind === "finding" && str(x.review) !== undefined && (x.scope as string).startsWith(`findings/${x.universe}/`);
};
const issueKey = (issue: CanonicalIssueReference) => canonicalIssueKey(issue);
const effectIssues = (e: DecisionEffect) => e.issues ?? [];

/** A time as milliseconds, or undefined when it does not parse. An unknown time never satisfies
 *  an ordering claim in either direction: nothing is "before" it and nothing is "after" it. */
const ms = (s: string | undefined): number | undefined => { const t = Date.parse(s ?? ""); return Number.isNaN(t) ? undefined : t; };

/** What an answer binds to: the question as shown and every option's effects. */
export function decisionHash(d: Pick<Decision, "kind" | "payload" | "options">): string {
  return "d:sha256:" + createHash("sha256")
    .update(canonical({ kind: d.kind, payload: normalizeQuestion(d.payload), options: d.options })).digest("hex").slice(0, 24);
}

/** The published questionnaire and decision engine must describe the same ordered questions. */
export function checkQuestionnaireDecisions(q: Questionnaire, decisions: Decision[]): string | null {
  const valid = validateQuestionnaire(q);
  if (!valid.ok) return valid.errors.join("; ");
  const questions = q.sections.flatMap((section) => section.questions);
  if (questions.length !== decisions.length) return "questionnaire questions must match the posted decisions exactly";
  const byId = new Map(decisions.map((d) => [d.id, d]));
  if (byId.size !== decisions.length) return "questionnaire decisions repeat an id";
  for (const question of questions) {
    const d = byId.get(question.id);
    if (!d) return `questionnaire question ${question.id} has no matching decision`;
    if (question.prompt !== d.payload.question
      || (question.context && !question.prompt.includes(question.context))
      || (question.action && !question.prompt.includes(question.action)))
      return `questionnaire question ${question.id} differs from the posted prompt or visible context`;
    if (question.kind === "choice") {
      if (d.kind !== "options" || d.payload.multiSelect || d.options.length !== question.options.length
        || question.options.some((option, i) => d.options[i]?.label !== option.label
          || d.payload.options[i]?.label !== option.label
          || d.payload.options[i]?.description !== option.description
          || (option.action ?? "") !== effectText(d.options[i]!)))
        return `questionnaire choice ${question.id} differs from the posted options`;
    } else if (question.kind === "short") {
      if (d.kind !== "words" || d.options.length || d.payload.options.length)
        return `questionnaire short answer ${question.id} needs a words decision`;
    } else {
      const items = d.options.filter((option) => !option.approveAll);
      if (d.kind !== "bulk" || d.payload.multiSelect !== true || items.length !== question.items.length
        || d.options.filter((option) => option.approveAll).length !== 1
        || question.items.some((item, i) => items[i]?.label !== item.text
          || d.payload.options.find((option) => option.label === item.text)?.description !== item.context
          || (item.action ?? "") !== effectText(items[i]!)))
        return `questionnaire list ${question.id} differs from the posted items`;
    }
  }
  return null;
}

/** A posted decision the fold will hold, or why not. Shared with the posting ops, so an op
 *  refuses exactly what the fold would drop. */
export function checkDecision(d: Decision): string | null {
  // A fold drops garbage; it never throws on it, or one bad line blocks the whole scope.
  if (!d || typeof d !== "object" || !Array.isArray(d.options) || !d.options.every((o) => o && typeof o === "object" && typeof o.label === "string" && Array.isArray(o.effects))) {
    return "a decision needs options, each with a label and effects";
  }
  if (!d.payload || typeof d.payload !== "object" || !str(d.payload.question) || !Array.isArray(d.payload.options)
    || !d.payload.options.every((o) => o && typeof o === "object" && typeof o.label === "string")) {
    return "the payload is not an AskUserQuestion question";
  }
  if (!str(d.id) || !str(d.round) || !/^D\d+$/.test(typeof d.ref === "string" ? d.ref : "")) return "a decision needs an id, a round and a ref like D2";
  if (d.kind !== "options" && d.kind !== "words" && d.kind !== "bulk") return "kind must be options, words or bulk";
  const labels = d.payload.options.map((o) => o.label);
  // A pick is recorded by label, so two options sharing one could not be told apart (bulk 8).
  if (new Set(labels).size !== labels.length) return "two options share a label";
  if (d.options.length !== labels.length || d.options.some((o, i) => o.label !== labels[i])) {
    return "the options must be the payload's options, in order";
  }
  const multi = d.payload.multiSelect === true;
  if (d.kind === "bulk") {
    if (!multi) return "a bulk decision is a multi-select question";
    if (d.options.filter((o) => o.approveAll).length !== 1) return "a bulk decision carries exactly one approve-all option, because an empty multi-select cannot be submitted";
  } else if (d.options.some((o) => o.approveAll)) return "only a bulk decision has an approve-all option";
  for (const o of d.options) {
    if (d.kind === "words" && o.effects.length) return "a words decision has no effects";
    if (o.approveAll && o.effects.length) return "the approve-all option has no effects of its own";
    for (const e of o.effects as unknown[]) {
      if (!e || typeof e !== "object") return "an effect must be an object";
      const x = e as DecisionEffect;
      if ((x.on !== "settle" && x.on !== "unblock") || !Array.isArray(x.findings) || !x.findings.every((f) => str(f))
        || (x.issues !== undefined && (!Array.isArray(x.issues) || !x.issues.every(validIssue)))
        || (!x.findings.length && !x.issues?.length)) return "an effect needs findings or exact issues and on: settle | unblock";
      // Refused rather than defaulted: a default would record "accepted, won't fix" as "the
      // finding was wrong" (owner, 2026-09-23).
      if (x.on === "settle" && x.as !== "refuted" && x.as !== "accepted") return `a settle must say how it closes — as: "refuted" or "accepted"`;
      if (x.as === "accepted" && x.issues?.some(i => i.kind === "bug")) return "human acceptance here applies only to findings; bugs retain their typed lifecycle";
      if (x.on === "unblock" && x.as !== undefined) return "an unblock closes nothing, so it takes no `as`";
    }
    if (o.park !== undefined) {
      if (multi) return "a multi-select question cannot offer a park: picked with other options it means nothing (owner, 2026-09-23)";
      // A park with no date in the verified text is not a park (C23).
      if (typeof o.park !== "string" || !ISO_DATE.test(o.park) || !o.label.includes(o.park.slice(0, 10))) return `option "${o.label}" parks without its date in the label`;
    }
  }
  if (d.resolves) {
    const ids = d.resolves.answers;
    if (!Array.isArray(ids) || ids.length !== 2 || !ids.every((id) => str(id)) || ids[0] === ids[1]
      || d.kind !== "options" || multi || d.options.length !== 2
      || d.options.some((o, i) => o.label !== `Preserve ${ids[i]}` || o.effects.length || o.park)
      || ids.some((id) => !d.payload.question.includes(id))) return "a resolution must show two answer ids and offer one effect-free Preserve option per answer";
  }
  if (d.options.filter((o) => o.recommended).length > 1) return "at most one option is recommended";
  // What the person is shown carries what it acts on, so words typed back can be bound to it
  // by what was said (owner, H2/H5: "the question should just say 'Close D13 (f_09deadcafef3)?'").
  if (!new RegExp(`\\b${d.ref}\\b`).test(d.payload.question)) return `the question text must name its ref ${d.ref}`;
  for (const o of d.options) for (const e of o.effects) {
    for (const f of e.findings) if (!d.payload.question.includes(f)) return `the question text must name ${f}, which option "${o.label}" acts on`;
  }
  return null;
}

// --- confirm-this-reading (owner, the impl-2 discussion; P2.1 (1), (2); P3.1–P3.5) ---------------
//
// A POSTED decision, in the words' own round: `confirm_reading` writes it with codemap's text,
// the person is asked it verbatim and it is logged like any question. The fold checks its
// STRUCTURE against the real answer and options (P3.4), never its wording, so a later build that
// rewords it strands no open confirm. One that fails that check stays visible but cannot act; one
// that fails `checkDecision`, like any posted question, is dropped (owner, Q2.3 (3)).

export const CONFIRM_YES = "Yes";
export const CONFIRM_NO = "No — ask me again";
export const NONE = "(none)";
const READING = /^Reading ([12])$/;

/** What a confirm asks about: the words (an answer id) and the one or two readings offered. */
export interface Confirms { answer: string; readings: Mapping[][] }

const effectText = (o: DecisionOption): string => o.effects.map((e) => {
  const targets = [...e.findings, ...effectIssues(e).map((issue) => `${issue.kind} ${issue.id}`)];
  return e.on === "settle" ? `settles ${targets.join(", ")} as ${e.as}` : `unblocks ${targets.join(", ")}`;
}).join("; ");

/** Groups a reading's lines by decision, in the order the reading names them. */
const byDecision = (maps: Mapping[]): Map<string, (string | null)[]> => {
  const out = new Map<string, (string | null)[]>();
  for (const m of maps) out.set(m.decision, [...(out.get(m.decision) ?? []), m.option]);
  return out;
};

/** A confirm line's `D<n> → <labels>` — the part the fold checks exactly. */
/** What a verified pick labelled `label` on a valid confirm offering `rs` says: the reading it
 *  binds, `null` for "No — ask me again", or undefined when it says nothing (P3.2). */
const meaning = (label: string | undefined, rs: Mapping[][]): Mapping[] | null | undefined => {
  const n = READING.exec(label ?? "")?.[1];
  return label === CONFIRM_YES && rs.length === 1 ? rs[0]! : n && rs.length === 2 ? rs[Number(n) - 1]! : label === CONFIRM_NO && rs.length === 1 ? null : undefined;
};

const lineHead = (t: Pick<Decision, "ref">, picks: (string | null)[]): string => `${t.ref} → ${picks.map((p) => p ?? NONE).join(", ")}`;

/**
 * Everything picking `picks` on `t` does, as the person reads it (owner, P2.1 (2)): what it
 * settles and unblocks, and every finding of `t` it releases or leaves held — a bulk decision's
 * approved items with their effects too. As of when the words were typed: whether that ruling
 * still stands is ranked, and this text cannot follow a later answer.
 */
function actionLine(t: Pick<Decision, "ref" | "kind" | "options">, picks: (string | null)[]): string {
  const fs = [...new Set([...named(t), ...namedIssues(t).map((issue) => issue.id)])];
  const held = (xs: string[]) => (xs.length ? `${xs.join(", ")} stay held` : "");
  const join = (...parts: string[]) => `${lineHead(t, picks)} (${parts.filter(Boolean).join("; ")})`;
  if (picks.every((p) => p === null)) return join(`rules nothing on ${t.ref}`, held(fs));
  const chosen = picks.filter((p): p is string => p !== null).map((p) => t.options.find((o) => o.label === p)!);
  if (t.kind === "bulk") {
    const checked = chosen.some((o) => o.approveAll) ? [] : chosen;
    const approved = t.options.filter((o) => !o.approveAll && !checked.includes(o));
    return join(
      checked.length ? `checked, ruled on separately: ${checked.map((o) => o.label).join(", ")}` : "",
      held([...new Set(checked.flatMap((o) => o.effects.flatMap((e) => [...e.findings, ...effectIssues(e).map((issue) => issue.id)])))]),
      approved.length ? `approves ${approved.map((o) => `${o.label}${o.effects.length ? ` (${effectText(o)})` : ""}`).join("; ")}` : "",
    );
  }
  const park = chosen.length === 1 ? chosen[0]!.park : undefined;
  if (park) return join(`parks until ${park.slice(0, 10)}`, held(fs));
  const touched = new Set(chosen.flatMap((o) => o.effects.flatMap((e) => [...e.findings, ...effectIssues(e).map((issue) => issue.id)])));
  return join(...chosen.map(effectText), fs.some((f) => !touched.has(f)) ? `releases ${fs.filter((f) => !touched.has(f)).join(", ")}` : "");
}

/**
 * The confirm question `ref` for words `a` on `d`: one reading (Yes / No — ask me again; Other is
 * the person's own words, read like any reply), or the two readings of a dispute as options.
 */
export function confirmPayload(decisions: Map<string, FoldedDecision>, d: FoldedDecision, a: FoldedAnswer, readings: Mapping[][], ref: string): AskedQuestion {
  // Lines in one order whatever order the reading was given in, so one reading is one text. The
  // fold checks each line against the STORED reading's order, so a poster stores `canonicalMaps` too.
  const rendered = readings.map((r) => [...byDecision(canonicalMaps(r))].map(([id, picks]) => actionLine(decisions.get(id)!, picks)));
  // JSON-quoted, so words with a newline stay on one line and cannot pass for an action line.
  // Third person, one text for every viewer (plan 2.1): the fold re-renders it to check a posted
  // confirm, so it cannot say "you" to whoever happens to answer — and anyone may confirm.
  const who = a.by.principal;
  const words = `${who} typed at ${a.givenAt}:\n${JSON.stringify(a.words)}`;
  const presentation = d.presentation ? `\nFrozen questionnaire context: ${canonical(d.presentation)}` : "";
  if (readings.length === 1) {
    return normalizeQuestion({
      question: `${ref}: confirm how ${who}'s words on ${d.ref} (answer ${a.id}, round ${d.round}) are read. ${words}${presentation}\n${rendered[0]!.join("\n")}\nAs of when the words were typed, is that what they meant?`, header: "Confirm",
      options: [{ label: CONFIRM_YES, description: "Bind exactly the action above, as of when the words were typed" }, { label: CONFIRM_NO, description: "Not what they meant: ask the question again" }],
    });
  }
  return normalizeQuestion({
    question: `${ref}: ${who}'s words on ${d.ref} (answer ${a.id}, round ${d.round}) were read two ways. ${words}${presentation}\n${rendered.map((r, i) => `Reading ${i + 1}:\n${r.join("\n")}`).join("\n")}\nWhich did they mean, as of when the words were typed?`, header: "Confirm",
    options: rendered.map((r, i) => ({ label: `Reading ${i + 1}`, description: r.join("; ") })),
  });
}

/**
 * Why posted confirm `c` is not one codemap could have written for the log as folded, or null
 * (P3.4). It is kept either way — the fold never drops a posted question (P2.1 (4)) — but only
 * a confirm that passes carries a confirm's meaning. A ref two questions share is NOT checked
 * here: it is judged as the posting clone saw the round, which only `confirm_reading` can
 * (owner, Q2.1), so a later pull never voids a pick already given.
 */
function confirmRefusal(decisions: Map<string, FoldedDecision>, c: FoldedDecision, target: { a: FoldedAnswer; d: FoldedDecision } | undefined): string | null {
  const cf = c.confirms!;
  if (ms(c.postedAt) === undefined) return "it has no posting time";
  if (!target) return `the words it confirms (${cf.answer}) are not an answer here`;
  const { d, a } = target;
  if (d.round !== c.round) return "it is not in the round of the words it confirms";
  if (d.confirms) return "it confirms words on another confirm";
  if (!Array.isArray(cf.readings) || !cf.readings.length || cf.readings.length > 2) return "it offers no reading, or more than two";
  if (cf.readings.some((reading) => !validMaps(reading) || reading.some((mapping) => !decisions.has(mapping.decision)
    || (mapping.option !== null && !decisions.get(mapping.decision)!.options.some((o) => o.label === mapping.option)))))
    return "a reading names a question or option that is not an exact decision here";
  const labels = cf.readings.length === 1 ? [CONFIRM_YES, CONFIRM_NO] : ["Reading 1", "Reading 2"];
  if (c.kind !== "options" || c.payload.multiSelect || c.options.length !== 2 || c.options.some((o, i) => o.label !== labels[i] || o.effects.length || o.park)) return "its options are not the confirm's";
  // A matching ref and option label cannot authorize different action prose. The generated
  // presentation is determined by the frozen question, answer and reading identities.
  if (canonical(normalizeQuestion(c.payload)) !== canonical(confirmPayload(decisions, d, a, cf.readings, c.ref)))
    return "its displayed action differs from the reading it confirms";
  const q = c.payload.question;
  if (!new RegExp(`\\b${d.ref}\\b`).test(q) || !q.includes(a.id)) return `its question does not name ${d.ref} and answer ${a.id}`;
  const sections = cf.readings.length === 1 ? [q.split("\n")] : q.split(/\nReading [12]:\n/).slice(1).map((s) => s.split("\n"));
  if (sections.length !== cf.readings.length) return "its question does not set out each reading";
  for (const [i, r] of cf.readings.entries()) {
    if (!validMaps(r)) return "a reading it offers is empty";
    const why = bindRefusal(decisions, d, a, r);
    if (why) return `a reading it offers cannot bind: ${why}`;
    const heads = sections[i]!.filter((l) => /^D\d+ → /.test(l));
    const want = [...byDecision(r)];
    if (heads.length !== want.length) return "its action lines are not one per decision the reading maps";
    for (const [id, picks] of want) {
      const t = decisions.get(id)!, head = lineHead(t, picks);
      if (!heads.some((l) => l === head || l.startsWith(`${head} (`))) return `it has no action line ${head}`;
      const missing = [...named(t), ...namedIssues(t).map((issue) => issue.id)].find((f) => !q.includes(f));
      if (missing) return `its question does not name ${missing}, which ${t.ref} acts on`;
    }
  }
  return null;
}

// --- the reader's brief (owner, P1.4 + P3.4) -------------------------------------------------
//
// Codemap writes what the reader is told, so it cannot carry the agent's own reading. The op
// compares the reader's launch prompt with it exactly; the fold, which cannot read transcripts,
// checks the stored text's STRUCTURE — so a later build that rewords it strands nothing. The
// reader ends by calling `submit_verdict` itself (owner, Q2.2): see `ops/decisions.ts`.

const BRIEF_WORDS = "Their words, exactly as typed (JSON-quoted):";
const BRIEF_Q = /^(D\d+): (".*")$/, BRIEF_OPTS = /^ {2}options: (\[.*\])$/, BRIEF_CONTEXT = /^ {2}context: (\{.*\})$/;
export interface BriefEntry { id: string; hash: string; ref: string }
export const briefManifest = (decisions: Map<string, FoldedDecision>, d: FoldedDecision, a: FoldedAnswer): BriefEntry[] =>
  readable(decisions, d, a).map((t) => ({ id: t.id, hash: t.hash, ref: t.ref }));

/** Questions these words could bind in their admission context. Current supersession can
 *  still refuse a NEW reading of an unread answer. */
export const readable = (decisions: Map<string, FoldedDecision>, d: FoldedDecision, a: FoldedAnswer): FoldedDecision[] =>
  [...decisions.values()].filter((t) => t.round === d.round && !bindRefusal(decisions, d, a, [{ decision: t.id, option: null }]));

/** The reader's exact prompt for words `a` on `d`: the words, the questions and the verdict
 *  format — nothing of anyone's reading of them. */
export function readerBrief(decisions: Map<string, FoldedDecision>, d: FoldedDecision, a: FoldedAnswer): string {
  const qs = readable(decisions, d, a);
  const shared = [...new Set(qs.map((t) => t.ref).filter((r, i, all) => all.indexOf(r) !== i))];
  return [
    "A person was asked the questions below and typed a reply. Say which of the questions their words answer, and with which option. Read only the words: nobody has told you how anyone else reads them.",
    "",
    BRIEF_WORDS,
    JSON.stringify(a.words),
    "",
    `The questions (round ${d.round}), each with its exact option labels:`,
    ...qs.flatMap((t) => [`${t.ref}: ${JSON.stringify(t.payload.question)}`, `  options: ${JSON.stringify(t.options.map((o) => o.label))}`, `  context: ${canonical({ id: t.id, kind: t.kind, payload: t.payload, options: t.options, presentation: t.presentation })}`]),
    ...shared.map((r) => `Two questions share the ref ${r}: a line naming ${r} is refused as ambiguous.`),
    "",
    `When you have decided, call the codemap MCP tool \`submit_verdict\` yourself, once, with \`answer: "${a.id}"\` and \`verdict\`: one line per pick, \`D<n> → <exact option label>\`; \`D<n> → ${NONE}\` where the words answer that question with none of its options; or, if you cannot tell which question they answer, the single line \`unclear: <why>\`. That call is your answer; then stop.`,
  ].join("\n");
}

/** The questions a stored brief lists, or why it is not one codemap wrote for words `a` on `d`:
 *  it quotes the words exactly, and every question it lists is one the words may be read onto,
 *  with its exact labels. */
export function briefListing(decisions: Map<string, FoldedDecision>, d: FoldedDecision, a: FoldedAnswer, brief: string, manifest?: BriefEntry[]): FoldedDecision[] | string {
  const lines = brief.split("\n");
  const w = lines.indexOf(BRIEF_WORDS);
  let words: unknown;
  try { words = w < 0 ? undefined : JSON.parse(lines[w + 1] ?? ""); } catch { /* not JSON */ }
  if (words !== a.words) return "the reader's brief does not quote the words exactly";
  const listed: FoldedDecision[] = [];
  const candidates = [...decisions.values()].filter((t) => t.round === d.round && t.kind !== "words"
    && !t.confirms?.invalid && ms(t.postedAt) !== undefined && ms(t.postedAt)! < ms(a.givenAt)!);
  const entries = manifest === undefined ? undefined : Array.isArray(manifest) && manifest.every((m) => m && typeof m.id === "string" && typeof m.hash === "string" && typeof m.ref === "string") ? manifest : null;
  if (entries === null) return "the reader's brief has a malformed manifest";
  let at = 0;
  for (let i = 0; i < lines.length; i++) {
    const m = BRIEF_Q.exec(lines[i]!);
    if (!m) continue;
    let question: unknown, labels: unknown, context: unknown;
    try { question = JSON.parse(m[2]!); labels = JSON.parse(BRIEF_OPTS.exec(lines[i + 1] ?? "")?.[1] ?? ""); context = JSON.parse(BRIEF_CONTEXT.exec(lines[i + 2] ?? "")?.[1] ?? ""); } catch { return `the reader's brief lists ${m[1]} unreadably`; }
    const matches = candidates.filter((x) => x.ref === m[1] && x.payload.question === question
      && Array.isArray(labels) && labels.length === x.options.length && x.options.every((o, j) => o.label === labels[j])
      && canonical(context) === canonical({ id: x.id, kind: x.kind, payload: x.payload, options: x.options, presentation: x.presentation }));
    if (!matches.length) return `the reader's brief lists ${m[1]} as a question these words cannot be read onto, or with other labels`;
    if (entries) {
      const e = entries[at++], t = matches.find((x) => x.id === e?.id);
      if (!t || t.hash !== e!.hash || t.ref !== e!.ref) return `the reader's brief manifest does not identify ${m[1]} and its exact hash`;
      listed.push(t);
    } else listed.push(...matches);
  }
  if (entries && at !== entries.length) return "the reader's brief manifest has a different number of questions";
  const unique = [...new Map(listed.map((t) => [t.id, t])).values()];
  const shared = [...new Set(unique.map((t) => t.ref).filter((r, i, all) => all.indexOf(r) !== i))];
  for (const ref of shared) if (!lines.includes(`Two questions share the ref ${ref}: a line naming ${ref} is refused as ambiguous.`))
    return `the reader's brief omits its ambiguity warning for ${ref}`;
  return unique;
}

/** Why a stored brief is not one codemap wrote for words `a` on `d` with this verdict, or null:
 *  `briefListing`'s checks, every decision the verdict names is listed, and none is a ref two
 *  listed questions share. With no verdict, whether the brief itself still stands. */
export function briefRefusal(decisions: Map<string, FoldedDecision>, d: FoldedDecision, a: FoldedAnswer, brief: string, verdict: Mapping[], manifest?: BriefEntry[]): string | null {
  const got = briefListing(decisions, d, a, brief, manifest);
  if (typeof got === "string") return got;
  const listed = new Set(got.map((t) => t.id));
  const missing = verdict.find((m) => !listed.has(m.decision));
  if (missing) return `the verdict names ${decisions.get(missing.decision)?.ref ?? missing.decision}, which the reader's brief did not list`;
  // Judged against the brief the reader read, never the round as folded now (owner, Q2.1): a
  // question pulled later cannot make an accepted line ambiguous.
  const refs = [...listed].map((id) => decisions.get(id)!.ref);
  const shared = verdict.find((m) => refs.filter((r) => r === decisions.get(m.decision)!.ref).length > 1);
  return shared ? `the verdict names ${decisions.get(shared.decision)!.ref}, which two questions in the reader's brief share: it is ambiguous` : null;
}

// --- the fold -------------------------------------------------------------------------

/** What an answer says, before it is applied. */
interface Resolved {
  verified: boolean;
  words: string;
  /** Options picked (for a bulk decision: the items CHECKED, or the approve-all option). */
  picked: DecisionOption[];
  park?: string;
  free: boolean;
  /** When given, if not when recorded. */
  givenAt?: string;
  once?: string;
}

/** Rule `picked` onto answer `a` — the one place an answer's picks become its facts. */
function rule(d: FoldedDecision, a: FoldedAnswer, r: Pick<Resolved, "picked" | "park">, verified: boolean): void {
  const park = r.park ?? (r.picked.length === 1 ? r.picked[0]!.park : undefined);
  if (park !== undefined) {
    // Principal-only and dated (C23): unverified, it applies nothing and waits for you.
    if (!verified) { a.parkWaits = park.slice(0, 10); return; }
    a.park = park.slice(0, 10);
    // A valid park is accepted; one that looks errant is flagged, not refused (R19).
    const offered = d.options.map((o) => o.park?.slice(0, 10)).filter(Boolean);
    a.flags = [
      ...(!offered.includes(a.park) ? [`park date ${a.park} is not one this decision offered${offered.length ? ` (${offered.join(", ")})` : ""}`] : []),
      ...(a.park < a.givenAt.slice(0, 10) ? [`park date ${a.park} had already passed when it was answered`] : []),
    ];
    if (!a.flags.length) delete a.flags;
    return;
  }
  let chosen = r.picked;
  if (d.kind === "bulk") {
    const all = r.picked.some((o) => o.approveAll);
    // "None — approve all" beside a checked item says two things at once: it is read, not guessed.
    if (all && r.picked.length > 1) { a.free = true; return; }
    const checked = new Set(r.picked.map((o) => o.label));
    a.separately = d.options.filter((o) => !o.approveAll && checked.has(o.label)).map((o) => o.label);
    chosen = d.options.filter((o) => !o.approveAll && !checked.has(o.label));
  }
  for (const o of chosen) {
    for (const eff of o.effects) {
      for (const f of eff.findings) {
        // An unverified answer only unblocks (C8): its settles wait for you.
        if (eff.on === "settle" && !verified) { if (!a.unruled.includes(f)) a.unruled.push(f); continue; }
        a.ruled.push({ finding: f, on: eff.on, ...(eff.as ? { as: eff.as } : {}) });
      }
    }
    a.options.push(o.label);
  }
}

/** A reading of words onto questions: at least one `{ decision, option | null }` (P2.1 (3)).
 *  Shared with the ops, so they refuse exactly what the fold drops. */
export const validMaps = (m: unknown): Mapping[] | null => Array.isArray(m) && m.length > 0 && m.every((x) => x && typeof x === "object" && str(x.decision) && (x.option === null || str(x.option)))
  ? (m as Mapping[]) : null;

/** A reader's verdict: a reading, or — only when it says unclear — nothing. */
export const validVerdict = (m: unknown, unclear: unknown): Mapping[] | null =>
  str(unclear) ? (Array.isArray(m) && !m.length ? [] : null) : validMaps(m);

/** A reading's lines in one order: the order a confirm renders and stores them in. */
export const canonicalMaps = (ms: Mapping[]): Mapping[] => [...ms].sort((x, y) => codeUnitOrder(mapsKey([x]), mapsKey([y])));

/** Two readings are the same reading when they map the same lines, in any order. */
export const mapsKey = (ms: Mapping[]): string => ms.map((m) => `${m.decision}\0${m.option ?? ""}`).sort().join("\n");

export interface RevisionScope { findings: string[]; issues?: CanonicalIssueReference[] }
export const withdrawalScope = (d: FoldedDecision): RevisionScope =>
  ({ findings: named(d), issues: namedIssues(d) });

export function revisionRelayQuestion(d: FoldedDecision, sources: FoldedAnswer[], to: string,
  scope: RevisionScope): AskedQuestion {
  const shown = revisionPresentation(d, sources, to, scope);
  const listQuestion = d.presentation?.question;
  const reviewedItems = listQuestion?.kind === "list"
    ? listQuestion.items.filter((item) => listRevisionItemIds(d, scope).includes(item.id)) : undefined;
  return { question: JSON.stringify({ purpose: "explicit-ruling-revision", decision: d.id,
      answers: shown.answers, scope: shown.scope, display: shown.display, contextHash: shown.contextHash,
      ...(reviewedItems ? { reviewedItems, answerFormat: "Approve all reviewed items, or enter JSON: {\"approveUnmarked\":true,\"marked\":[{\"itemId\":\"id\",\"correction\":\"your correction\"}]}" } : {}) }),
    options: d.presentation?.question.kind === "list"
      ? [{ label: "Approve all reviewed items" }, { label: "Other", description: "Enter the exact per-item correction JSON shown in the question" }]
      : d.payload.options.length ? d.payload.options : [{ label: "Other", description: "Give the corrected answer in your own words" }] };
}

/** What a person revising `sources` is shown, and the hash a relayed question carries. */
export function revisionPresentation(d: FoldedDecision, sources: FoldedAnswer[], to: string, scope: RevisionScope) {
  const context = { decision: d.id, to,
    answers: sources.map((a) => ({ id: a.id, responseHash: a.responseHash, questionHash: d.hash })),
    scope, display: { question: d.payload,
      ...(d.presentation?.question.kind === "list" ? { questionnaire: d.presentation } : {}),
      answers: d.presentation?.question.kind === "list"
        ? sources.map((a) => ({ id: a.id, principal: a.by.principal, words: a.words,
          ...(a.questionnaire ? { reviewed: { answer: a.questionnaire.answer,
            approvals: a.questionnaire.approvals ?? [], corrections: a.questionnaire.corrections ?? [] } } : {}) }))
        : sources.map((a) => a.words),
      action: d.options.map((option) => ({ label: option.label, effects: option.effects })) } };
  return { ...context,
    contextHash: createHash("sha256").update(canonical(context)).digest("hex") };
}

export interface ListRevision {
  items: string[];
  approveUnmarked: true;
  marked: { itemId: string; correction: string }[];
}

export function parseListRelayAnswer(answer: string): Pick<ListRevision, "approveUnmarked" | "marked"> | null {
  if (typeof answer !== "string") return null;
  if (answer === "Approve all reviewed items") return { approveUnmarked: true, marked: [] };
  const words = answer.startsWith("Other:") ? answer.slice("Other:".length).trim() : answer;
  let value: unknown;
  try { value = JSON.parse(words); } catch { return null; }
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  if (raw.approveUnmarked !== true || !Array.isArray(raw.marked)
    || Object.keys(raw).some((key) => !["approveUnmarked", "marked"].includes(key))
    || !raw.marked.every((item) => item && typeof item === "object" && !Array.isArray(item)
      && typeof item.itemId === "string" && typeof item.correction === "string"
      && Object.keys(item).every((key) => key === "itemId" || key === "correction"))) return null;
  return { approveUnmarked: true, marked: raw.marked as ListRevision["marked"] };
}

export function listRevisionItemIds(d: FoldedDecision, scope: RevisionScope): string[] {
  const question = d.presentation?.question;
  if (question?.kind !== "list") return [];
  const selected = new Set([...scope.findings.map((id) => `finding:${id}`),
    ...(scope.issues ?? []).map((issue) => issueKey(issue))]);
  return question.items.filter((item) => {
    const option = d.options.find((o) => o.label === item.text);
    return option?.effects.some((effect) => effect.findings.some((id) => selected.has(`finding:${id}`))
      || effectIssues(effect).some((issue) => selected.has(issueKey(issue))));
  }).map((item) => item.id);
}

/** A list revision reviews every frozen item that bears on its named scope. */
export function checkListRevision(d: FoldedDecision, scope: RevisionScope, list: unknown): string | null {
  const question = d.presentation?.question;
  if (question?.kind !== "list") return list === undefined ? null : "only a questionnaire list accepts item corrections";
  if (!list || typeof list !== "object") return "a questionnaire list revision needs its reviewed items and corrections";
  const raw = list as Partial<ListRevision>;
  if (raw.approveUnmarked !== true || !Array.isArray(raw.items) || !Array.isArray(raw.marked)
    || Object.keys(raw).some((key) => !["items", "approveUnmarked", "marked"].includes(key)))
    return "a list revision must approve unmarked reviewed items";
  if (!Array.isArray(scope?.findings) || !scope.findings.every((id) => typeof id === "string")
    || (scope.issues !== undefined && (!Array.isArray(scope.issues) || !scope.issues.every(validIssue))))
    return "list revision needs an exact selected scope";
  const expected = listRevisionItemIds(d, scope);
  if (!expected.length || raw.items.length !== expected.length || new Set(raw.items).size !== expected.length
    || expected.some((id) => !raw.items!.includes(id))) return "list revision items must match the exact selected scope";
  const marked = new Set<string>();
  for (const item of raw.marked) {
    if (!item || typeof item.itemId !== "string" || !expected.includes(item.itemId)
      || typeof item.correction !== "string" || !item.correction.trim()
      || Object.keys(item).some((key) => !["itemId", "correction"].includes(key))
      || marked.has(item.itemId)) return "each marked list item needs its own correction and stable id";
    marked.add(item.itemId);
  }
  return null;
}

function listRevisionMatchesAnswer(d: FoldedDecision, list: ListRevision | undefined, via: AnswerVia): boolean {
  const question = d.presentation?.question;
  if (question?.kind !== "list") return true;
  if (!list) return false;
  if (via?.kind === "revision-relay") {
    const parsed = parseListRelayAnswer(via.proof?.answer);
    return !!parsed && canonical(parsed) === canonical({ approveUnmarked: list.approveUnmarked, marked: list.marked });
  }
  if (via?.kind !== "direct") return false;
  const marked = new Set(list.marked.map((item) => item.itemId));
  const labels = question.items.filter((item) => marked.has(item.id)).map((item) => item.text);
  const checked = labels.length ? labels : [d.options.find((option) => option.approveAll)?.label];
  return canonical(via.checked) === canonical(checked);
}


/** Every kind this family folds or knows to skip: anything else here is newer (`eventlog.ts registerKinds`). */
const DECISION_KINDS = registerKinds((scope) => scope.startsWith("decisions/"), [
  "decision.round.posted", "decision.confirm.posted", "decision.question.logged", "decision.answer.recorded",
  "decision.answer.revised", "decision.questionnaire.submitted", "decision.comparison.nominated",
  "decision.comparison.requested", "decision.comparison.judged", "decision.comparison.resolved", "decision.withdrawn",
  "decision.reading.recorded",
  // Retired with the merge transport; folded by nothing.
  "decision.conflict.resolved",
]);
/**
 * The decisions fold for a READ. HALTS on damage (`LogDamage`), naming the entry (owner, node 18:
 * "Halt on any bad entry"): a linear event the fold refuses, judged by `validation.ts judge` as
 * every family's is. It used to leave such an event out and read on, which could drop a good
 * answer and blame it.
 */
export function foldDecisions(events: LogEvent[]): SharedDecisions {
  return foldJudged(events, foldDecisionsReport, DECISION_KINDS).value;
}

/** The fold and every refusal, unjudged: what the write door asks of a new event (plan 1.1). */
export const foldDecisionsReport = shaped(foldDecisionsWithRefusals, decisionEventShape, decisionDevEra);

type ConfirmPick = { a: FoldedAnswer; c: FoldedDecision };
/**
 * What the person's picks on confirms of words `a` say, counting only the picks `counts` admits.
 * Picks group by the readings offered, across reposted confirms; within a group each person's
 * latest pick stands for them, and two people answering the same reading differently HOLD the
 * words unbound. Otherwise the latest-given pick decides (P3.2). One rule for the projected
 * ruler and the as-of ruler (`rulerAt`), so the two cannot drift.
 */
function confirmVerdict(a: FoldedAnswer, picks: ConfirmPick[], counts: (p: ConfirmPick) => boolean): {
  decided?: { pick: FoldedAnswer; maps: Mapping[] | null };
  dispute?: { readings: Mapping[][]; picks: string[] };
  rejected: Mapping[][];
} {
  const groups = new Map<string, { rs: Mapping[][]; mine: Map<string, { pick: FoldedAnswer; maps: Mapping[] | null }> }>();
  const rejected: Mapping[][] = [];
  for (const x of picks) {
    const { a: p, c } = x;
    if (c.confirms!.answer !== a.id || c.confirms!.invalid || !counts(x)) continue;
    const rs = c.confirms!.readings, maps = meaning(p.options[0], rs);
    if (maps === undefined) continue;
    if (maps === null) rejected.push(rs[0]!);
    const key = rs.map(mapsKey).sort().join("\n");
    const g = groups.get(key) ?? { rs, mine: new Map() };
    groups.set(key, g);
    const prev = g.mine.get(p.by.principal);
    if (!prev || outranksByTime(p, prev.pick)) g.mine.set(p.by.principal, { pick: p, maps });
  }
  let decided: { pick: FoldedAnswer; maps: Mapping[] | null } | undefined;
  let dispute: { readings: Mapping[][]; picks: string[] } | undefined;
  for (const g of groups.values()) {
    const said = [...g.mine.values()];
    if (new Set(said.map((x) => (x.maps ? mapsKey(x.maps) : "no"))).size > 1) {
      dispute = { readings: g.rs, picks: said.map((x) => x.pick.id) };
      continue;
    }
    for (const x of said) if (!decided || outranksByTime(x.pick, decided.pick)) decided = x;
  }
  return { ...(dispute ? { dispute } : decided ? { decided } : {}), rejected };
}

/**
 * The fold, and every event it did not apply as written. One output for every way the fold
 * refuses, so the write door can ask whether it would refuse a new event (plan 1.1).
 */
function foldDecisionsWithRefusals(events: LogEvent[]): { value: SharedDecisions; refused: Refusal[] } {
  // Withdrawals apply after binds, so a withdrawn pick on a confirm had already counted. Fold
  // again without every withdrawn pick until nothing more is excluded: a withdrawn Yes returns
  // the words to unconfirmed (plan 2.2), a withdrawn side of a dispute releases it (K5). The set
  // only grows and is bounded by the picks.
  const excluded = new Set<string>();
  for (;;) {
    const out = foldOnce(events, excluded);
    const more = out.value.decisions.filter((c) => c.confirms)
      .flatMap((c) => c.answers.filter((p) => (c.withdrawn || p.withdrawn) && !excluded.has(p.id)).map((p) => p.id));
    if (!more.length) return out;
    for (const id of more) excluded.add(id);
  }
}

function foldOnce(events: LogEvent[], excludedPicks: ReadonlySet<string>): { value: SharedDecisions; refused: Refusal[] } {
  const refused: Refusal[] = [];
  // One class for every refusal here, a failed precondition or reference alike: on read both
  // are damage for a linear event (`judge`). Shapes are refused ahead of the fold (`shaped`).
  const refuse = (e: LogEvent, why: string) => { refused.push({ id: e.id, kind: e.kind, why, cls: "state" }); };
  const eventById = new Map(events.map((e) => [e.id, e]));
  const refuseId = (id: string | undefined, why: string) => { const e = id ? eventById.get(id) : undefined; if (e) refuse(e, why); };
  const rounds = new Map<string, DecisionRound>();
  const decisions = new Map<string, FoldedDecision>();
  const exactRound = (id: string): DecisionRound | undefined => {
    const exact = rounds.get(id);
    if (exact) return exact;
    const matching = [...rounds.values()].filter((r) => r.label === id);
    return matching.length === 1 ? matching[0] : undefined;
  };
  const exactDecision = (id: string): FoldedDecision | undefined => {
    const exact = decisions.get(id);
    if (exact) return exact;
    const matching = [...decisions.values()].filter((d) => d.label === id);
    return matching.length === 1 ? matching[0] : undefined;
  };
  const questions = new Map<string, LoggedQuestion>();
  const reads = readSets(events);
  const answerEvents = new Map<string, LogEvent>();
  const answersById = new Map<string, { a: FoldedAnswer; d: FoldedDecision }>();
  // Position of each decision's posting, so an answer reaches only a decision posted before it.
  const postedPos = new Map<string, number>();
  /** Every well-formed reading, in log order. Which are accepted is decided after the log is
   *  read, so a reading that is not accepted claims nothing (owner, P1.2 "Not used"). */
  const readingEvents: { e: LogEvent; pos: number }[] = [];
  /** Verified picks on confirms — the only answers that carry a confirm's meaning (P3.2). */
  const picks: { a: FoldedAnswer; c: FoldedDecision }[] = [];
  const nominationEvents: { e: LogEvent; pos: number }[] = [];
  const withdrawalEvents: { e: LogEvent; pos: number }[] = [];
  const seenQuestionnaireAttempts = new Set<string>();
  const comparisonEvents: { e: LogEvent; pos: number }[] = [];

  // Questions first: a logged call is a fact about the transcript, and an answer event may
  // arrive from another writer before it in fold order.
  for (const e of events) {
    if (e.kind !== "decision.question.logged") continue;
    const q = e.data as any;
    // No round or no answer time: written by a build before either bound anything (H7.12).
    // Shape-checked on entry (`log-shape.ts`): rounds and per-question binding are always there.
    const asked = q.rounds as string[];
    if (!str(q?.session) || !str(q?.toolUseId) || !asked || !str(q?.answeredAt) || !Array.isArray(q?.questions) || !q?.answers || typeof q.answers !== "object" || Array.isArray(q.answers)) { refuse(e, "a logged question needs its session, call, rounds, answer time, questions and answers"); continue; }
    if (!q.questions.every((x: any) => x && typeof x === "object" && typeof x.question === "string" && Array.isArray(x.options)
      && x.options.every((o: any) => o && typeof o === "object" && typeof o.label === "string"))) { refuse(e, "a logged question's questions need their text and option labels"); continue; }
    if (questions.has(e.id)) continue;
    const bound = Object.fromEntries(Object.entries(q.bound as Record<string, string>).filter(([, r]) => asked.includes(r)));
    questions.set(e.id, {
      id: e.id, session: q.session, toolUseId: q.toolUseId,
      questions: q.questions.map(normalizeQuestion), answers: q.answers, rounds: asked, bound, answeredAt: q.answeredAt,
      ...(str(q.transcript) ? { transcript: q.transcript } : {}),
      loggedBy: e.actor, at: e.at,
    });
  }

  const acceptAnswer = (e: LogEvent, pos: number, data: any, answerId = e.id): void => {
    const d = exactDecision(str(data?.decision) ?? "");
    if (!d) return refuse(e, `no question ${String(data?.decision)}`);
    if ((postedPos.get(d.id) ?? Infinity) > pos) return refuse(e, `the answer folds before ${d.ref} was posted`);
    if (data.hash !== d.hash) return refuse(e, `the answer is to another version of ${d.ref}`);
    if (data?.via?.kind === "revision-relay" && e.kind !== "decision.answer.revised") return refuse(e, "a relayed revision is recorded only as a revision");
    const r = resolve(d, data.via as AnswerVia, e.actor, questions, rounds);
    if (!r) return refuse(e, `the answer binds to nothing this fold can check on ${d.ref}`);
    if (r.park !== undefined && !ISO_DATE.test(r.park)) return refuse(e, "a park needs a date");
    const givenAt = r.givenAt ?? e.at;
    const given = ms(givenAt);
    if (given === undefined) return refuse(e, "the answer has no time that parses");
    if (r.givenAt !== undefined) {
      const posted = ms(d.postedAt);
      if (posted === undefined || !(given > posted)) return refuse(e, `the answer was given before ${d.ref} was posted`);
    }
    if (r.once && d.answers.some((x) => x.once === r.once)) return refuse(e, `this answer is already recorded on ${d.ref}`);
    const a: FoldedAnswer = {
      id: answerId, by: e.actor, at: e.at,
      via: data.questionnaireMeta ? "questionnaire" : (data.via as AnswerVia).kind,
      verified: r.verified, givenAt, seq: pos,
      ...(r.once ? { once: r.once } : {}),
      responseHash: createHash("sha256").update(canonical({ words: r.words, free: r.free, picked: r.picked.map((o) => o.label), park: r.park ?? null,
        ...(data.questionnaireMeta ? { submittedAnswer: data.questionnaireMeta.answer } : {}) })).digest("hex"),
      words: r.words, options: [], ruled: [], unruled: [], free: r.free,
      ...(str(data.relayedBy) ? { relayedBy: data.relayedBy } : {}),
      ...(e.kind === "decision.answer.revised" ? { revision: data.revision } : {}),
      ...(data.questionnaireMeta ? { questionnaire: data.questionnaireMeta } : {}),
    };
    d.answers.push(a);
    answersById.set(answerId, { a, d });
    answerEvents.set(answerId, e);
    if (d.kind === "words") { a.free = false; return; }
    if (!r.free) rule(d, a, r, r.verified);
    if (d.confirms && !r.free && r.verified) picks.push({ a, c: d });
  };

  events.forEach((e, pos) => {
    let data = e.data as any;
    switch (e.kind) {
      case "decision.round.posted": {
        const r = data?.round;
        if (!r || typeof r !== "object" || !str(r.id) || !str(r.source) || !Array.isArray(data?.decisions)) { refuse(e, "a round needs its id, source and decisions"); break; }
        if (new Set(data.decisions.map((raw: Decision) => raw?.id)).size !== data.decisions.length) { refuse(e, "a round's decisions need distinct ids"); break; }
        // Each decision's own shape first: the questionnaire check dereferences them.
        if (r.questionnaire) {
          const why = data.decisions.map((raw: Decision) => checkDecision(raw)).find(Boolean)
            ?? checkQuestionnaireDecisions(r.questionnaire, data.decisions);
          if (why) { refuse(e, why); break; }
        }
        const pv = r.prevalidated;
        const prevalidated = pv && typeof pv === "object" && str(pv.record) && str(pv.sortedBy) ? { record: pv.record as string, sortedBy: pv.sortedBy as string } : undefined;
        // A posting's id is its event's, so two postings of one label never collide.
        const roundId = e.id;
        if (rounds.has(roundId)) { refuse(e, `round ${roundId} is already posted`); break; }
        rounds.set(roundId, {
          id: roundId, label: r.id, source: r.source, universe: str(r.universe) ?? "",
          ...(str(r.pr) ? { pr: r.pr } : {}), ...(str(r.branch) ? { branch: r.branch } : {}),
          ...(Array.isArray(r.notes) ? { notes: r.notes.filter((n: unknown) => str(n)) } : {}),
          ...(prevalidated ? { prevalidated } : {}),
          ...(r.questionnaire ? { questionnaire: r.questionnaire } : {}),
          postedBy: e.actor, at: e.at,
        });
        for (const raw of data.decisions as Decision[]) {
          const malformed = checkDecision(raw);
          if (malformed) { refuse(e, malformed); continue; }
          if (raw.round !== r.id) { refuse(e, `decision ${raw.id} names another round`); continue; }
          const d: FoldedDecision = {
            id: `${e.id}:${raw.id}`, label: raw.id,
            round: roundId, ref: raw.ref, kind: raw.kind,
            payload: normalizeQuestion(raw.payload),
            // A retired field on an old posting is ignored, never a reason to lose the question (S0.7).
            options: raw.options.map(({ closesOnAnswer: _c, ...o }: DecisionOption & { closesOnAnswer?: unknown }) => o),
            ...(str(raw.follows) || str(raw.supersedes) ? { follows: str(raw.follows) ?? str(raw.supersedes) } : {}),
            ...(str(raw.origin?.answer) ? { origin: { answer: raw.origin!.answer } } : {}),
            ...(Array.isArray(raw.notes) ? { notes: raw.notes } : {}),
            ...(raw.resolves ? { resolves: raw.resolves } : {}),
            hash: decisionHash(raw), postedAt: typeof e.at === "string" ? e.at : "", postingEvent: e.id, answers: [],
            ...(r.questionnaire ? (() => {
              const section = (r.questionnaire as Questionnaire).sections.find((section: Questionnaire["sections"][number]) => section.questions.some((q: Questionnaire["sections"][number]["questions"][number]) => q.id === raw.id));
              const question = section?.questions.find((q: Questionnaire["sections"][number]["questions"][number]) => q.id === raw.id);
              return section && question ? { presentation: {
                questionnaire: { id: r.questionnaire.id, title: r.questionnaire.title,
                  ...(r.questionnaire.context !== undefined ? { context: r.questionnaire.context } : {}),
                  ...(r.questionnaire.recipient !== undefined ? { recipient: r.questionnaire.recipient } : {}) },
                section, question,
              } } : {};
            })() : {}),
          };
          decisions.set(d.id, d);
          postedPos.set(d.id, pos);
        }
        break;
      }

      case "decision.confirm.posted": {
        // Its own kind, because a round is immutable once posted (above). Kept whatever its
        // `confirms` says — whether it is a confirm codemap could have written is judged below.
        const raw = data.decision as Decision & { confirms: Confirms };
        const r = exactRound(str(data?.round) ?? "");
        if (!r || raw.round !== (r.label ?? r.id) && raw.round !== r.id) { refuse(e, "a confirm needs its round and a decision in it"); break; }
        const malformedConfirm = checkDecision(raw);
        if (malformedConfirm) { refuse(e, malformedConfirm); break; }
        const cf = raw.confirms as unknown as Record<string, unknown> | undefined;
        const confirmId = e.id;
        if (decisions.has(confirmId)) { refuse(e, `confirm ${confirmId} is already posted`); break; }
        decisions.set(confirmId, {
          id: confirmId, label: raw.id, round: r.id, ref: raw.ref, kind: raw.kind, payload: normalizeQuestion(raw.payload), options: raw.options,
          hash: decisionHash(raw), postedAt: typeof e.at === "string" ? e.at : "", postingEvent: e.id, answers: [],
          confirms: { answer: str(cf?.answer) ?? "", readings: Array.isArray(cf?.readings) ? cf.readings as Mapping[][] : [] },
        });
        postedPos.set(confirmId, pos);
        break;
      }

      case "decision.answer.revised": {
        const proof = data?.via?.kind === "revision-relay" ? data.via.proof : undefined;
        if (data?.via?.kind === "revision-relay" && (!isObject(proof) || typeof proof.answer !== "string"
          || (proof.question !== undefined && !isObject(proof.question)))) { refuse(e, "a relayed revision needs its question and answer"); break; }
        const d = exactDecision(str(data?.decision) ?? "");
        const validList = d && !checkListRevision(d, data?.revision ?? { findings: [], issues: [] }, data?.list)
          && listRevisionMatchesAnswer(d, data?.list, data?.via);
        if (d?.presentation?.question.kind === "list" && validList) {
          const list = data.list as ListRevision;
          const question = d.presentation.question;
          const marked = new Set(list.marked.map((item) => item.itemId));
          data = { ...data, questionnaireMeta: {
            id: d.presentation.questionnaire.id, publication: d.round,
            version: questionnaireVersion(rounds.get(d.round)!.questionnaire!), submission: e.id,
            attemptId: e.id, payloadHash: createHash("sha256").update(canonical(list)).digest("hex"),
            questionId: question.id, answer: { questionId: question.id, kind: "list", approveUnmarked: true,
              marked: list.marked },
            approvals: list.items.filter((id) => !marked.has(id)),
            corrections: list.marked.map((item) => ({ itemId: item.itemId, text: item.correction, verdict: "pending" as const })),
          } };
        }
        acceptAnswer(e, pos, data);
        break;
      }
      case "decision.answer.recorded":
        acceptAnswer(e, pos, data);
        break;


      case "decision.questionnaire.submitted": {
        const round = exactRound(str(data?.round) ?? "");
        const q = round?.questionnaire;
        const staged = data?.staged as StagedSubmission | undefined;
        if (!q || !staged || (e.subject !== q.id && e.subject !== round?.id) || !str(staged.attemptId) || !str(staged.payloadHash)) { refuse(e, "a submission needs its questionnaire round and staged attempt"); break; }
        if (isAgentActor(e.actor)) { refuse(e, "a questionnaire submission is the person's own act"); break; }
        const checked = stageSubmission(q, {
          questionnaireId: staged.questionnaireId, version: staged.version,
          attemptId: staged.attemptId, answers: staged.answers,
        });
        if (!checked.ok || checked.value.payloadHash !== staged.payloadHash
          || JSON.stringify(checked.value.listApprovals) !== JSON.stringify(staged.listApprovals)) { refuse(e, "the submission does not match its questionnaire or payload"); break; }
        const attemptKey = `${e.actor.principal}\0${round!.id}\0${staged.attemptId}`;
        if (seenQuestionnaireAttempts.has(attemptKey)) { refuse(e, `attempt ${staged.attemptId} is already submitted`); break; }
        const questions = new Map(q.sections.flatMap((section) => section.questions.map((question) => [question.id, question] as const)));
        const entries = checked.value.answers.map((answer) => {
          const d = [...decisions.values()].find((candidate) => candidate.round === round!.id && (candidate.label ?? candidate.id) === answer.questionId), question = questions.get(answer.questionId);
          if (!d || !question || d.round !== round.id || (postedPos.get(d.id) ?? Infinity) > pos) return null;
          let via: AnswerVia;
          if (answer.kind === "choice" && question.kind === "choice") {
            const selected = "optionId" in answer ? question.options.find((option) => option.id === answer.optionId) : undefined;
            via = selected ? { kind: "direct", option: selected.label }
              : { kind: "direct", words: "other" in answer ? answer.other : "" };
          } else if (answer.kind === "short" && question.kind === "short") {
            via = { kind: "direct", words: answer.text };
          } else if (answer.kind === "list" && question.kind === "list") {
            const marked = new Set(answer.marked.map((item) => item.itemId));
            const checkedLabels = marked.size
              ? question.items.filter((item) => marked.has(item.id)).map((item) => item.text)
              : [d.options.find((option) => option.approveAll)?.label ?? ""];
            via = { kind: "direct", checked: checkedLabels };
          } else return null;
          const approval = checked.value.listApprovals.find((x) => x.questionId === answer.questionId);
          const meta = {
            id: q.id, publication: round!.id, version: checked.value.version, submission: e.id,
            attemptId: staged.attemptId, payloadHash: staged.payloadHash,
            questionId: answer.questionId, answer,
            ...(approval ? { approvals: approval.approvedItemIds,
              corrections: answer.kind === "list" ? answer.marked.map((item) => ({
                itemId: item.itemId, text: item.correction, verdict: "pending" as const })) : [] } : {}),
          };
          return { d, answer, via, meta };
        });
        if (entries.some((entry) => !entry)) { refuse(e, "a submitted answer names no question of this questionnaire posted before it"); break; }
        seenQuestionnaireAttempts.add(attemptKey);
        for (const entry of entries) {
          const { d, answer, via, meta } = entry!;
          const answerId = questionnaireAnswerId(e.id, answer.questionId);
          acceptAnswer(e, pos, { decision: d.id, hash: d.hash, via, questionnaireMeta: meta }, answerId);
        }
        break;
      }

      case "decision.comparison.nominated": {
        nominationEvents.push({ e, pos });
        break;
      }

      case "decision.comparison.requested":
      case "decision.comparison.judged":
      case "decision.comparison.resolved": {
        comparisonEvents.push({ e, pos });
        break;
      }



      case "decision.withdrawn": {
        withdrawalEvents.push({ e, pos });
        break;
      }

      // A person's pick on a held withdrawal, from before the linear log. Nothing holds now, so
      // it is skipped as older — never refused, which on read would be damage. The door refuses it.
      case "decision.conflict.resolved": break;

      case "decision.reading.recorded": {
        const answer = str(data?.answer), agent = str(data?.reader?.agent);
        // A reading without codemap's own parse of the reader's verdict is dropped (S0.7, H7.12):
        // its mapping is the session's, not the reader's, so it cannot bind.
        // Nor one without the brief the reader was launched with (P3.4), which a build before
        // codemap wrote the brief could not record: those words go back to unread.
        if (!answer || !agent || !validVerdict(data.reader.verdict, data.reader.unclear) || !str(data.reader.launchedAt) || !str(data.reader?.verified?.session) || !str(data.reader.brief)
          || !validMaps(data.session?.maps)) { refuse(e, "a reading needs its answer, reader, verdict, launch, session, brief and the session's reading"); break; }
        readingEvents.push({ e, pos });
        break;
      }
    }
  });

  // --- what the log says, applied to the set -------------------------------------------

  const kept = (id: string) => { const x = answersById.get(id); return x && x.d.answers.includes(x.a) ? x : undefined; };
  const sourceEventId = (id: string) => answerEvents.get(id)?.id ?? id;

  // Which confirms carry a confirm's meaning: judged once the cut is known, against the set.
  for (const c of decisions.values()) {
    if (!c.confirms) continue;
    const why = confirmRefusal(decisions, c, kept(c.confirms.answer));
    if (why) {
      c.confirms.invalid = why;
      refuseId(c.postingEvent, `not a confirm codemap could have posted: ${why}`);
      if (!answersById.has(c.confirms.answer)) c.confirms.never = true;
      // Keep the question and verified words intact, but a malformed confirmation
      // cannot borrow authority from effect-bearing options (2026-09-24 round, Q3).
      for (const a of c.answers) { a.ruled = []; a.unruled = []; a.park = undefined; a.parkWaits = undefined; a.separately = undefined; }
      continue;
    }
    // The request is answered by any pick that carries its meaning; typed words never answer it (Q1.3).
    let latest: FoldedAnswer | undefined;
    for (const { a: p, c: on } of picks) if (on === c && meaning(p.options[0], c.confirms.readings) !== undefined && (!latest || outranksByTime(p, latest))) latest = p;
    if (latest) c.confirms.picked = latest.id;
  }

  // Which readings count: in log order, one per answer and one answer per reader (S0.8(c)),
  // and only an ACCEPTED reading claims either slot (owner, P1.2): a rejected one never counted.
  const readings = new Map<string, { e: LogEvent; pos: number }>();
  const readerUsed = new Map<string, string>();
  for (const r of readingEvents) {
    const data = r.e.data as any, x = kept(data.answer), agent = data.reader.agent as string;
    if (!x) { refuse(r.e, `no answer ${data.answer}`); continue; }
    if (readings.has(data.answer)) { refuse(r.e, `answer ${data.answer} already has a reading`); continue; }
    if (readerUsed.has(agent)) { refuse(r.e, `reader ${agent} already read answer ${readerUsed.get(agent)}`); continue; }
    const unreadable = readingRefusal(decisions, x.d, x.a, { verdict: data.reader.verdict, unclear: data.reader.unclear, session: data.session.maps, launchedAt: data.reader.launchedAt, brief: data.reader.brief, manifest: data.reader.manifest });
    if (unreadable) { refuse(r.e, unreadable); continue; }
    readings.set(data.answer, r);
    readerUsed.set(agent, data.answer);
  }

  // Readings, then the person's picks on confirms, onto every answer still free — in log order
  // of the answers, and each binding decided from the answer and its own events alone.
  const byLog = [...answersById.values()].filter((x) => x.d.answers.includes(x.a) && x.a.free && x.d.kind !== "words").sort((x, y) => x.a.seq - y.a.seq);
  const confirmable = new Set(byLog.map((x) => x.a));
  /** Log position of the withdrawal that retired an answer or a whole question, by id. */
  const withdrawnAt = new Map<string, number>();
  /**
   * Who ruled through words `a` as of log position `pos`: only the confirm picks before it, less
   * those withdrawn (pick or confirm) before it. Every REFUSAL keyed on the ruler asks this at the
   * refused event's own position (review round 2, C16: "Validations are for the database at the
   * time the item was created not the future"; owner: judged by who ruled when it was taken).
   * `rulerOf` is the ruler NOW and stays the projected value; at the tip the two agree.
   */
  const rulerAt = (a: FoldedAnswer, pos: number): Actor => {
    if (!confirmable.has(a)) return a.by;
    const before = (id: string) => (withdrawnAt.get(id) ?? Infinity) < pos;
    const { decided } = confirmVerdict(a, picks, ({ a: p, c }) => p.seq < pos && !before(p.id) && !before(c.id));
    return decided?.maps ? decided.pick.by : a.by;
  };
  for (const { a, d } of byLog) {
    const r = readings.get(a.id);
    if (r) {
      const rd = (r.e.data as any).reader, ses = (r.e.data as any).session;
      const unclear = str(rd.unclear);
      const maps = validVerdict(rd.verdict, rd.unclear)!, sm = validMaps(ses.maps)!;
      a.reading = {
        id: r.e.id, agree: !unclear && mapsKey(maps) === mapsKey(sm),
        reader: { agent: rd.agent, maps, launchedAt: rd.launchedAt },
        session: { reading: str(ses.reading) ?? "", maps: sm },
        ...(str((r.e.data as any).asks) ? { asks: (r.e.data as any).asks } : {}),
        ...(unclear ? { unclear } : {}),
      };
    }
    // A person's word on these words, from anyone who confirms them (R3). A withdrawn Yes is not
    // a pick (plan 2.2). Typed words on a confirm are read like any reply and never carry this meaning.
    const verdict = confirmVerdict(a, picks, ({ a: p }) => !excludedPicks.has(p.id));
    if (verdict.rejected.length) a.rejected = verdict.rejected;
    if (verdict.dispute) a.confirmDispute = verdict.dispute;
    const decided = verdict.decided;
    if (decided?.maps) {
      // As of when the words were typed, from the pick that decided (S0.1): its id names the copies.
      a.confirmed = { answer: decided.pick.id, at: decided.pick.givenAt, maps: decided.maps, by: decided.pick.by };
      a.ruledBy = decided.pick.by;
      bind(decisions, answersById, d, a, decided.maps, decided.pick.id, decided.pick.seq);
    } else if (!decided && !a.confirmDispute && a.reading?.agree) {
      bind(decisions, answersById, d, a, a.reading.reader.maps, a.reading.id, readings.get(a.id)!.pos);
    }
  }

  // The presentation is an immutable human-visible snapshot.
  for (const d of decisions.values()) for (const a of d.answers) if (a.revision) {
    const rev = a.revision;
    const targets = Array.isArray(rev.of) ? rev.of.map((id) => d.answers.find((x) => x.id === id)) : [];
    const findings = Array.isArray(rev.findings) ? rev.findings : [];
    const issues = Array.isArray(rev.issues) ? rev.issues : [];
    const resolution = rev.resolves;
    const scopeValid = resolution ? !!d.resolves && targets.length === 1
      && resolution.priorResolution === targets[0]?.id
      && canonical([...resolution.answers].sort()) === canonical([...d.resolves.answers].sort())
      && resolution.shownHash === d.hash && !findings.length && !issues.length
      : (findings.length > 0 || issues.length > 0)
        && findings.every((f) => typeof f === "string" && (named(d).length ? named(d).includes(f) : d.kind === "words" && f === d.id))
        && issues.every((issue) => validIssue(issue) && namedIssues(d).some((named) => issueKey(named) === issueKey(issue)))
        && new Set(findings).size === findings.length
        && new Set(issues.map(issueKey)).size === issues.length;
    const samePrincipal = targets.every((x) => x?.by.principal === a.by.principal);
    const answerEvent = answerEvents.get(a.id);
    const relay = answerEvent?.kind === "decision.answer.revised" && (answerEvent.data as any)?.via?.kind === "revision-relay"
      ? (answerEvent.data as any).via.proof : undefined;
    const relayQuestion = targets.every(Boolean) ? revisionRelayQuestion(d, targets as FoldedAnswer[],
      a.by.principal, { findings, ...(issues.length ? { issues } : {}) }) : undefined;
    const relayValid = relay && isAgentActor(a.by) && str(relay.entryId) && str(relay.session)
      && str(relay.toolUseId) && str(relay.answeredAt) && ms(relay.answeredAt) !== undefined
      && relayQuestion && relay.question && typeof relay.question === "object" && sameQuestion(relay.question, relayQuestion)
      && relay.answer === a.words && targets.every((x) => (ms(x!.givenAt) ?? Infinity) < ms(relay.answeredAt)!);
    const valid = (a.via === "direct" || a.via === "questionnaire" || !!relayValid) && a.verified && !a.sourceAnswer && targets.length > 0
      && targets.every((x) => x?.verified && !x.sourceAnswer && (x.via === "direct" || x.via === "questionnaire"))
      && new Set(rev.of).size === rev.of.length && scopeValid
      && !checkListRevision(d, { findings, issues }, (answerEvents.get(a.id)?.data as any)?.list)
      && listRevisionMatchesAnswer(d, (answerEvents.get(a.id)?.data as any)?.list,
        (answerEvents.get(a.id)?.data as any)?.via)
      // What it revises comes before it — the door's prefix says so; this is the read's half.
      // Not whether the reviser SAW it: that refused only hand-built events (round 3, O1).
      && targets.every((x) => x!.seq < a.seq);
    if (!valid) {
      a.revisionInvalid = "revision needs exact sources logged before it, a named scope and a verified human answer";
      refuseId(answerEvent?.id, a.revisionInvalid);
      a.cancelled = { by: a.id, reason: a.revisionInvalid };
      continue;
    }
    if (!samePrincipal) for (const target of targets as FoldedAnswer[]) {
      const affected = [
        ...findings.map((id) => ({ kind: d.kind === "words" ? "decision" as const : "finding" as const, id, by: a.id })),
        ...issues.map((issue) => ({ ...issue, by: a.id })),
      ];
      (target.revisedOutOn ??= []).push(...affected);
    }
    a.ruled = a.ruled.filter((r) => findings.includes(r.finding));
    a.unruled = a.unruled.filter((f) => findings.includes(f));
  }

  // Compare original responses, never a reader's copies or a confirmation timestamp.
  // Given-time order also handles a correction arriving before its earlier source.
  for (const d of decisions.values()) {
    const originals = d.answers.filter((a) => a.verified && !a.sourceAnswer);
    for (const a of originals) {
      if (!a.free && !a.reading && !a.confirmed) continue;
      const changed = originals.filter((b) => b.by.principal === a.by.principal && b.responseHash !== a.responseHash && outranksByTime(b, a));
      const newer = best(changed);
      if (newer) a.cancelled = { by: newer.id, reason: `response changed by ${newer.id}; a new reading is required` };
    }
  }
  // A confirmation can itself have interpreted words copied onto another question.
  // Propagate through source links until every dependent pending use is cancelled.
  let changed = true;
  while (changed) {
    changed = false;
    for (const d of decisions.values()) {
      if (d.confirms && !d.cancellation) {
        const source = answersById.get(d.confirms.answer)?.a;
        if (source?.cancelled) { d.cancellation = source.cancelled; changed = true; }
      }
      for (const a of d.answers) {
        if (a.cancelled) continue;
        const cancellation = d.cancellation ?? (a.sourceAnswer ? answersById.get(a.sourceAnswer)?.a.cancelled : undefined);
        if (cancellation) { a.cancelled = cancellation; changed = true; }
      }
    }
  }

  // A refused withdrawal stays visible with its reason; nothing is silently dropped. Each is judged
  // against the answers EARLIER in the log: one there that its author had not read refuses it
  // ("this changed since you read it"), never holds it.
  /** Where each question's first ruling withdrawal sits: answers after it are cancelled. */
  const retiredAt = new Map<string, number>();
  const applyWithdrawal = (e: LogEvent, pos: number, d: FoldedDecision, named: FoldedAnswer | undefined, reason: string) => {
    if (!named) {
      d.withdrawn = { id: e.id, by: e.actor, at: e.at, reason };
      if (!withdrawnAt.has(d.id)) withdrawnAt.set(d.id, pos);
      for (const a of d.answers) a.cancelled = { by: e.id, reason: `question withdrawn: ${reason}` };
      return;
    }
    // Whose rulings it retires is fixed when it is taken: a later pick that moves the ruler must
    // not move what an applied withdrawal withdrew (owner: "Bob's withdrawal stays applied").
    const ruler = rulerAt(named, pos).principal;
    for (const x of d.answers) if (rulerAt(x, pos).principal === ruler && !x.sourceAnswer) {
      x.withdrawn = { by: e.id, reason };
      x.cancelled = { by: e.id, reason: `ruling withdrawn: ${reason}` };
      if (!withdrawnAt.has(x.id)) withdrawnAt.set(x.id, pos);
    }
    if (!retiredAt.has(d.id)) retiredAt.set(d.id, pos);
  };
  for (const { e, pos } of withdrawalEvents) {
    const data = e.data as any;
    const d = decisions.get(str(data?.decision) ?? "");
    if (!d || !str(data?.reason) || e.subject !== d.id) { refuse(e, "a withdrawal needs its question and a reason"); continue; }
    const target = str(data?.answer);
    const known = data?.knownAnswers;
    if (!Array.isArray(known) || !known.every((id: unknown) => str(id))) { refuse(e, "a withdrawal needs the answers it knew of"); continue; }
    const sources = d.answers.filter((a) => a.verified && !a.sourceAnswer);
    const named = target ? sources.find((a) => a.id === target) : undefined;
    const refuseWithdrawal = (why: string) => {
      refuse(e, why);
      (d.withdrawals ??= []).push({ id: e.id, by: e.actor, at: e.at, reason: data.reason,
        ...(target ? { answer: target } : {}), knownAnswers: [...known], state: "refused", refused: why });
    };
    if (target && (!named || !known.includes(target))) { refuseWithdrawal("it names no current verified answer on this question"); continue; }
    if (isAgentActor(e.actor)) {
      // An agent never retires a ruling on its own: the person answers a relayed question.
      if (named) {
        const r = decisions.get(str(data?.relay) ?? "");
        // Before the withdrawal, not across the log: a later answer must not turn it into damage (C16).
        const ruler = rulerAt(named, pos);
        const theirs = r ? r.answers.filter((a) => a.seq < pos && a.verified && !a.sourceAnswer && !a.cancelled && a.by.principal === ruler.principal) : [];
        const latest = theirs.reduce<FoldedAnswer | undefined>((x, a) => (!x || outranksByTime(a, x) ? a : x), undefined);
        // The whole question, not its text alone (F28): same options, same order.
        const why = !r || !sameQuestion(r.payload, withdrawalQuestion(d, { id: named.id, by: named.by, words: named.words, ruledBy: ruler }, data.reason, r.ref))
          ? "an agent withdraws a ruling only as the person's answer to the relayed withdrawal question"
          : latest?.options[0] !== WITHDRAW_IT ? `${ruler.principal} has not answered "${WITHDRAW_IT}"`
          : !reads.saw(e.id, sourceEventId(latest.id)) ? "the withdrawal was written before the person's answer" : null;
        if (why) { refuseWithdrawal(why); continue; }
      } else {
        const why = withdrawalReviewRefusal(d, data.reason, data.review);
        if (why) { refuseWithdrawal(why); continue; }
      }
    } else if (named && rulerAt(named, pos).principal !== e.actor.principal) { refuseWithdrawal("only the person who gave a ruling withdraws it"); continue; }
    // The same withdrawal again changes nothing: a no-op, recorded (owner, Q5).
    const same = (!target && !!d.withdrawn) || !!named?.withdrawn;
    const earlier = sources.filter((a) => a.seq < pos);
    const unseen = earlier.filter((a) => !known.includes(a.id) || !reads.saw(e.id, sourceEventId(a.id)));
    if (!same && unseen.length) { refuseWithdrawal(`an answer arrived after you read the question: ${unseen.map((a) => a.id).join(", ")}`); continue; }
    // A question with an answer is withdrawn ruling by ruling; the op says so before this does.
    if (!same && !target && earlier.length) { refuseWithdrawal(`${d.ref} has a submitted answer; name the exact answer to withdraw its ruling`); continue; }
    (d.withdrawals ??= []).push({ id: e.id, by: e.actor, at: e.at, reason: data.reason,
      ...(target ? { answer: target } : {}), knownAnswers: [...known],
      ...(str(data?.relay) ? { relay: data.relay } : {}), state: same ? "settled" : "applied" });
    // Withdrawing your ruling withdraws only your answers; a colleague's earlier answer stands
    // (owner, Q4).
    if (!same) applyWithdrawal(e, pos, d, named, data.reason);
  }

  // Anything given on a question after its ruling was withdrawn needs a fresh question — except
  // from a colleague whose answer stood through the withdrawal, who may still revise or re-answer
  // it (owner, O2).
  for (const d of decisions.values()) {
    const at = retiredAt.get(d.id);
    const retired = d.answers.find((a) => a.withdrawn)?.withdrawn;
    if (at === undefined || !retired) continue;
    const stood = new Set(d.answers.filter((a) => a.seq < at && !a.withdrawn && !a.cancelled && a.verified && !a.sourceAnswer)
      .map((a) => rulerOf(a).principal));
    for (const a of d.answers) if (!a.withdrawn && !a.cancelled && a.seq > at && !stood.has(rulerOf(a).principal))
      a.cancelled = { by: retired.by, reason: `this question has a withdrawn ruling; ask a fresh question` };
  }

  // A withdrawal also invalidates any interpretation copies and confirmations that
  // depended on the retired source. A late receipt remains history, never authority.
  let withdrawnDependency = true;
  while (withdrawnDependency) {
    withdrawnDependency = false;
    for (const d of decisions.values()) {
      if (d.confirms && !d.cancellation) {
        const source = answersById.get(d.confirms.answer)?.a;
        if (source?.cancelled) { d.cancellation = source.cancelled; withdrawnDependency = true; }
      }
      for (const a of d.answers) {
        if (a.cancelled) continue;
        const cancellation = d.cancellation ?? (a.sourceAnswer ? answersById.get(a.sourceAnswer)?.a.cancelled : undefined);
        if (cancellation) { a.cancelled = cancellation; withdrawnDependency = true; }
      }
    }
  }

  for (const d of decisions.values()) if (d.resolves) {
    const targets = d.resolves.answers.map((id) => answersById.get(id)?.a);
    const at = postedPos.get(d.id)!;
    if (targets.some((a) => !a?.verified) || rulerAt(targets[0]!, at).principal === rulerAt(targets[1]!, at).principal
      || targets.some((a) => !d.payload.question.includes(JSON.stringify(a!.words)))) {
      d.resolutionInvalid = "it does not show two different people's exact verified rulings";
      refuseId(d.postingEvent, d.resolutionInvalid);
    }
  }

  // A later correction of a resolution replaces that resolution's authority. Applying every
  // historical choice in turn would mark both source answers as losers and leave no intent.
  const resolutions = new Map<string, { answer: FoldedAnswer; selected?: string; newIntent: boolean }[]>();
  for (const d of decisions.values()) if (d.resolves && !d.resolutionInvalid) {
    const byPrincipal = new Map<string, FoldedAnswer>();
    for (const answer of d.answers) {
      if (!answer.verified || answer.resolvedOutBy || answer.cancelled) continue;
      const prev = byPrincipal.get(rulerOf(answer).principal);
      if (!prev || outranksByTime(answer, prev)) byPrincipal.set(rulerOf(answer).principal, answer);
    }
    for (const choice of byPrincipal.values()) {
      const selected = d.resolves.answers.find((id) => choice.options[0] === `Preserve ${id}`);
      const newIntent = !!(choice.nothing && choice.reading?.agree && choice.words.length > 0);
      if (!selected && !newIntent) continue;
      const key = [...d.resolves.answers].sort().join("\0");
      resolutions.set(key, [...(resolutions.get(key) ?? []), { answer: choice, selected, newIntent }]);
    }
  }
  for (const [key, choices] of resolutions) {
    // Different principals' independent resolutions need another human decision. Time alone
    // cannot silently choose between them; their source answers remain candidates meanwhile.
    if (new Set(choices.map((x) => rulerOf(x.answer).principal)).size > 1) continue;
    const latest = choices.reduce((best, x) => outranksByTime(x.answer, best.answer) ? x : best);
    const pair = key.split("\0");
    for (const t of decisions.values()) for (const a of t.answers)
      if (pair.includes(a.sourceAnswer ?? a.id) && (latest.newIntent || (a.sourceAnswer ?? a.id) !== latest.selected)) a.resolvedOutBy = latest.answer.id;
  }

  // A nomination may have arrived before its source answers on another writer. Judge it
  // against the complete set and keep only exact verified source identities and named scope.
  for (const { e, pos } of nominationEvents) {
    const data = e.data as any, ids = data?.answers;
    if (!Array.isArray(ids) || ids.length !== 2 || !ids.every((id: unknown) => str(id)) || ids[0] === ids[1]
      || !str(data?.reason) || !Array.isArray(data?.findings) || !Array.isArray(data?.issues ?? [])
      || (!data.findings.length && !(data.issues ?? []).length)
      || !data.findings.every((f: unknown) => str(f)) || new Set(data.findings).size !== data.findings.length
      || !(data.issues ?? []).every(validIssue)) { refuse(e, "a nomination needs two distinct answers, a reason and its findings or issues"); continue; }
    if (e.subject !== [...ids].sort().join("/")) { refuse(e, "a nomination's subject is its two answers"); continue; }
    const first = answersById.get(ids[0]), second = answersById.get(ids[1]);
    if (!first?.a.verified || !second?.a.verified || first.a.sourceAnswer || second.a.sourceAnswer
      || rulerAt(first.a, pos).principal === rulerAt(second.a, pos).principal) { refuse(e, "a nomination compares two different people's own verified answers"); continue; }
    const scope = new Set([...named(first.d), ...named(second.d)]);
    const issueScope = new Set([...namedIssues(first.d), ...namedIssues(second.d)].map(issueKey));
    if (!data.findings.every((f: string) => scope.has(f))
      || !(data.issues ?? []).every((issue: CanonicalIssueReference) => issueScope.has(issueKey(issue)))) { refuse(e, "a nomination names only findings and issues its questions name"); continue; }
    (first.d.nominations ??= []).push({ id: e.id, by: e.actor, at: e.at,
      answers: [ids[0], ids[1]], findings: data.findings,
      ...((data.issues ?? []).length ? { issues: data.issues } : {}), reason: data.reason });
  }

  // Follow-ups last: a copy's id exists only once its binding is made (Q13).
  for (const d of decisions.values()) {
    const src = d.origin ? answersById.get(d.origin.answer) : undefined;
    if (src) (src.d.followUps ??= []).push(d.id);
  }

  const base: SharedDecisions = { rounds: [...rounds.values()], decisions: [...decisions.values()], questions: [...questions.values()], comparisons: [] };
  base.comparisons = foldComparisons(base, comparisonEvents, refuse, reads, rulerAt);
  applyComparisonFrontier(base);
  // One entry per event: an event refused in two passes (a submission with two bad answers) is one refusal.
  const once = new Set<string>();
  return { value: base, refused: refused.filter((r) => !once.has(r.id) && !!once.add(r.id)) };
}

/** Why `maps` cannot bind words `a` on `d`, or null: every decision it names is in the same
 *  round, was posted before the words were given, takes options, and was not already replaced
 *  in the admission context — an unknown time satisfies neither — and each is picked once,
 *  or `(none)` alone, unless it is multi-select (R3). */
export function bindRefusal(decisions: Map<string, FoldedDecision>, d: FoldedDecision, a: FoldedAnswer, maps: Mapping[]): string | null {
  if (a.cancelled) return a.cancelled.reason;
  const given = ms(a.givenAt);
  if (given === undefined) return "the words have no time that parses";
  const picks = new Map<string, (string | null)[]>();
  for (const m of maps) {
    const t = decisions.get(m.decision);
    if (!t || t.round !== d.round) return `${m.decision} is not a question in round ${d.round}`;
    if (t.kind === "words") return `${t.ref} takes words, not options`;
    if (t.confirms?.invalid) return `${t.ref} is an invalid confirmation: ${t.confirms.invalid}`;
    if (m.option !== null && !t.options.some((o) => o.label === m.option)) return `"${m.option}" is not an option of ${t.ref} (${t.options.map((o) => o.label).join(" / ")})`;
    const posted = ms(t.postedAt);
    if (posted === undefined || !(posted < given)) return `${t.ref} was posted after the words were typed (${a.givenAt})`;
    picks.set(t.id, [...(picks.get(t.id) ?? []), m.option]);
  }
  for (const [id, p] of picks) {
    const t = decisions.get(id)!;
    if (p.includes(null) && p.length > 1) return `${t.ref} is read as ${NONE} and as a pick at once`;
    if (p.length > 1 && t.kind === "options" && t.payload.multiSelect !== true) return `${t.ref} takes one option, and the reading picks ${p.length}`;
  }
  return null;
}

const canBind = (decisions: Map<string, FoldedDecision>, d: FoldedDecision, a: FoldedAnswer, maps: Mapping[]): boolean => bindRefusal(decisions, d, a, maps) === null;

/**
 * Why a reading of words `a` on `d` would not be accepted, or null — one predicate for the op,
 * which asks it before writing, and the fold (plan P-b). Each end checks the slots (one reading
 * per answer, one answer per reader) against its own record. The reader's verdict must be able
 * to bind, and an unclear reading's session side. A disagreement whose session side cannot bind
 * still claims the slot — the first verdict counts (owner, Q2.2) — and its confirm offers the
 * reader's reading alone; `reader_brief` refuses such a session side, so only a hand-built
 * event reaches it.
 */
export function readingRefusal(decisions: Map<string, FoldedDecision>, d: FoldedDecision, a: FoldedAnswer,
  r: { verdict: unknown; unclear?: unknown; session: unknown; launchedAt: unknown; brief: unknown; manifest?: BriefEntry[] }): string | null {
  if (d.kind === "words") return `${d.ref} takes words: they are the answer, never read onto options`;
  if (!a.free || a.elsewhere) return `answer ${a.id} is not words waiting for a reading`;
  const launched = ms(typeof r.launchedAt === "string" ? r.launchedAt : undefined);
  // Launched after the words were typed, or it cannot have read them (plan B2).
  if (launched === undefined || !(launched > Date.parse(a.givenAt))) return `the reader was launched at ${String(r.launchedAt)}, before the words were typed at ${a.givenAt}: it cannot have read them`;
  const verdict = validVerdict(r.verdict, r.unclear), session = validMaps(r.session);
  if (!verdict) return "the reader's verdict is empty, and it does not say unclear";
  if (!session) return "the session's reading is empty";
  const sides = str(r.unclear) ? [session] : [verdict];
  for (const side of sides) {
    const why = bindRefusal(decisions, d, a, side);
    if (why) return `${side === verdict ? "the reader's verdict" : "your reading"} cannot bind: ${why}`;
  }
  if (!str(r.brief)) return "the reading carries no brief";
  return briefRefusal(decisions, d, a, r.brief as string, verdict, r.manifest);
}

/**
 * Bind words `a` by `maps`: its own decision's lines onto `a`; every other decision's onto a
 * copy there, which is a verified answer on that decision like any other and ranks there by
 * the words' given time (owner, S0.3 "Admit, ranked"). `source` names the reading or call.
 */
function bind(decisions: Map<string, FoldedDecision>, answersById: Map<string, { a: FoldedAnswer; d: FoldedDecision }>,
  d: FoldedDecision, a: FoldedAnswer, maps: Mapping[], source: string, pos: number): void {
  const byDecision = new Map<string, (string | null)[]>();
  for (const m of maps) byDecision.set(m.decision, [...(byDecision.get(m.decision) ?? []), m.option]);
  a.free = false;
  if (!byDecision.has(d.id)) a.elsewhere = true;
  for (const [id, picks] of byDecision) {
    const t = decisions.get(id)!;
    const options = picks.filter((p): p is string => p !== null).map((p) => t.options.find((o) => o.label === p)!);
    let target = a;
    if (t !== d) {
      // The same message relayed to that question too answers it there already (B1.4).
      if (a.once && t.answers.some((x) => x.once === a.once)) continue;
      target = { ...a, id: `${source}/${t.id}`, sourceAnswer: a.sourceAnswer ?? a.id, seq: pos, options: [], ruled: [], unruled: [], free: false };
      delete target.park; delete target.parkWaits; delete target.separately; delete target.flags; delete target.nothing;
      delete target.elsewhere; delete target.reading; delete target.confirmed; delete target.rejected; delete target.revision;
      t.answers.push(target);
      answersById.set(target.id, { a: target, d: t });
    }
    if (!options.length) { target.nothing = true; continue; }
    rule(t, target, { picked: options }, a.verified);
  }
}

/** An answer's words, its picks, and whether it is verified — or null when it binds to
 *  nothing this fold can check. */
function resolve(d: FoldedDecision, via: AnswerVia, actor: Actor, questions: Map<string, LoggedQuestion>, rounds: Map<string, DecisionRound>): Resolved | null {
  if (!via || typeof via !== "object") return null;
  switch (via.kind) {
    case "question": {
      const q = questions.get(via.question);
      // The logged call bound this question to this decision's round, and carries its payload
      // exactly (B1.4, S0.8(d)).
      const bound = q?.bound[d.payload.question];
      const legacyRound = rounds.get(d.round)?.label === bound
        && [...rounds.values()].filter((round) => round.label === bound).length === 1;
      if (!q || (bound !== d.round && !legacyRound) || !q.questions.some((x) => sameQuestion(x, d.payload))) return null;
      const v = q.answers[d.payload.question];
      // What a transcript records: a string, or a list of them for a multi-select.
      if (typeof v !== "string" && !(Array.isArray(v) && v.every((x) => typeof x === "string"))) return null;
      const list = Array.isArray(v) ? v : [v];
      const picked = list.map((l) => d.options.find((o) => o.label === l));
      // An empty multi-select is the person's answer, but never a pick: on a bulk question
      // "nothing marked" would otherwise approve every item (F60). A reader reads it.
      const words = list.length ? list.join(", ") : "none selected";
      // The call is kept whatever its time says — it is a fact about the transcript — but an
      // answer through it needs a time to rank by (P2.1 (5)).
      if (ms(q.answeredAt) === undefined) return null;
      const call = { verified: true, givenAt: q.answeredAt, once: loggedQuestionOnce(q), words };
      if (!list.length) return { ...call, picked: [], free: true };
      if (d.kind !== "words" && picked.every(Boolean) && (list.length === 1 || d.payload.multiSelect)) {
        return { ...call, picked: picked as DecisionOption[], free: false };
      }
      // Other text, a label with words appended, or a multi-select element that is words: the
      // person's own, and read by the reader (C14).
      return { ...call, picked: [], free: true };
    }
    case "revision-relay": {
      const proof = via.proof;
      if (!isAgentActor(actor) || !str(proof?.session) || !str(proof?.toolUseId)
        || !str(proof?.entryId) || !str(proof?.answeredAt) || ms(proof.answeredAt) === undefined
        || !str(proof?.answer)) return null;
      if (d.presentation?.question.kind === "list") {
        const parsed = parseListRelayAnswer(proof.answer);
        const marked = new Set(parsed?.marked.map((item) => item.itemId) ?? []);
        const labels = parsed && (marked.size
          ? d.presentation.question.items.filter((item) => marked.has(item.id)).map((item) => item.text)
          : [d.options.find((option) => option.approveAll)?.label]);
        const picked = labels?.map((label) => d.options.find((option) => option.label === label));
        return { verified: true, givenAt: proof.answeredAt,
          once: `revision:${proof.session}\0${proof.toolUseId}`,
          words: proof.answer, picked: picked?.every(Boolean) ? picked as DecisionOption[] : [],
          free: !picked?.every(Boolean) };
      }
      const picked = d.options.find((option) => option.label === proof.answer);
      return { verified: true, givenAt: proof.answeredAt,
        once: `revision:${proof.session}\0${proof.toolUseId}`,
        words: proof.answer, picked: picked ? [picked] : [], free: !picked };
    }
    case "message":
      // Always the reader's to bind, never a parser's — "D13 A" included (owner, H5).
      if (!str(via.session) || !str(via.entryId) || !str(via.text) || !str(via.at) || Number.isNaN(Date.parse(via.at)) || via.round !== d.round) return null;
      return { verified: true, givenAt: via.at, once: `m:${via.session}\0${via.entryId}`, words: via.text, picked: [], free: true };
    case "unverified":
      if (!str(via.words)) return null;
      return { verified: false, words: via.words, picked: [], free: true };
    case "direct": {
      if (isAgentActor(actor)) return null;   // the page is a person's door, never an agent's
      const page = { verified: true };
      if (via.park !== undefined) return typeof via.park === "string" ? { ...page, words: `park ${via.park}`, picked: [], park: via.park, free: false } : null;
      if (d.kind === "bulk" && via.checked !== undefined) {
        if (!Array.isArray(via.checked) || !via.checked.every((c) => typeof c === "string")) return null;
        const picked = via.checked.map((c) => d.options.find((o) => o.label === c));
        if (!picked.length || !picked.every(Boolean)) return null;
        return { ...page, words: via.checked.join(", "), picked: picked as DecisionOption[], free: false };
      }
      const o = typeof via.option === "string" ? d.options.find((x) => x.label === via.option) : undefined;
      if (o) return { ...page, words: o.label, picked: [o], free: false };
      if (str(via.words)) return { ...page, words: via.words!, picked: [], free: true };
      return null;
    }
  }
  return null;
}

// --- the ranking (plan A2, S0.5) ---------------------------------------------------------

/** In the ranking: every answer something has bound — a pick, a park, a bulk answer, words
 *  read or confirmed, including words that rule nothing — and not one about other questions. */
const ranks = (a: FoldedAnswer): boolean => !a.free && !a.elsewhere && !a.resolvedOutBy && !a.cancelled && !a.withdrawn;

/** `x` outranks `y`: verified first, then the later given, then the later in the log. */
const outranks = (x: FoldedAnswer, y: FoldedAnswer): boolean =>
  x.verified !== y.verified ? x.verified
    : Date.parse(x.givenAt) !== Date.parse(y.givenAt) ? Date.parse(x.givenAt) > Date.parse(y.givenAt) : x.seq > y.seq;

const best = (as: FoldedAnswer[]): FoldedAnswer | undefined => as.reduce<FoldedAnswer | undefined>((b, a) => (!b || outranks(a, b) ? a : b), undefined);

/** A global standing exists only when one principal remains on every named scope. */
export const standing = (d: FoldedDecision): FoldedAnswer | undefined => {
  if (d.withdrawn) return undefined;
  const scopes: (Pick<CanonicalIssue, "kind" | "id"> & Partial<CanonicalIssue>)[] = [
    ...named(d).map((id) => ({ kind: "finding" as const, id })), ...namedIssues(d),
  ];
  if (!scopes.length) scopes.push({ kind: "decision", id: d.id });
  const authorities = scopes.map((scope) => currentAnswersForIssue(d, scope));
  if (authorities.some((xs) => xs.length !== 1)) return undefined;
  const ids = new Set(authorities.map((xs) => xs[0]!.id));
  return ids.size === 1 ? authorities[0]![0] : undefined;
};

/** A per-issue standing is undefined when independent principals still have authority. */
export const standingForFinding = (d: FoldedDecision, finding: string): FoldedAnswer | undefined => {
  const authorities = currentAnswersForIssue(d, { kind: "finding", id: finding });
  return authorities.length === 1 ? authorities[0] : undefined;
};

export const standingForIssue = (d: FoldedDecision, issue: CanonicalIssueReference): FoldedAnswer | undefined => {
  const authorities = currentAnswersForIssue(d, issue);
  return authorities.length === 1 ? authorities[0] : undefined;
};

/** Words still waiting for a binding on `d`: unread, read as unclear, or read two ways. */
const pending = (d: FoldedDecision): FoldedAnswer[] => d.answers.filter((a) => a.free && !a.elsewhere && !a.cancelled);

/** Whether the answer ruled — picked something — rather than parked, awaited or ruled nothing. */
const decides = (a: FoldedAnswer | undefined): boolean => !!a && !a.free && !a.nothing && a.park === undefined && a.parkWaits === undefined;

/**
 * Whether binding free words `a` on `d` could still change a standing answer (owner, Q1.2 "While
 * they could change something"): some question they may be read onto (`readable`, so the two
 * cannot drift) has nothing standing, or a standing answer a bound copy would outrank. A copy on
 * another question ranks at the binding's log position (`bind`), i.e. after everything standing.
 * A confirm with no effects is skipped — words bound onto it never answer the request (Q1.3) —
 * Each question retains its own scope; a related later question changes nothing here.
 */
function couldChange(byId: Map<string, FoldedDecision>, d: FoldedDecision, a: FoldedAnswer): boolean {
  if (a.cancelled) return false;
  return readable(byId, d, a).some((t) => {
    if (t.confirms && t.options.every((o) => !o.effects.length)) return false;
    const top = standing(t);
    if (top && !outranks(t === d ? a : { ...a, seq: Infinity }, top)) return false;
    return true;
  });
}

/** Words that can no longer change anything (owner, P3.3 "Stop surfacing", with Q1.2's test):
 *  bound some way, or no question they may be
 *  read onto would change. */
function moot(byId: Map<string, FoldedDecision>, d: FoldedDecision, a: FoldedAnswer): boolean {
  return !d.answers.includes(a) || !a.free || a.elsewhere === true || !couldChange(byId, d, a);
}

/** The words on `d` still worth showing: pending and not moot. */
const surfacing = (byId: Map<string, FoldedDecision>, d: FoldedDecision): FoldedAnswer[] =>
  pending(d).filter((p) => couldChange(byId, d, p));

/** The words a confirm asks about, if they are still an answer here. */
export function confirmedWords(byId: Map<string, FoldedDecision>, c: FoldedDecision): { d: FoldedDecision; a: FoldedAnswer } | undefined {
  if (!c.confirms) return undefined;
  for (const d of byId.values()) { const a = d.answers.find((x) => x.id === c.confirms!.answer); if (a) return { d, a }; }
  return undefined;
}

/**
 * Where a confirm's REQUEST stands (owner, Q1.3 "The request only"): `answered` once a pick
 * carries its meaning; `unverifiable` when it is not one codemap could have written, or names
 * words never recorded (it binds nothing and holds nothing); `no longer needed` when its words
 * were cut or are moot (it stops holding and waiting — P3.3); else `open` (it holds and waits on
 * you). Words typed on the confirm never enter it: they are read like any reply.
 */
export type ConfirmState = "open" | "answered" | "no longer needed" | "unverifiable";
export function confirmState(byId: Map<string, FoldedDecision>, c: FoldedDecision): ConfirmState | undefined {
  if (!c.confirms) return undefined;
  if (c.cancellation) return "no longer needed";
  if (c.confirms.picked) return "answered";
  if (c.confirms.invalid && c.confirms.never) return "unverifiable";
  const t = confirmedWords(byId, c);
  if (!t || moot(byId, t.d, t.a)) return "no longer needed";
  return c.confirms.invalid ? "unverifiable" : "open";
}

export interface Superseding { answer: string; words: string; state: "unread" | "unclear" | "disputed"; rejected?: Mapping[][] }

/**
 * Verified words that would outrank the standing answer if something bound them, while they
 * are unread, unclear or in dispute (owner, P4.1 + plan A3): the ruling stands, and the
 * decision — and every finding it names — is marked possibly superseded until they are bound,
 * or a later verified answer rules.
 */
export function possiblySuperseded(d: FoldedDecision, byId: Map<string, FoldedDecision>): Superseding[] {
  const a = standing(d);
  // A confirm's own words are read like any reply, and there is no confirm of a confirm.
  if (!a || d.confirms) return [];
  const words = surfacing(byId, d);
  return words.filter((p) => p.verified).map((p) => ({
    answer: p.id, words: p.words,
    state: !p.reading ? "unread" as const : p.reading.unclear ? "unclear" as const : "disputed" as const,
    ...(p.rejected ? { rejected: p.rejected } : {}),
  }));
}

/** The exact source context a reader sees. It includes the frozen stakeholder form when present. */
export function comparisonSource(s: SharedDecisions, answerId: string, ruler: (a: FoldedAnswer) => Actor = rulerOf): AnswerSource | undefined {
  const d = s.decisions.find((decision) => decision.answers.some((a) => a.id === answerId && !a.sourceAnswer));
  const a = d?.answers.find((answer) => answer.id === answerId && !answer.sourceAnswer);
  if (!d || !a || !a.verified) return undefined;
  const round = s.rounds.find((r) => r.id === d.round);
  const formQuestion = round?.questionnaire?.sections.flatMap((section) => section.questions.map((question) => ({ section, question })))
    .find((x) => x.question.id === d.id);
  return { answerId, version: a.responseHash, principal: ruler(a).principal,
    questionId: d.id, questionVersion: d.hash,
    display: { prompt: d.payload.question, answerFormat: d.kind,
      context: JSON.stringify({ round: { id: round?.id, source: round?.source, notes: round?.notes },
        decision: { ref: d.ref, notes: d.notes, payload: d.payload },
        ...(formQuestion ? { questionnaire: { id: round?.questionnaire?.id, version: round?.questionnaire ? questionnaireVersion(round.questionnaire) : undefined,
          section: formQuestion.section, question: formQuestion.question } } : {}) }),
      options: d.options.map((option, index) => ({ ...option, displayed: d.payload.options[index] })),
      ...(formQuestion?.question.kind === "list" ? { items: formQuestion.question.items } : {}),
      ...(formQuestion ? { action: JSON.stringify(formQuestion.question) } : {}) },
    words: a.words };
}

export function comparisonRequestFor(s: SharedDecisions, id: string, answers: [string, string], issues: CanonicalIssue[],
  ruler: (a: FoldedAnswer) => Actor = rulerOf): ComparisonRequest | undefined {
  const left = comparisonSource(s, answers[0], ruler), right = comparisonSource(s, answers[1], ruler);
  if (!left || !right) return undefined;
  const ordered = [left, right].sort((a, b) => codeUnitOrder(a.answerId, b.answerId));
  const request = { id, left: ordered[0]!, right: ordered[1]!, issues,
    contextHash: comparisonContextHash({ left: ordered[0]!, right: ordered[1]!, issues }) };
  return validateComparisonRequest(request).ok ? request : undefined;
}

const same = (a: unknown, b: unknown) => canonical(a) === canonical(b);
/** A source ceases to be current when withdrawn, cancelled or outranked by its own principal. */
export function comparisonCurrentVersions(s: SharedDecisions, request: ComparisonRequest): Record<string, string | undefined> {
  const current: Record<string, string | undefined> = {};
  for (const source of [request.left, request.right]) {
    const d = s.decisions.find((x) => x.id === source.questionId);
    const a = d?.answers.find((x) => x.id === source.answerId);
    const relevant = d ? request.issues.filter((issue) => issue.kind === "decision"
      ? issue.id === d.id : issue.kind === "finding" ? named(d).includes(issue.id)
        || namedIssues(d).some((ref) => issueKey(ref) === issueKey(issue as CanonicalIssueReference))
        : namedIssues(d).some((ref) => issueKey(ref) === issueKey(issue as CanonicalIssueReference))) : [];
    // A prior resolution can exclude one alternative from current work without changing
    // its response version. The same exact pair must remain correctable toward that source.
    const stillAuthoritative = !!d && !!a && !d.withdrawn && !a.cancelled && !a.withdrawn
      && (!relevant.length || relevant.every((issue) => !revisedOutOn(a, issue)
        && !d.answers.some((later) => later !== a && later.verified && !later.sourceAnswer
          && rulerOf(later).principal === rulerOf(a).principal && !later.cancelled && !later.withdrawn
          && revisionCovers(later, issue) && outranksByTime(later, a))));
    current[source.answerId] = stillAuthoritative ? a!.responseHash : undefined;
  }
  return current;
}
export function comparisonSourcesCurrent(s: SharedDecisions, request: ComparisonRequest): boolean {
  const versions = comparisonCurrentVersions(s, request);
  return versions[request.left.answerId] === request.left.version
    && versions[request.right.answerId] === request.right.version;
}


/** Complete frozen comparison display, including the receipts outside this scope. */
export function resolutionShownHash(shown: unknown): string {
  return "resolution:v1:" + createHash("sha256").update(canonical({ version: 1, shown })).digest("hex");
}

/**
 * Replay accepts only requests whose source is exactly the posted question and response.
 * `reads` is over the whole log: a read set's path runs through events that are not comparisons.
 */
function foldComparisons(s: SharedDecisions, positioned: { e: LogEvent; pos: number }[], refuse: (e: LogEvent, why: string) => void, reads: ReadSets,
  rulerAt: (a: FoldedAnswer, pos: number) => Actor): FoldedComparison[] {
  const byId = new Map<string, { request: ComparisonRequest; judgments: ReaderJudgment[]; resolutions: HumanResolution[] }>();
  const events = positioned.map((x) => x.e), posOf = new Map(positioned.map((x) => [x.e, x.pos]));
  for (const e of events.filter((x) => x.kind === "decision.comparison.requested")) {
    const data = e.data as any;
    if (e.kind === "decision.comparison.requested") {
      const r = data?.request as ComparisonRequest;
      if (!r || typeof r !== "object" || !isObject(r.left) || !isObject(r.right)) { refuse(e, "a comparison request needs both sides"); continue; }
      if (e.subject !== r.id || !validateComparisonRequest(r).ok) { refuse(e, "a comparison request's subject is its id, and the request must be well formed"); continue; }
      if (byId.has(r.id)) { refuse(e, `comparison ${r.id} is already requested`); continue; }
      const leftDecision = s.decisions.find((d) => d.id === r.left.questionId);
      const rightDecision = s.decisions.find((d) => d.id === r.right.questionId);
      if (!leftDecision || !rightDecision || !r.issues.every((issue) => issue.universe === s.rounds[0]?.universe
        && (issue.kind === "decision" ? issue.scope === decisionScope(issue.universe)
          && leftDecision.id === rightDecision.id && issue.id === leftDecision.id
          : issue.kind === "finding" ? [leftDecision, rightDecision].some((d) => named(d).includes(issue.id)
              || namedIssues(d).some((ref) => issueKey(ref) === issueKey(issue as CanonicalIssueReference)))
            && validIssue(issue as CanonicalIssueReference)
            : [leftDecision, rightDecision].some((d) => namedIssues(d).some((x) => issueKey(x) === issueKey(issue as CanonicalIssueReference)))
              && validIssue(issue as CanonicalIssueReference)))) { refuse(e, "a comparison request names questions and issues that do not match"); continue; }
      // Its source principal is the ruler as of the request, what codemap derived then (C16).
      const pos = posOf.get(e)!;
      const expected = comparisonRequestFor(s, r.id, [r.left.answerId, r.right.answerId], r.issues, (a) => rulerAt(a, pos));
      if (!expected || !same(r, expected)) { refuse(e, "a comparison request is not the one codemap derives from its answers"); continue; }
      byId.set(r.id, { request: r, judgments: [], resolutions: [] });
    }
  }
  for (const e of events.filter((x) => x.kind !== "decision.comparison.requested")) {
    const data = e.data as any;
    if (e.kind === "decision.comparison.judged") {
      if (data?.judgment && !isObject(data.judgment.reader)) { refuse(e, "a comparison judgment needs its reader"); continue; }
      const j = data?.judgment ? { ...data.judgment, id: e.id, at: e.at } as ReaderJudgment : undefined;
      const r = byId.get(j?.requestId ?? "");
      const proof = data?.proof;
      if (!r || !j || e.subject !== j.requestId || !proof
        || proof.purpose !== "pair-comparison" || proof.requestId !== j.requestId
        || proof.contextHash !== r.request.contextHash || proof.brief !== comparisonBriefText(r.request)
        || proof.receipt !== j.reader.receipt || proof.agent !== j.reader.agent
        || proof.session !== j.reader.session || proof.launch !== j.reader.request
        || !str(proof.call) || !str(proof.toolUseId)) { refuse(e, "a comparison judgment needs its request and a proof of the reader that made it"); continue; }
      r.judgments.push(j);
    } else if (e.kind === "decision.comparison.resolved") {
      if (data?.resolution && !isObject(data.resolution.human)) { refuse(e, "a comparison resolution needs the person's act"); continue; }
      const h = data?.resolution ? { ...data.resolution, id: e.id, at: e.at } as HumanResolution : undefined;
      const r = byId.get(h?.requestId ?? "");
      const proof = data?.proof;
      // A judgment earlier in the log that the person never saw: refused, not resolved against
      // what they saw (owner, O4 — one of the four seen rules kept because it guards a lost update).
      const unseen = r?.judgments.find((j) => !reads.saw(e.id, j.id));
      if (unseen) { refuse(e, `a judgment (${unseen.id}) landed that this resolution did not see: review the comparison again`); continue; }
      const prior = r ? deriveComparison(r.request,
        { [r.request.left.answerId]: r.request.left.version,
          [r.request.right.answerId]: r.request.right.version },
        r.judgments.filter((j) => reads.saw(e.id, j.id)),
        r.resolutions.filter((prior) => reads.saw(e.id, prior.id))) : undefined;
      if (!r || !h || e.subject !== h.requestId || !proof
        || proof.purpose !== "human-comparison" || proof.contextHash !== r.request.contextHash
        || proof.shownHash !== h.human.shownHash || proof.receipt !== h.human.receipt
        || proof.principal !== e.actor.principal || h.human.principal !== e.actor.principal
        || !proof.shown || !same(proof.shown.request, r.request)
        || !Array.isArray(proof.shown.executions)
        || proof.executionsHash !== createHash("sha256").update(JSON.stringify(proof.shown.executions)).digest("hex")
        || !Array.isArray(proof.shown.judgments) || !Array.isArray(proof.shown.resolutions)
        || proof.shownHash !== resolutionShownHash(proof.shown)
        || !prior?.ok
        || !same(proof.shown.judgments, prior.value.acceptedJudgments)
        || !same(proof.shown.resolutions, prior.value.acceptedResolutions)
        || (isAgentActor(e.actor) && (proof.source !== "question" || !str(proof.session) || !str(proof.toolUseId)))
        || (!isAgentActor(e.actor) && proof.source !== "web" && proof.source !== "question")) { refuse(e, "a comparison resolution needs its request and a proof of what the person was shown"); continue; }
      r.resolutions.push(h);
    }
  }
  return [...byId.values()].map(({ request, judgments, resolutions }) => {
    const current = comparisonCurrentVersions(s, request);
    const result = deriveComparison(request, current, judgments, resolutions);
    return { request, judgments, resolutions,
      projection: result.ok ? result.value : { state: "pending", acceptedJudgments: [], acceptedResolutions: [],
        history: [], restrictsWork: true } as ComparisonProjection };
  });
}

const lostOn = (a: FoldedAnswer, issue: Pick<CanonicalIssue, "kind" | "id"> & Partial<CanonicalIssue>): boolean =>
  !!a.comparisonLostOn?.some((x) => x.kind === issue.kind && x.id === issue.id
    && (issue.universe === undefined || x.universe === issue.universe)
    && (issue.scope === undefined || x.scope === issue.scope));

function applyComparisonFrontier(s: SharedDecisions): void {
  const groups = new Map<string, { choices: Set<string>; losses: { answer: string; issue: CanonicalIssue; by: string }[] }>();
  for (const comparison of s.comparisons) {
    if (comparison.projection.state !== "resolved" || !comparison.projection.preservedAnswer) continue;
    const pair = [comparison.request.left.answerId, comparison.request.right.answerId].sort().join("\0");
    for (const issue of comparison.request.issues) {
      const key = `${pair}\0${issue.universe}\0${issue.kind}\0${issue.scope}\0${issue.id}`;
      const group = groups.get(key) ?? { choices: new Set<string>(), losses: [] };
      group.choices.add(comparison.projection.preservedAnswer);
      const losing = comparison.projection.preservedAnswer === comparison.request.left.answerId
        ? comparison.request.right.answerId : comparison.request.left.answerId;
      group.losses.push({ answer: losing, issue, by: comparison.projection.acceptedResolutions.at(-1)?.id ?? comparison.request.id });
      groups.set(key, group);
    }
  }
  for (const group of groups.values()) {
    if (group.choices.size !== 1) continue;
    for (const loss of group.losses) {
      const a = s.decisions.flatMap((d) => d.answers).find((x) => x.id === loss.answer);
      if (a) (a.comparisonLostOn ??= []).push({ ...loss.issue, by: loss.by });
    }
  }
}

const revisedOutOn = (a: FoldedAnswer, issue: Pick<CanonicalIssue, "kind" | "id"> & Partial<CanonicalIssue>): boolean =>
  !!a.revisedOutOn?.some((named) => named.kind === issue.kind && named.id === issue.id
    && (issue.universe === undefined || named.universe === undefined || named.universe === issue.universe)
    && (issue.scope === undefined || named.scope === undefined || named.scope === issue.scope));

const revisionCovers = (a: FoldedAnswer, issue: Pick<CanonicalIssue, "kind" | "id"> & Partial<CanonicalIssue>): boolean => {
  if (!a.revision) return true;
  if (issue.kind === "decision") return !!a.revision.resolves || a.revision.findings.includes(issue.id);
  if (issue.kind === "finding" && a.revision.findings.includes(issue.id)) return true;
  return !!a.revision.issues?.some((named) => named.kind === issue.kind && named.id === issue.id
    && (issue.universe === undefined || named.universe === issue.universe)
    && (issue.scope === undefined || named.scope === issue.scope));
};

/** Current per-principal authority, with no arbitrary winner between independent people. */
export function currentAnswersForIssue(d: FoldedDecision, issue: Pick<CanonicalIssue, "kind" | "id"> & Partial<CanonicalIssue>): FoldedAnswer[] {
  if (d.withdrawn) return [];
  const grouped = new Map<string, FoldedAnswer>();
  for (const a of d.answers) {
    if (!ranks(a) || lostOn(a, issue) || revisedOutOn(a, issue)
      || !revisionCovers(a, issue)) continue;
    const prior = grouped.get(rulerOf(a).principal);
    if (!prior || outranks(a, prior)) grouped.set(rulerOf(a).principal, a);
  }
  return [...grouped.values()];
}

export function answerHasCurrentAuthority(d: FoldedDecision, a: FoldedAnswer,
  issue: Pick<CanonicalIssue, "kind" | "id"> & Partial<CanonicalIssue>): boolean {
  return currentAnswersForIssue(d, issue).some((x) => x.id === a.id);
}

export function comparisonBriefText(request: ComparisonRequest): string {
  return JSON.stringify({ purpose: "pair-comparison", request,
    task: "Independently compare the complete human intent of both sources across the exact affected scope. Equal labels or effects do not prove equivalent meaning. Choose equivalent, incompatible, or unclear and explain your rationale. Do not infer a coordinator preference.",
    submit: { tool: "submit_comparison_judgment", request: request.id,
      verdict: "equivalent | incompatible | unclear", rationale: "your own explanation" } }, null, 2);
}

/** A comparison releases only its own pair and issue scope. Other holds remain. */
export function comparisonsForCandidate(s: SharedDecisions, candidate: IntentCandidate,
  issue?: Pick<CanonicalIssue, "kind" | "id"> & Partial<CanonicalIssue>): FoldedComparison[] {
  const pair = [...candidate.answers].sort().join("\0");
  return s.comparisons.filter((comparison) =>
    [comparison.request.left.answerId, comparison.request.right.answerId].sort().join("\0") === pair
    && (!issue || comparison.request.issues.some((x) => x.kind === issue.kind && x.id === issue.id
      && (issue.universe === undefined || x.universe === issue.universe)
      && (issue.scope === undefined || x.scope === issue.scope))));
}

export function comparisonRestricts(s: SharedDecisions, candidate: IntentCandidate,
  issue: Pick<CanonicalIssue, "kind" | "id"> & Partial<CanonicalIssue>): boolean {
  const matches = comparisonsForCandidate(s, candidate, issue);
  if (!matches.length || matches.some((comparison) => comparison.projection.restrictsWork)) return true;
  const choices = new Set(matches.map((comparison) => comparison.projection.preservedAnswer).filter(Boolean));
  return choices.size > 1;
}

// --- the views --------------------------------------------------------------------------
//
// The three things the person asked to be able to see (owner, 2026-09-23). Each is a function
// of the folded record — plus, for the second, the finding record, which alone says whether a
// ruling has been carried out.

export interface IntentCandidate {
  answers: [string, string]; decisions: [string, string]; findings: string[];
  issues?: CanonicalIssueReference[];
  decisionScope?: string[];
  sources: [{ principal: string; via: string; words: string; options: string[]; question: AskedQuestion; effects: DecisionOption[] },
    { principal: string; via: string; words: string; options: string[]; question: AskedQuestion; effects: DecisionOption[] }];
  evidence: "independent-principals" | "nominated";
  nomination?: { id: string; reason: string };
  humanKnowledge: "not established";
}

/** Mechanical candidates only. A later log event does not prove the later human knew the
 * earlier ruling when they answered; the reader still has to compare their full intent. */
export function intentCandidates(s: SharedDecisions): IntentCandidate[] {
  const current = new Map<string, { d: FoldedDecision; a: FoldedAnswer; finding: string }>();
  for (const d of s.decisions) {
    if (d.resolves || d.confirms?.invalid || d.withdrawn) continue;
    for (const a of d.answers) {
      if (!a.verified || a.resolvedOutBy || a.cancelled || a.elsewhere) continue;
      for (const finding of a.revision?.findings ?? named(d)) {
        if (!revisionCovers(a, { kind: "finding", id: finding })) continue;
        if (revisedOutOn(a, { kind: "finding", id: finding })) continue;
        if (lostOn(a, { kind: "finding", id: finding })) continue;
        const key = `${d.id}\0${rulerOf(a).principal}\0${finding}`;
        const prev = current.get(key);
        if (!prev || outranksByTime(a, prev.a)) current.set(key, { d, a, finding });
      }
    }
  }
  const all = [...current.values()];
  const out: IntentCandidate[] = [];
  const source = ({ d, a }: { d: FoldedDecision; a: FoldedAnswer }) => ({ principal: rulerOf(a).principal,
    via: a.via, words: a.words, options: a.options, question: d.payload, effects: d.options });
  const pairs = new Map<string, IntentCandidate>();
  for (let i = 0; i < all.length; i++) for (let j = i + 1; j < all.length; j++) {
    const x = all[i]!, y = all[j]!;
    if (x.finding !== y.finding) continue;
    const sx = x.a.sourceAnswer ?? x.a.id, sy = y.a.sourceAnswer ?? y.a.id;
    if (sx === sy || rulerOf(x.a).principal === rulerOf(y.a).principal) continue;
    const key = [sx, sy].sort().join("\0");
    const prior = pairs.get(key);
    if (prior) { if (!prior.findings.includes(x.finding)) prior.findings.push(x.finding); continue; }
    pairs.set(key, { answers: [sx, sy], decisions: [x.d.id, y.d.id], findings: [x.finding],
      sources: [source(x), source(y)],
      evidence: "independent-principals",
      humanKnowledge: "not established" });
  }
  const bugCurrent = new Map<string, { d: FoldedDecision; a: FoldedAnswer; issue: CanonicalIssueReference }>();
  for (const d of s.decisions) {
    if (d.resolves || d.confirms?.invalid || d.withdrawn) continue;
    for (const a of d.answers) {
      if (!a.verified || a.resolvedOutBy || a.cancelled || a.elsewhere) continue;
      for (const issue of namedIssues(d)) {
        if (!revisionCovers(a, issue) || revisedOutOn(a, issue)) continue;
        if (lostOn(a, issue)) continue;
        const key = `${d.id}\0${rulerOf(a).principal}\0${issueKey(issue)}`;
        const prev = bugCurrent.get(key);
        if (!prev || outranksByTime(a, prev.a)) bugCurrent.set(key, { d, a, issue });
      }
    }
  }
  const bugAnswers = [...bugCurrent.values()];
  for (let i = 0; i < bugAnswers.length; i++) for (let j = i + 1; j < bugAnswers.length; j++) {
    const x = bugAnswers[i]!, y = bugAnswers[j]!;
    if (issueKey(x.issue) !== issueKey(y.issue)) continue;
    const sx = x.a.sourceAnswer ?? x.a.id, sy = y.a.sourceAnswer ?? y.a.id;
    if (sx === sy || rulerOf(x.a).principal === rulerOf(y.a).principal) continue;
    const pair = [sx, sy].sort().join("\0");
    const prior = pairs.get(pair);
    if (prior) {
      if (!(prior.issues ?? []).some((issue) => issueKey(issue) === issueKey(x.issue)))
        prior.issues = [...(prior.issues ?? []), x.issue];
      continue;
    }
    pairs.set(pair, { answers: [sx, sy], decisions: [x.d.id, y.d.id], findings: [], issues: [x.issue],
      sources: [source(x), source(y)],
      evidence: "independent-principals",
      humanKnowledge: "not established" });
  }
  // Two people can answer the same explicit question even when it names no finding or bug.
  // That is still an independent intent comparison; no issue hold is invented for it.
  for (const d of s.decisions) {
    if (d.resolves || d.confirms?.invalid || d.withdrawn) continue;
    if (named(d).length || namedIssues(d).length) continue;
    const scopes: (Pick<CanonicalIssue, "kind" | "id"> & Partial<CanonicalIssue>)[] =
      [{ kind: "decision", id: d.id }];
    const current = d.answers.filter((a) => a.verified && !a.sourceAnswer && !a.cancelled
      && !a.withdrawn && !a.resolvedOutBy && !a.elsewhere
      && scopes.some((scope) => revisionCovers(a, scope) && !revisedOutOn(a, scope) && !lostOn(a, scope)));
    const byPrincipal = new Map<string, FoldedAnswer>();
    for (const a of current) {
      const prior = byPrincipal.get(rulerOf(a).principal);
      if (!prior || outranksByTime(a, prior)) byPrincipal.set(rulerOf(a).principal, a);
    }
    const distinct = [...byPrincipal.values()];
    for (let i = 0; i < distinct.length; i++) for (let j = i + 1; j < distinct.length; j++) {
      const x = distinct[i]!, y = distinct[j]!;
      const key = [x.id, y.id].sort().join("\0");
      const prior = pairs.get(key);
      if (prior) {
        prior.decisionScope = [...new Set([...(prior.decisionScope ?? []), d.id])];
        continue;
      }
      pairs.set(key, { answers: [x.id, y.id], decisions: [d.id, d.id], findings: [],
        decisionScope: [d.id], sources: [source({ d, a: x }), source({ d, a: y })],
        evidence: "independent-principals",
        humanKnowledge: "not established" });
    }
  }
  out.push(...pairs.values());
  const bySource = new Map([...all, ...bugAnswers].filter((x) => !x.a.sourceAnswer).map((x) => [x.a.id, x] as const));
  for (const d of s.decisions) for (const n of d.nominations ?? []) {
    const pair = [...n.answers].sort().join("\0");
    const already = pairs.get(pair);
    if (already) {
      for (const issue of n.issues ?? []) if (!(already.issues ?? []).some((x) => issueKey(x) === issueKey(issue)))
        already.issues = [...(already.issues ?? []), issue];
      continue;
    }
    const x = bySource.get(n.answers[0]), y = bySource.get(n.answers[1]);
    if (!x || !y || rulerOf(x.a).principal === rulerOf(y.a).principal) continue;
    pairs.set(pair, { answers: n.answers, decisions: [x.d.id, y.d.id], findings: n.findings,
      ...(n.issues?.length ? { issues: n.issues } : {}),
      sources: [source(x), source(y)], evidence: "nominated", nomination: { id: n.id, reason: n.reason },
      humanKnowledge: "not established" });
    out.push(pairs.get(pair)!);
  }
  return out;
}

export interface WaitingItem { decision: string; round: string; ref: string; why: string }

/** Parked through the whole of its date, by UTC date (H6.6). */
const parkedOn = (a: FoldedAnswer | undefined, today: string): boolean => a?.park !== undefined && a.park >= today;

const fmt = (s: SharedDecisions, maps: Mapping[]): string => maps.map((m) => {
  const t = s.decisions.find((x) => x.id === m.decision);
  return t ? `${t.ref} → ${m.option ?? NONE}` : `${m.decision} → ${m.option ?? NONE}`;
}).join("; ");

/**
 * What waits on the person: unanswered questions, and answers that need them again. `today`
 * (UTC, YYYY-MM-DD) comes from the op, never a clock in here: a park holds through its date
 * and, once it has passed, the decision is theirs again (bulk 3).
 */
export function waitingOnMe(s: SharedDecisions, today: string): WaitingItem[] {
  const out: WaitingItem[] = [];
  const byId = new Map(s.decisions.map((x) => [x.id, x]));
  for (const d of s.decisions) {
    if (d.cancellation || d.withdrawn || d.answers.some((a) => a.withdrawn)) continue;
    if (d.confirms?.invalid) {
      out.push({ decision: d.id, round: d.round, ref: d.ref, why: `not a confirm codemap can verify (${d.confirms.invalid}) — answering it binds nothing; ask for a new confirm` });
      continue;
    }
    const a = standing(d);
    const item = (why: string) => out.push({ decision: d.id, round: d.round, ref: d.ref, why });
    const cs = confirmState(byId, d);
    // An agent's unconfirmed words after your ruling: never applied over it, and never read,
    // so it cannot be told apart from agreement (owner, P3.1 (2); H6.8).
    if (a?.verified) for (const x of d.answers) if (!x.verified && x !== a && outranksByTime(x, a)) item(`an unconfirmed answer arrived after your ruling: "${x.words}"`);
    for (const p of surfacing(byId, d)) {
      if (p.reading?.unclear) item(`the reader could not tell which question your words answer: ${p.reading.unclear}`);
      else if (p.reading && !p.reading.agree) item(`your words were read two different ways: "${p.words}"`);
      if (p.rejected?.length) item(`you said a reading of your words was not what you meant ("${p.words}": ${fmt(s, p.rejected.at(-1)!)}): answer ${d.ref} again`);
    }
    for (const x of d.answers) if (x.confirmDispute)
      item(`two people answered the same confirm of "${x.words}" differently (${x.confirmDispute.picks.join(", ")}): it binds nothing until one of them changes their answer`);
    // A confirm's own standing answer is words on it, never a ruling: only the request waits on
    // you (Q1.3), and only while its words have not gone to a reader.
    if (d.confirms) {
      if (cs === "open" && !surfacing(byId, d).length) item(`confirm what your words on ${confirmedWords(byId, d)!.d.ref} meant`);
      continue;
    }
    if (!a) {
      // Unread words wait on an agent (`awaitingReading`), not on the person.
      if (!pending(d).length) item("not answered");
      continue;
    }
    if (parkedOn(a, today)) continue;   // under "parked", not here (H6.5)
    if (a.park !== undefined) item(`parked until ${a.park}, which has passed`);
    // Read, and ruled nothing: its findings are still undecided, so without this it would
    // wait on nobody (Q11, C20).
    if (d.resolves && a.nothing && a.reading?.agree)
      item(`your new intent \"${a.words}\" resolves the shown alternatives; ask a fresh valid question for the action it requires`);
    else if (a.nothing) item("your words were read, and they rule nothing here");
    if (a.parkWaits) item(`a park until ${a.parkWaits} that could not be verified as yours`);
    if (a.unruled.length) item(`settles that could not be verified as yours: ${a.unruled.join(", ")}`);
    for (const label of a.separately ?? []) {
      if (!(d.followUps ?? []).some((f) => byId.get(f)?.origin?.answer === a.id)) item(`you asked to rule on "${label}" separately, and it has not been asked yet`);
    }
  }
  for (const c of intentCandidates(s)) {
    const d = byId.get(c.decisions[0])!;
    out.push({ decision: d.id, round: d.round, ref: d.ref, why: `human rulings ${c.answers.join(" and ")} may conflict on intent; show both to the person and ask which to preserve before acting` });
  }
  return out;
}

/** Given later than `y` — the ranking's time order, ignoring verification. */
/**
 * Who rules through an answer: its confirmer when a confirm bound it, else its author (plan 2.1,
 * R3). Authority — withdrawal, comparison, sign-off, the `ruler:` line — keys on this; only a
 * revision and a changed response key on the words' author, `a.by`.
 */
export const rulerOf = (a: Pick<FoldedAnswer, "by" | "ruledBy">): Actor => a.ruledBy ?? a.by;

const outranksByTime = (x: FoldedAnswer, y: FoldedAnswer): boolean =>
  Date.parse(x.givenAt) !== Date.parse(y.givenAt) ? Date.parse(x.givenAt) > Date.parse(y.givenAt) : x.seq > y.seq;

export interface Parked { decision: string; round: string; ref: string; until: string; findings: string[] }

/** Decisions parked by the person, still within their date (owner, B3.1: "a separate park queue"). */
export function parked(s: SharedDecisions, today: string): Parked[] {
  const out: Parked[] = [];
  for (const d of s.decisions) {
    const a = standing(d);
    if (d.withdrawn || !parkedOn(a, today)) continue;
    out.push({ decision: d.id, round: d.round, ref: d.ref, until: a!.park!, findings: named(d) });
  }
  return out;
}

/** Every finding a decision's options act on. */
export const named = (d: Pick<Decision, "options"> & { confirms?: FoldedDecision["confirms"] }): string[] =>
  d.confirms?.invalid ? [] : [...new Set(d.options.flatMap((o) => o.effects.flatMap((e) => e.findings)))];

export const namedIssues = (d: Pick<Decision, "options"> & { confirms?: FoldedDecision["confirms"] }): CanonicalIssueReference[] => {
  if (d.confirms?.invalid) return [];
  const byKey = new Map<string, CanonicalIssueReference>();
  for (const o of d.options) for (const effect of o.effects) for (const issue of effectIssues(effect))
    byKey.set(issueKey(issue), issue);
  return [...byKey.values()];
};

export interface Unread { decision: string; round: string; ref: string; answer: string; words: string }

/** Free text the reader has not read yet — waiting on an agent, not on the person. An agent's
 *  unconfirmed words after a verified ruling are never sent to the reader (H6.8). */
export function awaitingReading(s: SharedDecisions): Unread[] {
  const out: Unread[] = [];
  const byId = new Map(s.decisions.map((x) => [x.id, x]));
  for (const d of s.decisions) {
    if (d.kind === "words" || d.withdrawn) continue;
    for (const x of surfacing(byId, d)) {
      // H6.8, as `record_reading` refuses it: words that may still change another question are
      // not thereby readable.
      if (x.reading || (!x.verified && standing(d)?.verified)) continue;
      out.push({ decision: d.id, round: d.round, ref: d.ref, answer: x.id, words: x.words });
    }
  }
  return out;
}

export interface Disputed { decision: string; round: string; ref: string; answer: string; words: string; reader: string; session: string }

/** The person's words, read two different ways by the reader and the session. */
export function readingsInDispute(s: SharedDecisions): Disputed[] {
  const out: Disputed[] = [];
  const byId = new Map(s.decisions.map((x) => [x.id, x]));
  for (const d of s.decisions) {
    for (const p of surfacing(byId, d)) {
      if (p.reading && !p.reading.agree && !p.reading.unclear) {
        out.push({ decision: d.id, round: d.round, ref: d.ref, answer: p.id, words: p.words, reader: fmt(s, p.reading.reader.maps), session: p.reading.session.reading || fmt(s, p.reading.session.maps) });
      }
    }
  }
  return out;
}

export interface Uncarried extends Ruled {
  decision: string; round: string; ref: string; answer: string; ruler: string;
}

/**
 * Rulings not yet carried out: every effect a standing answer ruled whose finding is still
 * open. A settle waits for the verifier; an unblock is fix work. `isOpen` is the finding
 * record's answer — this record never stores it.
 */
export function ruledNotCarriedOut(s: SharedDecisions, isOpen: (finding: string) => boolean): Uncarried[] {
  const out: Uncarried[] = [];
  const byId = new Map(s.decisions.map((x) => [x.id, x]));
  const contested = new Set(intentCandidates(s).flatMap((c) => c.findings));
  for (const d of s.decisions) for (const finding of named(d)) {
    const a = standingForFinding(d, finding);
    for (const r of a?.ruled.filter((r) => r.finding === finding) ?? [])
      if (isOpen(finding) && !contested.has(finding))
        out.push({ ...r, decision: d.id, round: d.round, ref: d.ref, answer: a!.id, ruler: rulerOf(a!).principal });
  }
  return out;
}

export interface Hold {
  decision: string; why: "undecided" | "ruled" | "comparison";
  answers?: [string, string];
  /** When this hold on the finding last began (owner, S0.4): a person's assignment keeps a
   *  held finding on the work queue only if made after it. */
  since: string;
}

/** Whether `d`, with `a` its standing answer so far, holds `finding` from open work. */
function holdsWith(d: FoldedDecision, a: FoldedAnswer | undefined, finding: string): boolean {
  if (!named(d).includes(finding)) return false;
  if (!decides(a)) return true;
  if (a!.ruled.some((r) => r.finding === finding && r.on === "settle")) return true;
  if (a!.unruled.includes(finding)) return true;
  return d.options.some((o) => a!.separately?.includes(o.label) && o.effects.some((e) => e.findings.includes(finding)));
}

/**
 * When `d`'s hold on `finding` last began: walked over the answers in the order they were
 * GIVEN, as the ranking reads them.
 */
function holdSince(d: FoldedDecision, finding: string): string | undefined {
  const given = d.answers.filter((a) => ranks(a) && !lostOn(a, { kind: "finding", id: finding })
    && (!a.revision || a.revision.findings.includes(finding)))
    .sort((x, y) => outranksByTime(x, y) ? 1 : -1);
  let since = holdsWith(d, undefined, finding) ? d.postedAt : undefined;
  const byPrincipal = new Map<string, FoldedAnswer>();
  for (const a of given) {
    const prior = byPrincipal.get(rulerOf(a).principal);
    if (!prior || outranks(a, prior)) byPrincipal.set(rulerOf(a).principal, a);
    const now = [...byPrincipal.values()].some((current) => holdsWith(d, current, finding));
    if (now && since === undefined) since = a.givenAt;
    else if (!now) since = undefined;
  }
  return since;
}
/**
 * Findings not to be offered as open work, and why: a decision on them is undecided, or a
 * standing settle ruling holds them for the verifier (owner: "Held for the verifier"). An
 * unblock ruling releases them. Derived, never stored — and the finding record decides whether
 * a ruled one has since closed.
 */
export function heldFindings(s: SharedDecisions, isOpen: (finding: string) => boolean): Map<string, Hold[]> {
  const out = new Map<string, Hold[]>();
  const byId = new Map(s.decisions.map((x) => [x.id, x]));
  const add = (d: FoldedDecision, f: string, why: Hold["why"]) => {
    // A closed finding is held by nothing (bulk item 1): the hold was on offering it as work.
    if (!isOpen(f)) return;
    const list = out.get(f) ?? [];
    if (list.some((x) => x.decision === d.id && x.why === why)) return;
    list.push({ decision: d.id, why, since: holdSince(d, f) ?? d.postedAt });
    out.set(f, list);
  };
  const byAnswer = new Map(s.decisions.flatMap((d) => d.answers.map((a) => [a.sourceAnswer ?? a.id, a] as const)));
  for (const c of intentCandidates(s)) for (const f of c.findings) {
    if (!isOpen(f)) continue;
    const d = byId.get(c.decisions[0])!;
    const times = c.answers.map((id) => byAnswer.get(id)?.givenAt ?? "");
    const list = out.get(f) ?? [];
    list.push({ decision: d.id, why: "comparison", answers: c.answers,
      since: times.every((t) => ms(t) !== undefined) ? times.sort((a, b) => ms(a)! - ms(b)!)[1]! : "" });
    out.set(f, list);
  }
  for (const d of s.decisions) {
    // An open confirm holds every finding of every decision its readings map — `(none)` too, as
    // its text says (Q2.3 (2)) — beside the decision's own hold (the discussion: "two entries is
    // fine"), from its own posting (S0.4, P3.5).
    if (d.confirms) {
      if (confirmState(byId, d) !== "open") continue;
      for (const r of d.confirms.readings) for (const m of r) for (const f of named(byId.get(m.decision)!)) add(d, f, "undecided");
      continue;
    }
    if (d.withdrawn || d.answers.some((a) => a.withdrawn)) continue;
    for (const f of named(d)) {
      const issue = { kind: "finding" as const, id: f };
      const authorities = currentAnswersForIssue(d, issue);
      if (!authorities.length && d.answers.some((a) => lostOn(a, issue))) continue;
      if (authorities.some((a) => a.ruled.some((r) => r.finding === f && r.on === "settle"))) {
        add(d, f, "ruled"); continue;
      }
      if (!authorities.length || authorities.some((a) => holdsWith(d, a, f))) add(d, f, "undecided");
    }
  }
  return out;
}

/** Typed shared issue holds. Legacy finding-only questions keep their existing id-based view;
 * canonical refs prevent a bug id or one review's finding id from borrowing another's hold. */
export function heldIssues(s: SharedDecisions, isOpen: (key: string) => boolean): Map<string, Hold[]> {
  const out = new Map<string, Hold[]>();
  const byId = new Map(s.decisions.map((d) => [d.id, d]));
  const namedKeys = (d: FoldedDecision) => namedIssues(d).map(issueKey);
  const holds = (d: FoldedDecision, a: FoldedAnswer | undefined, key: string): boolean => {
    if (!namedKeys(d).includes(key)) return false;
    if (!decides(a)) return true;
    const chosen = d.options.filter((o) => a!.options.includes(o.label))
      .flatMap((o) => o.effects.filter((effect) => effectIssues(effect).some((issue) => issueKey(issue) === key)));
    if (chosen.some((effect) => effect.on === "settle")) return true;
    if (chosen.some((effect) => effect.on === "unblock")) return false;
    return d.options.some((o) => a!.separately?.includes(o.label)
      && o.effects.some((effect) => effectIssues(effect).some((issue) => issueKey(issue) === key)));
  };
  const since = (d: FoldedDecision, issue: CanonicalIssueReference): string => {
    const key = issueKey(issue);
    const given = d.answers.filter((a) => ranks(a) && !lostOn(a, issue)
      && revisionCovers(a, issue))
      .sort((x, y) => outranksByTime(x, y) ? 1 : -1);
    let began = holds(d, undefined, key) ? d.postedAt : undefined;
    const byPrincipal = new Map<string, FoldedAnswer>();
    for (const a of given) {
      const prior = byPrincipal.get(rulerOf(a).principal);
      if (!prior || outranks(a, prior)) byPrincipal.set(rulerOf(a).principal, a);
      const now = [...byPrincipal.values()].some((current) => holds(d, current, key));
      if (now && began === undefined) began = a.givenAt;
      else if (!now) began = undefined;
    }
    return began ?? d.postedAt;
  };
  const add = (key: string, hold: Hold) => {
    if (!isOpen(key)) return;
    const list = out.get(key) ?? [];
    if (!list.some((x) => x.decision === hold.decision && x.why === hold.why
      && JSON.stringify(x.answers) === JSON.stringify(hold.answers))) list.push(hold);
    out.set(key, list);
  };
  for (const c of intentCandidates(s)) for (const issue of c.issues ?? []) {
    if (!comparisonRestricts(s, c, issue)) continue;
    const key = issueKey(issue);
    const answers = s.decisions.flatMap((d) => d.answers).filter((a) =>
      c.answers.includes(a.sourceAnswer ?? a.id));
    const times = answers.map((a) => a.givenAt).sort((a, b) => (ms(a) ?? 0) - (ms(b) ?? 0));
    add(key, { decision: c.decisions[0], why: "comparison", answers: c.answers,
      since: times.length >= 2 ? times[1]! : "" });
  }
  for (const d of s.decisions) {
    if (d.confirms) {
      if (confirmState(byId, d) !== "open") continue;
      for (const r of d.confirms.readings) for (const m of r) {
        const source = byId.get(m.decision);
        if (source) for (const key of namedKeys(source))
          add(key, { decision: d.id, why: "undecided", since: d.postedAt });
      }
      continue;
    }
    if (d.withdrawn || d.answers.some((a) => a.withdrawn)) continue;
    for (const issue of namedIssues(d)) {
      const key = issueKey(issue), authorities = currentAnswersForIssue(d, issue);
      if (!authorities.length && d.answers.some((a) => lostOn(a, issue))) continue;
      if (authorities.length && !authorities.some((a) => holds(d, a, key))) continue;
      const ruled = authorities.some((a) => d.options.some((o) => a.options.includes(o.label)
        && o.effects.some((effect) => effect.on === "settle"
          && effectIssues(effect).some((target) => issueKey(target) === key))));
      add(key, { decision: d.id, why: ruled ? "ruled" : "undecided", since: since(d, issue) });
    }
  }
  return out;
}

/** Every finding a possibly-superseded decision names, whether it holds it or not — a mark
 *  on the queues and catalogues that never withholds (owner, S0.8(a)). */
export function supersededFindings(s: SharedDecisions): Map<string, { decision: string; words: string[] }[]> {
  const out = new Map<string, { decision: string; words: string[] }[]>();
  const byId = new Map(s.decisions.map((x) => [x.id, x]));
  for (const d of s.decisions) {
    const p = possiblySuperseded(d, byId);
    if (!p.length) continue;
    for (const f of named(d)) out.set(f, [...(out.get(f) ?? []), { decision: d.id, words: p.map((x) => x.words) }]);
  }
  return out;
}

// --- writing --------------------------------------------------------------------------

/** The decisions fold, as the write door asks it (plan 1.1). */
export const decisionsDoor: DoorFold = (events, minted) => {
  const wrong = minted.kind === "decision.conflict.resolved"
    ? "nothing is held for a person to pick a side of: a withdrawal that conflicts is refused" : decisionEventShape(minted)
    ?? (minted.kind.startsWith("decision.comparison.")
      ? comparisonActRefusal(foldDecisionsReport(events.filter((x) => x.id !== minted.id)).value, minted) : null);
  return wrong ? { refused: [{ id: minted.id, why: wrong }] } : foldDecisionsReport(events);
};

/**
 * A comparison act's preconditions on the decisions log alone, against the log before it. In the
 * door, so a staged act's replay applies them as an inline act's write does (owner's one-door
 * rule); the act's own check keeps only what reads local data (executed closures).
 */
export function comparisonActRefusal(s: SharedDecisions, e: Pick<LogEvent, "id" | "kind" | "subject" | "at" | "data">): string | null {
  const data = e.data as Record<string, any> | undefined;
  if (e.kind === "decision.comparison.requested") {
    const r = data?.request as ComparisonRequest | undefined;
    if (!r?.left || !r.right || !Array.isArray(r.issues)) return null;   // the fold refuses the shape
    const pair = [r.left.answerId, r.right.answerId].sort().join("\0");
    const candidate = intentCandidates(s).find((x) => [...x.answers].sort().join("\0") === pair);
    if (!candidate) return "comparison candidate changed before append";
    const covered = r.issues.every((issue) => issue.kind === "decision"
      ? candidate.decisionScope?.includes(issue.id)
      : issue.kind === "finding" && candidate.findings.includes(issue.id)
        || (candidate.issues ?? []).some((ref) => canonicalIssueKey(ref) === canonicalIssueKey(issue as CanonicalIssueReference)));
    return covered ? null : "affected issue scope changed before append";
  }
  if (e.kind !== "decision.comparison.judged" && e.kind !== "decision.comparison.resolved") return null;
  const act = e.kind === "decision.comparison.judged" ? data?.judgment : data?.resolution;
  const current = s.comparisons.find((x) => x.request.id === e.subject);
  if (!current || !act || current.request.contextHash !== act.contextHash
    || (e.kind === "decision.comparison.judged" && current.projection.state === "resolved"))
    return `comparison changed before ${e.kind === "decision.comparison.judged" ? "judgment" : "resolution"} append`;
  if (!comparisonSourcesCurrent(s, current.request))
    return `an answer version changed before ${e.kind === "decision.comparison.judged" ? "judgment" : "resolution"} append`;
  const versions = comparisonCurrentVersions(s, current.request);
  const trial = { ...act, id: e.id, at: e.at };
  if (e.kind === "decision.comparison.judged") {
    const result = deriveComparison(current.request, versions, [...current.judgments, trial as ReaderJudgment], current.resolutions);
    return result.ok && result.value.acceptedJudgments.some((x) => x.id === e.id) ? null
      : "judgment is not independent or does not match the current comparison";
  }
  const result = deriveComparison(current.request, versions, current.judgments, [...current.resolutions, trial as HumanResolution]);
  return result.ok && result.value.acceptedResolutions.some((x) => x.id === e.id) ? null
    : "comparison has no established judgment or this correction does not match the authority frontier";
}

/**
 * What a decisions event names that the fold does not check (docs/sidecar-references.md, rows
 * 88-91, 96): a round's effects name findings and issues that exist, `follows` a posted decision,
 * `origin.answer` an answer; a logged question names rounds that were posted. Raw events.
 */
async function decisionReferences(read: ScopeReader, scope: string, events: LogEvent[], e: LogEvent): Promise<string | null> {
  const universe = scope.slice("decisions/".length);
  const d = e.data as Record<string, any> | undefined;
  const posted = events.filter((x) => x.kind === "decision.round.posted");
  const roundKnown = (r: string) => posted.some((x) => x.id === r || (x.data as Record<string, any> | undefined)?.round?.id === r);
  const decisionKnown = (id: string) => posted.some((x) => (((x.data as Record<string, any> | undefined)?.decisions as { id?: unknown }[] | undefined) ?? [])
    .some((q) => q?.id === id || `${x.id}:${String(q?.id)}` === id));
  if (e.kind === "decision.question.logged") {
    const missing = ((d?.rounds as unknown[] | undefined) ?? []).find((r) => typeof r === "string" && !roundKnown(r));
    return missing ? `no round ${String(missing)} was posted` : null;
  }
  if (e.kind !== "decision.round.posted") return null;
  const findings = new Map<string, Set<string>>();
  const createdIn = async (sc: string) => {
    let s = findings.get(sc);
    if (!s) { s = new Set((await read.read(sc)).filter((x) => x.kind === "finding.created" || x.kind === "bug.filed").map((x) => x.subject)); findings.set(sc, s); }
    return s;
  };
  let allFindings: Set<string> | null = null;
  for (const q of (d?.decisions as Record<string, any>[] | undefined) ?? []) {
    if (typeof q?.follows === "string" && !decisionKnown(q.follows)) return `no decision ${q.follows} to follow`;
    const origin = q?.origin?.answer;
    if (typeof origin === "string" && !events.some((x) => x.id === origin)) return `no answer ${origin} to follow up`;
    for (const opt of (q?.options as Record<string, any>[] | undefined) ?? []) {
      for (const eff of (opt?.effects as Record<string, any>[] | undefined) ?? []) {
        for (const f of (eff?.findings as unknown[] | undefined) ?? []) {
          if (typeof f !== "string") continue;
          if (!allFindings) {
            allFindings = new Set<string>();
            for (const sc of (await read.scopes()).filter((s) => s.startsWith(`findings/${universe}/`)))
              for (const id of await createdIn(sc)) allFindings.add(id);
          }
          if (!allFindings.has(f)) return `no finding ${f} in findings/${universe}`;
        }
        for (const i of (eff?.issues as { scope?: unknown; id?: unknown }[] | undefined) ?? []) {
          if (typeof i?.scope === "string" && typeof i.id === "string" && !(await createdIn(i.scope)).has(i.id))
            return `no issue ${i.id} in ${i.scope}`;
        }
      }
    }
  }
  return null;
}

registerDoor((scope) => scope.startsWith("decisions/"), (logRoot, scope) => async (events, minted) => {
  const own = await decisionsDoor(events, minted);
  const why = await decisionReferences(tipReader(logRoot), scope, events.filter((x) => x.id !== minted.id), minted);
  return why ? { refused: [...own.refused, { id: minted.id, why }] } : own;
});
registerReferences((scope) => scope.startsWith("decisions/"), async (scope, e, own, read) => {
  const why = await decisionReferences(read, scope, own, e);
  return why ? [{ id: e.id, kind: e.kind, cls: "reference", why }] : [];
});

/** One write, folded at the door: refused with the fold's reason, never appended to be refused later. */
const put = (logRoot: string, universe: string, actor: Actor, kind: string, subject: string, data: Record<string, unknown>) =>
  emitEventChecked(logRoot, decisionScope(universe), actor, async () => ({ kind, subject, data }), decisionsDoor);

export const postRoundEvent = (logRoot: string, universe: string, actor: Actor, round: Omit<DecisionRound, "postedBy" | "at">, decisions: Decision[]) =>
  put(logRoot, universe, actor, "decision.round.posted", round.id, { publication: 2, round, decisions });

export const postConfirmEvent = (logRoot: string, universe: string, actor: Actor, decision: Decision & { confirms: Confirms }) =>
  put(logRoot, universe, actor, "decision.confirm.posted", decision.id, { publication: 2, round: decision.round, decision });

export const logQuestionEvent = (logRoot: string, universe: string, actor: Actor, q: Omit<LoggedQuestion, "id" | "loggedBy" | "at">) =>
  put(logRoot, universe, actor, "decision.question.logged", q.toolUseId, q as unknown as Record<string, unknown>);

export const recordAnswerEvent = (logRoot: string, universe: string, actor: Actor, a: { decision: string; hash: string; via: AnswerVia; relayedBy?: string }) =>
  put(logRoot, universe, actor, "decision.answer.recorded", a.decision, a as unknown as Record<string, unknown>);

/** One locked append is the whole selected batch. A retry is the original receipt. */
export const submitQuestionnaireEvent = (
  logRoot: string, universe: string, actor: Actor, roundId: string, staged: StagedSubmission,
) => emitEventChecked(logRoot, decisionScope(universe), actor, async (events) => {
  if (isAgentActor(actor)) return { error: "questionnaire submission needs the principal's own act" };
  const s = foldDecisions(events);
  const exact = s.rounds.find((x) => x.id === roundId);
  const matches = exact ? [exact] : s.rounds.filter((x) => x.label === roundId);
  if (matches.length !== 1) return { error: matches.length ? `round ${roundId} is ambiguous; use ${matches.map((x) => x.id).join(", ")}` : `no round ${roundId}` };
  const round = matches[0]!;
  const q = round.questionnaire;
  if (!q || q.id !== staged.questionnaireId) return { error: "no published questionnaire with that round and ID" };
  const checked = stageSubmission(q, {
    questionnaireId: staged.questionnaireId, version: staged.version,
    attemptId: staged.attemptId, answers: staged.answers,
  });
  if (!checked.ok || checked.value.payloadHash !== staged.payloadHash
    || JSON.stringify(checked.value.listApprovals) !== JSON.stringify(staged.listApprovals))
    return { error: "submission no longer matches the frozen questionnaire or payload" };
  const previous = events.find((e) => e.kind === "decision.questionnaire.submitted"
    && (e.subject === round.id || e.subject === q.id) && (e.data as any)?.round === round.id
    && e.actor.principal === actor.principal
    && (e.data as any)?.staged?.attemptId === staged.attemptId);
  if (previous) return (previous.data as any)?.staged?.payloadHash === staged.payloadHash
    ? { existing: previous } : { error: "this attempt ID was already used with different answers" };
  for (const answer of checked.value.answers) {
    const d = s.decisions.find((x) => (x.label ?? x.id) === answer.questionId && x.round === round.id);
    if (!d || d.withdrawn) return { error: `question ${answer.questionId} is missing or withdrawn` };
  }
  return { kind: "decision.questionnaire.submitted", subject: round.id,
    data: { round: round.id, staged: checked.value } as unknown as Record<string, unknown> };
}, decisionsDoor);

export interface ReadingEvent {
  answer: string;
  /** Codemap's parse of the reader's own `submit_verdict` call, never the session's copy of it
   *  (plan B1, Q2.2). `brief`: the prompt it was launched with, which is codemap's own (P1.4);
   *  `verified.toolUseId` its launch, `verified.call` its submit. */
  reader: { agent: string; verdict: Mapping[]; unclear?: string; launchedAt: string; brief: string; manifest?: BriefEntry[]; verified: { session: string; toolUseId: string; call?: string; requestId?: string; receipt?: string } };
  /** What the asking session requested — the mapping the reader is compared against. */
  session: { reading?: string; maps: Mapping[] };
  asks?: string;
}

export const recordReadingEvent = (logRoot: string, universe: string, actor: Actor, a: ReadingEvent) =>
  put(logRoot, universe, actor, "decision.reading.recorded", a.answer, a as unknown as Record<string, unknown>);

export const nominateComparisonEvent = (logRoot: string, universe: string, actor: Actor,
  input: { answers: [string, string]; findings: string[]; issues?: CanonicalIssueReference[]; reason: string }) =>
  put(logRoot, universe, actor, "decision.comparison.nominated", [...input.answers].sort().join("/"), input);

export const withdrawDecisionEvent = (logRoot: string, universe: string, actor: Actor,
  input: { decision: string; answer?: string; reason: string; knownAnswers: string[];
    relay?: string; review?: WithdrawalReview }) =>
  emitEventChecked(logRoot, decisionScope(universe), actor, async (events) => {
    const d = foldDecisions(events).decisions.find((x) => x.id === input.decision);
    if (!d) return { error: `no decision ${input.decision}` };
    if (d.withdrawn) return { error: `${d.ref} is already withdrawn (${d.withdrawn.id})` };
    const sources = d.answers.filter((a) => a.verified && !a.sourceAnswer);
    if (canonical(sources.map((a) => a.id).sort()) !== canonical([...input.knownAnswers].sort()))
      return { error: "answers changed before withdrawal; read the decision again" };
    return { kind: "decision.withdrawn", subject: input.decision, data: input };
  }, decisionsDoor);

export const reviseAnswerEvent = (logRoot: string, universe: string, actor: Actor,
  input: { decision: string; hash: string; via: Extract<AnswerVia, { kind: "direct" | "revision-relay" }>;
    list?: ListRevision;
    revision: { of: string[]; findings: string[]; issues?: CanonicalIssueReference[];
      resolves?: { answers: [string, string]; priorResolution: string; shownHash: string } } }) =>
  emitEventChecked(logRoot, decisionScope(universe), actor, async (events) => {
    const d = foldDecisions(events).decisions.find((x) => x.id === input.decision);
    if (!d || d.hash !== input.hash || d.withdrawn || d.answers.some((a) => a.withdrawn))
      return { error: "the question or its authority changed before revision; read it again" };
    return { kind: "decision.answer.revised", subject: d.id, data: input };
  }, decisionsDoor);
