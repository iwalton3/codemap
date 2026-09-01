/**
 * The backlog projection — six buckets, each naming a different next action.
 *
 * "97 open findings on merged pull requests" is one number nobody can act on. The split
 * is the design: measured across two live universes, that pile was 47% still exactly
 * true of the trunk, 25% moved, and 19% carrying no witness at all — three completely
 * different pieces of work behind one count.
 *
 * Every case here is driven through the real projection against a real store, because a
 * bucket that could never be reached is worse than a missing one. `sleeping` in
 * particular must NOT be in `attention`: a backlogged finding with a live deadline is a
 * decision somebody made, and counting it as debt makes deferring honestly look
 * identical to ignoring the thing.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { indexBlob } from "./repo.js";
import { writeStore, writeLocalFinding } from "./store.js";
import type { State, Actor, BugWitness } from "./schema.js";
import type { SharedFinding } from "./shared-findings.js";
import { findingBacklog } from "./ops-shared.js";
import { discard } from "./test-tmp.js";

const state: State = { schemaVersion: 1, lastVerifiedCommit: null, branch: null } as State;
const V1 = "export function creditLine(cents) {\n  return cents * 2;\n}\n";
const PERSON: Actor = { principal: "izzie@x.com" };

/** A store whose one symbol is at `src/credit.js`, plus that anchor's id and live hash. */
async function universe(source = V1) {
  const root = mkdtempSync(join(tmpdir(), "codemap-backlog-"));
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(join(root, "src/credit.js"), source, "utf8");
  const anchors = await indexBlob(source, "src/credit.js");
  await writeStore(root, anchors, state);
  return { root, id: anchors[0]!.id, hash: anchors[0]!.bodyHash };
}

const finding = (id: string, over: Partial<SharedFinding> = {}): SharedFinding => ({
  id, target: { kind: "anchor", id: "a_x" }, text: "creditLine doubles the amount",
  author: PERSON, createdAt: "2026-08-01T00:00:00Z",
  state: "created", corroboration: [], thread: [], revisions: [], ...over,
} as SharedFinding);

const backlogged = (until: string, witness?: BugWitness) =>
  ({ until, reason: "slated for replacement", by: PERSON, at: "2026-09-01T00:00:00Z", ...(witness ? { witness } : {}) });

/**
 * A hash that DIFFERS but is still comparable — the same derivation, another digest.
 *
 * Fabricating one wholesale (`h2:aaaa:sha256:0000…`) does not work and must not: a
 * witness from another derivation is not evidence the code moved, so `witnessDrift`
 * correctly calls it undecidable and it lands in `unjudgeable`. Only the digest may
 * move if the case is meant to be drift.
 */
const otherBody = (hash: string): string => {
  const i = hash.lastIndexOf(":");
  return hash.slice(0, i + 1) + "0".repeat(hash.length - i - 1);
};

test("an uncarried finding lands by what the code says, and only `live` means undisposed", async () => {
  const { root, id, hash } = await universe();
  try {
    const w = (h: string): BugWitness => ({ anchorId: id, bodyHash: h });
    await writeLocalFinding(root, finding("f_live", { target: { kind: "anchor", id }, witness: w(hash) }), 1);
    await writeLocalFinding(root, finding("f_moved", { target: { kind: "anchor", id }, witness: w(otherBody(hash)) }), 1);
    await writeLocalFinding(root, finding("f_blind", { target: { kind: "anchor", id } }), 1);

    const b = await findingBacklog(root, { asOf: "2026-09-01" });
    assert.deepEqual(b.live.map((r) => r.id), ["f_live"], "the hash still matches — the claim is live");
    assert.deepEqual(b.moved.map((r) => r.id), ["f_moved"], "the code moved — re-validate");
    assert.deepEqual(b.unjudgeable.map((r) => r.id), ["f_blind"], "no witness, so nothing can judge it");
    assert.equal(b.attention, 3, "all three are somebody's work");
  } finally { discard(root); }
});

