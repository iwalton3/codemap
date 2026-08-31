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
import type { LogicalNode, NodeStatus, Pointer } from "./schema.js";
import { criterionIdFor, requirementIdFor } from "./schema.js";
import {
  loadNodes, readCriterion, readOperation, readOperations, readPointer, readPointers, readRequirement, readRequirements,
  readSpec, workFiles, workHas,
  writeLocalPointer,
} from "./store.js";
import { liveHashes, witnessDrift, realDrift } from "./reviews.js";
import { legacyIndex, type AnchorIndex } from "./anchor-resolve.js";
import { loadIgnore } from "./ignore.js";
import { requireActor } from "./identity.js";
import { universeKey } from "./sidecar-config.js";
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
interface Ctx {
  nodes: Map<string, LogicalNode>;
  isTest: (f: string) => boolean;
  /** Live hashes for every anchor the caller is about to ask about, fetched ONCE. */
  live: AnchorIndex;
}

/**
 * @param witnessed every anchor id the pointers being served witness. `liveHashes` reads
 * the WHOLE `@work` anchor table and re-parses the files it needs with tree-sitter, so
 * calling it per pointer is that work repeated per pointer — measured at 2,400 anchors and
 * 150 rules, `auditQueue` spent 547 ms doing it once per pointer and is linear in the
 * product. It takes an iterable, so one call with the union costs the same as one pointer.
 */
async function context(root: string, witnessed: Iterable<string> = []): Promise<Ctx> {
  const nodes = new Map((await loadNodes(root)).map((n) => [n.id, n]));
  let ig: Awaited<ReturnType<typeof loadIgnore>> | null = null;
  try { ig = await loadIgnore(root); } catch { /* no ignore file: nothing is a test */ }
  const ids = [...witnessed];
  return {
    nodes, isTest: (f: string) => ig?.isTest(f, false) ?? false,
    live: ids.length ? await liveHashes(root, ids) : legacyIndex(new Map()),
  };
}

const witnessedBy = (ps: Pointer[]): Set<string> =>
  new Set(ps.flatMap((p) => p.witnesses.map((w) => w.anchorId)));

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
  const changes = realDrift(witnessDrift(p.witnesses, ctx.live));
  return { ...base, moved: changes.length > 0, drifted: changes.map((c) => c.anchorId) };
}

