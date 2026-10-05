import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Actor } from "./schema.js";
import { testEvent } from "./test-events.js";
import { emitEvent } from "./write.js";
import {
  foldTopicsReport, foldTopicWalkthroughsReport, defineTopic, reviseTopic, retireTopic, readTopicsLog,
  publishTopicWalkthrough, topicWalkthroughScope, foldTopicWalkthroughs, type TopicWalkthrough,
} from "./shared-topics.js";
import { readScope } from "./eventlog.js";
import { discard } from "./test-tmp.js";

const izzie: Actor = { principal: "izzie@x.com" };
const dana: Actor = { principal: "dana@x.com" };
const SEL = { paths: ["src/fees/**"] };
const ev = (n: number, kind: string, subject: string, data: Record<string, unknown>, actor = izzie) =>
  testEvent({ id: `e${String(n).padStart(3, "0")}`, seq: n, kind, subject, data, actor });

test("the fold: a retired slug is never reused, a stale revision refuses, a retired topic is still listed", () => {
  const { value, refused } = foldTopicsReport([
    ev(1, "topic.defined", "fees", { title: "Fees", selector: SEL }),
    ev(2, "topic.revised", "fees", { now: { title: "Fee rules" }, was: { title: "Fees" } }, dana),
    // Read before dana's revision: the title it saw is gone.
    ev(3, "topic.revised", "fees", { now: { title: "Fee maths" }, was: { title: "Fees" } }),
    ev(4, "topic.retired", "fees", {}, dana),
    ev(5, "topic.defined", "fees", { title: "Fees again", selector: SEL }),
    ev(6, "topic.revised", "fees", { now: { title: "x" }, was: { title: "Fee rules" } }),
    ev(7, "topic.retired", "nope", {}),
    ev(8, "topic.defined", "Bad Slug", { title: "t", selector: SEL }),
    ev(9, "topic.defined", "empty", { title: "t", selector: {} }),
  ]);
  assert.deepEqual(refused.map((r) => [r.id, r.cls]), [
    ["e003", "state"], ["e005", "state"], ["e006", "state"], ["e007", "reference"], ["e008", "shape"], ["e009", "shape"],
  ]);
  assert.match(refused.find((r) => r.id === "e005")!.why, /never reused/);
  assert.equal(value.length, 1);
  assert.equal(value[0]!.status, "retired");
  assert.equal(value[0]!.title, "Fee rules");
  assert.deepEqual(value[0]!.revisions.map((r) => r.was), [{ title: "Fees" }]);
});

test("a selector revision is compared by content, not identity", () => {
  const { refused, value } = foldTopicsReport([
    ev(1, "topic.defined", "fees", { title: "Fees", selector: SEL }),
    ev(2, "topic.revised", "fees", { now: { selector: { paths: ["src/**"] } }, was: { selector: { paths: ["src/fees/**"] } } }),
  ]);
  assert.deepEqual(refused, []);
  assert.deepEqual(value[0]!.selector, { paths: ["src/**"] });
});

test("the door refuses what the fold refuses: re-defining a retired topic", async () => {
  const root = mkdtempSync(join(tmpdir(), "codemap-topics-"));
  try {
    await defineTopic(root, "acme-api", izzie, "fees", "Fees", SEL);
    const [t] = await readTopicsLog(root, "acme-api");
    await reviseTopic(root, "acme-api", dana, t!, { selector: { paths: ["src/**"] } });
    await assert.rejects(reviseTopic(root, "acme-api", izzie, t!, { selector: { paths: ["lib/**"] } }), /changed since you read it/);
    await retireTopic(root, "acme-api", dana, "fees");
    await assert.rejects(defineTopic(root, "acme-api", izzie, "fees", "Fees 2", SEL), /never reused/);
    assert.equal((await readTopicsLog(root, "acme-api"))[0]!.status, "retired");
  } finally { discard(root); }
});

