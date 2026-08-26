/**
 * The operations behind the MCP tools — a plain async API over a `.codemap/`
 * repo. Kept free of any protocol concern so it can be driven from tests, a
 * CLI, or the MCP server identically.
 *
 * Every operation that writes a claim (document / report_bug / annotate)
 * validates that the anchors it references actually exist — the "no floating
 * claims" invariant, enforced mechanically.
 */

/**
 * This file is a BARREL. The operations themselves live in `src/ops/*.ts`, one
 * module per surface, and every one of them is re-exported here so `ops.js`
 * stays the single import for the front-ends (mcp.ts, serve.ts, cli.ts), the
 * tests, and `web/app.js`'s `ApiMap`.
 *
 * Nothing under `src/ops/` may import from this file — the barrel imports all of
 * them, so a module reaching back closes a cycle. An ES-module cycle resolves to
 * a partially-initialized module rather than an error, and in this repo the
 * symptom is a blank page with nothing in the console (see
 * `src/import-cycles.test.ts`). Shared helpers go DOWN into `src/ops/shared.ts`.
 */

export { type Trust } from "./ops/shared.js";

export { availableViews, status, dashboard, lintSummaries, findGaps, cover } from "./ops/overview.js";

export { reindex, init, checkStale, indexFreshness, snapshot, snapshotAt, snapshots } from "./ops/indexing.js";

export { orphanedWork, type WhereWas, whereWas, whereWere } from "./ops/orphans.js";

export { diff, docDiff, diffCode } from "./ops/diffs.js";

export {
  pr, prPacketFor, prIngest, prWalkthroughSet, prWalkthroughGet, prStoryFor, prOffStoryFindings,
  prStepMark, prChapterMark, prTriageDerive, prPromotePlan, prPromote, prPullViewed, prPullViewedAll,
  prWalkthroughChapter,
  prPushPlan, prResolvePlan, prResolvePush, prResolvePull, prPushExecute, prCode, prsFor, prs,
} from "./ops/pr.js";

export {
  nodeCatalog, eventMatrix, getNode, neighborhood, subgraph, flows, pipelineGraph, stateMap, flow,
} from "./ops/graph.js";

export { outline, search, context, getAnchor, nodeReview, fileSource } from "./ops/read.js";

export {
  setTriage, anchorMark, clearTriage, deriveTriage, tripwires, triageDriftList, changedSince,
  queueContestedTriage,
} from "./ops/triage.js";

export {
  document, connect, disconnect, updateNode, confirm, UNPLACEABLE_CATEGORY, ackHole, nodeVersions, removeNode, linksReport,
} from "./ops/docs.js";

export {
  reportBug, listBugs, bugDetail, updateBug, commentBug, trackBugExternally,
  corroborateBugOp, promoteBugOp, requestOnBugOp, resolveBugContestOp, unanchorBugOp,
  publishBugs, acceptFinding,
} from "./ops/bugs.js";

export {
  anchorAnnotations, annotate, resolveAnnotation, escalateAnnotation, reviseAnnotation, withdrawAnnotation,
  assignAnnotation, type QueueItem, reviewQueue, closeAssignment, closeLocalFinding, listQuestions,
  // Test and migration fixtures only — not wired to any tool. See its note.
  annotateLegacyFinding,
} from "./ops/annotations.js";

import {
  closeAssignment as closeAnnotation, closeLocalFinding as closeLocal, commentOnLocalFinding,
  reviseLocalFinding, reviseAnnotation, remediateLocalFinding, checkComment, REVISABLE,
  setLocalFindingState, corroborateLocalFinding, promoteLocalFinding, requestOnLocalFinding,
  setLocalFindingPosted, relocateLocalFinding,
} from "./ops/annotations.js";
import { commentBug, corroborateBugOp, requestOnBugOp, acceptFinding } from "./ops/bugs.js";
import { readFinding, readBug, idsStartingWith} from "./store.js";
import { isRemediation, type Ask, type FindingState, type Remediation, type Verdict } from "./shared-findings.js";
export { reportDefect, type DefectContext, type DefectInput } from "./ops/defect.js";

