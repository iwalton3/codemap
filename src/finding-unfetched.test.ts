/**
 * A change this clone cannot see is NOT a finding whose code moved (owner, triage
 * 2026-09-19-review-and-findings-systems, Rulings 7, 12 and 13).
 *
 * Two defects with one shape. A finding whose `sourceRef` this clone never fetched had
 * `landing` = `unknown`, and `unknown` was judged AT THE TRUNK TIP — for a deletion
 * witness that is a positive claim that the deletion was reverted. A pull-request
 * finding's head was looked for at `refs/remotes/origin/pr/N`, a ref nothing in codemap
 * writes and almost nobody configures, so the miss made the answer depend on whether THIS
 * process had already resolved that PR through `gh`: one bucket from the web, another
 * from an agent, over the same store.
 *
 * Both now land in `unfetched` — listed, never counted in `attention`, because it is not
 * work anyone can do without fetching first. The discriminator is local (`hasObject`), and
 * a pull request's head comes from the branch codemap already recorded for it.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { indexBlob } from "./repo.js";
import { writeStore, writeLocalFinding, linkedBranches } from "./store.js";
import type { State, Actor } from "./schema.js";
import type { SharedFinding } from "./shared-findings.js";
import { findingBacklog, linkReviewOp } from "./ops-shared.js";
import { backlogOn } from "./ops.js";
import { discard } from "./test-tmp.js";

const state: State = { schemaVersion: 1, lastVerifiedCommit: null, branch: null } as State;
const V1 = "export function creditLine(cents) {\n  return cents * 2;\n}\n";
const PERSON: Actor = { principal: "izzie@x.com" };

/** A real git universe on `main`, with a `feature` commit that deletes nothing. */
async function universe() {
  const root = mkdtempSync(join(tmpdir(), "codemap-unfetched-"));
  mkdirSync(join(root, "src"), { recursive: true });
  const git = (...a: string[]) => {
    const r = spawnSync("git", ["-c", "user.email=izzie@x.com", "-c", "user.name=izzie", ...a], { cwd: root, encoding: "utf8" });
    if (r.status !== 0) throw new Error(`git ${a.join(" ")}: ${r.stderr}`);
    return r.stdout.trim();
  };
  writeFileSync(join(root, "src/credit.js"), V1, "utf8");
  writeFileSync(join(root, ".gitignore"), ".codemap/\n", "utf8");
  const anchors = await indexBlob(V1, "src/credit.js");
  await writeStore(root, anchors, state);
  git("init", "-q", "-b", "main");
  git("add", "-A"); git("commit", "-q", "-m", "main");
  git("checkout", "-q", "-b", "feature");
  writeFileSync(join(root, "src/credit.js"), V1.replace("cents * 2", "cents * 3"), "utf8");
  git("commit", "-q", "-am", "feature");
  const featureSha = git("rev-parse", "HEAD");
  git("checkout", "-q", "main");
  // The feature's body, which the TRUNK TIP does not hold. A witness the tip holds is
  // `landed` by the code-first rule before `landing` is ever consulted, so every case
  // below would pass for a reason that has nothing to do with what it is testing.
  const off = (await indexBlob(V1.replace("cents * 2", "cents * 3"), "src/credit.js"))[0]!.bodyHash;
  return { root, git, featureSha, id: anchors[0]!.id, hash: anchors[0]!.bodyHash, off, cleanup: () => discard(root) };
}

const finding = (id: string, over: Partial<SharedFinding> = {}): SharedFinding => ({
  id, target: { kind: "anchor", id: "a_x" }, text: "creditLine doubles the amount",
  author: PERSON, createdAt: "2026-08-01T00:00:00Z",
  state: "created", corroboration: [], thread: [], revisions: [], ...over,
} as SharedFinding);

/** Which bucket a finding landed in, and what the whole answer counted as attention. */
const bucketOf = async (root: string, id: string) => {
  const b = await findingBacklog(root, { asOf: "2026-09-19" });
  const keys = ["due", "woken", "sleeping", "live", "moved", "unjudgeable", "unfetched", "inReview"] as const;
  const at = keys.find((k) => (b[k] as { id: string }[]).some((r) => r.id === id));
  return { bucket: at, attention: b.attention };
};

/** A sha of the right shape that no repository has. */
const NOWHERE = "b".repeat(40);

/**
 * The I7 PAIR. Two findings identical in every respect except whether their commit is in
 * this clone — same branch, same witness, same body off the trunk tip. `hasObject` is the
 * only input that differs, so if the two answers were ever the same this file would be
 * proving nothing.
 */
