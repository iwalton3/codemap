import { registerKinds, registerReferences, tipReader, type ScopeReader } from "./eventlog.js";
import { RETIRED_REPAIR_KINDS } from "./repair-records.js";
import { collector, foldJudged, registerReport, staleRevision, wasOf, type RefusalClass, type Refusal } from "./validation.js";
import { rulingReferences } from "./ruling-references.js";
import { foldRepairRecords, type RepairFindingMap } from "./repair-records.js";
import { foldRepairVerification, type RepairVerificationApplication } from "./repair-verification.js";
/**
 * Findings on the event log — the payload the sidecar exists for.
 *
 * A finding has three INDEPENDENT axes, because the old `Disposition` enum was
 * doing two jobs at once (`open`/`confirmed` are lifecycle; `partial`/`rerated`
 * are verdicts about the report's accuracy) and collapsing them lost the thing
 * worth measuring:
 *
 *   promotion    a latch — "this deserves team-wide human attention". NOT the same
 *                as `posted`: promotion is a sidecar concept and does not gate
 *                anyone else's agent from triaging.
 *   corroboration a grow-only set, one entry per actor, NEVER collapsed to a scalar.
 *                The reason to run several models is that disagreement is the
 *                signal; a single `accuracy` field would destroy exactly the data
 *                being collected.
 *   state        the lifecycle, with a DERIVED ack gate (`needsHumanAck`).
 *
 * `needsHumanAck` is derived rather than stored because it is an OR over a latch
 * and a grow-only set: two people computing it from different pulls always agree,
 * and there is no field for them to race on.
 *
 * ## The fold is the authority
 *
 * Every rule here is enforced when FOLDING, not only when writing. A write-time
 * check protects the honest writer and nobody else — events arrive from other
 * people's clients, which may be older, buggy, or wrong. So an event that is not
 * permitted at the point it applies is ignored by every reader, identically,
 * because every reader sees the same order. Write-time checks still exist, but
 * only to produce a good error instead of a silently dropped event.
 */

import { ISO_DATE, type Actor, type BugSeverity, type BugWitness } from "./schema.js";
import { isAgentActor, isIndependent, isErrorIndependent, reviewerKey } from "./identity.js";
import { mintId, readScope, readSets, registerDoor, type LogEvent, type ReadSets } from "./eventlog.js";
import { emitEvent } from "./write.js";
import { issueClaimHash, validateApplicationCapsule, type ApplicationAttempt } from "./ruling-application.js";

/**
 * Lifecycle. `issued` is an agent's proposal; `created` is a claim somebody stands
 * behind. `created` is the RATCHET FLOOR for agents — past it, only a person closes.
 */
export type FindingState = "issued" | "created" | "invalid" | "refuted" | "resolved" | "withdrawn" | "accepted";

/** Terminal states — a finding here is done, and shows struck through. */
export const CLOSED_STATES: readonly FindingState[] = ["invalid", "refuted", "resolved", "withdrawn", "accepted"];
export const isClosed = (s: FindingState): boolean => CLOSED_STATES.includes(s);

/**
 * A reviewer's opinion of a finding.
 *
 * `partial` is the one triage reaches for constantly and could not say. The old
 * annotation store had it as a `disposition` — "real in part; `comment` states the part
 * that is real, in full" — and the canonical store's three verdicts had no home for it,
 * so it landed in prose that nothing can filter on. It is the commonest honest answer:
 * the defect is real, the stated impact is not, or two of the three reads it names are
 * unbounded and the third is fine.
 *
 * It STANDS BEHIND the finding — `partial` means real, with a correction — so it counts
 * everywhere `confirm` counts: the tier, the human queue, and the gates on closing and
 * re-rating. What it does not do is claim the finding is right as filed, which is why it
 * is its own word rather than a `confirm` with a caveat in the rationale.
 */
export type Verdict = "confirm" | "partial" | "refute" | "unsure";

/**
 * Is this finding rated differently from how it was filed?
 *
 * `rerated` was a `disposition` in the old store — "real, but the severity or impact
 * differs from as-filed" — and it is the one triage question that today needs reading
 * every revision list to answer. DERIVED, never stored: `revisions` already records the
 * `was` of every severity change, so a second field would be a copy that can disagree
 * with its source.
 *
 * The EARLIEST recorded `was` is the filed value, not the latest — a finding rated
 * medium, raised to critical and dropped back to medium was not re-rated, and comparing
 * against the previous value would say it was.
 */
export function reratedFrom(f: Pick<SharedFinding, "severity" | "revisions">): string | undefined {
  for (const r of f.revisions ?? []) {
    if (!("severity" in r.was)) continue;
    const filed = r.was.severity as string | undefined;
    return filed === f.severity ? undefined : (filed ?? "unset");
  }
  return undefined;
}

/** Verdicts that mean "this is real" — `partial` says so about part of it. */
export const STANDS_BEHIND: readonly Verdict[] = ["confirm", "partial"];
export const isStandingBehind = (v: Verdict): boolean => STANDS_BEHIND.includes(v);

/**
 * What a request asks a human to do. Anyone may ask, at any state.
 *
 * `withdraw` is the one that is not a verdict. The other four say something about
 * whether the claim is TRUE; withdraw says the record should go while the claim stands —
 * a duplicate, most often, which is the routine outcome of two reviewers landing on one
 * anchor. Without it a true-but-duplicate finding had to be queued as `invalidate`
 * ("this was not a real finding") or `refute` (a false verdict on the record, which by
 * the comment contract also publishes a withdrawal to the submitter). `withdrawn` was
 * already a terminal state and a `doubted` tier; the gap was only that an agent had no
 * word for it.
 */
// Keep the historical reopen ask for older records; new agent reopens are explicit
// acts against the closure the agent observed.
export const ASKS = ["promote", "invalidate", "refute", "resolve", "withdraw", "reopen"] as const;

/**
 * The ask that corresponds to closing into each state, so an agent's attempt to close
 * becomes a request rather than an error. `issued`/`created` are not closes and have no
 * ask — an agent may move a finding back to the open pile itself.
 */
export const ASK_FOR_STATE: Partial<Record<FindingState, Ask>> = {
  invalid: "invalidate", refuted: "refute", resolved: "resolve", withdrawn: "withdraw",
};

/** Historical ask vocabulary, retained for existing requests. */
export const REOPEN_STATES: readonly FindingState[] = ["created", "issued"];
export type Ask = (typeof ASKS)[number];

/**
 * ONE place, because the fold must accept exactly what the writers emit and the two
 * folds (findings and bugs) had the list spelled out separately. A word added to the
 * type but not to a guard is an event every reader silently drops.
 */
export const isAsk = (v: unknown): v is Ask => ASKS.includes(v as Ask);

export interface Corroboration {
  actor: Actor;
  verdict: Verdict;
  at: string;
  rationale: string;
  /**
   * The actor is not the finding's author. Recorded rather than derived at read
   * time because "how many independent opinions does this have" is the number the
   * queue is ranked by, and it must not change meaning as the fold is re-run.
   */
  independent: boolean;
  /**
   * The actor is unlikely to share the author's blind spots — a different person, a
   * different vendor's harness, or a person checking an agent. See
   * `isErrorIndependent`.
   *
   * Beside `independent` rather than instead of it because they answer different
   * questions and both are worth having: that one asks whether a SECOND PERSON
   * agreed, which is about authority; this one asks whether the agreement is worth
   * anything as evidence. Where one reviewer dispatches every agent, `independent`
   * is always false and only this can vary.
   *
   * Optional: derived from actor fields that historical records do not carry, so an
   * old corroboration reads `undefined` — not-established, which is not the same
   * claim as false.
   */
  errorIndependent?: boolean;
  /**
   * The commit the reviewer was standing on when they formed this verdict.
   *
   * A verdict is a claim about CODE, and nothing recorded which code. A triage pass on
   * `Acme.React` re-read every finding against whatever `@work` pointed at — a branch
   * that predated the pull request under review — so five findings were refuted for
   * being "not present" when they were merged to main the next day. One of the
   * refutations is exactly inverted from what the code says. See
   * `docs/finding-event-shape-audit.md`.
   *
   * Absent on verdicts recorded before this existed, and on any reviewer whose tree has
   * no commits at all. `staleVerdicts` reports what it can check.
   */
  ref?: string;
}

/**
 * What HAPPENED about a finding, as opposed to whether it is true.
 *
 * A second axis, and its absence was a live defect rather than a gap. `disposition` /
 * corroboration say whether the claim holds; nothing said whether anybody had acted on
 * it. So when a submitter fixed eleven of twelve findings the map could not record it,
 * and the workaround in use was to revise them to `refuted` — marking real, correctly
 * filed, now-fixed defects as FALSE POSITIVES. That poisons the one question this data
 * is for: "which of my findings were wrong?" then silently contains the ones that were
 * most right.
 *
 * `fixed-on-branch` and `fixed-on-default` are separate because the difference is
 * load-bearing and was previously a sentence somebody had to read: a fix living on an
 * unmerged branch means the mainline still carries the defect, which is exactly when a
 * linked bug must NOT be closed.
 */
