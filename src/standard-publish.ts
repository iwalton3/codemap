/**
 * Publishing the standard, and folding it back into rows.
 *
 * Its own module for the structural reason `triage-publish.ts` gives: the record modules
 * have to publish, and `ops-shared.ts` reaches down into `shared-projections.ts`, so a
 * publish call from `requirements.ts` up to the op surface would close a cycle. Everything
 * here sits UNDER the ops: it imports the fold, the projection and the sidecar directly
 * and never the op surface.
 *
 * The rule every writer below follows, which is `mirrorTriage`'s and is not negotiable:
 *
 *   configured: false            → no sidecar. Keep the local row; that is the whole story.
 *   configured: true, shared: true  → the act is in the log. Do NOT write a local row —
 *                                     the fold writes it, and a local one would be erased
 *                                     by the next sync and invisible until then.
 *   configured: true, shared: false → a FAILED APPEND. The caller must fail. A local row
 *                                     here fabricates causality that no clone can see.
 */

import type {
  Acknowledgement, Actor, Audit, BugWitness, Operation, Pointer, PopulationPredicate, Problem,
  ScrubPolicy, Spec, VacuityCheck,
} from "./schema.js";
import type { ScopeDiagnostic } from "./eventlog.js";
import { resolveSidecar, sidecarIdentity, type SidecarConfig } from "./sidecar-config.js";
import { requireActor } from "./identity.js";
import { ensureSidecar } from "./sidecar.js";
import { publishProvisionalAudit } from "./provisional.js";
import { readCached, readCachedMerged, ensureMaterialized } from "./materialize.js";
import type { LogEvent } from "./eventlog.js";
import { standardProjection } from "./shared-projections.js";
import {
  foldStandard, standardScope, lawScope, isLawEvent, publishSpecDrafted, publishOperation, publishSpecRatified,
  publishAckGranted, publishAckReleased, publishAudit, publishProblemRaised, publishAdjudication,
  publishSpecWithdrawn,
  publishVacuityCheck, publishPointerDeclared, publishPointerRestated, publishPointerRetired,
  publishPopulationPinned, publishScrubPolicy,
} from "./shared-standard.js";

/** One universe's standard, through the cache. */
/**
 * The standard: law (workspace) + evidence (this universe), folded together.
 *
 * Stored under the universe's own standard scope, so `source_scope` and every ownership
 * guard built on it are exactly as they were. The fingerprint covers both scopes, so an
 * append to either re-folds. See `docs/cross-universe-standard.md`.
 */
export const cachedStandard = (root: string, cfg: { path: string; universe: string }) =>
  readCachedMerged(
    root, cfg.path, [lawScope(), standardScope(cfg.universe)], standardScope(cfg.universe),
    sidecarIdentity(cfg),
    (events: LogEvent[], { readable }: { readable: Set<string> }) =>
      foldStandard(events, { evidence: readable.has(standardScope(cfg.universe)) }),
    standardProjection,
  );

/**
 * Fold this universe's standard into rows, now.
 *
 * Write-through. Without it a ratification is in the log and in nobody's table until the
 * next sync, so the call that made it reads back the old standard.
 *
 * Failure here is NOT failure of the write: the event is appended and durable, and the
 * next read or sync folds it. Reported, never thrown past the caller.
 */
export async function materializeStandard(root: string, cfg: SidecarConfig): Promise<boolean> {
  try { await cachedStandard(root, cfg); return true; } catch { return false; }
}

/**
 * Why the standard this read is about to answer from may NOT be presented as the team's.
 *
 * Two reasons, kept apart because the repair differs: `blocked` is the log itself refusing
 * to be read as settled (a fork, a duplicate id, a broken chain — `diagnostic` says which
 * and names the evidence), and `stale` is the rows being behind a log that is fine.
 *
 * There is no `complete` member on purpose. The value is `undefined` when the answer is
 * authoritative, so an ordinary read keeps the shape it had — a status on every response
 * for every healthy team is noise, and noise is what a warning has to outrank.
 */
