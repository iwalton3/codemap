"""Rulings (plan.md §0, second to fourth exchanges): the work is named by a reference
and the session finds its repositories; the scripts stay one repository per run.
`--related-repo` and its parent-folder session search go."""

import unittest

from _repo import RepoCase


class OneRepositoryPerRun(RepoCase):
    def test_related_repo_flag_is_refused(self):
        self.repo.commit("base", {"app.py": "x = 1\n"})
        self.repo.git("tag", "base")
        self.repo.commit("change", {"app.py": "x = 2\n"})
        pack = self.evidence("--related-repo", self.tmp)
        self.assertEqual(pack.proc.returncode, 2)


if __name__ == "__main__":
    unittest.main()
