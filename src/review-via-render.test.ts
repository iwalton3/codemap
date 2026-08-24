import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

/**
 * Every `via` a review mark can carry is rendered, and rendered everywhere.
 *
 * `AcceptanceVia` is produced in `src/acceptance.ts` and consumed by hand-written
 * lookup tables in `web/app.js`. Nothing connects the two, so adding a case to the
 * union renders as an ordinary green tick until somebody notices — which is exactly
 * what happened: `unverifiable` was in the union, was returned after every
 * `HASH_SCHEME` bump, and appeared in NONE of the tables. A mark that could not be
 * checked drew the same ✓ as one that had been.
 *
 * That is the project's north star failing in the quietest possible way, so it gets a
 * test rather than a note. Static, like `api-map.test.ts`: the thing being guarded is
 * a correspondence between two files, and the drift is what needs catching.
 *
 * `none` is excluded deliberately — it is the value for "not reviewed", so no mark is
 * drawn and there is nothing to label. `direct` is the unremarkable case and is the
 * fall-through in every table by design.
 */

// Repo-relative, matching `api-map.test.ts` — these tests read SOURCE, and the suite
// runs from the repository root. Resolving from `import.meta.url` would land in `dist/`,
// where `schema.ts` does not exist.
const APP = "web/app.js";
const SCHEMA = "src/schema.ts";

/** The union's members, read from the source of truth rather than restated here. */
function acceptanceVia(): string[] {
  const schema = readFileSync(SCHEMA, "utf8");
  const m = /export type AcceptanceVia = ([^;]+);/.exec(schema);
  assert.ok(m, "AcceptanceVia is not where this test expects it — update the test, not the type");
  return [...m![1]!.matchAll(/"([a-z]+)"/g)].map((x) => x[1]!);
}

/** The ones that must be visibly distinguished from an ordinary sign-off. */
const NEEDS_A_LABEL = (all: string[]) => all.filter((v) => v !== "none" && v !== "direct");

test("the AcceptanceVia union is what this test thinks it is", () => {
  // The control for every assertion below: if the union were read as an empty list,
  // every one of them would pass over nothing.
  const all = acceptanceVia();
  assert.deepEqual(all.sort(), ["direct", "none", "replayed", "reverted", "unverifiable"]);
  assert.equal(NEEDS_A_LABEL(all).length, 3, "three cases need to be told apart from a plain tick");
});

test("every via that needs a label has a tooltip in the web UI", () => {
  const app = readFileSync(APP, "utf8");
  const tips = /const VIA_TIP = \{([\s\S]*?)\};/.exec(app);
  assert.ok(tips, "VIA_TIP is gone or renamed");
  for (const via of NEEDS_A_LABEL(acceptanceVia())) {
    assert.match(
      tips![1]!, new RegExp(`\\b${via}\\s*:`),
      `\`${via}\` has no entry in VIA_TIP, so a mark carrying it hovers as an ordinary review. `
      + `A green check that cannot say why it is green is the failure this whole project is against.`,
    );
  }
});

test("and a glyph, so it is distinguishable without hovering", () => {
  const app = readFileSync(APP, "utf8");
  const marks = /const VIA_MARK = \{([^}]*)\}/.exec(app);
  assert.ok(marks, "VIA_MARK is gone or renamed");
  for (const via of NEEDS_A_LABEL(acceptanceVia())) {
    assert.match(
      marks![1]!, new RegExp(`\\b${via}\\s*:`),
      `\`${via}\` has no glyph in VIA_MARK. A tooltip alone is invisible in a list of fifty symbols.`,
    );
  }
  // `revMark` is the second, independent renderer — the two have to agree or the same
  // mark draws differently depending on which surface you are looking at.
  const revMark = /const revMark = [\s\S]*?';\n/.exec(app);
  assert.ok(revMark, "revMark is gone or renamed");
  for (const via of NEEDS_A_LABEL(acceptanceVia())) {
    assert.match(revMark![0]!, new RegExp(`'${via}'`), `revMark does not handle \`${via}\``);
  }
});

test("every surface that draws a mark is PASSED the via", () => {
  // The other half, and the one that made this bug invisible on a page where the
  // tables were correct: `revBtn` called `revCls(st, actor)` and `revMark(st, actor)`
  // with two arguments, so on that surface every via collapsed to a plain tick no
  // matter what the lookup tables said.
  const app = readFileSync(APP, "utf8");
  for (const call of [...app.matchAll(/\b(revCls|revMark|revDot)\(([^)]*)\)/g)]) {
    const [, fn, args] = call;
    if (/^\s*\(?[a-z]/i.test(args!) === false) continue; // the definition itself
    const arity = args!.split(",").length;
    assert.ok(
      arity >= 3,
      `${fn}(${args}) is called with ${arity} argument(s) and needs the \`via\` too — `
      + `without it this surface renders every mark as an ordinary sign-off.`,
    );
  }
});
