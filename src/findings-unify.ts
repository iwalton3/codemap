/**
 * One-time: every LOCAL finding becomes a shared one, so a store with a sidecar has one
 * kind of finding rather than two.
 *
 * Two kinds was a nightmare in the precise sense that every surface had to remember
 * which it was holding, and none of them did reliably. The shared page listed both and
 * every write behind it went to the log; `defer_finding` speaks one id namespace and
 * `findings` hands out the other; a finding nobody else could see rendered exactly like
 * one everybody could. Measured on one real universe: 45 local findings across two pull
 * requests, all of them already posted to GitHub, none of them visible to the team.
 *
 * Local findings still EXIST — a store with no sidecar files them, and always could.
 * What this removes is the split state: with a sidecar configured, a finding belongs in
 * the log, and `activationGate` is what stops the two coexisting after this has run.
 *
 * ## Why a replay rather than a copy
 *
 * The fold ADOPTS a local row when it sees an event for the same `(pr, id)` — and
 * adoption REPLACES the row's body with the fold's. So publishing a finding without
 * replaying its history does not preserve that history, it destroys it: the outcome, the
 * verdicts, the posted ref and the closed state would all be dropped on the next sync,
 * silently, because the row would look like a freshly created finding. Every act the
 * local row records is therefore re-emitted in causal order.
 *
 * ## What it cannot carry, and what it does about that
 *
 * An event's actor is whoever emits it. A migration emits as the person running it, so a
 * verdict recorded by somebody else cannot be replayed as theirs — `corroborate` keys on
 * `reviewerKey`, so three people's verdicts would collapse into the publisher's one, and
 * "three models confirmed it" would become a lie told by the migration rather than by
 * anyone. Those findings are REFUSED and named instead of being quietly flattened.
 *
 * Authorship and filing time are carried as `filed`, the publisher's explicit claim
 * about what the local row said — the shape `publishBug` already uses for `filedAt`.
 */

import type { Actor } from "./schema.js";
import { requireActor, reviewerKey } from "./identity.js";
import { resolveSidecar, sidecarForWrite, scopeFor, sidecarIdentity, type SidecarConfig } from "./sidecar-config.js";
import { ensureMaterialized } from "./materialize.js";
import { findingsProjection } from "./shared-projections.js";
import { readFindings, findingsUnifiedAt, markFindingsUnified } from "./store.js";
import { ensureSidecar } from "./sidecar.js";
import {
  createFinding, corroborate, comment, promote, recordOutcome, markPosted, markUpstreamed,
  promoteToBug, remediate, setState, isClosed, foldFindings, findingScope, type SharedFinding,
} from "./shared-findings.js";

export interface UnifyResult {
  universe: string;
  local: number;
  published: string[];
  /** Findings a replay would have had to forge attribution for. Named, never flattened. */
  refused: { id: string; pr: string; reason: string }[];
  dryRun?: boolean;
  note?: string;
}

/**
 * Whether this store is in the split state — a sidecar, and findings the team cannot see.
 *
 * The RATCHET. Once a sidecar is configured, the two kinds may not coexist: a shared
 * surface that silently serves half the findings is the defect the canonical table was
 * built to end, and it came back the moment a legacy backlog was left sitting in it.
 */
export async function splitState(root: string): Promise<{ cfg: SidecarConfig; local: SharedFinding[] } | null> {
  const cfg = sidecarForWrite(root);
  if (!cfg) return null;
  const local = (await readFindings(root)).findings.filter((f) => !f.origin);
  return local.length ? { cfg, local } : null;
}

/**
 * The message a shared surface shows while the split state stands, or null.
 *
 * Deliberately NOT an error that blocks reading. A store mid-migration still has to be
 * able to look at its own findings — refusing that would make the fix unreachable from
 * the surface that reports the problem.
 */
export async function activationGate(root: string): Promise<string | null> {
  const split = await splitState(root);
  if (!split) return null;
  const prs = [...new Set(split.local.map((f) => f.pr))].sort().join(", ");
  return `${split.local.length} finding(s) on this map are not on the sidecar (pull request(s) ${prs}), `
    + "so the team is reading half of them. Run `codemap unify-findings` — it publishes them, preserving their ids and history.";
}

/** Has the migration been run here? See `findingsUnifiedAt`. */
export const unifiedAt = findingsUnifiedAt;

/**
 * Which acts a finding carries, in the order they must be re-emitted.
 *
 * Order is causal, not cosmetic: `finding.created` has to exist before anything about it
 * folds, `stateChanged` last because a closed finding's ratchet would refuse the acts
 * that came before it, and `posted` before the close for the same reason a real timeline
 * would have had it there.
 */
