/**
 * Bugs on the event log — a finding that outlives the pull request it was found in.
 *
 * The lifecycle is `shared-findings.ts`'s, imported rather than copied: `FindingState`,
 * the agent ratchet, `needsHumanAck`, asks, outcomes. A second copy of a lifecycle is
 * how two copies drift, and everything that makes a finding's lifecycle right — an
 * agent may propose but not close what a person stood behind — is true of a bug for
 * the same reasons.
 *
 * Three things differ, and each is forced by what a bug IS:
 *
 * **Scope is `bugs/<universe>`.** A finding is about a change, so `findingScope` is
 * PR-keyed. A bug outlives every PR that touches it.
 *
 * **Anchors are a grow-only set, not a revisable scalar.** The local bug carries
 * `addAnchors` and whole-witness refresh, and two people adding different anchors
 * offline are not in conflict — collapsing them to a contested array would either
 * lose one addition or ask somebody to arbitrate a disagreement that does not exist.
 * Removal is a person's act and lands as a TOMBSTONE, so it converges with a
 * concurrent addition instead of racing it.
 *
 * **The verdict does not travel; the witness does.** `possiblyFixed` is a join
 * against THIS machine's index, by the same rule that governs doc freshness. What
 * enters the log is the hash the filer saw. And when the code a bug cites vanishes,
 * the bug is NOT auto-closed — that is the silent green check this project exists to
 * prevent. Drift moves it to a queue and never past one; only a person can tell a fix
 * from a rename from a deletion that ignored the defect.
 */

import { createHash } from "node:crypto";
import { ISO_DATE, type Actor, type BugSeverity, type BugWitness } from "./schema.js";
import { isAgentActor, isIndependent, isErrorIndependent, reviewerKey } from "./identity.js";
import { emitEvent, mintId, readScope, causality, type LogEvent } from "./eventlog.js";
import { applyRevision, newContestState, type Contested } from "./contest.js";
import {
  isClosed, mayTransition, mayRevise, needsHumanAck,
  isAsk, type Ask, type Corroboration, type ExternalRef, type FindingComment,
  type FindingState, type Verdict,
} from "./shared-findings.js";

export { isClosed, needsHumanAck, mayTransition, mayRevise };
export type { Ask, Verdict, FindingState as BugState };

/**
 * One cited anchor, with the hash it was cited AT.
 *
 * Per-anchor rather than one witness list beside the ids: an anchor added a month
 * later was witnessed at a different commit, and a single refresh timestamp cannot
 * say which of them the reader is looking at.
 */
export interface BugAnchor {
  anchorId: string;
  bodyHash: string;
  by: Actor;
  at: string;
  /** Removed by a person. The row stays so a concurrent re-add cannot resurrect it silently. */
  removed?: { by: Actor; at: string; reason: string };
}

export interface SharedBug {
  id: string;
  title: string;
  /** Prose: what is wrong, repro, expected vs actual. `Bug.description` locally. */
  text: string;
  severity: BugSeverity;
  category?: string;
  anchors: BugAnchor[];
  /** The commit the filer was on. Evidence for reading the witnesses, not a ref to resolve. */
  createdCommit?: string;
  author: Actor;
  /** When this entered the TEAM's log. The event's own time, so it cannot be backdated. */
  createdAt: string;
  /**
   * When it was first recorded, if that is not `createdAt`.
   *
   * Only a bug that existed locally before the team had a sidecar has one: publishing it
   * is an act happening now, and `createdAt` says so, but "this has been open eight
   * months" is exactly the fact triage needs and the publish would otherwise erase. It
   * is the publisher's claim, not the log's — which is why it is a separate field
   * rather than a `createdAt` the writer gets to choose.
   */
  filedAt?: string;

  state: FindingState;
  corroboration: Corroboration[];
  thread: FindingComment[];

