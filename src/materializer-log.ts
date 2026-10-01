/**
 * When each fold version reached the team: the first sync after an upgrade logs it (owner, C16:
 * "Logging when the materializer bump in the log happens now is an easy way to make this cheaper
 * later" — a validation a later version adds can then be scoped to the events after its bump).
 *
 * An act, so it has an honest actor and position: the principal whose sync first carries the new
 * version, at that sync. No fold reads this scope; a build that predates it ignores the scope.
 */
import { causalHeads, EVENT_SCHEMA, mintId, registerDoor, registerKinds, SIDECAR_PROTOCOL, type LogEvent, type StagedEvent } from "./eventlog.js";
import { MATERIALIZER_VERSION } from "./materializer-version.js";
import type { Actor } from "./schema.js";

export const MATERIALIZER_SCOPE = "materializer";
const KIND = "materializer.bumped";

const logged = (events: LogEvent[]): number =>
  Math.max(0, ...events.filter((e) => e.kind === KIND).map((e) => Number((e.data as { version?: unknown } | undefined)?.version) || 0));

/** The event this sync should carry, or null when the log already records this version. */
export function bumpEvent(events: LogEvent[], actor: Actor): StagedEvent | null {
  const from = logged(events);
  if (from >= MATERIALIZER_VERSION) return null;
  return {
    sidecarProtocol: SIDECAR_PROTOCOL, eventSchema: EVENT_SCHEMA, id: mintId(), kind: KIND, subject: `v${MATERIALIZER_VERSION}`,
    actor, at: new Date().toISOString(), after: causalHeads(events), data: { version: MATERIALIZER_VERSION, ...(from ? { from } : {}) },
  };
}

const ours = (scope: string) => scope === MATERIALIZER_SCOPE;
registerKinds(ours, [KIND]);
registerDoor(ours, () => (events, minted) => {
  const prior = logged(events.filter((e) => e.id !== minted.id));
  const version = Number((minted.data as { version?: unknown } | undefined)?.version) || 0;
  return { refused: version > prior ? [] : [{ id: minted.id, why: `version ${version} is already logged (${prior})` }] };
});
