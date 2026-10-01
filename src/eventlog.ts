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
 *     state: line position within a scope, `seq` across scopes — the order the remote
 *     accepted each event in (`sortEvents`). `after` orders nothing; it records what an
 *     act's author had read (`readSets`).
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
export const SIDECAR_PROTOCOL = 2;
export const EVENT_SCHEMA = 1;

/**
 * The one file per scope that every write since the linear log goes to
 * (docs/PROPOSAL-online-only-sync.md, "one append-only file per scope"). Line position is
 * order within a scope; `seq` is order across scopes. A sidecar still holding per-writer shards
 * from before it is unmigrated (`isLegacyShard`).
 */
export const LINEAR_SHARD = "events" + SHARD_EXT;

/**
 * The cutover's tripwire (plan 7.2): a shard the migration commit writes whose first line is
 * not JSON, so a build from before the linear log refuses the pull that brings it (its inbound
 * damage gate) and can neither merge nor push. This build exempts exactly this path with exactly
 * these bytes — anything else there is damage like anywhere else.
 */
export const TRIPWIRE_PATH = "linear-log/UPGRADE-CODEMAP" + SHARD_EXT;
export const TRIPWIRE_BYTES = "codemap: this sidecar was migrated to the linear format; upgrade codemap\n";

/**
 * The tripwire's partner for a FRESH clone, which has no inbound pull for the tripwire to trip:
 * a manifest no build writes (`anchorScheme` 0) from no real person. A build from before the
 * linear log refuses to pull or push past another principal's differing scheme on the fetched
 * ref, so it stops there. This build exempts it by exact path and bytes, as it does the tripwire.
 */
export const SENTINEL_MANIFEST_PATH = "manifests/UPGRADE-CODEMAP.json";
export const SENTINEL_MANIFEST_BYTES = JSON.stringify({
  principal: "UPGRADE-CODEMAP: this sidecar was migrated to the linear log; upgrade codemap",
  anchorScheme: 0, hashScheme: 0, grammars: {},
}, null, 2) + "\n";

/**
 * The sidecar's `.gitattributes`: no line-ending conversion, anywhere. Under `core.autocrlf=true`
 * (Git for Windows' default) a checkout writes CRLF, and the markers above then fail their exact
 * byte match and read as damage — a lockout no repair can clear, since the remote is clean.
 */
export const SIDECAR_ATTRIBUTES_PATH = ".gitattributes";
export const SIDECAR_ATTRIBUTES = "* -text\n";

/** The migration's markers, by sidecar-relative path. The one exemption list for both. */
const MIGRATION_MARKERS: ReadonlyMap<string, string> = new Map([
  [TRIPWIRE_PATH, TRIPWIRE_BYTES], [SENTINEL_MANIFEST_PATH, SENTINEL_MANIFEST_BYTES],
]);

/** Whether `text` at `path` (sidecar-relative, or ending in one) is exactly a migration marker. */
export function isMigrationMarker(path: string, text: string): boolean {
  for (const [p, bytes] of MIGRATION_MARKERS) if ((path === p || path.endsWith("/" + p)) && text === bytes) return true;
  return false;
}

/**
 * Whether a shard path is from before the linear log: a per-writer shard. A sidecar holding any
 * is unmigrated, and this build neither syncs nor folds it (plan 7.2b).
 */
export const isLegacyShard = (path: string): boolean =>
  path.endsWith(SHARD_EXT) && !path.endsWith("/" + LINEAR_SHARD) && path !== LINEAR_SHARD && path !== TRIPWIRE_PATH;

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
   * What this act's author had read, fixed when it was staged (`causalHeads`): the closure
   * over `after` is its read set, which folds check as a precondition (`readSets`). Not an
   * ordering input.
   */
  after: string[];
  /** Which clone wrote this: a random id minted on first use. Kept for audit. */
  writer: string;
  /**
   * This writer's previous event in the scope at the tip, or `GENESIS`. Kept for audit; a
   * merge-era event's read set reaches it (`readSets`).
   */
  writerPrev: string;
  /** Governs this envelope. Absent means an older writer; see `SIDECAR_PROTOCOL`. */
  sidecarProtocol: number;
  /** Governs `data` only. Absent means an older writer; see `EVENT_SCHEMA`. */
  eventSchema: number;
  /** Event-specific payload. Opaque here. */
  data?: Record<string, unknown>;
  /**
   * Position in the WHOLE sidecar's linear history, assigned when the event is appended at
   * the tip (protocol 2): one more than the largest `seq` on disk. Absent on events from
   * before the linear log. A fold that merges scopes needs it — ids are minted when an act is
   * staged, so a staged act pushed late would otherwise sort ahead of what it was validated
   * after, and could invalidate an event already on the remote.
   */
  seq?: number;
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
  // otherwise be ordered only by their random suffix. Across processes the random
  // suffix still breaks ties; this only removes the ambiguity a single writer can create.
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
 *
 * `separatorFor` is that separator, and deliberately NOT a repair — see its note. The
 * glued line the paragraph above describes is what `splitShard` now counts as damage,
 * which is the loud half; deleting the fragment instead would be the quiet half, and it
 * cannot tell a crash from a disk that ate an event somebody had already read.
 */