  promotion?: { at: string; by: Actor };
  /**
   * Where this is tracked outside codemap, at most one entry per system.
   *
   * A list rather than a scalar because a bug genuinely can be a Jira ticket AND a
   * GitHub issue, and a grow-only map keyed by system converges without anybody
   * arbitrating. Within one system the FIRST entry stands — two people filing the
   * same Jira ticket is the duplicate this log exists to prevent — and a person may
   * replace theirs, which an agent may not.
   */
  tracking: ExternalRef[];
  /** The finding this was accepted from, if it began as one. */
  from?: { pr: string; finding: string };

  assignment?: { kind: "investigate" | "fix" | "answer"; by: Actor; at: string; note?: string };
  outcome?: { result: "fixed" | "answered" | "declined"; detail: string; files?: string[]; by: Actor; at: string };
  pending?: { ask: Ask; by: Actor; at: string; rationale: string };
  closed?: { at: string; by: Actor; reason: string };

  revisions: { at: string; by: Actor; was: Record<string, unknown> }[];
  contested?: Contested[];

  /**
   * The bug is real, it is not being fixed now, and it WILL come back.
   *
   * The third exit a finding got, one record kind over — and it is needed here for the
   * same measured reason. A bug nobody will reach this quarter has two options today:
   * stay in the open queue and dilute it, or close as won't-fix, which asserts a
   * decision nobody made. The first is what actually happens, and it is how a bug queue
   * stops being read.
   *
   * **It is never deleted and never silenced from search.** That is the one hard
   * constraint and it is where this differs from the finding backlog, which can afford
   * `sleeping` to be quiet: a finding is a claim about one pull request, and a bug is a
   * standing defect record. A defect you cannot find is worse than one nobody has
   * prioritised. So a backlogged bug leaves the WORKING queue and stays in `search`, in
   * `bugs`, and on every surface that lists one — carrying a visible deadline so it
   * never reads as an ordinary open bug nobody is doing.
   *
   * `until` is required and the FOLD enforces it, the `acknowledgements` rule verbatim:
   * a linked ticket may be evidence but never the release condition, because one closed
   * as won't-do, moved or deleted leaves the record asleep permanently and silently.
   * Every deferral in the measured finding data was in exactly that state.
   *
   * `witnesses` is snapshotted HERE rather than read off the bug's citations, and this
   * is the subtlety the finding side got wrong first: backlogging follows an
   * investigation, so a condition keyed on the filing witnesses fires the moment it is
   * set, on code that moved days ago. These are the code as it stood when somebody said
   * "not now", so drift against THEM means somebody is editing the exact code that
   * decision was about.
   *
   * Principal-granted at both ends, like `debt`. With a backlog this size, deferral is
   * the cheapest way to empty a queue.
   */
  backlogged?: {
    /** ISO date. The release condition, and a required one. */
    until: string;
    /** The cited code as it stood when this was granted — drift against THESE wakes it. */
    witnesses?: BugWitness[];
    /** Why it is not being fixed now. A record of a decision, not a mute button. */
    reason: string;
    by: Actor; at: string;
    /** Evidence — a Jira issue. Never the release condition. */
    ref?: ExternalRef;
  };

  /**
   * Which sidecar scope this machine's copy came from — set by the STORE, never by the
   * fold. A bug with none is one this clone holds alone: filed before a sidecar was
   * configured, or never published.
   */
  origin?: { scope: string };
}

/** `bugs/acme/api` — universe-qualified, like docs. One scope for the whole universe. */
export const bugScope = (universe: string): string => `bugs/${universe}`;

/**
 * The bug id a finding becomes, derived from the finding rather than minted.
 *
 * Two people accepting the same finding offline would otherwise mint two random ids
 * and the team would carry one defect twice — the exact failure "raise this to the
 * team" hit in `docs/plan-sharing-the-rest.md`'s review. Derived, both write the same
 * id, and the fold's create-once rule merges them into one bug whose thread holds
 * both people's reasoning.
 */
export const bugIdFor = (findingId: string): string =>
  "bug_" + createHash("sha256").update(`finding\0${findingId}`).digest("hex").slice(0, 12);

