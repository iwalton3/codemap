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
import { shareFinding, closeFinding, bindDecisions, reassignFinding, sharedFindings, sharedSync } from "./ops-shared.js";
import { reviewQueue } from "./ops/annotations.js";
import { postRound, postPrevalidated, logQuestion, relayAnswer, answerDirect, decisionRounds, decisionRound, decisionStatus, waitDecisionStatus, nominateComparison, readerBrief, recordReading, submitVerdict as submitVerdictOp, confirmReading, parseVerdict, confirmId } from "./ops/decisions.js";
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
const fixtureReceipts = new Map<string, string[]>();
const receiptKey = (dir: string, answer: string, verdict: string) => `${dir}\0${answer}\0${verdict}`;
const attachFixtureReceipt = (dir: string, answer: string, verdict: string, receipt: string): boolean => {
  for (const session of readdirSync(dir)) {
    const sub = join(dir, session, "subagents");
    let files: string[] = [];
    try { files = readdirSync(sub).filter((x) => x.endsWith(".jsonl")).map((x) => join(sub, x)); } catch { /* no subagents */ }
    if (session.endsWith(".jsonl")) files.push(join(dir, session));
    for (const file of files) {
      const lines: any[] = readFileSync(file, "utf8").trim().split("\n").map((x) => JSON.parse(x));
      const call = lines.find((e) => e.type === "assistant" && Array.isArray(e.message?.content) && e.message.content.some((b: any) => b.type === "tool_use" && b.name.endsWith("submit_verdict") && b.input?.answer === answer && b.input?.verdict === verdict));
      if (!call) continue;
      const id = call.message.content.find((b: any) => b.name?.endsWith("submit_verdict")).id;
      const result = lines.find((e) => e.type === "user" && Array.isArray(e.message?.content) && e.message.content.some((b: any) => b.tool_use_id === id && b.content === "held"));
      if (!result) continue;
      result.message.content.find((b: any) => b.tool_use_id === id).content = JSON.stringify({ ok: true, held: true, receipt });
      writeFileSync(file, lines.map((x) => JSON.stringify(x)).join("\n") + "\n");
      return true;
    }
  }
  return false;
};
const submitVerdict: typeof submitVerdictOp = async (root, input, via, dir) => {
  const result = await submitVerdictOp(root, input, via, dir);
  if ((result as any).held && (result as any).receipt && dir) {
    const receipt = (result as any).receipt as string;
    if (!attachFixtureReceipt(dir, input.answer, input.verdict, receipt)) {
      const key = receiptKey(dir, input.answer, input.verdict);
      fixtureReceipts.set(key, [...(fixtureReceipts.get(key) ?? []), receipt]);
    }
  }
  return result;
};
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
  const sentInto = (text: string, uuid: string) => ({ type: "user", uuid, isSidechain: true, agentId: "", sessionId: session, origin: { kind: "coordinator" }, message: { role: "user", content: `The coordinator sent a message while you were working:\n${text}` } });
  const file = join(dir, `${session}.jsonl`);
  const write = () => {
    let prior: any[] = [];
    try { prior = readFileSync(file, "utf8").trim().split("\n").map((x) => JSON.parse(x)); } catch { /* first write */ }
    const receipts = new Map<string, string>();
    for (const e of prior) for (const b of Array.isArray(e.message?.content) ? e.message.content : [])
      if (b.type === "tool_result" && typeof b.content === "string" && b.content.includes('"receipt"')) receipts.set(b.tool_use_id, b.content);
    for (const e of lines) for (const b of Array.isArray((e as any).message?.content) ? (e as any).message.content : [])
      if (b.type === "tool_result" && receipts.has(b.tool_use_id)) b.content = receipts.get(b.tool_use_id);
    writeFileSync(file, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
  };
  return {
    ask(toolUseId: string, questions: object[], answers: Record<string, string | string[]>, when = later()) {
      lines.push({ type: "assistant", uuid: `a-${toolUseId}`, isSidechain: false, timestamp: when, message: { content: [{ type: "tool_use", id: toolUseId, name: "AskUserQuestion", input: { questions } }] } });
      lines.push({ type: "user", uuid: `r-${toolUseId}`, isSidechain: false, timestamp: when, sourceToolAssistantUUID: `a-${toolUseId}`, message: { content: [{ type: "tool_result", tool_use_id: toolUseId, content: "…" }] }, toolUseResult: { questions, answers } });
      write();
    },
    /** The session itself calling `submit_verdict` — not a reader. */
    submits(answer: string, verdict: string) {
      const id = `toolu_main_${lines.length}`;
      lines.push({ type: "assistant", uuid: `sv-${lines.length}`, isSidechain: false, timestamp: nextStamp(), message: { content: [{ type: "tool_use", id, name: "mcp__codemap__submit_verdict", input: { answer, verdict } }] } });
      lines.push({ type: "user", uuid: `svr-${lines.length}`, isSidechain: false, message: { content: [{ type: "tool_result", tool_use_id: id, content: "held" }] } });
      write();
    },
    typed(uuid: string, text: string, when = later()) {
      lines.push({ type: "user", uuid, isSidechain: false, timestamp: when, origin: { kind: "human" }, message: { role: "user", content: text } });
      write();
    },
    /** A reader subagent launched with `prompt` at `launchedAt`, and — unless `running` — handed
     *  back `report`. With `answer`, it called `submit_verdict` with `report` as its verdict first.
     *  `fork` records it as the harness records a fork; `sent`/`sentAfter`, a message sent into it
     *  before or after that call. */
    reader(agentId: string, report: string, opts: { launchedAt?: string; running?: boolean; prompt?: string; fork?: boolean; sent?: string; answer?: string; sentAfter?: string } = {}) {
      const sub = join(dir, session, "subagents");
      mkdirSync(sub, { recursive: true });
      const call = `toolu_${agentId}`;
      writeFileSync(join(sub, `agent-${agentId}.meta.json`), JSON.stringify({ agentType: opts.fork ? "fork" : "general-purpose", ...(opts.fork ? { isFork: true } : {}), toolUseId: call }));
      const key = opts.answer ? receiptKey(dir, opts.answer, report) : "";
      const queued = fixtureReceipts.get(key) ?? [];
      const receipt = queued.shift();
      if (receipt) fixtureReceipts.set(key, queued);
      writeFileSync(join(sub, `agent-${agentId}.jsonl`), [
        { type: "user", uuid: "s1", isSidechain: true, agentId, sessionId: session, message: { role: "user", content: opts.prompt ?? "read this" } },
        // Measured 2026-09-24: the harness's own reminder, right after launch — not a message sent in.
        { type: "user", uuid: "s1m", isSidechain: true, agentId, sessionId: session, isMeta: true, message: { role: "user", content: "<system-reminder>\nYour final report is delivered through SubagentHandback.\n</system-reminder>" } },
        ...(opts.sent ? [{ ...sentInto(opts.sent, "s1b"), agentId }] : []),
        ...(opts.answer ? [
          { type: "assistant", uuid: "sv", isSidechain: true, agentId, sessionId: session, timestamp: nextStamp(), message: { content: [{ type: "tool_use", id: `toolu_sv_${agentId}`, name: "mcp__codemap__submit_verdict", input: { answer: opts.answer, verdict: report } }] } },
          { type: "user", uuid: "svr", isSidechain: true, agentId, sessionId: session, message: { content: [{ type: "tool_result", tool_use_id: `toolu_sv_${agentId}`, content: receipt ? JSON.stringify({ ok: true, held: true, receipt }) : "held" }] } },
        ] : []),
        ...(opts.sentAfter ? [{ ...sentInto(opts.sentAfter, "s2b"), agentId }] : []),
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
/** The prompt codemap issues for reading `answer`, taking `maps` as your reading — what an honest reader is launched with. */
const briefOf = async (root: string, answer: string, maps: { decision: string; option: string | null }[]) => {
  const r = await readerBrief(root, { answer, maps }) as { prompt?: string; error?: string };
  if (!r.prompt) throw new Error(`reader_brief refused: ${r.error}`);
  return r.prompt;
};
let stamps = 0;
/** Each call's own time, in the order made. */
const nextStamp = () => new Date(Date.now() + 10_000 + ++stamps * 10).toISOString();
/** A reader launched with `opts.prompt` that calls `submit_verdict` with `verdict` itself — on
 *  disk as the harness leaves it once the call returns — and then the next call records it. */
async function reads(u: { root: string; transcripts: string }, t: ReturnType<typeof transcript>, answer: string, verdict: string, opts: Parameters<ReturnType<typeof transcript>["reader"]>[2] & { agentId?: string } = {}) {
  const id = opts.agentId ?? nextReader();
  t.reader(id, verdict, { ...opts, answer });
  const held = await submitVerdict(u.root, { answer, verdict }, {}, u.transcripts) as any;
  return { id, held, rec: await recordReading(u.root, { answer }, {}, u.transcripts) as any };
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
      const prompt = await briefOf(u.root, r.answer, [{ decision: "d1", option: "Real, fix it" }]);
      const read = (await reads(u, t, r.answer, "They typed 'D1 B', the second option.\n\nD1 → Real, fix it", { prompt })).rec;
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
      assert.match(String(err(await readerBrief(u.root, { answer: un.answer, maps: [{ decision: "d1", option: "Real, fix it" }] }))), /never read/);

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

test("B1 + B2 (Q2.2): the reader's verdict is its own submit_verdict call — one that does not parse or bind is not held; one that came too early, or from an echo, is never recorded", async () => {
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

      assert.match(String((await submitVerdict(u.root, { answer: a1, verdict: "D1 → Not a defect" }, {}, u.transcripts) as any).refused), /no reader_brief was issued/);
      const prompt = await briefOf(u.root, a1, mine);
      assert.match(String((await recordReading(u.root, { answer: a1 }, {}, u.transcripts) as any).note), /no verdict is held/, "a reader that has not submitted has nothing to record");
      for (const [report, re] of [["I think they meant not a defect", /does not end with a verdict/], ["D1 → Not a bug", /not an option of D1/], ["D9 → Real, fix it", /not a question the reader.s brief listed for round R1/], ["unclear: two open\nD1 → Not a defect", /both unclear and a mapping/]] as const) {
        const r = await submitVerdict(u.root, { answer: a1, verdict: report }, {}, u.transcripts) as any;
        assert.ok(re.test(String(r.refused)) && /not held/.test(r.note), `${report}: ${JSON.stringify(r)}`);
      }
      const early = await reads(u, t, a1, "D1 → Not a defect", { launchedAt: new Date(Date.now() - 60_000).toISOString(), prompt });
      assert.match(JSON.stringify(early.rec.invalid), /before the words were typed/);
      // ops1 part A: the reader said "Real, fix it"; your reading was "Not a defect". It binds nothing.
      const honest = await reads(u, t, a1, "Reading the words in context.\n\nD1 -> Real, fix it", { prompt });
      assert.equal(honest.rec.agree, false, JSON.stringify(honest.rec));
      assert.deepEqual(honest.rec.reader, [{ decision: "d1", option: "Real, fix it" }], "the reader's own mapping, parsed — never the session's copy");
      const view = await decisionRounds(u.root) as any;
      assert.ok(view.readingsInDispute.some((x: any) => x.decision === "d1"));
      assert.ok(!view.ruledNotCarriedOut.some((x: any) => x.finding === f), "nothing bound");
      // One reader reads one answer: the same reader's call for another answer does not carry its brief.
      await briefOf(u.root, a2, [{ decision: "d2", option: "Real, fix it" }]);
      const again = await reads(u, t, a2, "D2 → Real, fix it", { prompt, agentId: honest.id });
      assert.match(JSON.stringify(again.rec.invalid), /not launched with the brief issued/);
      assert.deepEqual(parseVerdict("D2 → (none)", (await decisionRound(u.root, "R1") as any).decisions, "R1"), { maps: [{ decision: "d2", option: null }] });
    });
  } finally { u.cleanup(); }
});


/** Words on d1 relayed, and your reading taken with the brief: "Not a defect". */
async function wordsWithBrief(u: Awaited<ReturnType<typeof universe>>) {
  const f = await withFinding(u);
  await postRound(u.root, { round: { id: "R1", source: "x" }, decisions: [decision("d1", f)] });
  const t = transcript(u.transcripts);
  t.typed("m1", "hmm, that one", later(1));
  const a = (await relayAnswer(u.root, { round: "R1", decision: "d1", session: SESSION, entryId: "m1" }, {}, u.transcripts) as any).answer as string;
  const mine = [{ decision: "d1", option: "Not a defect" }];
  return { f, t, a, mine, prompt: await briefOf(u.root, a, mine) };
}

test("a direct answer settles an already held reader verdict before recording the new answer", async () => {
  const u = await universe();
  try {
    await asAgent(async () => {
      const { t, a, prompt } = await wordsWithBrief(u);
      t.reader(nextReader(), "D1 → Not a defect", { prompt, answer: a });
      const held = await submitVerdict(u.root, { answer: a, verdict: "D1 → Not a defect" }, {}, u.transcripts) as any;
      assert.equal(held.held, true);
      const before = await decisionRound(u.root, "R1") as any;
      assert.equal(before.decisions[0].answers.find((x: any) => x.id === a).reading, undefined);
      await withEnv({ CODEMAP_TRANSCRIPT_DIR: u.transcripts, CODEMAP_AGENT_MODEL: undefined }, async () => {
        const direct = await answerDirect(u.root, { decision: "d1", option: "Real, fix it" }) as any;
        assert.equal(direct.ok, true, JSON.stringify(direct));
      });
      const after = await decisionRound(u.root, "R1") as any;
      const d = after.decisions[0];
      assert.equal(d.answers.find((x: any) => x.id === a).reading?.agree, true);
      assert.equal(d.standing.id, a, "the verified earlier words keep their actual given time, later than the page pick");
    });
  } finally { u.cleanup(); }
});

test("Q2.2 (a, b): the first reader's verdict counts — a second reader is refused, and your reading cannot change after the brief", async () => {
  const u = await universe();
  try {
    await asAgent(async () => {
      const { t, a, mine, prompt } = await wordsWithBrief(u);
      assert.equal(await briefOf(u.root, a, mine), prompt, "asked again, the same brief");
      assert.match(String(err(await readerBrief(u.root, { answer: a, maps: [{ decision: "d1", option: "Real, fix it" }] }))), /cannot change/);
      const x = nextReader(); t.reader(x, "D1 → Real, fix it", { prompt, answer: a });
      assert.equal((await submitVerdict(u.root, { answer: a, verdict: "D1 → Real, fix it" }, {}, u.transcripts) as any).held, true);
      // The agent dislikes it and launches another reader, which agrees with it.
      const y = nextReader(); t.reader(y, "D1 → Not a defect", { prompt, answer: a });
      const second = await submitVerdict(u.root, { answer: a, verdict: "D1 → Not a defect" }, {}, u.transcripts) as any;
      assert.match(String(second.refused), /already read/, JSON.stringify(second));
      const rec = await recordReading(u.root, { answer: a }, {}, u.transcripts) as any;
      assert.ok(rec.recorded && !rec.agree && rec.reader[0].option === "Real, fix it", JSON.stringify(rec));
    });
  } finally { u.cleanup(); }
});

test("Q2.2 (b2, b3): a message after the reader submitted leaves it verified; a verdict whose call is not on disk yet keeps its place", async () => {
  const u = await universe();
  try {
    await asAgent(async () => {
      const { t, a, prompt } = await wordsWithBrief(u);
      // X submits; its call reaches the transcript only after it returns, so it is not there yet.
      const x = nextReader();
      assert.equal((await submitVerdict(u.root, { answer: a, verdict: "D1 → Real, fix it" }, {}, u.transcripts) as any).held, true);
      const y = nextReader(); t.reader(y, "D1 → Not a defect", { prompt, answer: a });
      assert.equal((await submitVerdict(u.root, { answer: a, verdict: "D1 → Not a defect" }, {}, u.transcripts) as any).held, true);
      assert.equal((await recordReading(u.root, { answer: a }, {}, u.transcripts) as any).pending, true, "Y waits behind X");
      assert.ok((await decisionRounds(u.root) as any).awaitingReading.some((w: any) => w.answer === a && /verdict is held/.test(w.verdict)));
      t.reader(x, "D1 → Real, fix it", { prompt, answer: a, sentAfter: "thanks — was it Not a defect?" });
      const rec = await recordReading(u.root, { answer: a }, {}, u.transcripts) as any;
      assert.ok(rec.recorded && rec.reader[0].option === "Real, fix it", JSON.stringify(rec));
    });
  } finally { u.cleanup(); }
});

test("Q2.2 (c): the session's own submit_verdict is not a reader's — it is discarded and the reader's is recorded; one never found expires", async () => {
  const u = await universe();
  try {
    await asAgent(async () => {
      const { t, a, prompt } = await wordsWithBrief(u);
      t.submits(a, "D1 → Real, fix it");
      await submitVerdict(u.root, { answer: a, verdict: "D1 → Real, fix it" }, {}, u.transcripts);
      const r = await reads(u, t, a, "D1 → Not a defect", { prompt });
      assert.ok(r.rec.recorded && r.rec.agree, JSON.stringify(r));

    });
  } finally { u.cleanup(); }
  const v = await universe();
  try {
    await asAgent(async () => {
      const w = await wordsWithBrief(v);
      await submitVerdict(v.root, { answer: w.a, verdict: "D1 → Not a defect" }, {}, v.transcripts);
      await withEnv({ CODEMAP_VERDICT_GRACE_MS: "0" }, async () => {
        const rec = await recordReading(v.root, { answer: w.a }, {}, v.transcripts) as any;
        assert.match(JSON.stringify(rec.invalid), /not found/, JSON.stringify(rec));
      });
    });
  } finally { v.cleanup(); }
});

test("ambiguous legacy held calls stay unverified and block a later receipt row", async () => {
  const u = await universe();
  try {
    await asAgent(async () => {
      const { t, a, prompt } = await wordsWithBrief(u);
      const verdict = "D1 → Not a defect";
      t.reader(nextReader(), verdict, { prompt, answer: a });
      t.reader(nextReader(), verdict, { prompt, answer: a });
      openDb(u.root).prepare("INSERT INTO reader_verdicts(answer, verdict, held_at, state) VALUES(?, ?, ?, 'pending')")
        .run(a, verdict, "2026-09-23T00:00:00Z");
      await withEnv({ CODEMAP_VERDICT_GRACE_MS: "0" }, async () => {
        const first = await recordReading(u.root, { answer: a }, {}, u.transcripts) as any;
        assert.equal(first.legacyUnverified, true, JSON.stringify(first));
        assert.match(first.note, /multiple successful-held calls.*re-ask/);
        const newer = await submitVerdictOp(u.root, { answer: a, verdict }, {}, u.transcripts) as any;
        assert.equal(newer.held, true);
        const still = await recordReading(u.root, { answer: a }, {}, u.transcripts) as any;
        assert.equal(still.legacyUnverified, true, JSON.stringify(still));
        assert.ok((await decisionRounds(u.root) as any).awaitingReading.some((w: any) => w.answer === a && /multiple successful-held calls/.test(w.verdict)));
      });
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
      assert.match(String(err(await readerBrief(u.root, { answer: a, maps: [] }))), /at least one line/);
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
      await postRound(u.root, { round: { id: "R1", source: "x" }, decisions: [decision("d1", f), decision("d2", g, {}, "D2"), decision("d3", f, {}, "D3")] });
      await new Promise((r) => setTimeout(r, 30));
      await postRound(u.root, { round: { id: "R2", source: "x" }, decisions: [{ ...decision("d2b", g, {}, "D9", "R2"), supersedes: "d2" }] });
      const t = transcript(u.transcripts);
      t.typed("m1", "D2 is real", later(1));
      t.typed("m2", "D3 is not a defect", later(1));
      const a1 = (await relayAnswer(u.root, { round: "R1", decision: "d1", session: SESSION, entryId: "m1" }, {}, u.transcripts) as any).answer;
      const a2 = (await relayAnswer(u.root, { round: "R1", decision: "d3", session: SESSION, entryId: "m2" }, {}, u.transcripts) as any).answer;
      const brief1 = await briefOf(u.root, a1, [{ decision: "d1", option: "Real, fix it" }]);
      const x = nextReader();
      // A foreign writer's reading of a1 by x, naming D2 — replaced before the words were typed.
      const b = bindDecisions(u.root) as any;
      await recordReadingEvent(b.cfg.path, b.cfg.universe, b.actor, { answer: a1, session: { maps: [{ decision: "d2", option: "Real, fix it" }] }, reader: { agent: x, verdict: [{ decision: "d2", option: "Real, fix it" }], launchedAt: later(3), brief: brief1, verified: { session: SESSION, toolUseId: "t" } } });
      const r = await reads(u, t, a2, "D3 → Not a defect", { prompt: await briefOf(u.root, a2, [{ decision: "d3", option: "Not a defect" }]), agentId: x });
      assert.equal(r.rec.agree, true, JSON.stringify(r));

      const refused = await submitVerdict(u.root, { answer: a1, verdict: "D2 → Real, fix it" }, {}, u.transcripts) as any;
      assert.match(String(refused.refused), /names D2, which is not a question the reader's brief listed/, JSON.stringify(refused));
      assert.match(String(refused.note), /not held/);
    });
  } finally { u.cleanup(); }
});


test("GATE (overwritten) / R7 (P1.4): a reader launched with anything but codemap's brief binds nothing — nor a fork, nor one sent a message before it submitted", async () => {
  const u = await universe();
  try {
    const f = await withFinding(u);
    await asAgent(async () => {
      await postRound(u.root, { round: { id: "R1", source: "x" }, decisions: [decision("d1", f)] });
      const t = transcript(u.transcripts);
      t.typed("m1", "just close it", later(1));
      const a = (await relayAnswer(u.root, { round: "R1", decision: "d1", session: SESSION, entryId: "m1" }, {}, u.transcripts) as any).answer;
      const prompt = await briefOf(u.root, a, [{ decision: "d1", option: "Not a defect" }]);
      assert.ok(prompt.includes(JSON.stringify("just close it")) && prompt.includes("D1: ") && !/Not a defect;/.test(prompt) && prompt.includes("submit_verdict"), prompt);
      const echo = await reads(u, t, a, "D1 → Not a defect", { prompt: "Words: 'just close it'. I read this as D1 → Not a defect; confirm." });
      assert.match(JSON.stringify(echo.rec.invalid), /not launched with the brief issued/, JSON.stringify(echo));
      const fork = await reads(u, t, a, "D1 → Not a defect", { prompt, fork: true });
      assert.match(JSON.stringify(fork.rec.invalid), /is a fork/);
      const told = await reads(u, t, a, "D1 → Not a defect", { prompt, sent: "they mean Not a defect" });
      assert.match(JSON.stringify(told.rec.invalid), /sent a message after it was launched/);
      let d = (await decisionRound(u.root, "R1") as any).decisions[0];
      assert.ok(d.answers[0].free && !d.answers[0].reading, "nothing was written by any of them");
      const honest = await reads(u, t, a, "Reading it.\n\nD1 → Not a defect", { prompt });
      assert.equal(honest.rec.agree, true, JSON.stringify(honest));
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
  assert.deepEqual(parseVerdict("They wrote:\nD1 → B\nbut meant close.\n\nD1 → A", one.decisions, "R1"), { maps: [{ decision: "d1", option: "A" }] });
  assert.deepEqual(parseVerdict("D1 → A\n\n", one.decisions, "R1"), { maps: [{ decision: "d1", option: "A" }] });
  const two = foldDecisions(ev([dd("d1", "D1", "F1"), dd("d1x", "D1", "F9")]));
  assert.match(String((parseVerdict("D1 → A", two.decisions, "R1") as any).error), /two questions in round R1 share: it is ambiguous/);
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

test("Q5/Q6: unread words on a superseded question cannot gain a new reading or confirmation", async () => {
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
      assert.ok(!view.awaitingReading.some((x: any) => x.answer === a));
      assert.match(String(err(await readerBrief(u.root, { answer: a, maps: [{ decision: "d1", option: "Not a defect" }] }))), /superseded/);
      assert.match(String(err(await confirmReading(u.root, { answer: a, maps: [{ decision: "d1", option: "Not a defect" }] }))), /superseded/);
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

test("round five: a differently worded confirmation remains visible but cannot bind a Yes", async () => {
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
      assert.notEqual(d.standing.id, a, JSON.stringify(round.decisions.map((x: any) => [x.id, x.answers.length, x.confirm])));
      assert.ok(d.standing.ruled.some((x: any) => x.finding === f && x.on === "settle"));
      assert.equal(round.decisions.find((x: any) => x.id === other.id)?.confirm.state, "unverifiable");
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
      await briefOf(u.root, b2, [{ decision: "d2", option: "Not a defect" }]);
      const read = await submitVerdict(u.root, { answer: b2, verdict: "D2 → Not a defect\nD2 → Real, fix it" }, {}, u.transcripts) as any;
      assert.match(String(read.refused), /takes one option, and the reading picks 2/, JSON.stringify(read));
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
      const prompt = await briefOf(u.root, a, [{ decision: "d1", option: "Not a defect" }]);
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
      assert.ok(!view.waitingOnYou.some((w: any) => w.decision === c.confirm), "an unread superseded question cannot gain a new interpretation");
    });
  } finally { u.cleanup(); }
});


// --- the four gates, end to end through the Codex round's paths (its Step 9) ----------------

const tick = () => new Promise((r) => setTimeout(r, 25));
/** A posted confirm like `c`, as another clone would post it: `edit` its text, then its own id. */
const otherClone = (c: any, a: string, readings: any[][], edit: (q: string) => string, ref = c.ref) => {
  const payload = { ...c.ask, question: edit(c.ask.question) };
  const posted = { round: "R1", ref, kind: "options" as const, payload, options: payload.options.map((o: any) => ({ label: o.label, effects: [] })), confirms: { answer: a, readings } };
  return { id: confirmId(a, posted), ...posted };
};
const bound = (u: { root: string }) => { const b = bindDecisions(u.root); if ("error" in b) throw new Error(b.error); return b; };

test("GATE (codex round, overwritten): a Yes survives another clone's wording and a pulled same-numbered question; a second reader cannot bind after a first verdict is held", async () => {
  const u = await universe();
  try {
    const f = await withFinding(u);
    const a = await flaggedRuling(u, f);
    await asAgent(async () => {
      const maps = [{ decision: "d1", option: "Real, fix it" }];
      const c = await confirmReading(u.root, { answer: a, maps }) as any;
      assert.equal(c.confirm, confirmId(a, { kind: "options", payload: c.ask, options: c.ask.options.map((o: any) => ({ label: o.label, effects: [] })) }));
      const b = bound(u);
      await postConfirmEvent(b.cfg.path, b.cfg.universe, b.actor, otherClone(c, a, [maps], (q) => q.replace("is that what you meant?", "did you mean this?")));
      transcript(u.transcripts).ask("toolu_c", [c.ask], { [c.ask.question]: "Yes" }, later(2));
      await logQuestion(u.root, { toolUseId: "toolu_c", round: "R1" }, {}, u.transcripts);
      // A pull brings another clone's question numbered D1 — the ref the Yes acted on.
      await postConfirmEvent(b.cfg.path, b.cfg.universe, b.actor, otherClone(c, a, [maps], (q) => q.replace(/^D2:/, "D1:").replace("is that", "was that"), "D1"));
      const d = (await decisionRound(u.root, "R1") as any).decisions.find((x: any) => x.id === "d1");
      assert.equal(d.standing.id, a, JSON.stringify(d.standing));
      assert.ok(d.standing.ruled.some((x: any) => x.finding === f && x.on === "unblock"));
    });
  } finally { u.cleanup(); }
  const v = await universe();
  try {
    await asAgent(async () => {
      const { t, a, prompt } = await wordsWithBrief(v);
      await submitVerdict(v.root, { answer: a, verdict: "D1 → Real, fix it" }, {}, v.transcripts);   // not on disk yet
      const x = nextReader();
      const second = await reads(v, t, a, "D1 → Not a defect", { prompt });
      assert.ok(second.held.held && second.rec.pending, JSON.stringify(second));
      t.reader(x, "D1 → Real, fix it", { prompt, answer: a });
      const rec = await recordReading(v.root, { answer: a }, {}, v.transcripts) as any;
      assert.ok(rec.recorded && rec.reader[0].option === "Real, fix it", JSON.stringify(rec));
    });
  } finally { v.cleanup(); }
});

test("GATE (codex round, closed unseen): reading, submitting, recording and confirming write no findings event", async () => {
  const u = await universe();
  try {
    const f = await withFinding(u);
    const a = await flaggedRuling(u, f);
    const before = otherEvents(u.side);
    await asAgent(async () => {
      const t = transcript(u.transcripts);
      const prompt = await briefOf(u.root, a, [{ decision: "d1", option: "Not a defect" }]);
      const r = await reads(u, t, a, "D1 → (none)", { prompt });
      assert.ok(r.rec.recorded && !r.rec.agree, JSON.stringify(r));
      const c = await confirmReading(u.root, { answer: a }) as any;
      assert.equal(c.ok, true, JSON.stringify(c));
      t.ask("toolu_c", [c.ask], { [c.ask.question]: "Reading 1" }, later(2));
      await logQuestion(u.root, { toolUseId: "toolu_c", round: "R1" }, {}, u.transcripts);
    });
    assert.equal(otherEvents(u.side), before, "nothing outside the decisions log was written");
    assert.equal((await readFinding(u.root, f))?.state, "issued");
  } finally { u.cleanup(); }
});

test("GATE (codex round, held offered as work): a (none) confirm holds, a finding a replacement drops stays held until it rules, and a No stays answered after later Other words", async () => {
  const heldOn = async (root: string, id: string) => ((await reviewQueue(root, { assignedOnly: false }) as any).queue.find((x: any) => x.id === id)?.held ?? []) as any[];
  const u = await universe();
  try {
    const [f, g] = [await withFinding(u), await withFinding(u)];
    const two = { id: "d1", round: "R1", ref: "D1", kind: "options" as const, payload: { question: `D1: are ${f} and ${g} real defects?`, header: "F", options: [{ label: "Not a defect", description: "d" }, { label: "Real, fix it", description: "d" }] },
      options: [{ label: "Not a defect", effects: [{ findings: [f, g], on: "settle" as const, as: "refuted" as const }] }, { label: "Real, fix it", effects: [{ findings: [f, g], on: "unblock" as const }] }] };
    await asAgent(async () => { await postRound(u.root, { round: { id: "R1", source: "x" }, decisions: [two] }); });
    await asPerson(async () => { await answerDirect(u.root, { decision: "d1", option: "Real, fix it" }); });
    await asAgent(async () => {
      transcript(u.transcripts).typed("m1", "hmm, not those", later(1));
      const a = (await relayAnswer(u.root, { round: "R1", decision: "d1", session: SESSION, entryId: "m1" }, {}, u.transcripts) as any).answer;
      assert.equal((await heldOn(u.root, f)).length, 0, "released by the ruling, only flagged");
      const c = await confirmReading(u.root, { answer: a, maps: [{ decision: "d1", option: null }] }) as any;
      assert.ok((await heldOn(u.root, f)).some((h: any) => h.decision === c.confirm), "the (none) confirm holds");
    });
  } finally { u.cleanup(); }
  const v = await universe();
  try {
    const [f, g] = [await withFinding(v), await withFinding(v)];
    await asAgent(async () => {
      const two = { id: "d1", round: "R1", ref: "D1", kind: "options" as const, payload: { question: `D1: are ${f} and ${g} real defects?`, header: "F", options: [{ label: "Not a defect", description: "d" }, { label: "Real, fix it", description: "d" }] },
        options: [{ label: "Not a defect", effects: [{ findings: [f, g], on: "settle" as const, as: "refuted" as const }] }, { label: "Real, fix it", effects: [{ findings: [f, g], on: "unblock" as const }] }] };
      await postRound(v.root, { round: { id: "R1", source: "x" }, decisions: [two] });
      await tick();
      await postRound(v.root, { round: { id: "R2", source: "x" }, decisions: [{ ...decision("d1b", f, {}, "D7", "R2"), supersedes: "d1" }] });
      assert.ok((await heldOn(v.root, g)).some((h: any) => h.decision === "d1" && h.why === "undecided"), "dropped by D1b, held by D1");
    });
    await asPerson(async () => { await answerDirect(v.root, { decision: "d1b", option: "Real, fix it" }); });
    assert.equal((await heldOn(v.root, g)).length, 0, "released once D1b rules");
  } finally { v.cleanup(); }
  const w = await universe();
  try {
    const f = await withFinding(w);
    const a = await flaggedRuling(w, f);
    await asAgent(async () => {
      const c = await confirmReading(w.root, { answer: a, maps: [{ decision: "d1", option: "Real, fix it" }] }) as any;
      const t = transcript(w.transcripts);
      t.ask("toolu_no", [c.ask], { [c.ask.question]: "No — ask me again" }, later(2));
      await logQuestion(w.root, { toolUseId: "toolu_no", round: "R1" }, {}, w.transcripts);
      t.ask("toolu_other", [c.ask], { [c.ask.question]: "nothing, really" }, later(3));
      const other = (await logQuestion(w.root, { toolUseId: "toolu_other", round: "R1" }, {}, w.transcripts) as any).answered[0].answer;
      const prompt = await briefOf(w.root, other, [{ decision: c.confirm, option: null }]);
      const r = await reads(w, t, other, `${c.ref} → (none)`, { prompt });
      assert.ok(r.rec.recorded, JSON.stringify(r));
      const round = await decisionRound(w.root, "R1") as any;
      assert.equal(round.decisions.find((x: any) => x.id === c.confirm)?.confirm.state, "answered");
      assert.ok(!(await heldOn(w.root, f)).some((h: any) => h.decision === c.confirm), "and holds nothing");
    });
  } finally { w.cleanup(); }
});

test("Round five replaces vanishing gate: cancelled replies remain visible; missing confirmation evidence still waits on the person", async () => {
  const u = await universe();
  try {
    const [f, g] = [await withFinding(u), await withFinding(u)];
    await asAgent(async () => { await postRound(u.root, { round: { id: "R1", source: "x" }, decisions: [decision("d1", f), decision("d2", g, {}, "D2")] }); });
    await tick();
    await asPerson(async () => { await answerDirect(u.root, { decision: "d2", option: "Not a defect" }); });
    await tick();
    const t = transcript(u.transcripts);
    let a = "", c: any;
    await asAgent(async () => {
      t.typed("m1", "fix D2 after all", later(0));
      a = (await relayAnswer(u.root, { round: "R1", decision: "d1", session: SESSION, entryId: "m1" }, {}, u.transcripts) as any).answer;
    });
    await tick();
    await asAgent(async () => {
      c = await confirmReading(u.root, { answer: a, maps: [{ decision: "d2", option: "Real, fix it" }] });
      assert.equal(c.ok, true, JSON.stringify(c));
      await tick();
      await asPerson(async () => { await answerDirect(u.root, { decision: "d1", option: "Not a defect" }); });
      assert.ok(!(await decisionRounds(u.root) as any).awaitingReading.some((x: any) => x.answer === a));
      await tick();
      t.ask("toolu_other", [c.ask], { [c.ask.question]: "leave D1 open" }, later(0));
      await logQuestion(u.root, { toolUseId: "toolu_other", round: "R1" }, {}, u.transcripts);
    });
    await tick();
    await asPerson(async () => { await answerDirect(u.root, { decision: "d2", option: "Not a defect" }); });
    const round = await decisionRound(u.root, "R1") as any;
    assert.equal(round.decisions.find((x: any) => x.id === c.confirm)?.confirm.state, "no longer needed", JSON.stringify(round.decisions.map((x: any) => x.confirm)));
    assert.ok(!round.awaitingReading.some((x: any) => x.decision === c.confirm));
    assert.ok(round.decisions.find((x: any) => x.id === c.confirm).answers.some((x: any) => x.words === "leave D1 open" && x.cancelled));
    await asAgent(async () => {
      const b = bound(u);
      const never = otherClone(c, "never-recorded", [[{ decision: "d2", option: "Real, fix it" }]], (q) => q.replace(/^D3:/, "D9:"), "D9");
      await postConfirmEvent(b.cfg.path, b.cfg.universe, b.actor, never);
      const view = await decisionRounds(u.root) as any;
      assert.ok(view.waitingOnYou.some((x: any) => x.decision === never.id && /not a confirm codemap can verify/.test(x.why)), JSON.stringify(view.waitingOnYou));
    });
  } finally { u.cleanup(); }
});

test("F4 (run 2026-09-24-decision-rounds-2-codex-round-review): a multi-select reading given out of order posts a confirm the fold accepts", async () => {
  const u = await universe();
  try {
    const f = await withFinding(u);
    const multi = { ...decision("d1", f), payload: { ...payloadFor(f), multiSelect: true } };
    await asAgent(async () => {
      await postRound(u.root, { round: { id: "R1", source: "x" }, decisions: [multi] });
      transcript(u.transcripts).typed("m1", "both of them", later(1));
      const a = (await relayAnswer(u.root, { round: "R1", decision: "d1", session: SESSION, entryId: "m1" }, {}, u.transcripts) as any).answer;
      const c = await confirmReading(u.root, { answer: a, maps: [{ decision: "d1", option: "Real, fix it" }, { decision: "d1", option: "Not a defect" }] }) as any;
      assert.equal(c.ok, true, JSON.stringify(c));
    });
  } finally { u.cleanup(); }
});


test("Q4: confirmReading refuses a ref shared by two posted questions", async () => {
  const u = await universe();
  try {
    const f = await withFinding(u);
    await asAgent(async () => {
      await postRound(u.root, { round: { id: "R1", source: "x" }, decisions: [decision("d1", f)] });
      const t = transcript(u.transcripts);
      t.typed("m-shared", "hmm", later(2));
      const a = (await relayAnswer(u.root, { round: "R1", decision: "d1", session: SESSION, entryId: "m-shared" }, {}, u.transcripts) as any).answer;
      const first = await confirmReading(u.root, { answer: a, maps: [{ decision: "d1", option: "Not a defect" }] }) as any;
      assert.equal(first.ok, true);
      const duplicate = { id: "duplicate-ref", round: "R1", ref: "D1", kind: "options" as const,
        payload: { ...first.ask, question: first.ask.question.replace(/^D2:/, "D1:") },
        options: first.ask.options.map((o: any) => ({ label: o.label, effects: [] })),
        confirms: { answer: a, readings: [[{ decision: "d1", option: "Not a defect" }]] } };
      const b = bindDecisions(u.root) as any;
      await postConfirmEvent(b.cfg.path, b.cfg.universe, b.actor, duplicate);
      const again = await confirmReading(u.root, { answer: a, maps: [{ decision: "d1", option: "Real, fix it" }] }) as any;
      assert.match(String(again.error), /two questions.*ambiguous/);
    });
  } finally { u.cleanup(); }
});

test("round five: changed response cancels a completed reading and its pending confirmation through ops", async () => {
  const u = await universe();
  try {
    const f = await withFinding(u);
    await asAgent(async () => {
      await postRound(u.root, { round: { id: "R1", source: "round-five" }, decisions: [decision("d1", f)] });
      const t = transcript(u.transcripts);
      t.typed("original", "not a defect, keep the explanation", later(1));
      const original = await relayAnswer(u.root, { round: "R1", decision: "d1", session: SESSION, entryId: "original" }, {}, u.transcripts) as any;
      const maps = [{ decision: "d1", option: "Not a defect" }];
      const unreadCursor = (await decisionStatus(u.root, "R1") as any).cursor;
      const prompt = await briefOf(u.root, original.answer, maps);
      const read = await reads(u, t, original.answer, "D1 → Real, fix it", { prompt });
      const readStatus = await decisionStatus(u.root, "R1", unreadCursor) as any;
      assert.equal(readStatus.changed, true, "reading evidence changes the cursor without adding an answer");
      assert.equal(readStatus.decisions[0].answers.length, 1);
      assert.equal(read.rec.recorded, true);
      assert.equal(read.rec.agree, false);
      const confirmation = await confirmReading(u.root, { answer: original.answer }, {}, u.transcripts) as any;
      assert.equal(confirmation.ok, true, JSON.stringify(confirmation));
      t.typed("correction", "leave it open; the premise was right", later(20));
      const correction = await relayAnswer(u.root, { round: "R1", decision: "d1", session: SESSION, entryId: "correction" }, {}, u.transcripts) as any;
      assert.equal(correction.recorded, true);
      const view = await decisionRound(u.root, "R1") as any;
      const d = view.decisions.find((x: any) => x.id === "d1");
      const historic = d.answers.find((a: any) => a.id === original.answer);
      assert.equal(historic.cancelled.by, correction.answer);
      assert.ok(historic.reading.id);
      assert.equal(view.decisions.find((x: any) => x.id === confirmation.confirm).confirm.state, "no longer needed");
      assert.ok(!view.waitingOnYou.some((x: any) => x.decision === confirmation.confirm));
      assert.deepEqual(view.awaitingReading.map((x: any) => x.answer), [correction.answer]);
      assert.match(String(err(await readerBrief(u.root, { answer: original.answer, maps }))), /response changed/);
      assert.match(String(err(await confirmReading(u.root, { answer: original.answer }, {}, u.transcripts))), /response changed/);
      assert.match(String(err(await submitVerdict(u.root, { answer: original.answer, verdict: "D1 → Not a defect" }, {}, u.transcripts))), /response changed/);
      const recorded = await recordReading(u.root, { answer: original.answer }, {}, u.transcripts) as any;
      assert.equal(recorded.ok, false);
      assert.equal(recorded.cancelledBy, correction.answer);
      await asPerson(async () => {
        assert.match(String(err(await answerDirect(u.root, { decision: confirmation.confirm, option: "Reading 1" }))), /response changed/);
      });
    });
  } finally { u.cleanup(); }
});


test("round five: status cursor returns late answers, timeout is local, CLI resumes by id", async () => {
  const u = await universe();
  try {
    const f = await withFinding(u);
    await asAgent(async () => {
      await postRound(u.root, { round: { id: "R1", source: "round-five" }, decisions: [decision("d1", f)] });
    });
    const initial = await decisionStatus(u.root, "R1") as any;
    assert.equal(initial.changed, true);
    assert.equal(initial.decisions[0].answers.length, 0);
    const quiet = await waitDecisionStatus(u.root, "R1", initial.cursor, 0) as any;
    assert.equal(quiet.changed, false);
    assert.equal(quiet.timedOut, true);
    await asPerson(async () => { await answerDirect(u.root, { decision: "d1", option: "Not a defect" }); });
    const changed = await waitDecisionStatus(u.root, "R1", initial.cursor, 0) as any;
    assert.equal(changed.changed, true);
    assert.equal(changed.decisions[0].answers.length, 1);
    assert.equal((await decisionStatus(u.root, "R1", changed.cursor) as any).changed, false);
    await asAgent(async () => { assert.equal((await sharedSync(u.root) as any).ok, true); });
    const synced = await decisionStatus(u.root, "R1", changed.cursor) as any;
    assert.ok(synced.lastSync?.at);
    assert.equal(synced.changed, false, "sync with no new answer does not move the content cursor");
    const cli = spawnSync(process.execPath, [join(process.cwd(), "dist/cli.js"), "decisions", "status", "R1", "--repo", u.root, "--cursor", initial.cursor], { encoding: "utf8" });
    assert.equal(cli.status, 0, cli.stderr);
    const resumed = JSON.parse(cli.stdout);
    assert.equal(resumed.changed, true);
    assert.equal(resumed.decisions[0].answers[0].id, changed.decisions[0].answers[0].id);
    assert.match(String(err(await waitDecisionStatus(u.root, "R1", initial.cursor, 60_001))), /60000/);
  } finally { u.cleanup(); }
});


test("round five: nominate an exact independent pair outside inferred overlap", async () => {
  const u = await universe();
  try {
    const f = await withFinding(u), g = await withFinding(u);
    await asAgent(async () => {
      const d2 = decision("d2", g, {}, "D2");
      await postRound(u.root, { round: { id: "R1", source: "round-five" }, decisions: [decision("d1", f), d2] });
    });
    let alice: any;
    await asPerson(async () => { alice = await answerDirect(u.root, { decision: "d1", option: "Not a defect" }); });
    let bob: any;
    await withEnv({ CODEMAP_AGENT_MODEL: undefined, CODEMAP_PRINCIPAL: "bob@x.com" }, async () => {
      bob = await answerDirect(u.root, { decision: "d2", option: "Real, fix it" });
    });
    assert.equal((await decisionRounds(u.root) as any).intentCandidates.length, 0);
    await asAgent(async () => {
      assert.match(String(err(await nominateComparison(u.root, { answers: [alice.answer, bob.answer], findings: ["f_elsewhere"], reason: "wrong" }))), /outside both questions/);
      const result = await nominateComparison(u.root, { answers: [alice.answer, bob.answer], findings: [f], reason: "the second answer qualifies the first" }) as any;
      assert.equal(result.ok, true, JSON.stringify(result));
      assert.equal(result.candidate.evidence, "nominated");
      assert.equal((await nominateComparison(u.root, { answers: [alice.answer, bob.answer], findings: [f], reason: "duplicate" }) as any).alreadyCandidate, true);
    });
    const view = await decisionRounds(u.root) as any;
    assert.ok(view.intentCandidates.some((x: any) => x.evidence === "nominated" && x.findings.includes(f)));
    assert.ok((await decisionsView(u.root)).mark(f).held);
  } finally { u.cleanup(); }
});
