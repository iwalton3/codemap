/**
 * Findings on code a change DELETES (triage run 2026-09-19-post-round-review, Item C).
 * The owner's cases, each run end to end: a deletion finding is open while the deletion is
 * unmerged and landed once the symbol is gone from the trunk tip (Q2, amending Q9), it is
 * always a deletion (Q3), pull requests resolve as branches do (Q4), and a line number
 * that misses at the head is refused (Q6). Plus I1 (ambiguity is not absence) and the fold.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { reportDefect } from "./ops/defect.js";
import { init } from "./ops.js";
import { readFindings, writeLocalFinding } from "./store.js";
import { readSnapshot } from "./snapshots.js";
import { findingBacklog } from "./ops-shared.js";
import { foldFindings } from "./shared-findings.js";
import { branchKey } from "./review-target.js";
import type { LogEvent } from "./eventlog.js";
import { discard } from "./test-tmp.js";

const PAY = [
  "export function transfer(cents: number) {", "  return cents;", "}", "",
  "export function refund(cents: number) {", "  return -cents;", "}", "",
].join("\n");
const TWINS = "export class A {\n  run() { return 1; }\n}\nexport class B {\n  run() { return 2; }\n}\n";

/** main holds `refund`; `feature` deletes it. No origin, so the trunk is `main`. */
async function repo() {
  const base = mkdtempSync(join(tmpdir(), "codemap-deletion-"));
  const root = join(base, "repo");
  mkdirSync(join(root, "src"), { recursive: true });
  mkdirSync(join(root, ".codemap"), { recursive: true });
  const git = (...a: string[]) => {
    const r = spawnSync("git", ["-c", "user.email=izzie@x.com", "-c", "user.name=izzie", ...a], { cwd: root, encoding: "utf8" });
    if (r.status !== 0) throw new Error(`git ${a.join(" ")}: ${r.stderr}`);
    return r.stdout.trim();
  };
  git("init", "-q", "-b", "main");
  writeFileSync(join(root, "src/pay.ts"), PAY);
  writeFileSync(join(root, "src/twins.ts"), TWINS);
  writeFileSync(join(root, ".gitignore"), ".codemap/\n");
  git("add", "-A"); git("commit", "-q", "-m", "main");
  const baseSha = git("rev-parse", "HEAD");
  git("checkout", "-q", "-b", "feature");
  writeFileSync(join(root, "src/pay.ts"), PAY.split("export function refund")[0]!);
  git("commit", "-q", "-am", "delete refund");
  const headSha = git("rev-parse", "HEAD");
  git("checkout", "-q", "main");
  await init(root);
  const refund = (await readSnapshot(root, baseSha))!.find((a) => a.symbolPath.at(-1) === "refund")!;
  return { root, git, baseSha, headSha, refund, cleanup: () => discard(base) };
}

const onBranch = (root: string, targetId: string, branch = "feature") => reportDefect(root, {
  context: { kind: "branch", branch }, targetKind: "anchor", targetId,
  text: "the evidence", comment: "callers still need this", severity: "medium",
}) as Promise<Record<string, unknown>>;

const onPr = (root: string, targetId: string, ref: string) => reportDefect(root, {
  context: { kind: "pull_request", pr: "12" }, targetKind: "anchor", targetId, ref,
  text: "the evidence", comment: "callers still need this", severity: "medium",
}) as Promise<Record<string, unknown>>;

async function landing(root: string) {
  const b = await findingBacklog(root, { asOf: "2026-09-19" });
  const rows = [...b.due, ...b.woken, ...b.sleeping, ...b.live, ...b.moved, ...b.unjudgeable, ...b.inReview];
  return { landed: Object.fromEntries(rows.map((r) => [r.id, r.landed])), moved: b.moved.map((r) => r.id) };
}

test("a finding on a symbol the branch deletes is a DELETION, witnessed at the head", async () => {
  const u = await repo();
  try {
    const out = await onBranch(u.root, "src/pay.ts#refund");
    assert.equal(out.error, undefined, String(out.error));
    const [f] = (await readFindings(u.root, { pr: branchKey("feature") })).findings;
    assert.equal(f!.target.id, u.refund.id);
    assert.deepEqual(f!.witness, { anchorId: u.refund.id, bodyHash: u.refund.bodyHash, deleted: true });
    assert.equal(f!.sourceRef, u.headSha, "the head holds the deletion; the base is already on the trunk");
  } finally { u.cleanup(); }
});

test("a deletion finding is open until the deletion reaches the trunk, then landed (cases 1, 2)", async () => {
  const u = await repo();
  try {
    const id = String((await onBranch(u.root, "src/pay.ts#refund")).id);
    assert.equal((await landing(u.root)).landed[id], "open", "the trunk still runs `refund`; nothing has landed");
    u.git("merge", "-q", "--no-ff", "-m", "merge feature", "feature");
    assert.equal((await landing(u.root)).landed[id], "landed", "merged: the deletion is on the trunk");
  } finally { u.cleanup(); }
});

