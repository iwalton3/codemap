/**
 * Resolving human-friendly anchor references → anchor ids (P1.1).
 *
 * Agents know code as `file#Symbol`, not `a_1a2b…`. Accept that (plus `file:line`
 * and raw ids) and resolve server-side, so map-building doesn't need a `search`
 * round-trip before every write.
 */

import { type Anchor } from "./schema.js";

interface Resolution {
  id?: string;
  error?: string;
}

function resolveOne(anchors: Anchor[], byId: Map<string, Anchor>, ref: string): Resolution {
  if (byId.has(ref)) return { id: ref };

  const hash = ref.indexOf("#");
  if (hash !== -1) {
    const file = ref.slice(0, hash);
    const sym = ref.slice(hash + 1);
    const fileMatch = (a: Anchor) => a.file === file || a.file.endsWith("/" + file);
    const symMatch = (a: Anchor) => {
      const path = a.symbolPath.join(".");
      return path === sym || a.symbolPath[a.symbolPath.length - 1] === sym || path.endsWith("." + sym);
    };
    const cands = anchors.filter((a) => fileMatch(a) && symMatch(a));
    if (cands.length === 1) return { id: cands[0]!.id };
    if (cands.length === 0) return { error: `no anchor for "${ref}"` };
    return { error: `ambiguous "${ref}" → ${cands.slice(0, 6).map((c) => `${c.symbolPath.join(".")} (${c.id})`).join(", ")}` };
  }

  const colon = ref.lastIndexOf(":");
  if (colon !== -1 && /^\d+$/.test(ref.slice(colon + 1))) {
    const file = ref.slice(0, colon);
    const line = Number(ref.slice(colon + 1));
    const cands = anchors
      .filter((a) => (a.file === file || a.file.endsWith("/" + file)) && a.loc && a.loc.startLine <= line && line <= a.loc.endLine)
      .sort((x, y) => (x.loc!.endLine - x.loc!.startLine) - (y.loc!.endLine - y.loc!.startLine)); // most specific
    if (cands.length) return { id: cands[0]!.id };
    return { error: `no anchor at "${ref}"` };
  }

  return { error: `unresolved anchor ref "${ref}"` };
}

/** Resolve a list of refs; returns resolved ids and per-ref errors (ambiguous/missing). */
export function resolveAnchorRefs(anchors: Anchor[], refs: string[]): { ids: string[]; errors: string[] } {
  const byId = new Map(anchors.map((a) => [a.id, a]));
  const ids: string[] = [];
  const errors: string[] = [];
  for (const ref of refs) {
    const r = resolveOne(anchors, byId, ref);
    if (r.id) ids.push(r.id);
    else errors.push(r.error!);
  }
  return { ids, errors };
}
