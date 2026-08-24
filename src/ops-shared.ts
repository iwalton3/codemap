/**
 * The shared-review operations, protocol-free — what the CLI, MCP and HTTP all
 * call. Same rule as `ops.ts`: the logic lives here, the front-ends are thin.
 *
 * Everything degrades to a clear message when no sidecar is configured, because
 * that is the state every existing store is in and none of them should start
 * failing. A sidecar is additive.
 */

import type { Actor } from "./schema.js";
import { requireActor, isAgentActor } from "./identity.js";
import { comparableHashes, sameBody } from "./normalize.js";
import { realpathSync } from "node:fs";
import { classifyCitations } from "./citation-state.js";
import { evalVersion } from "./doc-version.js";
import { readCached, ensureMaterialized, type Projection } from "./materialize.js";
import type { ScopeStatus, ScopeDiagnostic, LogEvent } from "./eventlog.js";
import { scopesOnDisk, readScopeChecked, writerFor, rotateWriter, acknowledgeScope } from "./eventlog.js";
import { findingsProjection, docsProjection, notesProjection, walkthroughsProjection, docsByNode, projectionFor } from "./shared-projections.js";
import { anchorIndex, derivationsOf, type AnchorIndex, resolveAnchor} from "./anchor-resolve.js";
import { resolveSidecar, scopeFor, type SidecarConfig } from "./sidecar-config.js";
import { originSlug, headCommit, currentBranch } from "./git.js";
import { fetchReviewThreads, type GhRunner } from "./pr-push.js";
import { ensureSidecar, sync as sidecarSync, healMerge, readManifests, checkPeers, currentManifest } from "./sidecar.js";
import {
  createFinding, corroborate, comment, promote, request, setState, recordOutcome,
  markPosted, markUpstreamed, promoteToBug, needsHumanAck, ackQueue,
  revise, resolveContest, relocate,
  foldFindings, findingScope,
  type SharedFinding, type Verdict, type Ask, type FindingState, type NewFinding,
} from "./shared-findings.js";
import { publishWalkthrough, currentWalkthrough, staleWalkthroughs, foldWalkthroughs, walkthroughScope } from "./shared-walkthrough.js";
import {
  createNote, answerNote, resolveNote, allNotes, foldNotes, noteScope, bucketFor,
  type NewNote,
} from "./shared-notes.js";
import { readAnnotations, readAnchorStore, loadNodes, loadNodeVersions, derivationLookup, workIndexFor} from "./store.js";
import {
  publishDocVersion, acceptDocHash, resolveDoc, foldDocs, docScope,
  type NewDocVersion,
} from "./shared-docs.js";
import type { PrWalkthrough } from "./walkthrough.js";

const NO_SIDECAR =
  "no sidecar configured for this universe. Point one at a shared repo with "
  + "CODEMAP_SIDECAR=/path/to/sidecar, or write that path into .codemap/sidecar. "
  + "Everything else works without one.";

interface Bound { cfg: SidecarConfig; actor: Actor }

/** Resolve the sidecar and the actor together — both are needed for every write. */
function bind(root: string): Bound | { error: string } {
  const cfg = resolveSidecar(root);
  if (!cfg) return { error: NO_SIDECAR };
  const actor = requireActor(root);
  if ("error" in actor) return actor;
  return { cfg, actor };
}

/** `acme/api/pr-264` — the universe-qualified key every scope is built from. */
const prKey = (cfg: SidecarConfig, pr: number | string) => scopeFor(cfg, "pr", pr);


/** Is this scope part of the universe we are syncing? One sidecar can carry several. */
function inUniverse(scope: string, universe: string): boolean {
  const rest = scope.slice(scope.indexOf("/") + 1);
  return rest === universe || rest.startsWith(universe + "/");
}

export interface Materialized {
  /** Scopes considered — the whole universe, not just the ones that moved. */
  scanned: number;
  /** Scopes whose rows this sync had to rebuild. */
  folded: number;
  /** Scopes that cannot answer authoritatively, with why. */
  blocked: { scope: string; reason: string }[];
}

/**
 * Fold every scope this pull moved, so ordinary queries never have to.
 *
 * This is what makes "the log is pull/push, never read on a query" true rather than
 * aspirational. Without it the projection is filled in lazily by whoever happens to
 * query first, so completeness is a property each query earns instead of one the
 * store has — and a cross-scope query returns only the warmed scopes while looking
 * total.
 *
 * Unchanged scopes cost a fingerprint of their shard directory and nothing else, so
 * scanning all of them is how the changed ones are found; there is no separate
 * change-scan to keep in step with the fold.
 *
 * Never throws. A sync that has already moved bytes must not fail because one scope
 * would not fold — the log still holds everything, and the next sync tries again.
 */
async function materializeUniverse(root: string, cfg: SidecarConfig): Promise<Materialized> {
  const identity = sidecarIdentity(cfg);
  const out: Materialized = { scanned: 0, folded: 0, blocked: [] };
  for (const scope of await scopesOnDisk(cfg.path)) {
    const which = projectionFor(scope);
    if (!which || !inUniverse(scope, cfg.universe)) continue;
    out.scanned++;
    try {
      const { fresh, folded, status, diagnostic } = await ensureMaterialized(root, cfg.path, scope, identity, which.fold, which.proj);
      if (folded) out.folded++;
      // `fresh: false` means the rows are BEHIND the log — the fold kept losing a
      // race with an append. Worth saying out loud here for the same reason a
      // blocked scope is: this is the one moment a person is watching.
      if (!fresh) out.blocked.push({ scope, reason: "rows are behind the log; the next sync will retry" });
      else if (status !== "complete") out.blocked.push({ scope, reason: diagnostic?.detail ?? status });
    } catch (e: any) {
      out.blocked.push({ scope, reason: `could not fold: ${e?.message ?? e}` });
    }
  }
  return out;
}

/** Send and receive. The whole point of the button. */
export async function sharedSync(root: string) {
  const b = bind(root);
  if ("error" in b) return b;
  const r = await sidecarSync(b.cfg.path, b.actor, `codemap: ${b.cfg.universe}`);
  if ("error" in r) return r;
  // AFTER the transport, and only here: `sidecar.ts` is transport and knows nothing
  // about folds or entity kinds. Sync is also the one moment a person is watching,
  // which is why the blocked scopes are reported rather than discovered later.
  const materialized = await materializeUniverse(root, b.cfg);
  return { ok: true, universe: b.cfg.universe, sidecar: b.cfg.path, ...r, materialized };
}

export interface HealResult {
  ok: true;
  universe: string;
  sidecar: string;
  /** Shards whose two sides were unioned back together. */
  resolved: { path: string; events: number }[];
  /** The new writer id, when this clone was the one holding a forked one. */
  rotated?: string;
  /** Scopes whose blocking evidence this person has now acknowledged. */
  acknowledged: { scope: string; reason: string }[];
  /** Scopes still blocked, and why — evidence heal cannot clear on its own. */
  blocked: { scope: string; reason: string }[];
}

