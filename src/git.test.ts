import { test } from "node:test";
import assert from "node:assert/strict";
import { parseSubmoduleStatus, submoduleDrift } from "./git.js";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { discard } from "./test-tmp.js";

test("an in-sync submodule is not reported", () => {
  const out = " d748b4537be9985d747673ced94abe5abd87423a Acme.BaseClasses (heads/main)\n";
  assert.deepEqual(parseSubmoduleStatus(out), []);
});

test("a checkout that differs from the pin is drifted", () => {
  // The live case this was written for: Acme.Settlement pinned d748b45 and had
  // cf08f1a checked out, so its @work index held kernel code its commits do not ship.
  const out = "+cf08f1af9855e0865aa5282f17e82929dcf68b67 Acme.BaseClasses (remotes/local/main)\n";
  assert.deepEqual(parseSubmoduleStatus(out), [
    { sha: "cf08f1af9855e0865aa5282f17e82929dcf68b67", path: "Acme.BaseClasses", state: "drifted" },
  ]);
});

test("an uninitialized submodule is reported separately from a drifted one", () => {
  const out = "-0000000000000000000000000000000000000000 vendor/thing\n";
  const d = parseSubmoduleStatus(out);
  assert.equal(d.length, 1);
  assert.equal(d[0]!.state, "uninitialized");
  assert.equal(d[0]!.path, "vendor/thing");
});

test("an unmerged submodule is a conflict", () => {
  const out = "U1111111111111111111111111111111111111111 libs/shared (heads/main)\n";
  assert.equal(parseSubmoduleStatus(out)[0]!.state, "conflict");
});

test("mixed output returns only the drifted entries, in order", () => {
  const out = [
    " aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa in/sync (heads/main)",
    "+bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb one/ahead (heads/main)",
    "-cccccccccccccccccccccccccccccccccccccccc two/missing",
    "",
  ].join("\n");
  assert.deepEqual(parseSubmoduleStatus(out).map((d) => d.path), ["one/ahead", "two/missing"]);
});

test("a path containing spaces survives the describe-suffix strip", () => {
  const out = "+dddddddddddddddddddddddddddddddddddddddd my libs/shared thing (heads/main)\n";
  const d = parseSubmoduleStatus(out)[0]!;
  assert.equal(d.path, "my libs/shared thing", "the (describe) suffix is dropped, the spaces in the path are not");
});

test("empty output is not a failure", () => {
  assert.deepEqual(parseSubmoduleStatus(""), []);
  assert.deepEqual(parseSubmoduleStatus("\n\n"), []);
});

// --- the check failing is not the same as there being nothing to report --------

const tmp = () => mkdtempSync(join(tmpdir(), "codemap-sm-"));

test("a repo with no submodules reports no drift and no error", () => {
  const root = tmp();
  try {
    spawnSync("git", ["init", "-q", "-b", "main"], { cwd: root });
    const r = submoduleDrift(root);
    assert.deepEqual(r.drift, []);
    assert.equal(r.error, undefined, "empty output is a real answer, not a failure");
  } finally { discard(root); }
});

test("a directory that is not a repo is not a submodule problem", () => {
  // A gitless universe is supported and has nothing to be out of sync with.
  const root = tmp();
  try {
    const r = submoduleDrift(root);
    assert.deepEqual(r.drift, []);
    assert.equal(r.error, undefined);
  } finally { discard(root); }
});

test("a broken submodule gitdir is REPORTED, not silently read as nothing", () => {
  // The case a snapshot copy produces, and the one the old code swallowed: the
  // command fails, and a scan that cannot tell whether its submodules are in sync
  // must say so — the index would otherwise describe code the commit does not ship.
  const root = tmp();
  try {
    spawnSync("git", ["init", "-q", "-b", "main"], { cwd: root });
    writeFileSync(join(root, ".gitmodules"), '[submodule "lib"]\n\tpath = lib\n\turl = ../lib.git\n', "utf8");
    mkdirSync(join(root, "lib"), { recursive: true });
    // A gitlink in the index whose gitdir does not exist.
    writeFileSync(join(root, "lib", ".git"), "gitdir: /nonexistent/modules/lib\n", "utf8");
    spawnSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "add", ".gitmodules"], { cwd: root });
    spawnSync("git", ["update-index", "--add", "--cacheinfo", "160000,0000000000000000000000000000000000000001,lib"], { cwd: root });

    const r = submoduleDrift(root);
    // Either it reports drift for `lib` or it reports an error — what it must NOT
    // do is return a clean empty answer, which reads as "everything is in sync".
    assert.ok(r.drift.length > 0 || !!r.error, `expected drift or an error, got ${JSON.stringify(r)}`);
  } finally { discard(root); }
});
