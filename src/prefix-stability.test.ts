/**
 * Review C16 (owner: "Validations are for the database at the time the item was created not the
 * future"): appending an event the door accepts must never change the verdict on an event before
 * it. Random histories, each event offered to the door at the tip and kept only if accepted; after
 * every append the whole log is folded, and no earlier event may be refused.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { canonicalMaps, comparisonBriefText, comparisonRequestFor, confirmPayload, CONFIRM_NO, CONFIRM_YES, decisionHash, decisionsDoor,
  foldDecisions, intentCandidates, KEEP_IT, named, resolutionShownHash, rulerOf, WITHDRAW_IT, withdrawalQuestion, type Mapping } from "./shared-decisions.js";
import { canonical } from "./transcript.js";
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

// --- confirmations, revisions and comparisons -------------------------------------------------
//
// The arms where a later valid event could plausibly reach back: `rulerOf` (a confirm pick makes
// its confirmer the ruler of the words, and a later pick or a withdrawn pick moves it — the K5
// fixpoint in `foldDecisionsWithRefusals`), the withdrawal rules that key on it, a revision's
// validity, and the comparison request / judgment / resolution checks in `foldComparisons`.

const CAROL_ACTOR: Actor = { principal: "carol@x.com" };
const F1_ISSUE = { kind: "finding" as const, universe: "u", scope: "findings/u/pr1", review: "pr1", id: "F1" };
const EMPTY_EXECUTIONS = createHash("sha256").update(JSON.stringify([])).digest("hex");

/** A log built one door-checked append at a time, which remembers the first C16 breach. */
class World {
  accepted: LogEvent[] = [];
  n = 0; k = 0;
  lastWhy = "";
  /** The first append after which an EARLIER event was refused, and what it refused. */
  breach?: { appended: string; refused: string[] };
  readonly base = Date.parse("2026-09-25T00:00:00Z");

  tip = (): string[] => (this.accepted.length ? [this.accepted.at(-1)!.id] : []);
  s = () => foldDecisionsReport(this.accepted).value;
  find = (id: string) => this.s().decisions.find((d) => d.id === id)!;
  answerOf = (id: string) => this.s().decisions.flatMap((d) => d.answers).find((a) => a.id === id && !a.sourceAnswer)!;
  decisionOfAnswer = (id: string) => this.s().decisions.find((d) => d.answers.some((a) => a.id === id && !a.sourceAnswer))!.id;

  ev(kind: string, subject: string, data: Record<string, unknown>, actor: Actor, after = this.tip()): LogEvent {
    const n = ++this.n;
    return { id: `e${String(n).padStart(4, "0")}`, kind, subject, data, actor, after,
      at: new Date(this.base + n * 1000).toISOString(),
      writer: actor.via ? "w_agent" : `w_${actor.principal[0]}`, writerPrev: "GENESIS", sidecarProtocol: 2, eventSchema: 1,
      seq: this.accepted.length + 1 } as LogEvent;
  }

  /** Offered at the tip, kept only if the door accepts it — exactly the generator above. */
  offer(e: LogEvent): boolean {
    const verdict = decisionsDoor([...this.accepted, e], e) as { refused: { id: string; why: string }[] };
    const own = verdict.refused.find((x) => x.id === e.id);
    if (own) { this.lastWhy = own.why; return false; }
    this.accepted.push(e);
    const earlier = foldDecisionsReport(this.accepted).refused.filter((x) => x.cls !== "newer" && x.id !== e.id);
    if (earlier.length && !this.breach) {
      const on = this.s().decisions.find((d) => d.id === (e.data as { decision?: string }).decision);
      const what = e.kind === "decision.answer.recorded" && on?.confirms ? ` (picks "${(e.data as { via: { option?: string } }).via.option}" on confirm ${on.id})` : "";
      this.breach = { appended: `${e.id} ${e.kind}${what} by ${e.actor.principal}`, refused: earlier.map((x) => `${x.id} ${x.kind}: ${x.why}`) };
    }
    return true;
  }
  must(e: LogEvent): LogEvent {
    assert.ok(this.offer(e), `the door refused ${e.id} ${e.kind}: ${this.lastWhy}`);
    return e;
  }