/**
 * Report back on whatever `review_queue` handed you — annotation or finding.
 *
 * The queue serves both, so its ids have to be closeable without the caller knowing
 * which store a row lives in. Resolved against the RECORD rather than the id's prefix:
 * `f_`, `finding_` and `bug_` are minted by a generic helper and are visually
 * confusable, so dispatching on them would route by a serialization detail.
 *
 * It lives HERE, in the aggregator, because the three branches span two layers that may
 * not import each other: `ops/annotations` reaching `ops-shared` closes a cycle through
 * `ops/triage`. Only front ends import `ops.ts`, so this is the one place all three are
 * reachable at once.
 */
export async function closeFinding(
  root: string,
  input: {
    id: string; result: "fixed" | "answered" | "declined"; detail: string; files?: string[]; by?: string;
    comment?: string; line?: number; severity?: "low" | "medium" | "high" | "critical";
    remediation?: Remediation; disposition?: never; state?: FindingState;
  },
): Promise<Record<string, unknown>> {
  // VALIDATED FIRST, before a single event is written. This ran after the outcome, the
  // corroboration and the remediation had already landed, so a rejected comment returned
  // a bare error over a half-completed call — and the natural response to an error is to
  // retry, which re-emitted `finding.outcome` and (until the history landed) overwrote
  // the first report. The tool's own response shape drove the data loss the audit
  // measured. `reviseOn` and the local path already validate up front.
  {
    const c = checkComment(input.comment, (input as { disposition?: string }).disposition);
    if ("error" in c) return c;
  }
  const f = await readFinding(root, input.id).catch(() => null);
  if (!f) return closeAnnotation(root, input as never) as Promise<Record<string, unknown>>;
  if (!f.origin) {
    const r = await closeLocal(root, input as never);
    // The same inference the fold-owned branch makes: a report that says `fixed` must
    // not leave the finding counted as open. This branch is every finding before it is
    // published, which is most of them for most of their life.
    const rem = input.remediation ?? (input.result === "fixed" ? ("fixed-on-branch" as const) : undefined);
    if (!r.error && rem) {
      const rr = await remediateLocalFinding(root, f.id, rem, { detail: input.detail }) as { error?: string };
      if (rr.error) return { ...r, note: `${r.note ?? ""} remediation NOT recorded: ${rr.error}`.trim() };
    }
    return r.error ? r : { ...r, ...(await applyState(root, input, f.id)) };
  }
  // Fold-owned: a row the fold owns may only be changed by an event.
  const shared = await import("./ops-shared.js");
  const r = await shared.reportOnFinding(root, f.pr!, f.id, input.result, input.detail, input.files) as Record<string, unknown>;
  if (r.error) return r;
  const d = (input as { disposition?: string }).disposition;
  const verdict = d === "refuted" ? "refute" as const : d === "confirmed" ? "confirm" as const : null;
  // Captured, not fired and forgotten: `corroborateFinding` can now REFUSE a verdict
  // formed on a tree that does not contain the code the finding is about, and a refusal
  // nobody reports is the silent-drop shape this envelope exists to end.
  const vr = verdict
    ? await shared.corroborateFinding(root, f.pr!, f.id, verdict, input.detail) as { error?: string }
    : null;
  // The corrected wording is the point of reporting back, so it goes onto the RECORD
  // rather than into the outcome's prose: a `comment` the submitter reads and a `line`
  // the publisher places by are fields, and an outcome paragraph is neither filterable
  // nor placeable. A revision is how a finding's substance changes, so this is one —
  // and it inherits that verb's refusals, which is why the failure is reported back
  // instead of swallowed.
  const notes: string[] = ["reported — a person still has to close it"];
  // STRUCTURED, not prose. This returned `ok: true` with every refusal buried in `note`,
  // and `ok` means success everywhere else — so an agent that set `comment` and had it
  // refused believed it landed and moved on. Reported by an agent that only caught it by
  // re-reading the prose (`docs/mcp-complaints.md` § workflow-issues §2).
  const applied: string[] = ["outcome"];
  const refused: { field: string; why: string }[] = [];
  if (vr?.error) refused.push({ field: "disposition", why: vr.error });
  // Ungated, unlike the comment/severity half below: what HAPPENED about a finding is an
  // observation, and the commonest reason to record one is a submitter fixing something
  // other people confirmed — exactly the case a confirmation gate would refuse.
  // `result: "fixed"` with no remediation used to leave it at `outstanding` — so a call
  // that literally says the code was fixed left "what is still open on this PR" counting
  // it as open. A prior pass lost nine findings that way (`docs/mcp-complaints.md` § workflow-issues §8).
  // Inferred rather than refused, and `fixed-on-BRANCH` rather than `-on-default`: a
  // report on a pull request's finding is about the branch, and claiming the mainline is
  // clean would let a linked bug be closed while the defect still ships.
  const remediation = input.remediation
    ?? (input.result === "fixed" ? ("fixed-on-branch" as const) : undefined);
  if (remediation) {
    const rr = await shared.remediateFinding(root, f.pr!, f.id, remediation, { detail: input.detail }) as { error?: string };
    if (rr.error) { refused.push({ field: "remediation", why: rr.error }); notes.push(`remediation NOT recorded: ${rr.error}`); }
    else {
      applied.push("remediation");
      if (!input.remediation) notes.push(`remediation set to \`fixed-on-branch\` because you reported \`fixed\` — pass \`remediation\` to say otherwise`);
    }
  }
  if (verdict && !vr?.error) applied.push("corroboration");
  if (d && !verdict) {
    refused.push({ field: "disposition", why: "a shared finding records verdicts, not dispositions" });
    notes.push(`disposition "${d}" is not recorded on a shared finding — verdicts are`);
  }
  const patch = {
    ...(input.comment !== undefined ? { comment: input.comment } : {}),
    ...(Number.isFinite(input.line) ? { line: Math.floor(input.line as number) } : {}),
    ...(input.severity !== undefined ? { severity: input.severity } : {}),
  };
  if (Object.keys(patch).length) {
    const rev = await shared.reviseFinding(root, f.pr!, f.id, patch) as { error?: string };
    if (rev.error) {
      for (const k of Object.keys(patch)) refused.push({ field: k, why: rev.error });
      notes.push(`${Object.keys(patch).join(" and ")} NOT changed: ${rev.error}`);
    } else applied.push(...Object.keys(patch));
  }
  const moved = await applyState(root, input, f.id);
  if (moved.asked) applied.push("ask"); else if (moved.state) applied.push("state");
  return {
    // `ok` now means what it means everywhere else. A caller that asked for four things
    // and got three has not succeeded, and finding that out should not require reading.
    ok: refused.length === 0,
    id: f.id, pr: f.pr, shared: true, applied,
    ...(refused.length ? { refused } : {}),
    ...moved,
    note: [...notes, moved.note].filter(Boolean).join("; "),
  };
}

