/**
 * The sidecar: a git repo that carries shared review state, and the send/receive
 * loop over it.
 *
 * The whole algorithm is four lines, and the reason it can be four lines is that
 * everything above it is append-only and commutative:
 *
 *   pull:  fetch, merge      -> re-fold
 *   push:  commit, push      -> on reject: pull, retry
 *
 * The retry is safe to perform BLINDLY, and that is the property that makes a
 * one-button sync honest rather than a lie over a fragile operation: events are
 * immutable and their order is decided by the fold, not by the file, so a merge
 * can never change what an event means. Nothing here has to understand findings.
 *
 * Merge, not rebase. Rebase replays each local commit onto the remote tip, so a
 * conflict has to be resolved once per commit; a merge resolves once. Linear
 * history would buy nothing here — the log's order comes from `sortEvents`, not
 * from the commit graph.
 */

import { spawnSync } from "node:child_process";
import { appendFile, mkdir, readFile, readdir, rm, stat, truncate, writeFile } from "node:fs/promises";
import { existsSync, realpathSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { ANCHOR_SCHEME, HASH_SCHEME } from "./schema.js";
import { GRAMMAR_VERSIONS } from "./grammar-versions.js";
import { gitBin } from "./git.js";
import { withSidecarLock, touchHeldLocks } from "./lock.js";
import {
  SHARD_EXT, LINEAR_SHARD, SIDECAR_PROTOCOL, EVENT_SCHEMA, principalKey, splitShard, damageRef, appendLinear, atTip, causalHeads,
  doorFor, maxSeq, mintId, readScope, sortEvents, writerFor, type DoorFold, type LogEvent, type ShardDamage, type StagedEvent,
} from "./eventlog.js";
import { withoutOverlay } from "./sync-session.js";
import { pushGate } from "./validation.js";
import { allQueuedIds, drop, getMeta, markConflict, markInflight, markLanded, markStaged, pending, setMeta, setTx, stage } from "./sync-queue.js";
import { shapeCheckFor } from "./log-shape.js";
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
 * holder from being stolen from mid-merge. Before AND after: before, so the clock
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
 * it everybody's; inbound, merging it puts the bytes in one more clone's history and
 * destroys the scope on one more machine. The collateral on the inbound side is real and
 * accepted: the good events in that pull do not arrive either. That is the trade a broken
 * shared log deserves, and stopping is what gets it repaired.
 *
 * This is NOT a defence against a hostile shard, and it should not be tuned as one. The
 * case it is built for is a sidecar that is genuinely damaged — a bad merge, a disk, an
 * interrupted write — where continuing quietly is how the damage spreads.
 *
 * The outbound half hangs off `commitLocal` rather than off `push`, because that is the
 * one function that commits: `syncHeld` commits before it pulls, and a check only on the
 * push would leave the damage in the local history with a clean `git status` over it —
 * which the next push would then publish without ever looking.
 *
 * Neither repairs, and nothing else here does either — see `separatorFor` in `eventlog.ts`
 * for why a torn tail is sealed in rather than truncated. Quietly dropping bytes that do
 * not parse would destroy the evidence of whatever put them there, and cannot tell a
 * crash from a disk that ate an event somebody had already read.
 */

/**
 * Damage only — the events are `readShard`'s business, not a gate's. Bytes that are not JSON,
 * and, in a scope that has one, an event not in the shape its kind is written in (plan 1.2):
 * the transport sees the same damage a read halts on, or it would publish what locks the team.
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
 * Every shard an inbound branch would ADD, read off the fetched COMMIT.
 *
 * **From the MERGE BASE, not from our own tip, and that distinction is load-bearing
 * rather than an optimisation.** `diff HEAD remoteSha` answers "how do these two differ",
 * which includes everything WE have that they do not — so the moment somebody repaired a
 * damaged shard and tried to publish the repair, this read the remote's still-damaged
 * copy of it and refused the pull that the push has to go through first. The repairer
 * was locked out of repairing. `base..remoteSha` asks what is new on their side, which
 * is the only thing a merge can bring, and a remote already contained in our history
 * yields nothing at all.
 *
 * The content at `remoteSha` is what lands, so a shard damaged and then fixed within the
 * incoming range is fine and reads as fine — we validate what arrives, not every state it
 * passed through.
 *
 * No merge base means unrelated histories, which is a first pull: everything is inbound.
 *
 * One `git show` per changed shard. That is the shape `erasedByMerge` already has, and an
 * ordinary pull changes a handful; a first pull reads every shard once, which is the one
 * time it is genuinely worth doing.
 */
function damagedInboundShards(root: string, beforeSha: string, remoteSha: string): ShardDamage[] {
  const base = beforeSha ? g(root, ["merge-base", beforeSha, remoteSha]).out : "";
  const listing = base
    ? g(root, ["diff", "--name-only", "-z", base, remoteSha])
    : g(root, ["ls-tree", "-r", "--name-only", "-z", remoteSha]);
  if (!listing.ok) return [];
  const out: ShardDamage[] = [];
  for (const path of listing.out.split("\0")) {
    if (!path.endsWith(SHARD_EXT)) continue;
    const blob = gRaw(root, ["show", `${remoteSha}:${path}`]);
    if (!blob.ok) continue; // deleted on their side — `erasedByMerge` is what judges that
    out.push(...shardDamage(blob.out, path));
  }
  return out;
}

/**
 * Commit whatever is in the tree.
 *
 * Called BEFORE a merge as well as before a push: a fresh sidecar's scaffold
 * (.gitattributes, the manifest) is untracked, and git refuses a merge that would
 * overwrite untracked files — so a new person's first pull failed on the files
 * their own setup had just written.
 *
 * **Three outcomes, not two.** This returned a bare boolean that was `false` both
 * for "nothing to commit" and for "the commit failed", so no caller could tell a
 * clean no-op from a lost finding — and both call sites dropped it anyway. With a
 * failing commit the shards stay staged, the merge still succeeds, and the push is
 * a no-op that exits 0, so `sync` reported `pushed: true` while nothing left the
 * machine. Reproduced with `commit.gpgsign=true` and an unusable key, which is an
 * ordinary global git config. See the architecture doc's R1.
 */
type CommitOutcome = "nothing" | "committed" | { error: string };

function commitLocal(root: string, message: string): CommitOutcome {
  if (!g(root, ["status", "--porcelain"]).out) return "nothing";
  // THE gate, and it is here rather than in `pushHeld` because this is the only place
  // anything is committed. `syncHeld` commits before it pulls — the scaffold-vs-merge
  // fix — so a check on the push side alone would let damage into the local history
  // there, and `git status` is clean afterwards, so the next push would sail through
  // and publish it.
  const damaged = damagedWorkingShards(root);
  if (damaged.length) {
    lockOn(root, damaged);
    return { error: `refusing to commit ${damaged.length} unreadable line(s) — bytes that are not JSON, or `
      + `an event no conforming build writes — and committing them would put them in front of the whole `
      + `team:\n${damageDetail(damaged)}\n`
      + `The store is locked until they are repaired: see docs/log-repair.md. Until then this clone does `
      + `not sync in EITHER direction — a sync commits before it pulls, so nothing is sent and nothing is `
      + `received.` };
  }
  g(root, ["add", "-A"]);
  const c = g(root, ["commit", "-q", "-m", message]);
  if (!c.ok) return { error: `the sidecar commit failed, so nothing can be pushed: ${(c.err || c.out).slice(0, 300)}` };
  return "committed";
}

/**
 * Manifests are per-principal, in a directory, for the same reason shards are.
 *
 * A single shared manifest cannot work: every clone rewrites it with its OWN
 * schemes, so a pull would compare a file to itself and see agreement — and when
 * two people genuinely differ, JSON does not union-merge, so the one file that is
 * supposed to REPORT the incompatibility becomes a merge conflict instead. One
 * file per person conflicts never, and answers the more useful question: not
 * "does this sidecar match me" but "who on this team does not".
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
 * `--allow-unrelated-histories` merge has added a second root beside it. That last case
 * is not hypothetical: it is the ordinary way this team joins up, everybody running
 * `ensureSidecar` locally and then pointing at one remote.
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

export const ATTRIBUTES = ".gitattributes";

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
}

export const currentManifest = (principal: string): SidecarManifest => ({
  principal,
  anchorScheme: ANCHOR_SCHEME,
  hashScheme: HASH_SCHEME,
  grammars: { ...GRAMMAR_VERSIONS },
});

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
      const m = JSON.parse(await readFile(join(dir, n), "utf8")) as SidecarManifest;
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
async function gitConfigLooksSet(root: string, identity: string): Promise<boolean> {
  const cfg = await readFile(join(root, ".git", "config"), "utf8").catch(() => "");
  return new RegExp(`^\\s*email\\s*=\\s*${identity.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*$`, "m").test(cfg)
    && /^\s*gpgsign\s*=\s*false\s*$/m.test(cfg);
}

/**
 * Make `root` a usable sidecar: a git repo, with the shard merge policy in place
 * and a manifest.
 *
 * **`-merge`, not `merge=union`.** Union was justified as covering "the same person
 * appending from two machines", and this branch's own code retired that reason:
 * shards are per-WRITER (`shardFor`), so two clones write one shard file only when
 * they share a writer id — which IS the fork. Union did not prevent that fork, it
 * laundered its evidence into a clean-looking merge, to be discovered later as a
 * team-wide blocked scope instead of at sync time on the two guilty clones. It also
 * ADDED a damage mode: a stitched union is one of the ways a glued line appears.
 *
 * `-merge` conflicts a both-sides-changed shard with no interleaving and no conflict
 * markers written into the file, so a conflicted shard can never poison `readShard`;
 * a one-side-changed shard never invokes a driver and merges clean, so the ordinary
 * team flow of disjoint per-writer files is untouched. `codemap sidecar heal` is the
 * way out, and it is a person.
 */
export async function ensureSidecar(root: string, actor?: Actor): Promise<{ created: boolean } | { error: string }> {
  await mkdir(root, { recursive: true });
  // Is this path a repo ROOT — not "is it inside one". The difference is the whole
  // safety of the operation: the documented zero-config layout puts the sidecar at
  // `.codemap/sidecar` INSIDE the code repo, which is inside a work tree, so asking
  // the weaker question skipped `init` and pointed every later git call at the
  // user's own repository. `commitLocal` there is `git add -A` + commit, and `push`
  // finds that repo's `origin` — one sync committed a developer's uncommitted work
  // and pushed it to the team remote, while sharing nothing, because the shards sit
  // under the `*`-ignored `.codemap/`. `pull` merged the sidecar's history into
  // their working tree.
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
  if (!(await gitConfigLooksSet(root, identity))) {
    g(root, ["config", "user.email", identity]);
    g(root, ["config", "user.name", "codemap"]);
    g(root, ["config", "commit.gpgsign", "false"]);
  }
  // Written by everyone, identically, so it never conflicts.
  await writeFile(join(root, ATTRIBUTES), `*${SHARD_EXT} -merge\n`, "utf8");
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

export interface PullResult { gained: number; warning?: string; restored?: Restored[] }

/** A shard whose lines a pull tried to delete, and how many were put back. */
export interface Restored { path: string; events: number }

/** A shard that came back from a merge with fewer lines than it went in with. */
interface Erasure { path: string; restored: string[] }

/**
 * Every (commit, shard) in the incoming history that removed lines.
 *
 * **Scanning the range, not the endpoints, and that distinction is the whole fix.**
 * Comparing our pre-merge tip with the merged tip is blind to an event that was added
 * and deleted between them: it is absent at both ends, so the diff is empty and the
 * loss is invisible. Same for a first pull, where every deletion in the incoming
 * history happened before our endpoint existed. Verified — see the test that pushes an
 * event and its deletion before the other clone ever fetches.
 *
 * `-z` so paths arrive NUL-terminated and raw; with `--numstat` alone git C-quotes any
 * non-ASCII path, and the quoted form was then passed to `git show`, which fails, and
 * the shard was skipped in silence. Directory-derived universe keys make that
 * reachable. `core.quotePath=false` belts the same braces.
 */
function deletingCommits(root: string, range: string): { commit: string; path: string }[] | { error: string } {
  // `--full-history` is LOAD-BEARING. With a pathspec, git's default history
  // simplification prunes commits that are TREESAME to their parent — and when the
  // path is absent from the final tree it prunes the entire side branch that added
  // and removed it. Measured: an add-then-delete across a merge yields 0 numstat rows
  // by default and 2 with this flag. Removing it silently restores the exact hole
  // this function exists to close.
  const log = g(root, ["-c", "core.quotePath=false", "log", "--full-history", "--numstat", "-z",
                       "--no-renames", "--format=C%H", range, "--", `*${SHARD_EXT}`]);
  // An audit that cannot run must not read as "nothing was erased". This guards a
  // non-negotiable, so a failure here fails the pull.
  if (!log.ok) return { error: `could not audit the incoming history for deletions: ${log.err.slice(0, 300)}` };
  const out: { commit: string; path: string }[] = [];
  let commit = "";
  for (const rec of log.out.split("\0")) {
    if (!rec) continue;
    if (rec.startsWith("C")) { commit = rec.slice(1).trim(); continue; }
    const [, deleted, path] = rec.split("\t");
    // "-" is git's binary marker. A shard is never binary, and one we cannot count is
    // one we cannot vouch for — so treat it as suspect rather than skipping it.
    if (!path || deleted === "0") continue;
    out.push({ commit, path });
  }
  return out;
}

/** Lines of a blob at a rev, or null when the path is not there. */
function linesAt(root: string, rev: string, path: string): string[] | null {
  const blob = g(root, ["show", `${rev}:${path}`]);
  if (!blob.ok) return null;
  return blob.out.split("\n").filter((l) => l.trim() && isEventLine(l, path));
}

/**
 * Does this line carry an event at all?
 *
 * The append-only restore is about EVENTS, and a line no build can parse is not one — so
 * it was never erased in the sense this protects, and putting it back is actively wrong.
 * Deleting the damaged line is the ONLY repair a corrupt shard has, and without this the
 * repair is undone on every teammate's next pull: their merge sees the removal, restores
 * it, and pushes it back at the person who fixed it. Found by running the oracle, not by
 * reading either mechanism — each is right on its own.
 *
 * Parse only, deliberately NOT `wellFormed`: an event from a newer client parses and
 * fails the envelope check, and that IS a real record whose loss must still be caught.
 * Same line the damage check draws.
 */
function isEventLine(line: string, path: string): boolean {
  // A wrong-shaped line is damage too (plan 1.2): restoring one would undo its repair.
  const check = shapeCheckFor(dirname(path));
  try { const e = JSON.parse(line) as LogEvent; return !check || !check(e); } catch { return false; }
}

/**
 * Lines the incoming history removed and the merge result no longer has.
 *
 * A shard is append-only, so its line set may only grow. Nothing enforced that:
 * `git rm` a shard on any clone, push, and every teammate's next pull applied the
 * deletion as a clean silent merge. That was the one live hole in "once state is
 * pushed, nothing deletes it".
 */
function erasedByMerge(root: string, beforeSha: string): Erasure[] | { error: string } {
  const deletions = deletingCommits(root, `${beforeSha}..HEAD`);
  if ("error" in deletions) return deletions;

  /** path -> every line that existed before something dropped it. */
  const had = new Map<string, Set<string>>();
  const remember = (path: string, lines: string[] | null) => {
    if (!lines?.length) return;
    let set = had.get(path);
    if (!set) had.set(path, set = new Set());
    for (const l of lines) set.add(l);
  };

  // Deletions in the incoming history.
  for (const { commit, path } of deletions) {
    // The first parent is the state the deleting commit removed FROM. A root commit
    // has none, and then there was nothing to lose.
    remember(path, linesAt(root, `${commit}^`, path));
  }

  // And lines OUR side had that the merge result no longer does. The range scan
  // above cannot see these: `git log` omits diffs for merge commits, so a merge that
  // resolved by dropping our lines contributes no numstat rows at all.
  const ends = g(root, ["-c", "core.quotePath=false", "diff", "--numstat", "-z", "--no-renames",
                        beforeSha, "HEAD", "--", `*${SHARD_EXT}`]);
  if (!ends.ok) return { error: `could not audit the merge result for deletions: ${ends.err.slice(0, 300)}` };
  for (const rec of ends.out.split("\0")) {
    if (!rec) continue;
    const [, deleted, path] = rec.split("\t");
    if (!path || deleted === "0") continue;
    remember(path, linesAt(root, beforeSha, path));
  }

  if (!had.size) return [];

  const out: Erasure[] = [];
  for (const [path, lines] of had) {
    const now = new Set(linesAt(root, "HEAD", path) ?? []);
    const lost = [...lines].filter((l) => !now.has(l));
    if (lost.length) out.push({ path, restored: lost });
  }
  return out;
}

/**
 * Put the erased lines back, by appending them.
 *
 * Restoring rather than refusing, on purpose. Refusing the merge would wedge pull
 * permanently — the deletion is in history and history cannot be un-made, so there
 * would be no way back, which is the dead-scope failure the architecture doc rejects.
 * Appending is also the only repair consistent with the rule being defended: the fix
 * for "somebody deleted state" is not a rollback, it is more append-only content.
 *
 * Appends rather than rewrites, so a concurrent writer's line cannot be read, held,
 * and then clobbered by the write-back. The caller holds the sidecar lock regardless.
 */
async function restoreErased(root: string, erased: Erasure[]): Promise<void> {
  for (const e of erased) {
    const file = join(root, e.path);
    await mkdir(dirname(file), { recursive: true });
    const current = await readFile(file, "utf8").catch(() => "");
    // A shard whose last line has no terminator would otherwise get the first
    // restored line glued onto it, turning two events into one unreadable one.
    const lead = current && !current.endsWith("\n") ? "\n" : "";
    await appendFile(file, lead + e.restored.join("\n") + "\n", "utf8");
  }
}

/**
 * Fetch, and it is safe to do this OUTSIDE the sidecar lock.
 *
 * The lock exists to keep two commit-merge-push sequences from interleaving against
 * one working tree. A fetch touches neither the working tree nor the index — it
 * writes objects and `refs/remotes/*`, and git serializes those itself. It is also
 * the slow part: network-bound, up to the full git timeout, during which holding the
 * lock stalls every other local reader and writer of this sidecar for no reason.
 *
 * `false` means there is no remote, which is not an error: a sidecar with no remote
 * is a perfectly good local one and the whole design works offline.
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

function fetchRemote(root: string): { fetched: boolean } | { error: string } {
  if (!hasRemote(root)) return { fetched: false };
  const r = g(root, ["fetch", "--quiet", "origin"]);
  return r.ok ? { fetched: true } : { error: `fetch failed: ${r.err.slice(0, 300)}` };
}

/**
 * What a LOCKED clone may still do (plan 1.2): fetch, and look at what the fetched tip would
 * bring, without merging it. Nothing is written but the remote-tracking ref. The first damaged
 * line inbound, or null; an error when the fetch itself fails.
 */
export async function inboundDamage(root: string): Promise<ShardDamage | null | { error: string }> {
  const f = fetchRemote(root);
  if ("error" in f) return f;
  if (!f.fetched) return null;
  const remoteSha = g(root, ["rev-parse", "--verify", "--quiet", `origin/${branchOf(root)}`]).out;
  if (!remoteSha) return null;
  const beforeSha = g(root, ["rev-parse", "--verify", "--quiet", "HEAD"]).out;
  return damagedInboundShards(root, beforeSha, remoteSha)[0] ?? null;
}

/**
 * Fetch and merge. A sidecar with no remote is a perfectly good local one, so
 * that is a no-op rather than an error — the whole design works offline and only
 * needs a remote to reach other people.
 */
export async function pull(root: string, actor?: Actor): Promise<PullResult | { error: string }> {
  return pullLinear(root, actor);
}

/**
 * The pull itself, with the lock already held.
 *
 * Separate because the erasure repair reads a shard and writes it back, and `push`
 * calls this after a rejection from inside `sync`'s lock — so the public entry point
 * must take the lock and the internal one must not, or every sync deadlocks against
 * itself. Same shape as `sync`/`syncHeld`, and the lock is not reentrant.
 */
async function pullHeld(root: string, actor?: Actor, fetched: FetchState = false): Promise<PullResult | { error: string }> {
  if (!hasRemote(root)) return { gained: 0 };
  if (typeof fetched === "object") return fetched;
  const before = await countEvents(root);
  // Only when the caller has not already fetched outside the lock. The in-lock fetch
  // stays for the paths that cannot hoist it: a brand-new sidecar whose repo did not
  // exist yet, and `pushHeld` re-pulling after a rejection.
  if (!fetched) {
    const r = g(root, ["fetch", "--quiet", "origin"]);
    if (!r.ok) return { error: `fetch failed: ${r.err.slice(0, 300)}` };
  }

  const branch = branchOf(root);
  // PINNED to a sha, not left as `origin/<branch>`, and this matters more since the
  // fetch moved outside the lock: another process's fetch does not take the lock, so
  // the ref can advance between the manifest check and the merge — and then we would
  // have vetted one state and merged another. Resolve once, use that sha for both.
  const remoteSha = g(root, ["rev-parse", "--verify", "--quiet", `origin/${branch}`]).out;
  // Nothing fetched yet (an empty remote, or a first sync) — not an error.
  if (!remoteSha) return { gained: 0 };

  // Checked against the FETCHED commit, before merging. Reading the working tree
  // would compare my manifest to my own, and a fatal mismatch should refuse the
  // data rather than merge it and then complain.
  const mine = currentManifest(actor?.principal ?? "");
  const incompatEarly = checkPeers(remoteManifests(root, remoteSha), mine);
  if (incompatEarly?.fatal) return { error: incompatEarly.message };

  // Our tip BEFORE the merge, so the append-only audit further down has something to
  // compare against and the inbound shard check knows what this pull would ADD. `HEAD`
  // on an unborn branch has no sha — nothing to erase, and everything is inbound.
  const beforeSha = g(root, ["rev-parse", "--verify", "--quiet", "HEAD"]).out;

  // Checked while the sidecar is still untouched, exactly as the manifest gate above is,
  // and REFUSED rather than reported. A merge that takes damaged bytes makes a broken
  // sidecar worse: this clone's history then carries them too, and the scope it destroys
  // reads as an empty one on one more machine.
  //
  // The collateral is real and accepted — the good events in the same pull do not arrive
  // either, and every scope waits on a repair to one of them. That is the trade a broken
  // shared log deserves: it is not a hostile act being defended against, it is a genuinely
  // damaged sidecar, and whoever wrote that shard still holds the only history that can
  // repair it. Stopping is what gets it repaired; merging is what spreads it.
  const damaged = damagedInboundShards(root, beforeSha, remoteSha);
  if (damaged.length) {
    // Damage this machine can see locks it, an incoming pull it refused included (owner, batch 8).
    lockOn(root, damaged);
    return { error: `refusing to merge: ${damaged.length} line(s) in the incoming shards are damaged — `
      + `bytes that are not JSON, or an event no conforming build writes. The sidecar is untouched.\n`
      + `${damageDetail(damaged)}\n`
      + `The store is locked until the team's log is repaired: see docs/log-repair.md.` };
  }

  // `--allow-unrelated-histories` because the ordinary way a team arrives here is
  // that everybody ran `ensureSidecar` locally and then pointed it at the same
  // remote, so the second person's history is genuinely unrelated to the first's.
  // Safe for this content specifically: per-writer shards are disjoint between
  // clones, and the only other files are the manifest and .gitattributes, which are
  // generated identically by the same code. Compatibility is checked below.
  const merge = g(root, ["merge", "--no-edit", "--allow-unrelated-histories", remoteSha]);
  if (!merge.ok) {
    // A conflicted SHARD is the interesting case and it has exactly one cause: two
    // clones sharing a writer id, since per-writer shards are otherwise disjoint.
    // Diagnose it before aborting — the abort is what keeps the promise that the
    // sidecar is untouched, and it also destroys the conflict stages, which is why
    // `heal` re-runs the merge for itself rather than trying to consume this one.
    const conflicted = g(root, ["diff", "--name-only", "--diff-filter=U", "-z"]).out
      .split("\0").map((f) => f.trim()).filter(Boolean);
    const shards = conflicted.filter((f) => f.endsWith(SHARD_EXT));
    g(root, ["merge", "--abort"]);
    if (shards.length) {
      const writer = shards[0]!.split("/").pop()!.replace(SHARD_EXT, "");
      return { error: `shard ${shards[0]} diverged: writer id ${writer} exists in two clones `
        + `(a copied machine image, or a synced home directory). Both sides are intact and the `
        + `sidecar is untouched. Run \`codemap sidecar heal\` on this clone.` };
    }
    return { error: `merge failed and was aborted, the sidecar is untouched: ${merge.err.slice(0, 300)}` };
  }
  const incompat = checkPeers(await readManifests(root), mine);
  if (incompat?.fatal) return { error: incompat.message };

  const erased = beforeSha ? erasedByMerge(root, beforeSha) : [];
  if ("error" in erased) return erased;
  if (erased.length) {
    await restoreErased(root, erased);
    const c = commitLocal(root, "codemap: restore events a merge deleted");
    if (typeof c === "object") return c;
  }

  return {
    gained: (await countEvents(root)) - before,
    ...(incompat ? { warning: incompat.message } : {}),
    ...(erased.length ? { restored: erased.map((e) => ({ path: e.path, events: e.restored.length })) } : {}),
  };
}

/**
 * Peers' manifests as they exist at a fetched COMMIT, without touching the tree.
 *
 * A sha rather than `origin/<branch>`: the ref can move under us now that fetching
 * does not take the lock, and a caller that vets one state must merge that same one.
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
    const blob = g(root, ["show", `${rev}:${MANIFEST_DIR}/${name}`]);
    if (!blob.ok) continue;
    try {
      const m = JSON.parse(blob.out) as SidecarManifest;
      if (m && typeof m.principal === "string" && typeof m.anchorScheme === "number") out.push(m);
    } catch { /* not ours to die on */ }
  }
  if (key) manifestCache.set(key, out);
  return out;
}

