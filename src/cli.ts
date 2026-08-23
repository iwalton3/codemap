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
import * as shared from "./ops-shared.js";

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
  const drift = refs.baseAheadOfMergeBase === null
    ? `  (could not tell whether ${pr.baseRef} has moved — is it fetched?)`
    : refs.baseAheadOfMergeBase ? `  (${pr.baseRef} is ${refs.baseAheadOfMergeBase} commits ahead of it — diffing against the tip would fold those in)` : "";
  console.log(`  merge-base ${refs.mergeBase.slice(0, 12)}${drift}`);
  for (const p of r.laneProblems ?? []) console.error(`  ! .codemaplanes ${p}`);

  console.log("\nlanes:");
  for (const l of lanes) console.log(`  ${pad(l.lane, 10)} ${String(l.lines).padStart(6)} lines  ${String(l.files).padStart(4)} files  ${pad(l.review, 8)} ${l.why}`);
  const pct = totals.changedLines ? Math.round((totals.queueLines / totals.changedLines) * 100) : 0;
  console.log(`  → ${totals.queueLines} of ${totals.changedLines} changed lines are in the review queue (${pct}%)`);

  console.log(`\nsymbols: ${diff.changed.length} changed, ${diff.added.length} added, ${diff.removed.length} removed`);
  if (diff.unverifiable?.length) {
    console.log(`  ${diff.unverifiable.length} could not be compared — this working tree and the base were indexed by`);
    console.log(`  different builds, so a hash difference says nothing about the code. Neither side is wrong;`);
    console.log(`  they are not comparable. \`codemap check\` will say whether your live index is the older one.`);
  }
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
async function cmdPrPush(
  root: string, prInput: string, confirm: boolean, markViewed: boolean,
  filter: { electedOnly?: boolean; minSeverity?: any; summary?: string; event?: "APPROVE" | "REQUEST_CHANGES"; ids?: string[] },
): Promise<void> {
  if (!prInput) { console.error("usage: codemap pr-push <pr> [--confirm] [--viewed] [--all] [--summary TEXT] [--approve|--request-changes]"); process.exit(2); }
  const plan = await ops.prPushPlan(root, prInput, filter);
  if ("error" in plan) { console.error(plan.error); process.exit(1); }

  console.log(`#${plan.pr.number} ${plan.pr.title}`);
  if (plan.event !== "COMMENT") console.log(`  VERDICT: ${plan.event} — this shows on the pull request as a vote`);
  if (plan.summary) console.log(`  summary: ${(plan.summary.split("\n")[0] ?? "").slice(0, 120)}${plan.summary.length > 120 ? "…" : ""}`);
  console.log(`  ${plan.comments.length} inline comment(s), ${plan.deferred.length} folded into the summary body`);
  console.log(`  ${plan.viewedPaths.length} file(s) fully reviewed → would be marked viewed on GitHub`);
  if (plan.skipped.alreadyPushed) console.log(`  ${plan.skipped.alreadyPushed} already pushed (skipped — a re-run never duplicates)`);
  if (plan.skipped.resolved) console.log(`  ${plan.skipped.resolved} resolved locally (not pushed)`);
  if (plan.skipped.notElected) console.log(`  ${plan.skipped.notElected} held back — an agent raised them and you have not raised them to the maintainer (--all to include)`);
  if (plan.skipped.belowSeverity) console.log(`  ${plan.skipped.belowSeverity} below --min-severity`);
  if (plan.skipped.withdrawn) console.log(`  ${plan.skipped.withdrawn} withdrawn`);
  if (plan.skipped.notPublishable) console.log(`  ${plan.skipped.notPublishable} held back by disposition (untriaged, refuted or accepted)`);
  if (plan.skipped.noComment) console.log(`  ${plan.skipped.noComment} have no submitter-facing \`comment\` written — the evidence is not published in its place`);
  if (plan.skipped.evidenceMoved) console.log(`  ${plan.skipped.evidenceMoved} written against a different version of the code (see below)`);
  if (plan.unverified.length) console.log(`  ${plan.unverified.length} predate witnessing — codemap cannot confirm they were written against THIS pull request`);
  for (const c of plan.comments) console.log(`    ${c.path}:${c.line}  ${c.body.split("\n")[0]}${c.citesLine ? `   [!] its own text points at :${c.citesLine}` : ""}`);
  for (const d of plan.deferred) console.log(`    [body] ${d.path}${d.line ? ":" + d.line : ""}  (${d.why})`);
  // Loud, and never folded into a count: these are findings the human vouched for
  // that this plan is NOT sending, which used to happen without anything saying so.
  if (plan.blocked.length) {
    console.log(`\n  ${plan.blocked.length} finding(s) you elected cannot be placed on this diff and are NOT in this review:`);
    for (const b of plan.blocked) console.log(`    ${b.file ?? b.symbol ?? "?"}  ${b.label}\n      → ${b.why}`);
  }

  if (!confirm) {
    console.log(`\nnothing posted. re-run with --confirm to publish${markViewed ? " (and --viewed to sync viewed state)" : ""}.`);
    return;
  }
  if (!plan.comments.length && !plan.deferred.length && plan.event === "COMMENT" && !plan.summary && !(markViewed && plan.viewedPaths.length)) {
    console.log("\nnothing to publish.");
    return;
  }
  // The plan just printed is the one published — not a second one derived after
  // the operator agreed to the first.
  const out = await ops.prPushExecute(root, plan, { markViewed });
  const { result } = out;
  console.log(`\nposted: ${result.postedComments} inline comment(s)${result.reviewUrl ? ` → ${result.reviewUrl}` : ""}`);
  if (result.markedViewed.length) console.log(`marked viewed: ${result.markedViewed.length} file(s)`);
  for (const e of result.errors) console.error(`  ! ${e}`);
}

