/**
 * `scripts/migrate-sidecar.mjs` run end to end on a scratch sidecar (round 2 of the online-only
 * sync review: C7, C6). This build stands in for both the old and the new build, as the review's
 * repros did; what is under test is what the script does with what it reads.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { discard } from "./test-tmp.js";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..");
const DIST = join(REPO, "dist");

function migrate(root: string): { status: number | null; stderr: string } {
  const r = spawnSync(process.execPath, [join(REPO, "scripts", "migrate-sidecar.mjs"), root, "--old-build", DIST, "--new-build", DIST, "--apply"],
    { encoding: "utf8" });
  return { status: r.status, stderr: r.stderr };
}

function sidecar(shards: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "codemap-migrate-"));
  for (const [path, text] of Object.entries(shards)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  return root;
}

const legacy = (id: string, kind: string, subject: string, data: Record<string, unknown>) => JSON.stringify({
  id, kind, subject, data, actor: { principal: "alice@x.com" }, at: "2026-09-01T00:00:00Z", after: [],
  writer: "w_legacy", writerPrev: "GENESIS", sidecarProtocol: 2, eventSchema: 1,
});

test("C7: a shard with a line that is not JSON is refused, named, and left in place", () => {
  const root = sidecar({ "decisions/u/w_legacy.ndjson": "not-json\n" });
  try {
    const r = migrate(root);
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /decisions\/u\/w_legacy\.ndjson:1 is not JSON[\s\S]*docs\/log-repair\.md/);
    assert.ok(existsSync(join(root, "decisions/u/w_legacy.ndjson")), "the evidence is not deleted");
  } finally { discard(root); }
});

test("C7: a torn last line counts too", () => {
  const good = legacy("e1", "note.created", "N1", { text: "x" });
  const root = sidecar({ "notes/u/00/w_legacy.ndjson": `${good}\n${good.slice(0, 20)}` });
  try {
    const r = migrate(root);
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /w_legacy\.ndjson:2 is not JSON/);
  } finally { discard(root); }
});

test("C6: an event this build reads as NEWER fails the migration instead of landing in the migrated log", () => {
  const root = sidecar({ "notes/u/00/w_legacy.ndjson": `${legacy("e1", "note.frobbed", "N1", {})}\n` });
  try {
    const r = migrate(root);
    assert.notEqual(r.status, 0, r.stderr);
    assert.match(r.stderr, /newer than this build[\s\S]*note\.frobbed e1/);
  } finally { discard(root); }
});

test("C6: a migrated log whose cross-scope reference precedes its target is not left to lock", async () => {
  // The bug is dropped (the read's own judgment calls it damage); the parent's loop kept it, and the log locked.
  const { createFinding } = await import("./shared-findings.js");
  const { fileBug } = await import("./shared-bugs.js");
  const { scanSidecar } = await import("./damage-scan.js");
  const { readFileSync } = await import("node:fs");
  const src = mkdtempSync(join(tmpdir(), "codemap-migrate-src-"));
  let root = "";
  try {
    const ana = { principal: "ana@x.com" };
    const f = await createFinding(src, "u/pr-1", ana, { targetKind: "anchor", targetId: "a_1", text: "t" });
    await fileBug(src, "u", ana, { title: "b", text: "b", anchors: [], from: { pr: 1, finding: f } });
    // As legacy shards the old build orders scope by scope, `bugs/` first: the bug filed FROM the
    // finding lands before the finding exists, so its reference does not resolve in its prefix.
    const lines = (scope: string) => readFileSync(join(src, scope, "events.ndjson"), "utf8").split("\n").filter(Boolean)
      .map((l) => JSON.parse(l) as Record<string, unknown>);
    const asLegacy = (e: Record<string, unknown>, at: string) => {
      const { seq: _s, ...rest } = e;
      return JSON.stringify({ ...rest, at, after: [], writer: "w_legacy", writerPrev: "GENESIS" });
    };
    const findings = lines("findings/u/pr-1").map((e) => asLegacy(e, "2026-09-01T00:00:00Z"));
    const bugs = lines("bugs/u").map((e) => asLegacy(e, "2026-09-01T00:00:01Z"));
    root = sidecar({ "findings/u/pr-1/w_legacy.ndjson": findings.join("\n") + "\n", "bugs/u/w_legacy.ndjson": bugs.join("\n") + "\n" });
    const r = migrate(root);
    assert.equal(r.status, 0, r.stderr);
    assert.equal((await scanSidecar(root)).damage, null, "the migrated log reads clean");
  } finally { discard(src); if (root) discard(root); }
});

test("C6: an old build's malformed event is dropped like damage, not refused as newer", async () => {
  const { readFileSync } = await import("node:fs");
  const created = legacy("e1", "finding.created", "F1", { text: "t", targetKind: "anchor", targetId: "a_1" });
  const root = sidecar({ "findings/u/pr-1/w_legacy.ndjson": `${created}\n${legacy("e2", "finding.outcome", "F1", {})}\n` });
  try {
    const report = join(root, "..", `${root.split("/").pop()}-report.json`);
    const r = spawnSync(process.execPath, [join(REPO, "scripts", "migrate-sidecar.mjs"), root, "--old-build", DIST, "--new-build", DIST,
      "--report", report], { encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr);
    const dropped = (JSON.parse(readFileSync(report, "utf8")) as { dropped: { id: string; why: string }[] }).dropped;
    assert.deepEqual(dropped.map((d) => d.id), ["e2"]);
    assert.match(dropped[0]!.why, /^shape: /);
    discard(report);
  } finally { discard(root); }
});

test("round 3, I5: an event that depends on a dropped malformed one is judged again, not refused as newer", async () => {
  const { readFileSync } = await import("node:fs");
  const line = (id: string, kind: string, data: Record<string, unknown>, after: string[]) =>
    JSON.stringify({ ...JSON.parse(legacy(id, kind, "F1", data)), after });
  const root = sidecar({ "findings/u/pr-1/w_legacy.ndjson": [
    line("e1", "finding.created", { text: "t", targetKind: "anchor", targetId: "a_1" }, []),
    line("e2", "finding.outcome", {}, ["e1"]),
    // Refused for naming e2, so the read classes it newer — until e2 is gone.
    line("e3", "finding.reopened", { state: "created", observedClosure: "e2" }, ["e2"]),
  ].join("\n") + "\n" });
  try {
    const report = join(root, "..", `${root.split("/").pop()}-report.json`);
    const r = spawnSync(process.execPath, [join(REPO, "scripts", "migrate-sidecar.mjs"), root, "--old-build", DIST, "--new-build", DIST,
      "--report", report], { encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr);
    const dropped = (JSON.parse(readFileSync(report, "utf8")) as { dropped: { id: string; pass: number }[] }).dropped;
    assert.deepEqual(dropped.map((d) => [d.id, d.pass]), [["e2", 0], ["e3", 1]]);
    discard(report);
  } finally { discard(root); }
});
