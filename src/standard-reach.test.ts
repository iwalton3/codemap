/**
 * Every op on the standard surface is reachable from the front-end that needs it.
 *
 * `ops-reach.test.ts` does this for `ops-shared.ts` and stops there, so the standard —
 * the newest and largest op surface in the tree — had no such sweep at all. What that
 * cost, measured by writing this file: **the browser carried seven of the twenty-eight
 * reads and two of the five acts only a PRINCIPAL can perform.** The hub reported six
 * queue counts a person could not open, and `adjudicate` — the human act the whole loop
 * is built around, and one an agent is structurally forbidden — had nowhere to happen.
 *
 * That is the same hole, one level up, that put this surface on the web in the first
 * place: *"`mcp.ts` has carried the whole surface since it was built and `serve.ts` none
 * of it, which left ratification with nowhere to happen"*. A sweep run once is a sweep
 * that has to be run again; this is the version with a schedule.
 *
 * A TEXT scan for the same reason `ops-reach.test.ts` is one: the drift is a name nobody
 * typed. The exemptions below each carry a reason, and a stale exemption is a failure —
 * an exemption list nobody prunes is how the sweep quietly stops covering anything.
 *
 * **It scans for the CALL, `ops.name(`, and not for the name.** Written the loose way it
 * passed a deliberate mutation: deleting the `adjudicate` handler left the sentence above
 * it explaining why `adjudicate` belongs there, and a bare-name scan was satisfied by the
 * comment mourning the code it had just lost. A sweep a comment can satisfy is a sweep
 * that measures how much was written about an op, not whether it is wired.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { readdirSync } from "node:fs";
import { join } from "node:path";

const ops = (() => {
  const src = readFileSync("src/ops/standard.ts", "utf8");
  return [
    ...[...src.matchAll(/^export (?:async )?function (\w+)/gm)].map((m) => m[1]!),
    ...[...src.matchAll(/^export const (\w+)\s*=/gm)].map((m) => m[1]!),
  ];
})();

const mcp = readFileSync("src/mcp.ts", "utf8");
const serve = readFileSync("src/serve.ts", "utf8");
/**
 * Every web module, `core.js` included — but only ever searched for the CALL form.
 *
 * `core.js` was excluded at first, because it holds the ApiMap and that names every route by
 * definition: a check for the bare string was satisfied by the declaration of the thing it
 * was checking for. Tightening the matcher to `api('…'` is what made the exclusion
 * unnecessary, and then wrong — `attestedPost` is a real fetcher that lives in `core.js`,
 * and excluding the file reported its route as an orphan. The narrower question is the one
 * worth asking of every file, rather than the broad question of a chosen few.
 */
const pages = readdirSync("web").filter((f) => f.endsWith(".js"))
  .map((f) => readFileSync(join("web", f), "utf8")).join("\n");

/** Is the op CALLED here — `ops.x(` or `shared.x(` — rather than merely mentioned? */
const calls = (hay: string, op: string) => new RegExp(`\\b(?:ops|shared)\\.${op}\\(`).test(hay);

/**
 * Ops the WEB may skip, and why. Everything else must be reachable from a browser.
 *
 * The rule these follow: an op is exempt when the browser already reaches the same
 * information or the same act by another name, or when it is an AGENT's act that a person
 * has no occasion to perform by hand. It is NOT exempt merely because MCP has it — that
 * reasoning is what left ratification agent-only.
 */