export interface PushResult {
  pushed: boolean;
  committed: boolean;
  retries: number;
  /**
   * What the retry pulls brought in.
   *
   * A rejected push re-pulls, and that pull can gain events, restore ones a merge
   * deleted, and raise a warning — all of which were dropped on the floor, so a sync
   * that repaired a deletion on its retry path reported nothing at all.
   */
  gained?: number;
  restored?: Restored[];
  warning?: string;
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

/**
 * Commit whatever is on disk and push it, pulling and retrying on rejection.
 *
 * Retrying without inspecting the rejection is deliberate and only safe because
 * of what is being pushed: append-only files whose meaning does not depend on
 * their position, so a merge in between cannot change what this push says.
 */
export async function push(root: string, message: string, opts: { attempts?: number; actor?: Actor } = {}): Promise<PushResult | { error: string }> {
  const r = await sync(root, opts.actor, message);
  return "error" in r ? r : { pushed: r.pushed, committed: r.committed, retries: r.retries, ...(r.gained ? { gained: r.gained } : {}), ...(r.warning ? { warning: r.warning } : {}) };
}

async function pushHeld(root: string, message: string, opts: { attempts?: number; actor?: Actor } = {}): Promise<PushResult | { error: string }> {
  const attempts = opts.attempts ?? 3;
  // The push-side check lives in `commitLocal`, which is the only thing that commits.
  const commit = commitLocal(root, message);
  if (typeof commit === "object") return commit;
  const committed = commit === "committed";
  if (!hasRemote(root)) return { pushed: false, committed, retries: 0 };

  const branch = branchOf(root);

  // The push-side gate, and it is deliberately against the REMOTE's manifests, not
  // the ones in our tree. `pull` already refuses to merge a fatally incompatible
  // peer, which covers the sync path; this covers `push` called on its own.
  //
  // Checking the local tree instead looks equivalent and is not: our tree holds every
  // peer's manifest, so the moment one teammate upgrades, everybody else would refuse
  // to push and the team would wedge on somebody else's version. The question a
  // pusher must ask is "am I the one who disagrees with what is already there", which
  // is what the fetched ref answers.
  const gateSha = g(root, ["rev-parse", "--verify", "--quiet", `origin/${branch}`]).out;
  const gate = gateSha ? checkPeers(remoteManifests(root, gateSha), currentManifest(opts.actor?.principal ?? "")) : null;
  if (gate?.fatal) return { error: `refusing to push into a sidecar this build cannot agree with: ${gate.message}` };

  // Accumulated across retries, not overwritten: two rejections mean two pulls, and
  // the events or repairs from the first must not vanish when the second reports.
  let gained = 0;
  const restored: Restored[] = [];
  let warning: string | undefined;

  for (let i = 0; i < attempts; i++) {
    const p = g(root, ["push", "--quiet", "origin", `HEAD:${branch}`]);
    if (p.ok) {
      if (!remoteHasHead(root, branch)) {
        return { error: `git push reported success but origin/${branch} does not contain this commit — nothing was sent. The sidecar is intact; retry, and check the remote's refusal (a hook, or a protected branch).` };
      }
      return {
        pushed: true, committed, retries: i,
        ...(gained ? { gained } : {}),
        ...(restored.length ? { restored } : {}),
        ...(warning ? { warning } : {}),
      };
    }
    const pulled = await pullHeld(root, opts.actor);
    if ("error" in pulled) return { error: `push rejected and the follow-up pull failed: ${pulled.error}` };
    gained += pulled.gained;
    if (pulled.restored) restored.push(...pulled.restored);
    warning = pulled.warning ?? warning;
  }
  return { error: `push still rejected after ${attempts} attempts — someone is pushing continuously, or the remote refuses this branch` };
}

export interface HealedMerge { resolved: { path: string; events: number }[] }

/**
 * Re-run the merge and resolve conflicted shards by unioning their lines.
 *
 * **Its own merge, deliberately.** `pull` aborts on conflict, and the abort is what
 * keeps its promise that the sidecar is untouched — it also destroys the `:2:`/`:3:`
 * stages. A heal that tried to consume the conflict `pull` reported would find none
 * left, so it makes its own and consumes that. Loosening `pull`'s abort instead would
 * trade a clear failure for a half-merged tree on every ordinary sync.
 *
 * The union is the correct content resolution for two append-only line files, and it
 * is the same answer `merge=union` used to give — the difference is everything around
 * it. This runs once, loudly, by a person, with the writer rotated and the evidence
 * acknowledged in the same act. The driver did it silently, forever, and hid the fork.
 *
 * Lines from both sides, byte-identical duplicates collapsed, differing-content lines
 * that claim one id BOTH kept: that pair is the duplicate-id evidence, and G3 forbids
 * resolving it by deleting one. `readScope` reports it and a person decides.
 */
async function healMergeHeld(root: string, actor?: Actor): Promise<HealedMerge | { error: string }> {
  const ready = await ensureSidecar(root, actor);
  if ("error" in ready) return ready;
  const pre = commitLocal(root, "codemap: local state before heal");
  if (typeof pre === "object") return pre;
  if (!hasRemote(root)) return { resolved: [] };

  const f = fetchRemote(root);
  if ("error" in f) return f;
  const branch = branchOf(root);
  const remoteSha = g(root, ["rev-parse", "--verify", "--quiet", `origin/${branch}`]).out;
  if (!remoteSha) return { resolved: [] };

  const merge = g(root, ["merge", "--no-edit", "--allow-unrelated-histories", remoteSha]);
  if (merge.ok) return { resolved: [] };   // nothing to heal; the merge simply worked

  const conflicted = g(root, ["diff", "--name-only", "--diff-filter=U", "-z"]).out
    .split("\0").map((x) => x.trim()).filter(Boolean);
  const shards = conflicted.filter((x) => x.endsWith(SHARD_EXT));
  // Anything else conflicting is not ours to resolve by union — a manifest or the
  // attributes file, which are generated identically and should never conflict at all.
  if (!shards.length || shards.length !== conflicted.length) {
    g(root, ["merge", "--abort"]);
    return { error: `heal only resolves shard conflicts, and this merge conflicts on `
      + `${conflicted.filter((x) => !x.endsWith(SHARD_EXT)).join(", ") || "nothing it can see"}. `
      + `The sidecar is untouched.` };
  }

  const resolved: { path: string; events: number }[] = [];
  for (const path of shards) {
    // `git show :2:` / `:3:` — the conflict stages. With `-merge` no conflict markers
    // are ever written into the file, so the working-tree copy is simply "ours" and
    // the other side is only reachable here.
    const ours = g(root, ["show", `:2:${path}`]);
    const theirs = g(root, ["show", `:3:${path}`]);
    const lines = [...ours.out.split("\n"), ...theirs.out.split("\n")].filter((l) => l.trim());
    const union = [...new Set(lines)];
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), union.join("\n") + "\n", "utf8");
    const add = g(root, ["add", "--", path]);
    if (!add.ok) { g(root, ["merge", "--abort"]); return { error: `could not stage ${path}: ${add.err.slice(0, 200)}` }; }
    resolved.push({ path, events: union.length });
  }

  const commit = g(root, ["commit", "-q", "--no-edit"]);
  if (!commit.ok) {
    g(root, ["merge", "--abort"]);
    return { error: `resolved every shard but the merge commit failed, so nothing changed: ${(commit.err || commit.out).slice(0, 300)}` };
  }
  return { resolved };
}