  // --- builders: each returns the event, unoffered ----------------------------------------
  round(refs: string[], after?: string[]): LogEvent {
    const label = `R${++this.k}`;
    const decisions = refs.map((ref) => ({ id: `${ref.toLowerCase()}_${this.k}`, round: label, ref, kind: "options",
      payload: { question: `${ref}: settle F1?`, options: [{ label: "Settle" }, { label: "Keep open" }] },
      options: [{ label: "Settle", effects: [{ findings: ["F1"], on: "settle", as: "refuted" }] }, { label: "Keep open", effects: [] }] }));
    return this.ev("decision.round.posted", label, { publication: 2, round: { id: label, source: "test", universe: "u" }, decisions }, AGENT, after);
  }
  option(d: string, who: Actor, label: string, after?: string[]): LogEvent {
    const x = this.find(d);
    return this.ev("decision.answer.recorded", x.id, { decision: x.id, hash: decisionHash(x), via: { kind: "direct", option: label } }, who, after);
  }
  words(d: string, who: Actor, text: string, after?: string[]): LogEvent {
    const x = this.find(d);
    return this.ev("decision.answer.recorded", x.id, { decision: x.id, hash: decisionHash(x), via: { kind: "direct", words: text } }, who, after);
  }
  /** The confirm `confirm_reading` would post for words `answer`, offering `readings`. */
  confirm(answer: string, readings: Mapping[][], after?: string[]): LogEvent {
    const s = this.s();
    const byId = new Map(s.decisions.map((d) => [d.id, d]));
    const d = s.decisions.find((x) => x.answers.some((a) => a.id === answer && !a.sourceAnswer))!;
    const a = d.answers.find((x) => x.id === answer)!;
    const rs = readings.map(canonicalMaps);
    const ref = `D${100 + ++this.k}`;
    const payload = confirmPayload(byId, d, a, rs, ref);
    const label = s.rounds.find((r) => r.id === d.round)!.label ?? d.round;
    const decision = { id: `c${this.k}`, round: label, ref, kind: "options", payload,
      options: payload.options.map((o) => ({ label: o.label, effects: [] })), confirms: { answer, readings: rs } };
    return this.ev("decision.confirm.posted", decision.id, { publication: 2, round: d.round, decision }, AGENT, after);
  }
  withdraw(d: string, answer: string | undefined, who: Actor, extra: Record<string, unknown> = {}, after?: string[]): LogEvent {
    const x = this.find(d);
    const known = x.answers.filter((a) => a.verified && !a.sourceAnswer).map((a) => a.id);
    return this.ev("decision.withdrawn", x.id, { decision: x.id, ...(answer ? { answer } : {}), reason: "changed my mind", knownAnswers: known, ...extra }, who, after);
  }
  revise(d: string, of: string[], who: Actor, label: string, after?: string[]): LogEvent {
    const x = this.find(d);
    return this.ev("decision.answer.revised", x.id, { decision: x.id, hash: decisionHash(x), via: { kind: "direct", option: label },
      revision: { of, findings: ["F1"] } }, who, after);
  }
  nominate(pair: [string, string], who: Actor, after?: string[]): LogEvent {
    return this.ev("decision.comparison.nominated", [...pair].sort().join("/"), { answers: pair, findings: ["F1"], reason: "overlap" }, who, after);
  }
  request(pair: [string, string], after?: string[]): LogEvent | null {
    const ids = [...pair].sort() as [string, string];
    const request = comparisonRequestFor(this.s(), `cmp${++this.k}`, ids, [F1_ISSUE]);
    return request ? this.ev("decision.comparison.requested", request.id, { request }, AGENT, after) : null;
  }
  judge(requestId: string, verdict: "equivalent" | "incompatible" | "unclear", after?: string[]): LogEvent {
    const c = this.s().comparisons.find((x) => x.request.id === requestId)!;
    const r = c.request, k = ++this.k;
    // Never a source's principal, or the judgment is not independent.
    const reader = { principal: "reader@x.com", agent: `reader${k}`, session: `rs${k}`, request: `launch${k}`, receipt: `rcpt${k}` };
    const judgment = { requestId, contextHash: r.contextHash, issues: r.issues,
      answerVersions: [`${r.left.answerId}\0${r.left.version}`, `${r.right.answerId}\0${r.right.version}`], verdict, rationale: "read both", reader };
    const proof = { purpose: "pair-comparison", requestId, contextHash: r.contextHash, brief: comparisonBriefText(r),
      receipt: reader.receipt, agent: reader.agent, session: reader.session, launch: reader.request, toolUseId: reader.request, call: `call${k}`, result: "held" };
    return this.ev("decision.comparison.judged", requestId, { judgment, proof }, AGENT, after);
  }
  /** A person's web resolution, shown the comparison as folded now; `revises` corrects their own. */
  resolve(requestId: string, preserve: string, who: Actor, revises?: { id: string; preserve: string; human: { receipt: string } }, after?: string[]): LogEvent {
    const c = this.s().comparisons.find((x) => x.request.id === requestId)!;
    const r = c.request, k = ++this.k;
    const shown = { request: r, judgments: c.projection.acceptedJudgments, resolutions: c.projection.acceptedResolutions, executions: [] };
    const shownHash = resolutionShownHash(shown);
    const resolution = { requestId, contextHash: r.contextHash, issues: r.issues,
      answerVersions: [`${r.left.answerId}\0${r.left.version}`, `${r.right.answerId}\0${r.right.version}`], preserve,
      ...(revises ? { revises: revises.id, shownResolution: { id: revises.id, preserve: revises.preserve, receipt: revises.human.receipt } } : {}),
      rationale: "this one", human: { principal: who.principal, session: "web", request: requestId, receipt: `hr${k}`, shownHash } };
    const proof = { purpose: "human-comparison", source: "web", principal: who.principal, contextHash: r.contextHash, shownHash,
      receipt: `hr${k}`, session: "web", shown, executionsHash: EMPTY_EXECUTIONS };
    return this.ev("decision.comparison.resolved", requestId, { resolution, proof }, who, after);
  }
}

