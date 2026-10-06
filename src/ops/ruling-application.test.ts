import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { indexBlob } from "../repo.js";
import { writeStore, readFinding, readBug } from "../store.js";
import { shareFinding } from "../ops-shared.js";
import { postRound, answerDirect, withdrawDecision } from "./decisions.js";
import { universeKey, sidecarIdentity, sidecarWriteDoor } from "../sidecar-config.js";
import { reportBug } from "./bugs.js";
import { reviseOn, setFindingState } from "../ops.js";
import { createFinding, findingScope, foldFindings } from "../shared-findings.js";
import { readCached } from "../materialize.js";
import { findingsProjection } from "../shared-projections.js";
import { applicationReaderBrief, submitApplicationVerdict, recordApplicationVerdict, applyRuling } from "./ruling-application.js";
import { readerReceipts } from "../reader-local.js";
import { discard } from "../test-tmp.js";

const SRC = "export function creditLine(cents) { return cents * 2; }\n";
const session = "5e55a0a0-0000-0000-0000-000000000001";
const asAgent = async (fn: () => Promise<void>) => {
  const old = process.env.CODEMAP_AGENT_MODEL;
  process.env.CODEMAP_AGENT_MODEL = "claude-opus-5";
  try { await fn(); } finally { if (old === undefined) delete process.env.CODEMAP_AGENT_MODEL; else process.env.CODEMAP_AGENT_MODEL = old; }
};
const asPerson = async (fn: () => Promise<void>) => {
  const old = process.env.CODEMAP_AGENT_MODEL;
  delete process.env.CODEMAP_AGENT_MODEL;
  try { await fn(); } finally { if (old !== undefined) process.env.CODEMAP_AGENT_MODEL = old; }
};
const error = (v: any) => String(v?.error ?? v?.reason ?? "");

async function fixture(direct: boolean | "link" | "unselected" = true, acceptance = false) {
  const root = mkdtempSync(join(tmpdir(), "codemap-apply-"));
  const side = mkdtempSync(join(tmpdir(), "codemap-apply-side-"));
  const tx = mkdtempSync(join(tmpdir(), "codemap-apply-tx-"));
  const git = (...args: string[]) => spawnSync("git", args, { cwd: root });
  git("init", "-q", "-b", "main");
  git("config", "user.email", "alice@x.com");
  git("config", "user.name", "alice");
  mkdirSync(join(root, ".codemap")); mkdirSync(join(root, "src"));
  writeFileSync(join(root, ".codemap", "sidecar"), side);
  writeFileSync(join(root, "src/credit.js"), SRC);
  const anchors = await indexBlob(SRC, "src/credit.js");
  await writeStore(root, anchors, { schemaVersion: 1, lastVerifiedCommit: null, branch: null } as any);
  let id = "";
  await asAgent(async () => {
    const filed = await shareFinding(root, 7, { targetKind: "anchor", targetId: anchors[0]!.id, text: "creditLine doubles" }) as any;
    assert.equal(filed.error, undefined, JSON.stringify(filed));
    id = filed.id;
    const question = acceptance ? `D1: explicitly accept ${id} as real and deliberately not being fixed?` : direct === "link"
      ? `D1: does /#/u/${encodeURIComponent(universeKey(root))}/shared/7/findings?f=${id} remain a defect?`
      : direct === true ? `D1: does ${id} remain a defect?` : "D1: does this doubling remain a defect?";
    const posted = await postRound(root, { round: { id: "R1", source: "x" }, decisions: [{ id: "d1", round: "R1", ref: "D1", kind: "options",
      payload: { question, header: "F", options: [{ label: "Not a defect", description: acceptance ? "Real, deliberately not being fixed permanently" : "close as refuted" }, { label: "Real, fix it", description: direct === "unselected" ? `fix ${id}` : "fix work" }] },
      options: [{ label: "Not a defect", effects: (direct === true || direct === "link") ? [{ findings: [id], on: "settle", as: acceptance ? "accepted" : "refuted" }] : [] }, { label: "Real, fix it", effects: (direct === true || direct === "link") ? [{ findings: [id], on: "unblock" }] : [] }],
    }] }) as any;
    assert.equal(posted.ok, true, JSON.stringify(posted));
  });
  let answer = "";
  await asPerson(async () => {
    const r = await answerDirect(root, { decision: "d1", option: "Not a defect" }) as any;
    assert.equal(r.recorded, true, JSON.stringify(r));
    answer = r.answer;
  });
  const issue = { kind: "finding" as const, universe: universeKey(root), id, review: 7 };
  return { root, side, tx, id, answer, issue, cleanup: () => { discard(root); discard(side); discard(tx); } };
}