/**
 * Repair a forked sidecar: union the divided shard, stop the fork growing, and record
 * that a person has seen the evidence.
 *
 * **A person, never an agent.** Same rule as `retireSharedDoc`: acknowledging is
 * saying "I have looked at this disagreement and it is understood", which is not an
 * agent's to say. With no server and no auth the gate is cooperative — see
 * `acknowledged` in `eventlog.ts`.
 *
 * **Three separately-locked steps, not one.** The sidecar lock is not reentrant, and
 * `emitEvent` and `sync` each take it — so a heal that held the lock across the whole
 * sequence would deadlock against itself for the full timeout. Sequencing is safe
 * where nesting is not: each step is individually consistent, and if another sync
 * interleaves, the acknowledgment is keyed on evidence, so anything new simply blocks
 * again.
 *
 * Rotation is what actually stops the fork; acknowledgment only silences the warning.
 * They are one command because doing either alone is a trap — acknowledging without
 * rotating leaves the fork growing under a scope that now reports itself healthy.
 */
export async function sharedHeal(root: string): Promise<HealResult | { error: string }> {
  const b = bind(root);
  if ("error" in b) return b;
  if (isAgentActor(b.actor)) {
    return { error: "an agent may not acknowledge a fork. A fork means two people's clones "
      + "disagree about one writer's history, and saying that is understood is a person's call. "
      + "Ask them to run `codemap sidecar heal`." };
  }

  // 1. Union the divided shard. Its own merge — `pull` aborts and destroys the stages.
  const merged = await healMerge(b.cfg.path, b.actor);
  if ("error" in merged) return merged;

  // 2. Stop it growing. Only when THIS clone holds the forked id: if the fork is
  //    somebody else's, rotating here changes nothing and loses our own chain.
  const mine = await writerFor(b.cfg.path);
  let rotated: string | undefined;

  const acknowledged: { scope: string; reason: string }[] = [];
  const blocked: { scope: string; reason: string }[] = [];

  for (const scope of await scopesOnDisk(b.cfg.path)) {
    if (!inUniverse(scope, b.cfg.universe)) continue;
    const checked = await readScopeChecked(b.cfg.path, scope);
    if (checked.status === "complete") continue;
    const d = checked.diagnostic;
    if (!d) { blocked.push({ scope, reason: checked.status }); continue; }
    // A newer protocol is never acknowledgeable: clearing it would be agreeing to
    // read data this build cannot interpret. It resolves by upgrading.
    if (d.reason === "protocol") { blocked.push({ scope, reason: d.detail }); continue; }

    if (!rotated && d.reason === "fork" && checked.events.some((e) => e.writer === mine)) {
      rotated = await rotateWriter(b.cfg.path);
    }
    // 3. Record that a person has seen exactly THIS evidence. A later fork digests
    //    differently and blocks again, which is what makes acknowledging safe.
    await acknowledgeScope(b.cfg.path, scope, b.actor, d);
    acknowledged.push({ scope, reason: d.reason });
  }

  const synced = await sidecarSync(b.cfg.path, b.actor, `codemap: heal ${b.cfg.universe}`);
  if ("error" in synced) return synced;
  return {
    ok: true, universe: b.cfg.universe, sidecar: b.cfg.path,
    resolved: merged.resolved, ...(rotated ? { rotated } : {}), acknowledged, blocked,
  };
}

/** Who else is on this sidecar, and whether their codemap agrees with ours. */
export async function sharedStatus(root: string) {
  const cfg = resolveSidecar(root);
  if (!cfg) return { error: NO_SIDECAR };
  const actor = requireActor(root);
  const mine = currentManifest("error" in actor ? "" : actor.principal);
  const peers = await readManifests(cfg.path);
  const incompat = checkPeers(peers, mine);
  return {
    universe: cfg.universe,
    sidecar: cfg.path,
    you: "error" in actor ? null : actor.principal,
    peers: peers.map((p) => ({ principal: p.principal, anchorScheme: p.anchorScheme, hashScheme: p.hashScheme })),
    ...(incompat ? { [incompat.fatal ? "blocked" : "warning"]: incompat.message } : {}),
  };
}

export async function shareFinding(root: string, pr: number | string, f: NewFinding) {
  const b = bind(root);
  if ("error" in b) return b;
  await ensureSidecar(b.cfg.path, b.actor);
  const id = await createFinding(b.cfg.path, prKey(b.cfg, pr), b.actor, f);
  return { ok: true, id, note: "recorded locally — run `codemap sync` to send it" };
}

export async function corroborateFinding(root: string, pr: number | string, id: string, verdict: Verdict, rationale: string) {
  const b = bind(root);
  if ("error" in b) return b;
  if (!rationale.trim()) return { error: "a verdict without a rationale is a vote, not a review — say what you checked" };
  await corroborate(b.cfg.path, prKey(b.cfg, pr), b.actor, id, verdict, rationale);
  return { ok: true, id, verdict };
}

export async function commentOnFinding(root: string, pr: number | string, id: string, body: string, inReplyTo?: string) {
  const b = bind(root);
  if ("error" in b) return b;
  if (!body.trim()) return { error: "an empty comment says nothing" };
  const e = await comment(b.cfg.path, prKey(b.cfg, pr), b.actor, id, body, inReplyTo);
  return { ok: true, id: e.id };
}

export async function promoteFinding(root: string, pr: number | string, id: string) {
  const b = bind(root);
  if ("error" in b) return b;
  await promote(b.cfg.path, prKey(b.cfg, pr), b.actor, id);
  return { ok: true, id, note: "surfaced for team-wide attention; it does not gate anyone's triage" };
}

export async function requestOnFinding(root: string, pr: number | string, id: string, ask: Ask, rationale: string) {
  const b = bind(root);
  if ("error" in b) return b;
  if (!rationale.trim()) return { error: `asking to ${ask} without saying why leaves the human nothing to act on` };
  await request(b.cfg.path, prKey(b.cfg, pr), b.actor, id, ask, rationale);
  return { ok: true, id, ask, note: "queued for a person to acknowledge" };
}

export async function closeFinding(root: string, pr: number | string, id: string, state: FindingState, reason?: string) {
  const b = bind(root);
  if ("error" in b) return b;
  const r = await setState(b.cfg.path, prKey(b.cfg, pr), b.actor, id, state, reason);
  return "error" in r ? r : { ok: true, id, state };
}

export async function reportOnFinding(root: string, pr: number | string, id: string, result: "fixed" | "answered" | "declined", detail: string, files?: string[]) {
  const b = bind(root);
  if ("error" in b) return b;
  await recordOutcome(b.cfg.path, prKey(b.cfg, pr), b.actor, id, result, detail, files);
  return { ok: true, id, result, note: "reported — a person still has to close it" };
}

export async function upstreamFinding(root: string, pr: number | string, id: string, ref: { system?: string; key?: string; url?: string }) {
  const b = bind(root);
  if ("error" in b) return b;
  await markUpstreamed(b.cfg.path, prKey(b.cfg, pr), b.actor, id, ref);
  return { ok: true, id, note: "tracked upstream; still open here until the code says otherwise" };
}