export type StandardScope =
  | { status: "blocked"; diagnostic?: ScopeDiagnostic }
  | { status: "stale"; detail: string };

/**
 * Whether the standard may be answered from — for a read that is about to query the rows.
 *
 * The hole this closes: nothing on the read path ever asked. `materializeStandard` reduces
 * the verdict to a boolean and runs only on the WRITE path, so a `standard/` scope blocked
 * by a fork still served projection rows that looked exactly like a healthy team's. §7 of
 * `docs/sidecar-architecture.md` is a fail-CLOSED rule, and the one way it fails in
 * practice is a surface that never looked — which was this one.
 *
 * Fails closed itself: a sidecar that cannot be read at all is reported non-authoritative
 * rather than passed over, because the alternative is answering as the team from rows
 * nothing just checked.
 *
 * No sidecar is not a warning. Local rows with no log behind them ARE the whole story.
 */
export async function standardScopeWarning(root: string): Promise<StandardScope | undefined> {
  const cfg = resolveSidecar(root);
  if (!cfg) return undefined;
  try {
    // `cachedStandard`, NOT a single-scope `ensureMaterialized`. This read used to fold
    // `standard/<universe>` on its own and write the result under the same key the merged
    // fold uses — so every read silently replaced the standard with a LAW-LESS one, and
    // the requirements vanished from the rows a moment after they were ratified. One
    // entity folded from two scopes has to have exactly one materializer.
    const { fresh, ...st } = await cachedStandard(root, cfg);
    if (st.status !== "complete") {
      return { status: "blocked", ...(st.diagnostic ? { diagnostic: st.diagnostic } : {}) };
    }
    // `fresh: false` means somebody is appending faster than the fold can keep up, so the
    // rows describe an input set already superseded. `sharedFindings` discards this; here
    // it is reported, because the standard's reads are the ones that say a rule CONFORMS.
    if (!fresh) return { status: "stale", detail: "the rows are behind the log — the next sync will retry" };
    return undefined;
  } catch (e: any) {
    return { status: "stale", detail: `the shared standard could not be read: ${e?.message ?? e}` };
  }
}

export interface Shared {
  shared: boolean;
  configured: boolean;
  folded?: boolean;
  error?: string;
  /**
   * The act left this machine as a commit-discovered DOCUMENT rather than as an event —
   * currently only a provisional audit. It is not in the log, so nothing folds it and the
   * local row is still the caller's to write; see `provisional.ts`.
   */
  document?: boolean;
  /**
   * Why it stayed here, with a sidecar configured and nothing wrong. Not an error — the
   * write succeeded — but the author asked for a team and did not get one, so it is said
   * out loud rather than inferred from the absence of a document.
   */
  reason?: string;
}

/** Not shared, and nothing is wrong with that — there is no sidecar. */
export const localOnly: Shared = { shared: false, configured: false };

/**
 * Append to the sidecar, choosing the half this act belongs in.
 *
 * `scope` defaults to the EVIDENCE half — an observation of this universe's code. Law
 * (specs, operations, criteria, and a `gap`) goes to the workspace scope, so a rule
 * governing several repositories is stated once. See `docs/cross-universe-standard.md`.
 */
async function share(
  root: string, emit: (logRoot: string, scope: string, actor: Actor) => Promise<unknown>,
  scope?: string,
): Promise<Shared> {
  const cfg = resolveSidecar(root);
  if (!cfg) return localOnly;
  const actor = requireActor(root);
  if ("error" in actor) return { shared: false, configured: true, error: actor.error };
  try {
    await ensureSidecar(cfg.path, actor);
    await emit(cfg.path, scope ?? standardScope(cfg.universe), actor);
  } catch (e: any) {
    return { shared: false, configured: true, error: `sidecar append failed: ${e?.message ?? e}` };
  }
  return { shared: true, configured: true, folded: await materializeStandard(root, cfg) };
}