function transcript(dir: string, prompt: string, requestId: string, verdict: string, rationale: string, receipt: string, agentId = "a12345678", sessionId = session) {
  const sub = join(dir, sessionId, "subagents"); mkdirSync(sub, { recursive: true });
  const launch = `toolu_launch_${agentId}`, call = `toolu_submit_${agentId}`;
  writeFileSync(join(sub, `agent-${agentId}.meta.json`), JSON.stringify({ agentType: "general-purpose", toolUseId: launch }));
  writeFileSync(join(sub, `agent-${agentId}.jsonl`), [
    { type: "user", isSidechain: true, agentId, sessionId, message: { role: "user", content: prompt } },
    { type: "assistant", isSidechain: true, agentId, sessionId, message: { content: [{ type: "tool_use", id: call, name: "mcp__codemap__submit_application_verdict", input: { requestId, verdict, rationale } }] } },
    { type: "user", isSidechain: true, agentId, sessionId, message: { content: [{ type: "tool_result", tool_use_id: call, content: JSON.stringify({ ok: true, held: true, receipt }) }] } },
  ].map((x) => JSON.stringify(x)).join("\n") + "\n");
  writeFileSync(join(dir, `${sessionId}.jsonl`), [
    { type: "assistant", isSidechain: false, timestamp: new Date().toISOString(), message: { content: [{ type: "tool_use", id: launch, name: "Agent", input: { prompt, subagent_type: "general-purpose" } }] } },
    { type: "user", isSidechain: false, message: { content: [{ type: "tool_result", tool_use_id: launch, content: "launched" }] }, toolUseResult: { agentId } },
  ].map((x) => JSON.stringify(x)).join("\n") + "\n");
  return { agentId, callId: call, requestId, receipt };
}

test("application refuses bare approval and requires a recorded authentic reader call; retry keeps one event", async () => {
  const u = await fixture();
  try {
    await asAgent(async () => {
      assert.match(error(await applyRuling(u.root, { issue: u.issue, answerId: u.answer, readers: [] }, u.tx)), /one independent sound reader/);
      const brief = await applicationReaderBrief(u.root, { issue: u.issue, answerId: u.answer, slot: 1 }, u.tx) as any;
      assert.equal(brief.ok, true, JSON.stringify(brief));
      const held = submitApplicationVerdict(u.root, { requestId: brief.requestId, verdict: "sound", rationale: "The person rejects the premise." }) as any;
      const ref = { requestId: brief.requestId, receipt: held.receipt, agentId: "a12345678", callId: "toolu_submit_a12345678" };
      assert.match(error(await applyRuling(u.root, { issue: u.issue, answerId: u.answer, readers: [ref] }, u.tx)), /not recorded/);
      assert.equal((await readFinding(u.root, u.id))?.state, "issued");
      assert.equal((recordApplicationVerdict(u.root, ref, u.tx) as any).pending, true);
      transcript(u.tx, brief.prompt, brief.requestId, "sound", "The person rejects the premise.", held.receipt);
      assert.equal((recordApplicationVerdict(u.root, ref, u.tx) as any).recorded, true);
      const applied = await applyRuling(u.root, { issue: u.issue, answerId: u.answer, readers: [ref] }, u.tx) as any;
      assert.equal(applied.ok, true, JSON.stringify(applied));
      assert.equal((await readFinding(u.root, u.id))?.state, "refuted", JSON.stringify(await readFinding(u.root, u.id)));
      const retry = await applyRuling(u.root, { issue: u.issue, answerId: u.answer, readers: [] }, u.tx) as any;
      assert.equal(retry.application, applied.application, JSON.stringify(retry));
    });
  } finally { u.cleanup(); }
});

