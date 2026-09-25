/** Projected questionnaire retrieval. Remote arrival is an explicit sidecar sync. */
import { createHash } from "node:crypto";
import { readStoreMeta, SIDECAR_LINEAGE, type SidecarMark } from "../store.js";
import { resolveSidecar } from "../sidecar-config.js";
import { questionnaireList, questionnaireDetail, decisionRound } from "./decisions.js";

export async function questionnaireRead(root: string, id: string, principal?: string) {
  const detail = await questionnaireDetail(root, id, principal);
  if ("error" in detail && detail.error) return { error: detail.error, status: detail.status };
  const published = detail as Exclude<typeof detail, { error: string }>;
  const result = await decisionRound(root, published.round);
  if ("error" in result) return { error: result.error, status: published.status };
  const round = result as Exclude<typeof result, { error: string }>;
  return { ...published,
    history: round.decisions,
    pending: {
      awaitingReading: round.awaitingReading,
      readingsInDispute: round.readingsInDispute,
      waitingOnYou: round.waitingOnYou,
      held: round.held,
      intentCandidates: round.intentCandidates,
    },
  };
}

export { questionnaireList };

/** The cursor hashes projected content and scope health, never wall-clock or sync metadata. */
export async function questionnaireStatus(root: string, id: string, cursor?: string, principal?: string) {
  const detail = await questionnaireRead(root, id, principal);
  if ("error" in detail && detail.error) return { error: detail.error, status: detail.status };
  const read = detail as Exclude<typeof detail, { error: string }>;
  const cfg = resolveSidecar(root);
  const lineage = readStoreMeta<SidecarMark>(root, SIDECAR_LINEAGE)?.lineage;
  const stored = cfg && readStoreMeta<{ at: string; lineage?: string; mode: string; blocked: unknown[] }>(root, `sidecar_sync:${cfg.universe}`);
  const lastSync = stored && lineage && stored.lineage === lineage ? stored : null;
  const nextCursor = createHash("sha256").update(JSON.stringify(read)).digest("hex");
  return { ok: true as const, cursor: nextCursor, changed: cursor !== nextCursor,
    lastSync, syncState: read.status.status === "blocked" ? "blocked" as const : lastSync ? "last-synced" as const : "stale" as const,
    remoteFreshness: "unknown-until-sync" as const, requiresSync: true as const, ...read };
}

/** Bounded LOCAL observation; it never starts a pull, push, or background job. */
export async function waitQuestionnaireStatus(root: string, id: string, cursor: string, timeoutMs: number, principal?: string) {
  if (!/^[a-f0-9]{64}$/.test(cursor)) return { error: "wait needs the cursor returned by questionnaire status" };
  if (!Number.isInteger(timeoutMs) || timeoutMs < 0 || timeoutMs > 60_000)
    return { error: "wait must be between 0 and 60000 milliseconds" };
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const status = await questionnaireStatus(root, id, cursor, principal);
    if ("error" in status) return status;
    if (status.status.status === "blocked" || status.changed) return status;
    const remaining = deadline - Date.now();
    if (remaining <= 0) return { ...status, timedOut: true as const };
    await new Promise((resolve) => setTimeout(resolve, Math.min(500, remaining)));
  }
}
