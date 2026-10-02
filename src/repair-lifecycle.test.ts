import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { repairCodeLifecycle } from "./repair-lifecycle.js";
import type { RepairEvidenceInput } from "./repair-records.js";
import type { SharedFinding } from "./shared-findings.js";
import { discard } from "./test-tmp.js";
import { writeLocalLink } from "./store.js";
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "codemap-repair-life-"));
  const git = (...args: string[]) => {
    const out = spawnSync("git", args, { cwd: root, encoding: "utf8" });
    assert.equal(out.status, 0, out.stderr); return out.stdout.trim();
  };
  git("init", "-b", "main"); git("config", "user.name", "tester"); git("config", "user.email", "test@example.test");
  writeFileSync(join(root, "guard.js"), "export const guard = x => x;\n");
  git("add", "."); git("commit", "-m", "base"); const base = git("rev-parse", "HEAD");
  git("checkout", "-b", "repair");
  writeFileSync(join(root, "guard.js"), "export const guard = x => x < 0 ? 0 : x;\n");
  git("add", "."); git("commit", "-m", "repair"); const fix = git("rev-parse", "HEAD");
  const evidence = { baseCommit: base, witnessCommit: base, fixCommit: fix, attribution: [], inspected: [], id: "e", sortId: "s", coverage: [], reproducer: [], changeFalsifier: [], regression: [], rulingIds: [] } as RepairEvidenceInput;
  const finding = { sourceRef: base, target: { kind: "anchor", id: "a_guard" } } as SharedFinding;
  return { root, git, evidence, finding, base, fix };
}
test("repair adequacy on a branch is distinct from landing, and drift retains historical boundary", async () => {
  const f = fixture(); try {
    const onBranch = { ...f.finding, branch: "repair" } as SharedFinding;
    const branch = await repairCodeLifecycle(f.root, onBranch, f.evidence, "fixed");
    assert.equal(branch.landing, "open"); assert.equal(branch.source, "unchanged"); assert.equal(branch.checkedCommit, f.fix);
    writeFileSync(join(f.root, "guard.js"), "export const guard = x => x;\n");
    f.git("commit", "-qam", "the branch undoes the guard");
    const moved = await repairCodeLifecycle(f.root, onBranch, f.evidence, "fixed");
    assert.equal(moved.source, "moved"); assert.equal(moved.checkedCommit, f.fix);
    assert.match(moved.reasons.join(" "), /historical success remains/);
  } finally { discard(f.root); }
});
test("exact repair file reaches default through cherry-pick or squash, and new trunk SHA invalidates lineage cache", async () => {
  const f = fixture(); try {
    assert.equal((await repairCodeLifecycle(f.root, f.finding, f.evidence, "fixed")).landing, "open");
    f.git("checkout", "main");
    writeFileSync(join(f.root, "unrelated.txt"), "separate commit\n"); f.git("add", "."); f.git("commit", "-m", "unrelated");
    f.git("merge", "--squash", "repair"); f.git("commit", "-m", "squash repair");
    assert.notEqual(f.git("rev-parse", "HEAD"), f.fix);
    assert.equal((await repairCodeLifecycle(f.root, f.finding, f.evidence, "fixed")).landing, "landed");
    f.git("checkout", "repair"); f.git("checkout", "main"); f.git("merge", "repair");
    assert.equal((await repairCodeLifecycle(f.root, f.finding, f.evidence, "fixed")).landing, "landed");
  } finally { discard(f.root); }
});
test("missing commit stays unknown and an unchanged empty scope is never vacuous body proof", async () => {
  const f = fixture(); try {
    const missing = await repairCodeLifecycle(f.root, f.finding, { ...f.evidence, fixCommit: "0".repeat(40) }, "fixed");
    assert.equal(missing.landing, "unknown"); assert.equal(missing.source, "unknown");
    const empty = await repairCodeLifecycle(f.root, f.finding, { ...f.evidence, baseCommit: f.fix }, "fixed");
    assert.equal(empty.landing, "open"); assert.equal(empty.source, "unknown");
  } finally { discard(f.root); }
});
test("F29: the working tree never moves a repair's source, whatever is checked out; an unlanded repair with no branch has none", async () => {
  const f = fixture(); try {
    const onBranch = { ...f.finding, branch: "repair" } as SharedFinding;
    writeFileSync(join(f.root, "guard.js"), "an uncommitted edit\n");
    assert.equal((await repairCodeLifecycle(f.root, onBranch, f.evidence, "fixed")).source, "unchanged");
    f.git("checkout", "-f", "main");
    assert.equal((await repairCodeLifecycle(f.root, onBranch, f.evidence, "fixed")).source, "unchanged", "checking out main changes nothing");
    const noBranch = await repairCodeLifecycle(f.root, f.finding, f.evidence, "fixed");
    assert.equal(noBranch.source, "unknown");
    assert.match(noBranch.reasons.join(" "), /names no branch/);
  } finally { discard(f.root); }
});

