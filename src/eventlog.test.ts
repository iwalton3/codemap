import { test } from "node:test";
import { testEvent } from "./test-events.js";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync, appendFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, win32 } from "node:path";
import type { Actor } from "./schema.js";
import { wellFormed, mintId, shardFor, appendEvents, appendBatch, readShard, readScope, readScopeChecked, sortEvents, causalHeads, readSets, writerFor, scopeStatus, scopesOnDisk, SHARD_EXT, GENESIS, SIDECAR_PROTOCOL, EVENT_SCHEMA, type LogEvent } from "./eventlog.js";
import { emitEvent, emitEventChecked } from "./write.js";
import { projectionFor } from "./shared-projections.js";
import { docScope } from "./shared-docs.js";
import { noteScope } from "./shared-notes.js";
import { bugScope } from "./shared-bugs.js";
import { discard } from "./test-tmp.js";

const izzie: Actor = { principal: "izzie@x.com" };
const dana: Actor = { principal: "dana@x.com" };
const izzieAgent: Actor = { principal: "izzie@x.com", via: { kind: "agent", model: "claude-opus-5" } };

/**
 * One writer PER PRINCIPAL, which is what these tests mean by "a different person": a
 * merge-era read set follows its own writer's chain, so a shared default would quietly
 * fold two people into one history.
 */
const ev = (id: string, over: Partial<LogEvent> = {}, principal?: string): LogEvent => {
  const actor = principal ? { principal } : izzie;
  return testEvent({ id, subject: "f_1", actor, writer: "w_" + actor.principal, ...over });
};

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

const W_A = "w_aaaaaaaaaaaaaaaa", W_B = "w_bbbbbbbbbbbbbbbb";

test("two writers never share a shard — that is where conflict-freedom comes from", () => {
  assert.notEqual(shardFor("pr-264", W_A), shardFor("pr-264", W_B));
});

test("a shard is a CLONE, not a person — one person on two machines writes two", () => {
  // It used to be the person, and that is the hole this closes: the causal vector
  // compresses each writer's history to one ordinal, which is only sound if a
  // writer is one sequential thing. One person on two machines is not.
  assert.notEqual(shardFor("pr-264", W_A), shardFor("pr-264", W_B));
  assert.equal(shardFor("pr-264", W_A), shardFor("pr-264", W_A),
    "and everything from one clone still lands together, whoever is driving it");
});

test("a writer id is already a portable filename", () => {
  // The principal had to be hashed — `:` `\` `<` `>` `|` `?` `*` are all legal in an
  // email and none can appear in a Windows path. A writer id is minted, not given.
  const name = shardFor("pr-1", W_A).slice("pr-1/".length);
  assert.match(name, /^w_[0-9a-f]{16}\.ndjson$/, `got ${name}`);
});

test("a clone's writer id is minted once and then stable", async () => {
  const root = tmp();
  try {
    mkdirSync(join(root, ".git"), { recursive: true });
    const first = await writerFor(root);
    assert.match(first, /^w_[0-9a-f]{16}$/);
    assert.equal(await writerFor(root), first, "same process");
    // …and durable: it lives in the git dir, which `git add -A` can never reach.
    assert.equal(readFileSync(join(root, ".git", "codemap-writer"), "utf8").trim(), first);
  } finally { discard(root); }
});

test("two clones mint different writer ids", async () => {
  const a = tmp(), b = tmp();
  try {
    mkdirSync(join(a, ".git"), { recursive: true });
    mkdirSync(join(b, ".git"), { recursive: true });
    assert.notEqual(await writerFor(a), await writerFor(b));
  } finally { [a, b].forEach((r) => discard(r)); }
});

// --- appending and reading ----------------------------------------------------

test("events round-trip through a shard", async () => {
  const root = tmp();
  try {
    await appendEvents(root, "pr-264", W_A, [ev(mintId(1)), ev(mintId(2))]);
    const got = await readScope(root, "pr-264");
    assert.equal(got.length, 2);
  } finally { discard(root); }
});

test("appending twice extends the shard rather than replacing it", async () => {
  const root = tmp();
  try {
    await appendEvents(root, "pr-264", W_A, [ev(mintId(1))]);
    await appendEvents(root, "pr-264", W_A, [ev(mintId(2))]);
    assert.equal((await readScope(root, "pr-264")).length, 2);
  } finally { discard(root); }
});

