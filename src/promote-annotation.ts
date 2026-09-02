/**
 * Promoting an annotation into a finding — the verb whose absence made pointers a
 * parallel system.
 *
 * `defer_finding` moves a finding to a bug and was, until now, the only promotion in the
 * tool. There was no way to say "this pointer turned out to be a defect": the only route
 * was to file a SECOND record with `report_defect` and resolve the first, which loses the
 * id, the history, the original author and the time it was raised — and leaves the
 * team's `shared_note` copy pointing at an id nothing tracks any more. That happened
 * six times in one afternoon on `Acme.React`.
 *
 * It MOVES rather than links, unlike `defer_finding`. A finding and a bug are different
 * obligations and both are real; a pointer that has been confirmed as a defect is not a
 * separate thing from the finding — it IS the finding, and leaving both would recreate
 * the two-records-for-one-defect problem `codemap unify-findings` exists to drain. This
 * is the per-record form of what `migrate-findings` does in bulk, and it shares the
 * mapper so the two cannot disagree about what an annotation becomes.
 *
 * The pull request is REQUIRED and never inferred. An annotation carries no `pr` — that
 * absence is the whole reason 51 of them are stranded on `Acme.API` — and intersecting
 * its target with a worklist is a guess that two pull requests touching one symbol make
 * wrong. A person says which.
 */

import { readAnnotations, writeAnnotations, readFinding, writeLocalFinding } from "./store.js";
import { resolveSidecar, sidecarForWrite } from "./sidecar-config.js";
import { toFinding } from "./findings-migrate.js";

export async function promoteAnnotation(
  root: string, id: string, pr: number | string,
): Promise<Record<string, unknown>> {
  const prKey = String(pr).trim();
  if (!prKey || !/^\d+$/.test(prKey)) {
    return { error: `which pull request? \`pr\` must be a number — an annotation carries none of its own, and guessing it from the target is what puts a finding on the wrong review` };
  }
  const store = await readAnnotations(root);
  const a = store.annotations.find((x) => x.id === id);
  if (!a) {
    const { idsStartingWith } = await import("./store.js");
    const hits = idsStartingWith(root, id);
    return {
      error: `no annotation "${id}"`
        + (hits.length === 1 ? ` — did you mean \`${hits[0]}\`?` : hits.length ? ` — that is the start of ${hits.length}: ${hits.join(", ")}` : "")
        + ". Findings already in the findings table do not need promoting; `defer_finding` moves one to a bug.",
    };
  }
  if (await readFinding(root, id, { pr: prKey })) {
    return { error: `${id} is already a finding on pr ${prKey}` };
  }

  const { finding, stamped } = toFinding(a, new Date().toISOString());
  const cfg = sidecarForWrite(root);
  if (cfg) {
    // Through the LOG, so the team's copy is the same record rather than a second one.
    // `filedBy`/`filedAt` carry the original attribution: this is a republication of
    // something already said, not a new claim by whoever ran the promotion.
    const { createFinding } = await import("./shared-findings.js");
    const { scopeFor } = await import("./sidecar-config.js");
    const { requireActor } = await import("./identity.js");
    const { ensureSidecar } = await import("./sidecar.js");
    const actor = requireActor(root);
    if ("error" in actor) return actor;
    await ensureSidecar(cfg.path, actor);
    await createFinding(cfg.path, scopeFor(cfg, "pr", prKey), actor, {
      id: finding.id,
      targetKind: finding.target.kind, targetId: finding.target.id,
      text: finding.text,
      ...(finding.comment ? { comment: finding.comment } : {}),
      ...(finding.severity ? { severity: finding.severity } : {}),
      ...(finding.category ? { category: finding.category } : {}),
      ...(finding.line !== undefined ? { line: finding.line } : {}),
      ...(finding.witness ? { witness: finding.witness } : {}),
      ...(finding.sourceRef ? { sourceRef: finding.sourceRef } : {}),
      filedBy: finding.author.principal || "(unrecorded)",
      filedAt: finding.createdAt,
    });
    // WRITE-THROUGH. The canonical readers query SQLite and never fold, so without this
    // the finding is in the log and in nobody's table — and the read-back below, which is
    // what stops this dropping the annotation before the finding exists, fails on a write
    // that actually succeeded. Caught by that guard rather than in production.
    const { ensureMaterialized } = await import("./materialize.js");
    const { sidecarIdentity } = await import("./sidecar-config.js");
    const { findingScope, foldFindings } = await import("./shared-findings.js");
    const { findingsProjection } = await import("./shared-projections.js");
    await ensureMaterialized(root, cfg.path, findingScope(scopeFor(cfg, "pr", prKey)),
      sidecarIdentity(cfg), foldFindings, findingsProjection);
  } else {
    await writeLocalFinding(root, finding, prKey);
  }

  // Read it back BEFORE the annotation is dropped — the rule `migrateLocalFindings`
  // follows, and for the same reason: the row is the only copy once the blob is
  // rewritten, and a write this did not verify is how a promotion loses the record.
  if (!(await readFinding(root, id, { pr: prKey }))) {
    return { error: `${id} did not read back as a finding on pr ${prKey} — nothing has been removed; fix and re-run` };
  }
  await writeAnnotations(root, store.annotations.filter((x) => x.id !== id));

  return {
    ok: true, id, pr: prKey, was: a.kind ?? "note",
    ...(stamped ? { stampedNow: true, note: "it recorded no creation time anywhere, so this promotion's is the one it has" } : {}),
    shared: !!cfg,
  };
}
