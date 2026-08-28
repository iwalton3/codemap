/**
 * A blocked standard is served NON-AUTHORITATIVELY, not served as the team's.
 *
 * The hole this closes was found by review, not by use: `materializeStandard` reduced the
 * scope verdict to a boolean and ran only on the WRITE path, so nothing on the read path
 * ever asked. A `standard/` scope blocked by a fork still handed back projection rows that
 * looked exactly like a healthy team's — §7 of `docs/sidecar-architecture.md` is a
 * fail-CLOSED rule, and the way it fails in practice is a surface that never looked.
 *
 * Two halves, and both matter. The marker must APPEAR when the log is blocked, and the
 * rows must still COME BACK — hiding them leaves a reader staring at an empty page with
 * no way to repair what they cannot see. A test that only asserted the first half would
 * pass against an implementation that refused the read.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { discard } from "./test-tmp.js";
import { indexBlob } from "./repo.js";
import { writeStore } from "./store.js";
import type { State } from "./schema.js";
import * as ops from "./ops/standard.js";
import { draftSpec, addOperation, ratifySpec } from "./requirements.js";

const state: State = { schemaVersion: 1, lastVerifiedCommit: null, branch: null } as State;
const SRC = "export function creditLine(cents) { return cents; }\n";
const tmp = (t: string) => mkdtempSync(join(tmpdir(), `codemap-blocked-${t}-`));

const ok = <T>(r: T): Exclude<T, { error: string }> => {
  assert.ok(!(r && typeof r === "object" && "error" in (r as object)), `unexpected error: ${(r as any)?.error}`);
  return r as Exclude<T, { error: string }>;
};

/** A universe with a sidecar, holding one ratified rule that really went through the log. */
async function universeWithRule() {
  const root = tmp("repo");
  const side = tmp("side");
  for (const a of [["init", "-q", "-b", "main"], ["config", "user.email", "izzie@x.com"], ["config", "user.name", "izzie"]]) {
    spawnSync("git", a, { cwd: root });
  }
  mkdirSync(join(root, ".codemap"), { recursive: true });
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(join(root, "src/credit.js"), SRC, "utf8");
  await writeStore(root, await indexBlob(SRC, "src/credit.js"), state);
  writeFileSync(join(root, ".codemap", "sidecar"), side, "utf8");

  const sp = ok(await draftSpec(root, { title: "Credit limits" }));
  ok(await addOperation(root, {
    specId: sp.id, kind: "add_requirement", rationale: "policy", reversibility: "reversible",
    title: "Credit line is capped", section: "Credit/Limits",
    statement: "A credit line never exceeds the approved limit.", provenance: "credit policy",
  }));
  ok(await ratifySpec(root, sp.id));
  return { root, side, cleanup: () => [root, side].forEach((r) => discard(r)) };
}

/** Every shard file under the standard scope, wherever the writer id put it. */
function shards(side: string): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      if (e.isDirectory()) walk(join(d, e.name));
      else if (e.name.endsWith(".ndjson")) out.push(join(d, e.name));
    }
  };
  walk(join(side, "standard"));
  return out;
}

/**
 * Fork the log the way a real fork happens: a second writer file claiming ids that
 * already exist with different bodies. `readScopeChecked` calls that `duplicate-id`.
 */
function forkTheLog(side: string) {
  const files = shards(side);
  assert.ok(files.length, "the fixture must have written events, or blocking it proves nothing");
  const lines = readFileSync(files[0]!, "utf8").split("\n").filter(Boolean);
  const rewritten = lines.map((l) => JSON.stringify({ ...JSON.parse(l), subject: "tampered" }));
  writeFileSync(join(files[0]!.replace(/[^/]+\.ndjson$/, "w_impostor.ndjson")), rewritten.join("\n") + "\n");
}

test("a healthy standard carries no scope marker at all", async () => {
  const u = await universeWithRule();
  try {
    // The marker must be ABSENT when nothing is wrong — a status on every response for
    // every healthy team is noise, and noise is what a warning has to outrank. This also
    // stops the test below passing against an implementation that always warns.
    const r = await ops.listRequirements(u.root);
    assert.equal(r.requirements.length, 1);
    assert.equal(r.scope, undefined);
    assert.equal((await ops.conformance(u.root)).scope, undefined);
    assert.equal((await ops.standardStatus(u.root)).scope, undefined);
  } finally { u.cleanup(); }
});

test("a blocked standard scope is served with the marker, and still serves its rows", async () => {
  const u = await universeWithRule();
  try {
    assert.equal((await ops.listRequirements(u.root)).scope, undefined, "clean first");
    forkTheLog(u.side);

    const r = await ops.listRequirements(u.root);
    assert.equal(r.scope?.status, "blocked", "the rows are no longer the team's word");
    assert.equal(r.requirements.length, 1, "and they still come back — hiding them helps nobody repair it");
    if (r.scope?.status === "blocked") {
      assert.ok(r.scope.diagnostic?.detail, "with something a person can act on");
      assert.ok(r.scope.diagnostic?.evidence?.length, "and the ids to act on it with");
    }
  } finally { u.cleanup(); }
});

