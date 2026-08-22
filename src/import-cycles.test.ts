import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

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
function moduleGraph(): Map<string, string[]> {
  const dir = "src";
  const g = new Map<string, string[]>();
  for (const f of readdirSync(dir)) {
    if (!f.endsWith(".ts") || f.endsWith(".test.ts") || f.endsWith(".d.ts")) continue;
    const src = readFileSync(join(dir, f), "utf8");
    // Every spelling: `from "./x.js"`, `await import("./x.js")`, and the bare
    // side-effect `import "./x.js"`. The last one is easy to leave out and is the
    // one a cycle can hide behind — an earlier version of this test did, and
    // silently passed a probe that reintroduced the exact cycle it exists for.
    const deps = [...src.matchAll(/(?:\bfrom\s*|\bimport\s*\(?\s*)"\.\/([\w-]+)\.js"/g)].map((m) => m[1]!);
    g.set(f.replace(/\.ts$/, ""), [...new Set(deps)]);
  }
  return g;
}

test("no import cycles among src modules", () => {
  const g = moduleGraph();
  assert.ok(g.size > 20, `expected the source tree, found ${g.size} modules`);

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

  assert.deepEqual([...cycles], [], "an ES-module cycle fails silently — break it at the pure half");
});

/**
 * `store.ts` is the storage seam: everything above it calls into it, and it calls
 * only downward. Stated separately from the cycle check because the failure it
 * guards is directional — importing something that imports you back is a cycle,
 * but so is a long chain, and the message should say which rule was broken.
 */
test("nothing store.ts depends on depends on store.ts", () => {
  const g = moduleGraph();
  const reach = (from: string, seen = new Set<string>()): Set<string> => {
    for (const d of g.get(from) ?? []) if (!seen.has(d)) { seen.add(d); reach(d, seen); }
    return seen;
  };
  const below = reach("store");
  const offenders = [...below].filter((m) => (g.get(m) ?? []).includes("store"));
  assert.deepEqual(offenders, [], "these are below store.ts and reach back into it");
});
