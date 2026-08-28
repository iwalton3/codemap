/**
 * Audit pointers — a prior on where to look, never a verdict (COD-29).
 * `docs/requirements-architecture.md` is normative; this implements it.
 *
 * A pointer is a standing declaration that a rule's conformance depends on some
 * observable. When it moves, the rule rises in the audit queue — and that is *all* it
 * does. `conformant` stays reachable only through a code-backed audit, because even a
 * failing test proves the INVARIANT broke, and whether the REQUIREMENT broke depends on
 * whether the check faithfully encodes it. Nothing here reads or writes conformance.
 *
 * What it is FOR is differential audit. Without pointers, re-checking the standard is a
 * sweep — every rule against the whole tree, which is the cost that makes an auditor agent
 * unaffordable and its output noise. With them, an audit is provoked by what actually
 * MOVED and arrives with the chain assembled:
 *
 *     test changes ────────────pointer──▶ rule possibly broken   + the backtrace
 *     code changes ─▶ doc stales ─pointer──▶ rule possibly broken   + the backtrace
 *
 * **The second path is free**, and it is the reason to aim at a doc rather than an anchor:
 * doc staleness is codemap's ORIGINAL machinery, shipped years before any of this. The
 * pointer just connects that detector upward. It is not special-cased below — a doc going
 * stale IS its cited anchors moving, so one witness mechanism serves both.
 */

import { randomBytes } from "node:crypto";
import type { BugWitness, LogicalNode, NodeStatus, Pointer } from "./schema.js";
import {
  loadNodes, readPointer, readPointers, readRequirement, readRequirements, workFiles, workHas,
  writeLocalPointer,
} from "./store.js";
import { liveHashes, witnessDrift, realDrift } from "./reviews.js";
import { loadIgnore } from "./ignore.js";
import { requireActor } from "./identity.js";
import type { ActorInput } from "./identity.js";
import { disposition, sharePointerDeclared, sharePointerRestated, sharePointerRetired } from "./standard-publish.js";

const mint = () => "pt_" + randomBytes(6).toString("hex");
const now = () => new Date().toISOString();

export type Err = { error: string };
const isErr = (x: unknown): x is Err => !!x && typeof x === "object" && "error" in (x as object);

/**
 * Where a pointer sits on the abstraction ladder, DERIVED rather than declared.
 *
 * `check` — a test or lint. Covers a whole population and survives any single site
 * changing. It is a compression *and* it runs, which is why it ranks highest.
 * `pattern` — a doc. Covers everything the pattern governs and survives refactors within
 * it, and drift detection is already attached to it.
 * `symbol` — one anchor. The LAST RESORT: it covers one symbol and survives almost
 * nothing, because a rename mints a new id, so it goes quiet exactly when the code it
 * governs is edited.
 */
export type PointerRank = "check" | "pattern" | "symbol";

export interface ServedPointer extends Pointer {
  rank: PointerRank;
  /** The last resort was taken. Reported so it is visible, never refused. */
  lastResort: boolean;
  /** What it watches has moved since the baseline — the pointer is FIRING. */
  moved: boolean;
  drifted: string[];
  /** The address no longer resolves: the doc is gone, or the anchor left the tree. */
  missing: boolean;
  /** For a doc pointer, the node's own staleness — the free signal, as context. */
  docStatus?: NodeStatus;
}

/**
 * The reads every `serve` needs, loaded ONCE.
 *
 * Not premature: serving a pointer wants the node table and the ignore file, and
 * `auditQueue` serves every pointer of every rule. Doing it per pointer was two full node
 * loads each — at the seeding scale this record exists for (~150 rules) that is hundreds
 * of scans to answer one queue.
 */
interface Ctx { nodes: Map<string, LogicalNode>; isTest: (f: string) => boolean }

async function context(root: string): Promise<Ctx> {
  const nodes = new Map((await loadNodes(root)).map((n) => [n.id, n]));
  let ig: Awaited<ReturnType<typeof loadIgnore>> | null = null;
  try { ig = await loadIgnore(root); } catch { /* no ignore file: nothing is a test */ }
  return { nodes, isTest: (f: string) => ig?.isTest(f, false) ?? false };
}

/** The anchors a pointer's baseline is taken over: the anchor itself, or a doc's citations. */
function watched(root: string, ctx: Ctx, target: Pointer["target"]): string[] | null {
  if (target.kind === "anchor") return workHas(root, [target.id]).has(target.id) ? [target.id] : null;
  return ctx.nodes.get(target.id)?.anchors ?? null;
}

function rankOf(root: string, ctx: Ctx, target: Pointer["target"]): PointerRank {
  if (target.kind === "node") return "pattern";
  // A check is not a third target KIND — it is an anchor that lives in a `[tests]` path,
  // which is why tests are indexed at all. Derived here rather than asserted by a writer,
  // for the reason nothing else in this subsystem stores a status somebody can satisfy.
  try {
    const file = workFiles(root, [target.id]).get(target.id);
    return file && ctx.isTest(file) ? "check" : "symbol";
  } catch { return "symbol"; }
}

