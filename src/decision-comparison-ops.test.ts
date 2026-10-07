import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { indexBlob } from "./repo.js";
import { writeStore } from "./store.js";
import { shareFinding } from "./ops-shared.js";
import { postRound, answerDirect, reviseDecision, decisionRounds } from "./ops/decisions.js";
import { requestComparison, comparisonBrief, submitComparisonJudgment, recordComparisonJudgment,
  comparisonDetail, comparisonResolutionBrief, resolveComparison } from "./ops/comparisons.js";
import { decisionsView } from "./ops/decision-holds.js";
import { readScope } from "./eventlog.js";
import { appendUnfolded } from "./test-door.js";
import { isLogDamage } from "./log-damage.js";
import { decisionScope, foldDecisions, comparisonBriefText } from "./shared-decisions.js";
import { resolveDecisionIssue } from "./decision-issues.js";
import { universeKey } from "./sidecar-config.js";
import { discard } from "./test-tmp.js";
import type { State } from "./schema.js";

const SRC = "export function example(x) { return x + 1; }\n";
const SESSION = "5e55a0a0-0000-0000-0000-000000000011";
const env = async (principal: string, agent: boolean, fn: () => Promise<void>) => {
  const oldPrincipal = process.env.CODEMAP_PRINCIPAL, oldModel = process.env.CODEMAP_AGENT_MODEL;
  process.env.CODEMAP_PRINCIPAL = principal;
  if (agent) process.env.CODEMAP_AGENT_MODEL = "test-reader"; else delete process.env.CODEMAP_AGENT_MODEL;
  try { await fn(); } finally {
    if (oldPrincipal === undefined) delete process.env.CODEMAP_PRINCIPAL; else process.env.CODEMAP_PRINCIPAL = oldPrincipal;
    if (oldModel === undefined) delete process.env.CODEMAP_AGENT_MODEL; else process.env.CODEMAP_AGENT_MODEL = oldModel;
  }
};
async function fixture(twoFindings = false) {
  const root = mkdtempSync(join(tmpdir(), "codemap-comparison-op-"));
  const side = mkdtempSync(join(tmpdir(), "codemap-comparison-side-"));
  const transcripts = mkdtempSync(join(tmpdir(), "codemap-comparison-tx-"));
  const git = (...args: string[]) => spawnSync("git", args, { cwd: root });
  git("init", "-q", "-b", "main"); git("config", "user.email", "alice@x.com"); git("config", "user.name", "alice");
  mkdirSync(join(root, ".codemap"), { recursive: true });
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(join(root, ".codemap", "sidecar"), side);
  writeFileSync(join(root, "src", "example.js"), SRC);
  const anchors = await indexBlob(SRC, "src/example.js");
  await writeStore(root, anchors, { schemaVersion: 1, lastVerifiedCommit: null, branch: null } as State);
  let finding = "", secondFinding = "";
  await env("author", true, async () => {
    finding = (await shareFinding(root, 7, { targetKind: "anchor", targetId: anchors[0]!.id, text: "example returns wrong value" }) as any).id;
    if (twoFindings) secondFinding = (await shareFinding(root, 7,
      { targetKind: "anchor", targetId: anchors[0]!.id, text: "example also mishandles another case" }) as any).id;
  });
  const findings = secondFinding ? [finding, secondFinding] : [finding];
  const decision = { id: "d1", round: "R1", ref: "D1", kind: "options" as const,
    payload: { question: `D1: are ${findings.join(" and ")} invalid?`, options: [
      { label: "Reject", description: "Reject claim" }, { label: "Fix", description: "Keep as work" }] },
    options: [
      { label: "Reject", effects: [{ findings, on: "settle" as const, as: "refuted" as const }] },
      { label: "Fix", effects: [{ findings, on: "unblock" as const }] },
    ] };
  await env("author", true, async () => {
    assert.equal((await postRound(root, { round: { id: "R1", source: "comparison-test" }, decisions: [decision] }) as any).ok, true);
  });
  let alice = "", bob = "";
  await env("alice", false, async () => { alice = (await answerDirect(root, { decision: "d1", option: "Reject" }) as any).answer; });
  await env("bob", false, async () => { bob = (await answerDirect(root, { decision: "d1", option: "Fix" }) as any).answer; });
  return { root, side, transcripts, finding, secondFinding, alice, bob, cleanup: () => {
    discard(root); discard(side); discard(transcripts);
  } };
}

