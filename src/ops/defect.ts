/**
 * One way to report a defect, and the context decides what it becomes.
 *
 * The failure this exists to remove: an agent chose the STORE by choosing a tool name.
 * `annotate(kind:"finding")` wrote a local annotation, `share_finding` wrote a sidecar
 * event, `report_bug` wrote a bug — three verbs for one act, and picking wrong stranded
 * the work somewhere nothing read. On the universe that motivated this there were 96
 * findings in one store and 26 in another, with no surface showing more than 96 of the
 * 122. See `docs/plan-findings-unification.md`.
 *
 * So the caller says what it was DOING, not where the record should live:
 *
 *   - `pull_request` — found while reviewing PR N. Becomes a finding on that pull
 *     request, resolved at or before merge.
 *   - `drive_by` — noticed while doing something unrelated. Becomes a bug, which
 *     outlives the branch.
 *
 * There is deliberately no `storage`, `shared` or `entityKind` parameter. Whether a
 * finding enters the sidecar log or stays a local row is decided by whether a sidecar
 * is configured, and that is a property of the machine rather than a choice.
 *
 * **The honest limit**, recorded so nobody rediscovers it as a bug: a required
 * discriminator makes the invalid SHAPE unrepresentable — `{kind:"drive_by", pr:270}`
 * cannot be expressed — but it cannot prove an agent did not mislabel a pull-request
 * defect as a drive-by. Intent is not observable. Making that impossible needs either a
 * trusted work-context token from the harness or removing bug creation from the agent
 * surface entirely, and neither is built.
 */

import { requireActor, isAgentActor } from "../identity.js";
import { resolveSidecar } from "../sidecar-config.js";
import { mintId } from "../eventlog.js";
import { headCommit } from "../git.js";
import { writeLocalFinding } from "../store.js";
import { resolveRefs } from "./shared.js";
import { witnessAt } from "./annotations.js";
import { reportBug } from "./bugs.js";
import { COMMENT_MAX, type BugSeverity } from "../schema.js";
import type { SharedFinding } from "../shared-findings.js";

export type DefectContext =
  | { kind: "pull_request"; pr: string | number }
  | { kind: "drive_by"; rationale: string };

export interface DefectInput {
  context: DefectContext;
  /** The evidence: what was checked, why the obvious alternative fails, what is unverified. */
  text: string;
  /** The submitter-facing version. Required on a pull-request finding. */
  comment?: string;
  severity?: BugSeverity;
  category?: string;
  /** Pull-request findings: the one symbol or node it is about. */
  targetKind?: "anchor" | "node";
  targetId?: string;
  line?: number;
  /** Resolve and witness the target at this commit as well as the live index. */
  ref?: string;
  /** Drive-by bugs: a title, and the code it is anchored to. */
  title?: string;
  anchors?: string[];
  /** The caller's own model id and harness. Never guessed — see `bind` in ops-shared. */
  model?: string;
  harness?: string;
}

const NEEDS_CONTEXT =
  'say what you were doing: `context: {kind:"pull_request", pr:"270"}` for something '
  + 'found while reviewing that pull request, or `context: {kind:"drive_by", rationale:"..."}` '
  + "for a defect noticed during unrelated work. A pull-request finding belongs on the pull "
  + "request, where the person who wrote the code will see it; a drive-by outlives the branch "
  + "and becomes a bug.";