/**
 * Move the finding's state, if the caller asked for one.
 *
 * `close_finding` is named for closing and, until now, could not close: there was no
 * MCP tool that set a finding's state at all, and `setFindingState` was reachable only
 * from a web POST. Its description promised the pending-ask conversion anyway, which
 * meant an agent following it dropped a `state` the schema did not declare, got
 * `ok: true`, and queued nothing — the exact zero-`request_human` failure the ask
 * conversion was built to end, now with the documentation steering agents into it.
 *
 * Attached here rather than given its own verb deliberately: a third tool covering the
 * same intent is how `request_human` came to be the one nobody used.
 */
async function applyState(
  root: string, input: { state?: FindingState; detail?: string }, id: string,
): Promise<{ state?: FindingState; asked?: string; note?: string }> {
  if (!input.state) return {};
  const r = await setFindingState(root, { id, state: input.state, reason: input.detail }) as
    { error?: string; state?: FindingState; asked?: string; note?: string };
  if (r.error) return { note: `state NOT changed: ${r.error}` };
  return r.asked ? { asked: r.asked, note: r.note } : { state: r.state };
}

/**
 * Correct a finding, wherever it lives — annotation, local finding, or the fold's.
 *
 * The same dispatch `commentOn` uses, and for the same reason: revising is one act, and
 * making the caller pick the tool by the store is making them pick it by a detail they
 * cannot see from the id. It was worse than a missing verb — `revise_finding` named
 * "yours or somebody else's" in its description, listed one refusal that did not
 * include this, and then failed on a shared id with `no annotation "f_…"`.
 *
 * What the stores genuinely do NOT share is `disposition`: the fold has no such field,
 * so on a shared finding the two verdict-shaped values become corroboration and the
 * rest are reported back as not recorded, exactly as `closeFinding` does.
 */