test("K8: an open pull request's finding judges its repair's source against the PR's linked head branch", async () => {
  const f = fixture(); try {
    const onPr = { ...f.finding, pr: "12" } as SharedFinding;
    assert.equal((await repairCodeLifecycle(f.root, onPr, f.evidence, "fixed")).source, "unknown", "no link, nothing to judge");
    writeLocalLink(f.root, "12", "repair");
    const open = await repairCodeLifecycle(f.root, onPr, f.evidence, "fixed");
    assert.equal(open.landing, "open"); assert.equal(open.source, "unchanged", open.reasons.join("; "));
    writeFileSync(join(f.root, "guard.js"), "export const guard = x => x;\n");
    f.git("commit", "-qam", "the PR undoes the guard");
    assert.equal((await repairCodeLifecycle(f.root, onPr, f.evidence, "fixed")).source, "moved");
    f.git("branch", "renamed", "main"); writeLocalLink(f.root, "12", "renamed");
    assert.equal((await repairCodeLifecycle(f.root, onPr, f.evidence, "fixed")).source, "unknown", "two linked tips judge nothing");
  } finally { discard(f.root); }
});

test("default source drift is visible even with unchanged verified branch workspace", async () => {
  const f = fixture(); try {
    f.git("checkout", "main"); f.git("merge", "repair");
    writeFileSync(join(f.root, "guard.js"), "export const guard = x => x;\n");
    f.git("add", "."); f.git("commit", "-m", "later regression");
    f.git("checkout", "repair");
    const view = await repairCodeLifecycle(f.root, { ...f.finding, branch: "repair" } as SharedFinding, f.evidence, "fixed");
    assert.equal(view.source, "unchanged"); assert.equal(view.landing, "landed"); assert.equal(view.defaultSource, "moved");
    assert.match(view.reasons.join(" "), /default branch source moved/);
  } finally { discard(f.root); }
});
test("inspection on exact existing source supplies boundary without diff or anchor", async () => {
  const f = fixture(); try {
    const evidence = { ...f.evidence, baseCommit: f.fix, inspected: [{ source: "guard.js", commit: f.fix, reasoning: "negative input returns zero" }] };
    const view = await repairCodeLifecycle(f.root, { ...f.finding, branch: "repair", target: {kind: "node", id: "n"} }, evidence, "fixed");
    assert.equal(view.source, "unchanged"); assert.deepEqual(view.files, ["guard.js"]);
    const opaque = await repairCodeLifecycle(f.root, f.finding, { ...evidence, inspected: [{source:"guard inspection narrative",commit:f.fix,reasoning:"read"}] }, "fixed");
    assert.equal(opaque.source, "unknown");
  } finally { discard(f.root); }
});

test("negative ancestry in shallow history is unknown, and deepening supplies the missing landing proof", async () => {
  const f = fixture(); const clone = `${f.root}-shallow`;
  try {
    f.git("checkout", "main"); f.git("merge", "repair");
    writeFileSync(join(f.root, "middle.txt"), "intermediate history\n"); f.git("add", "."); f.git("commit", "-m", "middle");
    writeFileSync(join(f.root, "guard.js"), "export const guard = x => x;\n"); f.git("add", "."); f.git("commit", "-m", "regression");
    const git = (...args: string[]) => {
      const out = spawnSync("git", args, { cwd: clone, encoding: "utf8" });
      assert.equal(out.status, 0, out.stderr); return out.stdout.trim();
    };
    const cloned = spawnSync("git", ["clone", "--depth", "1", `file://${f.root}`, clone], { encoding: "utf8" });
    assert.equal(cloned.status, 0, cloned.stderr);
    git("fetch", "--depth", "1", "origin", "repair:refs/heads/repair");
    git("fetch", "--depth", "1", "origin", f.base);
    assert.equal(git("rev-parse", "--is-shallow-repository"), "true");
    const hidden = await repairCodeLifecycle(clone, f.finding, f.evidence, "fixed");
    assert.equal(hidden.landing, "unknown", "present objects do not prove missing ancestry");
    git("fetch", "--unshallow", "origin");
    const proven = await repairCodeLifecycle(clone, f.finding, f.evidence, "fixed");
    assert.equal(proven.landing, "landed"); assert.equal(proven.defaultSource, "moved");
  } finally { discard(clone); discard(f.root); }
});