test("a backlogged finding sleeps until its deadline — and is NOT debt while it does", async () => {
  const { root, id, hash } = await universe();
  try {
    await writeLocalFinding(root, finding("f_sleep", {
      target: { kind: "anchor", id }, witness: { anchorId: id, bodyHash: hash },
      backlogged: backlogged("2027-01-01", { anchorId: id, bodyHash: hash }),
    }), 1);

    const asleep = await findingBacklog(root, { asOf: "2026-09-01" });
    assert.deepEqual(asleep.sleeping.map((r) => r.id), ["f_sleep"]);
    assert.deepEqual(asleep.live, [], "a backlogged finding is not undisposed — somebody disposed of it");
    assert.equal(asleep.attention, 0, "counting a live deferral as debt makes deferring look like ignoring");

    // Same store, same finding, later. The date is the condition that always fires.
    const woken = await findingBacklog(root, { asOf: "2027-06-01" });
    assert.deepEqual(woken.due.map((r) => r.id), ["f_sleep"], "the release condition fired");
    assert.deepEqual(woken.sleeping, []);
    assert.equal(woken.attention, 1);
  } finally { discard(root); }
});

test("it wakes EARLY when somebody edits the code the decision was about", async () => {
  const { root, id, hash } = await universe();
  try {
    // Its own witness, taken when it was backlogged. Drift against THIS — not
    // against the filing witness — is what means "somebody is touching that code now".
    await writeLocalFinding(root, finding("f_touched", {
      target: { kind: "anchor", id }, witness: { anchorId: id, bodyHash: hash },
      backlogged: backlogged("2027-01-01", { anchorId: id, bodyHash: otherBody(hash) }),
    }), 1);
    await writeLocalFinding(root, finding("f_untouched", {
      target: { kind: "anchor", id }, witness: { anchorId: id, bodyHash: hash },
      backlogged: backlogged("2027-01-01", { anchorId: id, bodyHash: hash }),
    }), 1);

    const b = await findingBacklog(root, { asOf: "2026-09-01" });
    assert.deepEqual(b.woken.map((r) => r.id), ["f_touched"], "its code moved under it, well before the date");
    assert.deepEqual(b.sleeping.map((r) => r.id), ["f_untouched"], "and its neighbour is undisturbed");
    assert.equal(b.attention, 1, "only the woken one is owed");
  } finally { discard(root); }
});

test("one with no witness still wakes on its deadline — the deadline is never optional", async () => {
  // What an acknowledgement has always had, and the floor this guarantees: a finding
  // whose anchor had already left the tree when it was backlogged has the date and nothing
  // else, and must still come back rather than sleeping forever.
  const { root, id, hash } = await universe();
  try {
    await writeLocalFinding(root, finding("f_dateonly", {
      target: { kind: "anchor", id }, witness: { anchorId: id, bodyHash: hash }, backlogged: backlogged("2026-10-01"),
    }), 1);
    assert.deepEqual((await findingBacklog(root, { asOf: "2026-09-01" })).sleeping.map((r) => r.id), ["f_dateonly"]);
    assert.deepEqual((await findingBacklog(root, { asOf: "2026-10-01" })).due.map((r) => r.id), ["f_dateonly"],
      "due ON the date, not after it");
  } finally { discard(root); }
});

test("a closed finding is in no bucket at all", async () => {
  const { root, id, hash } = await universe();
  try {
    for (const s of ["resolved", "refuted", "invalid", "withdrawn"] as const) {
      await writeLocalFinding(root, finding("f_" + s, {
        target: { kind: "anchor", id }, witness: { anchorId: id, bodyHash: hash }, state: s,
      }), 1);
    }
    const b = await findingBacklog(root, { asOf: "2026-09-01" });
    assert.equal(b.attention, 0);
    assert.deepEqual(b.counts, { due: 0, woken: 0, sleeping: 0, live: 0, moved: 0, unjudgeable: 0 });
  } finally { discard(root); }
});

