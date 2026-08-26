import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, normalize, sep } from "node:path";

/**
 * The module graph must stay acyclic.
 *
 * Not a style rule. An ES-module cycle resolves to a partially-initialized module
 * rather than an error, so the symptom is a `undefined is not a function` at some
 * unrelated call site — or, in the web app, a blank page with NOTHING in the
 * console. This repo has shipped that failure before, which is why it is worth a
 * test rather than vigilance.
 *
 * The near-miss that prompted this: `shared-docs.ts` imported `winningVersionAt`
 * from `store.ts`, which was harmless in that direction — and would have closed a
 * loop the moment `store.ts` imported the shared folds to materialize them. The
 * pure half now lives in `doc-version.ts`, below both, so the cycle is not
 * available to be reintroduced by accident.
 */
/**
 * Nodes are paths under `src` (`ops/docs`, not `docs`), and the walk RECURSES.
 * A flat, same-directory-only scan cannot see `src/ops/*` at all, so splitting a
 * module into a subdirectory would have quietly emptied this test of the very
 * case it was extended to cover — the guard would still pass while guarding
 * nothing.
 */
function moduleGraph(root: string, ext: ".ts" | ".js"): Map<string, string[]> {
  const g = new Map<string, string[]>();
  const walk = (dir: string) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      // `vendor/` is third-party and re-vendored wholesale; a cycle inside it is not
      // ours to fix and would fail this test on every re-vendor.
      if (e.isDirectory()) { if (e.name !== "vendor") walk(join(dir, e.name)); continue; }
      if (!e.name.endsWith(ext) || e.name.endsWith(".test" + ext) || e.name.endsWith(".d.ts")) continue;
      // POSIX-separated, on every platform. The key is compared against import
      // SPECIFIERS, which are always `/`-separated — so on win32 `join` produced
      // `web\core` here, nothing matched, `cyclesIn` found no edges to walk, and this
      // guard reported a clean graph while checking nothing. Same class as COD-12.
      const rel = join(dir, e.name).split(sep).join("/")
        .replace(new RegExp("^" + root + "/"), "").replace(new RegExp("\\" + ext + "$"), "");
      const src = readFileSync(join(dir, e.name), "utf8");
      // Every spelling: `from "./x.js"`, `await import("./x.js")`, and the bare
      // side-effect `import "./x.js"`. The last one is easy to leave out and is the
      // one a cycle can hide behind — an earlier version of this test did, and
      // silently passed a probe that reintroduced the exact cycle it exists for.
      // BOTH quote styles. The src tree is double-quoted and `web/` is single-quoted,
      // so a double-quote-only pattern finds ZERO edges in web/ — the graph comes back
      // as isolated nodes and every cycle assertion passes vacuously. Caught by
      // reintroducing the app<->shared cycle and watching this stay green.
      // Same normalization as `rel` above, and for the same reason: `join`/`normalize`
      // are platform-dependent, so on win32 a dep resolving into a subdirectory came
      // back as `ops\docs` and matched no node key. Single-segment names happen to
      // survive, which is what makes this the half that would have been missed.
      const deps = [...src.matchAll(/(?:\bfrom\s*|\bimport\s*\(?\s*)['"](\.\.?\/[\w./-]+)\.js['"]/g)]
        .map((m) => normalize(join(dirname(rel), m[1]!)).split(sep).join("/"));
      g.set(rel, [...new Set(deps)]);
    }
  };
  walk(root);
  return g;
}

/**
 * `web/` is walked too, and that is not symmetry for its own sake.
 *
 * The blank-page failure this test exists for SHIPPED IN THE WEB APP, and until
 * 2026-08-26 this walked `src` only — so the guard covered the tree where the bug had
 * never happened and skipped the one where it had. `web/app.js` and `web/shared.js`
 * were in a live cycle the whole time, safe only because `shared.js` touched the
 * imported bindings inside method bodies; `web/core.js` now sits below both.
 *
 * Same graph, different extension: the web app is plain `.js` the browser loads
 * directly, so there is no build step and the import specifiers are the real ones.
 */
const cyclesIn = (g: Map<string, string[]>): string[] => {
  const seen = new Set<string>(), stack: string[] = [], cycles = new Set<string>();
  const walk = (n: string) => {
    if (stack.includes(n)) { cycles.add([...stack.slice(stack.indexOf(n)), n].join(" -> ")); return; }
    if (seen.has(n)) return;
    seen.add(n);
    stack.push(n);
    for (const d of g.get(n) ?? []) walk(d);
    stack.pop();
  };
  for (const n of g.keys()) walk(n);
  return [...cycles];
};

test("no import cycles among web modules", () => {
  const g = moduleGraph("web", ".js");
  // The app is three modules and would be three if a page split landed badly, so the
  // floor is low on purpose — it is here to catch the walk finding NOTHING, which is
  // how a directory rename empties this test while leaving it green.
  assert.ok(g.size >= 3, `expected the web app, found ${g.size} modules`);
  assert.ok(g.has("core"), "web/core.js is the dependency-free half — if it is gone, so is the split");
  assert.deepEqual(cyclesIn(g), [], "an ES-module cycle in web/ is a BLANK PAGE with nothing in the console");
});

test("no import cycles among src modules", () => {
  const g = moduleGraph("src", ".ts");
  assert.ok(g.size > 20, `expected the source tree, found ${g.size} modules`);

  assert.deepEqual(cyclesIn(g), [], "an ES-module cycle fails silently — break it at the pure half");
});

/**
 * `store.ts` is the storage seam: everything above it calls into it, and it calls
 * only downward. Stated separately from the cycle check because the failure it
 * guards is directional — importing something that imports you back is a cycle,
 * but so is a long chain, and the message should say which rule was broken.
 */
test("nothing store.ts depends on depends on store.ts", () => {
  const g = moduleGraph("src", ".ts");
  const reach = (from: string, seen = new Set<string>()): Set<string> => {
    for (const d of g.get(from) ?? []) if (!seen.has(d)) { seen.add(d); reach(d, seen); }
    return seen;
  };
  const below = reach("store");
  const offenders = [...below].filter((m) => (g.get(m) ?? []).includes("store"));
  assert.deepEqual(offenders, [], "these are below store.ts and reach back into it");
});
