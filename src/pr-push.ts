/**
 * Publishing a review back to GitHub.
 *
 * Split into a plan and an execution on purpose. Posting to a pull request is
 * outward-facing and effectively irreversible — other people get notified — so
 * the plan is inspectable before anything leaves the machine, and every push is
 * recorded so a re-run cannot duplicate a comment someone already replied to.
 *
 * Two things go up:
 *   - findings, as one review with inline comments where the line is in the diff
 *     and a summary body carrying the rest;
 *   - `viewed` state, as GitHub's per-file viewed checkbox, so the two tools
 *     agree about what has been looked at.
 */

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import type { Annotation } from "./schema.js";
import { readAnnotations, readPushes, writePush } from "./store.js";
import { diffLineRanges } from "./git.js";
import { prTriage, anchorSpans } from "./pr.js";
import { LANE_POLICY } from "./lanes.js";

export interface InlineComment { path: string; line: number; side: "RIGHT"; body: string; annotationId: string }
export interface DeferredComment { annotationId: string; path: string; line?: number; body: string; why: string }

export interface PushPlan {
  pr: { number: number; title: string; url: string; owner: string; repo: string; nodeId?: string };
  head: string;
  body: string;
  comments: InlineComment[];
  deferred: DeferredComment[];
  viewedPaths: string[];
  skipped: { alreadyPushed: number; resolved: number; notElected: number; belowSeverity: number };
  /**
   * Identity of exactly what this plan would publish. A caller that inspected a
   * plan sends it back with the publish; if re-deriving gives a different one, the
   * push is refused rather than sending something nobody read. The plan/execute
   * split exists so a human approves a SPECIFIC set of comments, and over HTTP the
   * plan cannot be handed back by reference.
   */
  fingerprint: string;
}

const ICON: Record<string, string> = { finding: "⚑", question: "❓", pointer: "👁", note: "✎" };

/** One finding, rendered for GitHub. Provenance is explicit — a human reading this must know an agent wrote it. */
function renderAnnotation(a: Annotation, symbol: string): string {
  const kind = a.kind ?? "note";
  const head = `${ICON[kind] ?? "✎"} **${kind}${a.severity ? ` · ${a.severity}` : ""}${a.category ? ` · ${a.category}` : ""}**`;
  const who = a.author && a.author.startsWith("agent") ? `_first-pass agent review — not yet confirmed by a human_` : "";
  return [head, "", a.text, "", who, `<sub>codemap · \`${symbol}\`</sub>`].filter(Boolean).join("\n");
}

/**
 * A finding is the human's to publish when they wrote it, or when they explicitly
 * raised an agent's to the maintainer. Nothing else goes out under their account.
 *
 * The `author` prefix is the existing provenance convention — `renderAnnotation`
 * uses the same test to label an agent's finding on the PR.
 */
export const isAgentAuthored = (a: Annotation) => (a.author ?? "").startsWith("agent");
export const isElected = (a: Annotation) => !isAgentAuthored(a) || !!a.escalated;

/**
 * Why one finding is or is not published. Extracted because every decision that
 * determines what lands irreversibly on somebody else's pull request lived inside
 * a loop with no test reaching it: the vetting gate, the re-run dedupe and the
 * severity bar could all have been deleted without breaking anything.
 */
export type PushVerdict = "push" | "not-in-pr" | "resolved" | "already-pushed" | "not-elected" | "below-severity";

export function pushVerdict(
  a: Annotation,
  inPr: boolean,
  pushed: ReadonlySet<string>,
  filter: { electedOnly?: boolean; minSeverity?: string } = {},
): PushVerdict {
  if (!inPr) return "not-in-pr";
  if (a.resolved) return "resolved";                       // never send something closed locally
  if (pushed.has(a.id)) return "already-pushed";           // a re-run must not duplicate a comment
  if (filter.electedOnly !== false && !isElected(a)) return "not-elected";
  const minSev = filter.minSeverity === undefined ? -1 : SEV_ORDER.indexOf(filter.minSeverity);
  if (minSev >= 0 && SEV_ORDER.indexOf(a.severity ?? "low") < minSev) return "below-severity";
  return "push";
}