test("indirect application needs independent readers and arbitration needs their recorded disagreement", async () => {
  const u = await fixture(false);
  try {
    await asAgent(async () => {
      const one = await applicationReaderBrief(u.root, { issue: u.issue, answerId: u.answer, slot: 1 }, u.tx) as any;
      assert.equal(one.directMention, false, JSON.stringify(one));
      assert.match(error(await applyRuling(u.root, { issue: u.issue, answerId: u.answer, readers: [] }, u.tx)), /two independent/);
      assert.match(error(await applicationReaderBrief(u.root, { issue: u.issue, answerId: u.answer, role: "arbitrator", slot: 3 }, u.tx)), /two recorded/);
    });
  } finally { u.cleanup(); }
});


test("changed issue claim, withdrawn ruling, and prior ordinary closure refuse application without spending the pair", async () => {
  const stale = await fixture();
  try {
    let oldRef: ReturnType<typeof transcript>;
    await asAgent(async () => {
      const brief = await applicationReaderBrief(stale.root, { issue: stale.issue, answerId: stale.answer, slot: 1 }, stale.tx) as any;
      const held = submitApplicationVerdict(stale.root, { requestId: brief.requestId, verdict: "sound", rationale: "The old claim is answered." }) as any;
      oldRef = transcript(stale.tx, brief.prompt, brief.requestId, "sound", "The old claim is answered.", held.receipt);
      assert.equal((recordApplicationVerdict(stale.root, oldRef, stale.tx) as any).recorded, true);
      const revised = await reviseOn(stale.root, { id: stale.id, text: "creditLine silently triples" }) as any;
      assert.equal(revised.error, undefined, JSON.stringify(revised));
      const next = await applicationReaderBrief(stale.root, { issue: stale.issue, answerId: stale.answer, slot: 1 }, stale.tx) as any;
      assert.equal(next.ok, true, JSON.stringify(next));
      assert.notEqual(next.requestId, brief.requestId);
      assert.match(error(await applyRuling(stale.root, { issue: stale.issue, answerId: stale.answer, readers: [oldRef] }, stale.tx)), /another issue\/ruling version/);
    });
    await asPerson(async () => {
      const withdrawn = await withdrawDecision(stale.root, { decision: "d1", answer: stale.answer, reason: "I changed my mind" }) as any;
      assert.equal(withdrawn.ok, true, JSON.stringify(withdrawn));
    });
    await asAgent(async () => {
      assert.match(error(await applyRuling(stale.root, { issue: stale.issue, answerId: stale.answer, readers: [oldRef] }, stale.tx)), /no current verified authority/);
    });
  } finally { stale.cleanup(); }

  const closed = await fixture();
  try {
    await asPerson(async () => {
      const r = await setFindingState(closed.root, { id: closed.id, state: "invalid", reason: "separate investigation" }) as any;
      assert.equal(r.error, undefined, JSON.stringify(r));
    });
    await asAgent(async () => {
      assert.match(error(await applyRuling(closed.root, { issue: closed.issue, answerId: closed.answer, readers: [] }, closed.tx)), /already closed/);
      assert.equal((await readFinding(closed.root, closed.id))?.applications?.length ?? 0, 0);
    });
  } finally { closed.cleanup(); }
});

test("an ambiguous finding ID in a bare question needs two readers", async () => {
  const u = await fixture();
  try {
    const cfg = sidecarWriteDoor(u.root).cfg!;
    const original = (await readFinding(u.root, u.id))!;
    await createFinding(u.side, `${u.issue.universe}/pr-8`, original.author, {
      id: u.id, targetKind: "anchor", targetId: original.target.id, text: "second review has same ID",
    });
    const second = findingScope(`${u.issue.universe}/pr-8`);
    await readCached(u.root, u.side, second, sidecarIdentity(cfg), foldFindings, findingsProjection);
    await asAgent(async () => {
      const brief = await applicationReaderBrief(u.root, { issue: u.issue, answerId: u.answer, slot: 1 }, u.tx) as any;
      assert.equal(brief.ok, true, JSON.stringify(brief));
      assert.equal(brief.directMention, false);
      assert.match(error(await applyRuling(u.root, { issue: u.issue, answerId: u.answer, readers: [] }, u.tx)), /two independent/);
    });
  } finally { u.cleanup(); }
});