/** Live anchors — the tombstoned ones are history, not citations. */
export const citedAnchors = (b: SharedBug): string[] =>
  b.anchors.filter((a) => !a.removed).map((a) => a.anchorId);

/** The witness list, in the shape `witnessDrift` already takes. */
export const witnessesOf = (b: SharedBug): BugWitness[] =>
  b.anchors.filter((a) => !a.removed).map((a) => ({ anchorId: a.anchorId, bodyHash: a.bodyHash }));

/** Has somebody put this in a tracker outside codemap? */
export const isTracked = (b: SharedBug): boolean => b.tracking.length > 0;

// ---------------------------------------------------------------------------
// The fold
// ---------------------------------------------------------------------------

type Data = Record<string, unknown>;
const str = (d: Data | undefined, k: string): string | undefined => {
  const v = d?.[k];
  return typeof v === "string" && v.trim() ? v : undefined;
};

const SEVERITIES: readonly string[] = ["low", "medium", "high", "critical"];
const severity = (d: Data | undefined, k = "severity"): BugSeverity | undefined => {
  const v = str(d, k);
  return v && SEVERITIES.includes(v) ? (v as BugSeverity) : undefined;
};

/** Anchor citations off an event, ignoring anything that is not a witnessed id. */
function anchorsIn(d: Data | undefined): { anchorId: string; bodyHash: string }[] {
  const raw = d?.anchors;
  if (!Array.isArray(raw)) return [];
  const out: { anchorId: string; bodyHash: string }[] = [];
  for (const a of raw) {
    const anchorId = str(a as Data, "anchorId");
    // A citation with no witness is the thing that makes staleness undetectable, so
    // it is not a citation. `sha256:absent` is what the local filer writes when the
    // symbol is not in its index, and it IS a witness — it says "I looked and it was
    // not there", which a later reader can act on.
    const bodyHash = str(a as Data, "bodyHash");
    if (anchorId && bodyHash) out.push({ anchorId, bodyHash });
  }
  return out;
}

/** The scalars one person owns — the only ones that can be contested. */
const CONTESTABLE = ["title", "text", "severity", "category"] as const;

/**
 * Every bug in a universe, folded from its events.
 *
 * Malformed and ratchet-breaking events are skipped rather than fatal, for the reason
 * they are in `foldFindings`: they arrive from other people's clients, and a store
 * that refuses to load — or that lets one bad client rewrite everyone's state — is
 * worse than one that ignores a record.
 */
