#!/usr/bin/env node
// Migrate a sidecar to the linear log (plan 2026-09-30-online-only-sync, 7.1).
//
//   node scripts/migrate-sidecar.mjs <sidecar> --old-build <dist of e40e9e3> [--new-build <dist>]
//        [--report <file.json>] [--apply] [--no-tripwire]
//
// Without --apply it only reports. With it, it rewrites the sidecar's working tree and COMMITS
// locally; it never pushes — pushing is the owner's step (docs/sidecar-migration.md).
//
// 1. Refuses a sidecar with uncommitted changes, or local commits its remote does not have.
// 2. Orders every event by e40e9e3's fold: each scope in that build's `sortEvents` order, and
//    one global order from that build's `sortEvents` over all scopes together (the same
//    algorithm its merged folds used for law + evidence).
// 3. Applies the owner's gate rulings: `graph.published` events whose source node is an analyzer
//    node are dropped (owner, Q2: "Drop them").
// 4. Judges the result with THIS build's READ — `judgeReads`, what `scanSidecar` runs: classification,
//    each event against the log before it, cross-scope references (round 2 C6) — with `seq`
//    assigned, and drops what it reports as damage, repeating until nothing more drops (a dropped
//    event can orphan a later one). Anything it reports as NEWER by what it IS — an unknown kind, an
//    unread envelope field, a higher protocol or schema — fails the migration: this build cannot
//    judge it. One newer only by its SHAPE is dropped like damage: on a live log a wrong shape can
//    only be a newer writer's, but nothing newer than this build wrote a log from before the linear
//    one, so here it is an old build's malformed event (round 1's 7.3 report dropped the same ones).
//    A fold defect (valid when written, refused over the whole log) is kept.
//
// It refuses outright a shard holding a line that does not parse, a torn last line included
// (round 2 C7): the old build's read skips such lines, and step 5 deletes the shard.
// 5. Writes each scope as one `events.ndjson`, removes the per-writer shards, writes the tripwire and
//    the sentinel manifest (a fresh clone's tripwire; eventlog.ts).
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const argv = process.argv.slice(2);
const flag = (name) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };
const root = argv.find((a, i) => !a.startsWith("--") && !["--old-build", "--new-build", "--report"].includes(argv[i - 1]));
const oldBuild = flag("--old-build");
const newBuild = resolve(flag("--new-build") ?? "dist");
const apply = argv.includes("--apply"), tripwire = !argv.includes("--no-tripwire");
if (!root || !oldBuild) {
  console.error("usage: node scripts/migrate-sidecar.mjs <sidecar> --old-build <dist of e40e9e3> [--new-build <dist>] [--report <file>] [--apply] [--no-tripwire]");
  process.exit(2);
}
const git = (...a) => spawnSync("git", a, { cwd: root, encoding: "utf8" });
const load = (build, mod) => import(pathToFileURL(join(build, mod)).href);

// --- 1. a clean, published clone only ----------------------------------------------------------
if (existsSync(join(root, ".git"))) {
  const dirty = git("status", "--porcelain").stdout.trim();
  if (dirty) { console.error(`refusing: the sidecar has uncommitted changes:\n${dirty}`); process.exit(1); }
  const upstream = git("rev-parse", "--verify", "--quiet", "@{u}").stdout.trim();
  if (upstream && git("rev-list", "--count", `${upstream}..HEAD`).stdout.trim() !== "0") {
    console.error("refusing: the sidecar has local commits its remote does not have — sync with the current build first");
    process.exit(1);
  }
}

// --- 2. e40e9e3's order -------------------------------------------------------------------------
const old = await load(oldBuild, "eventlog.js");
const scopes = (await old.scopesOnDisk(root)).filter((s) => s !== "linear-log");
// Every line must parse before anything is read through a reader that skips what does not: the
// shards are deleted at the end, and an event that is not read is an event destroyed.
const unreadable = [];
for (const s of scopes) {
  for (const f of readdirSync(join(root, s)).filter((n) => n.endsWith(".ndjson")).sort()) {
    readFileSync(join(root, s, f), "utf8").split("\n").forEach((line, i) => {
      if (!line.trim()) return;
      let e;
      try { e = JSON.parse(line); } catch { unreadable.push(`${s}/${f}:${i + 1} is not JSON`); return; }
      if (!e || typeof e.id !== "string" || typeof e.kind !== "string") unreadable.push(`${s}/${f}:${i + 1} is not an event`);
    });
  }
}
if (unreadable.length) {
  console.error(`refusing: ${unreadable.length} line(s) in this sidecar cannot be read, and migrating would delete them:\n  `
    + unreadable.slice(0, 20).join("\n  ") + "\nRepair them first: see docs/log-repair.md.");
  process.exit(1);
}
const byScope = new Map();
for (const s of scopes) byScope.set(s, await old.readScope(root, s));
const scopeOf = new Map();
for (const [s, evs] of byScope) for (const e of evs) scopeOf.set(e.id, s);
const global = old.sortEvents([...byScope.values()].flat());