test("an abandoned deletion never lands, and the same deletion reaching the trunk another way does (cases 2, 3)", async () => {
  const u = await repo();
  try {
    const id = String((await onBranch(u.root, "src/pay.ts#refund")).id);
    u.git("commit", "-q", "--allow-empty", "-m", "the trunk moves on; feature is abandoned");
    assert.equal((await landing(u.root)).landed[id], "open");
    writeFileSync(join(u.root, "src/pay.ts"), PAY.split("export function refund")[0]!);
    u.git("commit", "-q", "-am", "somebody else deletes refund on the trunk");
    assert.equal((await landing(u.root)).landed[id], "landed", "the symbol is gone from the tip");
  } finally { u.cleanup(); }
});

test("a landed deletion whose symbol comes back reads as moved (case 4)", async () => {
  const u = await repo();
  try {
    const id = String((await onBranch(u.root, "src/pay.ts#refund")).id);
    u.git("merge", "-q", "--no-ff", "-m", "merge feature", "feature");
    await init(u.root);
    assert.ok(!(await landing(u.root)).moved.includes(id), "absent, as the deletion said");
    writeFileSync(join(u.root, "src/pay.ts"), PAY);
    u.git("commit", "-q", "-am", "refund is back");
    await init(u.root);
    assert.ok((await landing(u.root)).moved.includes(id), "the deletion no longer holds");
  } finally { u.cleanup(); }
});

test("a rename is a deletion of the old name, and it lands when the rename lands (case 5)", async () => {
  const u = await repo();
  try {
    u.git("checkout", "-q", "-b", "rename");
    writeFileSync(join(u.root, "src/pay.ts"), PAY.replace("refund", "refundAll"));
    u.git("commit", "-q", "-am", "rename");
    u.git("checkout", "-q", "main");
    const out = await onBranch(u.root, "src/pay.ts#refund", "rename");
    const f = (await readFindings(u.root, { pr: branchKey("rename") })).findings.find((x) => x.id === out.id)!;
    assert.equal(f.witness?.deleted, true);
    assert.equal((await landing(u.root)).landed[f.id], "open");
    u.git("merge", "-q", "--no-ff", "-m", "merge rename", "rename");
    assert.equal((await landing(u.root)).landed[f.id], "landed");
  } finally { u.cleanup(); }
});

