"""Superseded 2026-09-30: the list form is now the log form (see TheLogForm below). The history:

Ruling (owner, 2026-09-21): "for trivial fixes that are clustered, we just do the questions
for 'fix all or <proposal>' as a list of basic questions, no drafter, still use the coherence
check … this would only happen for a sort that is all group 1 items or refuted, not for
assumption or design change items, for design suggestions those are by definition not defects
so it is probably fine to skip those if both sorts agree?"

**The check this file exists for is reachability.** The first version of this rule triggered on
a round whose items were all *isolated* group-1 defects, and could never fire: those land as
settled fixes before planning and the round stops at "anything left for a plan?" (ez-plan Z4) with nothing left. It shipped and
was reverted the same day. So the trigger is groups 1 and 5, and the rule has to keep naming the
three things that actually reach planning -- defect patterns, "don't fix early" items, and
group-1 items inside the plan's reach -- because a future edit that narrows it back to
"isolated" would be silently dead again rather than wrong in any visible way.

The exclusions are the other half: a group 2 or 3 item, or a group-4 item the sorters disagreed
about, is a proposal someone must make, which is what this path cannot carry.
"""

import os
import unittest

from _repo import ROOT

# ez-plan's Z12 since planning became its own skill; the step file cites it rather than restating.
CONTRACT = os.path.join(ROOT, "ez-plan", "references", "contract.md")


def read(path):
    """Flattened to one line; these files wrap at 100 columns (CLAUDE.md, the sweep rule)."""
    with open(path, encoding="utf-8") as fh:
        # Bold is emphasis, not the rule: a needle pins wording, never markup.
        return " ".join(fh.read().replace("**", "").split())


def says(case, path, name, needle, why):
    case.assertTrue(needle in read(path), f"{name}: {why}\n  missing: {needle!r}")


class TheLogForm(unittest.TestCase):
    """Since the 2026-09-30 ladder redesign the list form is the log form: a plan with no decision
    for the owner is the decision log alone (Z12, Z14). The list form's exclusions and its pattern
    question are superseded — a pattern is settled at its level or put as its fork, and any item
    needing a proposal is a decision for the owner, which takes the round off this path."""

    def test_it_fires_only_when_nothing_is_left_for_the_owner(self):
        says(self, CONTRACT, "ez-plan contract.md Z12", "leaves no decision for the owner",
             "no longer limits the drafterless plan to rounds with no owner decision")

    def test_read_from_the_record(self):
        says(self, CONTRACT, "ez-plan contract.md Z12",
             "read from `decisions.md`, never from the session's own impression",
             "no longer forbids reading the trigger from the session's own impression")

    def test_a_fork_is_never_logged(self):
        says(self, CONTRACT, "ez-plan contract.md Z14", "a level-5 fork, put as the fork",
             "no longer keeps a level-5 fork out of the agent's log")

    def test_the_coherence_check_still_runs(self):
        says(self, CONTRACT, "ez-plan contract.md Z12", "coherence check still runs",
             "no longer keeps the coherence check, which is what replaces the drafter")

    def test_the_goal_is_still_asked(self):
        says(self, CONTRACT, "ez-plan contract.md Z12", "the goal is still asked",
             "no longer keeps the owner's goal question on a short plan")


if __name__ == "__main__":
    unittest.main()
