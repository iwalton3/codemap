import { test } from "node:test";
import assert from "node:assert/strict";
import { scenario, who, concurrently, inSequence, settle, views, assertConverged, asAgent, type Scenario } from "./scenario.js";
import { createFinding, corroborate, revise, resolveContest, readFindings, promote } from "./shared-findings.js";

const PR = "acme/api/pr-264";
const NEW = { targetKind: "anchor" as const, targetId: "a_1", text: "the original text", comment: "the original ask", severity: "medium" as const };

async function withTeam(fn: (s: Scenario) => Promise<void>) {
  const s = await scenario(["izzie@x.com", "dana@x.com"]);
  try { await fn(s); } finally { s.dispose(); }
}

/** File a finding as izzie and get everyone onto it. */
async function seeded(s: Scenario): Promise<string> {
  const izzie = who(s, "izzie@x.com");
  const id = await createFinding(izzie.sidecar, PR, izzie.actor, NEW);
  await settle(s);
  return id;
}

// --- the true positive ---------------------------------------------------------

test("two people rewriting the same field without seeing each other is contested", async () => {
  await withTeam(async (s) => {
    const id = await seeded(s);
    await concurrently(
      s,
      "izzie@x.com", (p) => revise(p.sidecar, PR, p.actor, id, { severity: "critical" }),
      "dana@x.com", (p) => revise(p.sidecar, PR, p.actor, id, { severity: "low" }),
    );
    const f = (await readFindings(who(s, "izzie@x.com").sidecar, PR)).get(id)!;
    assert.ok(f.contested?.length, "must not silently pick a winner");
    assert.equal(f.contested![0]!.field, "severity");
    assert.deepEqual(
      [f.contested![0]!.held.value, f.contested![0]!.incoming.value].sort(),
      ["critical", "low"],
      "both values survive — nothing is lost",
    );
  });
});

test("every clone agrees on what is contested", async () => {
  await withTeam(async (s) => {
    const id = await seeded(s);
    await concurrently(
      s,
      "izzie@x.com", (p) => revise(p.sidecar, PR, p.actor, id, { comment: "izzie's wording" }),
      "dana@x.com", (p) => revise(p.sidecar, PR, p.actor, id, { comment: "dana's wording" }),
    );
    assertConverged(await views(s, PR), (f) => `${f.id} ${f.comment} contested=${f.contested?.map((c) => c.field).join(",") ?? "-"}`);
  });
});

// --- the false positives that would train people to ignore it -------------------

test("a revision written AFTER pulling is collaboration, not conflict", async () => {
  // The single most important negative case. Two people editing the same field an
  // hour apart, second one having pulled, is ordinary work — and no wall-clock rule
  // distinguishes it from the real case, which is why causality is the test.
  await withTeam(async (s) => {
    const id = await seeded(s);
    await inSequence(
      s,
      "izzie@x.com", (p) => revise(p.sidecar, PR, p.actor, id, { severity: "critical" }),
      "dana@x.com", (p) => revise(p.sidecar, PR, p.actor, id, { severity: "low" }),
    );
    const f = (await readFindings(who(s, "izzie@x.com").sidecar, PR)).get(id)!;
    assert.equal(f.contested, undefined, "informed disagreement is a revision, not a contest");
    assert.equal(f.severity, "low", "and the later, informed value stands");
  });
});

test("concurrent edits to DIFFERENT fields do not contest", async () => {
  await withTeam(async (s) => {
    const id = await seeded(s);
    await concurrently(
      s,
      "izzie@x.com", (p) => revise(p.sidecar, PR, p.actor, id, { severity: "critical" }),
      "dana@x.com", (p) => revise(p.sidecar, PR, p.actor, id, { category: "Authorization" }),
    );
    const f = (await readFindings(who(s, "dana@x.com").sidecar, PR)).get(id)!;
    assert.equal(f.contested, undefined);
    assert.equal(f.severity, "critical");
    assert.equal(f.category, "Authorization", "both edits land");
  });
});

test("concurrently setting the SAME value is agreement, not conflict", async () => {
  await withTeam(async (s) => {
    const id = await seeded(s);
    await concurrently(
      s,
      "izzie@x.com", (p) => revise(p.sidecar, PR, p.actor, id, { severity: "critical" }),
      "dana@x.com", (p) => revise(p.sidecar, PR, p.actor, id, { severity: "critical" }),
    );
    assert.equal((await readFindings(who(s, "izzie@x.com").sidecar, PR)).get(id)!.contested, undefined);
  });
});

test("one person revising twice from two machines does not contest with themselves", async () => {
  await withTeam(async (s) => {
    const id = await seeded(s);
    const izzie = who(s, "izzie@x.com");
    await revise(izzie.sidecar, PR, izzie.actor, id, { severity: "high" });
    await revise(izzie.sidecar, PR, izzie.actor, id, { severity: "critical" });
    await settle(s);
    assert.equal((await readFindings(izzie.sidecar, PR)).get(id)!.contested, undefined);
  });
});