export const REMEDIATIONS = ["outstanding", "fixed-on-branch", "fixed-on-default", "deferred", "wont-fix"] as const;
export type Remediation = (typeof REMEDIATIONS)[number];
export const isRemediation = (v: unknown): v is Remediation => REMEDIATIONS.includes(v as Remediation);

export interface FindingComment {
  id: string;
  actor: Actor;
  at: string;
  body: string;
  inReplyTo?: string;
  /** Set only when this reply was deliberately sent to the pull request. */
  publishedRef?: ExternalRef;
}

/** Where this finding lives outside codemap. See the four uses of this shape. */
export interface ExternalRef {
  system: "github" | "jira" | string;
  key?: string;
  url?: string;
  at: string;
  by: Actor;
}

export interface SharedFinding {
  id: string;
  target: { kind: "anchor" | "node"; id: string };
  text: string;
  comment?: string;
  severity?: BugSeverity;
  category?: string;
  line?: number;
  witness?: BugWitness;
  sourceRef?: string;
  /**
   * The branch this finding was filed against before its pull request existed. Carried on
   * the `created` event because a branch scope is a hash of the name (see review-target.ts).
   */
  branch?: string;
  /**
   * The ref the filer actually NAMED, when it was an explicit `origin/` spelling.
   *
   * `normalizeBranch` strips `origin/`, so `origin/feature` and `feature` produce the same
   * key and land in the same scope. Since Ruling 11 they can be witnessed at different
   * commits, and without this the row cannot say which spelling produced which — the only
   * trace would be `sourceRef`, which no surface presents as "you asked for origin".
   */
  namedRef?: string;
  author: Actor;
  createdAt: string;
  /**
   * What the LOCAL row said about who filed it and when, carried as the publisher's
   * claim — the shape `SharedBug.filedAt` already uses, and for the same reason.
   *
   * Only a one-time migration sets it. `author` and `createdAt` come from the event, and
   * must: the event actor is who is accountable for the publication, and an event that
   * asserted somebody else wrote it would be exactly the false provenance this design
   * refuses. But the pre-sidecar record HAD an author — often a legacy label like
   * `agent:pr-first-pass` rather than a principal — and dropping it silently would lose
   * the only evidence of where the finding came from. So it is kept, and kept under a
   * name that says whose claim it is.
   */
  filed?: { by: string; at: string };

  state: FindingState;
  corroboration: Corroboration[];
  thread: FindingComment[];

  promotion?: { at: string; by: Actor };
  posted?: ExternalRef;
  upstream?: ExternalRef;
  /** The bug this became. Both records survive; see `finding.promotedToBug`. */
  bug?: string;

  /**
   * What happened about it — see `Remediation`. An OBSERVATION about the code, not a
   * claim about the report, which is why anyone may record one at any time and why it
   * is its own event rather than a revision: it adds information and destroys none, so
   * the gate that protects somebody's confirmed wording has nothing to protect here.
   */
  remediation?: { state: Remediation; by: Actor; at: string; detail?: string; ref?: string };

  /**
   * The finding is real, it is not being fixed now, and it WILL come back.
   *
   * The state between "blocks the merge" and "confirmed bug", which had no record. A
   * finding that was neither severe enough to hold a pull request nor worth promoting
   * simply stayed open on a pull request that merged, and nothing ever looked at it
   * again: measured at 97 such findings across two universes, 46 of them still exactly
   * true of the trunk. The workaround people reached for is in the data — a bug minted
   * with the detail "deferred to bug_7a5b29e71285 so it survives the PR closing" — which
   * is what dilutes the bug queue into noise. The backlog is where those go instead,
   * and NOTHING here promotes anything to a bug.
   *
   * `until` is a release condition and it is REQUIRED, for the reason `acknowledgements`
   * gives about `revalidateBy`: a linked ticket may be evidence but never the condition,
   * because a ticket closed as won't-do, moved or deleted leaves the record asleep
   * permanently and silently. Every one of the seven deferrals in the measured data had
   * an empty `ref` and no date at all — the release condition lived in prose, so there
   * was none.
   *
   * `witness` is the SECOND half of the condition and is snapshotted here rather than
   * read off the finding: `SharedFinding.witness` is from filing time, so a deadline keyed
   * on it would wake instantly whenever the code moved between filing and the decision
   * to backlog it — the common case, since backlogging usually follows an investigation.
   * This one is the code as it stood when somebody said "not now", so drift against it
   * means somebody is editing the exact code that decision was about.
   *
   * Principal-granted, like `debt`. An agent may ask (`ASKS`), never grant: with a
   * backlog this size, deferral is the cheapest way to clear a queue, and the fold drops
   * an agent's attempt as well as the tool refusing it.
   */
  backlogged?: {
    /** ISO date. The release condition, and a required one. */
    until: string;
    /** The code when it was backlogged — drift against THIS wakes it early. */
    witness?: BugWitness;
    /** Why it is not being fixed now. A record of a decision, not a mute button. */
    reason: string;
    by: Actor;
    at: string;
    /** Evidence — a Jira issue, a bug. Never the release condition. */
    ref?: ExternalRef;
  };

  /**
   * This finding's `witness` was attached AFTER the fact, so it cannot testify about the
   * code at filing time — only from `at` onward.
   *
   * Findings with no witness at all cannot be judged against the code by anything, and
   * they were 19% of the measured backlog (a bounded episode: one writer path, three
   * pull requests, two days in 2026-08, no model and no `sourceRef` recorded). Re-attaching
   * is evidence work rather than a disposition, so an agent may do it — but a retro
   * witness must never be mistaken for one captured when the claim was made, which is
   * what this marks.
   */
  witnessAttached?: { by: Actor; at: string };

  assignment?: { kind: "investigate" | "fix" | "answer"; by: Actor; at: string; note?: string };
  /**
   * The LATEST report, kept as a field because every reader wants "where did this get
   * to" without walking a list. `outcomes` is the real record.
   */
  outcome?: { result: "fixed" | "answered" | "declined"; detail: string; files?: string[]; by: Actor; at: string };
  /**
   * Every report, oldest first. APPEND-ONLY, because rounds are real.
   *
   * This was a single last-write-wins field, and a multi-round verification overwrote
   * itself: on `Acme.API` PR 270, 37 of 59 reports were unreachable — 53k characters of
   * investigation, including the verification that mattered, buried under a later
   * bookkeeping note. Measured in `docs/finding-event-shape-audit.md`. The fold keeps
   * every event now, and the surfaces render the history rather than the last line.
   */
  outcomes?: NonNullable<SharedFinding["outcome"]>[];
  /** An outstanding ask waiting on a person. One at a time; a second replaces it. */
  /** The open ask, if one is outstanding. Cleared when a person acts on it. */
  pending?: { ask: Ask; by: Actor; at: string; rationale: string };
  /**
   * Every ask ever made, and what became of it. APPEND-ONLY.
   *
   * `pending` alone is a banner that vanishes the moment somebody accepts it, taking
   * the REASON with it — so a finding closed on an agent's recommendation kept no record
   * of the recommendation, and "why is this resolved" was answerable only from the raw
   * log. The settlement is stamped in place rather than appended, because an ask has one
   * outcome and a second entry for it would read as a second ask.
   */
  asks?: { ask: Ask; by: Actor; at: string; rationale: string; settled?: { as: "applied" | "superseded" | "declined"; by: Actor; at: string; state?: FindingState; reason?: string } }[];
  /**
   * How it ended. `grantedAsk` is the request this close granted, if it granted one —
   * so "why is this resolved" is answerable from the record without reading the log,
   * and the agent that did the work keeps its attribution.
   */
  applications?: ApplicationAttempt[];
  repairClosure?: { requestId: string; applicationId: string; outcome: "fixed" | "factually-refuted" | "invalid"; attention: string[] };
  /** Last accepted opening act; captured by a ruling application. */
  openEpoch?: string;
  closed?: {
    /** Event whose closure is currently in force; a reopen must name this exact act. */
    eventId?: string;
    at: string; by: Actor; reason: string;
    grantedAsk?: { ask: Ask; by: Actor; at: string; rationale: string };
  };

  revisions: { at: string; by: Actor; was: Record<string, unknown> }[];
  /**
   * The target moved, or went away.
   *
   * A finding whose anchor is not in your checkout is usually not your problem —
   * it is on another branch, and `classifyCitations` works that out without asking
   * anyone. This records the residue: a symbol that was renamed (`moved`, with
   * where to) or genuinely removed (`gone`).
   *
   * An agent may PROPOSE either; applying one is a person's act, because
   * re-pointing a finding at the wrong symbol is the false-provenance failure
   * `witness`/`sourceRef` exist to prevent, and a silent mis-target is worse than
   * a finding nobody has triaged.
   */
  relocation?: { kind: "moved" | "gone"; to?: string; by: Actor; at: string; rationale: string; applied?: boolean };
  /**
   * Where this machine's copy came from. Set by the STORE from the row's
   * `source_scope`, never by the fold — the fold's output describes the finding, not
   * this clone's provenance for it, and a value the fold never produced would break
   * the projection round trip. Absent means a local finding: filed here, with no
   * sidecar configured, and not yet published.
   */
  origin?: { scope: string };
  /**
   * The pull request. Set by the STORE from the row's own column, on the same rule as
   * `origin`. For a fold-owned finding it is `prOfScope(source_scope)`; for a local
   * one it is what the filer supplied. Stored either way — the association is never
   * inferred from a worklist again.
   */
  pr?: string;
}