test("a scope collects every actor's shard", async () => {
  const root = tmp();
  try {
    await appendEvents(root, "pr-264", W_A, [ev(mintId(1))]);
    await appendEvents(root, "pr-264", W_A, [ev(mintId(2), { actor: dana })]);
    const got = await readScope(root, "pr-264");
    assert.equal(got.length, 2);
    assert.deepEqual([...new Set(got.map((e) => e.actor.principal))].sort(), ["dana@x.com", "izzie@x.com"]);
  } finally { discard(root); }
});

test("scopes are isolated", async () => {
  const root = tmp();
  try {
    await appendEvents(root, "pr-264", W_A, [ev(mintId(1))]);
    await appendEvents(root, "pr-227", W_A, [ev(mintId(2))]);
    assert.equal((await readScope(root, "pr-264")).length, 1);
    assert.equal((await readScope(root, "pr-999")).length, 0, "an unknown scope is empty, not an error");
  } finally { discard(root); }
});

// --- the failure modes that actually happen -----------------------------------

test("a torn final line is dropped and everything before it survives", async () => {
  // A process killed mid-append leaves one. Failing the whole read would mean a
  // shared store that will not load because somebody closed a laptop.
  const root = tmp();
  try {
    await appendEvents(root, "pr-264", W_A, [ev(mintId(1)), ev(mintId(2))]);
    appendFileSync(join(root, shardFor("pr-264", W_A)), '{"id":"zzz","kind":"not-final', "utf8");
    const got = await readScope(root, "pr-264");
    assert.equal(got.length, 2, "the two whole events stand");
  } finally { discard(root); }
});

test("appending AFTER a torn line does not glue onto it", async () => {
  // The torn line is only harmless until the next append. `appendFile` starts
  // exactly where the file ends, so without a separator the next event is
  // concatenated onto the partial one, the glued line fails `JSON.parse`, and it
  // is dropped — silently, after `emit` has already returned its id. `git add -A`
  // then ships the glue to everyone.
  const root = tmp();
  try {
    const file = join(root, shardFor("pr-264", W_A));
    await appendEvents(root, "pr-264", W_A, [ev(mintId(1)), ev(mintId(2))]);
    appendFileSync(file, '{"id":"zzz","kind":"not-final', "utf8");

    const next = ev(mintId(3));
    await appendEvents(root, "pr-264", W_A, [next]);
    const got = await readScope(root, "pr-264");
    assert.equal(got.length, 3, "the two whole events, plus the one just written");
    assert.ok(got.some((e) => e.id === next.id), "the event written after the tear survives");
  } finally { discard(root); }
});

test("and a BATCH after a torn line loses none of it", async () => {
  // Only the first event of a batch is eaten, which is what makes this read as an
  // intermittent lost write rather than a broken shard.
  const root = tmp();
  try {
    const file = join(root, shardFor("pr-264", W_A));
    await appendEvents(root, "pr-264", W_A, [ev(mintId(1))]);
    appendFileSync(file, '{"id":"zzz","kind":"not-fi', "utf8");

    const batch = [ev(mintId(2)), ev(mintId(3)), ev(mintId(4))];
    await appendEvents(root, "pr-264", W_A, batch);
    const ids = new Set((await readScope(root, "pr-264")).map((e) => e.id));
    for (const e of batch) assert.ok(ids.has(e.id), `lost ${e.id}`);
  } finally { discard(root); }
});

test("a line that parses but is not an event is skipped", async () => {
  const root = tmp();
  try {
    const f = join(root, shardFor("pr-264", W_A));
    mkdirSync(join(root, "pr-264"), { recursive: true });
    writeFileSync(f, '{"id":"a"}\nnull\n123\n' + JSON.stringify(ev(mintId(5))) + "\n", "utf8");
    assert.equal((await readScope(root, "pr-264")).length, 1);
  } finally { discard(root); }
});

test("a duplicated line — what merge=union produces — is folded once", async () => {
  // The case sharding does not cover: one person appending from two machines. Ids
  // are minted once, so duplicates are identical and the later sighting loses nothing.
  const root = tmp();
  try {
    const e = ev(mintId(1));
    await appendEvents(root, "pr-264", W_A, [e]);
    appendFileSync(join(root, shardFor("pr-264", W_A)), JSON.stringify(e) + "\n", "utf8");
    assert.equal((await readScope(root, "pr-264")).length, 1);
  } finally { discard(root); }
});