export async function findingToBug(root: string, pr: number | string, id: string, bug: string) {
  const b = bind(root);
  if ("error" in b) return b;
  await promoteToBug(b.cfg.path, prKey(b.cfg, pr), b.actor, id, bug);
  return { ok: true, id, bug };
}

export async function recordPublished(root: string, pr: number | string, id: string, ref: { key?: string; url?: string }) {
  const b = bind(root);
  if ("error" in b) return b;
  await markPosted(b.cfg.path, prKey(b.cfg, pr), b.actor, id, ref);
  return { ok: true, id };
}

/** A finding, flattened for a front-end: derived fields resolved, actors named. */
function view(f: SharedFinding) {
  const confirms = f.corroboration.filter((c) => c.verdict === "confirm");
  return {
    id: f.id,
    state: f.state,
    target: f.target,
    text: f.text,
    comment: f.comment,
    severity: f.severity,
    category: f.category,
    author: f.author.principal,
    authorModel: f.author.via?.model,
    createdAt: f.createdAt,
    needsAck: needsHumanAck(f),
    promoted: !!f.promotion,
    posted: f.posted?.url,
    upstream: f.upstream?.key,
    bug: f.bug,
    // Independent confirmations are the number worth ranking by: agreement from
    // the author's own agent is not a second opinion.
    confirms: confirms.length,
    independentConfirms: confirms.filter((c) => c.independent).length,
    refutes: f.corroboration.filter((c) => c.verdict === "refute").length,
    corroboration: f.corroboration.map((c) => ({ by: c.actor.principal, model: c.actor.via?.model, verdict: c.verdict, rationale: c.rationale, independent: c.independent })),
    thread: f.thread.map((c) => ({ id: c.id, by: c.actor.principal, model: c.actor.via?.model, at: c.at, body: c.body, inReplyTo: c.inReplyTo })),
    pending: f.pending ? { ask: f.pending.ask, by: f.pending.by.principal, rationale: f.pending.rationale } : undefined,
    outcome: f.outcome ? { result: f.outcome.result, detail: f.outcome.detail, by: f.outcome.by.principal, files: f.outcome.files } : undefined,
    closed: f.closed ? { by: f.closed.by.principal, reason: f.closed.reason } : undefined,
    contested: f.contested?.map((c) => ({ field: c.field, held: c.held, incoming: c.incoming })),
    relocation: f.relocation
      ? { kind: f.relocation.kind, to: f.relocation.to, by: f.relocation.by.principal, model: f.relocation.by.via?.model, rationale: f.relocation.rationale, applied: !!f.relocation.applied }
      : undefined,
  };
}

/**
 * Record where a finding's target went.
 *
 * Without `apply` this is a proposal and lands in the ack queue; an agent may only
 * propose. Re-pointing a finding at the wrong symbol is the false-provenance
 * failure `witness`/`sourceRef` exist to prevent, so applying one is a person's act.
 */
export async function relocateFinding(
  root: string, pr: number | string, id: string,
  kind: "moved" | "gone", rationale: string, opts: { to?: string; apply?: boolean } = {},
) {
  const b = bind(root);
  if ("error" in b) return b;
  if (!rationale.trim()) return { error: `saying a target ${kind === "moved" ? "moved" : "is gone"} without saying why leaves nothing to check` };
  if (kind === "moved" && !opts.to?.trim()) return { error: "say WHICH anchor it moved to — \"it moved\" is not actionable" };
  if (opts.apply && isAgentActor(b.actor)) {
    return { error: "an agent may propose a relocation, not apply one — a mis-targeted finding is worse than an untriaged one" };
  }
  // An applied relocation is the ONE place a foreign anchor id gets written INTO
  // shared state: `f.target.id` becomes whatever the proposer's machine minted, and
  // ids are derived from the parse, so their `a_X` and ours can name different
  // symbols. Everything else in this design reads such an id and says "cannot tell";
  // here that is not enough, because the write outlives the reader. So the applier
  // checks it against their own index before it becomes the target.
  // See docs/anchor-id-provenance.md §4.
  // ANCHOR targets only. A finding may target a node (`{kind: "node"}`), whose ids
  // are minted locally and are not derived from the parse at all — gating those on
  // the anchor index would refuse a legitimate node-to-node relocation, with a
  // message about anchors that would not even be true.
  const targetKind = opts.apply && kind === "moved" && opts.to
    ? (await cachedFindings(root, b.cfg, pr)).value.get(id)?.target.kind
    : undefined;
  if (targetKind === "anchor" && opts.to) {
    // ONE id, one indexed lookup. This read the entire anchor store to answer a
    // membership question — the shape that produced the last performance cliff.
    const here = await liveHashes(root, [opts.to]);
    if (!here.has(opts.to)) {
      return {
        error: `${opts.to.slice(0, 12)} is not an anchor in this checkout, so applying it would point the finding at nothing. `
          + `Either the symbol is on another branch — index it and try again — or the proposal came from a build whose anchor ids are derived differently, `
          + `in which case re-target it by symbol here rather than by their id.`,
      };
    }
  }
  await relocate(b.cfg.path, prKey(b.cfg, pr), b.actor, id, kind, rationale, opts);
  return { ok: true, id, kind, ...(opts.apply ? { applied: true } : { note: "queued for a person to apply" }) };
}

export async function reviseFinding(root: string, pr: number | string, id: string, now: Record<string, unknown>) {
  const b = bind(root);
  if ("error" in b) return b;
  await revise(b.cfg.path, prKey(b.cfg, pr), b.actor, id, now);
  return { ok: true, id };
}

/** Settle a field two people set differently without seeing each other. */
export async function settleContest(root: string, pr: number | string, id: string, field: string, value: unknown) {
  const b = bind(root);
  if ("error" in b) return b;
  const r = await resolveContest(b.cfg.path, prKey(b.cfg, pr), b.actor, id, field, value);
  return "error" in r ? r : { ok: true, id, field };
}

/**
 * A PR's findings, through the materialized cache.
 *
 * The sidecar's log stays authoritative; this is the projection of it. Reads that
 * miss re-fold and store; reads that hit answer from rows. The sidecar PATH is the
 * identity half of the cache key, so pointing a universe at a different sidecar
 * cannot reuse rows folded from the first one.
 *
 * Write paths inside `shared-findings.ts` still fold the log directly, and should:
 * they need the freshest state at the moment they append, not a projection of it.
 */
/**
 * The identity half of the cache key: the sidecar as the filesystem resolves it.
 *
 * `resolveSidecar` normalizes and absolutizes but does not follow symlinks, so a
 * stable pointer retargeted at a different sidecar keeps one lexical path — and
 * with matching shard stats the first sidecar's rows would be served for the
 * second's log indefinitely. `realpath` is what makes "cannot reuse rows" true.
 */
const sidecarIdentity = (cfg: { path: string }): string => {
  try { return realpathSync(cfg.path); } catch { return cfg.path; }   // not created yet
};

/**
 * What a surface says about the scope it just answered from.
 *
 * Present only when the answer is NOT authoritative, so an ordinary read keeps the
 * shape it had — a `scope: {status: "complete"}` on every response for every team
 * is noise, and noise is what a warning has to outrank. A blocked scope still
 * returns its rows: see `readScopeChecked` and PROPOSAL-provenance.md §7.
 */