export interface PushFilter {
  /**
   * Publish only findings the human elected: their own, plus any agent finding they
   * raised to the maintainer. This is the default because the first pass is an
   * agent's PROPOSAL — sending one to a colleague's pull request under your own
   * account vouches for it, and that has to be something you chose, not something
   * that happened because you happened to open the symbol.
   */
  electedOnly?: boolean;
  minSeverity?: "low" | "medium" | "high" | "critical";
}

const SEV_ORDER = ["low", "medium", "high", "critical"];

export async function planPrPush(root: string, input: string, filter: PushFilter = {}): Promise<PushPlan | { error: string }> {
  // A misspelt tier used to yield indexOf() === -1, which the filter below read as
  // "no severity filter" — so `--min-severity High` published every `low` finding
  // to someone else's PR, and the plan printed `belowSeverity: 0` confirming
  // nothing had been held back. Publishing is not undoable, so refuse; and refuse
  // before any git or network work, so the message is the first thing seen.
  const minSev = filter.minSeverity === undefined ? -1 : SEV_ORDER.indexOf(filter.minSeverity);
  if (minSev < 0 && filter.minSeverity !== undefined) {
    return { error: `unknown --min-severity "${filter.minSeverity}" — expected one of ${SEV_ORDER.join(", ")}` };
  }

  const t = await prTriage(root, input, { fetch: false });
  if ("error" in t) return t;

  const anns = (await readAnnotations(root)).annotations;
  const byAnchor = new Map(t.worklist.map((w) => [w.id, w]));
  const pushed = new Set((await readPushes(root)).pushes[String(t.pr.number)]?.annotationIds ?? []);

  const ranges = diffLineRanges(root, t.refs.mergeBase, t.refs.head);
  const commentable = (path: string, line: number) => (ranges.get(path) ?? []).some(([a, b]) => line >= a && line <= b);

  // A finding without its own line still belongs *somewhere* specific. Fall back to
  // the first line of its symbol that the diff actually touches, so the comment
  // lands on the code it is about instead of being swept into the summary. Only a
  // symbol with no changed lines at all — a body the PR never edited — defers.
  const spans = await anchorSpans(root, t.refs.head, t.worklist.filter((w) => w.change !== "removed").map((w) => ({ id: w.id, file: w.file })));
  const firstCommentableLine = (anchorId: string, path: string): number | undefined => {
    const s = spans.get(anchorId);
    if (!s) return undefined;
    for (const [a, b] of ranges.get(path) ?? []) {
      const lo = Math.max(a, s.startLine), hi = Math.min(b, s.endLine);
      if (lo <= hi) return lo;
    }
    return undefined;
  };

  const comments: InlineComment[] = [];
  const deferred: DeferredComment[] = [];
  let resolved = 0, already = 0, notElected = 0, belowSeverity = 0;
  const electedOnly = filter.electedOnly !== false;

  for (const a of anns) {
    if (a.target.kind !== "anchor") continue;
    const w = byAnchor.get(a.target.id);
    const verdict = pushVerdict(a, !!w, pushed, { electedOnly, minSeverity: filter.minSeverity });
    if (verdict === "not-in-pr") continue;
    if (verdict === "resolved") { resolved++; continue; }
    if (verdict === "already-pushed") { already++; continue; }
    if (verdict === "not-elected") { notElected++; continue; }
    if (verdict === "below-severity") { belowSeverity++; continue; }
    const body = renderAnnotation(a, w!.symbol);
    const line = a.line && commentable(w!.file, a.line) ? a.line : firstCommentableLine(a.target.id, w!.file);
    if (line) {
      comments.push({ path: w!.file, line, side: "RIGHT", body, annotationId: a.id });
    } else {
      deferred.push({ annotationId: a.id, path: w!.file, line: a.line, body, why: a.line ? "line is not in the diff and the symbol has no changed lines" : "no line, and the symbol has no changed lines" });
    }
  }

  // A file counts as viewed once every reviewable symbol the PR changed in it has
  // been looked at — GitHub's checkbox is per file, codemap's marks are per symbol.
  const byFile = new Map<string, { total: number; seen: number }>();
  for (const w of t.worklist) {
    if (LANE_POLICY[w.lane].review !== "queue") continue;
    const e = byFile.get(w.file) ?? { total: 0, seen: 0 };
    e.total++;
    if (w.reviewed || w.viewed) e.seen++;
    byFile.set(w.file, e);
  }
  const viewedPaths = [...byFile.entries()].filter(([, e]) => e.total && e.seen === e.total).map(([f]) => f);

  const signed = t.worklist.filter((w) => w.lane === "code" && w.reviewed).length;
  const queue = t.worklist.filter((w) => w.lane === "code").length;
  const laneLines = t.lanes.map((l) => `| ${l.lane} | ${l.lines} | ${l.files} | ${l.review} |`).join("\n");

  const body = [
    `### codemap review`,
    ``,
    `**${signed}/${queue}** changed symbols signed · **${t.totals.queueLines}** of **${t.totals.changedLines}** changed lines in the review queue.`,
    ``,
    `| lane | lines | files | attention |`,
    `|---|---:|---:|---|`,
    laneLines,
    ``,
    deferred.length
      ? [`<details><summary>${deferred.length} finding(s) not on a diff line</summary>`, ``,
         ...deferred.map((d) => `- \`${d.path}${d.line ? ":" + d.line : ""}\` — ${d.body.split("\n")[0]}\n\n  ${d.body.split("\n").slice(2).join(" ").trim()}`),
         ``, `</details>`].join("\n")
      : "",
    ``,
    `<sub>Posted from [codemap](https://github.com/) — findings are anchored to symbols, so they survive a rebase.</sub>`,
  ].filter((x) => x !== "").join("\n");

  const fingerprint = createHash("sha256").update(JSON.stringify([
    t.refs.head,
    comments.map((c) => [c.annotationId, c.path, c.line]).sort(),
    deferred.map((d) => d.annotationId).sort(),
    [...viewedPaths].sort(),
  ])).digest("hex").slice(0, 16);

  return {
    fingerprint,
    pr: { number: t.pr.number, title: t.pr.title, url: t.pr.url, owner: t.pr.owner, repo: t.pr.repo },
    head: t.refs.head,
    body, comments, deferred, viewedPaths,
    skipped: { alreadyPushed: already, resolved, notElected, belowSeverity },
  };
}

