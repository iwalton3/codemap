/**
 * The decision and repair flows of plan 2026-10-06-codemap-flows-review driven through the real
 * MCP server, with each session's transcript built from what the server ACTUALLY returned. The
 * carrier lookup (owner, D1) matches on a tool result's shape; every other test hands it a shape
 * written by hand, so this is the one place a drift between the two can show.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { team } from "./oracle.js";
import { rpc } from "./test-mcp.js";
import { readerTranscript, sessionFile } from "./test-transcripts.js";
import { shareFinding } from "./ops-shared.js";
import { postRound, answerDirect } from "./ops/decisions.js";
import { decisionsView } from "./ops/decision-holds.js";
import { postRepairSort } from "./ops/repairs.js";
import { discard } from "./test-tmp.js";
import type { AskedQuestion } from "./schema.js";

type Call = { name: string; arguments: Record<string, unknown> };
type Reply = { content?: { type: string; text: string }[] } | undefined;
const parsed = (r: Reply) => JSON.parse(r?.content?.[0]?.text ?? "null");
const json = (text: string) => { try { return JSON.parse(text); } catch { return { error: text }; } };
const payload = (f: string, ref = "D1"): AskedQuestion => ({ question: `${ref}: is ${f} a real defect?`, header: "F",
  options: [{ label: "Not a defect", description: "close as refuted" }, { label: "Real, fix it", description: "fix work" }] });
const decision = (id: string, f: string, round: string, ref = "D1") => ({ id, round, ref, kind: "options" as const, payload: payload(f, ref),
  options: [{ label: "Not a defect", effects: [{ findings: [f], on: "settle" as const, as: "refuted" as const }] }, { label: "Real, fix it", effects: [{ findings: [f], on: "unblock" as const }] }] });

async function universe() {
  const t = await team(["alice@acme.test"]);
  const dir = mkdtempSync(join(tmpdir(), "codemap-mcp-carriers-"));
  const root = t.all[0]!.repo;
  const f = await shareFinding(root, 7, { targetKind: "anchor", targetId: "src/pay.ts#transfer", text: "a guard is missing" }) as { id: string };
  assert.ok(f.id, JSON.stringify(f));
  /** The real server as an agent session, reading transcripts from `dir`. */
  const mcp = (calls: Call[], onReply: (call: Call, result: Reply) => void = () => {}) =>
    rpc(root, calls, { env: { CODEMAP_TRANSCRIPT_DIR: dir, CODEMAP_AGENT_MODEL: "carrier-test" }, onReply: onReply as never });
  return { root, dir, f: f.id, mcp, dispose: () => { t.dispose(); discard(dir); } };
}

test("D1 over MCP: post_round's real result is the carrier, and log_question finds the call after it", async () => {
  const u = await universe();
  try {
    const s = sessionFile(u.dir, "5e55a0a0-0000-0000-0000-0000000000a1");
    const out = await u.mcp([
      { name: "post_round", arguments: { round: { id: "R1", source: "carrier test" }, decisions: [decision("d1", u.f, "R1")] } },
      { name: "log_question", arguments: { round: "R1" } },
    ], (call, result) => {
      if (call.name !== "post_round") return;
      s.tool("post_round", call.arguments, result?.content);
      s.ask([payload(u.f)], { [payload(u.f).question]: "Real, fix it" });
    });
    const logged = json(out[1]!);
    assert.equal(logged.ok, true, out[1]!);
    assert.equal(logged.answered?.[0]?.recorded, true, out[1]!);
  } finally { u.dispose(); }
});

