/**
 * The backlog reflects the DEFAULT BRANCH, not the checkout (owner, triage
 * 2026-09-19-deletion-fixes-review Q9-Q11): a finding live on the default branch is debt;
 * otherwise it is in review, or needs revalidation when its citations no longer match — an
 * unmerged one compared at its change's CURRENT head. In-review findings are listed, not
 * counted in `attention`. The working tree is never consulted.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { reportDefect } from "./ops/defect.js";
import { init, backlogOn } from "./ops.js";
import { findingBacklog } from "./ops-shared.js";
import { discard } from "./test-tmp.js";

const PAY = (t: string) => [
  "export function transfer(cents: number) {", `  return ${t};`, "}", "",
  "export function refund(cents: number) {", "  return -cents;", "}", "",
].join("\n");

/** main holds `transfer`/`refund`; `feature` rewrites `transfer`'s body. No origin: the trunk is `main`. */
async function repo() {
  const base = mkdtempSync(join(tmpdir(), "codemap-backlog-trunk-"));
  const root = join(base, "repo");
  mkdirSync(join(root, "src"), { recursive: true });
  mkdirSync(join(root, ".codemap"), { recursive: true });
  const git = (...a: string[]) => {
    const r = spawnSync("git", ["-c", "user.email=izzie@x.com", "-c", "user.name=izzie", ...a], { cwd: root, encoding: "utf8" });
    if (r.status !== 0) throw new Error(`git ${a.join(" ")}: ${r.stderr}`);
    return r.stdout.trim();
  };
  git("init", "-q", "-b", "main");
  writeFileSync(join(root, "src/pay.ts"), PAY("cents"));
  writeFileSync(join(root, ".gitignore"), ".codemap/\n");
  git("add", "-A"); git("commit", "-q", "-m", "main");
  git("checkout", "-q", "-b", "feature");
  writeFileSync(join(root, "src/pay.ts"), PAY("cents * 2"));
  git("commit", "-q", "-am", "double it");
  git("checkout", "-q", "main");
  await init(root);
  return { root, git, cleanup: () => discard(base) };
}

const file = async (root: string, branch: string, target: string) => {
  const r = await reportDefect(root, {
    context: { kind: "branch", branch }, targetKind: "anchor", targetId: target,
    text: "the evidence", comment: "wrong", severity: "medium",
  }) as Record<string, unknown>;
  assert.equal(r.error, undefined, String(r.error));
  return String(r.id);
};

type Listing = Awaited<ReturnType<typeof findingBacklog>>;
const listing = () => ({ asOf: "2026-09-19" });
const bucketOf = (b: Listing, id: string) =>
  (["due", "woken", "sleeping", "live", "moved", "unjudgeable", "inReview"] as const).find((k) => (b[k] as { id: string }[]).some((r) => r.id === id));

test("an unmerged finding whose head still holds the witnessed body is in review, not moved, on a trunk checkout", async () => {
  const u = await repo();
  try {
    const id = await file(u.root, "feature", "src/pay.ts#transfer");
    const b = await findingBacklog(u.root, listing());
    assert.equal(bucketOf(b, id), "inReview");
    assert.equal(b.attention, 0, "in review is owed on its PR page, not here (Q11)");
  } finally { u.cleanup(); }
});

test("an unmerged finding whose change's head has since rewritten the cited body needs revalidation", async () => {
  const u = await repo();
  try {
    const id = await file(u.root, "feature", "src/pay.ts#transfer");
    u.git("checkout", "-q", "feature");
    writeFileSync(join(u.root, "src/pay.ts"), PAY("cents * 3"));
    u.git("commit", "-q", "-am", "triple it");
    u.git("checkout", "-q", "main");
    assert.equal(bucketOf(await findingBacklog(u.root, listing()), id), "moved");
  } finally { u.cleanup(); }
});

test("a finding on trunk code is debt, and an uncommitted local edit to it changes nothing", async () => {
  const u = await repo();
  try {
    // Code the branch did not touch is on the trunk already: landed at filing (branch-round Q9).
    const id = await file(u.root, "feature", "src/pay.ts#refund");
    writeFileSync(join(u.root, "src/pay.ts"), PAY("cents").replace("return -cents", "return 0 - cents"));
    const b = await findingBacklog(u.root, listing());
    assert.equal(bucketOf(b, id), "live");
    assert.equal(b.attention, 1);
  } finally { u.cleanup(); }
});

test("a landed finding whose code the default branch then changed needs revalidation", async () => {
  const u = await repo();
  try {
    const id = await file(u.root, "feature", "src/pay.ts#refund");
    writeFileSync(join(u.root, "src/pay.ts"), PAY("cents").replace("return -cents", "return 0 - cents"));
    u.git("commit", "-q", "-am", "rewrite refund on main");
    assert.equal(bucketOf(await findingBacklog(u.root, listing()), id), "moved");
  } finally { u.cleanup(); }
});

test("backlogging an unmerged finding puts it to sleep; it wakes when its change's head moves the code", async () => {
  const u = await repo();
  try {
    const id = await file(u.root, "feature", "src/pay.ts#transfer");
    const r = await backlogOn(u.root, { id, until: "2099-01-01", reason: "later" }) as Record<string, unknown>;
    assert.equal(r.error, undefined, String(r.error));
    assert.equal(bucketOf(await findingBacklog(u.root, listing()), id), "sleeping", "the witness is taken where it is judged");
    u.git("checkout", "-q", "feature");
    writeFileSync(join(u.root, "src/pay.ts"), PAY("cents * 3"));
    u.git("commit", "-q", "-am", "triple it");
    u.git("checkout", "-q", "main");
    assert.equal(bucketOf(await findingBacklog(u.root, listing()), id), "woken");
  } finally { u.cleanup(); }
});