/** `healMergeHeld` with the sidecar lock taken. See the note on `pull`. */
export async function healMerge(root: string, actor?: Actor): Promise<HealedMerge | { error: string }> {
  return withSidecarLock(root, () => healMergeHeld(root, actor));
}

/**
 * Receive only: everything `sync` does except the push.
 *
 * NOT `pull`, and the difference is the whole reason this exists. `pull` is the bare
 * merge: its first line reads `git remote` and returns `gained: 0` on a directory that
 * is not a repository yet, so a teammate who had never synced would click a button and
 * be told, truthfully and uselessly, that nothing arrived. `ensureSidecar` first makes
 * it one; `commitLocal` then clears the scaffold that ensure just wrote, because git
 * refuses a merge that would overwrite untracked files — the same reason `syncHeld`
 * commits before pulling, and the first pull anybody ever runs is exactly that case.
 *
 * The commit is LOCAL. Nothing leaves the machine here; that is the point of the op.
 */
export async function receive(root: string, actor?: Actor, message = "codemap: review state"): Promise<PullResult | { error: string }> {
  // Outside the lock, for `sync`'s reason: a failure is remembered rather than retried
  // inside, so somebody offline waits one git timeout instead of two.
  void message;
  const ready = await withSidecarLock(root, () => ensureSidecar(root, actor));
  if ("error" in ready) return ready;
  return pullLinear(root, actor);
}

