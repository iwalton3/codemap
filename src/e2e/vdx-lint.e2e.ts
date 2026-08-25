/**
 * The framework's own template lint, run somewhere that actually runs it.
 *
 * `tsc -p web` reads a template's string-form bindings as opaque text, so a whole class
 * of mistakes is invisible to it — Lit sigils, a raw `.map()` in a slot, `ref=` typos —
 * and those are precisely the ones `CLAUDE.md` records as having bitten repeatedly. The
 * lint covers that gap and nothing else does.
 *
 * Until this file, nothing ran it. It existed as a sentence in
 * `web/vendor/vdx/PROVENANCE.md` saying re-vendoring was the moment to remember, which
 * makes it a check that runs when somebody recalls it exists — the state the suite is
 * meant to replace. Template edits are far more frequent than re-vendoring, so the one
 * check TypeScript cannot stand in for was the one with no schedule.
 *
 * e2e rather than unit, and skipping rather than failing, for the puppeteer suite's
 * reason: the tool is not this project's to own and lives outside the repo. Point
 * `CODEMAP_VDX_TOOLS` at any vdx-web checkout's `tools/` directory.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

/** A vdx-web checkout's `tools/`. Overridable because the default is one machine's. */
export const VDX_TOOLS = process.env.CODEMAP_VDX_TOOLS ?? "/working/vdx-web/tools";
const OPTIMIZE = join(VDX_TOOLS, "optimize.js");

/**
 * The app's source, resolved from this file rather than `cwd`.
 *
 * Compiled to `dist/e2e/`, so two levels up is the repo root. `cwd` is whatever the
 * runner was started from and would lint the wrong tree — or nothing — the moment
 * anyone invoked a single file from elsewhere.
 */
const WEB = fileURLToPath(new URL("../../web", import.meta.url));

const skip = existsSync(OPTIMIZE)
  ? false
  : `no vdx tools at ${OPTIMIZE} — set CODEMAP_VDX_TOOLS to a vdx-web checkout's tools/ directory`;

/**
 * Exit code is the contract the tool publishes for CI: 0 clean, 1 issues, 2 unfixable.
 * Template WARNINGS are advisory and deliberately do not move it, so this fails on what
 * the tool itself calls a failure and on nothing else.
 *
 * Verified able to fail: a raw `.map()` returning `html` in a slot, dropped into a copy
 * of `web/`, is reported as `t8-list-control` and exits 2.
 */
test("the web app has no vdx template binding issues", { skip }, () => {
  const r = spawnSync(process.execPath, [OPTIMIZE, "-i", WEB, "--templates-only"], {
    encoding: "utf8",
    // The tool resolves its own helpers relative to itself, not to cwd, but a run from
    // an unrelated directory is the kind of thing that only fails on somebody else's
    // machine. Start it where it lives.
    cwd: VDX_TOOLS,
  });
  assert.equal(
    r.status, 0,
    `vdx template lint exited ${r.status} — these are bindings TypeScript cannot see, so `
    + `nothing else will catch them:\n\n${(r.stdout || "") + (r.stderr || "")}`,
  );
});