function gh(args: string[], input?: string): { ok: boolean; out: string; err: string } {
  const r = spawnSync("gh", args, { encoding: "utf8", input, maxBuffer: 32 * 1024 * 1024, timeout: 120_000 });
  return { ok: r.status === 0, out: r.stdout ?? "", err: (r.stderr ?? "").trim() };
}

export interface PushResult {
  reviewUrl?: string;
  postedComments: number;
  deferredInBody: number;
  markedViewed: string[];
  errors: string[];
}

/**
 * Actually publish. Never called without an explicit caller decision — see the
 * CLI's confirmation and the walkthrough's two-step buttons.
 *
 * The two halves are independent because they are different acts: comments notify
 * the author and argue for a change, while viewed state just tells them which
 * files someone has read. Wanting one is not wanting the other.
 */
export async function executePrPush(
  root: string, plan: PushPlan,
  // `gh` is injected so the ORDER of what this does — post, record, then sync — is
  // testable without posting to anybody's pull request. That order is load-bearing:
  // see the recording comment below.
  opts: { markViewed?: boolean; comments?: boolean; gh?: typeof gh } = {},
): Promise<PushResult> {
  const gh_ = opts.gh ?? gh;
  const slug = `${plan.pr.owner}/${plan.pr.repo}`;
  const errors: string[] = [];
  const result: PushResult = { postedComments: 0, deferredInBody: plan.deferred.length, markedViewed: [], errors };
  // Nothing to say is not a reason to open a review on someone's pull request.
  const postComments = opts.comments !== false && (plan.comments.length > 0 || plan.deferred.length > 0);

  if (postComments) {
    const payload = JSON.stringify({
      commit_id: plan.head,
      body: plan.body,
      event: "COMMENT",
      comments: plan.comments.map((c) => ({ path: c.path, line: c.line, side: c.side, body: c.body })),
    });
    const r = gh_(["api", "--method", "POST", `repos/${slug}/pulls/${plan.pr.number}/reviews`, "--input", "-"], payload);
    if (!r.ok) {
      // A failed post must not abandon a viewed sync that was also asked for: they
      // are independent acts, and one failing is not the other's news.
      errors.push(`review post failed: ${r.err.slice(0, 400)}`);
    } else {
      try { result.reviewUrl = JSON.parse(r.out).html_url; } catch { /* url is a nicety */ }
      result.postedComments = plan.comments.length;

      // Record the publish IMMEDIATELY. The viewed-sync below is a sequential `gh`
      // call per file with a 120s timeout each; recording afterwards left a window
      // where an interrupt lost the only evidence the review went out, and the next
      // publish re-posted every inline comment on someone else's pull request.
      await writePush(root, String(plan.pr.number), {
        annotationIds: [...plan.comments.map((c) => c.annotationId), ...plan.deferred.map((d) => d.annotationId)],
        viewedPaths: [],
        at: new Date().toISOString(),
        reviewUrl: result.reviewUrl,
      });
    }
  }

  if (opts.markViewed && plan.viewedPaths.length) {
    const idr = gh_(["pr", "view", String(plan.pr.number), "--repo", slug, "--json", "id", "--jq", ".id"]);
    const nodeId = idr.ok ? idr.out.trim() : "";
    if (!nodeId) errors.push("could not resolve the PR node id — viewed state not synced");
    else {
      for (const path of plan.viewedPaths) {
        const m = gh_(["api", "graphql", "-f",
          "query=mutation($id:ID!,$p:String!){markFileAsViewed(input:{pullRequestId:$id,path:$p}){clientMutationId}}",
          "-f", `id=${nodeId}`, "-f", `p=${path}`]);
        if (m.ok) result.markedViewed.push(path);
        else errors.push(`markFileAsViewed ${path}: ${m.err.slice(0, 160)}`);
      }
    }
  }

  // Second write: the viewed paths, once they are actually synced. `writePush`
  // unions, so this adds to the record above rather than replacing it.
  if (result.markedViewed.length) {
    await writePush(root, String(plan.pr.number), {
      annotationIds: [], viewedPaths: result.markedViewed, at: new Date().toISOString(), reviewUrl: result.reviewUrl,
    });
  }
  return result;
}