test("converting findings to bugs in BULK says so, and one at a time does not", async () => {
  // The distinction the note is about: a finding that is a real defect belongs in the
  // bug queue, and that is the ordinary case. What devalues the queue is sweeping a
  // pull request's leftovers into it — so this warns on the run, never on the act, and
  // it never refuses either.
  const { root, id, hash } = await universe();
  // A finding is only ever accepted into a SHARED bug, so this needs an identity and a
  // sidecar — a pointer file is the whole of it.
  const git = (...a: string[]) => spawnSync("git", ["-c", "user.email=izzie@x.com", "-c", "user.name=t", ...a], { cwd: root });
  git("init", "-q", "-b", "main");
  git("config", "user.email", "izzie@x.com");
  git("config", "user.name", "izzie");
  const side = mkdtempSync(join(tmpdir(), "codemap-backlog-side-"));
  mkdirSync(join(root, ".codemap"), { recursive: true });
  writeFileSync(join(root, ".codemap", "sidecar"), side, "utf8");
  try {
    const { deferFinding } = await import("./ops.js");
    const { shareFinding } = await import("./ops-shared.js");
    // Through the real verb, not `writeLocalFinding`: a finding is accepted into a bug
    // from the LOG, so a hand-written projection row is a finding `deferFinding`
    // correctly cannot find.
    const ids: string[] = [];
    for (let i = 0; i < 7; i++) {
      const r = await shareFinding(root, 9, { targetKind: "anchor", targetId: id, text: `finding ${i}` }) as { id?: string; error?: string };
      assert.ok(r.id, `filing ${i} failed: ${r.error}`);
      ids.push(r.id!);
    }
    const notes: (string | undefined)[] = [];
    for (const fid of ids) {
      const r = await deferFinding(root, fid);
      assert.ok(!r.error, `conversion of ${fid} failed: ${r.error}`);
      // `warning`, not `note` — the underlying accept has a note of its own and this
      // must add a message rather than replace it. Asserted, because overwriting it was
      // the first version of this.
      assert.match(String(r.note), /the bug now carries the obligation/, "the op's own note survives");
      notes.push(r.warning as string | undefined);
    }
    void hash;
    assert.equal(notes[0], undefined, "the first conversion is ordinary triage and must warn about nothing");
    assert.equal(notes[3], undefined, "…and so is the fourth");
    assert.match(String(notes[6]), /stops reading as/, "but a run of them is visible while it happens");
    assert.match(String(notes[6]), /backlogged instead/, "and names the alternative");
  } finally { discard(root); discard(side); }
});

test("`landed` is decided by the CODE reaching the trunk, not by a pull request's status", async () => {
  // The moment a finding changes kind. Answered locally and from ancestry, which also
  // gets the stacked case right: a pull request merged into another branch reads MERGED
  // on GitHub while its code is nowhere near the trunk, and its findings are still
  // ordinary review rather than debt.
  const { root, id, hash } = await universe();
  const git = (...a: string[]) => spawnSync("git", ["-c", "user.email=izzie@x.com", "-c", "user.name=t", ...a], { cwd: root, encoding: "utf8" });
  try {
    git("init", "-q", "-b", "main");
    git("add", "-A");
    git("commit", "-qm", "on the trunk");
    const onTrunk = git("rev-parse", "HEAD").stdout.trim();
    git("checkout", "-qb", "feat/stacked");
    writeFileSync(join(root, "src/other.js"), "export const x = 1;\n", "utf8");
    git("add", "-A");
    git("commit", "-qm", "not on the trunk");
    const offTrunk = git("rev-parse", "HEAD").stdout.trim();
    git("checkout", "-q", "main");

    const w = { anchorId: id, bodyHash: hash };
    await writeLocalFinding(root, finding("f_debt", { target: { kind: "anchor", id }, witness: w, sourceRef: onTrunk }), 1);
    await writeLocalFinding(root, finding("f_review", { target: { kind: "anchor", id }, witness: w, sourceRef: offTrunk }), 2);
    await writeLocalFinding(root, finding("f_work", { target: { kind: "anchor", id }, witness: w, sourceRef: "@work" }), 3);
    await writeLocalFinding(root, finding("f_none", { target: { kind: "anchor", id }, witness: w }), 4);

    const b = await findingBacklog(root, { asOf: "2026-09-01" });
    const landing = Object.fromEntries(b.live.map((r) => [r.id, r.landed]));
    assert.equal(landing.f_debt, "landed", "its code is on the trunk — this is debt now");
    assert.equal(landing.f_review, "open", "a stacked branch's code has not landed, whatever GitHub says");
    // `@work` names no commit, and it was a third of the measured findings. Guessing
    // either way would put real debt in the wrong pile silently.
    assert.equal(landing.f_work, "unknown", "absence of evidence is not evidence");
    assert.equal(landing.f_none, "unknown");
    assert.deepEqual(b.byLanding, { landed: 1, open: 1, unknown: 2 });
  } finally { discard(root); }
});
