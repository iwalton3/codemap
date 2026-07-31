/**
 * Resolving human-friendly anchor references → anchor ids (P1.1).
 *
 * Agents know code as `file#Symbol`, not `a_1a2b…`. Accept that (plus `file:line`
 * and raw ids) and resolve server-side, so map-building doesn't need a `search`
 * round-trip before every write.
 *
 * Overload-heavy languages (C# especially) make `file#Symbol` ambiguous often, so
 * two things matter here: the ambiguity error must carry enough to pick a
 * candidate WITHOUT another lookup (hence the line ranges), and `file#Symbol(*)`
 * resolves to every overload at once, which is usually what the caller meant.
 */

import { type Anchor } from "./schema.js";

interface Resolution {
  /** Resolved ids — one for a normal ref, N for the `(*)` all-overloads form. */
  ids?: string[];
  error?: string;
}

const linesOf = (a: Anchor) => (a.loc ? `${a.loc.startLine}-${a.loc.endLine}` : "?");

function resolveOne(anchors: Anchor[], byId: Map<string, Anchor>, ref: string): Resolution {
  if (byId.has(ref)) return { ids: [ref] };

  const hash = ref.indexOf("#");
  if (hash !== -1) {
    const file = ref.slice(0, hash);
    let sym = ref.slice(hash + 1);
    // `file#Symbol(*)` — cite every overload of Symbol in that file.
    const all = sym.endsWith("(*)");
    if (all) sym = sym.slice(0, -3);
    const fileMatch = (a: Anchor) => a.file === file || a.file.endsWith("/" + file);
    const symMatch = (a: Anchor) => {
      const path = a.symbolPath.join(".");
      return path === sym || a.symbolPath[a.symbolPath.length - 1] === sym || path.endsWith("." + sym);
    };
    const cands = anchors.filter((a) => fileMatch(a) && symMatch(a));
    if (cands.length === 0) return { error: `no anchor for "${ref}"` };
    if (all) return { ids: cands.map((c) => c.id) };
    if (cands.length === 1) return { ids: [cands[0]!.id] };
    // Ambiguous: give each candidate's id AND line range, so the caller picks from
    // this message instead of paying a second round-trip to find out which
    // overload is which.
    const shown = cands.slice(0, 6).map((c) => `${c.symbolPath.join(".")} (${c.id}, ${linesOf(c)})`).join(", ");
    const more = cands.length > 6 ? `, +${cands.length - 6} more` : "";
    return { error: `ambiguous "${ref}" → ${shown}${more} — cite one by id or line (\`${file}:<line>\`), or all ${cands.length} with \`${file}#${sym}(*)\`` };
  }

  const colon = ref.lastIndexOf(":");
  if (colon !== -1 && /^\d+$/.test(ref.slice(colon + 1))) {
    const file = ref.slice(0, colon);
    const line = Number(ref.slice(colon + 1));
    const cands = anchors
      .filter((a) => (a.file === file || a.file.endsWith("/" + file)) && a.loc && a.loc.startLine <= line && line <= a.loc.endLine)
      .sort((x, y) => (x.loc!.endLine - x.loc!.startLine) - (y.loc!.endLine - y.loc!.startLine)); // most specific
    if (cands.length) return { ids: [cands[0]!.id] };
    return { error: `no anchor at "${ref}"` };
  }

  return { error: `unresolved anchor ref "${ref}"` };
}

/**
 * Resolve a list of refs. Resolved ids and per-ref errors come back SEPARATELY —
 * the caller decides whether a bad ref is fatal. Write ops keep what resolved and
 * report the rest, so one ambiguous overload in a long list doesn't discard the
 * whole call (body included) on a round-trip.
 */
export function resolveAnchorRefs(anchors: Anchor[], refs: string[]): { ids: string[]; errors: string[] } {
  const byId = new Map(anchors.map((a) => [a.id, a]));
  const ids: string[] = [];
  const seen = new Set<string>();
  const errors: string[] = [];
  for (const ref of refs) {
    const r = resolveOne(anchors, byId, ref);
    if (r.ids) for (const id of r.ids) { if (!seen.has(id)) { seen.add(id); ids.push(id); } }
    else errors.push(r.error!);
  }
  return { ids, errors };
}
