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
import { appendFile, mkdir, open, readFile, readdir } from "node:fs/promises";
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
   * The events this writer had already folded that nothing else descends from.
   *
   * The causal edge. Two events where neither reaches the other are CONCURRENT,
   * which is the only case a timestamp tiebreak is allowed to decide — and the
   * only case that can be a genuine conflict.
   *
   * A list because a writer who has pulled from two people who were apart holds
   * two heads, and a single id cannot say so: it drops one of them, and everything
   * behind it, from the record of what they knew. Logs written before this was a
   * list carry a bare string, which reads as a one-element list; their vectors are
   * a lower bound, exactly as they were when they were written.
   */
  after?: string | string[];
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
let lastMinted = 0;
export function mintId(now = Date.now()): string {
  // Monotonic WITHIN a process. Two events minted in the same millisecond would
  // otherwise be ordered only by their random suffix, so a writer's own second
  // event could sort before its first — and the causal edge it recorded would
  // point at the wrong predecessor. Across processes the random suffix still
  // breaks ties; this only removes the ambiguity a single writer can create.
  const t = now > lastMinted ? now : lastMinted + 1;
  lastMinted = t;
  return t.toString(36).padStart(10, "0") + "-" + randomBytes(5).toString("hex");
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
export function principalKey(principal: string): string {
  return createHash("sha256").update(principal).digest("hex").slice(0, 12);
}

export function shardFor(scope: string, actor: Actor): string {
  return join(scope, principalKey(actor.principal) + SHARD_EXT);
}

/**
 * Whether the shard is safe to append to as-is — nothing there, or a clean newline.
 *
 * A missing file answers true: there is nothing to run into.
 */
async function endsCleanly(file: string): Promise<boolean> {
  let fh;
  try { fh = await open(file, "r"); } catch { return true; }
  try {
    const { size } = await fh.stat();
    if (size === 0) return true;
    const last = Buffer.alloc(1);
    await fh.read(last, 0, 1, size - 1);
    return last[0] === 0x0a;
  } catch { return true; } finally { await fh.close(); }
}

/**
 * Append events to their actor's shard.
 *
 * `appendFile` with whole lines: a torn write can only ever lose or truncate the
 * LAST line, which `readShard` discards.
 *
 * Which holds only until the next append. `appendFile` resumes at the byte the
 * file ends on, so writing straight onto a torn line CONCATENATES the next event
 * onto the fragment: the glued line fails `JSON.parse` and is dropped — silently,
 * after `emit` has already handed back its id — and `git add -A` then ships the
 * glue to every teammate. In a batch only the first event is eaten, so it reads
 * as an intermittent lost write rather than as a damaged shard.
 */
export async function appendEvents(logRoot: string, scope: string, actor: Actor, events: LogEvent[]): Promise<void> {
  if (!events.length) return;
  const file = join(logRoot, shardFor(scope, actor));
  await mkdir(dirname(file), { recursive: true });
  const lead = (await endsCleanly(file)) ? "" : "\n";
  await appendFile(file, lead + events.map((e) => JSON.stringify(e)).join("\n") + "\n", "utf8");
}

/**
 * The envelope every reader depends on, checked once at the door.
 *
 * `actor.principal` is the part worth spelling out: `causality()` keys its vector
 * on it for EVERY event before any fold looks at any of them, so a line missing an
 * actor is not a record one fold branch skips — it throws, and takes every finding
 * in the scope with it. The events arrive from other people's clients, which may be
 * older or buggy, so one such line would stop the whole team reading a pull request.
 * A shared store that refuses to load is worse than one that ignores a record.
 *
 * `at` and `data` are deliberately not required: a fold branch that wants them
 * already guards, and rejecting an event for a missing timestamp would discard
 * meaning over presentation.
 */
function wellFormed(e: LogEvent): boolean {
  return !!e && typeof e.id === "string" && !!e.id
    && typeof e.kind === "string" && typeof e.subject === "string"
    && !!e.actor && typeof e.actor.principal === "string" && !!e.actor.principal.trim();
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
      if (wellFormed(e)) out.push(e);
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
/** `after` normalised. A bare string is a log written before it became a list. */
export const parentsOf = (e: LogEvent): string[] =>
  e.after === undefined ? [] : Array.isArray(e.after) ? e.after : [e.after];

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
    let i = pending.findIndex((e) => parentsOf(e).every((p) => !byId.has(p) || emitted.has(p)));
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

/**
 * Who had seen what, for a whole scope.
 *
 * The question every conflict rule actually asks is "had this writer seen that
 * write?", and for a long time the answer was an integer comparison: `after`'s
 * position in fold order versus the other write's. That is unsound. `sortEvents`
 * breaks ties by id and `mintId` stamps at WRITE time, so an edit made offline on
 * Monday sits at a LOWER fold index than everything that reached the remote on
 * Tuesday — and its author saw none of it. Three people writing while apart is
 * enough to reach the bad case; see `contest-causality.test.ts`.
 *
 * The answer is a vector clock, and it is exact rather than a lower bound because
 * shards are SINGLE-WRITER and append-only: a pull takes a whole shard, so holding
 * one of a principal's events means holding every earlier one of theirs. One
 * number per person is therefore a complete summary.
 *
 * That number is the event's ORDINAL among its principal's events in fold order,
 * not its id. Ids are only a time order within one process — the same person
 * writing from a laptop and a desktop can mint a later event with a lower id, and
 * `sortEvents` exists precisely to put those back in causal order.
 *
 * The premise has one known hole, recorded rather than papered over: `readScope`
 * dedupes because ONE PERSON CAN APPEND FROM TWO MACHINES, and those events are
 * not causally related even though this keys them under one principal. Fold order
 * then supplies an edge between them that never existed. Attribution and
 * independence are unaffected — those want the human — but exact reachability for
 * a writer working from two machines at once needs a per-writer generation id,
 * which the event format does not carry.
 *
 * Pass events in fold order (`readScope` returns them so). Events without an
 * actor are skipped rather than fatal: `readShard` rejects them at the door, and
 * a caller folding a hand-built array must not be able to crash every reader.
 */
export interface Causality {
  /** Had the writer of `from` already folded `target`? Unknown ids answer false. */
  saw(from: string, target: string): boolean;
  /** Every event nothing else descends from — what a new write records as `after`. */
  heads(): string[];
}

export function causality(sortedEvents: LogEvent[]): Causality {
  const byId = new Map(sortedEvents.map((e) => [e.id, e]));
  /** principal -> how many of their events have been folded so far. */
  const count = new Map<string, number>();
  /** event -> its 1-based ordinal among its own principal's events. */
  const seq = new Map<string, number>();
  /** event -> the highest ordinal its writer had folded, per principal. */
  const seen = new Map<string, Map<string, number>>();
  /** principal -> their most recently folded event. */
  const ownLast = new Map<string, string>();

  for (const e of sortedEvents) {
    const mine = e.actor?.principal;
    if (!mine) continue;
    const v = new Map<string, number>();
    const absorb = (id: string | undefined) => {
      const parent = id !== undefined ? byId.get(id) : undefined;
      if (!parent) return;
      for (const [p, n] of seen.get(parent.id) ?? []) if ((v.get(p) ?? 0) < n) v.set(p, n);
      const p = parent.actor.principal;
      const n = seq.get(parent.id)!;
      if ((v.get(p) ?? 0) < n) v.set(p, n);
    };
    for (const id of parentsOf(e)) absorb(id);
    // A writer's own previous event is a causal parent as surely as `after` is:
    // they had it by construction. Tracked separately because `after` names only
    // the heads, and a writer whose own last event was not one would otherwise
    // lose their own history.
    absorb(ownLast.get(mine));

    const n = (count.get(mine) ?? 0) + 1;
    count.set(mine, n);
    seq.set(e.id, n);
    seen.set(e.id, v);
    ownLast.set(mine, e.id);
  }

  return {
    saw(from, target) {
      const t = byId.get(target);
      const n = seq.get(target);
      // No ordinal means the event was skipped as malformed, so nobody saw it.
      if (!t?.actor?.principal || n === undefined) return false;
      return (seen.get(from)?.get(t.actor.principal) ?? 0) >= n;
    },
    heads() {
      const covered = new Map<string, number>();
      for (const v of seen.values()) for (const [p, n] of v) if ((covered.get(p) ?? 0) < n) covered.set(p, n);
      return sortedEvents.filter((e) => {
        const n = seq.get(e.id);
        return n !== undefined && (covered.get(e.actor!.principal) ?? 0) < n;
      }).map((e) => e.id);
    },
  };
}

/** What a new write records as `after`. See `Causality.heads`. */
export const causalHeads = (sortedEvents: LogEvent[]): string[] => causality(sortedEvents).heads();