const WEB_EXEMPT: Record<string, string> = {
  // Rolled into a composite read the browser does call. The op stays exported because MCP
  // offers each one individually, where a narrow read is cheaper than a page's worth.
  pendingSpecs: "in `standardQueues`",
  promotableAudits: "in `standardQueues`",
  awaitingAdjudication: "in `standardQueues`",
  actionableProblems: "in `standardQueues`",
  settledWithoutAdjudication: "in `standardQueues`",
  dueForRevalidation: "in `standardQueues`",
  auditQueue: "in `standardHealth`",
  scrubPlan: "in `standardHealth`",
  baselinePlan: "in `standardHealth`",
  brokenPins: "in `standardHealth`",
  weakAssertions: "in `standardHealth`",
  criteriaSummary: "in `getRequirement` — the dossier is one read",
  populationFor: "in `getRequirement`",
  scrubsFor: "in `getRequirement`",
  pointersFor: "in `getRequirement`",
  auditsFor: "in `getRequirement`",
  listAcknowledgements: "in `getRequirement`",
  listProblems: "in `getRequirement` and `standardQueues`",
  provisionalAudits: "reached by route, and rolled into `getRequirement`",

  // AGENT acts. A person may of course do these, but not by hand in a browser: each is
  // the output of reading code, and a form that invites one invites it unevidenced.
  // `acknowledgeGap` is the odd one and belongs here for a different reason — it is minted
  // against a DRAFT operation, and the ratifier's power over it is refusal, which the spec
  // page already gives them.
  recordAudit: "an agent act — it is the product of reading code, not of a form",
  raiseProblem: "an agent act — the finding comes with the audit that found it",
  declarePointer: "an agent act",
  restatePointer: "an agent act",
  retirePointer: "an agent act",
  pinPopulation: "an agent act — a pin is a lint's output",
  declareNotExpressible: "an agent act",
  recordVacuityCheck: "an agent act — a demonstration is something that was run",
  draftSpec: "an agent act — proposing is what an agent is for; disposing is the person's",
  addOperation: "an agent act",
  acknowledgeGap: "minted against a draft operation; the ratifier's power over it is refusal, which the spec page has",
  setScrubPolicy: "a policy an agent sets and the plan renders; no browser form yet",
};

/** Ops MCP may skip. Ratification is the shape of the whole list: an agent cannot. */
const MCP_EXEMPT: Record<string, string> = {
  standardQueues: "a page's worth of rows in one response — MCP offers each queue narrowly",
  standardHealth: "same: MCP offers the five reads individually",
  ratifySpec: "PRINCIPAL only — the MCP agent latch is a ratchet, so this is the browser's",
  withdrawSpec: "PRINCIPAL only",
  reorganizeRequirement: "PRINCIPAL only",
  adjudicate: "PRINCIPAL only",
  acknowledgeDebt: "PRINCIPAL only",
  releaseAcknowledgement: "open to any actor, but it is the reader of the queue who notices",
};

test("the standard surface has more than a handful of ops, or this sweep is vacuous", () => {
  assert.ok(ops.length > 25, `expected the standard API, found ${ops.length}: ${ops.join(", ")}`);
});

test("every read and every principal act on the standard is reachable from a BROWSER", () => {
  const missing = ops.filter((op) => !WEB_EXEMPT[op] && !calls(serve, op));
  assert.deepEqual(
    missing, [],
    "these are unreachable from the web UI. Wire them into `serve.ts` and a page, or add an "
    + "exemption above SAYING WHY — and 'MCP has it' is not a why: that is the reasoning that "
    + "left ratification with nowhere to happen.",
  );
});

test("every op an agent may perform is reachable from MCP", () => {
  const missing = ops.filter((op) => !MCP_EXEMPT[op] && !calls(mcp, op));
  assert.deepEqual(missing, [], "wire these into the MCP tool table, or exempt them with a reason");
});

/**
 * A stale exemption is a failure, not a harmless leftover.
 *
 * An exemption names an op; when the op is renamed or deleted the entry stops matching
 * anything and the list silently shrinks in coverage while looking the same size. That is
 * how an allowlist stops being a decision and becomes a habit.
 */
/**
 * A route nothing fetches is not on the web either.
 *
 * `serve.ts` calling an op is half of it; the other half is a page asking for the route.
 * Both halves shipped separately here — the routes went in before the pages — and a route
 * with no page is exactly the shape of the gap this file exists to catch, one layer out.
 */
test("every /api/standard route is fetched by a page", () => {
  const routes = [...serve.matchAll(/case "(\/api\/standard[^"]*)":/g)].map((m) => m[1]!);
  assert.ok(routes.length > 5, `expected the standard routes, found ${routes.length}`);
  // The CALL, `api('...')`, not the string. Same lesson as `calls` above, one layer out.
  const orphans = routes.filter((r) => !pages.includes(`api('${r}'`));
  assert.deepEqual(orphans, [], "no page fetches these — wire them into a page or drop the route");
});

