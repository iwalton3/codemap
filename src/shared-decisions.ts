/**
 * Decision rounds, folded from `decisions/<universe>`.
 *
 * Four events: `decision.round.posted`, `decision.question.logged`,
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
 * up in the fold"). A logged question, a relayed message or a reader's handback was checked
 * against the transcript on the machine that asked; a clone cannot re-read that transcript and
 * trusts the logger for it. Everything that travels is checked here.
 */
import { createHash } from "node:crypto";
import { emitEvent, type LogEvent } from "./eventlog.js";
import { isAgentActor } from "./identity.js";
import { canonical, normalizeQuestion, sameQuestion } from "./transcript.js";
import { ISO_DATE, type Actor, type AskedQuestion, type Decision, type DecisionEffect, type DecisionOption, type DecisionRound, type LoggedQuestion } from "./schema.js";

export const decisionScope = (universe: string): string => `decisions/${universe}`;

/** How an answer reached the log. */
export type AnswerVia =
  /** An `AskUserQuestion` call, logged by `log_question`. */
  | { kind: "question"; question: string }
  /** The person's whole typed message, copied from the transcript by its entry id, with
   *  when they typed it and the round the relaying agent says it answered (H5). */
  | { kind: "message"; session: string; entryId: string; text: string; at: string; round: string }
  /** An agent's words the transcript could not confirm. Unblocks only (C8). */
  | { kind: "unverified"; words: string }
  /** The person on the page. `checked` is a bulk decision's items to rule on separately. */
  | { kind: "direct"; option?: string; park?: string; words?: string; checked?: string[] };

export interface Mapping { decision: string; option: string | null }

/** One effect an answer ruled, finding by finding. */
export interface Ruled { finding: string; on: "settle" | "unblock"; as?: "refuted" }

export interface FoldedAnswer {
  id: string;
  by: Actor;
  at: string;
  via: AnswerVia["kind"];
  /** The words are the person's (C8): an unverified answer's settles wait for them. */
  verified: boolean;
  /** When the person gave it — the transcript entry's time, or the page's — never when it
   *  was recorded: between two verified answers, the later GIVEN stands (H7.9). */
  givenAt: string;
  /** Log position of the event that made it: breaks a tie in `givenAt` (S0.5). */
  seq: number;
  /** What it was given through, so one call or message answers a decision once (B1.4). */
  once?: string;
  /** The person's words as recorded — never an agent's summary of them. */
  words: string;
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
  /** The reader's verdict, parsed by codemap from the reader's own handback (plan B1). */
  reading?: {
    id: string; agree: boolean;
    reader: { agent: string; maps: Mapping[]; launchedAt: string };
    session: { reading: string; maps: Mapping[] };
    asks?: string;
    /** The reader could not tell which question the words answer, and why: nothing binds (H5). */
    unclear?: string;
  };
  /** The person's answer to a confirm-this-reading question on these words (S0.1, S0.2). */
  confirmed?: { call: string; at: string; maps: Mapping[] };
  /** Readings the person said were not what they meant — never offered again. */
  rejected?: Mapping[][];
  /** Accepted, but looks errant — shown, never silently applied as if ordinary (R19). */
  flags?: string[];
}

export interface FoldedDecision extends Decision {
  hash: string;
  answers: FoldedAnswer[];
  /** A decision posted later that replaces this one. */
  replacedBy?: string;
  /** It was posted to replace a decision another had already replaced — two clones replacing
   *  at once. The first in log order replaces; this one stays a live question (H6.4). */
  replaceLost?: string;
  /** Decisions posted since, citing an answer here as their origin (C1, bulk items). */
  followUps?: string[];
}

export interface SharedDecisions {
  rounds: DecisionRound[];
  decisions: FoldedDecision[];
  questions: LoggedQuestion[];
}

const str = (v: unknown): string | undefined => (typeof v === "string" && v.trim() ? v : undefined);

/** What an answer binds to: the question as shown and every option's effects. */
export function decisionHash(d: Pick<Decision, "kind" | "payload" | "options">): string {
  return "d:sha256:" + createHash("sha256")
    .update(canonical({ kind: d.kind, payload: normalizeQuestion(d.payload), options: d.options })).digest("hex").slice(0, 24);
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
      if ((x.on !== "settle" && x.on !== "unblock") || !Array.isArray(x.findings) || !x.findings.length || !x.findings.every((f) => str(f))) return "an effect needs findings and on: settle | unblock";
      // Refused rather than defaulted: a default would record "accepted, won't fix" as "the
      // finding was wrong" (owner, 2026-09-23).
      if (x.on === "settle" && x.as !== "refuted") return `a settle must say how it closes — as: "refuted" is the only state until finding states can say "accepted"`;
      if (x.on === "unblock" && x.as !== undefined) return "an unblock closes nothing, so it takes no `as`";
    }
    if (o.park !== undefined) {
      if (multi) return "a multi-select question cannot offer a park: picked with other options it means nothing (owner, 2026-09-23)";
      // A park with no date in the verified text is not a park (C23).
      if (typeof o.park !== "string" || !ISO_DATE.test(o.park) || !o.label.includes(o.park.slice(0, 10))) return `option "${o.label}" parks without its date in the label`;
    }
  }
  if (d.options.filter((o) => o.recommended).length > 1) return "at most one option is recommended";
  // What the person is shown carries what it acts on, so words typed back can be bound to it
  // by what was said (owner, H2/H5: "the question should just say 'Close D13 (f_09deadcafef3)?'").
  if (!new RegExp(`\\b${d.ref}\\b`).test(d.payload.question)) return `the question text must name its ref ${d.ref}`;
  for (const o of d.options) for (const e of o.effects) for (const f of e.findings) {
    if (!d.payload.question.includes(f)) return `the question text must name ${f}, which option "${o.label}" acts on`;
  }
  return null;
}