export interface SyncResult { gained: number; pushed: boolean; committed: boolean; retries: number; warning?: string; restored?: Restored[] }

/** Send and receive, in the order that makes the publish guard trustworthy. */
export async function sync(root: string, actor?: Actor, message = "codemap: review state"): Promise<SyncResult | { error: string }> {
  const { currentSession } = await import("./sync-session.js");
  const s = currentSession();
  const r = await syncLinear(root, s.session, { actor, message });
  if ("error" in r) return r;
  setTx(root, s.session, s.kind, false);
  return { gained: r.gained, pushed: r.pushed, committed: r.committed, retries: r.retries, ...(r.warning ? { warning: r.warning } : {}) };
}

/** The merge-era sync, dormant until phase 6 deletes it. */
export async function mergeSync(root: string, actor?: Actor, message = "codemap: review state"): Promise<SyncResult | { error: string }> {
  // Fetch first and unlocked — see `fetchRemote`. A failure is NOT fatal here: the
  // sidecar may be brand new (no repo yet, so nothing to fetch from) or offline, and
  // both of those still have local work to commit. `syncHeld` fetches for itself when
  // this did not, and reports the failure then.
  const pre = fetchRemote(root);
  // A failure here is NOT fatal: the sidecar may not be a repo yet (nothing to fetch
  // from, reported as `fetched: false`, and `ensureSidecar` is about to create it).
  // But a genuine fetch failure IS remembered rather than retried in the lock — the
  // retry would fail the same way after another full git timeout, so a user with no
  // network waited twice as long to be told once.
  const fetched: FetchState = "error" in pre ? pre : pre.fetched;
  // The WHOLE remaining sequence, not each git call: commit-then-merge-then-push is
  // one transaction against one working tree, and interleaving two of them is how you
  // get a push that carries half of somebody else's merge. See `withSidecarLock`.
  return withSidecarLock(root, () => syncHeld(root, actor, message, fetched));
}