test("a typed bug ruling uses exact bug scope and closes only with an authentic reader", async () => {
  const u = await fixture();
  try {
    let bugId = "";
    await asAgent(async () => {
      const bug = await reportBug(u.root, { title: "Credit doubles unexpectedly", description: "The result is wrong", anchors: [(await readFinding(u.root, u.id))!.target.id] }) as any;
      assert.equal(bug.ok, true, JSON.stringify(bug)); bugId = bug.id;
      const ref = { kind: "bug" as const, universe: u.issue.universe, id: bugId, scope: `bugs/${u.issue.universe}` };
      const posted = await postRound(u.root, { round: { id: "BR1", source: "bug" }, decisions: [{
        id: "bug-d1", round: "BR1", ref: "D1", kind: "options",
        payload: { question: `D1: is ${bugId} a defect?`, header: "B", options: [{ label: "Not a defect", description: "close" }, { label: "Real", description: "fix" }] },
        options: [{ label: "Not a defect", effects: [{ findings: [], issues: [ref], on: "settle", as: "refuted" }] },
          { label: "Real", effects: [{ findings: [], issues: [ref], on: "unblock" }] }],
      }] }) as any;
      assert.equal(posted.ok, true, JSON.stringify(posted));
    });
    let answer = "";
    await asPerson(async () => {
      const r = await answerDirect(u.root, { decision: "bug-d1", option: "Not a defect" }) as any;
      assert.equal(r.recorded, true, JSON.stringify(r)); answer = r.answer;
    });
    const issue = { kind: "bug" as const, universe: u.issue.universe, id: bugId };
    await asAgent(async () => {
      const brief = await applicationReaderBrief(u.root, { issue, answerId: answer, slot: 1 }, u.tx) as any;
      assert.equal(brief.ok, true, JSON.stringify(brief));
      const held = submitApplicationVerdict(u.root, { requestId: brief.requestId, verdict: "sound", rationale: "The ruling defeats the reported bug." }) as any;
      const ref = transcript(u.tx, brief.prompt, brief.requestId, "sound", "The ruling defeats the reported bug.", held.receipt);
      assert.equal((recordApplicationVerdict(u.root, ref, u.tx) as any).recorded, true);
      const applied = await applyRuling(u.root, { issue, answerId: answer, readers: [ref] }, u.tx) as any;
      assert.equal(applied.ok, true, JSON.stringify(applied));
      assert.equal((await readBug(u.root, bugId))?.state, "refuted");
      assert.equal((await readFinding(u.root, u.id))?.state, "issued");
    });
  } finally { u.cleanup(); }
});


test("an exact shown review link disambiguates a repeated finding ID; an unselected option does not", async () => {
  const linked = await fixture("link");
  const unselected = await fixture("unselected");
  try {
    for (const u of [linked, unselected]) {
      const original = (await readFinding(u.root, u.id))!;
      await createFinding(u.side, `${u.issue.universe}/pr-8`, original.author,
        { id: u.id, targetKind: "anchor", targetId: original.target.id, text: "same ID on another review" });
      const cfg = sidecarWriteDoor(u.root).cfg!;
      await readCached(u.root, u.side, findingScope(`${u.issue.universe}/pr-8`), sidecarIdentity(cfg), foldFindings, findingsProjection);
    }
    await asAgent(async () => {
      const link = await applicationReaderBrief(linked.root, { issue: linked.issue, answerId: linked.answer, slot: 1 }, linked.tx) as any;
      const hidden = await applicationReaderBrief(unselected.root, { issue: unselected.issue, answerId: unselected.answer, slot: 1 }, unselected.tx) as any;
      assert.equal(link.directMention, true, JSON.stringify(link));
      assert.equal(hidden.directMention, false, JSON.stringify(hidden));
    });
  } finally { linked.cleanup(); unselected.cleanup(); }
});