test("a missing shard reads as empty, not as a failure", async () => {
  assert.deepEqual(await readShard("/nope/nothing.ndjson"), []);
});

// --- ordering: the property every reader depends on ---------------------------

test("events fold in seq order, whatever their ids: a staged act lands where it was pushed", () => {
  // Ids are minted at staging. `x` was staged first and pushed last; it folds last.
  const x = ev("0000000001-xx", { seq: 3 }), y = ev("0000000002-yy", { seq: 1 }), z = ev("0000000003-zz", { seq: 2 });
  assert.deepEqual(sortEvents([x, y, z]).map((e) => e.id), [y.id, z.id, x.id]);
  assert.deepEqual(sortEvents([z, x, y]).map((e) => e.id), [y.id, z.id, x.id], "and input order does not matter");
});

test("`after` orders nothing: an event earlier in seq stays earlier, whatever it names", () => {
  // Under the causal sort `q` waited for `p`, the event it named. The remote accepted `q`
  // first, and every reader folds in that order.
  const p = ev("0000000001-pp", { seq: 2 }), q = ev("0000000002-qq", { seq: 1, after: [p.id] });
  assert.deepEqual(sortEvents([p, q]).map((e) => e.id), [q.id, p.id]);
});

test("merged scopes interleave by seq — law and evidence fold in push order", () => {
  const law1 = ev("0000000009-l1", { seq: 1, subject: "law" }), ev2 = ev("0000000001-e1", { seq: 2 }), law3 = ev("0000000005-l3", { seq: 3, subject: "law" });
  assert.deepEqual(sortEvents([ev2, law1, law3]).map((e) => e.id), [law1.id, ev2.id, law3.id]);
});

test("an event without seq keeps its input place; seq events fill the others in seq order", () => {
  // Only a fixture mixes them: an unmigrated sidecar is refused before anything folds.
  const old = ev("0000000005-old"), a = ev("0000000009-aa", { seq: 2 }), b = ev("0000000001-bb", { seq: 1 });
  assert.deepEqual(sortEvents([a, old, b]).map((e) => e.id), [b.id, old.id, a.id]);
  assert.deepEqual(sortEvents([ev("0000000002-bb"), ev("0000000001-aa")]).map((e) => e.id),
    ["0000000002-bb", "0000000001-aa"], "no seq at all: input order, not id order");
});

test("the causal head of nothing is nothing", () => {
  assert.deepEqual(causalHeads([]), []);
});

test("a writer apart from another records BOTH heads, and neither is dropped", () => {
  // The whole reason `after` is a list. One id can only name one of two acts neither
  // had read, and everything behind the other vanishes from the record of what this
  // author knew.
  const a = ev("0000000001-aa", {}, "alice@x.com");
  const b = ev("0000000002-bb", {}, "dana@x.com");
  const heads = causalHeads([a, b]);
  assert.deepEqual([...heads].sort(), [a.id, b.id]);

  const c = ev("0000000003-cc", { after: heads }, "bob@x.com");
  const reads = readSets([a, b, c]);
  assert.ok(reads.saw(c.id, a.id), "bob saw alice");
  assert.ok(reads.saw(c.id, b.id), "bob saw dana");
});

test("what an author never read is not in their read set, whatever the order", () => {
  // dana staged hers having read only `t`, and it landed after alice's. Position says
  // dana came after alice; her read set says she never saw it.
  const t = ev("0000000001-tt", { seq: 1 });
  const alice = ev("0000000002-aa", { seq: 2, after: [t.id] }, "alice@x.com");
  const dana = ev("0000000003-dd", { seq: 3, after: [t.id] }, "dana@x.com");
  const reads = readSets([t, alice, dana]);
  assert.ok(reads.saw(dana.id, t.id), "dana read t");
  assert.ok(!reads.saw(dana.id, alice.id), "and did NOT read alice, despite folding after her");
  assert.deepEqual(causalHeads([t, alice, dana]).sort(), [alice.id, dana.id], "so a later act names both");
  // CONTROL: the read set is transitive — an act after the head reads everything behind it.
  const bob = ev("0000000004-bb", { seq: 4, after: [alice.id, dana.id] }, "bob@x.com");
  assert.ok(readSets([t, alice, dana, bob]).saw(bob.id, t.id));
});

