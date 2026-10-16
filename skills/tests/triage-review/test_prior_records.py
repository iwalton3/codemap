"""Ruling P-4 (ideas/routing-2026-09-15/round6/owner.md): prior records are, from each earlier
run directory, sort.md, owner.md, owner-late.md, plan.md and deposition.md -- never findings.md,
sort-a/b, arbitration replies or lens readings -- plus earlier reports at both report paths.
The records and reports locations are arguments: for a Claude Artifact run `--repo` is the replay.
Round 7 (ideas/routing-2026-09-15/round7/plan.md §2): only the primary window searches, a spanned
run's current directory is excluded by containment, `<date>-<slug>` counts only under `triage/`,
and reports are listed uncapped. Round 8 (ideas/routing-2026-09-15/round8/plan.md §4.1, owner.md
P7): the older roots come from `--reports`, never from `--repo`, which is the replay on a Claude
Artifact run.

Round 2026-09-21-rule-sweep, owner ruling: **the declaration is the discriminator, not the
directory's name.** Round 7's I3 read `<date>-<slug>` only under a directory *named* `triage`,
because the skill chose that name; once a project's CLAUDE.md can name the destination, the name
carries nothing and the search found no history under any other name. A records directory is now
one somebody named -- the default, or a CLAUDE.md's choice -- and `--records-undeclared` marks the
one case nobody named, the current directory of an Artifact run outside git, where the
`triage-` prefix is still what keeps `~/notes/triage/2026-01-15-meeting/` out. I3's *case* is
unchanged and still pinned below; only what answers it moved."""

import importlib.util
import os
import subprocess
import unittest

from _repo import SKILL_DIR, RepoCase, run_script


def write(path, text="x\n"):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8") as fh:
        fh.write(text)


class PriorRecords(RepoCase):
    def prior(self, records, run_dir, reports=None, extra=()):
        self.repo.commit("base", {"app.py": "x = 1\n"})
        self.repo.git("tag", "base")
        self.repo.commit("change", {"app.py": "x = 2\n"})
        proc = run_script("evidence.py", "--repo", self.repo.path, "--run-dir", run_dir,
                          "--since", "base", "--until", "HEAD",
                          "--records", records, "--reports", reports or self.repo.path, *extra)
        self.assertEqual(proc.returncode, 0, proc.stderr)
        with open(os.path.join(run_dir, "evidence", "prior.md"), encoding="utf-8") as fh:
            return fh.read()

    def git_records(self):
        records = os.path.join(self.tmp, "common", "triage")
        earlier = os.path.join(records, "2026-09-01-earlier")
        for name in ("sort.md", "owner.md", "owner-late.md", "plan.md", "deposition.md",
                     "findings.md", "sort-a.md", "sort-b.md", "arbitration.md", "arbitration-3.md",
                     "lens-a.md"):
            write(os.path.join(earlier, name))
        current = os.path.join(records, "2026-09-16-current")
        write(os.path.join(current, "sort.md"))
        return records, earlier, current

    def test_earlier_runs_words_and_deliverables_are_listed(self):
        records, earlier, current = self.git_records()
        prior = self.prior(records, current)
        for name in ("sort.md", "owner.md", "owner-late.md", "plan.md", "deposition.md"):
            self.assertIn(os.path.join(earlier, name) + "`", prior)

    def test_earlier_runs_readings_are_not_listed(self):
        records, earlier, current = self.git_records()
        prior = self.prior(records, current)
        for name in ("findings.md", "sort-a.md", "sort-b.md", "arbitration.md",
                     "arbitration-3.md", "lens-a.md"):
            self.assertNotIn(os.path.join(earlier, name), prior)

    def test_current_run_is_not_listed(self):
        records, _earlier, current = self.git_records()
        prior = self.prior(records, current)
        self.assertNotIn(current, prior.split("Searched:")[0])

    def test_root_postmortem_is_listed(self):
        reports = os.path.join(self.tmp, "worktree")
        write(os.path.join(reports, "POSTMORTEM-2026-09-01-earlier.md"))
        records = os.path.join(self.tmp, "common", "triage")
        prior = self.prior(records, os.path.join(records, "2026-09-16-current"), reports)
        self.assertIn(os.path.join(reports, "POSTMORTEM-2026-09-01-earlier.md"), prior)

    def test_artifact_run_outside_git_lists_triage_directories(self):
        cwd = os.path.join(self.tmp, "notes")
        write(os.path.join(cwd, "triage-2026-09-01-earlier", "plan.md"))
        write(os.path.join(cwd, "unrelated", "plan.md"))
        prior = self.prior(cwd, os.path.join(cwd, "triage-2026-09-16-current"), cwd,
                           extra=("--records-undeclared",))
        self.assertIn(os.path.join(cwd, "triage-2026-09-01-earlier", "plan.md"), prior)
        self.assertNotIn(os.path.join(cwd, "unrelated"), prior)

    def test_spanned_run_does_not_list_its_own_run_directory(self):
        records, _earlier, current = self.git_records()
        prior = self.prior(records, os.path.join(current, "api"))
        self.assertNotIn(current, prior.split("Searched:")[0])

    def test_dated_folder_outside_triage_is_not_a_run(self):
        cwd = os.path.join(self.tmp, "notes")
        write(os.path.join(cwd, "2026-01-15-meeting", "plan.md"))
        # The owner's I3 case. What keeps it out is now that nobody named this directory,
        # not that it is called something other than `triage`.
        prior = self.prior(cwd, os.path.join(cwd, "triage-2026-09-16-current"), cwd,
                           extra=("--records-undeclared",))
        self.assertNotIn(os.path.join(cwd, "2026-01-15-meeting"), prior.split("Searched:")[0])

    def test_postmortem_under_docs_is_listed_past_the_cap(self):
        reports = os.path.join(self.tmp, "worktree")
        report = os.path.join(reports, "docs", "postmortems", "2026-09-01-earlier.md")
        write(report)
        os.utime(report, (1_000_000, 1_000_000))
        for i in range(41):
            write(os.path.join(reports, "docs", "review-%02d.md" % i))
        records = os.path.join(self.tmp, "common", "triage")
        prior = self.prior(records, os.path.join(records, "2026-09-16-current"), reports)
        listed = prior.split("Searched:")[0]
        self.assertEqual(listed.count(report + "`"), 1, listed)


