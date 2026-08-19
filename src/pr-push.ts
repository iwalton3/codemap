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
import { PUBLISHABLE, type Annotation, type Disposition } from "./schema.js";
import { readAnnotations, writeAnnotations, readAnchorStore, readPushes, writePush } from "./store.js";
import { diffLineRanges } from "./git.js";
import { prTriage, anchorSpans, fetchPrMeta, type PrMeta } from "./pr.js";
import { LANE_POLICY } from "./lanes.js";

export interface InlineComment { path: string; line: number; side: "RIGHT"; body: string; annotationId: string }
export interface DeferredComment { annotationId: string; path: string; line?: number; body: string; why: string }
/**
 * A finding the human elected that this plan cannot place, and why.
 *
 * These used to vanish: a finding whose anchor was not in the PR's worklist hit a
 * bare `continue`, uncounted, so electing one on code the branch never touched
 * silently never went out AND the plan reported nothing held back. Most of the
 * time that is the right call — the map is full of annotations about other code —
 * but once a human has vouched for one, dropping it without saying so is the tool
 * lying about what it published.
 */
export interface BlockedComment { annotationId: string; severity?: string; file?: string; symbol?: string; why: string }

export interface PushPlan {
  pr: { number: number; title: string; url: string; owner: string; repo: string; nodeId?: string };
  head: string;
  body: string;
  comments: InlineComment[];
  deferred: DeferredComment[];
  blocked: BlockedComment[];
  viewedPaths: string[];
  skipped: { alreadyPushed: number; resolved: number; notElected: number; belowSeverity: number; withdrawn: number; noComment: number; notPublishable: number };
  /**
   * Identity of exactly what this plan would publish. A caller that inspected a
   * plan sends it back with the publish; if re-deriving gives a different one, the
   * push is refused rather than sending something nobody read. The plan/execute
   * split exists so a human approves a SPECIFIC set of comments, and over HTTP the
   * plan cannot be handed back by reference.
   */
  fingerprint: string;
}

/**
 * Publish under an agent's name or the human's.
 *
 * Derived from who wrote the `comment` — the submitter-facing text is the thing
 * being attributed — but overridable, because a human who rewrites an agent's
 * wording to be sharper should not have to choose between mislabelling it and
 * losing the marker.
 */
const attributionOf = (a: Annotation): "agent" | "human" =>
  a.publishAttribution ?? (lastCommentAuthorIsAgent(a) ? "agent" : "human");

function lastCommentAuthorIsAgent(a: Annotation): boolean {
  // Whoever last CHANGED the comment owns it. A finding an agent filed and a human
  // then rewrote is the human's; one a human filed and an agent revised is not.
  const rev = [...(a.revisions ?? [])].reverse().find((r) => "comment" in r.was);
  return (rev?.by ?? a.author ?? "").startsWith("agent");
}

/**
 * One finding, rendered for the person who has to fix it.
 *
 * The body is `comment`, never `text`: `text` is the investigation, written for the
 * map, and publishing it is the failure this whole split exists to prevent. A
 * finding without a comment is not rendered at all — it is skipped and said so.
 */
function renderAnnotation(a: Annotation, subject: string, preamble?: string): string {
  const mark = attributionOf(a) === "agent" ? "[Claude] " : "";
  // Two markers only. The submitter needs to know an answer is wanted rather than a
  // fix; more taxonomy than that will not survive contact.
  const q = a.kind === "question" ? "**Question** — " : "";
  return [
    preamble ? `${mark}**Re: ${preamble}**` : "",
    `${preamble ? "" : mark}${q}${a.comment!.trim()}`,
    ``,
    `<sub>codemap · \`${subject}\`${a.severity ? ` · ${a.severity}` : ""}${a.category ? ` · ${a.category}` : ""}</sub>`,
  ].filter((x) => x !== "").join("\n\n");
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
 * Where a finding stands on its way to the pull request. DERIVED, never stored.
 *
 * The two transitions already exist and are already enforced by construction:
 * `escalated` is the human's deliberate vouch (a web action — agents have no tool
 * that can set it), and the push record is the receipt for what actually went out.
 * Storing a parallel enum would mean two answers to the same question and a
 * dual-write to keep them agreeing, so this reads them instead.
 *
 *   local      an agent's proposal, not vouched for
 *   approved   the human's to publish — theirs, or an agent's they raised
 *   withdrawn  decided against; stays on the map
 *   posted     on the pull request; terminal for that PR
 */
