import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Actor } from "./schema.js";
import { mintId, shardFor, appendEvents, readShard, readScope, sortEvents, causalHead, type LogEvent } from "./eventlog.js";

const izzie: Actor = { principal: "izzie@x.com" };
const dana: Actor = { principal: "dana@x.com" };
const izzieAgent: Actor = { principal: "izzie@x.com", via: { kind: "agent", model: "claude-opus-5" } };

const ev = (id: string, over: Partial<LogEvent> = {}): LogEvent =>
  ({ id, kind: "noted", subject: "f_1", actor: izzie, at: "2026-08-21T00:00:00Z", ...over });

const tmp = () => mkdtempSync(join(tmpdir(), "codemap-log-"));

// --- ids ----------------------------------------------------------------------

test("ids sort by time, and the padding is what makes that true", () => {
  // base-36 of a ms timestamp is 8 chars now and 9 later; unpadded, the longer one
  // would sort FIRST and the log would silently reorder itself sometime next century.
  const early = mintId(1_000);
  const now = mintId(1_760_000_000_000);
  const far = mintId(400_000_000_000_000);
  assert.ok(early < now && now < far, `${early} < ${now} < ${far}`);
  assert.equal(new Set([early.length, now.length, far.length]).size, 1, "fixed width");
});

test("ids minted in the same millisecond are still distinct", () => {
  const ids = new Set(Array.from({ length: 200 }, () => mintId(1_760_000_000_000)));
  assert.equal(ids.size, 200);
});

// --- sharding -----------------------------------------------------------------

test("two actors never share a shard — that is where conflict-freedom comes from", () => {
  assert.notEqual(shardFor("pr-264", izzie), shardFor("pr-264", dana));
});

test("an agent writes to its principal's shard, not one of its own", () => {
  // The alternative would fragment one person's log per model and defeat the point:
  // the shard is a WRITER, and the writer is the person.
  assert.equal(shardFor("pr-264", izzie), shardFor("pr-264", izzieAgent));
});

test("a principal never reaches the path — an email is not a portable filename", () => {
  // `:` `\` `<` `>` `|` `?` `*` are all legal in an email address and none of them
  // can appear in a Windows path, so the principal is hashed rather than used raw.
  const odd: Actor = { principal: 'a+b/c:d\\e<weird>|x?y*z@example.com' };
  const name = shardFor("pr-1", odd).slice("pr-1/".length);
  assert.match(name, /^[0-9a-f]{12}\.ndjson$/, `got ${name}`);
});

test("the same principal always lands on the same shard", () => {
  assert.equal(shardFor("pr-1", izzie), shardFor("pr-1", { principal: "izzie@x.com", github: "izzie" }));
});

// --- appending and reading ----------------------------------------------------

