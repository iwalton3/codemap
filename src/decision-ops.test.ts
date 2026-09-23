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
import { writeStore, readFinding } from "./store.js";
import type { State } from "./schema.js";
import { shareFinding, corroborateFinding, closeFinding, bindDecisions } from "./ops-shared.js";
import { postRound, postPrevalidated, logQuestion, relayAnswer, answerDirect, decisionRounds, decisionRound, recordReading } from "./ops/decisions.js";
import { discard } from "./test-tmp.js";
import { decisionScope } from "./shared-decisions.js";

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
const payload = { question: "Is F a real defect?", header: "F", options: [{ label: "Not a defect", description: "close as refuted" }, { label: "Real, fix it", description: "fix work" }] };
const decision = (id: string, f: string, extra: Record<string, unknown> = {}) => ({
  id, round: "R1", ref: "D1", kind: "options" as const, payload,
  options: [{ label: "Not a defect", effects: [{ findings: [f], on: "settle" as const, as: "refuted" as const }], ...extra }, { label: "Real, fix it", effects: [{ findings: [f], on: "unblock" as const }] }],
});
/** The transcript of a session that asked `payload` and got `answer`. */
function asked(dir: string, answer: string, toolUseId = "toolu_1") {
  const lines = [
    { type: "assistant", uuid: "a1", isSidechain: false, message: { content: [{ type: "tool_use", id: toolUseId, name: "AskUserQuestion", input: { questions: [payload] } }] } },
    { type: "user", uuid: "r1", isSidechain: false, sourceToolAssistantUUID: "a1", message: { content: [{ type: "tool_result", tool_use_id: toolUseId, content: "…" }] }, toolUseResult: { questions: [payload], answers: { [payload.question]: answer } } },
    { type: "user", uuid: "m1", isSidechain: false, origin: { kind: "human" }, message: { role: "user", content: "D1 B" } },
    { type: "user", uuid: "m2", isSidechain: false, origin: { kind: "human" }, message: { role: "user", content: "D2 A" } },
  ];
  writeFileSync(join(dir, `${SESSION}.jsonl`), lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
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
      assert.deepEqual(ok.ask[0].payload.question, payload.question);
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

      asked(u.transcripts, "Not a defect");
      // No session given: the agent knows what it asked, and codemap finds whose transcript holds it.
      const r = await logQuestion(u.root, { toolUseId: "toolu_1" }, {}, u.transcripts) as any;
      assert.equal(r.ok, true, JSON.stringify(r));
      assert.equal(r.answered[0].verified, true);
      assert.deepEqual(r.answered[0].closed, [], "an ordinary round's ruling closes nothing itself");
      assert.equal((await readFinding(u.root, f))?.state, "issued", "the finding is untouched");

      view = await decisionRounds(u.root) as any;
      assert.ok(!view.waitingOnYou.some((w: any) => w.decision === "d1"));
      assert.ok(view.ruledNotCarriedOut.some((x: any) => x.finding === f && x.on === "settle" && x.ruler === "alice@x.com"));
      const round = await decisionRound(u.root, "R1") as any;
      assert.ok(round.held.some((h: any) => h.finding === f && h.holds.some((x: any) => x.why === "ruled")));

      assert.match(String(err(await logQuestion(u.root, { session: SESSION, toolUseId: "toolu_1" }, {}, u.transcripts))), /already logged/);
    });
    // Once the finding closes — by whoever — it is no longer "not carried out".
    await asPerson(async () => { await closeFinding(u.root, 7, f, "refuted", "done by hand"); });
    await asAgent(async () => {
      const view = await decisionRounds(u.root) as any;
      assert.ok(!view.ruledNotCarriedOut.some((x: any) => x.finding === f));
    });
  } finally { u.cleanup(); }
});