async function replay(logRoot: string, scope: string, actor: Actor, f: SharedFinding): Promise<void> {
  await createFinding(logRoot, scope, actor, {
    id: f.id,
    targetKind: f.target.kind,
    targetId: f.target.id,
    text: f.text,
    ...(f.comment ? { comment: f.comment } : {}),
    ...(f.severity ? { severity: f.severity } : {}),
    ...(f.category ? { category: f.category } : {}),
    ...(f.line !== undefined ? { line: f.line } : {}),
    ...(f.witness ? { witness: f.witness } : {}),
    ...(f.sourceRef ? { sourceRef: f.sourceRef } : {}),
    filedBy: f.author.principal || "(unrecorded)",
    filedAt: f.createdAt,
  });
  for (const c of f.thread) await comment(logRoot, scope, actor, f.id, c.body, c.inReplyTo);
  for (const c of f.corroboration) await corroborate(logRoot, scope, actor, f.id, c.verdict, c.rationale);
  if (f.promotion) await promote(logRoot, scope, actor, f.id);
  if (f.remediation) {
    await remediate(logRoot, scope, actor, f.id, f.remediation.state, f.remediation.detail, f.remediation.ref);
  }
  if (f.outcome) await recordOutcome(logRoot, scope, actor, f.id, f.outcome.result, f.outcome.detail, f.outcome.files);
  if (f.posted) await markPosted(logRoot, scope, actor, f.id, { key: f.posted.key, url: f.posted.url });
  if (f.upstream) await markUpstreamed(logRoot, scope, actor, f.id, { system: f.upstream.system, key: f.upstream.key, url: f.upstream.url });
  if (f.bug) await promoteToBug(logRoot, scope, actor, f.id, f.bug);
  // LAST, and through `setState` so the ratchet is the one the fold will apply: a state
  // this actor may not set is one the fold would drop, which would leave the migrated
  // finding open when the local row said it was closed.
  if (f.state !== "issued" && f.state !== "created") {
    await setState(logRoot, scope, actor, f.id, f.state, f.closed?.reason ?? "migrated from this store's local findings");
  }
}

/** Why this finding cannot be replayed honestly, or null. */
function unreplayable(f: SharedFinding, actor: Actor): string | null {
  const mine = reviewerKey(actor);
  const others = f.corroboration.filter((c) => reviewerKey(c.actor) !== mine);
  if (others.length) {
    return `carries ${others.length} verdict(s) from ${[...new Set(others.map((c) => c.actor.principal))].join(", ")}`
      + " — replaying them as you would record somebody else's review under your name";
  }
  return null;
}

export async function unifyFindings(root: string, opts: { dryRun?: boolean } = {}): Promise<UnifyResult | { error: string }> {
  const cfg = sidecarForWrite(root);
  if (!cfg) return { error: "no sidecar is configured for this universe — there is nothing to unify with" };
  const actor = requireActor(root);
  if ("error" in actor) return actor;

  const all = (await readFindings(root)).findings;
  const local = all.filter((f) => !f.origin);
  const refused: UnifyResult["refused"] = [];
  const ready: SharedFinding[] = [];
  for (const f of local) {
    const why = unreplayable(f, actor);
    if (why) refused.push({ id: f.id, pr: f.pr!, reason: why });
    else ready.push(f);
  }

  // AFTER the split and BEFORE any write. A count must not write.
  if (opts.dryRun) {
    return {
      universe: cfg.universe, local: local.length, refused, dryRun: true,
      published: ready.map((f) => f.id),
      note: `would publish ${ready.length} finding(s), preserving ids and history; `
        + `they would be attributed to ${actor.principal}, with what the local row said kept as \`filed\``,
    };
  }

  await ensureSidecar(cfg.path, actor);
  const published: string[] = [];
  for (const f of ready) {
    await replay(cfg.path, scopeFor(cfg, "pr", String(f.pr)), actor, f);
    published.push(f.id);
  }
  // Materialize every touched scope so the fold ADOPTS the local rows now, rather than
  // leaving a store that has published and still reads as split until the next sync.
  //
  // Straight to `ensureMaterialized` rather than through `ops-shared`: this module is
  // imported BY that one (for the gate), so reaching back closes a cycle —
  // `import-cycles.test.ts` catches it, dynamic imports included.
  for (const pr of [...new Set(ready.map((f) => f.pr))]) {
    await ensureMaterialized(
      root, cfg.path, findingScope(scopeFor(cfg, "pr", String(pr))),
      sidecarIdentity(cfg), foldFindings, findingsProjection,
    );
  }

  // Only when the split is actually gone. A partial run that marked itself done would
  // switch the gate off over findings the team still cannot see.
  if (!refused.length) markFindingsUnified(root, published.length);

  return {
    universe: cfg.universe, local: local.length, published, refused,
    note: refused.length
      ? `${refused.length} finding(s) left local — see \`refused\`; a person has to decide what to do with those`
      : "run `codemap sync` to send them",
  };
}

/** Closed states are worth naming in a report — a migrated backlog is mostly done work. */
export const closedCount = (fs: SharedFinding[]): number => fs.filter((f) => isClosed(f.state)).length;