test("events round-trip through a shard", async () => {
  const root = tmp();
  try {
    await appendEvents(root, "pr-264", izzie, [ev(mintId(1)), ev(mintId(2))]);
    const got = await readScope(root, "pr-264");
    assert.equal(got.length, 2);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("appending twice extends the shard rather than replacing it", async () => {
  const root = tmp();
  try {
    await appendEvents(root, "pr-264", izzie, [ev(mintId(1))]);
    await appendEvents(root, "pr-264", izzie, [ev(mintId(2))]);
    assert.equal((await readScope(root, "pr-264")).length, 2);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("a scope collects every actor's shard", async () => {
  const root = tmp();
  try {
    await appendEvents(root, "pr-264", izzie, [ev(mintId(1))]);
    await appendEvents(root, "pr-264", dana, [ev(mintId(2), { actor: dana })]);
    const got = await readScope(root, "pr-264");
    assert.equal(got.length, 2);
    assert.deepEqual([...new Set(got.map((e) => e.actor.principal))].sort(), ["dana@x.com", "izzie@x.com"]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("scopes are isolated", async () => {
  const root = tmp();
  try {
    await appendEvents(root, "pr-264", izzie, [ev(mintId(1))]);
    await appendEvents(root, "pr-227", izzie, [ev(mintId(2))]);
    assert.equal((await readScope(root, "pr-264")).length, 1);
    assert.equal((await readScope(root, "pr-999")).length, 0, "an unknown scope is empty, not an error");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// --- the failure modes that actually happen -----------------------------------

test("a torn final line is dropped and everything before it survives", async () => {
  // A process killed mid-append leaves one. Failing the whole read would mean a
  // shared store that will not load because somebody closed a laptop.
  const root = tmp();
  try {
    await appendEvents(root, "pr-264", izzie, [ev(mintId(1)), ev(mintId(2))]);
    appendFileSync(join(root, shardFor("pr-264", izzie)), '{"id":"zzz","kind":"not-final', "utf8");
    const got = await readScope(root, "pr-264");
    assert.equal(got.length, 2, "the two whole events stand");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("a line that parses but is not an event is skipped", async () => {
  const root = tmp();
  try {
    const f = join(root, shardFor("pr-264", izzie));
    mkdirSync(join(root, "pr-264"), { recursive: true });
    writeFileSync(f, '{"id":"a"}\nnull\n123\n' + JSON.stringify(ev(mintId(5))) + "\n", "utf8");
    assert.equal((await readScope(root, "pr-264")).length, 1);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("a duplicated line — what merge=union produces — is folded once", async () => {
  // The case sharding does not cover: one person appending from two machines. Ids
  // are minted once, so duplicates are identical and the later sighting loses nothing.
  const root = tmp();
  try {
    const e = ev(mintId(1));
    await appendEvents(root, "pr-264", izzie, [e]);
    appendFileSync(join(root, shardFor("pr-264", izzie)), JSON.stringify(e) + "\n", "utf8");
    assert.equal((await readScope(root, "pr-264")).length, 1);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("a missing shard reads as empty, not as a failure", async () => {
  assert.deepEqual(await readShard("/nope/nothing.ndjson"), []);
});

// --- ordering: the property every reader depends on ---------------------------

test("independent events order by id, so every machine folds the same state", () => {
  const a = ev("0000000001-aa"), b = ev("0000000002-bb"), c = ev("0000000003-cc");
  assert.deepEqual(sortEvents([c, a, b]).map((e) => e.id), [a.id, b.id, c.id]);
});

test("causality beats the clock — a fast laptop cannot reorder a reply before its cause", () => {
  // dana's machine is a minute fast, so her id sorts FIRST; but she wrote it having
  // already seen izzie's, and `after` says so. Without this the refutation lands
  // ahead of the confirmation it was answering.
  const cause = ev("0000000009-izz", { kind: "confirmed" });
  const reply = ev("0000000001-dan", { kind: "refuted", actor: dana, after: cause.id });
  assert.deepEqual(sortEvents([reply, cause]).map((e) => e.kind), ["confirmed", "refuted"]);
});

test("an `after` naming an event this scope does not have is not a deadlock", () => {
  const orphan = ev("0000000005-aa", { after: "0000000001-elsewhere" });
  assert.deepEqual(sortEvents([orphan]).map((e) => e.id), [orphan.id]);
});

test("a cycle still yields every event — a log that refuses to load is worse", () => {
  const a = ev("0000000001-aa", { after: "0000000002-bb" });
  const b = ev("0000000002-bb", { after: "0000000001-aa" });
  assert.equal(sortEvents([a, b]).length, 2);
});

test("sorting is deterministic regardless of input order", () => {
  const evs = [ev("0000000003-cc"), ev("0000000001-aa", { after: "0000000002-bb" }), ev("0000000002-bb")];
  const one = sortEvents([...evs]).map((e) => e.id);
  const two = sortEvents([...evs].reverse()).map((e) => e.id);
  assert.deepEqual(one, two);
  assert.deepEqual(one, ["0000000002-bb", "0000000001-aa", "0000000003-cc"], "cause before effect, id otherwise");
});

test("the causal head is the LAST event in fold order, not the highest id", () => {
  // These differ whenever two events share a millisecond and are ordered by their
  // random suffix. Taking the highest id made a writer's own consecutive events
  // read as concurrent — the exact ambiguity `after` exists to remove — because the
  // second one pointed `after` at something that was not what it had just seen.
  const first = ev("0000000009-zz");
  const second = ev("0000000002-aa", { after: first.id });
  const sorted = sortEvents([first, second]);
  assert.deepEqual(sorted.map((e) => e.id), [first.id, second.id], "causality put the low id last");
  assert.equal(causalHead(sorted), second.id, "so the head is that one, not the max id");
});

test("the causal head of nothing is nothing", () => {
  assert.equal(causalHead([]), undefined);
});

test("a writer's own consecutive events keep their order even within one millisecond", () => {
  // The regression this was found by: two asks written back to back, the second
  // replacing the first. Same ms, so only `mintId`'s monotonicity separates them.
  const ids = Array.from({ length: 50 }, () => mintId(1_760_000_000_000));
  assert.deepEqual([...ids].sort(), ids, "minted in strictly increasing order");
});
