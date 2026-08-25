/**
 * The HTTP write routes, exercised over a real server.
 *
 * The UI suite renders pages; it never POSTs. That gap let a helper declared
 * mid-handler ship — two of its three call sites were above the declaration, so
 * handing a finding to an agent died on "Cannot access 'withAnchorAnnotations'
 * before initialization". No unit test can see that: the bug is in the wiring, not
 * in any op. These call every write route the review loop uses and assert the
 * contract each one owes its caller.
 *
 * Needs a server but no browser, so unlike the UI suite it never skips.
 */

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { makeFixture, startServer, type Server, type Fixture } from "./harness.js";
import { readAnchorStore } from "../store.js";
import { annotateLegacyFinding } from "../ops/annotations.js";

/**
 * Seed a legacy finding-ANNOTATION in process.
 *
 * `/api/annotate` refuses findings now — `report_defect` is the create verb, and a
 * finding filed as an annotation is a local record with no pull request. The lifecycle
 * below (assign, resolve, escalate, revise, withdraw) still runs on annotation-findings
 * that predate that, so it still needs covering; only the CREATE path moved.
 */
const seedFinding = (root: string, input: Record<string, unknown>) =>
  annotateLegacyFinding(root, input as never) as Promise<any>;

describe("HTTP write routes", () => {
  let fixture: Fixture, server: Server, u: string, anchorId: string;

  before(async () => {
    fixture = await makeFixture();
    server = await startServer(fixture.root);
    u = fixture.universe;
    anchorId = (await readAnchorStore(fixture.root)).anchors[0]!.id;
  });
  after(() => { server?.stop(); fixture?.cleanup(); });

  const post = async (path: string, body: Record<string, unknown>) => {
    const r = await fetch(`${server.url}${path}`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ u, ...body }),
    });
    assert.equal(r.status, 200, `${path} returned ${r.status}`);
    return r.json() as Promise<any>;
  };

  test("raising a finding reports the anchor it landed on and that anchor's findings", async () => {
    // A POINTER, not a finding: what is under test is the ROUTE's response shape, and
    // `/api/annotate` refuses findings now — see `seedFinding`.
    const out = await post("/api/annotate", {
      targetKind: "anchor", targetId: anchorId, text: "negative amounts are only guarded here",
      comment: "`transfer` guards negatives at pay.ts:2 only. Add the same check on the by-id path.",
      kind: "pointer", severity: "high", author: "human", line: 2,
    });
    assert.ok(!out.error, out.error);

    const refusedKind = await post("/api/annotate", {
      targetKind: "anchor", targetId: anchorId, text: "x", comment: "y", kind: "finding", author: "human",
    });
    assert.match(refusedKind.error, /no longer files findings/, "the HTTP tap is shut too, not just MCP");
    assert.deepEqual(out.target, { kind: "anchor", id: anchorId });
    assert.ok(Array.isArray(out.annotations) && out.annotations.length >= 1,
      "the caller needs the anchor's findings back to refresh one symbol");
  });

  test("handing a finding to an agent does the same", async () => {
    // The route that broke: it sits ABOVE the helper's old declaration.
    const raised = await seedFinding(fixture.root, {
      targetKind: "anchor", targetId: anchorId, text: "check the rounding mode", comment: "rounds half-up; the ledger rounds half-even", author: "human",
    });
    const out = await post("/api/annotation_assign", { id: raised.id, kind: "investigate", by: "me" });
    assert.ok(!out.error, out.error);
    assert.deepEqual(out.target, { kind: "anchor", id: anchorId });
    assert.ok(out.annotations.find((a: any) => a.id === raised.id)?.assignment, "the handoff is in the returned findings");
  });

  test("resolving and raising to the maintainer report the same shape", async () => {
    const mine = await seedFinding(fixture.root, {
      targetKind: "anchor", targetId: anchorId, text: "mine", comment: "mine", author: "human",
    });
    const resolved = await post("/api/annotation_resolve", { id: mine.id, resolved: true });
    assert.ok(!resolved.error, resolved.error);
    assert.ok(resolved.annotations.find((a: any) => a.id === mine.id)?.resolved);

    // a human's own finding is already theirs to publish
    const refused = await post("/api/annotation_escalate", { id: mine.id });
    assert.ok(refused.error, "electing your own finding is refused, not silently recorded");

    const theirs = await seedFinding(fixture.root, {
      targetKind: "anchor", targetId: anchorId, text: "agent thinks this overflows",
      comment: "an agent's proposal", author: "agent:pr-first-pass",
    });
    const raised = await post("/api/annotation_escalate", { id: theirs.id, by: "izzie" });
    assert.ok(!raised.error, raised.error);
    assert.ok(raised.annotations.find((a: any) => a.id === theirs.id)?.escalated, "raised, and visible in the refresh");
  });

  test("a finding on a symbol only the branch has still comes back with its source", async () => {
    // Findings ingested against a pull request are written against the PR HEAD's
    // anchors, so one on a symbol the branch ADDS has no `@work` row — and the queue
    // handed the agent an item with no file, no symbol and no source, which is
    // exactly the hunting this surface promises it will not have to do.
    const { writeSnapshot } = await import("../store.js");
    const { indexBlob } = await import("../repo.js");
    const src = "export function onlyOnTheBranch(cents: number) {\n  return cents * 2;\n}\n";
    const branchAnchors = await indexBlob(src, "src/branch-only.ts");
    const id = branchAnchors[0]!.id;
    await writeSnapshot(fixture.root, "prhead", "feature/x", branchAnchors, "2026-08-19T00:00:00Z");

    const raised = await seedFinding(fixture.root, {
      targetKind: "anchor", targetId: id, text: "overflows", comment: "sums into an int32", author: "human", ref: "prhead",
    });
    assert.ok(!raised.error, raised.error);
    await post("/api/annotation_assign", { id: raised.id, kind: "investigate", by: "me" });

    const q = await (await fetch(`${server.url}/api/queue?u=${u}`)).json() as any;
    const item = q.queue.find((x: any) => x.id === raised.id);
    assert.ok(item, "the assigned finding is in the queue");
    assert.equal(item.file, "src/branch-only.ts", "with the file it lives in");
    assert.match(item.symbol, /onlyOnTheBranch/);
    assert.equal(item.atCommit, "prhead", "and it says the body is the branch's, not HEAD's");
    // The source itself needs that commit's objects, which a synthetic snapshot in a
    // fixture repo does not have — what this pins is that the item is LOCATED at all,
    // which is what was missing.
  });

  test("a finding must carry the version its submitter reads", async () => {
    // The UI raises findings through this route, so the requirement has to hold at
    // the wiring and not only in ops — and the message has to say what to do.
    // The duty moved with the verb: `/api/defect` raises findings now, so that is where
    // the requirement has to hold at the wiring rather than only in ops.
    const bare = await post("/api/defect", {
      context: { kind: "pull_request", pr: "1" },
      targetKind: "anchor", targetId: anchorId, text: "no tenant predicate",
    });
    assert.match(bare.error, /needs `comment`/);

    const long = await post("/api/defect", {
      context: { kind: "pull_request", pr: "1" },
      targetKind: "anchor", targetId: anchorId, text: "x", comment: "y".repeat(801),
    });
    assert.match(long.error, /cap is 800/);
  });

  test("a finding can be corrected, withdrawn, and taken back", async () => {
    const raised = await seedFinding(fixture.root, {
      targetKind: "anchor", targetId: anchorId, text: "the evidence", comment: "the short version",
      severity: "high", author: "human",
    });
    const found = (out: any) => out.annotations.find((a: any) => a.id === raised.id);

    const revised = await post("/api/annotation_revise", {
      id: raised.id, comment: "The by-id path is reachable only with the operator claim, so this leaks existence, not data.", disposition: "rerated", publishPath: "src/pay.ts",
    });
    assert.ok(!revised.error, revised.error);
    assert.equal(found(revised).disposition, "rerated");
    assert.equal(found(revised).publishPath, "src/pay.ts");
    assert.equal(found(revised).comment, "The by-id path is reachable only with the operator claim, so this leaks existence, not data.");
    assert.equal(found(revised).revisions.length, 1, "and what it used to say survives");
    assert.equal(found(revised).revisions[0].was.comment, "the short version");

    const gone = await post("/api/annotation_withdraw", { id: raised.id });
    assert.equal(found(gone).withdrawn.by, "human");
    assert.equal(found(gone).resolved, false, "withdrawn is not closed");

    const back = await post("/api/annotation_withdraw", { id: raised.id, withdraw: false });
    assert.equal(found(back).withdrawn, undefined);
  });

  test("the push plan is a POST, so a long summary cannot break the request", async () => {
    // It travelled as a query parameter, and a few paragraphs URL-encoded approaches
    // Node's 16KB header limit — failing exactly when someone has just written
    // something they care about. This is 8KB of summary through the real server.
    const summary = "Overall this looks right, but see the notes.\n".repeat(180);
    assert.ok(summary.length > 8000, "the fixture has to be big enough to matter");
    const out = await post("/api/pr/push_plan", { pr: "999999", summary, event: "REQUEST_CHANGES" });
    // The fixture has no GitHub remote, so the PLAN fails — on the pull request, not
    // on the transport. A 431/dropped connection would have thrown in `post`.
    assert.ok(out.error, "expected a PR-resolution error, not a transport one");
    assert.doesNotMatch(String(out.error), /header|431|too large/i);
  });

  test("the resolve-sync routes are reachable and fail on the pull request, not the wiring", async () => {
    // Three POST routes added at once behind one `startsWith` prefix check — the last
    // time a route was added without a test that exercised it, the handler existed and
    // the dispatch did not.
    for (const path of ["/api/pr/resolve_plan", "/api/pr/resolve_push", "/api/pr/resolve_pull"]) {
      const out = await post(path, { pr: "999999" });
      assert.ok(out.error, `${path} should reach the PR lookup`);
      assert.doesNotMatch(String(out.error), /unknown route|not found/i, `${path} is not dispatched`);
    }
  });

  test("the queue can list beyond the assignment queue over HTTP", async () => {
    const raised = await seedFinding(fixture.root, {
      targetKind: "anchor", targetId: anchorId, text: "e", comment: "unassigned but real",
      author: "human",
    });
    assert.ok(!raised.error, raised.error);
    const assigned = await (await fetch(`${server.url}/api/queue?u=${u}`)).json() as any;
    assert.equal(assigned.queue.find((q: any) => q.id === raised.id), undefined, "not in the assignment queue");
    const all = await (await fetch(`${server.url}/api/queue?u=${u}&all=1`)).json() as any;
    assert.ok(all.queue.find((q: any) => q.id === raised.id), "but findable in the full list");
  });

  test("a review write hands back the resulting mark", async () => {
    const out = await post("/api/review", { targetKind: "anchor", targetId: anchorId, level: "code", attestation: "signed" });
    assert.ok(!out.error, out.error);
    assert.equal(out.mark?.reviewed, true, "so the walkthrough can update one symbol instead of reloading the story");

    const back = await post("/api/review", { targetKind: "anchor", targetId: anchorId, level: "code", attestation: "signed", unmark: true });
    assert.equal(back.mark?.reviewed, false);
  });
});
