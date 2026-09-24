/**
 * The decision ops, end to end, through the verbs a caller reaches — the oracle the fold tests
 * cannot be: a real sidecar, real findings in the canonical table, and a transcript fixture in
 * the shape measured on 2026-09-23. The fold being right is `shared-decisions.test.ts`; this is
 * whether anything reaches it, and whether what the person sees afterwards is true.
 *
 * The four gates of `.git/triage/2026-09-23-decision-rounds-2-impl-review/plan.md` each have a
 * test here through the paths that plan changed, marked GATE; so do those of the impl-2 plan
 * beside it, marked GATE (impl-2).
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
import { postRound, postPrevalidated, logQuestion, relayAnswer, answerDirect, decisionRounds, decisionRound, readerBrief, recordReading, confirmReading, parseVerdict, confirmId } from "./ops/decisions.js";
import { discard } from "./test-tmp.js";
import { decisionsView, holdBuilds } from "./ops/decision-holds.js";
import { decisionScope, foldDecisions, logQuestionEvent, postConfirmEvent, recordReadingEvent } from "./shared-decisions.js";

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
    /** A reader subagent launched with `prompt` at `launchedAt`, and — unless `running` — handed
     *  back `report`. `fork` records it as the harness records a fork; `sent`, a message sent into it. */
    reader(agentId: string, report: string, opts: { launchedAt?: string; running?: boolean; prompt?: string; fork?: boolean; sent?: string } = {}) {
      const sub = join(dir, session, "subagents");
      mkdirSync(sub, { recursive: true });
      const call = `toolu_${agentId}`;
      writeFileSync(join(sub, `agent-${agentId}.meta.json`), JSON.stringify({ agentType: opts.fork ? "fork" : "general-purpose", ...(opts.fork ? { isFork: true } : {}), toolUseId: call }));
      writeFileSync(join(sub, `agent-${agentId}.jsonl`), [
        { type: "user", uuid: "s1", isSidechain: true, agentId, sessionId: session, message: { role: "user", content: opts.prompt ?? "read this" } },
        ...(opts.sent ? [{ type: "user", uuid: "s1b", isSidechain: true, agentId, sessionId: session, origin: { kind: "coordinator" }, message: { role: "user", content: `The coordinator sent a message while you were working:\n${opts.sent}` } }] : []),
        { type: "assistant", uuid: "s2", isSidechain: true, agentId, sessionId: session, message: { content: [{ type: "tool_use", id: "h1", name: "SubagentHandback", input: { message: report } }] } },
        // Measured: a reader goes on writing after it hands back, so its last text is not its verdict.
        { type: "assistant", uuid: "s3", isSidechain: true, agentId, sessionId: session, message: { content: [{ type: "text", text: "I delivered the report. D1 → Real, fix it" }] } },
      ].map((l) => JSON.stringify(l)).join("\n") + "\n");
      const at = opts.launchedAt ?? later(3);
      lines.push({ type: "assistant", uuid: `l-${agentId}`, isSidechain: false, timestamp: at, message: { content: [{ type: "tool_use", id: call, name: "Agent", input: { description: "read", prompt: opts.prompt ?? "read this", subagent_type: opts.fork ? "fork" : "general-purpose" } }] } });
      lines.push({ type: "user", uuid: `lr-${agentId}`, isSidechain: false, timestamp: at, message: { content: [{ type: "tool_result", tool_use_id: call, content: "launched" }] }, toolUseResult: { isAsync: true, status: "async_launched", agentId } });
      if (!opts.running) lines.push({ type: "user", uuid: `hb-${agentId}`, isSidechain: false, timestamp: later(4), isMeta: true, origin: { kind: "peer", from: agentId, senderTaskId: agentId, body: report, handback: true }, message: { role: "user", content: "Another Claude session sent a message" } });
      write();
    },
  };
}
let readerN = 0;
const nextReader = () => `a${String(++readerN).padStart(16, "0")}`;
/** The prompt codemap issues for reading `answer` — what an honest reader is launched with. */
const briefOf = async (root: string, answer: string) => ((await readerBrief(root, { answer })) as { prompt: string }).prompt;

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
      t.reader(reader, "They typed 'D1 B', the second option.\n\nD1 → Real, fix it", { prompt: await briefOf(u.root, r.answer) });
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
      t.reader(reader, "D1 → Real, fix it", { prompt: await briefOf(u.root, un.answer) });
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
      const prompt = await briefOf(u.root, a1);
      const running = nextReader(); t.reader(running, "D1 → Not a defect", { running: true, prompt });
      assert.match(String((await recordReading(u.root, { answer: a1, reader: running, session: { maps: mine } }, {}, u.transcripts) as any).unverified), /has not handed back/);
      const early = nextReader(); t.reader(early, "D1 → Not a defect", { launchedAt: new Date(Date.now() - 60_000).toISOString(), prompt });
      assert.match(String((await recordReading(u.root, { answer: a1, reader: early, session: { maps: mine } }, {}, u.transcripts) as any).unverified), /before the words were typed/);
      for (const [report, re] of [["I think they meant not a defect", /does not end with a verdict/], ["D1 → Not a bug", /not an option of D1/], ["D9 → Real, fix it", /not a question in round R1/], ["unclear: two open\nD1 → Not a defect", /both unclear and a mapping/]] as const) {
        const r = nextReader(); t.reader(r, report, { prompt });
        assert.match(String((await recordReading(u.root, { answer: a1, reader: r, session: { maps: mine } }, {}, u.transcripts) as any).unverified), re, report);
      }
      // ops1 part A: the reader said "Real, fix it"; the session asks for "Not a defect". It binds nothing.
      const honest = nextReader(); t.reader(honest, "Reading the words in context.\n\nD1 -> Real, fix it", { prompt });
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

