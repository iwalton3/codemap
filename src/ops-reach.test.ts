import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

/**
 * Every op the sidecar exposes must be reachable from something.
 *
 * `ops-shared.ts` is the whole API of the shared half, and `mcp.ts`, `serve.ts`
 * and `cli.ts` are the three front-ends over it — plus `ops.ts`, for the mirrors
 * that hang off a local write rather than off a request. An exported op named in
 * none of them is not "internal": it is a feature with a dead half, and the
 * failure is invisible because the LIVE half keeps answering.
 *
 * That is exactly how `posted` went missing. `inboundReplies` was wired into all
 * three front-ends and `recordPublished`, the only thing that writes the field it
 * reads, into none — so pulling the submitter's replies back always answered
 * "nothing from here has been published to the pull request", correctly, forever.
 * The same shape had eaten `shareDoc` and `shareWalkthrough`: their readers were
 * exposed, so shared walkthroughs could be listed but never created.
 *
 * A text scan rather than an import graph because that is what the drift is —
 * a name nobody typed. `src/api-map.test.ts` guards the GET routes the same way.
 */
test("every exported shared op is reachable from a front-end", () => {
  const src = readFileSync("src/ops-shared.ts", "utf8");
  const ops = [...src.matchAll(/^export (?:async )?function (\w+)/gm)].map((m) => m[1]!);
  assert.ok(ops.length > 20, `expected the shared API, found ${ops.length} ops`);

  // `src/ops.ts` is a barrel; the mirrors that hang off a local write live in the
  // modules under it, so the scan has to reach them or every one reads as orphaned.
  const callers = ["src/serve.ts", "src/mcp.ts", "src/cli.ts", "src/ops.ts",
    ...readdirSync("src/ops").map((f) => join("src/ops", f))]
    .map((f) => readFileSync(f, "utf8")).join("\n");

  const orphans = ops.filter((op) => !new RegExp(`\\b${op}\\b`).test(callers));
  assert.deepEqual(orphans, [], "wire these to a front-end, or delete them");
});
