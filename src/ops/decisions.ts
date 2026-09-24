/**
 * Decision rounds: posting questions, recording what the person answered, and reading their
 * typed words onto options. The fold and the rulings are in `shared-decisions.ts`; the rulings
 * verbatim in docs/decision-rounds-worked-cases.md and the review rounds' `owner.md` files.
 *
 * Nothing here closes a finding. A ruling is carried out by the verifier (I9) or by a person in
 * session; close-on-answer was cut (owner, 2026-09-23).
 *
 * Verification happens HERE, on the machine that asked — the transcript never travels
 * (owner: "verification needs to happen before it ends up in the fold").
 */
import { createHash } from "node:crypto";
import { isAgentActor } from "../identity.js";
import { bindDecisions, type Bound, type Via } from "../ops-shared.js";
import { lookupFinding } from "../store.js";
import {
  CONFIRM_NO, CONFIRM_YES, NONE, readingRefusal, readerBrief as briefFor, bindRefusal, checkDecision, confirmPayload, confirmState, confirmedWords, decisionHash, logQuestionEvent,
  mapsKey, named, possiblySuperseded, postConfirmEvent, postRoundEvent, validMaps,
  readingsInDispute, recordAnswerEvent, recordReadingEvent, ruledNotCarriedOut, standing, waitingOnMe, awaitingReading, parked,
  type AnswerVia, type FoldedDecision, type Mapping, type SharedDecisions,
} from "../shared-decisions.js";
import { decisionsView } from "./decision-holds.js";
import { isUnverified, readCall, readMessage, readSubagent, sameQuestion, sessionHolding, transcriptDir } from "../transcript.js";
import type { AskedQuestion, Decision, DecisionRound } from "../schema.js";
import type { ScopeStatus } from "../eventlog.js";

/** Today by UTC date, for the views: parks are dated, and the fold holds no clock. Taken once
 *  per response, so a park cannot drop out of both views at midnight (owner, P3.2 (8)). */
const today = () => new Date().toISOString().slice(0, 10);

/** A write onto a scope the fold cannot read would be decided against rows that may be wrong. */
async function writable(root: string): Promise<{ s: SharedDecisions } | { error: string; status: ScopeStatus }> {
  const v = await decisionsView(root);
  if (v.status.status === "blocked") return { error: `the decisions log is blocked, so nothing is written: ${v.status.diagnostic?.detail ?? "unreadable"}`, status: v.status };
  return { s: v.s };
}

// --- posting ---------------------------------------------------------------------------

export interface NewRound { round: Omit<DecisionRound, "postedBy" | "at" | "universe" | "prevalidated">; decisions: Decision[] }

