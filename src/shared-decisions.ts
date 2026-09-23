/**
 * Decision rounds, folded from `decisions/<universe>`.
 *
 * Four events: `decision.round.posted`, `decision.question.logged`,
 * `decision.answer.recorded` and `decision.reading.recorded`. The rules are the owner's, word
 * for word in docs/decision-rounds-worked-cases.md; the C-numbers below are that document's.
 *
 * **A ruling is not its carrying-out.** The answer is the person's ruling and stands as given.
 * Carrying it out — closing a finding — is a separate act in the FINDINGS scope, by the
 * verifier or, only on a pre-validated option, by the answer's own op. So this record never
 * stores "carried out": the finding record is the one authority for that, and `ruledNotCarriedOut`
 * joins the two at read time.
 *
 * **No state label.** A decision's condition is read off its latest standing answer, and every
 * fact about an answer is stored on that answer. The earlier build kept one `state` per decision
 * that every event path had to reset, and "set on one path, never reset on another" was the
 * shape of most of its defects (docs/postmortems/2026-09-23-i8a-fix-round.md §5).
 *
 * **Verification happens before the log** (owner: "verification needs to happen before it ends
 * up in the fold"). A logged question or relayed message was checked against the transcript on
 * the machine that asked; a clone cannot re-read that transcript and trusts the logger for it.
 * Everything that travels is checked here: that the logged call carries the decision's exact
 * payload, and that a picked answer is one of its options.
 */
import { createHash } from "node:crypto";
import { emitEvent, type LogEvent } from "./eventlog.js";
import { isAgentActor } from "./identity.js";
import { canonical, normalizeQuestion, sameQuestion } from "./transcript.js";
import { ISO_DATE, type Actor, type Decision, type DecisionEffect, type DecisionOption, type DecisionRound, type LoggedQuestion } from "./schema.js";

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
export interface Ruled { finding: string; on: "settle" | "unblock"; as?: "refuted"; closesOnAnswer?: true }