const decisionOf = (e: LogEvent) => `${e.id}:${(e.data as { decisions: { id: string }[] }).decisions[0]!.id}`;

/** Random histories over confirms, picks, revisions, withdrawals and the comparison lifecycle. */
function confirmHistory(seed: number, length: number): { w: World; kinds: Map<string, number> } {
  const r = rng(seed);
  const w = new World();
  const kinds = new Map<string, number>();
  const people: Actor[] = [...PEOPLE, CAROL_ACTOR];
  /** Usually the tip; sometimes a stale prefix, so the read rules get exercised too. */
  const seen = (): string[] => {
    if (!w.accepted.length || r.next() < 0.8) return w.tip();
    const upTo = Math.floor(r.next() * w.accepted.length);
    return upTo ? [w.accepted[upTo - 1]!.id] : [];
  };
  const count = (e: LogEvent) => {
    const data = e.data as { decision?: string; via?: { words?: string } };
    const onConfirm = e.kind === "decision.answer.recorded" && w.find(data.decision!)?.confirms;
    const words = e.kind === "decision.answer.recorded" && data.via?.words !== undefined;
    const k = onConfirm ? "pick on a confirm" : words ? "words" : e.kind;
    kinds.set(k, (kinds.get(k) ?? 0) + 1);
  };
  // Keeps going after a breach: `breach` holds the first, and the rest still reach the arms.
  for (let i = 0; i < length; i++) {
    const s = w.s();
    const plain = s.decisions.filter((d) => !d.confirms && !d.withdrawn && d.payload.question.includes("settle F1"));
    const confirms = s.decisions.filter((d) => d.confirms && !d.confirms.invalid);
    const sources = s.decisions.flatMap((d) => d.answers.filter((a) => a.verified && !a.sourceAnswer).map((a) => ({ d, a })));
    // Once a comparison exists, lean on judging and resolving it before its sources churn.
    const move = s.comparisons.length && r.next() < 0.3 ? 0.86 + r.next() * 0.14 : r.next();
    let e: LogEvent | null = null;
    if (plain.length < 2 || move < 0.06) {
      e = w.round(r.next() < 0.5 ? ["D1"] : ["D1", "D2"], seen());
    } else if (move < 0.2) {
      e = w.option(r.pick(plain).id, r.pick(people), r.pick(["Settle", "Keep open"]), seen());
    } else if (move < 0.3) {
      e = w.words(r.pick(plain).id, r.pick(people), r.pick(["close it", "leave it", "hmm"]), seen());
    } else if (move < 0.4) {
      // A confirm of free words: one reading, or two, onto questions of their round.
      const free = sources.filter(({ d, a }) => !d.confirms && a.free && !a.cancelled);
      if (!free.length) continue;
      const { d, a } = r.pick(free);
      const onto = s.decisions.filter((t) => t.round === d.round && !t.confirms && Date.parse(t.postedAt) < Date.parse(a.givenAt));
      const reading = (): Mapping[] => [{ decision: r.pick(onto).id, option: r.pick(["Settle", "Keep open"]) }];
      const one = reading(), two = reading();
      e = w.confirm(a.id, r.next() < 0.7 || canonical(one) === canonical(two) ? [one] : [one, two], seen());
    } else if (move < 0.58) {
      if (!confirms.length) continue;
      const c = r.pick(confirms);
      e = w.option(c.id, r.pick(people), r.pick(c.options.map((o) => o.label)), seen());
    } else if (move < 0.7) {
      // A person withdraws a ruling — usually their own, by `rulerOf` — on a question or a confirm.
      const open = sources.filter(({ d }) => !d.withdrawn);
      if (!open.length) continue;
      const { d, a } = r.pick(open);
      const ruler = people.find((p) => p.principal === rulerOf(a).principal)!;
      e = w.withdraw(d.id, a.id, r.next() < 0.85 ? ruler : r.pick(people), {}, seen());
    } else if (move < 0.78) {
      const direct = sources.filter(({ d, a }) => !d.confirms && a.via === "direct");
      if (!direct.length) continue;
      const { d, a } = r.pick(direct);
      e = w.revise(d.id, [a.id], r.pick(people), r.pick(["Settle", "Keep open"]), seen());
    } else if (move < 0.81) {
      const onF1 = sources.filter(({ d }) => !d.confirms && named(d).includes("F1"));
      if (onF1.length < 2) continue;
      const x = r.pick(onF1), y = r.pick(onF1);
      e = w.nominate([x.a.id, y.a.id], r.pick(people), seen());
    } else if (move < 0.86) {
      const candidates = intentCandidates(s);
      if (!candidates.length) continue;
      e = w.request(r.pick(candidates).answers, seen());
    } else if (move < 0.93) {
      const open = s.comparisons.filter((c) => c.projection.state !== "resolved");
      if (!open.length) continue;
      e = w.judge(r.pick(open).request.id, r.next() < 0.75 ? "incompatible" : r.pick(["equivalent", "unclear"] as const), seen());
    } else {
      const ripe = s.comparisons.filter((c) => ["incompatible", "disputed", "resolved"].includes(c.projection.state));
      if (!ripe.length) continue;
      const c = r.pick(ripe);
      const who = r.pick(people);
      const own = c.projection.acceptedResolutions.filter((h) => h.human.principal === who.principal).at(-1);
      e = w.resolve(c.request.id, r.pick([c.request.left.answerId, c.request.right.answerId]), who,
        own && r.next() < 0.5 ? own : undefined, seen());
    }
    if (e && w.offer(e)) count(e);
  }
  return { w, kinds };
}