/** What posting refuses, shared by `postRound` and the import. */
export async function checkRound(root: string, r: NewRound): Promise<string | null> {
  const w = await writable(root);
  if ("error" in w) return w.error;
  const existing = w.s;
  if (!r?.round || typeof r.round.id !== "string" || !r.round.id.trim() || typeof r.round.source !== "string" || !r.round.source.trim()) return "a round needs an id and a source";
  if (!Array.isArray(r.decisions) || !r.decisions.length) return "a round needs at least one decision";
  if (existing.rounds.some((x) => x.id === r.round.id)) return `round ${r.round.id} is already posted; a changed question is a new decision in a new round`;
  const refs = new Set<string>(), ids = new Set<string>(), replaces = new Set<string>();
  for (const d of r.decisions) {
    if (d?.round !== r.round.id) return `decision ${String(d?.id)} names round ${String(d?.round)}, not ${r.round.id}`;
    const bad = checkDecision(d);
    if (bad) return `decision ${d.ref ?? d.id}: ${bad}`;
    if ((d.options as unknown as { closesOnAnswer?: unknown }[]).some((o) => o.closesOnAnswer !== undefined)) return `decision ${d.ref}: closesOnAnswer is gone — no answer closes a finding itself; a settle waits for the verifier`;
    // A reader's verdict names an option on one line, `D<n> → <label>` (owner, S0.8(c)). Asked
    // here and not in the fold, which must never drop a question already posted.
    const arrow = d.options.find((o) => /\n|→|->/.test(o.label));
    if (arrow) return `decision ${d.ref}: option "${arrow.label}" contains a newline or an arrow, so a reader's verdict line could not name it`;
    if (refs.has(d.ref)) return `two decisions in one round share the ref ${d.ref}`;
    refs.add(d.ref);
    // The fold keeps the first of two, so the second would be asked with the first's payload (bulk 8).
    if (ids.has(d.id)) return `two decisions in one round share the id ${d.id}`;
    ids.add(d.id);
    if (existing.decisions.some((x) => x.id === d.id)) return `decision ${d.id} is already posted`;
    // A decision names findings by codemap id, and only ones codemap holds (owner, 2026-09-23:
    // "Yes, refuse unrecorded"). Findings a round's own sort produced come in by import.
    for (const o of d.options) for (const e of o.effects) for (const f of e.findings) {
      const found = lookupFinding(root, f);
      if (!found) return `decision ${d.ref} names ${f}, which is not a finding this store holds — record it first (a skill round's findings come in through import_round)`;
      if ("ambiguous" in found) return `decision ${d.ref} names ${f}, which is a finding under more than one review (${found.ambiguous.join(", ")}), so a ruling on it could reach the wrong one`;
      // On this map only, the team's clones could not carry a ruling on it out (bulk 10).
      if (!found.finding.origin) return `decision ${d.ref} names ${f}, which is on this map only — publish it first (\`codemap unify-findings\`)`;
    }
    if (d.supersedes) {
      const old = existing.decisions.find((x) => x.id === d.supersedes);
      if (!old) return `decision ${d.ref} replaces ${d.supersedes}, which is not posted`;
      // The fold ignores it too: a pick on a confirm already says what a replacement could.
      if (old.confirms) return `decision ${d.ref} replaces ${old.ref}, which is a confirm: ask for a new confirm instead`;
      // One replacement per question, so "the replacement decides" names one (bulk 9, ruled):
      // re-asking a replaced question replaces its replacement, which keeps the chain linear.
      if (old.replacedBy) return `decision ${d.ref} replaces ${d.supersedes}, which ${old.replacedBy} already replaced — replace ${old.replacedBy} instead`;
      if (replaces.has(d.supersedes)) return `two decisions in this round replace ${d.supersedes}`;
      replaces.add(d.supersedes);
    }
  }
  return null;
}

/** Post a round of decisions, each with the exact `AskUserQuestion` payload it will be asked with. */
export async function postRound(root: string, r: NewRound, via: Via = {}) {
  const b = bindDecisions(root, via);
  if ("error" in b) return b;
  if ((r?.round as any)?.prevalidated !== undefined) return { error: "only import_round marks a round pre-validated — it comes from a skill's sort of two sorters and an arbitrator" };
  const bad = await checkRound(root, r);
  if (bad) return { error: bad };
  await postRoundEvent(b.cfg.path, b.cfg.universe, b.actor, { ...r.round, universe: b.cfg.universe }, r.decisions);
  const { s } = await decisionsView(root);
  return {
    ok: true, round: r.round.id,
    // What to ask with, verbatim — a paraphrase reads as unverified (C14).
    ask: r.decisions.map((d) => ({ decision: d.id, ref: d.ref, payload: s.decisions.find((x) => x.id === d.id)?.payload ?? d.payload })),
  };
}

/** Post a round the import built. Not exported to any surface: see `import_round`. The mark
 *  is provenance only — it closes nothing (owner, 2026-09-23). */
export async function postPrevalidated(root: string, b: Bound, r: NewRound, prevalidated: DecisionRound["prevalidated"]) {
  const bad = await checkRound(root, r);
  if (bad) return { error: bad };
  await postRoundEvent(b.cfg.path, b.cfg.universe, b.actor, { ...r.round, universe: b.cfg.universe, ...(prevalidated ? { prevalidated } : {}) }, r.decisions);
  return { ok: true as const, round: r.round.id };
}

// --- reading ---------------------------------------------------------------------------

/** Every decision whose ruling verified words may yet overturn (plan A3). */
const superseding = (s: SharedDecisions) => s.decisions.flatMap((d) => {
  const p = possiblySuperseded(d, new Map(s.decisions.map((x) => [x.id, x])));
  return p.length ? [{ decision: d.id, round: d.round, ref: d.ref, words: p }] : [];
});

