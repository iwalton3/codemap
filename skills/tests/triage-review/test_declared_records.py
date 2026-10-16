"""Ruling (owner, 2026-09-21, run `2026-09-21-rule-sweep`): **the declaration is the
discriminator, not the directory's name.**

Round 7's I3 (`ideas/routing-2026-09-15/round7/owner.md`) read `<date>-<slug>` as a run only
under a directory *named* `triage`, which worked while the skill chose that name. Once a
project's `CLAUDE.md` can name the destination, the name carries nothing: the search fell
through to the `triage-` prefix rule, matched nothing, and printed NO PRIOR RECORDS FOUND --
which `prompts/triager.md` relays as itself, so a round with history reads as a round without.

A records directory is now one somebody named. `--records-undeclared` marks the single case
nobody named: the current directory of an Artifact run outside git, where the prefix is still
what keeps I3's meeting folder out (pinned in `test_prior_records.py`).

The spanned-run case below is here because it falsified the first fix proposed for this. That
proposal derived the run's shape from `--run-dir`'s own basename; on a spanned run
`diagnose-3-evidence.md` passes `RECORD/<label>`, so the basename is a member label and the
proposal turned a working search into the failure it was meant to repair. Deriving the shape
from any path is the mistake, whichever path it is -- which is the whole content of the ruling.

The exclusion tests are the same ruling in its second place: the pack is *told* where the
record store is rather than inferring what it is looking at.

**Both locations are searched**, which the owner ruled on a fact about how the move happens
(2026-09-21): "on one project I have a few runs I would have to move into the committed location, but I
can't do it until a PR lands with the move." The CLAUDE.md line arrives in a pull request, so
there is necessarily a window where runs exist in both places; searching only the declared one
would report no history during it, which is the failure the whole rule exists to stop. The pack
derives the default from the primary's common dir rather than being passed it, so an override
cannot silently lose the history behind it.
"""

import os
import unittest

from _repo import SKILL_DIR, RepoCase, run_script


def write(path, text="x\n"):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8") as fh:
        fh.write(text)


class DeclaredRecordsAreSearched(RepoCase):
    """The failure two agents reproduced: same layout, parent renamed."""

    def pack(self, records, run_dir, *extra):
        self.repo.commit("base", {"app.py": "x = 1\n"})
        self.repo.git("tag", "base")
        self.repo.commit("change", {"app.py": "x = 2\n"})
        proc = run_script("evidence.py", "--repo", self.repo.path, "--run-dir", run_dir,
                          "--since", "base", "--until", "HEAD",
                          "--records", records, "--reports", self.repo.path, *extra)
        self.assertEqual(proc.returncode, 0, proc.stderr)
        with open(os.path.join(run_dir, "evidence", "prior.md"), encoding="utf-8") as fh:
            return fh.read()

    def earlier_under(self, records):
        for name in ("sort.md", "owner.md", "plan.md", "deposition.md"):
            write(os.path.join(records, "2026-09-01-earlier", name))
        return os.path.join(records, "2026-09-01-earlier", "sort.md")

    def test_a_destination_a_project_named_is_searched(self):
        records = os.path.join(self.tmp, ".triage")     # what a CLAUDE.md might choose
        earlier = self.earlier_under(records)
        prior = self.pack(records, os.path.join(records, "2026-09-16-current"))
        self.assertIn(earlier, prior)
        self.assertNotIn("NO PRIOR RECORDS FOUND", prior)

    def test_the_default_directory_still_is(self):
        records = os.path.join(self.tmp, "common", "triage")
        earlier = self.earlier_under(records)
        prior = self.pack(records, os.path.join(records, "2026-09-16-current"))
        self.assertIn(earlier, prior)

    def test_a_spanned_run_still_finds_its_history(self):
        # diagnose-3-evidence.md: "RECORD/<label> in place of RECORD in both paths".
        # The run directory's basename is a member label, not a date.
        records = os.path.join(self.tmp, ".triage")
        earlier = self.earlier_under(records)
        prior = self.pack(records, os.path.join(records, "2026-09-16-current", "api"))
        self.assertIn(earlier, prior,
                      "a spanned run's --run-dir basename is a label; nothing may read the "
                      "run's shape off it")


class BothLocationsAreSearched(RepoCase):
    """The migration window: the CLAUDE.md line lands in a PR, the old runs are behind it."""

    def run_pack(self, records):
        self.repo.commit("base", {"app.py": "x = 1\n"})
        self.repo.git("tag", "base")
        self.repo.commit("change", {"app.py": "x = 2\n"})
        run_dir = os.path.join(records, "2026-09-16-current")
        proc = run_script("evidence.py", "--repo", self.repo.path, "--run-dir", run_dir,
                          "--since", "base", "--until", "HEAD",
                          "--records", records, "--reports", self.repo.path)
        self.assertEqual(proc.returncode, 0, proc.stderr)
        with open(os.path.join(run_dir, "evidence", "prior.md"), encoding="utf-8") as fh:
            return fh.read()

    def test_a_run_left_in_the_default_location_is_still_found(self):
        old = os.path.join(self.repo.path, ".git", "triage", "2026-09-01-old", "sort.md")
        write(old)
        moved = os.path.join(self.repo.path, ".triage", "2026-09-10-moved", "sort.md")
        write(moved)
        prior = self.run_pack(os.path.join(self.repo.path, ".triage"))
        self.assertIn(moved, prior, "the declared store was not searched")
        self.assertIn(old, prior, "a run left behind by an unfinished migration was lost")

    def test_the_ordinary_case_searches_the_default_once(self):
        old = os.path.join(self.repo.path, ".git", "triage", "2026-09-01-old", "sort.md")
        write(old)
        prior = self.run_pack(os.path.join(self.repo.path, ".git", "triage"))
        self.assertIn(old, prior)
        self.assertEqual(prior.count(os.path.dirname(old)), 1,
                         "the default location was searched twice; realpath dedup is not working")