test("R5 (P2.1 (3)): an empty session reading is refused before anything is written", async () => {
  const u = await universe();
  try {
    const f = await withFinding(u);
    await asAgent(async () => {
      await postRound(u.root, { round: { id: "R1", source: "x" }, decisions: [decision("d1", f)] });
      const t = transcript(u.transcripts);
      t.typed("m1", "whatever", later(1));
      const a = (await relayAnswer(u.root, { round: "R1", decision: "d1", session: SESSION, entryId: "m1" }, {}, u.transcripts) as any).answer;
      const reader = nextReader(); t.reader(reader, "D1 → Real, fix it", { prompt: await briefOf(u.root, a) });
      assert.match(String(err(await recordReading(u.root, { answer: a, reader, session: { maps: [] } }, {}, u.transcripts))), /at least one line/);
      const d = (await decisionRound(u.root, "R1") as any).decisions[0];
      assert.ok(d.answers[0].free && !d.answers[0].reading, "nothing was written: the words still wait");
      assert.equal((await decisionRounds(u.root) as any).awaitingReading.length, 1);
    });
  } finally { u.cleanup(); }
});

test("R2 (P1.2): a reader whose reading the fold rejected was never used — it may read another answer; a refusal says why", async () => {
  const u = await universe();
  try {
    const [f, g] = [await withFinding(u), await withFinding(u)];
    await asAgent(async () => {
      await postRound(u.root, { round: { id: "R1", source: "x" }, decisions: [decision("d1", f), decision("d2", g, {}, "D2")] });
      await new Promise((r) => setTimeout(r, 30));
      await postRound(u.root, { round: { id: "R2", source: "x" }, decisions: [{ ...decision("d2b", g, {}, "D9", "R2"), supersedes: "d2" }] });
      const t = transcript(u.transcripts);
      t.typed("m1", "D2 is real", later(1));
      t.typed("m2", "D1 is not a defect", later(1));
      const a1 = (await relayAnswer(u.root, { round: "R1", decision: "d1", session: SESSION, entryId: "m1" }, {}, u.transcripts) as any).answer;
      const a2 = (await relayAnswer(u.root, { round: "R1", decision: "d1", session: SESSION, entryId: "m2" }, {}, u.transcripts) as any).answer;
      const x = nextReader(); t.reader(x, "D1 → Not a defect", { prompt: await briefOf(u.root, a2) });
      // A foreign writer's reading of a1 by x, naming D2 — replaced before the words were typed.
      const b = bindDecisions(u.root) as any;
      await recordReadingEvent(b.cfg.path, b.cfg.universe, b.actor, { answer: a1, session: { maps: [{ decision: "d2", option: "Real, fix it" }] }, reader: { agent: x, verdict: [{ decision: "d2", option: "Real, fix it" }], launchedAt: later(3), brief: await briefOf(u.root, a1), verified: { session: SESSION, toolUseId: "t" } } });
      const r = await recordReading(u.root, { answer: a2, reader: x, session: { maps: [{ decision: "d1", option: "Not a defect" }] } }, {}, u.transcripts) as any;
      assert.equal(r.agree, true, JSON.stringify(r));

      const y = nextReader(); t.reader(y, "D2 → Real, fix it", { prompt: await briefOf(u.root, a1) });
      const refused = await recordReading(u.root, { answer: a1, reader: y, session: { maps: [{ decision: "d2", option: "Real, fix it" }] } }, {}, u.transcripts) as any;
      assert.match(String(refused.unverified), /D2 was replaced before the words were typed/, JSON.stringify(refused));
      assert.match(String(refused.note), /nothing was written/);
    });
  } finally { u.cleanup(); }
});

