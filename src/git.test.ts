import { test } from "node:test";
import assert from "node:assert/strict";
import { parseSubmoduleStatus } from "./git.js";

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