function readerTranscript(dir: string, prompt: string, request: string, verdict: string, rationale: string, receipt: string) {
  const agentId = "aCOMPARED12345678", launch = "toolu_launch", call = "toolu_submit";
  const sub = join(dir, SESSION, "subagents"); mkdirSync(sub, { recursive: true });
  writeFileSync(join(sub, `agent-${agentId}.meta.json`), JSON.stringify({ agentType: "general-purpose", toolUseId: launch }));
  const own = [
    { type: "user", uuid: "s1", isSidechain: true, agentId, sessionId: SESSION, message: { role: "user", content: prompt } },
    { type: "assistant", uuid: "s2", isSidechain: true, agentId, sessionId: SESSION, timestamp: new Date().toISOString(),
      message: { content: [{ type: "tool_use", id: call, name: "mcp__codemap__submit_comparison_judgment",
        input: { request, verdict, rationale } }] } },
    { type: "user", uuid: "s3", isSidechain: true, agentId, sessionId: SESSION,
      message: { content: [{ type: "tool_result", tool_use_id: call,
        content: JSON.stringify({ ok: true, held: true, receipt }) }] } },
  ];
  writeFileSync(join(sub, `agent-${agentId}.jsonl`), own.map((x) => JSON.stringify(x)).join("\n") + "\n");
  const parent = [
    { type: "assistant", uuid: "p1", isSidechain: false, timestamp: new Date().toISOString(),
      message: { content: [{ type: "tool_use", id: launch, name: "Agent",
        input: { description: "compare", prompt, subagent_type: "general-purpose" } }] } },
    { type: "user", uuid: "p2", isSidechain: false,
      message: { content: [{ type: "tool_result", tool_use_id: launch, content: "launched" }] },
      toolUseResult: { agentId } },
  ];
  writeFileSync(join(dir, `${SESSION}.jsonl`), parent.map((x) => JSON.stringify(x)).join("\n") + "\n");
}

async function requestAndJudge(u: Awaited<ReturnType<typeof fixture>>, verdict: "equivalent" | "incompatible", issues?: any[]) {
  let id = "", prompt = "";
  await env("reader", true, async () => {
    const requested = await requestComparison(u.root, { answers: [u.alice, u.bob], ...(issues ? { issues } : {}) }) as any;
    assert.equal(requested.ok, true, JSON.stringify(requested)); id = requested.id;
    const brief = await comparisonBrief(u.root, id) as any;
    assert.equal(brief.ok, true, JSON.stringify(brief)); prompt = brief.prompt;
    const held = await submitComparisonJudgment(u.root,
      { request: id, verdict, rationale: "I read both complete questions and instructions." }) as any;
    assert.equal(held.held, true, JSON.stringify(held));
    readerTranscript(u.transcripts, prompt, id, verdict,
      "I read both complete questions and instructions.", held.receipt);
    const recorded = await recordComparisonJudgment(u.root, { request: id }, {}, u.transcripts) as any;
    assert.equal(recorded.recorded, true, JSON.stringify(recorded));
  });
  return id;
}

test("real comparison request and independent transcript equivalence release only the pair restriction", async () => {
  const u = await fixture();
  try {
    const before = await decisionsView(u.root);
    assert.equal((Array.isArray(before.mark(u.finding).held) && (before.mark(u.finding).held as any[]).some((h: any) => h.why === "comparison")), true);
    assert.equal(before.work(u.finding).allowed, false);
    assert.equal((await decisionRounds(u.root)).intentCandidates.length, 1);
    const id = await requestAndJudge(u, "equivalent");
    const after = await decisionsView(u.root);
    assert.equal(after.s.comparisons.find((x) => x.request.id === id)?.projection.state, "equivalent");
    const canonical = after.s.comparisons.find((x) => x.request.id === id)!.request.issues[0] as any;
    assert.equal((Array.isArray(after.issueMark(canonical).held) ? (after.issueMark(canonical).held as any[]).some((h: any) => h.why === "comparison") : undefined), false);
    assert.equal((Array.isArray(after.issueMark(canonical).held) && (after.issueMark(canonical).held as any[]).some((h: any) => h.why === "ruled")), true,
      "Alice's ordinary settle hold survives equivalent intent");
    assert.equal((await comparisonDetail(u.root, id) as any).comparison.projection.restrictsWork, false);
    assert.ok((await decisionRounds(u.root)).comparisons.some((x) => x.id === id));
  } finally { u.cleanup(); }
});

