import { test } from "node:test";
import assert from "node:assert/strict";
import { team, settle } from "./oracle.js";
import { Ledger, checkAlways, checkSettled } from "./oracle-properties.js";
import { postRound, answerDirect, confirmReading, decisionRound, CONFIRM_YES } from "./ops/decisions.js";

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
