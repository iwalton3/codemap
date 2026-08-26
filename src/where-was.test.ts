/**
 * Step 1 of recovery: what an anchor id NAMED, at the commit a record points at.
 *
 * The half that can be verified — the answer is an anchor this build minted itself
 * from source at that commit, whose own id is the one asked about. See
 * docs/anchor-id-provenance.md § "Recovery: placing an id nobody can place".
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { indexBlob } from "./repo.js";
import { collidingAnchors } from "./indexer.js";
import { init, whereWas } from "./ops.js";
import { readAnchorStore } from "./store.js";
import { discard } from "./test-tmp.js";

const git = (root: string, ...args: string[]) =>
  spawnSync("git", ["-c", "user.email=t@x", "-c", "user.name=t", ...args], { cwd: root, encoding: "utf8" });

/** A repo with two commits: `transfer` in the first, renamed in the second. */
async function repo() {
  const root = mkdtempSync(join(tmpdir(), "codemap-wherewas-"));
  mkdirSync(join(root, "src"));
  writeFileSync(join(root, "src/pay.ts"), "export function transfer(c: number) { return c; }\n");
  git(root, "init", "-q", "-b", "main");
  git(root, "add", "-A");
  git(root, "commit", "-qm", "first");
  const first = git(root, "rev-parse", "HEAD").stdout.trim();
  await init(root);
  const id = (await readAnchorStore(root)).anchors.find((a) => a.symbolPath.join(".") === "transfer")!.id;

  writeFileSync(join(root, "src/pay.ts"), "export function settle(c: number) { return c; }\n");
  git(root, "commit", "-qam", "renamed");
  await init(root);
  return { root, first, id };
}

test("an id the working tree lost is found at the commit the record names", async () => {
  const { root, first, id } = await repo();
  try {
    assert.equal((await readAnchorStore(root)).anchors.some((a) => a.id === id), false,
      "precondition: the rename took the id out of the live index");

    const w = await whereWas(root, id, first) as any;
    assert.equal(w.at, "found");
    assert.equal(w.file, "src/pay.ts");
    assert.equal(w.symbol, "transfer");
    assert.equal(w.ref, first, "and it answers about THAT commit, not the newest one holding it");
  } finally { discard(root); }
});

test("an id no commit produced is absent there, and says how much it looked at", async () => {
  // The control. Without it, "found" would pass just as well if every id matched.
  const { root, first } = await repo();
  try {
    const w = await whereWas(root, "a_0000000000000000", first) as any;
    assert.equal(w.at, "absent");
    assert.equal(w.ref, first);
    assert.ok(w.indexed > 0, "it really indexed that commit");
  } finally { discard(root); }
});

test("a record with no historical address is told so, not told the code is gone", async () => {
  // `@work` is the live index, not a commit. A finding witnessed there recorded no
  // address at all, and answering `absent` would be an answer to a question nobody
  // asked — the distinction the four shapes exist for.
  const { root, id } = await repo();
  try {
    for (const ref of ["@work", "@orphan", "", undefined]) {
      const w = await whereWas(root, id, ref as string | undefined) as any;
      assert.equal(w.at, "unaddressed", `ref ${JSON.stringify(ref)}`);
      assert.match(w.why, /no commit to ask about/);
    }
    const bad = await whereWas(root, id, "no-such-ref") as any;
    assert.equal(bad.at, "unaddressed");
    assert.match(bad.why, /cannot resolve/);
  } finally { discard(root); }
});

/**
 * Two `partial` declarations of one class in ONE file give their members the same
 * anchor id: a container's disambiguator is not carried into its children's path,
 * and each partial body is a separate scope in which the member is unique. The
 * store is keyed `(ref, id)` and written `INSERT OR REPLACE`, so one of the two
 * methods silently ceases to exist.
 *
 * Latent rather than active — 0 groups in 18,761 anchors across five repositories,
 * because real `partial` classes live in different files and the file is the first
 * field of the digest. Recorded and detectable rather than fixed: carrying the
 * disambiguator down changes ids, which is an `ANCHOR_SCHEME` bump.
 */