test("a pull-request finding resolves as a branch finding does: head, else the deletion, else refused", async () => {
  const u = await repo();
  try {
    const out = await onPr(u.root, "src/pay.ts#refund", u.headSha);
    assert.equal(out.error, undefined, String(out.error));
    const [f] = (await readFindings(u.root, { pr: 12 })).findings;
    assert.equal(f!.witness?.deleted, true, "a deletion, not the trunk's body");
    assert.equal(f!.sourceRef, u.headSha);

    // Code only the root checkout's trunk has — added after the branch left it — is not
    // code this pull request holds or deletes. It used to be witnessed at `@work`.
    writeFileSync(join(u.root, "src/late.ts"), "export function late() { return 1; }\n");
    u.git("add", "-A"); u.git("commit", "-q", "-m", "late");
    await init(u.root);
    const late = await onPr(u.root, "src/late.ts#late", u.headSha);
    assert.match(String(late.error), /not in pull request 12's last commit/);
  } finally { u.cleanup(); }
});

test("an ambiguous name at the head is the filer's to pick, never read as a deletion (I1)", async () => {
  const u = await repo();
  try {
    const out = await onBranch(u.root, "src/twins.ts#run");
    assert.match(String(out.error), /ambiguous/);
  } finally { u.cleanup(); }
});

test("a line number that misses at the head is refused, naming the symbol it meant at the base (I2)", async () => {
  const u = await repo();
  try {
    const out = await onBranch(u.root, "src/pay.ts:6");
    assert.match(String(out.error), /src\/pay\.ts#refund/);
    assert.equal((await readFindings(u.root, { pr: branchKey("feature") })).findings.length, 0, "and nothing was filed");
  } finally { u.cleanup(); }
});

test("the fold keeps a deletion marker, and drops a witness whose marker is malformed", () => {
  const ev = (subject: string, witness: unknown) => ({
    kind: "finding.created", subject, at: "2026-09-19T00:00:00Z",
    actor: { principal: "izzie", kind: "human" },
    data: { text: "t", targetKind: "anchor", targetId: "a_1", witness },
  } as unknown as LogEvent);
  const out = foldFindings([
    ev("f_del", { anchorId: "a_1", bodyHash: "h", deleted: true }),
    ev("f_bad", { anchorId: "a_1", bodyHash: "h", deleted: "yes" }),
    ev("f_body", { anchorId: "a_1", bodyHash: "h" }),
  ]);
  assert.deepEqual(out.get("f_del")!.witness, { anchorId: "a_1", bodyHash: "h", deleted: true });
  assert.equal(out.get("f_bad")!.witness, undefined, "read as a body it would land at filing");
  assert.deepEqual(out.get("f_body")!.witness, { anchorId: "a_1", bodyHash: "h" });
});

test("a committed deletion is not refused as uncommitted because the same file has an unrelated edit", async () => {
  // triage 2026-09-19-deletion-fixes-review I9: the file-level uncommitted check ran before
  // the base was asked, so any dirty edit in the file masked the deletion committed in it.
  const u = await repo();
  try {
    const wt = join(u.root, "..", "feature-wt");
    u.git("worktree", "add", "-q", wt, "feature");
    writeFileSync(join(wt, "src/pay.ts"), "export function transfer(cents: number) {\n  return cents + 1;\n}\n");
    const r = await onBranch(u.root, "src/pay.ts#refund");
    assert.equal(r.error, undefined, String(r.error));
    const f = (await readFindings(u.root, { pr: branchKey("feature") })).findings.find((x) => x.id === r.id)!;
    assert.equal(f.witness?.deleted, true);
  } finally { u.cleanup(); }
});

test("a symbol only in a worktree's uncommitted edits is still refused as uncommitted", async () => {
  const u = await repo();
  try {
    const wt = join(u.root, "..", "feature-wt");
    u.git("worktree", "add", "-q", wt, "feature");
    writeFileSync(join(wt, "src/pay.ts"), PAY.split("export function refund")[0]! + "export function brandNew() {\n  return 1;\n}\n");
    const r = await onBranch(u.root, "src/pay.ts#brandNew");
    assert.match(String(r.error), /uncommitted changes/);
  } finally { u.cleanup(); }
});

test("an older build's backlog on a deletion finding folds as a deletion backlog; a body finding's is left alone", () => {
  // triage 2026-09-19-deletion-fixes-review I5: an older `backlogFinding` re-read the body and
  // emitted a plain witness, which woke the backlog the moment the deletion landed, and no
  // refold could recover it. Now the FOLD derives it — upgrading repairs it. Whatever body it
  // names: this build always copies the deletion witness, so a plain one on the same anchor
  // of a deletion finding can only be an older writer's.
  const actor = { principal: "izzie", kind: "human" };
  const ev = (id: string, subject: string, kind: string, data: unknown, at: string) =>
    ({ id, kind, subject, at, actor, data } as unknown as LogEvent);
  const created = (subject: string, witness: unknown) =>
    ev(subject + "-c", subject, "finding.created", { text: "t", targetKind: "anchor", targetId: "a_1", witness }, "2026-09-19T00:00:00Z");
  const backlogged = (subject: string, witness: unknown) =>
    ev(subject + "-b", subject, "finding.backlogged", { until: "2099-01-01", reason: "later", witness }, "2026-09-19T00:01:00Z");
  const out = foldFindings([
    created("f_old", { anchorId: "a_1", bodyHash: "sha256:body", deleted: true }),
    backlogged("f_old", { anchorId: "a_1", bodyHash: "sha256:body" }),
    created("f_body", { anchorId: "a_1", bodyHash: "sha256:body" }),
    backlogged("f_body", { anchorId: "a_1", bodyHash: "sha256:body" }),
  ]);
  assert.deepEqual(out.get("f_old")!.backlogged!.witness, { anchorId: "a_1", bodyHash: "sha256:body", deleted: true });
  assert.equal(out.get("f_body")!.backlogged!.witness!.deleted, undefined, "a body finding's backlog stays a body");
});

test("an older build's LOCAL backlog on a deletion finding is read as a deletion backlog too", async () => {
  // No sidecar, so no fold: the same repair is made where the local row is read.
  const u = await repo();
  try {
    const r = await onBranch(u.root, "src/pay.ts#refund");
    const key = branchKey("feature");
    const f = (await readFindings(u.root, { pr: key })).findings.find((x) => x.id === r.id)!;
    f.backlogged = {
      until: "2099-01-01", reason: "later", by: { principal: "izzie@x.com" }, at: "2026-09-19T00:00:00Z",
      witness: { anchorId: u.refund.id, bodyHash: u.refund.bodyHash },
    };
    await writeLocalFinding(u.root, f, key);
    const b = await findingBacklog(u.root, { asOf: "2026-09-19" });
    assert.deepEqual(b.sleeping.map((x) => x.id), [r.id], "asleep while the deletion is unmerged, not woken");
  } finally { u.cleanup(); }
});