export async function reviseOn(
  root: string,
  input: {
    id: string; by?: string; allowPostEdit?: boolean;
    text?: string; comment?: string; disposition?: string; severity?: "low" | "medium" | "high" | "critical";
    category?: string; line?: number; publishPath?: string; publishLine?: number; ref?: string;
    remediation?: Remediation;
  },
): Promise<Record<string, unknown>> {
  const f = await readFinding(root, input.id).catch(() => null);
  if (!f) return reviseAnnotation(root, input as never) as Promise<Record<string, unknown>>;
  if (!f.origin) {
    const r = await reviseLocalFinding(root, input as never) as Record<string, unknown>;
    if (!r.error && input.remediation) {
      const rr = await remediateLocalFinding(root, f.id, input.remediation, { detail: input.text }) as { error?: string };
      if (rr.error) return { ...r, note: `${r.note ?? ""} remediation NOT recorded: ${rr.error}`.trim() };
    }
    return r;
  }

  const shared = await import("./ops-shared.js");
  const c = checkComment(input.comment, input.disposition);
  if ("error" in c) return c;
  const patch: Record<string, unknown> = {};
  for (const k of REVISABLE) {
    const v = (input as Record<string, unknown>)[k];
    if (v === undefined) continue;
    patch[k] = k === "line" ? Math.floor(v as number) : k === "comment" ? c.comment : v;
  }
  const notes: string[] = [];
  let out: Record<string, unknown> = { ok: true, id: f.id, pr: f.pr, shared: true, changed: [] as string[] };
  if (input.remediation) {
    const rr = await shared.remediateFinding(root, f.pr!, f.id, input.remediation, { detail: input.text }) as { error?: string };
    if (rr.error) notes.push(`remediation NOT recorded: ${rr.error}`);
  }
  if (Object.keys(patch).length) {
    const r = await shared.reviseFinding(root, f.pr!, f.id, patch, { allowPostEdit: input.allowPostEdit }) as Record<string, unknown>;
    if (r.error) return r;
    out = { ...r, pr: f.pr, shared: true };
  }
  const verdict = input.disposition === "refuted" ? "refute" as const
    : input.disposition === "confirmed" ? "confirm" as const : null;
  if (verdict) {
    // `corroborateFinding` refuses a verdict with no rationale, and it is right to:
    // a verdict without one is a vote. So it is only recorded when the revision
    // carried the reasoning that justifies it.
    const rationale = (input.text ?? input.comment ?? "").trim();
    if (rationale) {
      const r = await shared.corroborateFinding(root, f.pr!, f.id, verdict, rationale) as { error?: string };
      // Same reason as `closeFinding`'s: the ground check can refuse, and a refusal
      // reported nowhere is worse than the wrong verdict it prevented.
      if (r.error) notes.push(`disposition NOT recorded: ${r.error}`);
    }
    else notes.push(`disposition "${input.disposition}" not recorded — a verdict on a shared finding needs a rationale; pass \`text\`, or use \`corroborate\``);
  } else if (input.disposition) {
    notes.push(`disposition "${input.disposition}" is not recorded on a shared finding — verdicts are`);
  }
  for (const k of ["publishPath", "publishLine"] as const) {
    if ((input as Record<string, unknown>)[k] !== undefined) {
      notes.push(`${k} is a local publishing field and has no shared equivalent — set it on the copy this machine publishes from`);
    }
  }
  // `finding.revised` folds text/comment/severity/category/sourceRef/line and NOT the
  // witness, so there is no event that re-witnesses a shared finding. Said out loud
  // rather than dropped: `ref` is the one route past the written-against-a-different-
  // body gate, and an agent that thinks it ran will not look for another.
  if (input.ref !== undefined) {
    notes.push("ref is not recorded on a shared finding — the fold has no re-witness event; re-witness the local copy, or ask a person");
  }
  return notes.length ? { ...out, note: notes.join("; ") } : out;
}

// ---------------------------------------------------------------------------
// One verb per act, over both kinds of record
// ---------------------------------------------------------------------------

/**
 * Findings and bugs have the same lifecycle acts — say something, weigh in, ask a
 * person — and had two tools each, so the caller picked the entity type by picking a
 * tool name. That is the same mistake `report_defect` removed from creation.
 *
 * Dispatch resolves the id against the RECORDS, never against its prefix: `f_`,
 * `finding_` and `bug_` are minted by one generic helper, are visually confusable, and
 * say nothing about where a row lives. A finding also carries its own pull request, so
 * the caller no longer passes a `pr` that could be the wrong one.
 *
 * These live in `ops.ts` for the reason `closeFinding` does: the branches span two
 * layers that may not import each other.
 */
