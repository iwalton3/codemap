/**
 * The sidecar: a git repo that carries shared review state, and the sync over it.
 *
 * The remote is the one serializer (docs/PROPOSAL-online-only-sync.md). A sync fetches, moves the
 * working tree to the remote tip, replays this session's staged ops against it, commits, and
 * pushes as a fast-forward; a lost race starts again from the new tip. Nothing is merged.
 */

import { spawnSync } from "node:child_process";
import { mkdir, readFile, readdir, rm, stat, truncate, writeFile } from "node:fs/promises";
import { existsSync, mkdirSync, realpathSync, readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { ANCHOR_SCHEME, HASH_SCHEME } from "./schema.js";
import { GRAMMAR_VERSIONS } from "./grammar-versions.js";
import { MATERIALIZER_VERSION } from "./materializer-version.js";
import { bumpEvent, MATERIALIZER_SCOPE } from "./materializer-log.js";
import { gitBin } from "./git.js";
import { withSidecarLock, touchHeldLocks } from "./lock.js";
import {
  SHARD_EXT, LINEAR_SHARD, SIDECAR_PROTOCOL, EVENT_SCHEMA, principalKey, splitShard, damageRef, appendLinear, atTip, causalHeads,
  doorFor, identicalAct, isLegacyShard, isMigrationMarker, maxSeq, SIDECAR_ATTRIBUTES, SIDECAR_ATTRIBUTES_PATH, mintId, readScope, sortEvents, writeDoor, writerFor, type DoorFold, type LogEvent, type ShardDamage, type StagedEvent,
} from "./eventlog.js";
import { withoutOverlay } from "./sync-session.js";
import { pushGate } from "./validation.js";
import { allQueuedIds, drop, getMeta, markConflict, markInflight, markLanded, markStaged, markUnknown, pending, setMeta, setTx, stage } from "./sync-queue.js";
import { recordLockout } from "./lockout.js";
import type { Actor } from "./schema.js";

/**
 * Two paths naming the same directory. `realpath` both: macOS `/tmp` is a symlink
 * to `/private/tmp`, and git answers with the resolved form, so a string compare
 * would decide a perfectly good sidecar was not its own repo.
 */
function samePath(a: string, b: string): boolean {
  if (!a || !b) return false;
  // `.native` goes through the OS resolver (`GetFinalPathNameByHandle` on Windows),
  // which expands 8.3 short names; the JS implementation walks lstat and does not.
  // `os.tmpdir()` on Windows is often the short form (`C:\Users\RUNNER~1\...`) while
  // `git rev-parse --show-toplevel` returns the long one, so without this the two
  // never compare equal and the guard below refuses every sidecar under a temp dir.
  try { return realpathSync.native(a) === realpathSync.native(b); } catch { return a === b; }
}

/**
 * The longest a single git call can block. The sidecar lock's stale window is set
 * wider than this on purpose; `lock.test.ts` fails if they ever cross.
 */
export const GIT_CALL_TIMEOUT_MS = 180_000;

/**
 * Every git call goes through here, and every git call refreshes the sidecar lock.
 *
 * `spawnSync` blocks the event loop, so the lock's `setInterval` heartbeat cannot
 * fire during a call — and a run of consecutive calls never turns the loop either,
 * so it cannot fire between them. Stamping here is what keeps a legitimately-slow
 * holder from being stolen from mid-sync. Before AND after: before, so the clock
 * starts fresh against the block about to happen; after, so a long call is not
 * followed by an unrefreshed gap.
 */
const g = (root: string, args: string[]) => {
  const r = gRaw(root, args);
  return { ok: r.ok, out: r.out.trim(), err: r.err.trim() };
};

/**
 * The same call with stdout UNTRIMMED.
 *
 * Only shard validation wants this, and it is not a preference: whether a shard's
 * last line is a torn append or ordinary damage is decided by whether the file ends
 * in a newline, so trimming the blob makes every inbound shard's final line look
 * torn and exempts exactly the byte range a check is for.
 */
const gRaw = (root: string, args: string[]) => {
  touchHeldLocks();
  const r = spawnSync(gitBin(), args, { cwd: root, encoding: "utf8", maxBuffer: 1 << 28, timeout: GIT_CALL_TIMEOUT_MS });
  touchHeldLocks();
  return { ok: r.status === 0, out: r.stdout ?? "", err: (r.stderr ?? "").trim() };
};

/**
 * The branch name, including before the first commit.
 *
 * NOT `rev-parse --abbrev-ref HEAD`: on an unborn branch that prints the literal
 * "HEAD" and exits non-zero, so taking its stdout gave a branch called "HEAD",
 * `origin/HEAD` did not resolve, and the very first pull a new person ever ran
 * decided there was nothing to fetch. `symbolic-ref` answers on an unborn branch,
 * which is exactly the case that matters here.
 */
const branchOf = (root: string): string => g(root, ["symbolic-ref", "--short", "HEAD"]).out || "main";

/**
 * Shards that do not parse, and the two places they are refused.
 *
 * The hole this closes: `readShardLines` drops an unparseable line by design, so a
 * shard that is wholly garbage yields no events and its scope reads `complete`. The
 * team's findings for that scope simply vanish, and every surface agrees the queue is
 * clear. `scopeStatus` now blocks on it — but a blocked scope is a diagnosis whenever
 * somebody next happens to read, and these two are what speak at the moment it matters.
 *
 * **Both REFUSE, and the reason is the same one twice.** A genuinely broken sidecar
 * should stop and say so rather than be made worse — outbound, committing damage makes
 * it everybody's; inbound, taking it puts the bytes in one more clone's history and
 * destroys the scope on one more machine. The collateral on the inbound side is real and
 * accepted: the good events in that pull do not arrive either. That is the trade a broken
 * shared log deserves, and stopping is what gets it repaired.
 *
 * This is NOT a defence against a hostile shard, and it should not be tuned as one. The
 * case it is built for is a sidecar that is genuinely damaged — a broken build, a disk, an
 * interrupted write — where continuing quietly is how the damage spreads.
 *
 * The outbound half hangs off `commitLocal`, because that is the one function that commits:
 * a check only on the push would leave the damage in the local history with a clean
 * `git status` over it, which the next push would then publish without ever looking.
 *
 * Neither repairs, and nothing else here does either — see `separatorFor` in `eventlog.ts`
 * for why a torn tail is sealed in rather than truncated. Quietly dropping bytes that do
 * not parse would destroy the evidence of whatever put them there, and cannot tell a
 * crash from a disk that ate an event somebody had already read.
 */

/**
 * Bytes that are not JSON. A wrong SHAPE is not damage any more: it parses, so it is newer
 * than this build (owner, batch 1) — reads skip it, pushes block (`newerIn`).
 */
function shardDamage(text: string, as: string): ShardDamage[] {
  return splitShard(text, as).damage;
}

/** Lock this clone on the first damaged line, the way a read that met it would (plan 1.2). */
const lockOn = (root: string, damage: ShardDamage[]): void => {
  const d = damage[0];
  if (d) recordLockout(root, { id: d.id ?? "(unreadable bytes)", kind: d.kind ?? "(unreadable bytes)",
    why: d.why ?? "the line is not JSON, so no build can read the event it held", scope: dirname(d.shard), shard: d.shard, line: d.line });
};

/** The one sentence both gates end with, so a person is never left without the repair. */
const damageDetail = (damage: ShardDamage[]): string =>
  damage.slice(0, 3).map((d) => `  ${damageRef(d)}: ${d.why ? `${d.id} (${d.kind}): ${d.why}` : JSON.stringify(d.sample)}`).join("\n")
  + (damage.length > 3 ? `\n  … and ${damage.length - 3} more` : "");

/**
 * Every shard this commit would introduce, checked before it is made.
 *
 * Scoped to what `git status` reports rather than to the whole tree — the same listing
 * `commitLocal` uses to decide there is anything to do at all. A shard nobody touched is
 * somebody else's problem, and blocking on it would wedge this clone over a file it did
 * not write.
 */
function damagedWorkingShards(root: string): ShardDamage[] {
  const out: ShardDamage[] = [];
  // `gRaw`, NOT `g`. `g` trims, and porcelain's status field is two columns wide with a
  // LEADING SPACE for the ordinary case — an unstaged modification is `" M path"`. Trimming
  // ate that space on the FIRST entry only, so the regex below failed, the fallback took
  // the whole string as a path, the read threw ENOENT into the catch, and the
  // alphabetically-first modified shard was silently never checked. The gate looked like
  // it worked because every entry after the first still had its space.
  for (const entry of gRaw(root, ["status", "--porcelain", "-z", "--untracked-files=all"]).out.split("\0")) {
    if (!entry) continue;
    // `XY <path>`; a rename also emits its source as a bare following entry, which has
    // no status prefix. Shards are never renamed, so taking the whole string when the
    // prefix is absent only ever validates one extra file, which is harmless.
    const path = /^.. (.*)$/.exec(entry)?.[1] ?? entry;
    if (!path.endsWith(SHARD_EXT)) continue;
    try { out.push(...shardDamage(readFileSync(join(root, path), "utf8"), path)); } catch { /* deleted, or raced */ }
  }
  return out;
}

/**
 * Every shard that taking the fetched COMMIT would change, read off that commit. A sync only
 * ever moves to the remote tip, so what arrives is whatever differs from HEAD; an unborn HEAD
 * takes everything. The content at `remoteSha` is what lands, so a shard damaged and fixed
 * within the incoming range reads as fine — what arrives is validated, not every state it
 * passed through.
 */
function damagedInboundShards(root: string, headSha: string, remoteSha: string): ShardDamage[] {
  const listing = headSha
    ? g(root, ["diff", "--name-only", "-z", headSha, remoteSha])
    : g(root, ["ls-tree", "-r", "--name-only", "-z", remoteSha]);
  if (!listing.ok) return [];
  const out: ShardDamage[] = [];
  for (const path of listing.out.split("\0")) {
    if (!path.endsWith(SHARD_EXT)) continue;
    const blob = gRaw(root, ["show", `${remoteSha}:${path}`]);
    if (!blob.ok) continue; // deleted on their side
    out.push(...shardDamage(blob.out, path));
  }
  return out;
}

/**
 * Commit whatever is in the tree.
 *
 * **Three outcomes, not two.** This returned a bare boolean that was `false` both
 * for "nothing to commit" and for "the commit failed", so no caller could tell a
 * clean no-op from a lost finding — and both call sites dropped it anyway. With a
 * failing commit the shards stay staged and the push is a no-op that exits 0, so `sync` reported `pushed: true` while nothing left the
 * machine. Reproduced with `commit.gpgsign=true` and an unusable key, which is an
 * ordinary global git config. See the architecture doc's R1.
 */
type CommitOutcome = "nothing" | "committed" | { error: string };

function commitLocal(root: string, message: string): CommitOutcome {
  if (!g(root, ["status", "--porcelain"]).out) return "nothing";
  // THE gate: this is the only place anything is committed, and once damage is in the local
  // history `git status` is clean over it, so the next push would publish it unexamined.
  const damaged = damagedWorkingShards(root);
  if (damaged.length) {
    lockOn(root, damaged);
    return { error: `refusing to commit ${damaged.length} unreadable line(s) — bytes that are not JSON — `
      + `and committing them would put them in front of the whole team:\n${damageDetail(damaged)}\n`
      + `The store is locked until they are repaired: see docs/log-repair.md. Until then this clone does `
      + `not sync in either direction.` };
  }
  g(root, ["add", "-A"]);
  const c = g(root, ["commit", "-q", "-m", message]);
  if (!c.ok) return { error: `the sidecar commit failed, so nothing can be pushed: ${(c.err || c.out).slice(0, 300)}` };
  return "committed";
}

/**
 * Manifests are per-principal, in a directory.
 *
 * A single shared manifest cannot work: every clone rewrites it with its OWN
 * schemes, so a pull would compare a file to itself and see agreement. One file
 * per person answers the more useful question: not "does this sidecar match me"
 * but "who on this team does not".
 */
/** Re-exported: the lock lives below this module so the event log can take it too. */
export { withSidecarLock } from "./lock.js";

/**
 * WHICH sidecar this is — an identity that survives a move and a re-clone, and differs
 * between two teams' repos.
 *
 * The oldest root commit. Nothing else in reach has all three properties:
 *
 * - **The PATH does not**, and that is the whole reason this exists: a sidecar that moves
 *   or is re-cloned to a new directory is the same sidecar, and refusing it would break an
 *   ordinary recovery.
 * - **A remote URL does not**, because a sidecar with no remote is a perfectly good local
 *   one and the whole design works offline.
 * - **A tip commit does not**, because it moves on every append.
 *
 * A root commit is created once, by `ensureSidecar`, and pushed on the first sync — so a
 * clone of the same repo has it, and `merge-base --is-ancestor` still finds it after an
 * `--allow-unrelated-histories` merge has added a second root beside it — a history a
 * sidecar from before the linear log may carry. Joining a team now replaces the local
 * history with the remote's instead (`joined` in `syncLinear`).
 *
 * Null means the sidecar has no commits yet — a brand-new one, which is not yet anything.
 *
 * **Not memoised**, for the same reason `isSameSidecar` is not, and the case that proved
 * it is the one that matters most: an orphan checkout or a `commit-tree` replaces the
 * history at the SAME path, and a cached root then outlives it. `adoptSidecar` — the only
 * way out of a refused binding — recorded the stale lineage and left the store blocked
 * until the process restarted. An escape hatch that needs a restart is not one. Every
 * caller here is a transport or a write, so this is never on a hot read path.
 */
export function sidecarLineage(root: string): string | null {
  const r = g(root, ["rev-list", "--max-parents=0", "HEAD"]);
  if (!r.ok || !r.out) return null;
  // Sorted so the choice among several roots is deterministic; any of them identifies the
  // history, and `isSameSidecar` asks about ancestry rather than equality.
  const roots = r.out.split("\n").map((l) => l.trim()).filter(Boolean).sort();
  return roots[0] ?? null;
}

/**
 * Is the sidecar at `root` the one `lineage` came from — moved, re-cloned or merged?
 *
 * **Not memoised, deliberately.** A positive cache was tried on the argument that HEAD
 * only advances, so a commit that is an ancestor stays one. Nothing enforces that: an
 * orphan checkout replaces the history at the same path, git then correctly says the
 * recorded lineage is NOT an ancestor, and a process-lifetime cache kept answering
 * `true` — in a long-running `serve.js`, for as long as it ran. The cache existed to keep
 * a spawn off the hot read path; the callers now ask only when they are about to fold,
 * which is when they are already doing real work, so there is nothing left to buy.
 */
export function isSameSidecar(root: string, lineage: string): boolean {
  return g(root, ["merge-base", "--is-ancestor", lineage, "HEAD"]).ok;
}

export const MANIFEST_DIR = "manifests";

/**
 * What the shards were written under — the team-wide compatibility contract.
 *
 * Only `anchorScheme` is a hard gate. An anchor id is the identity of a piece of
 * code, so a store minted under another derivation targets symbols that do not
 * exist here and there is nothing sensible to show. Hashes are different: a
 * witness carries its own HASH_SCHEME and a mismatch already reads as
 * `unverifiable` rather than as drift, so a hash or grammar difference degrades
 * instead of breaking — which is what that machinery was built for, and what
 * stops one person upgrading from locking the rest of the team out mid-rollout.
 */
export interface SidecarManifest {
  principal: string;
  anchorScheme: number;
  hashScheme: number;
  grammars: Record<string, string>;
  /** The fold version this person's build runs; see `peersAhead`. Absent from older builds. */
  materializerVersion?: number;
}

export const currentManifest = (principal: string): SidecarManifest => ({
  principal,
  anchorScheme: ANCHOR_SCHEME,
  hashScheme: HASH_SCHEME,
  grammars: { ...GRAMMAR_VERSIONS },
  materializerVersion: MATERIALIZER_VERSION,
});

/**
 * Whether a teammate's build folds a newer materializer version than this one (owner, C17): a
 * validator failure is then read as newer, not damage, until this build catches up.
 */
export async function peersAhead(root: string): Promise<boolean> {
  return (await readManifests(root)).some((m) => typeof m.materializerVersion === "number" && m.materializerVersion > MATERIALIZER_VERSION);
}

export interface Incompat {
  fatal: boolean;
  message: string;
}

/** Compare one peer's manifest to mine. Null = nothing worth saying. */
export function checkManifest(theirs: SidecarManifest, mine: SidecarManifest): Incompat | null {
  // My OWN entry, which is not automatically me: one person on two machines writes
  // one manifest file from both, and skipping it outright left the supported
  // two-machine case ungated on the pull AND the push. The direction is what decides
  // it — if the remote copy is ahead, this machine is the stale one and its
  // scheme-N events would land in a log that has moved on. If it is behind, this is
  // the upgrade writing over its own older claim, which is the normal path.
  if (theirs.principal === mine.principal) {
    return theirs.anchorScheme > mine.anchorScheme
      ? {
        fatal: true,
        message:
          `your own manifest on this sidecar is ANCHOR_SCHEME ${theirs.anchorScheme} and this machine is ${mine.anchorScheme}. `
          + `Another of your machines is on a newer codemap; anchor ids are derived differently, so anything written here `
          + `would mis-target. Upgrade this machine before syncing.`,
      }
      : null;
  }
  const who = theirs.principal;
  if (theirs.anchorScheme !== mine.anchorScheme) {
    return {
      fatal: true,
      message:
        `${who} is writing under ANCHOR_SCHEME ${theirs.anchorScheme} and this codemap is ${mine.anchorScheme}. `
        + `Anchor ids are derived differently, so their findings point at symbols that do not exist here. `
        + `Get onto the same codemap version before syncing — merging would silently mis-target every one of them.`,
    };
  }
  const notes: string[] = [];
  if (theirs.hashScheme !== mine.hashScheme) {
    notes.push(`${who} is on HASH_SCHEME ${theirs.hashScheme} (this is ${mine.hashScheme}): their witnesses read as unverifiable until re-witnessed`);
  }
  for (const [name, v] of Object.entries(theirs.grammars ?? {})) {
    const local = mine.grammars[name];
    if (local && local !== v) notes.push(`${who} has grammar ${name} ${v} (this is ${local}): bodies hash differently, so witnesses will not match across the two`);
  }
  return notes.length ? { fatal: false, message: notes.join("; ") } : null;
}

/** Every peer's manifest, mine included. */
export async function readManifests(root: string): Promise<SidecarManifest[]> {
  const dir = join(root, MANIFEST_DIR);
  let names: string[];
  try { names = await readdir(dir); } catch { return []; }
  const out: SidecarManifest[] = [];
  for (const n of names.filter((n) => n.endsWith(".json"))) {
    try {
      const text = await readFile(join(dir, n), "utf8");
      if (isMigrationMarker(`${MANIFEST_DIR}/${n}`, text)) continue;
      const m = JSON.parse(text) as SidecarManifest;
      if (m && typeof m.principal === "string" && typeof m.anchorScheme === "number") out.push(m);
    } catch { /* somebody else's client wrote something odd; not our problem to die on */ }
  }
  return out;
}

/** The worst thing to say about the team's manifests, or null. Fatal wins over advisory. */
export function checkPeers(all: SidecarManifest[], mine: SidecarManifest): Incompat | null {
  const found = all.map((t) => checkManifest(t, mine)).filter((x): x is Incompat => !!x);
  return found.find((x) => x.fatal) ?? (found.length ? { fatal: false, message: found.map((x) => x.message).join("; ") } : null);
}

/**
 * Is this sidecar's committer config already what we would write?
 *
 * A fast path only — reading the file rather than asking git, because `ensureSidecar`
 * runs on every sync and three `git config` spawns there cost the test suite ~19%.
 * Being wrong is cheap in the safe direction: a false negative just writes the same
 * values again, and the write is idempotent. Never treat this as the source of truth.
 */
function gitConfigLooksSet(cfg: string, identity: string): boolean {
  return new RegExp(`^\\s*email\\s*=\\s*${identity.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*$`, "m").test(cfg)
    && /^\s*gpgsign\s*=\s*false\s*$/m.test(cfg);
}

/** Make `root` a usable sidecar: its own git repo, with its own committer identity, and a manifest. */
export async function ensureSidecar(root: string, actor?: Actor): Promise<{ created: boolean } | { error: string }> {
  await mkdir(root, { recursive: true });
  // Is this path a repo ROOT — not "is it inside one". The difference is the whole
  // safety of the operation: the documented zero-config layout puts the sidecar at
  // `.codemap/sidecar` INSIDE the code repo, which is inside a work tree, so asking
  // the weaker question skipped `init` and pointed every later git call at the
  // user's own repository. `commitLocal` there is `git add -A` + commit, and `push`
  // finds that repo's `origin` — one sync committed a developer's uncommitted work
  // and pushed it to the team remote, while sharing nothing, because the shards sit
  // under the `*`-ignored `.codemap/`.
  const top = g(root, ["rev-parse", "--show-toplevel"]);
  const isRepoRoot = top.ok && samePath(top.out, root);
  if (!isRepoRoot) {
    const init = g(root, ["init", "-q", "-b", "main"]);
    if (!init.ok) return { error: `could not init the sidecar at ${root}: ${init.err}` };
    // `init` inside another repo succeeds and yields a real, separate repo — but if
    // it somehow did not, every later call would operate on the enclosing one.
    const after = g(root, ["rev-parse", "--show-toplevel"]);
    if (!after.ok || !samePath(after.out, root)) {
      return { error: `the sidecar at ${root} is not its own git repository — it resolves to ${after.out || "no repository"}. Refusing to use it: every write would land in that repository instead.` };
    }
  }
  // The sidecar is a machine artifact, not authored history, so it carries its own
  // committer identity and signs nothing. Without this it inherits the user's global
  // config — and a `commit.gpgsign=true` with a key git cannot use makes every commit
  // fail, which is one half of R1. Local config, so nothing about the user's own
  // repositories changes. Checked on every ensure rather than only on `init`, because
  // a sidecar cloned from a teammate never goes through `init` and would otherwise
  // never be configured at all — which is precisely the clone R1 bites.
  const identity = actor?.principal?.trim() || "codemap@localhost";
  const cfg = await readFile(join(root, ".git", "config"), "utf8").catch(() => "");
  if (!gitConfigLooksSet(cfg, identity)) {
    g(root, ["config", "user.email", identity]);
    g(root, ["config", "user.name", "codemap"]);
    g(root, ["config", "commit.gpgsign", "false"]);
  }
  // Its own check, not inside the identity's: a clone configured before this existed already
  // has the identity and would never get it. With `.gitattributes`, see SIDECAR_ATTRIBUTES.
  if (!/^\s*autocrlf\s*=\s*false\s*$/m.test(cfg)) {
    g(root, ["config", "core.autocrlf", "false"]);
  }
  await writeFile(join(root, SIDECAR_ATTRIBUTES_PATH), SIDECAR_ATTRIBUTES, "utf8");
  if (actor) {
    await mkdir(join(root, MANIFEST_DIR), { recursive: true });
    await writeFile(
      join(root, MANIFEST_DIR, principalKey(actor.principal) + ".json"),
      JSON.stringify(currentManifest(actor.principal), null, 2) + "\n",
      "utf8",
    );
  }
  return { created: !isRepoRoot };
}

/** Every event line currently on disk — the cheap way to say what a sync gained. */
export async function countEvents(root: string): Promise<number> {
  let total = 0;
  const walk = async (dir: string): Promise<void> => {
    let entries;
    try { entries = await readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (e.name === ".git") continue;
      const p = join(dir, e.name);
      if (e.isDirectory()) await walk(p);
      else if (e.name.endsWith(SHARD_EXT)) {
        try { total += (await readFile(p, "utf8")).split("\n").filter((l) => l.trim()).length; } catch { /* raced */ }
      }
    }
  };
  await walk(root);
  return total;
}

export interface PullResult { gained: number; warning?: string; joined?: boolean }

/**
 * Fetch, and it is safe to do this OUTSIDE the sidecar lock.
 *
 * The lock exists to keep two fetch-replay-push sequences from interleaving against
 * one working tree. A fetch touches neither the working tree nor the index — it
 * writes objects and `refs/remotes/*`, and git serializes those itself. It is also
 * the slow part: network-bound, up to the full git timeout, during which holding the
 * lock stalls every other local reader and writer of this sidecar for no reason.
 *
 * `false` means there is no remote, which is not an error: a sidecar with no remote
 * is a local one, and its own history is the only serializer there is.
 */
/** What an already-attempted fetch left behind: done, not attempted, or its failure. */
type FetchState = boolean | { error: string };

/**
 * Does this sidecar have a remote configured?
 *
 * Read from `.git/config` rather than spawned. `git remote` is a config lookup behind
 * a process start, and this sits on the hot path of every pull and every push — one
 * 12-test file spawned it 1,488 times. A spawn is ~5ms on Linux and several times
 * that on Windows, where the same suite runs 6x slower largely for this reason.
 *
 * No cache, deliberately: the file is the source of truth and reading it is a syscall,
 * so this stays correct when a remote is added mid-process — which the oracle does.
 *
 * Falls back to the spawn when the config cannot be read. A linked worktree keeps
 * `.git` as a FILE pointing elsewhere; a sidecar is always its own ordinary repo
 * today, but guessing wrong here would decide a remote-backed sidecar is local-only
 * and silently stop syncing, which is the one failure this must not invent.
 */
function hasRemote(root: string): boolean {
  try {
    return /^\s*\[remote /m.test(readFileSync(join(root, ".git", "config"), "utf8"));
  } catch {
    return !!g(root, ["remote"]).out;
  }
}

// Another git process in this clone holds a ref lock. Two codemap processes share a clone (the
// web server and an MCP session) and the first fetch runs outside the sidecar lock, so this is
// ordinary contention, not an unreachable remote.
const REF_LOCKED = /cannot lock ref|Unable to create '[^']*\.lock'/;

async function fetchRemote(root: string): Promise<{ fetched: boolean } | { error: string }> {
  if (!hasRemote(root)) return { fetched: false };
  for (let i = 0; ; i++) {
    const r = g(root, ["fetch", "--quiet", "origin"]);
    if (r.ok) return { fetched: true };
    if (i < 4 && REF_LOCKED.test(r.err)) { await sleep(100 * (i + 1)); continue; }
    return { error: `fetch failed: ${r.err.slice(0, 300)}` };
  }
}

/**
 * What a LOCKED clone may still do (plan 1.2): fetch, and look at what the fetched tip would
 * bring, without taking it. Nothing is written but the remote-tracking ref. The first damaged
 * line inbound, or null; an error when the fetch itself fails.
 */
export async function inboundDamage(root: string): Promise<ShardDamage | null | { error: string }> {
  const f = await fetchRemote(root);
  if ("error" in f) return f;
  if (!f.fetched) return null;
  const remoteSha = g(root, ["rev-parse", "--verify", "--quiet", `origin/${branchOf(root)}`]).out;
  if (!remoteSha) return null;
  const beforeSha = g(root, ["rev-parse", "--verify", "--quiet", "HEAD"]).out;
  return damagedInboundShards(root, beforeSha, remoteSha)[0] ?? null;
}

/** Bring the tree to the remote tip, pushing nothing. With no remote, a no-op. */
export async function pull(root: string, actor?: Actor): Promise<PullResult | { error: string }> {
  return pullLinear(root, actor);
}

/**
 * Peers' manifests as they exist at a fetched COMMIT, without touching the tree.
 *
 * A sha rather than `origin/<branch>`: the ref can move under us now that fetching
 * does not take the lock, and a caller that vets one state must take that same one.
 */
const manifestCache = new Map<string, SidecarManifest[]>();
/** A full sha — the only rev whose content is guaranteed never to change. */
const isSha = (rev: string): boolean => /^[0-9a-f]{40}$/.test(rev);

function remoteManifests(root: string, rev: string): SidecarManifest[] {
  // Memoized on (root, sha) and never invalidated. That is sound ONLY because the key
  // is a content address: the tree at a sha cannot change, so a hit can never be
  // stale. Guarded on the rev actually being a full sha — a branch name moves, and
  // this would then serve one answer forever.
  //
  // Worth the cache because the sidecar re-reads these constantly: one `ls-tree` plus
  // a `show` per peer on every pull. One 12-test file made 3,704 such calls, and a
  // process spawn is ~5ms on Linux and several times that on Windows, where the whole
  // suite runs 6x slower for exactly this kind of reason.
  const key = isSha(rev) ? `${root}\u0000${rev}` : null;
  if (key) { const hit = manifestCache.get(key); if (hit) return hit; }

  const listing = g(root, ["ls-tree", "--name-only", `${rev}:${MANIFEST_DIR}`]);
  // A failed listing is NOT cached: the sha may simply not be fetched yet, and a
  // later fetch must be able to change the answer. Only a real reading is memoized.
  if (!listing.ok) return [];
  const out: SidecarManifest[] = [];
  for (const name of listing.out.split("\n").map((s) => s.trim()).filter((s) => s.endsWith(".json"))) {
    const blob = gRaw(root, ["show", `${rev}:${MANIFEST_DIR}/${name}`]);
    if (!blob.ok || isMigrationMarker(`${MANIFEST_DIR}/${name}`, blob.out)) continue;
    try {
      const m = JSON.parse(blob.out) as SidecarManifest;
      if (m && typeof m.principal === "string" && typeof m.anchorScheme === "number") out.push(m);
    } catch { /* not ours to die on */ }
  }
  if (key) manifestCache.set(key, out);
  return out;
}

/**
 * Did the remote branch actually take our tip?
 *
 * `git push` exiting 0 does not mean it did. A push of a tip the remote already has
 * is a successful no-op, which is exactly what a sync whose commit failed performs —
 * so the exit code cannot tell "I sent my findings" from "I sent nothing". Push
 * updates the remote-tracking ref on success, so this costs no network.
 *
 * Note what this does NOT catch: a commit that never happened leaves HEAD at an old
 * commit the remote does have, and this passes. That is why the commit failure is
 * raised at its source rather than inferred here. The two checks cover different
 * lies and both are needed.
 */
function remoteHasHead(root: string, branch: string): boolean {
  return g(root, ["merge-base", "--is-ancestor", "HEAD", `refs/remotes/origin/${branch}`]).ok;
}

/** Receive only: make `root` a sidecar if it is not one yet, then bring it to the remote tip. */
export async function receive(root: string, actor?: Actor): Promise<PullResult | { error: string }> {
  const ready = await withSidecarLock(root, () => ensureSidecar(root, actor));
  if ("error" in ready) return ready;
  return pullLinear(root, actor);
}

export interface SyncResult { gained: number; pushed: boolean; committed: boolean; retries: number; warning?: string; joined?: boolean }

/** Send and receive: this session's staged writes, all or none (`syncLinear`). */
export async function sync(root: string, actor?: Actor, message = "codemap: review state"): Promise<SyncResult | { error: string }> {
  const { currentSession } = await import("./sync-session.js");
  const s = currentSession();
  const r = await syncLinear(root, s.session, { actor, message });
  // A refusal keeps what it refused and what is still staged: the caller repairs from those.
  if ("error" in r) return r as { error: string };
  setTx(root, s.session, s.kind, false);
  return { gained: r.gained, pushed: r.pushed, committed: r.committed, retries: r.retries, ...(r.warning ? { warning: r.warning } : {}), ...(r.joined ? { joined: true } : {}) };
}

// ---- The linear sync (docs/PROPOSAL-online-only-sync.md; plan 2.3) ------------------------
//
// The remote is the one serializer. A sync fetches, puts the working tree at the remote tip,
// replays this session's staged ops one at a time — each validated by its scope's fold against
// the log exactly as it stands before it — commits, and pushes as a fast-forward. A refused
// push means someone got there first, and the whole attempt starts again from the new tip.
// Nothing is ever merged.

/** Fetch-replay-push attempts before "busy, try again" (plan, "Decided by the session"). */
export const PUSH_ATTEMPTS = 5;
/** GitHub's documented recommendation per repository; exceeded, a sync warns and never throttles. */
export const PUSHES_PER_MINUTE = 6;

export interface Refusal { id: string; kind: string; scope: string; why: string }

/** One act that syncs inline: its check runs against the tip of every attempt. */
export interface InlineAct {
  scope: string;
  actor: Actor;
  check: (events: LogEvent[]) => Promise<
    | { kind: string; subject: string; data?: Record<string, unknown> }
    | { existing: LogEvent }
    | { error: string }
  >;
  fold?: DoorFold;
}

export interface LinearResult {
  gained: number;
  pushed: boolean;
  committed: boolean;
  retries: number;
  /** Event ids this sync put on the remote (or, with no remote, in local history). */
  landed: string[];
  warning?: string;
  /** The inline act's event: appended, or the one its check found already there. */
  event?: LogEvent;
  /** Staged acts not written because the same person's identical act was already there (`identicalAct`). */
  noop?: string[];
  /**
   * This clone's history was unrelated to the remote's and was replaced by it — a sidecar set
   * up locally, now joining its team. Its root commit changed; the store's record of which
   * sidecar it is must follow (`sharedSync`), or the repoint guard refuses the team's own.
   */
  joined?: boolean;
}

export type LinearFailure = {
  error: string;
  /** Every op the fold refused, when a replay was refused. All-or-nothing: none landed. */
  conflicts?: Refusal[];
  /** Ops still staged for this session after the failure. */
  staged?: string[];
  /** A push failed and the remote could not be reached: these may already have landed (C7). */
  unknown?: string[];
  /** The remote refused the push outright (`[remote rejected]`: a hook, a protected branch). */
  refused?: boolean;
};

export type LinearOutcome = LinearResult | LinearFailure;

/** Whether writes here go through the remote. No git directory or no remote: a local sidecar. */
export function transportsRemotely(root: string): boolean {
  return existsSync(join(root, ".git")) && hasRemote(root);
}

const rev = (root: string, r: string): string => g(root, ["rev-parse", "--verify", "--quiet", r]).out;

/**
 * A push that lost a race: refused before it started (`[rejected]`, non-fast-forward) or while
 * it ran — the remote's ref moved between the advertisement and the update, which it reports
 * as `cannot lock ref … is at X but expected Y`. A hook or a protected branch is not a race.
 */
const isRejection = (err: string): boolean =>
  /\[rejected\]|non-fast-forward|fetch first|stale info|cannot lock ref|failed to update ref/i.test(err)
  && !/hook declined|protected branch/i.test(err);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function refusalOf(fold: DoorFold | undefined, events: LogEvent[], e: LogEvent): Promise<string | null> {
  if (!fold) return null;
  try {
    const verdict = await fold(sortEvents([...events, e]), e);
    return verdict.refused.find((r) => r.id === e.id)?.why ?? null;
  } catch (err) {
    // A fold that halts names the entry (`LogDamage`). This event is refused; damage already
    // in the log is not this write's to answer, and goes on up to the lockout.
    const entry = (err as { entry?: { id?: string; why?: string } } | null)?.entry;
    if (entry?.id === e.id) return entry.why ?? "the fold refuses it";
    throw err;
  }
}

/** Every event in the `.ndjson` files at a commit: id to its line's bytes. */
function linesAtCommit(root: string, sha: string, paths: string[]): Map<string, string> {
  const ids = new Map<string, string>();
  for (const p of paths) {
    const blob = gRaw(root, ["show", `${sha}:${p}`]);
    if (!blob.ok) continue;
    for (const { event, line } of splitShard(blob.out, p).events) ids.set(event.id, line);
  }
  return ids;
}

/**
 * Lines a shard in the working tree has LOST against its committed version. The engine only
 * ever appends, so this is a hand edit — a repair in progress, most likely — and the reset
 * would throw it away without a word.
 */
async function editedShards(root: string): Promise<string[]> {
  const head = rev(root, "HEAD");
  if (!head) return [];
  const dirty = gRaw(root, ["status", "--porcelain", "-z", "--", `*${SHARD_EXT}`]).out
    .split("\0").map((entry) => /^.. (.*)$/.exec(entry)?.[1] ?? entry).filter((p) => p.endsWith(SHARD_EXT));
  const edited: string[] = [];
  for (const p of dirty) {
    const committed = gRaw(root, ["show", `${head}:${p}`]);
    if (!committed.ok) continue;
    let now = "";
    try { now = await readFile(join(root, p), "utf8"); } catch { /* deleted: every line lost */ }
    if (!now.startsWith(committed.out)) edited.push(p);
  }
  return edited;
}

/**
 * Events in this clone — the working tree or a local commit — that are neither on the remote
 * tip nor held by the queue. Resetting to the tip would destroy them, so a sync refuses
 * instead. The ordinary case (a clean tree at, or behind, the tip) costs two git calls.
 * Per-writer shards are `unmigrated`'s to judge, by id: their lines never match the remote's.
 */
async function unqueuedLocalEvents(root: string, remoteSha: string): Promise<{ path: string; id: string }[]> {
  const head = rev(root, "HEAD");
  // `gRaw` and `-z`: see `damagedWorkingShards` for what trimming porcelain output costs.
  const dirty = gRaw(root, ["status", "--porcelain", "-z", "--untracked-files=all", "--", `*${SHARD_EXT}`]).out
    .split("\0").map((entry) => /^.. (.*)$/.exec(entry)?.[1] ?? entry).filter((p) => p.endsWith(SHARD_EXT) && !isLegacyShard(p));
  const ahead = !!head && head !== remoteSha && !g(root, ["merge-base", "--is-ancestor", head, remoteSha]).ok;
  if (!dirty.length && !ahead) return [];
  const changed = new Set(dirty);
  if (ahead) {
    for (const p of g(root, ["diff", "--name-only", remoteSha, head, "--", `*${SHARD_EXT}`]).out.split("\n")) if (p.trim() && !isLegacyShard(p.trim())) changed.add(p.trim());
  }
  const paths = [...changed];
  const remote = linesAtCommit(root, remoteSha, paths);
  const queued = queuedIds(root);
  const lost: { path: string; id: string }[] = [];
  for (const p of paths) {
    let text = "";
    try { text = await readFile(join(root, p), "utf8"); } catch { /* deleted locally */ }
    for (const { event, line } of splitShard(text, p).events) {
      const there = remote.get(event.id);
      // Not on the remote and not ours to replay — or on it with different BYTES: a pushed
      // event edited here. Either way the reset would destroy it without a word.
      if (there === undefined ? !queued.has(event.id) : there !== line) lost.push({ path: p, id: event.id });
    }
  }
  return lost;
}

/**
 * Per-writer shards — a sidecar from before the linear log (plan 7.2b) — at a commit, or in this
 * clone's tree (tracked or not). This build has no ordering for them: it neither syncs over them
 * nor folds them, and says to migrate.
 */
function legacyShards(root: string, sha?: string): string[] {
  const listing = sha ? g(root, ["ls-tree", "-r", "--name-only", sha]) : g(root, ["ls-files", "-co", "--exclude-standard"]);
  return listing.ok ? listing.out.split("\n").map((p) => p.trim()).filter(isLegacyShard) : [];
}

const UNMIGRATED = (where: string, first: string) =>
  `refusing to sync: ${where} holds per-writer shards from before the linear log (first: ${first}), which this build `
  + `cannot order. The sidecar must be migrated first — see docs/sidecar-migration.md. Reads carry on from what this store already has.`;

/**
 * Why this clone cannot sync over per-writer shards, or null. Decided on the REMOTE first: once
 * the team's sidecar is migrated, an upgraded clone whose old events all reached it moves to the
 * tip like any other, and one holding events that never did is told exactly that — migrating
 * again is not the way out. Compared by id, since the migration rewrites every line (`seq`).
 */
async function unmigrated(root: string, remoteSha: string): Promise<string | null> {
  const oldThere = remoteSha ? legacyShards(root, remoteSha) : [];
  if (oldThere.length) return UNMIGRATED("the team's sidecar", oldThere[0]!);
  const oldHere = legacyShards(root);
  if (!oldHere.length) return null;
  if (!remoteSha) return UNMIGRATED("this clone's sidecar", oldHere[0]!);
  const shardsThere = g(root, ["ls-tree", "-r", "--name-only", remoteSha]).out.split("\n").map((p) => p.trim()).filter((p) => p.endsWith(SHARD_EXT));
  const there = linesAtCommit(root, remoteSha, shardsThere);
  const unpushed: { path: string; id: string }[] = [];
  for (const p of oldHere) {
    let text = "";
    try { text = await readFile(join(root, p), "utf8"); } catch { continue; }
    for (const { event } of splitShard(text, p).events) if (!there.has(event.id)) unpushed.push({ path: p, id: event.id });
  }
  if (!unpushed.length) return null;
  return `refusing to sync: this clone holds ${unpushed.length} event(s) an older build wrote that never reached the team's `
    + `sidecar before it was migrated (first: ${unpushed[0]!.path} ${unpushed[0]!.id}). Moving to the migrated tip would `
    + `destroy them. Copy this sidecar clone aside, then redo those acts with this build — see docs/sidecar-migration.md, `
    + `"If something goes wrong".`;
}

/** Put the working tree at `sha` — tracked files reset, stray shards removed. */
function resetTo(root: string, sha: string): { error: string } | null {
  const keep = carried(root, sha);
  const r = g(root, ["reset", "-q", "--hard", sha]);
  if (!r.ok) return { error: `could not move the sidecar to the remote tip: ${r.err.slice(0, 300)}` };
  g(root, ["clean", "-fq", "--", `*${SHARD_EXT}`]);
  for (const [p, bytes] of keep) {
    mkdirSync(dirname(join(root, p)), { recursive: true });
    writeFileSync(join(root, p), bytes);
  }
  return null;
}

/**
 * Files other than shards that this clone committed and `sha` lacks — a provisional audit
 * whose push never landed (a lost race, a failed push). The reset would delete them, so
 * they are put back and travel with the next commit. Shards are not carried: replay is how
 * events travel. Manifests are rewritten by `ensureSidecar` after every reset.
 */
function carried(root: string, sha: string): Map<string, Buffer> {
  const out = new Map<string, Buffer>();
  const head = rev(root, "HEAD");
  if (!head || head === sha) return out;
  const base = g(root, ["merge-base", head, sha]).out;
  const listing = base
    ? g(root, ["diff", "--name-only", "-z", "--diff-filter=A", base, head])
    : g(root, ["ls-tree", "-r", "--name-only", "-z", head]);
  for (const p of listing.out.split("\0")) {
    if (!p || p.endsWith(SHARD_EXT) || p.startsWith(`${MANIFEST_DIR}/`) || p === ".gitattributes") continue;
    if (g(root, ["cat-file", "-e", `${sha}:${p}`]).ok) continue;
    try { out.set(p, readFileSync(join(root, p))); } catch { /* deleted here since */ }
  }
  return out;
}

/** Undo a refused replay: every appended file back to the length it had. */
async function truncateBack(root: string, sizes: Map<string, number>): Promise<void> {
  for (const [file, size] of sizes) {
    if (size < 0) await rm(file, { force: true });
    else await truncate(file, size).catch(() => {});
  }
}

function recordPush(root: string, latencyMs: number): string | undefined {
  const now = Date.now();
  const recent = (JSON.parse(getMeta(root, "pushes") ?? "[]") as number[]).filter((t) => now - t < 60_000);
  recent.push(now);
  setMeta(root, "pushes", JSON.stringify(recent));
  setMeta(root, "lastPushMs", String(latencyMs));
  return recent.length > PUSHES_PER_MINUTE
    ? `${recent.length} pushes to the sidecar in the last minute (last took ${latencyMs}ms); GitHub recommends at most `
      + `${PUSHES_PER_MINUTE} per minute per repository. Batch writes in a transaction.`
    : undefined;
}

/**
 * Sync one session: push its staged ops, all-or-nothing, and bring the tree to the tip.
 * With `inline`, push that one act instead — its check re-run against every attempt's tip.
 * `conflictOnRefusal` is for a session that is gone: a refusal becomes a local conflict.
 */
export async function syncLinear(
  root: string, session: string,
  opts: { actor?: Actor; message?: string; inline?: InlineAct; conflictOnRefusal?: boolean } = {},
): Promise<LinearOutcome> {
  const pre = await fetchRemote(root);
  return withSidecarLock(root, () => withoutOverlay(() => linearHeld(root, session, opts, "error" in pre ? pre : pre.fetched)));
}

async function linearHeld(
  root: string, session: string,
  opts: { actor?: Actor; message?: string; inline?: InlineAct; conflictOnRefusal?: boolean },
  fetched0: FetchState,
): Promise<LinearOutcome> {
  const message = opts.message ?? "codemap: review state";
  const ready = await ensureSidecar(root, opts.actor ?? opts.inline?.actor);
  if ("error" in ready) return ready;
  const remote = hasRemote(root);
  const branch = branchOf(root);
  const mine = currentManifest((opts.actor ?? opts.inline?.actor)?.principal ?? "");
  const before = await countEvents(root);
  const stagedIds = (): string[] => pending(root, session).map((o) => o.event.id);
  let inlineId: string | null = null;
  let warning: string | undefined;
  let joined = false;
  const forgetInline = () => { if (inlineId) { markStaged(root, [inlineId]); drop(root, session, inlineId); inlineId = null; } };

  for (let attempt = 0; attempt < PUSH_ATTEMPTS; attempt++) {
    if (attempt > 0) await sleep(50 + Math.random() * 400 * attempt);
    let remoteSha = "";
    if (remote) {
      const f = attempt === 0 && fetched0 !== false ? fetched0 : await (async () => {
        const r = await fetchRemote(root);
        return "error" in r ? r : true;
      })();
      if (typeof f === "object") {
        forgetInline();
        return { error: `could not reach the sidecar remote, so nothing was synced (${f.error}). Shared state is online-only: `
          + `${opts.inline ? "the act was NOT written" : "staged writes stay staged until a sync succeeds"}.`, staged: stagedIds() };
      }
      remoteSha = rev(root, `origin/${branch}`);
    }
    const old = await unmigrated(root, remoteSha);
    if (old) { forgetInline(); return { error: old }; }
    // Damage in this clone's own tree locks it before anything moves: the reset below would
    // repair it from the remote, and silently — which hides whatever put it there.
    const local = damagedWorkingShards(root);
    if (local.length) {
      forgetInline();
      lockOn(root, local);
      return { error: `refusing to sync: ${local.length} line(s) in this clone's sidecar are damaged — bytes that are not `
        + `JSON.\n${damageDetail(local)}\n`
        + `The store is locked until they are repaired: see docs/log-repair.md.` };
    }
    const edited = await editedShards(root);
    if (edited.length) {
      forgetInline();
      return { error: `refusing to sync: ${edited.length} shard(s) in this sidecar clone were edited by hand, not appended to `
        + `(${edited.slice(0, 3).join(", ")}). A sync moves the tree to the remote tip and would discard the edit. A repair is `
        + `committed and pushed with git — see docs/log-repair.md — and anything else is restored with \`git checkout\`.` };
    }
    if (remoteSha) {
      const lost = await unqueuedLocalEvents(root, remoteSha);
      if (lost.length) {
        forgetInline();
        return { error: `refusing to sync: ${lost.length} event(s) in this sidecar clone differ from the remote and were not `
          + `staged through a sync (first: ${lost[0]!.path} ${lost[0]!.id}) — absent there, or edited here. Moving to the remote `
          + `tip would destroy them. They were written by an older build, or by hand; if this sidecar predates the linear log it `
          + `must be migrated first.` };
      }
      const head = rev(root, "HEAD");
      // Every attempt, not only when the tip moves: a clone already at a tip holding a peer
      // it cannot agree with must not push into it either.
      const incompat = checkPeers(remoteManifests(root, remoteSha), mine);
      if (incompat?.fatal) { forgetInline(); return { error: incompat.message }; }
      warning = incompat?.message ?? warning;
      // A damaged tip is still taken (owner, RULE-locked: "If another instance pushes broken state
      // we should still pull it") and then locks: nothing is pushed on top of it.
      const damaged = head !== remoteSha ? damagedInboundShards(root, head, remoteSha) : [];
      if (head && !g(root, ["merge-base", head, remoteSha]).ok) joined = true;
      const moved = resetTo(root, remoteSha);
      if (moved) { forgetInline(); return moved; }
      if (damaged.length) {
        forgetInline();
        lockOn(root, damaged);
        await ensureSidecar(root, opts.actor ?? opts.inline?.actor);
        return { error: `took the remote tip, and ${damaged.length} line(s) in it are damaged — bytes that are not JSON.\n`
          + `${damageDetail(damaged)}\nThe store is locked and pushes are blocked until the team's log is repaired: see `
          + `docs/log-repair.md. ${opts.inline ? "The act was NOT written." : "Staged writes stay staged."}`, staged: stagedIds() };
      }
      // The reset takes tracked files to the tip; our own manifest goes back on top of it.
      const again = await ensureSidecar(root, opts.actor ?? opts.inline?.actor);
      if ("error" in again) { forgetInline(); return again; }
    }

    // Replay. Written to disk op by op, because a fold may read another scope (the standard
    // folds law beside evidence) and must see what this replay already put there.
    const ops = opts.inline ? [] : pending(root, session);
    if (ops.length || opts.inline) {
      const blocked = await pushGate(root);
      if (blocked) { forgetInline(); return { error: blocked, staged: stagedIds() }; }
    }
    markInflight(root, ops.map((o) => o.event.id));
    const cache = new Map<string, LogEvent[]>();
    const scopeEvents = async (s: string): Promise<LogEvent[]> => {
      let hit = cache.get(s);
      if (!hit) { hit = await readScope(root, s); cache.set(s, hit); }
      return hit;
    };
    const sizes = new Map<string, number>();
    const append = async (scope: string, e: LogEvent) => {
      const file = join(root, scope, LINEAR_SHARD);
      if (!sizes.has(file)) sizes.set(file, await stat(file).then((s) => s.size, () => -1));
      await appendLinear(root, scope, [e]);
    };
    let top = await maxSeq(root);
    const writer = await writerFor(root);
    const landedNow: string[] = [];
    const already: string[] = [];
    const refusals: Refusal[] = [];
    const noop: string[] = [];
    for (const op of ops) {
      const evs = await scopeEvents(op.scope);
      if (evs.some((e) => e.id === op.event.id)) { already.push(op.event.id); continue; }
      if (identicalAct(evs, op.event)) { noop.push(op.event.id); continue; }
      const e = atTip(evs, writer, top, op.event);
      const why = await refusalOf(doorFor(root, op.scope), evs, e);
      if (why) { refusals.push({ id: e.id, kind: e.kind, scope: op.scope, why }); continue; }
      await append(op.scope, e);
      evs.push(e); top++; landedNow.push(e.id);
    }
    // The first sync on this version logs it (materializer-log.ts) — never against a log this
    // build cannot read, so a sync that only pulls is not turned into a refusal by it.
    const by = opts.actor ?? opts.inline?.actor;
    let bumped = 0;
    if (by && remote && !refusals.length) {
      const evs = await scopeEvents(MATERIALIZER_SCOPE);
      const bump = bumpEvent(evs, by);
      if (bump && !(await pushGate(root))) {
        const e = atTip(evs, writer, top, bump);
        if (!(await refusalOf(doorFor(root, MATERIALIZER_SCOPE), evs, e))) {
          await append(MATERIALIZER_SCOPE, e);
          evs.push(e); top++; bumped = 1;
        }
      }
    }
    let inlineEvent: LogEvent | undefined;
    if (opts.inline) {
      const a = opts.inline;
      const evs = await scopeEvents(a.scope);
      const admission = await a.check(evs);
      if ("error" in admission) { forgetInline(); return admission; }
      if ("existing" in admission) {
        forgetInline();
        return { gained: (await countEvents(root)) - before, pushed: false, committed: false, retries: attempt, landed: [],
          event: admission.existing, ...(warning ? { warning } : {}) };
      }
      const twin = identicalAct(evs, { ...admission, actor: a.actor });
      if (twin) {
        forgetInline();
        return { gained: (await countEvents(root)) - before, pushed: false, committed: false, retries: attempt, landed: [],
          event: twin, noop: [twin.id], ...(warning ? { warning } : {}) };
      }
      const staged: StagedEvent = {
        sidecarProtocol: SIDECAR_PROTOCOL, eventSchema: EVENT_SCHEMA, id: mintId(), kind: admission.kind,
        subject: admission.subject, actor: a.actor, at: new Date().toISOString(), after: causalHeads(evs),
        ...(admission.data ? { data: admission.data } : {}),
      };
      const e = atTip(evs, writer, top, staged);
      const why = await refusalOf(writeDoor(root, a.scope, a.fold), evs, e);
      if (why) { forgetInline(); return { error: why }; }
      // In the queue BEFORE it can reach the remote: a crash after the push is then resolved by
      // finding its id there, never by pushing it twice.
      forgetInline();
      stage(root, session, a.scope, staged);
      markInflight(root, [staged.id]);
      inlineId = staged.id;
      await append(a.scope, e);
      evs.push(e); top++; landedNow.push(e.id);
      inlineEvent = e;
    }
    if (refusals.length) {
      await truncateBack(root, sizes);
      const ids = ops.map((o) => o.event.id);
      markStaged(root, ids);
      if (opts.conflictOnRefusal) markConflict(root, refusals, ids);
      return {
        error: `${refusals.length} staged write(s) were refused against the current log, so none was pushed: `
          + refusals.map((r) => `${r.kind} ${r.id}: ${r.why}`).join("; "),
        conflicts: refusals, staged: opts.conflictOnRefusal ? [] : stagedIds(),
      };
    }
    const toLand = [...landedNow, ...already, ...noop];

    const committed = commitLocal(root, message);
    if (typeof committed === "object") {
      await truncateBack(root, sizes);
      markStaged(root, ops.map((o) => o.event.id));
      forgetInline();
      return { ...committed, staged: stagedIds() };
    }
    // What arrived from others: everything on disk now, less what this sync appended.
    const result = async (pushed: boolean, retries: number): Promise<LinearResult> => ({
      gained: Math.max(0, (await countEvents(root)) - before - landedNow.length - bumped), pushed,
      committed: committed === "committed", retries, landed: landedNow,
      ...(noop.length ? { noop } : {}), ...(warning ? { warning } : {}), ...(inlineEvent ? { event: inlineEvent } : {}), ...(joined ? { joined } : {}),
    });
    if (!remote) { markLanded(root, toLand); return result(false, attempt); }
    const head = rev(root, "HEAD");
    // `pushed` says the remote holds our history — true here — and `committed` whether this
    // sync had anything of its own; conflating them trades a lie for a false alarm.
    if (head && head === remoteSha) { markLanded(root, toLand); return result(true, attempt); }

    // Every push, not only one carrying staged ops: a commit of anything else goes through it too.
    if (!ops.length && !opts.inline) {
      const blocked = await pushGate(root);
      if (blocked) return { error: blocked, staged: stagedIds() };
    }
    const t0 = Date.now();
    const p = g(root, ["push", "--quiet", "origin", `HEAD:${branch}`]);
    const rate = recordPush(root, Date.now() - t0);
    warning = rate ?? warning;
    if (p.ok) {
      // Exit 0 with the tracking ref behind is not "nothing was sent": another process may hold
      // the ref's lock (review C8a). Settled like any failed push — fetch, with the ref-lock retry,
      // and look for the ids at the tip.
      if (!remoteHasHead(root, branch)) {
        return settleFailedPush(root, branch, `git push exited 0 but origin/${branch} did not move to this commit`, toLand,
          [...new Set([...ops.map((o) => o.scope), ...(opts.inline ? [opts.inline.scope] : []), ...(bumped ? [MATERIALIZER_SCOPE] : [])])],
          inlineId, forgetInline, stagedIds, () => result(true, attempt));
      }
      markLanded(root, toLand);
      inlineId = null;
      return result(true, attempt);
    }
    if (isRejection(p.err)) continue;
    return settleFailedPush(root, branch, p.err, toLand, [...new Set([...ops.map((o) => o.scope), ...(opts.inline ? [opts.inline.scope] : []),
      ...(bumped ? [MATERIALIZER_SCOPE] : [])])], inlineId, forgetInline, stagedIds, () => result(true, attempt));
  }
  if (remote) {
    const tip = rev(root, `origin/${branch}`);
    if (tip) resetTo(root, tip);
  }
  markStaged(root, pending(root, session).map((o) => o.event.id));
  forgetInline();
  return { error: `busy: the sidecar remote moved under ${PUSH_ATTEMPTS} attempts in a row. Nothing was pushed; try again.`, staged: stagedIds() };
}

/**
 * A push that failed for a reason other than a lost race, settled at the failure (owner, C7):
 * fetch, and each op is on the tip — landed — or not — staged again, and an inline act is
 * forgotten and its caller told it was NOT written. Only an unreachable remote leaves an op
 * unknown: it stays `inflight`, shown on the overlay, and the next fetch settles it (a sync looks
 * for its id at the tip before replaying). A definite `[remote rejected]` is a refusal.
 */
async function settleFailedPush(
  root: string, branch: string, err: string, toLand: string[], scopes: string[], inlineId: string | null,
  forgetInline: () => void, stagedIds: () => string[], landedResult: () => Promise<LinearResult>,
): Promise<LinearOutcome> {
  const why = err.slice(0, 300);
  const fetched = await fetchRemote(root);
  if ("error" in fetched) {
    // Back to the last tip seen: the ops stay queued (inflight) and anything else appended here
    // (the materializer bump) is re-derived, so no unqueued event is left for the next sync to refuse.
    const last = rev(root, `origin/${branch}`);
    if (last) resetTo(root, last);
    markUnknown(root, toLand);
    return { error: `the push to the sidecar remote failed (${why}), and the remote could not be reached to see whether it `
      + `landed. ${inlineId ? "The act" : "The write(s)"} may already have landed: the next sync settles it — do not redo it.`,
      staged: stagedIds(), unknown: toLand };
  }
  const tip = rev(root, `origin/${branch}`);
  const there = tip ? linesAtCommit(root, tip, scopes.map((s) => `${s}/${LINEAR_SHARD}`)) : new Map<string, string>();
  const landed = toLand.filter((id) => there.has(id)), absent = toLand.filter((id) => !there.has(id));
  markLanded(root, landed);
  markStaged(root, absent);
  // Every op is now accounted for — landed, or staged to replay — so the unpushed commit goes.
  if (tip) resetTo(root, tip);
  if (!absent.length) return landedResult();
  const inlineLost = !!inlineId && absent.includes(inlineId);
  if (inlineLost) forgetInline();
  const rejected = /\[remote rejected\]/.test(err);
  return { error: `${rejected ? "the sidecar remote refused the push" : "the push to the sidecar remote failed"} (${why}). `
    + `Checked the remote: ${inlineLost ? "the act was NOT written" : `${absent.length} write(s) did not land and stay staged`}`
    + `${landed.length ? `; ${landed.length} did land` : ""}.`, staged: stagedIds(), ...(rejected ? { refused: true } : {}) };
}

/** Bring the tree to the remote tip without pushing anything. */
export async function pullLinear(root: string, actor?: Actor): Promise<PullResult | { error: string }> {
  const pre = await fetchRemote(root);
  if ("error" in pre) return pre;
  return withSidecarLock(root, async () => {
    if (!pre.fetched) return { gained: 0 };
    const branch = branchOf(root);
    const remoteSha = rev(root, `origin/${branch}`);
    if (!remoteSha) return { gained: 0 };
    const head = rev(root, "HEAD");
    const old = await unmigrated(root, remoteSha);
    if (old) return { error: old };
    const local = damagedWorkingShards(root);
    if (local.length) {
      lockOn(root, local);
      return { error: `refusing to pull: ${local.length} line(s) in this clone's sidecar are damaged.\n${damageDetail(local)}\n`
        + `The store is locked until they are repaired: see docs/log-repair.md.` };
    }
    const edited = await editedShards(root);
    if (edited.length) {
      return { error: `refusing to pull: ${edited.length} shard(s) in this sidecar clone were edited by hand (${edited.slice(0, 3).join(", ")}). `
        + `A pull would discard the edit; commit and push a repair with git (docs/log-repair.md), or restore it with \`git checkout\`.` };
    }
    if (head === remoteSha) return { gained: 0 };
    const lost = await unqueuedLocalEvents(root, remoteSha);
    if (lost.length) {
      return { error: `refusing to pull: ${lost.length} event(s) in this sidecar clone are not on the remote and were not `
        + `staged through a sync (first: ${lost[0]!.path} ${lost[0]!.id}). If this sidecar predates the linear log it must be migrated first.` };
    }
    const mine = currentManifest(actor?.principal ?? "");
    const incompat = checkPeers(remoteManifests(root, remoteSha), mine);
    if (incompat?.fatal) return { error: incompat.message };
    // Taken even when damaged, then locked (owner, RULE-locked): a pull always works.
    const damaged = damagedInboundShards(root, head, remoteSha);
    const before = await countEvents(root);
    const joined = !!head && !g(root, ["merge-base", head, remoteSha]).ok;
    const moved = resetTo(root, remoteSha);
    if (moved) return moved;
    if (actor) await ensureSidecar(root, actor);
    if (damaged.length) lockOn(root, damaged);
    return { gained: (await countEvents(root)) - before, ...(incompat ? { warning: incompat.message } : {}), ...(joined ? { joined } : {}) };
  });
}

function queuedIds(root: string): Set<string> {
  return new Set(allQueuedIds(root));
}
