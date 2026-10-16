"""Ruling (owner, 2026-09-21): "if an alternative destination for /triage-review, mentioned by
name, is specified in CLAUDE.md, use that instead of $(git rev-parse --git-common-dir)/triage/",
and "if it is in the working tree it gets committed after each step. If it is gitignored it
doesn't."

From a field note: a session isolated to a worktree was refused twice when it tried to
write the record under the main checkout's git directory.

The commit rule is what keeps the override from breaking two guards the skill runs on itself --
*The tree* at step 1, and the diagnosis checkpoint, which stops on any porcelain output. Committed
or ignored, both leave the tree clean at every step boundary. What committing then breaks instead
is D6's resume comparison, since HEAD moves under the run; the tag now stands on ancestry *and*
every changed path being under RECORD. Ancestry alone would admit another session's work, so the
git check below pins both halves.

The lens boundary is the third thing the override touches, and the one that was nearly missed: the
reader was told the record is out of bounds because it sits under `.git/`, which stops being true
the moment a record lives in the working tree.
"""

import os
import unittest

from _repo import SKILL_DIR, RepoCase

CONTRACT = os.path.join(SKILL_DIR, "references", "contract.md")
DIAGNOSE = os.path.join(SKILL_DIR, "references", "diagnose.md")
# The record rules shared with ez-plan (K1, K2, K5) live here since the split.
SHARED = os.path.join(SKILL_DIR, "references", "shared.md")
SKILL = os.path.join(SKILL_DIR, "SKILL.md")
BLAME = os.path.join(SKILL_DIR, "steps", "1-blame.md")
CHECKPOINT = os.path.join(SKILL_DIR, "steps", "diagnose-1-checkpoint.md")
LENS = os.path.join(SKILL_DIR, "prompts", "lens.md")
LENS_STEP = os.path.join(SKILL_DIR, "steps", "diagnose-4-lens-readers.md")


def read(path):
    """Flattened to one line; these files wrap at 100 columns (CLAUDE.md, the sweep rule)."""
    with open(path, encoding="utf-8") as fh:
        # Bold is emphasis, not the rule: a needle pins wording, never markup.
        return " ".join(fh.read().replace("**", "").split())


def says(case, path, name, needle, why):
    case.assertTrue(needle in read(path), f"{name}: {why}\n  missing: {needle!r}")


class TheOverrideIsStated(unittest.TestCase):
    def test_contract_and_skill_carry_it(self):
        says(self, SHARED, "shared.md K1", "destination for a skill by name",
             "no longer lets a CLAUDE.md move the record")
        for path, name in ((SKILL, "SKILL.md"), (BLAME, "1-blame.md")):
            says(self, path, name, "destination for this skill by name",
                 "no longer lets a CLAUDE.md move the record")

    def test_the_relative_path_has_a_base(self):
        says(self, SHARED, "shared.md K1", "relative to the primary's working tree root",
             "no longer says what a relative destination is relative to")

    def test_the_report_does_not_move(self):
        says(self, CONTRACT, "contract.md", "override does not move it",
             "no longer keeps the report in the primary's working tree")

    def test_prior_records_follow_it(self):
        says(self, SHARED, "shared.md K5", "every directory a `CLAUDE.md` names for either skill",
             "no longer follows the override, so a later round would see no history")


class TheCommitRule(unittest.TestCase):
    def test_the_discriminator_is_mechanical(self):
        for path, name in ((SHARED, "shared.md K2"), (BLAME, "1-blame.md")):
            says(self, path, name, "git check-ignore -q <RECORD>",
                 "no longer decides committed-or-not by asking git")

    def test_each_step_commits_before_it_ends(self):
        says(self, SHARED, "shared.md K2",
             "each step commits what it wrote before it ends",
             "no longer commits the record as it is written")
        says(self, BLAME, "1-blame.md",
             "every step commits what it wrote to it before that step ends",
             "no longer commits the record as it is written")


class TheLensBoundary(unittest.TestCase):
    def test_out_of_bounds_by_what_it_is(self):
        says(self, LENS, "prompts/lens.md",
             "out of bounds for what it holds and not for where it happens to be",
             "still excludes the record by its path, which an in-tree record escapes")

    def test_the_launch_names_the_record(self):
        says(self, LENS_STEP, "diagnose-4-lens-readers.md",
             "out of bounds whether or not it is committed: `RECORD`",
             "no longer tells the lens reader which directory to stay out of")


class TheResumeComparison(unittest.TestCase):
    def test_both_halves_are_stated(self):
        for path, name in ((DIAGNOSE, "diagnose.md D6"),
                           (CHECKPOINT, "diagnose-1-checkpoint.md")):
            says(self, path, name,
                 "every path in `git diff --name-only <tag>..HEAD` is under `RECORD`",
                 "no longer bounds what a moved HEAD may contain")
        says(self, DIAGNOSE, "diagnose.md D6", "Both halves of the second case are checked",
             "no longer requires both ancestry and the RECORD-only paths")


class AncestryAdmitsOnlyTheRecord(RepoCase):
    """The rule as the checkpoint runs it, on the two cases it has to separate."""

    def setUp(self):
        super().setUp()
        self.repo.commit("base", {"app.py": "x = 1\n"})
        self.repo.git("tag", "diagnose/t")

    def moved_paths(self):
        out = self.repo.git("diff", "--name-only", "diagnose/t..HEAD")
        return [p for p in out.splitlines() if p]

    def tag_is_ancestor(self):
        return self.repo.git("merge-base", "diagnose/t", "HEAD") == \
            self.repo.git("rev-parse", "diagnose/t")

    def test_a_record_only_commit_keeps_the_tag(self):
        self.repo.commit("round record", {".triage/2026-09-21-r/sort.md": "s\n"})
        self.assertTrue(self.tag_is_ancestor())
        self.assertTrue(all(p.startswith(".triage/") for p in self.moved_paths()),
                        f"expected only record paths, got {self.moved_paths()}")

    def test_work_committed_under_the_run_does_not(self):
        self.repo.commit("record and a fix", {".triage/2026-09-21-r/sort.md": "s\n",
                                              "app.py": "x = 2\n"})
        self.assertTrue(self.tag_is_ancestor(), "ancestry alone cannot tell these apart")
        self.assertFalse(all(p.startswith(".triage/") for p in self.moved_paths()),
                         "the path half is what rejects a commit carrying real work")


if __name__ == "__main__":
    unittest.main()


class TheRecordSkillsFollowIt(unittest.TestCase):
    """Run 2026-10-02-release-stack-and-auth-sweep, I6 (F6): discover-rules and reconsolidate wrote
    to a literal `.git/` path, which in a linked worktree is a file, and read no record a
    `CLAUDE.md` had moved."""
    ROOT = os.path.dirname(SKILL_DIR)
    SKILLS = ("discover-rules", "reconsolidate")

    def test_no_literal_git_path(self):
        import re
        for s in self.SKILLS:
            text = read(os.path.join(self.ROOT, s, "SKILL.md"))
            self.assertEqual(re.findall(r"\.git/\w", text), [], f"{s} names a literal .git/ path")

    def test_common_dir_and_override(self):
        for s in self.SKILLS:
            path = os.path.join(self.ROOT, s, "SKILL.md")
            says(self, path, s, "git rev-parse --git-common-dir", "no longer resolves the common dir")
            says(self, path, s, f"names a destination for `/{s}` by name",
                 "no longer lets a CLAUDE.md move its run record")
            says(self, path, s, "names for `/triage-review` or `/ez-plan`",
                 "no longer reads planning records a CLAUDE.md moved")