/**
 * A POST act is a STRING on both sides, and nothing typed has ever compared the two.
 *
 * The GET sweep above reads `case "/api/standard/…":`; the write surface is not a `case`
 * at all but a chain of `if (act === "…")` inside one handler, so it was outside every
 * check in this file. A rename or a typo on either side is silent in both directions: the
 * server answers `no such action "…"` — a 200 with an error body, which the page renders as
 * a refusal indistinguishable from a real one — and a dispatch nobody posts to is a verb
 * that exists and cannot be performed, which is the hole this whole file was written for.
 *
 * Scoped to `web/standard.js` because that is this surface's page module; the two GET
 * scans above already cover the rest of `web/`.
 */
const SERVER_ACTS = [...serve.matchAll(/act === "([a-z_]+)"/g)].map((m) => m[1]!);
const PAGE = readFileSync("web/standard.js", "utf8");
/** Routes the page GETs, so a shared path literal is not mistaken for a write. */
const PAGE_GETS = new Set([...PAGE.matchAll(/\bapi\(\s*'\/api\/standard\/?([a-z_]*)'/g)].map((m) => m[1]!));
/**
 * The act names the page actually POSTs. Three call shapes, because the surface has three:
 * a literal path (the hub's queue acts), the act name as an argument to `loop`/`correct`
 * (the review loop and the correction verbs, which build the path from it), and
 * `this.act('ratify')` on the spec page.
 */
const PAGE_ACTS = new Set([
  ...[...PAGE.matchAll(/'\/api\/standard\/([a-z_]+)'/g)].map((m) => m[1]!).filter((a) => !PAGE_GETS.has(a)),
  ...[...PAGE.matchAll(/\bthis\.(?:loop|correct)\(\s*[^,]+,\s*'([a-z_]+)',/g)].map((m) => m[1]!),
  ...[...PAGE.matchAll(/\bthis\.act\(\s*'([a-z_]+)'\s*\)/g)].map((m) => m[1]!),
]);

/**
 * Acts the server dispatches that no page posts, and why that is not a dead route.
 *
 * `answer` has no reason, and that is the finding rather than an omission: it is recorded
 * here so the next reader sees a decision nobody has made instead of a route nobody has
 * noticed. `no exemption is stale` below stops the entry outliving the route.
 */
const POST_EXEMPT: Record<string, string> = {
  answer: "NO PAGE POSTS IT. The standard's threads RENDER answers and offer no composer — "
    + "answering a note happens on the shared-findings surface — so this route is currently "
    + "unreachable from a browser. Wire a composer into `thread()` or drop the route.",
};

test("every act the server dispatches is one a page can actually post", () => {
  assert.ok(SERVER_ACTS.length > 10, `expected the standard's write surface, found ${SERVER_ACTS.length}`);
  const unreachable = SERVER_ACTS.filter((a) => !POST_EXEMPT[a] && !PAGE_ACTS.has(a));
  assert.deepEqual(unreachable, [], "no page posts these — wire them into a page, or exempt them with a reason");
});

test("every act a page posts is one the server dispatches", () => {
  assert.ok(PAGE_ACTS.size > 10, `expected the page's write calls, found ${PAGE_ACTS.size}`);
  const dead = [...PAGE_ACTS].filter((a) => !SERVER_ACTS.includes(a));
  assert.deepEqual(dead, [], "these buttons POST an action the server does not dispatch — it answers "
    + "`no such action`, which the page renders as an ordinary refusal");
});

test("no POST exemption names an act that no longer exists", () => {
  for (const [name, why] of Object.entries(POST_EXEMPT)) {
    assert.ok(SERVER_ACTS.includes(name), `"${name}" (${why}) is exempted and is not an act any more — drop the entry`);
  }
});

test("no exemption names an op that no longer exists", () => {
  const known = new Set(ops);
  for (const [name, why] of [...Object.entries(WEB_EXEMPT), ...Object.entries(MCP_EXEMPT)]) {
    assert.ok(known.has(name), `"${name}" (${why}) is exempted and is not an op any more — drop the entry`);
  }
});
