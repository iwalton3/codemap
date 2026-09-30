/**
 * A revision made against a value that has since changed is refused at replay, and its
 * author told (plan 5.1, replacing the field contest). A revision carries `was`, each field
 * it changes as its author read it; the fold refuses it once the value has moved.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { scenario, who, concurrently, inSequence, settle, step, views, assertConverged, type Scenario } from "./scenario.js";
import { createFinding, corroborate, revise, readFindings, promote, findingScope, foldFindingsReport } from "./shared-findings.js";
import { readScope, readScopeChecked } from "./eventlog.js";
import { begin, syncSession, staged } from "./sync-engine.js";
import { lockoutOf } from "./lockout.js";
import { testEvent } from "./test-events.js";

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

test("a revision staged against a value a teammate has since changed is refused at replay, and its author is told", async () => {
  await withTeam(async (s) => {
    const id = await seeded(s);
    const izzie = who(s, "izzie@x.com"), dana = who(s, "dana@x.com");
    begin(izzie.sidecar);
    await revise(izzie.sidecar, PR, izzie.actor, id, { severity: "critical" });
    await revise(dana.sidecar, PR, dana.actor, id, { severity: "low" });
    const r = await syncSession(izzie.sidecar, izzie.actor);
    assert.ok("error" in r, "izzie's revision replays against dana's");
    assert.deepEqual(r.conflicts?.map((c) => c.kind), ["finding.revised"]);
    assert.match(r.conflicts![0]!.why, /severity changed since you read it/);
    assert.equal(staged(izzie.sidecar).length, 1, "and it stays staged for her to drop or redo");
    await settle(s).catch(() => {});
    assertConverged(await views(s, PR), (f) => `${f.id} ${f.severity}`);
    for (const p of s.all) {
      assert.equal((await readFindings(p.sidecar, PR)).get(id)!.severity, "low", "dana's, the one that landed");
      assert.equal(lockoutOf(p.sidecar), null);
    }
    const onRemote = await readScope(dana.sidecar, findingScope(PR));
    assert.equal(onRemote.filter((e) => e.kind === "finding.revised").length, 1, "the refused revision never reached the remote");
  });
});

test("three writers: the one who revised offline is refused against what landed in between", async () => {
  // dana revises and stays offline; alice pushes; bob pulls alice's and revises on top.
  // dana's was minted first, so it sorts first by id — and it is still the stale one.
  const s = await scenario(["alice@x.com", "bob@x.com", "dana@x.com"]);
  try {
    const alice = who(s, "alice@x.com"), bob = who(s, "bob@x.com"), dana = who(s, "dana@x.com");
    const id = await createFinding(alice.sidecar, PR, alice.actor, NEW);
    await settle(s);
    begin(dana.sidecar);
    await revise(dana.sidecar, PR, dana.actor, id, { severity: "low" });
    await revise(alice.sidecar, PR, alice.actor, id, { severity: "critical" });
    await step(s, "bob@x.com");
    await revise(bob.sidecar, PR, bob.actor, id, { severity: "high" });
    const r = await syncSession(dana.sidecar, dana.actor);
    assert.ok("error" in r && /severity changed since you read it/.test(r.conflicts?.[0]?.why ?? ""), JSON.stringify(r));
    await settle(s).catch(() => {});
    for (const p of s.all) assert.equal((await readFindings(p.sidecar, PR)).get(id)!.severity, "high");
  } finally { s.dispose(); }
});

test("a revision written AFTER pulling lands, and the later value stands", async () => {
  await withTeam(async (s) => {
    const id = await seeded(s);
    await inSequence(
      s,
      "izzie@x.com", (p) => revise(p.sidecar, PR, p.actor, id, { severity: "critical" }),
      "dana@x.com", (p) => revise(p.sidecar, PR, p.actor, id, { severity: "low" }),
    );
    assert.equal((await readFindings(who(s, "izzie@x.com").sidecar, PR)).get(id)!.severity, "low");
  });
});

test("revisions of DIFFERENT fields written apart both land", async () => {
  await withTeam(async (s) => {
    const id = await seeded(s);
    await concurrently(
      s,
      "izzie@x.com", (p) => revise(p.sidecar, PR, p.actor, id, { severity: "critical" }),
      "dana@x.com", (p) => revise(p.sidecar, PR, p.actor, id, { category: "Authorization" }),
    );
    const f = (await readFindings(who(s, "dana@x.com").sidecar, PR)).get(id)!;
    assert.equal(f.severity, "critical");
    assert.equal(f.category, "Authorization", "both edits land");
  });
});

test("the SAME value written apart is not a conflict — the second lands as a no-op (owner, Q5)", async () => {
  await withTeam(async (s) => {
    const id = await seeded(s);
    await concurrently(
      s,
      "izzie@x.com", (p) => revise(p.sidecar, PR, p.actor, id, { severity: "critical" }),
      "dana@x.com", (p) => revise(p.sidecar, PR, p.actor, id, { severity: "critical" }),
    );
    assert.equal((await readFindings(who(s, "izzie@x.com").sidecar, PR)).get(id)!.severity, "critical");
  });
});

test("one person revising twice in a row is two ordinary revisions", async () => {
  await withTeam(async (s) => {
    const id = await seeded(s);
    const izzie = who(s, "izzie@x.com");
    await revise(izzie.sidecar, PR, izzie.actor, id, { severity: "high" });
    await revise(izzie.sidecar, PR, izzie.actor, id, { severity: "critical" });
    await settle(s);
    const f = (await readFindings(izzie.sidecar, PR)).get(id)!;
    assert.deepEqual([f.severity, f.revisions.length], ["critical", 2]);
  });
});

test("appends written apart all land — only a revision has a prior value to check", async () => {
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
    assert.equal(f.corroboration.length, 2, "both opinions kept — disagreement is the signal");
    assert.ok(f.promotion, "a latch, set once");
  });
});

test("the fold: a LINEAR revision is checked field by field; legacy and merge-era ones fold as before", () => {
  const created = testEvent({ id: "e1", kind: "finding.created", subject: "f1", data: NEW, seq: 1 });
  const moved = testEvent({ id: "e2", kind: "finding.revised", subject: "f1", data: { now: { severity: "high" }, was: { severity: "medium" } }, seq: 2 });
  const rev = (now: Record<string, unknown>, was: Record<string, unknown> | undefined, seq?: number) =>
    testEvent({ id: "e3", kind: "finding.revised", subject: "f1", data: { now, ...(was ? { was } : {}) }, ...(seq ? { seq } : {}) });
  const run = (e: ReturnType<typeof rev>) => {
    const { value, refused } = foldFindingsReport([created, moved, e]);
    return { f: value.get("f1")!, refused: refused.map((r) => `${r.cls}: ${r.why}`) };
  };
  assert.deepEqual(run(rev({ severity: "low" }, { severity: "medium" }, 3)).refused, ["state: severity changed since you read it"]);
  assert.deepEqual(run(rev({ severity: "low", comment: "x" }, { severity: "medium", comment: "the original ask" }, 3)).refused,
    ["state: severity changed since you read it"], "names only the field that moved");
  assert.equal(run(rev({ severity: "low" }, { severity: "high" }, 3)).f.severity, "low", "read the current value: lands");
  assert.equal(run(rev({ category: "Auth" }, { category: null }, 3)).f.category, "Auth", "`null` is unset, and it was");
  assert.deepEqual(run(rev({ category: "Auth" }, { category: "Billing" }, 3)).refused, ["state: category changed since you read it"]);
  assert.equal(run(rev({ severity: "low" }, undefined, 3)).f.severity, "low", "no `was`: nothing to check");
  assert.equal(run(rev({ severity: "low" }, {}, 3)).f.severity, "low", "a field `was` does not name is unchecked");
  assert.equal(run(rev({ severity: "low" }, { severity: "medium" })).f.severity, "low", "merge-era (no seq): as it always folded");
});

/**
 * One person, two models, two opinions.
 *
 * Keyed on the principal alone, the second run silently replaced the first — so a
 * reviewer whose two models DISAGREED published one verdict and never learned the
 * other existed. A verdict is an opinion, and whose opinion it is includes which
 * model formed it. See PROPOSAL-provenance.md §4 and `reviewerKey`.
 */