// --- 3. the owner's rulings ---------------------------------------------------------------------
const { isAnalyzerNodeId } = await load(newBuild, "analyzers/node-ids.js");
const dropped = [];
let kept = global.filter((e) => {
  if (e.kind === "graph.published" && typeof (e.data?.nodeId ?? e.subject) === "string" && isAnalyzerNodeId(e.data?.nodeId ?? e.subject)) {
    dropped.push({ id: e.id, kind: e.kind, scope: scopeOf.get(e.id), why: "owner Q2: an analyzer node's wiring is not published" });
    return false;
  }
  return true;
});

// --- 4. validate with this build, until nothing more drops ---------------------------------------
await load(newBuild, "families.js");
const { judgeReads } = await load(newBuild, "damage-scan.js");
const newLog = await load(newBuild, "eventlog.js");
const { splice } = await load(newBuild, "migration-splice.js");

const withSeq = (events) => splice(global, events, new Set(dropped.map((d) => d.id))).map((e, i) => ({ ...e, seq: i + 1 }));
/** The read's judgment of the log as it would be written: every damaged entry, newer and fold defect. */
async function judged(events) {
  const reads = new Map(scopes.map((s) => [s, { events: [], malformed: [] }]));
  for (const e of events) reads.get(scopeOf.get(e.id)).events.push(e);
  return judgeReads(reads, false, true);
}
let defects = [];
for (let pass = 0; pass < 1000; pass++) {
  const j = await judged(withSeq(kept));
  const newer = j.newer.filter((n) => n.cls !== "shape");
  if (newer.length) {
    console.error(`refusing: ${newer.length} event(s) are newer than this build, which therefore cannot judge them:\n  `
      + newer.slice(0, 20).map((n) => `${n.kind} ${n.id} in ${n.scope}: ${n.why}`).join("\n  ") + "\nMigrate with a build that reads them.");
    process.exit(1);
  }
  defects = j.defects;
  const bad = new Map([...j.damage, ...j.newer.map((n) => ({ ...n, why: `shape: ${n.why}` }))].map((d) => [d.id, d]));
  if (!bad.size) break;
  if (!kept.some((e) => bad.has(e.id))) {
    console.error(`refusing: the read reports damage it cannot attribute to one event: ${j.damage.map((d) => `${d.id}: ${d.why}`).join("; ")}`);
    process.exit(1);
  }
  for (const [id, d] of bad) dropped.push({ id, kind: kept.find((e) => e.id === id)?.kind ?? d.kind, scope: scopeOf.get(id) ?? d.scope, why: d.why, pass });
  kept = kept.filter((e) => !bad.has(e.id));
}
const migrated = withSeq(kept);

// --- 5. write -----------------------------------------------------------------------------------
const report = {
  sidecar: resolve(root), oldBuild: resolve(oldBuild), newBuild, applied: apply, tripwire,
  scopes: scopes.length, eventsBefore: global.length, eventsAfter: migrated.length,
  dropped, foldDefects: defects, perScope: scopes.map((s) => ({ scope: s, before: byScope.get(s).length, after: migrated.filter((e) => scopeOf.get(e.id) === s).length })),
};
if (apply) {
  for (const s of scopes) {
    const dir = join(root, s);
    for (const f of readdirSync(dir)) if (f.endsWith(".ndjson")) rmSync(join(dir, f));
    const lines = migrated.filter((e) => scopeOf.get(e.id) === s).map((e) => JSON.stringify(e));
    if (lines.length) writeFileSync(join(dir, newLog.LINEAR_SHARD), lines.join("\n") + "\n");
  }
  if (tripwire) {
    mkdirSync(join(root, "linear-log"), { recursive: true });
    writeFileSync(join(root, newLog.TRIPWIRE_PATH), newLog.TRIPWIRE_BYTES);
    mkdirSync(join(root, "manifests"), { recursive: true });
    writeFileSync(join(root, newLog.SENTINEL_MANIFEST_PATH), newLog.SENTINEL_MANIFEST_BYTES);
  }
  writeFileSync(join(root, newLog.SIDECAR_ATTRIBUTES_PATH), newLog.SIDECAR_ATTRIBUTES);
  if (existsSync(join(root, ".git"))) {
    git("add", "-A");
    const c = git("-c", "user.name=codemap", "-c", "user.email=codemap@localhost", "commit", "-q", "-m",
      `codemap: migrate to the linear log (${migrated.length} events, ${dropped.length} dropped)`);
    if (c.status !== 0) { console.error(`the commit failed: ${c.stderr}`); process.exit(1); }
    report.commit = git("rev-parse", "HEAD").stdout.trim();
  }
}
const out = flag("--report");
if (out) writeFileSync(out, JSON.stringify(report, null, 2) + "\n");
console.log(JSON.stringify({ ...report, dropped: report.dropped.length, perScope: undefined }, null, 2));
if (report.dropped.length) {
  const byWhy = new Map();
  for (const d of report.dropped) byWhy.set(`${d.kind} — ${d.why}`, (byWhy.get(`${d.kind} — ${d.why}`) ?? 0) + 1);
  console.log("dropped, by reason:");
  for (const [why, n] of [...byWhy].sort((a, b) => b[1] - a[1])) console.log(`  ${n}× ${why}`);
}
