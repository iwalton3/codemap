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
    const out = await post("/api/annotate", {
      targetKind: "anchor", targetId: anchorId, text: "negative amounts are only guarded here",
      kind: "finding", severity: "high", author: "human", line: 2,
    });
    assert.ok(!out.error, out.error);
    assert.deepEqual(out.target, { kind: "anchor", id: anchorId });
    assert.ok(Array.isArray(out.annotations) && out.annotations.length >= 1,
      "the caller needs the anchor's findings back to refresh one symbol");
  });

  test("handing a finding to an agent does the same", async () => {
    // The route that broke: it sits ABOVE the helper's old declaration.
    const raised = await post("/api/annotate", {
      targetKind: "anchor", targetId: anchorId, text: "check the rounding mode", kind: "finding", author: "human",
    });
    const out = await post("/api/annotation_assign", { id: raised.id, kind: "investigate", by: "me" });
    assert.ok(!out.error, out.error);
    assert.deepEqual(out.target, { kind: "anchor", id: anchorId });
    assert.ok(out.annotations.find((a: any) => a.id === raised.id)?.assignment, "the handoff is in the returned findings");
  });

  test("resolving and raising to the maintainer report the same shape", async () => {
    const mine = await post("/api/annotate", {
      targetKind: "anchor", targetId: anchorId, text: "mine", kind: "finding", author: "human",
    });
    const resolved = await post("/api/annotation_resolve", { id: mine.id, resolved: true });
    assert.ok(!resolved.error, resolved.error);
    assert.ok(resolved.annotations.find((a: any) => a.id === mine.id)?.resolved);

    // a human's own finding is already theirs to publish
    const refused = await post("/api/annotation_escalate", { id: mine.id });
    assert.ok(refused.error, "electing your own finding is refused, not silently recorded");

    const theirs = await post("/api/annotate", {
      targetKind: "anchor", targetId: anchorId, text: "agent thinks this overflows",
      kind: "finding", author: "agent:pr-first-pass",
    });
    const raised = await post("/api/annotation_escalate", { id: theirs.id, by: "izzie" });
    assert.ok(!raised.error, raised.error);
    assert.ok(raised.annotations.find((a: any) => a.id === theirs.id)?.escalated, "raised, and visible in the refresh");
  });

  test("a review write hands back the resulting mark", async () => {
    const out = await post("/api/review", { targetKind: "anchor", targetId: anchorId, level: "code", attestation: "signed" });
    assert.ok(!out.error, out.error);
    assert.equal(out.mark?.reviewed, true, "so the walkthrough can update one symbol instead of reloading the story");

    const back = await post("/api/review", { targetKind: "anchor", targetId: anchorId, level: "code", attestation: "signed", unmark: true });
    assert.equal(back.mark?.reviewed, false);
  });
});