const nonAuthoritative = (s: ScopeStatus): { status: "blocked"; diagnostic?: ScopeDiagnostic } | undefined =>
  s.status === "blocked" ? { status: "blocked", diagnostic: s.diagnostic } : undefined;

const cachedFindings = (root: string, cfg: { path: string; universe: string }, pr: number | string) =>
  readCached(root, cfg.path, findingScope(prKey(cfg, pr)), sidecarIdentity(cfg), foldFindings, findingsProjection);

/** A universe's shared docs, through the cache. Same shape as findings above. */
const cachedDocs = (root: string, cfg: { path: string; universe: string }) =>
  readCached(root, cfg.path, docScope(cfg.universe), sidecarIdentity(cfg), foldDocs, docsProjection);

/**
 * One target's notes, through the cache.
 *
 * Notes shard by target into 256 buckets, so this folds ONE bucket and filters —
 * which is what `notesForTarget` does, with the fold now cached per bucket.
 */
const cachedNotes = async (root: string, cfg: { path: string; universe: string }, targetId: string) => {
  const { value, ...status } = await readCached(root, cfg.path, noteScope(cfg.universe, bucketFor(targetId)), sidecarIdentity(cfg), foldNotes, notesProjection);
  return { notes: [...value.values()].filter((n) => n.target.id === targetId), ...status };
};

export async function sharedFindings(root: string, pr: number | string, opts: { queue?: boolean } = {}) {
  const cfg = resolveSidecar(root);
  if (!cfg) return { error: NO_SIDECAR };
  const { value: folded, ...scope } = await cachedFindings(root, cfg, pr);
  const all = [...folded.values()];
  const places = await classifyCitations(root, [...new Set(all.filter((f) => f.target.kind === "anchor").map((f) => f.target.id))]);
  const chosen = opts.queue ? ackQueue(all) : all;
  const place = (f: SharedFinding) => places.get(f.target.id) ?? { state: "unknown" as const };
  return {
    scope: nonAuthoritative(scope),
    universe: cfg.universe,
    pr,
    total: all.length,
    waitingOnYou: ackQueue(all).length,
    contested: all.filter((f) => f.contested?.length).length,
    findings: chosen.map((f) => ({ ...view(f), target: { ...f.target, where: place(f).state, at: place(f).at, lastFile: place(f).file } })),
  };
}

/**
 * The submitter's replies to findings this team published — inbound only.
 *
 * The direction is the design. The sidecar hosts the REVIEWERS' discussion,
 * because GitHub cannot host a conversation about code the branch never touched
 * or about an ABSENCE, which has no line anywhere. But the person who has to fix
 * it answers on the pull request, and that answer is information the reviewer
 * needs — so it is read back, attributed to the GitHub account that wrote it, and
 * never written to.
 *
 * Not folded into the thread: a reply is somebody else's utterance on another
 * system, and recording it as a sidecar event would make it look like it had been
 * said here, by an actor with a principal. It is presented alongside instead.
 */
export async function inboundReplies(root: string, pr: number | string, opts: { gh?: GhRunner } = {}) {
  const cfg = resolveSidecar(root);
  if (!cfg) return { error: NO_SIDECAR };
  const slug = originSlug(root);
  if (!slug) return { error: "no GitHub remote on this universe, so there is no pull request to read replies from" };

  const all = [...(await cachedFindings(root, cfg, pr)).value.values()];
  const published = all.filter((f) => f.posted?.key);
  if (!published.length) return { universe: cfg.universe, pr, findings: [], note: "nothing from here has been published to the pull request" };

  const threads = fetchReviewThreads(`${slug.owner}/${slug.repo}`, Number(pr), opts.gh);
  if ("error" in threads) return threads;

  // Ours is the ROOT comment of its thread; everything after it is the reply.
  const byComment = new Map<number, typeof threads[number]>();
  for (const t of threads) for (const id of t.commentIds) byComment.set(id, t);

  const out = [];
  for (const f of published) {
    const t = byComment.get(Number(f.posted!.key));
    if (!t) continue;
    const replies = t.comments.filter((c) => c.databaseId !== Number(f.posted!.key));
    if (!replies.length && !t.isResolved) continue;
    out.push({
      id: f.id,
      comment: f.comment,
      url: f.posted!.url,
      resolvedOnGitHub: t.isResolved,
      resolvedBy: t.resolvedBy,
      truncated: t.truncated,
      replies: replies.map((c) => ({ by: c.author, at: c.createdAt, body: c.body })),
    });
  }
  return { universe: cfg.universe, pr, findings: out };
}

// ---------------------------------------------------------------------------
// Annotations — the codebase knowledge, not the pull-request findings
// ---------------------------------------------------------------------------

/**
 * Mirror a locally-written annotation onto the sidecar.
 *
 * Called from `ops.annotate` after the local write, and silently a no-op when no
 * sidecar is configured. Local FIRST and always: codemap worked without a sidecar
 * for its whole life, and a note must never be lost because a shared repo was
 * misconfigured. The sidecar is where the note goes to be useful to somebody else.
 */
export async function mirrorNote(root: string, n: NewNote): Promise<{ shared: boolean }> {
  const cfg = resolveSidecar(root);
  if (!cfg) return { shared: false };
  const actor = requireActor(root);
  if ("error" in actor) return { shared: false };
  await ensureSidecar(cfg.path, actor);
  await createNote(cfg.path, cfg.universe, actor, n);
  return { shared: true };
}

/** What the team knows about one symbol — everyone's notes, not just yours. */
export async function sharedNotes(root: string, targetId: string) {
  const cfg = resolveSidecar(root);
  if (!cfg) return { error: NO_SIDECAR };
  const { notes, ...scope } = await cachedNotes(root, cfg, targetId);
  return {
    scope: nonAuthoritative(scope),
    universe: cfg.universe,
    target: targetId,
    notes: notes.map((n) => ({
      id: n.id, kind: n.kind, text: n.text, severity: n.severity, category: n.category, line: n.line,
      by: n.author.principal, model: n.author.via?.model, at: n.createdAt,
      resolved: n.resolved ? { by: n.resolved.by.principal, reason: n.resolved.reason } : undefined,
      answers: n.answers.map((a) => ({ by: a.actor.principal, model: a.actor.via?.model, at: a.at, body: a.body })),
      // A disagreement nobody is shown is a disagreement nobody settles. Same
      // shape as a finding's, so a reader that renders one renders both.
      contested: n.contested?.map((c) => ({ field: c.field, held: c.held, incoming: c.incoming })),
    })),
  };
}

export async function answerSharedNote(root: string, targetId: string, id: string, body: string) {
  const b = bind(root);
  if ("error" in b) return b;
  if (!body.trim()) return { error: "an empty answer says nothing" };
  await answerNote(b.cfg.path, b.cfg.universe, targetId, b.actor, id, body);
  return { ok: true, id };
}

