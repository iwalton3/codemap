"""Run 2026-10-02-release-stack-and-auth-sweep, I5 (F5): an owner page's snapshot handler replaced a
field the owner had typed into while its write was still pending, on screen and in the state the
next write is built from. A field is dirty from `setField` until its own write resolves, and a
snapshot leaves a dirty field alone. Both pages share the shape."""

import json
import os
import shutil
import subprocess
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
HARNESS = os.path.join(os.path.dirname(os.path.abspath(__file__)), "page_harness.js")
PAGES = [("ez-plan/page.html", "decisions.json"), ("reconsolidate/page.html", "clusters.json")]


@unittest.skipUnless(shutil.which("node"), "node is not installed")
class PageSnapshot(unittest.TestCase):
    def play(self, page, data, scenario):
        proc = subprocess.run(["node", HARNESS, os.path.join(ROOT, page), data, scenario],
                              capture_output=True, text=True, timeout=30)
        self.assertEqual(proc.returncode, 0, proc.stderr)
        return json.loads(proc.stdout)

    def test_stale_snapshot_after_blur_keeps_typed_text(self):
        for page, data in PAGES:
            with self.subTest(page=page):
                self.assertEqual(self.play(page, data, "stale-after-blur"),
                                 {"shown": "new", "saved": "new"})

    def test_stale_snapshot_while_typing_keeps_typed_text(self):
        for page, data in PAGES:
            with self.subTest(page=page):
                self.assertEqual(self.play(page, data, "stale-while-typing"),
                                 {"shown": "new", "saved": "new"})

    def test_remote_change_repaints_a_field_nobody_is_editing(self):
        for page, data in PAGES:
            with self.subTest(page=page):
                self.assertEqual(self.play(page, data, "remote-change-lands"), {"shown": "theirs"})

    def test_field_takes_remote_changes_once_its_write_resolves(self):
        for page, data in PAGES:
            with self.subTest(page=page):
                self.assertEqual(self.play(page, data, "own-write-then-remote"), {"shown": "theirs"})


if __name__ == "__main__":
    unittest.main()
