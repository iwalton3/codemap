/**
 * Why a cited anchor is not in this checkout — and whether that is anyone's
 * problem.
 *
 * "Not in this checkout" conflates four different situations, and treating them
 * alike is what turns a shared store into a queue of things nobody can act on. A
 * dry run against a real repo produced 985 docs, most of them citing symbols the
 * current branch does not have; almost none of that was work.
 *
 *   here        the anchor is in `@work`
 *   offTree     it is in a cached commit snapshot — another branch has it. NOT an
 *               action item: the record is fine, it is simply not about the code
 *               you have. Determined automatically, so nobody acks it.
 *   retained    gone from the tree and every snapshot, but `@orphan` kept its last
 *               known file/symbol/line. Actionable: renamed, moved, or deleted.
 *   lost        no record anywhere. Filed before retention existed, or the record
 *               was dropped. Actionable, and the hardest to judge.
 *   unknown     this universe has no index here, so the question cannot be
 *               answered. NOT actionable — somebody who has pulled the sidecar but
 *               not yet run `init` must still be able to read the team's findings,
 *               and telling them everything is `lost` would be a confident lie.
 *
 * The buckets are `ops.orphans`', deliberately: a second vocabulary for the same
 * question is how two parts of a tool start disagreeing about what is missing.
 */

import type { Anchor } from "./schema.js";
import { readAnchorStore, findAnchorsOutsideWork, readOrphans, workHas} from "./store.js";

export type CitationState = "here" | "offTree" | "retained" | "lost" | "unknown";

export interface CitationPlace {
  state: CitationState;
  /** For `offTree`, the snapshot ref that has it; for `retained`, `@orphan`. */
  at?: string;
  /** Last known location, when anything knows one. */
  file?: string;
  symbol?: string;
}

/**
 * Classify a set of cited anchor ids against this checkout.
 *
 * One pass over the store rather than per-citation lookups: a catalogue view asks
 * about every citation of every doc, and the dry run had a thousand of them.
 */
export async function classifyCitations(root: string, anchorIds: string[]): Promise<Map<string, CitationPlace>> {
  const out = new Map<string, CitationPlace>();
  if (!anchorIds.length) return out;

  let work: Set<string>;
  try {
    // Membership for the ids ASKED ABOUT, not a Set of every anchor in the universe.
    // A catalogue view asks about every citation of every doc — the dry run had a
    // thousand — and building the whole set to test a handful was one of the two
    // full table scans `sharedDocs` paid on every call.
    work = workHas(root, [...new Set(anchorIds)]);
  } catch {
    // No index in this universe yet. Reading shared state must not require one.
    for (const id of anchorIds) out.set(id, { state: "unknown" });
    return out;
  }
  const missing = anchorIds.filter((id) => !work.has(id));
  for (const id of anchorIds) if (work.has(id)) out.set(id, { state: "here" });
  if (!missing.length) return out;

  const elsewhere = findAnchorsOutsideWork(root, missing);
  const orphans = readOrphans(root, missing.filter((id) => !elsewhere.has(id)));

  for (const id of missing) {
    const s = elsewhere.get(id);
    if (s) { out.set(id, { state: "offTree", at: s.ref, file: s.anchor.file, symbol: name(s.anchor) }); continue; }
    const k = orphans.get(id);
    if (k) { out.set(id, { state: "retained", at: "@orphan", file: k.file, symbol: name(k) }); continue; }
    out.set(id, { state: "lost" });
  }
  return out;
}

const name = (a: Anchor): string => a.symbolPath[a.symbolPath.length - 1] ?? "";

/**
 * Does this record need somebody to do something about its missing citations?
 *
 * `offTree` deliberately does not count. Asking a person to acknowledge that a
 * symbol lives on a branch they are not on is manufacturing work — and a queue
 * full of manufactured work is how the real items stop being read.
 */
export const needsAttention = (places: Iterable<CitationPlace>): boolean =>
  [...places].some((p) => p.state === "retained" || p.state === "lost");
