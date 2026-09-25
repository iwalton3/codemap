import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { db } from "./db.js";
import { testBug, testEvent } from "./test-events.js";
import { discard } from "./test-tmp.js";
import { foldFindings, findingScope } from "./shared-findings.js";
import { bugScope } from "./shared-bugs.js";
import { bugsProjection, findingsProjection } from "./shared-projections.js";
import { findingKeyScope } from "./review-target.js";
import { universeKey } from "./sidecar-config.js";
import { writeLocalBug, writeLocalFinding } from "./store.js";
import { canonicalIssueKey, resolveDecisionIssue } from "./decision-issues.js";

const tmp = () => mkdtempSync(join(tmpdir(), "codemap-issue-ref-"));
const finding = (id: string, branch?: string) => foldFindings([testEvent({
  id: `create-${id}`, kind: "finding.created", subject: id,
  data: { targetKind: "anchor", targetId: "a_1", text: "claim", ...(branch ? { branch } : {}) },
})]).get(id)!;
const sharedFinding = (root: string, id: string, review: number | string, branch?: string) => {
  const universe = universeKey(root);
  const scope = findingScope(findingKeyScope({ path: "", universe }, review));
  findingsProjection.write(db(root), scope, new Map([[id, finding(id, branch)]]));
  return scope;
};
const sharedBug = (root: string, id: string) => {
  const scope = bugScope(universeKey(root));
  bugsProjection.write(db(root), scope, new Map([[id, testBug({ id, title: "claim", text: "claim" })]]));
  return scope;
};

test("an exact shared finding gets one canonical key with or without its review hint", async () => {
  const root = tmp();
  try {
    const universe = universeKey(root);
    const scope = sharedFinding(root, "f_exact", 264);
    const a = await resolveDecisionIssue(root, { kind: "finding", universe, id: "f_exact" });
    const b = await resolveDecisionIssue(root, { kind: "finding", universe, id: "f_exact", review: 264 });
    assert.equal(a.ok, true);
    assert.equal(b.ok, true);
    if (!a.ok || !b.ok || a.ref.kind !== "finding" || b.ref.kind !== "finding") return;
    assert.equal(a.ref.scope, scope);
    assert.equal(a.ref.review, "264");
    assert.equal(b.ref.review, "264");
    assert.equal(a.key, b.key);
    assert.equal(a.key, canonicalIssueKey(b.ref));
    assert.equal(a.issue.text, "claim");
    assert.deepEqual(await resolveDecisionIssue(root, { kind: "finding", universe, id: "D1" }),
      { ok: false, reason: "not-found", error: "no finding with exact ID D1" });
  } finally { discard(root); }
});

test("same finding ID on two reviews refuses an unqualified reference", async () => {
  const root = tmp();
  try {
    const universe = universeKey(root);
    sharedFinding(root, "f_repeat", 264);
    const scope = sharedFinding(root, "f_repeat", 265);
    const ambiguous = await resolveDecisionIssue(root, { kind: "finding", universe, id: "f_repeat" });
    assert.equal(ambiguous.ok, false);
    if (!ambiguous.ok) assert.equal(ambiguous.reason, "ambiguous");
    const exact = await resolveDecisionIssue(root, { kind: "finding", universe, id: "f_repeat", scope });
    assert.equal(exact.ok, true);
    if (exact.ok && exact.ref.kind === "finding") {
      assert.equal(exact.ref.scope, scope);
      assert.equal(exact.ref.review, "265");
    }
  } finally { discard(root); }
});

test("branch review key and exact source scope identify the same finding", async () => {
  const root = tmp();
  try {
    const universe = universeKey(root);
    const scope = sharedFinding(root, "f_branch", "branch:feature/x", "feature/x");
    const a = await resolveDecisionIssue(root, { kind: "finding", universe, id: "f_branch", review: "branch:feature/x" });
    const b = await resolveDecisionIssue(root, { kind: "finding", universe, id: "f_branch", scope });
    assert.equal(a.ok, true);
    assert.equal(b.ok, true);
    if (a.ok && b.ok && a.ref.kind === "finding" && b.ref.kind === "finding") {
      assert.equal(a.key, b.key);
      assert.equal(a.ref.review, "branch:feature/x");
      assert.equal(b.ref.review, "branch:feature/x");
    }
  } finally { discard(root); }
});

test("bug identity uses its typed universe scope and rejects a local bug", async () => {
  const root = tmp();
  try {
    const universe = universeKey(root);
    const scope = sharedBug(root, "bug_exact");
    const shared = await resolveDecisionIssue(root, { kind: "bug", universe, id: "bug_exact" });
    assert.equal(shared.ok, true);
    if (shared.ok) assert.equal(shared.ref.scope, scope);
    await writeLocalBug(root, testBug({ id: "bug_local", title: "local" }));
    const local = await resolveDecisionIssue(root, { kind: "bug", universe, id: "bug_local" });
    assert.equal(local.ok, false);
    if (!local.ok) assert.equal(local.reason, "local-only");
    const wrong = await resolveDecisionIssue(root, { kind: "bug", universe, id: "bug_exact", scope: "bugs/other" });
    assert.equal(wrong.ok, false);
    if (!wrong.ok) assert.equal(wrong.reason, "wrong-scope");
  } finally { discard(root); }
});

test("finding identity refuses local and cross-universe rows", async () => {
  const root = tmp();
  try {
    const universe = universeKey(root);
    await writeLocalFinding(root, finding("f_local"), 264);
    const local = await resolveDecisionIssue(root, { kind: "finding", universe, id: "f_local", review: 264 });
    assert.equal(local.ok, false);
    if (!local.ok) assert.equal(local.reason, "local-only");
    const foreign = await resolveDecisionIssue(root, { kind: "finding", universe: "other/repo", id: "f_local", review: 264 });
    assert.equal(foreign.ok, false);
    if (!foreign.ok) assert.equal(foreign.reason, "wrong-universe");
  } finally { discard(root); }
});