test("I12 sibling: a question resolution finds its AskUserQuestion call from the brief's exact question", async () => {
  const u = await fixture();
  try {
    const id = await requestAndJudge(u, "incompatible");
    const brief = await comparisonResolutionBrief(u.root, id) as any;
    const call = (toolUseId: string, pick: string) => {
      const when = new Date(Date.now() + 1000).toISOString();
      return [{ type: "assistant", uuid: `a-${toolUseId}`, isSidechain: false, timestamp: when, message: { content: [{ type: "tool_use", id: toolUseId, name: "AskUserQuestion", input: { questions: [brief.question] } }] } },
        { type: "user", uuid: `r-${toolUseId}`, isSidechain: false, timestamp: when, sourceToolAssistantUUID: `a-${toolUseId}`, message: { content: [{ type: "tool_result", tool_use_id: toolUseId, content: "…" }] }, toolUseResult: { questions: [brief.question], answers: { [brief.question.question]: pick } } }];
    };
    const file = join(u.transcripts, `${SESSION}.jsonl`);
    // The brief's result is the carrier: the call is looked for only after it (owner, D1, Q1).
    const shown = [{ type: "text", text: JSON.stringify(brief) }];
    const carrier = [{ type: "assistant", uuid: "a-brief", isSidechain: false, message: { content: [{ type: "tool_use", id: "toolu_brief", name: "mcp__codemap__comparison_resolution_brief", input: { id } }] } },
      { type: "user", uuid: "r-brief", isSidechain: false, message: { content: [{ type: "tool_result", tool_use_id: "toolu_brief", content: shown }] }, toolUseResult: shown }];
    writeFileSync(file, [...carrier, ...call("toolu_r1", `Preserve ${u.alice}`)].map((l) => JSON.stringify(l)).join("\n") + "\n");
    await env("resolver", true, async () => {
      const input = { request: id, preserve: u.alice, rationale: "the person chose Alice's ruling",
        shownHash: brief.shownHash, executionsHash: brief.executionsHash, source: "question" as const };
      const resolved = await resolveComparison(u.root, input, {}, u.transcripts) as any;
      assert.equal(resolved.ok, true, JSON.stringify(resolved));
    });
  } finally { u.cleanup(); }
});

test("incompatible real judgment requires shown human resolution; third answer and stale revision remain restricted", async () => {
  const u = await fixture();
  try {
    const id = await requestAndJudge(u, "incompatible");
    const brief = await comparisonResolutionBrief(u.root, id) as any;
    assert.equal(brief.ok, true);
    assert.equal((await comparisonDetail(u.root, id) as any).comparison.projection.state, "incompatible");
    let resolutionEvent = "";
    await env("resolver", false, async () => {
      const resolved = await resolveComparison(u.root, { request: id, preserve: u.alice,
        rationale: "Keep Alice's exact ruling after reviewing both sources and execution history.",
        shownHash: brief.shownHash, executionsHash: brief.executionsHash, source: "web" }) as any;
      assert.equal(resolved.ok, true, JSON.stringify(resolved));
      resolutionEvent = resolved.event;
    });
    const after = await decisionsView(u.root);
    assert.equal(after.s.comparisons.find((x) => x.request.id === id)?.projection.preservedAnswer, u.alice);
    assert.ok(!after.s.decisions[0]!.answers.find((a) => a.id === u.alice)?.comparisonLostOn);
    assert.ok(after.s.decisions[0]!.answers.find((a) => a.id === u.bob)?.comparisonLostOn?.length);
    assert.equal(after.s.decisions[0]!.answers.find((a) => a.id === u.alice)?.id, u.alice);
    await env("third", false, async () => { assert.equal((await answerDirect(u.root, { decision: "d1", option: "Fix" }) as any).ok, true); });
    assert.ok((await decisionRounds(u.root)).intentCandidates.some((c) => c.answers.includes(u.alice) && !c.answers.includes(u.bob)));
    await env("alice", false, async () => {
      const revised = await reviseDecision(u.root, { decision: "d1", revises: [u.alice], findings: [u.finding], option: "Fix" }) as any;
      assert.equal(revised.ok, true, JSON.stringify(revised));
    });
    const historical = (await comparisonDetail(u.root, id) as any).comparison;
    assert.equal(historical.projection.restrictsWork, true);
    assert.ok(historical.resolutions.some((x: any) => x.id === resolutionEvent), "later revision retains the earlier resolution as history");
  } finally { u.cleanup(); }
});


