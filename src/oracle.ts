/**
 * The oracle: a team of whole UNIVERSES, not just sidecars.
 *
 * `scenario.ts` gives each person a sidecar and nothing else. That is enough to
 * test the log and not enough to test review — a reviewer needs code to read, an
 * index over it, and a branch that moves under them. Here a person is the three
 * things a real machine has: a clone of a shared code repo, their own `.codemap`
 * store, and their own sidecar clone.
 *
 * Why it exists: 699 tests pass and every one of them is a handful of operations
 * against a store born at the current schema. Real review is a long chain — index,
 * document, publish, sync, review a branch, file findings, disagree, edit a
 * colleague's doc, change the code, re-index, confirm, sync again — and a defect
 * that needs six steps to appear cannot appear in three. This is the machinery for
 * driving the whole chain and checking, after every step, that the properties that
 * must always hold still do.
 *
 * `docs/HANDOFF.md` § "Your job: build the oracle" is the brief.
 */

import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { spawnSync } from "node:child_process";
import type { Actor } from "./schema.js";
import { gitBin } from "./git.js";
import { ensureSidecar } from "./sidecar.js";
import { sharedSync } from "./ops-shared.js";
import { forgetWriter, principalKey } from "./eventlog.js";
import { init } from "./ops.js";
import { clearPrMetaCache } from "./pr.js";

/**
 * Every member's universe directory has the SAME basename, and that is load-bearing.
 *
 * `universeKey` is the origin's GitHub slug, or the directory basename when there
 * isn't one — and a local bare repo is never a GitHub URL, so every clone here takes
 * the fallback. Give the clones different names and each one publishes under a
 * different universe, so the scopes a teammate's fold looks for are scopes nobody
 * ever wrote. Nothing errors; the team simply never sees each other's work.
 *
 * `url.<local>.insteadOf` looks like the fix that would let this exercise the real
 * slug path instead. It is not: `git remote get-url` applies the rewrite itself, so
 * `originSlug` reads the local path right back and the fallback happens anyway.
 */
const UNIVERSE_DIR = "acme-api";

const git = (root: string, ...args: string[]) =>
  spawnSync(gitBin(), args, { cwd: root, encoding: "utf8" });

/** A person's whole machine. */
export interface Member {
  /**
   * This MACHINE, not this person — and the distinction is the whole writer model.
   *
   * One principal on two clones is the case sharding does not cover and `heal` exists
   * for, so the oracle has to be able to represent it. Keying members by principal
   * made `team([izzie, izzie])` collapse two machines into one map entry, and every
   * convergence check over it passed by comparing a clone with itself.
   */
  machine: string;
  actor: Actor;
  /** Their clone of the code repo — the universe root, where `.codemap` lives. */
  repo: string;
  /** Their sidecar clone. */
  sidecar: string;
}

export interface Team {
  /** The bare code repo everyone clones and pushes branches to. */
  codeOrigin: string;
  /** The bare sidecar repo the shared log lives in. */
  sidecarOrigin: string;
  /** By machine id. Two clones of one person are two entries. */
  members: Map<string, Member>;
  all: Member[];
  dispose(): void;
}

/**
 * Files by repo-relative path. `null` DELETES — a rename is a delete plus a write.
 *
 * Without deletion the harness can only ever add and overwrite, so no scenario built
 * on it can reach a removed anchor, an orphan, a tombstone, or a pull request that
 * takes a symbol away — which is a large share of what makes staleness interesting.
 */
export type Tree = Record<string, string | null>;

/**
 * A small polyglot seed. Deliberately real source in THREE grammars: the index has to
 * produce anchors for anything downstream to cite, and a fixture with one language
 * cannot show a per-citation derivation rule doing its job.
 *
 * The C# half is not decoration — it is the only part that reaches the anchor-id
 * shapes this project exists for, and a TypeScript-and-Python seed cannot produce any
 * of them:
 *
 *   - **Overloads**, and so a DISAMBIGUATOR. `Settle` is `(decimal)` and
 *     `(decimal,string)`; an id derives from `file \0 symbolPath \0 disambiguator`,
 *     so changing an overload's signature changes its id. In an event-sourced
 *     codebase that is `Apply(SomeEvent)` — exactly the code people file findings
 *     about. Neither other grammar in this repo emits a disambiguator at all.
 *   - **Namespaces** in the symbol path, so a rename above the symbol moves ids that
 *     never textually changed.
 *   - **Partial types across two files**, which is the real shape (two `partial`
 *     declarations in ONE file collide — see `docs/anchor-id-provenance.md`) and the
 *     only way a class has two anchors that a reader must not treat as duplicates.
 *
 * `oracle.test.ts` asserts all three are really in the index. Without that control a
 * seed that quietly stopped indexing `.cs` would read as coverage.
 */
