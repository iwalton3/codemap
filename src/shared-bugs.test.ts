/**
 * The bug fold.
 *
 * The lifecycle is `shared-findings.ts`'s and is tested there; what is tested HERE is
 * the three things a bug does differently — a grow-only citation set, a tracking
 * reference that latches per system, and an id derived from the finding it came from —
 * plus the parts of the ratchet a bug reaches through its own event kinds, because the
 * fold is what binds a writer this build did not write.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Actor } from "./schema.js";
import { sortEvents, readScope } from "./eventlog.js";
import {
  anchorBug, bugAckQueue, bugIdFor, bugScope, citedAnchors, commentOnBug, corroborateBug,
  fileBug, foldBugs, isTracked, needsHumanAck, promoteBug, readBugsShared, requestOnBug,
  resolveBugContest, reviseBug, setBugState, trackBug, unanchorBug, witnessesOf,
} from "./shared-bugs.js";
import { discard } from "./test-tmp.js";

const izzie: Actor = { principal: "izzie@x.com" };
const dana: Actor = { principal: "dana@x.com" };
const opus: Actor = { principal: "izzie@x.com", via: { kind: "agent", model: "claude-opus-5" } };
const danasAgent: Actor = { principal: "dana@x.com", via: { kind: "agent", model: "claude-opus-5" } };

const U = "acme/api";
const tmp = () => mkdtempSync(join(tmpdir(), "codemap-sb-"));
const NEW = { title: "negatives are not rejected", text: "transfer() takes a negative amount", anchors: [{ anchorId: "a_1", bodyHash: "sha256:one" }] };
const one = async (root: string) => [...(await readBugsShared(root, U)).values()][0]!;

// --- opening state follows authorship, exactly as a finding's does ---------------

test("a person's bug opens as `created`; an agent's is a proposal", async () => {
  const root = tmp();
  try {
    await fileBug(root, U, izzie, NEW);
    assert.equal((await one(root)).state, "created");
  } finally { discard(root); }
});

test("an agent's bug opens as `issued`, and it records which model filed it", async () => {
  const root = tmp();
  try {
    await fileBug(root, U, opus, NEW);
    const b = await one(root);
    assert.equal(b.state, "issued");
    assert.equal(b.author.via?.model, "claude-opus-5");
  } finally { discard(root); }
});

test("an agent may not close a bug somebody stood behind — the WRITE path says why", async () => {
  const root = tmp();
  try {
    const id = await fileBug(root, U, izzie, NEW);
    await corroborateBug(root, U, dana, id, "confirm", "reproduced it");
    const r = await setBugState(root, U, opus, id, "resolved");
    assert.ok("error" in r && /needs a person/.test(r.error));
    assert.equal((await one(root)).state, "created", "and nothing moved");
  } finally { discard(root); }
});

test("and the FOLD says so too — an event from a client that did not ask is ignored", async () => {
  const root = tmp();
  try {
    const id = await fileBug(root, U, izzie, NEW);
    await promoteBug(root, U, izzie, id);
    // Straight past `setBugState`'s refusal, the way an older or wrong client would.
    await commentOnBug(root, U, opus, id, "closing this");
    const events = sortEvents(await readScope(root, bugScope(U)));
    events.push({
      ...events[0]!, id: "zzz", kind: "bug.stateChanged", actor: opus,
      data: { state: "resolved" }, after: events.map((e) => e.id),
    });
    assert.equal(foldBugs(events).get(id)!.state, "created",
      "the write-time check protects the honest writer and nobody else");
  } finally { discard(root); }
});

// --- citations are a grow-only set, and that is the whole difference from findings ---

test("two people citing different code on one bug keep BOTH citations", async () => {
  const root = tmp();
  try {
    const id = await fileBug(root, U, izzie, NEW);
    await anchorBug(root, U, dana, id, [{ anchorId: "a_2", bodyHash: "sha256:two" }]);
    await anchorBug(root, U, izzie, id, [{ anchorId: "a_3", bodyHash: "sha256:three" }]);
    assert.deepEqual(citedAnchors(await one(root)), ["a_1", "a_2", "a_3"]);
  } finally { discard(root); }
});

test("re-citing an anchor refreshes its witness rather than duplicating it", async () => {
  const root = tmp();
  try {
    const id = await fileBug(root, U, izzie, NEW);
    await anchorBug(root, U, dana, id, [{ anchorId: "a_1", bodyHash: "sha256:moved" }]);
    const b = await one(root);
    assert.equal(b.anchors.length, 1);
    assert.deepEqual(witnessesOf(b), [{ anchorId: "a_1", bodyHash: "sha256:moved" }]);
    assert.equal(b.anchors[0]!.by.principal, "dana@x.com", "and says who last looked");
  } finally { discard(root); }
});

test("a removed citation is a TOMBSTONE, so a concurrent re-add cannot resurrect it", async () => {
  const root = tmp();
  try {
    const id = await fileBug(root, U, izzie, NEW);
    assert.ok(!("error" in (await unanchorBug(root, U, izzie, id, "a_1", "wrong symbol"))));
    await anchorBug(root, U, dana, id, [{ anchorId: "a_1", bodyHash: "sha256:one" }]);
    const b = await one(root);
    assert.deepEqual(citedAnchors(b), [], "still removed");
    assert.equal(b.anchors[0]!.removed?.reason, "wrong symbol", "and the record of why survives");
  } finally { discard(root); }
});

test("an agent may not drop the evidence under a bug", async () => {
  const root = tmp();
  try {
    const id = await fileBug(root, U, izzie, NEW);
    const r = await unanchorBug(root, U, opus, id, "a_1", "looks unrelated");
    assert.ok("error" in r && /a person's call/.test(r.error));
    assert.deepEqual(citedAnchors(await one(root)), ["a_1"]);
  } finally { discard(root); }
});

test("a citation with no witness is not a citation — staleness would be undetectable", async () => {
  const root = tmp();
  try {
    const id = await fileBug(root, U, izzie, NEW);
    await anchorBug(root, U, izzie, id, [{ anchorId: "a_9" } as never]);
    assert.deepEqual(citedAnchors(await one(root)), ["a_1"]);
  } finally { discard(root); }
});

// --- external tracking ----------------------------------------------------------

test("a tracking reference latches per system — the FIRST ticket is the ticket", async () => {
  const root = tmp();
  try {
    const id = await fileBug(root, U, izzie, NEW);
    await trackBug(root, U, izzie, id, { key: "ACME-1", url: "https://jira/ACME-1" });
    await trackBug(root, U, danasAgent, id, { key: "ACME-2" });
    const b = await one(root);
    assert.equal(b.tracking.length, 1);
    assert.equal(b.tracking[0]!.key, "ACME-1", "an agent may not re-point it at another ticket");
    assert.ok(isTracked(b));
  } finally { discard(root); }
});

test("a person may re-point it, and a second SYSTEM is not a conflict", async () => {
  const root = tmp();
  try {
    const id = await fileBug(root, U, izzie, NEW);
    await trackBug(root, U, izzie, id, { key: "ACME-1" });
    await trackBug(root, U, dana, id, { key: "ACME-7" });
    await trackBug(root, U, dana, id, { system: "github", url: "https://github.com/acme/api/issues/3" });
    const b = await one(root);
    assert.deepEqual(b.tracking.map((t) => `${t.system}:${t.key ?? t.url}`),
      ["jira:ACME-7", "github:https://github.com/acme/api/issues/3"]);
  } finally { discard(root); }
});

test("a reference to nowhere is refused by the fold — neither key nor url is not tracking", async () => {
  const root = tmp();
  try {
    const id = await fileBug(root, U, izzie, NEW);
    await trackBug(root, U, izzie, id, { system: "jira" });
    assert.equal(isTracked(await one(root)), false);
  } finally { discard(root); }
});

test("being in a tracker is not being fixed", async () => {
  const root = tmp();
  try {
    const id = await fileBug(root, U, izzie, NEW);
    await trackBug(root, U, izzie, id, { key: "ACME-1" });
    assert.equal((await one(root)).state, "created");
  } finally { discard(root); }
});

// --- accepting a finding --------------------------------------------------------

test("the bug id a finding becomes is derived, so two people converge on ONE bug", async () => {
  const root = tmp();
  try {
    const id = bugIdFor("f_31a");
    assert.equal(id, bugIdFor("f_31a"), "derived, not minted");
    assert.notEqual(id, bugIdFor("f_31b"));

    // Two people accept the same finding offline, each witnessing the code they can see.
    await fileBug(root, U, izzie, { ...NEW, id, from: { pr: 264, finding: "f_31a" } });
    await fileBug(root, U, dana, {
      ...NEW, id, title: "dana's wording",
      anchors: [{ anchorId: "a_2", bodyHash: "sha256:two" }],
      from: { pr: 264, finding: "f_31a" },
    });

    const bugs = await readBugsShared(root, U);
    assert.equal(bugs.size, 1, "one defect, one bug");
    const b = bugs.get(id)!;
    assert.equal(b.title, "negatives are not rejected", "the first filing owns what one person owns");
    assert.deepEqual(citedAnchors(b), ["a_1", "a_2"], "and the citations MERGE — neither is lost");
    assert.deepEqual(b.from, { pr: "264", finding: "f_31a" });
  } finally { discard(root); }
});

test("a published bug carries when it was originally filed, apart from when it reached the team", async () => {
  const root = tmp();
  try {
    await fileBug(root, U, izzie, { ...NEW, filedAt: "2026-01-04T00:00:00Z" });
    const b = await one(root);
    assert.equal(b.filedAt, "2026-01-04T00:00:00Z");
    assert.notEqual(b.createdAt, b.filedAt, "the log's own time is not the publisher's claim");
  } finally { discard(root); }
});

// --- contest, and the queue -----------------------------------------------------

test("two people re-titling one bug without seeing each other CONTESTS it", async () => {
  const root = tmp();
  try {
    const id = await fileBug(root, U, izzie, NEW);
    const events = sortEvents(await readScope(root, bugScope(root ? U : U)));
    await reviseBug(root, U, izzie, id, { severity: "high" });
    // Dana's revision, written without having seen izzie's — a concurrent write, which
    // is what an offline clone produces.
    const all = sortEvents(await readScope(root, bugScope(U)));
    const concurrent = {
      ...all[0]!, id: "z_dana", kind: "bug.revised", actor: dana, writer: "w_dana",
      data: { now: { severity: "low" } }, after: [events[0]!.id],
    };
    const b = foldBugs(sortEvents([...all, concurrent])).get(id)!;
    assert.deepEqual(b.contested?.map((c) => c.field), ["severity"]);
    assert.equal(bugAckQueue([b]).length, 1, "and a contested field is waiting on a person");
  } finally { discard(root); }
});

test("an agent may not settle a disagreement between two people", async () => {
  const root = tmp();
  try {
    const id = await fileBug(root, U, izzie, NEW);
    const r = await resolveBugContest(root, U, opus, id, "severity", "high");
    assert.ok("error" in r && /an agent may not decide it/.test(r.error));
  } finally { discard(root); }
});

test("the ack queue is what needs a person, and a closed bug has left it", async () => {
  const root = tmp();
  try {
    const quiet = await fileBug(root, U, izzie, NEW);
    const asked = await fileBug(root, U, izzie, { ...NEW, title: "second" });
    const done = await fileBug(root, U, izzie, { ...NEW, title: "third" });
    await requestOnBug(root, U, opus, asked, "resolve", "the code was rewritten");
    await promoteBug(root, U, izzie, done);
    await setBugState(root, U, izzie, done, "resolved", "fixed in #300");

    const all = [...(await readBugsShared(root, U)).values()];
    assert.deepEqual(bugAckQueue(all).map((b) => b.id), [asked]);
    assert.equal(needsHumanAck(all.find((b) => b.id === quiet)!), false,
      "…and the control: an untouched bug is not in it, so the filter is doing work");
  } finally { discard(root); }
});

test("the fold is order-independent", async () => {
  const root = tmp();
  try {
    const id = await fileBug(root, U, opus, NEW);
    await corroborateBug(root, U, dana, id, "confirm", "yes");
    await anchorBug(root, U, dana, id, [{ anchorId: "a_2", bodyHash: "sha256:two" }]);
    await commentOnBug(root, U, izzie, id, "looking at it");
    await trackBug(root, U, izzie, id, { key: "ACME-1" });

    const events = sortEvents(await readScope(root, bugScope(U)));
    const forward = foldBugs(events);
    const shuffled = foldBugs(sortEvents([...events].reverse()));
    assert.equal(JSON.stringify([...shuffled]), JSON.stringify([...forward]));
  } finally { discard(root); }
});

test("nothing the fold produces is a verdict about THIS checkout", async () => {
  const root = tmp();
  try {
    // `possiblyFixed` is a join against the local index and must never enter the log:
    // a clone that shipped its own answer would carry a copy nobody could refresh.
    await fileBug(root, U, izzie, NEW);
    const serialized = JSON.stringify(await one(root));
    for (const derived of ["possiblyFixed", "codeChanged", "stale", "unverifiable"]) {
      assert.ok(!serialized.includes(derived), `${derived} is derived per clone — it must not travel`);
    }
  } finally { discard(root); }
});