// Skipped on Windows: the fake `gh` is a shebang script on a `:`-joined PATH.
test("linked PR fallback proves the exact repair and default ancestry, never an older or stacked merge", { skip: process.platform === "win32" }, async () => {
  const f = fixture(); const bin = mkdtempSync(join(tmpdir(), "codemap-repair-gh-")); const oldPath = process.env.PATH;
  try {
    f.git("remote", "add", "origin", "https://github.com/test/repair-lifecycle.git");
    writeLocalLink(f.root, "12", "repair");
    const finding = { ...f.finding, pr: "branch:repair", branch: "repair" };
    const metadata = join(bin, "meta.json");
    writeFileSync(join(bin, "gh"), `#!/bin/sh\ncat '${metadata}'\n`); chmodSync(join(bin, "gh"), 0o755);
    process.env.PATH = `${bin}:${oldPath}`;
    const meta = (head: string, merge: string) => writeFileSync(metadata, JSON.stringify({ state: "MERGED", headRefOid: head, mergeCommit: { oid: merge } }));
    meta(f.base, f.base);
    assert.equal((await repairCodeLifecycle(f.root, finding, f.evidence, "fixed")).landing, "open", "a merge predating the repair proves nothing");
    f.git("checkout", "main");
    writeFileSync(join(f.root, "unrelated.txt"), "advance default\n"); f.git("add", "."); f.git("commit", "-m", "advance default");
    meta(f.fix, f.fix);
    assert.equal((await repairCodeLifecycle(f.root, finding, f.evidence, "fixed")).landing, "open", "MERGED into a feature branch is not default landing");
    f.git("merge", "--squash", "repair"); f.git("commit", "-m", "squash repair"); const merged = f.git("rev-parse", "HEAD");
    writeFileSync(join(f.root, "guard.js"), "export const guard = x => x;\n"); f.git("add", "."); f.git("commit", "-m", "later regression");
    meta(f.fix, merged);
    const landed = await repairCodeLifecycle(f.root, finding, f.evidence, "fixed");
    assert.equal(landed.landing, "landed"); assert.equal(landed.defaultSource, "moved"); assert.equal(landed.checkedCommit, f.fix);
    f.git("checkout", "repair"); writeFileSync(join(f.root, "guard.js"), "export const guard = x => Math.max(1,x);\n");
    f.git("add", "."); f.git("commit", "-m", "later unmerged repair");
    assert.equal((await repairCodeLifecycle(f.root, finding, { ...f.evidence, fixCommit: f.git("rev-parse", "HEAD") }, "fixed")).landing, "open", "the same branch link cannot close a newer repair");
    const changedHead = f.git("rev-parse", "HEAD");
    f.git("checkout", "main"); writeFileSync(join(f.root, "unrelated.txt"), "another default tip\n");
    f.git("add", "."); f.git("commit", "-m", "advance again"); meta(changedHead, merged);
    assert.equal((await repairCodeLifecycle(f.root, finding, f.evidence, "fixed")).landing, "open", "changed PR head source cannot inherit verification of its earlier commit");
    writeLocalLink(f.root, "13", "missing"); writeFileSync(metadata, "unavailable metadata");
    assert.equal((await repairCodeLifecycle(f.root, { ...finding, pr: "branch:missing" }, f.evidence, "fixed")).landing, "open", "failed lookup keeps negative ancestry");
  } finally { process.env.PATH = oldPath; discard(bin); discard(f.root); }
});
