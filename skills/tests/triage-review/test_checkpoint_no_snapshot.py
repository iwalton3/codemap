"""Revision 2 (round4/triage.md, "Round 5"): "The wip branch and review-inside-diagnose
parts should be dropped." Round 7 (ideas/routing-2026-09-15/round7/owner.md Q5): a tree
with tracked changes is refused, naming the paths, and nothing is tagged. Round 8
(ideas/routing-2026-09-15/round8/plan.md §1, owner.md A3): untracked files are refused too. Round 9
(ideas/routing-2026-09-15/round9/plan.md §2.1, owner.md P19, I1): so is anything unusual plain
`git status` shows on a clean tree, which `--porcelain` prints nothing for."""

import os
import subprocess
import unittest

from _repo import RepoCase, run_script


class CheckpointNoSnapshot(RepoCase):
    def test_tracked_change_is_refused_and_nothing_tagged(self):
        self.repo.commit("base", {"app.py": "x = 1\n", "lib/util.py": "y = 1\n"})
        with open(os.path.join(self.repo.path, "lib", "util.py"), "w", encoding="utf-8") as fh:
            fh.write("y = 2\n")
        proc = run_script("checkpoint.py", "--repo", self.repo.path, "--slug", "t")
        self.assertNotEqual(proc.returncode, 0, proc.stdout)
        self.assertIn("lib/util.py", proc.stderr)
        self.assertEqual(self.repo.git("tag", "--list"), "")

    def test_staged_change_is_refused(self):
        self.repo.commit("base", {"app.py": "x = 1\n"})
        with open(os.path.join(self.repo.path, "new.py"), "w", encoding="utf-8") as fh:
            fh.write("z = 1\n")
        self.repo.git("add", "new.py")
        proc = run_script("checkpoint.py", "--repo", self.repo.path, "--slug", "t")
        self.assertNotEqual(proc.returncode, 0, proc.stdout)
        self.assertIn("new.py", proc.stderr)
        self.assertEqual(self.repo.git("tag", "--list"), "")

    def test_untracked_file_is_refused_and_nothing_tagged(self):
        # An earlier run's uncommitted report is the owner's to decide on at node 2.
        self.repo.commit("base", {"app.py": "x = 1\n"})
        with open(os.path.join(self.repo.path, "POSTMORTEM-2026-09-01-earlier.md"), "w",
                  encoding="utf-8") as fh:
            fh.write("report\n")
        proc = run_script("checkpoint.py", "--repo", self.repo.path, "--slug", "t")
        self.assertNotEqual(proc.returncode, 0, proc.stdout)
        self.assertIn("POSTMORTEM-2026-09-01-earlier.md", proc.stderr)
        self.assertEqual(self.repo.git("tag", "--list"), "")

    def unusual(self, says, *commands):
        """Three commits changing app.py, then each git command, failures allowed: a conflict is
        how most of these states are reached. The fixture checks it reached the state -- plain
        `git status` says `says` on a tree `--porcelain` calls clean -- then runs checkpoint.py."""
        for n in (1, 2, 3):
            self.repo.commit("c%d" % n, {"app.py": "x = %d\n" % n})
        self.branch = self.repo.git("symbolic-ref", "--short", "HEAD")
        env = dict(os.environ, GIT_EDITOR="true", LC_ALL="C",
                   GIT_SEQUENCE_EDITOR="sed -i -e s/^pick/edit/")
        for cmd in commands:
            subprocess.run(["git", "-C", self.repo.path, "-c", "user.name=t", "-c", "user.email=t@t",
                            "-c", "commit.gpgsign=false",
                            *[a.replace("BRANCH", self.branch) for a in cmd]],
                           env=env, capture_output=True, text=True)
        status = subprocess.run(["git", "-C", self.repo.path, "status"], env=env,
                                capture_output=True, text=True).stdout
        self.assertIn(says, status)
        self.assertEqual(self.repo.git("status", "--porcelain", "--untracked-files=normal"), "")
        proc = run_script("checkpoint.py", "--repo", self.repo.path, "--slug", "t")
        self.assertNotEqual(proc.returncode, 0, proc.stdout)
        self.assertIn(self.repo.path, proc.stderr)
        self.assertEqual(self.repo.git("tag", "--list"), "")
        return proc

    def test_detached_head_is_refused_naming_its_sha(self):
        proc = self.unusual("HEAD detached at", ["checkout", "-q", "--detach"])
        found, _, status = proc.stderr.partition("git status says:")
        # The sha is in git status's own output too, so look for it before that.
        self.assertIn(self.repo.git("rev-parse", "--short", "HEAD"), found)
        self.assertIn("HEAD detached at", status)

    def test_bisect_underway_on_a_branch_is_refused(self):
        self.unusual("You are currently bisecting", ["bisect", "start"])

    def test_rebase_stopped_at_edit_is_refused(self):
        self.unusual("interactive rebase in progress", ["rebase", "-i", "HEAD~2"])

    def test_merge_stopped_before_committing_is_refused(self):
        self.unusual("you are still merging", ["checkout", "-q", "-b", "other", "HEAD~1"],
                     ["commit", "-q", "--allow-empty", "-m", "e"], ["checkout", "-q", "BRANCH"],
                     ["merge", "-s", "ours", "--no-commit", "other"])

    def test_am_stopped_is_refused(self):
        patches = os.path.join(self.tmp, "patches")
        self.unusual("You are in the middle of an am session",
                     ["format-patch", "-q", "-2", "-o", patches, "HEAD"],
                     ["reset", "-q", "--hard", "HEAD~2"],
                     ["rm", "-q", "app.py"], ["commit", "-q", "-m", "gone"],
                     ["am", os.path.join(patches, "0001-c2.patch"),
                      os.path.join(patches, "0002-c3.patch")])

    def test_revert_stopped_on_a_branch_is_refused(self):
        # A conflicted revert resolved back to HEAD, not concluded: only REVERT_HEAD says so.
        self.unusual("You are currently reverting", ["revert", "HEAD~1"],
                     ["checkout", "HEAD", "--", "app.py"])

    def test_cherry_pick_stopped_on_a_branch_is_refused(self):
        self.unusual("You are currently cherry-picking",
                     ["checkout", "-q", "-b", "pick", "HEAD~2"],
                     ["commit", "-q", "--allow-empty", "-m", "e"],
                     ["commit", "-q", "-am", "x"],
                     ["cherry-pick", "BRANCH"], ["checkout", "HEAD", "--", "app.py"])

    def test_cherry_pick_range_left_mid_sequence_is_refused(self):
        # The first pick conflicts and is concluded by hand: CHERRY_PICK_HEAD goes, the
        # sequence stays.
        self.unusual("Cherry-pick currently in progress",
                     ["checkout", "-q", "-b", "pick", "HEAD~2"],
                     ["rm", "-q", "app.py"], ["commit", "-q", "-m", "gone"],
                     ["cherry-pick", "BRANCH~1", "BRANCH"],
                     ["rm", "-q", "--cached", "app.py"], ["clean", "-qf"],
                     ["commit", "-q", "--allow-empty", "--no-edit"])

    def test_clean_tree_tags_head_and_no_wip(self):
        # A guard: passes before round 8 too.
        self.repo.commit("base", {"app.py": "x = 1\n"})
        proc = run_script("checkpoint.py", "--repo", self.repo.path, "--slug", "t")
        self.assertEqual(proc.returncode, 0, proc.stderr)
        tags = self.repo.git("tag", "--list").splitlines()
        self.assertEqual(len(tags), 1, tags)
        self.assertFalse(tags[0].endswith("-wip"), tags)
        self.assertEqual(self.repo.git("rev-parse", tags[0]), self.repo.git("rev-parse", "HEAD"))


if __name__ == "__main__":
    unittest.main()
