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
import { headCommit, revParse, worktreeForBranch, uncommittedPaths } from "../git.js";
import { assertFindingKey, branchKey, normalizeBranch } from "../review-target.js";
import { prHeadForFinding } from "../pr.js";
import { writeLocalFinding } from "../store.js";
import { trunkBase } from "./at.js";
import { readSnapshot } from "../snapshots.js";
import { snapshotRefusal } from "../store.js";
import { resolveAnchorRefs } from "../refs.js";
import { reportBug } from "./bugs.js";
import { COMMENT_MAX, type BugSeverity, type BugWitness } from "../schema.js";
import type { SharedFinding } from "../shared-findings.js";

export type DefectContext =
  | { kind: "pull_request"; pr: string | number }
  /** Reviewing a branch whose pull request does not exist yet. */
  | { kind: "branch"; branch: string }
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
  + 'found while reviewing that pull request, `context: {kind:"branch", branch:"feature/x"}` for a '
  + 'branch whose pull request is not open yet, or `context: {kind:"drive_by", rationale:"..."}` '
  + "for a defect noticed during unrelated work. A pull-request finding belongs on the pull "
  + "request, where the person who wrote the code will see it; a drive-by outlives the branch "
  + "and becomes a bug.";

export async function reportDefect(root: string, input: DefectInput) {
  const ctx = input.context;
  if (!ctx || (ctx.kind !== "pull_request" && ctx.kind !== "branch" && ctx.kind !== "drive_by")) return { error: NEEDS_CONTEXT };
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

  // --- a pull request or branch finding --------------------------------------
  // A branch finding is witnessed at the branch's last commit, never at a worktree's
  // uncommitted edits: review does not cover uncommitted changes (owner, 2026-09-18).
  let key: string;
  let ref = input.ref;
  let branch: string | undefined;
  if (ctx.kind === "branch") {
    if (!String(ctx.branch ?? "").trim()) return { error: "which branch? `context.branch` is what scopes the finding" };
    const n = normalizeBranch(root, String(ctx.branch));
    if ("error" in n) return n;
    branch = n.name;
    const sha = revParse(root, `refs/heads/${branch}`) ?? revParse(root, `refs/remotes/origin/${branch}`);
    if (!sha) return { error: `no branch "${branch}" in this repository` };
    key = branchKey(branch);
    ref = sha;
  } else {
    if (!String(ctx.pr ?? "").trim()) return { error: "which pull request? `context.pr` is what scopes the finding" };
    key = String(ctx.pr);
  }
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
    if (!ref) {
      const h = await prHeadForFinding(root, key);
      if ("error" in h) {
        return { error: `could not find pull request ${key}'s head to witness the finding at (${h.error}) — pass \`ref\`: \`pr_packet\`'s \`refs.head\`` };
      }
      ref = h.sha;
    }
    const r = await changeTarget(root, branch ?? `pull request ${key}`, branch, ref, targetId);
    if ("error" in r) return r;
    ({ targetId, witness, sourceRef } = r);
  }

  const line = Number.isFinite(input.line) && (input.line as number) > 0 ? Math.floor(input.line as number) : undefined;
  const shape = {
    targetKind: input.targetKind, targetId, text: input.text, comment,
    ...(input.severity ? { severity: input.severity } : {}),
    ...(input.category ? { category: input.category } : {}),
    ...(line !== undefined ? { line } : {}),
    ...(witness ? { witness } : {}),
    ...(sourceRef ? { sourceRef } : {}),
    ...(branch ? { branch } : {}),
  };

  // With a sidecar the finding enters the LOG and is materialized by the write; without
  // one it is a local row carrying the same pull request. Degraded delivery — not team
  // synced — never degraded semantics: every local reader sees it either way.
  if (resolveSidecar(root)) {
    const shared = await import("../ops-shared.js");
    const r = await shared.shareFinding(root, key, shape as never, { model: input.model, harness: input.harness }) as Record<string, unknown>;
    return r.error ? r : { ...r, filedAs: "finding", ...(branch ? { branch } : { pr: key }) };
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
    ...(branch ? { branch } : {}),
    author: actor,
    createdAt: at,
    // The same rule the fold applies: an agent PROPOSES, a person stands behind one.
    state: isAgentActor(actor) ? "issued" : "created",
    corroboration: [], thread: [], revisions: [],
  };
  void headCommit;
  try { assertFindingKey(key); } catch (e) { return { error: (e as Error).message }; }
  await writeLocalFinding(root, finding, key);
  return {
    ok: true, id: finding.id, filedAs: "finding", ...(branch ? { branch } : { pr: key }), shared: false,
    note: `no sidecar configured, so this stays on this machine — it is still on the ${branch ? "branch" : "pull request"} here`,
  };
}

