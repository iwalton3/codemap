/**
 * The decision ops, end to end, through the verbs a caller reaches — the oracle the fold tests
 * cannot be: a real sidecar, real findings in the canonical table, and a transcript fixture in
 * the shape measured on 2026-09-23. The fold being right is `shared-decisions.test.ts`; this is
 * whether anything reaches it, and whether what the person sees afterwards is true.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { indexBlob } from "./repo.js";
import { writeStore, readFinding, writeLocalFinding } from "./store.js";
import { db as openDb } from "./db.js";
import type { State } from "./schema.js";
import { shareFinding, corroborateFinding, closeFinding, bindDecisions, reassignFinding, sharedFindings, closeFindingOnDecision } from "./ops-shared.js";
import { reviewQueue } from "./ops/annotations.js";
import { postRound, postPrevalidated, logQuestion, relayAnswer, answerDirect, decisionRounds, decisionRound, recordReading } from "./ops/decisions.js";
import { discard } from "./test-tmp.js";
import { decisionScope, logQuestionEvent, recordAnswerEvent, recordReadingEvent } from "./shared-decisions.js";

const state: State = { schemaVersion: 1, lastVerifiedCommit: null, branch: null } as State;
const SRC = "export function creditLine(cents) {\n  return cents * 2;\n}\n";

const withEnv = async (vars: Record<string, string | undefined>, fn: () => Promise<void>) => {
  const saved: Record<string, string | undefined> = {};
  for (const k of Object.keys(vars)) { saved[k] = process.env[k]; if (vars[k] === undefined) delete process.env[k]; else process.env[k] = vars[k]!; }
  try { await fn(); } finally { for (const k of Object.keys(saved)) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]!; } }
};
const asAgent = (fn: () => Promise<void>) => withEnv({ CODEMAP_AGENT_MODEL: "claude-opus-5" }, fn);
const asPerson = (fn: () => Promise<void>) => withEnv({ CODEMAP_AGENT_MODEL: undefined }, fn);
const err = (r: unknown): string | undefined => (r as { error?: string })?.error;

async function universe() {
  const root = mkdtempSync(join(tmpdir(), "codemap-decisions-"));
  const git = (...a: string[]) => spawnSync("git", a, { cwd: root });
  git("init", "-q", "-b", "main");
  git("config", "user.email", "alice@x.com");
  git("config", "user.name", "alice");
  mkdirSync(join(root, ".codemap"), { recursive: true });
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(join(root, "src/credit.js"), SRC, "utf8");
  const anchors = await indexBlob(SRC, "src/credit.js");
  await writeStore(root, anchors, state);
  const side = mkdtempSync(join(tmpdir(), "codemap-decisions-side-"));
  writeFileSync(join(root, ".codemap", "sidecar"), side, "utf8");
  const transcripts = mkdtempSync(join(tmpdir(), "codemap-decisions-tx-"));
  return { root, side, transcripts, anchor: anchors[0]!.id, cleanup: () => { discard(root); discard(side); discard(transcripts); } };
}

const SESSION = "5e55a0a0-0000-0000-0000-000000000001";
/** What the person is shown names its ref and the finding it acts on (H5). */
const payloadFor = (f: string, ref = "D1") => ({ question: `${ref}: is ${f} a real defect?`, header: "F", options: [{ label: "Not a defect", description: "close as refuted" }, { label: "Real, fix it", description: "fix work" }] });
const decision = (id: string, f: string, extra: Record<string, unknown> = {}, ref = "D1") => ({
  id, round: "R1", ref, kind: "options" as const, payload: payloadFor(f, ref),
  options: [{ label: "Not a defect", effects: [{ findings: [f], on: "settle" as const, as: "refuted" as const }], ...extra }, { label: "Real, fix it", effects: [{ findings: [f], on: "unblock" as const }] }],
});
/** A second after now: the person answers after the round was posted. */
const soon = () => new Date(Date.now() + 1000).toISOString();
/** The transcript of a session that asked `questions` and got `answer` to the first, and
 *  where the person then typed "D1 B" (m1) and "D2 A" (m2). */
