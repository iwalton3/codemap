"""Round 9 (ideas/routing-2026-09-15/round9/plan.md §3; owner.md S3, P10, P11): a window with no
commits, or none past the bot filter, is valid. Its pack is written in full -- the prior-records
search or its SKIPPED note included -- and says NO COMMITS IN WINDOW, and MEASURED NOTHING once for
the self-fix instruments and the put-back list."""

import os
import unittest

from _repo import RepoCase

FILES = ("commits.md", "selffix.md", "surface.md", "prior.md", "summary.md")


class EmptyWindow(RepoCase):
    def test_primary_window_still_lists_prior_records(self):
        earlier = os.path.join(self.tmp, "records", "triage-2026-09-01-earlier", "plan.md")
        os.makedirs(os.path.dirname(earlier))
        with open(earlier, "w", encoding="utf-8") as fh:
            fh.write("plan\n")
        self.repo.commit("base", {"app.py": "x = 1\n"})
        pack = self.evidence("--records-undeclared", since="HEAD", until="HEAD")
        self.assertEqual(pack.proc.returncode, 0, pack.proc.stderr)
        self.assertIn(earlier, pack.read("prior.md"))

    def test_skipped_window_writes_every_file_and_says_why(self):
        self.repo.commit("base", {"app.py": "x = 1\n"})
        pack = self.evidence("--skip-prior", since="HEAD", until="HEAD")
        self.assertEqual(pack.proc.returncode, 0, pack.proc.stderr)
        for name in FILES:
            self.assertTrue(os.path.exists(os.path.join(pack.dir, name)), name)
        self.assertIn("SKIPPED", pack.read("prior.md"))
        commits = pack.read("commits.md")
        self.assertIn("NO COMMITS IN WINDOW", commits)
        self.assertIn("the base may be wrong", commits)
        self.assertNotIn("uncommitted", commits + pack.proc.stdout)
        selffix = pack.read("selffix.md")
        self.assertIn("MEASURED NOTHING", selffix)
        self.assertIn("no commits in the window", selffix)
        self.assertNotIn("NO RATE", selffix + pack.proc.stdout)
        self.assertNotIn("None found.", selffix)

    def test_window_of_only_bot_commits_is_empty(self):
        self.repo.commit("base", {"app.py": "x = 1\n"})
        self.repo.git("tag", "base")
        self.repo.commit("Bump foo to v2", {"deps.txt": "foo 2\n"})
        pack = self.evidence("--skip-prior")
        self.assertEqual(pack.proc.returncode, 0, pack.proc.stderr)
        for name in FILES:
            self.assertTrue(os.path.exists(os.path.join(pack.dir, name)), name)
        self.assertIn("1 excluded as bot/noise", pack.read("commits.md"))


if __name__ == "__main__":
    unittest.main()