/**
 * "did you mean" for an id that is the FRONT of a real one.
 *
 * `no finding or bug "f_00mt8zvn7m"` says the record does not exist. It does — the id is
 * half of one, and the half a person naturally copies. Appended to the refusal rather
 * than resolved silently: a prefix matching two records must not pick one, and the
 * suggestion is the useful answer either way.
 */
function didYouMean(root: string, id: string): string {
  const hits = idsStartingWith(root, id);
  if (!hits.length) return "";
  if (hits.length === 1) return ` — did you mean \`${hits[0]}\`? (ids are not truncatable; that one starts with what you passed)`;
  return ` — that is the start of ${hits.length}: ${hits.map((h) => `\`${h}\``).join(", ")}`;
}

async function whichRecord(root: string, id: string): Promise<
  { bug: true } | { finding: { pr: string; shared: boolean } } | { error: string }
> {
  const f = await readFinding(root, id).catch((e: any) => { throw e; });
  if (f) return { finding: { pr: f.pr!, shared: !!f.origin } };
  if (await readBug(root, id)) return { bug: true };
  return { error: `no finding or bug "${id}"${didYouMean(root, id)}` };
}

/** Say something on a finding or a bug — the reviewers' thread, wherever it lives. */
export async function commentOn(root: string, input: { id: string; body: string; inReplyTo?: string; model?: string; harness?: string }) {
  const w = await whichRecord(root, input.id);
  if ("error" in w) return w;
  if ("bug" in w) return commentBug(root, input.id, input.body, input.inReplyTo);
  if (!w.finding.shared) return commentOnLocalFinding(root, input.id, input.body, input.inReplyTo);
  const shared = await import("./ops-shared.js");
  return shared.commentOnFinding(root, w.finding.pr, input.id, input.body, input.inReplyTo, { model: input.model, harness: input.harness });
}

/** A second opinion on somebody's finding or bug: confirm, refute or unsure. */
export async function corroborateOn(root: string, input: { id: string; verdict: "confirm" | "refute" | "unsure"; rationale: string; model?: string; harness?: string; anyway?: boolean }) {
  const w = await whichRecord(root, input.id);
  if ("error" in w) return w;
  if ("bug" in w) return corroborateBugOp(root, input.id, input.verdict, input.rationale);
  // A LOCAL canonical finding holds corroboration too — `closeLocalFinding` has written
  // it since the tables merged. Refusing here said "there is nobody to corroborate this
  // for", which was never the question: a second model reviewing your own finding is the
  // point of running several, sidecar or no sidecar.
  if (!w.finding.shared) return corroborateLocalFinding(root, input.id, input.verdict as Verdict, input.rationale);
  const shared = await import("./ops-shared.js");
  return shared.corroborateFinding(root, w.finding.pr, input.id, input.verdict, input.rationale, { model: input.model, harness: input.harness, anyway: input.anyway });
}

/** Ask a PERSON to do what you may not: promote, invalidate, refute or resolve. */
export async function requestHuman(root: string, input: { id: string; action: Ask; rationale: string }) {
  const w = await whichRecord(root, input.id);
  if ("error" in w) return w;
  if ("bug" in w) return requestOnBugOp(root, input.id, input.action as never, input.rationale);
  // An ask on a local finding lands in the same queue the shared ones do — `reviewQueue`
  // reads the canonical table, so a person sees it either way.
  if (!w.finding.shared) return requestOnLocalFinding(root, input.id, input.action, input.rationale);
  const shared = await import("./ops-shared.js");
  return shared.requestOnFinding(root, w.finding.pr, input.id, input.action as never, input.rationale);
}

/**
 * Record what HAPPENED about a finding — fixed, deferred, not being fixed.
 *
 * Its own path rather than a field on a revision, and that is the whole point: a
 * revision rewrites somebody's claim and is gated on confirmation, while this adds an
 * observation about the code and destroys nothing. Routing it through the revision would
 * re-block the case the axis exists for — a submitter fixing findings other people
 * confirmed, which is the commonest reason a finding ever gets updated.
 */
export async function recordRemediation(
  root: string, id: string, state: Remediation, opts: { detail?: string; ref?: string } = {},
): Promise<Record<string, unknown>> {
  if (!isRemediation(state)) return { error: `unknown remediation "${state}"` };
  const f = await readFinding(root, id).catch(() => null);
  if (!f) return { error: `no finding "${id}"` };
  if (!f.origin) return remediateLocalFinding(root, id, state, opts) as Promise<Record<string, unknown>>;
  const shared = await import("./ops-shared.js");
  return shared.remediateFinding(root, f.pr!, id, state, opts) as Promise<Record<string, unknown>>;
}

/**
 * Move a finding's lifecycle state — resolve, refute, invalidate, reopen.
 *
 * Dispatched on the RECORD, like every other act here, and it is the one that was
 * missing: `shared_findings` lists this store's own rows beside the team's, so the
 * shared page's `resolve` button was offered on a local finding and answered
 * `no finding finding_… on pr <scope>` — a real id, a real row, and an error naming the
 * one place it could not be.
 *
 * The ratchet is the same function on both sides, so what an agent may close does not
 * depend on whether the row happens to have been published.
 */
export async function setFindingState(
  root: string, input: { id: string; state: FindingState; reason?: string },
): Promise<Record<string, unknown>> {
  const f = await readFinding(root, input.id).catch(() => null);
  if (!f) return { error: `no finding "${input.id}"` };
  if (!f.origin) return setLocalFindingState(root, input.id, input.state, input.reason);
  const shared = await import("./ops-shared.js");
  return shared.closeFinding(root, f.pr!, f.id, input.state, input.reason) as Promise<Record<string, unknown>>;
}

/** Surface a finding for team-wide human attention, wherever the row lives. */
export async function promoteOn(root: string, id: string): Promise<Record<string, unknown>> {
  const f = await readFinding(root, id).catch(() => null);
  if (!f) return { error: `no finding "${id}"` };
  if (!f.origin) return promoteLocalFinding(root, id);
  const shared = await import("./ops-shared.js");
  return shared.promoteFinding(root, f.pr!, id) as Promise<Record<string, unknown>>;
}

/**
 * Where a finding landed on the pull request, wherever the row lives.
 *
 * Dispatched on the RECORD like everything else. It took a `pr` and went straight to the
 * log, so on a local row it emitted an event the fold drops and returned `{ ok: true }` —
 * and `inbound_replies` reads nothing but this, so the silent success guaranteed those
 * replies would never be shown to anybody.
 */
export async function recordPublishedOn(
  root: string, id: string, ref: { key?: string; url?: string },
): Promise<Record<string, unknown>> {
  const f = await readFinding(root, id).catch(() => null);
  if (!f) return { error: `no finding "${id}"` };
  if (!f.origin) {
    return setLocalFindingPosted(root, id, ref);
  }
  const shared = await import("./ops-shared.js");
  return shared.recordPublished(root, f.pr!, id, ref) as Promise<Record<string, unknown>>;
}

/** Say where a finding's target went, wherever the row lives. */
export async function relocateOn(
  root: string, id: string, kind: "moved" | "gone", rationale: string, opts: { to?: string } = {},
): Promise<Record<string, unknown>> {
  const f = await readFinding(root, id).catch(() => null);
  if (!f) return { error: `no finding "${id}"` };
  if (!f.origin) return relocateLocalFinding(root, id, kind, rationale, opts);
  const shared = await import("./ops-shared.js");
  return shared.relocateFinding(root, f.pr!, id, kind, rationale, opts) as Promise<Record<string, unknown>>;
}

/**
 * Defer a finding into a bug, wherever the row lives.
 *
 * The finding carries its own pull request, so there is no `pr` to get wrong — which is
 * what made this fail on a correct id: `no finding <id> on pr <n>` for a real record,
 * because the id was a local row and the lookup read the log.
 */
export async function deferFinding(
  root: string, id: string, opts: { title?: string; severity?: "low" | "medium" | "high" | "critical" } = {},
): Promise<Record<string, unknown>> {
  const f = await readFinding(root, id).catch(() => null);
  if (!f) return { error: `no finding "${id}" — ids come from \`findings\` or \`shared_findings\`${didYouMean(root, id)}` };
  return acceptFinding(root, f.pr!, id, opts) as Promise<Record<string, unknown>>;
}
