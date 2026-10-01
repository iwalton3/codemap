/** The migration's splice (scripts/migrate-sidecar.mjs, plan 7.1), here so the suite can hold it. */
import { GENESIS, type LogEvent } from "./eventlog.js";

/**
 * Splice dropped events out of the causal record so every kept event's read set (`readSets`) is
 * what it was, minus the dropped events themselves. A merge-era event's read edges are its
 * `after` AND its own writer's previous event (eventlog.ts `readEdges`), so a dropped event is
 * replaced by both of its edges, followed through drops; and a kept event whose `writerPrev` was
 * dropped takes the nearest kept predecessor AND the dropped one's edges into its `after`.
 * Measured: without this, contests appeared on the live sidecar that were not there.
 */
export function splice(all: LogEvent[], events: LogEvent[], droppedIds: ReadonlySet<string>): LogEvent[] {
  const byId = new Map(all.map((e) => [e.id, e]));
  const edges = (e: LogEvent | undefined): string[] => {
    const p = e?.writerPrev && e.writerPrev !== GENESIS ? byId.get(e.writerPrev) : undefined;
    return [...(e?.after ?? []), ...(p && p.writer === e!.writer ? [p.id] : [])];
  };
  const heads = (id: string, seen = new Set<string>()): string[] => {
    if (!droppedIds.has(id)) return [id];
    if (seen.has(id)) return [];
    seen.add(id);
    return edges(byId.get(id)).flatMap((p) => heads(p, seen));
  };
  const prev = (id: string): string => { let p = id; while (droppedIds.has(p)) p = byId.get(p)?.writerPrev ?? GENESIS; return p; };
  return events.map((e) => {
    const after = (e.after ?? []).flatMap((p) => heads(p));
    if (e.writerPrev && droppedIds.has(e.writerPrev)) after.push(...heads(e.writerPrev));
    return { ...e, after: [...new Set(after)], writerPrev: e.writerPrev ? prev(e.writerPrev) : e.writerPrev };
  });
}
