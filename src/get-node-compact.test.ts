/**
 * `get_node`'s documentation view (COD-16).
 *
 * The measured complaint: a well-annotated node's response is mostly review/triage
 * state and annotation revision chains — including text that was withdrawn and
 * rewritten — while the reader wanted the prose. `compact` drops that payload.
 *
 * The size assertion at the bottom is the point of this file rather than a nicety.
 * Every "it omits X" check below still passes if `compact` starts omitting X and
 * quietly reinstates something else, so a test that only checks absences cannot
 * fail in the direction that matters.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { document, annotate, reviseAnnotation, getNode } from "./ops.js";
import { writeStore } from "./store.js";
import { indexBlob } from "./repo.js";
import type { State } from "./schema.js";
import { discard } from "./test-tmp.js";

const git = (root: string, ...args: string[]) =>
  spawnSync("git", ["-c", "user.email=izzie@x.com", "-c", "user.name=t", ...args], { cwd: root, encoding: "utf8" });

const state: State = { schemaVersion: 1, lastVerifiedCommit: null, branch: null } as State;

const SRC = `export function transfer(cents: number) {
  return cents;
}
export function settle(cents: number) {
  return cents * 2;
}
`;

/** A universe with one file, one node over both its symbols, and annotation history. */
async function universe() {
  const root = mkdtempSync(join(tmpdir(), "codemap-gnc-"));
  git(root, "init", "-q", "-b", "main");
  mkdirSync(join(root, ".codemap"), { recursive: true });
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(join(root, "src/pay.ts"), SRC, "utf8");
  const indexed = await indexBlob(SRC, "src/pay.ts");
  await writeStore(root, indexed, state);
  const anchors = indexed.map((a) => a.id);

  await document(root, {
    id: "money-movement", type: "module", title: "Money movement",
    summary: "How cents get from one ledger to another.",
    body: "Transfer is the only entry point; settle doubles for the fee model.",
    anchors,
  });

  // The payload the ticket is about: annotations that were revised, so the response
  // carries superseded wording as well as current. `note` rather than `finding` —
  // `annotate` refuses findings now (they route through `report_defect`), and the
  // revision chain that costs the tokens is the same either way.
  for (const [i, aid] of anchors.entries()) {
    const a = await annotate(root, {
      targetKind: "anchor", targetId: aid, kind: "note",
      text: `initial wording ${i} — `.repeat(20),
      comment: `initial rationale ${i} — `.repeat(20),
    }) as { id: string };
    await reviseAnnotation(root, {
      id: a.id, allowPostEdit: true,
      text: `rewritten wording ${i} — `.repeat(20),
      comment: `rewritten rationale ${i} — `.repeat(20),
    });
  }
  return { root, anchors, cleanup: () => discard(root) };
}

test("compact keeps the documentation — prose, and WHICH code it covers", async () => {
  const u = await universe();
  try {
    const n = await getNode(u.root, "money-movement", { compact: true }) as any;
    assert.ok(!n.error, `refused: ${n.error}`);
    assert.equal(n.title, "Money movement");
    assert.match(n.summary, /one ledger to another/);
    assert.match(n.body, /only entry point/);
    assert.equal(n.trust, "unverified", "the trust ladder still resolves");
    // Briefs, not bare ids: the ticket proposed ids only, which would have traded
    // this one call for an N-call `get_anchor` walk to learn the same thing.
    assert.equal(n.resolvedAnchors.length, u.anchors.length);
    const symbols = n.resolvedAnchors.map((a: any) => a.symbol).sort();
    assert.deepEqual(symbols, ["settle", "transfer"], "a reader can see the covered code");
    for (const a of n.resolvedAnchors) assert.equal(a.file, "src/pay.ts");
  } finally { u.cleanup(); }
});

test("compact drops the review/triage/annotation payload", async () => {
  const u = await universe();
  try {
    const n = await getNode(u.root, "money-movement", { compact: true }) as any;
    assert.equal(n.compact, true, "and says so, so a caller knows what it did not get");
    assert.ok(!("annotations" in n), "no node-level annotations");
    assert.ok(!("triage" in n), "no node-level triage prose");
    for (const a of n.resolvedAnchors) {
      for (const k of ["review", "viewed", "severity", "triage", "annotations"]) {
        assert.ok(!(k in a), `per-anchor "${k}" is gone`);
      }
    }
    // Nothing withdrawn survives anywhere in the response.
    assert.ok(!JSON.stringify(n).includes("initial wording"),
      "superseded finding text must not ride along");
  } finally { u.cleanup(); }
});

test("the full view is unchanged — compact is opt-in, not a new default", async () => {
  const u = await universe();
  try {
    const n = await getNode(u.root, "money-movement") as any;
    assert.ok(!("compact" in n));
    assert.ok(Array.isArray(n.annotations), "node annotations still served");
    assert.ok(n.resolvedAnchors.every((a: any) => a.review && a.triage),
      "per-anchor review/triage still served to the queue-working caller");
    assert.ok(JSON.stringify(n).includes("initial wording"),
      "including the revision history — which is why the compact view exists");
  } finally { u.cleanup(); }
});

test("compact is SUBSTANTIALLY smaller — the check that can actually fail", async () => {
  const u = await universe();
  try {
    const full = JSON.stringify(await getNode(u.root, "money-movement"));
    const lean = JSON.stringify(await getNode(u.root, "money-movement", { compact: true }));
    const ratio = lean.length / full.length;
    // Two anchors with one revised finding each — a modest node by the standards of
    // the one on the ticket (10 anchors, two full revision chains). If a future edit
    // reinstates the fat payload under another key this fails; the absence checks
    // above would not.
    assert.ok(ratio < 0.35,
      `compact is ${(ratio * 100).toFixed(0)}% of full (${lean.length}/${full.length}) — expected under 35%`);
  } finally { u.cleanup(); }
});
