/**
 * What happens when a write's inline sync also brought teammates' events down. A sync that
 * pulls must fold what arrived, or the projection lags the tree it describes; `sharedSync`
 * always did this, and now every write is a sync. The ops layer knows which universes sit on
 * a sidecar and registers the handler — the write path knows only the sidecar's path.
 */
type Handler = (logRoot: string) => Promise<void>;
let handler: Handler | null = null;

export function onArrivals(h: Handler): void { handler = h; }

export async function arrived(logRoot: string): Promise<void> {
  if (handler) await handler(logRoot);
}
