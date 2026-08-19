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

// `loc` offsets are UTF-16 code-unit indices into the parsed source STRING
// (matching node.text), NOT UTF-8 byte offsets. A multi-byte char (em dash, §)
// before an anchor makes the true byte position > the code-unit index, so
// slicing a raw Buffer with `loc` shifts the window left and leaks the tail of
// the preceding line (the `summary>` bug in the flows/diff/anchor code views).
// Guards the string-slice contract at codeFor / codeAt* (ops.ts, diff.ts).
test("loc slices the parsed string, not raw UTF-8 bytes (multi-byte safe)", async () => {
  const src = [
    "/// <summary>",
    "/// NACHA builder — em dash and § before the class (design doc §4).",
    "/// </summary>",
    "public class NachaFileBuilder { }",
  ].join("\n");
  const a = (await indexBlob(src, "N.cs")).find((x) => x.symbolPath.join(".").endsWith("NachaFileBuilder"));
  assert.ok(a?.loc, "class anchor should have a loc");

  const strSlice = src.slice(a!.loc!.startByte, a!.loc!.endByte);
  assert.ok(strSlice.startsWith("public class NachaFileBuilder"), `string slice starts at the class, got: ${JSON.stringify(strSlice.slice(0, 20))}`);

  // The raw-buffer slice (the old bug) drifts by the multi-byte overhead and does NOT.
  const bufSlice = Buffer.from(src, "utf8").subarray(a!.loc!.startByte, a!.loc!.endByte).toString("utf8");
  assert.ok(!bufSlice.startsWith("public class"), "raw-buffer slice must drift here — proves the string slice is load-bearing");
});

test("parsers are reused per grammar — a Parser per file leaked the wasm heap", async () => {
  // `Parser` and `Tree` are wasm-heap allocations the JS collector never touches.
  // Minting a Parser per file and dropping every Tree on the floor made a process
  // that indexed a couple of large C# trees die on a bare `Aborted()` out of wasm —
  // reachable by `serve.js` and the MCP server, which snapshot commits on demand.
  // (The e2e suite is the end-to-end regression test; this pins the mechanism,
  // because the leak scales with TREE SIZE and small sources never reproduce it.)
  const { parserForPath } = await import("./grammars.js");
  const a = await parserForPath("a.cs");
  const b = await parserForPath("b.cs");
  const ts = await parserForPath("x.ts");
  assert.ok(a && b && ts);
  assert.equal(a!.parser, b!.parser, "the same grammar must hand back the same parser");
  assert.notEqual(a!.parser, ts!.parser, "different grammars need different parsers");

  // and the cached parser stays usable after a tree taken from it has been deleted
  assert.ok((await indexBlob("public class A { void B() {} }", "a.cs")).length > 0);
  assert.ok((await indexBlob("public class C { void D() {} }", "c.cs")).length > 0);
});