test("a linear event's writerPrev reads nothing: two sessions on one clone share a writer", () => {
  // `atTip` sets writerPrev to the clone's last event at the tip, which another session on
  // the same clone may have staged. Following it credited `sb` with `sa`, unread.
  const t = ev("0000000001-tt", { seq: 1 });
  const sa = ev("0000000002-sa", { seq: 2, after: [t.id], writer: "w_one" });
  const sb = ev("0000000003-sb", { seq: 3, after: [t.id], writer: "w_one", writerPrev: sa.id });
  assert.equal(readSets([t, sa, sb]).saw(sb.id, sa.id), false);
  assert.deepEqual(causalHeads([t, sa, sb]).sort(), [sa.id, sb.id]);
  // CONTROL: the same pair as merge-era events (no seq) keeps the chain they were written with.
  const ma = { ...sa, seq: undefined }, mb = { ...sb, seq: undefined };
  assert.equal(readSets([t, ma, mb]).saw(mb.id, ma.id), true);
});

test("asking a read set does not change the events it was asked of", () => {
  // `readEdges` hands back `after` itself; walking it in place emptied the event's
  // `after`, and the next `causalHeads` over the same array came back wrong.
  const a = ev("0000000001-aa", { seq: 1 }), b = ev("0000000002-bb", { seq: 2, after: ["0000000001-aa"] });
  readSets([a, b]).saw(b.id, a.id);
  assert.deepEqual(b.after, [a.id]);
  assert.deepEqual(causalHeads([a, b]), [b.id]);
});

test("a batch's later acts read the earlier ones", async () => {
  // They share no `writerPrev` a read set follows, so each names the one before it.
  const root = tmp();
  try {
    mkdirSync(join(root, ".git"), { recursive: true });
    const [x, y, z] = await appendBatch(root, "s", izzie, [
      { kind: "noted", subject: "f_1" }, { kind: "noted", subject: "f_1" }, { kind: "noted", subject: "f_1" }]);
    const events = await readScope(root, "s");
    const reads = readSets(events);
    assert.ok(reads.saw(z!.id, x!.id) && reads.saw(z!.id, y!.id) && reads.saw(y!.id, x!.id));
    assert.equal(reads.saw(x!.id, y!.id), false);
    assert.deepEqual(causalHeads(events), [z!.id]);
  } finally { discard(root); }
});

test("a writer's own consecutive events keep their order even within one millisecond", () => {
  // The regression this was found by: two asks written back to back, the second
  // replacing the first. Same ms, so only `mintId`'s monotonicity separates them.
  const ids = Array.from({ length: 50 }, () => mintId(1_760_000_000_000));
  assert.deepEqual([...ids].sort(), ids, "minted in strictly increasing order");
});

// --- a merge-era read set follows its own WRITER's chain -------------------------

/**
 * Merge-era `after` was compressed against the writer's own chain, so a merge-era read set
 * reaches the writer's previous event — keyed on the WRITER (one clone), never the person:
 * one person on two machines is two histories. An agent having seen something cannot
 * establish that the human did.
 */
const ago = (id: string, principal: string, writer?: string, after?: string[], via?: unknown, prev?: string): LogEvent =>
  testEvent({
    id, kind: "finding.revised", subject: "f_1",
    actor: (via ? { principal, via } : { principal }) as Actor,
    at: "2026-01-01T00:00:00Z",
    ...(after ? { after } : {}),
    ...(writer ? { writer } : {}),
    ...(prev ? { writerPrev: prev } : {}),
  });

test("one person's two machines do not lend each other knowledge they never had", () => {
  //  H  Dana revises.
  //  O  Izzie's LAPTOP agent comments, having seen H.
  //  E  Izzie's stale DESKTOP revises, having seen neither.
  const H = ago("0000000001-aa", "dana@x.com", "w_dana");
  const O = ago("0000000002-bb", "izzie@x.com", "w_laptop", [H.id], { kind: "agent", model: "m" });
  const E = ago("0000000003-cc", "izzie@x.com", "w_desktop");
  assert.equal(readSets([H, O, E]).saw(E.id, H.id), false,
    "the desktop never saw Dana's revision, and the laptop agent's sighting is not its own");
});

