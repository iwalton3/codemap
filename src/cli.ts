/**
 * codemap CLI (v1): `init` builds the anchor index; `check` reports staleness.
 */

import { parseArgs } from "node:util";
import { resolve } from "node:path";
import { currentBranch } from "./git.js";
import { readAnchorStore, readState, writeState, loadNodes } from "./store.js";
import { computeStaleness } from "./stale.js";
import { analyzeMarten } from "./analyzers/marten.js";
import { enableAnalyzer, refreshAnalyzers } from "./analyzers/run.js";
import { applyIndexUpdate } from "./sync.js";
import { withLock } from "./lock.js";
import * as ops from "./ops.js";

function usage(): never {
  console.error("Usage:\n  codemap init     [repo]\n  codemap check    [repo]\n  codemap snapshot [repo]              cache the current commit for branch-diff\n  codemap diff <base> [head] [--repo path]   base = branch/tag/sha; omit head = working tree\n  codemap analyze marten [repo] [--verbose] [--emit]");
  process.exit(2);
}

async function cmdAnalyze(analyzer: string, root: string, verbose: boolean, emit: boolean): Promise<void> {
  if (analyzer !== "marten") {
    console.error(`unknown analyzer "${analyzer}" (available: marten)`);
    process.exit(2);
  }
  const r = await analyzeMarten(root, { verbose });
  console.log(JSON.stringify(r.summary));
  for (const f of r.findings) {
    console.log(`  [${f.severity}] ${f.check}: ${f.message}  (${f.file}:${f.line})`);
  }
  if (!r.findings.length) console.log("  no findings");
  if (emit) {
    const e = await enableAnalyzer(root, analyzer);
    if (e.error) console.error(e.error);
    else console.log(`emitted + enabled (auto-refreshes on check): ${JSON.stringify(e.emitted)}`);
  }
}

async function cmdInit(root: string): Promise<void> {
  // init and reindex are the same operation (full re-baseline); share it.
  const r = await ops.reindex(root);
  console.log(`indexed ${r.anchors} anchors across ${r.files} files`);
  console.log(`baseline commit: ${r.commit ?? "(no git)"}${r.commit ? ` (snapshotted, branch ${r.branch ?? "?"})` : ""}`);
}

async function cmdSnapshot(root: string): Promise<void> {
  const r = await ops.snapshot(root);
  console.log(JSON.stringify(r));
}

async function cmdDiff(root: string, base: string, head?: string): Promise<void> {
  if (!base) {
    console.error("Usage: codemap diff <base> [head] [repo]   (base/head are branch/tag/sha; omit head = working tree)");
    process.exit(2);
  }
  const r = await ops.diff(root, base, head);
  if ("error" in r) {
    console.error(r.error);
    process.exit(1);
  }
  console.log(`base ${r.base.label} (${(r.base.sha ?? "").slice(0, 12)}, ${r.base.anchors} anchors)  →  head ${r.head.label} (${r.head.anchors} anchors)`);
  console.log(`symbols: +${r.added.length} added  -${r.removed.length} removed  ~${r.changed.length} changed`);
  const show = (label: string, xs: { file: string; symbol: string }[]) => {
    for (const b of xs.slice(0, 40)) console.log(`  ${label} ${b.file}  ${b.symbol}`);
    if (xs.length > 40) console.log(`  … +${xs.length - 40} more`);
  };
  show("+", r.added);
  show("-", r.removed);
  show("~", r.changed);
  if (r.impact.nodes.length) {
    console.log(`\nimpacted docs (${r.impact.nodes.length}):`);
    for (const n of r.impact.nodes) console.log(`  • ${n.id} "${n.title}" — ${n.anchors.length} anchor(s)`);
  }
  if (r.impact.flows.length) {
    console.log(`\nimpacted flows (${r.impact.flows.length}):`);
    for (const f of r.impact.flows) console.log(`  ⇒ ${f.id} "${f.title}" — steps: ${f.steps.map((s) => s.title).join(", ")}`);
  }
  if (r.impact.reviews.length) {
    console.log(`\nreviews that would go stale (${r.impact.reviews.length}):`);
    for (const rv of r.impact.reviews) console.log(`  ⚠ ${rv.level} review of ${rv.target.kind} ${rv.target.id}`);
  }
}