/**
 * Sync which review conversations are settled, either way.
 *
 * Both directions are shown first, because they are different acts: pushing closes
 * threads on somebody else's pull request, and pulling records their resolution as
 * your own agreement — which is why it defaults to only accepting your own.
 */
async function cmdPrResolve(root: string, prInput: string, o: { confirm: boolean; pull: boolean; anyone: boolean }): Promise<void> {
  if (!prInput) { console.error("usage: codemap pr-resolve <pr> [--confirm] [--pull] [--anyone]"); process.exit(2); }
  const plan = await ops.prResolvePlan(root, prInput);
  if ("error" in plan) { console.error(plan.error); process.exit(1); }

  console.log(`#${plan.pr} — ${plan.inSync} conversation(s) already agree`);
  if (plan.toResolve.length) {
    console.log(`\n  settled here, still open on the pull request — ${plan.toResolve.length}:`);
    for (const t of plan.toResolve) console.log(`    ${t.path ?? "?"}${t.line ? ":" + t.line : ""}  ${t.label}`);
  }
  if (plan.toClose.length) {
    console.log(`\n  resolved on the pull request, still open here — ${plan.toClose.length}:`);
    for (const t of plan.toClose) console.log(`    by ${t.resolvedBy ?? "?"}  ${t.label}`);
  }
  if (plan.unmatched.length) console.log(`\n  ${plan.unmatched.length} posted finding(s) have no thread on this PR (deleted, or posted elsewhere)`);

  if (!o.confirm) { console.log(`\nnothing changed. --confirm to ${o.pull ? "take these resolutions into the map" : "close those conversations on GitHub"}.`); return; }

  if (o.pull) {
    const r = await ops.prResolvePull(root, plan, { anyone: o.anyone });
    console.log(`\nclosed here: ${r.closed.length}`);
    for (const s of r.skipped) console.log(`  skipped ${s.annotationId}: ${s.why}`);
  } else {
    const r = await ops.prResolvePush(root, plan);
    console.log(`\nresolved on GitHub: ${r.resolved.length}`);
    for (const e of r.errors) console.error(`  ! ${e}`);
  }
}

