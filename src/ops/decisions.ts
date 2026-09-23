/**
 * Decision rounds: posting questions, recording what the person answered, and carrying out the
 * one kind of ruling this plan lets an answer carry out itself. The fold and the rulings are in
 * `shared-decisions.ts`; the rulings verbatim in docs/decision-rounds-worked-cases.md.
 *
 * Verification happens HERE, on the machine that asked — the transcript never travels
 * (owner: "verification needs to happen before it ends up in the fold").
 */
import { isAgentActor } from "../identity.js";
import { readCached } from "../materialize.js";
import { decisionsProjection } from "../shared-projections.js";
import { sidecarIdentity, type SidecarConfig } from "../sidecar-config.js";
import { bindDecisions, closeFindingOnDecision, findingKeyAndState, type Bound, type Via } from "../ops-shared.js";
import { isClosed } from "../shared-findings.js";
import {
  checkDecision, decisionHash, decisionScope, foldDecisions, heldFindings, logQuestionEvent, postRoundEvent, readingsInDispute,
  recordAnswerEvent, recordReadingEvent, ruledNotCarriedOut, standing, waitingOnMe, awaitingReading,
  type AnswerVia, type FoldedDecision, type Mapping, type SharedDecisions,
} from "../shared-decisions.js";
import { isUnverified, readCall, readMessage, sameQuestion, sessionHolding, transcriptDir } from "../transcript.js";
import type { Decision, DecisionRound } from "../schema.js";
import type { ScopeStatus } from "../eventlog.js";

/** The folded rounds, and whether the log could be read — a blocked scope serves its stored
 *  rows, which must never read as "every question is answered". */
const read = async (root: string, cfg: Pick<SidecarConfig, "path" | "universe">): Promise<{ s: SharedDecisions; status: ScopeStatus }> => {
  const { value, ...status } = await readCached(root, cfg.path, decisionScope(cfg.universe), sidecarIdentity(cfg), foldDecisions, decisionsProjection);
  return { s: value, status };
};
const cached = async (root: string, cfg: Pick<SidecarConfig, "path" | "universe">): Promise<SharedDecisions> => (await read(root, cfg)).s;

/** A write onto a scope the fold cannot read would be decided against rows that may be wrong. */
async function writable(root: string, b: Bound): Promise<{ s: SharedDecisions } | { error: string; status: ScopeStatus }> {
  const { s, status } = await read(root, b.cfg);
  if (status.status === "blocked") return { error: `the decisions log is blocked, so nothing is written: ${status.diagnostic?.detail ?? "unreadable"}`, status };
  return { s };
}

const isOpen = (root: string) => (f: string) => {
  const r = findingKeyAndState(root, f);
  return !!r && !isClosed(r.state as any);
};

// --- posting ---------------------------------------------------------------------------

export interface NewRound { round: Omit<DecisionRound, "postedBy" | "at" | "universe" | "prevalidated">; decisions: Decision[] }

/** What posting refuses, shared by `postRound` and the import (which alone may pre-validate). */
export async function checkRound(root: string, b: Bound, r: NewRound, prevalidated: boolean): Promise<string | null> {
  const w = await writable(root, b);
  if ("error" in w) return w.error;
  const existing = w.s;
  if (!r?.round || typeof r.round.id !== "string" || !r.round.id.trim() || typeof r.round.source !== "string" || !r.round.source.trim()) return "a round needs an id and a source";
  if (!Array.isArray(r.decisions) || !r.decisions.length) return "a round needs at least one decision";
  if (existing.rounds.some((x) => x.id === r.round.id)) return `round ${r.round.id} is already posted; a changed question is a new decision in a new round`;
  const refs = new Set<string>();
  for (const d of r.decisions) {
    if (d?.round !== r.round.id) return `decision ${String(d?.id)} names round ${String(d?.round)}, not ${r.round.id}`;
    const bad = checkDecision(d, prevalidated);
    if (bad) return `decision ${d.ref ?? d.id}: ${bad}`;
    if (refs.has(d.ref)) return `two decisions in one round share the ref ${d.ref}`;
    refs.add(d.ref);
    if (existing.decisions.some((x) => x.id === d.id)) return `decision ${d.id} is already posted`;
    // A decision names findings by codemap id, and only ones codemap holds (owner, 2026-09-23:
    // "Yes, refuse unrecorded"). Findings a round's own sort produced come in by import.
    for (const o of d.options) for (const e of o.effects) for (const f of e.findings) {
      if (!findingKeyAndState(root, f)) return `decision ${d.ref} names ${f}, which is not a finding this store holds — record it first (a skill round's findings come in through import_round)`;
    }
    if (d.supersedes && !existing.decisions.some((x) => x.id === d.supersedes)) return `decision ${d.ref} replaces ${d.supersedes}, which is not posted`;
  }
  return null;
}

