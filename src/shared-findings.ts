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
import { isAgentActor, isIndependent, reviewerKey } from "./identity.js";
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

export type Verdict = "confirm" | "refute" | "unsure";
/** What a request asks a human to do. Anyone may ask, at any state. */
export type Ask = "promote" | "invalidate" | "refute" | "resolve";

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
}

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

  state: FindingState;
  corroboration: Corroboration[];
  thread: FindingComment[];

  promotion?: { at: string; by: Actor };
  posted?: ExternalRef;
  upstream?: ExternalRef;
  /** The bug this became. Both records survive; see `finding.promotedToBug`. */
  bug?: string;

  assignment?: { kind: "investigate" | "fix" | "answer"; by: Actor; at: string; note?: string };
  outcome?: { result: "fixed" | "answered" | "declined"; detail: string; files?: string[]; by: Actor; at: string };
  /** An outstanding ask waiting on a person. One at a time; a second replaces it. */
  pending?: { ask: Ask; by: Actor; at: string; rationale: string };
  closed?: { at: string; by: Actor; reason: string };

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
}

/**
 * `pr` is whatever key the caller scopes by. `ops` passes a UNIVERSE-QUALIFIED one
 * (`acme/api/pr-264`) because one sidecar serves several repos and PR 264 exists
 * in more than one of them — and two universes that share a submodule have
 * byte-identical anchor ids, so an unqualified scope would cross-contaminate the
 * findings that are hardest to notice being wrong.
 */
export const findingScope = (pr: number | string): string => `findings/${pr}`;

/** Derived, never stored — an OR over a latch and a grow-only set, so it cannot race. */
export function needsHumanAck(f: SharedFinding): boolean {
  return !!f.promotion || f.corroboration.some((c) => c.verdict === "confirm");
}

/**
 * Whether `actor` may move a finding to `next` right now.
 *
 * The whole ratchet, in one place, so the fold and the write path cannot drift
 * apart. A person may do anything. An agent may only:
 *   - promote its own proposal to `created`, and
 *   - kill a proposal nobody has stood behind yet (`issued` -> `invalid`).
 * Past `created`, or once anything needs an ack, an agent may only REQUEST.
 */
export function mayTransition(f: SharedFinding, actor: Actor, next: FindingState): boolean {
  if (!isAgentActor(actor)) return true;
  if (f.state !== "issued") return false;
  if (needsHumanAck(f)) return false;
  return next === "created" || next === "invalid";
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
        // Authorship decides the opening state, exactly as the old disposition
        // default did — but from `via`, not from a prefix on a name.
        state: isAgentActor(e.actor) ? "issued" : "created",
        corroboration: [],
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
        // A person may revise anyone's; an agent only while it is still a proposal.
        if (isAgentActor(e.actor) && f.state !== "issued") break;
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
        if (verdict !== "confirm" && verdict !== "refute" && verdict !== "unsure") break;
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
        };
        if (i >= 0) f.corroboration[i] = entry; else f.corroboration.push(entry);
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
        f.outcome = {
          result, detail: str(d, "detail") ?? "",
          files: Array.isArray(d?.files) ? (d.files as string[]) : undefined,
          by: e.actor, at: e.at,
        };
        break;
      }

      case "finding.requested": {
        const ask = str(d, "ask") as Ask | undefined;
        if (ask !== "promote" && ask !== "invalidate" && ask !== "refute" && ask !== "resolve") break;
        // One outstanding ask; a second replaces it, and the replacement is visible
        // because the superseded event is still in the log.
        f.pending = { ask, by: e.actor, at: e.at, rationale: str(d, "rationale") ?? "" };
        break;
      }

      case "finding.stateChanged": {
        const next = str(d, "state") as FindingState | undefined;
        if (!next || !["issued", "created", "invalid", "refuted", "resolved", "withdrawn"].includes(next)) break;
        // THE gate. An agent that tries to close a finding somebody stood behind is
        // ignored by every reader, not just by its own client.
        if (!mayTransition(f, e.actor, next)) break;
        f.state = next;
        if (isClosed(next)) f.closed = { at: e.at, by: e.actor, reason: str(d, "reason") ?? next };
        else f.closed = undefined;
        // An ask is answered by the act it asked for.
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

export const corroborate = (logRoot: string, pr: number | string, actor: Actor, id: string, verdict: Verdict, rationale: string) =>
  emit(logRoot, pr, actor, id, "finding.corroborated", { verdict, rationale });

export const comment = (logRoot: string, pr: number | string, actor: Actor, id: string, body: string, inReplyTo?: string) =>
  emit(logRoot, pr, actor, id, "finding.commented", { body, ...(inReplyTo ? { inReplyTo } : {}) });

export const promote = (logRoot: string, pr: number | string, actor: Actor, id: string) =>
  emit(logRoot, pr, actor, id, "finding.promoted");

export const request = (logRoot: string, pr: number | string, actor: Actor, id: string, ask: Ask, rationale: string) =>
  emit(logRoot, pr, actor, id, "finding.requested", { ask, rationale });

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
    return {
      error: needsHumanAck(current)
        ? `${id} needs a person: it is promoted or somebody has confirmed it, so an agent may only request \`${next}\`, not do it`
        : `an agent may not move ${id} from ${current.state} to ${next} — request it instead`,
    };
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
