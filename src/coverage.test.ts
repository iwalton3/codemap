/**
 * Coverage resolution — and in particular the `tests` state, which is the only one a
 * `cover` rule cannot produce.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { resolveCoverage, DENOMINATOR, docPct } from "./coverage.js";
import { coverageFor } from "./ops/shared.js";
import { init, findGaps, cover, coverageRules, uncover } from "./ops.js";
import { sidecarIgnorePath } from "./ignore.js";
import { universeKey } from "./sidecar-config.js";
import { discard } from "./test-tmp.js";

const ok = <T>(r: T): Exclude<T, { error: string }> => {
  assert.ok(!(r && typeof r === "object" && "error" in (r as object)), `unexpected error: ${(r as any)?.error}`);
  return r as Exclude<T, { error: string }>;
};
import type { Anchor } from "./schema.js";

const anchor = (id: string, file: string): Anchor => ({
  id, file, symbolPath: ["Thing", id], kind: "method",
  bodyHash: "h2:sha256:" + id, lastVerifiedCommit: null,
});

test("a test anchor is out of the denominator, and a citation cannot promote it back", () => {
  // The whole reason tests are indexed is so a requirement can pin a lint — so something
  // WILL point at them. If a citation moved a test into `cited` it would re-enter the
  // documentation denominator through exactly the mechanism the bin exists to serve, and
  // every coverage percentage would move for a reason that is not a regression.
  const anchors = [
    anchor("a_code", "src/pay.ts"),
    anchor("a_test", "Acme.Api.Tests/PayTests.cs"),
    anchor("a_cited_test", "Acme.Api.Tests/LedgerTests.cs"),
  ];
  const isTest = (f: string) => f.includes(".Tests/");

  const r = resolveCoverage(anchors, new Set(["a_cited_test"]), [], isTest);
  assert.equal(r.state.get("a_code"), "open", "ordinary code is still the work queue");
  assert.equal(r.state.get("a_test"), "tests");
  assert.equal(r.state.get("a_cited_test"), "tests", "a citation does not promote it");

  const denom = DENOMINATOR.reduce((n, s) => n + r.breakdown[s], 0);
  assert.equal(denom, 1, "two test anchors must not be in the denominator");
  assert.equal(r.breakdown.tests, 2);

  // Could this pass vacuously? Without the bin the same anchors are ordinary ones and the
  // denominator triples — which is exactly the damage lifting the ignore line alone does.
  const without = resolveCoverage(anchors, new Set(["a_cited_test"]), []);
  assert.equal(DENOMINATOR.reduce((n, s) => n + without.breakdown[s], 0), 3);
  assert.equal(without.breakdown.tests, 0);
  assert.equal(without.state.get("a_cited_test"), "cited");
});

test("indexing tests does not move the documented percentage", () => {
  // The number a person actually looks at. One documented anchor out of two documentable
  // is 50% whether or not a thousand test methods are in the map.
  const code = [anchor("a_doc", "src/pay.ts"), anchor("a_open", "src/ledger.ts")];
  const cited = new Set(["a_doc"]);
  const before = docPct(resolveCoverage(code, cited, []).breakdown);
  assert.equal(before, 50);

  const withTests = [...code, ...Array.from({ length: 1000 }, (_, i) => anchor(`a_t${i}`, "Acme.Api.Tests/T.cs"))];
  const after = docPct(resolveCoverage(withTests, cited, [], (f) => f.includes(".Tests/")).breakdown);
  assert.equal(after, 50, "the bin is what keeps this stable");

  // And what it looks like without the bin, which is the failure being prevented.
  assert.equal(docPct(resolveCoverage(withTests, cited, []).breakdown), 0);
});

test("subtree scope still outranks the tests bin", () => {
  // `deferred`/`owned` are about OWNERSHIP — another universe's code — which is a more
  // fundamental fact than what kind of thing it is. Both are outside the denominator, so
  // nothing is lost either way; this pins the order rather than leaving it to chance.
  const anchors = [anchor("a_t", "vendor/Acme.Api.Tests/T.cs")];
  const r = resolveCoverage(anchors, new Set(), [
    { id: "r1", as: "deferred", select: { pathPrefix: "vendor/" } },
  ], (f) => f.includes(".Tests/"));
  assert.equal(r.state.get("a_t"), "deferred");
});

test("a real repo's [tests] bin keeps its tests out of the work queue", async () => {
  // The seam the unit tests above cannot reach: they hand `resolveCoverage` a predicate
  // directly, so `coverageFor` could stop consulting `.codemapignore` entirely and every
  // one of them would still pass. This is the whole point of the design — the declaration
  // is in the COMMITTED file, because a `cover` rule lives in the gitignored store and
  // would never reach a teammate's fresh clone.
  const root = mkdtempSync(join(tmpdir(), "codemap-cov-"));
  try {
    mkdirSync(join(root, "src"), { recursive: true });
    mkdirSync(join(root, "Acme.Api.Tests"), { recursive: true });
    writeFileSync(join(root, "src", "pay.ts"), "export function transfer(c: number) { return c; }\n", "utf8");
    writeFileSync(join(root, "Acme.Api.Tests", "pay.test.ts"),
      "export function refuses_negative() { return 1; }\nexport function refuses_zero() { return 2; }\n", "utf8");
    writeFileSync(join(root, ".codemapignore"), "[tests]\nAcme.Api.Tests/\n", "utf8");
    await init(root);

    const { result } = await coverageFor(root);
    assert.equal(result.breakdown.tests, 2, "both test symbols are INDEXED — that is why they can be pinned");
    assert.equal(result.breakdown.open, 1, "and only the real code is the work queue");

    const gaps = await findGaps(root, {});
    assert.equal(gaps.openCount, 1);
    assert.deepEqual([...new Set(gaps.open.map((g) => g.file))], ["src/pay.ts"],
      "a test offered as a documentation gap is the work queue filling with nothing");
  } finally { discard(root); }
});


/**
 * The team's declaration, on the sidecar, doing the same job — and the trap beside it.
 *
 * `.codemapignore` resolves from the working tree and therefore moves with the branch.
 * The sidecar's copy does not, which is the whole point: a branch cut before the file was
 * committed used to arrive with no exclusions at all, silently.
 */