// --- confirm-this-reading (owner, S0.1 + S0.2) ----------------------------------------------
//
// A DERIVED question, posted nowhere: codemap writes its exact text, the agent asks it
// verbatim, and `log_question` logs the call. The fold recognises the text — it recomputes the
// payload from what it parsed and requires an exact match — so the logged call is the only
// record, it holds no finding and it never waits as unanswered.

const CONFIRM = "Confirm reading of answer ";
export const CONFIRM_YES = "Yes";
export const CONFIRM_NO = "No — ask me again";
const NONE = "(none)";

/** What picking `o` on `d` does, as the person reads it in a confirm question. */
function describe(d: Pick<Decision, "kind" | "options">, o: DecisionOption): string {
  if (d.kind === "bulk") return o.approveAll ? "approves every item not checked" : "checked: ruled on separately";
  if (o.park) return `parks until ${o.park.slice(0, 10)}`;
  const parts = o.effects.map((e) => `${e.on === "settle" ? `settles ${e.findings.join(", ")} as ${e.as}` : `unblocks ${e.findings.join(", ")}`}`);
  return parts.length ? parts.join("; ") : "no effect";
}

/** One mapping as a line: `D13 → Not a defect (settles f_… as refuted)`. */
export function actionLine(d: Pick<Decision, "ref" | "kind" | "options">, option: string | null): string | null {
  if (option === null) return `${d.ref} → ${NONE}`;
  const o = d.options.find((x) => x.label === option);
  return o ? `${d.ref} → ${o.label} (${describe(d, o)})` : null;
}

const lines = (byId: Map<string, Pick<Decision, "ref" | "kind" | "options">>, maps: Mapping[]): string[] | null => {
  const out: string[] = [];
  for (const m of maps) {
    const t = byId.get(m.decision);
    const l = t ? actionLine(t, m.option) : null;
    if (!l) return null;
    out.push(l);
  }
  return out;
};

/**
 * The confirm question for answer `a` on decision `d`: one reading (Yes / No — ask me again;
 * "Other" is the person's own words), or the two readings of a dispute as options. Null when a
 * mapping names something that does not exist.
 */
export function confirmPayload(decisions: FoldedDecision[], d: FoldedDecision, a: FoldedAnswer, readings: Mapping[][]): AskedQuestion | null {
  const byId = new Map(decisions.map((x) => [x.id, x]));
  const rendered = readings.map((r) => lines(byId, r));
  if (!readings.length || readings.length > 2 || rendered.some((r) => !r || !r.length)) return null;
  // JSON-quoted, so words with a newline stay on one line and the lines below stay parseable.
  const head = `${CONFIRM}${a.id} (${d.ref}, round ${d.round}). Your words at ${a.givenAt}:\n${JSON.stringify(a.words)}`;
  if (readings.length === 1) {
    return normalizeQuestion({
      question: `${head}\n${rendered[0]!.join("\n")}\nIs that what you meant?`, header: "Confirm",
      options: [{ label: CONFIRM_YES, description: "Bind exactly the action above, as of when you typed it" }, { label: CONFIRM_NO, description: "Not what I meant: ask the question again" }],
    });
  }
  return normalizeQuestion({
    question: `${head}\n${rendered.map((r, i) => `Reading ${i + 1}:\n${r!.join("\n")}`).join("\n")}\nWhich did you mean?`, header: "Confirm",
    options: rendered.map((r, i) => ({ label: `Reading ${i + 1}`, description: r!.join("; ") })),
  });
}

/** The answer id a question claims to confirm, if it is shaped as a confirm at all. */
export const confirmTarget = (q: AskedQuestion): string | undefined => {
  if (!q.question.startsWith(CONFIRM)) return undefined;
  return q.question.slice(CONFIRM.length).split(" ")[0] || undefined;
};

/** The readings a confirm question offers, recovered by recomputing it — never by trusting
 *  the text. Null unless the recomputed payload is exactly the question asked. */
