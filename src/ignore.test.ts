import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { compileIgnore, loadIgnore, sidecarIgnorePath } from "./ignore.js";
import { universeKey } from "./sidecar-config.js";
import { discard } from "./test-tmp.js";

test("bare basename matches a file at any depth, exact", () => {
  const ig = compileIgnore("framework.js");
  assert.equal(ig.ignores("static/lib/framework.js", false), true);
  assert.equal(ig.ignores("framework.js", false), true);
  assert.equal(ig.ignores("framework.jsx", false), false);
  assert.equal(ig.ignores("lib/framework.ts", false), false);
});

test("dir pattern excludes the dir and everything under it, anywhere", () => {
  const ig = compileIgnore("vdx/");
  assert.equal(ig.ignores("wwwroot/console/vdx", true), true);
  assert.equal(ig.ignores("wwwroot/console/vdx/lib/framework.js", false), true);
  assert.equal(ig.ignores("wwwroot/console/vdxx", true), false); // not a segment match
  assert.equal(ig.ignores("src/vdx-utils.js", false), false);
});

test("anchored path only matches from the repo root", () => {
  const ig = compileIgnore("wwwroot/console/vdx/");
  assert.equal(ig.ignores("wwwroot/console/vdx/lib/a.js", false), true);
  assert.equal(ig.ignores("app/wwwroot/console/vdx/lib/a.js", false), false);
});

test("globstar spans segments", () => {
  const ig = compileIgnore("**/generated/**");
  assert.equal(ig.ignores("a/b/generated/c/d.cs", false), true);
  assert.equal(ig.ignores("generated/x.cs", false), true);
  assert.equal(ig.ignores("a/regenerated/x.cs", false), false);
});

test("single star stays within a segment", () => {
  const ig = compileIgnore("*.min.js");
  assert.equal(ig.ignores("static/vendor/marked.min.js", false), true);
  assert.equal(ig.ignores("static/app.js", false), false);
});

test("negation re-includes (last match wins)", () => {
  const ig = compileIgnore("lib/*.js\n!lib/keep.js");
  assert.equal(ig.ignores("lib/a.js", false), true);
  assert.equal(ig.ignores("lib/keep.js", false), false);
});

test("comments and blank lines are ignored", () => {
  const ig = compileIgnore("# a comment\n\nvendor/\n");
  assert.equal(ig.ignores("vendor/x.js", false), true);
  assert.equal(ig.ignores("src/x.js", false), false);
});

test("the [tests] bin is indexed, not excluded — and the two bins do not leak", () => {
  // Tests belong IN the map: a requirement pins a lint by hash, so the lint has to be
  // indexed and citable. What they must stay out of is the documentation denominator.
  const ig = compileIgnore([
    "**/Internal/Generated/",
    "",
    "[tests]",
    "*.Tests/",
    "test-scripts/",
  ].join("\n"));

  assert.equal(ig.ignores("src/Internal/Generated/Handlers.cs", false), true);
  assert.equal(ig.isTest("src/Internal/Generated/Handlers.cs", false), false,
    "an excluded path is not a test path — the bins are separate lists");

  assert.equal(ig.isTest("Acme.Api.Tests/PayTests.cs", false), true);
  assert.equal(ig.ignores("Acme.Api.Tests/PayTests.cs", false), false,
    "a [tests] pattern must NOT exclude — indexing them is the whole point");
  assert.equal(ig.isTest("test-scripts/seed.py", false), true);
  assert.equal(ig.isTest("src/pay.ts", false), false);
});

test("an unknown section falls back to excluding, which is the visible failure", () => {
  // A typo'd header that silently dropped its patterns would re-admit whatever they
  // excluded — generated code flooding the map, quietly. Over-excluding is loud.
  const ig = compileIgnore("[tetss]\nvendor/\n");
  assert.equal(ig.ignores("vendor/thing.js", false), true);
  assert.equal(ig.isTest("vendor/thing.js", false), false);
});

test("a file with no sections behaves exactly as before", () => {
  const ig = compileIgnore("vendor/\n!vendor/keep.js\n");
  assert.equal(ig.ignores("vendor/x.js", false), true);
  assert.equal(ig.ignores("vendor/keep.js", false), false, "last match still wins");
  assert.equal(ig.isTest("vendor/x.js", false), false);
});


/**
 * WHERE the declaration lives, and the three states that make the layer expressible.
 *
 * `.codemapignore` resolves from the working tree, so it moves with the branch: a branch
 * cut before the file was committed does not have it, and checking that branch out deletes
 * it. The old `loadIgnore` answered that the same way it answers "declared, and nothing
 * matched" — so generated code floods back as documentation gaps, and every pointer at a
 * test anchor demotes from `check` to `symbol`/`lastResort`, which is the ladder inverting
 * silently. See the header.
 */
