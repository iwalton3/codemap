"""Rulings (plan.md §0, first and second exchanges): the RECORD/CRITERION verdict and
its timing boundaries go. Every commit that changed a named criterion file is
listed, with what it removed and added, and the pack judges none of it: whether a
change conflicts with another rule or with what exists is the readers' call."""

import unittest

from _repo import RepoCase

RULES = "".join("rule %d: X must Y%d\n" % (i, i) for i in range(1, 11))


class CriteriaListed(RepoCase):
    def base(self):
        self.repo.commit("base", {"spec/rules.md": RULES, "src/app.py": "print(0)\n"})
        self.repo.git("tag", "base")
        self.code = 0

    def code_commit(self):
        self.code += 1
        return self.repo.commit("code %d" % self.code,
                                {"src/app.py": "print(%d)\n" % self.code})

    def surface(self):
        pack = self.evidence("--spec", "spec")
        self.assertEqual(pack.proc.returncode, 0, pack.proc.stderr)
        return pack.read("surface.md")

    def test_one_word_disposition_flip_is_listed_with_both_lines(self):
        self.base()
        self.code_commit()
        flip = self.repo.commit("flip", {"spec/rules.md": RULES.replace("rule 3: X must", "rule 3: X may")})
        self.code_commit()
        surface = self.surface()
        self.assertIn(flip[:12], surface)
        self.assertIn("- rule 3: X must Y3", surface)
        self.assertIn("+ rule 3: X may Y3", surface)

    def test_no_verdict_is_printed(self):
        self.base()
        self.code_commit()
        self.repo.commit("rewrite", {"spec/rules.md": RULES.replace("must", "may")})
        self.repo.commit("append", {"spec/rules.md": RULES.replace("must", "may") + "rule 11: new\n" * 30})
        surface = self.surface()
        self.assertNotIn("RECORD", surface)
        self.assertNotIn("CRITERION", surface)

    def test_rewrite_before_any_code_is_still_listed(self):
        self.base()
        rewrite = self.repo.commit("rewrite", {"spec/rules.md": RULES.replace("must Y5", "may Z")})
        self.code_commit()
        surface = self.surface()
        self.assertIn(rewrite[:12], surface)
        row = next(l for l in surface.splitlines() if rewrite[:12] in l)
        self.assertIn("code commits before it: 0", row)

    def test_new_rule_file_is_listed_as_created(self):
        self.base()
        self.code_commit()
        added = self.repo.commit("add", {"spec/new-rule.md": "new rule 1\n"})
        self.code_commit()
        surface = self.surface()
        rows = [l for l in surface.splitlines() if added[:12] in l]
        self.assertTrue(rows, surface)
        self.assertIn("spec/new-rule.md", rows[0])
        self.assertIn("created", rows[0])

if __name__ == "__main__":
    unittest.main()