export const SEED: Tree = {
  "src/pay.ts":
    "export function transfer(amount: number, to: string) {\n"
    + "  if (amount <= 0) throw new Error(\"amount must be positive\");\n"
    + "  return { to, amount, at: \"now\" };\n"
    + "}\n\n"
    + "export function refund(amount: number, to: string) {\n"
    + "  return transfer(-amount, to);\n"
    + "}\n",
  "src/ledger.ts":
    "export class Ledger {\n"
    + "  post(entry: { amount: number }) {\n"
    + "    return entry.amount;\n"
    + "  }\n"
    + "}\n",
  "src/settle.py":
    "def settle(batch):\n"
    + "    return sum(item['amount'] for item in batch)\n\n"
    + "def reconcile(a, b):\n"
    + "    return a - b\n",
  "src/Settlement/SettlementService.cs":
    "namespace Acme.Api.Settlement;\n\n"
    + "public class SettlementService\n"
    + "{\n"
    + "    public decimal Settle(decimal amount) => amount;\n\n"
    + "    public decimal Settle(decimal amount, string currency)\n"
    + "    {\n"
    + "        if (currency == \"USD\") return amount;\n"
    + "        return amount * 1.0m;\n"
    + "    }\n"
    + "}\n",
  // ONE class, TWO files. Real partials live apart, and each declaration is its own
  // anchor because the file is the first field of the digest.
  "src/Settlement/LedgerAccount.Balance.cs":
    "namespace Acme.Api.Settlement;\n\n"
    + "public partial class LedgerAccount\n"
    + "{\n"
    + "    public decimal Balance(decimal[] entries)\n"
    + "    {\n"
    + "        decimal total = 0m;\n"
    + "        foreach (var e in entries) total += e;\n"
    + "        return total;\n"
    + "    }\n"
    + "}\n",
  "src/Settlement/LedgerAccount.Posting.cs":
    "namespace Acme.Api.Settlement;\n\n"
    + "public partial class LedgerAccount\n"
    + "{\n"
    + "    public void Post(decimal amount)\n"
    + "    {\n"
    + "        if (amount <= 0) throw new System.ArgumentException(\"amount must be positive\");\n"
    + "    }\n"
    + "}\n",
  "README.md": "# acme-api\n\nA fixture universe.\n",
};

/**
 * A team with a shared code origin, a shared sidecar origin, and one clone of each
 * per person.
 *
 * Everyone starts indexed and synced, so a test's own steps are the only source of
 * divergence — otherwise the first write of every test is accidentally concurrent
 * and nothing measures what it meant to.
 */
export async function team(principals: string[], opts: { seed?: Tree } = {}): Promise<Team> {
  const root = mkdtempSync(join(tmpdir(), "codemap-oracle-"));
  const dispose = () => rmSync(root, { recursive: true, force: true });

  const codeOrigin = join(root, "code-origin.git");
  const sidecarOrigin = join(root, "sidecar-origin.git");
  mkdirSync(codeOrigin, { recursive: true });
  mkdirSync(sidecarOrigin, { recursive: true });
  git(codeOrigin, "init", "-q", "--bare", "-b", "main");
  git(sidecarOrigin, "init", "-q", "--bare", "-b", "main");

  // Seed through a throwaway clone: the origin must have a HEAD before anyone clones
  // it, and half the diff surface needs a commit to resolve against.
  const seedDir = join(root, "seed");
  git(root, "clone", "-q", codeOrigin, seedDir);
  identify(seedDir, "seed@acme.test", "seed");
  writeTree(seedDir, opts.seed ?? SEED);
  git(seedDir, "add", "-A");
  git(seedDir, "commit", "-qm", "seed");
  git(seedDir, "push", "-q", "origin", "main");
  rmSync(seedDir, { recursive: true, force: true });

  const members = new Map<string, Member>();
  const all: Member[] = [];
  for (const [i, principal] of principals.entries()) {
    const machine = `m${i}`;
    const home = join(root, machine);
    const repo = join(home, UNIVERSE_DIR);
    mkdirSync(home, { recursive: true });
    git(root, "clone", "-q", codeOrigin, repo);
    identify(repo, principal, principal.split("@")[0]!);

    const sidecar = join(home, "sidecar");
    const actor: Actor = { principal };
    await ensureSidecar(sidecar, actor);
    git(sidecar, "remote", "add", "origin", sidecarOrigin);

    // The pointer must exist before any op resolves the sidecar, and the git remote
    // must exist before the first `init` — `universeKey` memoises per root, so a
    // remote added afterwards leaves this universe keyed by whatever it was first.
    mkdirSync(join(repo, ".codemap"), { recursive: true });
    writeFileSync(join(repo, ".codemap", "sidecar"), sidecar, "utf8");
    await init(repo);

    const m: Member = { machine, actor, repo, sidecar };
    members.set(machine, m);
    all.push(m);
  }

  // Two passes, so everyone ends up holding everyone's manifest rather than only the
  // people who happened to sync after them.
  for (const m of all) await sharedSync(m.repo);
  for (const m of all) await sharedSync(m.repo);

  return { codeOrigin, sidecarOrigin, members, all, dispose };
}