test("the [tests] bin works from the sidecar too, and a repo file overrides it", async () => {
  const root = mkdtempSync(join(tmpdir(), "codemap-covside-"));
  const side = mkdtempSync(join(tmpdir(), "codemap-covsidecar-"));
  try {
    mkdirSync(join(root, "src"), { recursive: true });
    mkdirSync(join(root, "Acme.Api.Tests"), { recursive: true });
    mkdirSync(join(root, ".codemap"), { recursive: true });
    writeFileSync(join(root, "src", "pay.ts"), "export function transfer(c: number) { return c; }\n", "utf8");
    writeFileSync(join(root, "Acme.Api.Tests", "pay.test.ts"),
      "export function refuses_negative() { return 1; }\nexport function refuses_zero() { return 2; }\n", "utf8");
    writeFileSync(join(root, ".codemap", "sidecar"), side, "utf8");
    const teamFile = sidecarIgnorePath(side, universeKey(root));
    mkdirSync(dirname(teamFile), { recursive: true });
    writeFileSync(teamFile, "[tests]\nAcme.Api.Tests/\n", "utf8");
    await init(root);

    const team = (await coverageFor(root)).result;
    assert.equal(team.breakdown.tests, 2, "the team's declaration reaches a repo that has none of its own");
    assert.equal(team.breakdown.open, 1);

    // A repo file OVERRIDES — and one that classifies nothing puts the tests back in the
    // work queue, which is the branch saying so rather than the branch losing a file.
    writeFileSync(join(root, ".codemapignore"), "# this branch classifies nothing\n", "utf8");
    const overridden = (await coverageFor(root)).result;
    assert.equal(overridden.breakdown.tests, 0, "override, not merge");
    assert.equal(overridden.breakdown.open, 3);
  } finally { discard(root); discard(side); }
});

/**
 * `deferred` and `owned` outrank the `[tests]` bin (`resolveCoverage`, "scope wins"), so a
 * rule of either kind over a test path makes the bin appear to do nothing. That happened on
 * a live universe and cost an afternoon — because nothing said so, and `cover` only ever
 * appended, so there was no way to take the rule back short of editing the store by hand.
 */
test("a cover rule that shadows the [tests] bin says so, and can be taken back", async () => {
  const root = mkdtempSync(join(tmpdir(), "codemap-shadow-"));
  try {
    mkdirSync(join(root, "src"), { recursive: true });
    mkdirSync(join(root, "Acme.Api.Tests"), { recursive: true });
    writeFileSync(join(root, "src", "pay.ts"), "export function transfer(c: number) { return c; }\n", "utf8");
    writeFileSync(join(root, "Acme.Api.Tests", "pay.test.ts"),
      "export function refuses_negative() { return 1; }\n", "utf8");
    writeFileSync(join(root, ".codemapignore"), "[tests]\nAcme.Api.Tests/\n", "utf8");
    await init(root);
    assert.equal((await coverageFor(root)).result.breakdown.tests, 1);

    const rule = ok(await cover(root, { as: "deferred", select: { pathPrefix: "Acme.Api.Tests" } }));
    assert.match(rule.warning ?? "", /OUTRANKS/, "silently shadowing the bin is what cost the afternoon");
    assert.match(rule.warning ?? "", new RegExp(rule.id), "and it names the rule so it can be dropped");
    assert.equal((await coverageFor(root)).result.breakdown.tests, 0, "the shadowing is real");

    const listed = await coverageRules(root);
    assert.equal(listed.ignoreSource, "repo");
    assert.equal(listed.rules.length, 1);
    assert.equal(listed.rules[0]!.shadowsTests, true, "visible without having to infer it from a percentage");

    assert.match((await uncover(root, { id: "rule_nope" }) as { error: string }).error, /no coverage rule/);
    ok(await uncover(root, { id: rule.id }));
    assert.deepEqual((await coverageRules(root)).rules, []);
    assert.equal((await coverageFor(root)).result.breakdown.tests, 1, "and the bin is doing its job again");

    // A mark that does NOT outrank the bin gets no warning — or the warning is noise on
    // every call and stops being read.
    const trivial = ok(await cover(root, { as: "trivial", select: { pathPrefix: "Acme.Api.Tests" } }));
    assert.equal(trivial.warning, undefined);
  } finally { discard(root); }
});
