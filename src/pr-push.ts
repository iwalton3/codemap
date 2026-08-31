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
import { readAnnotations, writeAnnotations, readAnchorStore, readPushes, writePush, readSnapshot, readOrphans } from "./store.js";
import { WORK_REF } from "./db.js";
import { diffHunks, isAncestor } from "./git.js";
import { prTriage, anchorSpans, fetchPrMeta, type PrMeta } from "./pr.js";
import { LANE_POLICY } from "./lanes.js";
import { sameBody, comparableHashes } from "./normalize.js";
import { resolveSidecar } from "./sidecar-config.js";

export interface InlineComment {
  path: string; line: number; side: "RIGHT"; body: string; annotationId: string;
  /**
   * The comment's own prose cites a line, and this is not it.
   *
   * A pure string check, and it would have caught the one comment in the first real
   * batch that landed eleven lines off its subject — the body said
   * `CreateTicket.cs:40-44` while the comment sat on line 30. Surfaced in the
   * plan rather than blocked: GitHub will accept it, and the human is the one who
   * can tell a mis-placement from a comment that legitimately cites elsewhere.
   */
  citesLine?: number;
}
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
export interface BlockedComment {
  annotationId: string; severity?: string; file?: string; symbol?: string; why: string;
  /**
   * This finding belongs to a DIFFERENT review, and is listed only for completeness.
   *
   * `isElected` is "a human wrote it", which is true forever and everywhere — so every
   * finding anyone ever wrote by hand is elected on every pull request, and each one
   * the diff cannot place is reported as held back. On a store with real history that
   * is a wall of other reviews' work every time you push, which trains people to skim
   * the one list that must not be skimmed: the findings that were about THIS change and
   * genuinely could not be placed.
   *
   * Nothing is dropped — the classification is presentational, because silently
   * discarding a finding somebody vouched for is the failure this whole list exists to
   * prevent, and it is worse than the noise.
   */
  elsewhere?: { pr?: number; ref?: string };
  /** Enough of the finding to recognise it — a plan that names only ids is not readable. */
  label: string;
}

/**
 * What kind of review this is, in GitHub's vocabulary.
 *
 * `COMMENT` leaves feedback without a verdict. The other two are votes that show on
 * the PR and can gate a merge, so neither is ever a default — the caller has to
 * choose one, and the UI makes it a separate deliberate act from writing the
 * comments.
 */
export type ReviewEvent = "COMMENT" | "APPROVE" | "REQUEST_CHANGES";