/**
 * Every round, and the three things the person reads (owner, 2026-09-23). A read DEGRADES: a
 * broken or missing sidecar serves the rows this store holds, marked `blocked` (P3.2 (7)).
 */
export async function decisionRounds(root: string) {
  const v = await decisionsView(root);
  const { s } = v, now = today();
  return {
    ...v.status,
    rounds: s.rounds.map((r) => ({ ...r, decisions: s.decisions.filter((d) => d.round === r.id).length })),
    waitingOnYou: waitingOnMe(s, now),
    ruledNotCarriedOut: ruledNotCarriedOut(s, v.isOpen),
    readingsInDispute: readingsInDispute(s),
    parked: parked(s, now),
    possiblySuperseded: superseding(s),
    // Waiting on an agent, not on the person: shown so it is not mistaken for nothing.
    awaitingReading: awaitingReading(s),
  };
}

/** One round: its decisions with their payloads, answers and holds. */
export async function decisionRound(root: string, id: string) {
  const v = await decisionsView(root);
  const { s } = v, now = today();
  const round = s.rounds.find((r) => r.id === id);
  if (!round) return { error: `no round ${id}`, ...v.status };
  const byId = new Map(s.decisions.map((x) => [x.id, x]));
  const mine = (x: { round: string }) => x.round === id;
  const findings = [...new Set(s.decisions.filter(mine).flatMap(named))];
  return {
    ...v.status,
    round,
    decisions: s.decisions.filter(mine).map((d) => ({
      ...d, standing: standing(d) ?? null, possiblySuperseded: possiblySuperseded(d, byId),
      ...(d.confirms ? { confirm: { state: confirmState(byId, d)!, of: confirmedWords(byId, d)?.d.ref ?? null } } : {}),
    })),
    held: findings.map((finding) => ({ finding, ...v.mark(finding) })).filter((h) => h.held || h.possiblySuperseded),
    waitingOnYou: waitingOnMe(s, now).filter(mine),
    ruledNotCarriedOut: ruledNotCarriedOut(s, v.isOpen).filter(mine),
    readingsInDispute: readingsInDispute(s).filter(mine),
    parked: parked(s, now).filter(mine),
    awaitingReading: awaitingReading(s).filter(mine),
  };
}

// --- answering -------------------------------------------------------------------------

const found = (s: SharedDecisions, answer: string) => {
  for (const d of s.decisions) { const a = d.answers.find((x) => x.id === answer); if (a) return { d, a }; }
  return undefined;
};

async function record(root: string, b: Bound, d: FoldedDecision, via: AnswerVia, relayedBy?: string) {
  const e = await recordAnswerEvent(b.cfg.path, b.cfg.universe, b.actor, { decision: d.id, hash: d.hash, via, ...(relayedBy ? { relayedBy } : {}) });
  return outcome(root, d, e.id);
}

/** What the fold made of answer `id` on `d`, as the caller reads it. */
async function outcome(root: string, d: Pick<FoldedDecision, "id" | "ref">, id: string) {
  const { s } = await decisionsView(root);
  const now = s.decisions.find((x) => x.id === d.id);
  const a = now?.answers.find((x) => x.id === id);
  // The fold dropped it: say so rather than report an answer nobody will see.
  if (!now || !a) return { decision: d.id, ref: d.ref, recorded: false as const, why: "the fold did not accept this answer (a paraphrased question, a question posted after it was answered, one it was given after it was replaced, or an unverified park)" };
  const top = standing(now);
  return {
    decision: d.id, ref: d.ref, recorded: true as const, answer: id, verified: a.verified, standing: top?.id === a.id,
    ...(now.confirms ? { confirm: confirmOutcome(s, now, a) } : {}),
    ...(!a.verified && top?.verified ? { note: "unconfirmed, after a verified ruling: it is shown to the person and never applied over their ruling" } : {}),
    ...(a.free ? { awaitsReading: true } : {}),
    ruled: a.ruled, ...(a.unruled.length ? { waitingOnYou: a.unruled } : {}),
    ...(a.separately?.length ? { askSeparately: a.separately } : {}),
    ...(a.park ? { parked: a.park } : {}), ...(a.flags ? { flags: a.flags } : {}),
  };
}