test("disagreeing indirect readers need an authentic arbitrator who sees both rationales", async () => {
  const u = await fixture(false);
  try {
    await asAgent(async () => {
      const refs: ReturnType<typeof transcript>[] = [];
      for (const [slot, verdict, rationale] of [[1, "sound", "The ruling rebuts the claim."], [2, "unsound", "The evidence still shows a defect."]] as const) {
        const brief = await applicationReaderBrief(u.root, { issue: u.issue, answerId: u.answer, slot }, u.tx) as any;
        assert.equal(brief.ok, true, JSON.stringify(brief));
        const held = submitApplicationVerdict(u.root, { requestId: brief.requestId, verdict, rationale }) as any;
        const ref = transcript(u.tx, brief.prompt, brief.requestId, verdict, rationale, held.receipt,
          `a1234567${slot}`, `5e55a0a0-0000-0000-0000-00000000000${slot}`);
        assert.equal((recordApplicationVerdict(u.root, ref, u.tx) as any).recorded, true);
        refs.push(ref);
      }
      assert.match(error(await applyRuling(u.root, { issue: u.issue, answerId: u.answer, readers: refs }, u.tx)), /arbitrator/);
      const arb = await applicationReaderBrief(u.root, { issue: u.issue, answerId: u.answer, role: "arbitrator", slot: 3, readers: refs }, u.tx) as any;
      assert.equal(arb.ok, true, JSON.stringify(arb));
      assert.match(arb.prompt, /The ruling rebuts the claim/);
      assert.match(arb.prompt, /The evidence still shows a defect/);
      const held = submitApplicationVerdict(u.root, { requestId: arb.requestId, verdict: "sound", rationale: "The ruling addresses the complete premise." }) as any;
      const arbRef = transcript(u.tx, arb.prompt, arb.requestId, "sound", "The ruling addresses the complete premise.", held.receipt,
        "a12345673", "5e55a0a0-0000-0000-0000-000000000003");
      assert.equal((recordApplicationVerdict(u.root, arbRef, u.tx) as any).recorded, true);
      const result = await applyRuling(u.root, { issue: u.issue, answerId: u.answer, readers: refs, arbitrator: arbRef }, u.tx) as any;
      assert.equal(result.ok, true, JSON.stringify(result));
      assert.equal((await readFinding(u.root, u.id))?.state, "invalid");
    });
  } finally { u.cleanup(); }
});


test("explicit human acceptance is credited to the answerer, never reported as fixed or refuted", async () => {
  const u = await fixture(true, true);
  const oldPrincipal = process.env.CODEMAP_PRINCIPAL;
  try {
    process.env.CODEMAP_PRINCIPAL = "bob@x.com";
    await asAgent(async () => {
      const brief = await applicationReaderBrief(u.root, { issue: u.issue, answerId: u.answer, slot: 1 }, u.tx) as any;
      assert.equal(brief.ok, true, JSON.stringify(brief));
      assert.match(brief.prompt, /deliberately not being fixed/);
      assert.match(error(await applyRuling(u.root, { issue: u.issue, answerId: u.answer, readers: [] }, u.tx)), /one independent sound reader/);
      const rationale = "The exact shown human choice accepts the complete real claim permanently; it does not authorize a repair.";
      const held = submitApplicationVerdict(u.root, { requestId: brief.requestId, verdict: "sound", rationale }) as any;
      const ref = transcript(u.tx, brief.prompt, brief.requestId, "sound", rationale, held.receipt);
      assert.equal((recordApplicationVerdict(u.root, ref, u.tx) as any).recorded, true);
      const applied = await applyRuling(u.root, { issue: u.issue, answerId: u.answer, readers: [ref] }, u.tx) as any;
      assert.equal(applied.ok, true, JSON.stringify(applied));
      const finding = await readFinding(u.root, u.id);
      assert.equal(finding?.state, "accepted");
      assert.equal(finding?.closed?.by.principal, "alice@x.com");
      assert.equal(finding?.closed?.by.via, undefined);
      assert.equal(finding?.applications?.[0]?.by.principal, "bob@x.com");
      assert.equal(finding?.repairClosure, undefined);
      await asPerson(async () => {
        const reopened = await setFindingState(u.root, { id: u.id, state: "issued", reason: "follow-up" }) as any;
        assert.equal(reopened.error, undefined, JSON.stringify(reopened));
      });
      await applyRuling(u.root, { issue: u.issue, answerId: u.answer, readers: [ref] }, u.tx);
      assert.equal((await readFinding(u.root, u.id))?.state, "issued", "same human ruling is spent after reopening");
    });
  } finally { if (oldPrincipal === undefined) delete process.env.CODEMAP_PRINCIPAL; else process.env.CODEMAP_PRINCIPAL = oldPrincipal; u.cleanup(); }
});