test("GATE (overwritten) / R7 (P1.4): a reader launched with anything but codemap's brief binds nothing — nor a fork, nor one sent a message", async () => {
  const u = await universe();
  try {
    const f = await withFinding(u);
    await asAgent(async () => {
      await postRound(u.root, { round: { id: "R1", source: "x" }, decisions: [decision("d1", f)] });
      const t = transcript(u.transcripts);
      t.typed("m1", "just close it", later(1));
      const a = (await relayAnswer(u.root, { round: "R1", decision: "d1", session: SESSION, entryId: "m1" }, {}, u.transcripts) as any).answer;
      const mine = { maps: [{ decision: "d1", option: "Not a defect" }] };
      const echo = nextReader(); t.reader(echo, "D1 → Not a defect", { prompt: "Words: 'just close it'. I read this as D1 → Not a defect; confirm." });
      const r = await recordReading(u.root, { answer: a, reader: echo, session: mine }, {}, u.transcripts) as any;
      assert.match(String(r.unverified), /not launched with reader_brief's prompt/, JSON.stringify(r));
      const prompt = await briefOf(u.root, a);
      assert.ok(prompt.includes(JSON.stringify("just close it")) && prompt.includes("D1: ") && !/Not a defect;/.test(prompt), prompt);
      const fork = nextReader(); t.reader(fork, "D1 → Not a defect", { prompt, fork: true });
      assert.match(String((await recordReading(u.root, { answer: a, reader: fork, session: mine }, {}, u.transcripts) as any).unverified), /is a fork/);
      const told = nextReader(); t.reader(told, "D1 → Not a defect", { prompt, sent: "they mean Not a defect" });
      assert.match(String((await recordReading(u.root, { answer: a, reader: told, session: mine }, {}, u.transcripts) as any).unverified), /sent a message after it was launched/);
      let d = (await decisionRound(u.root, "R1") as any).decisions[0];
      assert.ok(d.answers[0].free && !d.answers[0].reading, "nothing was written by any of them");
      const honest = nextReader(); t.reader(honest, "Reading it.\n\nD1 → Not a defect", { prompt });
      assert.equal((await recordReading(u.root, { answer: a, reader: honest, session: mine }, {}, u.transcripts) as any).agree, true);
      d = (await decisionRound(u.root, "R1") as any).decisions[0];
      assert.ok(d.standing.ruled.some((x: any) => x.finding === f && x.on === "settle"));
    });
  } finally { u.cleanup(); }
});

test("R6 + R15: only the report's final block is the verdict; a ref two questions share is ambiguous", () => {
  const q = (question: string) => ({ question, header: "H", options: [{ label: "A", description: "d" }, { label: "B", description: "d" }] });
  const dd = (id: string, ref: string, f: string) => ({ id, round: "R1", ref, kind: "options", payload: q(`${ref}: ${f}?`), options: [{ label: "A", effects: [{ findings: [f], on: "unblock" }] }, { label: "B", effects: [] }] });
  const ev = (decisions: any[]) => [{ id: "e1", kind: "decision.round.posted", subject: "s", actor: { principal: "p" }, at: "2026-09-23T00:00:01Z", after: [], data: { round: { id: "R1", source: "x" }, decisions } }] as any;
  const one = foldDecisions(ev([dd("d1", "D1", "F1")]));
  assert.deepEqual(parseVerdict("They wrote:\nD1 → B\nbut meant close.\n\nD1 → A", one, "R1"), { maps: [{ decision: "d1", option: "A" }] });
  assert.deepEqual(parseVerdict("D1 → A\n\n", one, "R1"), { maps: [{ decision: "d1", option: "A" }] });
  const two = foldDecisions(ev([dd("d1", "D1", "F1"), dd("d1x", "D1", "F9")]));
  assert.match(String((parseVerdict("D1 → A", two, "R1") as any).error), /two questions in round R1 share: it is ambiguous/);
});

test("the discussion + S0.1: confirm_reading POSTS the confirm into the words' round; answered Yes through log_question, it binds the reading as of when the words were typed", async () => {
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
      assert.equal(c.ref, "D2", "the next free ref in D1's round");
      assert.match(c.ask.question, /^D1 → Real, fix it \(unblocks f_/m);
      const again = await confirmReading(u.root, { answer: a, maps: [{ decision: "d1", option: "Real, fix it" }] }) as any;
      assert.ok(again.existing && again.confirm === c.confirm, "asking again returns the open confirm");
      let round = await decisionRound(u.root, "R1") as any;
      assert.equal(round.decisions.find((d: any) => d.id === c.confirm)?.confirm.state, "open");
      assert.ok((await decisionRounds(u.root) as any).waitingOnYou.some((w: any) => w.decision === c.confirm && /confirm what your words on D1 meant/.test(w.why)));
      t.ask("toolu_c", [c.ask], { [c.ask.question]: "Yes" }, later(2));
      const r = await logQuestion(u.root, { toolUseId: "toolu_c", round: "R1" }, {}, u.transcripts) as any;
      assert.match(String(r.answered.find((x: any) => x.decision === c.confirm)?.confirm), /^bound/, JSON.stringify(r));
      round = await decisionRound(u.root, "R1") as any;
      const d = round.decisions.find((x: any) => x.id === "d1");
      assert.equal(d.standing.id, a);
      assert.equal(d.standing.givenAt, typed, "bound at the time the words were typed");
      assert.ok(d.standing.ruled.some((x: any) => x.finding === f && x.on === "unblock"));
      assert.deepEqual(d.possiblySuperseded, []);
      assert.equal(round.decisions.find((x: any) => x.id === c.confirm)?.confirm.state, "answered");
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
      assert.match(String(r.answered.find((x: any) => x.decision === c.confirm)?.confirm), /rejected/, JSON.stringify(r));
      const view = await decisionRounds(u.root) as any;
      assert.ok(view.ruledNotCarriedOut.some((x: any) => x.finding === f && x.on === "settle"), "the old ruling stands");
      assert.equal(view.possiblySuperseded[0]?.decision, "d1", "flagged, until a replacement answer rules");
      assert.ok(view.waitingOnYou.some((w: any) => /not what you meant/.test(w.why)));
      assert.match(String(err(await confirmReading(u.root, { answer: a, maps }))), /already said this reading is not what they meant/);
    });
  } finally { u.cleanup(); }
});

