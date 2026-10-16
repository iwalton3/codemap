"""Rulings (plan.md §0): the test-name patterns go, and so do the test churn totals.
The session running the skill names where the tests live, and whether a test is
worth anything is a reading of its content, not a line count."""

import unittest

from _repo import RepoCase


class NoTestGuessing(RepoCase):
    def test_pack_neither_counts_nor_classifies_tests(self):
        self.repo.commit("base", {"src/app.py": "x = 1\n",
                                  "src/BackTest.php": "<?php // production\n",
                                  "tests/test_app.py": "assert True\n"})
        self.repo.git("tag", "base")
        self.repo.commit("change", {"src/app.py": "x = 2\n",
                                    "src/BackTest.php": "<?php // production, changed\n",
                                    "tests/test_app.py": "assert 1\n"})
        pack = self.evidence()
        self.assertEqual(pack.proc.returncode, 0, pack.proc.stderr)
        surface = pack.read("surface.md")
        for text in (surface, pack.proc.stdout):
            self.assertNotIn("NO RECOGNIZED TEST PATHS", text)
        self.assertNotIn("| tests |", surface)
        self.assertNotIn("| production code |", surface)

    def test_test_flag_is_refused_rather_than_ignored(self):
        self.repo.commit("base", {"src/app.py": "x = 1\n"})
        self.repo.git("tag", "base")
        self.repo.commit("change", {"src/app.py": "x = 2\n"})
        pack = self.evidence("--test", "tests")
        self.assertEqual(pack.proc.returncode, 2)


if __name__ == "__main__":
    unittest.main()