const onBranch = (id: string, sourceRef: string, off: string, anchorId: string) =>
  finding(id, { target: { kind: "anchor", id: anchorId }, witness: { anchorId, bodyHash: off }, sourceRef, branch: "feature" });

test("a finding whose change this clone never fetched is `unfetched`, not drifted", async () => {
  const u = await universe();
  try {
    await writeLocalFinding(u.root, onBranch("f_absent", NOWHERE, u.off, u.id), "branch:feature");
    const r = await bucketOf(u.root, "f_absent");
    assert.equal(r.bucket, "unfetched");
    assert.equal(r.attention, 0, "nobody can act on it without fetching, so it is not owed work");
  } finally { u.cleanup(); }
});

test("and the SAME finding at a commit this clone HAS is judged — so the discriminator does work", async () => {
  const u = await universe();
  try {
    await writeLocalFinding(u.root, onBranch("f_present", u.featureSha, u.off, u.id), "branch:feature");
    assert.equal((await bucketOf(u.root, "f_present")).bucket, "inReview",
      "its branch head still holds what it witnessed — ordinary review");
  } finally { u.cleanup(); }
});

test("a pull request's head is the branch codemap recorded for it, with no `origin/pr/N` anywhere", async () => {
  const u = await universe();
  try {
    // What GitHub actually does: a same-repo PR's head is an ordinary branch, and any
    // normal fetch puts it at refs/remotes/origin/<branch>. `review_link` already records
    // which branch — written when the PR is resolved, and folded from the sidecar, so a
    // teammate who never resolved it still has it after a sync.
    u.git("update-ref", "refs/remotes/origin/feature", u.featureSha);
    await linkReviewOp(u.root, "12", "feature");
    assert.deepEqual(linkedBranches(u.root, 12), ["feature"], "the link is the mechanism under test");
    assert.equal(u.git("for-each-ref", "--format=%(refname)", "refs/remotes/origin/pr"), "",
      "and no origin/pr/* ref exists — the fallback must not be what answers");

    await writeLocalFinding(u.root, finding("f_pr", {
      target: { kind: "anchor", id: u.id }, witness: { anchorId: u.id, bodyHash: u.off }, sourceRef: u.featureSha,
    }), 12);
    assert.equal((await bucketOf(u.root, "f_pr")).bucket, "inReview");
  } finally { u.cleanup(); }
});

test("a pull request whose head this clone cannot resolve is `unfetched`, never `unjudgeable`", async () => {
  const u = await universe();
  try {
    // No link, no origin/pr/N, no `gh`: the head is genuinely unresolvable. This used to
    // reach `unjudgeable`, whose row offers `rewitness_finding` — which REFUSES a finding
    // that already has a witness. The advice and the state disagreed.
    await writeLocalFinding(u.root, finding("f_nohead", {
      target: { kind: "anchor", id: u.id }, witness: { anchorId: u.id, bodyHash: u.off }, sourceRef: u.featureSha,
    }), 12);
    const r = await bucketOf(u.root, "f_nohead");
    assert.equal(r.bucket, "unfetched");
    assert.equal(r.attention, 0);
  } finally { u.cleanup(); }
});

test("`unjudgeable` still means what its name says — a finding with no witness at all", async () => {
  const u = await universe();
  try {
    await writeLocalFinding(u.root, finding("f_blind", { target: { kind: "anchor", id: u.id } }), 12);
    assert.equal((await bucketOf(u.root, "f_blind")).bucket, "unjudgeable",
      "no witness is the case `rewitness_finding` genuinely repairs");
  } finally { u.cleanup(); }
});

test("carrying a finding whose change is not here is REFUSED, not recorded witnessless", async () => {
  const u = await universe();
  try {
    // `until` is required because a deferral that can only ever be woken by a date is the
    // failure the backlog exists to prevent. A carry whose drift condition is structurally
    // dead reproduces it — silently, which is what this refuses.
    await writeLocalFinding(u.root, onBranch("f_carry", NOWHERE, u.off, u.id), "branch:feature");
    const r = await backlogOn(u.root, { id: "f_carry", until: "2027-01-01", reason: "later" }) as Record<string, unknown>;
    assert.match(String(r.error), /not in this clone/);
    assert.equal(r.ok, undefined, "and nothing was recorded");
    assert.equal((await bucketOf(u.root, "f_carry")).bucket, "unfetched", "it stays where it was");
  } finally { u.cleanup(); }
});
