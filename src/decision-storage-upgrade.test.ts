import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, writeFileSync, readdirSync, statSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { team, settle, type Member } from "./oracle.js";
import { discard } from "./test-tmp.js";
import { db } from "./db.js";
import { SHARD_EXT } from "./eventlog.js";
import { MATERIALIZER_VERSION, foldCount, scopeFingerprint } from "./materialize.js";
import { resolveSidecar, sidecarIdentity, universeKey } from "./sidecar-config.js";
import { findingScope } from "./shared-findings.js";
import { bugScope } from "./shared-bugs.js";
import { decisionScope } from "./shared-decisions.js";
import { shareFinding, sharedFindings, shareDoc, sharedDocs, sharedSync, backlogFinding } from "./ops-shared.js";
import { reportBug, listBugs, backlogBugOp } from "./ops/bugs.js";
import { postRound, answerDirect, reviseDecision, decisionRound, logQuestion } from "./ops/decisions.js";
import { CODEX_CALL, CODEX_SESSION, codexReply, codexRows, codexTranscript } from "./test-codex-transcript.js";
import { applicationReaderBrief, submitApplicationVerdict, recordApplicationVerdict, applyRuling } from "./ops/ruling-application.js";
import { readAnchorStore, readFinding, readBug } from "./store.js";
import { ensureSidecar } from "./sidecar.js";

const A = "ana@acme.test";
async function as<T>(agent: boolean, run: () => Promise<T>): Promise<T> {
  const prior = process.env.CODEMAP_AGENT_MODEL;
  if (agent) process.env.CODEMAP_AGENT_MODEL = "upgrade-probe";
  else delete process.env.CODEMAP_AGENT_MODEL;
  try { return await run(); } finally {
    if (prior === undefined) delete process.env.CODEMAP_AGENT_MODEL;
    else process.env.CODEMAP_AGENT_MODEL = prior;
  }
}
const ok = (v: any) => assert.equal(v?.error, undefined, JSON.stringify(v));
const row = (root: string, table: string, id: string) => db(root).prepare(`SELECT body FROM ${table} WHERE id = ?`).get(id) as { body: string } | undefined;

function transcript(dir: string, prompt: string, requestId: string, receipt: string, n = 1) {
  const agentId = `aUPGRADE000${n}`, session = `5e55a0a0-0000-0000-0000-00000000900${n}`;
  const launch = "toolu_upgrade_launch", call = "toolu_upgrade_submit";
  const sub = join(dir, session, "subagents");
  mkdirSync(sub, { recursive: true });
  writeFileSync(join(sub, `agent-${agentId}.meta.json`), JSON.stringify({ agentType: "general-purpose", toolUseId: launch }));
  writeFileSync(join(sub, `agent-${agentId}.jsonl`), [
    { type: "user", isSidechain: true, agentId, sessionId: session, message: { role: "user", content: prompt } },
    { type: "assistant", isSidechain: true, agentId, sessionId: session, message: { content: [{ type: "tool_use", id: call,
      name: "mcp__codemap__submit_application_verdict", input: { requestId, verdict: "sound", rationale: "The exact ruling defeats this claim." } }] } },
    { type: "user", isSidechain: true, agentId, sessionId: session, message: { content: [{ type: "tool_result", tool_use_id: call,
      content: JSON.stringify({ ok: true, held: true, receipt }) }] } },
  ].map((value) => JSON.stringify(value)).join("\n") + "\n");
  writeFileSync(join(dir, `${session}.jsonl`), [
    { type: "assistant", isSidechain: false, timestamp: new Date().toISOString(), message: { content: [{ type: "tool_use", id: launch,
      name: "Agent", input: { prompt, subagent_type: "general-purpose" } }] } },
    { type: "user", isSidechain: false, message: { content: [{ type: "tool_result", tool_use_id: launch, content: "launched" }] }, toolUseResult: { agentId } },
  ].map((value) => JSON.stringify(value)).join("\n") + "\n");
  return { requestId, receipt, agentId, callId: call };
}

