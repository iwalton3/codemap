/**
 * Review C16 (owner: "Validations are for the database at the time the item was created not the
 * future"): appending an event the door accepts must never change the verdict on an event before
 * it. Random histories, each event offered to the door at the tip and kept only if accepted; after
 * every append the whole log is folded, and no earlier event may be refused.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { decisionHash, decisionsDoor, foldDecisions, KEEP_IT, WITHDRAW_IT, withdrawalQuestion } from "./shared-decisions.js";
import { foldJudged } from "./validation.js";
import { foldDecisionsReport } from "./shared-decisions.js";
import { kindsFor, type LogEvent } from "./eventlog.js";
import type { Actor } from "./schema.js";

const PEOPLE: Actor[] = [{ principal: "alice@x.com" }, { principal: "bob@x.com" }];
const AGENT: Actor = { principal: "alice@x.com", via: { kind: "agent", model: "m" } };

/** A small seeded generator, so a failure names a seed that reproduces it. */
function rng(seed: number) {
  let s = seed >>> 0;
  const next = () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 2 ** 32; };
  return { next, pick: <T>(xs: T[]): T => xs[Math.floor(next() * xs.length)]! };
}

function history(seed: number, length: number): { accepted: LogEvent[]; offered: number } {
  const r = rng(seed);
  const accepted: LogEvent[] = [];
  let n = 0, rounds = 0;
  const ev = (kind: string, subject: string, data: Record<string, unknown>, actor: Actor, after: string[]): LogEvent => ({
    id: `e${String(++n).padStart(4, "0")}`, kind, subject, data, actor, after, at: `2026-09-25T00:${String(Math.floor(n / 60)).padStart(2, "0")}:${String(n % 60).padStart(2, "0")}Z`,
    writer: actor.via ? "w_agent" : `w_${actor.principal[0]}`, writerPrev: "GENESIS", sidecarProtocol: 2, eventSchema: 1, seq: accepted.length + 1,
  });
  /** What the author read: everything, or (sometimes) a stale prefix. */
  const seen = (): string[] => {
    if (!accepted.length) return [];
    const upTo = r.next() < 0.75 ? accepted.length : Math.floor(r.next() * accepted.length);
    return upTo ? [accepted[upTo - 1]!.id] : [];
  };
  const post = (decision: Record<string, unknown>, round: string) =>
    ev("decision.round.posted", round, { publication: 2, round: { id: round, source: "test", universe: "u" }, decisions: [decision] }, AGENT, seen());
  const settle = (id: string) => ({ id, round: "", ref: id.toUpperCase(), kind: "options",
    payload: { question: `${id.toUpperCase()}: settle F1?`, options: [{ label: "Settle" }, { label: "Keep open" }] },
    options: [{ label: "Settle", effects: [{ findings: ["F1"], on: "settle", as: "refuted" }] }, { label: "Keep open", effects: [] }] });

  let offered = 0;
  for (let i = 0; i < length; i++) {
    const s = foldDecisions(accepted);
    const open = s.decisions.filter((d) => !d.withdrawn);
    const move = r.next();
    let e: LogEvent | null = null;
    if (!open.length || move < 0.1) {
      const round = `R${++rounds}`;
      e = post({ ...settle(`d${rounds}`), round }, round);
    } else if (move < 0.4) {
      const d = r.pick(open);
      const who = r.pick(PEOPLE);
      e = ev("decision.answer.recorded", d.id, { decision: d.id, hash: decisionHash(d),
        via: { kind: "direct", option: r.pick(d.options.map((o) => o.label)) } }, who, seen());
    } else if (move < 0.5) {
      const d = r.pick(open);
      const a = d.answers.filter((x) => x.verified && !x.sourceAnswer);
      if (!a.length) continue;
      const named = r.pick(a);
      const by = PEOPLE.find((p) => p.principal === named.by.principal) ?? r.pick(PEOPLE);
      e = ev("decision.withdrawn", d.id, { decision: d.id, answer: named.id, reason: "changed my mind", knownAnswers: a.map((x) => x.id) }, by, seen());
    } else if (move < 0.65) {
      // The relay: a withdrawal question for an answer of a person.
      const d = r.pick(open.filter((x) => !x.payload.options.some((o) => o.label === WITHDRAW_IT)));
      const a = d?.answers.filter((x) => x.verified && !x.sourceAnswer) ?? [];
      if (!a.length) continue;
      const named = r.pick(a);
      const q = withdrawalQuestion(d!, named, "conflicts", d!.ref);
      const round = `R${++rounds}`;
      e = post({ id: `w${rounds}`, round, ref: d!.ref, kind: "options", payload: q,
        options: q.options.map((o) => ({ label: o.label, effects: [] })) }, round);
    } else {
      // An agent withdrawal through a relay question, if one exists; or the person's answer to it.
      const relays = s.decisions.filter((x) => x.payload.options.some((o) => o.label === WITHDRAW_IT));
      if (!relays.length) continue;
      const relay = r.pick(relays);
      const target = s.decisions.find((x) => x.ref === relay.ref && x.id !== relay.id && !x.withdrawn);
      const named = target?.answers.find((x) => x.verified && !x.sourceAnswer
        && JSON.stringify(withdrawalQuestion(target, x, "conflicts", relay.ref)) === JSON.stringify(relay.payload));
      if (r.next() < 0.5 || !target || !named) {
        e = ev("decision.answer.recorded", relay.id, { decision: relay.id, hash: decisionHash(relay),
          via: { kind: "direct", option: r.pick([WITHDRAW_IT, KEEP_IT]) } }, PEOPLE[0]!, seen());
      } else {
        e = ev("decision.withdrawn", target.id, { decision: target.id, answer: named.id, reason: "conflicts",
          knownAnswers: target.answers.filter((x) => x.verified && !x.sourceAnswer).map((x) => x.id), relay: relay.id }, AGENT, seen());
      }
    }
    if (!e) continue;
    offered++;
    const tip = [...accepted, e];
    if ((decisionsDoor(tip, e) as { refused: { id: string }[] }).refused.some((x) => x.id === e!.id)) continue;
    accepted.push(e);
  }
  return { accepted, offered };
}

test("C16: a door-accepted append never changes the verdict on an earlier decisions event", () => {
  let landed = 0;
  const kinds = new Map<string, number>();
  for (let seed = 1; seed <= 300; seed++) {
    const { accepted } = history(seed, 30);
    landed += accepted.length;
    for (const e of accepted) {
      const k = e.kind === "decision.withdrawn" ? `${e.kind}${(e.data as { relay?: string }).relay ? " (relayed)" : ""}` : e.kind;
      kinds.set(k, (kinds.get(k) ?? 0) + 1);
    }
    // The fold, not the judge: an earlier event refused over the whole log is a changed verdict
    // even where `validWhenWritten` keeps the read from locking on it.
    const refused = foldDecisionsReport(accepted).refused.filter((x) => x.cls !== "newer");
    assert.deepEqual(refused.map((x) => `${x.id} ${x.kind}: ${x.why}`), [], `seed ${seed}`);
    assert.doesNotThrow(() => foldJudged(accepted, foldDecisionsReport, kindsFor("decisions/u")), `seed ${seed}`);
  }
  assert.ok(landed > 300 * 5, `the generator reaches past the first few events (${landed})`);
  // It must reach the arms it exists for, or it passes by never going there.
  for (const k of ["decision.answer.recorded", "decision.withdrawn", "decision.withdrawn (relayed)"])
    assert.ok((kinds.get(k) ?? 0) >= 20, `${k} landed ${kinds.get(k) ?? 0} times: ${JSON.stringify([...kinds])}`);
});
