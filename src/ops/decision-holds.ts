/**
 * Which findings a decision holds from open work, for the lists that offer findings as work
 * (owner, B1.3 "Queues skip held"; H7.13–15). Its own module because `ops/annotations` cannot
 * reach `ops-shared` without closing a cycle through `ops/triage`.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { readCached } from "../materialize.js";
import { decisionsProjection } from "../shared-projections.js";
import { resolveSidecar, sidecarIdentity } from "../sidecar-config.js";
import { decisionScope, foldDecisions, heldFindings, type Hold } from "../shared-decisions.js";

/** The holds, or why they cannot be known — never "none" from a log nobody could read (H7.14). */
export type Holds = { held: Map<string, Hold[]> } | { unknown: string };

export async function decisionHolds(root: string, isOpen: (finding: string) => boolean): Promise<Holds> {
  const cfg = resolveSidecar(root);
  // No sidecar, no decisions: a decision op refuses to make one, so nothing can hold anything.
  if (!cfg || !existsSync(join(cfg.path, ".git"))) return { held: new Map() };
  // Nor with no decisions log yet. Asked here, not left to the fold: an ordinary findings read
  // must not fold a scope the sync never had to materialize (the oracle's COMPLETENESS).
  if (!existsSync(join(cfg.path, decisionScope(cfg.universe)))) return { held: new Map() };
  const { value, status, diagnostic } = await readCached(root, cfg.path, decisionScope(cfg.universe), sidecarIdentity(cfg), foldDecisions, decisionsProjection);
  if (status === "blocked") return { unknown: diagnostic?.detail ?? "the decisions log cannot be read" };
  return { held: heldFindings(value, isOpen) };
}

/** A row's mark: its holds, or `"unknown"`, or nothing. */
export const holdMark = (h: Holds, id: string): { held?: Hold[] | "unknown" } => {
  if ("unknown" in h) return { held: "unknown" };
  const list = h.held.get(id);
  return list?.length ? { held: list } : {};
};