test("an unverifiable call writes nothing", async () => {
  const u = await universe();
  try {
    const f = await withFinding(u);
    await asAgent(async () => {
      await postRound(u.root, { round: { id: "R1", source: "x" }, decisions: [decision("d1", f)] });
      asked(u.transcripts, "Not a defect");
      const r = await logQuestion(u.root, { session: SESSION, toolUseId: "toolu_other" }, {}, u.transcripts) as any;
      assert.equal(r.ok, false);
      assert.ok(r.unverified);
      const round = await decisionRound(u.root, "R1") as any;
      assert.equal(round.decisions[0].answers.length, 0);
    });
  } finally { u.cleanup(); }
});

test("a relayed reply is the whole message; an unconfirmed one only unblocks", async () => {
  const u = await universe();
  try {
    const f = await withFinding(u);
    await asAgent(async () => {
      await postRound(u.root, { round: { id: "R1", source: "x" }, decisions: [decision("d1", f)] });
      asked(u.transcripts, "Not a defect");
      const r = await relayAnswer(u.root, { decision: "d1", session: SESSION, entryId: "m1" }, {}, u.transcripts) as any;
      assert.equal(r.verified, true, JSON.stringify(r));
      assert.ok(r.ruled.some((x: any) => x.finding === f && x.on === "unblock"), "D1 B is the fix-it option");

      const un = await relayAnswer(u.root, { decision: "d1", session: SESSION, entryId: "nope", words: "D1 A", relayedBy: "sess-x" }, {}, u.transcripts) as any;
      assert.equal(un.verified, false);
      assert.deepEqual(un.waitingOnYou, [f], "its settle waits for the person");
      const none = await relayAnswer(u.root, { decision: "d1", session: SESSION, entryId: "nope" }, {}, u.transcripts) as any;
      assert.equal(none.ok, false, "no words, nothing written");
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
        decision("d1", f, { closesOnAnswer: true }),
        { ...decision("d2", g, { closesOnAnswer: true }), ref: "D2", payload: { ...payload, question: "Is G a real defect?" } },
      ] }, { record: "rec", sortedBy: "two sorters and an arbitrator" });
      assert.equal((r as any).ok, true, JSON.stringify(r));

      asked(u.transcripts, "Not a defect");
      const lq = await logQuestion(u.root, { session: SESSION, toolUseId: "toolu_1" }, {}, u.transcripts) as any;
      assert.deepEqual(lq.answered[0].closed, [f]);
      const closed = await readFinding(u.root, f);
      assert.equal(closed?.state, "refuted");
      assert.equal(closed?.closed?.decision?.ruler, "alice@x.com");
      assert.equal(closed?.closed?.by.via?.kind, "agent", "the closer is the agent that carried it out");

      // A verified answer on a finding already closed: it stays as its closer left it, and the
      // answer does not report a close it did not make.
      const again = await relayAnswer(u.root, { decision: "d2", session: SESSION, entryId: "m2" }, {}, u.transcripts) as any;
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
      asked(u.transcripts, "not a defect, but log why");
      const lq = await logQuestion(u.root, { session: SESSION, toolUseId: "toolu_1" }, {}, u.transcripts) as any;
      assert.equal(lq.answered[0].awaitsReading, true);
      const answer = lq.answered[0].answer;
      const maps = [{ decision: "d1", option: "Not a defect" }];
      const self = await recordReading(u.root, { answer, reader: { transcript: SESSION, reading: "r", maps }, session: { reading: "r", maps } }) as any;
      assert.equal(self.recorded, false, "the session that asked cannot read its own answer");
      const two = await recordReading(u.root, { answer, reader: { transcript: "agent-B", reading: "r", maps }, session: { reading: "r", maps: [{ decision: "d1", option: "Real, fix it" }] } }) as any;
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
      asked(u.transcripts, "Not a defect");
      assert.match(String(err(await logQuestion(u.root, { session: SESSION, toolUseId: "toolu_1" }, {}, u.transcripts))), /blocked/);
    });
  } finally { u.cleanup(); }
});
