/**
 * The decision ops, end to end, through the verbs a caller reaches — the oracle the fold tests
 * cannot be: a real sidecar, real findings in the canonical table, and a transcript fixture in
 * the shape measured on 2026-09-23. The fold being right is `shared-decisions.test.ts`; this is
 * whether anything reaches it, and whether what the person sees afterwards is true.
 *
 * The four gates of `.git/triage/2026-09-23-decision-rounds-2-impl-review/plan.md` each have a
 * test here through the paths that plan changed, marked GATE.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { indexBlob } from "./repo.js";
import { writeStore, readFinding, writeLocalFinding } from "./store.js";
import { db as openDb } from "./db.js";
import type { State } from "./schema.js";
import { shareFinding, closeFinding, bindDecisions, reassignFinding, sharedFindings } from "./ops-shared.js";
import { reviewQueue } from "./ops/annotations.js";
import { postRound, postPrevalidated, logQuestion, relayAnswer, answerDirect, decisionRounds, decisionRound, recordReading, confirmReading, parseVerdict } from "./ops/decisions.js";
import { discard } from "./test-tmp.js";
import { decisionScope, logQuestionEvent } from "./shared-decisions.js";

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
const decision = (id: string, f: string, extra: Record<string, unknown> = {}, ref = "D1", round = "R1") => ({
  id, round, ref, kind: "options" as const, payload: payloadFor(f, ref),
  options: [{ label: "Not a defect", effects: [{ findings: [f], on: "settle" as const, as: "refuted" as const }], ...extra }, { label: "Real, fix it", effects: [{ findings: [f], on: "unblock" as const }] }],
});
/** `s` seconds from now: the person answers after the round was posted. */
const later = (s = 1) => new Date(Date.now() + s * 1000).toISOString();

/**
 * The asking session's transcript, appended to as the session goes — the shape measured
 * 2026-09-23: calls and their results, the person's typed messages, and a reader subagent's
 * launch, sidechain and hand-back.
 */
