"""`ez-plan` shares its groups with `triage-review` through `references/shared.md`, and cites both of
its contracts by rule ID (ideas/plan-skill-split/README.md). Two checks:

- the `pin-defs` regions in `ez-plan/references/shared.md` match `triage-review`'s sorter prompt, so
  both skills sort into the same categories;
- every rule ID an `ez-plan` file cites is defined in the file it cites, so a renamed or removed
  rule fails here rather than leaving a citation pointing at nothing.
"""

import os
import re
import unittest

from _repo import ROOT, SKILL_DIR

EZ = os.path.join(ROOT, "ez-plan")
SHARED = os.path.join(EZ, "references", "shared.md")
CONTRACT = os.path.join(EZ, "references", "contract.md")
SORTER = os.path.join(SKILL_DIR, "prompts", "sorter.md")

REGION = re.compile(r"<!--pin-defs-->(.*?)<!--/pin-defs-->", re.S)
DEFINED = re.compile(r"^\s*- \*\*([A-Z][0-9]*(?:\.[0-9]+)?)\.", re.M)
# `references/shared.md` K1, `references/contract.md` Z9-Z10. A bare `Z11` in prose is not checked.
CITED = re.compile(r"`references/(shared|contract)\.md`,? ((?:[A-Z][0-9]*(?:-[A-Z]?[0-9]+)?(?:, )?)+)")


def read(path):
    with open(path, encoding="utf-8") as fh:
        return fh.read()


def defined(path):
    return set(DEFINED.findall(read(path)))


def expand(ids):
    out = []
    for part in re.findall(r"[A-Z][0-9]*(?:-[A-Z]?[0-9]+)?", ids):
        m = re.fullmatch(r"([A-Z])([0-9]+)-[A-Z]?([0-9]+)", part)
        if m:
            out += [f"{m.group(1)}{n}" for n in range(int(m.group(2)), int(m.group(3)) + 1)]
        elif part:
            out.append(part)
    return out


class SharedGroupsPinned(unittest.TestCase):
    def test_shared_matches_the_sorter(self):
        self.assertEqual(
            REGION.findall(read(SHARED)), REGION.findall(read(SORTER)),
            "ez-plan/references/shared.md's pin-defs have drifted from triage-review's sorter.md")


class SharedContractIsOneFile(unittest.TestCase):
    def test_both_copies_are_byte_identical(self):
        self.assertEqual(
            read(SHARED), read(os.path.join(SKILL_DIR, "references", "shared.md")),
            "references/shared.md differs between ez-plan and triage-review; it is one file kept "
            "in both skills, so change it in both or neither")


class CitationsResolve(unittest.TestCase):
    def test_every_cited_id_is_defined(self):
        targets = {"shared": defined(SHARED), "contract": defined(CONTRACT)}
        missing = []
        for base, _, names in os.walk(EZ):
            for name in names:
                if not name.endswith(".md"):
                    continue
                path = os.path.join(base, name)
                for which, ids in CITED.findall(read(path)):
                    for rid in expand(ids.strip()):
                        if rid not in targets[which]:
                            missing.append(f"{os.path.relpath(path, ROOT)}: {which}.md {rid}")
        self.assertEqual(missing, [], "cited rule IDs that are not defined:\n  " + "\n  ".join(missing))

    def test_the_check_finds_definitions(self):
        # A regex that matched nothing would pass the check above vacuously.
        self.assertTrue({"U", "G1", "G2", "A", "S1", "S2", "Q1", "K5", "C"} <= defined(SHARED))
        self.assertTrue({f"Z{n}" for n in range(1, 14)} <= defined(CONTRACT))