/**
 * The pull request a findings scope is about — the inverse of `findingScope(prKey(...))`.
 *
 * The association is STRUCTURAL: it is the scope, not a field on the event, which is
 * why no shared finding has ever been filed against the wrong pull request. The
 * canonical `findings` table lifts it into a column so a reader has it without parsing
 * a path, and this is where that column's value comes from.
 *
 * `lastIndexOf`, not a split: a universe key contains slashes of its own
 * (`acme/api/pr-264`), so the first `/pr-` is not reliably the last one.
 *
 * TOTAL on purpose, and the fallback is not decoration. `findingScope` takes whatever
 * key the caller scopes by: `ops` always passes the universe-qualified `prKey`, but a
 * bare `findingScope(264)` is legal and several tests use it. Returning `""` for that
 * shape would put empty strings in a NOT NULL column, which reads as a value rather
 * than as the failure it is.
 */
export function prOfScope(scope: string): string {
  // The tail must be a whole segment. Without that a key that itself contained
  // `/pr-` — which `prKey` now refuses, but old shards and hand-written events are
  // not bound by it — would have its own tail picked out and indexed as the pull
  // request. `foo/pr-999` reading as PR 999 is worse than reading as nothing.
  const m = /\/pr-([^/]+)$/.exec(scope);
  if (m) return m[1]!;
  const j = scope.indexOf("/");
  return j < 0 ? scope : scope.slice(j + 1);
}

/**
 * `pr` is whatever key the caller scopes by. `ops` passes a UNIVERSE-QUALIFIED one
 * (`acme/api/pr-264`) because one sidecar serves several repos and PR 264 exists
 * in more than one of them — and two universes that share a submodule have
 * byte-identical anchor ids, so an unqualified scope would cross-contaminate the
 * findings that are hardest to notice being wrong.
 */
export const findingScope = (pr: number | string): string => `findings/${pr}`;

/**
 * What the ratchet reads, and nothing else.
 *
 * A shared BUG carries the same three fields and the same lifecycle. Sharing the
 * FUNCTIONS rather than copying the shape is what stops one lifecycle becoming two
 * that drift — `docs/plan-sharing-the-rest.md` §2 asks for exactly this reuse.
 */
export interface Ratcheted {
  state: FindingState;
  promotion?: { at: string; by: Actor };
  corroboration: Corroboration[];
  /** The bug it became. Once it has one, the bug is what asks — see `needsHumanAck`. */
  bug?: string;
}

/**
 * Where a finding sits in the reading order: what needs a decision first.
 *
 * The list is read top-down by somebody deciding what to act on, so the order is by
 * HOW SETTLED each finding is, not by when it was filed:
 *
 *   0 `confirmed`   — open, and somebody stood behind it.
 *   1 `unconfirmed` — open, nobody has weighed in yet.
 *   2 `doubted`     — refuted or withdrawn, or open with a refuting verdict on it:
 *                     probably not real, but nobody has closed it out.
 *   3 `settled`     — closed. Collapsed by the surfaces that render it.
 *
 * A finding with BOTH a confirm and a refute ranks `confirmed`, deliberately: two
 * reviewers disagreeing is the case most needing a person, and burying it under the
 * unconfirmed ones is the opposite of what this ordering is for.
 *
 * `refuted` and `withdrawn` are terminal in `FindingState`, but they are kept out of
 * `settled` because they are the two a person most often reopens — "we decided this
 * was not real" is worth seeing, where "we fixed it" is not.
 */
export type FindingTier = "confirmed" | "unconfirmed" | "doubted" | "settled";

const TIER_ORDER: Record<FindingTier, number> = { confirmed: 0, unconfirmed: 1, doubted: 2, settled: 3 };

export function findingTier(f: Pick<SharedFinding, "state" | "corroboration"> & { promotion?: unknown }): FindingTier {
  if (f.state === "resolved" || f.state === "invalid" || f.state === "accepted") return "settled";
  if (f.state === "refuted" || f.state === "withdrawn") return "doubted";
  // PROMOTION IS WEIGHING IN, and it outranks a verdict because a person did it. It
  // means "this is real, the team should know" — so a promoted finding reading
  // `unconfirmed` ("filed, and nobody has weighed in") said the opposite of what had
  // just happened, and hid it in the pile the reader is told is untriaged. Ahead of the
  // corroboration checks deliberately: a person promoting outranks an agent refuting.
  if (f.promotion) return "confirmed";
  if (f.corroboration.some((c) => isStandingBehind(c.verdict))) return "confirmed";
  if (f.corroboration.some((c) => c.verdict === "refute")) return "doubted";
  return "unconfirmed";
}

/**
 * Rank within a tier: severity, then oldest first.
 *
 * Oldest first rather than newest, because within one tier the question is which has
 * been waiting longest — a newest-first list quietly buries whatever nobody got to.
 */
const SEVERITY_ORDER: Record<string, number> = { critical: 0, high: 1, medium: 2, low: 3 };

export function byReadingOrder(
  a: Pick<SharedFinding, "state" | "corroboration" | "severity" | "createdAt" | "promotion">,
  b: Pick<SharedFinding, "state" | "corroboration" | "severity" | "createdAt" | "promotion">,
): number {
  return TIER_ORDER[findingTier(a)] - TIER_ORDER[findingTier(b)]
    || (SEVERITY_ORDER[a.severity ?? ""] ?? 4) - (SEVERITY_ORDER[b.severity ?? ""] ?? 4)
    || a.createdAt.localeCompare(b.createdAt);
}

/** Derived, never stored — an OR over a latch and a grow-only set, so it cannot race. */
export function needsHumanAck(f: Ratcheted): boolean {
  // A finding that became a BUG is not asking any more. `finding.promotedToBug` already
  // says so in words — "the finding stops asking for a decision; its successor is asking"
  // — and this did not implement it, so a promoted finding kept its ack badge, kept
  // counting in the PR page's open count and in the dashboard's `findings.waiting`, and
  // was unclearable except by asserting something about the code nobody had checked.
  if (f.bug) return false;
  return !!f.promotion || f.corroboration.some((c) => isStandingBehind(c.verdict));
}

/**
 * May an agent BURY this finding — move it to a closed state — without asking?
 *
 * This is the only thing an agent may not do on its own, and it is deliberately not
 * `needsHumanAck`. That predicate does two unrelated jobs: it populates the human queue
 * ("somebody needs to look at this") and it locked agents out ("nobody may improve this
 * any more"). Those are opposites in effect — the moment a finding mattered enough to be
 * queued, the agent best placed to sharpen it was shut out, which is what produced
 * fifteen thread comments reading "Submitter-facing replacement (supersedes the current
 * wording)" against three actual revisions. See `docs/finding-event-shape-audit.md`.
 *
 * Two conditions, and neither is promotion:
 *
 * - **Somebody CONFIRMED it.** A verdict is a person putting their name to "this is
 *   real", and one wrong call losing it is not recoverable from anywhere.
 * - **A PERSON filed it.** Their own report is not an agent's to retire, whatever the
 *   agent later concluded.
 *
 * Promotion is deliberately absent. It means "this is real, the team should know" — a
 * measure of triage, and an optional one. Gating on it made saying a finding matters the
 * act that froze it.
 */
export function agentClosureNeedsAck(f: Ratcheted & { author?: Actor }): boolean {
  return f.corroboration.some((c) => isStandingBehind(c.verdict))
    || (!!f.author && !isAgentActor(f.author));
}

/**
 * Whether `actor` may move a BUG to `next` right now — findings use `mayTransitionFinding`
 * (plan 3.3), and this is the agent close path bugs keep until the bug follow-up.
 *
 * The whole ratchet, in one place, so the fold and the write path cannot drift apart.
 * A person may do anything.
 *
 * **The gate is CONFIRMATION, not who filed it.** An agent may close a finding nobody
 * has stood behind — that is triage, and making it a person's job means a queue of
 * false positives nobody has time to clear. Once anything confirms one, or somebody
 * promotes it, only a person closes: losing a confirmed finding to one wrong call is
 * the failure the gate exists for, and it is not recoverable from anywhere.
 *
 * It used to key on `f.state !== "issued"`, which is the same rule for an agent's OWN
 * findings and the wrong one for everybody else's: a finding a PERSON files opens at
 * `created`, so a human's unreviewed one-liner — the case most likely to be a false
 * positive, and the one an agent is best placed to check — was the one an agent could
 * not touch.
 *
 * So an agent may:
 *   - promote its own proposal to `created`;
 *   - close an UNCONFIRMED finding as `invalid` or `refuted`.
 *
 * And may not: `resolved` (claims a defect was FIXED, which is a claim about the code
 * rather than about the report), or `withdrawn` (retires a record somebody may still want).
 * Reopening uses a separate event naming the closure it observed.
 */
