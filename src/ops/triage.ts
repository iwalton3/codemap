import { type ReviewLevel, type Importance, type Complexity, type TriageSource } from "../schema.js";
import { changedSince as reviewsChangedSince, type Attestation } from "../reviews.js";
import { setTriage as triageSet, clearTriage as triageClear, reviewTriageFor, deriveTriage as triageDerive, tripwires as triageTripwires, triageDrift } from "../triage.js";

/** Set/raise stakes on a target (ratchet-enforced). See docs/triage.md. */
export async function setTriage(
  root: string,
  input: { targetKind: "node" | "anchor"; targetId: string; importance?: Importance; complexity?: Complexity; source: TriageSource; reason?: string; tripwire?: boolean },
) {
  return triageSet(root, input);
}

/**
 * One anchor's review/viewed marks and severity, exactly as the walkthrough
 * renders them. Returned by the review write so a sign-off can update the symbol
 * in place — re-deriving the whole PR story to learn one symbol's new state was
 * what made signing feel slow on a large pull request.
 */
export async function anchorMark(root: string, id: string, opts: { ref?: string } = {}) {
  const rt = await reviewTriageFor(root, [{ kind: "anchor", id }], { ref: opts.ref });
  const e = rt.get(`anchor:${id}`);
  return {
    id,
    severity: e?.triage.severity ?? "untriaged",
    reviewed: e?.review.code.state === "reviewed",
    viewed: e?.viewed.code.state === "reviewed",
    review: e?.review.code,
    viewedMark: e?.viewed.code,
  };
}

/** Clear a target's stakes (back to untriaged). */
export async function clearTriage(root: string, input: { targetKind: "node" | "anchor"; targetId: string }) {
  return triageClear(root, input);
}

/** Graph-derive `likely` stakes across the whole map (regenerable). See docs/triage.md Phase 2. */
export async function deriveTriage(root: string) {
  return triageDerive(root);
}

/** Tripwires: armed watch-marks whose code has moved (`fired`) + the armed count. */
export async function tripwires(root: string) {
  return triageTripwires(root);
}

/** Triage marks whose witnessed code drifted — re-triage candidates. */
export async function triageDriftList(root: string) {
  return triageDrift(root);
}

/**
 * Targeted diff — which anchors covered by a target have moved since the human last
 * `viewed` / `signed` it. The read behind "what changed since I last looked?".
 */
export async function changedSince(
  root: string,
  /** `ref` says what "now" is — pass the PR head when asking about a PR sign-off. */
  input: { targetKind: "node" | "anchor"; targetId: string; level: ReviewLevel; attestation: Attestation; ref?: string },
) {
  return reviewsChangedSince(root, { kind: input.targetKind, id: input.targetId }, { level: input.level, attestation: input.attestation, ref: input.ref });
}