export async function resolveSharedNote(root: string, targetId: string, id: string, resolved: boolean, reason?: string) {
  const b = bind(root);
  if ("error" in b) return b;
  if (isAgentActor(b.actor) && resolved) {
    return { error: "an agent may answer a question, not declare it settled — reply instead and let a person close it" };
  }
  await resolveNote(b.cfg.path, b.cfg.universe, targetId, b.actor, id, resolved, reason);
  return { ok: true, id, resolved };
}

/**
 * Publish the annotations already in this universe's SQLite to the sidecar.
 *
 * The one-time step for a store that predates sharing. Idempotent by annotation
 * id: a note already on the sidecar is skipped, so running it twice — or after
 * somebody else has already published theirs — adds nothing.
 *
 * Attributed to whoever runs it, because the local `author` strings ("me",
 * "agent") cannot be resolved to a person. That is honest rather than accurate,
 * and it is the same reason legacy records were never back-filled.
 */
export async function publishLocalNotes(root: string, opts: { dryRun?: boolean } = {}) {
  const b = bind(root);
  if ("error" in b) return b;
  await ensureSidecar(b.cfg.path, b.actor);
  const local = (await readAnnotations(root)).annotations;
  const already = new Set((await allNotes(b.cfg.path, b.cfg.universe)).map((n) => n.id));
  const todo = local.filter((a) => !already.has(a.id));
  if (opts.dryRun) {
    return { universe: b.cfg.universe, local: local.length, alreadyShared: local.length - todo.length, wouldPublish: todo.length };
  }
  for (const a of todo) {
    await createNote(b.cfg.path, b.cfg.universe, b.actor, {
      id: a.id,
      targetKind: a.target.kind, targetId: a.target.id,
      kind: a.kind ?? "note", text: a.text,
      severity: a.severity, category: a.category, line: a.line,
    });
  }
  return {
    universe: b.cfg.universe, published: todo.length, alreadyShared: local.length - todo.length,
    note: todo.length ? "run `codemap sync` to send them" : "nothing new to publish",
  };
}

// ---------------------------------------------------------------------------
// Docs
// ---------------------------------------------------------------------------

/** Live body hashes for whatever this working tree currently has. */
/**
 * `@work` hashes for the ids a read actually cites.
 *
 * Was a Map over EVERY anchor in the universe, built to answer about a handful.
 * `workIndexFor` is the indexed lookup, and it takes the ref's derivations from a
 * DISTINCT over the whole ref rather than from the matched rows — see the note
 * there for why the difference matters.
 */
const liveHashes = async (root: string, ids: Iterable<string>): Promise<AnchorIndex> => workIndexFor(root, ids);

/**
 * The team's docs, each resolved against THIS checkout.
 *
 * Resolution is `winningVersionAt` — the version whose accepted hashes match the
 * code in front of you — so one linear sidecar serves every branch without branch
 * tags and without consulting git. A doc written on a feature branch and one
 * written on develop are both here, and each machine sees the one that describes
 * what it has checked out.
 */
export async function sharedDocs(root: string, opts: { nodeId?: string } = {}) {
  const cfg = resolveSidecar(root);
  if (!cfg) return { error: NO_SIDECAR };
  const { value: docs, ...scope } = await cachedDocs(root, cfg);
  // Classified once for every citation in the catalogue: the dry run had a
  // thousand of them, and per-citation lookups would be a query each.
  const cited = [...new Set([...docs.values()].flatMap((d) => d.versions.flatMap((v) => v.citations.map((c) => c.anchorId))))];
  const live = await liveHashes(root, cited);
  const places = await classifyCitations(root, cited);
  const rows = [];
  for (const doc of docs.values()) {
    if (opts.nodeId && doc.nodeId !== opts.nodeId) continue;
    const v = resolveDoc(doc, live);
    // ONE verdict, from the same function the local path uses. Three separate
    // re-derivations of it (web's `docFresh`, `needAttention` here, the CLI) had
    // already drifted: none of them could tell an id this build cannot derive from
    // a symbol that is gone, so this surface said `lost` where `evalVersion` said
    // `unverifiable` about one doc. See PROPOSAL-sidecar-materialization.md §7.4.
    const e = v ? evalVersion(v, live) : undefined;
    rows.push({
      nodeId: doc.nodeId,
      versions: doc.versions.length,
      // Acceptances that matched no citation — retained by the fold rather than
      // dropped. Surfaced as a count so the retention is not itself silent.
      unmatchedAcceptances: doc.unmatched?.length ?? 0,
      // `winningVersionAt` picks the LEAST-BAD version and always returns one when
      // versions exist — it never signals "none of these describe your checkout".
      // The per-citation `matches`/`present` below are what actually say whether
      // the winner is fresh here, so read those rather than the fact of a winner.
      resolved: v ? {
        versionId: v.versionId, type: v.type, title: v.title, summary: v.summary, body: v.body,
        removed: !!v.removed, generatedBy: v.generatedBy,
        by: doc.authors.get(v.versionId)?.principal,
        status: e!.status,
        citations: v.citations.map((c) => {
          const at = resolveAnchor(c.anchorId, c.acceptedHashes, live);
          const now = at.at === "found" ? at.hash : undefined;
          const present = now !== undefined;
          const matches = present && c.acceptedHashes.some((h) => sameBody(h, now!));
          // A citation confirmed under an older HASH_SCHEME cannot be compared to
          // this body at all, and calling that DRIFT is the false staleness the
          // scheme exists to prevent: a migration re-hashes everything, so every
          // doc in the store would read stale on the first reindex without anyone
          // touching the code. Found doing exactly that on a real repo — 985 of 985.
          //
          // The id-derivation cause joins it: an anchor id this build could not have
          // minted is equally "cannot be decided", and it arrives as an ABSENCE
          // rather than a mismatch, which is why it needs the resolution above and
          // not a hash comparison. See docs/anchor-id-provenance.md §6.
          const unverifiable = at.at === "incomparable"
            || (present && !matches && !c.acceptedHashes.some((h) => comparableHashes(h, now)));
          // WHY it is not here, not merely that it is not. `offTree` is somebody
          // else's branch and nobody's action item; the rest are the residue.
          // `unknown`, never `lost`, when nothing was classified: claiming code is
          // gone because this machine has no index is a confident lie.
          // Never `lost` for an incomparable id. `lost` means "no record anywhere",
          // which is a claim about the code; not being able to derive the id is a
          // fact about the two builds, and `unverifiable` above already carries it.
          const place = at.at === "incomparable"
            ? { state: "unknown" as const, at: undefined, file: undefined, symbol: undefined }
            : places.get(c.anchorId) ?? { state: present ? "here" : "unknown" as const };
          return {
            anchorId: c.anchorId, accepted: c.acceptedHashes.length, present, matches, unverifiable,
            where: place.state, at: place.at, lastFile: place.file, lastSymbol: place.symbol,
          };
        }),
      } : undefined,
    });
  }
  return {
    scope: nonAuthoritative(scope),
    universe: cfg.universe, total: rows.length,
    // The number worth acting on, as opposed to the number that merely mention
    // code you do not have checked out.
    // From the one verdict, not from a second scan of the citations. `unverifiable`
    // is deliberately NOT work: its recovery is aligning builds or re-witnessing,
    // neither of which is the reader's, and rendering it as a queue item is the
    // 985-docs shape this codebase already learned once.
    needAttention: rows.filter((r) => r.resolved?.status === "stale" || r.resolved?.status === "dangling").length,
    docs: rows,
  };
}