export function foldBugs(events: LogEvent[]): Map<string, SharedBug> {
  const out = new Map<string, SharedBug>();
  const contest = newContestState();
  const causal = causality(events);

  for (const e of events) {
    const d = e.data as Data | undefined;

    if (e.kind === "bug.filed") {
      const title = str(d, "title");
      const text = str(d, "text");
      if (!title || !text) continue;
      const existing = out.get(e.subject);
      if (existing) {
        // A second filing of one id is not a second bug — `bugIdFor` makes two people
        // accepting one finding land here on purpose. Their citations MERGE (the
        // grow-only rule, applied to the create event too) and the first filing is
        // the record for everything a single person owns.
        for (const a of anchorsIn(d)) addAnchor(existing, a, e.actor, e.at);
        continue;
      }
      out.set(e.subject, {
        id: e.subject,
        title,
        text,
        severity: severity(d) ?? "medium",
        category: str(d, "category"),
        anchors: anchorsIn(d).map((a) => ({ ...a, by: e.actor, at: e.at })),
        createdCommit: str(d, "createdCommit"),
        author: e.actor,
        createdAt: e.at,
        filedAt: str(d, "filedAt"),
        // Same rule as a finding, from `via` and not from a prefix on a name: an
        // agent PROPOSES a bug, a person stands behind one.
        state: isAgentActor(e.actor) ? "issued" : "created",
        corroboration: [],
        thread: [],
        tracking: [],
        from: (() => {
          const pr = str(d, "fromPr");
          const finding = str(d, "fromFinding");
          return pr && finding ? { pr, finding } : undefined;
        })(),
        revisions: [],
      });
      continue;
    }

    const b = out.get(e.subject);
    if (!b) continue; // an event about a bug this universe has never seen

    switch (e.kind) {
      case "bug.revised": {
        const was = (d?.was as Record<string, unknown>) ?? {};
        const now = (d?.now as Record<string, unknown>) ?? {};
        // A person may revise anyone's; an agent only while nobody has stood behind it.
        // Same gate as a finding's, from the same function — the two folds spelling one
        // rule out separately is how they drift.
        if (!mayRevise(b, e.actor)) break;
        applyRevision(b, e, now, CONTESTABLE, contest, causal);
        b.revisions.push({ at: e.at, by: e.actor, was });
        if (typeof now.title === "string") b.title = now.title;
        if (typeof now.text === "string") b.text = now.text;
        const s = severity(now as Data);
        if (s) b.severity = s;
        if (typeof now.category === "string") b.category = now.category;
        break;
      }

      case "bug.anchored": {
        // Grow-only. Two people citing different code on one bug are both right, and
        // this is the one place findings' scalar-revision semantics do not transfer.
        for (const a of anchorsIn(d)) addAnchor(b, a, e.actor, e.at);
        break;
      }

      case "bug.unanchored": {
        const anchorId = str(d, "anchorId");
        if (!anchorId) break;
        // A person's act. An agent dropping the evidence for a defect is the
        // false-provenance failure `witness` exists to prevent, and a bug that
        // silently stops pointing anywhere is worse than one pointing at moved code.
        if (isAgentActor(e.actor)) break;
        const hit = b.anchors.find((x) => x.anchorId === anchorId);
        if (!hit || hit.removed) break;
        hit.removed = { by: e.actor, at: e.at, reason: str(d, "reason") ?? "removed" };
        break;
      }

      case "bug.corroborated": {
        const verdict = str(d, "verdict") as Verdict | undefined;
        if (verdict !== "confirm" && verdict !== "refute" && verdict !== "unsure") break;
        // One entry per REVIEWER — the person plus the model that spoke for them.
        // See `reviewerKey`: keying on the principal alone let one person's second
        // model quietly overwrite their first, and the disagreement IS the signal.
        const i = b.corroboration.findIndex((c) => reviewerKey(c.actor) === reviewerKey(e.actor));
        const entry: Corroboration = {
          actor: e.actor, verdict, at: e.at,
          rationale: str(d, "rationale") ?? "",
          independent: isIndependent(e.actor, b.author),
          errorIndependent: isErrorIndependent(e.actor, b.author),
        };
        if (i >= 0) b.corroboration[i] = entry; else b.corroboration.push(entry);
        break;
      }

      case "bug.backlogged": {
        // BOTH ENDS. `backlogBug` refuses an agent with a sentence; this drops the event,
        // because a teammate's clone applies the log without ever seeing that check and a
        // guard in one end binds one machine. Twelve defects of exactly this shape are on
        // record across this subsystem.
        if (isAgentActor(e.actor)) break;
        const until = str(d, "until"), reason = str(d, "reason");
        // No deadline, no backlogging. A record whose whole point is that it comes back
        // and which has no date is the permanent silent silencing `acknowledgements`
        // refuses for the same reason.
        if (!until || !ISO_DATE.test(until) || !reason) break;
        // Only the bug's OWN live citations may witness it. Without this a caller could
        // point the release condition at unrelated code: the record would keep saying it
        // is about these anchors while every drift answer came from others, so edits to
        // the actual defect would never wake it and edits elsewhere would. The fold can
        // check this where the finding fold could not, because a bug's citations are
        // fold state rather than store state.
        const cited = new Set(citedAnchors(b));
        const witnesses = anchorsIn(d).filter((w) => cited.has(w.anchorId));
        b.backlogged = {
          until, reason, by: e.actor, at: e.at,
          // Dropping only the WITNESSES if they do not bind: the deadline is the
          // guaranteed release condition, and a decision somebody made should not be
          // lost over a bad optional field. Date-only is a supported state — it is
          // exactly what an acknowledgement has.
          ...(witnesses.length ? { witnesses } : {}),
          ...(str(d, "system") ? { ref: { system: str(d, "system")!, key: str(d, "key"), url: str(d, "url"), at: e.at, by: e.actor } } : {}),
        };
        break;
      }

      case "bug.backlogReleased":
        // Also principal-only, and for the symmetrical reason: an agent that could end one
        // could bring back every one, which is the same queue-clearing move from the other
        // side. Deleting the field rather than dating it — it is back, and the events
        // remain the history.
        if (isAgentActor(e.actor)) break;
        // The writer refuses an empty reason; so does the fold, or a buggy or older client
        // could un-backlog a bug with no record of why and every clone would apply it.
        if (!str(d, "reason")) break;
        delete b.backlogged;
        break;

      case "bug.commented": {
        const body = str(d, "body");
        if (!body) break;
        b.thread.push({ id: e.id, actor: e.actor, at: e.at, body, inReplyTo: str(d, "inReplyTo") });
        break;
      }

      case "bug.promoted":
        if (!b.promotion) b.promotion = { at: e.at, by: e.actor };
        break;

      case "bug.tracked": {
        const system = str(d, "system") ?? "jira";
        const key = str(d, "key");
        const url = str(d, "url");
        // A reference to nowhere is not tracking. One of the two is enough — a Jira
        // key without a base URL is still what somebody types into search.
        if (!key && !url) break;
        const ref: ExternalRef = { system, key, url, at: e.at, by: e.actor };
        const i = b.tracking.findIndex((t) => t.system === system);
        if (i < 0) { b.tracking.push(ref); break; }
        // Latched per system. Replacing one is a person's act: an agent re-pointing a
        // bug at a different ticket detaches the team's conversation from it silently.
        if (!isAgentActor(e.actor)) b.tracking[i] = ref;
        break;
      }

      case "bug.assigned": {
        const kind = str(d, "kind");
        if (kind !== "investigate" && kind !== "fix" && kind !== "answer") break;
        b.assignment = { kind, by: e.actor, at: e.at, note: str(d, "note") };
        break;
      }

      case "bug.outcome": {
        const result = str(d, "result");
        if (result !== "fixed" && result !== "answered" && result !== "declined") break;
        // Reporting is not resolving: the agent says what it did, a person closes.
        b.outcome = {
          result, detail: str(d, "detail") ?? "",
          files: Array.isArray(d?.files) ? (d.files as string[]) : undefined,
          by: e.actor, at: e.at,
        };
        break;
      }

      case "bug.requested": {
        const ask = str(d, "ask");
        if (!isAsk(ask)) break;
        b.pending = { ask, by: e.actor, at: e.at, rationale: str(d, "rationale") ?? "" };
        break;
      }

      case "bug.stateChanged": {
        const next = str(d, "state") as FindingState | undefined;
        if (!next || !["issued", "created", "invalid", "refuted", "resolved", "withdrawn"].includes(next)) break;
        if (!mayTransition(b, e.actor, next)) break;
        b.state = next;
        if (isClosed(next)) b.closed = { at: e.at, by: e.actor, reason: str(d, "reason") ?? next };
        else b.closed = undefined;
        b.pending = undefined;
        break;
      }
    }
  }
  return out;
}

