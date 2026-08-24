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

/**
 * "Reachable from SOMETHING" is not enough for the flows a beta user depends on.
 *
 * The test above passed while six shared ops were CLI-only — and the shape of that gap
 * was not random: everything needed to JOIN a team and to RECOVER from a fork was a
 * terminal command, while day-to-day review was on every surface. So a browser user
 * could work only after somebody ran three publish commands for them, and was stuck in
 * a terminal the first time a writer id forked.
 *
 * Two lists, because the surfaces are deliberately NOT symmetric. Publishing this
 * store's existing state and repairing a fork are person-run: an MCP session is an
 * agent actor, so bulk-publishing a human's legacy marks through it would republish
 * them as agent claims — `likely`, with tripwires dropped, since tripwires are
 * human-only. That is not publication, it is rewriting the record.
 */
const WEB_REQUIRED = [
  "sharedHub", "sharedHeal",
  "publishLocalDocs", "publishLocalNotes", "publishLocalTriage", "publishLocalGraph",
  "sharedTriage", "contestedTriage", "sharedGraph",
];
/** Reads only. An agent must SEE the team's stakes; it may not republish or heal. */
const MCP_REQUIRED = ["sharedTriage", "contestedTriage"];
/** And these must NOT be agent-reachable, for the reason in the note above. */
const MCP_FORBIDDEN = ["sharedHeal", "publishLocalDocs", "publishLocalNotes", "publishLocalTriage", "publishLocalGraph"];

test("the join and recover flows are reachable from the web, not just a terminal", () => {
  const web = readFileSync("src/serve.ts", "utf8");
  for (const op of WEB_REQUIRED) {
    assert.match(
      web, new RegExp(`\\b${op}\\b`),
      `\`${op}\` is not reachable from the web UI. It is one of the JOIN/RECOVER flows, which `
      + `is exactly the set that was terminal-only while every day-to-day op was not.`,
    );
  }
});

test("an agent can read the team's stakes, and cannot republish or heal", () => {
  const mcp = readFileSync("src/mcp.ts", "utf8");
  for (const op of MCP_REQUIRED) {
    assert.match(mcp, new RegExp(`\\b${op}\\b`), `\`${op}\` is a read an agent needs and cannot reach`);
  }
  for (const op of MCP_FORBIDDEN) {
    assert.doesNotMatch(
      mcp, new RegExp(`\\b${op}\\b`),
      `\`${op}\` is reachable from MCP. An MCP session is an AGENT actor, so publishing a human's `
      + `legacy marks through it rewrites them as agent claims and drops their tripwires; healing a `
      + `fork is a person's act by the same rule. If this is deliberate, the note above has to change first.`,
    );
  }
});
