import { createHash } from "node:crypto";
import { type ReviewLevel, type Importance, type Complexity, type TriageSource } from "../schema.js";
import { readAnnotations } from "../store.js";
import { annotate, assignAnnotation, reviseAnnotation, resolveAnnotation } from "./annotations.js";
import { cachedTriage } from "../triage-publish.js";
import { resolveSidecar } from "../sidecar-config.js";
import { isTombstone, type SharedTriage } from "../shared-triage.js";
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


/** Marks a queued item as a stakes disagreement, so a second pass finds it. */
export const CONTESTED_TRIAGE_CATEGORY = "contested-triage";

/** The evidence line a re-file compares against — see `queueContestedTriage`. */
const evidenceKey = (text: string): string | null => /^\[evidence ([0-9a-f]{12})\]$/m.exec(text)?.[1] ?? null;

/**
 * What the two sides actually said, as a digest.
 *
 * Digest the EVIDENCE, not the rendered prose: comparing text would make a wording
 * change look like a new disagreement, re-ask a question somebody had answered, and
 * clear the outcome on the way past. Same rule `ackHole` follows.
 */
function contestDigest(t: SharedTriage): string {
  const said = [t.importance.effective, ...(t.importance.concurrent ?? [])]
    .map((r) => `${r.value}\0${r.actor.principal}`)
    .sort();
  return createHash("sha256").update([`${t.target.kind}:${t.target.id}`, ...said].join("\n")).digest("hex").slice(0, 12);
}

function contestQuestion(t: SharedTriage): string {
  const line = (r: { value: unknown; actor: { principal: string }; reason?: string; at: string }) =>
    `  - **${r.value}** — ${r.actor.principal}${r.reason ? `: ${r.reason}` : ""} (${r.at.slice(0, 10)})`;
  const all = [t.importance.effective, ...(t.importance.concurrent ?? [])];
  return [
    `[evidence ${contestDigest(t)}]`,
    "",
    "Two people disagree about this symbol's stakes, across the business-critical line —",
    "the one disagreement where being wrong is expensive. Neither saw the other's mark, so",
    "neither decision superseded the other.",
    "",
    ...all.map(line),
    "",
    `Ranking holds at **${t.importance.effective.value}** meanwhile: the higher value wins so that`,
    "nothing is under-reviewed while this is open. Settle it by triaging the symbol again now",
    "that you have seen both sides — that mark supersedes them, and this item goes with it.",
  ].join("\n");
}

/**
 * File a review-queue item for every stakes disagreement that crosses the
 * business-critical line.
 *
 * Everything else the fold resolves silently: `low` versus `important` between two
 * people who never saw each other is not worth anyone's attention, and a rule people
 * route around is worse than a simpler one they keep. This is the exception, and it
 * goes to the queue `ackHole` already files into rather than to a sticky label that
 * sits on the record until somebody notices it.
 *
 * Entered by STATE rather than by act, which is the opposite of `ackHole` and is safe
 * for the opposite reason: a contest is rare BY CONSTRUCTION — it takes two people, on
 * one symbol, disagreeing across one line — where `ackHole`'s trigger could make 985
 * docs unplaceable at once. Re-running is idempotent: one open item per target, revised
 * when the evidence moves and left alone when it has not.
 */
export async function queueContestedTriage(root: string): Promise<{ filed: number; revised: number; alreadyQueued: number; closed: number } | { error: string }> {
  const cfg = resolveSidecar(root);
  if (!cfg) return { filed: 0, revised: 0, alreadyQueued: 0, closed: 0 };
  const { value, status } = await cachedTriage(root, cfg);
  // A blocked scope may not drive writes. Its projection is explicitly not something to
  // act on, so filing from it would invent work and — worse — RESOLVING from it would
  // close a real contest because a scope nobody may read no longer reports it.
  if (status !== "complete") return { filed: 0, revised: 0, alreadyQueued: 0, closed: 0 };
  const contested = [...value.values()].filter((t): t is SharedTriage => !isTombstone(t) && !!t.importance.contested);
  const open = (await readAnnotations(root)).annotations.filter((a) =>
    a.category === CONTESTED_TRIAGE_CATEGORY && !a.resolved);
  // Indexed, not scanned per contest: `open` grows with everything ever filed and the
  // inner `find` made this O(contests x open items).
  const openByTarget = new Map(open.map((a) => [`${a.target.kind}\0${a.target.id}`, a]));

  let filed = 0, revised = 0, alreadyQueued = 0, closed = 0;
  const live = new Set<string>();
  for (const t of contested) {
    live.add(`${t.target.kind}\0${t.target.id}`);
    const text = contestQuestion(t);
    const already = openByTarget.get(`${t.target.kind}\0${t.target.id}`);
    if (already) {
      // Answered and still accurate: waiting on a person, not on an agent. Re-asking
      // would throw away an answer nobody has read.
      if (evidenceKey(already.text) === contestDigest(t)) { alreadyQueued++; continue; }
      await reviseAnnotation(root, { id: already.id, text, by: "triage" });
      await assignAnnotation(root, { id: already.id, kind: "investigate", by: "triage" });
      revised++;
      continue;
    }
    const f = await annotate(root, {
      targetKind: t.target.kind, targetId: t.target.id,
      kind: "question", category: CONTESTED_TRIAGE_CATEGORY, author: "triage", text,
      // DERIVED, so it never goes on the sidecar — see `localOnly`.
      localOnly: true,
    }) as { id?: string };
    if (!f.id) continue;
    // Filing and assigning are two writes, so an item can exist unassigned — and a
    // dedupe that answered `alreadyQueued` about something no queue shows would hide it.
    // Assigned to an agent DELIBERATELY, and it is not a settlement: `investigate` asks
    // it to look and report an `outcome`, which `reviewQueue` then treats as waiting on
    // the human. The agent proposes so the person is not deciding blind; the person
    // settles by re-triaging, which is the act that travels.
    await assignAnnotation(root, { id: f.id, kind: "investigate", by: "triage" });
    filed++;
  }

  // The reverse pass. Settlement travels as an ordinary `triage.asserted`, so every
  // clone's fold stops reporting the contest and every clone closes its own item — no
  // shared lifecycle, which is exactly why the item is local. Without this the queue
  // item outlives the disagreement, and its own text promises it "goes with" it.
  for (const [k, a] of openByTarget) {
    if (live.has(k)) continue;
    await resolveAnnotation(root, a.id, true, { actor: "agent" });
    closed++;
  }
  return { filed, revised, alreadyQueued, closed };
}
