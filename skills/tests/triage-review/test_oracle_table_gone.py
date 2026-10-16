"""Ruling O1 (plan.md §0): the oracle table goes. It was dismissed in every field
report that mentioned it, and on jf-offline it marked the one oracle that mattered
as the only *cited* row."""

import unittest

from _repo import RepoCase


class OracleTableGone(RepoCase):
    def test_no_oracle_table_and_no_summary_line(self):
        self.repo.commit("base", {"CLAUDE.md": "Probe first: tools/probe.py\n",
                                  "tools/probe.py": "print('probe')\n",
                                  "app.py": "x = 1\n"})
        self.repo.git("tag", "base")
        self.repo.commit("change", {"app.py": "x = 2\n"})
        pack = self.evidence()
        self.assertEqual(pack.proc.returncode, 0, pack.proc.stderr)
        self.assertEqual(pack.read("oracles.md"), "")
        self.assertNotIn("oracles", pack.proc.stdout)


if __name__ == "__main__":
    unittest.main()
