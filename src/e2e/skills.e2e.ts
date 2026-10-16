/**
 * The skills' own test suites (`skills/tests/`), which are Python's stdlib unittest.
 *
 * e2e rather than unit, and skipping rather than failing, because `python3` is an
 * external prerequisite: `npm run unit` stays hermetic, and `npm test` still runs them —
 * a suite that is not in the default command stops being run.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

/** Compiled to `dist/e2e/`, so two levels up is the repo root. */
const SKILLS = fileURLToPath(new URL("../../skills", import.meta.url));

const python = spawnSync("python3", ["--version"], { encoding: "utf8" });
const skip = python.status === 0 ? false : "no python3 on PATH — the skills' suites need it";

for (const suite of ["tests/triage-review"]) {
  test(`skills: ${suite} passes`, { skip }, () => {
    const r = spawnSync("python3", ["-m", "unittest", "discover", "-s", suite], {
      cwd: SKILLS, encoding: "utf8",
    });
    assert.equal(r.status, 0, `python3 -m unittest discover -s ${suite} failed:\n\n${r.stderr}`);
  });
}
