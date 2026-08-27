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

import type { Actor, BugSeverity, BugWitness } from "./schema.js";
import { isAgentActor, isIndependent, isErrorIndependent, reviewerKey } from "./identity.js";
import { emitEvent, mintId, readScope, causality, type LogEvent } from "./eventlog.js";
import { applyRevision, newContestState, type Contested } from "./contest.js";

/**
 * Lifecycle. `issued` is an agent's proposal; `created` is a claim somebody stands
 * behind. `created` is the RATCHET FLOOR for agents — past it, only a person closes.
 */
export type FindingState = "issued" | "created" | "invalid" | "refuted" | "resolved" | "withdrawn";

/** Terminal states — a finding here is done, and shows struck through. */
export const CLOSED_STATES: readonly FindingState[] = ["invalid", "refuted", "resolved", "withdrawn"];
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
// `reopen` is the one an agent needed and could not say. A finding closed as `resolved`
// that the submitter then force-pushed the fix away from is live again, and every other
// channel was prose — `mayTransition` refuses agents any move off a closed state, and
// the four closing asks are all the wrong direction. Same lexical-gap shape as the
// `withdraw` complaint, one state over.
export const ASKS = ["promote", "invalidate", "refute", "resolve", "withdraw", "reopen"] as const;

/**
 * The ask that corresponds to closing into each state, so an agent's attempt to close
 * becomes a request rather than an error. `issued`/`created` are not closes and have no
 * ask — an agent may move a finding back to the open pile itself.
 */
export const ASK_FOR_STATE: Partial<Record<FindingState, Ask>> = {
  invalid: "invalidate", refuted: "refute", resolved: "resolve", withdrawn: "withdraw",
};

/** Reopening is always a person's, so an agent's attempt is always the ask. */
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
  closed?: {
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
   * Fields two people set to different values without having seen each other.
   *
   * Nothing is lost and nothing is arbitrated: both values are here, both are in
   * the log, and the finding keeps working. A PERSON clears it by re-submitting
   * the value they want, which lands as an event causally after both and so
   * resolves identically on every machine. Agents never clear it — same instinct
   * as the ack queue: a machine may propose, a person decides.
   */
  contested?: Contested[];
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
  if (f.state === "resolved" || f.state === "invalid") return "settled";
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
 * Whether `actor` may move a finding to `next` right now.
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
 * rather than about the report), `withdrawn` (retires a record somebody may still want),
 * or reopening anything already closed. Those stay `request_human`'s.
 */
