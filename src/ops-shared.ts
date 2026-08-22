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
import { comparableHashes } from "./normalize.js";
import { resolveSidecar, scopeFor, type SidecarConfig } from "./sidecar-config.js";
import { originSlug, headCommit, currentBranch } from "./git.js";
import { fetchReviewThreads } from "./pr-push.js";
import { ensureSidecar, sync as sidecarSync, readManifests, checkPeers, currentManifest } from "./sidecar.js";
import {
  createFinding, corroborate, comment, promote, request, setState, recordOutcome,
  markPosted, markUpstreamed, promoteToBug, readFindings, needsHumanAck, ackQueue,
  revise, resolveContest,
  type SharedFinding, type Verdict, type Ask, type FindingState, type NewFinding,
} from "./shared-findings.js";
import { publishWalkthrough, readWalkthroughs, currentWalkthrough, staleWalkthroughs } from "./shared-walkthrough.js";
import { createNote, answerNote, resolveNote, notesForTarget, allNotes, type NewNote } from "./shared-notes.js";
import { readAnnotations, readAnchorStore, loadNodes, loadNodeVersions } from "./store.js";
import { publishDocVersion, acceptDocHash, readDocs, resolveDoc, type NewDocVersion } from "./shared-docs.js";
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

/** Send and receive. The whole point of the button. */
export async function sharedSync(root: string) {
  const b = bind(root);
  if ("error" in b) return b;
  const r = await sidecarSync(b.cfg.path, b.actor, `codemap: ${b.cfg.universe}`);
  if ("error" in r) return r;
  return { ok: true, universe: b.cfg.universe, sidecar: b.cfg.path, ...r };
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
  };
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