export async function appendEvents(logRoot: string, scope: string, writer: string, events: LogEvent[]): Promise<void> {
  if (!events.length) return;
  const file = join(logRoot, shardFor(scope, writer));
  await mkdir(dirname(file), { recursive: true });
  await appendFile(file, (await separatorFor(file)) + events.map((e) => JSON.stringify(e)).join("\n") + "\n", "utf8");
}

/**
 * The separator an append needs, and a DECISION not to repair.
 *
 * A file not ending in a newline ends mid-line, and there are two of those:
 *
 * - **The line parses.** A whole event whose terminating newline was lost. It is
 *   readable and every build has counted it, so it is kept and separated with `"\n"`.
 * - **It does not.** A fragment — and this is where the tempting repair lives.
 *
 * **Truncating the fragment was tried and REVERTED, and it must not come back.** The
 * argument for it was that a crash mid-append leaves a partial line which the next
 * append seals into the middle of the file, where it is no longer distinguishable from
 * corruption and now blocks the scope — so a laptop losing power would wedge the team's
 * log until somebody hand-edited it.
 *
 * What that misses is that the two causes are ALSO indistinguishable. Disk corruption
 * that truncates an event this shard has already served produces bytes identical to a
 * torn append, so truncating deletes a real record that readers had accepted — silently,
 * and leaving a `writerPrev` chain that looks consistent because the event it skipped is
 * gone. Measured: append one event, read it back, `truncate` two bytes, append a second,
 * and the first has vanished with the scope reporting `complete`.
 *
 * Between wedging a scope loudly and deleting an event quietly, this project takes the
 * first every time — it is the whole thesis. The fragment is sealed in, `splitShard`
 * counts it as damage the moment anything follows it, the scope blocks, and the commit
 * gate refuses to publish it. The repair is a person deleting one line, which is exactly
 * what the diagnostic names.
 *
 * A second reason not to reinstate it: the truncation offset was also wrong. `readFile`
 * decodes invalid bytes to U+FFFD, so a byte length computed from the decoded string is
 * not the offset of that newline in the file — on a shard with binary damage it cut
 * mid-line and glued the next event onto a fragment, losing an event `emit` had already
 * returned an id for.
 */
const separatorFor = async (file: string): Promise<string> => ((await endsCleanly(file)) ? "" : "\n");

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
 * The scope's fold, asked whether it would apply one event: the minted one, envelope and all.
 * Passed in by the caller because the folds import this module.
 */
export type DoorFold = (events: LogEvent[], minted: LogEvent) =>
  Promise<{ refused: { id: string; why: string }[] }> | { refused: { id: string; why: string }[] };

/**
 * Each family's vocabulary: every kind this build folds or knows to skip (a retired kind).
 * Anything else in the family's scopes is NEWER (owner, C17: "Newer build is obviously new
 * event types"), and the door refuses to mint it. Registered by the families, like the doors.
 */
export interface Vocabulary {
  kinds: ReadonlySet<string>;
  /** An event of a known kind this build skips on read, never folding it and never locking on it. */
  skip?: (e: LogEvent) => boolean;
}
const vocabularies: { match: (scope: string) => boolean; vocab: Vocabulary }[] = [];
export function registerKinds(match: (scope: string) => boolean, kinds: readonly string[], skip?: (e: LogEvent) => boolean): Vocabulary {
  const vocab = { kinds: new Set([...kinds, ...SKIPPED_KINDS]), ...(skip ? { skip } : {}) };
  vocabularies.push({ match, vocab });
  return vocab;
}
export const kindsFor = (scope: string): Vocabulary | undefined => vocabularies.find((v) => v.match(scope))?.vocab;