test("Q4 over MCP: a new session reads the round with decision_round, then asks — and a session that never read it is not searched", async () => {
  const u = await universe();
  try {
    const poster = sessionFile(u.dir, "5e55a0a0-0000-0000-0000-0000000000b1");
    const resumed = sessionFile(u.dir, "5e55a0a0-0000-0000-0000-0000000000b2");
    const stranger = sessionFile(u.dir, "5e55a0a0-0000-0000-0000-0000000000b3");
    const out = await u.mcp([
      { name: "post_round", arguments: { round: { id: "R2", source: "carrier test" }, decisions: [decision("d1", u.f, "R2")] } },
      { name: "log_question", arguments: { round: "R2" } },
      { name: "decision_round", arguments: { id: "R2" } },
      { name: "log_question", arguments: { round: "R2" } },
    ], (call, result) => {
      if (call.name === "post_round") {
        poster.tool("post_round", call.arguments, result?.content);
        stranger.ask([payload(u.f)], { [payload(u.f).question]: "Not a defect" });
      }
      if (call.name === "decision_round") {
        resumed.tool("decision_round", call.arguments, result?.content);
        resumed.ask([payload(u.f)], { [payload(u.f).question]: "Real, fix it" }, 2000);
      }
    });
    const before = json(out[1]!);
    assert.notEqual(before.ok, true, `the stranger's identical call is not this round's: ${out[1]}`);
    const after = json(out[3]!);
    assert.equal(after.ok, true, out[3]!);
    assert.equal(after.answered?.[0]?.recorded, true, out[3]!);
    const view = await decisionsView(u.root);
    const d = view.s.decisions.find((x) => (x.label ?? x.id) === "d1")!;
    assert.deepEqual(d.answers.map((a) => a.options), [["Real, fix it"]], "only the resumed session's answer");
  } finally { u.dispose(); }
});

test("Q1 over MCP: report_ruling's real result carries its new round, so its withdraw question logs", async () => {
  const u = await universe();
  try {
    ok(await postRound(u.root, { round: { id: "R3", source: "carrier test" }, decisions: [decision("d1", u.f, "R3")] }));
    const ruling = (await answerDirect(u.root, { decision: "d1", option: "Real, fix it" }) as { answer: string }).answer;
    assert.ok(ruling);
    const s = sessionFile(u.dir, "5e55a0a0-0000-0000-0000-0000000000c1");
    const calls: Call[] = [
      { name: "report_ruling", arguments: { decision: "d1", answer: ruling, reason: "it conflicts with a later ruling" } },
      { name: "log_question", arguments: { round: "(filled in from report_ruling)" } },
    ];
    const out = await u.mcp(calls, (call, result) => {
      if (call.name !== "report_ruling") return;
      const r = parsed(result);
      s.tool("report_ruling", call.arguments, result?.content);
      s.ask([r.ask], { [r.ask.question]: "Withdraw it" });
      calls[1]!.arguments.round = r.round;
    });
    const logged = json(out[1]!);
    assert.equal(logged.ok, true, out[1]!);
    assert.equal(logged.answered?.[0]?.recorded, true, out[1]!);
  } finally { u.dispose(); }
});

test("Q1 over MCP: decision_revision_relay_brief's real result is the carrier for the relayed revision", async () => {
  const u = await universe();
  try {
    ok(await postRound(u.root, { round: { id: "R4", source: "carrier test" }, decisions: [decision("d1", u.f, "R4")] }));
    const first = (await answerDirect(u.root, { decision: "d1", option: "Not a defect" }) as { answer: string }).answer;
    const s = sessionFile(u.dir, "5e55a0a0-0000-0000-0000-0000000000d1");
    const input = { decision: "d1", revises: [first], findings: [u.f] };
    const out = await u.mcp([
      { name: "record_relayed_decision_revision", arguments: input },
      { name: "decision_revision_relay_brief", arguments: input },
      { name: "record_relayed_decision_revision", arguments: input },
    ], (call, result) => {
      if (call.name !== "decision_revision_relay_brief") return;
      const q = parsed(result).question as AskedQuestion;
      s.tool("decision_revision_relay_brief", call.arguments, result?.content);
      s.ask([q], { [q.question]: "Real, fix it" });
    });
    assert.match(json(out[0]!).error ?? out[0]!, /no AskUserQuestion call/, "before the brief, nothing carries it");
    const revised = json(out[2]!);
    assert.equal(revised.ok, true, out[2]!);
  } finally { u.dispose(); }
});