/**
 * Add a citation, or refresh the witness on one already there.
 *
 * Re-citing an anchor with a NEWER hash is how "I looked again and this is still the
 * code" is said — the local `refreshWitnesses` act, in the log. It does not resurrect
 * a removed one: that would let an agent undo a person's removal by re-filing.
 */
function addAnchor(b: SharedBug, a: { anchorId: string; bodyHash: string }, by: Actor, at: string): void {
  const hit = b.anchors.find((x) => x.anchorId === a.anchorId);
  if (!hit) { b.anchors.push({ ...a, by, at }); return; }
  if (hit.removed) return;
  if (hit.bodyHash === a.bodyHash) return;
  hit.bodyHash = a.bodyHash;
  hit.by = by;
  hit.at = at;
}

// ---------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------

const emit = (
  logRoot: string, universe: string, actor: Actor,
  subject: string, kind: string, data?: Data,
): Promise<LogEvent> => emitEvent(logRoot, bugScope(universe), actor, kind, subject, data);

export interface NewBug {
  /** Supplied when the bug already has an identity — a local bug being published, or `bugIdFor`. */
  id?: string;
  title: string;
  text: string;
  severity?: BugSeverity;
  category?: string;
  anchors: BugWitness[];
  createdCommit?: string;
  /** Set only when publishing something that already existed here. See `SharedBug.filedAt`. */
  filedAt?: string;
  from?: { pr: string | number; finding: string };
}

