/**
 * The shared-review operations, protocol-free — what the CLI, MCP and HTTP all
 * call. Same rule as `ops.ts`: the logic lives here, the front-ends are thin.
 *
 * Everything degrades to a clear message when no sidecar is configured, because
 * that is the state every existing store is in and none of them should start
 * failing. A sidecar is additive.
 */

import type { Actor } from "./schema.js";
import { requireActor } from "./identity.js";
import { resolveSidecar, scopeFor, type SidecarConfig } from "./sidecar-config.js";
import { originSlug } from "./git.js";
import { fetchReviewThreads } from "./pr-push.js";
import { ensureSidecar, sync as sidecarSync, readManifests, checkPeers, currentManifest } from "./sidecar.js";
import {
  createFinding, corroborate, comment, promote, request, setState, recordOutcome,
  markPosted, markUpstreamed, promoteToBug, readFindings, needsHumanAck, ackQueue,
  revise, resolveContest,
  type SharedFinding, type Verdict, type Ask, type FindingState, type NewFinding,
} from "./shared-findings.js";
import { publishWalkthrough, readWalkthroughs, currentWalkthrough, staleWalkthroughs } from "./shared-walkthrough.js";
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