/**
 * The team's docs describing these anchors. The local surfaces answer "what
 * documents this code" from `nodes` alone, so a colleague's synced doc reads as a
 * gap. PROPOSAL-sidecar-materialization.md step 5.
 *
 * The verdict is `evalVersion`'s. A fourth re-derivation of "is this doc fresh"
 * must not appear here — the three that existed had already drifted (§7.4).
 *
 * `null`, not an error, with no sidecar: every caller is a local read that worked
 * before shared docs existed and must keep working.
 */
export interface DocsVerdict extends ScopeStatus {
  /** The docs scope, when there is a sidecar at all. */
  scope?: string;
  /**
   * Scopes a DECIDING caller must not let decide for it.
   *
   * Empty when the scope is healthy or absent. Non-empty means: the rows are still
   * there and still shown, and they may not remove work from anybody's queue.
   */
  excludeFromDecisions: ReadonlySet<string>;
}

const NO_SIDECAR_VERDICT: DocsVerdict = { status: "complete", excludeFromDecisions: new Set() };

/**
 * Fold the docs scope and say whether it may be believed.
 *
 * **The one place the suppression decision is derived.** It used to be derived in two
 * (`sharedCoverage` and `findGaps`), which is how a rule that reads identically in
 * both ends up applied in one.
 *
 * Fails CLOSED but never crashes. The agnostic core does not depend on the sidecar,
 * and an unreadable one must not break a local read that predates it — so an I/O
 * failure degrades to `blocked` rather than throwing inside outline, search, context,
 * diff and the analyzer.
 */
export async function docsVerdict(root: string): Promise<DocsVerdict> {
  const cfg = resolveSidecar(root);
  if (!cfg) return NO_SIDECAR_VERDICT;
  const scope = docScope(cfg.universe);
  try {
    const { fresh, ...status } = await ensureMaterialized(
      root, cfg.path, scope, sidecarIdentity(cfg), foldDocs, docsProjection,
    );
    const trustworthy = fresh && status.status === "complete";
    return { ...status, scope, excludeFromDecisions: trustworthy ? new Set() : new Set([scope]) };
  } catch (e: any) {
    return {
      status: "blocked",
      diagnostic: { reason: "fork", detail: `the shared docs could not be read: ${e?.message ?? e}`, evidence: [] },
      scope,
      excludeFromDecisions: new Set([scope]),
    };
  }
}


/**
 * Does the team's sidecar hold a doc for this node? Nothing else about it.
 *
 * For `annotate`'s target guard, which exists to refuse a node that is nowhere —
 * not one that is merely somewhere else. A doc that lives only on the sidecar has
 * no local `node_versions` row and therefore could not be queued at all, which is
 * blocker 5 of "Clearing a doc nobody can place".
 *
 * Deliberately not `sharedDocs`: that classifies every citation and re-hashes live
 * code to do it, and this is a membership test on a write path. `false` when there
 * is no sidecar, so a store without one behaves exactly as it always did.
 */
export async function sharedKnowsNode(root: string, nodeId: string): Promise<boolean> {
  const cfg = resolveSidecar(root);
  if (!cfg) return false;
  const scope = docScope(cfg.universe);
  const { fresh } = await ensureMaterialized(root, cfg.path, scope, sidecarIdentity(cfg), foldDocs, docsProjection);
  if (fresh) return docsByNode(root, scope, [nodeId]).size > 0;
  // The projection is behind, so ask the log rather than answer "no" from rows we
  // have been told are stale — a false no here refuses a legitimate target.
  return (await cachedDocs(root, cfg)).value.has(nodeId);
}




/** Why this doc version cannot be published, or null. Shape only — ids are checked live. */
function badDocVersion(v: NewDocVersion | undefined): string | null {
  if (!v || typeof v !== "object") return "no doc version given";
  for (const k of ["nodeId", "type", "title", "body"] as const) {
    if (typeof v[k] !== "string" || !v[k].trim()) return `\`${k}\` must be a non-empty string`;
  }
  if (!Array.isArray(v.citations)) return "`citations` must be an array";
  if (!v.citations.length) return "a doc must cite at least one anchor — an uncited doc can never be found stale, which is the point of writing it here";
  for (const c of v.citations) {
    if (!c || typeof c.anchorId !== "string" || !c.anchorId.trim()) return "every citation needs an `anchorId`";
  }
  return notPublishable(v) ?? null;
}

/**
 * Two kinds of doc that must not travel, and why. Both are per VERSION, not per node:
 * `type` is a version field and one node's history can mix them, so a node-granular
 * skip either drops a legitimate older `concept` version or lets a historical
 * `process` version through to be silently dropped by the fold.
 *
 * **Analyzer output.** The architecture doc always said it does not sync — it is
 * deterministic, each party regenerates it, and it is the bulk. Two things settle it
 * beyond that. A published generated doc has NO REFRESH PATH: `publishLocalDocs`
 * skips nodes the sidecar already has, so the team's copy freezes on publish day while
 * every local copy keeps tracking the code. And generated versions carry no accepted
 * hashes and short-circuit to badness 0, so a synced one can never be judged stale —
 * which breaks "staleness becomes visible" for exactly the bulk of the content.
 *
 * **Flows.** A `process` doc IS its steps, and steps are separate nodes joined by
 * `step_of` edges. No event kind carries edges, so a synced process doc arrives with
 * none and the flow-walker renders it empty under a teammate's name — which is worse
 * for a reviewer than absence, because it looks like the team mapped the flow and
 * found nothing. A lone `step` is equally orphaned; its meaning is its position.
 *
 * Edge sync is a whole entity design (edges have no id, so it needs an identity rule,
 * a G3-compatible removal story, an ordering-merge rule for `ord`, and fold ownership
 * in `edges`) for a surface with no demonstrated demand. Narrow now; design it when
 * somebody asks why they cannot share a flow.
 */
export function notPublishable(v: { type?: string; generatedBy?: string | null }): string | null {
  if (v.generatedBy) {
    return "analyzer output is regenerated by every machine from the code, so publishing it "
      + "shares a copy that can never be refreshed or judged stale. Share what you CONCLUDED "
      + "about it as a doc in your own words, or as a note.";
  }
  if (v.type === "process" || v.type === "step") {
    return `a \`${v.type}\` doc is its steps, and step edges do not travel yet — the shared copy `
      + "would render as an empty flow on every teammate's machine. Share the insight as a "
      + "`concept` or `module` doc citing the same anchors, or keep the flow local until flows sync.";
  }
  return null;
}