async function syncHeld(root: string, actor?: Actor, message = "codemap: review state", fetched: FetchState = false): Promise<SyncResult | { error: string }> {
  const ready = await ensureSidecar(root, actor);
  if ("error" in ready) return ready;
  // Pull FIRST, always. `alreadyPosted` is only a guard against double-publishing
  // if it has seen what everyone else already published; planning a push against a
  // stale pull is the one place where being behind is actively destructive rather
  // than merely incomplete.
  // Commit BEFORE pulling: the scaffold ensureSidecar just wrote is untracked, and
  // git refuses a merge that would overwrite untracked files — so without this the
  // first pull a new person ever runs fails on their own setup's files.
  const pre = commitLocal(root, message);
  if (typeof pre === "object") return pre;
  const pulled = await pullHeld(root, actor, fetched);
  if ("error" in pulled) return pulled;
  const pushed = await pushHeld(root, message, { actor });
  if ("error" in pushed) return pushed;
  // The push's own numbers are folded in, not dropped: its retry pulls are pulls too.
  const restored = [...(pulled.restored ?? []), ...(pushed.restored ?? [])];
  const warning = pulled.warning ?? pushed.warning;
  return {
    gained: pulled.gained + (pushed.gained ?? 0),
    pushed: pushed.pushed,
    committed: pre === "committed" || pushed.committed,
    retries: pushed.retries,
    ...(warning ? { warning } : {}),
    ...(restored.length ? { restored } : {}),
  };
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
}