export const shareSpecDrafted = (root: string, spec: Spec): Promise<Shared> =>
  share(root, (l, s, a) => publishSpecDrafted(l, s, a, spec), lawScope());

export const shareOperation = (root: string, op: Operation): Promise<Shared> =>
  share(root, (l, s, a) => publishOperation(l, s, a, op), lawScope());

export const shareSpecRatified = (
  root: string, specId: string, at: string, witnesses: Record<string, BugWitness[]>,
  operations: string[],
): Promise<Shared> => share(root, (l, s, a) => publishSpecRatified(l, s, a, specId, at, witnesses, operations), lawScope());

export const shareSpecWithdrawn = (
  root: string, specId: string, at: string, reason: string,
): Promise<Shared> => share(root, (l, s, a) => publishSpecWithdrawn(l, s, a, specId, at, reason), lawScope());

/**
 * A GAP is law; DEBT is evidence.
 *
 * A gap says nothing satisfies this rule yet — a statement about the whole system, so it
 * belongs beside the rule. A debt says this code does not conform and we accept that, which
 * is a claim about ONE implementation: law-scoping it would let accepting debt for the
 * React app silence the rule for the API, which is the "declare the rule not yet
 * applicable" escape the mint-time asymmetry exists to close.
 */
export const shareAckGranted = (root: string, ack: Acknowledgement): Promise<Shared> =>
  share(root, (l, s, a) => publishAckGranted(l, s, a, ack), ack.basis === "gap" ? lawScope() : undefined);

/**
 * Released into the half the grant went to — the caller passes the basis because only it
 * has read the record. Releasing a gap into the evidence scope would leave the grant in the
 * law scope with its release somewhere a clone folding only law can never see it, so the
 * acknowledgement would read `active` for ever on exactly the machines that matter.
 */
export const shareAckReleased = (
  root: string, id: string, at: string, reason: string, basis: Acknowledgement["basis"],
): Promise<Shared> =>
  share(root, (l, s, a) => publishAckReleased(l, s, a, id, at, reason), basis === "gap" ? lawScope() : undefined);

/**
 * An audit of THE CODEBASE enters the log. A provisional one travels as a document.
 *
 * The old carve-out was total — a provisional audit stayed on the machine that took it —
 * and it went too far. Broadcasting a branch finding as the team's problem is what had to
 * be avoided; making it *invisible to the reviewer of that branch* was collateral, and it
 * left promotion available only to the author. So it travels, as a commit-discovered
 * document that nothing folds: it reaches the teammate reading that commit and it reaches
 * no clone's `conformance()`, because there is no fold to write a row with.
 *
 * `dirty` decides whether the document may exist at all — see `publishProvisionalAudit`.
 * Reported as an ERROR when the write fails with a sidecar configured, the same rule the
 * header states for a failed append: a finding the author believes is shared and is not is
 * the failure this whole module is arranged against.
 */
export async function shareAudit(root: string, audit: Audit, opts: { dirty: boolean }): Promise<Shared> {
  if (!audit.provisional) return share(root, (l, s, a) => publishAudit(l, s, a, audit));
  // Asked HERE rather than left to the publisher, so that everything below is a store
  // that has a team — which is what makes `reason` worth reporting instead of noise.
  if (!resolveSidecar(root)) return localOnly;
  const p = await publishProvisionalAudit(root, audit, opts);
  if (p.published) return { shared: false, configured: true, document: true };
  if ("error" in p) return { shared: false, configured: true, error: p.error };
  // Nothing that could honestly be published. The local row is the whole story, and the
  // reason travels back to the caller: a finding the author believes their team can see
  // and that stayed on this machine is the failure this module is arranged against.
  return { ...localOnly, reason: p.reason };
}

/**
 * A vacuity check always travels.
 *
 * Unlike an audit, it says nothing about whether the codebase conforms — it says whether a
 * CHECK can fail, which is a property of a check that every clone shares. There is no
 * provisional carve-out to make: the branch a demonstration was performed on does not
 * change what it established, and the witnesses say which code it established it about.
 */
