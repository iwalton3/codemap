"""Plan 2026-09-22-decision-rounds, I1 (owner, batch 1: "All others are fine"): step 5 derives a
check and watches it fail first, and then recorded only a line and a commit, so the reproducer was
gone by the time anyone could re-run it. The fields match `PROPOSAL-close-evidence.md` §5's
`falsified: {command, without_fix, with_fix}` in codemap, which a verifier re-runs.

S2 is the rule and step 5 applies it; both are pinned because a step that drops the fields while
S2 keeps them is exactly the drift this repository's sweep rule exists for.
"""

import os
import unittest

from _repo import ROOT

STEP5 = os.path.join(ROOT, "triage-review", "steps", "5-land-and-hand-over.md")
SHARED = [os.path.join(ROOT, s, "references", "shared.md") for s in ("triage-review", "ez-plan")]


def read(path):
    """Flattened to one line; these files wrap at 100 columns (CLAUDE.md, the sweep rule)."""
    with open(path, encoding="utf-8") as fh:
        return " ".join(fh.read().replace("**", "").split())


def says(case, path, name, needle, why):
    case.assertTrue(needle in read(path), f"{name}: {why}\n  missing: {needle!r}")


class WhatLandedKeepsTheCheck(unittest.TestCase):
    def test_s2_names_the_fields(self):
        for path in SHARED:
            says(self, path, "shared.md S2", "the command that fails without the fix",
                 "no longer records the check's command")
            says(self, path, "shared.md S2",
                 "what it did without the fix and what it does with it",
                 "no longer records the check's result both ways")
            says(self, path, "shared.md S2", "`no check: <why>`",
                 "no longer makes a missing check say why")

    def test_step5_applies_it(self):
        says(self, STEP5, "5-land-and-hand-over.md", "the command that fails without the fix",
             "no longer records the check's command")
        says(self, STEP5, "5-land-and-hand-over.md", "`no check: <why>`",
             "no longer makes a missing check say why")


if __name__ == "__main__":
    unittest.main()
