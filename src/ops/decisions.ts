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
import { isAgentActor } from "../identity.js";
import { bindDecisions, type Bound, type Via } from "../ops-shared.js";
import { lookupFinding } from "../store.js";
import {
  CONFIRM_NO, CONFIRM_YES, NONE, checkDecision, confirmPayload, confirmTarget, decisionHash, logQuestionEvent, mapsKey, named, possiblySuperseded, postRoundEvent, validMaps,
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
  const p = possiblySuperseded(d);
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
  const mine = (x: { round: string }) => x.round === id;
  const findings = [...new Set(s.decisions.filter(mine).flatMap(named))];
  return {
    ...v.status,
    round,
    decisions: s.decisions.filter(mine).map((d) => ({ ...d, standing: standing(d) ?? null, possiblySuperseded: possiblySuperseded(d) })),
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
    ...(!a.verified && top?.verified ? { note: "unconfirmed, after a verified ruling: it is shown to the person and never applied over their ruling" } : {}),
    ...(a.free ? { awaitsReading: true } : {}),
    ruled: a.ruled, ...(a.unruled.length ? { waitingOnYou: a.unruled } : {}),
    ...(a.separately?.length ? { askSeparately: a.separately } : {}),
    ...(a.park ? { parked: a.park } : {}), ...(a.flags ? { flags: a.flags } : {}),
  };
}

/**
 * Log an `AskUserQuestion` call from this session's transcript, and record it as the answer to
 * every decision whose exact payload it carries, in the rounds it was asked for. The default
 * path for relaying the person's answers (owner, R13). An unverifiable call writes nothing and
 * says why. A confirm-this-reading question in the call is recognised by the fold from the
 * logged call alone (S0.2); this reports what it did.
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
  const confirms: { question: string; answer: string }[] = [];
  for (const q of call.questions) {
    const target = confirmTarget(q);
    if (target) { confirms.push({ question: q.question, answer: target }); continue; }
    const hits = rounds.filter((r) => before.decisions.some((d) => d.round === r.id && sameQuestion(q, d.payload)));
    if (hits.length > 1) refused.push({ question: q.question, why: `it is the posted question of more than one round you named (${hits.map((r) => r.id).join(", ")}), so which one it answers cannot be told` });
    else if (hits.length) bound[q.question] = hits[0]!.id;
  }
  if (!rounds.length && !confirms.length) return { error: refused.map((x) => x.why).join("; ") + " (nothing was written)" };
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
  const after = confirms.length ? (await decisionsView(root)).s : before;
  const confirmed = confirms.map(({ question, answer }) => {
    const x = found(after, answer);
    const value = call.answers[question];
    if (!x) return { answer, result: "no such answer: not a confirm codemap issued" };
    if (x.a.confirmed?.call === logged) return { answer, result: "bound", maps: x.a.confirmed.maps };
    if (value === CONFIRM_NO && x.a.rejected?.length) return { answer, result: `rejected: the old ruling stands, flagged — re-ask ${x.d.ref} (the person must give a replacement)` };
    const other = after.decisions.flatMap((d) => d.answers).find((y) => y.id === `${logged}/${x.d.id}`);
    if (other) return { answer, result: `their own words, recorded as ${other.id}: have a reader read them; to act on them directly, ask a second, formatted confirm` };
    return { answer, result: "not recognised: the question was not the exact text confirm_reading issued, or the words have since been bound" };
  });
  return {
    ok: true, logged, ...(prior ? { retried: true } : {}), answered,
    ...(confirmed.length ? { confirmed } : {}),
    ...(refused.length ? { refused } : {}),
    ...(answered.length || confirmed.length ? {} : { note: `logged; no decision in ${named.join(", ")} carries these questions, so nothing was answered` }),
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
  for (const line of report.split("\n")) {
    const u = UNCLEAR.exec(line);
    if (u) { unclear.push(u[1]!); continue; }
    const m = ARROW.exec(line);
    if (!m) continue;
    const t = s.decisions.find((d) => d.round === round && d.ref === m[1]);
    if (!t) return { error: `the reader's line "${line.trim()}" names ${m[1]}, which is not a question in round ${round}` };
    const label = m[2]!;
    if (label !== NONE && !t.options.some((o) => o.label === label)) return { error: `the reader's line "${line.trim()}" names "${label}", which is not an option of ${t.ref} (${t.options.map((o) => o.label).join(" / ")})` };
    maps.push({ decision: t.id, option: label === NONE ? null : label });
  }
  if (unclear.length && maps.length) return { error: "the reader's report says both unclear and a mapping: which is it?" };
  if (unclear.length > 1) return { error: "the reader's report says unclear more than once" };
  if (unclear.length) return { maps: [], unclear: unclear[0]! };
  if (!maps.length) return { error: "the reader's report has no verdict line (`D<n> → <option>`, `D<n> → (none)`, or `unclear: <why>`)" };
  return { maps };
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
  if (!(Date.parse(agent.launchedAt) > Date.parse(a.givenAt))) return { ok: false, unverified: `subagent ${agent.agentId} was launched at ${agent.launchedAt}, before the words were typed at ${a.givenAt}: it cannot have read them`, note: "nothing was written" };
  const other = w.s.decisions.flatMap((y) => y.answers).find((y) => y.reading?.reader.agent === agent.agentId);
  if (other) return { ok: false, unverified: `subagent ${agent.agentId} already read answer ${other.id}: one reader reads one answer`, note: "nothing was written" };
  const v = parseVerdict(agent.report, w.s, d.round);
  if ("error" in v) return { ok: false, unverified: v.error, note: "nothing was written" };
  await recordReadingEvent(b.cfg.path, b.cfg.universe, b.actor, {
    answer: a.id, session: { ...(input.session.reading ? { reading: input.session.reading } : {}), maps: sm },
    reader: { agent: agent.agentId, verdict: v.maps, ...(v.unclear ? { unclear: v.unclear } : {}), launchedAt: agent.launchedAt, verified: { session: agent.session, toolUseId: agent.toolUseId } },
    ...(input.asks ? { asks: input.asks } : {}),
  });
  const after = found((await decisionsView(root)).s, a.id);
  const r = after?.a.reading;
  if (!r) return { ok: false, recorded: false, why: "the fold did not accept this reading (a question it names is in another round, takes no options, or was replaced before the words were typed)" };
  return {
    ok: true, agree: r.agree, reader: r.reader.maps,
    ...(r.agree ? {} : { note: r.unclear ? "unclear, so nothing binds and it waits for the person — re-ask the original question" : "the reader and your reading disagree, so nothing binds and it waits for the person — confirm_reading offers them both readings" }),
  };
}

/**
 * The exact confirm-this-reading question for words a ruling may not yet reflect (owner, S0.1 +
 * S0.2). Ask it verbatim with `AskUserQuestion`, then `log_question` the call: Yes binds the
 * reading as of when they typed it; "No — ask me again" records the rejection and you re-ask
 * the original question; their own words under Other are a new typed answer for a reader.
 * Writes nothing.
 */
