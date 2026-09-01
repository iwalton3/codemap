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

/**
 * The POST half, which had no guard at all — and shipped a dead button because of it.
 *
 * `/api/shared/<action>` takes the action from the PATH. `setFindingState` posted to
 * `/api/shared/act` with `action: "close"` in the BODY, which is a shape the server has
 * never accepted: it answered `unknown shared action "act"`, so resolve and reopen on the
 * diff page did nothing for as long as they existed. The GET routes have been guarded
 * since `ApiMap` (above); this is the same drift one verb over, and it is worse, because
 * a GET typo shows an empty page while a POST typo shows a button that looks fine.
 */
function sharedActions(): string[] {
  const src = readFileSync("src/serve.ts", "utf8");
  const start = src.indexOf('url.pathname.startsWith("/api/shared/")');
  assert.ok(start > 0, "could not find the shared POST dispatcher in serve.ts");
  const body = src.slice(start, src.indexOf('default: out = { error: `unknown shared action', start));
  return [...body.matchAll(/\n        case "([a-z_]+)":/g)].map((m) => m[1]!);
}

/**
 * Every `/api/shared/<x>` the web app names literally, GET or POST.
 *
 * Both together, because the prefix is shared: `/api/shared/hub` is a GET route and
 * `/api/shared/sync` is a POST action, and a scan that knew about only one half would
 * report every use of the other as dead. What is being caught is a string matching
 * NEITHER — which is exactly what `act` was.
 */
function sharedUses(): { action: string; where: string }[] {
  const out: { action: string; where: string }[] = [];
  for (const f of ["web/app.js", "web/shared.js", "web/standard.js", "web/core.js"]) {
    const src = readFileSync(f, "utf8");
    // A bare `${...}` segment is a dispatcher variable, not a literal, and is covered by
    // the call sites that supply it — this scan is for the ones spelled out in place.
    for (const m of src.matchAll(/['"`]\/api\/shared\/([a-z_]+)['"`]/g)) out.push({ action: m[1]!, where: f });
  }
  return out;
}

test("every shared action the web app posts to is one the server handles", () => {
  const known = new Set(sharedActions());
  assert.ok(known.size > 10, `only found ${known.size} actions — the parse is wrong, not the code`);
  for (const r of servedRoutes()) {
    if (r.startsWith("/api/shared/")) known.add(r.slice("/api/shared/".length));
  }
  const dead = sharedUses().filter((p) => !known.has(p.action));
  assert.deepEqual(dead, [],
    "these POST to an action serve.ts has no case for — the button will look fine and do nothing");
});