/** What an answer on a confirm did to the words it asks about. */
function confirmOutcome(s: SharedDecisions, c: FoldedDecision, a: FoldedDecision["answers"][number]): string {
  if (c.confirms!.invalid) return `not a confirm codemap can verify (${c.confirms!.invalid}): this answer binds nothing — ask for a new confirm`;
  const t = confirmedWords(new Map(s.decisions.map((x) => [x.id, x])), c);
  if (a.free) return "their own words on the confirm: have a reader read them (reader_brief, then record_reading), like any typed reply";
  if (!t) return "the words it asks about are no longer an answer here";
  if (t.a.confirmed?.answer === a.id) return "bound: the reading is ruled, as of when they typed the words";
  if (a.options[0] === CONFIRM_NO) return `rejected: the ruling on ${t.d.ref} stands, flagged — re-ask ${t.d.ref} (the person must give a replacement answer)`;
  return "not the latest pick on those words, or they were bound another way: this binds nothing";
}

/**
 * Log an `AskUserQuestion` call from this session's transcript, and record it as the answer to
 * every decision whose exact payload it carries, in the rounds it was asked for. The default
 * path for relaying the person's answers (owner, R13). An unverifiable call writes nothing and
 * says why. A confirm is a posted decision like any other, so it is answered here too.
 */
export async function logQuestion(root: string, input: { session?: string; toolUseId: string; round: string | string[] }, via: Via = {}, dir: string = transcriptDir()) {
  const b = bindDecisions(root, via);
  if ("error" in b) return b;
  // From the caller, and required: the transcript cannot say which round a call was for, and
  // an identical question in another round must not take the answer (owner, B1.4; P2.4).
  const named = [...new Set((Array.isArray(input.round) ? input.round : [input.round]).filter((r) => typeof r === "string" && r.trim()))];
  if (!named.length) return { error: "log_question needs the round (or rounds) the call was asked for" };
  const session = input.session ?? sessionHolding(input.toolUseId, dir);
  if (isUnverified(session)) return { ok: false, unverified: session.unverified, note: "nothing was written" };
  const call = readCall(session, input.toolUseId, dir);
  if (isUnverified(call)) return { ok: false, unverified: call.unverified, note: "nothing was written; relay_answer can still record the words as an unverified answer, which only unblocks" };
  const w = await writable(root);
  if ("error" in w) return w;
  const before = w.s;
  const refused: { question: string; why: string }[] = [];
  // A named round posted after the call was answered refuses only that round (S0.8(d)).
  const rounds: DecisionRound[] = [];
  for (const id of named) {
    const r = before.rounds.find((x) => x.id === id);
    if (!r) return { error: `no round ${id}` };
    if (!(Date.parse(call.at) > Date.parse(r.at))) refused.push({ question: `(round ${id})`, why: `the call was answered at ${call.at}, and round ${id} was posted at ${r.at}: an answer binds only to a question posted before it` });
    else rounds.push(r);
  }
  // A retry of a call already logged records whichever of its answers are missing — a crash
  // between logging and recording must not strand them (H6.1). Its bindings were decided then.
  const prior = before.questions.find((q) => q.toolUseId === input.toolUseId && q.session === session);
  if (prior && named.some((r) => !prior.rounds.includes(r))) return { error: `call ${input.toolUseId} is already logged for ${prior.rounds.join(", ")}` };
  const bound: Record<string, string> = {};
  for (const q of call.questions) {
    const hits = rounds.filter((r) => before.decisions.some((d) => d.round === r.id && sameQuestion(q, d.payload)));
    if (hits.length > 1) refused.push({ question: q.question, why: `it is the posted question of more than one round you named (${hits.map((r) => r.id).join(", ")}), so which one it answers cannot be told` });
    else if (hits.length) bound[q.question] = hits[0]!.id;
  }
  if (!rounds.length) return { error: refused.map((x) => x.why).join("; ") + " (nothing was written)" };
  const logged = prior?.id ?? (await logQuestionEvent(b.cfg.path, b.cfg.universe, b.actor, {
    session: call.session, toolUseId: call.toolUseId, questions: call.questions, answers: call.answers, transcript: session,
    rounds: named, bound, answeredAt: call.at,
  })).id;
  const binding = prior?.bound ?? bound;
  const once = `q:${call.session}\0${call.toolUseId}`;
  const answered = [];
  for (const d of before.decisions) {
    // A replaced question is answered too: the fold keeps an answer given before the
    // replacement was posted, whenever it is recorded (plan A4, K1).
    if (binding[d.payload.question] !== d.round || !call.questions.some((q) => sameQuestion(q, d.payload)) || call.answers[d.payload.question] === undefined) continue;
    // Judged per decision: a round can grow after it is posted.
    if (!(Date.parse(call.at) > Date.parse(d.postedAt))) { refused.push({ question: d.payload.question, why: `the call was answered at ${call.at}, and ${d.ref} was posted at ${d.postedAt || "an unknown time"}: an answer binds only to a question posted before it` }); continue; }
    const had = d.answers.find((a) => a.once === once);
    // Answered once: the retry records nothing new (B1.4).
    if (had) answered.push({ decision: d.id, ref: d.ref, recorded: false as const, already: had.id });
    else answered.push(await record(root, b, d, { kind: "question", question: logged }));
  }
  return {
    ok: true, logged, ...(prior ? { retried: true } : {}), answered,
    ...(refused.length ? { refused } : {}),
    ...(answered.length ? {} : { note: `logged; no decision in ${named.join(", ")} carries these questions, so nothing was answered` }),
  };
}

