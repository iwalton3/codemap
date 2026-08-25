/**
 * The triage surface, as an agent actually reaches it.
 *
 * Every test here is a use-report from `CODEMAP_COMPLAINTS.md`: an agent asked to
 * triage four findings on a pull request could not revise one, could not record a
 * re-rating anywhere filterable, and could not ask for the untriaged ones at all.
 * None of that was a missing capability — the fold has revised findings since it was
 * written — so what is checked here is REACHABILITY and the honesty of the refusals,
 * not the underlying operations, which have their own tests.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import * as shared from "./ops-shared.js";
import { reviseOn, closeFinding, reviewQueue } from "./ops.js";
import { readFinding, writeLocalFinding, writeStore } from "./store.js";
import { indexBlob } from "./repo.js";
import type { State } from "./schema.js";
import type { SharedFinding } from "./shared-findings.js";

const git = (root: string, ...args: string[]) =>
  spawnSync("git", ["-c", "user.email=izzie@x.com", "-c", "user.name=t", ...args], { cwd: root, encoding: "utf8" });

const tmp = (t: string) => mkdtempSync(join(tmpdir(), `codemap-fts-${t}-`));

const state: State = { schemaVersion: 1, lastVerifiedCommit: null, branch: null } as State;

/**
 * A universe with an identity, a sidecar, and an anchor index — `reviewQueue` reads
 * the index to mark a target the tree no longer has, so an uninitialized store is not
 * a lighter fixture, it is a different error.
 */
async function universe() {
  const root = tmp("repo");
  git(root, "init", "-q", "-b", "main");
  git(root, "config", "user.email", "izzie@x.com");
  git(root, "config", "user.name", "izzie");
  mkdirSync(join(root, ".codemap"), { recursive: true });
  mkdirSync(join(root, "src"), { recursive: true });
  const src = "export function transfer(cents: number) {\n  return cents;\n}\n";
  writeFileSync(join(root, "src/pay.ts"), src, "utf8");
  await writeStore(root, await indexBlob(src, "src/pay.ts"), state);
  const side = tmp("side");
  writeFileSync(join(root, ".codemap", "sidecar"), side, "utf8");
  return { root, side, cleanup: () => [root, side].forEach((r) => rmSync(r, { recursive: true, force: true })) };
}

const withEnv = async (vars: Record<string, string | undefined>, fn: () => Promise<void>) => {
  const saved: Record<string, string | undefined> = {};
  for (const k of Object.keys(vars)) { saved[k] = process.env[k]; if (vars[k] === undefined) delete process.env[k]; else process.env[k] = vars[k]!; }
  try { await fn(); } finally { for (const k of Object.keys(saved)) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]!; } }
};

const NEW = { targetKind: "anchor" as const, targetId: "a_1", text: "evidence", comment: "the ask", severity: "high" as const };

/** As an agent — which is what decides a new finding opens at `issued`. */
const asAgent = (fn: () => Promise<void>) => withEnv({ CODEMAP_AGENT_MODEL: "claude-opus-5" }, fn);

const localFinding = (id: string, over: Partial<SharedFinding> = {}): SharedFinding => ({
  id, target: { kind: "anchor", id: "a_local" }, text: "filed here",
  author: { principal: "izzie@x.com" }, createdAt: "2026-01-01T00:00:00Z",
  state: "created", corroboration: [], thread: [], revisions: [], ...over,
});

// ---------------------------------------------------------------------------
// Complaint 1 & 2 — an agent could not revise a shared finding, and the error
// named the one store it had not asked about.
// ---------------------------------------------------------------------------

test("one revise verb reaches a TEAM finding, not only a local annotation", async () => {
  const u = await universe();
  try {
    await asAgent(async () => {
      const r = await shared.shareFinding(u.root, 269, NEW) as { id: string };
      assert.equal((await readFinding(u.root, r.id))!.state, "issued", "an agent files a proposal");

      const out = await reviseOn(u.root, {
        id: r.id, severity: "medium",
        comment: "The by-id branch has no tenant predicate — `pay.ts:12` queries on id alone.",
      });
      assert.ok(!out.error, `revise refused: ${out.error}`);

      const f = (await readFinding(u.root, r.id))!;
      assert.equal(f.severity, "medium", "the re-rate is on the RECORD, filterable");
      assert.match(f.comment!, /tenant predicate/);
      assert.equal(f.revisions.length, 1, "and the previous wording is kept");
      assert.equal(f.revisions[0]!.was.severity, "high");
    });
  } finally { u.cleanup(); }
});

test("an unknown id names every namespace it could have come from", async () => {
  const u = await universe();
  try {
    const out = await reviseOn(u.root, { id: "f_nope", comment: "x" });
    // The complaint: `no annotation "f_…"` answered about the one store the caller
    // had not asked about, and read as "that kind of id is not supported here".
    assert.match(String(out.error), /no finding or annotation "f_nope"/);
    assert.match(String(out.error), /shared_findings/);
  } finally { u.cleanup(); }
});