/** What is pointing at code the tree no longer has. See ops.orphanedWork. */
async function cmdOrphans(root: string): Promise<void> {
  const r = await ops.orphanedWork(root);
  if (!r.total) { console.log("nothing is pointing at missing code."); return; }
  const k = r.byKind as Record<string, { offTree: number; retained: number; lost: number }>;
  const work = Object.entries(k).filter(([n]) => n !== "review").reduce((n, [, v]) => n + v.offTree + v.retained + v.lost, 0);
  console.log(`${r.total} reference(s) to code the working tree does not have — ${work} of them findings or bugs:\n`);
  const show = (label: string, rows: any[], note: string) => {
    // Reviews are counted, not listed. A repository's history necessarily strands
    // `viewed` marks — code gets deleted and renamed, and those marks were true when
    // they were made — so enumerating hundreds of them would bury the handful of
    // findings that are actually unreachable work.
    const work = rows.filter((x) => x.kind !== "review");
    const marks = rows.length - work.length;
    if (!rows.length) return;
    console.log(`  ${label} — ${rows.length}  (${note})`);
    for (const x of work) {
      console.log(`    ${x.ref}  ${x.file ?? "?"}${x.line ? ":" + x.line : ""}  ${x.symbol ?? ""}`);
      console.log(`      ${x.label}${x.at ? `   [last seen at ${x.at}]` : ""}${x.posted ? `   [POSTED to PR #${x.posted.pr}]` : ""}`);
    }
    if (marks) console.log(`    …and ${marks} review mark(s), not listed — mostly imported history over deleted or renamed code`);
    console.log("");
  };
  show("off-tree", r.offTree as any[], "exists on a branch — check that ref out, or work against it");
  show("retained", r.retained as any[], "gone from the tree; last known state kept, still re-anchorable");
  show("lost", r.lost as any[], "no record anywhere — the finding's own text is all that survives");
}

async function cmdPrIngest(root: string, prInput: string, files: string[], dryRun: boolean): Promise<void> {
  if (!prInput || !files.length) { console.error("usage: codemap pr-ingest <pr> [--dry-run] <findings.jsonl...>"); process.exit(2); }
  const { readFile } = await import("node:fs/promises");
  const texts = await Promise.all(files.map((f) => readFile(f, "utf8")));
  const r = await ops.prIngest(root, prInput, texts, { dryRun });
  if ("error" in r && r.error) { console.error(r.error); process.exit(1); }
  const res = r as Exclude<typeof r, { error: string }>;
  console.log(`${dryRun ? "[dry run] " : ""}pr #${res.pr} @ ${String(res.head).slice(0, 12)}`);
  console.log(`  annotations: ${res.annotations}${res.duplicates ? `  (${res.duplicates} already present, skipped)` : ""}  triage proposals: ${res.triaged}`);
  console.log(`  by severity: ${JSON.stringify(res.bySeverity)}`);
  if (res.triageRefused?.length) {
    console.log(`  triage left alone: ${res.triageRefused.length} (already at or above that tier, or human-owned)`);
    for (const x of res.triageRefused.slice(0, 5)) console.log(`    line ${x.line}: ${x.why}`);
  }
  if (res.rejected.length) {
    console.log(`  rejected: ${res.rejected.length}`);
    for (const x of res.rejected.slice(0, 10)) console.log(`    line ${x.line}: ${x.why}`);
  }
  if (res.malformed?.length) console.log(`  malformed json lines: ${res.malformed.length}`);
  for (const s of res.summaries) console.log(`\n  [${s.batch}] reviewed ${s.reviewed}, ${s.findings} findings\n    ${s.narrative}`);
}

function usage(): never {
  console.error("Usage:\n  codemap init     [repo]\n  codemap reindex  [repo]              full re-baseline at HEAD (alias of init)\n  codemap check    [repo]\n  codemap snapshot [repo]              cache the current commit for branch-diff\n  codemap diff <base> [head] [--repo path]   base = branch/tag/sha; omit head = working tree\n  codemap pr <url|owner/repo#N|#N> [--repo path] [--no-fetch] [--json]\n  codemap prs <owner/repo>             open pull requests\n  codemap orphans  [repo]              findings/reviews pointing at code the tree no longer has\n  codemap pr-resolve <pr> [--repo path] [--confirm] [--pull] [--anyone]\n                                              sync which review conversations are settled\n  codemap pr-packet <pr> [--repo path] [--limit N] [--offset N]   agent work packet (JSON)\n  codemap pr-ingest <pr> [--repo path] [--dry-run] <findings.jsonl...>\n  codemap pr-push <pr> [--repo path] [--confirm] [--viewed] [--all] [--min-severity s]\n                     [--only id,id,…]  publish exactly these, whatever their disposition\n                     [--summary TEXT] [--approve | --request-changes]\n  codemap pr-triage <pr> [--repo path]        derive stakes+complexity for the PR's symbols\n  codemap pr-pull-viewed <pr|--all> [--repo path] [--dry-run] [--force] [--limit N] [--max-prs N]\n                                              import GitHub's viewed ticks as `viewed`\n  codemap analyze marten [repo] [--verbose] [--emit]\n\n  Shared review (a sidecar repo; set CODEMAP_SIDECAR or .codemap/sidecar):\n  codemap sync     [repo]              send and receive shared review state\n  codemap shared   <pr> [repo] [--queue] [--json]   findings on the sidecar\n  codemap peers    [repo]              who else is on this sidecar, and scheme drift\n  codemap replies  <pr> [repo]         what the PR submitter said back about published findings\n  codemap notes    <anchor|node id> [repo]   what the TEAM knows about a symbol\n  codemap publish-notes [repo] [--dry-run]   put this store's existing annotations on the sidecar\n  codemap shared-docs [repo] [--json]  the team's docs, resolved against THIS checkout\n  codemap publish-docs [repo] [--dry-run]    put this store's docs on the sidecar");
  process.exit(2);
}


async function cmdSync(root: string): Promise<void> {
  const r = await shared.sharedSync(root) as Record<string, unknown>;
  if (r.error) { console.error(r.error); process.exit(1); }
  console.log(`sidecar ${r.sidecar}  (${r.universe})`);
  console.log(`  received ${r.gained} event(s)${r.pushed ? ", sent yours" : ", nothing to send"}${(r.retries as number) ? ` after ${r.retries} retry/retries` : ""}`);
  if (r.warning) console.log(`  WARNING: ${r.warning}`);
}

async function cmdPeers(root: string): Promise<void> {
  const r = await shared.sharedStatus(root) as Record<string, any>;
  if (r.error) { console.error(r.error); process.exit(1); }
  console.log(`sidecar ${r.sidecar}  (${r.universe})   you: ${r.you ?? "(no identity)"}`);
  for (const p of r.peers) console.log(`  ${p.principal}   anchor=${p.anchorScheme} hash=${p.hashScheme}`);
  if (!r.peers.length) console.log("  (nobody has written a manifest yet — sync once)");
  if (r.blocked) { console.error(`BLOCKED: ${r.blocked}`); process.exit(1); }
  if (r.warning) console.log(`WARNING: ${r.warning}`);
}

async function cmdShared(pr: string, root: string, opts: { queue?: boolean; json?: boolean }): Promise<void> {
  const r = await shared.sharedFindings(root, pr, { queue: opts.queue }) as Record<string, any>;
  if (r.error) { console.error(r.error); process.exit(1); }
  if (opts.json) { console.log(JSON.stringify(r, null, 2)); return; }
  console.log(`PR ${r.pr} (${r.universe}): ${r.total} finding(s), ${r.waitingOnYou} waiting on a person${r.contested ? `, ${r.contested} contested` : ""}`);
  for (const f of r.findings) {
    const marks = [
      f.needsAck ? "NEEDS-ACK" : null,
      f.promoted ? "promoted" : null,
      f.independentConfirms ? `${f.independentConfirms} independent confirm(s)` : null,
      f.refutes ? `${f.refutes} refute(s)` : null,
      f.pending ? `asked: ${f.pending.ask}` : null,
      f.upstream ? `upstream ${f.upstream}` : null,
      f.bug ? `→ bug ${f.bug}` : null,
      f.contested?.length ? `CONTESTED: ${f.contested.map((x: any) => x.field).join(", ")}` : null,
    ].filter(Boolean).join(", ");
    console.log(`  [${f.state}] ${f.id}  ${f.severity ?? "-"}  by ${f.author}${f.authorModel ? ` (${f.authorModel})` : ""}`);
    console.log(`      ${(f.comment ?? f.text).slice(0, 140)}`);
    if (marks) console.log(`      ${marks}`);
  }
  if (!r.findings.length) console.log("  (nothing)");
}

async function cmdReplies(pr: string, root: string): Promise<void> {
  const r = await shared.inboundReplies(root, pr) as Record<string, any>;
  if (r.error) { console.error(r.error); process.exit(1); }
  if (r.note) { console.log(r.note); return; }
  if (!r.findings.length) { console.log("no replies yet"); return; }
  for (const f of r.findings) {
    console.log(`${f.id}${f.resolvedOnGitHub ? `  [resolved on GitHub by ${f.resolvedBy ?? "?"}]` : ""}  ${f.url ?? ""}`);
    console.log(`   you: ${(f.comment ?? "").slice(0, 120)}`);
    for (const rep of f.replies) console.log(`   ${rep.by ?? "(unknown)"}: ${rep.body.replace(/\s+/g, " ").slice(0, 200)}`);
    if (f.truncated) console.log("   … thread longer than was read; open it on GitHub");
  }
}

async function cmdNotes(target: string, root: string): Promise<void> {
  const r = await shared.sharedNotes(root, target) as Record<string, any>;
  if (r.error) { console.error(r.error); process.exit(1); }
  if (!r.notes.length) { console.log("nothing shared about this symbol yet"); return; }
  for (const n of r.notes) {
    console.log(`[${n.kind}]${n.severity ? ` ${n.severity}` : ""} ${n.by}${n.model ? ` (${n.model})` : ""}${n.resolved ? "  (resolved)" : ""}`);
    console.log(`   ${n.text.replace(/\s+/g, " ")}`);
    for (const a of n.answers) console.log(`   → ${a.by}: ${a.body.replace(/\s+/g, " ").slice(0, 200)}`);
  }
}

async function cmdPublishNotes(root: string, dryRun: boolean): Promise<void> {
  const r = await shared.publishLocalNotes(root, { dryRun }) as Record<string, any>;
  if (r.error) { console.error(r.error); process.exit(1); }
  console.log(JSON.stringify(r));
}

async function cmdSharedDocs(root: string, json: boolean): Promise<void> {
  const r = await shared.sharedDocs(root) as Record<string, any>;
  if (r.error) { console.error(r.error); process.exit(1); }
  if (json) { console.log(JSON.stringify(r, null, 2)); return; }
  console.log(`${r.universe}: ${r.total} shared doc(s), resolved against this checkout`);
  for (const d of r.docs) {
    const v = d.resolved;
    if (!v) { console.log(`  ${d.nodeId}  (no versions)`); continue; }
    // The verdict comes from `evalVersion`, through the payload — not re-derived
    // here. This was one of three copies of the rule, and copies drift: it could
    // not tell an id this build cannot derive from a symbol that is gone.
    const missing = v.citations.filter((c: any) => !c.present).length;
    console.log(`  [${v.status ?? "?"}] ${v.title}  ${d.nodeId}  v${d.versions}  by ${v.by ?? "?"}`);
    if (missing) console.log(`      ${missing} cited symbol(s) are not in this checkout`);
  }
  if (!r.docs.length) console.log("  (nothing shared yet — try `codemap publish-docs`)");
}

async function cmdPublishDocs(root: string, dryRun: boolean): Promise<void> {
  const r = await shared.publishLocalDocs(root, { dryRun }) as Record<string, any>;
  if (r.error) { console.error(r.error); process.exit(1); }
  console.log(JSON.stringify(r));
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
  // A reindex is routine; losing review history to one should not be. Say what this
  // stranded, and where to go and look at it.
  // Louder than the orphan notes below: a drifted submodule means the anchors just
  // written describe code this commit does not ship, and nothing else says so.
  for (const sm of (r as { submodules?: { path: string; sha: string; state: string }[] }).submodules ?? []) {
    console.log(
      sm.state === "uninitialized"
        ? `WARNING: submodule ${sm.path} is not initialized — its code was NOT indexed. Run \`git submodule update --init ${sm.path}\``
        : sm.state === "conflict"
          ? `WARNING: submodule ${sm.path} has unmerged conflicts — what was indexed is whatever is on disk`
          : `WARNING: submodule ${sm.path} is at ${sm.sha.slice(0, 12)}, which is not the commit this repo pins — the index describes code this commit does not ship. Run \`git submodule update ${sm.path}\` and re-run`,
    );
  }
  const smErr = (r as { submoduleError?: string }).submoduleError;
  if (smErr) {
    console.log(`WARNING: could not check submodules (${smErr}) — if this repo has any, the index may describe code this commit does not ship`);
  }
  const o = (r as { orphans?: { retained: number; recovered: number } }).orphans;
  if (o?.retained) console.log(`${o.retained} anchor(s) left the tree with findings or reviews on them — kept, run \`codemap orphans\` to see what and where`);
  if (o?.recovered) console.log(`${o.recovered} previously-missing anchor(s) are back in the tree`);
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
  console.log(`symbols: +${r.added.length} added  -${r.removed.length} removed  ~${r.changed.length} changed`
    + (r.unverifiable?.length ? `  ?${r.unverifiable.length} not comparable` : ""));
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

const { positionals, values } = parseArgs({ allowPositionals: true, options: { verbose: { type: "boolean" }, emit: { type: "boolean" }, repo: { type: "string" }, "no-fetch": { type: "boolean" }, json: { type: "boolean" }, limit: { type: "string" }, offset: { type: "string" }, "dry-run": { type: "boolean" }, confirm: { type: "boolean" }, viewed: { type: "boolean" }, all: { type: "boolean" }, "min-severity": { type: "string" }, force: { type: "boolean" }, "max-prs": { type: "string" }, summary: { type: "string" }, approve: { type: "boolean" }, "request-changes": { type: "boolean" }, pull: { type: "boolean" }, anyone: { type: "boolean" }, only: { type: "string" }, queue: { type: "boolean" } } });

if (positionals[0] === "analyze") {
  const analyzer = positionals[1] ?? "";
  const root = resolve(positionals[2] ?? ".");
  // Only --emit writes; a read-only analyze needn't hold the lock.
  if (values.emit) await withLock(root, () => cmdAnalyze(analyzer, root, Boolean(values.verbose), true));
  else await cmdAnalyze(analyzer, root, Boolean(values.verbose), false);
} else {
  if (positionals[0] === "pr-packet") {
    // Every `pr-*` command below writes: annotations, reviews and triage are
    // whole-blob read-modify-write, and even a plain read caches two commit
    // snapshots through `prTriage` -> `ensureSnapshot`. The MCP server and the
    // HTTP API hold the lock for the identical ops; these ran outside it, so a
    // concurrent writer's update was lost outright — and because the blobs are
    // rewritten whole, what is lost is UNRELATED records, not just the racing one.
    // The lock is taken here, at the entry point, and never nested: `withLock` is
    // not re-entrant, so an inner acquisition would deadlock until its timeout.
    const packetRoot = resolve(values.repo ?? ".");
    // `Number()` unchecked let `--limit 5x` through as NaN, and `slice(0, NaN)` is
    // empty — so the packet came back with `included: 0` and no error at all.
    const num = (flag: string, raw: string | undefined, min: number): number | undefined => {
      if (raw === undefined) return undefined;
      const n = Number(raw);
      if (!Number.isFinite(n) || n < min) { console.error(`--${flag} must be a number >= ${min} (got "${raw}")`); process.exit(2); }
      return n;
    };
    const r = await withLock(packetRoot, () => ops.prPacketFor(packetRoot, positionals[1] ?? "", {
      limit: num("limit", values.limit, 1),
      offset: num("offset", values.offset, 0),
      fetch: !values["no-fetch"],
    }));
    if ("error" in r) { console.error(r.error); process.exit(1); }
    console.log(JSON.stringify(r, null, 1));
  } else if (positionals[0] === "pr-pull-viewed" && (values.all || positionals[1] === "--all")) {
    const root = resolve(values.repo ?? ".");
    // `--dry-run` is advertised for this command; ignoring it meant
    // `pr-pull-viewed 42 --all --dry-run` performed a real import across up to 400
    // pull requests. A PR number alongside --all is a contradiction, not a filter.
    if (positionals[1] && positionals[1] !== "--all") {
      console.error(`--all imports every pull request; drop "${positionals[1]}" or drop --all`);
      process.exit(2);
    }
    const limitArg = values.limit === undefined ? undefined : Number(values.limit);
    if (limitArg !== undefined && (!Number.isFinite(limitArg) || limitArg < 1)) {
      console.error(`--limit must be a positive number (got "${values.limit}")`);
      process.exit(2);
    }
    const maxArg = values["max-prs"] === undefined ? undefined : Number(values["max-prs"]);
    if (maxArg !== undefined && (!Number.isFinite(maxArg) || maxArg < 1)) {
      console.error(`--max-prs must be a positive number (got "${values["max-prs"]}")`);
      process.exit(2);
    }
    const r = await ops.prPullViewedAll(root, {
      force: Boolean(values.force),
      limit: limitArg,
      maxPrs: maxArg,
      dryRun: Boolean(values["dry-run"]),
      onProgress: (m) => process.stderr.write(m + "\n"),
    });
    if ("error" in r) { console.error(r.error); process.exit(1); }
    console.log(`\n${values["dry-run"] ? "[dry run] " : ""}surveyed ${r.surveyed} PRs — ${r.withTicks} to check${r.unresolvedBySurvey ? ` (${r.unresolvedBySurvey} the survey could not settle)` : ""}`);
    if (r.listTruncated) console.error(`  ! the listing hit its cap; older pull requests were never surveyed — re-run with --max-prs`);
    console.log(`  processed ${r.processed}${r.skippedAlreadyImported ? `, skipped ${r.skippedAlreadyImported} already imported` : ""}`);
    console.log(`  ${r.marked} symbol(s) marked viewed${r.leftSigned ? `, ${r.leftSigned} left alone (already signed)` : ""}`);
    if (r.errors.length) {
      console.log(`  ${r.errors.length} PR(s) could not be imported:`);
      for (const e of r.errors.slice(0, 10)) console.log(`    #${e.pr}: ${e.why}`);
    }
  } else if (positionals[0] === "pr-pull-viewed") {
    const pvRoot = resolve(values.repo ?? ".");
    const r = await withLock(pvRoot, () => ops.prPullViewed(pvRoot, positionals[1] ?? "", { dryRun: Boolean(values["dry-run"]) }));
    if ("error" in r) { console.error(r.error); process.exit(1); }
    console.log(`${values["dry-run"] ? "[dry run] " : ""}${r.files.viewedOnGitHub} of ${r.files.total} file(s) ticked viewed on GitHub`);
    console.log(`  ${r.anchors.marked} symbol(s) marked viewed here` +
      (r.anchors.alreadyViewed ? `, ${r.anchors.alreadyViewed} already viewed` : "") +
      (r.anchors.alreadySigned ? `, ${r.anchors.alreadySigned} already signed (a vouch outranks a tick)` : ""));
    if (r.skippedFiles.length) console.log(`  ${r.skippedFiles.length} ticked file(s) carry no reviewable symbol here (tests/generated/data)`);
  } else if (positionals[0] === "pr-triage") {
    const ptRoot = resolve(values.repo ?? ".");
    const r = await withLock(ptRoot, () => ops.prTriageDerive(ptRoot, positionals[1] ?? ""));
    if ("error" in r) { console.error(r.error); process.exit(1); }
    console.log(`considered ${r.considered} symbol(s) — ${r.applied} marked, ${r.refused} left alone (already at or above this tier)`);
    console.log(`  proposed stakes: ${JSON.stringify(r.byImportance)}`);
  } else if (positionals[0] === "pr-push") {
    const pushRoot = resolve(values.repo ?? ".");
    await withLock(pushRoot, () => cmdPrPush(pushRoot, positionals[1] ?? "", Boolean(values.confirm), Boolean(values.viewed), {
      electedOnly: !values.all, minSeverity: values["min-severity"] as any,
      ids: values.only ? String(values.only).split(",").map((x) => x.trim()).filter(Boolean) : undefined,
      summary: values.summary as string | undefined,
      event: values.approve ? "APPROVE" : values["request-changes"] ? "REQUEST_CHANGES" : undefined,
    }));
  } else if (positionals[0] === "pr-ingest") {
    const ingestRoot = resolve(values.repo ?? ".");
    await withLock(ingestRoot, () => cmdPrIngest(ingestRoot, positionals[1] ?? "", positionals.slice(2), Boolean(values["dry-run"])));
  } else if (positionals[0] === "pr") {
    const prRoot = resolve(values.repo ?? ".");
    await withLock(prRoot, () => cmdPr(prRoot, positionals[1] ?? "", { fetch: !values["no-fetch"], json: Boolean(values.json) }));
  } else if (positionals[0] === "pr-resolve") {
    const r = resolve(values.repo ?? ".");
    await withLock(r, () => cmdPrResolve(r, positionals[1] ?? "", {
      confirm: Boolean(values.confirm), pull: Boolean(values.pull), anyone: Boolean(values.anyone),
    }));
  } else if (positionals[0] === "sync") {
    await cmdSync(resolve((values.repo as string | undefined) ?? positionals[1] ?? "."));
  } else if (positionals[0] === "peers") {
    await cmdPeers(resolve((values.repo as string | undefined) ?? positionals[1] ?? "."));
  } else if (positionals[0] === "shared") {
    await cmdShared(positionals[1] ?? "", resolve((values.repo as string | undefined) ?? positionals[2] ?? "."), {
      queue: Boolean(values.queue), json: Boolean(values.json),
    });
  } else if (positionals[0] === "replies") {
    await cmdReplies(positionals[1] ?? "", resolve((values.repo as string | undefined) ?? positionals[2] ?? "."));
  } else if (positionals[0] === "notes") {
    await cmdNotes(positionals[1] ?? "", resolve((values.repo as string | undefined) ?? positionals[2] ?? "."));
  } else if (positionals[0] === "publish-notes") {
    await cmdPublishNotes(resolve((values.repo as string | undefined) ?? positionals[1] ?? "."), Boolean(values["dry-run"]));
  } else if (positionals[0] === "shared-docs") {
    await cmdSharedDocs(resolve((values.repo as string | undefined) ?? positionals[1] ?? "."), Boolean(values.json));
  } else if (positionals[0] === "publish-docs") {
    await cmdPublishDocs(resolve((values.repo as string | undefined) ?? positionals[1] ?? "."), Boolean(values["dry-run"]));
  } else if (positionals[0] === "orphans") {
    await cmdOrphans(resolve((values.repo as string | undefined) ?? positionals[1] ?? "."));
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