function transcript(dir: string, session = SESSION) {
  const lines: object[] = [];
  const file = join(dir, `${session}.jsonl`);
  const write = () => writeFileSync(file, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
  return {
    ask(toolUseId: string, questions: object[], answers: Record<string, string | string[]>, when = later()) {
      lines.push({ type: "assistant", uuid: `a-${toolUseId}`, isSidechain: false, timestamp: when, message: { content: [{ type: "tool_use", id: toolUseId, name: "AskUserQuestion", input: { questions } }] } });
      lines.push({ type: "user", uuid: `r-${toolUseId}`, isSidechain: false, timestamp: when, sourceToolAssistantUUID: `a-${toolUseId}`, message: { content: [{ type: "tool_result", tool_use_id: toolUseId, content: "…" }] }, toolUseResult: { questions, answers } });
      write();
    },
    typed(uuid: string, text: string, when = later()) {
      lines.push({ type: "user", uuid, isSidechain: false, timestamp: when, origin: { kind: "human" }, message: { role: "user", content: text } });
      write();
    },
    /** A reader subagent: launched at `launchedAt`, and — unless `running` — handed back `report`. */
    reader(agentId: string, report: string, opts: { launchedAt?: string; running?: boolean } = {}) {
      const sub = join(dir, session, "subagents");
      mkdirSync(sub, { recursive: true });
      const call = `toolu_${agentId}`;
      writeFileSync(join(sub, `agent-${agentId}.meta.json`), JSON.stringify({ agentType: "general-purpose", toolUseId: call }));
      writeFileSync(join(sub, `agent-${agentId}.jsonl`), [
        { type: "user", uuid: "s1", isSidechain: true, agentId, sessionId: session, message: { role: "user", content: "read this" } },
        { type: "assistant", uuid: "s2", isSidechain: true, agentId, sessionId: session, message: { content: [{ type: "tool_use", id: "h1", name: "SubagentHandback", input: { message: report } }] } },
        // Measured: a reader goes on writing after it hands back, so its last text is not its verdict.
        { type: "assistant", uuid: "s3", isSidechain: true, agentId, sessionId: session, message: { content: [{ type: "text", text: "I delivered the report. D1 → Real, fix it" }] } },
      ].map((l) => JSON.stringify(l)).join("\n") + "\n");
      const at = opts.launchedAt ?? later(3);
      lines.push({ type: "assistant", uuid: `l-${agentId}`, isSidechain: false, timestamp: at, message: { content: [{ type: "tool_use", id: call, name: "Agent", input: {} }] } });
      lines.push({ type: "user", uuid: `lr-${agentId}`, isSidechain: false, timestamp: at, message: { content: [{ type: "tool_result", tool_use_id: call, content: "launched" }] }, toolUseResult: { isAsync: true, status: "async_launched", agentId } });
      if (!opts.running) lines.push({ type: "user", uuid: `hb-${agentId}`, isSidechain: false, timestamp: later(4), isMeta: true, origin: { kind: "peer", from: agentId, senderTaskId: agentId, body: report, handback: true }, message: { role: "user", content: "Another Claude session sent a message" } });
      write();
    },
  };
}
let readerN = 0;
const nextReader = () => `a${String(++readerN).padStart(16, "0")}`;

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

test("posting refuses a finding this store does not hold, closesOnAnswer, and an arrow in a label; and accepts a plain round", async () => {
  const u = await universe();
  try {
    const f = await withFinding(u);
    await asAgent(async () => {
      assert.match(String(err(await postRound(u.root, { round: { id: "R1", source: "x" }, decisions: [decision("d1", "f_unrecorded")] }))), /not a finding this store holds/);
      assert.match(String(err(await postRound(u.root, { round: { id: "R1", source: "x", prevalidated: { record: "r", sortedBy: "s" } } as any, decisions: [decision("d1", f)] }))), /only import_round/);
      assert.match(String(err(await postRound(u.root, { round: { id: "R1", source: "x" }, decisions: [decision("d1", f, { closesOnAnswer: true })] }))), /closesOnAnswer is gone/);
      const arrow = decision("d1", f);
      arrow.payload.options[1]!.label = "Real -> fix it"; (arrow.options[1] as any).label = "Real -> fix it";
      assert.match(String(err(await postRound(u.root, { round: { id: "R1", source: "x" }, decisions: [arrow] }))), /contains a newline or an arrow/);
      const ok = await postRound(u.root, { round: { id: "R1", source: "x" }, decisions: [decision("d1", f)] }) as any;
      assert.equal(ok.ok, true, JSON.stringify(ok));
      assert.deepEqual(ok.ask[0].payload.question, payloadFor(f).question);
      assert.match(String(err(await postRound(u.root, { round: { id: "R1", source: "x" }, decisions: [decision("d2", f)] }))), /already posted/);
    });
  } finally { u.cleanup(); }
});

test("GATE (closed unseen): a logged answer is a ruling, never a close — the finding is held and listed as not carried out", async () => {
  const u = await universe();
  try {
    const f = await withFinding(u);
    await asAgent(async () => {
      await postRound(u.root, { round: { id: "R1", source: "x" }, decisions: [decision("d1", f)] });
      let view = await decisionRounds(u.root) as any;
      assert.ok(view.waitingOnYou.some((w: any) => w.decision === "d1"), "unanswered, it waits on you");

      transcript(u.transcripts).ask("toolu_1", [payloadFor(f)], { [payloadFor(f).question]: "Not a defect" });
      assert.match(String(err(await logQuestion(u.root, { toolUseId: "toolu_1" } as any, {}, u.transcripts))), /needs the round/);
      // No session given: the agent knows what it asked, and codemap finds whose transcript holds it.
      const r = await logQuestion(u.root, { toolUseId: "toolu_1", round: "R1" }, {}, u.transcripts) as any;
      assert.equal(r.ok, true, JSON.stringify(r));
      assert.equal(r.answered[0].verified, true);
      assert.equal((await readFinding(u.root, f))?.state, "issued", "the finding is untouched");

      view = await decisionRounds(u.root) as any;
      assert.ok(!view.waitingOnYou.some((w: any) => w.decision === "d1"));
      assert.ok(view.ruledNotCarriedOut.some((x: any) => x.finding === f && x.on === "settle" && x.ruler === "alice@x.com"));
      const round = await decisionRound(u.root, "R1") as any;
      assert.ok(round.held.some((h: any) => h.finding === f && h.held.some((x: any) => x.why === "ruled")));

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

test("prevalidated is provenance only: a pre-validated round's answer closes nothing", async () => {
  const u = await universe();
  try {
    const f = await withFinding(u);
    await asAgent(async () => {
      const r = await postPrevalidated(u.root, bindDecisions(u.root) as any, { round: { id: "R1", source: "triage" }, decisions: [decision("d1", f)] }, { record: "rec", sortedBy: "two sorters and an arbitrator" });
      assert.equal((r as any).ok, true, JSON.stringify(r));
      transcript(u.transcripts).ask("toolu_1", [payloadFor(f)], { [payloadFor(f).question]: "Not a defect" });
      assert.equal(((await logQuestion(u.root, { toolUseId: "toolu_1", round: "R1" }, {}, u.transcripts)) as any).ok, true);
      assert.equal((await readFinding(u.root, f))?.state, "issued");
      assert.equal((await decisionRound(u.root, "R1") as any).round.prevalidated.sortedBy, "two sorters and an arbitrator");
    });
  } finally { u.cleanup(); }
});

test("H6.1: a call that crashed after it was logged records its answers on the retry", async () => {
  const u = await universe();
  try {
    const f = await withFinding(u);
    await asAgent(async () => {
      await postRound(u.root, { round: { id: "R1", source: "x" }, decisions: [decision("d1", f)] });
      const when = later();
      transcript(u.transcripts).ask("toolu_1", [payloadFor(f)], { [payloadFor(f).question]: "Not a defect" }, when);
      const b = bindDecisions(u.root) as any;
      // The crash: the call is in the log, and no answer followed it.
      await logQuestionEvent(b.cfg.path, b.cfg.universe, b.actor, { session: SESSION, toolUseId: "toolu_1", questions: [payloadFor(f)], answers: { [payloadFor(f).question]: "Not a defect" }, transcript: SESSION, rounds: ["R1"], bound: { [payloadFor(f).question]: "R1" }, answeredAt: when });
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
      transcript(u.transcripts).ask("toolu_1", [payloadFor(f)], { [payloadFor(f).question]: "Not a defect" }, new Date(Date.now() - 60_000).toISOString());
      await postRound(u.root, { round: { id: "R1", source: "x" }, decisions: [decision("d1", f)] });
      const early = await logQuestion(u.root, { session: SESSION, toolUseId: "toolu_1", round: "R1" }, {}, u.transcripts) as any;
      assert.match(String(err(early)), /answered at .* posted at .*: an answer binds only to a question posted before it/);
      assert.equal((await decisionRound(u.root, "R1") as any).decisions[0].answers.length, 0);
      assert.match(String(err(await logQuestion(u.root, { session: SESSION, toolUseId: "toolu_1", round: "R9" }, {}, u.transcripts))), /no round R9/);
    });
  } finally { u.cleanup(); }
});

test("D4 (P2.4, S0.8(d)): one call, two rounds — each question binds in its own; one that is both rounds' question is refused alone", async () => {
  const u = await universe();
  try {
    const [f, g] = [await withFinding(u), await withFinding(u)];
    await asAgent(async () => {
      await postRound(u.root, { round: { id: "R1", source: "x" }, decisions: [decision("d1", f)] });
      await postRound(u.root, { round: { id: "R2", source: "x" }, decisions: [decision("d2", g, {}, "D2", "R2"), decision("dx", f, {}, "D1", "R2")] });
      transcript(u.transcripts).ask("toolu_1", [payloadFor(f), payloadFor(g, "D2")], { [payloadFor(f).question]: "Not a defect", [payloadFor(g, "D2").question]: "Real, fix it" });
      const r = await logQuestion(u.root, { toolUseId: "toolu_1", round: ["R1", "R2"] }, {}, u.transcripts) as any;
      assert.equal(r.ok, true, JSON.stringify(r));
      assert.match(r.refused[0].why, /more than one round you named \(R1, R2\)/, "D1's text is posted in both: which one it answers cannot be told");
      const [one, two] = [await decisionRound(u.root, "R1") as any, await decisionRound(u.root, "R2") as any];
      assert.equal(one.decisions[0].answers.length, 0);
      assert.ok(two.decisions.find((d: any) => d.id === "d2").standing.ruled.some((x: any) => x.finding === g && x.on === "unblock"));
    });
  } finally { u.cleanup(); }
});

test("an unverifiable call writes nothing", async () => {
  const u = await universe();
  try {
    const f = await withFinding(u);
    await asAgent(async () => {
      await postRound(u.root, { round: { id: "R1", source: "x" }, decisions: [decision("d1", f)] });
      transcript(u.transcripts).ask("toolu_1", [payloadFor(f)], { [payloadFor(f).question]: "Not a defect" });
      const r = await logQuestion(u.root, { session: SESSION, toolUseId: "toolu_other", round: "R1" }, {}, u.transcripts) as any;
      assert.equal(r.ok, false);
      assert.ok(r.unverified);
      assert.equal((await decisionRound(u.root, "R1") as any).decisions[0].answers.length, 0);
    });
  } finally { u.cleanup(); }
});

test("GATE (vanishing) / A4 + K1: answered before the question was replaced and logged after, the answer counts on it — through log_question", async () => {
  const u = await universe();
  try {
    const f = await withFinding(u);
    await asAgent(async () => {
      await postRound(u.root, { round: { id: "R1", source: "x" }, decisions: [decision("d1", f)] });
      await new Promise((r) => setTimeout(r, 30));
      await postRound(u.root, { round: { id: "R2", source: "x" }, decisions: [{ ...decision("d1b", f, {}, "D7", "R2"), supersedes: "d1" }] });
      // Answered between the two postings, logged only now — after the replacement.
      const [one, two] = [(await decisionRound(u.root, "R1") as any).round.at, (await decisionRound(u.root, "R2") as any).round.at];
      transcript(u.transcripts).ask("toolu_1", [payloadFor(f)], { [payloadFor(f).question]: "Not a defect" }, new Date((Date.parse(one) + Date.parse(two)) / 2).toISOString());
      const r = await logQuestion(u.root, { toolUseId: "toolu_1", round: "R1" }, {}, u.transcripts) as any;
      assert.equal(r.answered[0]?.recorded, true, JSON.stringify(r));
      const view = await decisionRounds(u.root) as any;
      assert.ok(view.ruledNotCarriedOut.some((x: any) => x.finding === f && x.replacedBy === "d1b"), "the ruling holds until the replacement is answered (B2.4)");
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
      const t = transcript(u.transcripts);
      t.typed("m1", "D1 B");
      assert.match(String(err(await relayAnswer(u.root, { round: "R9", decision: "d1", session: SESSION, entryId: "m1" }, {}, u.transcripts))), /not R9/);
      const r = await relayAnswer(u.root, { round: "R1", decision: "d1", session: SESSION, entryId: "m1" }, {}, u.transcripts) as any;
      assert.equal(r.verified, true, JSON.stringify(r));
      assert.equal(r.awaitsReading, true, "\"D1 B\" is words for the reader, not a pick");
      assert.deepEqual(r.ruled, []);
      const reader = nextReader();
      t.reader(reader, "They typed 'D1 B', the second option.\nD1 → Real, fix it");
      const read = await recordReading(u.root, { answer: r.answer, reader, session: { maps: [{ decision: "d1", option: "Real, fix it" }] } }, {}, u.transcripts) as any;
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

test("a message typed before its round was posted is refused, with both times", async () => {
  const u = await universe();
  try {
    const f = await withFinding(u);
    await asAgent(async () => {
      transcript(u.transcripts).typed("m1", "D1 B", new Date(Date.now() - 60_000).toISOString());
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

test("GATE (overwritten): after a click, an agent's unconfirmed relay and the person's unread words both leave the ruling standing — the words flag it", async () => {
  const u = await universe();
  try {
    const f = await withFinding(u);
    await asAgent(async () => { await postRound(u.root, { round: { id: "R1", source: "x" }, decisions: [decision("d1", f)] }); });
    await asPerson(async () => { await answerDirect(u.root, { decision: "d1", option: "Not a defect" }); });
    await asAgent(async () => {
      const un = await relayAnswer(u.root, { round: "R1", decision: "d1", session: SESSION, entryId: "nope", words: "D1 B, fix it", relayedBy: "sess-x" }, {}, u.transcripts) as any;
      assert.match(String(un.note), /unconfirmed, after a verified ruling/, JSON.stringify(un));
      assert.equal(un.standing, false);
      let view = await decisionRounds(u.root) as any;
      assert.ok(view.ruledNotCarriedOut.some((x: any) => x.finding === f && x.on === "settle"), "your ruling stands");
      assert.ok(view.waitingOnYou.some((w: any) => w.decision === "d1" && /arrived after your ruling/.test(w.why)));
      // An agent's unconfirmed words after a verified ruling are never read (H6.8).
      const t = transcript(u.transcripts);
      const reader = nextReader();
      t.reader(reader, "D1 → Real, fix it");
      assert.match(String(err(await recordReading(u.root, { answer: un.answer, reader, session: { maps: [{ decision: "d1", option: "Real, fix it" }] } }, {}, u.transcripts))), /never read/);

      t.typed("m1", "D1 hmm, actually maybe it is real", later(1));
      const m = await relayAnswer(u.root, { round: "R1", decision: "d1", session: SESSION, entryId: "m1" }, {}, u.transcripts) as any;
      assert.equal(m.recorded, true, JSON.stringify(m));
      view = await decisionRounds(u.root) as any;
      assert.ok(view.ruledNotCarriedOut.some((x: any) => x.finding === f && x.on === "settle"), "unread, the words do not displace it");
      assert.equal(view.possiblySuperseded[0]?.decision, "d1", JSON.stringify(view.possiblySuperseded));
      const all = await reviewQueue(u.root, { assignedOnly: false }) as any;
      assert.ok(all.queue.find((x: any) => x.id === f)?.possiblySuperseded, "and every surface marks it");
    });
  } finally { u.cleanup(); }
});

test("B1 + B2: the reader's verdict is read from its own hand-back — a mis-copy, a reader that is not finished or came too early, or one reused, is refused", async () => {
  const u = await universe();
  try {
    const [f, g] = [await withFinding(u), await withFinding(u)];
    await asAgent(async () => {
      await postRound(u.root, { round: { id: "R1", source: "x" }, decisions: [decision("d1", f), decision("d2", g, {}, "D2")] });
      const t = transcript(u.transcripts);
      t.typed("m1", "not a defect, but log why", later(1));
      t.typed("m2", "D2 is real", later(1));
      const a1 = (await relayAnswer(u.root, { round: "R1", decision: "d1", session: SESSION, entryId: "m1" }, {}, u.transcripts) as any).answer;
      const a2 = (await relayAnswer(u.root, { round: "R1", decision: "d2", session: SESSION, entryId: "m2" }, {}, u.transcripts) as any).answer;
      const mine = [{ decision: "d1", option: "Not a defect" }];

      assert.match(String((await recordReading(u.root, { answer: a1, reader: "someone-else", session: { maps: mine } }, {}, u.transcripts) as any).unverified), /not a subagent id/);
      const running = nextReader(); t.reader(running, "D1 → Not a defect", { running: true });
      assert.match(String((await recordReading(u.root, { answer: a1, reader: running, session: { maps: mine } }, {}, u.transcripts) as any).unverified), /has not handed back/);
      const early = nextReader(); t.reader(early, "D1 → Not a defect", { launchedAt: new Date(Date.now() - 60_000).toISOString() });
      assert.match(String((await recordReading(u.root, { answer: a1, reader: early, session: { maps: mine } }, {}, u.transcripts) as any).unverified), /before the words were typed/);
      for (const [report, re] of [["I think they meant not a defect", /no verdict line/], ["D1 → Not a bug", /not an option of D1/], ["D9 → Real, fix it", /not a question in round R1/], ["unclear: two open\nD1 → Not a defect", /both unclear and a mapping/]] as const) {
        const r = nextReader(); t.reader(r, report);
        assert.match(String((await recordReading(u.root, { answer: a1, reader: r, session: { maps: mine } }, {}, u.transcripts) as any).unverified), re, report);
      }
      // ops1 part A: the reader said "Real, fix it"; the session asks for "Not a defect". It binds nothing.
      const honest = nextReader(); t.reader(honest, "Reading the words in context.\nD1 -> Real, fix it");
      const read = await recordReading(u.root, { answer: a1, reader: honest, session: { maps: mine } }, {}, u.transcripts) as any;
      assert.equal(read.agree, false, JSON.stringify(read));
      assert.deepEqual(read.reader, [{ decision: "d1", option: "Real, fix it" }], "the reader's own mapping, parsed — never the session's copy");
      const view = await decisionRounds(u.root) as any;
      assert.ok(view.readingsInDispute.some((x: any) => x.decision === "d1"));
      assert.ok(!view.ruledNotCarriedOut.some((x: any) => x.finding === f), "nothing bound");
      // One reader reads one answer.
      assert.match(String((await recordReading(u.root, { answer: a2, reader: honest, session: { maps: [{ decision: "d2", option: "Real, fix it" }] } }, {}, u.transcripts) as any).unverified), /already read answer/);
      assert.deepEqual(parseVerdict("D2 → (none)", (await decisionRound(u.root, "R1") as any) as any, "R1"), { maps: [{ decision: "d2", option: null }] });
    });
  } finally { u.cleanup(); }
});

test("S0.1 + S0.2: confirm_reading issues the exact question; Yes binds the agent's reading as of when the words were typed", async () => {
  const u = await universe();
  try {
    const f = await withFinding(u);
    await asAgent(async () => { await postRound(u.root, { round: { id: "R1", source: "x" }, decisions: [decision("d1", f)] }); });
    await asPerson(async () => { await answerDirect(u.root, { decision: "d1", option: "Not a defect" }); });
    await asAgent(async () => {
      const t = transcript(u.transcripts);
      const typed = later(1);
      t.typed("m1", "D1 wait, it is real", typed);
      const a = (await relayAnswer(u.root, { round: "R1", decision: "d1", session: SESSION, entryId: "m1" }, {}, u.transcripts) as any).answer;
      assert.match(String(err(await confirmReading(u.root, { answer: a }))), /give your own reading/);
      const c = await confirmReading(u.root, { answer: a, maps: [{ decision: "d1", option: "Real, fix it" }] }) as any;
      assert.equal(c.ok, true, JSON.stringify(c));
      assert.match(c.ask.question, /D1 → Real, fix it \(unblocks f_/);
      t.ask("toolu_c", [c.ask], { [c.ask.question]: "Yes" }, later(2));
      const r = await logQuestion(u.root, { toolUseId: "toolu_c", round: "R1" }, {}, u.transcripts) as any;
      assert.equal(r.confirmed?.[0]?.result, "bound", JSON.stringify(r));
      const d = (await decisionRound(u.root, "R1") as any).decisions[0];
      assert.equal(d.standing.id, a);
      assert.equal(d.standing.givenAt, typed, "bound at the time the words were typed");
      assert.ok(d.standing.ruled.some((x: any) => x.finding === f && x.on === "unblock"));
      assert.deepEqual(d.possiblySuperseded, []);
    });
  } finally { u.cleanup(); }
});

test("S0.2: 'No — ask me again' keeps the old ruling, flagged, and the rejected reading is never offered again", async () => {
  const u = await universe();
  try {
    const f = await withFinding(u);
    await asAgent(async () => { await postRound(u.root, { round: { id: "R1", source: "x" }, decisions: [decision("d1", f)] }); });
    await asPerson(async () => { await answerDirect(u.root, { decision: "d1", option: "Not a defect" }); });
    await asAgent(async () => {
      const t = transcript(u.transcripts);
      t.typed("m1", "D1 hmm", later(1));
      const a = (await relayAnswer(u.root, { round: "R1", decision: "d1", session: SESSION, entryId: "m1" }, {}, u.transcripts) as any).answer;
      const maps = [{ decision: "d1", option: "Real, fix it" }];
      const c = await confirmReading(u.root, { answer: a, maps }) as any;
      t.ask("toolu_c", [c.ask], { [c.ask.question]: "No — ask me again" }, later(2));
      const r = await logQuestion(u.root, { toolUseId: "toolu_c", round: "R1" }, {}, u.transcripts) as any;
      assert.match(r.confirmed?.[0]?.result, /rejected/, JSON.stringify(r));
      const view = await decisionRounds(u.root) as any;
      assert.ok(view.ruledNotCarriedOut.some((x: any) => x.finding === f && x.on === "settle"), "the old ruling stands");
      assert.equal(view.possiblySuperseded[0]?.decision, "d1", "flagged, until a replacement answer rules");
      assert.ok(view.waitingOnYou.some((w: any) => /not what you meant/.test(w.why)));
      assert.match(String(err(await confirmReading(u.root, { answer: a, maps }))), /already said this reading is not what they meant/);
    });
  } finally { u.cleanup(); }
});

test("Q14 / H7.14: a decisions log that cannot be read is blocked, not 'nothing waits on you', and writes on it refuse", async () => {
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
      transcript(u.transcripts).ask("toolu_1", [payloadFor(f)], { [payloadFor(f).question]: "Not a defect" });
      assert.match(String(err(await logQuestion(u.root, { session: SESSION, toolUseId: "toolu_1", round: "R1" }, {}, u.transcripts))), /blocked/);
    });
  } finally { u.cleanup(); }
});

test("D1 (P3.2 (7)): with the sidecar gone, the decision reads serve the stored rows marked blocked — they do not refuse", async () => {
  const u = await universe();
  try {
    const f = await withFinding(u);
    await asAgent(async () => {
      await postRound(u.root, { round: { id: "R1", source: "x" }, decisions: [decision("d1", f)] });
      assert.equal((await decisionRounds(u.root) as any).status, "complete");
      renameSync(u.side, u.side + ".away");
      try {
        const view = await decisionRounds(u.root) as any;
        assert.equal(view.status, "blocked", JSON.stringify(view).slice(0, 300));
        assert.equal(view.rounds.length, 1, "the stored rows, not an empty list");
        assert.equal((await decisionRound(u.root, "R1") as any).status, "blocked");
      } finally { renameSync(u.side + ".away", u.side); }
    });
  } finally { u.cleanup(); }
});

test("GATE (held offered as work) + C2: a missing decisions log reads as unknown where decisions were read before, and as no holds where they never were", async () => {
  const u = await universe();
  try {
    const f = await withFinding(u);
    await asPerson(async () => { await reassignFinding(u.root, 7, f, { kind: "fix" }); });
    await asAgent(async () => {
      // Never folded: no holds, and reading the page writes no zero-event row that would later
      // read as "folded before" (S0.8(b)).
      assert.equal((await decisionRounds(u.root) as any).status, "complete");
      assert.equal(openDb(u.root).prepare("SELECT COUNT(*) AS n FROM shared_scope WHERE scope LIKE 'decisions/%'").get()!.n, 0);
      assert.ok((await reviewQueue(u.root) as any).queue.some((x: any) => x.id === f), "no decisions, no holds: the COMPLETENESS reading");

      await postRound(u.root, { round: { id: "R1", source: "x" }, decisions: [decision("d1", f)] });
      assert.ok(!(await reviewQueue(u.root) as any).queue.some((x: any) => x.id === f), "held from its posting");
      const b = bindDecisions(u.root) as any;
      const dir = join(b.cfg.path, decisionScope(b.cfg.universe));
      rmSync(dir, { recursive: true });
      const q = await reviewQueue(u.root) as any;
      assert.match(String(q.error), /decisions log cannot be read/, JSON.stringify(q).slice(0, 300));
      assert.deepEqual(q.queue, []);
      assert.equal((await reviewQueue(u.root, { assignedOnly: false }) as any).queue.find((x: any) => x.id === f)?.held, "unknown");
    });
  } finally { u.cleanup(); }
});

test("GATE (held offered as work) + C4: only a person's assignment made after the latest hold began keeps a held finding queued", async () => {
  const u = await universe();
  try {
    const [f, g, h] = [await withFinding(u), await withFinding(u), await withFinding(u)];
    // ops1 part B: assigned as fix by a person BEFORE the question existed.
    await asPerson(async () => { await reassignFinding(u.root, 7, h, { kind: "fix" }); });
    await asAgent(async () => {
      await postRound(u.root, { round: { id: "R1", source: "x" }, decisions: [decision("d1", f), decision("d2", g, {}, "D2"), decision("d3", h, {}, "D3")] });
      await reassignFinding(u.root, 7, f, { kind: "fix" });   // an agent's assignment never keeps it
    });
    await asPerson(async () => {
      await answerDirect(u.root, { decision: "d1", option: "Not a defect" });
      await answerDirect(u.root, { decision: "d3", option: "Not a defect" });
      await reassignFinding(u.root, 7, g, { kind: "fix" });   // a person, while held: kept
    });
    await asAgent(async () => {
      const q = await reviewQueue(u.root) as any;
      assert.ok(!q.queue.some((x: any) => x.id === f), "ruled not a defect, assigned by an agent: withheld");
      assert.ok(!q.queue.some((x: any) => x.id === h), "assigned before the hold began, then ruled not a defect: withheld (ops1)");
      assert.equal(q.withheld?.count, 2, JSON.stringify(q).slice(0, 400));
      const mine = q.queue.find((x: any) => x.id === g);
      assert.ok(mine, "a person assigned it while it was held");
      assert.equal(mine.held[0].why, "undecided");

      const all = await reviewQueue(u.root, { assignedOnly: false }) as any;
      assert.equal(all.queue.find((x: any) => x.id === f)?.held[0].why, "ruled");
      const shared = await sharedFindings(u.root, 7) as any;
      assert.equal(shared.findings.find((x: any) => x.id === f)?.held[0].why, "ruled");
      const waiting = await sharedFindings(u.root, 7, { queue: true }) as any;
      for (const row of waiting.findings) if (row.id === f) assert.ok(row.held, "the person's queue marks it, never drops it");
    });
  } finally { u.cleanup(); }
});

test("C3 (P3.1 (3), S0.8(e)): an id under two review keys is held on both rows, and open while either is", async () => {
  const u = await universe();
  try {
    const f = await withFinding(u);
    await asAgent(async () => {
      await postRound(u.root, { round: { id: "R1", source: "x" }, decisions: [decision("d1", f)] });
      // The same id under another key, as a second review's row would put it — closed there.
      openDb(u.root).prepare("INSERT INTO findings(id,pr,target_kind,target_id,state,author,created_at,needs_ack,contested,ord,body) SELECT id,'8',target_kind,target_id,'refuted',author,created_at,needs_ack,contested,ord,body FROM findings WHERE id = ?").run(f);
      const round = await decisionRound(u.root, "R1") as any;
      assert.ok(round.held.some((x: any) => x.finding === f), "one row open is enough to be held");
      const all = await reviewQueue(u.root, { assignedOnly: false }) as any;
      const rows = all.queue.filter((x: any) => x.id === f);
      assert.ok(rows.length >= 1 && rows.every((x: any) => Array.isArray(x.held)), JSON.stringify(rows).slice(0, 300));
    });
  } finally { u.cleanup(); }
});

test("P5 (bulk 8–10): posting refuses duplicate ids, a second or chained replacement, and a finding the team does not have", async () => {
  const u = await universe();
  try {
    const f = await withFinding(u);
    const g = await withFinding(u);
    await asAgent(async () => {
      const dup = await postRound(u.root, { round: { id: "R1", source: "x" }, decisions: [decision("d1", f), decision("d1", g, {}, "D2")] });
      assert.match(String(err(dup)), /share the id d1/, JSON.stringify(dup).slice(0, 300));
      assert.equal((await postRound(u.root, { round: { id: "R1", source: "x" }, decisions: [decision("d1", f), decision("d2", g, {}, "D2")] }) as any).ok, true);

      const re = (id: string, ref: string, round: string, supersedes: string) => ({ ...decision(id, f, {}, ref, round), supersedes });
      assert.match(String(err(await postRound(u.root, { round: { id: "R2", source: "x" }, decisions: [re("d1b", "D1", "R2", "d1"), re("d1c", "D2", "R2", "d1")] }))), /two decisions in this round replace d1/);
      assert.equal((await postRound(u.root, { round: { id: "R2", source: "x" }, decisions: [re("d1b", "D1", "R2", "d1")] }) as any).ok, true);
      assert.match(String(err(await postRound(u.root, { round: { id: "R3", source: "x" }, decisions: [re("d1c", "D1", "R3", "d1")] }))), /d1b already replaced — replace d1b instead/);
      assert.equal((await postRound(u.root, { round: { id: "R3", source: "x" }, decisions: [re("d1c", "D1", "R3", "d1b")] }) as any).ok, true, "the chain stays linear");

      const local = { ...(await readFinding(u.root, f))!, id: "f_local" };
      await writeLocalFinding(u.root, local as any, 7);
      assert.match(String(err(await postRound(u.root, { round: { id: "R4", source: "x" }, decisions: [{ ...decision("d4", "f_local"), round: "R4" }] }))), /on this map only/);
    });
  } finally { u.cleanup(); }
});