/**
 * A FINDING's ratchet (plan 3.3, R4: "one bar for every agent closure"). An agent never closes a
 * finding directly — not `invalid`, not `refuted`, confirmed or not: its closure goes through
 * repair verification (two blind runs, an arbitrator on disagreement), and anything else it
 * concludes becomes a person's ask. It may still move one back to the open pile. Bugs keep
 * `mayTransition`'s agent path until the bug follow-up.
 */
export function mayTransitionFinding(f: Ratcheted & { author?: Actor }, actor: Actor, next: FindingState): boolean {
  if (!isAgentActor(actor)) return true;
  void f;
  return next === "created" || next === "issued";
}

export function mayTransition(f: Ratcheted & { author?: Actor }, actor: Actor, next: FindingState): boolean {
  if (!isAgentActor(actor)) return true;
  if (isClosed(f.state)) return next === "created" || next === "issued";
  // Moving it back to the open pile is triage and always an agent's to do.
  if (next === "created" || next === "issued") return true;
  // Everything else here is a CLOSE. Confirmed, or filed by a person, and it needs an
  // ack — `setState` turns the attempt into a pending ask rather than refusing it, so
  // the badge says so on the item instead of the reason living in a thread comment.
  if (agentClosureNeedsAck(f)) return false;
  return next === "invalid" || next === "refuted";
}

/**
 * Whether `actor` may rewrite a finding's substance right now.
 *
 * Same gate, same reason. An unconfirmed finding is still a proposal whoever looks at
 * it may sharpen; a confirmed one carries somebody's name and only they change it.
 * Keyed on `f.state !== "issued"` this refused exactly the case that needs it most — a
 * person's raw note, which carries no severity, no line and no remedy, and which an
 * agent that has just read the code is best placed to supply.
 */
export function mayRevise(f: Ratcheted, actor: Actor): boolean {
  void f;
  void actor;
  // ALWAYS. An agent may rewrite what a finding SAYS at any point in its life.
  //
  // This used to refuse once anything confirmed it, on the grounds that "a confirmed one
  // carries somebody's name and only they change it". That is a real concern about the
  // JUDGEMENTS — the severity, the state, whether it is real — and not about the prose
  // describing the defect, which is the text that actually gets published and acted on.
  // Leaving a wrong summary standing with a correction three entries below it is worse
  // for the reader than replacing it, and replacing it loses nothing: `revisions` is
  // append-only and keeps the `was` of every field it changes.
  //
  // `severity` is the exception and is filtered at the write path, not here — see
  // `reviseFinding`.
  return true;
}

// ---------------------------------------------------------------------------
// The fold
// ---------------------------------------------------------------------------

type Data = Record<string, unknown>;
const str = (d: Data | undefined, k: string): string | undefined => {
  const v = d?.[k];
  return typeof v === "string" && v.trim() ? v : undefined;
};

/** A nested object in an event payload — `str`'s counterpart, for `witness`. */
const obj = (d: Data | undefined, k: string): Data | undefined => {
  const v = d?.[k];
  return v && typeof v === "object" && !Array.isArray(v) ? v as Data : undefined;
};

/**
 * A witness from an event, or none. `deleted` is exactly `true` or absent: anything else
 * drops the whole witness, because read as a body witness a deletion lands at filing —
 * the misreading it exists to prevent — while no witness is visibly `unjudgeable`.
 */
const witnessOf = (w: Data | undefined): BugWitness | undefined => {
  const anchorId = str(w, "anchorId"), bodyHash = str(w, "bodyHash");
  if (!anchorId || !bodyHash) return undefined;
  if (w!.deleted === undefined) return { anchorId, bodyHash };
  return w!.deleted === true ? { anchorId, bodyHash, deleted: true } : undefined;
};

/**
 * Every finding in a scope, folded from its events.
 *
 * Malformed events are skipped rather than fatal, and so are events that break the
 * ratchet: both arrive from other people's clients, and a shared store that
 * refuses to load — or that lets one bad client rewrite everyone's state — is
 * worse than one that ignores a record.
 */
interface ApplicationReplay {
  all: LogEvent[];
  reads: ReadSets;
  snapshots: Map<string, Map<string, SharedFinding>>;
  /** Where the top-level fold records what it did not apply. Snapshots record nothing. */
  refuse?: (e: LogEvent, cls: RefusalClass, why: string) => void;
}