function asked(dir: string, answer: string, toolUseId = "toolu_1", questions: object[] = [], when = soon()) {
  const first = questions[0] as { question: string };
  const lines = [
    { type: "assistant", uuid: "a1", isSidechain: false, timestamp: when, message: { content: [{ type: "tool_use", id: toolUseId, name: "AskUserQuestion", input: { questions } }] } },
    { type: "user", uuid: "r1", isSidechain: false, timestamp: when, sourceToolAssistantUUID: "a1", message: { content: [{ type: "tool_result", tool_use_id: toolUseId, content: "…" }] }, toolUseResult: { questions, answers: { [first.question]: answer } } },
    { type: "user", uuid: "m1", isSidechain: false, timestamp: when, origin: { kind: "human" }, message: { role: "user", content: "D1 B" } },
    { type: "user", uuid: "m2", isSidechain: false, timestamp: when, origin: { kind: "human" }, message: { role: "user", content: "D2 A" } },
  ];
  writeFileSync(join(dir, `${SESSION}.jsonl`), lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
}

const READER = "a0000000000000b01";
/** A reader subagent, in the shape measured 2026-09-23: its own sidechain transcript and meta
 *  file under the parent session, and the launch in the parent's transcript. Call after `asked`,
 *  which rewrites the parent. */
function readerAgent(dir: string, said: string, agentId = READER, parent = SESSION) {
  const sub = join(dir, parent, "subagents");
  mkdirSync(sub, { recursive: true });
  const call = `toolu_${agentId}`;
  writeFileSync(join(sub, `agent-${agentId}.meta.json`), JSON.stringify({ agentType: "general-purpose", toolUseId: call }));
  writeFileSync(join(sub, `agent-${agentId}.jsonl`), [
    { type: "user", uuid: "s1", isSidechain: true, agentId, sessionId: parent, message: { role: "user", content: "read this" } },
    { type: "assistant", uuid: "s2", isSidechain: true, agentId, sessionId: parent, message: { content: [{ type: "text", text: said }] } },
  ].map((l) => JSON.stringify(l)).join("\n") + "\n");
  const launch = [
    { type: "assistant", uuid: `l-${agentId}`, isSidechain: false, message: { content: [{ type: "tool_use", id: call, name: "Agent", input: {} }] } },
    { type: "user", uuid: `lr-${agentId}`, isSidechain: false, message: { content: [{ type: "tool_result", tool_use_id: call, content: "launched" }] }, toolUseResult: { isAsync: true, status: "async_launched", agentId } },
  ];
  writeFileSync(join(dir, `${parent}.jsonl`), readFileSync(join(dir, `${parent}.jsonl`), "utf8") + launch.map((l) => JSON.stringify(l)).join("\n") + "\n");
}

async function withFinding(u: Awaited<ReturnType<typeof universe>>) {
  let id = "";
  await asAgent(async () => {
    const f = await shareFinding(u.root, 7, { targetKind: "anchor", targetId: u.anchor, text: "creditLine doubles" }) as { id?: string };
    id = f.id!;
  });
  return id;
}

test("a decision op never creates the sidecar it needs", async () => {
  const u = await universe();
  try {
    await asPerson(async () => {
      assert.match(String(err(bindDecisions(u.root))), /has not been set up/);
      assert.match(String(err(await postRound(u.root, { round: { id: "R1", source: "x" }, decisions: [decision("d1", "f_none")] }))), /has not been set up/);
    });
    await withFinding(u);   // filing a finding sets the sidecar up
    await asPerson(async () => assert.equal(err(bindDecisions(u.root)), undefined));
  } finally { u.cleanup(); }
});

test("posting refuses a finding this store does not hold, and accepts one it does", async () => {
  const u = await universe();
  try {
    const f = await withFinding(u);
    await asAgent(async () => {
      assert.match(String(err(await postRound(u.root, { round: { id: "R1", source: "x" }, decisions: [decision("d1", "f_unrecorded")] }))), /not a finding this store holds/);
      assert.match(String(err(await postRound(u.root, { round: { id: "R1", source: "x", prevalidated: { record: "r", sortedBy: "s" } } as any, decisions: [decision("d1", f)] }))), /only import_round/);
      assert.match(String(err(await postRound(u.root, { round: { id: "R1", source: "x" }, decisions: [decision("d1", f, { closesOnAnswer: true })] }))), /only a pre-validated round/);
      const ok = await postRound(u.root, { round: { id: "R1", source: "x" }, decisions: [decision("d1", f)] }) as any;
      assert.equal(ok.ok, true, JSON.stringify(ok));
      assert.deepEqual(ok.ask[0].payload.question, payloadFor(f).question);
      assert.match(String(err(await postRound(u.root, { round: { id: "R1", source: "x" }, decisions: [decision("d2", f)] }))), /already posted/);
    });
  } finally { u.cleanup(); }
});

test("a logged answer is a ruling: the finding is held for the verifier and listed as not carried out", async () => {
  const u = await universe();
  try {
    const f = await withFinding(u);
    await asAgent(async () => {
      await postRound(u.root, { round: { id: "R1", source: "x" }, decisions: [decision("d1", f)] });
      let view = await decisionRounds(u.root) as any;
      assert.ok(view.waitingOnYou.some((w: any) => w.decision === "d1"), "unanswered, it waits on you");

      asked(u.transcripts, "Not a defect", "toolu_1", [payloadFor(f)]);
      assert.match(String(err(await logQuestion(u.root, { toolUseId: "toolu_1" } as any, {}, u.transcripts))), /needs the round/);
      // No session given: the agent knows what it asked, and codemap finds whose transcript holds it.
      const r = await logQuestion(u.root, { toolUseId: "toolu_1", round: "R1" }, {}, u.transcripts) as any;
      assert.equal(r.ok, true, JSON.stringify(r));
      assert.equal(r.answered[0].verified, true);
      assert.deepEqual(r.answered[0].closed, [], "an ordinary round's ruling closes nothing itself");
      assert.equal((await readFinding(u.root, f))?.state, "issued", "the finding is untouched");

      view = await decisionRounds(u.root) as any;
      assert.ok(!view.waitingOnYou.some((w: any) => w.decision === "d1"));
      assert.ok(view.ruledNotCarriedOut.some((x: any) => x.finding === f && x.on === "settle" && x.ruler === "alice@x.com"));
      const round = await decisionRound(u.root, "R1") as any;
      assert.ok(round.held.some((h: any) => h.finding === f && h.holds.some((x: any) => x.why === "ruled")));

      // A retry is safe: it records nothing new (H6.1).
      const again = await logQuestion(u.root, { session: SESSION, toolUseId: "toolu_1", round: "R1" }, {}, u.transcripts) as any;
      assert.equal(again.retried, true, JSON.stringify(again));
      assert.equal(again.answered[0].recorded, false);
      assert.equal((await decisionRound(u.root, "R1") as any).decisions[0].answers.length, 1);
    });
    // Once the finding closes — by whoever — it is no longer "not carried out".
    await asPerson(async () => { await closeFinding(u.root, 7, f, "refuted", "done by hand"); });
    await asAgent(async () => {
      const view = await decisionRounds(u.root) as any;
      assert.ok(!view.ruledNotCarriedOut.some((x: any) => x.finding === f));
    });
  } finally { u.cleanup(); }
});

test("P1.e (H6.1): a call that crashed after it was logged records its answers on the retry", async () => {
  const u = await universe();
  try {
    const f = await withFinding(u);
    await asAgent(async () => {
      await postRound(u.root, { round: { id: "R1", source: "x" }, decisions: [decision("d1", f)] });
      const when = soon();
      asked(u.transcripts, "Not a defect", "toolu_1", [payloadFor(f)], when);
      const b = bindDecisions(u.root) as any;
      // The crash: the call is in the log, and no answer followed it.
      await logQuestionEvent(b.cfg.path, b.cfg.universe, b.actor, { session: SESSION, toolUseId: "toolu_1", questions: [payloadFor(f)], answers: { [payloadFor(f).question]: "Not a defect" }, transcript: SESSION, round: "R1", answeredAt: when });
      assert.equal((await decisionRound(u.root, "R1") as any).decisions[0].answers.length, 0, "the check could fail: nothing is answered yet");
      const r = await logQuestion(u.root, { session: SESSION, toolUseId: "toolu_1", round: "R1" }, {}, u.transcripts) as any;
      assert.equal(r.retried, true, JSON.stringify(r));
      assert.equal(r.answered[0].recorded, true);
      assert.ok((await decisionRounds(u.root) as any).ruledNotCarriedOut.some((x: any) => x.finding === f));
    });
  } finally { u.cleanup(); }
});

test("B1.4: a call binds to the round it was asked for, posted before it was answered", async () => {
  const u = await universe();
  try {
    const f = await withFinding(u);
    await asAgent(async () => {
      asked(u.transcripts, "Not a defect", "toolu_1", [payloadFor(f)], new Date(Date.now() - 60_000).toISOString());
      await postRound(u.root, { round: { id: "R1", source: "x" }, decisions: [decision("d1", f)] });
      const early = await logQuestion(u.root, { session: SESSION, toolUseId: "toolu_1", round: "R1" }, {}, u.transcripts) as any;
      assert.match(String(err(early)), /answered at .* posted at .*: an answer binds only to a question posted before it/);
      assert.equal((await decisionRound(u.root, "R1") as any).decisions[0].answers.length, 0);
      assert.match(String(err(await logQuestion(u.root, { session: SESSION, toolUseId: "toolu_1", round: "R9" }, {}, u.transcripts))), /no round R9/);
    });
  } finally { u.cleanup(); }
});

test("an unverifiable call writes nothing", async () => {
  const u = await universe();
  try {
    const f = await withFinding(u);
    await asAgent(async () => {
      await postRound(u.root, { round: { id: "R1", source: "x" }, decisions: [decision("d1", f)] });
      asked(u.transcripts, "Not a defect", "toolu_1", [payloadFor(f)]);
      const r = await logQuestion(u.root, { session: SESSION, toolUseId: "toolu_other", round: "R1" }, {}, u.transcripts) as any;
      assert.equal(r.ok, false);
      assert.ok(r.unverified);
      const round = await decisionRound(u.root, "R1") as any;
      assert.equal(round.decisions[0].answers.length, 0);
    });
  } finally { u.cleanup(); }
});

test("H5: a relayed reply is the whole message, bound by the reader, never parsed; an unconfirmed one only unblocks", async () => {
  const u = await universe();
  try {
    const f = await withFinding(u);
    const g = await withFinding(u);
    await asAgent(async () => {
      await postRound(u.root, { round: { id: "R1", source: "x" }, decisions: [decision("d1", f), decision("d2", g, {}, "D2")] });
      asked(u.transcripts, "Not a defect", "toolu_1", [payloadFor(f)]);
      assert.match(String(err(await relayAnswer(u.root, { round: "R9", decision: "d1", session: SESSION, entryId: "m1" }, {}, u.transcripts))), /not R9/);
      const r = await relayAnswer(u.root, { round: "R1", decision: "d1", session: SESSION, entryId: "m1" }, {}, u.transcripts) as any;
      assert.equal(r.verified, true, JSON.stringify(r));
      assert.equal(r.awaitsReading, true, "\"D1 B\" is words for the reader, not a pick");
      assert.deepEqual(r.ruled, []);
      readerAgent(u.transcripts, "They mean: fix it.");
      const read = await recordReading(u.root, { answer: r.answer, reader: { transcript: READER, reading: "fix it", maps: [{ decision: "d1", option: "Real, fix it" }] }, session: { reading: "fix it", maps: [{ decision: "d1", option: "Real, fix it" }] } }, {}, u.transcripts) as any;
      assert.equal(read.agree, true, JSON.stringify(read));
      const round = await decisionRound(u.root, "R1") as any;
      assert.ok(round.decisions[0].standing.ruled.some((x: any) => x.finding === f && x.on === "unblock"));
      const twice = await relayAnswer(u.root, { round: "R1", decision: "d1", session: SESSION, entryId: "m1" }, {}, u.transcripts) as any;
      assert.equal(twice.recorded, false, "a message answers a decision once");

      const un = await relayAnswer(u.root, { round: "R1", decision: "d2", session: SESSION, entryId: "nope", words: "D2 A", relayedBy: "sess-x" }, {}, u.transcripts) as any;
      assert.equal(un.verified, false);
      const none = await relayAnswer(u.root, { round: "R1", decision: "d2", session: SESSION, entryId: "nope" }, {}, u.transcripts) as any;
      assert.equal(none.ok, false, "no words, nothing written");
    });
  } finally { u.cleanup(); }
});

test("P1.b: a message typed before its round was posted is refused, with both times", async () => {
  const u = await universe();
  try {
    const f = await withFinding(u);
    await asAgent(async () => {
      asked(u.transcripts, "Not a defect", "toolu_1", [payloadFor(f)], new Date(Date.now() - 60_000).toISOString());
      await postRound(u.root, { round: { id: "R1", source: "x" }, decisions: [decision("d1", f)] });
      assert.match(String(err(await relayAnswer(u.root, { round: "R1", decision: "d1", session: SESSION, entryId: "m1" }, {}, u.transcripts))), /typed at .* posted at .*: words bind only to a question posted before them/);
    });
  } finally { u.cleanup(); }
});

test("the page is a person's door, never an agent's", async () => {
  const u = await universe();
  try {
    const f = await withFinding(u);
    await asAgent(async () => {
      await postRound(u.root, { round: { id: "R1", source: "x" }, decisions: [decision("d1", f)] });
      assert.match(String(err(await answerDirect(u.root, { decision: "d1", option: "Not a defect" }))), /not an agent's act/);
    });
    await asPerson(async () => {
      const r = await answerDirect(u.root, { decision: "d1", option: "Real, fix it" }) as any;
      assert.equal(r.recorded, true, JSON.stringify(r));
    });
  } finally { u.cleanup(); }
});

test("P1.c (B2.1): a verified page answer is not displaced by an agent's unconfirmed relay, which waits on you", async () => {
  const u = await universe();
  try {
    const f = await withFinding(u);
    await asAgent(async () => { await postRound(u.root, { round: { id: "R1", source: "x" }, decisions: [decision("d1", f)] }); });
    await asPerson(async () => { await answerDirect(u.root, { decision: "d1", option: "Not a defect" }); });
    await asAgent(async () => {
      const un = await relayAnswer(u.root, { round: "R1", decision: "d1", session: SESSION, entryId: "nope", words: "D1 B, fix it", relayedBy: "sess-x" }, {}, u.transcripts) as any;
      assert.equal(un.outranked, true, JSON.stringify(un));
      const view = await decisionRounds(u.root) as any;
      assert.ok(view.ruledNotCarriedOut.some((x: any) => x.finding === f && x.on === "settle"), "your ruling stands");
      assert.ok(view.waitingOnYou.some((w: any) => w.decision === "d1" && /disagrees with your ruling/.test(w.why)));
    });
  } finally { u.cleanup(); }
});

test("a pre-validated option closes a sorter-confirmed finding on a verified answer, stamped with whose ruling it was", async () => {
  const u = await universe();
  try {
    const f = await withFinding(u);
    const g = await withFinding(u);
    await asAgent(async () => {
      // A sorter's verdict: now only a stamp lets an agent close it (N13).
      await corroborateFinding(u.root, 7, f, "confirm", "sorter A");
      const blocked = await closeFinding(u.root, 7, f, "refuted", "just an agent") as any;
      assert.ok(blocked.asked, "the ratchet holds it — the attempt becomes a pending ask");
      await closeFinding(u.root, 7, g, "refuted", "closed first");

      const b = bindDecisions(u.root);
      assert.ok(!("error" in b));
      const r = await postPrevalidated(u.root, b as any, { round: { id: "R1", source: "triage" }, decisions: [
        decision("d1", f, { closesOnAnswer: true }), decision("d2", g, { closesOnAnswer: true }, "D2"),
      ] }, { record: "rec", sortedBy: "two sorters and an arbitrator" });
      assert.equal((r as any).ok, true, JSON.stringify(r));

      asked(u.transcripts, "Not a defect", "toolu_1", [payloadFor(f)]);
      const lq = await logQuestion(u.root, { session: SESSION, toolUseId: "toolu_1", round: "R1" }, {}, u.transcripts) as any;
      assert.deepEqual(lq.answered[0].closed, [f]);
      const closed = await readFinding(u.root, f);
      assert.equal(closed?.state, "refuted");
      assert.equal(closed?.closed?.decision?.ruler, "alice@x.com");
      assert.equal(closed?.closed?.by.via?.kind, "agent", "the closer is the agent that carried it out");
    });
    // A verified answer on a finding already closed: it stays as its closer left it, and the
    // answer does not report a close it did not make.
    await asPerson(async () => {
      const again = await answerDirect(u.root, { decision: "d2", option: "Not a defect" }) as any;
      assert.equal(again.verified, true, JSON.stringify(again));
      assert.deepEqual(again.closed, []);
      assert.equal((await readFinding(u.root, g))?.closed?.reason, "closed first");
    });
  } finally { u.cleanup(); }
});

test("a reading of free text rules only when it agrees, and is refused from the relayer", async () => {
  const u = await universe();
  try {
    const f = await withFinding(u);
    await asAgent(async () => {
      await postRound(u.root, { round: { id: "R1", source: "x" }, decisions: [decision("d1", f)] });
      asked(u.transcripts, "not a defect, but log why", "toolu_1", [payloadFor(f)]);
      const lq = await logQuestion(u.root, { session: SESSION, toolUseId: "toolu_1", round: "R1" }, {}, u.transcripts) as any;
      assert.equal(lq.answered[0].awaitsReading, true);
      const answer = lq.answered[0].answer;
      const maps = [{ decision: "d1", option: "Not a defect" }];
      readerAgent(u.transcripts, "reading: r");
      const self = await recordReading(u.root, { answer, reader: { transcript: SESSION, reading: "r", maps }, session: { reading: "r", maps } }, {}, u.transcripts) as any;
      assert.equal(self.ok, false, "the session that asked cannot read its own answer");
      // P7 / F4: the relaying session naming someone who never read it.
      const someone = await recordReading(u.root, { answer, reader: { transcript: "someone-else", reading: "r", maps }, session: { reading: "r", maps } }, {}, u.transcripts) as any;
      assert.match(String(someone.unverified), /not a subagent id/);
      const unsaid = await recordReading(u.root, { answer, reader: { transcript: READER, reading: "something it never said", maps }, session: { reading: "r", maps } }, {}, u.transcripts) as any;
      assert.match(String(unsaid.unverified), /never said this reading/);
      const two = await recordReading(u.root, { answer, reader: { transcript: READER, reading: "r", maps }, session: { reading: "r", maps: [{ decision: "d1", option: "Real, fix it" }] } }, {}, u.transcripts) as any;
      assert.equal(two.agree, false);
      const view = await decisionRounds(u.root) as any;
      assert.ok(view.readingsInDispute.some((x: any) => x.decision === "d1"));
      assert.ok(view.waitingOnYou.some((x: any) => x.decision === "d1"));
    });
  } finally { u.cleanup(); }
});

test("Q14: a decisions log that cannot be read is blocked, not 'nothing waits on you', and writes on it refuse", async () => {
  const u = await universe();
  try {
    const f = await withFinding(u);
    await asAgent(async () => {
      await postRound(u.root, { round: { id: "R1", source: "x" }, decisions: [decision("d1", f)] });
      const b = bindDecisions(u.root) as any;
      const dir = join(b.cfg.path, decisionScope(b.cfg.universe));
      const shard = join(dir, readdirSync(dir).find((n) => n.endsWith(".ndjson"))!);
      writeFileSync(shard, `\x00\x01 garbage\n${readFileSync(shard, "utf8")}`);
      const view = await decisionRounds(u.root) as any;
      assert.equal(view.status, "blocked", JSON.stringify(view).slice(0, 300));
      assert.match(String(err(await postRound(u.root, { round: { id: "R2", source: "x" }, decisions: [{ ...decision("d2", f), round: "R2" }] }))), /blocked/);
      asked(u.transcripts, "Not a defect", "toolu_1", [payloadFor(f)]);
      assert.match(String(err(await logQuestion(u.root, { session: SESSION, toolUseId: "toolu_1", round: "R1" }, {}, u.transcripts))), /blocked/);
    });
  } finally { u.cleanup(); }
});

test("P3.c + P3.i (B1.3, H7.13–15): a held finding is not offered as work; the catalogues mark it; a blocked log refuses the queue", async () => {
  const u = await universe();
  try {
    const f = await withFinding(u);
    const g = await withFinding(u);
    await asAgent(async () => {
      await postRound(u.root, { round: { id: "R1", source: "x" }, decisions: [decision("d1", f), decision("d2", g, {}, "D2")] });
      await reassignFinding(u.root, 7, f, { kind: "fix" });
    });
    await asPerson(async () => {
      await answerDirect(u.root, { decision: "d1", option: "Not a defect" });
      await reassignFinding(u.root, 7, g, { kind: "fix" });
    });
    await asAgent(async () => {
      const q = await reviewQueue(u.root) as any;
      assert.ok(!q.queue.some((x: any) => x.id === f), "ruled not a defect: an agent is not handed it as work");
      assert.equal(q.withheld?.count, 1, JSON.stringify(q).slice(0, 400));
      const mine = q.queue.find((x: any) => x.id === g);
      assert.ok(mine, "a person assigned it, which wins (H7.15)");
      assert.deepEqual(mine.held, [{ decision: "d2", why: "undecided" }]);

      const all = await reviewQueue(u.root, { assignedOnly: false }) as any;
      assert.deepEqual(all.queue.find((x: any) => x.id === f)?.held, [{ decision: "d1", why: "ruled" }]);
      const shared = await sharedFindings(u.root, 7) as any;
      assert.deepEqual(shared.findings.find((x: any) => x.id === f)?.held, [{ decision: "d1", why: "ruled" }]);
      const waiting = await sharedFindings(u.root, 7, { queue: true }) as any;
      for (const row of waiting.findings) if (row.id === f) assert.ok(row.held, "the person's queue marks it, never drops it");

      const b = bindDecisions(u.root) as any;
      const dir = join(b.cfg.path, decisionScope(b.cfg.universe));
      const shard = join(dir, readdirSync(dir).find((n) => n.endsWith(".ndjson"))!);
      writeFileSync(shard, `\x00\x01 garbage\n${readFileSync(shard, "utf8")}`);
      const refused = await reviewQueue(u.root) as any;
      assert.match(String(refused.error), /decisions log cannot be read/);
      assert.deepEqual(refused.queue, []);
      assert.equal((await reviewQueue(u.root, { assignedOnly: false }) as any).queue.find((x: any) => x.id === f)?.held, "unknown");
    });
  } finally { u.cleanup(); }
});

test("P2.b–P2.d (B2.3): a close is carried out once per answer, retried until it lands, and only for the decisions touched", async () => {
  const u = await universe();
  try {
    const [f, g, h] = [await withFinding(u), await withFinding(u), await withFinding(u)];
    const both = (id: string, ref: string, a: string, b2: string) => ({
      id, round: "R1", ref, kind: "options" as const,
      payload: { question: `${ref}: are ${a} and ${b2} real?`, header: ref, options: [{ label: "Not defects" }, { label: "Real" }] },
      options: [{ label: "Not defects", effects: [{ findings: [a, b2], on: "settle" as const, as: "refuted" as const }], closesOnAnswer: true }, { label: "Real", effects: [{ findings: [a, b2], on: "unblock" as const }] }],
    });
    const dA = both("dA", "D1", f, g);
    let answerA = "";
    await asAgent(async () => {
      const b = bindDecisions(u.root) as any;
      const r = await postPrevalidated(u.root, b, { round: { id: "R1", source: "triage" }, decisions: [dA, decision("dB", h, {}, "D2")] }, { record: "rec", sortedBy: "two sorters and an arbitrator" });
      assert.equal((r as any).ok, true, JSON.stringify(r));
      const when = soon();
      asked(u.transcripts, "Not defects", "toolu_1", [dA.payload], when);
      // The crash: the call and its answer are in the log, and neither close happened.
      const L = await logQuestionEvent(b.cfg.path, b.cfg.universe, b.actor, { session: SESSION, toolUseId: "toolu_1", questions: [dA.payload], answers: { [dA.payload.question]: "Not defects" }, transcript: SESSION, round: "R1", answeredAt: when });
      const hash = (await decisionRound(u.root, "R1") as any).decisions.find((d: any) => d.id === "dA").hash;
      answerA = (await recordAnswerEvent(b.cfg.path, b.cfg.universe, b.actor, { decision: "dA", hash, via: { kind: "question", question: L.id } })).id;
    });
    await asPerson(async () => { await answerDirect(u.root, { decision: "dB", words: "leave it for now, fix later" }); });
    await asAgent(async () => {
      const dB = (await decisionRound(u.root, "R1") as any).decisions.find((d: any) => d.id === "dB");
      const maps = [{ decision: "dB", option: "Real, fix it" }];
      readerAgent(u.transcripts, "fix");
      const read = await recordReading(u.root, { answer: dB.standing.id, reader: { transcript: READER, reading: "fix", maps }, session: { reading: "fix", maps } }, {}, u.transcripts) as any;
      assert.equal(read.agree, true, JSON.stringify(read));
      assert.equal((await readFinding(u.root, f))?.state, "issued", "P2.d: an unrelated reading carries out nothing on dA");

      // Midway: f closed, g not, when the op died.
      const b = bindDecisions(u.root) as any;
      await closeFindingOnDecision(u.root, b, "7", { round: "R1", decision: "dA", answer: answerA, ruler: "alice@x.com", finding: f, as: "refuted" }, "the first close");
      const retry = await logQuestion(u.root, { session: SESSION, toolUseId: "toolu_1", round: "R1" }, {}, u.transcripts) as any;
      assert.deepEqual(retry.answered[0].closed, [g], "the retry closes the rest");
      assert.deepEqual((await readFinding(u.root, f))?.settledBy, [answerA], "and f exactly once");
      assert.equal((await readFinding(u.root, g))?.state, "refuted");
    });
    // P2.b: reopened by a person, it is never closed again by the same answer.
    await asPerson(async () => { await closeFinding(u.root, 7, f, "issued", "not so fast"); });
    await asAgent(async () => {
      assert.equal((await readFinding(u.root, f))?.state, "issued", "the check could fail: it is open");
      const again = await logQuestion(u.root, { session: SESSION, toolUseId: "toolu_1", round: "R1" }, {}, u.transcripts) as any;
      assert.deepEqual(again.answered[0].closed, []);
      assert.equal((await readFinding(u.root, f))?.state, "issued", "reopen wins");
    });
  } finally { u.cleanup(); }
});

test("P2.c: a page click answered again after a crash closes what the first did not, and nothing twice", async () => {
  const u = await universe();
  try {
    const [f, g] = [await withFinding(u), await withFinding(u)];
    const dC = { id: "dC", round: "R1", ref: "D1", kind: "options" as const,
      payload: { question: `D1: are ${f} and ${g} real?`, header: "D1", options: [{ label: "Not defects" }, { label: "Real" }] },
      options: [{ label: "Not defects", effects: [{ findings: [f, g], on: "settle" as const, as: "refuted" as const }], closesOnAnswer: true }, { label: "Real", effects: [{ findings: [f, g], on: "unblock" as const }] }] };
    await asAgent(async () => {
      const r = await postPrevalidated(u.root, bindDecisions(u.root) as any, { round: { id: "R1", source: "triage" }, decisions: [dC] }, { record: "rec", sortedBy: "two sorters and an arbitrator" });
      assert.equal((r as any).ok, true, JSON.stringify(r));
    });
    await asPerson(async () => {
      const b = bindDecisions(u.root) as any;
      const hash = (await decisionRound(u.root, "R1") as any).decisions[0].hash;
      const first = (await recordAnswerEvent(b.cfg.path, b.cfg.universe, b.actor, { decision: "dC", hash, via: { kind: "direct", option: "Not defects" } })).id;
      await closeFindingOnDecision(u.root, b, "7", { round: "R1", decision: "dC", answer: first, ruler: "alice@x.com", finding: f, as: "refuted" }, "the first close");
      const again = await answerDirect(u.root, { decision: "dC", option: "Not defects" }) as any;
      assert.deepEqual(again.closed, [g], JSON.stringify(again));
      assert.equal((await readFinding(u.root, f))?.closed?.reason, "the first close", "f stays as its first close left it");
    });
  } finally { u.cleanup(); }
});

test("P5 (bulk 8–10): posting refuses duplicate ids, a second or chained replacement, and a finding the team does not have", async () => {
  const u = await universe();
  try {
    const f = await withFinding(u);
    const g = await withFinding(u);
    await asAgent(async () => {
      // Two decisions sharing an id: the fold keeps the first, so the second was asked with its payload.
      const dup = await postRound(u.root, { round: { id: "R1", source: "x" }, decisions: [decision("d1", f), decision("d1", g, {}, "D2")] });
      assert.match(String(err(dup)), /share the id d1/, JSON.stringify(dup).slice(0, 300));
      assert.equal((await postRound(u.root, { round: { id: "R1", source: "x" }, decisions: [decision("d1", f), decision("d2", g, {}, "D2")] }) as any).ok, true);

      const re = (id: string, ref: string, round: string, supersedes: string) => ({ ...decision(id, f, {}, ref), round, supersedes });
      assert.match(String(err(await postRound(u.root, { round: { id: "R2", source: "x" }, decisions: [re("d1b", "D1", "R2", "d1"), re("d1c", "D2", "R2", "d1")] }))), /two decisions in this round replace d1/);
      assert.equal((await postRound(u.root, { round: { id: "R2", source: "x" }, decisions: [re("d1b", "D1", "R2", "d1")] }) as any).ok, true);
      assert.match(String(err(await postRound(u.root, { round: { id: "R3", source: "x" }, decisions: [re("d1c", "D1", "R3", "d1")] }))), /d1b already replaced — replace d1b instead/);
      assert.equal((await postRound(u.root, { round: { id: "R3", source: "x" }, decisions: [re("d1c", "D1", "R3", "d1b")] }) as any).ok, true, "the chain stays linear");

      // On this map only: the team's clones could not carry a ruling on it out.
      const local = { ...(await readFinding(u.root, f))!, id: "f_local" };
      await writeLocalFinding(u.root, local as any, 7);
      assert.match(String(err(await postRound(u.root, { round: { id: "R4", source: "x" }, decisions: [{ ...decision("d4", "f_local"), round: "R4" }] }))), /on this map only/);
    });
  } finally { u.cleanup(); }
});

test("Q16: a finding id under two review keys is refused, never closed in whichever scope sorted first", async () => {
  const u = await universe();
  try {
    const f = await withFinding(u);
    await asAgent(async () => {
      const r = await postPrevalidated(u.root, bindDecisions(u.root) as any, { round: { id: "R1", source: "triage" }, decisions: [decision("d1", f, { closesOnAnswer: true })] }, { record: "rec", sortedBy: "two sorters and an arbitrator" });
      assert.equal((r as any).ok, true, JSON.stringify(r));
      // The same id under another key, as a second review's row would put it.
      openDb(u.root).prepare("INSERT INTO findings(id,pr,target_kind,target_id,state,author,created_at,needs_ack,contested,ord,body) SELECT id,'8',target_kind,target_id,state,author,created_at,needs_ack,contested,ord,body FROM findings WHERE id = ?").run(f);
      assert.match(String(err(await postRound(u.root, { round: { id: "R2", source: "x" }, decisions: [{ ...decision("d2", f, {}, "D2"), round: "R2" }] }))), /under more than one review \(7, 8\)/);
    });
    await asPerson(async () => {
      const a = await answerDirect(u.root, { decision: "d1", option: "Not a defect" }) as any;
      assert.deepEqual(a.closed, []);
      assert.match(String(a.refused?.[0]), /under 7, 8, so it was not closed/);
    });
  } finally { u.cleanup(); }
});

test("P7 + H8: 'D1 A' bound by a verified reader to a pre-staged question closes it; a re-sent relay after a crash closes the rest once", async () => {
  const u = await universe();
  try {
    const [f, g] = [await withFinding(u), await withFinding(u)];
    const dA = { id: "dA", round: "R1", ref: "D1", kind: "options" as const,
      payload: { question: `D1: are ${f} and ${g} real?`, header: "D1", options: [{ label: "Not defects" }, { label: "Real" }] },
      options: [{ label: "Not defects", effects: [{ findings: [f, g], on: "settle" as const, as: "refuted" as const }], closesOnAnswer: true }, { label: "Real", effects: [{ findings: [f, g], on: "unblock" as const }] }] };
    await asAgent(async () => {
      const b = bindDecisions(u.root) as any;
      assert.equal((await postPrevalidated(u.root, b, { round: { id: "R1", source: "triage" }, decisions: [dA] }, { record: "rec", sortedBy: "two sorters and an arbitrator" }) as any).ok, true);
      asked(u.transcripts, "unused", "toolu_x", [payloadFor(f)]);   // m1 is the person's "D1 B"; read here as their answer
      const r = await relayAnswer(u.root, { round: "R1", decision: "dA", session: SESSION, entryId: "m1" }, {}, u.transcripts) as any;
      assert.equal(r.recorded, true, JSON.stringify(r));
      readerAgent(u.transcripts, "D1 B means Not defects here");
      // The crash: the reading is in the log and f closed; g's close never ran.
      const maps = [{ decision: "dA", option: "Not defects" }];
      await recordReadingEvent(b.cfg.path, b.cfg.universe, b.actor, { answer: r.answer, reader: { transcript: READER, reading: "Not defects", maps, verified: { session: SESSION, toolUseId: `toolu_${READER}` } }, session: { reading: "Not defects", maps } });
      await closeFindingOnDecision(u.root, b, "7", { round: "R1", decision: "dA", answer: r.answer, ruler: "alice@x.com", finding: f, as: "refuted" }, "the first close");
      assert.equal((await readFinding(u.root, g))?.state, "issued", "the check could fail: g is open");
      const again = await relayAnswer(u.root, { round: "R1", decision: "dA", session: SESSION, entryId: "m1" }, {}, u.transcripts) as any;
      assert.deepEqual(again.closed, [g], JSON.stringify(again));
      assert.deepEqual((await readFinding(u.root, f))?.settledBy, [r.answer], "f exactly once");
      const read = await decisionRound(u.root, "R1") as any;
      assert.equal(read.decisions[0].standing.own, true, "your own answer, once the reader is verified");
    });
  } finally { u.cleanup(); }
});

test("P7: record_reading by a verified reader subagent carries out a typed reply's close", async () => {
  const u = await universe();
  try {
    const f = await withFinding(u);
    await asAgent(async () => {
      assert.equal((await postPrevalidated(u.root, bindDecisions(u.root) as any, { round: { id: "R1", source: "triage" }, decisions: [decision("d1", f, { closesOnAnswer: true })] }, { record: "rec", sortedBy: "two sorters and an arbitrator" }) as any).ok, true);
      asked(u.transcripts, "unused", "toolu_x", [payloadFor(f)]);
      const r = await relayAnswer(u.root, { round: "R1", decision: "d1", session: SESSION, entryId: "m1" }, {}, u.transcripts) as any;
      readerAgent(u.transcripts, "reading: they said it is not a defect");
      const maps = [{ decision: "d1", option: "Not a defect" }];
      const read = await recordReading(u.root, { answer: r.answer, reader: { transcript: READER, reading: "they said it is not a defect", maps }, session: { reading: "not a defect", maps } }, {}, u.transcripts) as any;
      assert.deepEqual(read.closed, [f], JSON.stringify(read));
      assert.equal((await readFinding(u.root, f))?.state, "refuted");
    });
  } finally { u.cleanup(); }
});