function shardBytes(sidecar: string, scope: string): string {
  const h = createHash("sha256");
  for (const name of readdirSync(join(sidecar, scope)).filter((n) => n.endsWith(SHARD_EXT)).sort()) {
    h.update(name); h.update(readFileSync(join(sidecar, scope, name)));
  }
  return h.digest("hex");
}

function oldFingerprint(sidecar: string, scope: string, identity: string): string {
  const h = createHash("sha256");
  h.update(`v${MATERIALIZER_VERSION - 1}\0${identity}\0${scope}\0`);
  for (const name of readdirSync(join(sidecar, scope)).filter((n) => n.endsWith(SHARD_EXT)).sort()) {
    const st = statSync(join(sidecar, scope, name), { bigint: true });
    h.update(`${name}\0${st.size}\0${st.mtimeNs}\0`);
  }
  return h.digest("hex");
}

const decision = (id: string, target: string) => ({
  id, round: "R1", ref: id === "target" ? "D1" : "D2", kind: "options" as const,
  payload: { question: `${id === "target" ? "D1" : "D2"}: Is ${target} a real defect?`, options: [{ label: "No", description: "The premise is false" },
    { label: "Yes", description: "Repair it" }] },
  options: [{ label: "No", effects: [{ findings: [target], on: "settle" as const, as: "refuted" as const }] },
    { label: "Yes", effects: [{ findings: [target], on: "unblock" as const }] }],
});

test("native source receipts survive two-clone sync and refold from an older unchanged-shard cache", async () => {
  const t = await team([A, "bob@acme.test"]);
  const tx = codexTranscript([]);
  try {
    const m = t.all[0]!, peer = t.all[1]!, root = m.repo, cfg = resolveSidecar(root)!;
    const f = await as(true, () => shareFinding(root, 7, { targetKind: "anchor", targetId: "src/pay.ts#transfer", text: "negative transfer" })) as any;
    ok(f);
    const d = decision("target", f.id);
    const payload = { question: d.payload.question, options: d.payload.options.map(({ label }) => ({ label })) };
    ok(await as(true, () => postRound(root, { round: { id: "R1", source: "native upgrade" }, decisions: [{ ...d, payload }] })));
    const questions = [{ title: payload.question, options: payload.options.map((o) => o.label) }];
    const now = Date.now();
    const all = codexRows(questions, ["Yes"]) as any[];
    all[2].timestamp = new Date(now + 1000).toISOString();
    all[3].timestamp = new Date(now + 1500).toISOString();
    all[4] = codexReply(questions, ["Yes"], new Date(now + 2000).toISOString());
    tx.write(all);
    const result = await as(true, () => logQuestion(root, { harness: "codex", session: CODEX_SESSION, toolUseId: CODEX_CALL, round: "R1" }, {}, tx.dir)) as any;
    assert.equal(result.answered[0].recorded, true, JSON.stringify(result));
    await settle(t);
    const ours = await decisionRound(root, "R1") as any;
    const theirs = await decisionRound(peer.repo, "R1") as any;
    const expected = ours.decisions[0].answers[0].sourceReceipt;
    assert.equal(expected.harness, "codex");
    assert.deepEqual(theirs.decisions[0].answers[0].sourceReceipt, expected);
    const scope = decisionScope(cfg.universe), bytes = shardBytes(cfg.path, scope);
    const database = db(root);
    const exactDecision = ours.decisions[0].id;
    database.prepare("UPDATE decision_records SET body = json_remove(body, '$.answers[0].sourceReceipt') WHERE id = ?").run(exactDecision);
    database.prepare("UPDATE shared_scope SET fingerprint = ? WHERE scope = ?").run(oldFingerprint(cfg.path, scope, sidecarIdentity(cfg)), scope);
    assert.equal(JSON.parse(row(root, "decision_records", exactDecision)!.body).answers[0].sourceReceipt, undefined);
    const before = foldCount();
    const refreshed = await decisionRound(root, "R1") as any;
    assert.ok(foldCount() > before, "unchanged shards were refolded on upgrade");
    assert.deepEqual(refreshed.decisions[0].answers[0].sourceReceipt, expected);
    assert.equal(shardBytes(cfg.path, scope), bytes);
    assert.equal((await readFinding(peer.repo, f.id))!.closed, undefined);
  } finally { tx.cleanup(); t.dispose(); }
});

