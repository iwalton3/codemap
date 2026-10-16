"""Ruling (conversation 2026-09-21, from the `mpv-shim-todo` round): fixes on fixes is a
relation with two ends -- this round's findings landing in an earlier round's fixes -- and
`contract.md` R1 used to check only the second.

Both ends failed once on the same round. `~/bookmarks/scripts/jellyfin-mpv-shim`,
`.git/triage/2026-09-20-mpv-shim-todo/sort.md`: sixteen GitHub issues were run as findings,
which is new work against existing code and not the second turn of any loop; and blame on I1's
line reached `565dd6d4`, whose message says "Both reported in the hand pass" and so trips the
trailer test, while its diff only *moved* the statement into `_apply_resume_offset`. The
session overturned that by hand, at the cost of reading the diff.

Two checks here. The prose one pins that both ends are stated, in the contract and in the step
that runs them. The git one pins the mechanism the step now leans on: `git blame -M` attributes
a relocated line to the commit that wrote it, not to the one that carried it across. If that
claim is false the instruction is wrong, so it is checked rather than asserted.

This says nothing about whether a round is classified correctly -- only that neither end can
quietly go missing.
"""

import os
import unittest

from _repo import SKILL_DIR, RepoCase

CONTRACT = os.path.join(SKILL_DIR, "references", "contract.md")
BLAME = os.path.join(SKILL_DIR, "steps", "1-blame.md")


def read(path):
    """Flattened to one line. These files wrap at 100 columns, so a rule stated across a
    line break is invisible to any needle written as one (CLAUDE.md, the sweep rule)."""
    with open(path, encoding="utf-8") as fh:
        # Bold is emphasis, not the rule: a needle pins wording, never markup.
        return " ".join(fh.read().replace("**", "").split())


def says(case, path, name, needle, why):
    # assertIn on a whole file prints the whole file. Say what is missing instead.
    case.assertTrue(needle in read(path), f"{name}: {why}\n  missing: {needle!r}")


class BothEndsStated(unittest.TestCase):
    def test_contract_states_two_ends(self):
        says(self, CONTRACT, "contract.md R1", "two ends",
             "no longer says fixes on fixes has two ends")
        says(self, CONTRACT, "contract.md R1", "not fixes on fixes whatever blame reaches",
             "no longer exempts findings that are new work")

    def test_contract_states_the_relocation_rule(self):
        says(self, CONTRACT, "contract.md R1",
             "wrote those lines rather than only moving them",
             "no longer requires the blamed commit to have written the lines")

    def test_step_runs_both_ends(self):
        says(self, BLAME, "1-blame.md", "new work against existing code",
             "no longer checks where the findings came from")
        says(self, BLAME, "1-blame.md", "Blame with `-M -C -w`",
             "no longer tells blame to follow moved lines")

    def test_record_is_never_a_fix(self):
        for path, name in ((CONTRACT, "contract.md"), (BLAME, "1-blame.md")):
            says(self, path, name, "anything under a run's `RECORD`",
                 "no longer exempts the run's own record from fixes on fixes")


class MovedLineIsNotAuthorship(RepoCase):
    """The `565dd6d4` shape: one commit writes the line, a later one relocates it."""

    # Three lines, so the block clears `git blame -M`'s similarity floor, and moved below
    # unrelated code so the diff cannot render the change as an insertion.
    BLOCK = ["    if offset is not None:",
             "        player.playback_time = offset",
             "        player.pause = False"]

    def setUp(self):
        super().setUp()
        self.wrote = self.repo.commit("the defect arrives", {"player.py": "\n".join(
            ["def start():", "    setup()", *self.BLOCK, "    finish()", "",
             "def unrelated():", "    return 1", ""])})
        self.moved = self.repo.commit(
            "Two segment bugs\n\nBoth reported in the hand pass.\n\nReview-round: r1",
            {"player.py": "\n".join(
                ["def start():", "    setup()", "    finish()", "",
                 "def unrelated():", "    return 1", "",
                 "def _apply_resume_offset():", *self.BLOCK, ""])})

    def line_of(self, *flags):
        out = self.repo.git("blame", *flags, "-L", "/playback_time/,+1", "--", "player.py")
        return out.split(" ", 1)[0].lstrip("^")

    def test_plain_blame_names_the_relocation(self):
        # Why the rule was needed: without -M the mover is indistinguishable from the author.
        self.assertTrue(self.moved.startswith(self.line_of()),
                        "plain blame no longer reaches the relocating commit")

    def test_dash_m_reaches_the_commit_that_wrote_it(self):
        self.assertTrue(self.wrote.startswith(self.line_of("-M", "-C", "-w")),
                        "git blame -M no longer follows the line back past its relocation")

    def test_the_relocation_is_visible_in_the_diff(self):
        # The confirmation the step asks for by hand: `+` at one place, `-` at another.
        diff = self.repo.git("show", self.moved, "--", "player.py")
        body = [l for l in diff.splitlines() if "playback_time" in l]
        self.assertIn("+", [l[0] for l in body])
        self.assertIn("-", [l[0] for l in body])


if __name__ == "__main__":
    unittest.main()