export async function fileBug(logRoot: string, universe: string, actor: Actor, b: NewBug): Promise<string> {
  const id = b.id ?? "bug_" + mintId();
  await emit(logRoot, universe, actor, id, "bug.filed", {
    title: b.title, text: b.text, severity: b.severity ?? "medium", category: b.category,
    anchors: b.anchors, createdCommit: b.createdCommit, filedAt: b.filedAt,
    ...(b.from ? { fromPr: String(b.from.pr), fromFinding: b.from.finding } : {}),
  });
  return id;
}

export const commentOnBug = (logRoot: string, universe: string, actor: Actor, id: string, body: string, inReplyTo?: string) =>
  emit(logRoot, universe, actor, id, "bug.commented", { body, ...(inReplyTo ? { inReplyTo } : {}) });

export const corroborateBug = (logRoot: string, universe: string, actor: Actor, id: string, verdict: Verdict, rationale: string) =>
  emit(logRoot, universe, actor, id, "bug.corroborated", { verdict, rationale });

export const promoteBug = (logRoot: string, universe: string, actor: Actor, id: string) =>
  emit(logRoot, universe, actor, id, "bug.promoted");

export const requestOnBug = (logRoot: string, universe: string, actor: Actor, id: string, ask: Ask, rationale: string) =>
  emit(logRoot, universe, actor, id, "bug.requested", { ask, rationale });

export const assignBug = (logRoot: string, universe: string, actor: Actor, id: string, kind: "investigate" | "fix" | "answer", note?: string) =>
  emit(logRoot, universe, actor, id, "bug.assigned", { kind, ...(note ? { note } : {}) });

export const reportOnBug = (logRoot: string, universe: string, actor: Actor, id: string, result: "fixed" | "answered" | "declined", detail: string, files?: string[]) =>
  emit(logRoot, universe, actor, id, "bug.outcome", { result, detail, ...(files ? { files } : {}) });

export const anchorBug = (logRoot: string, universe: string, actor: Actor, id: string, anchors: BugWitness[]) =>
  emit(logRoot, universe, actor, id, "bug.anchored", { anchors });

export const reviseBug = (logRoot: string, universe: string, actor: Actor, id: string, now: Record<string, unknown>, was: Record<string, unknown> = {}) =>
  emit(logRoot, universe, actor, id, "bug.revised", { now, was });

/**
 * Backlog a bug: real, not now, and it comes back.
 *
 * `until` and `reason` are both required and the FOLD checks them too — an event missing
 * either is a deferral that never wakes, which is the failure this record exists to
 * prevent. `witnesses` is the cited code as it stands NOW, not the hashes the bug was
 * filed with; see `SharedBug.backlogged`.
 */