function confirmReadings(decisions: FoldedDecision[], d: FoldedDecision, a: FoldedAnswer, q: AskedQuestion): Mapping[][] | null {
  // A dispute's two readings are the stored ones; one reading is the agent's own (S0.1),
  // parsed off the question and then checked by recomputing it.
  if (a.reading && !a.reading.agree && !a.reading.unclear) {
    const two = [a.reading.reader.maps, a.reading.session.maps];
    const p = confirmPayload(decisions, d, a, two);
    return p && sameQuestion(p, q) ? two : null;
  }
  const byRef = new Map(decisions.filter((x) => x.round === d.round).map((x) => [x.ref, x]));
  const maps: Mapping[] = [];
  for (const l of q.question.split("\n").slice(2, -1)) {
    const ref = /^(D\d+) → /.exec(l)?.[1];
    const t = ref ? byRef.get(ref) : undefined;
    if (!t) return null;
    const option = [null, ...t.options.map((o) => o.label)].find((o) => actionLine(t, o) === l);
    if (option === undefined) return null;
    maps.push({ decision: t.id, option });
  }
  const p = confirmPayload(decisions, d, a, [maps]);
  return p && sameQuestion(p, q) ? [maps] : null;
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

const validMaps = (m: unknown): Mapping[] | null => Array.isArray(m) && m.every((x) => x && typeof x === "object" && str(x.decision) && (x.option === null || str(x.option)))
  ? (m as Mapping[]) : null;

/** When decision `d`'s replacement was posted, if it has one. */
const replacedAt = (d: FoldedDecision, decisions: Map<string, FoldedDecision>, rounds: Map<string, DecisionRound>): number | undefined => {
  const r = d.replacedBy ? decisions.get(d.replacedBy) : undefined;
  return r ? Date.parse(rounds.get(r.round)!.at) : undefined;
};

export function foldDecisions(events: LogEvent[]): SharedDecisions {
  const rounds = new Map<string, DecisionRound>();
  const decisions = new Map<string, FoldedDecision>();
  const questions = new Map<string, LoggedQuestion>();
  const answersById = new Map<string, { a: FoldedAnswer; d: FoldedDecision }>();
  // Position of each decision's posting, so an answer reaches only a decision posted before it.
  const postedAt = new Map<string, number>();
  /** The first well-formed reading of each answer, and the confirms of it, in log order —
   *  applied after the log is read, so no binding depends on what else was recorded first. */
  const readings = new Map<string, { e: LogEvent; pos: number }>();
  const readerUsed = new Map<string, string>();
  const confirms: { pos: number; call: LoggedQuestion; answer: string; q: AskedQuestion; value: string | string[] }[] = [];

  // Questions first: a logged call is a fact about the transcript, and an answer event may
  // arrive from another writer before it in fold order.
  for (const e of events) {
    if (e.kind !== "decision.question.logged") continue;
    const q = e.data as any;
    // No round or no answer time: written by a build before either bound anything (H7.12).
    const asked = Array.isArray(q?.rounds) && q.rounds.length && q.rounds.every((r: unknown) => str(r)) ? q.rounds as string[] : str(q?.round) ? [q.round as string] : undefined;
    if (!str(q?.session) || !str(q?.toolUseId) || !asked || !str(q?.answeredAt) || !Array.isArray(q?.questions) || !q?.answers || typeof q.answers !== "object" || Array.isArray(q.answers)) continue;
    if (!q.questions.every((x: any) => x && typeof x === "object" && typeof x.question === "string" && Array.isArray(x.options)
      && x.options.every((o: any) => o && typeof o === "object" && typeof o.label === "string"))) continue;
    if (questions.has(e.id)) continue;
    // A call logged before per-question binding named one round for all of it (S0.7).
    const bound: Record<string, string> = q.bound && typeof q.bound === "object" && !Array.isArray(q.bound)
      ? Object.fromEntries(Object.entries(q.bound).filter(([, r]) => typeof r === "string" && asked.includes(r as string))) as Record<string, string>
      : Object.fromEntries((q.questions as AskedQuestion[]).filter((x) => !confirmTarget(x)).map((x) => [x.question, asked[0]!]));
    questions.set(e.id, {
      id: e.id, session: q.session, toolUseId: q.toolUseId,
      questions: q.questions.map(normalizeQuestion), answers: q.answers, rounds: asked, bound, answeredAt: q.answeredAt,
      ...(str(q.transcript) ? { transcript: q.transcript } : {}),
      loggedBy: e.actor, at: e.at,
    });
  }

  events.forEach((e, pos) => {
    const data = e.data as any;
    switch (e.kind) {
      case "decision.round.posted": {
        const r = data?.round;
        if (!r || typeof r !== "object" || !str(r.id) || !str(r.source) || rounds.has(r.id) || !Array.isArray(data?.decisions)) break;
        const pv = r.prevalidated;
        const prevalidated = pv && typeof pv === "object" && str(pv.record) && str(pv.sortedBy) ? { record: pv.record as string, sortedBy: pv.sortedBy as string } : undefined;
        rounds.set(r.id, {
          id: r.id, source: r.source, universe: str(r.universe) ?? "",
          ...(str(r.pr) ? { pr: r.pr } : {}), ...(str(r.branch) ? { branch: r.branch } : {}),
          ...(Array.isArray(r.notes) ? { notes: r.notes.filter((n: unknown) => str(n)) } : {}),
          ...(prevalidated ? { prevalidated } : {}),
          postedBy: e.actor, at: e.at,
        });
        for (const raw of data.decisions as Decision[]) {
          // Immutable once posted: the hash binding means nothing if the text under it can
          // move. A second posting of an id is ignored, whatever it says.
          if (!raw || typeof raw !== "object" || decisions.has(raw.id) || raw.round !== r.id || checkDecision(raw)) continue;
          const d: FoldedDecision = {
            id: raw.id, round: raw.round, ref: raw.ref, kind: raw.kind,
            payload: normalizeQuestion(raw.payload),
            // A retired field on an old posting is ignored, never a reason to lose the question (S0.7).
            options: raw.options.map(({ closesOnAnswer: _c, ...o }: DecisionOption & { closesOnAnswer?: unknown }) => o),
            ...(str(raw.supersedes) ? { supersedes: raw.supersedes } : {}),
            ...(str(raw.origin?.answer) ? { origin: { answer: raw.origin!.answer } } : {}),
            ...(Array.isArray(raw.notes) ? { notes: raw.notes } : {}),
            hash: decisionHash(raw), answers: [],
          };
          decisions.set(d.id, d);
          postedAt.set(d.id, pos);
          const old = d.supersedes ? decisions.get(d.supersedes) : undefined;
          if (old && !old.replacedBy) old.replacedBy = d.id;
          else if (old) d.replaceLost = old.replacedBy;
        }
        break;
      }

      case "decision.question.logged": {
        // Confirms are applied here, in log position, because the answer they confirm must
        // already exist; ordinary questions bind through the answer events that cite them.
        const call = questions.get(e.id);
        if (!call) break;
        for (const q of call.questions) {
          const target = confirmTarget(q);
          const value = call.answers[q.question];
          if (target && value !== undefined) confirms.push({ pos, call, answer: target, q, value });
        }
        break;
      }

      case "decision.answer.recorded": {
        const d = decisions.get(str(data?.decision) ?? "");
        if (!d || (postedAt.get(d.id) ?? Infinity) > pos) break;
        if (data.hash !== d.hash) break;
        const r = resolve(d, data.via as AnswerVia, e.actor, questions);
        if (!r) break;
        // Principal-only and dated: a park that is not a date is no answer at all.
        if (r.park !== undefined && !ISO_DATE.test(r.park)) break;
        // Bound only to a question posted before it was given, by the person's clock and the
        // poster's, with no allowance for skew (B1.4, H7.10).
        const givenAt = r.givenAt ?? e.at;
        if (r.givenAt !== undefined && !(Date.parse(r.givenAt) > Date.parse(rounds.get(d.round)!.at))) break;
        // One call or message answers a decision once; a duplicate records nothing (H6.1).
        if (r.once && d.answers.some((x) => x.once === r.once)) break;
        const a: FoldedAnswer = {
          id: e.id, by: e.actor, at: e.at, via: (data.via as AnswerVia).kind, verified: r.verified, givenAt, seq: pos,
          ...(r.once ? { once: r.once } : {}),
          words: r.words, options: [], ruled: [], unruled: [], free: r.free,
          ...(str(data.relayedBy) ? { relayedBy: data.relayedBy } : {}),
        };
        d.answers.push(a);
        answersById.set(e.id, { a, d });
        // A words decision's answer is the words: recorded, never read onto options (C17).
        if (d.kind === "words") { a.free = false; break; }
        if (!r.free) rule(d, a, r, r.verified);
        break;
      }

      case "decision.reading.recorded": {
        const answer = str(data?.answer), agent = str(data?.reader?.agent);
        // A reading without codemap's own parse of the reader's verdict is dropped (S0.7, H7.12):
        // it carries the mapping the session passed in, which is how a mis-copy once bound.
        if (!answer || !agent || !validMaps(data.reader.verdict) || !str(data.reader.launchedAt) || !str(data.reader?.verified?.session)
          || !validMaps(data.session?.maps)) break;
        // One reading per answer, and one answer per reader (S0.8(c)): the first in the log.
        if (readings.has(answer) || (readerUsed.has(agent) && readerUsed.get(agent) !== answer)) break;
        readings.set(answer, { e, pos });
        readerUsed.set(agent, answer);
        break;
      }
    }
  });

  // --- what the log says, applied to the set -------------------------------------------

  // Given at or after its question was replaced, an answer answers nothing (plan A4: judged by
  // when GIVEN, so one given before the replacement and recorded after still counts, and B2.4
  // then holds its findings until the replacement is answered).
  for (const d of decisions.values()) {
    const cut = replacedAt(d, decisions, rounds);
    if (cut !== undefined) d.answers = d.answers.filter((a) => Date.parse(a.givenAt) < cut);
  }
  const kept = (id: string) => { const x = answersById.get(id); return x && x.d.answers.includes(x.a) ? x : undefined; };

  // "Other" typed into a confirm question is the person's words on the ORIGINAL decision, at
  // the call's time, read like any typed reply (S0.2). Made before any binding, so a reading
  // of it is found.
  for (const c of confirms) {
    const src = kept(c.answer);
    if (!src || typeof c.value !== "string" || [CONFIRM_YES, CONFIRM_NO, "Reading 1", "Reading 2"].includes(c.value)) continue;
    const once = `q:${c.call.session}\0${c.call.toolUseId}`;
    if (!(Date.parse(c.call.answeredAt) > Date.parse(src.a.givenAt)) || src.d.answers.some((x) => x.once === once)) continue;
    const cut = replacedAt(src.d, decisions, rounds);
    if (cut !== undefined && !(Date.parse(c.call.answeredAt) < cut)) continue;
    const a: FoldedAnswer = {
      id: `${c.call.id}/${src.d.id}`, by: c.call.loggedBy, at: c.call.at, via: "question", verified: true, givenAt: c.call.answeredAt, seq: c.pos,
      once, words: c.value, options: [], ruled: [], unruled: [], free: true,
    };
    src.d.answers.push(a);
    answersById.set(a.id, { a, d: src.d });
  }

  // Readings, then the person's confirms, onto every answer still free — in log order of the
  // answers, and each binding decided from the answer and its own events alone.
  const all = [...decisions.values()];
  const byLog = [...answersById.values()].filter((x) => x.d.answers.includes(x.a) && x.a.free && x.d.kind !== "words").sort((x, y) => x.a.seq - y.a.seq);
  for (const { a, d } of byLog) {
    const r = readings.get(a.id);
    if (r) {
      const rd = (r.e.data as any).reader, ses = (r.e.data as any).session;
      // Launched after the words were typed, or it cannot have read them (plan B2).
      if (Date.parse(rd.launchedAt) > Date.parse(a.givenAt)) {
        const unclear = str(rd.unclear);
        const maps = validMaps(rd.verdict)!, sm = validMaps(ses.maps)!;
        const key = (ms: Mapping[]) => ms.map((m) => `${m.decision}\0${m.option ?? ""}`).sort().join("\n");
        const agree = !unclear && key(maps) === key(sm);
        if (unclear || !agree || canBind(decisions, rounds, d, a, maps)) {
          a.reading = {
            id: r.e.id, agree,
            reader: { agent: rd.agent, maps, launchedAt: rd.launchedAt },
            session: { reading: str(ses.reading) ?? "", maps: sm },
            ...(str((r.e.data as any).asks) ? { asks: (r.e.data as any).asks } : {}),
            ...(unclear ? { unclear } : {}),
          };
        }
      }
    }
    // The person's own word on a reading of these words: the later confirmation wins (S0.2).
    let decided: { maps: Mapping[] | null; call: LoggedQuestion; pos: number } | undefined;
    for (const c of confirms) {
      if (c.answer !== a.id || typeof c.value !== "string") continue;
      const offered = confirmReadings(all, d, a, c.q);
      if (!offered) continue;
      const pick = c.value === CONFIRM_YES && offered.length === 1 ? offered[0]!
        : /^Reading [12]$/.test(c.value) && offered.length === 2 ? offered[Number(c.value.slice(-1)) - 1]!
          : c.value === CONFIRM_NO && offered.length === 1 ? null : undefined;
      if (pick === undefined) continue;
      if (pick === null) (a.rejected ??= []).push(offered[0]!);
      const later = !decided || Date.parse(c.call.answeredAt) > Date.parse(decided.call.answeredAt)
        || (c.call.answeredAt === decided.call.answeredAt && c.pos > decided.pos);
      if (later) decided = { maps: pick, call: c.call, pos: c.pos };
    }
    if (decided?.maps && canBind(decisions, rounds, d, a, decided.maps)) {
      a.confirmed = { call: decided.call.id, at: decided.call.answeredAt, maps: decided.maps };
      bind(decisions, answersById, d, a, decided.maps, decided.call.id, decided.pos);
    } else if (!decided && a.reading?.agree) {
      bind(decisions, answersById, d, a, a.reading.reader.maps, a.reading.id, readings.get(a.id)!.pos);
    }
  }

  // Follow-ups last: a copy's id exists only once its binding is made (Q13).
  for (const d of decisions.values()) {
    const src = d.origin ? answersById.get(d.origin.answer) : undefined;
    if (src) (src.d.followUps ??= []).push(d.id);
  }

  return { rounds: [...rounds.values()], decisions: [...decisions.values()], questions: [...questions.values()] };
}

/** Whether `maps` can bind words `a` on `d`: every decision it names is in the same round
 *  (posted with the answered one, so before the words), takes options, and was not already
 *  replaced when the words were given (R23, judged by given time as A4 is). */
function canBind(decisions: Map<string, FoldedDecision>, rounds: Map<string, DecisionRound>, d: FoldedDecision, a: FoldedAnswer, maps: Mapping[]): boolean {
  return maps.every((m) => {
    const t = decisions.get(m.decision);
    if (!t || t.round !== d.round || t.kind === "words") return false;
    if (m.option !== null && !t.options.some((o) => o.label === m.option)) return false;
    const cut = replacedAt(t, decisions, rounds);
    return cut === undefined || Date.parse(a.givenAt) < cut;
  });
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
    // A reading maps one pick onto a single-select decision; more is not a reading of it.
    if (t.kind === "options" && options.length > 1 && t.payload.multiSelect !== true) continue;
    let target = a;
    if (t !== d) {
      // The same message relayed to that question too answers it there already (B1.4).
      if (a.once && t.answers.some((x) => x.once === a.once)) continue;
      target = { ...a, id: `${source}/${t.id}`, seq: pos, options: [], ruled: [], unruled: [], free: false };
      delete target.park; delete target.parkWaits; delete target.separately; delete target.flags;
      delete target.elsewhere; delete target.reading; delete target.confirmed; delete target.rejected;
      t.answers.push(target);
      answersById.set(target.id, { a: target, d: t });
    }
    if (!options.length) { target.nothing = true; continue; }
    rule(t, target, { picked: options }, a.verified);
  }
}