function foldFindingsInternal(events: LogEvent[], replay: ApplicationReplay): Map<string, SharedFinding> {
  const out = new Map<string, SharedFinding>();
  const refuse = replay.refuse ?? (() => {});
  // Each finding's creating payload, so a second creation can be told apart: the same bytes
  // are one act seen twice, different ones are a claim on an id already taken (owner, Q5).
  const created = new Map<string, string>();
  const spent = new Set<string>();
  // A verification application is one-shot per finding epoch, spent only by a closure that
  // happens here — like `spent` for ruling applications (F34).
  const repairSpent = new Set<string>();
  const atAct = (e: LogEvent): SharedFinding | undefined => {
    let snapshot = replay.snapshots.get(e.id);
    if (!snapshot) {
      snapshot = foldFindingsInternal(replay.all.filter((prior) => replay.reads.saw(e.id, prior.id)), { ...replay, refuse: undefined });
      replay.snapshots.set(e.id, snapshot);
    }
    return snapshot.get(e.subject);
  };

  for (let at = 0; at < events.length; at++) {
    const e = events[at]!;
    const d = e.data as Data | undefined;

    if (e.kind === "finding.created") {
      if (out.has(e.subject)) {
        if (created.get(e.subject) !== JSON.stringify(d ?? null)) refuse(e, "state", `finding ${e.subject} already exists`);
        continue;
      }
      const text = str(d, "text");
      const targetId = str(d, "targetId");
      const targetKind = str(d, "targetKind");
      if (!text || !targetId || (targetKind !== "anchor" && targetKind !== "node")) {
        refuse(e, "shape", "a finding needs text and an anchor or node target"); continue;
      }
      created.set(e.subject, JSON.stringify(d ?? null));
      out.set(e.subject, {
        id: e.subject,
        target: { kind: targetKind, id: targetId },
        text,
        comment: str(d, "comment"),
        severity: str(d, "severity") as BugSeverity | undefined,
        category: str(d, "category"),
        line: typeof d?.line === "number" ? d.line : undefined,
        witness: witnessOf(obj(d, "witness")),
        sourceRef: str(d, "sourceRef"),
        ...(str(d, "branch") ? { branch: str(d, "branch") } : {}),
        ...(str(d, "namedRef") ? { namedRef: str(d, "namedRef") } : {}),
        author: e.actor,
        createdAt: e.at,
        ...(str(d, "filedBy") || str(d, "filedAt")
          ? { filed: { by: str(d, "filedBy") ?? "(unrecorded)", at: str(d, "filedAt") ?? e.at } }
          : {}),
        // Authorship decides the opening state, exactly as the old disposition
        // default did — but from `via`, not from a prefix on a name.
        state: isAgentActor(e.actor) ? "issued" : "created",
        openEpoch: e.id,
        corroboration: [],
        outcomes: [],
        asks: [],
        thread: [],
        revisions: [],
      });
      continue;
    }

    const f = out.get(e.subject);
    if (!f) {
      if (e.kind.startsWith("finding.")) refuse(e, "reference", `no finding ${e.subject} in this scope`);
      continue;
    }

    switch (e.kind) {
      case "finding.revised": {
        const was = (d?.was as Record<string, unknown>) ?? {};
        const now = (d?.now as Record<string, unknown>) ?? {};
        // A person may revise anyone's; an agent only while nobody has stood behind it.
        if (!mayRevise(f, e.actor)) { refuse(e, "state", "an agent may not revise a finding somebody has stood behind"); break; }
        const stale = staleRevision(e, f as unknown as Record<string, unknown>);
        if (stale) { refuse(e, "state", stale); break; }
        f.revisions.push({ at: e.at, by: e.actor, was });
        // Assigned field by field rather than through a dynamic key: a revision is
        // the one event that rewrites the finding's substance, so what it is allowed
        // to touch should be readable here rather than inferred from a list.
        if (typeof now.text === "string") f.text = now.text;
        if (typeof now.comment === "string") f.comment = now.comment;
        if (typeof now.severity === "string") f.severity = now.severity as BugSeverity;
        if (typeof now.category === "string") f.category = now.category;
        if (typeof now.sourceRef === "string") f.sourceRef = now.sourceRef;
        if (typeof now.line === "number") f.line = now.line;
        break;
      }

      case "finding.corroborated": {
        const verdict = str(d, "verdict") as Verdict | undefined;
        if (verdict !== "confirm" && verdict !== "partial" && verdict !== "refute" && verdict !== "unsure") { refuse(e, "shape", `unknown verdict ${String(verdict)}`); break; }
        // One entry per REVIEWER — the person, plus the model if one spoke for
        // them. A re-review replaces that reviewer's own opinion and nobody else's,
        // and never collapses two: the disagreement IS the signal, and keying on
        // the principal alone let one person's second model quietly overwrite their
        // first. See `reviewerKey`.
        const i = f.corroboration.findIndex((c) => reviewerKey(c.actor) === reviewerKey(e.actor));
        const entry: Corroboration = {
          actor: e.actor, verdict, at: e.at,
          rationale: str(d, "rationale") ?? "",
          independent: isIndependent(e.actor, f.author),
          errorIndependent: isErrorIndependent(e.actor, f.author),
          ...(str(d, "ref") ? { ref: str(d, "ref") } : {}),
        };
        if (i >= 0) f.corroboration[i] = entry; else f.corroboration.push(entry);
        break;
      }

      case "finding.remediated": {
        const state = str(d, "state");
        if (!isRemediation(state)) { refuse(e, "shape", `unknown remediation ${String(state)}`); break; }
        // Latest wins. It is an observation, and a later look at the code supersedes an
        // earlier one — unlike corroboration, where the disagreement IS the data.
        f.remediation = {
          state, by: e.actor, at: e.at,
          ...(str(d, "detail") ? { detail: str(d, "detail") } : {}),
          ...(str(d, "ref") ? { ref: str(d, "ref") } : {}),
        };
        break;
      }

      case "finding.backlogged": {
        // BOTH ENDS. `backlogFinding` refuses an agent with a sentence; this drops the
        // event, because a teammate's clone applies the log without ever seeing that
        // check and a guard in one end binds one machine. Twelve defects of this exact
        // shape are on record in this subsystem.
        if (isAgentActor(e.actor)) { refuse(e, "state", "backlogging is a person's act"); break; }
        const until = str(d, "until"), reason = str(d, "reason");
        // No deadline, no backlogging. The whole point of the record is that it comes
        // back; one without a date is the permanent silent silencing that
        // `acknowledgements` refuses for the same reason, and every deferral in the
        // measured data was in exactly that state.
        if (!until || !ISO_DATE.test(until) || !reason) { refuse(e, "shape", "a backlog needs a reason and a deadline"); break; }
        // The DATE part only — see the same slice in `foldBugs`. `ISO_DATE` admits a
        // trailing `T`, and `until` is compared lexicographically against a date.
        const day = until.slice(0, 10);
        const w = obj(d, "witness");
        // Same binding rule, and it drops only the WITNESS: the deadline is the guaranteed
        // release condition and a decision somebody made should not be lost over a bad
        // optional field. Date-only is a state this already supports.
        const wOk = w && (f.target.kind !== "anchor" || str(w, "anchorId") === f.target.id);
        // A plain witness on a DELETION finding's own anchor is an older build's: this one
        // copies the deletion witness, and the older `backlogFinding` re-read the body, which
        // wakes the backlog the moment the deletion lands. Derived here, so a refold repairs
        // it (triage 2026-09-19-deletion-fixes-review I5, Q3).
        const bw = wOk ? witnessOf(w) : undefined;
        const asDeletion = bw && !bw.deleted && f.witness?.deleted && bw.anchorId === f.witness.anchorId;
        f.backlogged = {
          until: day, reason, by: e.actor, at: e.at,
          ...(bw ? { witness: asDeletion ? { ...f.witness! } : bw } : {}),
          ...(str(d, "system") ? { ref: { system: str(d, "system")!, key: str(d, "key"), url: str(d, "url"), at: e.at, by: e.actor } } : {}),
        };
        break;
      }

      case "finding.backlogReleased":
        // Also principal-only, and for the symmetrical reason: an agent that could end a
        // one could bring back every one, which is the same queue-clearing move from the
        // other side. Deleting the field rather than dating it — it is back, and
        // the events remain the history.
        if (isAgentActor(e.actor)) { refuse(e, "state", "bringing a finding back is a person's act"); break; }
        // The writer refuses an empty reason and the fold did not, which is the
        // guard-at-one-end shape this contract exists to forbid: a buggy or older
        // client could un-backlog a finding with no record of why, and every clone
        // would apply it.
        if (!str(d, "reason")) { refuse(e, "shape", "a release needs a reason"); break; }
        delete f.backlogged;
        break;

      case "finding.rewitnessed": {
        // An AGENT may do this, deliberately: it is evidence-gathering, not a disposition,
        // and the bucket it repairs (19% of the measured backlog) is precisely the one
        // nothing else can touch. What it must never do is look like a witness captured
        // when the claim was made — `witnessAttached` is what keeps those distinguishable.
        const w = witnessOf(obj(d, "witness"));
        if (!w) { refuse(e, "shape", "a rewitness needs a witness"); break; }
        const { anchorId } = w;
        // Never over an existing witness. A witness is the evidence a finding was filed
        // against; replacing it would silently re-baseline every drift answer that
        // depends on it, which is the "amendment re-baselines the witnesses away" problem
        // one subsystem over. Repair is for findings that have none.
        if (f.witness) { refuse(e, "state", "the finding already has a witness"); break; }
        // Both ends FOR AN ANCHOR TARGET. `checkWitnessTarget` refuses this at the tool
        // with a sentence; the fold refuses it too, or a hostile or buggy client can point
        // any replaying clone's drift answers at code the finding was never about. A wrong
        // witness is worse than none: none is visibly `unjudgeable`, this looks settled.
        //
        // A NODE target is tool-only, and that is a limit rather than an oversight: the
        // rule is "the anchor must be one the node cites", and a node's citations are
        // store state the fold cannot read — it is a pure function of events, which is
        // what makes every clone agree. So the tool refuses it and the fold cannot. Said
        // out loud because "both ends" is the contract here and a comment claiming it
        // where it does not hold is worse than the gap.
        if (f.target.kind === "anchor" && anchorId !== f.target.id) { refuse(e, "state", "a witness must be of the finding's own anchor"); break; }
        f.witness = w;
        f.witnessAttached = { by: e.actor, at: e.at };
        // Arm a backlog that had NO witness to wake early on. One is allowed — the
        // deadline is the guaranteed condition and an anchor may already have left the
        // tree — but a finding repaired after being backlogged could then never wake on
        // drift at all, which is the half of the release condition only this tool can
        // restore. Never over an existing one, for the same reason as above.
        if (f.backlogged && !f.backlogged.witness) f.backlogged.witness = { ...w };
        break;
      }

      case "finding.commented": {
        const body = str(d, "body");
        if (!body) { refuse(e, "shape", "a comment needs a body"); break; }
        f.thread.push({ id: e.id, actor: e.actor, at: e.at, body, inReplyTo: str(d, "inReplyTo") });
        break;
      }

      case "finding.promoted":
        // A latch: surfacing something twice is not a state change.
        if (!f.promotion) f.promotion = { at: e.at, by: e.actor };
        break;

      case "finding.posted":
      case "finding.upstreamed": {
        const ref: ExternalRef = {
          system: str(d, "system") ?? (e.kind === "finding.posted" ? "github" : "jira"),
          key: str(d, "key"), url: str(d, "url"), at: e.at, by: e.actor,
        };
        // Also a latch. Two people publishing the same finding is the duplicate
        // this log exists to prevent, so the FIRST one is the record. The same record again
        // is a no-op; a different one is refused (owner, Q5).
        const held = e.kind === "finding.posted" ? f.posted : f.upstream;
        if (held) {
          if (held.system !== ref.system || held.key !== ref.key || held.url !== ref.url)
            refuse(e, "state", `the finding is already ${e.kind === "finding.posted" ? "posted" : "upstreamed"} as ${held.key ?? held.url ?? held.system}`);
          break;
        }
        if (e.kind === "finding.posted") f.posted = ref; else f.upstream = ref;
        break;
      }

      case "finding.assigned": {
        const kind = str(d, "kind");
        if (kind !== "investigate" && kind !== "fix" && kind !== "answer") { refuse(e, "shape", `unknown assignment ${String(kind)}`); break; }
        f.assignment = { kind, by: e.actor, at: e.at, note: str(d, "note") };
        // A fresh ask means the previous ANSWER no longer stands — the rule
        // `assignAnnotation` has always followed, and the fold did not. Without it
        // re-evaluating is invisible: `reviewQueue` keeps an item only while
        // `includeAnswered || !outcome`, so a finding somebody had already reported on
        // was handed back and appeared in no queue at all. That is the exact case the
        // button exists for — "I think this was fixed, but somebody should check".
        //
        // `outcomes` is untouched: it is the append-only history, and a re-ask does not
        // unsay what the earlier rounds found. Only the "where did this get to" pointer
        // is cleared, because the honest answer is now "somebody is looking again".
        f.outcome = undefined;
        break;
      }

      case "finding.outcome": {
        const result = str(d, "result");
        if (result !== "fixed" && result !== "answered" && result !== "declined") { refuse(e, "shape", `unknown outcome ${String(result)}`); break; }
        // Reporting is not resolving: the agent says what it did, the human closes.
        const entry: NonNullable<SharedFinding["outcome"]> = {
          result, detail: str(d, "detail") ?? "",
          files: Array.isArray(d?.files) ? (d.files as string[]) : undefined,
          by: e.actor, at: e.at,
        };
        // BOTH: the list is the record, the field is the latest. A single field lost 37
        // of 59 reports on one pull request — see `outcomes`.
        (f.outcomes ??= []).push(entry);
        f.outcome = entry;
        break;
      }

      case "finding.requested": {
        const ask = str(d, "ask");
        if (!isAsk(ask)) { refuse(e, "shape", `unknown ask ${String(ask)}`); break; }
        const record = { ask, by: e.actor, at: e.at, rationale: str(d, "rationale") ?? "" };
        // One outstanding ask; a second SUPERSEDES it, and the superseded one keeps its
        // rationale in `asks` rather than only in the raw log.
        const open = (f.asks ??= []).find((a) => !a.settled);
        if (open) open.settled = { as: "superseded", by: e.actor, at: e.at };
        f.asks.push(record);
        f.pending = record;
        break;
      }

      case "finding.askDeclined": {
        const reason = str(d, "reason");
        if (!reason) { refuse(e, "shape", "declining needs a reason"); break; }
        // A person's call, like granting one. An agent that wants its own ask off the
        // queue asks for something else, which supersedes it.
        if (isAgentActor(e.actor)) { refuse(e, "state", "declining an ask is a person's act"); break; }
        const open = (f.asks ??= []).find((a) => !a.settled);
        if (!open) { refuse(e, "state", "there is no open ask to decline"); break; }
        open.settled = { as: "declined", by: e.actor, at: e.at, reason };
        f.pending = undefined;
        break;
      }

      case "finding.stateChanged": {
        const next = str(d, "state") as FindingState | undefined;
        if (!next || !["issued", "created", "invalid", "refuted", "resolved", "withdrawn", "accepted"].includes(next)) {
          refuse(e, "shape", `unknown finding state ${String(next)}`); break;
        }
        // The ordinary closure gate still applies; an agent reopen needs a
        // separate event with the closure it observed.
        // Legacy human reopens remain valid; agents use an observed-closure act.
        if (isClosed(f.state) && !isClosed(next) && isAgentActor(e.actor)) { refuse(e, "state", "an agent reopens only through the closure it observed"); break; }
        if (!mayTransitionFinding(f, e.actor, next)) { refuse(e, "state", `the finding is ${f.state}; it may not become ${next} by this actor`); break; }
        const from = str(d, "from");
        if (from && from !== f.state) { refuse(e, "state", `the finding is ${f.state}; it may not become ${next} — this was decided when it was ${from}`); break; }
        f.state = next;
        // An ask is answered by the act it asked for — and SETTLED, not erased. Clearing
        // `pending` alone took the rationale with it, so a finding closed on an agent's
        // recommendation kept no record of the recommendation, and "why is this resolved"
        // was answerable only from the raw log.
        const open = (f.asks ??= []).find((a) => !a.settled);
        if (open) open.settled = { as: "applied", by: e.actor, at: e.at, state: next };
        if (isClosed(next)) {
          f.closed = {
            eventId: e.id, at: e.at, by: e.actor,
            // The person's own words if they gave any; otherwise the reason the ask
            // carried, which is what they were agreeing to. `next` alone says nothing.
            reason: str(d, "reason") ?? open?.rationale ?? next,
            ...(open ? { grantedAsk: { ask: open.ask, by: open.by, at: open.at, rationale: open.rationale } } : {}),
          };
        } else { f.closed = undefined; f.openEpoch = e.id; }
        f.pending = undefined;
        break;
      }

      case "finding.reopened": {
        const next = str(d, "state") as FindingState | undefined;
        if (next !== "created" && next !== "issued") { refuse(e, "shape", `a reopen goes to created or issued, not ${String(next)}`); break; }
        if (!isClosed(f.state) || !f.closed?.eventId || str(d, "observedClosure") !== f.closed.eventId) {
          refuse(e, "state", "the closure this reopen observed is not the finding's current one"); break;
        }
        f.state = next;
        f.openEpoch = e.id;
        f.closed = undefined;
        f.pending = undefined;
        break;
      }

      case "finding.repairApplied": {
        const application = d as unknown as RepairVerificationApplication;
        const prior = replay.all.filter(p => replay.reads.saw(e.id, p.id));
        const verification = foldRepairVerification([...prior, e]);
        if (!verification.applications.some(a => a.id === application?.id)) {
          refuse(e, "state", verification.rejected.find((r) => r.eventId === e.id)?.reason ?? "no verified application matches this repair"); break;
        }
        const act = atAct(e);
        if (!act || isClosed(act.state) || act.openEpoch !== application.openEpoch
          || issueClaimHash("finding", act) !== application.claimHash) { refuse(e, "state", "the finding was not open with this claim"); break; }
        const once = `${application.requestId}\0${application.findingId}\0${application.openEpoch}`;
        if (repairSpent.has(once)) { refuse(e, "state", "this verification has already been applied"); break; }
        if (isClosed(f.state) || f.openEpoch !== application.openEpoch
          || issueClaimHash("finding", f) !== application.claimHash) refuse(e, "state", "the finding was no longer open with this claim");
        if (!isClosed(f.state) && f.openEpoch === application.openEpoch
          && issueClaimHash("finding", f) === application.claimHash) {
          repairSpent.add(once);
          f.state = application.outcome === "fixed" ? "resolved" : application.outcome === "invalid" ? "invalid" : "refuted";
          f.closed = { eventId: e.id, at: e.at, by: e.actor, reason: application.reason };
          f.repairClosure = { requestId: application.requestId, applicationId: application.id, outcome: application.outcome, attention: [] };
          f.pending = undefined;
        }
        break;
      }

      case "finding.rulingApplied": {
        // No build ever published a version 1 or 2 capsule: one here is damage, not a refusal (plan 1.1).
        const version = (d?.capsule as { version?: unknown } | undefined)?.version;
        // Skipped, never locked on (owner, Q7: "fold or skip").
        if (version === 1 || version === 2) {
          refuse(e, "older", `a ruling application in a dev-era capsule (version ${version}); this build writes version 3`); break;
        }
        const attempts = (f.applications ??= []);
        const checked = validateApplicationCapsule(d?.capsule, "finding", e.subject);
        if ("error" in checked) {
          attempts.push({ eventId: e.id, at: e.at, by: e.actor, status: "refused", reason: checked.error });
          refuse(e, "state", checked.error);
          break;
        }
        const capsule = checked.capsule;
        if (spent.has(capsule.key)) {
          const first = attempts.find((a) => a.status === "executed" && a.key === capsule.key);
          if (JSON.stringify(first?.capsule) !== JSON.stringify(capsule)) refuse(e, "state", "this ruling was already applied to this finding");
          attempts.push({ eventId: e.id, at: e.at, by: e.actor, status: "duplicate", key: capsule.key, capsule });
          break;
        }
        const act = atAct(e);
        if (!act || isClosed(act.state) || act.state !== capsule.issue.openState
          || act.openEpoch !== capsule.issue.openEpoch
          || issueClaimHash("finding", act) !== capsule.issue.claimHash) {
          attempts.push({ eventId: e.id, at: e.at, by: e.actor, status: "refused",
            key: capsule.key, capsule, reason: "issue was not open with this claim in the act-time view" });
          refuse(e, "state", "the finding was not open with this claim");
          break;
        }
        // Spent only by a closure that happens (owner: "spend only when a closure actually
        // executes"): valid when written, but a concurrent close got there first, so this one
        // closed nothing and a fresh application of the same ruling must still be able to.
        if (isClosed(f.state) || f.openEpoch !== capsule.issue.openEpoch
          || issueClaimHash("finding", f) !== capsule.issue.claimHash) {
          attempts.push({ eventId: e.id, at: e.at, by: e.actor, status: "refused",
            key: capsule.key, capsule, reason: "issue was no longer open with this claim when this was applied; nothing was spent" });
          refuse(e, "state", "the finding was no longer open with this claim");
          break;
        }
        spent.add(capsule.key);
        attempts.push({ eventId: e.id, at: e.at, by: e.actor, status: "executed", key: capsule.key, capsule });
        f.state = capsule.outcome;
        f.closed = { eventId: e.id, at: e.at, by: capsule.acceptance?.by ?? e.actor, reason: capsule.reason };
        f.pending = undefined;
        break;
      }

      case "finding.relocation": {
        const kind = str(d, "kind");
        if (kind !== "moved" && kind !== "gone") { refuse(e, "shape", `unknown relocation ${String(kind)}`); break; }
        const to = str(d, "to");
        if (kind === "moved" && !to) { refuse(e, "shape", "a move needs where to"); break; }
        const apply = d?.apply === true;
        // The same gate as everything else: an agent proposes, a person applies.
        // A proposal from anyone is recorded; an APPLIED one from an agent is not.
        if (apply && isAgentActor(e.actor)) { refuse(e, "state", "applying a relocation is a person's act"); break; }
        f.relocation = { kind, ...(to ? { to } : {}), by: e.actor, at: e.at, rationale: str(d, "rationale") ?? "", ...(apply ? { applied: true } : {}) };
        if (apply) {
          if (kind === "moved" && to) f.target = { ...f.target, id: to };
          else if (kind === "gone") { f.state = "invalid"; f.closed = { eventId: e.id, at: e.at, by: e.actor, reason: str(d, "rationale") || "the code it was about is gone" }; }
        }
        break;
      }

      case "finding.promotedToBug": {
        const bug = str(d, "bug");
        if (!bug) { refuse(e, "shape", "a promotion needs the bug"); break; }
        // Both records survive and cross-link: the PR history should still show the
        // finding was raised there. Promotion transfers the OBLIGATION, so the
        // finding stops asking for a decision — its successor is asking.
        //
        // A LATCH, like `posted`. Two people accepting one finding offline is the
        // duplicate this log exists to prevent; `bugIdFor` already makes them mint
        // the same id, and the latch is what holds if one of them passes another.
        if (f.bug) { if (f.bug !== bug) refuse(e, "state", `the finding is already promoted to ${f.bug}`); break; }
        f.bug = bug;
        f.pending = undefined;
        // …and the outstanding ASK goes with it, for the same reason `pending` does: the
        // obligation transferred. An assignment left standing kept the finding in
        // `review_queue` after a bug had taken ownership, so an agent was still being
        // asked to investigate something whose successor was already tracking it.
        f.assignment = undefined;
        break;
      }
    }
  }
  return out;
}