export async function sharedFindings(root: string, pr: number | string, opts: { queue?: boolean } = {}) {
  const cfg = resolveSidecar(root);
  if (!cfg) return { error: NO_SIDECAR };
  const all = [...(await readFindings(cfg.path, prKey(cfg, pr))).values()];
  const chosen = opts.queue ? ackQueue(all) : all;
  return {
    universe: cfg.universe,
    pr,
    total: all.length,
    waitingOnYou: ackQueue(all).length,
    contested: all.filter((f) => f.contested?.length).length,
    findings: chosen.map(view),
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
export async function inboundReplies(root: string, pr: number | string) {
  const cfg = resolveSidecar(root);
  if (!cfg) return { error: NO_SIDECAR };
  const slug = originSlug(root);
  if (!slug) return { error: "no GitHub remote on this universe, so there is no pull request to read replies from" };

  const all = [...(await readFindings(cfg.path, prKey(cfg, pr))).values()];
  const published = all.filter((f) => f.posted?.key);
  if (!published.length) return { universe: cfg.universe, pr, findings: [], note: "nothing from here has been published to the pull request" };

  const threads = fetchReviewThreads(`${slug.owner}/${slug.repo}`, Number(pr));
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
  const notes = await notesForTarget(cfg.path, cfg.universe, targetId);
  return {
    universe: cfg.universe,
    target: targetId,
    notes: notes.map((n) => ({
      id: n.id, kind: n.kind, text: n.text, severity: n.severity, category: n.category, line: n.line,
      by: n.author.principal, model: n.author.via?.model, at: n.createdAt,
      resolved: n.resolved ? { by: n.resolved.by.principal, reason: n.resolved.reason } : undefined,
      answers: n.answers.map((a) => ({ by: a.actor.principal, model: a.actor.via?.model, at: a.at, body: a.body })),
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
async function liveHashes(root: string): Promise<Map<string, string>> {
  const store = await readAnchorStore(root);
  return new Map(store.anchors.map((a) => [a.id, a.bodyHash]));
}

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
  const docs = await readDocs(cfg.path, cfg.universe);
  const live = await liveHashes(root);
  const rows = [];
  for (const doc of docs.values()) {
    if (opts.nodeId && doc.nodeId !== opts.nodeId) continue;
    const v = resolveDoc(doc, live);
    rows.push({
      nodeId: doc.nodeId,
      versions: doc.versions.length,
      // `winningVersionAt` picks the LEAST-BAD version and always returns one when
      // versions exist — it never signals "none of these describe your checkout".
      // The per-citation `matches`/`present` below are what actually say whether
      // the winner is fresh here, so read those rather than the fact of a winner.
      resolved: v ? {
        versionId: v.versionId, type: v.type, title: v.title, summary: v.summary, body: v.body,
        removed: !!v.removed, generatedBy: v.generatedBy,
        by: doc.authors.get(v.versionId)?.principal,
        citations: v.citations.map((c) => {
          const now = live.get(c.anchorId);
          const present = now !== undefined;
          const matches = present && c.acceptedHashes.includes(now);
          // A citation confirmed under an older HASH_SCHEME cannot be compared to
          // this body at all, and calling that DRIFT is the false staleness the
          // scheme exists to prevent: a migration re-hashes everything, so every
          // doc in the store would read stale on the first reindex without anyone
          // touching the code. Found doing exactly that on a real repo — 985 of 985.
          const unverifiable = present && !matches
            && !c.acceptedHashes.some((h) => comparableHashes(h, now));
          return { anchorId: c.anchorId, accepted: c.acceptedHashes.length, present, matches, unverifiable };
        }),
      } : undefined,
    });
  }
  return { universe: cfg.universe, total: rows.length, docs: rows };
}

export async function shareDoc(root: string, v: NewDocVersion) {
  const b = bind(root);
  if ("error" in b) return b;
  await ensureSidecar(b.cfg.path, b.actor);
  const versionId = await publishDocVersion(b.cfg.path, b.cfg.universe, b.actor, {
    ...v,
    createdCommit: v.createdCommit ?? headCommit(root),
    createdBranch: v.createdBranch ?? currentBranch(root),
  });
  return { ok: true, nodeId: v.nodeId, versionId, note: "recorded locally — run `codemap sync` to send it" };
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
  const docs = await readDocs(b.cfg.path, b.cfg.universe);
  const doc = docs.get(nodeId);
  if (!doc) return { error: `no shared doc ${nodeId}` };
  const live = await liveHashes(root);
  const v = versionId ? doc.versions.find((x) => x.versionId === versionId) : resolveDoc(doc, live);
  if (!v) return { error: versionId ? `no version ${versionId} on ${nodeId}` : `no version of ${nodeId} resolves against this checkout — say which one` };

  const added: string[] = [];
  for (const c of v.citations) {
    const hash = live.get(c.anchorId);
    if (!hash || c.acceptedHashes.includes(hash)) continue;
    await acceptDocHash(b.cfg.path, b.cfg.universe, b.actor, nodeId, v.versionId, c.anchorId, hash);
    added.push(c.anchorId);
  }
  return { ok: true, nodeId, versionId: v.versionId, confirmed: added.length, anchors: added };
}

/**
 * Publish this store's existing docs to the sidecar.
 *
 * Idempotent by NODE: a node the sidecar already has is skipped rather than given
 * a second copy of its history. Each local version is republished in order, so the
 * accepted-hash sets that make branch resolution work survive the move — losing
 * them would leave every doc reading `stale` on the branch it was written for.
 */
export async function publishLocalDocs(root: string, opts: { dryRun?: boolean } = {}) {
  const b = bind(root);
  if ("error" in b) return b;
  await ensureSidecar(b.cfg.path, b.actor);
  const nodes = await loadNodes(root);
  const already = await readDocs(b.cfg.path, b.cfg.universe);
  const todo = nodes.filter((n) => !already.has(n.id));
  if (opts.dryRun) {
    return { universe: b.cfg.universe, local: nodes.length, alreadyShared: nodes.length - todo.length, wouldPublish: todo.length };
  }
  let versions = 0;
  for (const n of todo) {
    for (const v of await loadNodeVersions(root, n.id)) {
      await publishDocVersion(b.cfg.path, b.cfg.universe, b.actor, {
        nodeId: n.id, type: v.type, title: v.title, summary: v.summary, body: v.body,
        citations: v.citations, generatedBy: v.generatedBy, removed: v.removed,
        createdCommit: v.createdCommit, createdBranch: v.createdBranch,
      });
      versions++;
    }
  }
  return {
    universe: b.cfg.universe, publishedNodes: todo.length, publishedVersions: versions,
    alreadyShared: nodes.length - todo.length,
    note: todo.length ? "run `codemap sync` to send them" : "nothing new to publish",
  };
}

export async function shareWalkthrough(root: string, w: PrWalkthrough) {
  const b = bind(root);
  if ("error" in b) return b;
  await ensureSidecar(b.cfg.path, b.actor);
  await publishWalkthrough(b.cfg.path, b.actor, { ...w, pr: w.pr }, prKey(b.cfg, w.pr));
  return { ok: true, pr: w.pr, note: "recorded locally — run `codemap sync` to send it" };
}

export async function sharedWalkthroughs(root: string, pr: number | string, head?: string) {
  const cfg = resolveSidecar(root);
  if (!cfg) return { error: NO_SIDECAR };
  const all = await readWalkthroughs(cfg.path, prKey(cfg, pr));
  const cur = head ? currentWalkthrough(all, head) : undefined;
  return {
    universe: cfg.universe,
    pr,
    count: all.length,
    current: cur ? { by: cur.actor.principal, model: cur.actor.via?.model, at: cur.at, walkthrough: cur.walkthrough } : undefined,
    // Named rather than hidden: a walkthrough about another commit is not wrong,
    // it is about something else, and saying so is the point of the head stamp.
    stale: head ? staleWalkthroughs(all, head).map((s) => ({ by: s.actor.principal, head: s.walkthrough.head })) : [],
  };
}