/**
 * Relay the person's typed reply. Codemap copies their WHOLE message by its entry id (R16), so
 * a relay can never carry part of it. A message the transcript cannot confirm is recorded only
 * from `words`, as unverified: it unblocks and settles nothing (C8).
 */
export async function relayAnswer(root: string, input: { round: string; decision: string; session?: string; entryId: string; words?: string; relayedBy?: string }, via: Via = {}, dir: string = transcriptDir()) {
  const b = bindDecisions(root, via);
  if ("error" in b) return b;
  const w = await writable(root);
  if ("error" in w) return w;
  const d = w.s.decisions.find((x) => x.id === input.decision);
  if (!d) return { error: `no decision ${input.decision}` };
  // The context the agent says it was answering, which the reader checks against the transcript (H5).
  if (input.round !== d.round) return { error: `decision ${d.id} is in round ${d.round}, not ${String(input.round)}: say which round and question you asked` };
  const session = input.session ?? sessionHolding(input.entryId, dir);
  const m = isUnverified(session) ? session : readMessage(session, input.entryId, dir);
  if (isUnverified(m)) {
    if (!input.words?.trim()) return { ok: false, unverified: m.unverified, note: "nothing was written; pass the words to record them as an unverified answer, which only unblocks" };
    return { ok: true, ...(await record(root, b, d, { kind: "unverified", words: input.words }, input.relayedBy)), unverifiedBecause: m.unverified };
  }
  if (!(Date.parse(m.at) > Date.parse(d.postedAt))) {
    return { error: `the message was typed at ${m.at}, and ${d.ref} was posted at ${d.postedAt || "an unknown time"}: words bind only to a question posted before them (nothing was written)` };
  }
  const had = d.answers.find((a) => a.once === `m:${m.session}\0${m.entryId}`);
  if (had) return { ok: true, decision: d.id, ref: d.ref, recorded: false as const, already: had.id, note: "this message already answers this decision" };
  return { ok: true, ...(await record(root, b, d, { kind: "message", session: m.session, entryId: m.entryId, text: m.text, at: m.at, round: d.round }, input.relayedBy ?? m.session)) };
}

const ARROW = /^\s*(D\d+)\s*(?:→|->)\s*(.+?)\s*$/;
const UNCLEAR = /^\s*unclear:\s*(.+?)\s*$/i;

