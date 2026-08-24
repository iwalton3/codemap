/**
 * A real repository as an e2e fixture.
 *
 * The synthetic fixtures in `harness.ts` cannot reach the failures that only a
 * genuine history produces: a MERGED pull request whose head is an ancestor of
 * the base branch (so `merge-base(tip, head)` is the head itself and a naive
 * read reports the PR as changing nothing), C# files large enough that a
 * per-symbol index is not trivially correct, and symbols a branch DELETES.
 *
 * The repo is not this project's to own, so — like the puppeteer suite — the
 * tests skip when it is absent rather than fetching one. Point
 * `CODEMAP_E2E_GIT_REPO` at any clone of `jellyfin/jellyfin` that already holds
 * the fixture commits.
 *
 * Every run works on a `--local` clone (hardlinked, ~10ms, no checkout), never on
 * the source: the tests write `.codemap/` and detach HEAD, and the named repo is
 * somebody's working tree.
 */

import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";

export const SOURCE_REPO = process.env.CODEMAP_E2E_GIT_REPO ?? join(homedir(), "Desktop", "jellyfin");

/**
 * jellyfin/jellyfin#17463 — "Fix (Un)Played filter correctness and performance".
 *
 * Chosen because it is merged (so `merge-base(master, head) === head`, the collapse
 * `prBaseCommit` exists to defeat), touches five ordinary C# files with no EF
 * migrations among them, and removes exactly one symbol —
 * `IItemQueryHelpers.GetFullyPlayedFolderIdsQuery` — alongside added and changed
 * ones, so one PR covers all three change kinds.
 *
 * The shas are immutable: a merged PR's `baseRefOid`/`headRefOid` never move.
 */
export const FIXTURE_PR = {
  slug: "jellyfin/jellyfin",
  number: 17463,
  /** GitHub's recorded base — NOT the fork point, which is what codemap must derive. */
  recordedBase: "9ff92f3f0df9b3bc89860e505c95edf72fdbdf8b",
  head: "d64e18b69a0a6089aab350f33464f362f09de942",
  /** merge-base(recordedBase, head): the commit the branch actually forked from. */
  forkPoint: "5b550517b2ca64fee0d060f537901a2bc6604a64",
  baseRef: "master",
  removedSymbol: "GetFullyPlayedFolderIdsQuery",
  /** A commit well after the merge — a third, unrelated working-tree state. */
  laterOnBase: "master",
} as const;

const git = (cwd: string, ...a: string[]) => spawnSync("git", a, { cwd, encoding: "utf8" });

/** Why this suite cannot run here, or null when it can. */
export function skipReason(): string | null {
  if (!existsSync(join(SOURCE_REPO, ".git"))) return `no git repo at ${SOURCE_REPO} (set CODEMAP_E2E_GIT_REPO)`;
  for (const sha of [FIXTURE_PR.recordedBase, FIXTURE_PR.head, FIXTURE_PR.forkPoint]) {
    if (git(SOURCE_REPO, "cat-file", "-e", `${sha}^{commit}`).status !== 0) {
      return `${SOURCE_REPO} does not hold ${sha.slice(0, 12)} — fetch jellyfin/jellyfin master`;
    }
  }
  // The PULL REF, which is the actual prerequisite now that resolution is git-only.
  // A clone fetches `refs/pull/N/head` from its origin — this repo — so this repo has
  // to hold it locally. Holding the fixture COMMITS is not the same thing and does not
  // imply it: an ordinary `git fetch` brings branches and tags, never pull refs.
  //
  // A skip rather than a failure, by the same rule as the absent repo: `npm run unit`
  // and `npm run e2e` must not fail because somebody's checkout lacks a prerequisite
  // this project does not own. Found by the suite failing six tests on a checkout whose
  // pull refs had gone and whose remote had been renamed.
  const pullRef = `refs/pull/${FIXTURE_PR.number}/head`;
  if (git(SOURCE_REPO, "rev-parse", "--verify", "--quiet", pullRef).status !== 0) {
    return `${SOURCE_REPO} has no ${pullRef} — a PR is reachable without \`gh\` only through it. `
      + `Restore with: git -C ${SOURCE_REPO} fetch <remote> '+${pullRef}:${pullRef}'`;
  }
  return null;
}

export interface Clone { root: string; cleanup(): void }

/**
 * A throwaway clone with HEAD detached at `at` and a materialised working tree.
 *
 * `--local` hardlinks the object store, so clone + checkout is ~100ms and costs no
 * disk; anything written later goes to the clone's own store, never the source's.
 * The working tree is real because that is the variable under test: a PR's reading
 * must not depend on which commit happens to be checked out beside it.
 */
export function cloneAt(at: string): Clone {
  const root = mkdtempSync(join(tmpdir(), "codemap-e2e-repo-"));
  rmSync(root, { recursive: true, force: true });   // git clone insists on creating it
  const c = spawnSync("git", ["clone", "--quiet", "--local", "--no-checkout", SOURCE_REPO, root], { encoding: "utf8" });
  if (c.status !== 0) throw new Error(`clone failed: ${c.stderr}`);
  const co = git(root, "checkout", "--detach", "--quiet", at);
  if (co.status !== 0) throw new Error(`checkout ${at} failed: ${co.stderr}`);
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}