// Every other `resolveAnchorRefs` error is a miss, under one of its three spellings.
const ambiguous = (e: string) => e.startsWith("ambiguous ");

/**
 * A branch or pull-request finding's target, resolved and witnessed ON the change: at its
 * head, or — for a symbol the change deletes — as a DELETION, absent at the head with the
 * body its trunk merge-base holds. Never the root checkout's working tree, another
 * commit's snapshot or a retained orphan: those are bodies the change does not hold
 * (owner, triage 2026-09-19-branch-review-round Q2; 2026-09-19-post-round-review Q2-Q4).
 *
 * Only ABSENCE at the head falls through to the base: an ambiguous name is the caller's to
 * pick (I1), and a `file:line` is refused rather than re-read by the same number in the
 * base, where it can name a different symbol (I2, Q6).
 */
async function changeTarget(root: string, label: string, branch: string | undefined, sha: string, target: string) {
  const snapAt = async (commit: string) => {
    const snap = await readSnapshot(root, commit);
    if (!snap) throw new Error(snapshotRefusal(root, commit)?.message ?? `cannot index ${commit.slice(0, 12)}`);
    return snap;
  };
  try {
    const head = await snapAt(sha);
    const r = resolveAnchorRefs(head, [target]);
    const a = r.ids.length ? head.find((x) => x.id === r.ids[0]) : undefined;
    if (a) return { targetId: a.id, witness: { anchorId: a.id, bodyHash: a.bodyHash } as BugWitness, sourceRef: sha };
    if (r.errors.some(ambiguous)) return { error: r.errors.join("; ") };
    const uncommitted = uncommittedTarget(root, branch, target);
    if (uncommitted) return { error: uncommitted };
    const base = trunkBase(root, sha);
    const baseSnap = base && base.sha !== sha ? await snapAt(base.sha) : null;
    const line = /:\d+$/.test(target) && !/^a_[0-9a-f]+$/.test(target);
    const rb = baseSnap ? resolveAnchorRefs(baseSnap, [target]) : null;
    const d = rb?.ids.length ? baseSnap!.find((x) => x.id === rb.ids[0]) : undefined;
    if (d && line) {
      return {
        error: `"${target}" is no line of ${label}'s last commit. At its ${base!.label} that line is in `
          + `${d.file}#${d.symbolPath.join(".")} — if that is the code this change deletes, file on `
          + `\`${d.file}#${d.symbolPath.join(".")}\` (line numbers differ between the two sides).`,
      };
    }
    // Witnessed at the HEAD, where the deletion is: `landed` asks whether that commit
    // reached the trunk, and the base is on the trunk already.
    if (d) return { targetId: d.id, witness: { anchorId: d.id, bodyHash: d.bodyHash, deleted: true } as BugWitness, sourceRef: sha };
    if (rb && rb.errors.some(ambiguous)) return { error: rb.errors.join("; ") };
    return {
      error: `"${target}" is not in ${label}'s last commit${base ? ` nor at its ${base.label}` : ""} — `
        + "a finding is about code the change holds, or code it deletes"
        // Code in commits not pushed yet is the local branch's (owner, triage
        // 2026-09-19-post-round-review Q12), and a linked branch's findings show on the PR.
        + (branch ? "" : '. If it is in commits you have not pushed, file it on your branch: `context: {kind:"branch", branch:"<name>"}`'),
    };
  } catch (e) {
    return { error: (e as Error).message };
  }
}

/**
 * Why a branch finding's target did not resolve, when the reason is that it exists only
 * in the branch's worktree's uncommitted edits. Null for every other failure.
 */
function uncommittedTarget(root: string, branch: string | undefined, target: string): string | null {
  if (!branch) return null;
  const wt = worktreeForBranch(root, branch);
  const file = target.split(/#|:\d+$/)[0]!;
  if (!wt || !uncommittedPaths(wt).includes(file)) return null;
  return `"${target}" is not in ${branch}'s last commit — ${file} has uncommitted changes in ${wt}. `
    + "A finding records committed code, because review does not cover uncommitted changes. Commit it, then file.";
}