export const backlogBugEvent = (
  logRoot: string, universe: string, actor: Actor, id: string,
  input: { until: string; reason: string; witnesses?: BugWitness[]; ref?: { system: string; key?: string; url?: string } },
) => emit(logRoot, universe, actor, id, "bug.backlogged", {
  until: input.until, reason: input.reason,
  ...(input.witnesses?.length ? { anchors: input.witnesses.map((w) => ({ ...w })) } : {}),
  ...(input.ref ? { system: input.ref.system, ...(input.ref.key ? { key: input.ref.key } : {}), ...(input.ref.url ? { url: input.ref.url } : {}) } : {}),
} as Data);

/** Bring one back early — it returns to the working queue. A person's, as granting is. */
export const releaseBugBacklogEvent = (logRoot: string, universe: string, actor: Actor, id: string, reason: string) =>
  emit(logRoot, universe, actor, id, "bug.backlogReleased", { reason });

/** Say where this is tracked outside codemap — a Jira ticket, a GitHub issue. */
export const trackBug = (logRoot: string, universe: string, actor: Actor, id: string, ref: { system?: string; key?: string; url?: string }) =>
  emit(logRoot, universe, actor, id, "bug.tracked", { system: "jira", ...ref });

export async function readBugsShared(logRoot: string, universe: string): Promise<Map<string, SharedBug>> {
  return foldBugs(await readScope(logRoot, bugScope(universe)));
}

/**
 * Drop a citation. A person only — the fold ignores an agent's, so refusing here is
 * about giving a reason instead of a silent no-op.
 */
export async function unanchorBug(
  logRoot: string, universe: string, actor: Actor, id: string, anchorId: string, reason: string,
): Promise<LogEvent | { error: string }> {
  if (isAgentActor(actor)) {
    return { error: `removing the evidence under a bug is a person's call — say what you found in a comment instead` };
  }
  return emit(logRoot, universe, actor, id, "bug.unanchored", { anchorId, reason });
}

/**
 * Move a bug's state. Refuses up front where the ratchet forbids it — the fold would
 * ignore the event anyway, and a silent no-op is a worse answer than an error.
 */
export async function setBugState(
  logRoot: string, universe: string, actor: Actor, id: string, next: FindingState, reason?: string,
): Promise<LogEvent | { error: string }> {
  const current = (await readBugsShared(logRoot, universe)).get(id);
  if (!current) return { error: `no bug ${id} in ${universe}` };
  if (!mayTransition(current, actor, next)) {
    return {
      error: needsHumanAck(current)
        ? `${id} needs a person: it is promoted or somebody has confirmed it, so an agent may only request \`${next}\`, not do it`
        : `an agent may not move ${id} from ${current.state} to ${next} — request it instead`,
    };
  }
  return emit(logRoot, universe, actor, id, "bug.stateChanged", { state: next, ...(reason ? { reason } : {}) });
}

/**
 * Clear a contested field by stating what it should be. A person only, for the reason
 * `resolveContest` gives on findings: agents do not arbitrate between people.
 */
export async function resolveBugContest(
  logRoot: string, universe: string, actor: Actor, id: string, field: string, value: unknown,
): Promise<LogEvent | { error: string }> {
  if (isAgentActor(actor)) {
    return { error: `${field} is contested between two people — an agent may not decide it. Ask, or leave it for them.` };
  }
  const b = (await readBugsShared(logRoot, universe)).get(id);
  if (!b) return { error: `no bug ${id}` };
  if (!b.contested?.some((c) => c.field === field)) return { error: `${field} is not contested on ${id}` };
  return emit(logRoot, universe, actor, id, "bug.revised", { now: { [field]: value } });
}

/**
 * What is waiting on a person.
 *
 * Deliberately NOT including drift: whether a bug's code moved is a local join, so a
 * queue computed here would be missing exactly the entries the log cannot know about.
 * `ops/bugs.ts` adds them where the index is.
 */
export function bugAckQueue(bugs: Iterable<SharedBug>): SharedBug[] {
  return [...bugs].filter((b) =>
    !isClosed(b.state)
    && (needsHumanAck(b) || !!b.pending || !!b.contested?.length));
}