test("the declaration layers: the repo's wins, else the team's on the sidecar, else none", async () => {
  const root = mkdtempSync(join(tmpdir(), "codemap-ign-"));
  const side = mkdtempSync(join(tmpdir(), "codemap-ignside-"));
  try {
    mkdirSync(join(root, ".codemap"), { recursive: true });
    writeFileSync(join(root, ".codemap", "sidecar"), side, "utf8");

    // 1. NOTHING declared anywhere. The third state, and it is not "matches nothing".
    const none = await loadIgnore(root);
    assert.equal(none.source, "none");
    assert.equal(none.isTest("Acme.Api.Tests/PayTests.cs", false), false);

    // 2. The TEAM's, on the sidecar's own branch. Keyed like every other scope, so a clone
    //    with no GitHub origin can still find it — `universeKey` falls back to the basename.
    const teamFile = sidecarIgnorePath(side, universeKey(root));
    mkdirSync(dirname(teamFile), { recursive: true });
    writeFileSync(teamFile, "gen/\n\n[tests]\n*.Tests/\n", "utf8");
    const team = await loadIgnore(root);
    assert.equal(team.source, "sidecar");
    assert.equal(team.isTest("Acme.Api.Tests/PayTests.cs", false), true,
      "the bin the pointer ladder depends on, surviving a branch that never had the file");
    assert.equal(team.ignores("gen/Handlers.cs", false), true);

    // 3. The REPO's overrides it — OVERRIDE, not merge. A branch that restructures its test
    //    directory genuinely wants its own patterns, and must be able to drop an inherited
    //    one without a negation.
    writeFileSync(join(root, ".codemapignore"), "[tests]\ntests/\n", "utf8");
    const repo = await loadIgnore(root);
    assert.equal(repo.source, "repo");
    assert.equal(repo.isTest("tests/pay.spec.ts", false), true);
    assert.equal(repo.isTest("Acme.Api.Tests/PayTests.cs", false), false, "override, not merge");
    assert.equal(repo.ignores("gen/Handlers.cs", false), false, "the team's excluded bin goes too");

    // 4. An EMPTY repo file is a DECLARATION — "we exclude nothing" — and must not inherit
    //    the team's. This is the whole reason `source` is three-valued: collapsing it into
    //    "matches nothing" made the difference between this case and case 1 unaskable.
    writeFileSync(join(root, ".codemapignore"), "# nothing to exclude here\n", "utf8");
    const empty = await loadIgnore(root);
    assert.equal(empty.source, "repo");
    assert.equal(empty.isTest("Acme.Api.Tests/PayTests.cs", false), false,
      "an intentionally empty declaration does not fall through to the team default");
  } finally { discard(root); discard(side); }
});

test("with no sidecar configured, a missing repo file is still `none` rather than an error", async () => {
  const root = mkdtempSync(join(tmpdir(), "codemap-ign-bare-"));
  const had = process.env.CODEMAP_SIDECAR;
  delete process.env.CODEMAP_SIDECAR;
  try {
    const ig = await loadIgnore(root);
    assert.equal(ig.source, "none");
    assert.equal(ig.ignores("anything", false), false);
  } finally {
    if (had !== undefined) process.env.CODEMAP_SIDECAR = had;
    discard(root);
  }
});


/**
 * A declaration that EXISTS and cannot be read is not a declaration that is absent.
 *
 * `loadIgnore` caught every filesystem error as "no repo declaration" and fell through to
 * the team's — so a `.codemapignore` that is a directory, or unreadable, or a broken
 * symlink silently swapped this repo's policy for somebody else's. That is the one
 * transition the layer must never make on its own, and it is invisible: the answer looks
 * like a working configuration. Found by codex.
 */
test("an unreadable declaration refuses rather than inheriting the team's", async () => {
  const root = mkdtempSync(join(tmpdir(), "codemap-ignbad-"));
  const side = mkdtempSync(join(tmpdir(), "codemap-ignbadside-"));
  try {
    mkdirSync(join(root, ".codemap"), { recursive: true });
    writeFileSync(join(root, ".codemap", "sidecar"), side, "utf8");
    const teamFile = sidecarIgnorePath(side, universeKey(root));
    mkdirSync(dirname(teamFile), { recursive: true });
    writeFileSync(teamFile, "[tests]\n*.Tests/\n", "utf8");

    // CONTROL: with no repo file at all, inheriting is correct and must still happen.
    assert.equal((await loadIgnore(root)).source, "sidecar");

    // And now one that is present and unreadable — a directory gets EISDIR from readFile.
    mkdirSync(join(root, ".codemapignore"));
    await assert.rejects(() => loadIgnore(root), /could not be read/,
      "silently obeying the team's rules because this repo's file is broken is the worst answer available");
  } finally { discard(root); discard(side); }
});

/** The same rule one layer down: the team's file being unreadable is not the team having none. */
test("an unreadable team declaration refuses rather than reading as absent", async () => {
  const root = mkdtempSync(join(tmpdir(), "codemap-ignbad2-"));
  const side = mkdtempSync(join(tmpdir(), "codemap-ignbad2side-"));
  try {
    mkdirSync(join(root, ".codemap"), { recursive: true });
    writeFileSync(join(root, ".codemap", "sidecar"), side, "utf8");
    assert.equal((await loadIgnore(root)).source, "none", "the control: genuinely absent is `none`");

    mkdirSync(sidecarIgnorePath(side, universeKey(root)), { recursive: true });
    await assert.rejects(() => loadIgnore(root), /could not be read/);
  } finally { discard(root); discard(side); }
});
