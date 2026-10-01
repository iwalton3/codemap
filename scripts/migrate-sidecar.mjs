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
// 4. Validates the result with THIS build's folds, in that order, with `seq` assigned, and drops
//    whatever they refuse — so the migrated log reads clean and never locks — repeating until
//    nothing more drops (a dropped event can orphan a later one).
// 5. Writes each scope as one `events.ndjson`, removes the per-writer shards, writes the tripwire and
//    the sentinel manifest (a fresh clone's tripwire; eventlog.ts).
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
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
for (const m of ["shared-findings.js", "shared-bugs.js", "shared-notes.js", "shared-docs.js", "shared-triage.js",
  "shared-graph.js", "shared-reviews.js", "shared-walkthrough.js"]) await load(newBuild, m);
const { reportFor } = await load(newBuild, "validation.js");
const { foldDecisionsReport } = await load(newBuild, "shared-decisions.js");
const { foldStandardReport, LAW_SCOPE } = await load(newBuild, "shared-standard.js");
const { isLogDamage } = await load(newBuild, "log-damage.js");
const newLog = await load(newBuild, "eventlog.js");
const { splice } = await load(newBuild, "migration-splice.js");

const withSeq = (events) => splice(global, events, new Set(dropped.map((d) => d.id))).map((e, i) => ({ ...e, seq: i + 1 }));
/** Every event this build refuses in the order given, with why: one pass. */
function refusals(events) {
  const out = new Map();
  const groups = new Map();
  for (const e of events) {
    const s = scopeOf.get(e.id);
    if (!groups.has(s)) groups.set(s, []);
    groups.get(s).push(e);
  }
  const halting = (evs, fold) => {
    try { for (const r of fold(evs).refused) out.set(r.id, r.why); }
    catch (err) { if (isLogDamage(err)) out.set(err.entry.id, err.entry.why); else throw err; }
  };
  for (const [s, evs] of groups) {
    if (s.startsWith("decisions/")) { halting(evs, foldDecisionsReport); continue; }
    if (s.startsWith("standard/")) { halting(newLog.sortEvents([...(groups.get(LAW_SCOPE) ?? []), ...evs]), foldStandardReport); continue; }
    if (s === LAW_SCOPE) continue;
    const report = reportFor(s);
    if (report) for (const r of report(evs).refused) out.set(r.id, `${r.cls}: ${r.why}`);
  }
  if (groups.has(LAW_SCOPE) && ![...groups.keys()].some((s) => s.startsWith("standard/"))) halting(groups.get(LAW_SCOPE), foldStandardReport);
  return out;
}
for (let pass = 0; pass < 1000; pass++) {
  const bad = refusals(withSeq(kept));
  if (!bad.size) break;
  for (const [id, why] of bad) dropped.push({ id, kind: kept.find((e) => e.id === id)?.kind, scope: scopeOf.get(id), why, pass });
  kept = kept.filter((e) => !bad.has(e.id));
}
const migrated = withSeq(kept);

// --- 5. write -----------------------------------------------------------------------------------
const report = {
  sidecar: resolve(root), oldBuild: resolve(oldBuild), newBuild, applied: apply, tripwire,
  scopes: scopes.length, eventsBefore: global.length, eventsAfter: migrated.length,
  dropped, perScope: scopes.map((s) => ({ scope: s, before: byScope.get(s).length, after: migrated.filter((e) => scopeOf.get(e.id) === s).length })),
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