/** Known to every family and folded by none: a repair's tombstone (docs/log-repair.md). */
export const SKIPPED_KINDS: readonly string[] = ["log.repaired"];

/** The envelope this build reads. A field outside it is a newer writer's (owner, C17). */
export const ENVELOPE_FIELDS: ReadonlySet<string> = new Set([
  "id", "kind", "subject", "actor", "at", "after", "writer", "writerPrev", "sidecarProtocol", "eventSchema", "data", "seq",
]);

/** Scopes whose every write is folded at the door before it is appended (plan 1.1). */
export const FOLDED_AT_THE_DOOR = /^(decisions|standard|law)\//;

/**
 * Each scope's fold, for a replay that holds only data (plan 2.3). The folds register
 * themselves here, because they import this module and a replay cannot import them back.
 */
const doors: { match: (scope: string) => boolean; make: (logRoot: string, scope: string) => DoorFold }[] = [];
export function registerDoor(match: (scope: string) => boolean, make: (logRoot: string, scope: string) => DoorFold): void {
  doors.push({ match, make });
}

/**
 * The fold a staged op to `scope` replays through. A scope that must be folded, with no fold
 * registered in this process, THROWS rather than replaying unchecked: an unchecked replay is
 * how an invalid event reaches the remote.
 */
/**
 * The door a write goes through: the caller's fold, and the scope's registered door as well —
 * a door checks more than one fold (references into other scopes), and a caller passing its
 * scope's fold must not skip what replay would check.
 */
export function writeDoor(logRoot: string, scope: string, fold?: DoorFold): DoorFold | undefined {
  const registered = doorFor(logRoot, scope);
  if (!fold || !registered) return fold ?? registered;
  return async (events, minted) => {
    const a = await fold(events, minted), b = await registered(events, minted);
    return { refused: [...a.refused, ...b.refused] };
  };
}

export function doorFor(logRoot: string, scope: string): DoorFold | undefined {
  const d = doors.find((x) => x.match(scope));
  if (d) {
    const fold = d.make(logRoot, scope), kinds = kindsFor(scope)?.kinds;
    // The read classes a kind outside the vocabulary as newer, so this build writing one would
    // block every push on the team; refusing it here is what keeps the vocabulary complete.
    return kinds ? (events, minted) => kinds.has(minted.kind) ? fold(events, minted)
      : { refused: [{ id: minted.id, why: `${minted.kind} is not a kind this build writes to ${scope}` }] } : fold;
  }
  if (FOLDED_AT_THE_DOOR.test(scope)) throw new Error(`no fold is registered for ${scope} in this process, so a write to it cannot be validated`);
  return undefined;
}

/**
 * Recheck an admission decision against the scope while holding the append lock, then fold
 * the event exactly as it will be appended — its real id, writer, `writerPrev` and `after` —
 * and refuse it if the fold would. One door: a stand-in envelope folded differently from the
 * real one (a writer of its own read as having seen nothing).
 */
/** What an act's check answers: the event to write, one already there, or a refusal. */
export type Admission =
  | { kind: string; subject: string; data?: Record<string, unknown> }
  | { existing: LogEvent }
  | { error: string };
export type AdmissionCheck = (events: LogEvent[]) => Promise<Admission>;

/**
 * The door for a sidecar with no remote: its own history is the serializer, so the act is
 * checked, folded and appended at the tip under the lock, and nothing is pushed. Every other
 * write goes through `write.ts`, which routes here.
 */
export async function appendChecked(
  logRoot: string, scope: string, actor: Actor, check: AdmissionCheck, fold?: DoorFold,
  /** Fold with `fold` alone, not the scope's registered door too: `test-door.ts` planting what no build writes. */
  exact = false,
): Promise<LogEvent | { error: string }> {
  // The scope's registered door when the caller brings none: a local append is validated
  // exactly as a replay would be, or the read of it is what refuses — as damage.
  if (!exact) fold = writeDoor(logRoot, scope, fold);
  return withSidecarLock(logRoot, async () => {
    const events = await readScope(logRoot, scope);
    const admission = await check(events);
    if ("error" in admission) return admission;
    if ("existing" in admission) return admission.existing;
    const writer = await writerFor(logRoot);
    const event = atTip(events, writer, await maxSeq(logRoot), {
      sidecarProtocol: SIDECAR_PROTOCOL, eventSchema: EVENT_SCHEMA,
      id: mintId(), kind: admission.kind, subject: admission.subject, actor, at: new Date().toISOString(),
      after: causalHeads(events),
      ...(admission.data ? { data: admission.data } : {}),
    });
    if (fold) {
      let verdict: Awaited<ReturnType<DoorFold>>;
      try { verdict = await fold(sortEvents([...events, event]), event); } catch (err) {
        // A fold that halts names the entry (`LogDamage`, not imported: it imports this module).
        // This event is one no conforming build writes, so it is refused; damage already in
        // the log is not this write's to answer, and goes on up to the lockout.
        const entry = (err as { entry?: { id?: string; why?: string } } | null)?.entry;
        if (entry?.id === event.id) return { error: entry.why ?? "the fold refuses it" };
        throw err;
      }
      const refused = verdict.refused.find((r) => r.id === event.id);
      if (refused) return { error: refused.why };
    }
    await appendLinear(logRoot, scope, [event]);
    return event;
  });
}