class OlderRootsOnAnArtifactRun(RepoCase):
    """`self.repo` is the replay; the report goes somewhere else."""

    def pack(self, reports, records):
        self.repo.commit("v1", {"page.html": "<p>1</p>\n"})
        self.repo.git("tag", "base")
        self.repo.commit("v2", {"page.html": "<p>2</p>\n"})
        run_dir = os.path.join(records, "2026-09-16-current")
        proc = run_script("evidence.py", "--repo", self.repo.path, "--run-dir", run_dir,
                          "--since", "base", "--until", "HEAD",
                          "--records", records, "--reports", reports)
        self.assertEqual(proc.returncode, 0, proc.stderr)
        with open(os.path.join(run_dir, "evidence", "prior.md"), encoding="utf-8") as fh:
            listed, _, searched = fh.read().partition("Searched:")
        return listed, searched

    def test_from_a_git_repository_review_is_the_reports_repositorys(self):
        reports = os.path.join(self.tmp, "api")
        os.makedirs(reports)
        subprocess.run(["git", "-C", reports, "init", "-q"], check=True)
        review = os.path.join(reports, ".git", "review", "round-1.md")
        write(review)
        listed, searched = self.pack(reports, os.path.join(reports, ".git", "triage"))
        self.assertIn(review + "`", listed)
        self.assertNotIn(os.path.join(self.repo.path, ".git", "review"), searched)

    def test_outside_git_no_root_is_the_replays(self):
        reports = os.path.join(self.tmp, "notes")
        os.makedirs(reports)
        spec = importlib.util.spec_from_file_location(
            "evidence", os.path.join(SKILL_DIR, "scripts", "evidence.py"))
        evidence = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(evidence)
        projects = os.path.join(os.path.expanduser("~"), ".claude", "projects")
        _listed, searched = self.pack(reports, reports)
        self.assertNotIn(os.path.join(self.repo.path, ".git", "review"), searched)
        self.assertIn(os.path.join(projects, evidence.project_slug(reports), "artifacts"),
                      searched)
        self.assertNotIn(os.path.join(projects, evidence.project_slug(self.repo.path)),
                         searched)


class PriorRecordsSkipped(RepoCase):
    """A spanned run's non-primary window: the new argument fails before round 7 only as an
    unknown argument, so the guard beside it is that without it an earlier run is listed."""

    def pack(self, *extra):
        records = os.path.join(self.tmp, "common", "triage")
        write(os.path.join(records, "2026-09-01-earlier", "plan.md"))
        self.repo.commit("base", {"app.py": "x = 1\n"})
        self.repo.git("tag", "base")
        self.repo.commit("change", {"app.py": "x = 2\n"})
        run_dir = os.path.join(records, "2026-09-16-current", "web")
        proc = run_script("evidence.py", "--repo", self.repo.path, "--run-dir", run_dir,
                          "--since", "base", "--until", "HEAD", *extra)
        self.assertEqual(proc.returncode, 0, proc.stderr)
        with open(os.path.join(run_dir, "evidence", "prior.md"), encoding="utf-8") as fh:
            return records, fh.read(), proc.stdout

    def test_skip_prior_says_skipped_and_lists_nothing(self):
        records, prior, summary = self.pack("--skip-prior")
        self.assertIn("SKIPPED", prior)
        self.assertNotIn("NO PRIOR RECORDS FOUND", prior + summary)
        self.assertNotIn(records, prior)

    def test_without_skip_prior_an_earlier_run_is_listed(self):
        records, prior, _summary = self.pack("--records", os.path.join(self.tmp, "common", "triage"),
                                             "--reports", self.repo.path)
        self.assertIn(os.path.join(records, "2026-09-01-earlier", "plan.md"), prior)

    def test_records_are_required_without_skip_prior(self):
        self.repo.commit("base", {"app.py": "x = 1\n"})
        proc = run_script("evidence.py", "--repo", self.repo.path,
                          "--run-dir", os.path.join(self.tmp, "run"), "--since", "HEAD")
        self.assertEqual(proc.returncode, 2, proc.stderr)


if __name__ == "__main__":
    unittest.main()
