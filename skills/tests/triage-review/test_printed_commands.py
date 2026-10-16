"""Commands the evidence pack prints for a reader to run. Round 9
(ideas/routing-2026-09-15/round9/plan.md §1): they name the repository, because the reader may
start in another member of the unit; and they run where its path holds a space."""

import os
import subprocess
import unittest

from _repo import Repo, RepoCase

RULES = "".join("rule %d: X must Y%d\n" % (i, i) for i in range(1, 11))


class PrintedCommands(RepoCase):
    def setUp(self):
        super().setUp()
        self.repo = Repo(os.path.join(self.tmp, "my repo"))

    def run_printed(self, line):
        command = line.split("`")[1]
        proc = subprocess.run(command, shell=True, cwd=self.tmp, capture_output=True, text=True)
        self.assertEqual(proc.returncode, 0, proc.stderr)
        return proc.stdout

    def test_past_the_spec_row_cap(self):
        self.repo.commit("base", {"spec/rules.md": RULES})
        self.repo.git("tag", "base")
        for n in range(41):
            self.repo.commit("rule %d" % n, {"spec/rules.md": RULES + "rule 11: v%d\n" % n})
        pack = self.evidence("--spec", "spec")
        self.assertEqual(pack.proc.returncode, 0, pack.proc.stderr)
        more = [l for l in pack.read("surface.md").splitlines() if "more:" in l]
        self.assertEqual(len(more), 1, more)
        self.assertIn("rule 11: v40", self.run_printed(more[0]))

    def test_measured_nothing_check_by_hand(self):
        self.repo.commit("base", {"src/app.py": "x = 1\n"})
        self.repo.git("tag", "base")
        added = self.repo.commit("add only", {"src/more.py": "y = 1\n"})
        pack = self.evidence()
        self.assertEqual(pack.proc.returncode, 0, pack.proc.stderr)
        lines = pack.read("selffix.md").splitlines()
        check = next(l for l in lines if "log --numstat" in l)
        self.assertIn(added, self.run_printed("`%s`" % check.strip()))


if __name__ == "__main__":
    unittest.main()