/** Git identity for a clone. Set before any op: `resolvePrincipal` caches per root. */
function identify(root: string, email: string, name: string): void {
  git(root, "config", "user.email", email);
  git(root, "config", "user.name", name);
}

function writeTree(root: string, tree: Tree): void {
  for (const [rel, content] of Object.entries(tree)) {
    const abs = join(root, rel);
    if (content === null) { rmSync(abs, { force: true }); continue; }
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content, "utf8");
  }
}

/** Move a file, which is what a symbol changing address actually looks like. */
export function rename(m: Member, from: string, to: string): void {
  const content = readFileSync(join(m.repo, from), "utf8");
  writeTree(m.repo, { [from]: null, [to]: content });
}

/**
 * A member by principal — for the ordinary case of one machine each.
 *
 * Throws when a principal has more than one, rather than picking: with two clones of
 * one person, "which one" is the entire question a test is asking, and answering it
 * silently is how a scenario ends up asserting about a machine it did not mean.
 * Use `t.all` or `machine()` there.
 */
export const who = (t: Team, principal: string): Member => {
  const found = t.all.filter((m) => m.actor.principal === principal);
  if (!found.length) throw new Error(`no such person on this team: ${principal}`);
  if (found.length > 1) {
    throw new Error(`${principal} is on ${found.length} machines (${found.map((m) => m.machine).join(", ")}) — name one with machine()`);
  }
  return found[0]!;
};

/** A member by machine id, for a person who is on more than one. */
export const machine = (t: Team, id: string): Member => {
  const m = t.members.get(id);
  if (!m) throw new Error(`no such machine on this team: ${id}`);
  return m;
};

// --- the code repo: what a reviewer's day actually moves ---------------------------

/** Write files into a member's working tree. Nothing is committed until `commit`. */
export const edit = (m: Member, tree: Tree): void => writeTree(m.repo, tree);

export function commit(m: Member, message: string): string {
  git(m.repo, "add", "-A");
  const r = git(m.repo, "commit", "-qm", message);
  if (r.status !== 0) throw new Error(`commit failed: ${r.stderr}`);
  moved();
  return git(m.repo, "rev-parse", "HEAD").stdout.trim();
}

/**
 * Anything that moves a ref invalidates PR resolution.
 *
 * `prContext` caches for 60 seconds and a scenario runs in milliseconds, so without
 * this a step that pushes a commit and then re-reads the pull request is handed the
 * head from before its own push — and asserts against state it did not produce.
 */
const moved = () => clearPrMetaCache();

export function branch(m: Member, name: string, opts: { create?: boolean } = {}): void {
  const r = git(m.repo, "checkout", "-q", ...(opts.create ? ["-b"] : []), name);
  if (r.status !== 0) throw new Error(`checkout ${name} failed: ${r.stderr}`);
}

export function pushBranch(m: Member, name: string): void {
  const r = git(m.repo, "push", "-q", "origin", `${name}:${name}`);
  if (r.status !== 0) throw new Error(`push ${name} failed: ${r.stderr}`);
  moved();
}

export function fetchCode(m: Member): void {
  const r = git(m.repo, "fetch", "-q", "origin");
  if (r.status !== 0) throw new Error(`fetch failed: ${r.stderr}`);
}

