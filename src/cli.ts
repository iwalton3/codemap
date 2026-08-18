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

const pad = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + "…" : s.padEnd(n));

function cmdPrs(slug: string): void {
  if (!slug) { console.error("usage: codemap prs <owner/repo>"); process.exit(2); }
  const r = ops.prs(slug);
  if ("error" in r) { console.error(r.error); process.exit(1); }
  for (const p of r.prs) {
    console.log(`#${String(p.number).padEnd(5)} ${pad(p.title, 60)} ${pad(p.author, 14)} +${p.additions}/-${p.deletions} ${p.changedFiles}f ${p.draft ? "DRAFT" : ""}`);
  }
  if (!r.prs.length) console.log("no open pull requests");
}

async function cmdPr(root: string, input: string, opts: { fetch: boolean; json: boolean }): Promise<void> {
  if (!input) { console.error("usage: codemap pr <url|owner/repo#N|#N>"); process.exit(2); }
  const r = await ops.pr(root, input, { fetch: opts.fetch });
  if ("error" in r) { console.error(r.error); process.exit(1); }
  if (opts.json) { console.log(JSON.stringify(r, null, 2)); return; }

  const { pr, refs, lanes, totals, worklist, diff } = r;
  console.log(`#${pr.number} ${pr.title}`);
  console.log(`  ${pr.author} · ${pr.headRef} → ${pr.baseRef} · +${pr.additions}/-${pr.deletions} over ${pr.changedFiles} files`);
  console.log(`  merge-base ${refs.mergeBase.slice(0, 12)}${refs.baseAheadOfMergeBase ? `  (${pr.baseRef} is ${refs.baseAheadOfMergeBase} commits ahead of it — diffing against the tip would fold those in)` : ""}`);

  console.log("\nlanes:");
  for (const l of lanes) console.log(`  ${pad(l.lane, 10)} ${String(l.lines).padStart(6)} lines  ${String(l.files).padStart(4)} files  ${pad(l.review, 8)} ${l.why}`);
  const pct = totals.changedLines ? Math.round((totals.queueLines / totals.changedLines) * 100) : 0;
  console.log(`  → ${totals.queueLines} of ${totals.changedLines} changed lines are in the review queue (${pct}%)`);

  console.log(`\nsymbols: ${diff.changed.length} changed, ${diff.added.length} added, ${diff.removed.length} removed`);
  if (diff.added.length > diff.changed.length * 3 && diff.changed.length >= 0) {
    console.log(`  (mostly new surface — the ${diff.changed.length} *changed* symbols carry the regression risk)`);
  }
  const queue = worklist.filter((w) => w.lane === "code" && !w.reviewed);
  console.log(`worklist (top 20 of ${queue.length} unreviewed):`);
  for (const w of queue.slice(0, 20)) {
    const leaf = w.symbol.split(" › ").slice(-2).join(" › ");
    console.log(`  ${String(w.rank).padStart(4)}. [${pad(w.severity, 9)}][${pad(w.complexity, 8)}]${w.moneyHint ? "[$]" : "   "} ${w.change.padEnd(7)} ${pad(leaf, 38)} ${w.file.split("/").pop()}`);
    if (w.signature) console.log(`        ${w.signature.slice(0, 110)}`);
  }
  if (diff.impact.nodes.length) {
    console.log(`\ndocumented nodes impacted: ${diff.impact.nodes.length}`);
    for (const n of diff.impact.nodes.slice(0, 10)) console.log(`  [${pad(n.severity, 9)}] ${pad(n.title, 50)} (${n.anchors.length} anchors)`);
  }
  console.log(`\ncoverage: ${diff.coverage.complete}/${diff.coverage.total} review-complete`);
}

/**
 * Publishing is gated behind an explicit --confirm. Without it this prints the
 * plan and stops: comments on someone else's pull request notify people and are
 * not meaningfully undoable, so the default has to be "show me first".
 */
async function cmdPrPush(root: string, prInput: string, confirm: boolean, markViewed: boolean): Promise<void> {
  if (!prInput) { console.error("usage: codemap pr-push <pr> [--confirm] [--viewed]"); process.exit(2); }
  const plan = await ops.prPushPlan(root, prInput);
  if ("error" in plan) { console.error(plan.error); process.exit(1); }

  console.log(`#${plan.pr.number} ${plan.pr.title}`);
  console.log(`  ${plan.comments.length} inline comment(s), ${plan.deferred.length} folded into the summary body`);
  console.log(`  ${plan.viewedPaths.length} file(s) fully reviewed → would be marked viewed on GitHub`);
  if (plan.skipped.alreadyPushed) console.log(`  ${plan.skipped.alreadyPushed} already pushed (skipped — a re-run never duplicates)`);
  if (plan.skipped.resolved) console.log(`  ${plan.skipped.resolved} resolved locally (not pushed)`);
  for (const c of plan.comments) console.log(`    ${c.path}:${c.line}  ${c.body.split("\n")[0]}`);
  for (const d of plan.deferred) console.log(`    [body] ${d.path}${d.line ? ":" + d.line : ""}  (${d.why})`);

  if (!confirm) {
    console.log(`\nnothing posted. re-run with --confirm to publish${markViewed ? " (and --viewed to sync viewed state)" : ""}.`);
    return;
  }
  if (!plan.comments.length && !plan.deferred.length && !(markViewed && plan.viewedPaths.length)) {
    console.log("\nnothing to publish.");
    return;
  }
  const out = await ops.prPush(root, prInput, { markViewed });
  if ("error" in out) { console.error(out.error); process.exit(1); }
  const { result } = out;
  console.log(`\nposted: ${result.postedComments} inline comment(s)${result.reviewUrl ? ` → ${result.reviewUrl}` : ""}`);
  if (result.markedViewed.length) console.log(`marked viewed: ${result.markedViewed.length} file(s)`);
  for (const e of result.errors) console.error(`  ! ${e}`);
}

