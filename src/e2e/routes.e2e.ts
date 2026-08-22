/**
 * Every route the app registers, opened in a real browser.
 *
 * The failure this exists for is the one an untyped front end produces most:
 * a page that renders nothing and logs an error nobody is watching. Unit tests
 * cannot see it, and the targeted suites only cover the pages someone thought to
 * write a test for — which was 12 of 23 routes when this was added, missing all
 * three pan/zoom graph views.
 *
 * The route list is READ FROM `web/app.js`, never copied here. A hand-kept list
 * would be complete on the day it was written and quietly stale after that; this
 * way a new route is covered the moment it is registered, and a new *parameter*
 * kind fails loudly rather than being skipped (see `fill`).
 *
 * It asserts almost nothing about content on purpose. It is a smoke test — its
 * job is "this route renders and the console is clean", and the pages that carry
 * real behaviour have their own suites.
 */

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolvePlaywright, launchPlaywright, startServer, makeFixture, type Server, type Fixture } from "./harness.js";

const pw = resolvePlaywright();

/** The route table as the app actually registers it. */
function registeredRoutes(): string[] {
  const src = readFileSync("web/app.js", "utf8");
  const block = src.slice(src.indexOf("enableRouting("));
  const routes = [...block.slice(0, block.indexOf("});")).matchAll(/'(\/[^']*)':\s*\{\s*component:/g)].map((m) => m[1]!);
  assert.ok(routes.length > 5, `could not read the route table out of web/app.js (found ${routes.length})`);
  return routes;
}

describe("every registered route", { skip: pw ? false : "playwright not resolvable (set CODEMAP_E2E_PLAYWRIGHT)" }, () => {
  let fx: Fixture, server: Server, browser: any, universe: string, anchorId: string;

  before(async () => {
    fx = await makeFixture();
    server = await startServer(fx.root);
    browser = await launchPlaywright(pw);
    universe = (await (await fetch(`${server.url}/api/universes`)).json()).primary;
    const { readAnchorStore } = await import("../store.js");
    anchorId = (await readAnchorStore(fx.root)).anchors[0]!.id;
  });

  after(async () => {
    await browser?.close();
    server?.stop();
    fx?.cleanup();
  });

  /**
   * Substitute one route's parameters. An unrecognised parameter THROWS rather
   * than being left in the URL: a route with an unfilled `:param` would 'pass'
   * by rendering an empty state, which is the opposite of coverage.
   */
  function fill(route: string): string {
    return route.replace(/:([a-z]+)\*?/gi, (_m, name: string) => {
      switch (name) {
        case "universe": return universe;
        case "path": return "src";
        // Every `:id` route in the fixture resolves: the anchor page wants an
        // anchor, the node/graph/flow pages want the one documented node.
        case "id": return route.includes("/anchor/") ? anchorId : "n_transfer_flow";
        // A pull request the fixture has no data for. Rendering an empty state
        // cleanly IS the assertion — this is the shape a mistyped URL takes.
        case "pr": return "1";
        default: throw new Error(`route "${route}" has parameter ":${name}" with no fixture value — add one to fill()`);
      }
    });
  }

  for (const route of registeredRoutes()) {
    test(`${route} renders with a clean console`, async () => {
      const page = await browser.newPage();
      const errors: string[] = [];
      page.on("console", (m: any) => { if (m.type() === "error") errors.push(m.text()); });
      page.on("pageerror", (e: Error) => errors.push(e.message));
      try {
        // Hash mode — a path-form deep link falls back to home and would pass here.
        await page.goto(`${server.url}/#${fill(route)}`, { waitUntil: "networkidle" });
        await page.waitForSelector("main", { timeout: 15_000 });
        // A page still on its spinner has not proven anything.
        await page.waitForFunction(() => !document.querySelector("main .loading"), null, { timeout: 15_000 });
        const text = (await page.textContent("main"))?.trim() ?? "";
        assert.ok(text.length > 0, "rendered an empty <main>");
        assert.deepEqual(errors, []);
      } finally {
        await page.close();
      }
    });
  }
});