test("C16: confirms, picks, revisions and comparisons never change the verdict on an earlier event", () => {
  const kinds = new Map<string, number>();
  const breaches: string[] = [];
  let landed = 0;
  for (let seed = 1; seed <= 300; seed++) {
    const { w, kinds: k } = confirmHistory(seed, 40);
    landed += w.accepted.length;
    for (const [kind, n] of k) kinds.set(kind, (kinds.get(kind) ?? 0) + n);
    if (w.breach) breaches.push(`seed ${seed}: after ${w.breach.appended}: ${w.breach.refused.join(" | ")}`);
  }
  assert.ok(landed > 300 * 10, `the generator reaches past the first few events (${landed})`);
  for (const k of ["decision.confirm.posted", "pick on a confirm", "words", "decision.answer.revised", "decision.withdrawn",
    "decision.comparison.nominated", "decision.comparison.requested", "decision.comparison.judged", "decision.comparison.resolved"])
    assert.ok((kinds.get(k) ?? 0) >= 20, `${k} landed ${kinds.get(k) ?? 0} times: ${JSON.stringify([...kinds])}`);
  assert.deepEqual(breaches.slice(0, 10), [], `${breaches.length} seeds breached C16`);
});

// --- named cases: each drives one arm through a door-accepted append -----------------------