/** Post a round of decisions, each with the exact `AskUserQuestion` payload it will be asked with. */
export async function postRound(root: string, r: NewRound, via: Via = {}) {
  const b = bindDecisions(root, via);
  if ("error" in b) return b;
  if ((r?.round as any)?.prevalidated !== undefined) return { error: "only import_round marks a round pre-validated — it comes from a skill's sort of two sorters and an arbitrator" };
  const bad = await checkRound(root, b, r, false);
  if (bad) return { error: bad };
  await postRoundEvent(b.cfg.path, b.cfg.universe, b.actor, { ...r.round, universe: b.cfg.universe }, r.decisions);
  const s = await cached(root, b.cfg);
  return {
    ok: true, round: r.round.id,
    // What to ask with, verbatim — a paraphrase reads as unverified (C14).
    ask: r.decisions.map((d) => ({ decision: d.id, ref: d.ref, payload: s.decisions.find((x) => x.id === d.id)?.payload ?? d.payload })),
  };
}

/** Post a round the import built. Not exported to any surface: see `import_round`. */
export async function postPrevalidated(root: string, b: Bound, r: NewRound, prevalidated: DecisionRound["prevalidated"]) {
  const bad = await checkRound(root, b, r, !!prevalidated);
  if (bad) return { error: bad };
  await postRoundEvent(b.cfg.path, b.cfg.universe, b.actor, { ...r.round, universe: b.cfg.universe, ...(prevalidated ? { prevalidated } : {}) }, r.decisions);
  return { ok: true as const, round: r.round.id };
}

// --- reading ---------------------------------------------------------------------------

/** Every round, and the three things the person reads (owner, 2026-09-23). */
export async function decisionRounds(root: string, via: Via = {}) {
  const b = bindDecisions(root, via);
  if ("error" in b) return b;
  const { s, status } = await read(root, b.cfg);
  return {
    ...status,
    rounds: s.rounds.map((r) => ({ ...r, decisions: s.decisions.filter((d) => d.round === r.id).length })),
    waitingOnYou: waitingOnMe(s),
    ruledNotCarriedOut: ruledNotCarriedOut(s, isOpen(root)),
    readingsInDispute: readingsInDispute(s),
    // Waiting on an agent, not on the person: shown so it is not mistaken for nothing.
    awaitingReading: awaitingReading(s),
  };
}

/** One round: its decisions with their payloads, answers and holds. */
export async function decisionRound(root: string, id: string, via: Via = {}) {
  const b = bindDecisions(root, via);
  if ("error" in b) return b;
  const { s, status } = await read(root, b.cfg);
  const round = s.rounds.find((r) => r.id === id);
  if (!round) return { error: `no round ${id}`, ...status };
  const mine = (x: { round: string }) => x.round === id;
  const held = heldFindings(s);
  return {
    ...status,
    round,
    decisions: s.decisions.filter(mine).map((d) => ({ ...d, standing: standing(d) ?? null })),
    held: [...held].filter(([, hs]) => hs.some((h) => s.decisions.find((d) => d.id === h.decision)?.round === id)).map(([finding, hs]) => ({ finding, holds: hs })),
    waitingOnYou: waitingOnMe(s).filter(mine),
    ruledNotCarriedOut: ruledNotCarriedOut(s, isOpen(root)).filter(mine),
    readingsInDispute: readingsInDispute(s).filter(mine),
    awaitingReading: awaitingReading(s).filter(mine),
  };
}

