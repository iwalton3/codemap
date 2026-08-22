import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import type { Anchor, State } from "./schema.js";
import { writeStore, writeSnapshot, retainOrphans } from "./store.js";
import { classifyCitations, needsAttention } from "./citation-state.js";
import { relocate, createFinding, readFindings, ackQueue } from "./shared-findings.js";
import type { Actor } from "./schema.js";
import { fixtureHash } from "./fixture-hash.js";

const tmp = () => mkdtempSync(join(tmpdir(), "codemap-cs-"));
const state: State = { schemaVersion: 1, lastVerifiedCommit: null, branch: null } as State;
const anchor = (id: string, file = "src/pay.cs"): Anchor =>
  ({ id, file, symbolPath: ["C", id], kind: "function", bodyHash: fixtureHash("x", 2), lastVerifiedCommit: null });

test("an anchor in the working index is simply here", async () => {
  const root = tmp();
  try {
    await writeStore(root, [anchor("a_1")], state);
    const p = await classifyCitations(root, ["a_1"]);
    assert.equal(p.get("a_1")!.state, "here");
    assert.equal(needsAttention(p.values()), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("an anchor on another branch is offTree — NOT an action item", async () => {
  // The case that made the dry run look like a thousand-item backlog. Asking a
  // person to acknowledge that a symbol lives on a branch they are not on is
  // manufacturing work, and manufactured work is how a queue stops being read.
  const root = tmp();
  try {
    await writeStore(root, [anchor("a_here")], state);
    await writeSnapshot(root, "deadbeef", "feature/x", [anchor("a_elsewhere")], "2026-08-21T00:00:00Z");
    const p = await classifyCitations(root, ["a_here", "a_elsewhere"]);
    assert.equal(p.get("a_elsewhere")!.state, "offTree");
    assert.equal(p.get("a_elsewhere")!.at, "deadbeef", "and it says which branch has it");
    assert.equal(needsAttention(p.values()), false, "nobody has to do anything about this");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("an anchor kept in @orphan is retained, with its last known location", async () => {
  const root = tmp();
  try {
    // `retainOrphans` takes the anchors TO KEEP — `reindex` picks them by asking
    // what somebody's work still points at, and hands them over before the store is
    // overwritten. Doing it directly here keeps the fixture about classification.
    const gone = anchor("a_gone", "src/old.cs");
    await writeStore(root, [gone], state);
    retainOrphans(root, [gone]);
    await writeStore(root, [anchor("a_other")], state);   // a_gone leaves @work
    const p = await classifyCitations(root, ["a_gone"]);
    const got = p.get("a_gone")!;
    assert.equal(got.state, "retained");
    assert.equal(got.file, "src/old.cs", "so a person can go and look");
    assert.equal(needsAttention([got]), true);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("an anchor nothing has ever heard of is lost, and does need attention", async () => {
  const root = tmp();
  try {
    await writeStore(root, [anchor("a_1")], state);
    const p = await classifyCitations(root, ["a_nowhere"]);
    assert.equal(p.get("a_nowhere")!.state, "lost");
    assert.equal(needsAttention(p.values()), true);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("classification is one pass — an empty ask does no work", async () => {
  const root = tmp();
  try {
    assert.equal((await classifyCitations(root, [])).size, 0);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// --- relocation: the residue, and who may act on it ------------------------------

const izzie: Actor = { principal: "izzie@x.com" };
const opus: Actor = { principal: "izzie@x.com", via: { kind: "agent", model: "claude-opus-5" } };
const PR = "acme/api/pr-1";
const NEW = { targetKind: "anchor" as const, targetId: "a_old", text: "e", comment: "c" };

test("an agent may propose a relocation, and it lands in the ack queue", async () => {
  const root = tmp();
  try {
    const id = await createFinding(root, PR, izzie, NEW);
    await relocate(root, PR, opus, id, "moved", "renamed in abc123", { to: "a_new" });
    const f = (await readFindings(root, PR)).get(id)!;
    assert.equal(f.relocation?.kind, "moved");
    assert.equal(f.relocation?.to, "a_new");
    assert.equal(f.relocation?.applied, undefined, "a proposal, not a fact");
    assert.equal(f.target.id, "a_old", "and the target has NOT moved yet");
    assert.equal(ackQueue([f]).length, 1);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("an agent may NOT apply one — a mis-targeted finding is worse than an untriaged one", async () => {
  const root = tmp();
  try {
    const id = await createFinding(root, PR, izzie, NEW);
    await relocate(root, PR, opus, id, "moved", "renamed", { to: "a_new", apply: true });
    const f = (await readFindings(root, PR)).get(id)!;
    assert.equal(f.target.id, "a_old", "the fold ignored it, not just the writer");
    assert.equal(f.relocation, undefined);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("a person applying `moved` re-points the finding", async () => {
  const root = tmp();
  try {
    const id = await createFinding(root, PR, izzie, NEW);
    await relocate(root, PR, izzie, id, "moved", "renamed in abc123", { to: "a_new", apply: true });
    const f = (await readFindings(root, PR)).get(id)!;
    assert.equal(f.target.id, "a_new");
    assert.equal(f.relocation?.applied, true);
    assert.equal(ackQueue([f]).length, 0, "and it leaves the queue");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("a person applying `gone` closes it as invalid, with the reason", async () => {
  const root = tmp();
  try {
    const id = await createFinding(root, PR, izzie, NEW);
    await relocate(root, PR, izzie, id, "gone", "the endpoint was deleted in v3", { apply: true });
    const f = (await readFindings(root, PR)).get(id)!;
    assert.equal(f.state, "invalid");
    assert.match(f.closed!.reason, /deleted in v3/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("`moved` without a destination is not a proposal", async () => {
  const root = tmp();
  try {
    const id = await createFinding(root, PR, izzie, NEW);
    await relocate(root, PR, izzie, id, "moved", "it went somewhere");
    assert.equal((await readFindings(root, PR)).get(id)!.relocation, undefined);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