export type PublishState = "local" | "approved" | "withdrawn" | "posted";

export function publishStateOf(a: Annotation, pushed: ReadonlySet<string>): PublishState {
  if (a.postedRef || pushed.has(a.id)) return "posted";
  if (a.withdrawn) return "withdrawn";
  return isElected(a) ? "approved" : "local";
}

/**
 * Why one finding is or is not published. Extracted because every decision that
 * determines what lands irreversibly on somebody else's pull request lived inside
 * a loop with no test reaching it: the vetting gate, the re-run dedupe and the
 * severity bar could all have been deleted without breaking anything.
 */
export type PushVerdict =
  | "push" | "not-in-pr" | "resolved" | "already-pushed" | "not-elected" | "below-severity"
  | "withdrawn" | "no-comment" | "not-publishable";

export function pushVerdict(
  a: Annotation,
  inPr: boolean,
  pushed: ReadonlySet<string>,
  filter: { electedOnly?: boolean; minSeverity?: string; dispositions?: readonly Disposition[]; ids?: ReadonlySet<string> } = {},
): PushVerdict {
  if (!inPr) return "not-in-pr";
  if (a.resolved) return "resolved";                       // never send something closed locally
  if (pushed.has(a.id) || a.postedRef) return "already-pushed";  // a re-run must not duplicate a comment
  if (a.withdrawn) return "withdrawn";
  if (filter.electedOnly !== false && !isElected(a)) return "not-elected";
  const minSev = filter.minSeverity === undefined ? -1 : SEV_ORDER.indexOf(filter.minSeverity);
  if (minSev >= 0 && SEV_ORDER.indexOf(a.severity ?? "low") < minSev) return "below-severity";
  // Named ids are the human picking a specific batch in the editor; that choice
  // outranks the disposition default, which is how a refutation worth closing out
  // gets published on request.
  if (!filter.ids?.has(a.id) && (a.kind === "finding" || a.kind === "question")) {
    const allowed = filter.dispositions ?? PUBLISHABLE;
    if (!allowed.includes(a.disposition ?? "open")) return "not-publishable";
  }
  // Deliberately last, so "you never wrote the short version" is what a finding that
  // would OTHERWISE have gone out reports — not something every unelected note says.
  // Falling back to `text` here is exactly the wall of text the split exists to stop.
  if (!a.comment?.trim()) return "no-comment";
  return "push";
}

export type Placement =
  | { kind: "inline"; path: string; line: number; preamble?: string }
  | { kind: "body"; why: string };

/**
 * Where a finding can actually land.
 *
 * GitHub only accepts a review comment on a file in the diff, and only on a line
 * inside a hunk. Findings have neither constraint: plenty are about code the branch
 * never edited, and some are about an ABSENCE, which has no line anywhere. So the
 * comment often has to sit somewhere other than its subject — and when it does, the
 * body has to say where the subject really is, because the reader's context is
 * wrong by construction.
 *
 * File-level comments (`subject_type: "file"`) would be the tidier landing spot for
 * §4.2, but they are not reliably accepted inside a batched review create, and a
 * 422 there fails the WHOLE batch. First-hunk-line plus a preamble always works.
 */