/**
 * The reader's verdict, from its own report (owner, P2.1 + S0.8(c)): one line per pick,
 * `D<n> → <label>` (`->` also), `D<n> → (none)` for words that fit no option there, or one
 * `unclear: <why>`. Other lines are the reader's prose and are ignored. Anything it cannot
 * resolve exactly is refused, so a reader's typo never becomes a dispute the person must settle.
 */
export function parseVerdict(report: string, s: SharedDecisions, round: string): { maps: Mapping[]; unclear?: string } | { error: string } {
  const maps: Mapping[] = [];
  const unclear: string[] = [];
  // Only the report's final block is the verdict (R6): a line quoted in the reader's prose is not.
  const lines = report.split("\n");
  while (lines.length && !lines.at(-1)!.trim()) lines.pop();
  let start = lines.length;
  while (start > 0 && (UNCLEAR.test(lines[start - 1]!) || ARROW.test(lines[start - 1]!))) start--;
  for (const line of lines.slice(start)) {
    const u = UNCLEAR.exec(line);
    if (u) { unclear.push(u[1]!); continue; }
    const m = ARROW.exec(line)!;
    const ts = s.decisions.filter((d) => d.round === round && d.ref === m[1]);
    // Two questions posted with one ref: which it names cannot be told (owner, P2.1 (4)).
    if (ts.length > 1) return { error: `the reader's line "${line.trim()}" names ${m[1]}, which two questions in round ${round} share: it is ambiguous` };
    const t = ts[0];
    if (!t) return { error: `the reader's line "${line.trim()}" names ${m[1]}, which is not a question in round ${round}` };
    const label = m[2]!;
    if (label !== NONE && !t.options.some((o) => o.label === label)) return { error: `the reader's line "${line.trim()}" names "${label}", which is not an option of ${t.ref} (${t.options.map((o) => o.label).join(" / ")})` };
    maps.push({ decision: t.id, option: label === NONE ? null : label });
  }
  if (unclear.length && maps.length) return { error: "the reader's report says both unclear and a mapping: which is it?" };
  if (unclear.length > 1) return { error: "the reader's report says unclear more than once" };
  if (unclear.length) return { maps: [], unclear: unclear[0]! };
  if (!maps.length) return { error: "the reader's report does not end with a verdict (`D<n> → <option>`, `D<n> → (none)`, or `unclear: <why>`)" };
  return { maps };
}

/**
 * The exact prompt to launch a reader with, for answer `answer` (owner, P1.4): the person's
 * words, the questions they may be read onto, and the verdict format — nothing of your reading.
 * `record_reading` refuses a reader launched with anything else.
 */
export async function readerBrief(root: string, input: { answer: string }) {
  const { s } = await decisionsView(root);
  const x = found(s, input?.answer);
  if (!x) return { error: `no answer ${String(input?.answer)}` };
  const { d, a } = x;
  if (d.kind === "words") return { error: `${d.ref} takes words: they are the answer, never read` };
  if (!a.free || a.elsewhere) return { error: `answer ${a.id} is not words waiting for a reading` };
  return {
    ok: true, answer: a.id, prompt: briefFor(new Map(s.decisions.map((y) => [y.id, y])), d, a),
    note: "launch a NEW general-purpose subagent (not a fork) with exactly this as its prompt, send it nothing else, then record_reading with its agent id",
  };
}

/**
 * Bind the person's free text by a reader's verdict (C17, C19; plan B1, B2). The reader is a
 * subagent the harness launched on this machine AFTER the words were typed, that has handed
 * back its report, and that reads this one answer only. It was never shown the session's
 * request; codemap parses the reader's own report and compares it with `session.maps` — agree
 * and it binds, disagree and it waits for the person, unclear and it waits for the person.
 */
