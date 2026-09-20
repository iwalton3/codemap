/**
 * File Bug on a finding about a DELETION (triage 2026-09-19-deletion-fixes-review Q3, Q7):
 * refused until the deletion lands — before that it is review on its change, and a bug is a
 * trunk defect — and afterwards the bug carries the deletion witness, so "possibly fixed"
 * means the symbol is back. Bug readers judge the working tree, as every bug does (Q7).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { init, reindex } from "./ops.js";
import { reportDefect } from "./ops/defect.js";
import { acceptFinding, listBugs } from "./ops/bugs.js";
import { branchKey } from "./review-target.js";
import { readBugs } from "./store.js";
import { readSnapshot } from "./snapshots.js";
import { foldBugs, witnessesOf } from "./shared-bugs.js";
import type { LogEvent } from "./eventlog.js";
import { discard } from "./test-tmp.js";

const PAY = "export function transfer(c: number) {\n  return c;\n}\n\nexport function refund(c: number) {\n  return -c;\n}\n";

/** main holds `refund`, `feature` deletes it; a sidecar, because a finding is accepted into a SHARED bug. */
async function repo() {
  const base = mkdtempSync(join(tmpdir(), "codemap-delbug-"));
  const root = join(base, "repo");
  const side = join(base, "side");
  mkdirSync(join(root, "src"), { recursive: true });
  mkdirSync(join(root, ".codemap"), { recursive: true });
  mkdirSync(side);
  const git = (...a: string[]) => {
    const r = spawnSync("git", ["-c", "user.email=izzie@x.com", "-c", "user.name=izzie", ...a], { cwd: root, encoding: "utf8" });
    if (r.status !== 0) throw new Error(`git ${a.join(" ")}: ${r.stderr}`);
    return r.stdout.trim();
  };
  git("init", "-q", "-b", "main");
  git("config", "user.email", "izzie@x.com");
  git("config", "user.name", "izzie");
  writeFileSync(join(root, "src/pay.ts"), PAY);
  writeFileSync(join(root, ".gitignore"), ".codemap/\n");
  git("add", "-A"); git("commit", "-q", "-m", "main");
  const baseSha = git("rev-parse", "HEAD");
  git("checkout", "-q", "-b", "feature");
  writeFileSync(join(root, "src/pay.ts"), PAY.split("export function refund")[0]!);
  git("commit", "-q", "-am", "delete refund");
  git("checkout", "-q", "main");
  writeFileSync(join(root, ".codemap", "sidecar"), side);
  await init(root);
  const refund = (await readSnapshot(root, baseSha))!.find((a) => a.symbolPath.at(-1) === "refund")!;
  const f = await reportDefect(root, {
    context: { kind: "branch", branch: "feature" }, targetKind: "anchor", targetId: "src/pay.ts#refund",
    text: "e", comment: "callers still need this", severity: "medium",
  }) as { id: string; error?: string };
  assert.equal(f.error, undefined, String(f.error));
  return { root, git, refund, id: f.id, cleanup: () => discard(base) };
}

test("File Bug on an unmerged deletion finding is refused: it is still review on its change", async () => {
  const u = await repo();
  try {
    const r = await acceptFinding(u.root, branchKey("feature"), u.id) as { error?: string };
    assert.match(String(r.error), /still under review/);
    assert.equal((await readBugs(u.root)).bugs.length, 0);
  } finally { u.cleanup(); }
});

test("once the deletion lands the bug carries it, and reads possibly fixed only when the symbol is back", async () => {
  const u = await repo();
  try {
    u.git("merge", "-q", "--ff-only", "feature");
    const r = await acceptFinding(u.root, branchKey("feature"), u.id) as { error?: string; id?: string };
    assert.equal(r.error, undefined, String(r.error));
    const bug = (await readBugs(u.root)).bugs[0]!;
    assert.equal(bug.anchors.length, 1);
    assert.equal(bug.anchors[0]!.anchorId, u.refund.id);
    assert.equal(bug.anchors[0]!.bodyHash, u.refund.bodyHash);
    assert.equal(bug.anchors[0]!.deleted, true);

    // RE-INDEX, or this asserts through a stale `@work` that still holds the deleted id
    // and never exercises the deletion witness at all. Without it this passed with the
    // read-side file ladder wholly removed (triage 2026-09-19-review-and-findings-systems,
    // I12); `deletion-read-ladder.test.ts` is what covers that ladder directly.
    await reindex(u.root);
    const row = async () => (await listBugs(u.root, {})).bugs.find((b) => b.id === bug.id)!;
    assert.equal((await row()).possiblyFixed, false, "absent is the defect, not a fix");
    writeFileSync(join(u.root, "src/pay.ts"), PAY);
    assert.equal((await row()).possiblyFixed, true, "the symbol came back — re-validate");
  } finally { u.cleanup(); }
});

test("the bugs fold keeps a deletion citation, re-citing a body clears it, and a malformed marker is no citation", () => {
  const actor = { principal: "izzie@x.com" };
  let seq = 0;
  const ev = (kind: string, subject: string, data: Record<string, unknown>) =>
    ({ id: `e${++seq}`, kind, subject, actor, at: `2026-09-19T00:0${seq}:00Z`, data } as unknown as LogEvent);
  const D = { anchorId: "a_1", bodyHash: "h2:aaaa:sha256:bbbb", deleted: true };
  const out = foldBugs([
    ev("bug.filed", "bug_del", { title: "t", text: "x", anchors: [D] }),
    ev("bug.filed", "bug_back", { title: "t", text: "x", anchors: [D] }),
    ev("bug.anchored", "bug_back", { anchors: [{ anchorId: "a_1", bodyHash: "h2:aaaa:sha256:cccc" }] }),
    ev("bug.filed", "bug_bad", { title: "t", text: "x", anchors: [{ ...D, deleted: "yes" }] }),
  ]);
  assert.deepEqual(witnessesOf(out.get("bug_del")!), [D]);
  assert.deepEqual(witnessesOf(out.get("bug_back")!), [{ anchorId: "a_1", bodyHash: "h2:aaaa:sha256:cccc" }],
    "a person re-citing the body says the bug is about that body now");
  assert.deepEqual(out.get("bug_bad")?.anchors ?? [], [], "read as a body it would call the deletion's absence a fix");
});