export type LinearFailure = {
  error: string;
  /** Every op the fold refused, when a replay was refused. All-or-nothing: none landed. */
  conflicts?: Refusal[];
  /** Ops still staged for this session after the failure. */
  staged?: string[];
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
 * Events in this clone — the working tree or a local commit — that are neither on the remote
 * tip nor held by the queue. Resetting to the tip would destroy them, so a sync refuses
 * instead. The ordinary case (a clean tree at, or behind, the tip) costs two git calls.
 */
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

async function unqueuedLocalEvents(root: string, remoteSha: string): Promise<{ path: string; id: string }[]> {
  const head = rev(root, "HEAD");
  // `gRaw` and `-z`: see `damagedWorkingShards` for what trimming porcelain output costs.
  const dirty = gRaw(root, ["status", "--porcelain", "-z", "--untracked-files=all", "--", `*${SHARD_EXT}`]).out
    .split("\0").map((entry) => /^.. (.*)$/.exec(entry)?.[1] ?? entry).filter((p) => p.endsWith(SHARD_EXT));
  const ahead = !!head && head !== remoteSha && !g(root, ["merge-base", "--is-ancestor", head, remoteSha]).ok;
  if (!dirty.length && !ahead) return [];
  const changed = new Set(dirty);
  if (ahead) {
    for (const p of g(root, ["diff", "--name-only", remoteSha, head, "--", `*${SHARD_EXT}`]).out.split("\n")) if (p.trim()) changed.add(p.trim());
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

/** Put the working tree at `sha` — tracked files reset, stray shards removed. */
function resetTo(root: string, sha: string): { error: string } | null {
  const r = g(root, ["reset", "-q", "--hard", sha]);
  if (!r.ok) return { error: `could not move the sidecar to the remote tip: ${r.err.slice(0, 300)}` };
  g(root, ["clean", "-fq", "--", `*${SHARD_EXT}`]);
  return null;
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
  const pre = fetchRemote(root);
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
  const forgetInline = () => { if (inlineId) { markStaged(root, [inlineId]); drop(root, session, inlineId); inlineId = null; } };

  for (let attempt = 0; attempt < PUSH_ATTEMPTS; attempt++) {
    if (attempt > 0) await sleep(50 + Math.random() * 400 * attempt);
    let remoteSha = "";
    if (remote) {
      const f = attempt === 0 && fetched0 !== false ? fetched0 : (() => {
        const r = g(root, ["fetch", "--quiet", "origin"]);
        return r.ok ? true : { error: `fetch failed: ${r.err.slice(0, 300)}` };
      })();
      if (typeof f === "object") {
        forgetInline();
        return { error: `could not reach the sidecar remote, so nothing was synced (${f.error}). Shared state is online-only: `
          + `${opts.inline ? "the act was NOT written" : "staged writes stay staged until a sync succeeds"}.`, staged: stagedIds() };
      }
      remoteSha = rev(root, `origin/${branch}`);
    }
    // Damage in this clone's own tree locks it before anything moves: the reset below would
    // repair it from the remote, and silently — which hides whatever put it there.
    const local = damagedWorkingShards(root);
    if (local.length) {
      forgetInline();
      lockOn(root, local);
      return { error: `refusing to sync: ${local.length} line(s) in this clone's sidecar are damaged — bytes that are not `
        + `JSON, or an event no conforming build writes.\n${damageDetail(local)}\n`
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
      if (head !== remoteSha) {
        const damaged = damagedInboundShards(root, head, remoteSha);
        if (damaged.length) {
          forgetInline();
          lockOn(root, damaged);
          return { error: `refusing to take the remote tip: ${damaged.length} line(s) in it are damaged — bytes that are not `
            + `JSON, or an event no conforming build writes. The sidecar is untouched.\n${damageDetail(damaged)}\n`
            + `The store is locked until the team's log is repaired: see docs/log-repair.md.` };
        }
      }
      const moved = resetTo(root, remoteSha);
      if (moved) { forgetInline(); return moved; }
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
    for (const op of ops) {
      const evs = await scopeEvents(op.scope);
      if (evs.some((e) => e.id === op.event.id)) { already.push(op.event.id); continue; }
      const e = atTip(evs, writer, top, op.event);
      const why = await refusalOf(doorFor(root, op.scope), evs, e);
      if (why) { refusals.push({ id: e.id, kind: e.kind, scope: op.scope, why }); continue; }
      await append(op.scope, e);
      evs.push(e); top++; landedNow.push(e.id);
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
      const staged: StagedEvent = {
        sidecarProtocol: SIDECAR_PROTOCOL, eventSchema: EVENT_SCHEMA, id: mintId(), kind: admission.kind,
        subject: admission.subject, actor: a.actor, at: new Date().toISOString(), after: causalHeads(evs),
        ...(admission.data ? { data: admission.data } : {}),
      };
      const e = atTip(evs, writer, top, staged);
      const why = await refusalOf(a.fold ?? doorFor(root, a.scope), evs, e);
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
    const toLand = [...landedNow, ...already];

    const committed = commitLocal(root, message);
    if (typeof committed === "object") {
      await truncateBack(root, sizes);
      markStaged(root, ops.map((o) => o.event.id));
      forgetInline();
      return { ...committed, staged: stagedIds() };
    }
    // What arrived from others: everything on disk now, less what this sync appended.
    const result = async (pushed: boolean, retries: number): Promise<LinearResult> => ({
      gained: Math.max(0, (await countEvents(root)) - before - landedNow.length), pushed,
      committed: committed === "committed", retries, landed: landedNow,
      ...(warning ? { warning } : {}), ...(inlineEvent ? { event: inlineEvent } : {}),
    });
    if (!remote) { markLanded(root, toLand); return result(false, attempt); }
    const head = rev(root, "HEAD");
    // `pushed` says the remote holds our history — true here — and `committed` whether this
    // sync had anything of its own; conflating them trades a lie for a false alarm.
    if (head && head === remoteSha) { markLanded(root, toLand); return result(true, attempt); }

    const t0 = Date.now();
    const p = g(root, ["push", "--quiet", "origin", `HEAD:${branch}`]);
    const rate = recordPush(root, Date.now() - t0);
    warning = rate ?? warning;
    if (p.ok) {
      if (!remoteHasHead(root, branch)) {
        return { error: `git push reported success but origin/${branch} does not contain this commit — nothing was sent. `
          + `The writes stay staged; retry, and check the remote's refusal (a hook, or a protected branch).`, staged: stagedIds() };
      }
      markLanded(root, toLand);
      inlineId = null;
      return result(true, attempt);
    }
    if (isRejection(p.err)) continue;
    // Not a lost race. The push may or may not have reached the remote, so the ops stay
    // `inflight`: the next sync looks for their ids at the tip before it replays anything.
    return { error: `the push to the sidecar remote failed: ${p.err.slice(0, 300)}. The write(s) are kept on this machine and `
      + `the next sync confirms or retries them — never both.`, staged: stagedIds() };
  }
  if (remote) {
    const tip = rev(root, `origin/${branch}`);
    if (tip) resetTo(root, tip);
  }
  markStaged(root, pending(root, session).map((o) => o.event.id));
  forgetInline();
  return { error: `busy: the sidecar remote moved under ${PUSH_ATTEMPTS} attempts in a row. Nothing was pushed; try again.`, staged: stagedIds() };
}

/** Bring the tree to the remote tip without pushing anything. */
export async function pullLinear(root: string, actor?: Actor): Promise<PullResult | { error: string }> {
  const pre = fetchRemote(root);
  if ("error" in pre) return pre;
  return withSidecarLock(root, async () => {
    if (!pre.fetched) return { gained: 0 };
    const branch = branchOf(root);
    const remoteSha = rev(root, `origin/${branch}`);
    if (!remoteSha) return { gained: 0 };
    const head = rev(root, "HEAD");
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
    const damaged = damagedInboundShards(root, head, remoteSha);
    if (damaged.length) {
      lockOn(root, damaged);
      return { error: `refusing to take the remote tip: ${damaged.length} line(s) in it are damaged — bytes that are not `
        + `JSON, or an event no conforming build writes. The sidecar is untouched.\n${damageDetail(damaged)}\n`
        + `The store is locked until the team's log is repaired: see docs/log-repair.md.` };
    }
    const before = await countEvents(root);
    const moved = resetTo(root, remoteSha);
    if (moved) return moved;
    if (actor) await ensureSidecar(root, actor);
    return { gained: (await countEvents(root)) - before, ...(incompat ? { warning: incompat.message } : {}) };
  });
}

function queuedIds(root: string): Set<string> {
  return new Set(allQueuedIds(root));
}