export async function recordReading(root: string, input: { answer: string; reader: string; session: { reading?: string; maps: Mapping[] }; asks?: string }, via: Via = {}, dir: string = transcriptDir()) {
  const b = bindDecisions(root, via);
  if ("error" in b) return b;
  const w = await writable(root);
  if ("error" in w) return w;
  const x = found(w.s, input.answer);
  if (!x) return { error: `no answer ${input.answer}` };
  const { d, a } = x;
  if (a.reading) return { ok: true, recorded: false, already: a.reading.id, agree: a.reading.agree };
  if (!a.free) return { error: `answer ${a.id} is not words waiting for a reading` };
  // Never read (H6.8): after a verified ruling, unconfirmed words are shown to the person, not bound.
  if (!a.verified && standing(d)?.verified) return { error: `answer ${a.id} is unconfirmed and came after ${d.ref}'s verified ruling: it is shown to the person, never read` };
  const sm = validMaps(input.session?.maps);
  if (!sm) return { error: "session.maps is your reading, at least one line: [{ decision, option | null }]" };
  const agent = readSubagent(typeof input.reader === "string" ? input.reader : "", dir);
  if (isUnverified(agent)) return { ok: false, unverified: agent.unverified, note: "nothing was written: the reader must be a subagent of this machine, launched to read, finished, and passing its own agent id" };
  // Only an accepted reading counts, so this is the one a reader can have used (owner, P1.2).
  const other = w.s.decisions.flatMap((y) => y.answers).find((y) => y.reading?.reader.agent === agent.agentId);
  if (other) return { ok: false, unverified: `subagent ${agent.agentId} already read answer ${other.id}: one reader reads one answer`, note: "nothing was written" };
  const byId = new Map(w.s.decisions.map((y) => [y.id, y]));
  const brief = briefFor(byId, d, a);
  // Exact, at C14's strength: the one check that the reader never saw your reading (P1.4).
  if (agent.prompt !== brief) return { ok: false, unverified: `subagent ${agent.agentId} was not launched with reader_brief's prompt for ${a.id} — or the round changed since the brief was issued`, note: "nothing was written; launch a new reader with reader_brief's prompt" };
  const v = parseVerdict(agent.report, w.s, d.round);
  if ("error" in v) return { ok: false, unverified: v.error, note: "nothing was written" };
  // Exactly what the fold would not accept, with its reason — never an event it will drop.
  const why = readingRefusal(byId, d, a, { verdict: v.maps, unclear: v.unclear, session: sm, launchedAt: agent.launchedAt, brief });
  if (why) return { ok: false, unverified: why, note: "nothing was written; this reader was not used, so it may read another answer" };
  await recordReadingEvent(b.cfg.path, b.cfg.universe, b.actor, {
    answer: a.id, session: { ...(input.session.reading ? { reading: input.session.reading } : {}), maps: sm },
    reader: { agent: agent.agentId, verdict: v.maps, ...(v.unclear ? { unclear: v.unclear } : {}), launchedAt: agent.launchedAt, brief, verified: { session: agent.session, toolUseId: agent.toolUseId } },
    ...(input.asks ? { asks: input.asks } : {}),
  });
  const after = found((await decisionsView(root)).s, a.id);
  const r = after?.a.reading;
  if (!r) return { ok: false, recorded: false, why: "the fold did not accept this reading: the decisions log changed while it was being recorded — read the round again" };
  return {
    ok: true, agree: r.agree, reader: r.reader.maps,
    ...(r.agree ? {} : { note: r.unclear ? "unclear, so nothing binds and it waits for the person — re-ask the original question" : "the reader and your reading disagree, so nothing binds and it waits for the person — confirm_reading offers them both readings" }),
  };
}

/**
 * Post the confirm-this-reading question for words a ruling may not yet reflect (the impl-2
 * discussion; P2.1 (1)): a decision in the words' own round, with codemap's text, which holds
 * what its readings would rule on and waits on the person until it is answered. Ask it
 * verbatim, then `log_question` the call with that round. Yes (or Reading n) binds the reading
 * as of when they typed the words; "No — ask me again" records the rejection; their own words
 * under Other are read by a reader like any reply and carry none of this meaning.
 */