// --- answering -------------------------------------------------------------------------

/**
 * Carry out what the answer itself may carry out: the settles of a pre-validated option, and
 * only on a verified answer that is the decision's standing one. Every other ruling waits for
 * the verifier (owner, 2026-09-23: "Held until I9"). The close is `b.actor`'s act, stamped
 * with whose ruling it carries out.
 */
async function carryOut(root: string, b: Bound, decisionId: string, answerId: string) {
  const s = await cached(root, b.cfg);
  const d = s.decisions.find((x) => x.id === decisionId);
  const a = d && standing(d);
  // No `verified` check here: the fold never rules a settle from an unverified answer (C8).
  if (!d || !a || a.id !== answerId) return [];
  const closed: string[] = [];
  for (const r of a.ruled) {
    if (!r.closesOnAnswer || r.on !== "settle" || r.as !== "refuted") continue;
    const row = findingKeyAndState(root, r.finding);
    // Already closed: the finding stays as its closer left it; the ruling is still recorded.
    if (!row || isClosed(row.state as any)) continue;
    await closeFindingOnDecision(root, b, row.pr, { round: d.round, decision: d.id, answer: a.id, ruler: a.by.principal, finding: r.finding, as: "refuted" },
      `ruled by ${a.by.principal} (${d.ref}: ${a.words})`);
    closed.push(r.finding);
  }
  return closed;
}

async function record(root: string, b: Bound, d: FoldedDecision, via: AnswerVia, relayedBy?: string) {
  const e = await recordAnswerEvent(b.cfg.path, b.cfg.universe, b.actor, { decision: d.id, hash: d.hash, via, ...(relayedBy ? { relayedBy } : {}) });
  const s = await cached(root, b.cfg);
  const now = s.decisions.find((x) => x.id === d.id);
  const a = now?.answers.find((x) => x.id === e.id);
  // The fold dropped it: say so rather than report an answer nobody will see.
  if (!a) return { decision: d.id, ref: d.ref, recorded: false as const, why: "the fold did not accept this answer (a paraphrased question, an unverified park, or a decision since replaced)" };
  const closed = await carryOut(root, b, d.id, e.id);
  return {
    decision: d.id, ref: d.ref, recorded: true as const, answer: e.id, verified: a.verified,
    ...(a.free ? { awaitsReading: true } : {}),
    ruled: a.ruled, ...(a.unruled.length ? { waitingOnYou: a.unruled } : {}),
    ...(a.separately?.length ? { askSeparately: a.separately } : {}),
    ...(a.park ? { parked: a.park } : {}), ...(a.flags ? { flags: a.flags } : {}),
    // Every finding this answer closed, listed, never collapsed (R7.2).
    closed,
  };
}

/**
 * Log an `AskUserQuestion` call from this session's transcript, and record it as the answer to
 * every open decision whose exact payload it carries. The default path for relaying the person's
 * answers (owner, R13). An unverifiable call writes nothing and says why.
 */
export async function logQuestion(root: string, input: { session?: string; toolUseId: string }, via: Via = {}, dir: string = transcriptDir()) {
  const b = bindDecisions(root, via);
  if ("error" in b) return b;
  const session = input.session ?? sessionHolding(input.toolUseId, dir);
  if (isUnverified(session)) return { ok: false, unverified: session.unverified, note: "nothing was written" };
  input = { ...input, session };
  const call = readCall(session, input.toolUseId, dir);
  if (isUnverified(call)) return { ok: false, unverified: call.unverified, note: "nothing was written; relay_answer can still record the words as an unverified answer, which only unblocks" };
  const w = await writable(root, b);
  if ("error" in w) return w;
  const before = w.s;
  if (before.questions.some((q) => q.toolUseId === input.toolUseId && q.session === session)) return { error: `call ${input.toolUseId} is already logged` };
  const e = await logQuestionEvent(b.cfg.path, b.cfg.universe, b.actor, { session: call.session, toolUseId: call.toolUseId, questions: call.questions, answers: call.answers, transcript: session });
  const answered = [];
  for (const d of before.decisions) {
    if (d.replacedBy || !call.questions.some((q) => sameQuestion(q, d.payload)) || call.answers[d.payload.question] === undefined) continue;
    answered.push(await record(root, b, d, { kind: "question", question: e.id }));
  }
  return { ok: true, logged: e.id, answered, ...(answered.length ? {} : { note: "logged; no posted decision carries these questions, so nothing was answered" }) };
}