test("…but one machine's own history is still its own", () => {
  // The control. Keying by writer must not simply make everything unseen: on one
  // clone the previous event genuinely IS a causal parent — and the chain is what
  // says so. `E` names `O` as its predecessor, which is what `emitEvent` writes.
  const H = ago("0000000001-aa", "dana@x.com", "w_dana");
  const O = ago("0000000002-bb", "izzie@x.com", "w_laptop", [H.id]);
  const E = ago("0000000003-cc", "izzie@x.com", "w_laptop", undefined, undefined, O.id);
  assert.equal(readSets([H, O, E]).saw(E.id, H.id), true);
});

test("two events of one writer that BOTH open the chain lend nothing", () => {
  // Fold order does not supply the edge between them: only `writerPrev` does.
  const H = ago("0000000001-aa", "dana@x.com", "w_dana");
  const O = ago("0000000002-bb", "izzie@x.com", "w_copied", [H.id]);
  const E = ago("0000000003-cc", "izzie@x.com", "w_copied");
  assert.equal(readSets([H, O, E]).saw(E.id, H.id), false);
  assert.equal(readSets([H, O, E]).saw(E.id, O.id), false, "and they cannot see each other");
});


/** An event that makes a chain claim. `prev` defaults to opening the chain. */
const link = (id: string, writer: string, prev: string = GENESIS, over: Partial<LogEvent> = {}): LogEvent =>
  testEvent({ id, subject: "f_1", actor: izzie, at: "2026-01-01T00:00:00Z", writer, writerPrev: prev, ...over });

// --- scope status ---------------------------------------------------------------

test("an ordinary scope is complete", () => {
  assert.deepEqual(scopeStatus([link("0000000001-aa", "w_one")]), { status: "complete" });
});

test("two events of one writer naming one predecessor are not a diagnosis", () => {
  // The remote serializes every push, so one writer id in two clones is two writers'
  // events in one order — nothing to block on.
  assert.deepEqual(scopeStatus([link("0000000001-aa", "w_c"), link("0000000002-bb", "w_c")]), { status: "complete" });
});

test("an envelope from a newer codemap blocks the scope", () => {
  const st = scopeStatus([ev("0000000001-aa", { sidecarProtocol: SIDECAR_PROTOCOL + 1 })]);
  assert.equal(st.status, "blocked");
  assert.equal(st.diagnostic?.reason, "protocol");
});

test("a newer payload schema blocks it too, and separately", () => {
  const st = scopeStatus([ev("0000000001-aa", { eventSchema: EVENT_SCHEMA + 1 })]);
  assert.equal(st.diagnostic?.reason, "protocol");
  assert.match(st.diagnostic!.detail, new RegExp(`schema ${EVENT_SCHEMA + 1}`));
});

test("a missing protocol number is an older writer, not a newer one", () => {
  assert.equal(scopeStatus([ev("0000000001-aa")]).status, "complete");
});

test("one id read twice is one event, and the first sighting stands", async () => {
  const root = tmp();
  try {
    const dir = join(root, "s");
    mkdirSync(dir, { recursive: true });
    const a = link("0000000001-aa", "w_one");
    writeFileSync(join(dir, "w_one.ndjson"), JSON.stringify(a) + "\n");
    writeFileSync(join(dir, "w_two.ndjson"), JSON.stringify({ ...a, subject: "f_2" }) + "\n");
    const read = await readScopeChecked(root, "s");
    assert.equal(read.status, "complete");
    assert.deepEqual(read.events.map((e) => e.subject), ["f_1"]);
  } finally { discard(root); }
});

test("a blocked scope still hands back its events", async () => {
  // Non-authoritative, not hidden. A reviewer who can see what the team wrote is
  // better placed to act than one staring at an empty page.
  const root = tmp();
  try {
    const dir = join(root, "s");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "w_c.ndjson"),
      [link("0000000001-aa", "w_c"), link("0000000002-bb", "w_c", "0000000001-aa", { sidecarProtocol: 99 })].map((e) => JSON.stringify(e)).join("\n") + "\n");
    const read = await readScopeChecked(root, "s");
    assert.equal(read.status, "blocked");
    assert.equal(read.events.length, 2);
  } finally { discard(root); }
});