export async function confirmReading(root: string, input: { answer: string; maps?: Mapping[] }, via: Via = {}) {
  const b = bindDecisions(root, via);
  if ("error" in b) return b;
  const w = await writable(root);
  if ("error" in w) return w;
  const s = w.s, byId = new Map(s.decisions.map((y) => [y.id, y]));
  const x = found(s, input?.answer);
  if (!x) return { error: `no answer ${String(input?.answer)}` };
  const { d, a } = x;
  if (d.confirms) return { error: `${d.ref} is itself a confirm: words on it are read like any other reply (reader_brief, then record_reading)` };
  if (d.kind === "words") return { error: `${d.ref} takes words: they are the answer, never read onto options` };
  if (!a.free || a.elsewhere) return { error: `answer ${a.id} is not words waiting for a binding` };
  // An unclear reading has no mapping to confirm: re-ask the question (owner, "Agreed").
  if (a.reading?.unclear) return { error: `the reader could not tell which question these words answer (${a.reading.unclear}): re-ask ${d.ref} itself` };
  let readings: Mapping[][];
  if (a.reading && !a.reading.agree) readings = [a.reading.reader.maps, a.reading.session.maps];
  else {
    const maps = validMaps(input?.maps);
    if (!maps) return { error: "give your own reading of their words as maps: [{ decision, option | null }]" };
    if ((a.rejected ?? []).some((r) => mapsKey(r) === mapsKey(maps))) return { error: "the person already said this reading is not what they meant: re-ask the original question" };
    readings = [maps];
  }
  for (const r of readings) {
    // The fold's own test, so a confirm it would void is never posted.
    const why = bindRefusal(byId, d, a, r);
    if (why) return { error: `that reading cannot bind: ${why}` };
    for (const id of new Set(r.map((m) => m.decision))) {
      const t = byId.get(id)!;
      if (s.decisions.filter((y) => y.round === d.round && y.ref === t.ref).length > 1) return { error: `${t.ref} names two questions in round ${d.round}, so a line naming it is ambiguous (P2.1 (4))` };
    }
  }
  const key = readings.map(mapsKey).join("\n--\n");
  // Asked again: the open confirm, never a second question and a second hold.
  const open = s.decisions.find((c) => c.confirms?.answer === a.id && c.confirms.readings.map(mapsKey).join("\n--\n") === key && confirmState(byId, c) === "open");
  if (open) return { ok: true, confirm: open.id, ref: open.ref, round: open.round, ask: open.payload, existing: true, note: `already posted: ask it verbatim, then log_question the call with round ${d.round}` };
  const ref = `D${Math.max(0, ...s.decisions.filter((y) => y.round === d.round).map((y) => Number(y.ref.slice(1)))) + 1}`;
  const payload = confirmPayload(byId, d, a, readings, ref);
  // Derived from what it asks, so two clones posting the same confirm post one decision.
  const id = `cf_${createHash("sha256").update(`${a.id}\0${key}\0${ref}`).digest("hex").slice(0, 16)}`;
  const decision = { id, round: d.round, ref, kind: "options" as const, payload, options: payload.options.map((o) => ({ label: o.label, effects: [] })), confirms: { answer: a.id, readings } };
  const bad = checkDecision(decision);
  if (bad) return { error: `the confirm could not be posted: ${bad}` };
  await postConfirmEvent(b.cfg.path, b.cfg.universe, b.actor, decision);
  const after = (await decisionsView(root)).s.decisions.find((y) => y.id === id);
  if (!after || after.confirms?.invalid) return { ok: false, posted: id, why: `the fold does not accept it as a confirm${after?.confirms?.invalid ? `: ${after.confirms.invalid}` : ""} — it waits as a plain question that binds nothing` };
  return { ok: true, confirm: id, ref, round: d.round, ask: after.payload, note: `ask this verbatim with AskUserQuestion, then log_question the call with round ${d.round}` };
}

/** The person answering on the page. Never an agent (R18). */
export async function answerDirect(root: string, input: { decision: string; option?: string; park?: string; words?: string; checked?: string[] }, via: Via = {}) {
  const b = bindDecisions(root, via);
  if ("error" in b) return b;
  if (isAgentActor(b.actor)) return { error: "answering on a person's behalf is not an agent's act: ask with AskUserQuestion and log_question it" };
  const w = await writable(root);
  if ("error" in w) return w;
  const d = w.s.decisions.find((x) => x.id === input.decision);
  if (!d) return { error: `no decision ${input.decision}` };
  const { decision: _d, ...rest } = input;
  return { ok: true, ...(await record(root, b, d, { kind: "direct", ...rest })) };
}

export { decisionHash, CONFIRM_YES, CONFIRM_NO };