test("two symbols that collide on one id are detected rather than silently merged", async () => {
  const src = "partial class C { void M(int x) {} }\npartial class C { void M(string x) {} }\n";
  const anchors = await indexBlob(src, "src/C.cs");
  const dup = collidingAnchors(anchors);
  assert.equal(dup.size, 1, "the collision is real and this is what sees it");
  const both = [...dup.values()][0]!;
  assert.equal(both.length, 2);
  assert.deepEqual(both.map((a) => a.symbolPath.join(".")), ["C.M", "C.M"]);
  assert.notEqual(both[0]!.bodyHash, both[1]!.bodyHash, "two genuinely different methods");
});

test("an ordinary file produces no collisions at all", async () => {
  // The control for the one above: `collidingAnchors` returning a group for
  // everything would satisfy it just as well.
  const src = "class C { m(a: string) {} n(b: number) {} }\nfunction f() {}\n";
  assert.equal(collidingAnchors(await indexBlob(src, "src/ok.ts")).size, 0);
});

/**
 * The property that makes "verify the reader's own candidate" sound. `anchorId`
 * joins its fields with NUL and nothing else, so `["N","C","M"]` with no
 * disambiguator encodes identically to `["N","C"]` with disambiguator `"M"` — a
 * crafted triple can verify against an id it never named.
 *
 * Two real anchors cannot do that, because the alphabets are disjoint: every
 * disambiguator starts with `(` (`signatureKey` always parenthesises) or contains
 * `#` (the ordinal fallback), and no identifier in any supported language can hold
 * either. A grammar added later whose signature key is unparenthesised would reopen
 * it silently, which is why this is a test and not a paragraph.
 */
test("a disambiguator can never be mistaken for a symbol name", async () => {
  const cases: [string, string][] = [
    ["src/S.cs", "class S { void M(ref string a) {} void M(int a) {} void M(string a, int b) {} }"],
    ["src/o.ts", "export function f(a: string): void;\nexport function f(a: number): void;\nexport function f(a: any): void {}"],
    ["src/p.py", "class K:\n    def m(self, a):\n        pass\n    def m(self, a, b):\n        pass\n"],
  ];
  let seen = 0;
  for (const [file, src] of cases) {
    for (const a of await indexBlob(src, file)) {
      for (const seg of a.symbolPath) {
        assert.ok(!seg.startsWith("(") && !seg.includes("#"), `symbol name looks like a disambiguator: ${seg}`);
      }
      if (a.disambiguator !== undefined) {
        seen++;
        assert.ok(a.disambiguator.startsWith("(") || a.disambiguator.includes("#"),
          `disambiguator looks like a symbol name: ${JSON.stringify(a.disambiguator)}`);
      }
    }
  }
  assert.ok(seen >= 2, "the interesting half of this needs overloads to actually appear");
});

test("a reindex that loses a symbol to a colliding id says so", async () => {
  // Reported, not refused: wedging an index over a pattern measured at 0 in 18,761
  // anchors is worse than the loss it names. But it must not be silent — the store
  // is keyed `(ref, id)` and `INSERT OR REPLACE` has already dropped one row.
  const root = mkdtempSync(join(tmpdir(), "codemap-collide-"));
  try {
    mkdirSync(join(root, "src"));
    writeFileSync(join(root, "src/C.cs"), "partial class C { void M(int x) {} }\npartial class C { void M(string x) {} }\n");
    const r = await init(root) as any;
    assert.ok(r.idCollisions, "the reindex reports it");
    assert.equal(r.idCollisions.length, 1);
    assert.equal(r.idCollisions[0].file, "src/C.cs");
    assert.deepEqual(r.idCollisions[0].symbols, ["C \u203a M", "C \u203a M"]);
    // …and the store really did keep only one, which is what makes it worth saying.
    const kept = (await readAnchorStore(root)).anchors.filter((a) => a.symbolPath.join(".") === "C.M");
    assert.equal(kept.length, 1);
  } finally { discard(root); }
});

test("an ordinary reindex says nothing about collisions", async () => {
  const root = mkdtempSync(join(tmpdir(), "codemap-nocollide-"));
  try {
    mkdirSync(join(root, "src"));
    writeFileSync(join(root, "src/pay.ts"), "export function transfer(c: number) { return c; }\n");
    assert.equal((await init(root) as any).idCollisions, undefined, "absent, not an empty list");
  } finally { discard(root); }
});
