import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { State } from "./schema.js";
import { writeStore, readViewedImports, writeViewedImport } from "./store.js";
import { viewedTargetsFor } from "./pr-push.js";

const state: State = { schemaVersion: 1, lastVerifiedCommit: null, branch: null } as State;

test("viewedTargetsFor reads only the changed, reviewable files — never the whole tree", async () => {
  const read: string[][] = [];
  const r = await viewedTargetsFor("/nope", { baseRef: "develop", headSha: "head" }, {
    mergeBase: () => "mb",
    changedFiles: () => ["src/pay.cs", "tests/pay.cs", "gen/x.g.cs", "docs/spec.md"],
    readBlobs: (_r, _s, paths) => { read.push(paths); return new Map(paths.map((p) => [p, "class X {}"])); },
    indexBlob: async (_src, path) => [{ id: "a_" + path, bodyHash: "sha256:" + path }],
    // stand-in lane classifier: only src/ is the review queue
    lane: (p) => (p.startsWith("src/") ? "code" : p.startsWith("tests/") ? "test" : p.endsWith(".md") ? "spec" : "generated"),
  });
  assert.ok(!("error" in r));
  if ("error" in r) return;
  assert.deepEqual(read[0], ["src/pay.cs"], "tests, generated and spec files are never even read");
  assert.deepEqual([...r.byFile.keys()], ["src/pay.cs"]);
  assert.equal(r.byFile.get("src/pay.cs")![0]!.hash, "sha256:src/pay.cs", "the head body is the witness");
});

test("viewedTargetsFor reports a missing merge-base rather than guessing one", async () => {
  const r = await viewedTargetsFor("/nope", { baseRef: "gone", headSha: "head" }, {
    mergeBase: () => null,
    changedFiles: () => [], readBlobs: () => new Map(), indexBlob: async () => [], lane: () => "code",
  });
  assert.ok("error" in r);
});

test("import progress is recorded per PR so a long run resumes instead of restarting", async () => {
  const root = mkdtempSync(join(tmpdir(), "codemap-bulk-"));
  try {
    await writeStore(root, [], state);
    assert.deepEqual((await readViewedImports(root)).imported, {});
    await writeViewedImport(root, "94", 124);
    await writeViewedImport(root, "227", 0);
    const got = (await readViewedImports(root)).imported;
    assert.equal(got["94"]!.marked, 124);
    assert.ok(got["227"], "a PR that yielded nothing is still recorded — otherwise it is retried forever");
  } finally { rmSync(root, { recursive: true, force: true }); }
});