class PlanningOnlyConversation(unittest.TestCase):
    """Owner, 2026-10-02 (DESIGN.md, `Z9`): a conversation only about planning the work is the
    opening of a Discuss First begun before `/ez-plan` ran. Its record is written once, when the
    skill starts; a later discussion appends to it; it is drafted in the session; the work items
    are listed and checked against the code first where they were not; and a handoff is
    recommended on the work done during planning, not on length. Round
    `2026-10-02-planning-only-rule`."""

    def flat(self, *parts):
        with open(os.path.join(EZ, *parts), encoding="utf-8") as fh:
            return " ".join(fh.read().replace("**", "").split())

    def section(self, text, start, end):
        return text.split(start, 1)[1].split(end, 1)[0]

    def test_contract(self):
        c = self.flat("references", "contract.md")
        for needle in ("A planning-only conversation", "Draft the plan in the current session",
                       "still current and was not refuted by a later turn",
                       "solely about planning this work", "When the skill starts",
                       "the opening of a Discuss First begun before `/ez-plan` ran",
                       "did not both list the work items", "a lot of work happened during planning",
                       "instead of its length", "--resume"):
            self.assertIn(needle, c)
        for gone in ("launch the drafter — except on a planning-only conversation",
                     "does the enumeration first, against the code as it stands",
                     "before drafting or handing off", "neither enumerated",
                     "nothing before planning this work",
                     "on a planning-only conversation, everything still current"):
            self.assertNotIn(gone, c)
        z9 = self.section(c, "- A planning-only conversation", "- Z10.")
        self.assertNotIn("superseded", z9)
        self.assertNotIn("not asked again", z9)
        z7 = self.section(c, "- Z7. How a discussion ends.", "- Z8.")
        self.assertIn("superseded", z7)
        self.assertIn("K3", z7)
        z14 = self.section(c, "- Z14. Settling.", "2. Once the owner picks")
        self.assertIn("the record `Z9` writes", z14)

    def test_input_writes_the_record_before_the_sort(self):
        inp = self.flat("steps", "1-input.md")
        clause = self.section(inp, "On a planning-only conversation", "2. Sort it yourself")
        self.assertIn("write to `RECORD/owner.md`", clause)
        self.assertIn("did not both list the work items", clause)
        for gone in ("code review", "nothing before planning this work", "neither enumerated"):
            self.assertNotIn(gone, clause)

    def test_plan_step_writes_nothing_and_reads_the_record(self):
        plan = self.flat("steps", "3-plan.md")
        self.assertIn("or is a planning-only conversation, whatever its length", plan)
        self.assertNotIn("first write to `RECORD/owner.md`", plan)
        self.assertNotIn("Skip a question only where a discussion clearly", plan)
        self.assertIn("the one before `/ez-plan` ran", plan)

    def test_opening_cites_z7_and_settles_from_the_record(self):
        op = self.flat("steps", "2-opening.md")
        self.assertNotIn("on a planning-only conversation, everything still current", op)
        for row in ("| Plan here |", "| Plan later |"):
            self.assertIn("Z7", op.split(row, 1)[1].split("|", 1)[0])
        first = self.section(op, "## Settle, first pass", "1. On a triage round")
        self.assertIn("on a planning-only conversation", first)

    # DESIGN.md is the canonical skills repo's and is not published with the skills.
    @unittest.skipUnless(os.path.exists(os.path.join(ROOT, "DESIGN.md")), "no DESIGN.md here")
    def test_design_quotes_the_rulings(self):
        with open(os.path.join(ROOT, "DESIGN.md"), encoding="utf-8") as fh:
            d = " ".join(fh.read().replace("**", "").split())
        for needle in ("Once when the skill is started", "a lot of measurements of existing",
                       "contact the idea with reality", "Yes measuring is still planning"):
            self.assertIn(needle, d)
        for gone in ("one write made just before drafting", "still offers Plan Later on length"):
            self.assertNotIn(gone, d)

    def test_shared_k3_untouched(self):
        # Supersession of the start-time record is ez-plan's (Z7), scoped to direct invocations;
        # it must not reach /triage-review through the shared contract.
        self.assertNotIn("before the seal", self.flat("references", "shared.md"))

if __name__ == "__main__":
    unittest.main()
