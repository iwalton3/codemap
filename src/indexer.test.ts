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

test("overloads are identified by their parameter types, not by position", async () => {
  // The disambiguator was the overload's ordinal in its scope, which is not an
  // identity: deleting or reordering one renumbered the rest, so each inherited a
  // sibling's anchor id. A diff then reported `Apply(QuoteTicketCreated)` as
  // having "changed" into `Apply(QuoteReleaseCreditStatusUpdated)` and put two
  // unrelated bodies side by side — and reviews, triage and citations key on that
  // id, so they retargeted with it.
  const applies = async (src: string) => {
    const all = await indexBlob(src, "Agg.cs");
    return new Map(all.filter((a) => a.symbolPath.at(-1) === "Apply").map((a) => [a.disambiguator!, a.id]));
  };
  const agg = (...methods: string[]) => `namespace D { public class Agg { ${methods.join(" ")} } }`;
  const m = (evt: string, body: string) => `public void Apply(${evt} e) { ${body} }`;

  const base = await applies(agg(m("OrderCreated", "X(1);"), m("TicketCreated", "Y(2);"), m("OrderClosed", "Z(3);")));
  assert.deepEqual([...base.keys()], ["(OrderCreated)", "(TicketCreated)", "(OrderClosed)"]);

  // one overload swapped for an unrelated one: a removal and an addition, never a change
  const swapped = await applies(agg(m("OrderCreated", "X(1);"), m("CreditStatusUpdated", "W(9);"), m("OrderClosed", "Z(3);")));
  assert.equal(swapped.get("(OrderCreated)"), base.get("(OrderCreated)"));
  assert.equal(swapped.get("(OrderClosed)"), base.get("(OrderClosed)"), "the overload AFTER the swap keeps its identity");
  assert.equal([...swapped.values()].includes(base.get("(TicketCreated)")!), false, "the deleted overload's id is not reused");

  // reordering is a line-move, and an id is documented as stable across those
  const reordered = await applies(agg(m("OrderClosed", "Z(3);"), m("TicketCreated", "Y(2);"), m("OrderCreated", "X(1);")));
  for (const k of base.keys()) assert.equal(reordered.get(k), base.get(k), `${k} moved but is the same method`);

  // deleting an earlier overload does not renumber the later ones
  const fewer = await applies(agg(m("TicketCreated", "Y(2);"), m("OrderClosed", "Z(3);")));
  assert.equal(fewer.get("(TicketCreated)"), base.get("(TicketCreated)"));
  assert.equal(fewer.get("(OrderClosed)"), base.get("(OrderClosed)"));
});

test("a parameter rename is not a new method, but a type change is", async () => {
  const ids = async (src: string) => (await indexBlob(src, "A.cs"))
    .filter((a) => a.symbolPath.at(-1) === "Apply").map((a) => a.id);
  const agg = (p: string) => `namespace D { public class A { public void Apply(${p}) {} public void Apply(int n) {} } }`;

  assert.deepEqual(await ids(agg("OrderCreated e")), await ids(agg("OrderCreated evt")), "the parameter's NAME is not identity");
  assert.notDeepEqual(await ids(agg("OrderCreated e")), await ids(agg("OrderClosed e")), "its type is");
});

test("same-named callables that share a signature still get distinct ids", async () => {
  // Two identical signatures cannot be told apart by signature, and colliding onto
  // one id would be worse than an unstable one — so the ordinal still backs it up.
  const a = await indexBlob("def f(x):\n    return 1\ndef f(x):\n    return 2\n", "m.py");
  const fs = a.filter((x) => x.symbolPath.at(-1) === "f");
  assert.equal(fs.length, 2);
  assert.equal(new Set(fs.map((x) => x.id)).size, 2, "distinct ids");
});

// --- HASH_SCHEME 2: regions and line endings are cosmetic ----------------------

const hashOf = async (src: string, path: string, symbol: string) =>
  (await indexBlob(src, path)).find((a) => a.symbolPath.at(-1) === symbol)?.bodyHash;

test("renaming a #region does not touch the enclosing type's hash", async () => {
  const withA = "namespace N;\npublic class C {\n    #region Billing Info\n    public int X = 1;\n    #endregion\n}\n";
  const withB = withA.replace("Billing Info", "Totally Different Name");
  assert.equal(await hashOf(withA, "C.cs", "C"), await hashOf(withB, "C.cs", "C"));
});

test("adding a #region does not touch the enclosing type's hash either", async () => {
  const bare = "namespace N;\npublic class C {\n    public int X = 1;\n}\n";
  const regioned = "namespace N;\npublic class C {\n    #region Grouping\n    public int X = 1;\n    #endregion\n}\n";
  assert.equal(await hashOf(bare, "C.cs", "C"), await hashOf(regioned, "C.cs", "C"));
});

test("#if is NOT cosmetic — its condition decides what compiles", async () => {
  const dbg = "namespace N;\npublic class C {\n    public int M() {\n#if DEBUG\n        return 1;\n#endif\n        return 2;\n    }\n}\n";
  const stg = dbg.replace("DEBUG", "STAGING");
  assert.notEqual(await hashOf(dbg, "C.cs", "M"), await hashOf(stg, "C.cs", "M"), "a directive that changes the build must change the hash");
});

test("CRLF and LF hash identically inside a multi-line string", async () => {
  // C# verbatim strings (inline SQL), Python triple-quotes, JS template literals and
  // JSX text are all single leaf tokens that span lines and carry their own endings.
  const cs = 'namespace N;\npublic class C {\n    public string Q() {\n        return @"SELECT id\nFROM ledger";\n    }\n}\n';
  assert.equal(await hashOf(cs, "C.cs", "Q"), await hashOf(cs.replace(/\n/g, "\r\n"), "C.cs", "Q"), "C# verbatim string");

  const py = 'def f():\n    return """line one\nline two"""\n';
  assert.equal(await hashOf(py, "m.py", "f"), await hashOf(py.replace(/\n/g, "\r\n"), "m.py", "f"), "Python triple-quote");

  const js = "function g() {\n  return `alpha\nbeta`;\n}\n";
  assert.equal(await hashOf(js, "m.js", "g"), await hashOf(js.replace(/\n/g, "\r\n"), "m.js", "g"), "JS template literal");
});

test("a real edit inside a multi-line string still flips the hash", async () => {
  // The guard against over-stripping: CR goes, content does not.
  const a = 'namespace N;\npublic class C {\n    public string Q() {\n        return @"SELECT id\nFROM ledger";\n    }\n}\n';
  const b = a.replace("FROM ledger", "FROM ledger_v2");
  assert.notEqual(await hashOf(a, "C.cs", "Q"), await hashOf(b, "C.cs", "Q"));
});