test("revising F1 does not stale an F2-only comparison", async () => {
  const u = await fixture(true);
  try {
    const resolved = await resolveDecisionIssue(u.root,
      { kind: "finding", universe: universeKey(u.root), id: u.secondFinding });
    assert.equal(resolved.ok, true);
    const f2 = resolved.ref;
    const id = await requestAndJudge(u, "equivalent", [f2]);
    await env("alice", false, async () => {
      const revised = await reviseDecision(u.root,
        { decision: "d1", revises: [u.alice], findings: [u.finding], option: "Fix" }) as any;
      assert.equal(revised.ok, true, JSON.stringify(revised));
    });
    const comparison = (await comparisonDetail(u.root, id) as any).comparison;
    assert.equal(comparison.projection.state, "equivalent");
    assert.equal(comparison.projection.restrictsWork, false);
  } finally { u.cleanup(); }
});


test("a scoped revision cannot replace the other issue's comparison source", async () => {
  const u = await fixture(true);
  try {
    let revision = "";
    await env("alice", false, async () => {
      const changed = await reviseDecision(u.root,
        { decision: "d1", revises: [u.alice], findings: [u.finding], option: "Fix" }) as any;
      assert.equal(changed.ok, true, JSON.stringify(changed));
      revision = changed.answer;
    });
    const candidates = (await decisionRounds(u.root)).intentCandidates;
    const f2 = candidates.find((c) => c.findings.includes(u.secondFinding));
    assert.ok(f2, JSON.stringify(candidates));
    assert.deepEqual(new Set(f2.answers), new Set([u.alice, u.bob]));
    assert.ok(!candidates.some((c) => c.findings.includes(u.secondFinding) && c.answers.includes(revision)));
  } finally { u.cleanup(); }
});

test("resolution refuses a newly arrived judgment and replay rejects a subset proof", async () => {
  const u = await fixture();
  try {
    const id = await requestAndJudge(u, "incompatible");
    const old = await comparisonResolutionBrief(u.root, id) as any;
    const request = old.shown.request;
    const scope = decisionScope(universeKey(u.root));
    await appendUnfolded(u.side, scope, { principal: "another-reader" }, "decision.comparison.judged", id, {
      judgment: { requestId: id, contextHash: request.contextHash, issues: request.issues,
        answerVersions: [`${request.left.answerId}\0${request.left.version}`, `${request.right.answerId}\0${request.right.version}`],
        verdict: "incompatible", rationale: "I also found incompatible intent.",
        reader: { principal: "another-reader", agent: "other-reader", session: "other-session", request: "other-launch", receipt: "other-receipt" } },
      proof: { purpose: "pair-comparison", requestId: id, contextHash: request.contextHash,
        brief: comparisonBriefText(request), receipt: "other-receipt", agent: "other-reader",
        session: "other-session", launch: "other-launch", toolUseId: "other-launch", call: "other-call" },
    });
    const fresh = await comparisonResolutionBrief(u.root, id) as any;
    assert.notEqual(fresh.shownHash, old.shownHash);
    await env("resolver", false, async () => {
      const refused = await resolveComparison(u.root, { request: id, preserve: u.alice,
        rationale: "Preserve Alice", shownHash: old.shownHash, executionsHash: old.executionsHash, source: "web" }) as any;
      assert.match(refused.error, /context hash|fresh brief/);
    });
    const forged = await appendUnfolded(u.side, scope, { principal: "resolver" }, "decision.comparison.resolved", id, {
      resolution: { requestId: id, contextHash: request.contextHash, issues: request.issues,
        answerVersions: [`${request.left.answerId}\0${request.left.version}`, `${request.right.answerId}\0${request.right.version}`],
        preserve: u.alice, rationale: "Preserve Alice", human: { principal: "resolver", session: "web", request: id,
          receipt: "forged-receipt", shownHash: old.shownHash } },
      proof: { purpose: "human-comparison", source: "web", principal: "resolver", contextHash: request.contextHash,
        shownHash: old.shownHash, receipt: "forged-receipt", session: "web", shown: old.shown,
        executionsHash: old.executionsHash },
    });
    // A resolution no conforming build writes: the replay halts on it, naming it (plan 1.2).
    const events = await readScope(u.side, scope);
    assert.throws(() => foldDecisions(events), (e: unknown) => isLogDamage(e) && e.entry.id === forged.id);
  } finally { u.cleanup(); }
});