async function cmdCheck(root: string): Promise<void> {
  // Branch switch → re-baseline first (same detection the MCP check_stale uses).
  const before = await readState(root);
  const cur = currentBranch(root);
  if (cur && before.branch != null && cur !== before.branch) {
    const r = await ops.reindex(root);
    console.log(`branch changed ${before.branch} → ${cur}: re-indexed ${r.anchors} anchors at ${r.commit?.slice(0, 8) ?? "?"}`);
  } else if (cur && before.branch == null) {
    await writeState(root, { ...before, branch: cur }); // start tracking
  }
  const store = await readAnchorStore(root);
  const state = await readState(root);
  const nodes = await loadNodes(root);
  const r = await computeStaleness(root, store, nodes, state.lastVerifiedCommit);

  console.log(`scope: ${r.scope}   ok: ${r.okCount}   stale: ${r.checks.length}   added: ${r.addedAnchorIds.length}`);
  const byStatus = (s: string) => r.checks.filter((c) => c.status === s);
  for (const c of byStatus("candidate_stale")) {
    const a = store.anchors.find((x) => x.id === c.anchorId)!;
    console.log(`  ~ candidate-stale  ${a.file}  ${a.symbolPath.join(" › ")}`);
  }
  for (const c of byStatus("lost")) {
    const a = store.anchors.find((x) => x.id === c.anchorId)!;
    console.log(`  ✗ lost             ${a.file}  ${a.symbolPath.join(" › ")}`);
  }
  if (r.flaggedNodes.length) {
    console.log(`\nflagged docs (${r.flaggedNodes.length}):`);
    for (const { node, reasons } of r.flaggedNodes) {
      console.log(`  • ${node.id} "${node.title}" — ${reasons.length} anchor(s): ${reasons.map((x) => x.status).join(", ")}`);
    }
  } else if (r.checks.length) {
    console.log("\n(no logical nodes cite the affected anchors yet)");
  }
  const changed = r.checks.length > 0 || r.addedAnchorIds.length > 0;
  const upd = await applyIndexUpdate(root);
  if (upd.added || upd.movedLoc) console.log(`index update: +${upd.added} new anchors, ${upd.movedLoc} relocated`);
  for (const rf of await refreshAnalyzers(root, { changed })) {
    console.log(`refreshed ${rf.name} graph: ${JSON.stringify(rf.emitted)}`);
  }
}

const { positionals, values } = parseArgs({ allowPositionals: true, options: { verbose: { type: "boolean" }, emit: { type: "boolean" }, repo: { type: "string" } } });

if (positionals[0] === "analyze") {
  const analyzer = positionals[1] ?? "";
  const root = resolve(positionals[2] ?? ".");
  // Only --emit writes; a read-only analyze needn't hold the lock.
  if (values.emit) await withLock(root, () => cmdAnalyze(analyzer, root, Boolean(values.verbose), true));
  else await cmdAnalyze(analyzer, root, Boolean(values.verbose), false);
} else {
  if (positionals[0] === "diff") {
    // codemap diff <base> [head] [--repo path]   (defaults to cwd; head defaults to working tree)
    await cmdDiff(resolve(values.repo ?? "."), positionals[1] ?? "", positionals[2]);
  } else {
    const [cmd, repoArg] = positionals;
    const root = resolve(repoArg ?? ".");
    if (cmd === "init") await withLock(root, () => cmdInit(root));
    else if (cmd === "check") await withLock(root, () => cmdCheck(root));
    else if (cmd === "snapshot") await withLock(root, () => cmdSnapshot(root));
    else usage();
  }
}