export interface PushPlan {
  pr: { number: number; title: string; url: string; owner: string; repo: string; nodeId?: string };
  head: string;
  /** The whole review body: the human's summary, then the generated stats. */
  body: string;
  /** The human's own words to the author, as they wrote them. */
  summary?: string;
  event: ReviewEvent;
  comments: InlineComment[];
  deferred: DeferredComment[];
  blocked: BlockedComment[];
  viewedPaths: string[];
  skipped: { alreadyPushed: number; resolved: number; notElected: number; belowSeverity: number; withdrawn: number; noComment: number; notPublishable: number; evidenceMoved: number; evidenceUnverifiable: number };
  /** Published findings codemap could not confirm were written against this PR. */
  unverified: string[];
  /**
   * Raw comment push is OFF because this universe has a sidecar.
   *
   * The two halves of this file are different acts. Reporting what you signed off and
   * how clean the branch is — the verdict, the summary, the viewed ticks — is a status
   * report about YOUR reading, and it belongs on the pull request where the author
   * looks. Posting the findings themselves does not, once the team has a sidecar: that
   * is where the reviewers' discussion lives, it can hold a finding about code the
   * branch never touched or about an ABSENCE, and it survives the branch. Sending the
   * same finding to both makes the GitHub copy the one people reply to and the sidecar
   * copy the one that goes stale.
   *
   * Absent when there is no sidecar, so a solo store keeps exactly the behaviour it had.
   */
  commentPush?: { disabled: true; why: string; suppressed: number };
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

const labelOf = (a: Annotation): string => {
  const t = (a.comment || a.text || "").trim().split("\n")[0] ?? "";
  return t.length > 120 ? t.slice(0, 120) + "…" : t;
};

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
  | "withdrawn" | "no-comment" | "not-publishable" | "evidence-moved" | "evidence-unverifiable";

export function pushVerdict(
  a: Annotation,
  inPr: boolean,
  pushed: ReadonlySet<string>,
  filter: {
    electedOnly?: boolean; minSeverity?: string; dispositions?: readonly Disposition[]; ids?: ReadonlySet<string>;
    /** The anchor's body hash at the PR head; undefined when the PR does not carry it. */
    headHashOf?: (anchorId: string) => string | undefined;
    /** Which pull request this plan is for — `postedRef` is scoped to one. */
    pr?: number;
  } = {},
): PushVerdict {
  if (!inPr) return "not-in-pr";
  if (a.resolved) return "resolved";                       // never send something closed locally
  // A re-run must not duplicate a comment. `pushed` is already this PR's record;
  // `postedRef` names the PR it landed on, so it only speaks for that one — two pull
  // requests can touch the same symbol, and a finding that went to one is not
  // thereby answered on the other.
  if (pushed.has(a.id)) return "already-pushed";
  if (a.postedRef && (filter.pr === undefined || a.postedRef.pr === filter.pr)) return "already-pushed";
  if (a.withdrawn) return "withdrawn";
  if (filter.electedOnly !== false && !isElected(a)) return "not-elected";
  const minSev = filter.minSeverity === undefined ? -1 : SEV_ORDER.indexOf(filter.minSeverity);
  if (minSev >= 0 && SEV_ORDER.indexOf(a.severity ?? "low") < minSev) return "below-severity";
  // Named ids are the human picking a specific batch in the editor; that choice
  // outranks the disposition default, which is how a refutation worth closing out
  // gets published on request.
  //
  // The gate is on DISPOSITION, not on kind. A `pointer` filed as "watch out for X
  // when reviewing this" and then investigated and confirmed is a finding in
  // everything but the field it was filed under — and the six that were excluded on
  // kind alone included the highest-rated item in the whole review. What triage
  // concluded outranks what it was called when nobody knew yet.
  if (!filter.ids?.has(a.id)) {
    const allowed = filter.dispositions ?? PUBLISHABLE;
    if (!allowed.includes(a.disposition ?? "open")) return "not-publishable";
  }
  // Deliberately last, so "you never wrote the short version" is what a finding that
  // would OTHERWISE have gone out reports — not something every unelected note says.
  // Falling back to `text` here is exactly the wall of text the split exists to stop.
  if (!a.comment?.trim()) return "no-comment";
  // The body it was written against is not the body on this pull request. Either the
  // submitter has pushed since, or — the case this was built for — it was written
  // while reading a DIFFERENT branch that touches the same path, and an anchor id
  // carries no ref to tell those apart. Publishing it would send a confident,
  // well-evidenced review of code that is not in this PR.
  if (filter.headHashOf && a.witness) {
    const head = filter.headHashOf(a.witness.anchorId);
    // Two hashes from different derivations differ for a reason that has nothing to
    // do with the code, so a bare `sameBody` here reads a grammar re-vendor as "the
    // submitter pushed" and WITHHOLDS the finding — silently, because what a reader
    // never sees is what is missing from the pull request. Separated rather than
    // published: this gate exists to stop a confident review landing on code that is
    // not in this PR, and "nobody can tell" is not clearance to send it.
    if (head !== undefined && !comparableHashes(head, a.witness.bodyHash)) return "evidence-unverifiable";
    if (head !== undefined && !sameBody(head, a.witness.bodyHash)) return "evidence-moved";
  }
  return "push";
}

export type Placement =
  | { kind: "inline"; path: string; line: number; preamble?: string }
  | { kind: "body"; why: string };

/**
 * The `file:line` a comment cites as its evidence.
 *
 * The content contract requires part 2 to be "file:line plus the smallest quote
 * that proves it", so a finding that never got an explicit `line` has usually said
 * where it points anyway — in prose. Reading it back beats falling through to the
 * enclosing symbol's first hunk line, which lands on whatever the diff happened to
 * touch first.
 *
 * Ranges (`Foo.cs:40-44`) resolve to their FIRST line: the comment is about the
 * whole span and the thread has to start somewhere.
 */
export function citedLine(comment: string | undefined, file: string | undefined): number | undefined {
  if (!comment) return undefined;
  const base = file?.split("/").pop();
  let fallback: number | undefined;
  // `Name.ext:120` / `Name.ext:120-124`, optionally inside backticks or a path.
  for (const m of comment.matchAll(/([\w.-]+\.\w+):(\d+)(?:\s*[-–]\s*(\d+))?/g)) {
    const line = Number(m[2]);
    if (!Number.isFinite(line) || line <= 0) continue;
    // A citation naming THIS file wins outright; one naming another file is a
    // pointer somewhere else and must not silently reposition this comment.
    if (base && m[1] === base) return line;
    if (!base) fallback ??= line;
  }
  return fallback;
}

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
    /** The first line the change ADDED inside this finding's symbol, if any. */
    firstAddedLineOfSymbol: () => number | undefined;
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
    // An agent filing through `close_finding` could not set a line until recently,
    // but the contract made it say one in the prose. Trust that before falling back
    // to geometry.
    const cited = citedLine(a.comment, subject.file);
    if (cited !== undefined && q.commentable(subject.file, cited)) return { kind: "inline", path: subject.file, line: cited };
    // Then the first line this change ADDED inside the symbol. Context lines are by
    // definition not what the PR changed, so they are rarely a finding's subject.
    //
    // RELOCATED, and it must say so. The preamble on the last branch below explains
    // itself as "what stops the submitter reading the comment as being about the hunk
    // it happens to be pinned to" — and that is just as true here, but these two
    // branches did not carry it. Measured: a finding pinned to `AdminSidebar.tsx:264`
    // was placed on line 86 with nothing on it saying 264, because 264 is not in this
    // pull request's diff at all. `displaced` is only ever true when the annotation
    // named a line and this could not honour it, so a finding landing where it asked
    // still gets no preamble.
    const displaced = a.line !== undefined;
    const relocated = (line: number): Placement =>
      ({ kind: "inline", path: subject.file!, line, ...(displaced ? { preamble: where } : {}) });
    const added = q.firstAddedLineOfSymbol();
    if (added !== undefined) return relocated(added);
    const own = q.firstChangedLineOfSymbol();
    if (own !== undefined) return relocated(own);
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

export interface PushOptions {
  /**
   * The reviewer's own summary, addressed to the author.
   *
   * The generated body says how much was signed and which lanes it fell into, which
   * is useful and is not feedback. Without somewhere to say "here is what I think of
   * this change", the human's actual verdict had to go somewhere other than the tool
   * that holds the review.
   */
  summary?: string;
  event?: ReviewEvent;
}

export interface PushFilterExt extends PushFilter, PushOptions {
  /** Publish exactly these, whatever their disposition — the editor's approved batch. */
  ids?: string[];
  /** Override which dispositions go out unasked (default: confirmed / partial / rerated). */
  dispositions?: Disposition[];
}

export interface CommentSet {
  comments: InlineComment[];
  deferred: DeferredComment[];
  blocked: BlockedComment[];
  /**
   * Findings going out that predate witnessing, so codemap cannot confirm they were
   * written against this pull request. Not blocked — they were filed under the old
   * contract and blocking them all would be a migration disguised as a safety check
   * — but named, because "we did not check this one" is different from "this one is
   * fine" and the plan should not let them read the same.
   */
  unverified: string[];
  skipped: PushPlan["skipped"];
}

/**
 * Turn the map's annotations into what this pull request would actually receive.
 *
 * Extracted from `planPrPush` for the same reason `pushVerdict` was: every decision
 * about what lands irreversibly on somebody else's pull request lived inside a loop
 * that no test could reach, because reaching it needed a live GitHub PR. The
 * surrounding function still does the git and network work; this does the deciding,
 * against injected views of the diff and the worklist.
 */
export function buildComments(
  anns: readonly Annotation[],
  ctx: {
    inPr: (anchorId: string) => { file: string; symbol: string } | undefined;
    anchorOf: (anchorId: string) => { file: string; symbol: string } | undefined;
    pushed: ReadonlySet<string>;
    inDiff: (path: string) => boolean;
    commentable: (path: string, line: number) => boolean;
    firstHunkLine: (path: string) => number | undefined;
    firstChangedLineOfSymbol: (anchorId: string, path: string) => number | undefined;
    /** The first line the change ADDED inside that anchor, if any. */
    firstAddedLineOfSymbol: (anchorId: string, path: string) => number | undefined;
    /** The anchor's body hash at the PR head — what a finding's witness must match. */
    headHashOf: (anchorId: string) => string | undefined;
    /** Which pull request this is for; `postedRef` is scoped to one. */
    pr?: number;
    /** For asking git whether a finding's `sourceRef` is in this pull request. */
    root?: string;
    head?: string;
  },
  filter: PushFilterExt = {},
): CommentSet {
  const comments: InlineComment[] = [];
  const deferred: DeferredComment[] = [];
  const blocked: BlockedComment[] = [];
  const unverified: string[] = [];
  let resolved = 0, already = 0, notElected = 0, belowSeverity = 0, withdrawn = 0, noComment = 0, notPublishable = 0, evidenceMoved = 0, evidenceUnverifiable = 0;
  const electedOnly = filter.electedOnly !== false;
  /**
   * Was this finding raised while reading some OTHER change?
   *
   * Two signals, both definite rather than heuristic. It was published to a different
   * pull request — that is a receipt. Or it was witnessed at a ref this pull request
   * does not contain, which is what `sourceRef` records and is precisely "I was looking
   * at something else when I wrote this". A finding with no `sourceRef` is not
   * classified: absence of evidence is not evidence, and the safe answer is to leave it
   * in the main list.
   */
  const reachable = new Map<string, boolean>();
  const fromAnotherReview = (a: Annotation): boolean => {
    if (a.postedRef && ctx.pr !== undefined && a.postedRef.pr !== ctx.pr) return true;
    const ref = a.sourceRef;
    if (!ref || ref === WORK_REF || !ctx.head || !ctx.root) return false;
    let hit = reachable.get(ref);
    if (hit === undefined) {
      // `isAncestor` shells out, so this is memoised per REF — a store's findings share
      // very few of them, and the uncached version was one `git` per finding.
      hit = isAncestor(ctx.root, ref, ctx.head);
      reachable.set(ref, hit);
    }
    return !hit;
  };
  const ids = filter.ids?.length ? new Set(filter.ids) : undefined;
  const { pushed, inDiff, commentable, firstHunkLine } = ctx;

  for (const a of anns) {
    if (a.target.kind !== "anchor") continue;
    if (ids && !ids.has(a.id)) continue;                   // an explicit batch is exactly that
    const w = ctx.inPr(a.target.id);

    // A finding whose anchor is not in this PR is normally none of its business —
    // the map is full of them. But one the human ELECTED, or gave a publishPath, is
    // a deliberate act, and §4.3 is the common case rather than an error: the
    // witness findings were a fail-open predicate in a file the branch never touched
    // and a missing registration, which is an absence and has no line anywhere.
    const claimed = !w && (isElected(a) || !!a.publishPath) && !a.resolved && !a.withdrawn
      && !pushed.has(a.id) && !(a.postedRef && (ctx.pr === undefined || a.postedRef.pr === ctx.pr));
    if (!w && !claimed) continue;

    const verdict = pushVerdict(a, w ? true : claimed, pushed, {
      electedOnly, minSeverity: filter.minSeverity, dispositions: filter.dispositions, ids,
      headHashOf: ctx.headHashOf, pr: ctx.pr,
    });
    if (verdict === "not-in-pr") continue;
    if (verdict === "resolved") { resolved++; continue; }
    if (verdict === "already-pushed") { already++; continue; }
    if (verdict === "withdrawn") { withdrawn++; continue; }
    if (verdict === "not-elected") { notElected++; continue; }
    if (verdict === "below-severity") { belowSeverity++; continue; }
    if (verdict === "not-publishable") { notPublishable++; continue; }

    const anc = ctx.anchorOf(a.target.id);
    const subject = { file: w?.file ?? anc?.file, symbol: w?.symbol ?? anc?.symbol };

    if (verdict === "evidence-moved") {
      evidenceMoved++;
      blocked.push({
        annotationId: a.id, severity: a.severity, file: subject.file, symbol: subject.symbol, label: labelOf(a),
        why: `written against a different version of this code${a.sourceRef && a.sourceRef !== "@work" ? ` (${a.sourceRef.slice(0, 12)})` : a.sourceRef === "@work" ? " (the working tree, not this pull request)" : ""}. Re-read it at this PR's head and revise — or, if it describes another branch that touches the same file, it belongs on that one.`,
              ...(fromAnotherReview(a) ? { elsewhere: { pr: a.postedRef?.pr, ref: a.sourceRef } } : {}),
});
      continue;
    }

    if (verdict === "evidence-unverifiable") {
      evidenceUnverifiable++;
      blocked.push({
        annotationId: a.id, severity: a.severity, file: subject.file, symbol: subject.symbol, label: labelOf(a),
        why: "this build cannot compare the witness to the code on this pull request — the two hashes were "
          + "derived differently (a hash-scheme bump, or a re-vendored grammar). Nothing here says the code "
          + "moved. Re-read it at this PR's head and re-witness, and it will publish.",
              ...(fromAnotherReview(a) ? { elsewhere: { pr: a.postedRef?.pr, ref: a.sourceRef } } : {}),
});
      continue;
    }

    if (verdict === "no-comment") {
      noComment++;
      blocked.push({
        annotationId: a.id, severity: a.severity, file: subject.file, symbol: subject.symbol, label: labelOf(a),
        why: "no `comment` — write the submitter-facing version (what is broken, the file:line proving it, the ask). Publishing `text` would send the investigation.",
              ...(fromAnotherReview(a) ? { elsewhere: { pr: a.postedRef?.pr, ref: a.sourceRef } } : {}),
});
      continue;
    }

    const place = placeAnnotation(a, subject, {
      inDiff, commentable, firstHunkLine,
      firstAddedLineOfSymbol: () => (w ? ctx.firstAddedLineOfSymbol(a.target.id, w.file) : undefined),
      firstChangedLineOfSymbol: () => (w ? ctx.firstChangedLineOfSymbol(a.target.id, w.file) : undefined),
    });

    if (!a.witness) unverified.push(a.id);

    if (place.kind === "inline") {
      const cites = citedLine(a.comment, subject.file);
      comments.push({
        path: place.path, line: place.line, side: "RIGHT", annotationId: a.id,
        body: renderAnnotation(a, subject.symbol ?? place.path, place.preamble),
        // Only when it disagrees, and only when the comment lands on its own file —
        // a §4.3 comment placed elsewhere cites its real subject on purpose, and the
        // preamble already says so.
        ...(cites !== undefined && cites !== place.line && place.path === subject.file ? { citesLine: cites } : {}),
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
      blocked.push({
        annotationId: a.id, severity: a.severity, file: subject.file, symbol: subject.symbol,
        label: labelOf(a), why: place.why,
        ...(fromAnotherReview(a) ? { elsewhere: { pr: a.postedRef?.pr, ref: a.sourceRef } } : {}),
      });
    }
  }
  return { comments, deferred, blocked, unverified, skipped: { alreadyPushed: already, resolved, notElected, belowSeverity, withdrawn, noComment, notPublishable, evidenceMoved, evidenceUnverifiable } };
}

/**
 * The review body a verdict posts — the one artefact of this whole surface that a
 * SUBMITTER reads, which is why it is a pure function with a test rather than a string
 * join buried in `planPrPush`.
 *
 * It was buried, and the defect that produced this shape is the reason: markdown reads a
 * line of text with `---` directly beneath it as a SETEXT HEADING, so the reviewer's own
 * summary rendered as an H2. Their words arrived at the author in 24pt — it reads as
 * shouting, from the one person the process is trying to keep civil. Nothing could have
 * caught it: `executePrPush`'s test hands in a hand-written body with the blank line
 * already in it, so the fixture was right and the producer was wrong, and the two never
 * met.
 */
export function verdictBody(v: {
  summary?: string;
  signed: number; queue: number; queueLines: number; changedLines: number;
  laneLines: string;
  blocked: number;
  deferred: { path: string; line?: number; body: string }[];
}): string {
  return [
    // The human's words first, and above the machine's. The stats are context for
    // the feedback, not the other way round.
    v.summary ?? "",
    // A BLANK LINE before the rule, and it rides on THIS element because the
    // `filter(x => x !== "")` below strips a bare "".
    v.summary ? `\n---` : "",
    `### codemap review`,
    ``,
    `**${v.signed}/${v.queue}** changed symbols signed · **${v.queueLines}** of **${v.changedLines}** changed lines in the review queue.`,
    ``,
    `| lane | lines | files | attention |`,
    `|---|---:|---:|---|`,
    v.laneLines,
    ``,
    v.blocked
      ? `<sub>${v.blocked} elected finding(s) could not be placed on this diff and were held back — they are still on the reviewer's map.</sub>`
      : "",
    ``,
    v.deferred.length
      ? [`<details><summary>${v.deferred.length} finding(s) with no diff line to sit on</summary>`, ``,
         // Each keeps its own location line, because in here they have lost the one
         // thing an inline comment gives them: a position that says what they are about.
         ...v.deferred.map((d) => [`**\`${d.path}${d.line ? ":" + d.line : ""}\`**`, ``, d.body, ``, `---`].join("\n")),
         `</details>`].join("\n")
      : "",
    ``,
    `<sub>Posted from [codemap](https://github.com/) — findings are anchored to symbols, so they survive a rebase.</sub>`,
  ].filter((x) => x !== "").join("\n");
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

  const hunks = diffHunks(root, t.refs.mergeBase, t.refs.head);
  const ranges = new Map([...hunks].map(([f, h]) => [f, h.ranges] as const));
  const commentable = (path: string, line: number) => (ranges.get(path) ?? []).some(([a, b]) => line >= a && line <= b);

  // A finding without its own line still belongs *somewhere* specific. Fall back to
  // the first line of its symbol that the diff actually touches, so the comment
  // lands on the code it is about instead of being swept into the summary. Only a
  // symbol with no changed lines at all — a body the PR never edited — defers.
  const spans = await anchorSpans(root, t.refs.head, t.worklist.filter((w) => w.change !== "removed").map((w) => ({ id: w.id, file: w.file })));
  // The first line the change ADDED inside the symbol, which is what the finding is
  // almost always about. Preferred over the hunk intersection below, whose first
  // line is often three lines of context belonging to the previous member.
  const firstAddedLine = (anchorId: string, path: string): number | undefined => {
    const s = spans.get(anchorId);
    const added = hunks.get(path)?.added;
    if (!s || !added) return undefined;
    let best: number | undefined;
    for (const n of added) if (n >= s.startLine && n <= s.endLine && (best === undefined || n < best)) best = n;
    return best;
  };
  const firstCommentableLine = (anchorId: string, path: string): number | undefined => {
    const s = spans.get(anchorId);
    if (!s) return undefined;
    for (const [a, b] of ranges.get(path) ?? []) {
      const lo = Math.max(a, s.startLine), hi = Math.min(b, s.endLine);
      if (lo <= hi) return lo;
    }
    return undefined;
  };

  // Retained anchors are unioned in: a finding whose symbol the tree no longer has
  // still knows the file and line it was about, and if the pull request touches that
  // file the comment can be placed exactly as before. Without this an orphan reports
  // as "not in this pull request", which is both wrong and unactionable.
  const allAnchors = new Map((await readAnchorStore(root)).anchors.map((x) => [x.id, x]));
  for (const [id, a] of readOrphans(root)) if (!allAnchors.has(id)) allAnchors.set(id, a);
  // The PR head's bodies, from the snapshot `prContext` already cached — so a
  // finding's witness can be checked against what this pull request actually holds
  // without another git read.
  const headBodies = new Map(((await readSnapshot(root, t.refs.head)) ?? []).map((a) => [a.id, a.bodyHash]));

  const set = buildComments(anns, {
    pr: t.pr.number,
    root, head: t.refs.head,
    headHashOf: (id) => headBodies.get(id),
    inPr: (id) => { const w = byAnchor.get(id); return w ? { file: w.file, symbol: w.symbol } : undefined; },
    anchorOf: (id) => { const x = allAnchors.get(id); return x ? { file: x.file, symbol: x.symbolPath.join(" › ") } : undefined; },
    pushed,
    inDiff: (path) => ranges.has(path),
    commentable,
    firstHunkLine: (path) => ranges.get(path)?.[0]?.[0],
    firstAddedLineOfSymbol: firstAddedLine,
    firstChangedLineOfSymbol: firstCommentableLine,
  }, filter);
  // THE COMMENT HALF, and whether it is this universe's to send at all. See
  // `PushPlan.commentPush`: with a sidecar the findings live there, and posting them
  // here as well creates a second copy that the author replies to and nobody folds
  // back. The verdict, the summary and the viewed ticks are a different act and are
  // unaffected — they report YOUR reading of the branch, which is what a pull request
  // is for.
  //
  // Suppressed AFTER the set is built rather than by skipping the build: the count is
  // what tells a reader the findings exist and where they went, and a plan that simply
  // showed nothing would be indistinguishable from a clean review.
  const sidecar = resolveSidecar(root);
  const commentPush = sidecar
    ? {
      disabled: true as const,
      suppressed: set.comments.length + set.deferred.length,
      why: `this universe has a sidecar (${sidecar.universe}), so findings are published there and not as raw `
        + "comments on the branch — `shared_findings` is where the team reads and answers them. "
        + "The verdict, the summary and the viewed ticks still post.",
    }
    : undefined;
  const { blocked } = set;
  const comments = commentPush ? [] : set.comments;
  const deferred = commentPush ? [] : set.deferred;

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

  const EVENTS: ReviewEvent[] = ["COMMENT", "APPROVE", "REQUEST_CHANGES"];
  const event = filter.event && EVENTS.includes(filter.event) ? filter.event : "COMMENT";
  const summary = filter.summary?.trim() || undefined;

  const body = verdictBody({
    summary, signed, queue,
    queueLines: t.totals.queueLines, changedLines: t.totals.changedLines,
    laneLines, blocked: blocked.length,
    deferred: deferred.map((d) => ({ path: d.path, line: d.line, body: d.body })),
  });

  const fingerprint = createHash("sha256").update(JSON.stringify([
    t.refs.head,
    // The verdict and the summary change what the author receives as much as the
    // comments do — a plan approved as COMMENT must not be published as APPROVE.
    event, summary ?? "",
    // Bodies are in, not just placements: the whole point of the plan/execute split
    // is that a human approved SPECIFIC text, and a revision between inspecting and
    // publishing changes what goes to the submitter without moving a single line.
    comments.map((c) => [c.annotationId, c.path, c.line, c.body]).sort(),
    deferred.map((d) => [d.annotationId, d.body]).sort(),
    [...viewedPaths].sort(),
    // Whether the comment half is on. Without this a plan inspected while a sidecar
    // was configured and executed after it was removed re-derives to the same hash —
    // and the identity check exists precisely so nothing publishes that nobody read.
    !!commentPush,
  ])).digest("hex").slice(0, 16);

  return {
    fingerprint,
    pr: { number: t.pr.number, title: t.pr.title, url: t.pr.url, owner: t.pr.owner, repo: t.pr.repo },
    head: t.refs.head,
    body, event, ...(summary ? { summary } : {}),
    comments, deferred, blocked, viewedPaths,
    ...(commentPush ? { commentPush } : {}),
    unverified: set.unverified,
    skipped: set.skipped,
  };
}

/** The `gh` shell-out, as a type callers can inject a fake for. See `executePrPush`. */
export type GhRunner = (args: string[], input?: string) => { ok: boolean; out: string; err: string };

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
  ctx: {
    reviewId?: number; reviewUrl?: string; gh: typeof gh; slug: string;
    /**
     * What actually went out, which is not always what the plan carried: with a
     * sidecar the comment half is suppressed at the act. Stamping a `postedRef` on a
     * finding that never left the machine would be a false receipt — and a durable
     * one, since `pushVerdict` reads it as `already-pushed` forever after.
     */
    comments: InlineComment[]; deferred: DeferredComment[];
  },
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
  for (const c of ctx.comments) {
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
  for (const d of ctx.deferred) {
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
  // Nothing to say is not a reason to open a review on someone's pull request — but
  // a VERDICT is: approving a change, or asking for work on it, is worth posting
  // with no inline comments at all. So is a summary the human wrote by hand.
  // Normalised, not trusted: a plan reaching here without one must not put
  // `event: undefined` on the wire, where GitHub rejects the whole batch.
  const event: ReviewEvent = plan.event ?? "COMMENT";
  const hasVerdict = event !== "COMMENT" || !!plan.summary;

  // ENFORCED HERE TOO, not only in the plan. `planPrPush` empties these when a sidecar
  // is configured, so a plan arriving with them is a stale one made before the sidecar
  // existed, or a payload nobody built — and this is the act, where a write-time check
  // is the only one that binds. The verdict, the summary and the viewed sync are a
  // DIFFERENT act and are deliberately untouched: they report what the reviewer signed
  // off and how clean the branch is, which is what a pull request is for.
  const sidecar = resolveSidecar(root);
  const comments = sidecar ? [] : plan.comments;
  const deferred = sidecar ? [] : plan.deferred;
  if (sidecar && (plan.comments.length || plan.deferred.length)) {
    errors.push(
      `${plan.comments.length + plan.deferred.length} comment(s) in this plan were NOT posted: this universe has a `
      + `sidecar (${sidecar.universe}), so findings are published there rather than as raw comments on the branch. `
      + "Re-derive the plan to see it without them. The verdict and viewed state were unaffected.",
    );
  }
  result.deferredInBody = deferred.length;
  const postComments = opts.comments !== false
    && (comments.length > 0 || deferred.length > 0 || hasVerdict);

  if (postComments) {
    const payload = JSON.stringify({
      commit_id: plan.head,
      body: plan.body,
      event,
      comments: comments.map((c) => ({ path: c.path, line: c.line, side: c.side, body: c.body })),
    });
    const r = gh_(["api", "--method", "POST", `repos/${slug}/pulls/${plan.pr.number}/reviews`, "--input", "-"], payload);
    if (!r.ok) {
      // A failed post must not abandon a viewed sync that was also asked for: they
      // are independent acts, and one failing is not the other's news.
      //
      // GitHub refuses APPROVE and REQUEST_CHANGES on your own pull request, and the
      // raw message ("Can not approve your own pull request") does not say that the
      // comments were lost with it — which is the part that matters here.
      const own = /own pull request/i.test(r.err);
      errors.push(own
        ? `GitHub will not let you ${event === "APPROVE" ? "approve" : "request changes on"} your own pull request, so NOTHING was posted — including the comments. Re-run as a plain comment review.`
        : `review post failed: ${r.err.slice(0, 400)}`);
    } else {
      let reviewId: number | undefined;
      try {
        const review = JSON.parse(r.out);
        result.reviewUrl = review.html_url;
        reviewId = typeof review.id === "number" ? review.id : undefined;
      } catch { /* the url and id are a nicety; the post succeeded either way */ }
      result.postedComments = comments.length;

      // Record the publish IMMEDIATELY. Everything below is more `gh` — a comment
      // fetch here, then a call per file with a 120s timeout each — and recording
      // afterwards left a window where an interrupt lost the only evidence the review
      // went out, so the next publish re-posted every inline comment on someone
      // else's pull request. The dedupe record goes down before any of it.
      await writePush(root, String(plan.pr.number), {
        annotationIds: [...comments.map((c) => c.annotationId), ...deferred.map((d) => d.annotationId)],
        viewedPaths: [],
        at: new Date().toISOString(),
        reviewUrl: result.reviewUrl,
      });

      // Then stamp each finding with where it landed. Refinement of a record that
      // already exists, so losing it costs detail rather than the dedupe itself.
      await stampPostedRefs(root, plan, { reviewId, reviewUrl: result.reviewUrl, gh: gh_, slug, comments, deferred });
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

/**
 * A review conversation on a pull request, and whether it is settled.
 *
 * Threads are what GitHub resolves — not comments. The id we store on a finding is
 * the comment's REST `databaseId`, which is a different object entirely, so the
 * thread has to be found by matching that id inside it.
 */
export interface ReviewThread {
  id: string;
  isResolved: boolean;
  resolvedBy: string | null;
  path: string | null;
  line: number | null;
  /** REST ids of the comments in it — ours is the root, replies may follow. */
  commentIds: number[];
  /**
   * The conversation itself, oldest first — including the submitter's replies.
   *
   * Fetched because a reply to a published finding is information the reviewer
   * needs and GitHub is the only place it exists. Read-only and one-directional:
   * the sidecar hosts the REVIEWERS' discussion, this brings the AUTHOR's half of
   * it back. `truncated` when the thread is longer than one page was read to.
   */
  comments: { databaseId: number; author: string | null; body: string; createdAt: string }[];
  truncated: boolean;
}

export function fetchReviewThreads(slug: string, number: number, gh_: typeof gh = gh): ReviewThread[] | { error: string } {
  const [owner, repo] = slug.split("/");
  const out: ReviewThread[] = [];
  let after: string | null = null;
  for (let page = 0; page < 40; page++) {
    const args = ["api", "graphql", "-f",
      "query=query($o:String!,$r:String!,$n:Int!,$after:String){repository(owner:$o,name:$r){pullRequest(number:$n){reviewThreads(first:50,after:$after){pageInfo{hasNextPage endCursor} nodes{id isResolved resolvedBy{login} path line comments(first:100){pageInfo{hasNextPage} nodes{databaseId author{login} body createdAt}}}}}}}",
      "-f", `o=${owner}`, "-f", `r=${repo}`, "-F", `n=${number}`];
    if (after) args.push("-f", `after=${after}`);
    const r = gh_(args);
    if (!r.ok) return { error: `gh graphql failed: ${r.err.slice(0, 300)}` };
    try {
      const t = JSON.parse(r.out).data.repository.pullRequest.reviewThreads;
      for (const n of t.nodes) {
        const nodes = (n.comments?.nodes ?? []) as { databaseId: number; author?: { login?: string }; body?: string; createdAt?: string }[];
        out.push({
          id: n.id, isResolved: !!n.isResolved, resolvedBy: n.resolvedBy?.login ?? null,
          path: n.path ?? null, line: n.line ?? null,
          commentIds: nodes.map((c) => c.databaseId).filter(Boolean),
          comments: nodes.map((c) => ({
            databaseId: c.databaseId, author: c.author?.login ?? null,
            body: c.body ?? "", createdAt: c.createdAt ?? "",
          })),
          // Said rather than hidden, for the same reason the thread LIST refuses a
          // partial read: a conversation returned as complete when it is not is a
          // claim about the part nobody looked at.
          truncated: !!n.comments?.pageInfo?.hasNextPage,
        });
      }
      if (!t.pageInfo.hasNextPage) return out;
      after = t.pageInfo.endCursor;
    } catch (e) { return { error: `could not parse gh output: ${(e as Error).message}` }; }
  }
  // Same rule as the viewed list: a partial set returned as a success is a claim
  // about the threads it never looked at.
  return { error: `pull request has more review threads than this was read to the end of (${out.length}+)` };
}

export interface ResolveSyncPlan {
  pr: number;
  /** Settled here, still an open conversation on the pull request. */
  toResolve: { annotationId: string; threadId: string; commentId: number; path: string | null; line: number | null; label: string }[];
  /** Settled on the pull request, still open here — the input to a pull. */
  toClose: { annotationId: string; threadId: string; commentId: number; resolvedBy: string | null; label: string }[];
  /** Already agreeing. */
  inSync: number;
  /** Posted findings whose thread could not be found — deleted, or outside this PR. */
  unmatched: string[];
}

/**
 * Compare what codemap considers settled against what the pull request does.
 *
 * Only ever OUR comments: a finding without a `postedRef` for this PR has no thread
 * here, and a thread we did not post is somebody else's conversation. Pure, so both
 * directions can be inspected before anything is written anywhere.
 */
export function planResolveSync(anns: readonly Annotation[], threads: readonly ReviewThread[], pr: number): ResolveSyncPlan {
  const byComment = new Map<number, ReviewThread>();
  for (const t of threads) for (const c of t.commentIds) if (!byComment.has(c)) byComment.set(c, t);

  const plan: ResolveSyncPlan = { pr, toResolve: [], toClose: [], inSync: 0, unmatched: [] };
  for (const a of anns) {
    const ref = a.postedRef;
    if (!ref || ref.pr !== pr || !ref.commentId) continue;
    const t = byComment.get(ref.commentId);
    if (!t) { plan.unmatched.push(a.id); continue; }
    const settledHere = !!a.resolved;
    if (settledHere === t.isResolved) { plan.inSync++; continue; }
    if (settledHere) plan.toResolve.push({ annotationId: a.id, threadId: t.id, commentId: ref.commentId, path: t.path, line: t.line, label: labelOf(a) });
    else plan.toClose.push({ annotationId: a.id, threadId: t.id, commentId: ref.commentId, resolvedBy: t.resolvedBy, label: labelOf(a) });
  }
  return plan;
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

export interface ResolveSyncResult {
  resolved: string[];
  closed: string[];
  skipped: { annotationId: string; why: string }[];
  errors: string[];
}

/**
 * Mark settled conversations settled on the pull request.
 *
 * The workflow this is for: the submitter fixed it and did not close the comment, so
 * the thread sits open on their PR long after the finding stopped being live here.
 * Only threads rooted in a comment codemap posted are touched — the `postedRef`
 * match is what guarantees that.
 *
 * Resolving only. A finding reopened here does NOT reopen the conversation there:
 * un-resolving a thread the submitter closed would be arguing with them through a
 * state change rather than a sentence, and that is a reply, not a sync.
 */
export async function pushResolvedToGitHub(
  root: string, plan: ResolveSyncPlan, slug: string,
  opts: { gh?: typeof gh } = {},
): Promise<ResolveSyncResult> {
  const gh_ = opts.gh ?? gh;
  const out: ResolveSyncResult = { resolved: [], closed: [], skipped: [], errors: [] };
  for (const t of plan.toResolve) {
    const r = gh_(["api", "graphql", "-f",
      "query=mutation($t:ID!){resolveReviewThread(input:{threadId:$t}){thread{id isResolved}}}",
      "-f", `t=${t.threadId}`]);
    if (r.ok) out.resolved.push(t.annotationId);
    else out.errors.push(`resolve ${t.path ?? "?"}${t.line ? ":" + t.line : ""}: ${r.err.slice(0, 160)}`);
  }
  void root;
  return out;
}

/**
 * Learn that a conversation was settled on the pull request.
 *
 * Who resolved it matters, and is why this is not symmetric with the push. A pull
 * request's AUTHOR can resolve your comment, and doing so is not your agreement that
 * it is closed — `resolved` is the human reviewer's act, the same distinction that
 * keeps GitHub's viewed tick from importing as `signed`. So by default this accepts
 * only resolutions by the account that posted the review, and anything closed by
 * somebody else is reported rather than applied.
 */
export async function pullResolvedFromGitHub(
  root: string, plan: ResolveSyncPlan,
  deps: { resolveAnnotation: (root: string, id: string, resolved: boolean) => Promise<unknown> },
  opts: { viewer?: string | null; anyone?: boolean; dryRun?: boolean } = {},
): Promise<ResolveSyncResult> {
  const out: ResolveSyncResult = { resolved: [], closed: [], skipped: [], errors: [] };
  for (const t of plan.toClose) {
    const mine = opts.viewer && t.resolvedBy && t.resolvedBy === opts.viewer;
    if (!opts.anyone && !mine) {
      out.skipped.push({
        annotationId: t.annotationId,
        why: `resolved on GitHub by ${t.resolvedBy ?? "someone"}, not by you — closing it here would record their click as your agreement. Pass --anyone to accept it.`,
      });
      continue;
    }
    if (!opts.dryRun) await deps.resolveAnnotation(root, t.annotationId, true);
    out.closed.push(t.annotationId);
  }
  return out;
}

/** The login `gh` is authenticated as — who "I resolved it myself" means. */
export function ghViewer(gh_: typeof gh = gh): string | null {
  const r = gh_(["api", "user", "--jq", ".login"]);
  return r.ok ? r.out.trim() || null : null;
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