/** Land a branch with a merge commit — the shape that makes a merged PR's base recoverable. */
export function mergeBranch(m: Member, name: string, message = `Merge ${name}`): string {
  const r = git(m.repo, "merge", "--no-ff", "-q", "-m", message, name);
  if (r.status !== 0) throw new Error(`merge ${name} failed: ${r.stderr}`);
  moved();
  return git(m.repo, "rev-parse", "HEAD").stdout.trim();
}

/**
 * Publish a synthetic pull-request head, the way GitHub does.
 *
 * `refs/pull/N/head` is a server-side ref, which is why `ensurePrObjects` can fetch a
 * FORK's head with plain git and no `gh`. Pushing one into the bare origin gives a
 * hermetic fixture for both cases the resolver has to tell apart:
 *
 *   - `branch` given — a same-origin PR. The pull ref and a branch point at one sha,
 *     which is exactly the mapping that recovers the branch name without `gh`.
 *   - `sha` given with no branch — a FORK. The head is in no branch of this origin,
 *     so there is no branch to key by and the number is the only identity there is.
 */
export function openPr(m: Member, n: number, at: { branch?: string; sha?: string }): string {
  const source = at.branch ?? at.sha;
  if (!source) throw new Error("openPr needs a branch or a sha");
  const sha = git(m.repo, "rev-parse", source).stdout.trim();
  const r = git(m.repo, "push", "-q", "origin", `${sha}:refs/pull/${n}/head`);
  if (r.status !== 0) throw new Error(`push pull/${n}/head failed: ${r.stderr}`);
  moved();
  return sha;
}

// --- the sidecar --------------------------------------------------------------------

/**
 * `sharedSync`, the OP — never `sidecar.ts`'s `sync` underneath it.
 *
 * The transport moves bytes; the op moves bytes and then materializes every scope in
 * the universe. Calling the lower one leaves each clone holding a log it has not
 * projected, which is a state no real machine is ever in — every read folds, and a
 * scenario built on it is measuring something nobody runs. Caught by the
 * COMPLETENESS property, which is the sort of thing it is for.
 */
export const syncOne = (m: Member) => sharedSync(m.repo);

/** Everybody syncs twice, which is what it takes for a change to reach everyone. */
export async function settle(t: Team): Promise<void> {
  for (let round = 0; round < 2; round++) {
    for (const m of t.all) {
      const r = await sharedSync(m.repo) as { error?: string };
      if (r.error) throw new Error(`sync failed for ${m.actor.principal}: ${r.error}`);
    }
  }
}

/**
 * Two people write without having seen each other's work, then both sync.
 *
 * **`whileApart`, not `concurrently`, and the name is the point.** This produces
 * CAUSAL concurrency — the only kind the log has a definition for: neither event's
 * `after` reaches the other, so nothing orders them and a conflict is a real conflict.
 * The writes are still executed one after another, on one thread, in this process.
 *
 * The earlier name claimed simultaneity it never delivered, which mattered because the
 * two are different tests of different things. Anything about the LOCK, the retry loop,
 * or a lost update needs two real processes contending for one sidecar, and no
 * arrangement of `await`s can produce that: two awaits in one process share a lock
 * owner and never contend at all. That is `oracle-race.test.ts`, and it is the only
 * place in this suite where two things genuinely run at once.
 */
export async function whileApart(
  t: Team,
  a: string, aWrite: (m: Member) => Promise<unknown>,
  b: string, bWrite: (m: Member) => Promise<unknown>,
): Promise<void> {
  // Settle FIRST, or the writes are accidentally concurrent with whatever the scenario
  // did before them and the test measures something it did not mean.
  await settle(t);
  await aWrite(who(t, a));
  await bWrite(who(t, b));
  await settle(t);
}

// --- hostile history ----------------------------------------------------------------

/**
 * Rewrite a member's sidecar by hand and commit it, the way a person with `git` can.
 *
 * The sidecar is an ordinary git repository on somebody's disk, so every guarantee the
 * log makes has to survive a person editing it — deliberately, or by resolving a merge
 * badly, or by a script that "cleans up". Nothing above this line can produce those
 * states: the ops only ever append well-formed events.
 *
 * `mutate` is handed the shard paths that exist under `scope` and may write, add or
 * delete files under `m.sidecar`. Everything is staged with `git add -A`, so a deletion
 * is a real deletion in the commit.
 */