/** The fold and every event it did not apply, classed (plan 3.1). The door and the scans read this. */
export function foldFindingsReport(events: LogEvent[]): { value: RepairFindingMap<SharedFinding>; refused: Refusal[] } {
  const { refused, refuse } = collector();
  const value = foldFindingsWith(events, refuse);
  return { value, refused };
}

/**
 * The findings scope as a READ judges it: the finding fold and the repair folds that share the
 * scope, so what the door refuses (below) is what a read refuses — one rule at both ends.
 */
export function foldFindingsScopeReport(events: LogEvent[]): { value: RepairFindingMap<SharedFinding>; refused: Refusal[] } {
  const out = foldFindingsReport(events);
  const byId = new Map(events.map((e) => [e.id, e]));
  const more = [...foldRepairRecords(events).rejected, ...foldRepairVerification(events).rejected]
    .map((r) => ({ id: r.eventId, kind: byId.get(r.eventId)?.kind ?? "", why: r.reason, cls: "state" as const }));
  return { value: out.value, refused: [...out.refused, ...more] };
}

/**
 * The universe a findings scope belongs to (`findings/<universe>/pr-<n>` or `/b-<hash>`), or
 * null for a bare key, which only tests write.
 */
function universeOfFindingScope(scope: string): string | null {
  const m = /^findings\/(.+)\/(?:pr|b)-[^/]+$/.exec(scope);
  return m ? m[1]! : null;
}

