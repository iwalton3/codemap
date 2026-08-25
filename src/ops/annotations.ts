import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { type Actor, type Anchor, type LogicalNode, type BugSeverity, type Annotation, type Disposition, DISPOSITIONS, COMMENT_MAX } from "../schema.js";
import { indexFile, indexBlob } from "../repo.js";
import { headCommit, readBlobs } from "../git.js";
import { readAnchorStore, loadNodes, readAnnotations, writeAnnotations, readFindings, readFinding, writeLocalFinding, findAnchorsOutsideWork, readPushes, bodyHashAt, readOrphans } from "../store.js";
import {
  findingTier, isClosed, mayTransition, needsHumanAck,
  type Ask, type FindingState, type FindingTier, type Remediation, type SharedFinding, type Verdict,
} from "../shared-findings.js";
import { requireActor, isAgentActor, actorLabel, reviewerKey, isIndependent } from "../identity.js";
import { isAgentAuthored, publishStateOf, type PublishState } from "../pr-push.js";
import { genId, liveAnchors, resolveRefs, loadNodesShared} from "./shared.js";

// ---------------------------------------------------------------------------
// Annotations
// ---------------------------------------------------------------------------

/**
 * Every annotation on one anchor, as the walkthrough renders them.
 *
 * Returned alongside every annotation write so a caller can refresh the one symbol
 * that changed. Raising, handing a finding to an agent, resolving one or raising it
 * to the maintainer all used to reload the whole PR story, which on a large pull
 * request is seconds of work to learn what happened to a single anchor.
 */
export async function anchorAnnotations(root: string, anchorId: string) {
  const anns = (await readAnnotations(root)).annotations;
  return anns.filter((a) => a.target.kind === "anchor" && a.target.id === anchorId);
}

// What has to follow a lead word for it to be a verdict rather than a subject. A
// bare "-" counts only when SPACED, so "Partial-write recovery drops the second
// half" opens on a hyphenated word, not on a grade.
const leadTail = (follows: string) =>
  String.raw`(?=[:;,.!]|\s*[\u2014\u2013]|\s+-\s|\s+(?:${follows})\b|\s*$)`;

/**
 * Openings that grade the FINDING instead of describing the code.
 *
 * `comment` is the whole of what reaches the submitter — never the filing, the
 * `text`, the `disposition`, or the earlier revisions (see `renderAnnotation` in
 * pr-push.ts) — so "Confirmed and wider than filed" cites a document they cannot
 * read. Saying so in the tool description did not hold: agents wrote relative copy
 * twice more after reading it, while the length cap, which REFUSES, was obeyed
 * every time. So this refuses too.
 *
 * Deliberately narrow. The lead word only counts when what follows it is
 * verdict-shaped punctuation or a conjunction, which leaves a defect sentence that
 * happens to open on the same word alone: "Partial writes are not rolled back",
 * "Withdrawn tickets still bill". Missing a bad comment costs a re-read; refusing a
 * good one costs the trust that makes the check work at all.
 */
const VERDICT_LEAD = new RegExp(
  String.raw`^(?:confirmed|part(?:ly|ially) confirmed|partial|re-?rated|real|as filed|as reported|still open|false positive|not a (?:bug|defect|finding)|(?:much )?(?:wider|narrower|broader|smaller|bigger|worse|less bad) than (?:filed|reported|stated|described))`
  + leadTail("and|but"), "i");

/**
 * The withdrawal shape, which is legitimate for exactly one disposition — see
 * PUBLISHABLE: `refuted` goes out only where the human already raised the concern
 * on the pull request, so there the reader does share the baseline a retraction
 * needs. On anything still real it reads as "never mind" over a live defect.
 */
const WITHDRAWAL_LEAD = new RegExp(
  String.raw`^(?:withdraw(?:ing|n)|retract(?:ing|ed)|refuted|disregard|never mind|my mistake)`
  + leadTail("this|my|the"), "i");

/**
 * Validate the submitter-facing half of a finding.
 *
 * Over-length is refused rather than truncated, and the error names the cap and the
 * overage: a comment silently cut at 800 characters loses its last sentence, which
 * by the contract in the tool description is the ASK — the one part the person
 * fixing it actually needs.
 */