test("an agent revising a finding somebody stands behind is refused, not silently dropped", async () => {
  const u = await universe();
  try {
    // Filed by a PERSON, so it opens at `created` — past the point the fold accepts
    // an agent's revision. It used to be appended, synced, and then ignored by every
    // reader, which is indistinguishable from having worked.
    const r = await shared.shareFinding(u.root, 269, NEW) as { id: string };
    await asAgent(async () => {
      const out = await reviseOn(u.root, { id: r.id, severity: "low" });
      assert.match(String(out.error), /only a person revises/);
      assert.match(String(out.error), /request_human/, "and it names what the agent CAN do");
      assert.equal((await readFinding(u.root, r.id))!.severity, "high", "nothing moved");
    });
  } finally { u.cleanup(); }
});

test("a local finding revises through the same verb, with the same trail", async () => {
  const u = await universe();
  try {
    await writeLocalFinding(u.root, localFinding("f_local", { severity: "high", comment: "as filed" }), 269);
    const out = await reviseOn(u.root, { id: "f_local", severity: "low", comment: "The retry loop drops the last batch." });
    assert.ok(!out.error, String(out.error));
    const f = (await readFinding(u.root, "f_local"))!;
    assert.equal(f.severity, "low");
    assert.equal(f.revisions.length, 1);
    assert.equal(f.revisions[0]!.was.comment, "as filed");
  } finally { u.cleanup(); }
});

test("a finding already on the pull request refuses the edit that would diverge from it", async () => {
  const u = await universe();
  try {
    await asAgent(async () => {
      const r = await shared.shareFinding(u.root, 269, NEW) as { id: string };
      await shared.recordPublished(u.root, 269, r.id, { url: "https://github.com/a/b/pull/269#discussion_r1" });
      const out = await reviseOn(u.root, { id: r.id, comment: "Different wording entirely." });
      assert.match(String(out.error), /already on PR 269/);
      assert.match(String(out.error), /allowPostEdit/, "and says how to override it deliberately");
    });
  } finally { u.cleanup(); }
});

test("a field the shared fold cannot record is named, not dropped", async () => {
  const u = await universe();
  try {
    await asAgent(async () => {
      const r = await shared.shareFinding(u.root, 269, NEW) as { id: string };
      // `finding.revised` folds text/comment/severity/category/sourceRef/line. A
      // re-witness is not among them, and it is the ONE route past the written-
      // against-a-different-body gate — an agent that thinks it ran stops looking.
      const out = await reviseOn(u.root, { id: r.id, severity: "low", ref: "HEAD", publishPath: "src/pay.ts" });
      assert.ok(!out.error, String(out.error));
      assert.match(String(out.note), /ref is not recorded/);
      assert.match(String(out.note), /publishPath is a local publishing field/);
      assert.equal((await readFinding(u.root, r.id))!.severity, "low", "and what it COULD record still landed");
    });
  } finally { u.cleanup(); }
});

// ---------------------------------------------------------------------------
// Complaint 3 — reporting back dropped the structured verdict, so a re-rate
// survived only as prose in `detail`.
// ---------------------------------------------------------------------------

test("reporting back puts the corrected comment and severity on the record, not in prose", async () => {
  const u = await universe();
  try {
    await asAgent(async () => {
      const r = await shared.shareFinding(u.root, 269, NEW) as { id: string };
      const out = await closeFinding(u.root, {
        id: r.id, result: "answered", detail: "traced both branches; the write side is guarded",
        severity: "medium", line: 88,
        comment: "The by-id branch has no tenant predicate — `pay.ts:12` queries on id alone.",
      });
      assert.ok(!out.error, String(out.error));

      const f = (await readFinding(u.root, r.id))!;
      assert.ok(f.outcome, "the outcome is still recorded");
      assert.equal(f.severity, "medium", "and the re-rate is a FIELD — the complaint was that it stayed `high`");
      assert.equal(f.line, 88);
      assert.match(f.comment!, /tenant predicate/);
    });
  } finally { u.cleanup(); }
});

test("a report whose re-rate the ratchet refuses says so rather than reporting success", async () => {
  const u = await universe();
  try {
    const r = await shared.shareFinding(u.root, 269, NEW) as { id: string };
    await asAgent(async () => {
      const out = await closeFinding(u.root, {
        id: r.id, result: "answered", detail: "looked into it", severity: "low",
      });
      assert.ok(!out.error, "the outcome itself is recorded — that part an agent may do");
      assert.match(String(out.note), /NOT changed/);
      assert.equal((await readFinding(u.root, r.id))!.severity, "high");
      assert.ok((await readFinding(u.root, r.id))!.outcome, "and the report survived the refusal");
    });
  } finally { u.cleanup(); }
});

// ---------------------------------------------------------------------------
// Complaint 4 — the queue excludes exactly what needs triage.
// ---------------------------------------------------------------------------