export function rewriteHistory(m: Member, message: string, mutate: (paths: string[], sidecar: string) => void): void {
  const scopes = readdirSync(m.sidecar, { withFileTypes: true, recursive: true })
    .filter((d) => d.isFile() && d.name.endsWith(".ndjson"))
    .map((d) => relative(m.sidecar, join(d.parentPath, d.name)));
  mutate(scopes, m.sidecar);
  git(m.sidecar, "add", "-A");
  const r = git(m.sidecar, "commit", "-qm", message);
  // An empty commit means the mutation did nothing, and a scenario built on it would
  // assert against history it never actually rewrote.
  if (r.status !== 0) throw new Error(`rewriteHistory changed nothing: ${r.stdout || r.stderr}`);
}

/**
 * Append a raw line to a shard, bypassing every write path.
 *
 * The only way to reach an event this build would never mint — a protocol from the
 * future, a `writerPrev` cycle, a duplicated id. Those are the shapes `scopeStatus`
 * exists to refuse, and a test that cannot produce them is testing the refusal against
 * nothing.
 *
 * Deliberately NOT typed as `LogEvent`: the point is a malformed or forward-dated
 * envelope, and a type that made those unrepresentable would defeat it.
 */
export function appendRaw(m: Member, shardPath: string, event: Record<string, unknown>): void {
  const abs = join(m.sidecar, shardPath);
  mkdirSync(dirname(abs), { recursive: true });
  const existing = existsSync(abs) ? readFileSync(abs, "utf8") : "";
  const sep = !existing || existing.endsWith("\n") ? "" : "\n";
  writeFileSync(abs, existing + sep + JSON.stringify(event) + "\n", "utf8");
}

/** Every shard path under a scope, sidecar-relative. */
export function shardsIn(m: Member, scope: string): string[] {
  const dir = join(m.sidecar, scope);
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((f) => f.endsWith(".ndjson")).map((f) => join(scope, f));
}

/**
 * Publish somebody's manifest, as if they were on a different codemap build.
 *
 * The only honest way to reach upgrade skew in one process: `ensureSidecar` rewrites
 * THIS machine's manifest from `currentManifest()` on every sync, so a clone cannot
 * misrepresent its own build for longer than a call. A teammate's manifest is a file
 * this clone never rewrites, which is exactly what makes it the thing being trusted —
 * and the gate reads the REMOTE copy (`git ls-tree`) as well as the working tree, so a
 * manifest for one's OWN principal is reachable too, pushed from another machine.
 *
 * Writes and pushes from `from`'s clone, so `principal` should be somebody else.
 */
export function publishManifestAs(
  from: Member,
  principal: string,
  manifest: { anchorScheme: number; hashScheme: number; grammars?: Record<string, string> },
): void {
  const dir = join(from.sidecar, "manifests");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, principalKey(principal) + ".json"),
    JSON.stringify({ principal, grammars: {}, ...manifest }, null, 2) + "\n",
    "utf8",
  );
  git(from.sidecar, "add", "-A");
  const c = git(from.sidecar, "commit", "-qm", `manifest for ${principal}`);
  if (c.status !== 0) throw new Error(`manifest commit failed: ${c.stdout || c.stderr}`);
  const p = git(from.sidecar, "push", "-q", "origin", "HEAD:main");
  if (p.status !== 0) throw new Error(`manifest push failed: ${p.stderr}`);
}

/**
 * Make `to` a CLONE of `from`'s machine: same writer id, same person.
 *
 * The case sharding does not cover, and the one `heal` exists for. Two ordinary
 * clones have different writer ids and so write different shards, so no amount of
 * concurrent writing produces a fork — the id has to be copied deliberately.
 *
 * Pass two machines of ONE principal (`team([izzie, izzie])`). Copying a writer id
 * between two different people is a fork the system should also survive, but it is
 * not what this models, and calling it a cloned machine would misname the scenario.
 */
export function cloneMachine(from: Member, to: Member): void {
  let id: string;
  try { id = readFileSync(join(from.sidecar, ".git", "codemap-writer"), "utf8").trim(); }
  catch {
    // The id is minted on first append, so there is nothing to copy from a clone that
    // has never written — and the copy would silently do nothing, leaving a scenario
    // that believes it forked and never did.
    throw new Error(
      `${from.machine} has no writer id yet — a clone mints one on its first append. `
      + `Have it write something shared before cloning it.`,
    );
  }
  writeFileSync(join(to.sidecar, ".git", "codemap-writer"), id + "\n", "utf8");
  // Without this the copy is inert on a clone that has already appended, and the
  // fork the test is about never happens. See `forgetWriter`.
  forgetWriter(to.sidecar);
}