test("D4 over MCP: post_repair_sort fills both sorters' session from the connection and keeps the subagent's child", async () => {
  const u = await universe();
  try {
    const sorter = (child?: string) => ({ identity: { principal: "alice@acme.test", ...(child ? { child } : {}) }, classification: "implementation-defect", reason: "read code" });
    const sort = { classification: "implementation-defect", kind: "isolated", coverage: [{ findingId: u.f, claimIds: [`${u.f}:original`] }],
      restsOn: [], source: "triage-review round", provenance: "dual-sorted", assessments: [sorter(), sorter("a1234567")], disagreements: [] };
    const out = await u.mcp([
      { name: "post_repair_sort", arguments: { review: "7", sort: { ...sort, assessments: [{ ...sorter(), identity: { principal: "alice@acme.test", session: "mine" } }, sorter("a1")] } } },
      { name: "post_repair_sort", arguments: { review: "7", sort: { ...sort, assessments: [sorter(), sorter()] } } },
      { name: "post_repair_sort", arguments: { review: "7", sort } },
    ]);
    assert.match(out[0]!, /session/, "a caller cannot name the session");
    assert.match(out[1]!, /two independent sorters/, "the session's own reading twice is one reader");
    const posted = json(out[2]!);
    assert.equal(posted.ok, true, out[2]!);
    const s = posted.records.sorts.find((x: { input: { id: string } }) => x.input.id === posted.id);
    const [a, b] = s.input.assessments.map((x: { identity: unknown }) => x.identity);
    assert.ok(a.session && a.session === b.session, "both carry this connection's session");
    assert.equal(a.child, undefined); assert.equal(b.child, "a1234567");
    assert.equal(s.eligible, true, s.holds.join());
  } finally { u.dispose(); }
});

test("D2 over MCP: two readers launched from one session release a held sort; the verifier brief would carry the rulings", async () => {
  const u = await universe();
  try {
    ok(await postRound(u.root, { round: { id: "R5", source: "the owner, on the guard" }, decisions: [{ id: "D-dir", round: "R5", ref: "D1", kind: "words",
      payload: { question: `D1: which guard does ${u.f} need?`, options: [{ label: "Both" }, { label: "Neither" }] }, options: [{ label: "Both", effects: [] }, { label: "Neither", effects: [] }] }] }));
    ok(await answerDirect(u.root, { decision: "D-dir", option: "Both" }));
    const decisionId = (await decisionsView(u.root)).s.decisions.find((d) => (d.label ?? d.id) === "D-dir")!.id;
    const held = await postRepairSort(u.root, 7, { classification: "design-defect", kind: "isolated", coverage: [{ findingId: u.f, claimIds: [`${u.f}:original`] }],
      restsOn: [`decision:${decisionId}`], source: "owner worklist: which guard", provenance: "owner-reviewed", assessments: [], disagreements: [] }) as { id: string };
    ok(held);
    const parent = "5e55a0a0-0000-0000-0000-0000000000e1";
    const briefs: { requestId: string; prompt: string }[] = [], refs: { requestId: string; receipt: string }[] = [];
    const calls: Call[] = [
      { name: "release_reader_brief", arguments: { review: "7", sort: held.id, slot: 1 } },
      { name: "release_reader_brief", arguments: { review: "7", sort: held.id, slot: 2 } },
      { name: "submit_release_verdict", arguments: {} },
      { name: "submit_release_verdict", arguments: {} },
      { name: "release_held_sort", arguments: { review: "7", sort: held.id, readers: refs } },
      { name: "repair_records", arguments: { review: "7" } },
    ];
    const out = await u.mcp(calls, (call, result) => {
      const r = parsed(result);
      if (call.name === "release_reader_brief") {
        briefs.push(r);
        if (briefs.length === 2) briefs.forEach((b, i) => { calls[2 + i]!.arguments = { requestId: b.requestId, verdict: "yes", rationale: `reader ${i + 1}: both guards, as ruled` }; });
      }
      if (call.name === "submit_release_verdict") {
        const i = refs.length;
        readerTranscript(u.dir, parent, `a${i + 1}${i + 1}${i + 1}${i + 1}${i + 1}${i + 1}${i + 1}`, briefs[i]!.prompt, "submit_release_verdict", call.arguments, r);
        refs.push({ requestId: briefs[i]!.requestId, receipt: r.receipt });
      }
    });
    for (const b of briefs) {
      assert.match(b.prompt, /which guard does/, "the ruling's question");
      assert.doesNotMatch(b.prompt, /owner worklist/, "nothing of the fixer's");
    }
    const released = json(out[4]!);
    assert.equal(released.ok, true, out[4]!);
    const records = json(out[5]!);
    const s = records.records.sorts.find((x: { input: { id: string } }) => x.input.id === released.id);
    assert.equal(s.input.provenance, "released");
    assert.equal(s.input.release.readers[0].session, parent);
    assert.equal(s.input.release.readers[1].session, parent, "both readers came from one session, told apart by launch");
    assert.equal(s.eligible, true, s.holds.join());
  } finally { u.dispose(); }
});

function ok(v: unknown) { assert.equal((v as { error?: string })?.error, undefined, JSON.stringify(v)); }