/**
 * The references a findings event makes OUTSIDE its scope (docs/sidecar-references.md): a
 * promotion names a filed bug (row 23), a ruling application its round, decision and answer
 * (rows 29-31), and a verification result's sites the bugs they were filed as (row 51).
 */
async function outsideReferences(scope: string, e: LogEvent, _own: LogEvent[], read: ScopeReader): Promise<Refusal[]> {
  const universe = universeOfFindingScope(scope);
  if (!universe) return [];
  if (e.kind === "finding.rulingApplied") return rulingReferences(read, universe, e);
  const named = e.kind === "finding.promotedToBug" ? [str(e.data as Data | undefined, "bug")]
    : e.kind === "repair.verification-recorded"
      ? (((e.data as Data | undefined)?.results as { sites?: { bug?: unknown }[] }[] | undefined) ?? [])
        .flatMap((r) => r?.sites ?? []).map((s) => (typeof s?.bug === "string" ? s.bug : undefined))
      : [];
  const wanted = named.filter((b): b is string => !!b);
  if (!wanted.length) return [];
  const filed = new Set((await read.read(`bugs/${universe}`)).filter((b) => b.kind === "bug.filed").map((b) => b.subject));
  const missing = wanted.find((b) => !filed.has(b));
  return missing ? [{ id: e.id, kind: e.kind, cls: "reference", why: `no bug ${missing} has been filed in bugs/${universe}` }] : [];
}

registerReport((scope) => scope.startsWith("findings/"), foldFindingsScopeReport);

/** A verification application lands only if it is what closed the finding (claim, epoch, authority). */
function repairApplicationRefused(events: LogEvent[], minted: LogEvent): { id: string; why: string }[] {
  if (minted.kind !== "finding.repairApplied") return [];
  return foldFindingsReport(events).value.get(minted.subject)?.closed?.eventId === minted.id ? []
    : [{ id: minted.id, why: "canonical finding application refused current claim, epoch or authority" }];
}
// The findings scope's door: the finding fold, the repair records and verifications that share the
// scope, and what the scope's events name elsewhere. Everything here reads only the sidecar, so
// replay applies it too (owner's one-door rule, docs/sidecar-architecture.md).
registerDoor((scope) => scope.startsWith("findings/"), (logRoot, scope) => async (events, minted) => ({
  refused: [
    ...foldFindingsScopeReport(events).refused,
    ...repairApplicationRefused(events, minted),
    ...await outsideReferences(scope, minted, events, tipReader(logRoot)),
  ],
}));
registerReferences((scope) => scope.startsWith("findings/"), outsideReferences);


/** Every kind this family folds or knows to skip: anything else here is newer (`eventlog.ts registerKinds`). */
const FINDING_KINDS = registerKinds((scope) => scope.startsWith("findings/"), [
  "finding.created", "finding.revised", "finding.corroborated", "finding.remediated", "finding.backlogged",
  "finding.backlogReleased", "finding.rewitnessed", "finding.commented", "finding.promoted", "finding.posted",
  "finding.upstreamed", "finding.assigned", "finding.outcome", "finding.requested", "finding.askDeclined",
  "finding.stateChanged", "finding.reopened", "finding.repairApplied", "finding.rulingApplied", "finding.relocation",
  "finding.promotedToBug",
  "repair.claims-recorded", "repair.evidence-recorded", "repair.sort-recorded", "repair.verification-requested",
  "repair.verification-recorded", "repair.verification-arbitrated", ...RETIRED_REPAIR_KINDS,
]);
/** The fold for a READ: a refused linear event is damage and locks; see `validation.ts`. */
export function foldFindings(events: LogEvent[]): RepairFindingMap<SharedFinding> {
  return foldJudged(events, foldFindingsScopeReport, FINDING_KINDS).value;
}