/** An answer's words, its picks, and whether it is verified — or null when it binds to
 *  nothing this fold can check. */
function resolve(d: FoldedDecision, via: AnswerVia, actor: Actor, questions: Map<string, LoggedQuestion>): Resolved | null {
  if (!via || typeof via !== "object") return null;
  switch (via.kind) {
    case "question": {
      const q = questions.get(via.question);
      // The logged call bound this question to this decision's round, and carries its payload
      // exactly (B1.4, S0.8(d)).
      if (!q || q.bound[d.payload.question] !== d.round || !q.questions.some((x) => sameQuestion(x, d.payload))) return null;
      const v = q.answers[d.payload.question];
      // What a transcript records: a string, or a list of them for a multi-select.
      if (typeof v !== "string" && !(Array.isArray(v) && v.every((x) => typeof x === "string"))) return null;
      const list = Array.isArray(v) ? v : [v];
      const picked = list.map((l) => d.options.find((o) => o.label === l));
      const words = list.join(", ");
      const call = { verified: true, givenAt: q.answeredAt, once: `q:${q.session}\0${q.toolUseId}`, words };
      if (d.kind !== "words" && picked.every(Boolean) && (list.length === 1 || d.payload.multiSelect)) {
        return { ...call, picked: picked as DecisionOption[], free: false };
      }
      // Other text, a label with words appended, or a multi-select element that is words: the
      // person's own, and read by the reader (C14).
      return { ...call, picked: [], free: true };
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
const ranks = (a: FoldedAnswer): boolean => !a.free && !a.elsewhere;

/** `x` outranks `y`: verified first, then the later given, then the later in the log. */
const outranks = (x: FoldedAnswer, y: FoldedAnswer): boolean =>
  x.verified !== y.verified ? x.verified
    : Date.parse(x.givenAt) !== Date.parse(y.givenAt) ? Date.parse(x.givenAt) > Date.parse(y.givenAt) : x.seq > y.seq;

const best = (as: FoldedAnswer[]): FoldedAnswer | undefined => as.reduce<FoldedAnswer | undefined>((b, a) => (!b || outranks(a, b) ? a : b), undefined);

/** A decision's standing answer, derived from the whole set whenever it is read. */
export const standing = (d: FoldedDecision): FoldedAnswer | undefined => best(d.answers.filter(ranks));

/** Words still waiting for a binding on `d`: unread, read as unclear, or read two ways. */
const pending = (d: FoldedDecision): FoldedAnswer[] => d.answers.filter((a) => a.free && !a.elsewhere);

/** Of those, the ones that could still overturn what stands — bound, they would outrank it.
 *  Words a later answer already outranks are moot, and are not shown as waiting on anyone. */
const live = (d: FoldedDecision): FoldedAnswer[] => { const a = standing(d); return pending(d).filter((p) => !a || outranks(p, a)); };

/** Whether the answer ruled — picked something — rather than parked, awaited or ruled nothing. */
const decides = (a: FoldedAnswer | undefined): boolean => !!a && !a.free && !a.nothing && a.park === undefined && a.parkWaits === undefined;

export interface Superseding { answer: string; words: string; state: "unread" | "unclear" | "disputed"; rejected?: Mapping[][] }

/**
 * Verified words that would outrank the standing answer if something bound them, while they
 * are unread, unclear or in dispute (owner, P4.1 + plan A3): the ruling stands, and the
 * decision — and every finding it names — is marked possibly superseded until they are bound,
 * or a later verified answer rules.
 */
export function possiblySuperseded(d: FoldedDecision): Superseding[] {
  const a = standing(d);
  if (!a || d.replacedBy) return [];
  return live(d).filter((p) => p.verified).map((p) => ({
    answer: p.id, words: p.words,
    state: !p.reading ? "unread" as const : p.reading.unclear ? "unclear" as const : "disputed" as const,
    ...(p.rejected ? { rejected: p.rejected } : {}),
  }));
}

// --- the views --------------------------------------------------------------------------
//
// The three things the person asked to be able to see (owner, 2026-09-23). Each is a function
// of the folded record — plus, for the second, the finding record, which alone says whether a
// ruling has been carried out.

const roundAt = (s: SharedDecisions, d: FoldedDecision): string => s.rounds.find((r) => r.id === d.round)?.at ?? "";

/**
 * Where a replaced decision's ruling on `finding` went (owner, B2.4 + H4 + H6.2/6.3): to the
 * first decision down its replacement chain that names the finding and has a standing answer
 * that rules — and, when the ruling was verified, only a verified answer takes it over.
 * Undefined while the ruling still holds. `blocker` is a later answer that would have taken it
 * over but is unverified: it waits for the person.
 */
function successorOf(byId: Map<string, FoldedDecision>, d: FoldedDecision, a: FoldedAnswer, finding: string): { taken?: FoldedDecision; blocker?: FoldedDecision } {
  let blocker: FoldedDecision | undefined;
  const seen = new Set<string>([d.id]);
  for (let c = d.replacedBy ? byId.get(d.replacedBy) : undefined; c && !seen.has(c.id); c = c.replacedBy ? byId.get(c.replacedBy) : undefined) {
    seen.add(c.id);
    if (!c.options.some((o) => o.effects.some((e) => e.findings.includes(finding)))) continue;
    const b = standing(c);
    if (!b || !decides(b)) continue;
    if (a.verified && !b.verified) { blocker ??= c; continue; }
    return { taken: c };
  }
  return blocker ? { blocker } : {};
}

/** The rulings a replaced decision still holds, per finding: those nothing down its chain took over. */
const stillHeld = (byId: Map<string, FoldedDecision>, d: FoldedDecision): Ruled[] => {
  const a = standing(d);
  return a ? a.ruled.filter((r) => !successorOf(byId, d, a, r.finding).taken) : [];
};

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
    if (d.replacedBy) {
      // A replacement's unverified answer, where your ruling on the replaced question still
      // holds (H6.2) — listed on the replacement, the question still open to you.
      const a = standing(d);
      const listed = new Set<string>();
      for (const r of a?.ruled ?? []) {
        const b = successorOf(byId, d, a!, r.finding).blocker;
        if (b && !listed.has(b.id)) { listed.add(b.id); out.push({ decision: b.id, round: b.round, ref: b.ref, why: `an unconfirmed answer arrived after your ruling on ${d.ref} (${d.round})` }); }
      }
      continue;
    }
    const a = standing(d);
    const item = (why: string) => out.push({ decision: d.id, round: d.round, ref: d.ref, why });
    if (d.replaceLost) {
      const was = s.decisions.find((x) => x.id === d.supersedes);
      item(`posted to replace ${was?.ref ?? d.supersedes}, which ${d.replaceLost} had already replaced: a conflicting replacement`);
    }
    // An agent's unconfirmed words after your ruling: never applied over it, and never read,
    // so it cannot be told apart from agreement (owner, P3.1 (2); H6.8).
    if (a?.verified) for (const x of d.answers) if (!x.verified && x !== a && outranksByTime(x, a)) item(`an unconfirmed answer arrived after your ruling: "${x.words}"`);
    for (const p of live(d)) {
      if (p.reading?.unclear) item(`the reader could not tell which question your words answer: ${p.reading.unclear}`);
      else if (p.reading && !p.reading.agree) item(`your words were read two different ways: "${p.words}"`);
      if (p.rejected?.length) item(`you said a reading of your words was not what you meant ("${p.words}": ${fmt(s, p.rejected.at(-1)!)}): answer ${d.ref} again`);
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
    if (a.nothing) item("your words were read, and they rule nothing here");
    if (a.parkWaits) item(`a park until ${a.parkWaits} that could not be verified as yours`);
    if (a.unruled.length) item(`settles that could not be verified as yours: ${a.unruled.join(", ")}`);
    for (const label of a.separately ?? []) {
      if (!(d.followUps ?? []).some((f) => byId.get(f)?.origin?.answer === a.id)) item(`you asked to rule on "${label}" separately, and it has not been asked yet`);
    }
  }
  return out;
}

/** Given later than `y` — the ranking's time order, ignoring verification. */
const outranksByTime = (x: FoldedAnswer, y: FoldedAnswer): boolean =>
  Date.parse(x.givenAt) !== Date.parse(y.givenAt) ? Date.parse(x.givenAt) > Date.parse(y.givenAt) : x.seq > y.seq;

export interface Parked { decision: string; round: string; ref: string; until: string; findings: string[] }

/** Decisions parked by the person, still within their date (owner, B3.1: "a separate park queue"). */
export function parked(s: SharedDecisions, today: string): Parked[] {
  const out: Parked[] = [];
  for (const d of s.decisions) {
    const a = standing(d);
    if (d.replacedBy || !parkedOn(a, today)) continue;
    out.push({ decision: d.id, round: d.round, ref: d.ref, until: a!.park!, findings: named(d) });
  }
  return out;
}

const named = (d: FoldedDecision): string[] => [...new Set(d.options.flatMap((o) => o.effects.flatMap((e) => e.findings)))];

export interface Unread { decision: string; round: string; ref: string; answer: string; words: string }

/** Free text the reader has not read yet — waiting on an agent, not on the person. An agent's
 *  unconfirmed words after a verified ruling are never sent to the reader (H6.8). */
export function awaitingReading(s: SharedDecisions): Unread[] {
  const out: Unread[] = [];
  for (const d of s.decisions) {
    if (d.replacedBy || d.kind === "words") continue;
    for (const x of live(d)) {
      if (x.reading) continue;
      out.push({ decision: d.id, round: d.round, ref: d.ref, answer: x.id, words: x.words });
    }
  }
  return out;
}

export interface Disputed { decision: string; round: string; ref: string; answer: string; words: string; reader: string; session: string }

/** The person's words, read two different ways by the reader and the session. */
export function readingsInDispute(s: SharedDecisions): Disputed[] {
  const out: Disputed[] = [];
  for (const d of s.decisions) {
    if (d.replacedBy) continue;
    for (const p of live(d)) {
      if (p.reading && !p.reading.agree && !p.reading.unclear) {
        out.push({ decision: d.id, round: d.round, ref: d.ref, answer: p.id, words: p.words, reader: fmt(s, p.reading.reader.maps), session: p.reading.session.reading || fmt(s, p.reading.session.maps) });
      }
    }
  }
  return out;
}

export interface Uncarried extends Ruled {
  decision: string; round: string; ref: string; answer: string; ruler: string;
  /** The ruling is on a question since replaced, and holds until the replacement rules (B2.4). */
  replacedBy?: string;
}

/**
 * Rulings not yet carried out: every effect a standing answer ruled whose finding is still
 * open. A settle waits for the verifier; an unblock is fix work. `isOpen` is the finding
 * record's answer — this record never stores it.
 */
export function ruledNotCarriedOut(s: SharedDecisions, isOpen: (finding: string) => boolean): Uncarried[] {
  const out: Uncarried[] = [];
  const byId = new Map(s.decisions.map((x) => [x.id, x]));
  for (const d of s.decisions) {
    const a = standing(d);
    // A replaced question is listed here, marked replaced, and nowhere else (B5.1).
    for (const r of d.replacedBy ? stillHeld(byId, d) : a?.ruled ?? []) {
      if (isOpen(r.finding)) out.push({ ...r, decision: d.id, round: d.round, ref: d.ref, answer: a!.id, ruler: a!.by.principal, ...(d.replacedBy ? { replacedBy: d.replacedBy } : {}) });
    }
  }
  return out;
}

export interface Hold {
  decision: string; why: "undecided" | "ruled";
  /** When this hold on the finding last began (owner, S0.4): a person's assignment keeps a
   *  held finding on the work queue only if made after it. */
  since: string;
}

/** Whether `d`, with only `answers` given so far, holds `finding` from open work. */
function holdsWith(d: FoldedDecision, answers: FoldedAnswer[], finding: string): boolean {
  if (!named(d).includes(finding)) return false;
  const a = best(answers);
  if (!decides(a)) return true;
  if (a!.ruled.some((r) => r.finding === finding && r.on === "settle")) return true;
  if (a!.unruled.includes(finding)) return true;
  return d.options.some((o) => a!.separately?.includes(o.label) && o.effects.some((e) => e.findings.includes(finding)));
}

/**
 * When `d`'s hold on `finding` last began: walked over the answers in the order they were
 * GIVEN, as the ranking reads them. A replacement inherits its predecessor's start if the
 * predecessor was holding the finding when it was replaced (the chain holds it continuously).
 */
function holdSince(s: SharedDecisions, byId: Map<string, FoldedDecision>, d: FoldedDecision, finding: string): string | undefined {
  const prev = d.supersedes ? byId.get(d.supersedes) : undefined;
  const inherited = prev && prev.replacedBy === d.id && holdsWith(prev, prev.answers.filter(ranks), finding) ? holdSince(s, byId, prev, finding) : undefined;
  const given = d.answers.filter(ranks).sort((x, y) => (outranksByTime(x, y) ? 1 : -1));
  let since = holdsWith(d, [], finding) ? inherited ?? roundAt(s, d) : undefined;
  for (let i = 0; i < given.length; i++) {
    const now = holdsWith(d, given.slice(0, i + 1), finding);
    if (now && since === undefined) since = given[i]!.givenAt;
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
    if (list.some((x) => x.decision === d.id)) return;
    list.push({ decision: d.id, why, since: holdSince(s, byId, d, f) ?? roundAt(s, d) });
    out.set(f, list);
  };
  for (const d of s.decisions) {
    if (d.replacedBy) {
      for (const r of stillHeld(byId, d)) if (r.on === "settle") add(d, r.finding, "ruled");
      continue;
    }
    const a = standing(d);
    for (const r of a?.ruled ?? []) if (r.on === "settle") add(d, r.finding, "ruled");
    // Undecided while nothing rules it: no answer, a park, words not yet bound, or words that
    // rule nothing. A decided answer that picked an option with no effect on a finding releases it.
    if (!decides(a)) {
      const ruled = new Set((a?.ruled ?? []).map((r) => r.finding));
      for (const f of named(d)) if (!ruled.has(f)) add(d, f, "undecided");
      continue;
    }
    // Decided — but settles it could not rule wait for the person, and bulk items checked to be
    // ruled on separately wait for their own question.
    for (const f of a!.unruled) add(d, f, "undecided");
    for (const o of d.options) if (a!.separately?.includes(o.label)) for (const e of o.effects) for (const f of e.findings) add(d, f, "undecided");
  }
  return out;
}

/** Every finding a possibly-superseded decision names, whether it holds it or not — a mark
 *  on the queues and catalogues that never withholds (owner, S0.8(a)). */
export function supersededFindings(s: SharedDecisions): Map<string, { decision: string; words: string[] }[]> {
  const out = new Map<string, { decision: string; words: string[] }[]>();
  for (const d of s.decisions) {
    const p = possiblySuperseded(d);
    if (!p.length) continue;
    for (const f of named(d)) out.set(f, [...(out.get(f) ?? []), { decision: d.id, words: p.map((x) => x.words) }]);
  }
  return out;
}

// --- writing --------------------------------------------------------------------------

export const postRoundEvent = (logRoot: string, universe: string, actor: Actor, round: Omit<DecisionRound, "postedBy" | "at">, decisions: Decision[]) =>
  emitEvent(logRoot, decisionScope(universe), actor, "decision.round.posted", round.id, { round, decisions });

export const logQuestionEvent = (logRoot: string, universe: string, actor: Actor, q: Omit<LoggedQuestion, "id" | "loggedBy" | "at">) =>
  emitEvent(logRoot, decisionScope(universe), actor, "decision.question.logged", q.toolUseId, q as unknown as Record<string, unknown>);

export const recordAnswerEvent = (logRoot: string, universe: string, actor: Actor, a: { decision: string; hash: string; via: AnswerVia; relayedBy?: string }) =>
  emitEvent(logRoot, decisionScope(universe), actor, "decision.answer.recorded", a.decision, a as unknown as Record<string, unknown>);

export interface ReadingEvent {
  answer: string;
  /** Codemap's parse of the reader's own handback, never the session's copy of it (plan B1). */
  reader: { agent: string; verdict: Mapping[]; unclear?: string; launchedAt: string; verified: { session: string; toolUseId: string } };
  /** What the asking session requested — the mapping the reader is compared against. */
  session: { reading?: string; maps: Mapping[] };
  asks?: string;
}

export const recordReadingEvent = (logRoot: string, universe: string, actor: Actor, a: ReadingEvent) =>
  emitEvent(logRoot, decisionScope(universe), actor, "decision.reading.recorded", a.answer, a as unknown as Record<string, unknown>);