export function checkComment(
  comment: string | undefined, disposition?: string,
): { comment?: string } | { error: string } {
  const c = comment?.trim();
  if (!c) return {};
  if (c.length > COMMENT_MAX) {
    return { error: `comment is ${c.length} characters; the cap is ${COMMENT_MAX}. Cut the investigation — what was checked and what was ruled out belong in \`text\`. Keep: what is broken, file:line proving it, and the ask.` };
  }
  // Emphasis and quoting are not the sentence: "**Confirmed** — ..." opens exactly
  // as "Confirmed — ..." does, and the bolding is the tell, not a defence.
  const bare = c.replace(/[*_]/g, "").replace(/^[\s>#`]+/, "");
  const verdict = VERDICT_LEAD.exec(bare);
  if (verdict) {
    return { error: `comment opens with "${verdict[0]}", which is a verdict on the FINDING. The submitter never sees the finding — not as filed, not the \`text\`, not the \`disposition\` — so an opening that grades it describes a document they cannot read. Open with the defect itself, stated as a fact about the code, then the file:line, then the ask. The verdict goes in \`disposition\`, where it can be filtered on.` };
  }
  const withdrawal = WITHDRAWAL_LEAD.exec(bare);
  if (withdrawal && disposition !== "refuted") {
    return { error: `comment opens with "${withdrawal[0]}" but the disposition is \`${disposition ?? "unset"}\`. A retraction is only readable where the submitter already saw the concern, which is why it is the \`refuted\` shape — published by hand onto a thread that has it. Anything still real leads with what is STILL broken, written as if filed fresh; if this one really is a false positive, set disposition \`refuted\`.` };
  }
  return { comment: c };
}

const checkDisposition = (d: string | undefined): Disposition | undefined =>
  d && (DISPOSITIONS as readonly string[]).includes(d) ? (d as Disposition) : undefined;

/**
 * The body an annotation is being written against, and the ref that body came from.
 *
 * `ref` is a cached commit snapshot (a PR head); without one this is the live index,
 * which during a PR review is the WORKING TREE — a third version of the file that is
 * neither the PR under review nor the branch the reader may have been looking at.
 * Recording which one it was is what makes that confusion detectable later.
 */
export async function witnessAt(
  root: string, anchorId: string, ref?: string,
): Promise<{ witness?: { anchorId: string; bodyHash: string }; sourceRef: string }> {
  if (ref) {
    const hash = bodyHashAt(root, ref, anchorId);
    if (hash) return { witness: { anchorId, bodyHash: hash }, sourceRef: ref };
  }
  const stored = (await readAnchorStore(root)).anchors.find((a) => a.id === anchorId);
  if (stored) {
    // Re-index rather than trusting the stored hash: an edit since the last index
    // would witness a body nobody has read.
    const live = (await liveAnchors(root, [stored.file])).get(anchorId);
    if (live) return { witness: { anchorId, bodyHash: live.bodyHash }, sourceRef: "@work" };
  }
  // Not in the working tree. Resolution reaches snapshots and retained anchors, so
  // witnessing has to as well — otherwise a finding on a symbol the branch ADDS gets
  // no witness and claims `@work`, which is both false and exactly the record the
  // cross-branch gate reads.
  const off = findAnchorsOutsideWork(root, [anchorId]).get(anchorId);
  if (off) return { witness: { anchorId, bodyHash: off.anchor.bodyHash }, sourceRef: off.ref };
  const orphan = readOrphans(root, [anchorId]).get(anchorId);
  if (orphan) return { witness: { anchorId, bodyHash: orphan.bodyHash }, sourceRef: "@orphan" };
  return { sourceRef: ref ?? "@work" };
}

/**
 * Create a `kind: "finding"` ANNOTATION — the legacy shape.
 *
 * **For tests and migration fixtures. There is no production caller**, and that is the
 * point: `annotate` refuses findings so the tool surface cannot mint another local
 * record with no pull request, and this is not reachable from MCP or HTTP because it is
 * not wired to either. The lifecycle it produces still has to WORK — real stores hold
 * annotation-findings that predate the canonical table, and orphan recovery, publishing
 * and the review loop all still run on them — so it still has to be constructible.
 *
 * Same precedent as `clearAgentSession`: a test-only export beats an input flag, because
 * an input flag is something a caller can pass.
 */
export const annotateLegacyFinding = (
  root: string,
  input: Omit<Parameters<typeof annotate>[1], "kind">,
) => annotate(root, { ...input, kind: "finding" } as never, { legacy: true });

export async function annotate(
  root: string,
  input: { targetKind: "anchor" | "node"; targetId: string; text: string; author?: string; kind?: Annotation["kind"]; severity?: BugSeverity; category?: string; line?: number; ref?: string; comment?: string; disposition?: Disposition; publishPath?: string; publishLine?: number; agent?: boolean; model?: string; harness?: string;
    /**
     * Keep it off the sidecar. For an annotation DERIVED from shared state rather than
     * authored — a contested-stakes item, say. Mirroring one is the signature of a
     * derived fact being logged: the fold is deterministic, so every clone derives it,
     * so every clone files its own copy with its own random id, and the shared-note
     * fold refuses agent resolutions so none of them can ever be closed. The receipts
     * it is derived FROM already travel; the rendering is this clone's business.
     */
    localOnly?: boolean },
  /** `legacy` is `annotateLegacyFinding`'s only caller — see the note there. */
  opts: { legacy?: boolean } = {},
) {
  // Validate the target exists (anchor targets accept file#Symbol refs too).
  let targetId = input.targetId;
  let witness: { anchorId: string; bodyHash: string } | undefined;
  let sourceRef: string | undefined;
  if (input.targetKind === "anchor") {
    // A single-target ref is strict: there is nothing partial to accept, and the
    // ambiguity error now carries the candidates' ids and line ranges.
    // Orphans included: re-filing against code the tree no longer has is exactly what
    // someone needs when a reindex has stranded a finding, and refusing it leaves the
    // work unreachable rather than safe.
    const r = await resolveRefs(root, [input.targetId], input.ref, { includeOrphans: true });
    if (!r.ids.length) return { error: r.errors.join("; ") };
    targetId = r.ids[0]!;
    const w = await witnessAt(root, targetId, input.ref);
    witness = w.witness;
    sourceRef = w.sourceRef;
  } else {
    const nodes = await loadNodesShared(root);
    // OR the sidecar. The guard refuses a target that exists NOWHERE; a doc the team
    // published and this store never adopted exists, it is just not here — and it
    // cannot be adopted either, because `document` refuses a node whose anchors do
    // not resolve, which is exactly the doc being queued. Without this a shared-only
    // doc had no path to the review queue at all. Dynamic, like every other core
    // reach for the sidecar (`context`, `findGaps`): the agnostic core must not
    // depend on it, and a missing or unreadable sidecar answers false.
    if (!nodes.some((n) => n.id === input.targetId)) {
      const shared = await import("../docs-lookup.js")
        .then((m) => m.sharedKnowsNode(root, input.targetId!)).catch(() => false);
      if (!shared) return { error: `unknown node "${input.targetId}"` };
    }
  }
  const line = Number.isFinite(input.line) && (input.line as number) > 0 ? Math.floor(input.line as number) : undefined;
  // `finding` is REFUSED, not silently downgraded to a note. This is the tap that keeps
  // refilling the split store: a finding filed here is a local annotation with no `pr`,
  // so `shared_findings`, `defer_finding`, `record_published` and `inbound_replies` can
  // none of them ever reach it — and `codemap unify-findings` drains a pool that this
  // was still pouring into. `report_defect` is the one create verb, and it takes the
  // context that decides where the record belongs.
  //
  // Legacy annotations KEEP `kind: "finding"` — the queue reads it, and rewriting
  // history to close an input hole would lose which of them were findings.
  if (input.kind === "finding" && !opts.legacy) {
    return {
      error: "`annotate` no longer files findings — use `report_defect`, which takes the `context` that decides "
        + "whether it becomes a pull-request finding or a drive-by bug. A finding filed here would be a local "
        + "annotation with no pull request, which no shared surface can reach.",
    };
  }
  const KINDS = opts.legacy
    ? ["note", "question", "finding", "pointer"] as const
    : ["note", "question", "pointer"] as const;
  const kind = (KINDS as readonly string[]).includes(input.kind ?? "") ? input.kind : "note";
  const SEV = ["low", "medium", "high", "critical"];
  const severity = input.severity && SEV.includes(input.severity) ? input.severity : undefined;
  const category = input.category?.trim() || undefined;
  const c = checkComment(input.comment, input.disposition);
  if ("error" in c) return c;
  // `agent` falls back to the author-string sniff — the very heuristic this replaces —
  // because until every caller passes the flag, dropping it would silently DEFAULT
  // agent findings to `confirmed`, i.e. publishable with nobody vouching. `|| undefined`
  // rather than the bare boolean so a false sniff still lets the env vars decide.
  const looksAgent = (input.author ?? "agent").startsWith("agent");
  const resolved = requireActor(root, {
    agent: input.agent ?? (looksAgent || undefined),
    model: input.model,
    harness: input.harness,
  });
  if ("error" in resolved) return resolved;
  const actor = resolved;
  // The comment requirement lives on `report_defect` now — findings are refused above,
  // so there is no kind left here that has a submitter to write for.
  const ann: Annotation = {
    id: genId(kind || "note"),
    target: { kind: input.targetKind, id: targetId },
    text: input.text,
    kind,
    ...(severity ? { severity } : {}),
    ...(category ? { category } : {}),
    ...(c.comment ? { comment: c.comment } : {}),
    // Every kind carries one, so triage can promote any of them — a `pointer` that
    // investigation confirms is a finding in all but the field it was filed under.
    //
    // The default follows authorship, exactly as `isElected` does: a human writing
    // it IS the assertion, so `confirmed`; an agent's is a proposal awaiting triage,
    // so `open`. Anything else would either make the human re-affirm their own
    // finding before it could be sent, or let an unreviewed agent claim through.
    //
    // Decided from the structured actor, not from the author STRING. The old
    // `author.startsWith("agent")` made the answer depend on a name: a person
    // called "agentina" filed proposals, and an agent labelled anything else filed
    // findings that were publishable without anyone vouching for them. Falls back
    // to the string only for callers that pass no actor at all.
    disposition: checkDisposition(input.disposition)
      ?? (actor ? (isAgentActor(actor) ? "open" : "confirmed")
        : (input.author ?? "agent").startsWith("agent") ? "open" : "confirmed"),
    ...(input.publishPath?.trim() ? { publishPath: input.publishPath.trim() } : {}),
    ...(Number.isFinite(input.publishLine) ? { publishLine: Math.floor(input.publishLine as number) } : {}),
    resolved: false,
    ...(line !== undefined ? { line } : {}),
    ...(witness ? { witness } : {}),
    ...(sourceRef ? { sourceRef } : {}),
    // Both, for now. `author` stays because every existing record has one and the
    // UI reads it; `actor` is what a shared store needs and what the rules check.
    author: input.author ?? (actor ? actorLabel(actor) : "agent"),
    ...(actor ? { actor } : {}),
    createdCommit: headCommit(root),
  };
  const annStore = await readAnnotations(root);
  annStore.annotations.push(ann);
  await writeAnnotations(root, annStore.annotations);
  // Mirrored onto the sidecar when one is configured, because an annotation is
  // codebase knowledge that cost somebody real reading time — leaving it in one
  // person's SQLite means the next person pays for it again.
  //
  // AFTER the local write and never in place of it: codemap worked without a
  // sidecar for its whole life, and a note must not be lost because a shared repo
  // was misconfigured. `mirrorNote` is a no-op when there is nothing to mirror to,
  // and a throw here must not fail a write that has already succeeded locally.
  if (input.localOnly) return { ok: true, id: ann.id, target: ann.target };
  const { mirrorNote } = await import("../notes-publish.js");
  const mirrored = await mirrorNote(root, {
    id: ann.id, targetKind: input.targetKind, targetId,
    kind: kind ?? "note", text: input.text,
    severity, category, line,
  }).catch(() => ({ shared: false }));
  return { ok: true, id: ann.id, target: ann.target, ...(mirrored.shared ? { shared: true } : {}) };
}

/**
 * Resolve (or re-open) an annotation.
 *
 * `actor: "agent"` may only close a QUESTION — the thing it was asked and has now
 * answered. Closing a finding is the human's act: `closeAssignment` refuses to do it
 * for exactly this reason ("reporting and agreeing it is closed are different
 * acts"), and an agent that could reach the same state through this door would have
 * that guarantee for nothing. It is not only about self-vouching — `resolved` also
 * stops a finding ever reaching the pull request, so it is a way to silently
 * suppress one.
 */
export async function resolveAnnotation(
  root: string, id: string, resolved = true,
  opts: { actor?: "human" | "agent" } = {},
) {
  const annStore = await readAnnotations(root);
  const ann = annStore.annotations.find((a) => a.id === id);
  if (!ann) return { error: `no annotation "${id}"` };
  if (opts.actor === "agent" && (ann.kind ?? "note") !== "question") {
    return { error: `\`${id}\` is a ${ann.kind ?? "note"}, not a question — reporting on it and agreeing it is closed are different acts. Use \`close_finding\` to say what you did; the human closes it after reading.` };
  }
  ann.resolved = resolved;
  await writeAnnotations(root, annStore.annotations);
  return { ok: true, id, resolved, target: ann.target };
}

/**
 * Raise an agent's finding to the pull request's maintainer — or take it back.
 *
 * The one act that makes an agent's proposal publishable. It is deliberately
 * separate from `resolve` and from signing the symbol: reading a finding, agreeing
 * with it, and being willing to put your name on it in front of the author are
 * three different things, and only the third should notify anybody.
 *
 * A human-authored finding needs no flag — writing it was the act — so electing one
 * is refused rather than silently recorded as something it is not.
 */
export async function escalateAnnotation(root: string, input: { id: string; escalate?: boolean; by?: string }) {
  const annStore = await readAnnotations(root);
  const ann = annStore.annotations.find((a) => a.id === input.id);
  if (!ann) return { error: `no annotation "${input.id}"` };
  if (!isAgentAuthored(ann)) return { error: "you wrote this one — it is already yours to publish" };
  if (ann.resolved) return { error: "that finding is resolved; reopen it first if it should go to the maintainer" };
  const escalate = input.escalate !== false;
  ann.escalated = escalate ? { at: new Date().toISOString(), by: input.by || "human" } : undefined;
  await writeAnnotations(root, annStore.annotations);
  return { ok: true, id: ann.id, escalated: escalate, target: ann.target };
}

/**
 * Every annotation already published, across every pull request.
 *
 * The queue is not PR-scoped, so `posted` here means "went out somewhere" — which
 * is the question being asked. Per-PR dedupe stays in `planPrPush`, where the PR
 * is known.
 */
async function pushedAnnotationIds(root: string): Promise<Set<string>> {
  const ids = new Set<string>();
  for (const rec of Object.values((await readPushes(root)).pushes)) for (const id of rec.annotationIds ?? []) ids.add(id);
  return ids;
}

/**
 * Amend a finding, keeping what it used to say.
 *
 * Findings are filed before they are understood. A report goes in, investigation
 * shows it was overstated or aimed at the wrong line, and the correction has to be
 * visible AS a correction — which is exactly the case where you most want to see
 * what changed and who changed it. Revisions append; nothing is destroyed.
 *
 * Callable by either party: an agent revising its own overstatement is the loop
 * working, and the human sharpening an agent's wording is the normal path to a
 * publishable comment.
 */
export async function reviseAnnotation(
  root: string,
  input: {
    id: string; by?: string; allowPostEdit?: boolean;
    text?: string; comment?: string; disposition?: Disposition; severity?: BugSeverity;
    publishPath?: string; publishLine?: number; publishAttribution?: "agent" | "human";
    /** Where in the anchor's own file this points — the normal way to say it. */
    line?: number;
    /**
     * Re-witness against this ref. Revising after re-reading the code is exactly how
     * a finding blocked as written-against-a-different-body gets cleared, so the
     * re-read has to be recordable — otherwise the only way past the gate would be
     * to ignore it.
     */
    ref?: string;
  },
) {
  const store = await readAnnotations(root);
  const ann = store.annotations.find((a) => a.id === input.id);
  // Names both namespaces because this is the LAST branch `ops.reviseOn` tries: an id
  // that is not a finding lands here, and answering a shared id with `no annotation`
  // named the one store the caller had not asked about.
  if (!ann) return { error: `no finding or annotation "${input.id}" — ids come from \`findings\`, \`shared_findings\` or \`review_queue\`` };
  // Editing what the submitter can already see, without editing it there too, makes
  // the map and the pull request disagree about what was said — and the pull request
  // is the copy the other person is acting on.
  if (ann.postedRef && !input.allowPostEdit) {
    return { error: `that finding is already posted to PR #${ann.postedRef.pr}${ann.postedRef.url ? ` (${ann.postedRef.url})` : ""}. Revising it here would diverge from what the submitter can see — reply on the pull request instead, or pass allowPostEdit to change the map anyway (which does NOT edit the posted comment).` };
  }

  const c = checkComment(input.comment, input.disposition ?? ann.disposition);
  if ("error" in c) return c;
  const disposition = input.disposition === undefined ? undefined : checkDisposition(input.disposition);
  if (input.disposition !== undefined && !disposition) {
    return { error: `unknown disposition "${input.disposition}" — expected one of ${DISPOSITIONS.join(", ")}` };
  }
  const SEV = ["low", "medium", "high", "critical"];
  if (input.severity !== undefined && !SEV.includes(input.severity)) {
    return { error: `unknown severity "${input.severity}" — expected one of ${SEV.join(", ")}` };
  }

  const was: NonNullable<Annotation["revisions"]>[number]["was"] = {};
  const changed: string[] = [];
  /**
   * `provided` is separate from the value on purpose: a field the caller did not
   * mention must not change, and a field it sent EMPTY must be cleared. Folding the
   * two together meant an empty string read as "no change", so clearing a
   * `publishPath` in the editor silently kept the old one while the form showed it
   * gone — a comment would then have published against a file nobody chose.
   */
  const bump = <K extends keyof typeof was>(k: K, provided: boolean, next: (typeof was)[K] | undefined) => {
    if (!provided || next === (ann as never as Record<string, unknown>)[k]) return;
    (was as Record<string, unknown>)[k] = (ann as never as Record<string, unknown>)[k];
    if (next === undefined) delete (ann as never as Record<string, unknown>)[k];
    else (ann as never as Record<string, unknown>)[k] = next;
    changed.push(k);
  };
  const num = (v: unknown) => (Number.isFinite(v) && (v as number) > 0 ? Math.floor(v as number) : undefined);
  bump("line", input.line !== undefined, num(input.line));
  bump("text", input.text !== undefined, input.text?.trim() || undefined);
  bump("comment", input.comment !== undefined, c.comment);
  bump("disposition", input.disposition !== undefined, disposition);
  bump("severity", input.severity !== undefined, input.severity);
  bump("publishPath", input.publishPath !== undefined, input.publishPath?.trim() || undefined);
  bump("publishLine", input.publishLine !== undefined, num(input.publishLine));
  if (input.publishAttribution) ann.publishAttribution = input.publishAttribution;
  if (input.ref !== undefined && ann.target.kind === "anchor") {
    const w = await witnessAt(root, ann.target.id, input.ref || undefined);
    if (!w.witness) return { error: `could not read ${ann.target.id} at ${input.ref || "@work"} — nothing to witness against` };
    // EXACT, deliberately — not `sameBody`. The assignment below is only
    // PERSISTED if `changed` is non-empty (see the early return further down), so
    // an annotation-only difference has to count as a change or the better-
    // annotated witness is computed, assigned in memory, and dropped.
    if (w.witness.bodyHash !== ann.witness?.bodyHash) {
      was.witness = ann.witness; was.sourceRef = ann.sourceRef;
      changed.push("witness");
    }
    ann.witness = w.witness;
    ann.sourceRef = w.sourceRef;
  }

  if (!changed.length) return { ok: true, id: ann.id, changed: [], note: "nothing to change" };
  (ann.revisions ??= []).push({ at: new Date().toISOString(), by: input.by || "agent", was });
  await writeAnnotations(root, store.annotations);
  return { ok: true, id: ann.id, changed, revisions: ann.revisions.length, target: ann.target };
}

/**
 * The human decides this one is not going to the submitter — without resolving it,
 * because it may still be true and still worth having on the map.
 *
 * Separate from clearing `escalated`, which only exists on an AGENT's finding. A
 * human's own finding is publishable by virtue of having been written, so declining
 * to send it needs a record of its own rather than the absence of one.
 */
export async function withdrawAnnotation(root: string, input: { id: string; withdraw?: boolean; by?: string; reason?: string }) {
  const store = await readAnnotations(root);
  const ann = store.annotations.find((a) => a.id === input.id);
  if (!ann) return { error: `no annotation "${input.id}"` };
  if (ann.postedRef && input.withdraw !== false) {
    return { error: `that finding is already posted to PR #${ann.postedRef.pr} — withdrawing it here would not take it off the pull request. Reply to it there instead.` };
  }
  const withdraw = input.withdraw !== false;
  ann.withdrawn = withdraw
    ? { at: new Date().toISOString(), by: input.by || "human", ...(input.reason?.trim() ? { reason: input.reason.trim() } : {}) }
    : undefined;
  await writeAnnotations(root, store.annotations);
  return { ok: true, id: ann.id, withdrawn: withdraw, target: ann.target };
}

/**
 * Hand a finding to an agent. The reviewer's half of the loop: raising a finding
 * records it, assigning it asks for something to be done about it.
 */
export async function assignAnnotation(
  root: string,
  input: { id: string; kind: "investigate" | "fix"; by?: string; note?: string },
) {
  const store = await readAnnotations(root);
  const ann = store.annotations.find((a) => a.id === input.id);
  if (!ann) return { error: `no annotation "${input.id}"` };
  if (ann.resolved) return { error: "that annotation is already resolved — reopen it before assigning" };
  ann.assignment = { to: "agent", kind: input.kind, at: new Date().toISOString(), by: input.by || "me", note: input.note };
  ann.outcome = undefined; // a re-assignment asks again; the previous answer no longer stands
  await writeAnnotations(root, store.annotations);
  return { ok: true, id: ann.id, assigned: input.kind, target: ann.target };
}

export interface QueueItem {
  id: string;
  kind: Annotation["kind"];
  severity?: BugSeverity;
  category?: string;
  /** Absent under `brief` — `textPreview` carries the head of it instead. */
  text?: string;
  textPreview?: string;
  comment?: string;
  disposition?: Disposition;
  /**
   * The same axis `disposition` names, in the vocabulary `shared_findings` uses, so
   * one word reads both lists. See `tierOfAnnotation` for the correspondence.
   */
  tier?: FindingTier;
  /** What HAPPENED about it — the axis `tier` and `disposition` do not carry. */
  remediation?: Remediation;
  publishState?: PublishState;
  /**
   * False when the target is not in the working tree. The queue used to serve a
   * dangling id with nothing marking it — while `annotate` and `get_anchor` both
   * rejected the same id — so an agent could work from it and never learn the code
   * was gone. `targetAt` says where it was found instead.
   */
  targetResolved?: boolean;
  targetAt?: string;
  postedRef?: Annotation["postedRef"];
  /**
   * Set on rows that are canonical FINDINGS rather than annotations: which pull request
   * it belongs to, and whether the team has it. Absent on a note or a question, which
   * have neither.
   */
  pr?: string;
  shared?: boolean;
  /**
   * Triage state. The queue is the only way the web findings list can see a finding
   * on a symbol the pull request does not touch, and without these three every such
   * row read as live: it offered `resolve` on an already-resolved finding and never
   * `reopen`, and no amount of resolving could take one out of the list. Resolving a
   * dead finding wrote to the store and changed nothing on screen.
   */
  resolved?: boolean;
  withdrawn?: Annotation["withdrawn"];
  escalated?: Annotation["escalated"];
  line?: number;
  author: string;
  /** Absent when listing beyond the assignment queue (`assignedOnly: false`). */
  assignment?: Annotation["assignment"];
  target: Annotation["target"];
  /** Where to look: the anchor's file and symbol, plus its current source. */
  file?: string;
  symbol?: string;
  startLine?: number;
  code?: string;
}

/**
 * What an agent has been asked to act on, with enough context to act without
 * hunting: the finding, the symbol it sits on, and that symbol's current source.
 *
 * Only unresolved, unanswered assignments — an item that already has an `outcome`
 * is waiting on the human, not on the agent, and returning it would have agents
 * redo work someone has not read yet.
 */
/**
 * A canonical finding, in the shape this queue already knows how to handle.
 *
 * Findings are rows now, not annotations, so `review_queue` and `findings` were
 * answering from half the map — 51 of 96 on the store that motivated the migration.
 * Converting on the way IN rather than rewriting the pipeline keeps every filter,
 * the paging, the brief/full split and the off-tree resolution working unchanged.
 *
 * `disposition` is DERIVED, and only from things the record actually says: a refuting
 * verdict or a refuted state is `refuted`, a confirmation is `confirmed`, and anything
 * else is `open`. It is not stored on a finding — the shared model carries verdicts and
 * a state instead — so inventing a richer one here would put a triage conclusion on a
 * record nobody reached it for.
 */
/**
 * A plain annotation's tier — the one axis both finding surfaces answer on.
 *
 * `disposition` and `tier` name the same question ("how settled is this?") in two
 * vocabularies, and until the two stores are one word (`docs/plan-findings-unification.md`)
 * this is the mapping, in one place, so neither surface has to know the other's words:
 *
 *   open                          -> unconfirmed   nobody has weighed in
 *   confirmed / partial / rerated -> confirmed     somebody stood behind it
 *   refuted                       -> doubted       probably not real
 *   accepted, or resolved         -> settled       real, and done with
 *
 * `accepted` lands in `settled` rather than `confirmed` deliberately: it means real and
 * deliberately not being fixed, so it is finished, and leaving it under `confirmed`
 * would keep it at the top of a list read for what still needs deciding.
 */
export function tierOfAnnotation(a: Pick<Annotation, "disposition" | "resolved" | "withdrawn">): FindingTier {
  if (a.resolved || a.disposition === "accepted") return "settled";
  if (a.withdrawn || a.disposition === "refuted") return "doubted";
  if (a.disposition && a.disposition !== "open") return "confirmed";
  return "unconfirmed";
}

function findingAsQueueEntry(f: SharedFinding): Annotation {
  const refuted = f.state === "refuted" || f.corroboration.some((c) => c.verdict === "refute");
  const confirmed = f.corroboration.some((c) => c.verdict === "confirm");
  return {
    id: f.id,
    target: f.target,
    text: f.text,
    kind: "finding",
    ...(f.severity ? { severity: f.severity } : {}),
    ...(f.category ? { category: f.category } : {}),
    ...(f.line !== undefined ? { line: f.line } : {}),
    ...(f.comment ? { comment: f.comment } : {}),
    disposition: refuted ? "refuted" : confirmed ? "confirmed" : "open",
    resolved: f.state === "resolved",
    ...(f.state === "withdrawn" && f.closed
      ? { withdrawn: { at: f.closed.at, by: f.closed.by.principal, ...(f.closed.reason ? { reason: f.closed.reason } : {}) } } : {}),
    ...(f.posted ? { postedRef: { pr: Number(f.pr) || 0, at: f.posted.at, placement: "inline" as const, ...(f.posted.url ? { url: f.posted.url } : {}) } } : {}),
    ...(f.assignment ? { assignment: { to: "agent" as const, kind: f.assignment.kind === "answer" ? "investigate" as const : f.assignment.kind, at: f.assignment.at, by: f.assignment.by.principal, ...(f.assignment.note ? { note: f.assignment.note } : {}) } } : {}),
    ...(f.outcome ? { outcome: { at: f.outcome.at, by: f.outcome.by.principal, result: f.outcome.result, detail: f.outcome.detail, ...(f.outcome.files ? { files: f.outcome.files } : {}) } } : {}),
    ...(f.witness ? { witness: f.witness } : {}),
    ...(f.sourceRef ? { sourceRef: f.sourceRef } : {}),
    author: f.author.principal,
    actor: f.author,
    createdCommit: null,
    revisions: f.revisions.map((r) => ({ at: r.at, by: r.by.principal, was: r.was as never })),
  } as Annotation;
}

export async function reviewQueue(
  root: string,
  opts: {
    includeAnswered?: boolean; brief?: boolean; limit?: number; offset?: number;
    disposition?: string; publishState?: string;
    /**
     * One pull request's findings. PR membership is STORED on a canonical finding
     * (`docs/plan-findings-unification.md`), so this is a filter and not the read-time
     * worklist intersection the PR story does. An annotation has no `pr` of its own
     * until it is posted, so it matches only through its `postedRef`.
     */
    pr?: string | number;
    /**
     * How settled the row is, in the shared vocabulary — see `tierOf`. The same axis
     * `disposition` names locally, so either word answers "what has nobody looked at":
     * `tier: "unconfirmed"` and `disposition: "open"` select the same rows.
     */
    tier?: string;
    /**
     * What HAPPENED about it, as opposed to whether it is true — the other axis. Without
     * it, `disposition: "confirmed"` cannot tell an outstanding defect from one the
     * submitter fixed last night, which is what pushed people to revise fixed findings
     * to `refuted` and call real defects false positives.
     */
    remediation?: string;
    /**
     * Default true: the queue is "what a human asked an agent to act on", and an
     * assignment is what made it that.
     *
     * `false` lists every finding instead. Without it there was no way to enumerate
     * what had been PUBLISHED — a finding raised by `annotate` and never assigned
     * was posted to GitHub and then invisible to every query, which is a hole under
     * the idempotency rule even though the dedupe itself reads `postedRef` and the
     * push record rather than this.
     */
    assignedOnly?: boolean;
    includeResolved?: boolean;
    /**
     * Exactly these annotations, in the queue's own shape — restricted before
     * paging and before the full form re-indexes a file per row.
     */
    ids?: string[];
  } = {},
) {
  const store = await readAnnotations(root);
  const rows = (await readFindings(root)).findings;
  // Which pull request each row belongs to, and whether the team has it. Kept beside
  // the queue rather than forced into the Annotation shape: neither is a thing an
  // annotation has, and a synthetic field nobody can write back to is a lie.
  const prOf = new Map(rows.map((f) => [f.id, f.pr!]));
  const sharedIds = new Set(rows.filter((f) => f.origin).map((f) => f.id));
  // Tier from the RECORD where there is one. `findingAsQueueEntry` flattens a
  // finding's state and corroboration down to a `Disposition`, which cannot tell
  // `invalid` from unreviewed — so the tier is taken before that flattening, and only
  // a plain annotation, which never had the richer state, is derived from it.
  const tierOf = new Map(rows.map((f) => [f.id, findingTier(f)]));
  // Unset reads as `outstanding`: nobody has said anything happened, which is what
  // "outstanding" means. A separate "unknown" would split one state into two for no
  // caller — every filter on it wants the same rows either way.
  const remediationOf = new Map(rows.filter((f) => f.remediation).map((f) => [f.id, f.remediation!.state]));
  const everything = [...store.annotations, ...rows.map(findingAsQueueEntry)];
  const pushedIds = await pushedAnnotationIds(root);
  const liveIds = new Set((await readAnchorStore(root)).anchors.map((a) => a.id));
  const assignedOnly = opts.assignedOnly !== false;
  let pending = everything.filter((a) => assignedOnly
    ? a.assignment && !a.resolved && (opts.includeAnswered || !a.outcome)
    : (a.kind === "finding" || a.kind === "question") && (opts.includeResolved || !a.resolved));
  if (opts.ids) { const want = new Set(opts.ids); pending = pending.filter((a) => want.has(a.id)); }
  if (opts.pr !== undefined) {
    const want = String(opts.pr);
    pending = pending.filter((a) => (prOf.get(a.id) ?? (a.postedRef ? String(a.postedRef.pr) : undefined)) === want);
  }
  if (opts.disposition) pending = pending.filter((a) => (a.disposition ?? "open") === opts.disposition);
  if (opts.tier) pending = pending.filter((a) => (tierOf.get(a.id) ?? tierOfAnnotation(a)) === opts.tier);
  if (opts.remediation) pending = pending.filter((a) => (remediationOf.get(a.id) ?? "outstanding") === opts.remediation);
  if (opts.publishState) pending = pending.filter((a) => publishStateOf(a, pushedIds) === opts.publishState);

  const rank = { critical: 0, high: 1, medium: 2, low: 3 } as Record<string, number>;
  pending.sort((x, y) => (rank[x.severity ?? "low"] ?? 3) - (rank[y.severity ?? "low"] ?? 3));
  const total = pending.length;
  const offset = Math.max(0, Math.floor(opts.offset ?? 0));
  const limit = Number.isFinite(opts.limit) ? Math.max(1, Math.floor(opts.limit as number)) : undefined;
  const page = pending.slice(offset, limit === undefined ? undefined : offset + limit);
  const more = offset + page.length < total;

  // Brief by DEFAULT, because the full form inlines every anchor's source: the first
  // real call of this tool returned 100,882 characters and blew the token limit
  // outright, so the work could not start until it had been dumped to a file and
  // mined with jq. Full source is one `get_anchor` away; a queue you cannot read is
  // not a queue.
  // A dangling target is not an error here — the finding is still real, and the
  // comment on it is the durable artefact. It just has to be VISIBLE, so nobody
  // works from an id that `annotate` and `get_anchor` will both reject.
  const offTree = findAnchorsOutsideWork(root, [...new Set(
    pending.filter((a) => a.target.kind === "anchor" && !liveIds.has(a.target.id)).map((a) => a.target.id),
  )]);
  const keptAnchors = readOrphans(root, [...new Set(
    pending.filter((a) => a.target.kind === "anchor" && !liveIds.has(a.target.id)).map((a) => a.target.id),
  )]);
  const triageState = (a: Annotation) => ({
    ...(a.resolved ? { resolved: true } : {}),
    ...(a.withdrawn ? { withdrawn: a.withdrawn } : {}),
    ...(a.escalated ? { escalated: a.escalated } : {}),
  });
  const targetState = (a: Annotation) => {
    if (a.target.kind !== "anchor" || liveIds.has(a.target.id)) return {};
    const at = offTree.get(a.target.id)?.ref ?? (keptAnchors.has(a.target.id) ? "@orphan" : undefined);
    return { targetResolved: false, ...(at ? { targetAt: at } : {}) };
  };

  if (opts.brief !== false) {
    const brief: QueueItem[] = page.map((a) => ({
      id: a.id, kind: a.kind, severity: a.severity, category: a.category,
      disposition: a.disposition ?? "open", tier: tierOf.get(a.id) ?? tierOfAnnotation(a),
      remediation: remediationOf.get(a.id) ?? "outstanding",
      publishState: publishStateOf(a, pushedIds),
      comment: a.comment,
      textPreview: a.text.length > 300 ? a.text.slice(0, 300) + "…" : a.text,
      line: a.line, author: a.author, assignment: a.assignment, target: a.target,
      ...targetState(a),
      ...triageState(a),
      ...(a.postedRef ? { postedRef: a.postedRef } : {}),
      ...(prOf.has(a.id) ? { pr: prOf.get(a.id), shared: sharedIds.has(a.id) } : {}),
    }));
    return {
      total, offset, more, queue: brief,
      hint: "brief — pass brief:false for each symbol's full source, or read one with `get_anchor`.",
    };
  }
  pending = page;
  if (!pending.length) return { total, offset, more, queue: [] as QueueItem[] };

  const anchorIds = [...new Set(pending.filter((a) => a.target.kind === "anchor").map((a) => a.target.id))];
  const anchors = new Map((await readAnchorStore(root)).anchors.filter((a) => anchorIds.includes(a.id)).map((a) => [a.id, a]));
  // A finding ingested against a pull request is written against the PR HEAD's
  // anchors, so one on a symbol the branch ADDS has no `@work` row — and the item
  // came back with no file, no symbol and no source, which is precisely the hunting
  // this surface promises the agent will not have to do. Fall back to the newest
  // cached commit snapshot that holds it.
  const elsewhere = findAnchorsOutsideWork(root, anchorIds.filter((id) => !anchors.has(id)));

  const queue: QueueItem[] = [];
  for (const a of pending) {
    const off = a.target.kind === "anchor" ? elsewhere.get(a.target.id) : undefined;
    const anc = a.target.kind === "anchor" ? (anchors.get(a.target.id) ?? off?.anchor) : undefined;
    let code: string | undefined;
    if (anc && off) {
      // Only that commit has this body; read it from the commit, not from disk.
      try {
        const src = readBlobs(root, off.ref, [anc.file]).get(anc.file);
        const live = src ? (await indexBlob(src, anc.file)).find((x) => x.id === anc.id) : undefined;
        if (src && live?.loc) code = src.slice(live.loc.startByte, live.loc.endByte);
      } catch { /* the commit is gone — the finding still stands */ }
    } else if (anc) {
      // Re-index live, as `getAnchor` does. The stored `loc` is from the last index;
      // any edit above the symbol since then shifts the window, so slicing with it
      // hands an agent asked to FIX a finding the wrong text — under a tool
      // description that promises the symbol's current source.
      try {
        const src = await readFile(join(root, anc.file), "utf8");
        const live = (await indexFile(join(root, anc.file), anc.file)).find((x) => x.id === anc.id);
        if (live?.loc) code = src.slice(live.loc.startByte, live.loc.endByte);
      } catch { /* file gone — the finding still stands, the agent will see it missing */ }
    }
    queue.push({
      id: a.id, kind: a.kind, severity: a.severity, category: a.category, text: a.text,
      line: a.line, author: a.author, assignment: a.assignment, target: a.target,
      file: anc?.file, symbol: anc?.symbolPath.join(" › "), startLine: anc?.loc?.startLine, code,
      // Where the source came from, when it is not the working tree — an agent asked
      // to FIX must know it is looking at a branch's body, not at HEAD.
      ...(off ? { atCommit: off.ref } : {}),
      comment: a.comment,
      disposition: a.disposition ?? "open",
      tier: tierOf.get(a.id) ?? tierOfAnnotation(a),
      remediation: remediationOf.get(a.id) ?? "outstanding",
      publishState: publishStateOf(a, pushedIds),
      ...targetState(a),
      ...triageState(a),
      ...(a.postedRef ? { postedRef: a.postedRef } : {}),
    });
  }
  return { total, offset, more, queue };
}

/**
 * An agent reporting back. It does NOT resolve the finding — reporting and
 * agreeing it is closed are different acts, and an agent marking its own work
 * done is the accountability hole the whole attestation model avoids.
 *
 * A `fix` touching more than one file is refused. That boundary was drawn
 * deliberately: a multi-file change is work to hand a proper agent, not something
 * a review tool slips into someone's branch. Declining with a reason is a useful
 * answer, so it is recorded as one.
 */
/**
 * Report back on a LOCAL canonical finding — one filed here and not yet the fold's.
 *
 * `review_queue` serves annotations and findings in one list now, so an id it handed
 * out has to be closeable whichever store it came from. Resolved against the RECORD,
 * never by the id's prefix: those are minted by a generic helper and say nothing about
 * where a row lives.
 *
 * Fold-owned rows are NOT handled here, and the split is a layering constraint rather
 * than a preference: a row the fold owns may only be changed by an event, and reaching
 * `ops-shared` from this module closes an import cycle through `ops/triage`. `ops.ts`
 * owns that branch — see `closeFinding` there.
 *
 * Reporting is not resolving, the same rule `close_finding` states: this records what
 * was done and leaves the close to a person.
 *
 * `disposition` maps only where the finding model has somewhere true to put it: refuted
 * and confirmed are verdicts, so they land as corroboration. `partial`, `rerated` and
 * `accepted` are triage conclusions with no equivalent, and are reported back as not
 * recorded rather than dropped silently.
 */
export async function closeLocalFinding(
  root: string,
  input: {
    id: string; result: "fixed" | "answered" | "declined"; detail: string; files?: string[]; by?: string;
    comment?: string; line?: number; severity?: BugSeverity; disposition?: Disposition;
  },
): Promise<Record<string, unknown>> {
  const f = await readFinding(root, input.id).catch(() => null);
  if (!f) return { error: `no annotation or finding "${input.id}"` };
  // NO assignment precondition. Reporting back is what this records, and the ordinary
  // path that produces a finding — report_defect, publish, the submitter fixes it,
  // report back — has no assignment step anywhere in it. Requiring one made the tool
  // refuse the case its own description names ("takes any finding id"), and refuse it
  // for a reason no caller could satisfy by any route it controls. Assignment is a
  // HUMAN handing work over; it is not what makes an outcome worth recording.
  if (isClosed(f.state)) {
    return { error: `that finding is already \`${f.state}\` — reopen it before recording an outcome, or say this on the thread with \`comment\`` };
  }
  const files = input.files ?? [];
  if (input.result === "fixed" && files.length > 1) {
    return { error: `a fix may touch one file; this touched ${files.length} (${files.join(", ")}).` };
  }
  const c = checkComment(input.comment, input.disposition);
  if ("error" in c) return c;
  const actor = requireActor(root);
  if ("error" in actor) return actor;
  const verdict = input.disposition === "refuted" ? "refute" as const : input.disposition === "confirmed" ? "confirm" as const : null;
  const unmapped = input.disposition && !verdict ? input.disposition : null;
  const at = new Date().toISOString();

  const SEV = ["low", "medium", "high", "critical"];
  if (input.severity !== undefined && !SEV.includes(input.severity)) {
    return { error: `unknown severity "${input.severity}" — expected one of ${SEV.join(", ")}` };
  }
  // A re-rate that only reaches `detail` is the thing this whole surface exists to
  // stop: prose nothing can filter on, over a record that still reads `high`.
  const was: Record<string, unknown> = {};
  const set = <K extends keyof SharedFinding>(k: K, v: SharedFinding[K] | undefined) => {
    if (v === undefined || v === f[k]) return;
    was[k] = f[k];
    f[k] = v;
  };
  f.outcome = { result: input.result, detail: input.detail, ...(files.length ? { files } : {}), by: actor, at };
  set("comment", c.comment);
  set("line", Number.isFinite(input.line) ? Math.floor(input.line as number) : undefined);
  set("severity", input.severity);
  if (Object.keys(was).length) f.revisions = [...f.revisions, { at, by: actor, was }];
  if (verdict) f.corroboration = [...f.corroboration, { actor, verdict, at, rationale: input.detail, independent: false }];
  await writeLocalFinding(root, f, f.pr!);
  return { ok: true, id: f.id, pr: f.pr, shared: false, ...(unmapped ? { note: `disposition "${unmapped}" is not recorded on a finding — verdicts are` } : {}) };
}

/**
 * Add to a LOCAL finding's thread — one filed here with no sidecar, or not yet folded.
 *
 * The shared half is an event (`comment_on_finding`); this is the row half, and it lives
 * here for the same layering reason `closeLocalFinding` does: reaching `ops-shared` from
 * this module closes an import cycle through `ops/triage`. `ops.ts` picks between them.
 */
export async function commentOnLocalFinding(root: string, id: string, body: string, inReplyTo?: string) {
  if (!body.trim()) return { error: "an empty comment says nothing" };
  const f = await readFinding(root, id).catch(() => null);
  if (!f) return { error: `no finding "${id}"` };
  const actor = requireActor(root);
  if ("error" in actor) return actor;
  const at = new Date().toISOString();
  const commentId = "c_" + Math.random().toString(36).slice(2, 10);
  f.thread = [...f.thread, { id: commentId, actor, at, body, ...(inReplyTo ? { inReplyTo } : {}) }];
  await writeLocalFinding(root, f, f.pr!);
  return { ok: true, id: commentId };
}

/**
 * The fields a revision may rewrite, on either half of the split.
 *
 * Same list as the fold applies for `finding.revised` (`shared-findings.ts`) — kept
 * beside the local writer so the two halves of one verb cannot drift into revising
 * different things depending on whether a sidecar happens to be configured.
 */
export const REVISABLE = ["text", "comment", "severity", "category", "line"] as const;

/**
 * Revise a LOCAL finding — one filed here with no sidecar, or not yet folded.
 *
 * The shared half is an event (`finding.revised`); this is the row half, and it lives
 * here for the layering reason `closeLocalFinding` gives. `ops.reviseOn` picks between
 * them, and neither is reachable by a caller that has to know which store it has.
 *
 * A finding already on the pull request is refused for the reason `reviseAnnotation`
 * gives: the submitter is acting on the posted copy, and editing only the map makes
 * the two disagree without anybody being told.
 */
export async function reviseLocalFinding(
  root: string,
  input: {
    id: string; allowPostEdit?: boolean;
    text?: string; comment?: string; severity?: BugSeverity; category?: string; line?: number;
    /**
     * What triage concluded. A canonical finding has no `disposition` FIELD — it has
     * corroboration, which is where a verdict lives — so the two verdict-shaped values
     * land there and the rest are reported back as not recorded.
     *
     * It used to be accepted and dropped: `revise_finding(disposition: "confirmed")`
     * returned `ok` with `disposition` absent from `changed` and no warning, and passing
     * it alone returned "nothing changed", which reads as "it was already that value".
     * Twelve findings were believed triaged and were not.
     */
    disposition?: Disposition;
    /** Re-witness against this ref after re-reading the code, exactly as `reviseAnnotation` does. */
    ref?: string;
  },
) {
  const f = await readFinding(root, input.id).catch(() => null);
  if (!f) return { error: `no finding "${input.id}"` };
  if (f.posted && !input.allowPostEdit) {
    return { error: `that finding is already posted to PR #${f.pr}${f.posted.url ? ` (${f.posted.url})` : ""}. Revising it here would diverge from what the submitter can see — reply on the pull request instead, or pass allowPostEdit to change the map anyway (which does NOT edit the posted comment).` };
  }
  const c = checkComment(input.comment);
  if ("error" in c) return c;
  const SEV = ["low", "medium", "high", "critical"];
  if (input.severity !== undefined && !SEV.includes(input.severity)) {
    return { error: `unknown severity "${input.severity}" — expected one of ${SEV.join(", ")}` };
  }
  const actor = requireActor(root);
  if ("error" in actor) return actor;

  const next: Record<string, unknown> = {
    ...(input.text !== undefined ? { text: input.text.trim() } : {}),
    ...(c.comment !== undefined ? { comment: c.comment } : {}),
    ...(input.severity !== undefined ? { severity: input.severity } : {}),
    ...(input.category !== undefined ? { category: input.category.trim() } : {}),
    ...(Number.isFinite(input.line) ? { line: Math.floor(input.line as number) } : {}),
  };
  const row = f as unknown as Record<string, unknown>;
  const was: Record<string, unknown> = {};
  const changed: string[] = [];
  for (const k of REVISABLE) {
    if (!(k in next) || next[k] === row[k]) continue;
    was[k] = row[k];
    row[k] = next[k];
    changed.push(k);
  }
  // Re-witnessing is how a finding blocked as written-against-a-different-body gets
  // cleared, so it has to work on the store the finding is actually in — dropping it
  // silently here would leave the only route past that gate looking like it ran.
  if (input.ref !== undefined && f.target.kind === "anchor") {
    const w = await witnessAt(root, f.target.id, input.ref || undefined);
    if (!w.witness) return { error: `could not read ${f.target.id} at ${input.ref || "@work"} — nothing to witness against` };
    if (w.witness.bodyHash !== f.witness?.bodyHash) {
      was.witness = f.witness; was.sourceRef = f.sourceRef;
      changed.push("witness");
    }
    f.witness = w.witness;
    f.sourceRef = w.sourceRef;
  }
  const notes: string[] = [];
  const at = new Date().toISOString();
  if (input.disposition !== undefined) {
    if (!checkDisposition(input.disposition)) {
      return { error: `unknown disposition "${input.disposition}" — expected one of ${DISPOSITIONS.join(", ")}` };
    }
    const verdict = input.disposition === "refuted" ? "refute" as const
      : input.disposition === "confirmed" ? "confirm" as const : null;
    const rationale = (input.text ?? input.comment ?? "").trim();
    if (verdict && rationale) {
      // One entry per reviewer, replacing this actor's own earlier opinion and nobody
      // else's — the same rule the shared fold applies, so the two halves of one verb
      // record a verdict identically.
      f.corroboration = [
        ...f.corroboration.filter((c) => c.actor.principal !== actor.principal),
        { actor, verdict, at, rationale, independent: false },
      ];
      changed.push("disposition");
    } else if (verdict) {
      notes.push(`disposition "${input.disposition}" NOT recorded — a verdict needs a rationale; pass \`text\``);
    } else {
      notes.push(`disposition "${input.disposition}" NOT recorded — a finding carries verdicts, not dispositions; confirmed and refuted are the two that map`);
    }
  }
  if (!changed.length) {
    return {
      ok: true, id: f.id, pr: f.pr, shared: false, changed,
      note: notes.length ? notes.join("; ") : "nothing to change — every field you passed already held that value",
    };
  }
  f.revisions = [...f.revisions, { at, by: actor, was }];
  await writeLocalFinding(root, f, f.pr!);
  return { ok: true, id: f.id, pr: f.pr, shared: false, changed, ...(notes.length ? { note: notes.join("; ") } : {}) };
}

/**
 * Record what happened about a LOCAL finding. The row half of `finding.remediated`, here
 * for the layering reason `closeLocalFinding` gives; `ops.ts` picks between them.
 */
export async function remediateLocalFinding(
  root: string, id: string, state: Remediation, opts: { detail?: string; ref?: string } = {},
) {
  const f = await readFinding(root, id).catch(() => null);
  if (!f) return { error: `no finding "${id}"` };
  const actor = requireActor(root);
  if ("error" in actor) return actor;
  f.remediation = {
    state, by: actor, at: new Date().toISOString(),
    ...(opts.detail ? { detail: opts.detail } : {}),
    ...(opts.ref ? { ref: opts.ref } : {}),
  };
  await writeLocalFinding(root, f, f.pr!);
  return { ok: true, id: f.id, pr: f.pr, shared: false, remediation: state };
}

/**
 * The lifecycle acts, on a LOCAL canonical finding.
 *
 * `shared_findings` lists this store's own rows beside the team's — one canonical table,
 * and a store that never joined a team still has findings — but every write behind that
 * page went straight to the log, which has never heard of a local row. So `resolve` on
 * one answered `no finding finding_… on pr <scope>`: a real id, a real row, and an error
 * naming the one place it could not be.
 *
 * These are the row halves. They live here for the layering reason `closeLocalFinding`
 * gives, and `ops.ts` picks between them and the event ones.
 *
 * The RATCHET applies identically. `mayTransition` is the same function the fold uses,
 * so a local finding somebody has confirmed is no more closeable by an agent than a
 * shared one — the gate is about who stood behind the claim, not about where the row
 * happens to live.
 */
async function localFindingWrite<T>(
  root: string, id: string, fn: (f: SharedFinding, actor: Actor, at: string) => T | { error: string },
): Promise<Record<string, unknown>> {
  const f = await readFinding(root, id).catch(() => null);
  if (!f) return { error: `no finding "${id}"` };
  const actor = requireActor(root);
  if ("error" in actor) return actor;
  const r = fn(f, actor, new Date().toISOString());
  if (r && typeof r === "object" && "error" in r) return r as { error: string };
  await writeLocalFinding(root, f, f.pr!);
  return { ok: true, id: f.id, pr: f.pr, shared: false, ...(r as object ?? {}) };
}

export const setLocalFindingState = (root: string, id: string, state: FindingState, reason?: string) =>
  localFindingWrite(root, id, (f, actor, at) => {
    if (!mayTransition(f, actor, state)) {
      return {
        error: needsHumanAck(f)
          ? `${id} needs a person: it is promoted or somebody has confirmed it, so an agent may only request \`${state}\`, not do it`
          : `an agent may not move ${id} from ${f.state} to ${state} — request it instead`,
      };
    }
    f.state = state;
    f.closed = isClosed(state) ? { at, by: actor, reason: reason ?? state } : undefined;
    // An ask is answered by the act it asked for.
    f.pending = undefined;
    return { state };
  });

export const corroborateLocalFinding = (root: string, id: string, verdict: Verdict, rationale: string) =>
  localFindingWrite(root, id, (f, actor, at) => {
    if (!rationale.trim()) return { error: "a verdict without a rationale is a vote, not a review — say what you checked" };
    // One entry per REVIEWER, replacing that reviewer's own earlier opinion and nobody
    // else's — `reviewerKey`, the same rule the fold applies, so the two halves of one
    // verb cannot disagree about who has spoken.
    const i = f.corroboration.findIndex((c) => reviewerKey(c.actor) === reviewerKey(actor));
    const entry = { actor, verdict, at, rationale, independent: isIndependent(actor, f.author) };
    if (i >= 0) f.corroboration[i] = entry; else f.corroboration.push(entry);
    return { verdict };
  });

export const promoteLocalFinding = (root: string, id: string) =>
  localFindingWrite(root, id, (f, actor, at) => {
    // A latch: surfacing something twice is not a state change.
    if (!f.promotion) f.promotion = { at, by: actor };
    return { note: "surfaced for team-wide attention; it does not gate anyone's triage" };
  });

export const requestOnLocalFinding = (root: string, id: string, ask: Ask, rationale: string) =>
  localFindingWrite(root, id, (f, actor, at) => {
    if (!rationale.trim()) return { error: `asking to ${ask} without saying why leaves the human nothing to act on` };
    // One outstanding ask; a second replaces it.
    f.pending = { ask, by: actor, at, rationale };
    return { ask, note: "queued for a person to acknowledge" };
  });

export async function closeAssignment(
  root: string,
  input: {
    id: string; result: "fixed" | "answered" | "declined"; detail: string; files?: string[]; by?: string;
    /** The submitter-facing version of what was found, if this is going to the PR. */
    comment?: string;
    /**
     * Where in the file this actually points. An agent that has just read the code
     * knows the line; until it could say so, the publisher fell back to the enclosing
     * symbol's first changed line and put comments on the wrong member.
     */
    line?: number;
    /**
     * What the investigation concluded. Deliberately NOT folded into `result`:
     * `result` is what the AGENT DID (fixed it, looked into it, declined), and
     * `disposition` is what turned out to be TRUE of the finding. A false positive
     * is `answered` + `refuted` — the agent did answer, and the answer was "not a
     * defect". Collapsing the two would make `result` mean two things at once.
     */
    disposition?: Disposition;
    /**
     * A re-rate the investigation reached. Same reason `disposition` is here: a
     * severity stated only in `detail` leaves the record reading what it was filed
     * as, so anybody filtering by severity acts on the number nobody now believes.
     */
    severity?: BugSeverity;
  },
) {
  const store = await readAnnotations(root);
  const ann = store.annotations.find((a) => a.id === input.id);
  // A non-annotation id is a canonical finding, and `ops.closeFinding` routes those —
  // this function is the annotation half, and the last branch it tries, so the message
  // names every namespace an id can come from rather than only this one.
  if (!ann) return { error: `no finding or annotation "${input.id}" — ids come from \`findings\`, \`shared_findings\` or \`review_queue\`` };
  if (!ann.assignment) return { error: "that annotation was not assigned to an agent" };
  // `assignAnnotation` refuses a resolved annotation for the same reason: an agent
  // holding a queue read from before the human closed this would otherwise stamp an
  // outcome over the record of what happened at close time — and `reviewQueue`
  // filters resolved items out, so the write would be invisible afterwards.
  if (ann.resolved) return { error: "that finding was resolved while you were working on it — reopen it before recording an outcome" };
  const files = input.files ?? [];
  if (input.result === "fixed" && files.length > 1) {
    return { error: `a fix may touch one file; this touched ${files.length} (${files.join(", ")}). Report \`declined\` with what the change needs — a multi-file change belongs to an agent the human dispatches, not to a review-tool edit.` };
  }
  const c = checkComment(input.comment, input.disposition ?? ann.disposition);
  if ("error" in c) return c;
  const disposition = input.disposition === undefined ? undefined : checkDisposition(input.disposition);
  if (input.disposition !== undefined && !disposition) {
    return { error: `unknown disposition "${input.disposition}" — expected one of ${DISPOSITIONS.join(", ")}` };
  }

  // Reporting back is a revision of the finding, so it leaves the same trail: what
  // it said before the investigation is exactly what a reader wants when the
  // investigation changed the answer.
  const SEV = ["low", "medium", "high", "critical"];
  if (input.severity !== undefined && !SEV.includes(input.severity)) {
    return { error: `unknown severity "${input.severity}" — expected one of ${SEV.join(", ")}` };
  }
  const line = Number.isFinite(input.line) && (input.line as number) > 0 ? Math.floor(input.line as number) : undefined;
  if (c.comment || disposition || line !== undefined || input.severity !== undefined) {
    const was: NonNullable<Annotation["revisions"]>[number]["was"] = {};
    if (c.comment && c.comment !== ann.comment) { was.comment = ann.comment; ann.comment = c.comment; }
    if (disposition && disposition !== ann.disposition) { was.disposition = ann.disposition; ann.disposition = disposition; }
    if (line !== undefined && line !== ann.line) { was.line = ann.line; ann.line = line; }
    if (input.severity !== undefined && input.severity !== ann.severity) { was.severity = ann.severity; ann.severity = input.severity; }
    if (Object.keys(was).length) (ann.revisions ??= []).push({ at: new Date().toISOString(), by: input.by || "agent", was });
  }
  ann.outcome = { at: new Date().toISOString(), by: input.by || "agent", result: input.result, detail: input.detail, files: files.length ? files : undefined };
  await writeAnnotations(root, store.annotations);
  return { ok: true, id: ann.id, result: input.result, disposition: ann.disposition, awaitingHuman: true, target: ann.target };
}

/**
 * Open questions a human left for the agent during review — the "answer these to
 * improve the docs" queue. Each is resolved to its target's title/symbol + a link.
 */
export async function listQuestions(root: string, opts: { includeResolved?: boolean } = {}) {
  const [annStore, nodes, store] = await Promise.all([readAnnotations(root), loadNodesShared(root), readAnchorStore(root)]);
  const nodeById = new Map(nodes.map((n) => [n.id, n]));
  const anchorById = new Map(store.anchors.map((a) => [a.id, a]));
  const qs = annStore.annotations.filter((a) => a.kind === "question" && (opts.includeResolved || !a.resolved));
  return {
    total: qs.length,
    open: qs.filter((q) => !q.resolved).length,
    questions: qs.map((q) => {
      const t = q.target.kind === "node" ? nodeById.get(q.target.id) : anchorById.get(q.target.id);
      const label = q.target.kind === "node"
        ? (t as LogicalNode | undefined)?.title ?? q.target.id
        : (t as Anchor | undefined)?.symbolPath.join(" › ") ?? q.target.id;
      return { id: q.id, text: q.text, author: q.author, resolved: !!q.resolved, target: q.target, targetLabel: label };
    }),
  };
}

