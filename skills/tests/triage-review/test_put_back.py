"""Ruling (plan.md §0, question picker): "Files being changes and reverted is a strong
sign of churn, worth surfacing in a way that doesn't overload/distract the agents."
One short list: lines one commit removed and a later, different commit put back."""

import unittest

from _repo import RepoCase

RULE = "    if unit not in VOLUME_UNITS: return reject(unit)\n"


class PutBack(RepoCase):
    def selffix(self):
        pack = self.evidence()
        self.assertEqual(pack.proc.returncode, 0, pack.proc.stderr)
        return pack.read("selffix.md"), pack.proc.stdout

    def test_line_removed_then_put_back_is_listed(self):
        self.repo.commit("base", {"src/rules.py": "def check(unit):\n" + RULE + "    return ok()\n"})
        self.repo.git("tag", "base")
        out = self.repo.commit("only when changed", {"src/rules.py":
                               "def check(unit):\n    if changed(unit): return reject(unit)\n    return ok()\n"})
        back = self.repo.commit("unconditionally", {"src/rules.py": "def check(unit):\n" + RULE + "    return ok()\n"})
        selffix, stdout = self.selffix()
        row = next((l for l in selffix.splitlines() if "src/rules.py" in l), "")
        self.assertIn(out[:12], row, selffix)
        self.assertIn(back[:12], row)
        self.assertIn("put back", stdout)

    def test_one_of_two_identical_lines_put_back_is_listed(self):
        body = "def a():\n    assert status == 400, 'rejected payload'\n\ndef b():\n    assert status == 400, 'rejected payload'\n"
        self.repo.commit("base", {"tests/test_rules.py": body})
        self.repo.git("tag", "base")
        out = self.repo.commit("loosen", {"tests/test_rules.py": body.replace(
            "def b():\n    assert status == 400, 'rejected payload'", "def b():\n    assert status == 200, 'accepted'")})
        back = self.repo.commit("tighten", {"tests/test_rules.py": body})
        selffix, _ = self.selffix()
        row = next((l for l in selffix.splitlines() if "tests/test_rules.py" in l), "")
        self.assertIn(out[:12], row, selffix)
        self.assertIn(back[:12], row)

    def test_line_moved_inside_one_commit_is_not_listed(self):
        self.repo.commit("base", {"src/rules.py": "def check(unit):\n" + RULE + "    return ok()\n"})
        self.repo.git("tag", "base")
        self.repo.commit("move", {"src/rules.py": "def check(unit):\n    return ok()\n" + RULE})
        self.repo.commit("other", {"src/other.py": "x = 1\n"})
        selffix, _ = self.selffix()
        self.assertNotIn("src/rules.py", selffix)

    def test_short_lines_are_ignored(self):
        self.repo.commit("base", {"src/a.py": "def f():\n    return x\n"})
        self.repo.git("tag", "base")
        self.repo.commit("drop", {"src/a.py": "def f():\n    pass\n"})
        self.repo.commit("restore", {"src/a.py": "def f():\n    return x\n"})
        selffix, _ = self.selffix()
        self.assertNotIn("src/a.py", selffix)


if __name__ == "__main__":
    unittest.main()