/**
 * An event as staged: everything but what only the tip can say. `after` is what its author
 * had READ when they acted, fixed at staging — a staged act replayed later did not see what
 * landed in between, and folds that ask what a person saw must not be told it did.
 */
export type StagedEvent = Omit<LogEvent, "writer" | "writerPrev" | "seq">;

/**
 * Place a staged event at the tip of a scope: its writer chain and its global `seq`.
 * `events` is the scope in fold order.
 */
export function atTip(events: LogEvent[], writer: string, top: number, e: StagedEvent): LogEvent {
  let prev = GENESIS;
  for (let i = events.length - 1; i >= 0; i--) if (events[i]!.writer === writer) { prev = events[i]!.id; break; }
  return { ...e, writer, writerPrev: prev, seq: top + 1 };
}

/** Append to a scope's one linear file. Whole lines, like `appendEvents`, and the same seal. */
export async function appendLinear(logRoot: string, scope: string, events: LogEvent[]): Promise<void> {
  if (!events.length) return;
  const file = join(logRoot, scope, LINEAR_SHARD);
  await mkdir(dirname(file), { recursive: true });
  await appendFile(file, (await separatorFor(file)) + events.map((e) => JSON.stringify(e)).join("\n") + "\n", "utf8");
}

/**
 * The largest `seq` anywhere in the sidecar, or 0. Each linear file is appended in `seq`
 * order, so its last event carries its largest; only a tail is read.
 */
