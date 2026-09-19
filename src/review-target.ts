/**
 * What a review is OF: a pull request, or a branch whose pull request does not exist yet.
 *
 * A finding's key is `"<n>"` for pull request n, as it always was, or `"branch:<name>"` for
 * a branch. The key is what the local `findings.pr` column holds and what every
 * finding verb passes around, so one function turns it into a sidecar scope for all of
 * them.
 *
 * A branch scope is a HASH of the branch name, not the name: `docs/review-target-identity.md`
 * measured names escaping to paths past the 255-byte limit, and case-insensitive
 * filesystems would merge two branches. The name travels on the finding's `created`
 * event instead. There are no generations (owner, 2026-09-18): a branch name is one review
 * for ever, which is what lets the scope be derived rather than minted — two people opening
 * a review of one branch land in one scope with no registry to agree on it.
 */
import { createHash } from "node:crypto";
import { scopeFor, type SidecarConfig } from "./sidecar-config.js";
import { revParse } from "./git.js";

const BRANCH = "branch:";

export const branchKey = (name: string): string => BRANCH + name;

/** Malformed as a branch-review name: revision syntax, `HEAD`, or a full sha. */
const notABranchName = (name: string): boolean =>
  !name.trim() || /[\s~^:?*[\\]|@\{/.test(name) || name === "HEAD" || /^[0-9a-f]{40}$/.test(name);

/**
 * The one spelling of a branch a review is keyed by, or why the input is not a branch.
 *
 * The scope is a hash of the name, so every spelling of one branch has to arrive here as
 * the same string or the review splits (owner, triage 2026-09-19-branch-review-round Q3):
 * `refs/heads/x` and `origin/x` both mean `x`; any other remote is refused, because a
 * fork's same-named branch is somebody else's code. A local branch spelled exactly as
 * given wins over stripping, so a branch literally named `origin/…` is never misread.
 * Existence is NOT required: a merged branch is deleted, and its findings are still read.
 */
export function normalizeBranch(root: string, raw: string): { name: string } | { error: string } {
  let name = String(raw ?? "").trim().replace(/^refs\/heads\//, "");
  if (!name) return { error: "which branch?" };
  if (!revParse(root, `refs/heads/${name}`)) {
    const remote = /^(?:refs\/remotes\/)?([^/]+)\/(.+)$/.exec(name);
    if (remote && revParse(root, `refs/remotes/${remote[1]}/${remote[2]}`)) {
      if (remote[1] !== "origin") return { error: `"${raw}" is a branch of the remote "${remote[1]}" — only origin's branches are reviewed here, by their name without the remote` };
      name = remote[2]!;
    }
  }
  if (notABranchName(name)) return { error: `"${raw}" is not a branch name — pass the branch name (e.g. feature/x), not a revision` };
  return { name };
}

/** `branch:<normalized name>`, for a front end's `branch` argument. Throws, as `findingKeyScope` does. */
export function branchKeyFor(root: string, raw: string): string {
  const n = normalizeBranch(root, raw);
  if ("error" in n) throw new Error(n.error);
  return branchKey(n.name);
}

/** The local store's half of `findingKeyScope`'s check, so a key the sidecar would refuse is never stored. */
export function assertFindingKey(key: string): void {
  const b = branchOf(key);
  if (b !== null && notABranchName(b)) throw new Error(`"${b}" is not a branch name`);
}
export const isBranchKey = (key: string): boolean => key.startsWith(BRANCH);
export const branchOf = (key: string): string | null => (isBranchKey(key) ? key.slice(BRANCH.length) : null);

/** The scope a finding key lives in: `<universe>/pr-<n>` or `<universe>/b-<hex>`. */
export function findingKeyScope(cfg: SidecarConfig, key: number | string): string {
  const k = String(key).trim().replace(/^#/, "");
  const branch = branchOf(k);
  if (branch !== null) {
    if (notABranchName(branch)) {
      throw new Error(`"${branch}" is not a branch name`);
    }
    const hex = createHash("sha256").update(`${cfg.universe}\0branch\0${branch}`).digest("hex").slice(0, 40);
    return scopeFor(cfg, "b", hex);
  }
  // VALIDATED, because the scope IS the association: an unnormalized key makes two
  // scopes for one pull request, and every reader then sees half the findings.
  // `pr_walkthrough` advertises "number, url, or owner/repo#N", so a url arriving here is
  // not far-fetched — it would scope to `pr-https://…` while the same person's `5` scoped
  // to `pr-5`. A slash in the key would also let `prOfScope` pick the wrong tail back out.
  // Throws: both front ends surface the message, and this is malformed input, not a state.
  if (!/^\d+$/.test(k)) {
    throw new Error(
      `"${key}" is not a pull request number or a branch — findings scope by number (pass 5, not a url or owner/repo#5), or by \`branch:<name>\``,
    );
  }
  return scopeFor(cfg, "pr", k);
}