export function placeAnnotation(
  a: Annotation,
  subject: { file?: string; symbol?: string },
  q: {
    inDiff: (path: string) => boolean;
    commentable: (path: string, line: number) => boolean;
    firstHunkLine: (path: string) => number | undefined;
    firstChangedLineOfSymbol: () => number | undefined;
  },
): Placement {
  const where = subject.file ? `${subject.file}${a.line ? `:${a.line}` : ""}` : subject.symbol ?? "elsewhere";

  // An explicit publishPath is the human saying "put it here" — it wins outright.
  if (a.publishPath && q.inDiff(a.publishPath)) {
    const line = (a.publishLine && q.commentable(a.publishPath, a.publishLine) ? a.publishLine : undefined)
      ?? q.firstHunkLine(a.publishPath);
    if (line !== undefined) {
      const displaced = a.publishPath !== subject.file || (a.publishLine ?? line) !== a.line;
      return { kind: "inline", path: a.publishPath, line, ...(displaced ? { preamble: where } : {}) };
    }
  }

  if (subject.file && q.inDiff(subject.file)) {
    if (a.line && q.commentable(subject.file, a.line)) return { kind: "inline", path: subject.file, line: a.line };
    const own = q.firstChangedLineOfSymbol();
    if (own !== undefined) return { kind: "inline", path: subject.file, line: own };
    const first = q.firstHunkLine(subject.file);
    // Same file, wrong line: the preamble is what stops the submitter reading the
    // comment as being about the hunk it happens to be pinned to.
    if (first !== undefined) return { kind: "inline", path: subject.file, line: first, preamble: where };
    return { kind: "body", why: "the file is in the pull request but has no diff hunk to comment on" };
  }

  return {
    kind: "body",
    why: a.publishPath
      ? `publishPath "${a.publishPath}" is not a file in this pull request`
      : "the code this is about is not in this pull request — set publishPath to the nearest file that is",
  };
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

export interface PushFilterExt extends PushFilter {
  /** Publish exactly these, whatever their disposition — the editor's approved batch. */
  ids?: string[];
  /** Override which dispositions go out unasked (default: confirmed / partial / rerated). */
  dispositions?: Disposition[];
}

export async function planPrPush(root: string, input: string, filter: PushFilterExt = {}): Promise<PushPlan | { error: string }> {
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
  const blocked: BlockedComment[] = [];
  let resolved = 0, already = 0, notElected = 0, belowSeverity = 0, withdrawn = 0, noComment = 0, notPublishable = 0;
  const electedOnly = filter.electedOnly !== false;
  const ids = filter.ids?.length ? new Set(filter.ids) : undefined;

  const inDiff = (path: string) => ranges.has(path);
  const firstHunkLine = (path: string) => ranges.get(path)?.[0]?.[0];
  const allAnchors = new Map((await readAnchorStore(root)).anchors.map((x) => [x.id, x]));

  for (const a of anns) {
    if (a.target.kind !== "anchor") continue;
    if (ids && !ids.has(a.id)) continue;                   // an explicit batch is exactly that
    const w = byAnchor.get(a.target.id);

    // A finding whose anchor is not in this PR is normally none of its business —
    // the map is full of them. But one the human ELECTED, or gave a publishPath, is
    // a deliberate act, and §4.3 is the common case rather than an error: the
    // witness findings were a fail-open predicate in a file the branch never touched
    // and a missing registration, which is an absence and has no line anywhere.
    const claimed = !w && (isElected(a) || !!a.publishPath) && !a.resolved && !a.withdrawn
      && !pushed.has(a.id) && !a.postedRef;
    if (!w && !claimed) continue;

    const verdict = pushVerdict(a, w ? true : claimed, pushed, {
      electedOnly, minSeverity: filter.minSeverity, dispositions: filter.dispositions, ids,
    });
    if (verdict === "not-in-pr") continue;
    if (verdict === "resolved") { resolved++; continue; }
    if (verdict === "already-pushed") { already++; continue; }
    if (verdict === "withdrawn") { withdrawn++; continue; }
    if (verdict === "not-elected") { notElected++; continue; }
    if (verdict === "below-severity") { belowSeverity++; continue; }
    if (verdict === "not-publishable") { notPublishable++; continue; }

    const anc = allAnchors.get(a.target.id);
    const subject = { file: w?.file ?? anc?.file, symbol: w?.symbol ?? anc?.symbolPath.join(" › ") };

    if (verdict === "no-comment") {
      noComment++;
      blocked.push({
        annotationId: a.id, severity: a.severity, file: subject.file, symbol: subject.symbol,
        why: "no `comment` — write the submitter-facing version (what is broken, the file:line proving it, the ask). Publishing `text` would send the investigation.",
      });
      continue;
    }

    const place = placeAnnotation(a, subject, {
      inDiff, commentable, firstHunkLine,
      firstChangedLineOfSymbol: () => (w ? firstCommentableLine(a.target.id, w.file) : undefined),
    });

    if (place.kind === "inline") {
      comments.push({
        path: place.path, line: place.line, side: "RIGHT", annotationId: a.id,
        body: renderAnnotation(a, subject.symbol ?? place.path, place.preamble),
      });
      continue;
    }
    // Findings about the PR as a whole genuinely belong in the body; everything else
    // in here has lost its own resolvable thread, which is a cost worth naming.
    if (w) {
      deferred.push({
        annotationId: a.id, path: subject.file!, line: a.line, why: place.why,
        body: renderAnnotation(a, subject.symbol ?? subject.file!),
      });
    } else {
      blocked.push({ annotationId: a.id, severity: a.severity, file: subject.file, symbol: subject.symbol, why: place.why });
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
    blocked.length
      ? `<sub>${blocked.length} elected finding(s) could not be placed on this diff and were held back — they are still on the reviewer's map.</sub>`
      : "",
    ``,
    deferred.length
      ? [`<details><summary>${deferred.length} finding(s) with no diff line to sit on</summary>`, ``,
         // Each keeps its own location line, because in here they have lost the one
         // thing an inline comment gives them: a position that says what they are about.
         ...deferred.map((d) => [`**\`${d.path}${d.line ? ":" + d.line : ""}\`**`, ``, d.body, ``, `---`].join("\n")),
         `</details>`].join("\n")
      : "",
    ``,
    `<sub>Posted from [codemap](https://github.com/) — findings are anchored to symbols, so they survive a rebase.</sub>`,
  ].filter((x) => x !== "").join("\n");

  const fingerprint = createHash("sha256").update(JSON.stringify([
    t.refs.head,
    // Bodies are in, not just placements: the whole point of the plan/execute split
    // is that a human approved SPECIFIC text, and a revision between inspecting and
    // publishing changes what goes to the submitter without moving a single line.
    comments.map((c) => [c.annotationId, c.path, c.line, c.body]).sort(),
    deferred.map((d) => [d.annotationId, d.body]).sort(),
    [...viewedPaths].sort(),
  ])).digest("hex").slice(0, 16);

  return {
    fingerprint,
    pr: { number: t.pr.number, title: t.pr.title, url: t.pr.url, owner: t.pr.owner, repo: t.pr.repo },
    head: t.refs.head,
    body, comments, deferred, blocked, viewedPaths,
    skipped: { alreadyPushed: already, resolved, notElected, belowSeverity, withdrawn, noComment, notPublishable },
  };
}

function gh(args: string[], input?: string): { ok: boolean; out: string; err: string } {
  const r = spawnSync("gh", args, { encoding: "utf8", input, maxBuffer: 32 * 1024 * 1024, timeout: 120_000 });
  return { ok: r.status === 0, out: r.stdout ?? "", err: (r.stderr ?? "").trim() };
}

/**
 * Record where each published finding landed.
 *
 * The create-review response carries the review, not its comments, so the ids are
 * fetched separately and matched by (path, line). A line with two comments on it is
 * left without an id rather than guessed at: the id's whole purpose is to identify
 * ONE comment, and a wrong one would edit somebody else's.
 *
 * Best-effort throughout. Failing to record where a comment went is worth a
 * degraded record; it is not worth reporting a successful publish as a failure.
 */
async function stampPostedRefs(
  root: string, plan: PushPlan,
  ctx: { reviewId?: number; reviewUrl?: string; gh: typeof gh; slug: string },
): Promise<void> {
  const at = new Date().toISOString();
  const urls = new Map<string, { id: number; url: string }>();
  if (ctx.reviewId) {
    const r = ctx.gh(["api", `repos/${ctx.slug}/pulls/${plan.pr.number}/reviews/${ctx.reviewId}/comments`, "--paginate"]);
    if (r.ok) {
      try {
        const seen = new Map<string, number>();
        for (const c of JSON.parse(r.out) as { id: number; html_url: string; path: string; line?: number }[]) {
          const key = `${c.path}:${c.line ?? ""}`;
          seen.set(key, (seen.get(key) ?? 0) + 1);
          if (seen.get(key) === 1) urls.set(key, { id: c.id, url: c.html_url });
          else urls.delete(key);                          // ambiguous — no id is better than the wrong one
        }
      } catch { /* leave them unstamped */ }
    }
  }

  const store = await readAnnotations(root);
  const byId = new Map(store.annotations.map((a) => [a.id, a]));
  let touched = false;
  for (const c of plan.comments) {
    const a = byId.get(c.annotationId);
    if (!a) continue;
    const hit = urls.get(`${c.path}:${c.line}`);
    a.postedRef = {
      pr: plan.pr.number, at, placement: "inline", path: c.path, line: c.line,
      ...(ctx.reviewId ? { reviewId: ctx.reviewId } : {}),
      ...(hit ? { commentId: hit.id, url: hit.url } : ctx.reviewUrl ? { url: ctx.reviewUrl } : {}),
    };
    touched = true;
  }
  for (const d of plan.deferred) {
    const a = byId.get(d.annotationId);
    if (!a) continue;
    a.postedRef = {
      pr: plan.pr.number, at, placement: "body", path: d.path, line: d.line,
      ...(ctx.reviewId ? { reviewId: ctx.reviewId } : {}),
      ...(ctx.reviewUrl ? { url: ctx.reviewUrl } : {}),
    };
    touched = true;
  }
  if (touched) await writeAnnotations(root, store.annotations);
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
  opts: { markViewed?: boolean; comments?: boolean; gh?: typeof gh; headNow?: PrMeta | { error: string } } = {},
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
      let reviewId: number | undefined;
      try {
        const review = JSON.parse(r.out);
        result.reviewUrl = review.html_url;
        reviewId = typeof review.id === "number" ? review.id : undefined;
      } catch { /* the url and id are a nicety; the post succeeded either way */ }
      result.postedComments = plan.comments.length;

      // Record the publish IMMEDIATELY. Everything below is more `gh` — a comment
      // fetch here, then a call per file with a 120s timeout each — and recording
      // afterwards left a window where an interrupt lost the only evidence the review
      // went out, so the next publish re-posted every inline comment on someone
      // else's pull request. The dedupe record goes down before any of it.
      await writePush(root, String(plan.pr.number), {
        annotationIds: [...plan.comments.map((c) => c.annotationId), ...plan.deferred.map((d) => d.annotationId)],
        viewedPaths: [],
        at: new Date().toISOString(),
        reviewUrl: result.reviewUrl,
      });

      // Then stamp each finding with where it landed. Refinement of a record that
      // already exists, so losing it costs detail rather than the dedupe itself.
      await stampPostedRefs(root, plan, { reviewId, reviewUrl: result.reviewUrl, gh: gh_, slug });
    }
  }

  if (opts.markViewed && plan.viewedPaths.length) {
    // GitHub records a viewed tick against whatever the head is NOW, not against the
    // commit the plan was built from — so if the head moved since, ticking claims the
    // reviewer read code that arrived afterwards. That is the same lie `fetchViewedFiles`
    // refuses in the other direction by dropping DISMISSED. The head is re-read
    // FRESH, past the metadata cache, because a value up to a minute old is exactly
    // what would hide this.
    const now = opts.headNow ?? fetchPrMeta({ owner: plan.pr.owner, repo: plan.pr.repo, number: plan.pr.number }, { fresh: true });
    if ("error" in now) {
      errors.push(`viewed state not synced — could not confirm the head has not moved: ${now.error}`);
      return result;
    }
    if (now.headSha !== plan.head) {
      errors.push(`viewed state not synced — the pull request head moved from ${plan.head.slice(0, 12)} to ${now.headSha.slice(0, 12)} since this plan was made; re-open it and look again`);
      return result;
    }
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
      annotationIds: [], viewedPaths: result.markedViewed, at: new Date().toISOString(),
      // Not `result.reviewUrl` — a viewed-only publish has none, and `writePush`
      // spreads scalars, so it would erase the link to a review posted earlier.
      ...(result.reviewUrl ? { reviewUrl: result.reviewUrl } : {}),
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
