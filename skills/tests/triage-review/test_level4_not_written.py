"""Run 2026-10-02-release-stack-and-auth-sweep, I8 (F8): /discover-rules wrote an item the owner
placed at level 4 into docs/rules/ in the agent's candidate text. The owner, 2026-09-29: "I didn't
want to escalate arbitrary agent text as a ruling only as a decision that was approved". It is
listed for /reconsolidate instead, which writes a business rule only in the owner's words."""

import os
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))


def read(rel):
    with open(os.path.join(ROOT, rel), encoding="utf-8") as fh:
        return " ".join(fh.read().replace("**", "").split())


class LevelFourNotWritten(unittest.TestCase):
    def test_discover_rules_holds_it_back(self):
        text = read("discover-rules/SKILL.md")
        self.assertIn("except an item the owner placed at level 4, which is not written", text)
        self.assertIn("run record's For `/reconsolidate` list", text)

    def test_reconsolidate_picks_it_up(self):
        self.assertIn("the For `/reconsolidate` list in each `/discover-rules` run record",
                      read("reconsolidate/SKILL.md"))


if __name__ == "__main__":
    unittest.main()