/** A round with D1, bob's answer and alice's free words on it, and a confirm reading the words as `reading`. */
function wordsAndConfirm(w: World, reading = "Settle", bobSays = "Settle") {
  const d1 = decisionOf(w.must(w.round(["D1"])));
  const bobs = w.must(w.option(d1, PEOPLE[1]!, bobSays));
  const words = w.must(w.words(d1, PEOPLE[0]!, "close it I guess"));
  const confirm = w.must(w.confirm(words.id, [[{ decision: d1, option: reading }]]));
  return { d1, bobs: bobs.id, words: words.id, confirm: confirm.id };
}

const noBreach = (w: World) => assert.equal(w.breach, undefined,
  `C16: after ${w.breach?.appended}, an earlier event was refused: ${w.breach?.refused.join(" | ")}`);

test("C16 named, direct withdrawal (`only the person who gave a ruling`): a later confirm pick that disputes the reading", () => {
  const w = new World();
  const { d1, words, confirm } = wordsAndConfirm(w);
  w.must(w.option(confirm, PEOPLE[1]!, CONFIRM_YES));                  // bob confirms: bob rules through the words
  assert.equal(rulerOf(w.answerOf(words)).principal, "bob@x.com");
  w.must(w.withdraw(d1, words, PEOPLE[1]!));
  w.must(w.option(confirm, PEOPLE[0]!, CONFIRM_NO));                   // alice disputes it
  noBreach(w);
});

test("C16 named, relayed withdrawal (the relay arm): a later confirm pick that disputes the reading", () => {
  const w = new World();
  const { d1, words, confirm } = wordsAndConfirm(w);
  w.must(w.option(confirm, PEOPLE[1]!, CONFIRM_YES));
  const q = withdrawalQuestion(w.find(d1), w.answerOf(words), "conflicts", "D2");
  const relay = decisionOf(w.must(w.ev("decision.round.posted", "RW", { publication: 2, round: { id: "RW", source: "test", universe: "u" },
    decisions: [{ id: "w1", round: "RW", ref: "D2", kind: "options", payload: q, options: q.options.map((o) => ({ label: o.label, effects: [] })) }] }, AGENT)));
  w.must(w.option(relay, PEOPLE[1]!, WITHDRAW_IT));
  w.must(w.withdraw(d1, words, AGENT, { reason: "conflicts", relay }));
  w.must(w.option(confirm, PEOPLE[0]!, CONFIRM_NO));
  noBreach(w);
});

test("C16 named, K5 fixpoint (a withdrawn side of a dispute releases it): the release moves the ruler of an earlier withdrawal", () => {
  const w = new World();
  const { d1, words, confirm } = wordsAndConfirm(w);
  w.must(w.option(confirm, PEOPLE[1]!, CONFIRM_YES));
  const no = w.must(w.option(confirm, PEOPLE[0]!, CONFIRM_NO));       // disputed: alice rules her own words
  assert.equal(rulerOf(w.answerOf(words)).principal, "alice@x.com");
  w.must(w.withdraw(d1, words, PEOPLE[0]!));
  w.must(w.withdraw(confirm, no.id, PEOPLE[0]!));                      // her side withdrawn: bob's Yes binds
  noBreach(w);
});

test("C16 named, K5 fixpoint (a withdrawn Yes returns the words to unconfirmed): the confirmer's earlier withdrawal of the words", () => {
  const w = new World();
  const { d1, words, confirm } = wordsAndConfirm(w);
  const yes = w.must(w.option(confirm, PEOPLE[1]!, CONFIRM_YES));
  w.must(w.withdraw(d1, words, PEOPLE[1]!));                           // bob, ruling through the words, withdraws them
  w.must(w.withdraw(confirm, yes.id, PEOPLE[1]!));                     // then his Yes
  noBreach(w);
});

test("C16 named, withdrawal rules (`an answer arrived after you read`, O2 re-answer): later answers on a withdrawn question", () => {
  const w = new World();
  const d1 = decisionOf(w.must(w.round(["D1"])));
  const a = w.must(w.option(d1, PEOPLE[0]!, "Settle"));
  w.must(w.option(d1, PEOPLE[1]!, "Keep open"));
  assert.equal(w.offer(w.withdraw(d1, a.id, PEOPLE[0]!, {}, [a.id])), false, "a withdrawal that missed bob's answer is refused at the door");
  w.must(w.withdraw(d1, a.id, PEOPLE[0]!));
  w.must(w.option(d1, PEOPLE[1]!, "Settle"));                          // bob stood through it: he may re-answer
  w.must(w.option(d1, PEOPLE[0]!, "Keep open"));                       // alice's is cancelled, not refused
  w.must(w.withdraw(d1, a.id, PEOPLE[0]!, {}, [a.id]));                // the same withdrawal again: settled, a no-op
  noBreach(w);
});