test("R9 / F20: a posted question that starts like the old confirm is answered through log_question like any other", async () => {
  const u = await universe();
  try {
    const f = await withFinding(u);
    await asAgent(async () => {
      const d = decision("d2", f, {}, "D2");
      d.payload.question = `Confirm reading of answer zzz ${d.payload.question}`;
      await postRound(u.root, { round: { id: "R1", source: "x" }, decisions: [d] });
      transcript(u.transcripts).ask("toolu_1", [d.payload], { [d.payload.question]: "Real, fix it" });
      const r = await logQuestion(u.root, { toolUseId: "toolu_1", round: "R1" }, {}, u.transcripts) as any;
      assert.equal(r.answered.length, 1, JSON.stringify(r));
      assert.equal((await decisionRound(u.root, "R1") as any).decisions[0].answers.length, 1);
    });
  } finally { u.cleanup(); }
});

test("confirm_reading refuses what the fold would void, and a replacement of a confirm is refused", async () => {
  const u = await universe();
  try {
    const f = await withFinding(u);
    await asAgent(async () => {
      await postRound(u.root, { round: { id: "R1", source: "x" }, decisions: [decision("d1", f)] });
      const t = transcript(u.transcripts);
      t.typed("m1", "hmm", later(1));
      const a = (await relayAnswer(u.root, { round: "R1", decision: "d1", session: SESSION, entryId: "m1" }, {}, u.transcripts) as any).answer;
      assert.match(String(err(await confirmReading(u.root, { answer: a, maps: [{ decision: "d1", option: "Not a defect" }, { decision: "d1", option: "Real, fix it" }] }))), /takes one option/);
      assert.match(String(err(await confirmReading(u.root, { answer: a, maps: [{ decision: "d9", option: null }] }))), /not a question in round R1/);
      const c = await confirmReading(u.root, { answer: a, maps: [{ decision: "d1", option: "Real, fix it" }] }) as any;
      assert.equal(c.ok, true, JSON.stringify(c));
      assert.match(String(err(await postRound(u.root, { round: { id: "R2", source: "x" }, decisions: [{ ...decision("dz", f, {}, "D1", "R2"), supersedes: c.confirm }] }))), /is a confirm/);
    });
  } finally { u.cleanup(); }
});