/** GitHub's per-file review state for a PR, paginated. */
export function fetchViewedFiles(slug: string, number: number): { viewed: Set<string>; total: number } | { error: string } {
  const [owner, repo] = slug.split("/");
  const viewed = new Set<string>();
  let total = 0, after: string | null = null;
  for (let page = 0; page < 40; page++) {                    // 4,000 files is far past any reviewable PR
    const args = [
      "api", "graphql", "-f",
      "query=query($o:String!,$r:String!,$n:Int!,$after:String){repository(owner:$o,name:$r){pullRequest(number:$n){files(first:100,after:$after){pageInfo{hasNextPage endCursor} nodes{path viewerViewedState}}}}}",
      "-f", `o=${owner}`, "-f", `r=${repo}`, "-F", `n=${number}`,
    ];
    if (after) args.push("-f", `after=${after}`);
    const r = gh(args);
    if (!r.ok) return { error: `gh graphql failed: ${r.err.slice(0, 300)}` };
    try {
      const f = JSON.parse(r.out).data.repository.pullRequest.files;
      for (const n of f.nodes) {
        total++;
        // VIEWED only. DISMISSED means GitHub reset the tick because the file changed
        // after it was ticked — importing that would claim exposure to code the
        // reviewer never saw, which is the lie the whole attestation model avoids.
        if (n.viewerViewedState === "VIEWED") viewed.add(n.path);
      }
      if (!f.pageInfo.hasNextPage) return { viewed, total };
      after = f.pageInfo.endCursor;
    } catch (e) { return { error: `could not parse gh output: ${(e as Error).message}` }; }
  }
  // Pages remain. A partial set returned as a success reads as "these are the only
  // files ticked", which is a claim about the ones it never looked at.
  return { error: `pull request has more files than the viewed list was read to the end of (${total}+)` };
}