const walk = (topic: string, head: string, title = "F"): TopicWalkthrough => ({
  topic, head, selector: SEL, resolved: { ids: ["a_1"], outside: [], unresolved: [] }, by: "agent", at: "t",
  features: [{ id: "f", title, summary: "s", chapters: [{ id: "c", title: "C", blocks: [{ kind: "symbol", anchorId: "a_1" }], witnesses: [{ anchorId: "a_1", bodyHash: "sha256:x" }] }] }],
  covers: [],
});

test("two walks by one person at one commit both survive, each with its own id", async () => {
  const root = mkdtempSync(join(tmpdir(), "codemap-topics-"));
  try {
    await defineTopic(root, "acme-api", izzie, "fees", "Fees", SEL);
    await publishTopicWalkthrough(root, "acme-api", izzie, walk("fees", "h1", "first"));
    await publishTopicWalkthrough(root, "acme-api", izzie, walk("fees", "h1", "second"));
    const all = foldTopicWalkthroughs(await readScope(root, topicWalkthroughScope("acme-api", "fees")));
    assert.deepEqual(all.map((w) => w.walkthrough.features[0]!.title), ["first", "second"]);
    assert.notEqual(all[0]!.id, all[1]!.id);
  } finally { discard(root); }
});

test("a topic walkthrough is refused for an undefined or retired topic, a misfiled scope, or a WalkInput body", async () => {
  const root = mkdtempSync(join(tmpdir(), "codemap-topics-"));
  try {
    await assert.rejects(publishTopicWalkthrough(root, "acme-api", izzie, walk("fees", "h1")), /no topic fees/);
    await defineTopic(root, "acme-api", izzie, "fees", "Fees", SEL);
    await defineTopic(root, "acme-api", izzie, "rent", "Rent", SEL);
    await assert.rejects(
      emitEvent(root, topicWalkthroughScope("acme-api", "rent"), izzie, "topic.walkthrough.published", "fees", { walkthrough: walk("fees", "h1") as never }),
      /belongs in/);
    await retireTopic(root, "acme-api", izzie, "fees");
    await assert.rejects(publishTopicWalkthrough(root, "acme-api", izzie, walk("fees", "h1")), /retired/);
    const input = { ...walk("rent", "h"), features: [{ title: "F", summary: "s", chapters: [{ title: "C", blocks: [] }] }] };
    const { refused } = foldTopicWalkthroughsReport([ev(1, "topic.walkthrough.published", "rent", { walkthrough: input })]);
    assert.equal(refused[0]?.cls, "shape");
  } finally { discard(root); }
});

// ---------------------------------------------------------------------------
// Review round 2026-10-05: tightenings that are free only before any topic event is on a real log
// ---------------------------------------------------------------------------

test("an identical define is one act while the topic is active, and refused once it is retired (R21)", () => {
  const def = { title: "Fees", selector: SEL };
  const active = foldTopicsReport([ev(1, "topic.defined", "fees", def), ev(2, "topic.defined", "fees", def, dana)]);
  assert.deepEqual(active.refused, []);
  assert.equal(active.value[0]!.definedBy.principal, "izzie@x.com");
  const retired = foldTopicsReport([ev(1, "topic.defined", "fees", def), ev(2, "topic.retired", "fees", {}), ev(3, "topic.defined", "fees", def)]);
  assert.deepEqual(retired.refused.map((r) => [r.id, r.cls]), [["e003", "state"]]);
  assert.match(retired.refused[0]!.why, /never reused/);
});

test("a revision names what it read for every field it changes (R22)", () => {
  const { refused, value } = foldTopicsReport([
    ev(1, "topic.defined", "fees", { title: "Fees", selector: SEL }),
    ev(2, "topic.revised", "fees", { now: { title: "Fee rules" }, was: { title: "Fees" } }, dana),
    ev(3, "topic.revised", "fees", { now: { title: "Fee maths" }, was: {} }),
    ev(4, "topic.revised", "fees", { now: { title: "Fee maths", selector: { paths: ["x/**"] } }, was: { title: "Fee rules" } }),
  ]);
  assert.deepEqual(refused.map((r) => r.id), ["e003", "e004"]);
  assert.equal(value[0]!.title, "Fee rules");
});

