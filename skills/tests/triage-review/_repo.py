"""Throwaway git repositories, a runner for the triage-review scripts, and `SKILL_DIR` for the
checks that read the skill's own prose.

Run from the repository root:

    python3 -m unittest discover -s tests/triage-review

SKILL_DIR_UNDER_TEST points the checks at another copy of the skill's scripts, which is how
each check is observed failing against an older commit:

    git archive <sha> triage-review | tar -x -C /tmp/old
    SKILL_DIR_UNDER_TEST=/tmp/old/triage-review python3 -m unittest discover -s tests/triage-review
"""

import os
import shutil
import subprocess
import sys
import tempfile
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
SKILL_DIR = os.environ.get("SKILL_DIR_UNDER_TEST") or os.path.join(ROOT, "triage-review")


class Repo:
    def __init__(self, path):
        self.path = path
        os.makedirs(path)
        self.git("init", "-q")

    def git(self, *args):
        return subprocess.run(
            ["git", "-C", self.path, "-c", "user.name=t", "-c", "user.email=t@t",
             "-c", "commit.gpgsign=false", *args],
            check=True, capture_output=True, text=True, encoding="utf-8").stdout.strip()

    def commit(self, message, files=None, delete=()):
        """Write `files` ({path: text}), remove `delete`, commit everything; return the sha."""
        for rel, text in (files or {}).items():
            full = os.path.join(self.path, rel)
            os.makedirs(os.path.dirname(full), exist_ok=True)
            with open(full, "w", encoding="utf-8") as fh:
                fh.write(text)
        for rel in delete:
            os.remove(os.path.join(self.path, rel))
        self.git("add", "-A")
        self.git("commit", "-q", "--allow-empty", "-m", message)
        return self.git("rev-parse", "HEAD")


class Pack:
    def __init__(self, proc, out_dir):
        self.proc = proc
        self.dir = out_dir

    def read(self, name):
        path = os.path.join(self.dir, name)
        if not os.path.exists(path):
            return ""
        with open(path, encoding="utf-8") as fh:
            return fh.read()


def run_script(name, *args):
    return subprocess.run([sys.executable, os.path.join(SKILL_DIR, "scripts", name), *args],
                          capture_output=True, text=True, encoding="utf-8")


class RepoCase(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="triage-review-test-")
        self.addCleanup(shutil.rmtree, self.tmp, True)
        self.repo = Repo(os.path.join(self.tmp, "repo"))

    def evidence(self, *extra, since="base", until="HEAD"):
        run_dir = os.path.join(self.tmp, "run")
        proc = run_script("evidence.py", "--repo", self.repo.path, "--run-dir", run_dir,
                          "--since", since, "--until", until,
                          "--records", os.path.join(self.tmp, "records"),
                          "--reports", self.repo.path, *extra)
        return Pack(proc, os.path.join(run_dir, "evidence"))
