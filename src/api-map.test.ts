/**
 * `web/core.js` carries an `ApiMap` typedef saying what each GET route returns,
 * which is what makes `api()` typed at every call site. It is DERIVED from the
 * route table in `serve.ts` and lives in another file, so it can fall behind.
 *
 * Falling behind is quiet in the worst way: a route missing from the map makes
 * `api('/api/whatever')` a compile error at a call site that is perfectly
 * correct, which trains people to widen the map with `any` to make it stop.
 *
 * This is the check that keeps the map honest, and the only reason it is safe to
 * maintain by hand.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

/** Route names from the GET dispatcher in serve.ts. */
function servedRoutes(): string[] {
  const src = readFileSync("src/serve.ts", "utf8");
  const start = src.indexOf("async function api(path: string, q: URLSearchParams)");
  assert.ok(start > 0, "could not find the GET dispatcher in serve.ts");
  const body = src.slice(start, src.indexOf("\n    default:", start));
  return [...body.matchAll(/\n    case "(\/api\/[^"]+)":/g)].map((m) => m[1]!);
}

/** Keys of the ApiMap typedef in web/core.js. */
function mappedRoutes(): string[] {
  const src = readFileSync("web/core.js", "utf8");
  const start = src.indexOf(" * @typedef {{");
  assert.ok(start > 0, "could not find the ApiMap typedef in web/core.js");
  const body = src.slice(start, src.indexOf("}} ApiMap", start));
  return [...body.matchAll(/'(\/api\/[^']+)':/g)].map((m) => m[1]!);
}

test("every GET route the server serves is typed for the web app", () => {
  const served = servedRoutes(), mapped = new Set(mappedRoutes());
  assert.ok(served.length > 20, `only found ${served.length} routes — the parse is wrong, not the code`);
  const missing = served.filter((r) => !mapped.has(r));
  assert.deepEqual(missing, [], "add these to the ApiMap typedef in web/core.js");
});

test("the ApiMap names no route the server does not serve", () => {
  // The direction that produces a page reading a shape nobody returns.
  const served = new Set(servedRoutes());
  assert.deepEqual(mappedRoutes().filter((r) => !served.has(r)), [], "these routes are gone from serve.ts");
});