test("old cached decision and ruling projections re-fold unchanged shards without erasing other records", async () => {
  const t = await team([A]);
  const tx = mkdtempSync(join(tmpdir(), "codemap-upgrade-transcript-"));
  try {
    const m = t.all[0] as Member, root = m.repo, cfg = resolveSidecar(root)!;
    const target = await as(true, () => shareFinding(root, 7, { targetKind: "anchor", targetId: "src/pay.ts#transfer", text: "wrong transfer amount" })) as any;
    const other = await as(true, () => shareFinding(root, 7, { targetKind: "anchor", targetId: "src/pay.ts#transfer", text: "separate validation defect" })) as any;
    ok(target); ok(other);
    const bug = await as(true, () => reportBug(root, { title: "unrelated refund bug", description: "refund sign", anchors: ["src/pay.ts#refund"] })) as any;
    const targetBug = await as(true, () => reportBug(root, { title: "target transfer bug", description: "transfer rejects correct amount", anchors: ["src/pay.ts#transfer"] })) as any;
    ok(bug); ok(targetBug);
    const anchor = (await readAnchorStore(root)).anchors[0]!.id;
    ok(await as(true, () => shareDoc(root, { nodeId: "n_upgrade", type: "concept", title: "Payment flow", summary: "Pays",
      body: "Transfer behavior", citations: [{ anchorId: anchor, acceptedHashes: [] }] } as any)));
    ok(await as(false, () => backlogFinding(root, 7, other.id, { until: "2099-01-01", reason: "next release" })));
    ok(await as(false, () => backlogBugOp(root, bug.id, { until: "2099-01-01", reason: "next release" })));
    const bugRef = { kind: "bug" as const, universe: cfg.universe, scope: bugScope(cfg.universe), id: targetBug.id };
    const posted = await as(true, () => postRound(root, { round: { id: "R1", source: "upgrade probe" },
      decisions: [decision("target", target.id), decision("other", other.id), {
        id: "bugTarget", round: "R1", ref: "D3", kind: "options" as const,
        payload: { question: `D3: Is ${targetBug.id} a real defect?`, options: [{ label: "No", description: "The premise is false" }, { label: "Yes", description: "Repair it" }] },
        options: [{ label: "No", effects: [{ findings: [], issues: [bugRef], on: "settle" as const, as: "refuted" as const }] },
          { label: "Yes", effects: [{ findings: [], issues: [bugRef], on: "unblock" as const }] }],
      }] })) as any;
    ok(posted);
    const otherDecision = posted.ask.find((x: any) => x.label === "other").decision;
    const a = await as(false, () => answerDirect(root, { decision: "target", option: "No" })) as any;
    const b = await as(false, () => answerDirect(root, { decision: "other", option: "Yes" })) as any;
    const bugAnswer = await as(false, () => answerDirect(root, { decision: "bugTarget", option: "No" })) as any;
    assert.equal(a.recorded, true, JSON.stringify(a)); assert.equal(b.recorded, true, JSON.stringify(b));
    assert.equal(bugAnswer.recorded, true, JSON.stringify(bugAnswer));
    const revised = await as(false, () => reviseDecision(root, { decision: "other", revises: [b.answer], findings: [other.id], option: "No" })) as any;
    assert.equal(revised.ok, true, JSON.stringify(revised));
    const issue = { kind: "finding" as const, universe: universeKey(root), id: target.id, review: 7 };
    const applied = await as(true, async () => {
      const brief = await applicationReaderBrief(root, { issue, answerId: a.answer, slot: 1 }, tx) as any;
      assert.equal(brief.ok, true, JSON.stringify(brief));
      const held = submitApplicationVerdict(root, { requestId: brief.requestId, verdict: "sound", rationale: "The exact ruling defeats this claim." }) as any;
      assert.equal(held.held, true, JSON.stringify(held));
      const ref = transcript(tx, brief.prompt, brief.requestId, held.receipt);
      assert.equal((recordApplicationVerdict(root, ref, tx) as any).recorded, true);
      return applyRuling(root, { issue, answerId: a.answer, readers: [ref] }, tx);
    }) as any;
    assert.equal(applied.ok, true, JSON.stringify(applied));
    const bugApplied = await as(true, async () => {
      const brief = await applicationReaderBrief(root, { issue: bugRef, answerId: bugAnswer.answer, slot: 1 }, tx) as any;
      assert.equal(brief.ok, true, JSON.stringify(brief));
      const held = submitApplicationVerdict(root, { requestId: brief.requestId, verdict: "sound", rationale: "The exact ruling defeats this claim." }) as any;
      assert.equal(held.held, true, JSON.stringify(held));
      const ref = transcript(tx, brief.prompt, brief.requestId, held.receipt, 2);
      assert.equal((recordApplicationVerdict(root, ref, tx) as any).recorded, true);
      return applyRuling(root, { issue: bugRef, answerId: bugAnswer.answer, readers: [ref] }, tx);
    }) as any;
    assert.equal(bugApplied.ok, true, JSON.stringify(bugApplied));
    ok(await sharedSync(root));
    const ds = decisionScope(cfg.universe), fs = findingScope(`${cfg.universe}/pr-7`), bs = bugScope(cfg.universe);
    const before = new Map(await Promise.all([ds, fs, bs].map(async (scope) => [scope, await scopeFingerprint(cfg.path, scope, sidecarIdentity(cfg))] as const)));
    const bytes = new Map([ds, fs, bs].map((scope) => [scope, shardBytes(cfg.path, scope)]));
    assert.ok(row(root, "decision_records", otherDecision)?.body.includes(revised.revision));
    assert.equal((await readFinding(root, target.id))?.closed?.eventId, applied.application);
    assert.equal((await readBug(root, targetBug.id))?.closed?.eventId, bugApplied.application);

    // Model an older build that ignored these event kinds but cached the same shards.
    const d = db(root);
    d.prepare("UPDATE decision_records SET body = json_remove(body, '$.answers[#-1]') WHERE id = ?").run(otherDecision);
    d.prepare("UPDATE findings SET state = 'issued', body = json_remove(json_remove(body, '$.applications'), '$.closed') WHERE id = ?").run(target.id);
    d.prepare("DELETE FROM ruling_applications WHERE issue_id = ?").run(target.id);
    d.prepare("UPDATE bugs SET state = 'issued', body = json_remove(json_remove(body, '$.applications'), '$.closed') WHERE id = ?").run(targetBug.id);
    d.prepare("DELETE FROM ruling_applications WHERE issue_id = ?").run(targetBug.id);
    for (const scope of [ds, fs, bs]) d.prepare("UPDATE shared_scope SET fingerprint = ? WHERE scope = ?")
      .run(oldFingerprint(cfg.path, scope, sidecarIdentity(cfg)), scope);
    assert.equal(JSON.parse(row(root, "findings", target.id)!.body).closed, undefined, "the stale projection really lacks the application");
    assert.equal((d.prepare("SELECT COUNT(*) AS n FROM ruling_applications WHERE issue_id = ?").get(target.id) as any).n, 0);
    assert.equal(JSON.parse(row(root, "bugs", targetBug.id)!.body).closed, undefined);
    const folds = foldCount();
    const sync = await sharedSync(root) as any;
    ok(sync);
    assert.ok(foldCount() >= folds + 3, "the unchanged decision, finding and bug shards were re-folded");
    for (const scope of [ds, fs, bs]) {
      assert.equal(await scopeFingerprint(cfg.path, scope, sidecarIdentity(cfg)), before.get(scope));
      assert.equal(shardBytes(cfg.path, scope), bytes.get(scope), "upgrade changed no shard bytes");
    }
    assert.ok(row(root, "decision_records", otherDecision)?.body.includes(revised.revision));
    assert.equal((await readFinding(root, target.id))?.closed?.eventId, applied.application);
    assert.equal((await readBug(root, targetBug.id))?.closed?.eventId, bugApplied.application);
    assert.equal((d.prepare("SELECT COUNT(*) AS n FROM ruling_applications WHERE issue_id = ?").get(target.id) as any).n, 1);
    assert.equal((d.prepare("SELECT COUNT(*) AS n FROM ruling_applications WHERE issue_id = ?").get(targetBug.id) as any).n, 1);
    assert.equal((await sharedFindings(root, 7) as any).findings.find((f: any) => f.id === other.id)?.backlogged?.until, "2099-01-01");
    assert.equal((await listBugs(root, { backlog: true }) as any).bugs.find((x: any) => x.id === bug.id)?.backlogged?.until, "2099-01-01");
    assert.equal((await sharedDocs(root) as any).docs.find((x: any) => x.nodeId === "n_upgrade")?.nodeId, "n_upgrade");
    assert.ok((await decisionRound(root, "R1") as any).decisions.some((x: any) => x.id === otherDecision));
  } finally { t.dispose(); discard(tx); }
});