export interface FoldedAnswer {
  id: string;
  by: Actor;
  at: string;
  via: AnswerVia["kind"];
  /** The words are the person's (C8): an unverified answer's settles wait for them. */
  verified: boolean;
  /**
   * The person's own verified answer to THIS decision: a page answer or a logged call. It
   * outranks one that is not (owner, B2.1 "Verified outranks"). A typed reply is bound to its
   * question by the reader, so it is not own until the reader's identity can be checked
   * (owner, H8); a reading's copy onto another decision never is (B2.2).
   */
  own: boolean;
  /** When the person gave it — the transcript entry's time, or the page's — never when it
   *  was recorded: between two own answers, the later GIVEN stands (H7.9). */
  givenAt: string;
  /** What it was given through, so one call or message answers a decision once (B1.4). */
  once?: string;
  /** Not own, after an own answer: kept, never standing (B2.1). */
  outranked?: true;
  /** ...and it disagrees with that answer, so it waits for you. */
  conflicts?: true;
  /** The person's words as recorded — never an agent's summary of them. */
  words: string;
  /** The options (or bulk items) this answer ruled, directly or through an agreeing reading. */
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
  /** Free text, which the reader maps onto options (C17). */
  free: boolean;
  /** Transcript id of whoever relayed it; the reader must be someone else. */
  relayedBy?: string;
  /** Transcript ids the reader must not be — from the evidence on a verified relay, and the
   *  caller's `relayedBy` on an unverified one, where it is recorded, not enforceable (R7.3). */
  relayers: string[];
  reading?: {
    id: string; agree: boolean;
    reader: { transcript: string; reading: string; maps: Mapping[] };
    session: { reading: string; maps: Mapping[] };
    asks?: string;
    /** The reader could not tell which question the words answer, and why: nothing binds (H5). */
    unclear?: string;
  };
  /** A later answer on the same decision replaced this one as its answer (C3). */
  superseded?: boolean;
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

/**
 * A posted decision the fold will hold, or why not. Shared with the posting ops, so an op
 * refuses exactly what the fold would drop. `prevalidated` is the round's.
 */
export function checkDecision(d: Decision, prevalidated = false): string | null {
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
    if (o.closesOnAnswer !== undefined) {
      if (o.closesOnAnswer !== true) return "closesOnAnswer is true or absent";
      if (!prevalidated) return "only a pre-validated round (a skill's sort, imported) may close a finding on answer";
      if (!o.effects.some((e) => e.on === "settle")) return `option "${o.label}" closes on answer but settles nothing`;
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

// --- the fold -------------------------------------------------------------------------

/** What an answer says, before it is applied. */
interface Resolved {
  verified: boolean;
  words: string;
  /** Options picked (for a bulk decision: the items CHECKED, or the approve-all option). */
  picked: DecisionOption[];
  park?: string;
  free: boolean;
  relayers?: string[];
  own: boolean;
  /** When given, if not when recorded. */
  givenAt?: string;
  once?: string;
}

/**
 * Add `a` to `d`, deciding which answer stands (owner, B2.1 + H7.9): an own answer outranks
 * one that is not; between two of a kind, the later GIVEN stands, so an answer given earlier
 * and recorded later corrects nothing. An answer that is not own, after one that is, is kept
 * and never stands; the agent's unconfirmed words disagree with it by definition, and the
 * person's typed words wait for their reading to say (H6.8).
 */
function admit(d: FoldedDecision, a: FoldedAnswer): void {
  const cur = standing(d);
  d.answers.push(a);
  if (!cur) return;
  const wins = a.own !== cur.own ? a.own : Date.parse(a.givenAt) >= Date.parse(cur.givenAt);
  if (wins) { cur.superseded = true; return; }
  if (cur.own && !a.own) {
    a.outranked = true;
    if (a.via !== "message") a.conflicts = true;
  } else a.superseded = true;
}

/** Rule `picked` onto answer `a` — the one place an answer's facts are set. `closes`: the
 *  person picked it themselves, so a close-on-answer option may close (B2.2). */
function rule(d: FoldedDecision, a: FoldedAnswer, r: Resolved, verified: boolean, closes: boolean): void {
  const park = r.park ?? (r.picked.length === 1 ? r.picked[0]!.park : undefined);
  if (park !== undefined) {
    // Principal-only and dated (C23): unverified, it applies nothing and waits for you.
    if (!verified) { a.parkWaits = park.slice(0, 10); return; }
    a.park = park.slice(0, 10);
    // A valid park is accepted; one that looks errant is flagged, not refused (R19).
    const offered = d.options.map((o) => o.park?.slice(0, 10)).filter(Boolean);
    a.flags = [
      ...(!offered.includes(a.park) ? [`park date ${a.park} is not one this decision offered${offered.length ? ` (${offered.join(", ")})` : ""}`] : []),
      ...(a.park < a.at.slice(0, 10) ? [`park date ${a.park} had already passed when it was answered`] : []),
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
        a.ruled.push({ finding: f, on: eff.on, ...(eff.as ? { as: eff.as } : {}), ...(closes && o.closesOnAnswer && eff.on === "settle" ? { closesOnAnswer: true as const } : {}) });
      }
    }
    a.options.push(o.label);
  }
}

export function foldDecisions(events: LogEvent[]): SharedDecisions {
  const rounds = new Map<string, DecisionRound>();
  const decisions = new Map<string, FoldedDecision>();
  const questions = new Map<string, LoggedQuestion>();
  const answersById = new Map<string, { a: FoldedAnswer; d: FoldedDecision }>();
  // Position of each decision's posting, so an answer reaches only a decision posted before it.
  const postedAt = new Map<string, number>();

  // Questions first: a logged call is a fact about the transcript, and an answer event may
  // arrive from another writer before it in fold order.
  for (const e of events) {
    if (e.kind !== "decision.question.logged") continue;
    const q = e.data as any;
    // No round or no answer time: written by a build before either bound anything (H7.12).
    if (!str(q?.session) || !str(q?.toolUseId) || !str(q?.round) || !str(q?.answeredAt) || !Array.isArray(q?.questions) || !q?.answers || typeof q.answers !== "object" || Array.isArray(q.answers)) continue;
    if (!q.questions.every((x: any) => x && typeof x === "object" && typeof x.question === "string" && Array.isArray(x.options)
      && x.options.every((o: any) => o && typeof o === "object" && typeof o.label === "string"))) continue;
    if (questions.has(e.id)) continue;
    questions.set(e.id, {
      id: e.id, session: q.session, toolUseId: q.toolUseId,
      questions: q.questions.map(normalizeQuestion), answers: q.answers, round: q.round, answeredAt: q.answeredAt,
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
          if (!raw || typeof raw !== "object" || decisions.has(raw.id) || raw.round !== r.id || checkDecision(raw, !!prevalidated)) continue;
          const d: FoldedDecision = {
            id: raw.id, round: raw.round, ref: raw.ref, kind: raw.kind,
            payload: normalizeQuestion(raw.payload), options: raw.options,
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
          const src = d.origin ? answersById.get(d.origin.answer) : undefined;
          if (src) (src.d.followUps ??= []).push(d.id);
        }
        break;
      }

      case "decision.answer.recorded": {
        const d = decisions.get(str(data?.decision) ?? "");
        if (!d || (postedAt.get(d.id) ?? Infinity) > pos || d.replacedBy) break;
        if (data.hash !== d.hash) break;
        const r = resolve(d, data.via as AnswerVia, e.actor, questions);
        if (!r) break;
        // Principal-only and dated: a park that is not a date is no answer at all. Dropped
        // HERE, before it can supersede anything — a dropped event changes nothing.
        if (r.park !== undefined && !ISO_DATE.test(r.park)) break;
        // Bound only to a question posted before it was given, by the person's clock and the
        // poster's, with no allowance for skew (B1.4, H7.10).
        const givenAt = r.givenAt ?? e.at;
        if (r.givenAt !== undefined && !(Date.parse(r.givenAt) > Date.parse(rounds.get(d.round)!.at))) break;
        // One call or message answers a decision once; a duplicate records nothing (H6.1).
        if (r.once && d.answers.some((x) => x.once === r.once)) break;
        const a: FoldedAnswer = {
          id: e.id, by: e.actor, at: e.at, via: (data.via as AnswerVia).kind, verified: r.verified, own: r.own, givenAt,
          ...(r.once ? { once: r.once } : {}),
          words: r.words, options: [], ruled: [], unruled: [], free: r.free,
          ...(str(data.relayedBy) ? { relayedBy: data.relayedBy } : {}),
          relayers: r.relayers ?? (str(data.relayedBy) ? [data.relayedBy] : []),
        };
        admit(d, a);
        answersById.set(e.id, { a, d });
        // A words decision's answer is recorded and never read onto options (C17).
        if (d.kind === "words" || r.free) break;
        rule(d, a, r, r.verified, r.own);
        break;
      }

      case "decision.reading.recorded": {
        const src = answersById.get(str(data?.answer) ?? "");
        if (!src || !src.a.free || src.d.kind === "words" || src.a.reading || src.a.superseded) break;
        // Outranked, only the person's confirmed words are worth reading, and only to learn
        // whether they disagree; an agent's unconfirmed words are a conflict unread (H6.8).
        if (src.a.outranked && src.a.via !== "message") break;
        // Words that answered a question since replaced map onto nothing (R23).
        if (src.d.replacedBy) break;
        const rd = data.reader, ses = data.session;
        const transcript = str(rd?.transcript);
        // The reader is another agent: never whoever relayed the words (C17). Judged against
        // the EVIDENCE's session, so leaving `relayedBy` out cannot pass; and a relay with no
        // known relayer cannot show independence at all, so it is not read.
        if (!transcript || src.a.relayers.includes(transcript)) break;
        if (src.a.via !== "direct" && !src.a.relayers.length) break;
        const maps = (m: unknown): Mapping[] | null => Array.isArray(m) && m.every((x) => x && typeof x === "object" && str(x.decision) && (x.option === null || str(x.option)))
          ? (m as Mapping[]) : null;
        const rm = maps(rd?.maps), sm = maps(ses?.maps);
        if (!rm || !sm) break;
        const unclear = str(data.unclear);
        // Every mapped decision is in the same round — so posted when the answered one was, before
        // the words — takes options, is not replaced, and, apart from the one answered, has no
        // standing answer yet (C2). An outranked answer is read against its own decision only.
        const targets = rm.map((m) => decisions.get(m.decision));
        if (targets.some((t) => !t || t.round !== src.d.round || t.kind === "words" || t.replacedBy
          || (t !== src.d && (standing(t) || src.a.outranked)))) break;
        const key = (ms: Mapping[]) => ms.map((m) => `${m.decision}\0${m.option ?? ""}`).sort().join("\n");
        const agree = !unclear && key(rm) === key(sm);
        src.a.reading = {
          id: e.id, agree,
          reader: { transcript, reading: str(rd.reading) ?? "", maps: rm },
          session: { reading: str(ses.reading) ?? "", maps: sm },
          ...(str(data.asks) ? { asks: data.asks } : {}),
          ...(unclear ? { unclear } : {}),
        };
        if (!agree) {
          // Unread, an outranked message was a conflict pending; read two ways it still is.
          if (src.a.outranked) src.a.conflicts = true;
          break;   // neither applies (C19)
        }
        // Group the agreed mappings by decision: a bulk decision's are the items checked.
        const byDecision = new Map<string, DecisionOption[]>();
        for (const m of rm) {
          if (m.option === null) continue;
          const t = decisions.get(m.decision)!;
          const o = t.options.find((x) => x.label === m.option);
          if (o) byDecision.set(t.id, [...(byDecision.get(t.id) ?? []), o]);
        }
        for (const [id, picked] of byDecision) {
          const t = decisions.get(id)!;
          // A reading maps one pick onto a single-select decision; more is not a reading of it.
          if (t.kind === "options" && picked.length > 1 && t.payload.multiSelect !== true) continue;
          const target = t === src.d ? src.a : (() => {
            // A copy is never the person's own answer to a question they may not have seen (B2.2).
            const copy: FoldedAnswer = { ...src.a, options: [], ruled: [], unruled: [], free: false, superseded: false, own: false };
            delete copy.park; delete copy.parkWaits; delete copy.separately; delete copy.flags;
            t.answers.push(copy);
            return copy;
          })();
          target.free = false;
          rule(t, target, { verified: src.a.verified, words: src.a.words, picked, free: false, own: false }, src.a.verified, false);
        }
        // Read, an outranked message disagrees unless it picked what the standing answer did.
        if (src.a.outranked) {
          const now = standing(src.d);
          const same = now && !src.a.park && !src.a.parkWaits && now.park === undefined
            && [...src.a.options].sort().join("\n") === [...now.options].sort().join("\n");
          if (!same) src.a.conflicts = true;
        }
        break;
      }
    }
  });

  return { rounds: [...rounds.values()], decisions: [...decisions.values()], questions: [...questions.values()] };
}

/** An answer's words, its picks, and whether it is verified — or null when it binds to
 *  nothing this fold can check. */
function resolve(d: FoldedDecision, via: AnswerVia, actor: Actor, questions: Map<string, LoggedQuestion>): Resolved | null {
  if (!via || typeof via !== "object") return null;
  switch (via.kind) {
    case "question": {
      const q = questions.get(via.question);
      // The logged call must be for this decision's round and carry its payload exactly (B1.4).
      if (!q || q.round !== d.round || !q.questions.some((x) => sameQuestion(x, d.payload))) return null;
      const v = q.answers[d.payload.question];
      // What a transcript records: a string, or a list of them for a multi-select.
      if (typeof v !== "string" && !(Array.isArray(v) && v.every((x) => typeof x === "string"))) return null;
      const relayers = [q.session, ...(q.transcript ? [q.transcript] : [])];
      const list = Array.isArray(v) ? v : [v];
      const picked = list.map((l) => d.options.find((o) => o.label === l));
      const words = list.join(", ");
      const call = { verified: true, own: true, givenAt: q.answeredAt, once: `q:${q.session}\0${q.toolUseId}`, words, relayers };
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
      return { verified: true, own: false, givenAt: via.at, once: `m:${via.session}\0${via.entryId}`, words: via.text, picked: [], free: true, relayers: [via.session] };
    case "unverified":
      if (!str(via.words)) return null;
      return { verified: false, own: false, words: via.words, picked: [], free: true };
    case "direct": {
      if (isAgentActor(actor)) return null;   // the page is a person's door, never an agent's
      const page = { verified: true, own: true };
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

// --- the views --------------------------------------------------------------------------
//
// The three things the person asked to be able to see (owner, 2026-09-23). Each is a function
// of the folded record — plus, for the second, the finding record, which alone says whether a
// ruling has been carried out.

/** A decision's standing answer: the one neither superseded nor outranked (see `admit`). */
export const standing = (d: FoldedDecision): FoldedAnswer | undefined => d.answers.filter((a) => !a.superseded && !a.outranked).at(-1);

/** Whether the answer ruled — picked something — rather than parked or awaited a reading. */
const decides = (a: FoldedAnswer | undefined): boolean => !!a && !a.free && a.park === undefined && a.parkWaits === undefined;

/**
 * Where a replaced decision's ruling on `finding` went (owner, B2.4 + H4 + H6.2/6.3): to the
 * first decision down its replacement chain that names the finding and has a standing answer
 * that rules — and, when the ruling was the person's own, only an own answer takes it over.
 * Undefined while the ruling still holds. `blocker` is a later answer that would have taken it
 * over but is not the person's own: it disagrees with their ruling and waits for them.
 */
function successorOf(s: SharedDecisions, d: FoldedDecision, a: FoldedAnswer, finding: string): { taken?: FoldedDecision; blocker?: FoldedDecision } {
  const byId = new Map(s.decisions.map((x) => [x.id, x]));
  let blocker: FoldedDecision | undefined;
  const seen = new Set<string>([d.id]);
  for (let c = d.replacedBy ? byId.get(d.replacedBy) : undefined; c && !seen.has(c.id); c = c.replacedBy ? byId.get(c.replacedBy) : undefined) {
    seen.add(c.id);
    if (!c.options.some((o) => o.effects.some((e) => e.findings.includes(finding)))) continue;
    const b = standing(c);
    if (!b || !decides(b)) continue;
    if (a.own && !b.own) { blocker ??= c; continue; }
    return { taken: c };
  }
  return blocker ? { blocker } : {};
}

/** The rulings a replaced decision still holds, per finding: those nothing down its chain took over. */
const stillHeld = (s: SharedDecisions, d: FoldedDecision): Ruled[] => {
  const a = standing(d);
  return a ? a.ruled.filter((r) => !successorOf(s, d, a, r.finding).taken) : [];
};

export interface WaitingItem { decision: string; round: string; ref: string; why: string }

/** What waits on the person: unanswered questions, and answers that need them again. */
export function waitingOnMe(s: SharedDecisions): WaitingItem[] {
  const out: WaitingItem[] = [];
  for (const d of s.decisions) {
    if (d.replacedBy) {
      // A replacement's answer that is not yours, where your ruling on the replaced question
      // still holds (H6.2) — listed on the replacement, the question still open to you.
      const a = standing(d);
      const listed = new Set<string>();
      for (const r of a?.ruled ?? []) {
        const b = successorOf(s, d, a!, r.finding).blocker;
        if (b && !listed.has(b.id)) { listed.add(b.id); out.push({ decision: b.id, round: b.round, ref: b.ref, why: `an unconfirmed answer disagrees with your ruling on ${d.ref} (${d.round})` }); }
      }
      continue;
    }
    const a = standing(d);
    const item = (why: string) => out.push({ decision: d.id, round: d.round, ref: d.ref, why });
    if (d.replaceLost) {
      const was = s.decisions.find((x) => x.id === d.supersedes);
      item(`posted to replace ${was?.ref ?? d.supersedes}, which ${d.replaceLost} had already replaced: a conflicting replacement`);
    }
    // Since the ruling stands: an answer that is not yours disagreeing with it (B2.1).
    const at = a ? d.answers.indexOf(a) : -1;
    for (const x of d.answers.slice(at + 1)) if (x.conflicts) item(`an unconfirmed answer disagrees with your ruling: "${x.words}"`);
    if (!a) { item("not answered"); continue; }
    if (a.reading?.unclear) item(`the reader could not tell which question your words answer: ${a.reading.unclear}`);
    if (a.parkWaits) item(`a park until ${a.parkWaits} that could not be verified as yours`);
    if (a.unruled.length) item(`settles that could not be verified as yours: ${a.unruled.join(", ")}`);
    if (a.reading && !a.reading.agree && !a.reading.unclear) item("your words were read two different ways");
    if (a.free && d.kind !== "words" && a.via !== "direct" && !a.relayers.length) item("your words could not be read: nobody independent can read an answer with no known relayer");
    for (const label of a.separately ?? []) {
      if (!(d.followUps ?? []).some((f) => s.decisions.find((x) => x.id === f)?.origin?.answer === a.id)) item(`you asked to rule on "${label}" separately, and it has not been asked yet`);
    }
  }
  return out;
}

export interface Unread { decision: string; round: string; ref: string; answer: string; words: string }

/** Free text the reader has not read yet — waiting on an agent, not on the person. */
export function awaitingReading(s: SharedDecisions): Unread[] {
  const out: Unread[] = [];
  for (const d of s.decisions) {
    if (d.replacedBy || d.kind === "words") continue;
    const a = standing(d);
    // Your typed words after your own answer: read only to learn whether they disagree with it.
    for (const x of d.answers) {
      if (x.free && !x.reading && (x === a ? (x.via === "direct" || x.relayers.length) : x.outranked && x.via === "message" && !x.conflicts)) {
        out.push({ decision: d.id, round: d.round, ref: d.ref, answer: x.id, words: x.words });
      }
    }
  }
  return out;
}

export interface Disputed { decision: string; round: string; ref: string; answer: string; words: string; reader: string; session: string }

/** The person's words, read two different ways by the reader and the session. */
export function readingsInDispute(s: SharedDecisions): Disputed[] {
  const out: Disputed[] = [];
  for (const d of s.decisions) {
    const a = standing(d);
    if (!d.replacedBy && a?.reading && !a.reading.agree && !a.reading.unclear) {
      out.push({ decision: d.id, round: d.round, ref: d.ref, answer: a.id, words: a.words, reader: a.reading.reader.reading, session: a.reading.session.reading });
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
 * open. A settle waits for the verifier (or its op, on a pre-validated option); an unblock is
 * fix work. `isOpen` is the finding record's answer — this record never stores it.
 */
export function ruledNotCarriedOut(s: SharedDecisions, isOpen: (finding: string) => boolean): Uncarried[] {
  const out: Uncarried[] = [];
  for (const d of s.decisions) {
    const a = standing(d);
    // A replaced question is listed here, marked replaced, and nowhere else (B5.1).
    for (const r of d.replacedBy ? stillHeld(s, d) : a?.ruled ?? []) {
      if (isOpen(r.finding)) out.push({ ...r, decision: d.id, round: d.round, ref: d.ref, answer: a!.id, ruler: a!.by.principal, ...(d.replacedBy ? { replacedBy: d.replacedBy } : {}) });
    }
  }
  return out;
}

export interface Hold { decision: string; why: "undecided" | "ruled" }

/**
 * Findings not to be offered as open work, and why: a decision on them is undecided, or a
 * standing settle ruling holds them for the verifier (owner: "Held for the verifier"). An
 * unblock ruling releases them. Derived, never stored — and the finding record decides whether
 * a ruled one has since closed.
 */
export function heldFindings(s: SharedDecisions, isOpen: (finding: string) => boolean): Map<string, Hold[]> {
  const out = new Map<string, Hold[]>();
  const add = (f: string, h: Hold) => {
    // A closed finding is held by nothing (bulk item 1): the hold was on offering it as work.
    if (!isOpen(f)) return;
    const list = out.get(f) ?? [];
    if (!list.some((x) => x.decision === h.decision)) list.push(h);
    out.set(f, list);
  };
  for (const d of s.decisions) {
    if (d.replacedBy) {
      for (const r of stillHeld(s, d)) if (r.on === "settle") add(r.finding, { decision: d.id, why: "ruled" });
      continue;
    }
    const a = standing(d);
    for (const r of a?.ruled ?? []) if (r.on === "settle") add(r.finding, { decision: d.id, why: "ruled" });
    // Undecided while nothing rules it: no answer, a park, or words not yet read (or read two
    // ways). A decided answer that picked an option with no effect on a finding releases it.
    if (!decides(a)) {
      const ruled = new Set((a?.ruled ?? []).map((r) => r.finding));
      for (const o of d.options) for (const e of o.effects) for (const f of e.findings) {
        if (!ruled.has(f)) add(f, { decision: d.id, why: "undecided" });
      }
      continue;
    }
    // Decided — but settles it could not rule wait for the person, and bulk items checked to be
    // ruled on separately wait for their own question.
    for (const f of a!.unruled) add(f, { decision: d.id, why: "undecided" });
    for (const o of d.options) if (a!.separately?.includes(o.label)) for (const e of o.effects) for (const f of e.findings) add(f, { decision: d.id, why: "undecided" });
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

export const recordReadingEvent = (
  logRoot: string, universe: string, actor: Actor,
  a: { answer: string; reader: { transcript: string; reading: string; maps: Mapping[] }; session: { reading: string; maps: Mapping[] }; asks?: string; unclear?: string },
) => emitEvent(logRoot, decisionScope(universe), actor, "decision.reading.recorded", a.answer, a as unknown as Record<string, unknown>);
