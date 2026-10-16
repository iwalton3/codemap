"""Ruling (plan.md §3.12, owner.md Q8): `shared.md` (formerly `contract.md`) and `prompts/sorter.md`
both keep a copy of the group definitions, and the four owner-verbatim ones are pinned to each other.

The point of the pin, in the owner's words, is "to force the sort to use the same finding
categories as in the contract and not let the prose drift". It is not a guard on its own
scope: two regions expanded identically in both files would still be doing its job.

The pin is scoped to what the two files already say identically. Everything around it —
the group-1 exclusions, the defect-pattern rule, and the *assumed* and *out of scope*
entries — is written differently in each and stays unpinned, because converging it would
mean rewriting north-star prose no finding asked about.

This asserts nothing about whether the definitions are right: only that the two copies
have not drifted.
"""

import os
import re
import unittest

from _repo import SKILL_DIR

REGION = re.compile(r"<!--pin-defs-->(.*?)<!--/pin-defs-->", re.S)

# The groups moved to the shared contract when planning became ez-plan (references/shared.md).
CONTRACT = os.path.join(SKILL_DIR, "references", "shared.md")
SORTER = os.path.join(SKILL_DIR, "prompts", "sorter.md")

# The owner's own words. A region emptied or its markers moved past them still fails.
OWNER_WORDS = [
    "We know what we're doing, we know where and why it's wrong, there is\n   one correct, "
    "obvious, and isolated way fix it.",
    "We designed something. It causes a problem downstream. A proposal is\n   needed.",
    "Past code made an assumption documented nowhere. The assumption either broke\n   "
    "or doesn't hold up elsewhere. A proposal is needed.",
    "The design is questionable and might deserve a change.",
]


def regions(path):
    with open(path, encoding="utf-8") as fh:
        return REGION.findall(fh.read())


class GroupDefinitionsPinned(unittest.TestCase):
    def test_both_files_exist(self):
        for path in (CONTRACT, SORTER):
            self.assertTrue(os.path.exists(path), "missing: %s" % path)

    def test_the_two_copies_are_byte_identical(self):
        self.assertEqual(
            regions(CONTRACT), regions(SORTER),
            "the pinned definitions in references/shared.md and prompts/sorter.md have "
            "drifted; they are one block kept in two files")

    def test_the_pin_is_not_empty(self):
        for path in (CONTRACT, SORTER):
            found = regions(path)
            self.assertEqual(len(found), 2, "expected two pin-defs regions in %s" % path)
            pinned = "".join(found)
            for words in OWNER_WORDS:
                self.assertIn(words, pinned,
                              "%s: the owner's words fell outside the pin" % path)


if __name__ == "__main__":
    unittest.main()
