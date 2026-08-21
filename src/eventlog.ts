/**
 * The shared-state substrate: an append-only event log that git can merge.
 *
 * The requirement is not a reconciler for arbitrary concurrent mutation — that is
 * unbounded, because every new field is a new merge rule and the rules interact.
 * It is: make conflict STRUCTURALLY IMPOSSIBLE for almost everything, and make the
 * small residue LOUD instead of silently resolved.
 *
 * Two properties do that:
 *
 *   - Conflict-freedom comes from SINGLE-WRITER FILES, not from one file per
 *     event. Two actors never write the same file, so git merges by adding or
 *     extending disjoint files. One file per event would give the same property
 *     and was the first design, but it does not survive Windows: NTFS has a 4KB
 *     minimum allocation, so a 200-byte event costs 4KB on disk, and Defender and
 *     `git status` both stat every one. A busy quarter is six figures of tiny
 *     files. Bundling into line-delimited JSON takes the file count from
 *     O(events) to O(actors x shards) — the same fix Minecraft's region files were.
 *
 *   - Ordering is TOTAL and machine-independent, so every reader folds to the same
 *     state. Ids sort lexicographically by time, and `after` records what the
 *     writer had already seen, which is what gives a causal order that survives a
 *     laptop whose clock is a minute fast. Without it, that laptop's refutation
 *     silently sorts ahead of the confirmation it was answering.
 *
 * This module owns the log itself — appending, reading, ordering. What the events
 * MEAN is the fold's business, and lives with the entity being folded.
 */

import { createHash, randomBytes } from "node:crypto";
import { appendFile, mkdir, readFile, readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { Actor } from "./schema.js";

/** Line-delimited JSON: one event per line, appended, never rewritten. */
export const SHARD_EXT = ".ndjson";

export interface LogEvent {
  /** Sortable, unique, and self-describing: `<time36>-<rand>`. See `mintId`. */
  id: string;
  /** What happened. The fold dispatches on it. */
  kind: string;
  /** What it happened to — the entity id, so a fold can group without parsing `kind`. */
  subject: string;
  actor: Actor;
  at: string;
  /**
   * The highest event id this writer had already folded.
   *
   * The causal edge. Two events where neither names the other are CONCURRENT, which
   * is the only case a timestamp tiebreak is allowed to decide — and the only case
   * that can be a genuine conflict.
   */
  after?: string;
  /** Event-specific payload. Opaque here. */
  data?: Record<string, unknown>;
}

/**
 * A sortable id: milliseconds base-36, zero-padded, plus randomness.
 *
 * Padded because base-36 of a millisecond timestamp is 8 characters until the year
 * 5188 and 9 after it, and an unpadded mix would sort the longer one first — a
 * lexicographic sort is only a time sort if the width is fixed.
 */
export function mintId(now = Date.now()): string {
  return now.toString(36).padStart(10, "0") + "-" + randomBytes(5).toString("hex");
}

/**
 * Where an actor's events for a scope go.
 *
 * The principal is hashed rather than used raw: it is an email, and emails contain
 * characters that are legal in one filesystem and not another (`+` is fine, but the
 * whole string ends up in a path that has to work on Windows too). Short hash,
 * because collisions here cost nothing — a shared file is only a merge, and the
 * actor is recorded inside every line anyway.
 */
export function shardFor(scope: string, actor: Actor): string {
  const who = createHash("sha256").update(actor.principal).digest("hex").slice(0, 12);
  return join(scope, who + SHARD_EXT);
}

/**
 * Append events to their actor's shard.
 *
 * `appendFile` with whole lines: a torn write can only ever lose or truncate the
 * LAST line, which `readShard` discards. Anything already written stays valid.
 */
export async function appendEvents(logRoot: string, scope: string, actor: Actor, events: LogEvent[]): Promise<void> {
  if (!events.length) return;
  const file = join(logRoot, shardFor(scope, actor));
  await mkdir(dirname(file), { recursive: true });
  await appendFile(file, events.map((e) => JSON.stringify(e)).join("\n") + "\n", "utf8");
}

/**
 * Every event in one shard, skipping anything unparseable.
 *
 * A partial trailing line is EXPECTED, not exceptional: a process killed
 * mid-append leaves one, and so does a `merge=union` that stitched two sides. Each
 * line is self-contained, so the bad one is dropped and the rest stand. Failing the
 * whole read would mean a shared store that will not load because somebody closed a
 * laptop, which is strictly worse than losing the last event.
 */
export async function readShard(file: string): Promise<LogEvent[]> {
  let text: string;
  try { text = await readFile(file, "utf8"); } catch { return []; }
  const out: LogEvent[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      const e = JSON.parse(line) as LogEvent;
      if (e && typeof e.id === "string" && typeof e.kind === "string" && typeof e.subject === "string") out.push(e);
    } catch { /* torn or stitched line — see above */ }
  }
  return out;
}

/**
 * Every event under a scope, in the one order all readers agree on.
 *
 * Deduped by id, because `merge=union` can legitimately produce the same line
 * twice: it is the case sharding does not cover, one person appending from two
 * machines. Duplicates are identical by construction (an id is minted once), so
 * dropping the later sighting loses nothing.
 */
export async function readScope(logRoot: string, scope: string): Promise<LogEvent[]> {
  const dir = join(logRoot, scope);
  let names: string[];
  try { names = await readdir(dir); } catch { return []; }
  const seen = new Set<string>();
  const all: LogEvent[] = [];
  for (const n of names.filter((n) => n.endsWith(SHARD_EXT)).sort()) {
    for (const e of await readShard(join(dir, n))) {
      if (seen.has(e.id)) continue;
      seen.add(e.id);
      all.push(e);
    }
  }
  return sortEvents(all);
}

/**
 * Causal order first, then id.
 *
 * A stable topological pass: an event waits for the one it names in `after` when
 * that event is present. Ties — genuinely concurrent events, and events whose
 * `after` is not in this scope — fall back to id, which is time-then-random and
 * therefore total. A cycle cannot arise from honest writers (`after` names an id
 * that already existed) but the queue drains regardless, because anything still
 * blocked at the end is emitted in id order rather than dropped.
 */
export function sortEvents(events: LogEvent[]): LogEvent[] {
  const byId = new Map(events.map((e) => [e.id, e]));
  // Sorted by id, so "first eligible" is always "lowest id that is eligible".
  const pending = [...events].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const emitted = new Set<string>();
  const out: LogEvent[] = [];
  while (pending.length) {
    // Re-scan from the start every time rather than sweeping once: emitting an
    // event can make an EARLIER-id one eligible, and a single greedy pass would
    // leave it behind whatever came after. That still produces a causally valid
    // order, but not the same one twice from differently-ordered input — and
    // "every reader folds identically" is the whole point.
    let i = pending.findIndex((e) => !(e.after && byId.has(e.after) && !emitted.has(e.after)));
    // Nothing eligible means a cycle, which honest writers cannot produce (`after`
    // names an id that already existed). Take the lowest id and carry on: a log
    // that refuses to load is worse than one that orders a cycle arbitrarily.
    if (i < 0) i = 0;
    const [e] = pending.splice(i, 1);
    out.push(e!);
    emitted.add(e!.id);
  }
  return out;
}

/** The highest id in a set of events — what the next write should record as `after`. */
export function highWatermark(events: LogEvent[]): string | undefined {
  let hi: string | undefined;
  for (const e of events) if (hi === undefined || e.id > hi) hi = e.id;
  return hi;
}
