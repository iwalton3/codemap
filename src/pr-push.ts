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
  skipped: { alreadyPushed: number; resolved: number };
}

const ICON: Record<string, string> = { finding: "⚑", question: "❓", pointer: "👁", note: "✎" };

/** One finding, rendered for GitHub. Provenance is explicit — a human reading this must know an agent wrote it. */
function renderAnnotation(a: Annotation, symbol: string): string {
  const kind = a.kind ?? "note";
  const head = `${ICON[kind] ?? "✎"} **${kind}${a.severity ? ` · ${a.severity}` : ""}${a.category ? ` · ${a.category}` : ""}**`;
  const who = a.author && a.author.startsWith("agent") ? `_first-pass agent review — not yet confirmed by a human_` : "";
  return [head, "", a.text, "", who, `<sub>codemap · \`${symbol}\`</sub>`].filter(Boolean).join("\n");
}

export async function planPrPush(root: string, input: string): Promise<PushPlan | { error: string }> {
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
  let resolved = 0, already = 0;

  for (const a of anns) {
    if (a.target.kind !== "anchor") continue;
    const w = byAnchor.get(a.target.id);
    if (!w) continue;                                   // not part of this PR
    if (a.resolved) { resolved++; continue; }
    if (pushed.has(a.id)) { already++; continue; }
    const body = renderAnnotation(a, w.symbol);
    const line = a.line && commentable(w.file, a.line) ? a.line : firstCommentableLine(a.target.id, w.file);
    if (line) {
      comments.push({ path: w.file, line, side: "RIGHT", body, annotationId: a.id });
    } else {
      deferred.push({ annotationId: a.id, path: w.file, line: a.line, body, why: a.line ? "line is not in the diff and the symbol has no changed lines" : "no line, and the symbol has no changed lines" });
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

  return {
    pr: { number: t.pr.number, title: t.pr.title, url: t.pr.url, owner: t.pr.owner, repo: t.pr.repo },
    head: t.refs.head,
    body, comments, deferred, viewedPaths,
    skipped: { alreadyPushed: already, resolved },
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

/** Actually publish. Never called without an explicit caller decision — see the CLI's confirmation. */
export async function executePrPush(
  root: string, plan: PushPlan, opts: { markViewed?: boolean } = {},
): Promise<PushResult> {
  const slug = `${plan.pr.owner}/${plan.pr.repo}`;
  const errors: string[] = [];
  const result: PushResult = { postedComments: 0, deferredInBody: plan.deferred.length, markedViewed: [], errors };

  const payload = JSON.stringify({
    commit_id: plan.head,
    body: plan.body,
    event: "COMMENT",
    comments: plan.comments.map((c) => ({ path: c.path, line: c.line, side: c.side, body: c.body })),
  });
  const r = gh(["api", "--method", "POST", `repos/${slug}/pulls/${plan.pr.number}/reviews`, "--input", "-"], payload);
  if (!r.ok) {
    errors.push(`review post failed: ${r.err.slice(0, 400)}`);
    return result;
  }
  try { result.reviewUrl = JSON.parse(r.out).html_url; } catch { /* url is a nicety */ }
  result.postedComments = plan.comments.length;

  if (opts.markViewed && plan.viewedPaths.length) {
    const idr = gh(["pr", "view", String(plan.pr.number), "--repo", slug, "--json", "id", "--jq", ".id"]);
    const nodeId = idr.ok ? idr.out.trim() : "";
    if (!nodeId) errors.push("could not resolve the PR node id — viewed state not synced");
    else {
      for (const path of plan.viewedPaths) {
        const m = gh(["api", "graphql", "-f",
          "query=mutation($id:ID!,$p:String!){markFileAsViewed(input:{pullRequestId:$id,path:$p}){clientMutationId}}",
          "-f", `id=${nodeId}`, "-f", `p=${path}`]);
        if (m.ok) result.markedViewed.push(path);
        else errors.push(`markFileAsViewed ${path}: ${m.err.slice(0, 160)}`);
      }
    }
  }

  await writePush(root, String(plan.pr.number), {
    annotationIds: [...plan.comments.map((c) => c.annotationId), ...plan.deferred.map((d) => d.annotationId)],
    viewedPaths: result.markedViewed,
    at: new Date().toISOString(),
    reviewUrl: result.reviewUrl,
  });
  return result;
}