export interface PullViewedResult {
  files: { total: number; viewedOnGitHub: number; mapped: number };
  anchors: { marked: number; alreadyViewed: number; alreadySigned: number };
  /** Files ticked on GitHub that carry no reviewable symbol here (tests, generated, data). */
  skippedFiles: string[];
}

/**
 * Import GitHub's per-file "viewed" ticks as codemap `viewed` marks.
 *
 * Never `signed`, and that asymmetry is the point. GitHub's checkbox is a single
 * click on a whole file with no record of what was in it; a codemap sign-off is a
 * liability-bearing vouch witnessed against exact bodies. Treating one as the
 * other would launder "I clicked through this in a hurry" into "I stand behind
 * it" — which is precisely the failure the viewed/signed split exists to prevent.
 * `viewed` says what is true: eyes were on it.
 *
 * GitHub's unit is the file and codemap's is the symbol, so a ticked file marks
 * every symbol the PR changed *in* it. Marks are witnessed at the PR head, so
 * they read fresh against the code that was actually on screen and go stale if it
 * moves — which is the value over the checkbox itself.
 */
export async function pullViewedFromGitHub(
  root: string, input: string,
  deps: {
    triage: (root: string, input: string, opts: { fetch?: boolean }) => Promise<any>;
    markBatch: (root: string, ids: string[], o: { level: "code"; actor: "human"; attestation: "viewed"; reviewer?: string; ref?: string }) => Promise<{ marked: number }>;
    /** Injected so the mapping is testable without GitHub. */
    fetchViewed?: (slug: string, number: number) => { viewed: Set<string>; total: number } | { error: string };
  },
  opts: { dryRun?: boolean; reviewer?: string } = {},
): Promise<PullViewedResult | { error: string }> {
  const t = await deps.triage(root, input, { fetch: false });
  if ("error" in t) return t;

  const gh = (deps.fetchViewed ?? fetchViewedFiles)(`${t.pr.owner}/${t.pr.repo}`, t.pr.number);
  if ("error" in gh) return gh;

  const byFile = new Map<string, any[]>();
  for (const w of t.worklist) {
    if (LANE_POLICY[w.lane as keyof typeof LANE_POLICY].review !== "queue") continue;
    (byFile.get(w.file) ?? byFile.set(w.file, []).get(w.file)!).push(w);
  }

  const toMark: string[] = [];
  const skippedFiles: string[] = [];
  let alreadyViewed = 0, alreadySigned = 0;
  for (const path of gh.viewed) {
    const items = byFile.get(path);
    if (!items) { skippedFiles.push(path); continue; }
    for (const w of items) {
      if (w.reviewed) { alreadySigned++; continue; }   // a sign-off already outranks this
      if (w.viewed) { alreadyViewed++; continue; }
      toMark.push(w.id);
    }
  }

  const marked = opts.dryRun ? toMark.length
    : (await deps.markBatch(root, toMark, { level: "code", actor: "human", attestation: "viewed", reviewer: opts.reviewer, ref: t.refs.head })).marked;

  return {
    files: { total: gh.total, viewedOnGitHub: gh.viewed.size, mapped: gh.viewed.size - skippedFiles.length },
    anchors: { marked, alreadyViewed, alreadySigned },
    skippedFiles,
  };
}