test("emitting builds a chain: GENESIS, then each event naming the last", async () => {
  const root = tmp();
  try {
    mkdirSync(join(root, ".git"), { recursive: true });
    const a = await emitEvent(root, "s", izzie, "noted", "f_1");
    const b = await emitEvent(root, "s", izzie, "noted", "f_1");
    const c = await emitEvent(root, "s", dana, "noted", "f_1");
    assert.equal(a.writerPrev, GENESIS);
    assert.equal(b.writerPrev, a.id);
    // One CLONE, two people: the chain is the clone's, so Dana's event continues it.
    assert.equal(c.writerPrev, b.id);
    assert.equal(a.sidecarProtocol, SIDECAR_PROTOCOL);
    assert.equal(a.eventSchema, EVENT_SCHEMA);
    const read = await readScopeChecked(root, "s");
    assert.equal(read.status, "complete");
  } finally { discard(root); }
});

test("checked append serializes admission, retry and refusal with the event", async () => {
  const root = tmp();
  try {
    mkdirSync(join(root, ".git"), { recursive: true });
    const attempt = () => emitEventChecked(root, "s", izzie, async (events) => {
      const prior = events.find((e) => e.data?.attempt === "once");
      return prior ? { existing: prior } : { kind: "noted", subject: "f_1", data: { attempt: "once" } };
    });
    const [a, b] = await Promise.all([attempt(), attempt()]);
    assert.ok(!("error" in a) && !("error" in b));
    assert.equal(a.id, b.id);
    assert.equal((await readScope(root, "s")).length, 1);
    const denied = await emitEventChecked(root, "s", izzie, async () => ({ error: "stale admission" }));
    assert.deepEqual(denied, { error: "stale admission" });
    assert.equal((await readScope(root, "s")).length, 1);
  } finally { discard(root); }
});

test("a chain is per scope, so a writer's first event in a new scope opens a new one", async () => {
  const root = tmp();
  try {
    mkdirSync(join(root, ".git"), { recursive: true });
    await emitEvent(root, "s1", izzie, "noted", "f_1");
    const other = await emitEvent(root, "s2", izzie, "noted", "f_1");
    // `readScope` reads one scope at a time, so a global predecessor could not be
    // validated from there — see PROPOSAL-provenance.md §4.
    assert.equal(other.writerPrev, GENESIS);
  } finally { discard(root); }
});

// --- the protocol-1 freeze ------------------------------------------------------

test("the mandatory envelope is checked at the door, field by field", async () => {
  // The freeze deleted every accommodation for events written before `writer`,
  // `writerPrev`, list-form `after`, and the version numbers — events that never
  // existed, because nothing was ever deployed. What replaces them is a door: a line
  // missing any of it is dropped, rather than folding under a guessed default.
  const dir = mkdtempSync(join(tmpdir(), "codemap-freeze-"));
  try {
    const shard = join(dir, "w_one.ndjson");
    const good = testEvent({ id: "0000000001-aa", writer: "w_one" });
    const drop = (over: Record<string, unknown>) => JSON.stringify({ ...good, id: "0000000002-bb", ...over });

    writeFileSync(shard, [
      JSON.stringify(good),
      drop({ writer: undefined }),
      drop({ writerPrev: undefined }),
      drop({ after: undefined }),
      drop({ after: "0000000001-aa" }),          // the old bare-string form
      drop({ sidecarProtocol: undefined }),
      drop({ eventSchema: undefined }),
    ].join("\n") + "\n", "utf8");

    const read = await readShard(shard);
    // CONTROL is the first line: if the door rejected everything — or if the file
    // simply failed to parse — this would be 0 and the test would "pass" for the
    // wrong reason.
    assert.deepEqual(read.map((e) => e.id), [good.id], "the well-formed one, and only it");
  } finally { discard(dir); }
});

test("a writerPrev naming another writer's event grants nothing", () => {
  // `writerPrev` means "my own previous event": naming somebody else's would inherit
  // their whole read set and cover them as a head — over-crediting.
  const a = testEvent({ id: "0000000001-a", writer: "WA" });
  const b = testEvent({ id: "0000000002-b", writer: "WB", writerPrev: "0000000001-a" });
  assert.equal(readSets([a, b]).saw(b.id, a.id), false, "a cross-writer chain claim is not a sighting");
  assert.deepEqual(causalHeads([a, b]).sort(), [a.id, b.id].sort(), "and it does not cover the other writer");

  // CONTROL — the same claim made honestly, through `after`, DOES grant sight.
  const b2 = testEvent({ id: "0000000002-b", writer: "WB", after: [a.id] });
  assert.equal(readSets([a, b2]).saw(b2.id, a.id), true);
});