test("a reviewer's second model does not overwrite their first", async () => {
  const s = await scenario(["izzie@x.com"]);
  try {
    const izzie = who(s, "izzie@x.com");
    const opus = { principal: "izzie@x.com", via: { kind: "agent" as const, model: "claude-opus-5" } };
    const sonnet = { principal: "izzie@x.com", via: { kind: "agent" as const, model: "claude-sonnet-5" } };
    const id = await createFinding(izzie.sidecar, PR, { principal: "dana@x.com" }, NEW);
    await corroborate(izzie.sidecar, PR, opus, id, "confirm", "reproduced on the retry path");
    await corroborate(izzie.sidecar, PR, sonnet, id, "refute", "the caller already guards it");

    const f = (await readFindings(izzie.sidecar, PR)).get(id)!;
    assert.equal(f.corroboration.length, 2, "two models are two opinions");
    assert.deepEqual(f.corroboration.map((c) => c.verdict).sort(), ["confirm", "refute"]);

    // The control, and the half that must not regress: the SAME reviewer changing
    // their mind is a replacement, not a third voice.
    await corroborate(izzie.sidecar, PR, opus, id, "unsure", "cannot reproduce it now");
    const again = (await readFindings(izzie.sidecar, PR)).get(id)!;
    assert.equal(again.corroboration.length, 2);
    assert.equal(again.corroboration.find((c) => c.actor.via?.model === "claude-opus-5")!.verdict, "unsure");
  } finally { s.dispose(); }
});

