import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { migrateLocalFindings } from "./findings-migrate.js";
import { readAnnotations, writeAnnotations, readFindings, readFinding } from "./store.js";
import type { Annotation } from "./schema.js";

/**
 * The migration rewrites `meta.annotations` and the findings it removes exist only as
 * the rows it just wrote, so what is asserted here is the order of operations as much
 * as the mapping: nothing leaves the blob that is not already readable as a row.
 */

const repo = () => {
  const root = mkdtempSync(join(tmpdir(), "codemap-mig-"));
  spawnSync("git", ["init", "-q", "-b", "main"], { cwd: root });
  mkdirSync(join(root, ".codemap"), { recursive: true });
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) };
};

const ann = (over: Partial<Annotation> & { id: string }): Annotation => ({
  target: { kind: "anchor", id: "a_1" },
  text: "the evidence", kind: "finding", author: "agent", createdCommit: null,
  resolved: false, revisions: [], ...over,
} as Annotation);

const posted = (pr: number, at = "2026-08-19T19:17:02.437Z") =>
  ({ pr, at, placement: "inline" as const, url: `https://github.com/o/r/pull/${pr}#x` });

test("a finding posted to a pull request moves under that pull request", async () => {
  const r = repo();
  try {
    await writeAnnotations(r.root, [
      ann({ id: "finding_a", comment: "the ask", severity: "high", category: "Logic", postedRef: posted(264) }),
    ]);
    const out = await migrateLocalFindings(r.root);
    assert.deepEqual(out.moved, [{ id: "finding_a", pr: "264" }]);

    const f = (await readFinding(r.root, "finding_a", { pr: 264 }))!;
    assert.equal(f.pr, "264", "the pull request is stored, not inferred");
    assert.equal(f.origin, undefined, "a local row — publishing stays a separate act");
    assert.equal(f.comment, "the ask");
    assert.equal(f.severity, "high");
    assert.equal(f.createdAt, "2026-08-19T19:17:02.437Z", "a recorded time, not the migration's");
    assert.equal(out.stampedNow, 0);
    // And it has LEFT the blob: two copies of one finding is what this ends.
    assert.equal((await readAnnotations(r.root)).annotations.length, 0);
  } finally { r.cleanup(); }
});

test("a finding with no recorded pull request is reported, never guessed", async () => {
  const r = repo();
  try {
    await writeAnnotations(r.root, [
      ann({ id: "finding_open", comment: "still open" }),
      ann({ id: "finding_done", comment: "closed out", resolved: true }),
    ]);
    const out = await migrateLocalFindings(r.root);
    assert.deepEqual(out.moved, [], "nothing is placed on a guess");
    assert.equal(out.unplaced.length, 2);
    assert.deepEqual(out.unplaced.map((u) => [u.id, u.open]), [["finding_open", true], ["finding_done", false]],
      "open ones are flagged, because those are the ones worth a person's time");
    // Untouched: an annotation the migration could not place must still be there.
    assert.equal((await readAnnotations(r.root)).annotations.length, 2);
  } finally { r.cleanup(); }
});

test("a person can place one by hand, and only then does it move", async () => {
  const r = repo();
  try {
    await writeAnnotations(r.root, [ann({ id: "finding_x", comment: "about PR 900" })]);
    const out = await migrateLocalFindings(r.root, { assign: { finding_x: 900 } });
    assert.deepEqual(out.moved, [{ id: "finding_x", pr: "900" }]);
    assert.equal((await readFinding(r.root, "finding_x", { pr: 900 }))!.pr, "900");
  } finally { r.cleanup(); }
});

test("a dry run moves nothing and removes nothing", async () => {
  const r = repo();
  try {
    await writeAnnotations(r.root, [ann({ id: "finding_a", postedRef: posted(264) })]);
    const out = await migrateLocalFindings(r.root, { dryRun: true });
    assert.equal(out.moved.length, 1, "it still says what would happen");
    assert.equal((await readFindings(r.root)).findings.length, 0, "but wrote no row");
    assert.equal((await readAnnotations(r.root)).annotations.length, 1, "and removed no annotation");
  } finally { r.cleanup(); }
});

test("running it twice is a no-op, so re-running is how you check", async () => {
  const r = repo();
  try {
    await writeAnnotations(r.root, [ann({ id: "finding_a", postedRef: posted(264) })]);
    await migrateLocalFindings(r.root);
    const again = await migrateLocalFindings(r.root);
    assert.deepEqual(again.moved, []);
    assert.equal((await readFindings(r.root, { pr: 264 })).findings.length, 1, "still exactly one row");
  } finally { r.cleanup(); }
});

test("state comes from the annotation's own fields, not from a default", async () => {
  const r = repo();
  try {
    await writeAnnotations(r.root, [
      ann({ id: "f_w", postedRef: posted(1), withdrawn: { at: "2026-01-01T00:00:00Z", by: "izzie" } }),
      ann({ id: "f_r", postedRef: posted(2), resolved: true }),
      ann({ id: "f_x", postedRef: posted(3), disposition: "refuted" }),
      ann({ id: "f_h", postedRef: posted(4), actor: { principal: "izzie@x.com" } }),
      ann({ id: "f_a", postedRef: posted(5), actor: { principal: "izzie@x.com", via: { kind: "agent" } } }),
    ]);
    await migrateLocalFindings(r.root);
    const state = async (id: string, pr: number) => (await readFinding(r.root, id, { pr }))!.state;
    assert.equal(await state("f_w", 1), "withdrawn");
    assert.equal(await state("f_r", 2), "resolved");
    assert.equal(await state("f_x", 3), "refuted");
    assert.equal(await state("f_h", 4), "created", "a person's finding is an assertion");
    assert.equal(await state("f_a", 5), "issued", "an agent's is a proposal");
  } finally { r.cleanup(); }
});

test("a finding with no timestamp anywhere is stamped now, and counted for saying so", async () => {
  const r = repo();
  try {
    await writeAnnotations(r.root, [ann({ id: "finding_a", postedRef: { pr: 264, placement: "body" } as never })]);
    const out = await migrateLocalFindings(r.root);
    assert.equal(out.stampedNow, 1, "a made-up createdAt nobody flagged is how a backfill starts lying");
  } finally { r.cleanup(); }
});

test("notes, questions and pointers stay annotations", async () => {
  const r = repo();
  try {
    await writeAnnotations(r.root, [
      ann({ id: "finding_a", postedRef: posted(264) }),
      ann({ id: "q1", kind: "question", text: "is this idempotent?" }),
      ann({ id: "p1", kind: "pointer", text: "watch the tenant scope here" }),
      ann({ id: "n1", kind: "note", text: "worth knowing" }),
    ]);
    await migrateLocalFindings(r.root);
    const left = (await readAnnotations(r.root)).annotations.map((a) => a.id).sort();
    assert.deepEqual(left, ["n1", "p1", "q1"], "only findings move — the split that is load-bearing stays");
  } finally { r.cleanup(); }
});
