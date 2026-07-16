import { test } from "node:test";
import assert from "node:assert/strict";
import { indexBlob } from "./repo.js";

// Anchoring of exported const bindings (the Acme.React config-file gap):
// `export const x = {…} | new X() | factory(…)` should anchor; scalars and
// non-exported consts should not.
test("TS: exported significant const bindings are anchored as `variable`", async () => {
  const src = `
export const cacheStrategies = { fresh: 0, stale: 5 };
export const queryClient = new QueryClient({ retry: 3 });
export const Route = createFileRoute("/app")({ component: Page });
export const ROUTES = ["a", "b"];
export const API_URL = "https://x";          // scalar → skip
const internalConfig = { secret: 1 };        // not exported → skip
export const handler = () => doThing();      // arrow → function anchor (existing)
`;
  const anchors = await indexBlob(src, "config.ts");
  const byName = new Map(anchors.map((a) => [a.symbolPath.join("."), a]));

  for (const name of ["cacheStrategies", "queryClient", "Route", "ROUTES"]) {
    assert.ok(byName.has(name), `expected an anchor for exported const ${name}`);
    assert.equal(byName.get(name)!.kind, "variable", `${name} should be kind "variable"`);
  }
  assert.ok(byName.has("handler"), "arrow-function const still anchored");
  assert.equal(byName.get("handler")!.kind, "function");

  assert.ok(!byName.has("API_URL"), "scalar export should not anchor");
  assert.ok(!byName.has("internalConfig"), "non-exported const should not anchor");
});

test("TS: `as const` initializer is unwrapped and anchored", async () => {
  const anchors = await indexBlob(`export const cfg = { a: 1 } as const;`, "c.ts");
  const cfg = anchors.find((a) => a.symbolPath.join(".") === "cfg");
  assert.ok(cfg, "as-const object export should anchor");
  assert.equal(cfg!.kind, "variable");
});

test("TS: editing an anchored config object flips its hash", async () => {
  const a = await indexBlob(`export const cfg = { retry: 3 };`, "c.ts");
  const b = await indexBlob(`export const cfg = { retry: 9 };`, "c.ts");
  const ha = a.find((x) => x.symbolPath.join(".") === "cfg")!.bodyHash;
  const hb = b.find((x) => x.symbolPath.join(".") === "cfg")!.bodyHash;
  assert.notEqual(ha, hb, "a config change should change the anchor hash");
});