class EzPlansRecordsAreSearched(RepoCase):
    """references/shared.md K5: a plan holds the owner's intent, which is what turns an apparent
    assumption into a ruling, so a diagnosis must find ez-plan's runs as well as triage-review's."""

    def run_pack(self, *records):
        self.repo.commit("base", {"app.py": "x = 1\n"})
        self.repo.git("tag", "base")
        self.repo.commit("change", {"app.py": "x = 2\n"})
        run_dir = os.path.join(self.repo.path, ".git", "triage", "2026-09-16-current")
        args = []
        for r in records:
            args += ["--records", r]
        proc = run_script("evidence.py", "--repo", self.repo.path, "--run-dir", run_dir,
                          "--since", "base", "--until", "HEAD", *args,
                          "--reports", self.repo.path)
        self.assertEqual(proc.returncode, 0, proc.stderr)
        with open(os.path.join(run_dir, "evidence", "prior.md"), encoding="utf-8") as fh:
            return fh.read()

    def test_the_default_plan_store_is_searched(self):
        plan = os.path.join(self.repo.path, ".git", "plan", "2026-09-01-roadmap", "owner.md")
        write(plan)
        prior = self.run_pack(os.path.join(self.repo.path, ".git", "triage"))
        self.assertIn(plan, prior, "ez-plan's default store was not searched")

    def test_an_ez_plan_override_is_searched(self):
        plan = os.path.join(self.repo.path, "plans", "2026-09-01-roadmap", "plan.md")
        write(plan)
        # The ez-plan store first: a single-valued --records keeps only the last one given.
        prior = self.run_pack(os.path.join(self.repo.path, "plans"),
                              os.path.join(self.repo.path, ".triage"))
        self.assertIn(plan, prior, "a store a CLAUDE.md named for ez-plan was not searched")

    def test_an_undeclared_plan_run_counts(self):
        from importlib import util
        import sys
        path = os.path.join(SKILL_DIR, "scripts", "evidence.py")
        spec = util.spec_from_file_location("evidence_under_test", path)
        mod = util.module_from_spec(spec)
        sys.modules["evidence_under_test"] = mod
        spec.loader.exec_module(mod)
        self.assertTrue(mod.RUN_DIR_OUTSIDE_GIT.match("plan-2026-09-01-roadmap"))
        self.assertTrue(mod.RUN_DIR_OUTSIDE_GIT.match("triage-2026-09-01-round"))
        self.assertFalse(mod.RUN_DIR_OUTSIDE_GIT.match("2026-01-15-meeting"))


class TheRecordIsNotTheArtifact(RepoCase):
    """Item 4: a record committed in the working tree is inside the window by construction."""

    def pack_with_record_in_tree(self):
        self.repo.commit("base", {"app.py": "x = 1\n", "docs/guide.md": "the guide\n"})
        self.repo.git("tag", "base")
        self.repo.commit("round record", {
            ".triage/2026-09-16-current/sort.md": "the sort\n",
            ".triage/2026-09-16-current/owner.md": "the owner's words\n",
            ".triage/2026-09-16-current/plan.md": "the plan\n"})
        self.repo.commit("real work", {"docs/guide.md": "the guide, revised\n"})
        proc = run_script("evidence.py", "--repo", self.repo.path,
                          "--run-dir", os.path.join(self.repo.path, ".triage",
                                                    "2026-09-16-current"),
                          "--since", "base", "--until", "HEAD",
                          "--records", os.path.join(self.repo.path, ".triage"),
                          "--reports", self.repo.path)
        self.assertEqual(proc.returncode, 0, proc.stderr)
        out = os.path.join(self.repo.path, ".triage", "2026-09-16-current", "evidence")
        return {n: open(os.path.join(out, n), encoding="utf-8").read()
                for n in ("surface.md", "selffix.md")}

    def test_the_record_is_not_reported_as_the_artifacts_docs(self):
        s = self.pack_with_record_in_tree()["surface.md"]
        for own in ("sort.md", "owner.md", "plan.md"):
            self.assertNotIn(".triage/2026-09-16-current/" + own, s,
                             f"the run's own {own} is being read as the artifact's docs")

    def test_the_artifacts_own_docs_still_are(self):
        # The exclusion must be the record store and not documents in general.
        self.assertIn("docs/guide.md", self.pack_with_record_in_tree()["surface.md"])


if __name__ == "__main__":
    unittest.main()
