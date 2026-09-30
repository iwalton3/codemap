/**
 * Where a write just went, said truthfully for this session: staged in its transaction, sent to
 * the team (a single write syncs inline), or recorded in a sidecar with no remote. Its own
 * module so the ops that report it can import it without importing each other.
 */
import { resolveSidecar } from "./sidecar-config.js";
import { transportsRemotely } from "./sidecar.js";
import { sessionRow } from "./sync-queue.js";
import { currentSession } from "./sync-session.js";

export function deliveryNote(root: string, many = false): string {
  const cfg = resolveSidecar(root);
  const it = many ? "them" : "it";
  if (!cfg) return "recorded on this machine only — there is no sidecar";
  if (sessionRow(cfg.path, currentSession().session)?.tx) return `staged in this session's transaction — \`sync\` pushes ${it}, all or none`;
  return transportsRemotely(cfg.path) ? "sent to the team" : "recorded in this sidecar, which has no remote";
}