test("the untriaged are askable, which the human queue can never show", async () => {
  const u = await universe();
  try {
    await asAgent(async () => {
      const untouched = await shared.shareFinding(u.root, 269, NEW) as { id: string };
      const looked = await shared.shareFinding(u.root, 269, { ...NEW, text: "second" }) as { id: string };
      await shared.corroborateFinding(u.root, 269, looked.id, "confirm", "read it");

      const q = await shared.sharedFindings(u.root, 269, { queue: true }) as { findings: { id: string }[] };
      assert.deepEqual(q.findings.map((f) => f.id), [looked.id],
        "confirming is what PUTS a finding in the queue — so the queue cannot answer `what is untriaged`");

      const t = await shared.sharedFindings(u.root, 269, { tier: "unconfirmed" }) as
        { findings: { id: string }[]; tiers: Record<string, number> };
      assert.deepEqual(t.findings.map((f) => f.id), [untouched.id]);
      assert.equal(t.tiers.unconfirmed, 1, "and the counts are on every answer, not only the filtered one");
      assert.equal(t.tiers.confirmed, 1);
    });
  } finally { u.cleanup(); }
});

// ---------------------------------------------------------------------------
// Complaint 5 — two vocabularies for one axis, and no way to ask about one PR.
// ---------------------------------------------------------------------------

test("`findings` answers about ONE pull request, in either vocabulary", async () => {
  const u = await universe();
  try {
    await writeLocalFinding(u.root, localFinding("f_269a"), 269);
    await writeLocalFinding(u.root, localFinding("f_269b", { corroboration: [
      { actor: { principal: "dana@x.com" }, verdict: "confirm", at: "2026-01-02T00:00:00Z", rationale: "read it", independent: true },
    ] }), 269);
    await writeLocalFinding(u.root, localFinding("f_271a"), 271);

    const ids = async (opts: Record<string, unknown>) =>
      ((await reviewQueue(u.root, { assignedOnly: false, brief: true, ...opts }) as
        { queue: { id: string }[] }).queue).map((q) => q.id).sort();

    assert.deepEqual(await ids({}), ["f_269a", "f_269b", "f_271a"]);
    assert.deepEqual(await ids({ pr: "269" }), ["f_269a", "f_269b"], "one pull request, from the STORED pr");
    // The complaint: `disposition` and `tier` name one axis, so either word has to
    // select the same rows — otherwise the answer depends on which list you came from.
    assert.deepEqual(await ids({ pr: "269", tier: "unconfirmed" }), ["f_269a"]);
    assert.deepEqual(await ids({ pr: "269", disposition: "open" }), ["f_269a"]);
    assert.deepEqual(await ids({ pr: "269", tier: "confirmed" }), ["f_269b"]);
  } finally { u.cleanup(); }
});

test("every finding row carries the tier, so one word reads both lists", async () => {
  const u = await universe();
  try {
    await writeLocalFinding(u.root, localFinding("f_1", { state: "invalid" }), 269);
    const q = await reviewQueue(u.root, { assignedOnly: false, brief: true, includeResolved: true }) as
      { queue: { id: string; tier?: string; disposition?: string }[] };
    const row = q.queue.find((r) => r.id === "f_1")!;
    // `invalid` flattens to disposition `open` — the tier is taken from the record
    // BEFORE that flattening, which is the whole reason it is not derived from it.
    assert.equal(row.tier, "settled");
    assert.equal(row.disposition, "open");
  } finally { u.cleanup(); }
});

// ---------------------------------------------------------------------------
// `withdraw`: the ask that is not a verdict
// ---------------------------------------------------------------------------

test("a true-but-duplicate finding can be retired without calling it false", async () => {
  const u = await universe();
  try {
    const r = await shared.shareFinding(u.root, 269, NEW) as { id: string };
    await asAgent(async () => {
      const { requestHuman } = await import("./ops.js");
      const out = await requestHuman(u.root, {
        id: r.id, action: "withdraw",
        rationale: "the claim is TRUE and confirmed; f_other covers the same defect on the same anchor",
      }) as Record<string, unknown>;
      assert.ok(!out.error, String(out.error));

      // It reaches the person's queue as `withdraw`. The fold guard is the half that
      // matters: a word added to the type but not to the guard is an event every reader
      // silently drops, and the request would vanish rather than fail.
      const f = (await shared.sharedFindings(u.root, 269) as { findings: { id: string; pending?: { ask: string } }[] })
        .findings.find((x) => x.id === r.id)!;
      assert.equal(f.pending?.ask, "withdraw");
    });
    // And it is still an ASK — an agent may not retire the record itself, which is the
    // gate that stops a confirmed finding being lost by one wrong call.
    assert.notEqual((await readFinding(u.root, r.id))!.state, "withdrawn");
  } finally { u.cleanup(); }
});

test("every ask a writer can emit is one the fold accepts", async () => {
  const { ASKS, isAsk } = await import("./shared-findings.js");
  // The two folds spelled this list out separately and drifted is the failure mode:
  // `withdraw` in the enum and absent from a guard reads as "accepted, then ignored".
  for (const a of ASKS) assert.ok(isAsk(a), `${a} is emittable but not foldable`);
  assert.ok(!isAsk("retire"), "and the guard is a guard, not a pass-through");
} );