async function cmdPrIngest(root: string, prInput: string, files: string[], dryRun: boolean): Promise<void> {
  if (!prInput || !files.length) { console.error("usage: codemap pr-ingest <pr> [--dry-run] <findings.jsonl...>"); process.exit(2); }
  const { readFile } = await import("node:fs/promises");
  const texts = await Promise.all(files.map((f) => readFile(f, "utf8")));
  const r = await ops.prIngest(root, prInput, texts, { dryRun });
  if ("error" in r && r.error) { console.error(r.error); process.exit(1); }
  const res = r as Exclude<typeof r, { error: string }>;
  console.log(`${dryRun ? "[dry run] " : ""}pr #${res.pr} @ ${String(res.head).slice(0, 12)}`);
  console.log(`  annotations: ${res.annotations}  triage proposals: ${res.triaged}`);
  console.log(`  by severity: ${JSON.stringify(res.bySeverity)}`);
  if (res.rejected.length) {
    console.log(`  rejected: ${res.rejected.length}`);
    for (const x of res.rejected.slice(0, 10)) console.log(`    line ${x.line}: ${x.why}`);
  }
  if (res.malformed?.length) console.log(`  malformed json lines: ${res.malformed.length}`);
  for (const s of res.summaries) console.log(`\n  [${s.batch}] reviewed ${s.reviewed}, ${s.findings} findings\n    ${s.narrative}`);
}

function usage(): never {
  console.error("Usage:\n  codemap init     [repo]\n  codemap reindex  [repo]              full re-baseline at HEAD (alias of init)\n  codemap check    [repo]\n  codemap snapshot [repo]              cache the current commit for branch-diff\n  codemap diff <base> [head] [--repo path]   base = branch/tag/sha; omit head = working tree\n  codemap pr <url|owner/repo#N|#N> [--repo path] [--no-fetch] [--json]\n  codemap prs <owner/repo>             open pull requests\n  codemap pr-packet <pr> [--repo path] [--limit N] [--offset N]   agent work packet (JSON)\n  codemap pr-ingest <pr> [--repo path] [--dry-run] <findings.jsonl...>\n  codemap pr-push <pr> [--repo path] [--confirm] [--viewed]   publish findings to GitHub\n  codemap analyze marten [repo] [--verbose] [--emit]");
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
  const r = await ops.init(root);
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

const { positionals, values } = parseArgs({ allowPositionals: true, options: { verbose: { type: "boolean" }, emit: { type: "boolean" }, repo: { type: "string" }, "no-fetch": { type: "boolean" }, json: { type: "boolean" }, limit: { type: "string" }, offset: { type: "string" }, "dry-run": { type: "boolean" }, confirm: { type: "boolean" }, viewed: { type: "boolean" } } });

if (positionals[0] === "analyze") {
  const analyzer = positionals[1] ?? "";
  const root = resolve(positionals[2] ?? ".");
  // Only --emit writes; a read-only analyze needn't hold the lock.
  if (values.emit) await withLock(root, () => cmdAnalyze(analyzer, root, Boolean(values.verbose), true));
  else await cmdAnalyze(analyzer, root, Boolean(values.verbose), false);
} else {
  if (positionals[0] === "pr-packet") {
    const r = await ops.prPacketFor(resolve(values.repo ?? "."), positionals[1] ?? "", {
      limit: values.limit ? Number(values.limit) : undefined,
      offset: values.offset ? Number(values.offset) : undefined,
      fetch: !values["no-fetch"],
    });
    if ("error" in r) { console.error(r.error); process.exit(1); }
    console.log(JSON.stringify(r, null, 1));
  } else if (positionals[0] === "pr-push") {
    await cmdPrPush(resolve(values.repo ?? "."), positionals[1] ?? "", Boolean(values.confirm), Boolean(values.viewed));
  } else if (positionals[0] === "pr-ingest") {
    await cmdPrIngest(resolve(values.repo ?? "."), positionals[1] ?? "", positionals.slice(2), Boolean(values["dry-run"]));
  } else if (positionals[0] === "pr") {
    await cmdPr(resolve(values.repo ?? "."), positionals[1] ?? "", { fetch: !values["no-fetch"], json: Boolean(values.json) });
  } else if (positionals[0] === "prs") {
    cmdPrs(positionals[1] ?? "");
  } else if (positionals[0] === "diff") {
    // codemap diff <base> [head] [--repo path]   (defaults to cwd; head defaults to working tree)
    await cmdDiff(resolve(values.repo ?? "."), positionals[1] ?? "", positionals[2]);
  } else {
    const [cmd, repoArg] = positionals;
    const root = resolve(repoArg ?? ".");
    if (cmd === "init" || cmd === "reindex") await withLock(root, () => cmdInit(root));
    else if (cmd === "check") await withLock(root, () => cmdCheck(root));
    else if (cmd === "snapshot") await withLock(root, () => cmdSnapshot(root));
    else usage();
  }
}