async function serveWith(root: string, ctx: Ctx, p: Pointer): Promise<ServedPointer> {
  const rank = rankOf(root, ctx, p.target);
  const anchors = watched(root, ctx, p.target);
  const node = p.target.kind === "node" ? ctx.nodes.get(p.target.id) : undefined;
  const base = {
    ...p, rank, lastResort: rank === "symbol", missing: anchors === null,
    ...(node?.status ? { docStatus: node.status } : {}),
  };
  if (!p.witnesses.length) return { ...base, moved: false, drifted: [] };
  const live = await liveHashes(root, p.witnesses.map((w: BugWitness) => w.anchorId));
  const changes = realDrift(witnessDrift(p.witnesses, live));
  return { ...base, moved: changes.length > 0, drifted: changes.map((c) => c.anchorId) };
}

export async function serve(root: string, p: Pointer): Promise<ServedPointer> {
  return serveWith(root, await context(root), p);
}

// --- declaring ---------------------------------------------------------------

export interface Declared { ok: true; id: string; pointer: ServedPointer; advice?: string }

/**
 * Declare where an auditor should look for this rule.
 *
 * Open to any actor and deliberately ungated: a pointer cannot reach the conformance
 * state, so there is nothing here to silence. That is the same reasoning that makes
 * releasing an acknowledgement open while granting one is not — the asymmetry is about
 * consequence, and a laundered pointer costs queue position only. (The same lint used as a
 * POPULATION PREDICATE can flip debt→gap, which is silencing, and is gated where it lands.)
 *
 * An anchor target is accepted and flagged, never refused. Nothing here can know whether a
 * higher rung was available — but where the anchor is already cited by a doc, that doc is
 * named, because it is the better pointer and the caller is one call from it.
 */
export async function declarePointer(
  root: string,
  input: { requirementId: string; targetKind: Pointer["target"]["kind"]; targetId: string; rationale: string } & ActorInput,
): Promise<Declared | Err> {
  const rationale = input.rationale?.trim();
  if (!rationale) {
    return {
      error:
        "a pointer needs a `rationale` — why this address is the one to watch. It is what a "
        + "later reader has to judge, and a pointer nobody can evaluate is the vacuity "
        + "problem arriving at the one record that exists to make auditing cheaper.",
    };
  }
  if (input.targetKind !== "node" && input.targetKind !== "anchor") {
    return { error: '`targetKind` must be "node" or "anchor"' };
  }
  const r = await readRequirement(root, input.requirementId);
  if (!r) return { error: `no requirement "${input.requirementId}"` };
  if (r.status === "retired") return { error: `${r.id} is retired — a rule that does not bind needs nobody watching it` };

  const target = { kind: input.targetKind, id: input.targetId };
  const ctx = await context(root);
  const anchors = watched(root, ctx, target);
  if (anchors === null) {
    return {
      error: input.targetKind === "node"
        ? `no doc "${input.targetId}"`
        : `anchor "${input.targetId}" is not in the live index — a pointer at an address that does not resolve fires never, which reads as coverage`,
    };
  }
  // An empty doc is accepted with no witnesses, and it is worth knowing why that is not a
  // refusal: a doc citing nothing is a well-formed record here for the same reason an
  // uncited requirement is. What it CANNOT do is fire, which `moved: false` reports.
  const actor = requireActor(root, input);
  if (isErr(actor)) return actor;

  const live = anchors.length ? await liveHashes(root, anchors) : new Map<string, string>();
  const pointer: Pointer = {
    id: mint(), requirementId: r.id, target, rationale,
    witnesses: anchors.map((id) => ({ anchorId: id, bodyHash: live.get(id) ?? "sha256:absent" })),
    state: "active", declaredBy: actor, declaredAt: now(),
  };

  const d = disposition(await sharePointerDeclared(root, pointer));
  if ("error" in d) return d;
  if (d.local) await writeLocalPointer(root, pointer);

  const served = await serveWith(root, ctx, pointer);
  const advice = served.lastResort ? betterThanAnAnchor(ctx, target.id) : undefined;
  return { ok: true, id: pointer.id, pointer: served, ...(advice ? { advice } : {}) };
}

/** A doc already citing this anchor is a higher rung, and the caller is one call from it. */
function betterThanAnAnchor(ctx: Ctx, anchorId: string): string {
  const docs = [...ctx.nodes.values()].filter((n) => n.anchors.includes(anchorId));
  const base =
    "an anchor is the LAST RESORT: it covers one symbol and a rename mints a new id, so this "
    + "goes quiet exactly when the code it governs is edited.";
  return docs.length
    ? `${base} ${docs.length} doc(s) already cite it and would cover more for longer: `
      + docs.slice(0, 5).map((n) => `${n.id} ("${n.title}")`).join(", ")
    : `${base} Prefer a lint or a doc-of-a-pattern where one exists.`;
}

