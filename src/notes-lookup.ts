/**
 * "What has the TEAM pinned to this code?" — the leaf half, for the same structural
 * reason `docs-lookup.ts`, `notes-publish.ts` and `triage-publish.ts` exist. The
 * code-review surfaces live in `pr.ts` and `ops/read.ts`, and reaching `ops-shared.ts`
 * from either makes that module a hub; an ES-module cycle here renders a blank page with
 * an empty console, so `src/import-cycles.test.ts` refuses them outright.
 *
 * ## Why the code-review pane needed this
 *
 * A `pointer` is a review AID — "when reviewing this block, watch out for X" — and 34 of
 * the 44 on the primary universe carry a LINE. Its whole value is being pinned beside
 * the code while somebody reads the diff, and the panes that do that pinning
 * (`prStory`'s steps, `nodeReview`, `fileView`) all read local annotations only. So your
 * own pointer showed at its line and a teammate's showed nowhere near the code — the
 * one surface where a pointer is worth anything.
 *
 * ## Separate from `annotations`, never merged into it
 *
 * The same rule `getAnchor` follows for `sharedDocs`. Those arrays carry records the UI
 * offers actions on — assign, escalate, resolve — and a fold-owned note is not locally
 * mutable: `writeLocalFinding` throws on exactly that, and the UI would be offering
 * buttons whose writes cannot land. Read-only, beside them, attributed.
 *
 * Findings are excluded. They are rows in `findings` with a pull request, a tier and a
 * thread; the note log still holds pre-canonical copies mirrored by
 * `annotate(kind:"finding")` before that door shut, and rendering those against the code
 * would put the copy with none of that beside the one that has it all.
 */

import { resolveSidecar } from "./sidecar-config.js";
import { readSharedNotes } from "./store.js";
import type { SharedNote } from "./shared-notes.js";

/** What a code-review pane shows for somebody else's note. */
export interface PinnedNote {
  id: string;
  kind: string;
  text: string;
  by: string;
  at: string;
  line?: number;
  severity?: string;
  category?: string;
  resolved: boolean;
}

const pin = (n: SharedNote): PinnedNote => ({
  id: n.id,
  kind: n.kind,
  text: n.text,
  by: n.author.principal,
  at: n.createdAt,
  ...(n.line !== undefined ? { line: n.line } : {}),
  ...(n.severity ? { severity: n.severity } : {}),
  ...(n.category ? { category: n.category } : {}),
  resolved: !!n.resolved,
});

/**
 * The team's notes for a whole page, grouped by the anchor they are pinned to.
 *
 * ONE query for the universe rather than one per anchor: a code-review page asks about
 * every symbol in a node or a file at once, and the per-target form of this
 * (`readSharedNotes({targetId})`) would be a query each. Empty map when there is no
 * sidecar, and never throws — a shared store that is missing or unreadable must not
 * fail a local read that worked before shared notes existed.
 *
 * `localIds` drops the mirror of your own notes: `annotate` writes both sides under one
 * id, and those are already in the caller's `annotations`.
 */
export async function teamNotesByAnchor(
  root: string, localIds: Set<string>,
): Promise<Map<string, PinnedNote[]>> {
  const out = new Map<string, PinnedNote[]>();
  try {
    const cfg = resolveSidecar(root);
    if (!cfg) return out;
    for (const n of await readSharedNotes(root, cfg.universe)) {
      if (n.kind === "finding" || localIds.has(n.id) || n.target.kind !== "anchor") continue;
      (out.get(n.target.id) ?? out.set(n.target.id, []).get(n.target.id)!).push(pin(n));
    }
  } catch { /* a local read must still answer */ }
  return out;
}