test("C16 named, answer.revised: the revised answer is confirmed and withdrawn after the revision", () => {
  const w = new World();
  const { d1, words, confirm } = wordsAndConfirm(w);
  const alice = w.must(w.option(d1, PEOPLE[0]!, "Settle"));
  w.must(w.revise(d1, [alice.id], PEOPLE[1]!, "Keep open"));           // bob revises alice's ruling
  w.must(w.revise(d1, [words], PEOPLE[0]!, "Settle"));                 // alice revises her own words
  w.must(w.option(confirm, PEOPLE[1]!, CONFIRM_YES));
  w.must(w.withdraw(d1, alice.id, PEOPLE[0]!));
  noBreach(w);
});

test("C16 named, nomination (`two different people's own verified answers`): a later confirm makes bob the ruler of alice's words", () => {
  const w = new World();
  const { bobs, words, confirm } = wordsAndConfirm(w);
  w.must(w.nominate([words, bobs], PEOPLE[0]!));
  w.must(w.option(confirm, PEOPLE[1]!, CONFIRM_YES));
  noBreach(w);
});

test("C16 named, comparison requested (`comparisonSource` freezes `rulerOf`): a later confirm by the other side", () => {
  const w = new World();
  const { bobs, words, confirm } = wordsAndConfirm(w, "Keep open");
  const req = w.request([words, bobs]);
  assert.ok(req, "the free words and bob's answer are a comparison candidate");
  w.must(req!);
  w.must(w.option(confirm, PEOPLE[1]!, CONFIRM_YES));
  noBreach(w);
});

/** A round with alice's and bob's opposite answers on D1, and a comparison requested of them. */
function requested(w: World) {
  const d1 = decisionOf(w.must(w.round(["D1"])));
  const alice = w.must(w.option(d1, PEOPLE[0]!, "Settle"));
  const bob = w.must(w.option(d1, PEOPLE[1]!, "Keep open"));
  const req = w.request([alice.id, bob.id]);
  assert.ok(req, "alice's and bob's answers are a comparison candidate");
  w.must(req!);
  return { d1, alice: alice.id, bob: bob.id, req: req!.subject };
}

test("C16 named, comparison judged: a later revision stales the sources the judgment was made on", () => {
  const w = new World();
  const { d1, alice, req } = requested(w);
  w.must(w.judge(req, "incompatible"));
  w.must(w.revise(d1, [alice], PEOPLE[0]!, "Keep open"));
  assert.equal(w.offer(w.resolve(req, alice, CAROL_ACTOR)), false, "the stale comparison takes no resolution");
  noBreach(w);
});

test("C16 named, comparison resolved: a correction, a disagreeing resolution, and a judgment no resolution saw", () => {
  const w = new World();
  const { alice, bob, req } = requested(w);
  w.must(w.judge(req, "incompatible"));
  const first = w.must(w.resolve(req, alice, CAROL_ACTOR));
  const h1 = w.s().comparisons[0]!.projection.acceptedResolutions.find((h) => h.id === first.id)!;
  w.must(w.resolve(req, bob, CAROL_ACTOR, h1));                       // carol corrects her own
  w.must(w.resolve(req, alice, PEOPLE[1]!));                           // bob disagrees: disputed
  assert.equal(w.s().comparisons[0]!.projection.state, "disputed");
  w.must(w.judge(req, "equivalent"));                                  // a judgment no resolution saw
  noBreach(w);
});

test("C16 named, comparison resolved: the source answer is withdrawn after the resolution", () => {
  const w = new World();
  const { d1, alice, req } = requested(w);
  w.must(w.judge(req, "incompatible"));
  w.must(w.resolve(req, alice, CAROL_ACTOR));
  w.must(w.withdraw(d1, alice, PEOPLE[0]!));
  noBreach(w);
});