export async function shareDoc(root: string, v: NewDocVersion) {
  const b = bind(root);
  if ("error" in b) return b;
  // The MCP tool takes this as an opaque object, so it is the only gate. NO
  // FLOATING CLAIMS is the invariant that makes staleness detectable at all: a doc
  // citing nothing can never go stale, and a doc citing an id that is not an anchor
  // is a claim about code nobody can find.
  const bad = badDocVersion(v);
  if (bad) return { error: bad };
  // Refused, not stripped. Retiring a doc is a closure and `retireSharedDoc` makes
  // it a person's act; this route takes an opaque object, so without this an agent
  // publishes `removed: true` and has tombstoned it. Not inert either, though it
  // looks it: the citations must be live anchors to get past the check below, so
  // such a tombstone loses to any content version — until that code is deleted,
  // at which point it starts winning. A planted tombstone is worse than a refused
  // one. Stripping it silently would be its own lie: the caller asked to retire.
  if ((v as { removed?: unknown }).removed) {
    return { error: "a tombstone is not published through this route — retiring a doc is a closure, and `retire_shared_doc` is where a person makes it. This publishes a version that DESCRIBES code; one that claims code is gone has to say why." };
  }
  const anchors = new Set((await readAnchorStore(root)).anchors.map((a) => a.id));
  const unknown = v.citations.map((c) => c.anchorId).filter((id) => !anchors.has(id));
  if (unknown.length) {
    return { error: `not anchors in this universe: ${unknown.slice(0, 5).join(", ")}${unknown.length > 5 ? ` (+${unknown.length - 5} more)` : ""}. A doc must cite code that exists — index it first, or cite the anchor it really describes.` };
  }
  // Checked, not merely awaited. `ensureSidecar` returns an error when the path is
  // not its own git repository — and appending into a directory that is not a usable
  // sidecar, then reporting success, is the shape of failure this whole arc exists to
  // stop.
  const ready = await ensureSidecar(b.cfg.path, b.actor);
  if ("error" in ready) return ready;
  // `versionId` and `createdAt` are dropped, not honoured. This is a NEW version, so
  // there is no prior identity to preserve — the field exists for `publishLocalDocs`,
  // which republishes versions that already have one.
  //
  // Taking them here would be an unowned identity from an opaque object: version ids
  // are unique per SCOPE, not per node, so a colliding one makes `foldDocs` drop the
  // newcomer — losing that node's doc for the whole team — and a `createdAt` in the
  // future wins `selectWinner`'s tiebreak against every later version forever.
  const { versionId: _vid, createdAt: _at, ...fresh } = v as NewDocVersion & { createdAt?: string };
  const versionId = await publishDocVersion(b.cfg.path, b.cfg.universe, b.actor, {
    ...fresh,
    createdCommit: v.createdCommit ?? headCommit(root),
    createdBranch: v.createdBranch ?? currentBranch(root),
  });
  // WRITE-THROUGH: append, then materialize this scope, so the row is in SQLite
  // before this returns and the caller never observes the log. Without it a shared
  // write is invisible until something else happens to fold — which is the whole
  // difference between "the store" and "a cache somebody refreshes".
  //
  // The RESULT is checked. `docsVerdict` turns a materialization failure into a
  // blocked verdict rather than throwing, which is right for a read and wrong to
  // ignore here: the event landed, the row may not have, and saying "ok" flatly would
  // claim a condition this function advertises and did not deliver. The event is
  // durable either way, so this is a partial success, not an error.
  const after = await docsVerdict(root);
  const materialized = after.status === "complete";
  return {
    ok: true, nodeId: v.nodeId, versionId,
    ...(materialized ? {} : { materialized: false as const, scope: after.status }),
    note: materialized
      ? "recorded locally — run `codemap sync` to send it"
      : "recorded in the log, but this store could not fold it — the next read or sync will retry",
  };
}

/**
 * Confirm a doc against the body this checkout has.
 *
 * The act that lets one version be valid on several branches. Only for anchors
 * the version already cites, and only for bodies that are actually here.
 */
export async function confirmSharedDoc(root: string, nodeId: string, versionId?: string) {
  const b = bind(root);
  if ("error" in b) return b;
  const docs = (await cachedDocs(root, b.cfg)).value;
  const doc = docs.get(nodeId);
  if (!doc) return { error: `no shared doc ${nodeId}` };
  const live = await liveHashes(root, doc.versions.flatMap((x) => x.citations.map((c) => c.anchorId)));
  const v = versionId ? doc.versions.find((x) => x.versionId === versionId) : resolveDoc(doc, live);
  if (!v) return { error: versionId ? `no version ${versionId} on ${nodeId}` : `no version of ${nodeId} resolves against this checkout — say which one` };

  const added: string[] = [];
  // "Nothing to confirm" and "cannot confirm" are different answers, and this used
  // to give neither: a citation whose id is not resolvable here has no live hash to
  // add, so it was skipped and the caller was told how many succeeded. The UI then
  // offers a button that clears nothing. See docs/anchor-id-provenance.md §6.
  const unconfirmable: string[] = [];
  for (const c of v.citations) {
    const hash = live.get(c.anchorId);
    if (!hash && resolveAnchor(c.anchorId, c.acceptedHashes, live).at === "incomparable") {
      unconfirmable.push(c.anchorId);
    }
    // EXACT, like the insert this feeds (`shared-docs.ts`). Skipping by BODY would
    // suppress the event that carries a better-annotated spelling of a hash the set
    // already holds — so the set could never upgrade, and protecting the insert
    // while the producer stayed body-based would have been protection in name only.
    if (!hash || c.acceptedHashes.includes(hash)) continue;
    await acceptDocHash(b.cfg.path, b.cfg.universe, b.actor, nodeId, v.versionId, c.anchorId, hash);
    added.push(c.anchorId);
  }
  // Write-through, like every other shared write: the acceptances are appended as
  // events, and without folding them the confirmation is invisible to this store
  // until something else happens to materialize — so a doc confirmed a moment ago
  // still reads `stale`, and an edit on top of it carries no evidence.
  if (added.length) await docsVerdict(root);
  return {
    ok: true, nodeId, versionId: v.versionId, confirmed: added.length, anchors: added,
    ...(unconfirmable.length ? {
      unconfirmable,
      note: `${unconfirmable.length} citation(s) name ids this build cannot derive — confirming cannot clear those, and re-documenting against the current symbols is what would`,
    } : {}),
  };
}

/**
 * Publish this store's existing docs to the sidecar.
 *
 * Idempotent by NODE: a node the sidecar already has is skipped rather than given
 * a second copy of its history. Each local version is republished in order, so the
 * accepted-hash sets that make branch resolution work survive the move — losing
 * them would leave every doc reading `stale` on the branch it was written for.
 */
/**
 * Retire a shared doc whose subject is gone.
 *
 * A tombstone version, which the resolver already understands: it is `fresh` on a
 * branch where the cited anchors are ABSENT and loses to a live content version
 * where they still exist. So "removed on main, still live on the release branch"
 * resolves by presence, without branch tags and without deleting anything.
 *
 * A person's act. An agent may say a doc's subject looks gone — that is what a
 * shared note on the node is for — but retiring it is a closure, and the same
 * rule that stops an agent closing a finding applies here for the same reason.
 *
 * Refuses when the citations are still present: a doc about code that is right
 * there is not a doc whose subject was removed, and tombstoning it would hide
 * something true.
 */