test("GATE (vanishing) / R13: words typed on D1 before it was replaced, relayed after, are read on D1 — and can be confirmed", async () => {
  const u = await universe();
  try {
    const f = await withFinding(u);
    await asAgent(async () => {
      await postRound(u.root, { round: { id: "R1", source: "x" }, decisions: [decision("d1", f)] });
      const t = transcript(u.transcripts);
      t.typed("m1", "close it", later(0.02));
      await new Promise((r) => setTimeout(r, 60));
      await postRound(u.root, { round: { id: "R2", source: "x" }, decisions: [{ ...decision("d1b", f, {}, "D7", "R2"), supersedes: "d1" }] });
      const a = (await relayAnswer(u.root, { round: "R1", decision: "d1", session: SESSION, entryId: "m1" }, {}, u.transcripts) as any).answer;
      const view = await decisionRounds(u.root) as any;
      assert.ok(view.awaitingReading.some((x: any) => x.decision === "d1" && x.answer === a), JSON.stringify(view.awaitingReading));
      assert.ok(view.waitingOnYou.some((w: any) => w.decision === "d1" && /given before it was replaced by D7/.test(w.why)));
      assert.match(await briefOf(u.root, a), /^D1: /m, "the brief offers D1: posted before the words, replaced after");
      const c = await confirmReading(u.root, { answer: a, maps: [{ decision: "d1", option: "Not a defect" }] }) as any;
      assert.equal(c.ok, true, JSON.stringify(c));
      assert.equal(c.round, "R1");
    });
  } finally { u.cleanup(); }
});

test("R17 (P2.2 (7)): the holds are built only when a mark is read — once per view — never by a write", async () => {
  const u = await universe();
  try {
    const [f, g] = [await withFinding(u), await withFinding(u)];
    await asAgent(async () => {
      await postRound(u.root, { round: { id: "R1", source: "x" }, decisions: [decision("d1", f), decision("d2", g, {}, "D2")] });
      let n = holdBuilds();
      await decisionsView(u.root);
      assert.equal(holdBuilds() - n, 0, "reading the rows builds nothing");
      transcript(u.transcripts).ask("toolu_1", [payloadFor(f), payloadFor(g, "D2")], { [payloadFor(f).question]: "Not a defect", [payloadFor(g, "D2").question]: "Real, fix it" });
      n = holdBuilds();
      assert.equal(((await logQuestion(u.root, { toolUseId: "toolu_1", round: "R1" }, {}, u.transcripts)) as any).answered.length, 2);
      assert.equal(holdBuilds() - n, 0, "answering two decisions builds nothing");
      n = holdBuilds();
      const round = await decisionRound(u.root, "R1") as any;
      assert.equal(round.held.length, 1, "f is ruled and held; g released");
      assert.equal(holdBuilds() - n, 1, "a caller reading marks builds them once for its view");
    });
  } finally { u.cleanup(); }
});