function foldFindingsWith(events: LogEvent[], refuse: ApplicationReplay["refuse"]): RepairFindingMap<SharedFinding> {
  const out: RepairFindingMap<SharedFinding> = foldFindingsInternal(events, { all: events, reads: readSets(events), snapshots: new Map(), refuse });
  out.repairRecords = foldRepairRecords(events);
  const verification = foldRepairVerification(events);
  out.repairVerification = verification;
  for (const finding of out.values()) {
    if (finding.repairClosure && !verification.applications.some(a => a.id === finding.repairClosure!.applicationId)) {
      finding.repairClosure.attention = ["Later verification provenance or conflicting records require attention; the historical closure is retained."];
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------

const emit = (
  logRoot: string, pr: number | string, actor: Actor,
  subject: string, kind: string, data?: Data,
): Promise<LogEvent> => emitEvent(logRoot, findingScope(pr), actor, kind, subject, data);

export interface NewFinding {
  id?: string;
  /** Migration only — see `SharedFinding.filed`. */
  filedBy?: string;
  filedAt?: string;
  targetKind: "anchor" | "node";
  targetId: string;
  text: string;
  comment?: string;
  severity?: BugSeverity;
  category?: string;
  line?: number;
  witness?: BugWitness;
  sourceRef?: string;
  branch?: string;
  /** The ref the filer named, when explicitly origin's. See `SharedFinding.namedRef`. */
  namedRef?: string;
}

export async function createFinding(logRoot: string, pr: number | string, actor: Actor, f: NewFinding): Promise<string> {
  const id = f.id ?? "f_" + mintId();
  await emit(logRoot, pr, actor, id, "finding.created", { ...f, id: undefined } as Data);
  return id;
}

export const corroborate = (
  logRoot: string, pr: number | string, actor: Actor, id: string, verdict: Verdict, rationale: string, ref?: string,
) => emit(logRoot, pr, actor, id, "finding.corroborated", { verdict, rationale, ...(ref ? { ref } : {}) });

export const comment = (logRoot: string, pr: number | string, actor: Actor, id: string, body: string, inReplyTo?: string) =>
  emit(logRoot, pr, actor, id, "finding.commented", { body, ...(inReplyTo ? { inReplyTo } : {}) });

/**
 * Record what happened about a finding. Anyone, at any state — see `Remediation`.
 *
 * `ref` is what makes `fixed-on-branch` checkable rather than asserted: the commit the
 * fix landed in, so a later reader can look instead of believing.
 */
export const remediate = (logRoot: string, pr: number | string, actor: Actor, id: string,
  state: Remediation, detail?: string, ref?: string) =>
  emit(logRoot, pr, actor, id, "finding.remediated",
    { state, ...(detail ? { detail } : {}), ...(ref ? { ref } : {}) });

/**
 * Backlog a finding: real, not now, and it comes back.
 *
 * `until` and `reason` are both required and the FOLD checks them too — an event missing
 * either is a carry that never wakes, which is the failure this record exists to prevent.
 * `witness` is the code as it stands NOW, not the finding's filing witness; see
 * `SharedFinding.backlogged`.
 */
export const backlogFindingEvent = (
  logRoot: string, pr: number | string, actor: Actor, id: string,
  input: { until: string; reason: string; witness?: BugWitness; ref?: { system: string; key?: string; url?: string } },
) => emit(logRoot, pr, actor, id, "finding.backlogged", {
  until: input.until, reason: input.reason,
  ...(input.witness ? { witness: { ...input.witness } } : {}),
  ...(input.ref ? { system: input.ref.system, ...(input.ref.key ? { key: input.ref.key } : {}), ...(input.ref.url ? { url: input.ref.url } : {}) } : {}),
} as Data);

export const releaseBacklog = (logRoot: string, pr: number | string, actor: Actor, id: string, reason: string) =>
  emit(logRoot, pr, actor, id, "finding.backlogReleased", { reason });

/**
 * Ask for the finding to be looked at again — the reviewer's half of the loop.
 *
 * `finding.assigned` has been folded since the record existed and had no emitter, no op
 * and no tool, so the whole verb was a dead half: `findingAsQueueEntry` maps an
 * assignment into `review_queue`, and nothing could ever put one there. This is the
 * missing end.
 *
 * NOT a disposition — it asks a question rather than answering one, which is why it is
 * open to anybody. What comes back is an outcome, and a person still closes.
 */
export const assign = (
  logRoot: string, pr: number | string, actor: Actor, id: string,
  kind: "investigate" | "fix" | "answer", note?: string,
) => emit(logRoot, pr, actor, id, "finding.assigned", { kind, ...(note ? { note } : {}) });

/** Attach a witness to a finding filed without one. Evidence, so an agent may do it. */
export const rewitness = (logRoot: string, pr: number | string, actor: Actor, id: string, witness: BugWitness) =>
  emit(logRoot, pr, actor, id, "finding.rewitnessed", { witness: { ...witness } } as Data);

export const promote = (logRoot: string, pr: number | string, actor: Actor, id: string) =>
  emit(logRoot, pr, actor, id, "finding.promoted");

export const request = (logRoot: string, pr: number | string, actor: Actor, id: string, ask: Ask, rationale: string) =>
  emit(logRoot, pr, actor, id, "finding.requested", { ask, rationale });

/**
 * Say no to an ask, which nothing could do.
 *
 * `pending` was cleared only by the act it asked for, so declining left the finding
 * wearing `refuted pending` and sitting in `waitingOnYou` forever — a permanently wrong
 * claim about an open item, on the queue whose accuracy the whole design leans on. The
 * web's "answer instead" posted a COMMENT, which touches none of that.
 *
 * The reason is not optional: an ask that was declined without one is indistinguishable
 * from one nobody got to, which is the state this is removing.
 */
export const declineAsk = (logRoot: string, pr: number | string, actor: Actor, id: string, reason: string) =>
  emit(logRoot, pr, actor, id, "finding.askDeclined", { reason });

export const recordOutcome = (logRoot: string, pr: number | string, actor: Actor, id: string, result: "fixed" | "answered" | "declined", detail: string, files?: string[]) =>
  emit(logRoot, pr, actor, id, "finding.outcome", { result, detail, ...(files ? { files } : {}) });

export const markPosted = (logRoot: string, pr: number | string, actor: Actor, id: string, ref: { key?: string; url?: string }) =>
  emit(logRoot, pr, actor, id, "finding.posted", { system: "github", ...ref });

export const markUpstreamed = (logRoot: string, pr: number | string, actor: Actor, id: string, ref: { system?: string; key?: string; url?: string }) =>
  emit(logRoot, pr, actor, id, "finding.upstreamed", { system: "jira", ...ref });

export const promoteToBug = (logRoot: string, pr: number | string, actor: Actor, id: string, bug: string) =>
  emit(logRoot, pr, actor, id, "finding.promotedToBug", { bug });

/**
 * Say where a finding's target went. `apply` performs it; without it this is a
 * proposal that lands in the ack queue.
 */
export const relocate = (logRoot: string, pr: number | string, actor: Actor, id: string,
  kind: "moved" | "gone", rationale: string, opts: { to?: string; apply?: boolean } = {}) =>
  emit(logRoot, pr, actor, id, "finding.relocation", { kind, rationale, ...(opts.to ? { to: opts.to } : {}), ...(opts.apply ? { apply: true } : {}) });

/**
 * Rewrite a finding's substance. `was` is what its author read — the finding as it reads here
 * unless the caller read it elsewhere; a replay onto a finding that has since moved is refused
 * (`staleRevision`).
 */
export async function revise(
  logRoot: string, pr: number | string, actor: Actor, id: string, now: Record<string, unknown>, was?: Record<string, unknown>,
): Promise<LogEvent> {
  return emit(logRoot, pr, actor, id, "finding.revised", { now, was: was ?? wasOf((await readFindings(logRoot, pr)).get(id), now) });
}

/**
 * Move a finding's state. Refuses up front when the ratchet forbids it — the fold
 * would ignore the event anyway, and a silent no-op is a worse answer than an error.
 */
export async function setState(
  logRoot: string, pr: number | string, actor: Actor, id: string, next: FindingState, reason?: string,
): Promise<LogEvent | { error: string }> {
  const current = (await readFindings(logRoot, pr)).get(id);
  if (!current) return { error: `no finding ${id} on pr ${pr}` };
  if (isClosed(current.state) && (next === "created" || next === "issued")) {
    if (!current.closed?.eventId) return { error: `cannot reopen ${id}: current closure has no event identity` };
    return emit(logRoot, pr, actor, id, "finding.reopened", {
      state: next, observedClosure: current.closed.eventId, ...(reason ? { reason } : {}),
    });
  }
  if (!mayTransitionFinding(current, actor, next)) {
    // ASKED, not refused. The agent has reached a conclusion and this is the moment it
    // says so; erroring here sent it looking for another verb, and what it reached for
    // was prose — 15 of 15 thread comments in the sidecar are state changes and
    // corrections written as remarks, against zero `request_human` asks ever recorded.
    // Recording the ask puts a `refuted pending` badge on the item, which is the whole
    // point: a person approves it from the row instead of reading the log for it.
    const ask = ASK_FOR_STATE[next];
    if (ask) {
      const e = await emit(logRoot, pr, actor, id, "finding.requested", {
        ask,
        rationale: reason ?? `agent concluded ${next}`,
      });
      return { ...e, asked: ask } as LogEvent & { asked: Ask };
    }
    return { error: `an agent may not move ${id} from ${current.state} to ${next} — request it instead` };
  }
  // `from`: what the author decided against. A replay onto a finding that has since moved is
  // refused rather than silently re-disposing a teammate's close (plan 3.1).
  return emit(logRoot, pr, actor, id, "finding.stateChanged", { state: next, from: current.state, ...(reason ? { reason } : {}) });
}

export async function readFindings(logRoot: string, pr: number | string): Promise<Map<string, SharedFinding>> {
  return foldFindings(await readScope(logRoot, findingScope(pr)));
}

/**
 * What is waiting on a person: everything closed-worthy that only they may close,
 * plus every outstanding request. This is the queue the whole design is for.
 */
export function ackQueue(findings: Iterable<SharedFinding>): SharedFinding[] {
  return [...findings].filter((f) =>
    !isClosed(f.state) && !f.bug
    && (needsHumanAck(f) || !!f.pending
      // An unapplied relocation proposal is waiting on a person by the same rule.
      || (!!f.relocation && !f.relocation.applied)));
}

/**
 * Findings already on the pull request — the idempotency guard, shared.
 *
 * `pr_push` was per-store, so two reviewers with separate stores both published
 * and the submitter got everything twice. Folding it from the log means the
 * SECOND person sees the first person's posts, provided they pull before
 * planning — which is the one place a stale pull is actively destructive.
 */
export function alreadyPosted(findings: Iterable<SharedFinding>): Map<string, ExternalRef> {
  const out = new Map<string, ExternalRef>();
  for (const f of findings) if (f.posted) out.set(f.id, f.posted);
  return out;
}