export async function serve(root: string, p: Pointer): Promise<ServedPointer> {
  return serveWith(root, await context(root, witnessedBy([p])), p);
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
/**
 * Propose a detector alongside a draft spec's `add_criterion`. Binds when it is ratified.
 *
 * The reason this verb exists: moving a criterion's check onto pointers took it out of
 * `operationContent`, so it stopped being part of what a ratifier signs — and a detector
 * declared after adoption is a check the person who adopted the rule never saw. Proposed
 * here, it renders on the spec page while they decide. Visible, not signed, which is the
 * honest position for evidence.
 *
 * No late binding, unlike `Acknowledgement.operationId`, and that is not a shortcut: both
 * ids are pure functions of operation ids (`criterionIdFor`, `requirementIdFor`), so this
 * knows the criterion and the rule it will attach to before either exists, and ratification
 * only flips the state. A late-bound field would be a second place for the derivation to
 * disagree with itself.
 *
 * Open to any actor, like every other authoring act on a draft: proposing a check is not
 * adopting one, and it is refused the moment the spec stops being a draft.
 */
export async function proposePointer(
  root: string,
  input: { operationId: string; targetKind: Pointer["target"]["kind"]; targetId: string; rationale: string } & ActorInput,
): Promise<Declared | Err> {
  const rationale = input.rationale?.trim();
  if (!rationale) return { error: "a pointer needs a `rationale` — why this address is the one to watch" };

  const op = await readOperation(root, input.operationId);
  if (!op) return { error: `no operation "${input.operationId}"` };
  if (op.kind !== "add_criterion") {
    return {
      error:
        `${op.id} is a ${op.kind} — a detector is proposed against an \`add_criterion\`. The code a `
        + `RULE governs is watched by an ordinary pointer, declared once the rule exists.`,
    };
  }
  if (op.removed) return { error: `${op.id} was pulled from ${op.specId}` };
  const sp = await readSpec(root, op.specId);
  if (!sp) return { error: `operation ${op.id} points at missing spec ${op.specId}` };
  if (sp.status !== "draft") {
    return {
      error:
        `${sp.id} is ${sp.status} — a pointer is only PROPOSED while the spec is a draft. The `
        + `criterion exists now, so declare a detector against it directly with \`declarePointer\`.`,
    };
  }
  // Both ids, derived. `requirementId` comes from the rule this same spec creates when the
  // criterion names an operation, and off the criterion's own target when it names a rule
  // that already stands — the identical resolution `applyOperation` does at ratification.
  const requirementId = op.targetOperationId ? requirementIdFor(op.targetOperationId) : op.requirementId;
  if (!requirementId) return { error: `${op.id} names neither a target operation nor a requirement` };
  const criterionId = criterionIdFor(op.id);

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
  const actor = requireActor(root, input);
  if (isErr(actor)) return actor;

  const live = anchors.length ? await liveHashes(root, anchors) : legacyIndex(new Map());
  const pointer: Pointer = {
    id: mint(), requirementId, criterionId, operationId: op.id,
    universe: universeKey(root), target, rationale,
    witnesses: anchors.map((id) => ({ anchorId: id, bodyHash: live.get(id) ?? "sha256:absent" })),
    state: "pending", declaredBy: actor, declaredAt: now(),
  };
  const d = disposition(await sharePointerDeclared(root, pointer));
  if ("error" in d) return d;
  if (d.local) await writeLocalPointer(root, pointer);
  return { ok: true, id: pointer.id, pointer: await serveWith(root, { ...ctx, live }, pointer) };
}

/**
 * Ratification binds every pointer proposed with this spec. Mirrors `bindGapsForSpec`.
 *
 * A state flip and nothing else — `criterionId` and `requirementId` were derived when the
 * pointer was minted, so there is no second place for the derivation to disagree.
 *
 * A pointer whose operation was PULLED from the draft is retired rather than left pending:
 * its criterion is never going to exist, and a `pending` row nothing can ever bind is the
 * orphan `remove_operation`'s dependency check exists to prevent one layer up.
 */
export async function bindPointersForSpec(root: string, specId: string): Promise<number> {
  const ops = await readOperations(root, { specId, includeRemoved: true });
  const byId = new Map(ops.map((o) => [o.id, o]));
  let bound = 0;
  for (const p of await readPointers(root, { state: "pending" })) {
    const op = p.operationId ? byId.get(p.operationId) : undefined;
    if (!op) continue;
    const next: Pointer = op.removed
      ? { ...p, state: "retired", retiredBy: p.declaredBy, retiredAt: now(), retiredReason: `the operation it was proposed with was pulled from ${specId}` }
      : { ...p, state: "active" };
    await writeLocalPointer(root, next);
    bound++;
  }
  return bound;
}

/**
 * Retire every pointer still PENDING against a spec's operations. The withdrawal half of
 * `bindPointersForSpec` — see the note there on why a pending pointer needs both exits.
 */
export async function retirePendingForSpec(
  root: string, specId: string, reason: string, by: Pointer["declaredBy"],
): Promise<number> {
  const ops = new Set((await readOperations(root, { specId, includeRemoved: true })).map((o) => o.id));
  let n = 0;
  for (const p of await readPointers(root, { state: "pending" })) {
    if (!p.operationId || !ops.has(p.operationId)) continue;
    await writeLocalPointer(root, { ...p, state: "retired", retiredBy: by, retiredAt: now(), retiredReason: reason });
    n++;
  }
  return n;
}

export async function declarePointer(
  root: string,
  input: {
    requirementId: string; targetKind: Pointer["target"]["kind"]; targetId: string; rationale: string;
    /** Set to make this a DETECTOR for that criterion — see `Pointer.criterionId`. */
    criterionId?: string;
  } & ActorInput,
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

  // A detector names a criterion OF THIS RULE. Checked rather than trusted, because a
  // pointer whose criterion belongs to another requirement would render under a rule it
  // says nothing about, and `criteriaFor` would never surface it.
  const criterionId = input.criterionId?.trim();
  if (criterionId) {
    const c = await readCriterion(root, criterionId);
    if (!c) return { error: `no criterion "${criterionId}"` };
    if (c.requirementId !== r.id) {
      return { error: `${criterionId} is a criterion of ${c.requirementId}, not of ${r.id} — a detector watches a check of the rule it is filed under` };
    }
  }
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

  // `legacyIndex(new Map())` and not a bare Map, so this is the same `AnchorIndex` shape
  // `context()` builds and can be handed straight to `serveWith` below.
  const live = anchors.length ? await liveHashes(root, anchors) : legacyIndex(new Map());
  const pointer: Pointer = {
    id: mint(), requirementId: r.id, ...(criterionId ? { criterionId } : {}),
    universe: universeKey(root), target, rationale,
    witnesses: anchors.map((id) => ({ anchorId: id, bodyHash: live.get(id) ?? "sha256:absent" })),
    state: "active", declaredBy: actor, declaredAt: now(),
  };

  const d = disposition(await sharePointerDeclared(root, pointer));
  if ("error" in d) return d;
  if (d.local) await writeLocalPointer(root, pointer);

  // Served against the hashes this call just computed, not against `ctx.live`. `context(root)`
  // was built with NO witnessed set, so its live index is EMPTY — every witness then resolves
  // `absent`, `comparableHashes` treats absent as comparable, and a pointer baselined one line
  // above comes back `moved: true` with every anchor drifted. `restatePointer`'s entire
  // contract is "this is the new quiet", so it was answering the opposite of its purpose.
  const served = await serveWith(root, { ...ctx, live }, pointer);
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
  // Says which state, because there are now three and "retired" was wrong for one of them.
  // A PENDING pointer cannot be re-baselined and should not be: it has no criterion yet, so
  // there is no "new quiet" to establish — ratification is what gives it something to watch.
  if (p.state !== "active") {
    return {
      error: p.state === "pending"
        ? `${p.id} is still pending — it binds when ${p.operationId ? `the spec carrying ${p.operationId}` : "its spec"} is ratified, and there is nothing to re-baseline before that`
        : `${p.id} is retired`,
    };
  }
  const ctx = await context(root);
  const anchors = watched(root, ctx, p.target);
  if (anchors === null) {
    return { error: `${p.id} points at ${p.target.kind} "${p.target.id}", which no longer resolves — retire it rather than baselining an address that is gone` };
  }
  const actor = requireActor(root, input);
  if (isErr(actor)) return actor;

  // `legacyIndex(new Map())` and not a bare Map, so this is the same `AnchorIndex` shape
  // `context()` builds and can be handed straight to `serveWith` below.
  const live = anchors.length ? await liveHashes(root, anchors) : legacyIndex(new Map());
  const next: Pointer = {
    ...p,
    witnesses: anchors.map((id) => ({ anchorId: id, bodyHash: live.get(id) ?? "sha256:absent" })),
    restatedBy: actor, restatedAt: now(),
  };
  const d = disposition(await sharePointerRestated(root, next));
  if ("error" in d) return d;
  if (d.local) await writeLocalPointer(root, next);
  // See `declarePointer`: the freshly computed hashes, not the empty index on `ctx`.
  return { ok: true, pointer: await serveWith(root, { ...ctx, live }, next) };
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
  const ps = await readPointers(root, { requirementId });
  const ctx = await context(root, witnessedBy(ps));
  return Promise.all(ps.map((p) => serveWith(root, ctx, p)));
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
  // One query and one grouping, not one query per rule — and ONE live-hash pass for every
  // pointer in the queue rather than one each. The queue is the read this record exists to
  // serve, so it is the one that must not be O(rules) round trips.
  const all = await readPointers(root, { state: "active" });
  const ctx = await context(root, witnessedBy(all));
  const byRule = new Map<string, Pointer[]>();
  for (const p of all) {
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