export const shareVacuityCheck = (root: string, check: VacuityCheck): Promise<Shared> =>
  share(root, (l, s, a) => publishVacuityCheck(l, s, a, check));

/**
 * A pointer always travels. It says where to LOOK, which is a fact about the standard
 * rather than an observation of one branch's code, and it can reach no verdict that a
 * provisional carve-out would need to hold back.
 */
export const sharePointerDeclared = (root: string, p: Pointer): Promise<Shared> =>
  share(root, (l, s, a) => publishPointerDeclared(l, s, a, p));

export const sharePointerRestated = (root: string, p: Pointer): Promise<Shared> =>
  share(root, (l, s, a) => publishPointerRestated(l, s, a, p.id, p.restatedAt!, p.witnesses));

export const sharePointerRetired = (root: string, p: Pointer): Promise<Shared> =>
  share(root, (l, s, a) => publishPointerRetired(l, s, a, p.id, p.retiredAt!, p.retiredReason ?? ""));

/**
 * A pin travels UNLESS it is provisional, carrying the pin it replaces.
 *
 * A lint enumerates whatever is checked out, so a pin from a feature branch is that
 * branch's population and not the team's — publishing it would release a gap on evidence
 * that may never merge, and would make a later honest pin from the default branch read as
 * narrowing. The same rule `shareAudit` follows, for the same reason. What a rule ranges over is a fact about the
 * standard rather than about one branch's code, and the supersession has to ride WITH it —
 * two events would let a clone fold half and hold two active populations for one rule.
 */
export const sharePopulationPinned = (
  root: string, pin: PopulationPredicate, supersedes?: string,
): Promise<Shared> => pin.provisional
  ? Promise.resolve(localOnly)
  : share(root, (l, s, a) => publishPopulationPinned(l, s, a, pin, supersedes));

/**
 * The schedule travels. Coverage is a property of the TEAM's standard — "everything is
 * looked at every T" is not a claim one clone can make alone — and a covering audit
 * somebody else performed is exactly the work this clone then does not have to repeat.
 * The audits themselves travel by `shareAudit`, which is the point of folding the two.
 */
export const shareScrubPolicy = (root: string, policy: ScrubPolicy): Promise<Shared> =>
  share(root, (l, s, a) => publishScrubPolicy(l, s, a, policy));

/** Same rule: a problem raised from a provisional audit is this branch's, not the team's. */
export const shareProblemRaised = (root: string, problem: Problem): Promise<Shared> =>
  problem.provisional ? Promise.resolve(localOnly) : share(root, (l, s, a) => publishProblemRaised(l, s, a, problem));

/**
 * An adjudication travels only if the problem it decides did.
 *
 * Deciding which side moves on a branch-local non-conformance is a real act and stays with
 * the problem it is about — publishing it alone would arrive at a clone that has no such
 * problem to attach it to.
 */
export const shareAdjudication = (
  root: string, problem: Problem, disposition: string, reason: string, at: string,
): Promise<Shared> =>
  problem.provisional
    ? Promise.resolve(localOnly)
    : share(root, (l, s, a) => publishAdjudication(l, s, a, problem.id, disposition, reason, at));

/**
 * What a caller must do with a `Shared` before writing anything locally.
 *
 * Returns an error when the append failed with a sidecar configured — the one case where
 * the caller has to abandon the write entirely — and `local: true` when there is nothing
 * to publish to and the row is the whole story.
 */
export function disposition(s: Shared): { error: string } | { local: boolean } {
  // A document is not in the log, so nothing will fold a row for it and the local row is
  // the caller's to write — the reverse of the `shared: true` case, and the reason
  // `local` cannot simply be `!s.configured` any more.
  if (s.document) return { local: true };
  if (s.configured && !s.shared) {
    return {
      error: s.error
        ?? "the sidecar is configured but the act could not be appended — refusing to write a local row, "
          + "which would be erased by the next sync and invisible until then",
    };
  }
  return { local: !s.configured };
}