export async function maxSeq(logRoot: string): Promise<number> {
  let top = 0;
  const walk = async (rel: string): Promise<void> => {
    let entries;
    try { entries = await readdir(join(logRoot, rel), { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (e.isDirectory()) { if (e.name !== ".git") await walk(rel ? `${rel}/${e.name}` : e.name); continue; }
      if (e.name !== LINEAR_SHARD) continue;
      const s = await lastSeq(join(logRoot, rel, e.name));
      if (s > top) top = s;
    }
  };
  await walk("");
  return top;
}

async function lastSeq(file: string): Promise<number> {
  let fh;
  try { fh = await open(file, "r"); } catch { return 0; }
  try {
    const { size } = await fh.stat();
    const len = Math.min(size, 65536);
    const buf = Buffer.alloc(len);
    await fh.read(buf, 0, len, size - len);
    const lines = buf.toString("utf8").split("\n").map((l) => l.trim()).filter(Boolean);
    for (let i = lines.length - 1; i >= 0; i--) {
      try { const s = (JSON.parse(lines[i]!) as LogEvent).seq; if (typeof s === "number") return s; } catch { /* a torn tail, or the cut */ }
    }
  } finally { await fh.close(); }
  // Nothing parseable in the tail: read it whole rather than restart numbering at 0.
  return Math.max(0, ...(await readShard(file)).map((e) => e.seq ?? 0));
}

/**
 * Many events from one writer, in one lock and one append.
 *
 * `emitEvent` re-reads the whole scope to find its causal heads, so calling it in a
 * loop is quadratic — fine for a button click, and not fine for a pull request that
 * triages 531 symbols. This reads once and chains `writerPrev` across the batch.
 *
 * The first event records what the scope's reader had read; each later one names the one
 * before it, which its author composed it after (`readSets`).
 */
export async function appendBatch(
  logRoot: string, scope: string, actor: Actor,
  items: { kind: string; subject: string; data?: Record<string, unknown> }[],
): Promise<LogEvent[]> {
  if (!items.length) return [];
  // All or none through the scope's door, as a remote batch replays at sync.
  const fold = doorFor(logRoot, scope);
  return withSidecarLock(logRoot, async () => {
    const writer = await writerFor(logRoot);
    const events = await readScope(logRoot, scope);
    let top = await maxSeq(logRoot);
    let after = causalHeads(events);
    const out: LogEvent[] = [];
    for (const it of items) {
      const event = atTip(events, writer, top++, {
        sidecarProtocol: SIDECAR_PROTOCOL, eventSchema: EVENT_SCHEMA,
        id: mintId(), kind: it.kind, subject: it.subject, actor, at: new Date().toISOString(), after,
        ...(it.data ? { data: it.data } : {}),
      });
      if (fold) {
        const why = (await fold(sortEvents([...events, event]), event)).refused.find((r) => r.id === event.id)?.why;
        if (why) throw new Error(why);
      }
      events.push(event);
      out.push(event);
      after = [event.id];
    }
    await appendLinear(logRoot, scope, out);
    return out;
  });
}

/**
 * The envelope every reader depends on, checked once at the door.
 *
 * `actor.principal` is the part worth spelling out: folds read it without a guard, so a
 * line missing an actor would throw rather than be skipped, and take every finding in the
 * scope with it. A shared store that refuses to load is worse than one that ignores a record.
 *
 * `at` and `data` are deliberately not required: a fold branch that wants them
 * already guards, and rejecting an event for a missing timestamp would discard
 * meaning over presentation.
 */
export function wellFormed(e: LogEvent): boolean {
  return !!e && typeof e.id === "string" && !!e.id
    && typeof e.kind === "string" && typeof e.subject === "string"
    && !!e.actor && typeof e.actor.principal === "string" && !!e.actor.principal.trim()
    // Protocol 1: mandatory since then, and a merge-era read set follows `writerPrev`.
    && typeof e.writer === "string" && !!e.writer
    // An event may not BE the sentinel, or it would read as every chain's predecessor.
    && e.id !== GENESIS
    && typeof e.writerPrev === "string" && !!e.writerPrev
    && Array.isArray(e.after)
    && typeof e.sidecarProtocol === "number" && typeof e.eventSchema === "number";
}

/**
 * Every event in one shard, skipping anything unparseable.
 *
 * A partial trailing line is EXPECTED, not exceptional: a process killed
 * mid-append leaves one. Each line is self-contained, so the bad one is dropped and
 * the rest stand. Failing the whole read would mean a shared store that will not
 * load because somebody closed a laptop, which is strictly worse than losing the
 * last event.
 *
 * Every OTHER unparseable line is damage, and `readShardLines` counts it — see
 * `ShardDamage`. Skipping those silently is what let a wholly-garbage shard read as
 * an empty scope with `status: "complete"`, so a team's findings vanished and every
 * surface said the queue was clear.
 */
export async function readShard(file: string): Promise<LogEvent[]> {
  return (await readShardLines(file)).events.map((l) => l.event);
}

/**
 * One line of a shard that no build can read.
 *
 * The line NUMBER rather than the bytes: a shard is append-only and never rewritten,
 * so a line's position is stable, and it is what a repair needs. `sample` is a short
 * prefix so a person can tell binary from a stitched line without opening the file.
 */
export interface ShardDamage {
  /** Path as the caller passed it — `collect` passes the scope-relative shard name. */
  shard: string;
  /** 1-based, counting every line including blank ones, so `sed -n 12p` finds it. */
  line: number;
  sample: string;
  /** For a line that parses but is damaged (a wrong shape): the entry, and what is wrong. */
  id?: string;
  kind?: string;
  why?: string;
}

/** `path:line` — the evidence form a `corrupt-shard` diagnostic carries. */
export const damageRef = (d: ShardDamage): string => `${d.shard}:${d.line}`;

/**
 * The same read, keeping each event's own bytes and what would not parse.
 *
 * **The torn tail is exempt, and the exemption is narrow on purpose.** A partial
 * write can only ever be the LAST line of a file that does not end in a newline —
 * `appendEvents` writes whole lines terminated by one, so a file ending in `\n` has
 * no incomplete line in it by construction, and one that does not has exactly one
 * candidate. Anything else that fails to parse was fully written, and something
 * other than a crash put it there.
 *
 * And it must LOOK like a truncated event: an opening brace, because every line this
 * module writes is `JSON.stringify` of an object. Position alone is not enough — a
 * shard whose single line is binary is entirely at the end of itself, which is exactly
 * how a wholly-destroyed shard read as an empty one. The residue is a corruption that
 * begins with `{`, lands in the last line, and has no newline after it; the cost of
 * the other error is a scope that blocks over a crash, which is loud, honest (an
 * event WAS lost) and healed by the next append.
 *
 * A line that parses but fails `wellFormed` is not folded and not counted here either: it
 * is `malformed`, and the damage scan decides what it is (owner, C17) — newer when a newer
 * protocol or schema wrote it, otherwise an existing validator failing, which is damage.
 * Only bytes that are not JSON at all count here.
 */
async function readShardLines(
  file: string, as = file,
): Promise<ShardLines> {
  let text: string;
  try { text = await readFile(file, "utf8"); } catch { return { events: [], damage: [], malformed: [] }; }
  return splitShard(text, as);
}

/**
 * The parse itself, on bytes rather than a path.
 *
 * Separate so the push and pull gates can validate a blob straight out of git — an
 * inbound shard is checked BEFORE it reaches the working tree, so there is no file
 * to read. One implementation, or the gate and the reader disagree about what a
 * damaged shard is, which is the whole class of defect this fixes.
 */
export interface ShardLines {
  events: { event: LogEvent; line: string }[];
  damage: ShardDamage[];
  /** Lines that parse but fail `wellFormed`, with what parsed. */
  malformed: (ShardDamage & { parsed: unknown })[];
}

export function splitShard(text: string, as: string): ShardLines {
  if (isMigrationMarker(as, text)) return { events: [], damage: [], malformed: [] };
  const events: { event: LogEvent; line: string }[] = [];
  const damage: ShardDamage[] = [];
  const malformed: ShardLines["malformed"] = [];
  const lines = text.split("\n");
  // The index of the one line a torn write could have left, or -1. Two conditions in
  // one expression: `split` puts the text after the final newline in the last element,
  // so a file ending cleanly has "" there and nothing is exempt; and what is there must
  // have BEGUN as an event, which is what stops a shard whose single line is binary
  // exempting itself for being at its own end.
  const last = lines[lines.length - 1]!.trim();
  const torn = last.startsWith("{") ? lines.length - 1 : -1;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (!line.trim()) continue;
    try {
      const e = JSON.parse(line) as LogEvent;
      if (wellFormed(e)) events.push({ event: e, line: line.trim() });
      else malformed.push({ shard: as, line: i + 1, sample: line.trim().slice(0, 80), parsed: e });
    } catch {
      if (i === torn) continue; // a crash mid-append — see above
      damage.push({ shard: as, line: i + 1, sample: line.trim().slice(0, 80) });
    }
  }
  return { events, damage, malformed };
}

/**
 * Every event under a scope, in the one order all readers agree on. Deduped by id: the
 * first sighting stands.
 */
export async function readScope(logRoot: string, scope: string): Promise<LogEvent[]> {
  return (await collect(logRoot, scope)).events;
}

/** A scope's events, plus whether they can be answered from authoritatively. */
export interface ScopeRead extends ScopeStatus { events: LogEvent[]; malformed: ShardLines["malformed"] }

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
  const { events, damage, malformed } = await collect(logRoot, scope);
  return { events, malformed, ...scopeStatus(events, damage) };
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
 *
 * **A scope is a POSIX path on every platform, and `path.join` may not build one.**
 * The string returned here is not just a path: `projectionFor` prefix-matches it
 * against `"notes/"`/`"docs/"`/… and `inUniverse` slices it at the first `/`. On
 * win32 `join` yields `notes\acme\d7`, which both reject — so materialization
 * silently scanned zero scopes there, every read fell back to folding the log, and
 * the projection the whole architecture rests on was never built. See COD-12.
 */
export async function scopesOnDisk(logRoot: string): Promise<string[]> {
  const found: string[] = [];
  const walk = async (rel: string): Promise<void> => {
    let entries;
    try { entries = await readdir(join(logRoot, rel), { withFileTypes: true }); } catch { return; }
    if (entries.some((e) => e.isFile() && e.name.endsWith(SHARD_EXT))) found.push(rel);
    for (const e of entries) {
      if (e.isDirectory() && e.name !== ".git") await walk(rel ? `${rel}/${e.name}` : e.name);
    }
  };
  await walk("");
  return found.sort();
}

/**
 * What the calling session has staged, read on top of the log (plan 2.4: "a caller reads its
 * own staged acts"). Registered by the sync engine, which this module cannot import; absent,
 * nobody has staged anything.
 */
export interface OverlayHook {
  active(logRoot: string, scope: string): boolean;
  events(logRoot: string, scope: string, tip: LogEvent[]): Promise<LogEvent[]>;
}
let overlay: OverlayHook | null = null;
export function registerOverlay(h: OverlayHook): void { overlay = h; }
/** Whether a read of `scope` includes staged acts — and so must not be cached as the log's. */
export const overlayActive = (logRoot: string, scope: string): boolean => !!overlay?.active(logRoot, scope);

async function collect(logRoot: string, scope: string): Promise<{ events: LogEvent[]; damage: ShardDamage[]; malformed: ShardLines["malformed"] }> {
  const read = await collectTip(logRoot, scope);
  if (!overlay?.active(logRoot, scope)) return read;
  const seen = new Set(read.events.map((e) => e.id));
  const extra = (await overlay.events(logRoot, scope, read.events)).filter((e) => !seen.has(e.id));
  return { ...read, events: [...read.events, ...extra] };
}

async function collectTip(logRoot: string, scope: string): Promise<{ events: LogEvent[]; damage: ShardDamage[]; malformed: ShardLines["malformed"] }> {
  const dir = join(logRoot, scope);
  let names: string[];
  try { names = await readdir(dir); } catch { return { events: [], damage: [], malformed: [] }; }
  const seen = new Set<string>();
  const damage: ShardDamage[] = [];
  const malformed: ShardLines["malformed"] = [];
  const all: LogEvent[] = [];
  for (const n of names.filter((n) => n.endsWith(SHARD_EXT)).sort()) {
    // Named `<scope>/<shard>`, not by absolute path: the evidence goes into a stored
    // diagnostic and is compared against later readings of the same scope, and an
    // absolute path differs between two clones of one sidecar.
    const shard = await readShardLines(join(dir, n), `${scope}/${n}`);
    damage.push(...shard.damage);
    malformed.push(...shard.malformed);
    for (const { event } of shard.events) {
      if (seen.has(event.id)) continue;
      seen.add(event.id);
      all.push(event);
    }
  }
  return { events: sortEvents(all), damage, malformed };
}

/** Why a scope may not be answered from. One diagnostic, not a taxonomy. */
export interface ScopeDiagnostic {
  /**
   * `sidecar-missing` and `sidecar-mismatch` are the odd ones out and are raised by the
   * MATERIALIZER, not by `scopeStatus`: they are facts about the configured path rather
   * than about a scope's events, and there are no events to judge when they fire.
   * `unreadable` is a read that threw (`docsVerdict`).
   */
  reason: "sidecar-missing" | "sidecar-mismatch" | "unmigrated" | "corrupt-shard" | "protocol" | "unreadable";
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
 * Whether a scope may be answered from, and if not, the one thing to say.
 *
 * Precedence is fixed rather than by severity: unreadable bytes mean the event set
 * is not the one on disk, and an envelope this reader does not understand makes every
 * later judgement unreliable. Reporting the outermost failure first is also what makes
 * the diagnostic deterministic, which a stored one has to be.
 *
 * A ratchet or domain rejection is deliberately not here. The fold refuses
 * forbidden transitions ON PURPOSE, and counting one as a reason the scope is
 * unreadable would let any client wedge a scope by emitting an event the rules
 * correctly refuse — a denial of service built out of a safety mechanism.
 */
export function scopeStatus(events: LogEvent[], damage: ShardDamage[] = []): ScopeStatus {
  const verdict = (diagnostic: ScopeDiagnostic): ScopeStatus => ({ status: "blocked", diagnostic });
  /**
   * Before everything else, because it is the only failure about the BYTES.
   *
   * Every other diagnostic here is a claim about a set of events that was read; this
   * one says the set is not the set that is on disk. A wholly-garbage shard read as an
   * empty one and the scope answered `complete`, so a universe whose findings had been
   * destroyed presented as a universe with no findings — the silent emptying this
   * whole check exists to stop. The repair is exact and local: delete the line (no build has
   * ever read it, so nothing is lost).
   */
  if (damage.length) {
    const first = damage[0]!;
    return {
      status: "blocked",
      diagnostic: {
        reason: "corrupt-shard",
        detail: `${damage.length} line(s) in this scope's shards are not JSON and no build `
          + `can read them — the events they held are gone, not merely unfolded. First at `
          + `${damageRef(first)}: ${JSON.stringify(first.sample)}. A shard is append-only, so `
          + `deleting the damaged line(s) in the sidecar and committing repairs it; nothing `
          + `readable is lost, because nothing here was ever readable.`,
        evidence: damage.slice(0, 5).map(damageRef),
      },
    };
  }
  const ahead = events.filter((e) =>
    (e.sidecarProtocol ?? SIDECAR_PROTOCOL) > SIDECAR_PROTOCOL
    || (e.eventSchema ?? EVENT_SCHEMA) > EVENT_SCHEMA);
  if (ahead.length) {
    const top = Math.max(...ahead.map((e) => e.sidecarProtocol ?? 0));
    const schema = Math.max(...ahead.map((e) => e.eventSchema ?? 0));
    return verdict({
        reason: "protocol",
        detail: `${ahead.length} event(s) were written by a newer codemap `
          + `(protocol ${top} / schema ${schema}; this build reads `
          + `${SIDECAR_PROTOCOL} / ${EVENT_SCHEMA}). Upgrade to read this scope.`,
        evidence: ahead.slice(0, 5).map((e) => e.id),
    });
  }
  return { status: "complete" };
}

/**
 * The order every reader folds in: `seq`, the position the remote accepted each event at.
 * Within one scope's file that is line order; across scopes (the standard's law and
 * evidence, a merged read) it is the only order there is. Ids and `after` order nothing: an
 * id is minted at staging, and a staged act can land after events minted later.
 *
 * An event without `seq` keeps its place in the input, and the `seq` events are sorted into
 * the remaining places. A real sidecar never holds both — an unmigrated one is refused before
 * anything folds — so this decides only fixtures that plant merge-era events in a file.
 */
export function sortEvents(events: LogEvent[]): LogEvent[] {
  const slots: number[] = [];
  events.forEach((e, i) => { if (typeof e.seq === "number") slots.push(i); });
  const linear = slots.map((i) => events[i]!).sort((a, b) => a.seq! - b.seq!);
  const out = [...events];
  slots.forEach((slot, k) => { out[slot] = linear[k]!; });
  return out;
}

/**
 * What an act's author had READ, for a fold whose rule is about what a person knew ("a
 * resolution is by someone who saw both sides", "revising another person's answer"). Position
 * cannot answer it: a staged act lands after events its author never saw.
 */
export interface ReadSets {
  /** Had the author of `from` read `target`? Unknown ids answer false. */
  saw(from: string, target: string): boolean;
}

/**
 * The events an event's read set names directly: its `after`, and — for a merge-era event —
 * its own writer's previous event, because merge-era `after` was compressed against the
 * writer's chain. A linear event's `writerPrev` is placed at the tip and says nothing about
 * what its author read: two sessions on one clone share a writer.
 */
function readEdges(e: LogEvent, byId: Map<string, LogEvent>): string[] {
  const after = e.after ?? [];
  const linear = typeof e.seq === "number" && (e.sidecarProtocol ?? 1) >= 2;
  if (linear || !e.writerPrev || e.writerPrev === GENESIS) return after;
  const prev = byId.get(e.writerPrev);
  return prev && prev.writer === e.writer ? [...after, prev.id] : after;
}

/** The read set of each event: the closure over `readEdges`, computed when asked. */
export function readSets(events: LogEvent[]): ReadSets {
  const byId = new Map(events.map((e) => [e.id, e]));
  const memo = new Map<string, Set<string>>();
  const closure = (from: LogEvent): Set<string> => {
    let seen = memo.get(from.id);
    if (seen) return seen;
    seen = new Set<string>();
    const stack = [...readEdges(from, byId)];   // a copy: `readEdges` may return `after` itself
    while (stack.length) {
      const e = byId.get(stack.pop()!);
      if (!e || seen.has(e.id)) continue;
      seen.add(e.id);
      stack.push(...readEdges(e, byId));
    }
    memo.set(from.id, seen);
    return seen;
  };
  return {
    saw(from, target) {
      const e = byId.get(from);
      return !!e && closure(e).has(target);
    },
  };
}

/**
 * What a new act records as `after`: every event of `events` that no other's read set names
 * directly. Their closure is all of `events`, so the act is credited with exactly what its
 * author read — the tip, and their own staged acts. Usually one id.
 */
export function causalHeads(events: LogEvent[]): string[] {
  const byId = new Map(events.map((e) => [e.id, e]));
  const named = new Set(events.flatMap((e) => readEdges(e, byId)));
  return events.filter((e) => !named.has(e.id)).map((e) => e.id);
}
