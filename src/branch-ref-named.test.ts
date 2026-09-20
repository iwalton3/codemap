/**
 * `origin/x` is a REQUEST, and the witness follows the ref named (owner, triage
 * 2026-09-19-review-and-findings-systems, Ruling 11).
 *
 * The undocumented assumption behind local-first was that `refs/heads/<name>` is at least
 * as new as `origin/<name>`. When it is not, the consequences were ASYMMETRIC, which is
 * what made this a question rather than an obvious bug: a finding on a symbol only origin
 * has was REFUSED, while one on a symbol both have was accepted and witnessed at the stale
 * local body — so it read as drifted from the moment it was filed.
 *
 * A bare name still resolves local-first, because unpushed commits are the local branch's.
 * The spelling is recorded on the finding: `normalizeBranch` strips `origin/`, so both
 * spellings key to `branch:feature` and share a scope, and nothing else on the row could
 * say which was asked for.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { init } from "./ops.js";
import { reportDefect } from "./ops/defect.js";
import { readFindings } from "./store.js";
import { readSnapshot } from "./snapshots.js";
import { discard } from "./test-tmp.js";

const V = (body: string, extra = "") =>
  `export function transfer(c: number) {\n  return ${body};\n}\n${extra}`;
const REFUND = "export function refund(c: number) {\n  return -c;\n}\n";

/**
 * A clone whose local `feature` is BEHIND `origin/feature`: origin has a later commit
 * that both rewrites `transfer` and adds `refund`. This is an ordinary stale checkout,
 * not a contrived state — it is what any clone looks like before a fetch is merged.
 */
async function behindOrigin() {
  const root = mkdtempSync(join(tmpdir(), "codemap-namedref-"));
  mkdirSync(join(root, "src"), { recursive: true });
  const git = (...a: string[]) => {
    const r = spawnSync("git", ["-c", "user.email=izzie@x.com", "-c", "user.name=izzie", ...a], { cwd: root, encoding: "utf8" });
    if (r.status !== 0) throw new Error(`git ${a.join(" ")}: ${r.stderr}`);
    return r.stdout.trim();
  };
  git("init", "-q", "-b", "main");
  writeFileSync(join(root, ".gitignore"), ".codemap/\n", "utf8");
  writeFileSync(join(root, "src/pay.ts"), V("c"), "utf8");
  git("add", "-A"); git("commit", "-q", "-m", "main");
  git("update-ref", "refs/remotes/origin/main", "HEAD");
  git("checkout", "-q", "-b", "feature");
  writeFileSync(join(root, "src/pay.ts"), V("c * 2"), "utf8");
  git("commit", "-q", "-am", "A — what this clone has");
  const localSha = git("rev-parse", "HEAD");
  writeFileSync(join(root, "src/pay.ts"), V("c * 3", REFUND), "utf8");
  git("commit", "-q", "-am", "B — what a teammate pushed");
  const originSha = git("rev-parse", "HEAD");
  git("update-ref", "refs/remotes/origin/feature", originSha);
  git("reset", "-q", "--hard", localSha);
  git("checkout", "-q", "main");
  await init(root);
  return { root, git, localSha, originSha, cleanup: () => discard(root) };
}

const file = (root: string, branch: string, targetId: string) => reportDefect(root, {
  context: { kind: "branch", branch }, text: "the evidence", comment: "callers still need this",
  targetKind: "anchor", targetId, model: "m", harness: "h",
}) as Promise<Record<string, unknown>>;

const stored = async (root: string, id: string) =>
  (await readFindings(root, {})).findings.find((f) => f.id === id)!;

const bodyAt = async (root: string, sha: string, name: string) =>
  (await readSnapshot(root, sha))!.find((a) => a.symbolPath.at(-1) === name)?.bodyHash;

test("a finding filed on `origin/x` is witnessed at ORIGIN's head, not the stale local one", async () => {
  const u = await behindOrigin();
  try {
    const r = await file(u.root, "origin/feature", "src/pay.ts#transfer");
    assert.equal(r.error, undefined, String(r.error));
    const f = await stored(u.root, String(r.id));
    assert.equal(f.sourceRef, u.originSha, "the ref named is the ref followed");
    assert.equal(f.witness?.bodyHash, await bodyAt(u.root, u.originSha, "transfer"),
      "and the body is origin's — the local one read as drifted from the moment it was filed");
    assert.notEqual(f.witness?.bodyHash, await bodyAt(u.root, u.localSha, "transfer"));
  } finally { u.cleanup(); }
});

test("and the spelling is recorded, because the SCOPE strips it", async () => {
  const u = await behindOrigin();
  try {
    const named = await stored(u.root, String((await file(u.root, "origin/feature", "src/pay.ts#transfer")).id));
    const bare = await stored(u.root, String((await file(u.root, "feature", "src/pay.ts#transfer")).id));
    assert.equal(named.branch, "feature");
    assert.equal(bare.branch, "feature", "both key to the same branch, and the same scope");
    assert.equal(named.namedRef, "origin/feature", "so only this says which was asked for");
    assert.equal(bare.namedRef, undefined);
    assert.notEqual(named.sourceRef, bare.sourceRef, "two spellings, two commits — the honest answer");
  } finally { u.cleanup(); }
});

test("a symbol only ORIGIN has can be filed on `origin/x` — it used to be refused", async () => {
  const u = await behindOrigin();
  try {
    // The asymmetry that made this a question: this half FAILED LOUDLY while the half
    // above failed silently, so the loud one is what people saw and neither got fixed.
    const r = await file(u.root, "origin/feature", "src/pay.ts#refund");
    assert.equal(r.error, undefined, String(r.error));
  } finally { u.cleanup(); }
});

test("a bare branch name is still local-first, so unpushed work is unaffected", async () => {
  const u = await behindOrigin();
  try {
    const f = await stored(u.root, String((await file(u.root, "feature", "src/pay.ts#transfer")).id));
    assert.equal(f.sourceRef, u.localSha, "a bare name means the local branch, ahead or behind");
    assert.equal(f.witness?.bodyHash, await bodyAt(u.root, u.localSha, "transfer"));
  } finally { u.cleanup(); }
});

test("a local branch literally NAMED `origin/x` is not redirected to the remote", async () => {
  const u = await behindOrigin();
  try {
    // `normalizeBranch` keeps a local branch spelled exactly as given, so the stripping
    // never happened and there is no request to follow. Following one anyway would look
    // for `refs/remotes/origin/origin/feature`, which resolves nowhere.
    u.git("branch", "origin/odd", u.localSha);
    const r = await file(u.root, "origin/odd", "src/pay.ts#transfer");
    assert.equal(r.error, undefined, String(r.error));
    const f = await stored(u.root, String(r.id));
    assert.equal(f.branch, "origin/odd", "the local branch, by its real name");
    assert.equal(f.namedRef, undefined, "nothing was stripped, so nothing was requested");
    assert.equal(f.sourceRef, u.localSha);
  } finally { u.cleanup(); }
});