test("a corrected resolution changes the shown frontier before another human act", async () => {
  const u = await fixture();
  try {
    const id = await requestAndJudge(u, "incompatible");
    const initial = await comparisonResolutionBrief(u.root, id) as any;
    let first = "";
    await env("resolver", false, async () => {
      const result = await resolveComparison(u.root, { request: id, preserve: u.alice,
        rationale: "Preserve the first exact ruling", shownHash: initial.shownHash,
        executionsHash: initial.executionsHash, source: "web" }) as any;
      assert.equal(result.ok, true, JSON.stringify(result));
      first = result.event;
    });
    const beforeCorrection = await comparisonResolutionBrief(u.root, id) as any;
    const prior = beforeCorrection.shown.resolutions.find((r: any) => r.id === first);
    assert.ok(prior);
    await env("resolver", false, async () => {
      const result = await resolveComparison(u.root, { request: id, preserve: u.bob,
        rationale: "Correct my earlier choice after reviewing both exact rulings",
        shownHash: beforeCorrection.shownHash, executionsHash: beforeCorrection.executionsHash,
        revises: first, shownResolution: { id: first, preserve: u.alice, receipt: prior.human.receipt },
        source: "web" }) as any;
      assert.equal(result.ok, true, JSON.stringify(result));
    });
    const afterCorrection = await comparisonResolutionBrief(u.root, id) as any;
    assert.notEqual(afterCorrection.shownHash, beforeCorrection.shownHash);
    await env("another-resolver", false, async () => {
      const stale = await resolveComparison(u.root, { request: id, preserve: u.alice,
        rationale: "I saw only the earlier resolution", shownHash: beforeCorrection.shownHash,
        executionsHash: beforeCorrection.executionsHash, source: "web" }) as any;
      assert.match(stale.error, /context hash|fresh brief/);
    });
    assert.equal((await comparisonDetail(u.root, id) as any).comparison.projection.preservedAnswer, u.bob);
  } finally { u.cleanup(); }
});

test("a judgment staged against a comparison resolved meanwhile is refused at the door, as replay applies it (C18)", async () => {
  const u = await fixture();
  try {
    const id = await requestAndJudge(u, "incompatible");
    const brief = await comparisonResolutionBrief(u.root, id) as any;
    const request = brief.shown.request;
    await env("resolver", false, async () => {
      const resolved = await resolveComparison(u.root, { request: id, preserve: u.alice, rationale: "Keep Alice's.",
        shownHash: brief.shownHash, executionsHash: brief.executionsHash, source: "web" }) as any;
      assert.equal(resolved.ok, true, JSON.stringify(resolved));
    });
    const scope = decisionScope(universeKey(u.root));
    const tip = await readScope(u.side, scope);
    const late = { ...tip.at(-1)!, id: "late-judgment", seq: (tip.at(-1)!.seq ?? 0) + 1, kind: "decision.comparison.judged", subject: id,
      actor: { principal: "another-reader" }, data: {
        judgment: { requestId: id, contextHash: request.contextHash, issues: request.issues,
          answerVersions: [`${request.left.answerId}\0${request.left.version}`, `${request.right.answerId}\0${request.right.version}`],
          verdict: "incompatible", rationale: "late", reader: { principal: "another-reader", agent: "a2", session: "s2", request: "l2", receipt: "r2" } },
        proof: { purpose: "pair-comparison", requestId: id, contextHash: request.contextHash, brief: comparisonBriefText(request),
          receipt: "r2", agent: "a2", session: "s2", launch: "l2", toolUseId: "l2", call: "c2" } } };
    const { decisionsDoor } = await import("./shared-decisions.js");
    const refused = (decisionsDoor([...tip, late], late) as { refused: { id: string; why: string }[] }).refused.find((r) => r.id === late.id);
    assert.match(refused?.why ?? "", /comparison changed before judgment append/);
  } finally { u.cleanup(); }
});