test("missing and wrong sidecars serve marked cached rows and refuse a new ruling execution", async () => {
  const t = await team([A]);
  const otherSidecar = mkdtempSync(join(tmpdir(), "codemap-upgrade-other-sidecar-"));
  try {
    const m = t.all[0] as Member, root = m.repo, sidecar = m.sidecar;
    const filed = await as(true, () => shareFinding(root, 7, { targetKind: "anchor", targetId: "src/pay.ts#transfer", text: "unresolved transfer defect" })) as any;
    ok(filed);
    ok(await as(true, () => postRound(root, { round: { id: "R1", source: "upgrade probe" }, decisions: [decision("target", filed.id)] })));
    const answered = await as(false, () => answerDirect(root, { decision: "target", option: "No" })) as any;
    assert.equal(answered.recorded, true, JSON.stringify(answered));
    ok(await sharedSync(root));
    const point = (path: string) => writeFileSync(join(root, ".codemap", "sidecar"), path);
    const issue = { kind: "finding" as const, universe: universeKey(root), id: filed.id, review: 7 };
    for (const path of [sidecar + "-missing", otherSidecar]) {
      if (path === otherSidecar) await ensureSidecar(otherSidecar, { principal: "other@acme.test" });
      point(path);
      // Force a miss: ordinary cache hits deliberately defer binding checks.
      db(root).prepare("UPDATE shared_scope SET fingerprint = 'older-build' WHERE scope LIKE 'decisions/%' OR scope LIKE 'findings/%'").run();
      const rounds = await decisionRound(root, "R1") as any;
      const findings = await sharedFindings(root, 7) as any;
      assert.equal(rounds.status, "blocked", JSON.stringify(rounds));
      assert.equal(findings.scope?.status, "blocked", JSON.stringify(findings));
      assert.ok(findings.findings.some((f: any) => f.id === filed.id), "the cached row was not erased");
      const refused = await as(true, () => applyRuling(root, { issue, answerId: answered.answer, readers: [] })) as any;
      assert.match(String(refused.error), /sidecar|blocked|missing|different/i, JSON.stringify(refused));
      assert.equal((await readFinding(root, filed.id))?.applications?.length ?? 0, 0);
    }
    point(sidecar);
    ok(await sharedSync(root));
    assert.equal((await decisionRound(root, "R1") as any).status, "complete");
    const scope = decisionScope(universeKey(root));
    const shard = join(sidecar, scope, readdirSync(join(sidecar, scope)).find((name) => name.endsWith(SHARD_EXT))!);
    const intact = readFileSync(shard);
    writeFileSync(shard, Buffer.concat([Buffer.from("\x00\x01 garbage\n"), intact]));
    try {
      const blocked = await decisionRound(root, "R1") as any;
      assert.equal(blocked.status, "blocked", JSON.stringify(blocked));
      assert.equal(blocked.diagnostic?.reason, "corrupt-shard");
      const refused = await as(true, () => applyRuling(root, { issue, answerId: answered.answer, readers: [] })) as any;
      assert.match(String(refused.error), /blocked|corrupt/i, JSON.stringify(refused));
      assert.equal((await readFinding(root, filed.id))?.applications?.length ?? 0, 0);
    } finally { writeFileSync(shard, intact); }
  } finally { t.dispose(); discard(otherSidecar); }
});