test("an event may not be named GENESIS", () => {
  // The sentinel is a word, not an id. An event actually called `GENESIS` becomes the
  // apparent predecessor of every chain opening and lends them everything it saw.
  const shadow = testEvent({ id: GENESIS, writer: "W", writerPrev: "absent" });
  assert.equal(wellFormed(shadow), false, "refused at the door");

  // …and even if one reached a read set, the sentinel is never looked up.
  const h = testEvent({ id: "h", writer: "V" });
  const ghost = testEvent({ id: GENESIS, writer: "W", writerPrev: "absent", after: [h.id] });
  const fresh = testEvent({ id: "z", writer: "W", writerPrev: GENESIS });
  assert.equal(readSets([fresh, ghost, h]).saw(fresh.id, h.id), false);

  // CONTROL — an ordinary chain opening is still well formed and still opens a chain.
  const ok = testEvent({ id: "0000000001-a", writer: "W", writerPrev: GENESIS });
  assert.equal(wellFormed(ok), true);
});

// --- a scope is a POSIX path, on every platform ----------------------------------

/**
 * The string `scopesOnDisk` returns is not merely a path.
 *
 * `projectionFor` prefix-matches it against `"notes/"`/`"docs/"`/…, and `inUniverse`
 * slices it at the first `/`. A separator that is right for the filesystem and wrong
 * for those two consumers makes `materializeUniverse` skip every scope in silence —
 * which is what `path.join` did on win32 for as long as the sidecar has existed, so
 * the projection the architecture rests on was never built there and every read fell
 * back to folding the log. See COD-12.
 *
 * These pass on POSIX either way, because `path.join` already yields `/` there. That
 * is not a vacuous test: it is one whose failing platform now runs in CI, which is
 * why the Windows job was added BEFORE this fix rather than after it.
 */
const scopeFixture = (root: string, scopes: string[]): void => {
  for (const s of scopes) {
    mkdirSync(join(root, s), { recursive: true });
    writeFileSync(join(root, s, `w_fixture${SHARD_EXT}`), "");
  }
};

test("a discovered scope is the same string the writer built", async () => {
  const root = tmp();
  try {
    // Two segments, which is what a GitHub slug gives and what the bug was found on:
    // `notes/<universe>/<bucket>` is then FOUR path segments deep.
    const universe = "acme/api";
    const built = [docScope(universe), noteScope(universe, "d7"), noteScope(universe, "cc")];
    scopeFixture(root, built);
    assert.deepEqual(await scopesOnDisk(root), [...built].sort());
  } finally { discard(root); }
});

test("every scope on disk routes to a projection — what materialization iterates", async () => {
  const root = tmp();
  try {
    const universe = "acme/api";
    scopeFixture(root, [docScope(universe), noteScope(universe, "d7"), bugScope(universe)]);
    const scopes = await scopesOnDisk(root);
    assert.equal(scopes.length, 3, "the fixture is what is being iterated");
    for (const scope of scopes) {
      assert.ok(projectionFor(scope), `no projection for ${scope} — materializeUniverse would skip it`);
      assert.ok(!scope.includes("\\"), `${scope} carries a backslash, which no consumer accepts`);
    }
  } finally { discard(root); }
});

test("the win32 form of the same scope routes nowhere — the separator is not cosmetic", () => {
  // Pins WHY the walk above may not use `path.join`. If a consumer is ever made
  // tolerant of backslashes this fails, and that should be a deliberate edit rather
  // than something that quietly makes the fix above look unnecessary.
  const posix = noteScope("acme/api", "d7");
  const win = posix.split("/").reduce((a, b) => win32.join(a, b));
  assert.equal(win, "notes\\acme\\api\\d7", "the shape win32 produces");
  assert.ok(projectionFor(posix), "the POSIX form routes");
  assert.equal(projectionFor(win), null, "and the win32 form does not");
});
