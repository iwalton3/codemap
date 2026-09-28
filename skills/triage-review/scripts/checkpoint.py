#!/usr/bin/env python3
"""Make the current state recoverable before a triage runs.

Reverting has to be a live recommendation, and it is only live if the state can
be got back. It runs after the skill has committed the work in flight. A tree with
any change -- tracked, staged or untracked -- is refused: nothing is tagged, the
paths are named, and the exit is non-zero, because a tag on `HEAD` would not hold
that state. So is anything unusual plain `git status` shows (references/shared.md
U): a detached `HEAD`, or a merge, rebase, `am`, cherry-pick, revert or
bisect underway -- named, with plain `git status`'s own words. Nothing here moves,
resets, cleans or stages anything: `HEAD` gets a tag. One repository per
invocation; the skill runs it per member.
"""

import argparse
import os
import subprocess
import sys
import time


def git(repo, *args, check=True):
    p = subprocess.run(
        ["git", "-C", repo, *args],
        capture_output=True, text=True, encoding="utf-8", errors="replace",
    )
    if check and p.returncode != 0:
        sys.exit("git %s failed: %s" % (" ".join(args), p.stderr.strip()))
    return p.stdout.rstrip()


# What plain `git status` reads to say an operation is underway. `--porcelain` prints none of
# these on a clean tree, and plain `git status` is translated and for people, so the files are
# checked instead. This list can lag behind `git status`: a new "in progress" line there belongs
# here too.
UNDERWAY = (
    ("MERGE_HEAD", "a merge is underway"),
    ("rebase-merge", "a rebase is underway"),   # detaches HEAD too
    ("rebase-apply", "a rebase or `git am` is underway"),
    ("CHERRY_PICK_HEAD", "a cherry-pick is underway"),
    ("REVERT_HEAD", "a revert is underway"),
    ("sequencer", "a cherry-pick or revert sequence is underway"),
    ("BISECT_LOG", "a bisect is underway"),
)


def unusual(repo):
    """What would stop a reasonable person committing more work here, beyond changed files."""
    found = []
    if subprocess.run(["git", "-C", repo, "symbolic-ref", "-q", "HEAD"],
                      capture_output=True).returncode != 0:
        found.append("HEAD is detached at %s" % git(repo, "rev-parse", "--short", "HEAD"))
    for name, what in UNDERWAY:
        # --git-path: per worktree, so a linked worktree's merge is not the main one's.
        path = git(repo, "rev-parse", "--git-path", name)
        if os.path.exists(os.path.join(repo, path)):
            found.append("%s (%s)" % (what, name))
    return found


def main(argv=None):
    ap = argparse.ArgumentParser()
    ap.add_argument("--repo", default=".")
    ap.add_argument("--slug", default="", help="appended to the tag name")
    args = ap.parse_args(argv)

    repo = os.path.abspath(args.repo)
    if git(repo, "rev-parse", "--is-inside-work-tree", check=False) != "true":
        hint = ""
        if git(repo, "rev-parse", "--is-bare-repository", check=False).strip() == "true":
            wt = [l.split()[0] for l in
                  git(repo, "worktree", "list", check=False).splitlines()
                  if "(bare)" not in l]
            hint = ("\nThis is a BARE repository. Point --repo at a worktree"
                    + (": " + ", ".join(wt) if wt else
                       "; `git worktree list` shows none, so add one first."))
        sys.exit("no work tree at %s%s" % (repo, hint))

    odd = unusual(repo)
    if odd:
        sys.exit("unusual state at %s, nothing tagged:\n%s\n\ngit status says:\n%s"
                 % (repo, "\n".join("    " + l for l in odd),
                    "\n".join("    " + l for l in git(repo, "status").splitlines())))
    dirty = git(repo, "status", "--porcelain", "--untracked-files=normal")
    if dirty:
        sys.exit("changes at %s, nothing tagged:\n%s"
                 % (repo, "\n".join("    " + l for l in dirty.splitlines())))

    stamp = time.strftime("%Y%m%d-%H%M%S", time.gmtime())
    slug = ("-" + args.slug) if args.slug else ""
    base = "diagnose/%s%s" % (stamp, slug)

    head = git(repo, "rev-parse", "HEAD")
    branch = git(repo, "rev-parse", "--abbrev-ref", "HEAD")

    git(repo, "tag", base, head)
    print("checkpoint tag : %s -> %s (%s)" % (base, head[:12], branch))

    print()
    print("to get back here:")
    print("    git -C %s checkout %s" % (repo, base))
    print("to drop the checkpoint later:")
    print("    git -C %s tag -d %s" % (repo, base))
    return 0


if __name__ == "__main__":
    sys.exit(main())