/**
 * Re-baseline: somebody looked, and this is the new quiet.
 *
 * Explicit rather than implied by `recordAudit`, and the tradeoff is worth stating. Folding
 * it into an audit would make one act silently emit N others, each needing its own honest
 * actor and causal position; the cost of keeping it separate is that a pointer nobody
 * restates fires for ever, which is the `always fires` pathology the scrub exists to catch.
 */
export async function restatePointer(
  root: string, input: { id: string } & ActorInput,
): Promise<{ ok: true; pointer: ServedPointer } | Err> {
  const p = await readPointer(root, input.id);
  if (!p) return { error: `no pointer "${input.id}"` };
  if (p.state !== "active") return { error: `${p.id} is retired` };
  const ctx = await context(root);
  const anchors = watched(root, ctx, p.target);
  if (anchors === null) {
    return { error: `${p.id} points at ${p.target.kind} "${p.target.id}", which no longer resolves — retire it rather than baselining an address that is gone` };
  }
  const actor = requireActor(root, input);
  if (isErr(actor)) return actor;

  const live = anchors.length ? await liveHashes(root, anchors) : new Map<string, string>();
  const next: Pointer = {
    ...p,
    witnesses: anchors.map((id) => ({ anchorId: id, bodyHash: live.get(id) ?? "sha256:absent" })),
    restatedBy: actor, restatedAt: now(),
  };
  const d = disposition(await sharePointerRestated(root, next));
  if ("error" in d) return d;
  if (d.local) await writeLocalPointer(root, next);
  return { ok: true, pointer: await serveWith(root, ctx, next) };
}

/**
 * Stop watching. RETIRED, never deleted — a pointer's own history is where a scrub reads
 * its firing rate, and deleting the record destroys the evidence that it was vacuous.
 */
export async function retirePointer(
  root: string, input: { id: string; reason: string } & ActorInput,
): Promise<{ ok: true; pointer: Pointer } | Err> {
  const reason = input.reason?.trim();
  if (!reason) return { error: "retiring a pointer needs a reason — a rule quietly losing what watches it is how a standard comes to look settled" };
  const p = await readPointer(root, input.id);
  if (!p) return { error: `no pointer "${input.id}"` };
  if (p.state === "retired") return { error: `${p.id} is already retired` };
  const actor = requireActor(root, input);
  if (isErr(actor)) return actor;

  const next: Pointer = { ...p, state: "retired", retiredBy: actor, retiredAt: now(), retiredReason: reason };
  const d = disposition(await sharePointerRetired(root, next));
  if ("error" in d) return d;
  if (d.local) await writeLocalPointer(root, next);
  return { ok: true, pointer: next };
}

// --- reading -----------------------------------------------------------------

export async function pointersFor(root: string, requirementId: string): Promise<ServedPointer[]> {
  const ctx = await context(root);
  return Promise.all((await readPointers(root, { requirementId })).map((p) => serveWith(root, ctx, p)));
}

/** Which rules were watching this address — the reverse read a diff rollup needs. */
export async function pointersAt(
  root: string, target: { kind: string; id: string },
): Promise<Pointer[]> {
  return readPointers(root, { target, state: "active" });
}

/**
 * The audit queue, ordered by what actually moved.
 *
 * `firing` is the differential half — a rule whose watched address changed, with the
 * backtrace already assembled, which is what converts an audit from judgement into
 * reading. `unwatched` is the other half and matters just as much: a rule with no pointer
 * **can never rise**, so its absence has to be visible in its own right rather than
 * reading as calm. It is the requirement-side twin of `unknown`.
 */
export async function auditQueue(root: string): Promise<{
  firing: { requirementId: string; title: string; section: string; pointers: ServedPointer[] }[];
  unwatched: { requirementId: string; title: string; section: string }[];
  broken: ServedPointer[];
}> {
  // Ratified only, the way `conformance()` and the diff rollup filter: a retired rule does
  // not bind, so neither its silence nor its noise is anybody's work.
  const { requirements } = await readRequirements(root, { status: "ratified" });
  const ctx = await context(root);
  // One query and one grouping, not one query per rule. The queue is the read this record
  // exists to serve, so it is the one that must not be O(rules) round trips.
  const byRule = new Map<string, Pointer[]>();
  for (const p of await readPointers(root, { state: "active" })) {
    byRule.set(p.requirementId, [...(byRule.get(p.requirementId) ?? []), p]);
  }
  const firing: { requirementId: string; title: string; section: string; pointers: ServedPointer[] }[] = [];
  const unwatched: { requirementId: string; title: string; section: string }[] = [];
  const broken: ServedPointer[] = [];
  for (const r of requirements) {
    const active = await Promise.all((byRule.get(r.id) ?? []).map((p) => serveWith(root, ctx, p)));
    if (!active.length) { unwatched.push({ requirementId: r.id, title: r.title, section: r.section }); continue; }
    broken.push(...active.filter((p) => p.missing));
    const hot = active.filter((p) => p.moved);
    if (hot.length) firing.push({ requirementId: r.id, title: r.title, section: r.section, pointers: hot });
  }
  return { firing, unwatched, broken };
}
