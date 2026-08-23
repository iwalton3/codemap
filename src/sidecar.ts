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
import { appendFile, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { join, dirname } from "node:path";
import { ANCHOR_SCHEME, HASH_SCHEME } from "./schema.js";
import { GRAMMAR_VERSIONS } from "./grammar-versions.js";
import { gitBin } from "./git.js";
import { withSidecarLock, touchHeldLocks } from "./lock.js";
import { SHARD_EXT, principalKey } from "./eventlog.js";
import type { Actor } from "./schema.js";

/**
 * Two paths naming the same directory. `realpath` both: macOS `/tmp` is a symlink
 * to `/private/tmp`, and git answers with the resolved form, so a string compare
 * would decide a perfectly good sidecar was not its own repo.
 */
function samePath(a: string, b: string): boolean {
  if (!a || !b) return false;
  try { return realpathSync(a) === realpathSync(b); } catch { return a === b; }
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
  touchHeldLocks();
  const r = spawnSync(gitBin(), args, { cwd: root, encoding: "utf8", maxBuffer: 1 << 28, timeout: GIT_CALL_TIMEOUT_MS });
  touchHeldLocks();
  return { ok: r.status === 0, out: (r.stdout ?? "").trim(), err: (r.stderr ?? "").trim() };
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
 * Make `root` a usable sidecar: a git repo, with the union merge driver in place
 * and a manifest.
 *
 * `merge=union` is what covers the one case single-writer sharding does not — the
 * same person appending from two machines. Git takes the lines from both sides,
 * which is exactly right for an append-only line file, and the fold sorts and
 * dedupes afterwards so neither reordering nor duplication survives.
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
  await writeFile(join(root, ATTRIBUTES), `*${SHARD_EXT} merge=union\n`, "utf8");
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
  return blob.out.split("\n").filter((l) => l.trim());
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

function fetchRemote(root: string): { fetched: boolean } | { error: string } {
  if (!g(root, ["remote"]).out) return { fetched: false };
  const r = g(root, ["fetch", "--quiet", "origin"]);
  return r.ok ? { fetched: true } : { error: `fetch failed: ${r.err.slice(0, 300)}` };
}

/**
 * Fetch and merge. A sidecar with no remote is a perfectly good local one, so
 * that is a no-op rather than an error — the whole design works offline and only
 * needs a remote to reach other people.
 */
export async function pull(root: string, actor?: Actor): Promise<PullResult | { error: string }> {
  const f = fetchRemote(root);
  if ("error" in f) return f;
  return withSidecarLock(root, () => pullHeld(root, actor, f.fetched));
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
  if (!g(root, ["remote"]).out) return { gained: 0 };
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

  // No `-c merge.union.driver=...`: `union` is one of git's BUILT-IN drivers, and
  // defining one by that name would replace it with whatever was named instead.
  //
  // `--allow-unrelated-histories` because the ordinary way a team arrives here is
  // that everybody ran `ensureSidecar` locally and then pointed it at the same
  // remote, so the second person's history is genuinely unrelated to the first's.
  // Safe for this content specifically: the shards union-merge, and the only other
  // files are the manifest and .gitattributes, which are generated identically by
  // the same code. Compatibility is checked below, on the merged result.
  // Our tip BEFORE the merge, so the append-only audit below has something to
  // compare against. `HEAD` on an unborn branch has no sha, and there is nothing to
  // erase in that case either.
  const beforeSha = g(root, ["rev-parse", "--verify", "--quiet", "HEAD"]).out;

  const merge = g(root, ["merge", "--no-edit", "--allow-unrelated-histories", remoteSha]);
  if (!merge.ok) {
    // With union merging on the shards, the realistic causes are a genuine
    // conflict in the manifest or attributes — not in anyone's events.
    g(root, ["merge", "--abort"]);
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
function remoteManifests(root: string, rev: string): SidecarManifest[] {
  const listing = g(root, ["ls-tree", "--name-only", `${rev}:${MANIFEST_DIR}`]);
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
  return withSidecarLock(root, () => pushHeld(root, message, opts));
}

async function pushHeld(root: string, message: string, opts: { attempts?: number; actor?: Actor } = {}): Promise<PushResult | { error: string }> {
  const attempts = opts.attempts ?? 3;
  const commit = commitLocal(root, message);
  if (typeof commit === "object") return commit;
  const committed = commit === "committed";
  if (!g(root, ["remote"]).out) return { pushed: false, committed, retries: 0 };

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

export interface SyncResult { gained: number; pushed: boolean; committed: boolean; retries: number; warning?: string; restored?: Restored[] }

/** Send and receive, in the order that makes the publish guard trustworthy. */
export async function sync(root: string, actor?: Actor, message = "codemap: review state"): Promise<SyncResult | { error: string }> {
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