test("D3: an application reader recorded by receipt alone; a fork, or a call never on disk past the grace, is an error that spends the receipt", async () => {
  const u = await fixture();
  const grace = process.env.CODEMAP_VERDICT_GRACE_MS;
  try {
    await asAgent(async () => {
      const hold = async (slot: number) => {
        const brief = await applicationReaderBrief(u.root, { issue: u.issue, answerId: u.answer, slot }, u.tx) as any;
        assert.equal(brief.ok, true, JSON.stringify(brief));
        const held = submitApplicationVerdict(u.root, { requestId: brief.requestId, verdict: "sound", rationale: "The person rejects the premise." }) as any;
        return { brief, held, ref: { requestId: brief.requestId, receipt: held.receipt } };
      };
      const forked = await hold(1);
      transcript(u.tx, forked.brief.prompt, forked.brief.requestId, "sound", "The person rejects the premise.", forked.held.receipt, "a55555555");
      writeFileSync(join(u.tx, session, "subagents", "agent-a55555555.meta.json"), JSON.stringify({ agentType: "fork", isFork: true, toolUseId: "toolu_launch_a55555555" }));
      assert.match(error(recordApplicationVerdict(u.root, forked.ref, u.tx)), /is a fork/);
      assert.match(error(recordApplicationVerdict(u.root, forked.ref, u.tx)), /reader receipt is invalid/);
      const unwritten = await hold(2);
      assert.equal((recordApplicationVerdict(u.root, unwritten.ref, u.tx) as any).pending, true);
      process.env.CODEMAP_VERDICT_GRACE_MS = "0";
      assert.match(error(recordApplicationVerdict(u.root, unwritten.ref, u.tx)), /past the grace/);
    });
  } finally {
    if (grace === undefined) delete process.env.CODEMAP_VERDICT_GRACE_MS; else process.env.CODEMAP_VERDICT_GRACE_MS = grace;
    u.cleanup();
  }
});

test("a recorded retry returns the whole reader reference, so a lost first response is recoverable (Codex, 2026-10-06)", async () => {
  const u = await fixture();
  try {
    await asAgent(async () => {
      const brief = await applicationReaderBrief(u.root, { issue: u.issue, answerId: u.answer, slot: 1 }, u.tx) as any;
      const held = submitApplicationVerdict(u.root, { requestId: brief.requestId, verdict: "sound", rationale: "The person rejects the premise." }) as any;
      const ref = transcript(u.tx, brief.prompt, brief.requestId, "sound", "The person rejects the premise.", held.receipt);
      assert.equal((recordApplicationVerdict(u.root, ref, u.tx) as any).recorded, true);
      const again = recordApplicationVerdict(u.root, { requestId: ref.requestId, receipt: ref.receipt }, u.tx) as any;
      assert.equal(again.existing, true, JSON.stringify(again));
      assert.deepEqual([again.agentId, again.callId], [ref.agentId, ref.callId]);
    });
  } finally { u.cleanup(); }
});