export async function reportDefect(root: string, input: DefectInput) {
  const ctx = input.context;
  if (!ctx || (ctx.kind !== "pull_request" && ctx.kind !== "drive_by")) return { error: NEEDS_CONTEXT };
  if (!input.text?.trim()) return { error: "a defect needs `text`: what you checked and what it proves" };

  if (ctx.kind === "drive_by") {
    if (!String(ctx.rationale ?? "").trim()) {
      return { error: "say what you were doing when you noticed it — a drive-by with no context is one nobody can judge the priority of" };
    }
    if (!input.title?.trim()) return { error: "a bug needs a `title` — the one line a triage list is read by" };
    if (!input.anchors?.length) return { error: "a bug needs `anchors`: the code it is about" };
    const r = await reportBug(root, {
      title: input.title, description: input.text, anchors: input.anchors,
      severity: input.severity, category: input.category,
    }) as Record<string, unknown>;
    return r.error ? r : { ...r, filedAs: "bug", why: ctx.rationale };
  }

  // --- a pull request finding ------------------------------------------------
  if (!String(ctx.pr ?? "").trim()) return { error: "which pull request? `context.pr` is what scopes the finding" };
  if (!input.targetKind || !input.targetId) {
    return { error: "a finding is about one symbol or node — pass `targetKind` and `targetId`" };
  }
  const comment = input.comment?.trim();
  if (!comment) {
    return {
      error: "a finding needs `comment`: what is broken, the file:line that proves it, and the ask — in at most "
        + COMMENT_MAX + " characters, for the person who has to fix it. The evidence goes in `text`.",
    };
  }
  if (comment.length > COMMENT_MAX) {
    return { error: `comment is ${comment.length} characters; the cap is ${COMMENT_MAX}. The investigation belongs in \`text\`.` };
  }

  let targetId = input.targetId;
  let witness: SharedFinding["witness"];
  let sourceRef: string | undefined;
  if (input.targetKind === "anchor") {
    // Orphans included, for the reason `annotate` includes them: re-filing against code
    // the tree no longer has is exactly what somebody needs when a reindex stranded a
    // finding, and refusing it leaves the work unreachable rather than safe.
    const r = await resolveRefs(root, [targetId], input.ref, { includeOrphans: true });
    if (!r.ids.length) return { error: r.errors.join("; ") };
    targetId = r.ids[0]!;
    const w = await witnessAt(root, targetId, input.ref);
    witness = w.witness;
    sourceRef = w.sourceRef;
  }

  const line = Number.isFinite(input.line) && (input.line as number) > 0 ? Math.floor(input.line as number) : undefined;
  const shape = {
    targetKind: input.targetKind, targetId, text: input.text, comment,
    ...(input.severity ? { severity: input.severity } : {}),
    ...(input.category ? { category: input.category } : {}),
    ...(line !== undefined ? { line } : {}),
    ...(witness ? { witness } : {}),
    ...(sourceRef ? { sourceRef } : {}),
  };

  // With a sidecar the finding enters the LOG and is materialized by the write; without
  // one it is a local row carrying the same pull request. Degraded delivery — not team
  // synced — never degraded semantics: every local reader sees it either way.
  if (resolveSidecar(root)) {
    const shared = await import("../ops-shared.js");
    const r = await shared.shareFinding(root, ctx.pr, shape as never, { model: input.model, harness: input.harness }) as Record<string, unknown>;
    return r.error ? r : { ...r, filedAs: "finding", pr: String(ctx.pr) };
  }

  const actor = requireActor(root, { model: input.model, harness: input.harness });
  if ("error" in actor) return actor;
  const at = new Date().toISOString();
  const finding: SharedFinding = {
    id: "f_" + mintId(),
    target: { kind: input.targetKind, id: targetId },
    text: input.text, comment,
    ...(input.severity ? { severity: input.severity } : {}),
    ...(input.category ? { category: input.category } : {}),
    ...(line !== undefined ? { line } : {}),
    ...(witness ? { witness } : {}),
    ...(sourceRef ? { sourceRef } : {}),
    author: actor,
    createdAt: at,
    // The same rule the fold applies: an agent PROPOSES, a person stands behind one.
    state: isAgentActor(actor) ? "issued" : "created",
    corroboration: [], thread: [], revisions: [],
  };
  void headCommit;
  await writeLocalFinding(root, finding, String(ctx.pr));
  return {
    ok: true, id: finding.id, filedAs: "finding", pr: String(ctx.pr), shared: false,
    note: "no sidecar configured, so this stays on this machine — it is still on the pull request here",
  };
}