test("and a person is not their own agent", async () => {
  // A human verdict and their agent's are two reviewers, not one — which the
  // principal key also collapsed.
  const s = await scenario(["izzie@x.com"]);
  try {
    const izzie = who(s, "izzie@x.com");
    const human = { principal: "izzie@x.com" };
    const agent = { principal: "izzie@x.com", via: { kind: "agent" as const, model: "claude-opus-5" } };
    const id = await createFinding(izzie.sidecar, PR, { principal: "dana@x.com" }, NEW);
    await corroborate(izzie.sidecar, PR, agent, id, "confirm", "reproduced");
    await corroborate(izzie.sidecar, PR, human, id, "refute", "I read it differently");
    assert.equal((await readFindings(izzie.sidecar, PR)).get(id)!.corroboration.length, 2);
  } finally { s.dispose(); }
});

/**
 * A real team, a real remote, real union merges — and no fork.
 *
 * The detector blocks a WHOLE SCOPE, so a false positive is far worse than a
 * missed detection, and the shape most likely to produce one is exactly what sync
 * does: fetch, merge, and `merge=union` stitching shards together. Every clone
 * mints its own writer id, so nobody else ever writes to my shard and its last
 * line stays my chain's head — but that is an argument, and this is the check.
 */
test("an ordinary team syncing does not fork anybody's chain", async () => {
  await withTeam(async (s) => {
    const id = await seeded(s);
    const izzie = who(s, "izzie@x.com"), dana = who(s, "dana@x.com");
    // Concurrent writes on both sides, then merges in both directions, twice.
    for (let round = 0; round < 2; round++) {
      await corroborate(izzie.sidecar, PR, izzie.actor, id, "confirm", `round ${round}`);
      await corroborate(dana.sidecar, PR, dana.actor, id, "refute", `round ${round}`);
      await revise(izzie.sidecar, PR, izzie.actor, id, { comment: `izzie ${round}` });
      await revise(dana.sidecar, PR, dana.actor, id, { category: `dana ${round}` });
      await settle(s);
    }
    for (const p of s.all) {
      const read = await readScopeChecked(p.sidecar, findingScope(PR));
      assert.equal(read.status, "complete",
        `${p.actor.principal}'s clone reads blocked: ${JSON.stringify(read.diagnostic)}`);
    }
  });
});