test("a walkthrough accounts within its resolved set, witnesses what it cites, and walks something (R23, R34)", async () => {
  const fold = (w: unknown) => foldTopicWalkthroughsReport([ev(1, "topic.walkthrough.published", "fees", { walkthrough: w })]).refused;
  assert.deepEqual(fold(walk("fees", "h1")), [], "the fixture itself is a good walk");
  const outside = walk("fees", "h1");
  outside.features[0]!.chapters[0]!.blocks = [{ kind: "symbol", anchorId: "a_out" }];
  outside.features[0]!.chapters[0]!.witnesses = [{ anchorId: "a_out", bodyHash: "sha256:x" }];
  assert.match(fold(outside)[0]?.why ?? "", /a_out/);
  const unwitnessed = walk("fees", "h1");
  unwitnessed.features[0]!.chapters[0]!.witnesses = [];
  assert.match(fold(unwitnessed)[0]?.why ?? "", /witness/);
  assert.match(fold({ ...walk("fees", "h1"), features: [] })[0]?.why ?? "", /walks nothing/);
  const twice = walk("fees", "h1");
  twice.features[0]!.chapters.push({ ...twice.features[0]!.chapters[0]!, id: "c2", title: "C2" });
  assert.match(fold(twice)[0]?.why ?? "", /more than one chapter/);

  const root = mkdtempSync(join(tmpdir(), "codemap-topics-"));
  try {
    await defineTopic(root, "acme-api", izzie, "fees", "Fees", SEL);
    await assert.rejects(publishTopicWalkthrough(root, "acme-api", izzie, outside), /a_out/);
    await assert.rejects(publishTopicWalkthrough(root, "acme-api", izzie, unwitnessed), /witness/);
  } finally { discard(root); }
});

test("a walkthrough filed outside a topic scope is refused (R24)", async () => {
  const root = mkdtempSync(join(tmpdir(), "codemap-topics-"));
  try {
    await defineTopic(root, "acme-api", izzie, "fees", "Fees", SEL);
    await assert.rejects(
      emitEvent(root, "topic-walkthrough/acme-api/not-a-topic-hash", izzie, "topic.walkthrough.published", "fees", { walkthrough: walk("fees", "h1") as never }),
      /not a topic walkthrough scope/);
  } finally { discard(root); }
});

test("a finding's topic or branch field binds it to its scope, at the door (R26)", async () => {
  const { createFinding } = await import("./shared-findings.js");
  const { findingScopeOfBugKey } = await import("./shared-bugs.js");
  const root = mkdtempSync(join(tmpdir(), "codemap-topics-"));
  const f = (extra: Record<string, unknown>) => ({ targetKind: "anchor", targetId: "a_1", text: "t", ...extra }) as never;
  const scopeOf = (key: string) => findingScopeOfBugKey("acme-api", key)!.slice("findings/".length);
  try {
    await defineTopic(root, "acme-api", izzie, "fees", "Fees", SEL);
    await assert.rejects(createFinding(root, scopeOf("5"), izzie, f({ topic: "ghost" })), /pull request/);
    await assert.rejects(createFinding(root, scopeOf("5"), izzie, f({ branch: "feat/x" })), /pull request/);
    await assert.rejects(createFinding(root, scopeOf("topic:fees"), izzie, f({ topic: "fees", branch: "feat/x" })), /branch/);
    await assert.rejects(createFinding(root, scopeOf("branch:feat/x"), izzie, f({})), /names its branch/);
    await assert.rejects(createFinding(root, scopeOf("branch:feat/x"), izzie, f({ branch: "feat/y" })), /belongs in/);
    await assert.rejects(createFinding(root, scopeOf("branch:feat/x"), izzie, f({ branch: "feat/x", topic: "fees" })), /topic/);
    await createFinding(root, scopeOf("5"), izzie, f({}));
    await createFinding(root, scopeOf("branch:feat/x"), izzie, f({ branch: "feat/x" }));
    await createFinding(root, scopeOf("topic:fees"), izzie, f({ topic: "fees" }));
  } finally { discard(root); }
});