test("R18 (P2.2 (9)): a round's held list shows every hold on its findings, including one another round places", async () => {
  const u = await universe();
  try {
    const f = await withFinding(u);
    await asAgent(async () => {
      await postRound(u.root, { round: { id: "R1", source: "x" }, decisions: [decision("d1", f)] });
      await postRound(u.root, { round: { id: "R2", source: "x" }, decisions: [decision("d2", f, {}, "D1", "R2")] });
    });
    await asPerson(async () => { await answerDirect(u.root, { decision: "d2", option: "Real, fix it" }); });
    await asAgent(async () => {
      const r2 = await decisionRound(u.root, "R2") as any;
      const row = r2.held.find((h: any) => h.finding === f);
      assert.ok(row && row.held.some((x: any) => x.decision === "d1") && !row.held.some((x: any) => x.decision === "d2"), JSON.stringify(r2.held));
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

// --- the four gates, end to end through the impl-2 plan's paths (its Step 10) ---------------

/** Posted, answered on the page, then the person's typed words that may overturn it: the shape
 *  every confirm starts from. */
async function flaggedRuling(u: Awaited<ReturnType<typeof universe>>, f: string, text = "D1 hmm, maybe it is real") {
  await asAgent(async () => { await postRound(u.root, { round: { id: "R1", source: "x" }, decisions: [decision("d1", f)] }); });
  await asPerson(async () => { await answerDirect(u.root, { decision: "d1", option: "Not a defect" }); });
  let a = "";
  await asAgent(async () => {
    transcript(u.transcripts).typed("m1", text, later(1));
    a = (await relayAnswer(u.root, { round: "R1", decision: "d1", session: SESSION, entryId: "m1" }, {}, u.transcripts) as any).answer;
  });
  return a;
}
/** Every event line in the sidecar outside the decisions log. */
const otherEvents = (side: string): number => {
  let n = 0;
  const walk = (dir: string) => { for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name === ".git" || e.name === "decisions") continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p); else if (e.name.endsWith(".ndjson")) n += readFileSync(p, "utf8").split("\n").filter(Boolean).length;
  } };
  walk(side);
  return n;
};

test("Q2.3 (1) (A1): another clone's differently worded confirm of the same reading is its own decision — a Yes on it binds", async () => {
  const u = await universe();
  try {
    const f = await withFinding(u);
    await asAgent(async () => { await postRound(u.root, { round: { id: "R1", source: "x" }, decisions: [decision("d1", f)] }); });
    await asPerson(async () => { await answerDirect(u.root, { decision: "d1", option: "Not a defect" }); });
    await asAgent(async () => {
      const t = transcript(u.transcripts);
      t.typed("m1", "D1 wait, it is real", later(1));
      const a = (await relayAnswer(u.root, { round: "R1", decision: "d1", session: SESSION, entryId: "m1" }, {}, u.transcripts) as any).answer;
      const maps = [{ decision: "d1", option: "Real, fix it" }];
      const c = await confirmReading(u.root, { answer: a, maps }) as any;
      assert.equal(c.ok, true, JSON.stringify(c));
      assert.equal(c.confirm, confirmId(a, { kind: "options", payload: c.ask, options: c.ask.options.map((o: any) => ({ label: o.label, effects: [] })) }), "the op derives the id from the text it posts");
      // Another clone, on a build that words the confirm differently, posts the same reading.
      const b = bindDecisions(u.root, {});
      if ("error" in b) throw new Error(b.error);
      const payload = { ...c.ask, question: c.ask.question.replace("is that what you meant?", "did you mean this?") };
      const posted = { round: "R1", ref: c.ref, kind: "options" as const, payload, options: payload.options.map((o: any) => ({ label: o.label, effects: [] })), confirms: { answer: a, readings: [maps] } };
      const other = { id: confirmId(a, posted), ...posted };
      assert.notEqual(other.id, c.confirm);
      await postConfirmEvent(b.cfg.path, b.cfg.universe, b.actor, other);
      t.ask("toolu_o", [payload], { [payload.question]: "Yes" }, later(2));
      await logQuestion(u.root, { toolUseId: "toolu_o", round: "R1" }, {}, u.transcripts);
      const round = await decisionRound(u.root, "R1") as any;
      const d = round.decisions.find((x: any) => x.id === "d1");
      assert.equal(d.standing.id, a, JSON.stringify(round.decisions.map((x: any) => [x.id, x.answers.length, x.confirm])));
      assert.ok(d.standing.ruled.some((x: any) => x.finding === f && x.on === "unblock"));
      assert.equal(round.decisions.find((x: any) => x.id === other.id)?.confirm.state, "answered");
    });
  } finally { u.cleanup(); }
});

test("GATE (impl-2, overwritten): a confirm's Yes on words older than a later pick leaves the pick standing", async () => {
  const u = await universe();
  try {
    const f = await withFinding(u);
    const a = await flaggedRuling(u, f);
    let c: any;
    await asAgent(async () => { c = await confirmReading(u.root, { answer: a, maps: [{ decision: "d1", option: "Real, fix it" }] }); assert.equal(c.ok, true, JSON.stringify(c)); });
    await new Promise((r) => setTimeout(r, 1100));   // the click comes after the words were typed
    await asPerson(async () => { await answerDirect(u.root, { decision: "d1", option: "Not a defect" }); });
    await asAgent(async () => {
      transcript(u.transcripts).ask("toolu_c", [c.ask], { [c.ask.question]: "Yes" }, later(2));
      await logQuestion(u.root, { toolUseId: "toolu_c", round: "R1" }, {}, u.transcripts);
      const d = (await decisionRound(u.root, "R1") as any).decisions.find((x: any) => x.id === "d1");
      assert.equal(d.standing.via, "direct", JSON.stringify(d.standing));
      assert.ok(d.standing.ruled.some((x: any) => x.finding === f && x.on === "settle"), "the later pick stands");
    });
  } finally { u.cleanup(); }
});

test("GATE (impl-2, closed unseen): no confirm path writes a findings event", async () => {
  const u = await universe();
  try {
    const f = await withFinding(u);
    const a = await flaggedRuling(u, f);
    const before = otherEvents(u.side);
    await asAgent(async () => {
      const c = await confirmReading(u.root, { answer: a, maps: [{ decision: "d1", option: "Not a defect" }] }) as any;
      transcript(u.transcripts).ask("toolu_c", [c.ask], { [c.ask.question]: "Yes" }, later(2));
      await logQuestion(u.root, { toolUseId: "toolu_c", round: "R1" }, {}, u.transcripts);
      assert.ok((await decisionRound(u.root, "R1") as any).decisions.find((x: any) => x.id === "d1").standing.confirmed, "the Yes bound");
    });
    assert.equal(otherEvents(u.side), before, "nothing outside the decisions log was written");
    assert.equal((await readFinding(u.root, f))?.state, "issued");
  } finally { u.cleanup(); }
});

test("GATE (impl-2, held offered as work): an open confirm withholds its findings — against an assignment made before it (P3.5) — and a two-pick verdict leaves one held", async () => {
  const u = await universe();
  try {
    const [f, g] = [await withFinding(u), await withFinding(u)];
    await asAgent(async () => { await postRound(u.root, { round: { id: "R1", source: "x" }, decisions: [decision("d1", f), decision("d2", g, {}, "D2")] }); });
    await asPerson(async () => {
      await answerDirect(u.root, { decision: "d1", option: "Real, fix it" });   // releases f as fix work
      await reassignFinding(u.root, 7, f, { kind: "fix" });
    });
    let a = "";
    await asAgent(async () => {
      assert.ok((await reviewQueue(u.root) as any).queue.some((x: any) => x.id === f), "released and assigned by a person: offered");
      const t = transcript(u.transcripts);
      t.typed("m1", "D1 wait — not a defect after all", later(1));
      a = (await relayAnswer(u.root, { round: "R1", decision: "d1", session: SESSION, entryId: "m1" }, {}, u.transcripts) as any).answer;
      assert.ok((await reviewQueue(u.root) as any).queue.some((x: any) => x.id === f), "flagged only: a mark never withholds");
      const c = await confirmReading(u.root, { answer: a, maps: [{ decision: "d1", option: "Not a defect" }] }) as any;
      assert.equal(c.ok, true, JSON.stringify(c));
      const q = await reviewQueue(u.root) as any;
      assert.ok(!q.queue.some((x: any) => x.id === f), "the confirm's hold began after the assignment: withheld");

      t.typed("m2", "D2 both, I guess", later(1));
      const b2 = (await relayAnswer(u.root, { round: "R1", decision: "d2", session: SESSION, entryId: "m2" }, {}, u.transcripts) as any).answer;
      const r = nextReader(); t.reader(r, "D2 → Not a defect\nD2 → Real, fix it", { prompt: await briefOf(u.root, b2) });
      const read = await recordReading(u.root, { answer: b2, reader: r, session: { maps: [{ decision: "d2", option: "Not a defect" }] } }, {}, u.transcripts) as any;
      assert.match(String(read.unverified), /takes one option, and the reading picks 2/, JSON.stringify(read));
      const all = await reviewQueue(u.root, { assignedOnly: false }) as any;
      assert.equal(all.queue.find((x: any) => x.id === g)?.held?.[0]?.why, "undecided");
    });
  } finally { u.cleanup(); }
});

test("GATE (impl-2, vanishing): a rejected first reading strands nothing, an empty one consumes nothing, and a confirm whose words were cut stays listed", async () => {
  const u = await universe();
  try {
    const f = await withFinding(u);
    await asAgent(async () => {
      await postRound(u.root, { round: { id: "R1", source: "x" }, decisions: [decision("d1", f)] });
      const t = transcript(u.transcripts);
      t.typed("m1", "not a defect", later(5));   // typed after a replacement another clone posts below
      const a = (await relayAnswer(u.root, { round: "R1", decision: "d1", session: SESSION, entryId: "m1" }, {}, u.transcripts) as any).answer;
      const prompt = await briefOf(u.root, a);
      const b = bindDecisions(u.root) as any;
      // A foreign writer's reading of the words, one that could never bind, and an empty one.
      await recordReadingEvent(b.cfg.path, b.cfg.universe, b.actor, { answer: a, session: { maps: [{ decision: "d9", option: null }] }, reader: { agent: "aFOREIGN000000001", verdict: [{ decision: "d9", option: null }], launchedAt: later(6), brief: prompt, verified: { session: SESSION, toolUseId: "t" } } });
      await recordReadingEvent(b.cfg.path, b.cfg.universe, b.actor, { answer: a, session: { maps: [] }, reader: { agent: "aFOREIGN000000002", verdict: [], launchedAt: later(6), brief: prompt, verified: { session: SESSION, toolUseId: "t" } } });
      let view = await decisionRounds(u.root) as any;
      assert.ok(view.awaitingReading.some((x: any) => x.answer === a), "the words still wait for a reader");
      const c = await confirmReading(u.root, { answer: a, maps: [{ decision: "d1", option: "Not a defect" }] }) as any;
      assert.equal(c.ok, true, JSON.stringify(c));
      // Another clone's replacement of D1, posted before the words were typed, arrives: the words are cut.
      await postRound(u.root, { round: { id: "R2", source: "x" }, decisions: [{ ...decision("d1b", f, {}, "D7", "R2"), supersedes: "d1" }] });
      const round = await decisionRound(u.root, "R1") as any;
      assert.equal(round.decisions.find((x: any) => x.id === c.confirm)?.confirm.state, "no longer needed", JSON.stringify(round.decisions.map((x: any) => x.confirm)));
      view = await decisionRounds(u.root) as any;
      assert.ok(!view.waitingOnYou.some((w: any) => w.decision === c.confirm), "it waits on nobody");
    });
  } finally { u.cleanup(); }
});

