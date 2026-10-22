/**
 * The findings a scope's log makes, whichever act made them: each `finding.created`, and each
 * leftover problem a verifier left on a repair verification, which the request's first
 * APPLICATION makes (C4). There is no act for a leftover, so none can be skipped. Pure over the
 * events and a leaf (an ES-module cycle made the old filer exist), so the findings fold, the
 * repair records and every cross-scope "does this finding exist" check read one answer:
 * `findingIds`, never their own scan for `finding.created` (`finding-created-sweep.test.ts`).
 *
 * Every application in a readable log is an accepted one — a refused one is damage and locks —
 * so this does not run the verification fold.
 */
import { createHash } from "node:crypto";
import { COMMENT_MAX, type Actor } from "./schema.js";
import type { LogEvent } from "./eventlog.js";

/**
 * Whether `e` was written under EVENT_SCHEMA 6's close-out rules (plan 2026-10-20 Phase 2): stakes
 * on every posted sort, evidence that can meet the bar at filing, slot 2's derived check, leftovers
 * the application makes. An event stamped lower keeps the rules it was written under, so a
 * stakes-less sort or evidence filed before the bar stays valid instead of becoming damage.
 */
export const CLOSEOUT_SCHEMA = 6;
export const closeoutRules = (e: Pick<LogEvent, "eventSchema">): boolean => (e.eventSchema ?? 0) >= CLOSEOUT_SCHEMA;

/** Where a leftover finding came from: the finding whose closure left it, and every run that named the text. */
export interface LeftoverOrigin { parent: string; requestId: string; applicationId: string; runs: { id: string; slot: number; kind: "problem" | "note" }[] }

/** A finding as its log filed it: the creating event's data, or a leftover's derived equivalent. */
export interface FiledFinding { id: string; eventId: string; actor: Actor; at: string; data: Record<string, unknown>; leftover?: LeftoverOrigin }

/** A leftover's id: one per request and problem text, so sibling applications of a request make one finding. */
export const leftoverId = (requestId: string, text: string): string =>
  "f_" + createHash("sha256").update(`leftover\0${requestId}\0${text}`).digest("hex").slice(0, 24);

type Run = { id: string; slot: number; identity: { principal: string; harness?: string }; leftovers?: { kind: "problem" | "note"; text: string }[] };

/** Every finding the events file, in log order: each `finding.created` event, and each derived leftover. */
export function filedFindings(events: LogEvent[]): FiledFinding[] {
  const out: FiledFinding[] = [];
  const asFiled = new Map<string, Record<string, unknown>>();
  const fixOf = new Map<string, string>(), runsOf = new Map<string, Run[]>(), applied = new Set<string>();
  for (const e of events) {
    const d = e.data as Record<string, any> | undefined;
    if (e.kind === "finding.created") {
      out.push({ id: e.subject, eventId: e.id, actor: e.actor, at: e.at, data: d ?? {} });
      if (d && !asFiled.has(e.subject)) asFiled.set(e.subject, d);
    } else if (e.kind === "repair.verification-requested" && typeof d?.id === "string") {
      if (typeof d.capsule?.evidence?.fixCommit === "string") fixOf.set(d.id, d.capsule.evidence.fixCommit);
    } else if (e.kind === "repair.verification-recorded" && typeof d?.requestId === "string") {
      runsOf.set(d.requestId, [...(runsOf.get(d.requestId) ?? []), d as Run]);
    } else if (e.kind === "finding.repairApplied" && typeof d?.requestId === "string" && !applied.has(d.requestId)) {
      applied.add(d.requestId);
      const parent = asFiled.get(d.findingId);
      const problems: unknown[] = Array.isArray(d.leftovers?.problems) ? d.leftovers.problems : [];
      if (!closeoutRules(e) || d.leftoversHeld !== undefined || !parent) continue;
      const runs = [...(runsOf.get(d.requestId) ?? [])].sort((a, b) => a.slot - b.slot);
      for (const text of problems) {
        if (typeof text !== "string" || !text.trim()) continue;
        const named = runs.flatMap((r) => (Array.isArray(r.leftovers) ? r.leftovers : []).filter((x) => typeof x?.text === "string" && x.text.trim() === text).map((x) => ({ id: r.id, slot: r.slot, kind: x.kind })));
        // The lowest slot whose run called it a problem is its author (owner, Q3: "Both are right").
        const by = runs.find((r) => typeof r.identity?.principal === "string" && named.some((n) => n.id === r.id && n.kind === "problem"));
        const author: Actor = by ? { principal: by.identity.principal, via: { kind: "agent", ...(by.identity.harness ? { harness: by.identity.harness } : {}) } } : e.actor;
        const id = leftoverId(d.requestId, text), fix = fixOf.get(d.requestId);
        const data: Record<string, unknown> = {
          targetKind: parent.targetKind, targetId: parent.targetId,
          text: `Left over from ${d.findingId} when repair verification ${d.requestId} closed it: ${text}`,
          comment: text.slice(0, COMMENT_MAX),
          ...(fix ? { sourceRef: fix } : {}),
          ...(typeof parent.branch === "string" ? { branch: parent.branch } : {}),
          ...(typeof parent.topic === "string" ? { topic: parent.topic } : {}),
          ...(d.leftoverWitness ? { witness: d.leftoverWitness } : {}),
        };
        if (!asFiled.has(id)) asFiled.set(id, data);
        out.push({ id, eventId: e.id, actor: author, at: e.at, data, leftover: { parent: d.findingId, requestId: d.requestId, applicationId: d.id, runs: named } });
      }
    }
  }
  return out;
}

/** Whether a finding exists in these events — the one predicate every existence check calls. */
export const findingIds = (events: LogEvent[]): Set<string> => new Set(filedFindings(events).map((f) => f.id));