test("an agent acting for someone does not contest with that person", async () => {
  await withTeam(async (s) => {
    const id = await seeded(s);
    const izzie = who(s, "izzie@x.com");
    await concurrently(
      s,
      "izzie@x.com", (p) => revise(p.sidecar, PR, p.actor, id, { severity: "critical" }),
      "izzie@x.com", () => revise(izzie.sidecar, PR, asAgent(izzie, "claude-opus-5"), id, { severity: "low" }),
    );
    assert.equal((await readFindings(izzie.sidecar, PR)).get(id)!.contested, undefined, "same principal");
  });
});

test("concurrent APPENDS never contest — that is the whole point of the design", async () => {
  // Corroborations, comments and promotions are grow-only or latches. If any of
  // these ever flagged, the detector would be firing on ordinary collaboration.
  await withTeam(async (s) => {
    const id = await seeded(s);
    await concurrently(
      s,
      "izzie@x.com", (p) => corroborate(p.sidecar, PR, p.actor, id, "confirm", "reproduced"),
      "dana@x.com", (p) => corroborate(p.sidecar, PR, p.actor, id, "refute", "guarded upstream"),
    );
    await concurrently(
      s,
      "izzie@x.com", (p) => promote(p.sidecar, PR, p.actor, id),
      "dana@x.com", (p) => promote(p.sidecar, PR, p.actor, id),
    );
    const f = (await readFindings(who(s, "dana@x.com").sidecar, PR)).get(id)!;
    assert.equal(f.contested, undefined);
    assert.equal(f.corroboration.length, 2, "both opinions kept — disagreement is the signal");
    assert.ok(f.promotion, "a latch, set once");
  });
});

// --- clearing it -----------------------------------------------------------------

test("a person clears a contest by stating the value, and it stays cleared", async () => {
  await withTeam(async (s) => {
    const id = await seeded(s);
    await concurrently(
      s,
      "izzie@x.com", (p) => revise(p.sidecar, PR, p.actor, id, { severity: "critical" }),
      "dana@x.com", (p) => revise(p.sidecar, PR, p.actor, id, { severity: "low" }),
    );
    const izzie = who(s, "izzie@x.com");
    const r = await resolveContest(izzie.sidecar, PR, izzie.actor, id, "severity", "high");
    assert.ok(!("error" in r), JSON.stringify(r));
    await settle(s);

    for (const p of s.all) {
      const f = (await readFindings(p.sidecar, PR)).get(id)!;
      // The fold replays history on every read, so "cleared" has to survive that —
      // otherwise the disagreement would be re-detected forever and never clearable.
      assert.equal(f.contested, undefined, `still contested for ${p.actor.principal}`);
      assert.equal(f.severity, "high");
    }
  });
});

test("an agent may not decide a disagreement between people", async () => {
  await withTeam(async (s) => {
    const id = await seeded(s);
    await concurrently(
      s,
      "izzie@x.com", (p) => revise(p.sidecar, PR, p.actor, id, { severity: "critical" }),
      "dana@x.com", (p) => revise(p.sidecar, PR, p.actor, id, { severity: "low" }),
    );
    const izzie = who(s, "izzie@x.com");
    const r = await resolveContest(izzie.sidecar, PR, asAgent(izzie, "claude-opus-5"), id, "severity", "high") as { error: string };
    assert.match(r.error, /may not decide/);
    assert.ok((await readFindings(izzie.sidecar, PR)).get(id)!.contested?.length, "and it is still contested");
  });
});

test("resolving a field that is not contested is refused", async () => {
  await withTeam(async (s) => {
    const id = await seeded(s);
    const izzie = who(s, "izzie@x.com");
    const r = await resolveContest(izzie.sidecar, PR, izzie.actor, id, "severity", "high") as { error: string };
    assert.match(r.error, /not contested/);
  });
});

test("a contested finding still works — nothing is blocked while it is unresolved", async () => {
  await withTeam(async (s) => {
    const id = await seeded(s);
    await concurrently(
      s,
      "izzie@x.com", (p) => revise(p.sidecar, PR, p.actor, id, { comment: "izzie's" }),
      "dana@x.com", (p) => revise(p.sidecar, PR, p.actor, id, { comment: "dana's" }),
    );
    const dana = who(s, "dana@x.com");
    await corroborate(dana.sidecar, PR, dana.actor, id, "confirm", "still real either way");
    await settle(s);
    const f = (await readFindings(who(s, "izzie@x.com").sidecar, PR)).get(id)!;
    assert.ok(f.contested?.length);
    assert.equal(f.corroboration.length, 1, "work continues around the disagreement");
  });
});
