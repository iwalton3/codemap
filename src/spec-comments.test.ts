/**
 * Commenting on a PROPOSAL, end to end — the surface a reviewer argues on.
 *
 * Most of this was already built (`7c224fe`), and this file exists because "already
 * built" was not the same as "verified from both ends". Writing it found two holes, and
 * both are the same shape: a call that reported success while doing something other than
 * what its caller asked for.
 *
 *  - `inReplyTo` was accepted on a proposal comment and SILENTLY DROPPED. A proposal's
 *    threads are one-per-call by design, so there was nothing to attach to — and the reply
 *    then opened a second top-level thread that reads as a fresh objection, on the one
 *    surface a principal decides from.
 *  - With no sidecar, `spec` answered `comments: []`. An empty thread reads as "nobody
 *    objected", which is a surface answering a question it never asked — the failure
 *    `standardScopeWarning` exists for one layer up.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { indexBlob } from "./repo.js";
import { writeStore } from "./store.js";
import type { State } from "./schema.js";
import { discard } from "./test-tmp.js";
import { draftSpec, addOperation } from "./requirements.js";
import { getSpec } from "./ops/standard.js";
import { commentOn } from "./ops.js";
import { answerSharedNote, sharedNotes } from "./ops-shared.js";

const state: State = { schemaVersion: 1, lastVerifiedCommit: null, branch: null } as State;
const SRC = "export function creditLine(cents) { return cents; }\n";
const AGENT = { agent: true, model: "claude-opus-5", harness: "claude-code" } as const;

const ok = <T>(r: T): Exclude<T, { error: string }> => {
  assert.ok(!(r && typeof r === "object" && "error" in (r as object)), `unexpected error: ${(r as any)?.error}`);
  return r as Exclude<T, { error: string }>;
};
const err = (r: unknown): string => {
  assert.ok(r && typeof r === "object" && "error" in (r as object), `expected a refusal, got ${JSON.stringify(r)}`);
  return (r as { error: string }).error;
};

const git = (root: string, ...a: string[]) => spawnSync("git", a, { cwd: root, encoding: "utf8" });

async function universe(opts: { sidecar?: boolean } = {}) {
  const root = mkdtempSync(join(tmpdir(), "codemap-cmt-"));
  git(root, "init", "-q", "-b", "main");
  git(root, "config", "user.email", "izzie@x.com");
  git(root, "config", "user.name", "izzie");
  mkdirSync(join(root, ".codemap"), { recursive: true });
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(join(root, "src/credit.js"), SRC, "utf8");
  git(root, "add", "-A");
  git(root, "commit", "-qm", "fixture");
  let side: string | null = null;
  if (opts.sidecar) {
    side = mkdtempSync(join(tmpdir(), "codemap-cmtside-"));
    writeFileSync(join(root, ".codemap", "sidecar"), side, "utf8");
  }
  await writeStore(root, await indexBlob(SRC, "src/credit.js"), state);
  return { root, cleanup: () => { discard(root); if (side) discard(side); } };
}

async function drafted(root: string) {
  const sp = ok(await draftSpec(root, { title: "Credit currency policy", ...AGENT }));
  const op = ok(await addOperation(root, {
    specId: sp.id, kind: "add_requirement", rationale: "policy §4 was never written down",
    reversibility: "reversible", title: "Credit line currency", section: "Credit/Limits",
    statement: "All credit lines are in USD.", provenance: "credit policy §4", ...AGENT,
  }));
  return { specId: sp.id, opId: op.id };
}

test("an agent posts on a spec and on an operation, and both read back where the ratifier looks", async () => {
  const u = await universe({ sidecar: true });
  try {
    const { specId, opId } = await drafted(u.root);
    const onSpec = ok(await commentOn(u.root, { id: specId, body: "is T+1 calendar or business days?", ...AGENT }));
    const onOp = ok(await commentOn(u.root, { id: opId, body: "does this cover multi-currency lines?", ...AGENT }));

    // Threads are per TARGET, and the operation's renders against the operation — an
    // objection to one amendment belongs where the ratifier reads that amendment.
    const d = ok(await getSpec(u.root, { specId }));
    assert.deepEqual(d.comments.map((c) => c.id), [onSpec.id]);
    assert.deepEqual(d.operations[0]!.comments.map((c) => c.id), [onOp.id]);
    assert.equal(d.comments[0]!.model, "claude-opus-5", "\"agent\" alone does not say whose objection this is");
    assert.equal(d.commentsUnavailable, undefined, "the store can read them, so nothing warns");
  } finally { u.cleanup(); }
});

test("a reply threads under the comment it answers", async () => {
  const u = await universe({ sidecar: true });
  try {
    const { specId } = await drafted(u.root);
    const first = ok(await commentOn(u.root, { id: specId, body: "is T+1 calendar or business days?", ...AGENT }));
    ok(await answerSharedNote(u.root, specId, first.id, "business days — §4 says so"));

    const d = ok(await getSpec(u.root, { specId }));
    assert.equal(d.comments.length, 1, "an answer does not open a second thread");
    assert.deepEqual(d.comments[0]!.answers.map((a) => a.body), ["business days — §4 says so"]);
  } finally { u.cleanup(); }
});

test("`inReplyTo` on a proposal is REFUSED, not silently dropped", async () => {
  const u = await universe({ sidecar: true });
  try {
    const { specId, opId } = await drafted(u.root);
    const first = ok(await commentOn(u.root, { id: specId, body: "is T+1 calendar or business days?", ...AGENT }));

    for (const target of [specId, opId]) {
      const e = err(await commentOn(u.root, { id: target, body: "answering that", inReplyTo: first.id, ...AGENT }));
      assert.match(e, /answer_shared_note/, "and the refusal names the verb that DOES reply");
    }
    // Nothing was written. Dropping it silently left the caller's model of what happened
    // intact and wrong, with an extra top-level objection on the ratifier's screen.
    assert.equal(ok(await getSpec(u.root, { specId })).comments.length, 1);
    assert.equal(ok(await sharedNotes(u.root, opId)).notes.length, 0);
  } finally { u.cleanup(); }
});

test("with no sidecar, an empty thread says WHY rather than reading as agreement", async () => {
  const u = await universe();
  try {
    const { specId } = await drafted(u.root);
    assert.match(err(await commentOn(u.root, { id: specId, body: "an objection", ...AGENT })), /sidecar/i);

    const d = ok(await getSpec(u.root, { specId }));
    assert.deepEqual(d.comments, []);
    assert.match(d.commentsUnavailable ?? "", /sidecar/i,
      "an empty comments array on a store that cannot read them is silence presented as agreement");
  } finally { u.cleanup(); }
});
