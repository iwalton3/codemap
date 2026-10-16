"""Owner ruling (2026-09-18): one assertion about the step files, and deliberately no more.

A pointer into the skill that does not resolve is a hard stop mid-run, and ruling it out
costs nothing. That is the whole of this file.

**Two larger schemes were considered and dropped. Both are recorded because the next round
will think of them again.**

*Declaring every branch in a parseable block*, so the flow could be checked against the
contract's mermaid graph. Measured against real defects it did not earn its churn: none of
the seven misses in the round that prompted it were flow claims, and the number that made
the case turned out to be wrong — last round's nine stale `node 13` references would NOT
have been caught, because they were valid and stale. Node 13 still existed; it just no
longer meant what they said. That is semantic drift, which is the sweep reviewer agent's
job (`CLAUDE.md`).

*Asserting every step file ends by naming what comes next*, which `SKILL.md` already
requires and nothing enforces. It was written, and it passed the one file it was built to
catch: `plan-3-resumed.md` ended on a note about handoff deletion, but a citation of
`steps/plan-2-plan.md` for the coherence check sat near enough the end to read as a jump.
Nothing short of a reserved end-of-file marker distinguishes a citation from an exit, and
that marker means editing five step files to adopt a convention — for one bug already found
by hand. If a second file ever goes silent about its exit, that is the evidence to revisit
it; one is not.

**The standing lesson, which cost two tests to learn:** a check that cannot be observed
failing on the defect it was written for is worse than no check, because it makes the area
look covered. Verify the failure before keeping the test, not after.
"""

import os
import re
import unittest

from _repo import SKILL_DIR

# A path into the skill, with or without the SKILL_DIR prefix the step files use.
POINTER = re.compile(r"(?:SKILL_DIR/)?((?:steps|references|prompts|scripts)/[\w.-]+\.(?:md|py))")


class StepPointers(unittest.TestCase):
    def test_every_pointer_resolves(self):
        missing = []
        for base, dirs, names in os.walk(SKILL_DIR):
            dirs[:] = [d for d in dirs if d != "__pycache__"]
            for name in sorted(names):
                if not name.endswith((".md", ".py")):
                    continue
                path = os.path.join(base, name)
                with open(path, encoding="utf-8") as fh:
                    text = fh.read()
                rel = os.path.relpath(path, SKILL_DIR)
                for target in sorted(set(POINTER.findall(text))):
                    if not os.path.exists(os.path.join(SKILL_DIR, target)):
                        missing.append(f"{rel}: points at {target}, which does not exist")
        self.assertEqual(missing, [], "\n" + "\n".join(missing))


if __name__ == "__main__":
    unittest.main()