/**
 * EVERY read, not the one that happened to be checked.
 *
 * The defect was a surface that never looked, so a fix covering some reads and not others
 * reproduces it in miniature — and `conformance` is the one that matters most, because it
 * is the read that says a rule is met.
 */
test("every read on the standard surface carries the marker, not just the one that was checked", async () => {
  const u = await universeWithRule();
  try {
    forkTheLog(u.side);
    const reads: [string, Promise<{ scope?: { status: string } }>][] = [
      ["standardStatus", ops.standardStatus(u.root)],
      ["listRequirements", ops.listRequirements(u.root)],
      ["conformance", ops.conformance(u.root)],
      ["requirementSections", ops.requirementSections(u.root)],
      ["pendingSpecs", ops.pendingSpecs(u.root)],
      ["listAcknowledgements", ops.listAcknowledgements(u.root)],
      ["listProblems", ops.listProblems(u.root)],
      ["promotableAudits", ops.promotableAudits(u.root)],
      ["awaitingAdjudication", ops.awaitingAdjudication(u.root)],
      ["actionableProblems", ops.actionableProblems(u.root)],
      ["settledWithoutAdjudication", ops.settledWithoutAdjudication(u.root)],
      ["dueForRevalidation", ops.dueForRevalidation(u.root)],
      ["weakAssertions", ops.weakAssertions(u.root)],
    ];
    for (const [name, p] of reads) {
      assert.equal((await p).scope?.status, "blocked", `${name} answers as if the standard were the team's`);
    }
  } finally { u.cleanup(); }
});

test("no sidecar is not a warning — local rows with no log behind them are the whole story", async () => {
  const root = tmp("solo");
  try {
    for (const a of [["init", "-q", "-b", "main"], ["config", "user.email", "izzie@x.com"], ["config", "user.name", "izzie"]]) {
      spawnSync("git", a, { cwd: root });
    }
    mkdirSync(join(root, ".codemap"), { recursive: true });
    mkdirSync(join(root, "src"), { recursive: true });
    writeFileSync(join(root, "src/credit.js"), SRC, "utf8");
    await writeStore(root, await indexBlob(SRC, "src/credit.js"), state);

    const sp = ok(await draftSpec(root, { title: "s" }));
    ok(await addOperation(root, {
      specId: sp.id, kind: "add_requirement", rationale: "r", reversibility: "reversible",
      title: "t", section: "Credit", statement: "st", provenance: "p",
    }));
    ok(await ratifySpec(root, sp.id));

    const r = await ops.listRequirements(root);
    assert.equal(r.requirements.length, 1);
    assert.equal(r.scope, undefined, "a store that never joined a team is not a store with a problem");
  } finally { discard(root); }
});

/**
 * The read must answer from rows the fold has already brought up to date.
 *
 * This is about ORDER, and it is the reason `served` takes a thunk. The scope check folds
 * the log when the shards have moved; if the rows are read first and the verdict computed
 * second, the answer is from before the fold and the marker is from after it — a stale
 * answer wearing an authoritative marker, which is the failure the whole mechanism exists
 * to prevent, one layer up.
 *
 * A teammate's ratification arriving in the log is exactly that case: nothing local wrote
 * it, so only a fold on the read path can make it visible.
 */
test("a teammate's ratification is visible to the very next read, not the one after", async () => {
  const u = await universeWithRule();
  try {
    const { publishSpecDrafted, publishOperation, publishSpecRatified, standardScope } =
      await import("./shared-standard.js");
    const { resolveSidecar, sidecarIdentity } = await import("./sidecar-config.js");
    const cfg = resolveSidecar(u.root)!;
    const scope = standardScope(cfg.universe);
    void sidecarIdentity(cfg);

    // Straight into the log, the way a `git pull` would deliver it — no local write, so
    // nothing has materialized it here.
    const mate = { principal: "mate@x.com" };
    const spec = {
      id: "sp_mate", title: "Settlement", status: "draft" as const,
      author: mate, createdAt: "2026-08-10T00:00:00.000Z",
    };
    await publishSpecDrafted(cfg.path, scope, mate, spec);
    await publishOperation(cfg.path, scope, mate, {
      id: "op_mate", specId: "sp_mate", kind: "add_requirement", ord: 0,
      title: "Float settles daily", section: "Settlement/Float",
      statement: "Float must be settled daily.", provenance: "treasury", cites: [],
      rationale: "policy", reversibility: "reversible",
    });
    await publishSpecRatified(cfg.path, scope, mate, "sp_mate", "2026-08-10T01:00:00.000Z", {}, ["op_mate"]);

    // THE VERY NEXT READ. With the rows read before the scope check folded, this is 1.
    const r = await ops.listRequirements(u.root);
    assert.equal(r.requirements.length, 2, "the read answered from rows the fold had not yet written");
    assert.equal(r.scope, undefined, "and the log is healthy, so nothing warns");
  } finally { u.cleanup(); }
});
