#!/usr/bin/env node
// What the team sees, before and after the migration (plan 7.3): every scope folded by e40e9e3's
// build over the ORIGINAL shards and by this build over the MIGRATED sidecar, and each difference
// printed by path. Every difference must trace to an event the migration dropped (its report) or
// a concurrency hold the linear log deleted (the plan's phase-1 inventory).
//
//   node scripts/migration-diff.mjs <original> <migrated> --old-build <dist of e40e9e3> [--new-build <dist>] [--json <file>]
import { writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const argv = process.argv.slice(2);
const flag = (n) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : undefined; };
const [original, migrated] = argv.filter((a, i) => !a.startsWith("--") && !["--old-build", "--new-build", "--json"].includes(argv[i - 1]));
const oldBuild = flag("--old-build"), newBuild = resolve(flag("--new-build") ?? "dist");
if (!original || !migrated || !oldBuild) {
  console.error("usage: node scripts/migration-diff.mjs <original> <migrated> --old-build <dist of e40e9e3> [--new-build <dist>] [--json <file>]");
  process.exit(2);
}
const load = (build, m) => import(pathToFileURL(join(build, m)).href);

const FAMILIES = [
  ["findings/", "shared-findings.js", "foldFindings"], ["bugs/", "shared-bugs.js", "foldBugs"],
  ["notes/", "shared-notes.js", "foldNotes"], ["docs/", "shared-docs.js", "foldDocs"],
  ["triage/", "shared-triage.js", "foldTriage"], ["graph/", "shared-graph.js", "foldGraph"],
  ["reviews/", "shared-reviews.js", "foldReviewLinks"], ["walkthrough/", "shared-walkthrough.js", "foldWalkthroughs"],
  ["decisions/", "shared-decisions.js", "foldDecisions"],
];

/** A stable plain value for any folded result: Maps and Sets sorted, so two equal folds print equal. */
const stable = (v) => {
  if (v instanceof Map) return Object.fromEntries([...v.entries()].map(([k, x]) => [String(k), stable(x)]).sort((a, b) => a[0].localeCompare(b[0])));
  if (v instanceof Set) return [...v].map(stable).map((x) => JSON.stringify(x)).sort().map((x) => JSON.parse(x));
  if (Array.isArray(v)) return v.map(stable);
  if (v && typeof v === "object") return Object.fromEntries(Object.keys(v).sort().map((k) => [k, stable(v[k])]));
  return v;
};
function diff(a, b, path, out) {
  if (out.length > 200) return;
  if (JSON.stringify(a) === JSON.stringify(b)) return;
  if (a && b && typeof a === "object" && typeof b === "object" && !Array.isArray(a) === !Array.isArray(b)) {
    for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) diff(a[k], b[k], `${path}.${k}`, out);
    return;
  }
  out.push({ path, before: JSON.stringify(a)?.slice(0, 160), after: JSON.stringify(b)?.slice(0, 160) });
}

const oldLog = await load(oldBuild, "eventlog.js"), newLog = await load(newBuild, "eventlog.js");
const scopes = (await oldLog.scopesOnDisk(original)).filter((s) => s !== "linear-log");
const report = [];
for (const scope of scopes) {
  const fam = FAMILIES.find(([p]) => scope.startsWith(p));
  let before, after;
  if (fam) {
    const [, mod, fn] = fam;
    before = stable((await load(oldBuild, mod))[fn](await oldLog.readScope(original, scope)));
    after = stable((await load(newBuild, mod))[fn](await newLog.readScope(migrated, scope)));
  } else if (scope.startsWith("standard/") || scope.startsWith("law/")) {
    const law = "law/standard";
    const pair = scope === law ? [law] : [law, scope];
    const read = async (log, root) => log.sortEvents((await Promise.all(pair.map((s) => log.readScope(root, s)))).flat());
    before = stable((await load(oldBuild, "shared-standard.js")).foldStandard(await read(oldLog, original)));
    after = stable((await load(newBuild, "shared-standard.js")).foldStandard(await read(newLog, migrated)));
  } else continue;
  const out = [];
  diff(before, after, scope, out);
  if (out.length) report.push({ scope, differences: out });
}
const json = flag("--json");
if (json) writeFileSync(json, JSON.stringify(report, null, 2) + "\n");
console.log(`${scopes.length} scopes compared; ${report.length} differ.`);
for (const r of report) {
  console.log(`\n${r.scope}`);
  for (const d of r.differences.slice(0, 12)) console.log(`  ${d.path}\n    before: ${d.before}\n    after:  ${d.after}`);
  if (r.differences.length > 12) console.log(`  … ${r.differences.length - 12} more`);
}
