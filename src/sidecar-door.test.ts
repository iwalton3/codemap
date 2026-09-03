import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

/**
 * Every write reaches the sidecar through a DOOR, and nothing re-composes one.
 *
 * The rule `CLAUDE.md` states as *"every end guards the sidecar binding — read, write AND
 * transport"*, made checkable. It has cost two rounds already and both are in the log:
 *
 * - `5b9fce7` found `bind` and `bugLog` guarding while eight call sites resolved the
 *   config themselves and handed it to `ensureSidecar` — so `report_bug` refused while
 *   `annotate` answered `shared: true` into a stranger's log. **Guarding two doors of ten
 *   was worse than guarding none**, because the comment on `bind` then lied about the rest.
 * - `5d9f747` found the consolidated door collapsing "no sidecar" and "the wrong sidecar"
 *   into one quiet null, and swept nine more sites.
 *
 * Between them the rule was enforced by a comment, and answering "does every write go
 * through the door?" meant hand-checking nine files. Twice. That is what this replaces.
 *
 * Two halves, because they fail in opposite directions and either alone is satisfiable
 * by the other's defect:
 *
 *  1. a module that WRITES must get its config from a door (a new publish path that
 *     resolves and never checks);
 *  2. `checkSidecarBinding` is called only BY a door (a publish path that inlines the
 *     door's two steps, which passes half 1 while making the door not-the-only-door).
 *
 * A TEXT scan, for the reason `ops-reach.test.ts` gives: the drift is a name nobody
 * typed. **To check this is not vacuous**, delete the `sidecarWriteDoor` import from
 * `src/notes-publish.ts` (half 1 fails) or move `provisional.ts`'s old inlined
 * `checkSidecarBinding` back (half 2 fails).
 */

const modules = (): { path: string; src: string }[] => {
  const files = [
    ...readdirSync("src").filter((f) => f.endsWith(".ts")).map((f) => join("src", f)),
    ...readdirSync("src/ops").filter((f) => f.endsWith(".ts")).map((f) => join("src/ops", f)),
  ].filter((f) => !f.endsWith(".test.ts"));
  return files.map((path) => ({ path, src: readFileSync(path, "utf8") }));
};

/** The functions that ARE doors: each resolves the config and checks the binding. */
const DOORS = /\bsidecarWriteDoor\b|\bsidecarForWrite\b|\bbugLog\b|\bbind\(/;

/**
 * Modules that reach `ensureSidecar` without a door, and why that is right.
 *
 * A stale exemption is a failure — an exemption list nobody prunes is how a sweep quietly
 * stops covering anything (`standard-reach.test.ts` says the same, and means it).
 */
const MAY_WRITE_WITHOUT_A_DOOR: Record<string, string> = {
  "src/sidecar.ts": "defines `ensureSidecar`",
  "src/oracle.ts": "test infrastructure — it BUILDS the universes a door would guard",
  "src/scenario.ts": "test infrastructure, same as the oracle",
};

/**
 * Modules that may call `checkSidecarBinding`, i.e. the doors themselves.
 *
 * `bind` is a door and stays one rather than delegating: it takes a read/write
 * distinction (`opts.reading`) that `sidecarWriteDoor` deliberately does not have, so
 * routing it through would add a branch rather than remove one.
 */
const IS_A_DOOR: Record<string, string> = {
  "src/sidecar-config.ts": "defines both the check and `sidecarWriteDoor`",
  "src/ops-shared.ts": "`bind` is a door, and `sidecarVanished` is the escape hatch the refusal names",
};

test("every module that writes to the sidecar gets its config from a door", () => {
  const offenders = modules()
    .filter(({ path, src }) => /\bensureSidecar\(/.test(src) && !DOORS.test(src))
    .map(({ path }) => path)
    .filter((p) => !(p in MAY_WRITE_WITHOUT_A_DOOR));

  assert.deepEqual(offenders, [],
    "these call `ensureSidecar` without going through `sidecarWriteDoor`/`sidecarForWrite`/"
    + "`bugLog`/`bind` — a write that resolves its own config skips the binding check, which "
    + "is how `annotate` published into a stranger's log and MADE a sidecar at a typo'd path");

  // The exemptions describe files that still exist and still write. A pruned list is the
  // only thing keeping the assertion above honest.
  for (const p of Object.keys(MAY_WRITE_WITHOUT_A_DOOR)) {
    const m = modules().find((x) => x.path === p);
    assert.ok(m, `stale exemption: ${p} is gone`);
    assert.match(m.src, /\bensureSidecar\(/, `stale exemption: ${p} no longer writes`);
  }
});

test("only a door composes the binding check itself", () => {
  const offenders = modules()
    .filter(({ src }) => /\bcheckSidecarBinding\(/.test(src))
    .map(({ path }) => path)
    .filter((p) => !(p in IS_A_DOOR));

  assert.deepEqual(offenders, [],
    "these inline the door's two steps (`resolveSidecar` then `checkSidecarBinding`) "
    + "instead of calling it. That passes the write check above while making the door one "
    + "of several, which is exactly the state `5b9fce7` found: a guard whose comment "
    + "claimed a reach it did not have");

  for (const p of Object.keys(IS_A_DOOR)) {
    const m = modules().find((x) => x.path === p);
    assert.ok(m, `stale exemption: ${p} is gone`);
    assert.match(m.src, /\bcheckSidecarBinding\(/, `stale exemption: ${p} no longer checks`);
  }
});