export async function confirmReading(root: string, input: { answer: string; maps?: Mapping[] }) {
  const { s } = await decisionsView(root);
  const x = found(s, input.answer);
  if (!x) return { error: `no answer ${input.answer}` };
  const { d, a } = x;
  if (!a.free || a.elsewhere) return { error: `answer ${a.id} is not words waiting for a binding` };
  if (d.replacedBy) return { error: `${d.ref} was replaced by ${d.replacedBy}: ask that instead` };
  // An unclear reading has no mapping to confirm: re-ask the question (owner, "Agreed").
  if (a.reading?.unclear) return { error: `the reader could not tell which question these words answer (${a.reading.unclear}): re-ask ${d.ref} itself` };
  let readings: Mapping[][];
  if (a.reading && !a.reading.agree) readings = [a.reading.reader.maps, a.reading.session.maps];
  else {
    const maps = validMaps(input.maps);
    if (!maps) return { error: "give your own reading of their words as maps: [{ decision, option | null }]" };
    if ((a.rejected ?? []).some((r) => mapsKey(r) === mapsKey(maps))) return { error: "the person already said this reading is not what they meant: re-ask the original question" };
    readings = [maps];
  }
  for (const m of readings.flat()) {
    const t = s.decisions.find((y) => y.id === m.decision);
    if (!t || t.round !== d.round) return { error: `${m.decision} is not a question in round ${d.round}` };
    if (m.option !== null && !t.options.some((o) => o.label === m.option)) return { error: `"${m.option}" is not an option of ${t.ref}` };
  }
  const ask = confirmPayload(s.decisions, d, a, readings) as AskedQuestion;
  return { ok: true, ask, note: `ask this verbatim, then log_question the call with round ${d.round}` };
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