test("O4: a resolution that did not see a judgment earlier in the log is refused, not resolved against what it saw", async () => {
  const u = await fixture();
  try {
    const id = await requestAndJudge(u, "incompatible");
    const old = await comparisonResolutionBrief(u.root, id) as any;
    const request = old.shown.request;
    const scope = decisionScope(universeKey(u.root));
    const seen = (await readScope(u.side, scope)).at(-1)!.id;
    const second = await appendUnfolded(u.side, scope, { principal: "another-reader" }, "decision.comparison.judged", id, {
      judgment: { requestId: id, contextHash: request.contextHash, issues: request.issues,
        answerVersions: [`${request.left.answerId}\0${request.left.version}`, `${request.right.answerId}\0${request.right.version}`],
        verdict: "incompatible", rationale: "I also found incompatible intent.",
        reader: { principal: "another-reader", agent: "other-reader", session: "other-session", request: "other-launch", receipt: "other-receipt" } },
      proof: { purpose: "pair-comparison", requestId: id, contextHash: request.contextHash,
        brief: comparisonBriefText(request), receipt: "other-receipt", agent: "other-reader",
        session: "other-session", launch: "other-launch", toolUseId: "other-launch", call: "other-call" },
    });
    // Staged before the second judgment landed: its proof is exactly what it saw.
    const staged = await appendUnfolded(u.side, scope, { principal: "resolver" }, "decision.comparison.resolved", id, {
      resolution: { requestId: id, contextHash: request.contextHash, issues: request.issues,
        answerVersions: [`${request.left.answerId}\0${request.left.version}`, `${request.right.answerId}\0${request.right.version}`],
        preserve: u.alice, rationale: "Preserve Alice", human: { principal: "resolver", session: "web", request: id,
          receipt: "staged-receipt", shownHash: old.shownHash } },
      proof: { purpose: "human-comparison", source: "web", principal: "resolver", contextHash: request.contextHash,
        shownHash: old.shownHash, receipt: "staged-receipt", session: "web", shown: old.shown, executionsHash: old.executionsHash },
    }, { after: [seen], writer: "w_staged" });
    const { foldDecisionsReport } = await import("./shared-decisions.js");
    const all = foldDecisionsReport(await readScope(u.side, scope)).refused;
    const refused = all.find((r) => r.id === staged.id);
    assert.match(refused?.why ?? "", /did not see/, JSON.stringify(all));
    // Control: the same act having seen everything, with the brief it would then be shown, lands —
    // so the refusal above is about what it saw, not how the event was built.
    const fresh = await comparisonResolutionBrief(u.root, id) as any;
    const resolution = (receipt: string, b: any) => ({
      resolution: { requestId: id, contextHash: request.contextHash, issues: request.issues,
        answerVersions: [`${request.left.answerId}\0${request.left.version}`, `${request.right.answerId}\0${request.right.version}`],
        preserve: u.alice, rationale: "Preserve Alice", human: { principal: "resolver", session: "web", request: id, receipt, shownHash: b.shownHash } },
      proof: { purpose: "human-comparison", source: "web", principal: "resolver", contextHash: request.contextHash,
        shownHash: b.shownHash, receipt, session: "web", shown: b.shown, executionsHash: b.executionsHash },
    });
    const informed = await appendUnfolded(u.side, scope, { principal: "resolver" }, "decision.comparison.resolved", id,
      resolution("informed-receipt", fresh), { after: [second.id, staged.id], writer: "w_informed" });
    const again = foldDecisionsReport(await readScope(u.side, scope)).refused;
    assert.ok(!again.some((r) => r.id === informed.id), JSON.stringify(again));
  } finally { u.cleanup(); }
});