/**
 * Relay the person's typed reply. Codemap copies their WHOLE message by its entry id (R16), so
 * a relay can never carry part of it. A message the transcript cannot confirm is recorded only
 * from `words`, as unverified: it unblocks and settles nothing (C8).
 */
export async function relayAnswer(root: string, input: { decision: string; session?: string; entryId: string; words?: string; relayedBy?: string }, via: Via = {}, dir: string = transcriptDir()) {
  const b = bindDecisions(root, via);
  if ("error" in b) return b;
  const w = await writable(root, b);
  if ("error" in w) return w;
  const d = w.s.decisions.find((x) => x.id === input.decision);
  if (!d) return { error: `no decision ${input.decision}` };
  const session = input.session ?? sessionHolding(input.entryId, dir);
  const m = isUnverified(session) ? session : readMessage(session, input.entryId, dir);
  if (isUnverified(m)) {
    if (!input.words?.trim()) return { ok: false, unverified: m.unverified, note: "nothing was written; pass the words to record them as an unverified answer, which only unblocks" };
    return { ok: true, ...(await record(root, b, d, { kind: "unverified", words: input.words }, input.relayedBy)), unverifiedBecause: m.unverified };
  }
  return { ok: true, ...(await record(root, b, d, { kind: "message", session: m.session, entryId: m.entryId, text: m.text }, input.relayedBy ?? m.session)) };
}

/** The reader's mapping of free text onto options, beside the session's own (C17, C19). */
export async function recordReading(root: string, input: {
  answer: string; reader: { transcript: string; reading: string; maps: Mapping[] }; session: { reading: string; maps: Mapping[] }; asks?: string;
}, via: Via = {}) {
  const b = bindDecisions(root, via);
  if ("error" in b) return b;
  const w = await writable(root, b);
  if ("error" in w) return w;
  const d = w.s.decisions.find((x) => x.answers.some((a) => a.id === input.answer));
  if (!d) return { error: `no answer ${input.answer}` };
  await recordReadingEvent(b.cfg.path, b.cfg.universe, b.actor, input);
  const s = await cached(root, b.cfg);
  const a = s.decisions.find((x) => x.id === d.id)?.answers.find((x) => x.id === input.answer);
  if (!a?.reading) return { ok: false, recorded: false, why: "the fold did not accept this reading (the reader is the relayer, a decision it names is answered, replaced or in another round, or the answer was not free text)" };
  const closed: string[] = [];
  if (a.reading.agree) for (const x of s.decisions) closed.push(...await carryOut(root, b, x.id, standing(x)?.id ?? ""));
  return { ok: true, agree: a.reading.agree, ...(a.reading.agree ? {} : { note: "the readings disagree, so nothing applies and it waits for the person" }), closed };
}

/** The person answering on the page. Never an agent (R18). */
export async function answerDirect(root: string, input: { decision: string; option?: string; park?: string; words?: string; checked?: string[] }, via: Via = {}) {
  const b = bindDecisions(root, via);
  if ("error" in b) return b;
  if (isAgentActor(b.actor)) return { error: "answering on a person's behalf is not an agent's act: ask with AskUserQuestion and log_question it" };
  const w = await writable(root, b);
  if ("error" in w) return w;
  const d = w.s.decisions.find((x) => x.id === input.decision);
  if (!d) return { error: `no decision ${input.decision}` };
  const { decision: _d, ...rest } = input;
  return { ok: true, ...(await record(root, b, d, { kind: "direct", ...rest })) };
}

export { decisionHash };
