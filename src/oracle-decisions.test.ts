import { test } from "node:test";
import assert from "node:assert/strict";
import { team, settle } from "./oracle.js";
import { Ledger, checkAlways, checkSettled } from "./oracle-properties.js";
import { shareFinding } from "./ops-shared.js";
import { postRound, answerDirect, confirmReading, decisionRound, decisionStatus, nominateComparison, CONFIRM_YES } from "./ops/decisions.js";

test("a changed response and a stale clone's confirmation converge without reviving its old reading", async () => {
  const previous = process.env.CODEMAP_AGENT_MODEL;
  delete process.env.CODEMAP_AGENT_MODEL;
  let t: Awaited<ReturnType<typeof team>> | undefined;
  const ledger = new Ledger();
  try {
    t = await team(["ana@acme.test", "ana@acme.test"]);
    const [a, b] = t.all;
    const posted = await postRound(a!.repo, { round: { id: "R1", source: "questionnaire" }, decisions: [{
      id: "d1", round: "R1", ref: "D1", kind: "options",
      payload: { question: "D1: should the operation retry?", options: [{ label: "Retry" }, { label: "Stop" }] },
      options: [{ label: "Retry", effects: [] }, { label: "Stop", effects: [] }],
    }] });
    assert.equal("ok" in posted && posted.ok, true, JSON.stringify(posted));
    const original = await answerDirect(a!.repo, { decision: "d1", words: "retry after checking" }) as any;
    assert.equal(original.recorded, true);
    const confirmation = await confirmReading(a!.repo, { answer: original.answer, maps: [{ decision: "d1", option: "Retry" }] }) as any;
    assert.equal(confirmation.ok, true, JSON.stringify(confirmation));
    await settle(t);
    await checkSettled(t, ledger);

    const correction = await answerDirect(b!.repo, { decision: "d1", words: "stop and investigate" }) as any;
    assert.equal(correction.recorded, true);
    await checkAlways(t, ledger);
    // This clone has not received the correction and honestly accepts the old confirmation.
    const late = await answerDirect(a!.repo, { decision: confirmation.confirm, option: CONFIRM_YES }) as any;
    assert.equal(late.recorded, true);
    await checkAlways(t, ledger);
    await settle(t);
    await checkSettled(t, ledger);

    const views = await Promise.all(t.all.map((m) => decisionRound(m.repo, "R1"))) as any[];
    for (const view of views) {
      assert.equal(view.status, "complete");
      const d = view.decisions.find((x: any) => x.id === "d1");
      assert.deepEqual(d.answers.map((x: any) => x.words).sort(), ["retry after checking", "stop and investigate"]);
      assert.equal(d.answers.find((x: any) => x.id === original.answer).cancelled.by, correction.answer);
      assert.equal(d.standing, null);
      assert.deepEqual(view.awaitingReading.map((x: any) => x.answer), [correction.answer]);
      const c = view.decisions.find((x: any) => x.id === confirmation.confirm);
      assert.equal(c.confirm.state, "no longer needed");
      assert.ok(c.answers.some((x: any) => x.id === late.answer && x.cancelled));
      assert.ok(!view.waitingOnYou.some((x: any) => x.decision === c.id));
    }
    assert.deepEqual(views[0].decisions, views[1].decisions);
  } finally {
    t?.dispose();
    if (previous === undefined) delete process.env.CODEMAP_AGENT_MODEL;
    else process.env.CODEMAP_AGENT_MODEL = previous;
  }
});


test("two clones retain a nominated comparison and its local retrieval cursor", async () => {
  const previous = process.env.CODEMAP_AGENT_MODEL;
  delete process.env.CODEMAP_AGENT_MODEL;
  let t: Awaited<ReturnType<typeof team>> | undefined;
  const ledger = new Ledger();
  try {
    t = await team(["alice@acme.test", "bob@acme.test"]);
    const [alice, bob] = t.all;
    const f = await shareFinding(alice!.repo, 7, { targetKind: "anchor", targetId: "src/pay.ts#transfer", text: "transfer currency" }) as any;
    const g = await shareFinding(alice!.repo, 7, { targetKind: "anchor", targetId: "src/pay.ts#transfer", text: "transfer rounding" }) as any;
    assert.ok(f.id && g.id);
    await settle(t);
    await checkSettled(t, ledger);
    const d = (id: string, ref: string, issue: string) => ({ id, ref, round: "R1", kind: "options" as const,
      payload: { question: `${ref}: is ${issue} a defect?`, options: [{ label: "No", description: "premise is false" }, { label: "Yes", description: "repair the code" }] },
      options: [{ label: "No", effects: [{ findings: [issue], on: "settle" as const, as: "refuted" as const }] },
        { label: "Yes", effects: [{ findings: [issue], on: "unblock" as const }] }] });
    const posted = await postRound(alice!.repo, { round: { id: "R1", source: "oracle" }, decisions: [d("d1", "D1", f.id), d("d2", "D2", g.id)] }) as any;
    assert.equal(posted.ok, true, JSON.stringify(posted));
    await settle(t);
    await checkSettled(t, ledger);
    const a = await answerDirect(alice!.repo, { decision: "d1", option: "No" }) as any;
    const b = await answerDirect(bob!.repo, { decision: "d2", option: "Yes" }) as any;
    assert.ok(a.recorded && b.recorded);
    await checkAlways(t, ledger);
    await settle(t);
    await checkSettled(t, ledger);
    const before = await decisionStatus(bob!.repo, "R1") as any;
    assert.equal(before.intentCandidates.length, 0);
    const nominated = await nominateComparison(alice!.repo, { answers: [a.answer, b.answer], findings: [f.id],
      reason: "the rounding answer may qualify the currency policy" }) as any;
    assert.equal(nominated.ok, true, JSON.stringify(nominated));
    await checkAlways(t, ledger);
    await settle(t);
    await checkSettled(t, ledger);
    for (const member of t.all) {
      const status = await decisionStatus(member.repo, "R1", before.cursor) as any;
      assert.equal(status.changed, true);
      assert.ok(status.intentCandidates.some((x: any) => x.nomination?.id === nominated.nomination));
      assert.ok(status.held.some((x: any) => x.finding === f.id && x.held?.some((h: any) => h.why === "comparison")));
    }
  } finally {
    t?.dispose();
    if (previous === undefined) delete process.env.CODEMAP_AGENT_MODEL;
    else process.env.CODEMAP_AGENT_MODEL = previous;
  }
});