export async function retireSharedDoc(root: string, nodeId: string, rationale: string) {
  const b = bind(root);
  if ("error" in b) return b;
  if (isAgentActor(b.actor)) {
    return { error: "retiring a doc is a closure — an agent may not. Leave a shared note on the node saying what you found and let a person retire it." };
  }
  if (!rationale.trim()) return { error: "say why the subject is gone — a tombstone with no reason is indistinguishable from a mistake" };

  const doc = (await cachedDocs(root, b.cfg)).value.get(nodeId);
  if (!doc) return { error: `no shared doc ${nodeId}` };
  const live = await liveHashes(root, doc.versions.flatMap((x) => x.citations.map((c) => c.anchorId)));
  const v = resolveDoc(doc, live);
  if (!v) return { error: `${nodeId} has no versions to retire` };
  if (v.removed) return { error: `${nodeId} is already retired here` };

  const places = await classifyCitations(root, v.citations.map((c) => c.anchorId));
  const stillHere = v.citations.filter((c) => places.get(c.anchorId)?.state === "here");
  if (stillHere.length) {
    return { error: `${stillHere.length} of ${v.citations.length} cited symbols are still in this checkout — that is not a removed subject. Write a new version instead.` };
  }
  const offTree = v.citations.filter((c) => places.get(c.anchorId)?.state === "offTree");
  if (offTree.length) {
    return { error: `${offTree.length} cited symbol(s) are on another branch, not gone (${offTree.map((c) => places.get(c.anchorId)?.at).join(", ")}). A tombstone here would hide a doc that is correct there.` };
  }

  await publishDocVersion(b.cfg.path, b.cfg.universe, b.actor, {
    nodeId, type: v.type, title: v.title, summary: v.summary, body: v.body,
    // The hashes ride along, and they are NOT an acceptance claim — `evalVersion`'s
    // removed branch reads their DERIVATION and never compares their bodies. They
    // are the evidence, not the assertion: a tombstone
    // asserts "this was removed", which is an inference from absence, and absence is
    // only evidence when the id could have resolved here at all. Emptied, the
    // tombstone arrives with nothing to judge that by and reads as holding against
    // any index — including one whose build mints different ids for the same code.
    // See docs/anchor-id-provenance.md §6.
    citations: v.citations.map((c) => ({ anchorId: c.anchorId, acceptedHashes: [...c.acceptedHashes] })),
    removed: true,
    createdCommit: headCommit(root), createdBranch: currentBranch(root),
  });
  return { ok: true, nodeId, retired: true, rationale, note: "a tombstone version — the doc still resolves on branches that have the code" };
}

export async function publishLocalDocs(root: string, opts: { dryRun?: boolean } = {}) {
  const b = bind(root);
  if ("error" in b) return b;
  await ensureSidecar(b.cfg.path, b.actor);
  const nodes = await loadNodes(root);
  const already = (await cachedDocs(root, b.cfg)).value;
  const todo = nodes.filter((n) => !already.has(n.id));
  if (opts.dryRun) {
    return { universe: b.cfg.universe, local: nodes.length, alreadyShared: nodes.length - todo.length, wouldPublish: todo.length };
  }
  let versions = 0;
  const skipped = { generated: 0, flows: 0 };
  for (const n of todo) {
    for (const v of await loadNodeVersions(root, n.id)) {
      // Per version, and COUNTED. A silent narrowing is the failure this is trying to
      // avoid: a version that never travels and is never mentioned reads, from the
      // other side, exactly like one that did.
      if (notPublishable(v)) { if (v.generatedBy) skipped.generated++; else skipped.flows++; continue; }
      // Its own id and its own authorship time. A backfill is a republication of
      // history, not a new act: minting either here is what made the local and
      // shared copies indistinguishable and reordered the version tiebreak.
      await publishDocVersion(b.cfg.path, b.cfg.universe, b.actor, {
        nodeId: n.id, type: v.type, title: v.title, summary: v.summary, body: v.body,
        citations: v.citations, generatedBy: v.generatedBy, removed: v.removed,
        createdCommit: v.createdCommit, createdBranch: v.createdBranch,
        versionId: v.versionId, createdAt: v.createdAt,
      });
      versions++;
    }
  }
  return {
    universe: b.cfg.universe, publishedNodes: todo.length, publishedVersions: versions,
    alreadyShared: nodes.length - todo.length,
    ...(skipped.generated || skipped.flows ? { skipped } : {}),
    note: todo.length ? "run `codemap sync` to send them" : "nothing new to publish",
  };
}

export async function shareWalkthrough(root: string, w: PrWalkthrough) {
  const b = bind(root);
  if ("error" in b) return b;
  const ready = await ensureSidecar(b.cfg.path, b.actor);
  if ("error" in ready) return ready;
  await publishWalkthrough(b.cfg.path, b.actor, { ...w, pr: w.pr }, prKey(b.cfg, w.pr));
  // Write-through, same as a shared doc: append, then materialize that scope, so the
  // walkthrough is readable from SQLite the moment this returns. Reported rather than
  // swallowed — a bare `.catch(() => null)` here returned success for a write that
  // never reached the store.
  const m = await ensureMaterialized(root, b.cfg.path, walkthroughScope(prKey(b.cfg, w.pr)),
    sidecarIdentity(b.cfg), foldWalkthroughs, walkthroughsProjection).catch(() => null);
  const materialized = m?.fresh === true && m.status === "complete";
  return {
    ok: true, pr: w.pr,
    ...(materialized ? {} : { materialized: false as const }),
    note: materialized
      ? "recorded locally — run `codemap sync` to send it"
      : "recorded in the log, but this store could not fold it — the next read or sync will retry",
  };
}

export async function sharedWalkthroughs(root: string, pr: number | string, head?: string) {
  const cfg = resolveSidecar(root);
  if (!cfg) return { error: NO_SIDECAR };
  // Through the CACHE, not `readWalkthroughs`. This was the last read that folded the
  // log on every call, which is exactly what "the log is pull/push, never read on an
  // ordinary query" rules out — opening a pull request parsed every shard in its
  // walkthrough scope.
  const { value: all, ...status } = await readCached(
    root, cfg.path, walkthroughScope(prKey(cfg, pr)), sidecarIdentity(cfg),
    foldWalkthroughs, walkthroughsProjection,
  );
  const cur = head ? currentWalkthrough(all, head) : undefined;
  return {
    universe: cfg.universe,
    pr,
    count: all.length,
    // A blocked scope still SHOWS its walkthroughs — this suppresses nothing, so it
    // reports the verdict rather than emptying the list.
    ...(status.status !== "complete" ? { scope: status } : {}),
    current: cur ? { by: cur.actor.principal, model: cur.actor.via?.model, at: cur.at, walkthrough: cur.walkthrough } : undefined,
    // Named rather than hidden: a walkthrough about another commit is not wrong,
    // it is about something else, and saying so is the point of the head stamp.
    stale: head ? staleWalkthroughs(all, head).map((s) => ({ by: s.actor.principal, head: s.walkthrough.head })) : [],
  };
}
