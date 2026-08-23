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
import { appendFile, mkdir, open, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import type { Actor } from "./schema.js";
import { withSidecarLock } from "./lock.js";

/** Line-delimited JSON: one event per line, appended, never rewritten. */
export const SHARD_EXT = ".ndjson";

/**
 * The envelope's own version, and the payload's, kept apart on purpose.
 *
 * `sidecarProtocol` governs the fields THIS module reads — ids, ordering, the
 * causal edge, the writer chain. `eventSchema` governs `data`, which this module
 * never looks inside. They move independently: adding a field to a finding is not
 * a reason for a reader to distrust the ordering it can still do perfectly well.
 *
 * A reader that meets a HIGHER number cannot know what it is missing, so §7 of
 * PROPOSAL-provenance.md makes that `blocked` rather than a partial answer. A
 * LOWER number, or none at all, is an older writer and reads fine — every field
 * added here has been optional for exactly that reason.
 */
export const SIDECAR_PROTOCOL = 1;
export const EVENT_SCHEMA = 1;

/** The predecessor named by the first event of a `(scope, writer)` chain. */
export const GENESIS = "GENESIS";

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
  after: string[];
  /**
   * WHICH CLONE wrote this — a random id minted on first use, never derived from
   * the principal, the hostname, or anything reconstructible.
   *
   * The causal vector compresses each writer's history to one ordinal, which is
   * only sound if a writer is one sequential thing. Keyed on `actor.principal` it
   * is not: one person on two machines produces genuinely concurrent events, and
   * fold order then supplies an edge between them that never existed. That is not
   * a theoretical hole — it silently suppresses a real contest between two OTHER
   * people. See `causality`, and PROPOSAL-provenance.md §4.
   *
   * Optional, because every event written before this is missing it and must keep
   * folding. Those fall back to the principal, which is exactly today's behaviour.
   *
   * Attribution and independence keep using `actor.principal`: they want the human,
   * and always did.
   */
  writer: string;
  /**
   * The previous event of THIS `(scope, writer)` chain, or `GENESIS` for the first.
   *
   * The lock prevents two processes on one clone from forking a chain; this detects
   * the case no lock can reach — two clones holding one writer id, which a machine
   * image or a synced home directory produces by ordinary means. Two distinct events
   * naming the same predecessor are a fork.
   *
   * **Including two naming `GENESIS`**, which is the clause worth stating twice: two
   * clones copied BEFORE either had written anything both open their chain with
   * `GENESIS`, and an implementation that treats the first event as unremarkable
   * lets exactly that pair through. See `detectForks`.
   *
   * The chain key is per SCOPE, not global, because `readScope` reads one scope at
   * a time and a global predecessor could not be validated from there.
   *
   * Optional: events written before this exist and must keep folding. They are not
   * judged rather than assumed innocent — an absent chain says nothing either way.
   */
  writerPrev: string;
  /** Governs this envelope. Absent means an older writer; see `SIDECAR_PROTOCOL`. */
  sidecarProtocol: number;
  /** Governs `data` only. Absent means an older writer; see `EVENT_SCHEMA`. */
  eventSchema: number;
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

/**
 * Where a WRITER's events for a scope go.
 *
 * By writer rather than by principal, so one person on two machines writes two
 * files. Nothing then union-merges anyone's shard, `readScope`'s dedupe stops
 * having a case to cover, and prefix-closure per shard is true rather than assumed.
 * See `LogEvent.writer`.
 *
 * A writer id is already opaque and path-safe, so it is used as-is; the principal
 * had to be hashed because it is an email and emails hold characters that are legal
 * in one filesystem and not another. Principal-named shards are not a case any more —
 * nothing ever wrote one outside this branch, and the protocol-1 freeze stopped
 * keeping faith with them. `readScope` still takes every `*.ndjson` in the directory
 * because that is simply how a directory is read, not as an accommodation.
 */
export function shardFor(scope: string, writer: string): string {
  return join(scope, writer + SHARD_EXT);
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
export async function appendEvents(logRoot: string, scope: string, writer: string, events: LogEvent[]): Promise<void> {
  if (!events.length) return;
  const file = join(logRoot, shardFor(scope, writer));
  await mkdir(dirname(file), { recursive: true });
  const lead = (await endsCleanly(file)) ? "" : "\n";
  await appendFile(file, lead + events.map((e) => JSON.stringify(e)).join("\n") + "\n", "utf8");
}

/**
 * This clone's writer id — random, minted once, never derived from anything.
 *
 * Kept in the sidecar's own GIT DIRECTORY, which is the one durable place a clone
 * has that git can never track: the sidecar syncs with `git add -A`, so anything in
 * the work tree would be pushed to the whole team, and a writer id is the one value
 * that must NOT be shared — two clones holding one id is precisely the fork
 * `writerPrev` exists to detect.
 *
 * A root with no resolvable git directory (a scratch sidecar in a test) gets an
 * id for the life of the process only. Nothing is written where a later `git init`
 * could pick it up.
 *
 * MINT UNDER THE LOCK. Two processes reaching a cold cache together would mint two
 * ids for one clone, which is the same fork by a shorter route — `emitEvent` holds
 * `withSidecarLock` across this and the append, which is what §4 means by the lock
 * covering "selecting the writer".
 */
const writers = new Map<string, string>();

async function gitDirOf(root: string): Promise<string | null> {
  const dot = join(root, ".git");
  try {
    const st = await stat(dot);
    if (st.isDirectory()) return dot;
    // A linked worktree: `.git` is a file holding `gitdir: <path>`.
    const text = await readFile(dot, "utf8");
    const m = /^gitdir:\s*(.+)$/m.exec(text);
    return m ? resolve(root, m[1]!.trim()) : null;
  } catch { return null; }
}

export async function writerFor(logRoot: string): Promise<string> {
  const hit = writers.get(logRoot);
  if (hit) return hit;
  const dir = await gitDirOf(logRoot);
  const file = dir ? join(dir, "codemap-writer") : null;
  if (file) {
    try {
      const existing = (await readFile(file, "utf8")).trim();
      if (/^w_[0-9a-f]{16}$/.test(existing)) { writers.set(logRoot, existing); return existing; }
    } catch { /* not minted yet */ }
  }
  const minted = "w_" + randomBytes(8).toString("hex");
  if (file) await writeFile(file, minted + "\n", "utf8").catch(() => {});
  writers.set(logRoot, minted);
  return minted;
}

/**
 * Read the heads and append, as ONE act under the sidecar lock.
 *
 * The four shared entities each had this sequence written out, and the sequence is
 * the race: `causalHeads` reads what came before and the append commits to it, so
 * two processes that both read the same heads have already forked whichever order
 * their writes land in. A lock around the append alone would not have helped.
 */
export async function emitEvent(
  logRoot: string, scope: string, actor: Actor, kind: string, subject: string, data?: Record<string, unknown>,
): Promise<LogEvent> {
  return withSidecarLock(logRoot, async () => {
    const writer = await writerFor(logRoot);
    const seen = causalHeads(await readScope(logRoot, scope));
    // The chain's own file, not fold order. A shard is single-writer and
    // append-only, so its last line IS this chain's head by construction —
    // whereas fold order is a total order over the whole scope and would have to
    // be trusted to agree with append order for one writer, which is the very
    // thing a fork breaks.
    const own = await readShard(join(logRoot, shardFor(scope, writer)));
    const event: LogEvent = {
      sidecarProtocol: SIDECAR_PROTOCOL, eventSchema: EVENT_SCHEMA,
      id: mintId(), kind, subject, actor, at: new Date().toISOString(), writer,
      writerPrev: own.length ? own[own.length - 1]!.id : GENESIS,
      // Always present, even empty: `after` is a list in protocol 1, and an absent
      // one used to be indistinguishable from "saw nothing".
      after: seen,
      ...(data ? { data } : {}),
    };
    await appendEvents(logRoot, scope, writer, [event]);
    return event;
  });
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
export function wellFormed(e: LogEvent): boolean {
  return !!e && typeof e.id === "string" && !!e.id
    && typeof e.kind === "string" && typeof e.subject === "string"
    && !!e.actor && typeof e.actor.principal === "string" && !!e.actor.principal.trim()
    // Protocol 1. These were optional so that events written before them could keep
    // folding — events that never existed, because nothing was ever deployed. They
    // are mandatory now, and the causal vector depends on it: `writerPrev` is the
    // chain edge it derives segments from, and an absent one is not a missing
    // convenience, it is an event whose place in its own writer's history is unknown.
    && typeof e.writer === "string" && !!e.writer
    // An event may not BE the sentinel. `writerPrev: GENESIS` means "this opens the
    // chain", so an event actually named `GENESIS` becomes the apparent predecessor
    // of every chain opening and inherits their sight of it.
    && e.id !== GENESIS
    && typeof e.writerPrev === "string" && !!e.writerPrev
    && Array.isArray(e.after)
    && typeof e.sidecarProtocol === "number" && typeof e.eventSchema === "number";
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
  return (await readShardLines(file)).map((l) => l.event);
}

/**
 * The same read, keeping each event's own bytes.
 *
 * Only `readScopeChecked` wants them, and only to answer one question: two lines
 * sharing an id are `merge=union` doing its job when they are the same bytes, and
 * two writers claiming one id when they are not. Comparing the PARSED objects
 * would need a canonical form nobody has agreed on; comparing the text is exact
 * for the case that matters, because an id is minted once and a writer never
 * rewrites a line it has appended.
 */
async function readShardLines(file: string): Promise<{ event: LogEvent; line: string }[]> {
  let text: string;
  try { text = await readFile(file, "utf8"); } catch { return []; }
  const out: { event: LogEvent; line: string }[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      const e = JSON.parse(line) as LogEvent;
      if (wellFormed(e)) out.push({ event: e, line: line.trim() });
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
  return (await collect(logRoot, scope)).events;
}

/** A scope's events, plus whether they can be answered from authoritatively. */
export interface ScopeRead extends ScopeStatus { events: LogEvent[] }

/**
 * The same read, saying whether the result may be presented as the truth.
 *
 * See PROPOSAL-provenance.md §7: for v1 a scope is readable or it is not. The
 * events still come back — a blocked scope is rendered explicitly
 * non-authoritative rather than hidden, because a reviewer who can see what the
 * team wrote is better placed to repair it than one staring at an empty page.
 * What `blocked` forbids is presenting it as settled.
 */
export async function readScopeChecked(logRoot: string, scope: string): Promise<ScopeRead> {
  const { events, collisions } = await collect(logRoot, scope);
  return { events, ...scopeStatus(events, collisions) };
}

/**
 * Every scope that has shards on disk, as a scope path.
 *
 * A scope is any directory holding `*.ndjson`, which is the layout `shardFor` writes
 * and `collect` reads — so this and the reader cannot disagree about what a scope is.
 * `.git` is skipped: the sidecar's own object store is not the log.
 *
 * Used by sync to decide what to materialize. Cheap on purpose — it stats
 * directories and never opens a shard.
 */
export async function scopesOnDisk(logRoot: string): Promise<string[]> {
  const found: string[] = [];
  const walk = async (rel: string): Promise<void> => {
    let entries;
    try { entries = await readdir(join(logRoot, rel), { withFileTypes: true }); } catch { return; }
    if (entries.some((e) => e.isFile() && e.name.endsWith(SHARD_EXT))) found.push(rel);
    for (const e of entries) {
      if (e.isDirectory() && e.name !== ".git") await walk(rel ? join(rel, e.name) : e.name);
    }
  };
  await walk("");
  return found.sort();
}

/**
 * The read itself. Separate from the verdict because `emitEvent` takes this path
 * on every single write, under the lock, and only wants the causal heads — judging
 * the scope there would put a fork scan on the hot end of every append.
 */
async function collect(logRoot: string, scope: string): Promise<{ events: LogEvent[]; collisions: string[] }> {
  const dir = join(logRoot, scope);
  let names: string[];
  try { names = await readdir(dir); } catch { return { events: [], collisions: [] }; }
  const seen = new Map<string, string>();
  const collisions: string[] = [];
  const all: LogEvent[] = [];
  for (const n of names.filter((n) => n.endsWith(SHARD_EXT)).sort()) {
    for (const { event, line } of await readShardLines(join(dir, n))) {
      const first = seen.get(event.id);
      if (first !== undefined) {
        // Same id, same bytes: `merge=union` stitching one line in twice. Same id,
        // different bytes: two events claiming one identity, and no fold can pick.
        if (first !== line && !collisions.includes(event.id)) collisions.push(event.id);
        continue;
      }
      seen.set(event.id, line);
      all.push(event);
    }
  }
  return { events: sortEvents(all), collisions };
}

/** Why a scope may not be answered from. One diagnostic, not a taxonomy. */
export interface ScopeDiagnostic {
  reason: "protocol" | "duplicate-id" | "chain-cycle" | "fork";
  /** One line a person can act on. */
  detail: string;
  /** The ids or writers the detail is about, so a repair does not have to search. */
  evidence: string[];
}

export interface ScopeStatus {
  status: "complete" | "blocked";
  diagnostic?: ScopeDiagnostic;
}

/**
 * Two events of one `(scope, writer)` chain naming the same predecessor.
 *
 * The chain is per writer AND per scope, so this takes a scope's events as they
 * already arrive. Events with no `writerPrev` are not judged: they predate the
 * chain, and an absent predecessor is not evidence either way.
 */
export interface WriterFork {
  writer: string;
  /** What both sides named — an event id, or `GENESIS`. */
  prev: string;
  /** The ids that named it, sorted. Two or more, by definition. */
  events: string[];
}

export function detectForks(events: LogEvent[]): WriterFork[] {
  // `writer \0 prev` -> the ids naming it: the first one as a bare string, and an
  // array only once a second arrives. A well-behaved scope has exactly one id per
  // chain link, so a container per link would allocate one per event in the log
  // and this runs on every read of every scope.
  const chains = new Map<string, string | string[]>();
  const ids = new Set<string>();
  for (const e of events) {
    const w = e.writer;
    // NOT `writerOf` — the principal fallback is for causality, where an old event
    // must still fold. A chain claim needs a writer that actually made one.
    if (!w || e.writerPrev === undefined) continue;
    if (ids.has(e.id)) continue; // one event, however many times it was stitched in
    ids.add(e.id);
    const key = w + "\0" + e.writerPrev;
    const at = chains.get(key);
    if (at === undefined) chains.set(key, e.id);
    else if (typeof at === "string") chains.set(key, [at, e.id]);
    else at.push(e.id);
  }
  const out: WriterFork[] = [];
  for (const [key, at] of chains) {
    if (typeof at === "string") continue;
    const [writer, prev] = key.split("\0") as [string, string];
    out.push({ writer, prev, events: [...at].sort() });
  }
  return out.sort((a, b) => (a.writer + a.prev < b.writer + b.prev ? -1 : 1));
}

/**
 * Whether a scope may be answered from, and if not, the one thing to say.
 *
 * Precedence is fixed rather than by severity: an envelope this reader does not
 * understand makes every later judgement unreliable, a duplicated id makes the
 * event set itself ambiguous, and a fork is a claim ABOUT that set. Reporting the
 * outermost failure first is also what makes the diagnostic deterministic, which
 * a stored one has to be.
 *
 * A ratchet or domain rejection is deliberately not here. The fold refuses
 * forbidden transitions ON PURPOSE, and counting one as a reason the scope is
 * unreadable would let any client wedge a scope by emitting an event the rules
 * correctly refuse — a denial of service built out of a safety mechanism.
 */
export function scopeStatus(events: LogEvent[], duplicateIds: string[] = []): ScopeStatus {
  const ahead = events.filter((e) =>
    (e.sidecarProtocol ?? SIDECAR_PROTOCOL) > SIDECAR_PROTOCOL
    || (e.eventSchema ?? EVENT_SCHEMA) > EVENT_SCHEMA);
  if (ahead.length) {
    const top = Math.max(...ahead.map((e) => e.sidecarProtocol ?? 0));
    const schema = Math.max(...ahead.map((e) => e.eventSchema ?? 0));
    return {
      status: "blocked",
      diagnostic: {
        reason: "protocol",
        detail: `${ahead.length} event(s) were written by a newer codemap `
          + `(protocol ${top} / schema ${schema}; this build reads `
          + `${SIDECAR_PROTOCOL} / ${EVENT_SCHEMA}). Upgrade to read this scope.`,
        evidence: ahead.slice(0, 5).map((e) => e.id),
      },
    };
  }
  if (duplicateIds.length) {
    return {
      status: "blocked",
      diagnostic: {
        reason: "duplicate-id",
        detail: `${duplicateIds.length} event id(s) appear twice with different `
          + `content. An id is minted once, so two writers have claimed one — a `
          + `person has to say which is real.`,
        evidence: duplicateIds.slice(0, 5),
      },
    };
  }
  // Before forks, because a cycle is the more damaging shape and a forked-looking
  // chain inside one is not a diagnosis worth printing. A cycle cannot be produced
  // by any honest writer — `writerPrev` is the shard's own last line at append time —
  // so this is corruption or a hand-edit, and it is fail-closed for the same reason
  // everything else here is: left in the vector it makes every event cover every
  // other, `heads()` returns nothing, and the next append silently records having
  // seen nothing at all.
  const cycles = chainCycles(events);
  if (cycles.length) {
    return {
      status: "blocked",
      diagnostic: {
        reason: "chain-cycle",
        detail: `${cycles.length} event(s) have a writerPrev chain that loops, so they `
          + `have no place in their writer's history. No append can produce this — a `
          + `shard has been hand-edited or corrupted. The events are readable; their `
          + `causal position is not.`,
        evidence: cycles.slice(0, 5),
      },
    };
  }
  const forks = detectForks(events);
  if (forks.length) {
    return {
      status: "blocked",
      diagnostic: {
        reason: "fork",
        detail: `${forks.length} forked writer chain(s) in this scope: `
          + `${forks[0]!.writer} has two events naming the predecessor `
          + `${forks[0]!.prev}. That is one writer id in two clones (a copied `
          + `machine image, a synced home directory); rotate it on one of them.`,
        evidence: forks.flatMap((f) => f.events).slice(0, 6),
      },
    };
  }
  return { status: "complete" };
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
/**
 * The causal parents an event names.
 *
 * A list, always, since the protocol-1 freeze. It used to accept a bare string too,
 * for logs written before `after` became a list — logs that have never existed.
 */
export const parentsOf = (e: LogEvent): string[] => e.after ?? [];

/**
 * What must fold BEFORE an event: its causal parents, plus its own chain predecessor.
 *
 * Ordering only — `writerPrev` is not a causal claim about what the writer had seen
 * from others, and `parentsOf` stays the answer to that. It is here so that "a chain
 * parent folds before its child" is a property rather than a coincidence, which the
 * segment vector's own-edge absorption relies on: absorbing a parent that has not
 * been folded yet silently under-credits.
 */
const sortEdges = (e: LogEvent): string[] =>
  e.writerPrev && e.writerPrev !== GENESIS ? [...parentsOf(e), e.writerPrev] : parentsOf(e);

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
    let i = pending.findIndex((e) => sortEdges(e).every((p) => !byId.has(p) || emitted.has(p)));
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
 * The answer is a vector clock, and what it compresses on is the SEGMENT — a
 * maximal linear run of one writer's `writerPrev` chain. One number per segment is
 * a complete summary because within a segment each event names its predecessor, so
 * holding ordinal n really does mean holding 1..n.
 *
 * That ordinal is chain position, NOT fold position, and the difference is the whole
 * soundness argument. Keyed per writer with fold-order ordinals — which is what this
 * was — the prefix claim is false the moment one writer id exists on two clones: the
 * two histories interleave, and absorbing either one credits the reader with the
 * other. That silently suppressed a real contest between two OTHER people, and it is
 * not a hole recorded and tolerated any more; see `buildSegments` and
 * `docs/fork-repair.md`.
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

/**
 * The key the vector compresses on: the WRITER, and only the writer.
 *
 * The principal fallback is gone with the protocol-1 freeze. It existed for events
 * written before writer ids, and it was the one place the vector was documented as
 * inexact — keying on a person files two machines' concurrent chains under one key,
 * which is precisely the compression a fork invalidates.
 */
const writerOf = (e: LogEvent): string | undefined => e.writer;

/**
 * The writer's events as a TREE, cut into maximal linear runs.
 *
 * A segment is a run of one writer's chain with no branch in it. Segments are what
 * the causal vector compresses on, and the reason is the whole soundness argument:
 * an ordinal is a PREFIX CLAIM — holding ordinal n asserts holding 1..n — and that
 * is true within a segment by construction, because each event names its
 * predecessor. Across a fork it is false, which is how the old per-writer ordinal
 * credited a reader with a branch it had never seen. See `docs/fork-repair.md`.
 *
 * Segments are INTERNED to integers rather than keyed by a `writer + root` string.
 * A concatenated key is not injective — writer `w` with root `a\0b` collides with
 * writer `w\0a` with root `b` — and the collision reproduces the exact bug this
 * function exists to fix. It is the third instance of that class in this repo; an
 * integer cannot have it.
 *
 * `cyclic` is every event whose `writerPrev` chain never reaches a root. An honest
 * writer cannot produce one, and it is not a curiosity: left in the vector it makes
 * every event cover every other and `heads()` returns nothing at all, so the next
 * append records having seen NOTHING. Those events are excluded here and reported as
 * blocking evidence by `scopeStatus`.
 */
function buildSegments(events: LogEvent[], byId: Map<string, LogEvent>): {
  segOf: Map<string, number>; ordOf: Map<string, number>; cyclic: string[];
  chainParent: Map<string, string>;
} {
  const mine = events.filter((e) => writerOf(e) !== undefined);
  /** event -> its predecessor IN THIS WRITER'S CHAIN, when the scope has it. */
  const chainParent = new Map<string, string>();
  const children = new Map<string, string[]>();
  for (const e of mine) {
    // The sentinel is a word, not an id — never look it up. `wellFormed` also refuses
    // an event whose own id is `GENESIS`, so these two guards cover each other.
    const p = e.writerPrev === GENESIS ? undefined : byId.get(e.writerPrev);
    // Same writer only: a `writerPrev` naming somebody else's event is not a chain
    // link, and treating it as one would splice two writers into one segment.
    if (!p || writerOf(p) !== writerOf(e)) continue;
    chainParent.set(e.id, p.id);
    const kids = children.get(p.id);
    if (kids) kids.push(e.id); else children.set(p.id, [e.id]);
  }

  // Cycles are detected EXPLICITLY, by walking each chain to its root. Inferring
  // them from "never got a segment" is not enough and was wrong: a cycle with a
  // branch hanging off it makes one of its own members look like a fork point, which
  // turns the cycle into a segment with arbitrary ordinals and reports nothing. Found
  // by probing A<->B with C also naming A: `saw(A, B)` came back true.
  const onCycle = new Set<string>();
  const done = new Set<string>();
  for (const e of mine) {
    if (done.has(e.id)) continue;
    const path: string[] = [];
    const onPath = new Set<string>();
    let cur: string | undefined = e.id;
    while (cur !== undefined && !done.has(cur) && !onPath.has(cur)) {
      path.push(cur); onPath.add(cur);
      cur = chainParent.get(cur);
    }
    // Stopped because we walked back onto our own path: everything from that point
    // forward is the loop itself. Events that merely LEAD INTO a cycle are not in it
    // and keep their own segment — their ordinal claims only themselves.
    if (cur !== undefined && onPath.has(cur)) for (const id of path.slice(path.indexOf(cur))) onCycle.add(id);
    for (const id of path) done.add(id);
  }

  const segOf = new Map<string, number>(), ordOf = new Map<string, number>();
  let nextSeg = 0;
  // A segment opens where the chain does — no predecessor in this scope — or right
  // after a fork point, so each branch of a fork is its own segment and neither
  // inherits the other's ordinals.
  const opensSegment = (id: string): boolean => {
    const p = chainParent.get(id);
    return p === undefined || onCycle.has(p) || (children.get(p)?.length ?? 0) > 1;
  };
  /** Chain children, minus anything in a loop — a cycle is nobody's successor. */
  const heirs = (id: string): string[] => (children.get(id) ?? []).filter((k) => !onCycle.has(k));
  for (const e of mine) {
    if (onCycle.has(e.id) || segOf.has(e.id) || !opensSegment(e.id)) continue;
    const seg = nextSeg++;
    let cur: string | undefined = e.id, ord = 1;
    while (cur !== undefined && !segOf.has(cur)) {
      segOf.set(cur, seg);
      ordOf.set(cur, ord++);
      const kids = heirs(cur);
      cur = kids.length === 1 ? kids[0] : undefined;   // a branch ends the segment
    }
  }
  return { segOf, ordOf, chainParent, cyclic: mine.filter((e) => !segOf.has(e.id)).map((e) => e.id) };
}

export function causality(sortedEvents: LogEvent[]): Causality {
  const byId = new Map(sortedEvents.map((e) => [e.id, e]));
  const { segOf, ordOf, chainParent, cyclic } = buildSegments(sortedEvents, byId);
  const cyclicSet = new Set(cyclic);
  /** event -> the highest ordinal it holds, per SEGMENT. */
  const seen = new Map<string, Map<number, number>>();

  for (const e of sortedEvents) {
    if (segOf.get(e.id) === undefined) continue;   // no writer, or in a chain cycle
    const v = new Map<number, number>();
    const absorb = (id: string | undefined) => {
      const parent = id !== undefined ? byId.get(id) : undefined;
      if (!parent) return;
      for (const [s, n] of seen.get(parent.id) ?? []) if ((v.get(s) ?? 0) < n) v.set(s, n);
      const s = segOf.get(parent.id), n = ordOf.get(parent.id);
      if (s === undefined || n === undefined) return;
      if ((v.get(s) ?? 0) < n) v.set(s, n);
    };
    for (const id of parentsOf(e)) absorb(id);
    // The writer's own predecessor, taken from what the event RECORDED rather than
    // from fold order. Fold order is a total order over the whole scope and had to be
    // trusted to agree with append order for one writer — the very thing a fork
    // breaks, and the reason the previous own-edge fabricated knowledge.
    //
    // The VALIDATED parent, not the raw field: `writerPrev` means "my own previous
    // event", so one naming somebody else's is malformed. Absorbing it anyway let an
    // event inherit another writer's whole vector and cover them in `heads()` — over-
    // crediting, which is the direction that suppresses contests.
    absorb(chainParent.get(e.id));
    seen.set(e.id, v);
  }

  return {
    saw(from, target) {
      const s = segOf.get(target), n = ordOf.get(target);
      // No segment means malformed, writerless, or cyclic — nobody saw it.
      if (s === undefined || n === undefined) return false;
      return (seen.get(from)?.get(s) ?? 0) >= n;
    },
    heads() {
      const covered = new Map<number, number>();
      for (const v of seen.values()) for (const [s, n] of v) if ((covered.get(s) ?? 0) < n) covered.set(s, n);
      return sortedEvents.filter((e) => {
        // A cyclic event is always a head. It gets no segment, so it grants nobody
        // anything — but dropping it here would make it UNNAMEABLE, and `emitEvent`
        // captures `heads()` as the next event's `after`. A cycle-only scope then
        // produced `after: []`: the append recorded having seen nothing at all, which
        // is the total causality loss the cycle handling exists to prevent, arriving
        // by the other door. Nameable but crediting nothing is the conservative pair.
        if (cyclicSet.has(e.id)) return true;
        const s = segOf.get(e.id), n = ordOf.get(e.id);
        return s !== undefined && n !== undefined && (covered.get(s) ?? 0) < n;
      }).map((e) => e.id);
    },
  };
}

/** Every event whose `writerPrev` chain loops and so has no place in any segment. */
export const chainCycles = (events: LogEvent[]): string[] =>
  buildSegments(events, new Map(events.map((e) => [e.id, e]))).cyclic;

/** What a new write records as `after`. See `Causality.heads`. */
export const causalHeads = (sortedEvents: LogEvent[]): string[] => causality(sortedEvents).heads();