export function mayTransition(f: Ratcheted & { author?: Actor }, actor: Actor, next: FindingState): boolean {
  if (!isAgentActor(actor)) return true;
  // Reopening is a person's call even on an unconfirmed finding: whoever closed it
  // wrote a reason, and an agent re-litigating it is not triage.
  if (isClosed(f.state)) return false;
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

/** Fields whose value is a single scalar somebody owns — the only contestable ones. */
const CONTESTABLE = ["text", "comment", "severity", "category", "line"] as const;

/**
 * Every finding in a scope, folded from its events.
 *
 * Malformed events are skipped rather than fatal, and so are events that break the
 * ratchet: both arrive from other people's clients, and a shared store that
 * refuses to load — or that lets one bad client rewrite everyone's state — is
 * worse than one that ignores a record.
 */
export function foldFindings(events: LogEvent[]): Map<string, SharedFinding> {
  const out = new Map<string, SharedFinding>();
  // Who currently holds each contestable scalar, and which two writes each open
  // contest is between. Bookkeeping for the fold, not state anyone reads, so it
  // is kept out of SharedFinding.
  const contest = newContestState();

  // What each writer had folded when they wrote — the log's own notion of
  // causality, so the fold and `causalHeads` cannot drift apart on it.
  const causal = causality(events);

  for (let at = 0; at < events.length; at++) {
    const e = events[at]!;
    const d = e.data as Data | undefined;

    if (e.kind === "finding.created") {
      if (out.has(e.subject)) continue; // a second creation of one id is not a thing
      const text = str(d, "text");
      const targetId = str(d, "targetId");
      const targetKind = str(d, "targetKind");
      if (!text || !targetId || (targetKind !== "anchor" && targetKind !== "node")) continue;
      out.set(e.subject, {
        id: e.subject,
        target: { kind: targetKind, id: targetId },
        text,
        comment: str(d, "comment"),
        severity: str(d, "severity") as BugSeverity | undefined,
        category: str(d, "category"),
        line: typeof d?.line === "number" ? d.line : undefined,
        witness: (d?.witness as BugWitness | undefined) ?? undefined,
        sourceRef: str(d, "sourceRef"),
        author: e.actor,
        createdAt: e.at,
        ...(str(d, "filedBy") || str(d, "filedAt")
          ? { filed: { by: str(d, "filedBy") ?? "(unrecorded)", at: str(d, "filedAt") ?? e.at } }
          : {}),
        // Authorship decides the opening state, exactly as the old disposition
        // default did — but from `via`, not from a prefix on a name.
        state: isAgentActor(e.actor) ? "issued" : "created",
        corroboration: [],
        outcomes: [],
        asks: [],
        thread: [],
        revisions: [],
      });
      continue;
    }

    const f = out.get(e.subject);
    if (!f) continue; // an event about a finding this scope has never seen

    switch (e.kind) {
      case "finding.revised": {
        const was = (d?.was as Record<string, unknown>) ?? {};
        const now = (d?.now as Record<string, unknown>) ?? {};
        // A person may revise anyone's; an agent only while nobody has stood behind it.
        if (!mayRevise(f, e.actor)) break;
        applyRevision(f, e, now, CONTESTABLE, contest, causal);
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
        if (verdict !== "confirm" && verdict !== "partial" && verdict !== "refute" && verdict !== "unsure") break;
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
        if (!isRemediation(state)) break;
        // Latest wins. It is an observation, and a later look at the code supersedes an
        // earlier one — unlike corroboration, where the disagreement IS the data.
        f.remediation = {
          state, by: e.actor, at: e.at,
          ...(str(d, "detail") ? { detail: str(d, "detail") } : {}),
          ...(str(d, "ref") ? { ref: str(d, "ref") } : {}),
        };
        break;
      }

      case "finding.commented": {
        const body = str(d, "body");
        if (!body) break;
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
        // this log exists to prevent, so the FIRST one is the record.
        if (e.kind === "finding.posted") { if (!f.posted) f.posted = ref; }
        else if (!f.upstream) f.upstream = ref;
        break;
      }

      case "finding.assigned": {
        const kind = str(d, "kind");
        if (kind !== "investigate" && kind !== "fix" && kind !== "answer") break;
        f.assignment = { kind, by: e.actor, at: e.at, note: str(d, "note") };
        break;
      }

      case "finding.outcome": {
        const result = str(d, "result");
        if (result !== "fixed" && result !== "answered" && result !== "declined") break;
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
        if (!isAsk(ask)) break;
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
        if (!reason) break;                       // "declined" with no why is not an answer
        // A person's call, like granting one. An agent that wants its own ask off the
        // queue asks for something else, which supersedes it.
        if (isAgentActor(e.actor)) break;
        const open = (f.asks ??= []).find((a) => !a.settled);
        if (!open) break;
        open.settled = { as: "declined", by: e.actor, at: e.at, reason };
        f.pending = undefined;
        break;
      }

      case "finding.stateChanged": {
        const next = str(d, "state") as FindingState | undefined;
        if (!next || !["issued", "created", "invalid", "refuted", "resolved", "withdrawn"].includes(next)) break;
        // THE gate. An agent that tries to close a finding somebody stood behind is
        // ignored by every reader, not just by its own client.
        if (!mayTransition(f, e.actor, next)) break;
        f.state = next;
        // An ask is answered by the act it asked for — and SETTLED, not erased. Clearing
        // `pending` alone took the rationale with it, so a finding closed on an agent's
        // recommendation kept no record of the recommendation, and "why is this resolved"
        // was answerable only from the raw log.
        const open = (f.asks ??= []).find((a) => !a.settled);
        if (open) open.settled = { as: "applied", by: e.actor, at: e.at, state: next };
        if (isClosed(next)) {
          f.closed = {
            at: e.at, by: e.actor,
            // The person's own words if they gave any; otherwise the reason the ask
            // carried, which is what they were agreeing to. `next` alone says nothing.
            reason: str(d, "reason") ?? open?.rationale ?? next,
            ...(open ? { grantedAsk: { ask: open.ask, by: open.by, at: open.at, rationale: open.rationale } } : {}),
          };
        } else f.closed = undefined;
        f.pending = undefined;
        break;
      }

      case "finding.relocation": {
        const kind = str(d, "kind");
        if (kind !== "moved" && kind !== "gone") break;
        const to = str(d, "to");
        if (kind === "moved" && !to) break;    // "it moved" without where is not a proposal
        const apply = d?.apply === true;
        // The same gate as everything else: an agent proposes, a person applies.
        // A proposal from anyone is recorded; an APPLIED one from an agent is not.
        if (apply && isAgentActor(e.actor)) break;
        f.relocation = { kind, ...(to ? { to } : {}), by: e.actor, at: e.at, rationale: str(d, "rationale") ?? "", ...(apply ? { applied: true } : {}) };
        if (apply) {
          if (kind === "moved" && to) f.target = { ...f.target, id: to };
          else if (kind === "gone") { f.state = "invalid"; f.closed = { at: e.at, by: e.actor, reason: str(d, "rationale") || "the code it was about is gone" }; }
        }
        break;
      }

      case "finding.promotedToBug": {
        const bug = str(d, "bug");
        if (!bug) break;
        // Both records survive and cross-link: the PR history should still show the
        // finding was raised there. Promotion transfers the OBLIGATION, so the
        // finding stops asking for a decision — its successor is asking.
        //
        // A LATCH, like `posted`. Two people accepting one finding offline is the
        // duplicate this log exists to prevent; `bugIdFor` already makes them mint
        // the same id, and the latch is what holds if one of them passes another.
        if (f.bug) break;
        f.bug = bug;
        f.pending = undefined;
        break;
      }
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

/** Rewrite a finding's substance. The one event that can contest. */
export const revise = (logRoot: string, pr: number | string, actor: Actor, id: string, now: Record<string, unknown>, was: Record<string, unknown> = {}) =>
  emit(logRoot, pr, actor, id, "finding.revised", { now, was });

/**
 * Clear a contested field by stating what the value should be.
 *
 * A person only: agents may not resolve a disagreement between people, for the
 * same reason they may not close a finding somebody stood behind. It is an
 * ordinary revision — which is the point. It is written having seen both sides,
 * so it is causally after both, so every machine folds it the same way and the
 * contest clears everywhere without anybody arbitrating.
 */
export async function resolveContest(
  logRoot: string, pr: number | string, actor: Actor, id: string, field: string, value: unknown,
): Promise<LogEvent | { error: string }> {
  if (isAgentActor(actor)) {
    return { error: `${field} is contested between two people — an agent may not decide it. Ask, or leave it for them.` };
  }
  const f = (await readFindings(logRoot, pr)).get(id);
  if (!f) return { error: `no finding ${id}` };
  if (!f.contested?.some((c) => c.field === field)) return { error: `${field} is not contested on ${id}` };
  return emit(logRoot, pr, actor, id, "finding.revised", { now: { [field]: value } });
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
  if (!mayTransition(current, actor, next)) {
    // ASKED, not refused. The agent has reached a conclusion and this is the moment it
    // says so; erroring here sent it looking for another verb, and what it reached for
    // was prose — 15 of 15 thread comments in the sidecar are state changes and
    // corrections written as remarks, against zero `request_human` asks ever recorded.
    // Recording the ask puts a `refuted pending` badge on the item, which is the whole
    // point: a person approves it from the row instead of reading the log for it.
    const ask = isClosed(current.state) && REOPEN_STATES.includes(next) ? "reopen" as const : ASK_FOR_STATE[next];
    if (ask) {
      const e = await emit(logRoot, pr, actor, id, "finding.requested", {
        ask,
        rationale: reason ?? `agent concluded ${next}`,
      });
      return { ...e, asked: ask } as LogEvent & { asked: Ask };
    }
    return { error: `an agent may not move ${id} from ${current.state} to ${next} — request it instead` };
  }
  return emit(logRoot, pr, actor, id, "finding.stateChanged", { state: next, ...(reason ? { reason } : {}) });
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
    // A CONTESTED field is waiting on a person by construction: the fold refuses to
    // pick and only a person may state the value. Leaving it out meant the one
    // thing nobody else can resolve was the one thing the queue did not show —
    // found by a browser test that could not make the badge appear.
    && (needsHumanAck(f) || !!f.pending || !!f.contested?.length
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
