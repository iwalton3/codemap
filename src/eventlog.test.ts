import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, appendFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Actor } from "./schema.js";
import { mintId, shardFor, appendEvents, readShard, readScope, readScopeChecked, sortEvents, causalHeads,
  causality, writerFor, detectForks, scopeStatus, emitEvent, GENESIS, SIDECAR_PROTOCOL, EVENT_SCHEMA,
  type LogEvent } from "./eventlog.js";

const izzie: Actor = { principal: "izzie@x.com" };
const dana: Actor = { principal: "dana@x.com" };
const izzieAgent: Actor = { principal: "izzie@x.com", via: { kind: "agent", model: "claude-opus-5" } };

const ev = (id: string, over: Partial<LogEvent> = {}, principal?: string): LogEvent =>
  ({ id, kind: "noted", subject: "f_1", actor: principal ? { principal } : izzie, at: "2026-08-21T00:00:00Z", ...over });

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
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("two clones mint different writer ids", async () => {
  const a = tmp(), b = tmp();
  try {
    mkdirSync(join(a, ".git"), { recursive: true });
    mkdirSync(join(b, ".git"), { recursive: true });
    assert.notEqual(await writerFor(a), await writerFor(b));
  } finally { [a, b].forEach((r) => rmSync(r, { recursive: true, force: true })); }
});

// --- appending and reading ----------------------------------------------------

test("events round-trip through a shard", async () => {
  const root = tmp();
  try {
    await appendEvents(root, "pr-264", W_A, [ev(mintId(1)), ev(mintId(2))]);
    const got = await readScope(root, "pr-264");
    assert.equal(got.length, 2);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("appending twice extends the shard rather than replacing it", async () => {
  const root = tmp();
  try {
    await appendEvents(root, "pr-264", W_A, [ev(mintId(1))]);
    await appendEvents(root, "pr-264", W_A, [ev(mintId(2))]);
    assert.equal((await readScope(root, "pr-264")).length, 2);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("a scope collects every actor's shard", async () => {
  const root = tmp();
  try {
    await appendEvents(root, "pr-264", W_A, [ev(mintId(1))]);
    await appendEvents(root, "pr-264", W_A, [ev(mintId(2), { actor: dana })]);
    const got = await readScope(root, "pr-264");
    assert.equal(got.length, 2);
    assert.deepEqual([...new Set(got.map((e) => e.actor.principal))].sort(), ["dana@x.com", "izzie@x.com"]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("scopes are isolated", async () => {
  const root = tmp();
  try {
    await appendEvents(root, "pr-264", W_A, [ev(mintId(1))]);
    await appendEvents(root, "pr-227", W_A, [ev(mintId(2))]);
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
    await appendEvents(root, "pr-264", W_A, [ev(mintId(1)), ev(mintId(2))]);
    appendFileSync(join(root, shardFor("pr-264", W_A)), '{"id":"zzz","kind":"not-final', "utf8");
    const got = await readScope(root, "pr-264");
    assert.equal(got.length, 2, "the two whole events stand");
  } finally { rmSync(root, { recursive: true, force: true }); }
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
  } finally { rmSync(root, { recursive: true, force: true }); }
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
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("a line that parses but is not an event is skipped", async () => {
  const root = tmp();
  try {
    const f = join(root, shardFor("pr-264", W_A));
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
    await appendEvents(root, "pr-264", W_A, [e]);
    appendFileSync(join(root, shardFor("pr-264", W_A)), JSON.stringify(e) + "\n", "utf8");
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

test("the causal head is what descends from everything, not the highest id", () => {
  // These differ whenever two events share a millisecond and are ordered by their
  // random suffix. Taking the highest id made a writer's own consecutive events
  // read as concurrent — the exact ambiguity `after` exists to remove — because the
  // second one pointed `after` at something that was not what it had just seen.
  const first = ev("0000000009-zz");
  const second = ev("0000000002-aa", { after: first.id });
  const sorted = sortEvents([first, second]);
  assert.deepEqual(sorted.map((e) => e.id), [first.id, second.id], "causality put the low id last");
  assert.deepEqual(causalHeads(sorted), [second.id], "so the head is that one, not the max id");
});

test("the causal head of nothing is nothing", () => {
  assert.deepEqual(causalHeads([]), []);
});

test("a writer apart from another records BOTH heads, and neither is dropped", () => {
  // The whole reason `after` is a list. One id can only name one of two concurrent
  // writers, and everything behind the other vanishes from the record of what this
  // writer knew — which is how somebody who had read a disagreement in full could
  // be judged never to have seen half of it.
  const a = ev("0000000001-aa", {}, "alice@x.com");
  const b = ev("0000000002-bb", {}, "dana@x.com");
  const heads = causalHeads(sortEvents([a, b]));
  assert.deepEqual([...heads].sort(), [a.id, b.id]);

  const c = ev("0000000003-cc", { after: heads }, "bob@x.com");
  const causal = causality(sortEvents([a, b, c]));
  assert.ok(causal.saw(c.id, a.id), "bob saw alice");
  assert.ok(causal.saw(c.id, b.id), "bob saw dana");
});

/**
 * A late arrival CAN reorder events already folded. Pinned, because I claimed the
 * opposite and built a design paragraph on it.
 *
 * The shape is a forward reference: B names A as its parent, and A has not arrived
 * yet. While A is absent, B is eligible (`sortEvents` waits only for parents it can
 * SEE) and sorts by id. When A finally lands, B becomes blocked behind it and moves
 * — past events that had been sorting after it. Honest under cross-machine clock
 * skew: B's writer really had seen A, but A's id can still sort later.
 *
 * So there is no incremental shortcut. Anything cached off a scope's fold must be
 * rebuilt from the WHOLE scope when its event set changes, never patched with the
 * arriving event — see `PROPOSAL-sidecar-materialization.md` §2.
 */
test("a parent arriving late reorders the events that were waiting on it", () => {
  const A = ev("0000000003-aa");
  const B = ev("0000000001-bb", { after: [A.id] });   // names A, which is not here yet
  const C = ev("0000000002-cc");

  assert.deepEqual(sortEvents([B, C]).map((e) => e.id), [B.id, C.id], "B first: its parent is invisible");
  assert.deepEqual(sortEvents([A, B, C]).map((e) => e.id), [C.id, A.id, B.id], "and now B is last");
});

/**
 * The property that IS true, and the only one worth depending on: fold order is a
 * function of the event SET — not of arrival order, not of file order, not of which
 * shard a line came from.
 *
 * Random DAGs including forward references, which is exactly what the earlier
 * version of this test could not generate: it drew every parent from events already
 * in the list, so the case above was unreachable and 4,000 clean trials meant
 * nothing. The generator now emits some events whose parent arrives afterwards.
 */
test("fold order depends on the set alone, forward references included", () => {
  let seed = 987654321;
  const rand = (n: number) => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) % n;
  const people = ["a@x", "b@x", "c@x", "d@x"];
  const mint = () => String(rand(9999)).padStart(10, "0") + "-" + String(rand(1e6)).padStart(6, "0");

  let forwardRefs = 0;
  for (let trial = 0; trial < 300; trial++) {
    const ids = Array.from({ length: 14 }, mint);
    const evs = ids.map((id, i) => {
      const parents: string[] = [];
      // Backward refs from what exists, plus — the point of this test — forward
      // refs to ids that will only appear later in the array.
      if (i && rand(2)) parents.push(ids[rand(i)]!);
      if (i < ids.length - 1 && rand(3) === 0) { parents.push(ids[i + 1 + rand(ids.length - i - 1)]!); forwardRefs++; }
      return ev(id, parents.length ? { after: parents } : {}, people[rand(people.length)]);
    });

    const canonical = sortEvents([...evs]).map((e) => e.id);
    // Three different arrival orders of the same set must fold identically.
    for (let shuffle = 0; shuffle < 3; shuffle++) {
      const mixed = [...evs];
      for (let i = mixed.length - 1; i > 0; i--) { const j = rand(i + 1); [mixed[i], mixed[j]] = [mixed[j]!, mixed[i]!]; }
      assert.deepEqual(sortEvents(mixed).map((e) => e.id), canonical, "input order changed the fold");
    }
  }
  assert.ok(forwardRefs > 0, "no forward reference generated, so the interesting case was not exercised");
});

test("a bare `after` string still reads, so logs written before it was a list fold", () => {
  const a = ev("0000000001-aa", {}, "alice@x.com");
  const b = ev("0000000002-bb", { after: a.id }, "dana@x.com");   // the old one-id form
  assert.deepEqual(sortEvents([b, a]).map((e) => e.id), [a.id, b.id]);
  assert.ok(causality([a, b]).saw(b.id, a.id));
});

test("what a writer never pulled is not in their vector, whatever the fold order", () => {
  // dana writes offline; her id sorts FIRST, so an index comparison against fold
  // position concludes everyone later saw her. Nobody did until she pushed.
  const dana = ev("0000000001-aa", {}, "dana@x.com");
  const alice = ev("0000000005-bb", {}, "alice@x.com");
  const bob = ev("0000000009-cc", { after: [alice.id] }, "bob@x.com");
  const sorted = sortEvents([dana, alice, bob]);
  assert.deepEqual(sorted.map((e) => e.id), [dana.id, alice.id, bob.id], "dana folds first");
  const causal = causality(sorted);
  assert.ok(causal.saw(bob.id, alice.id), "bob saw alice");
  assert.ok(!causal.saw(bob.id, dana.id), "and did NOT see dana, despite her lower index");
});

test("a writer's own consecutive events keep their order even within one millisecond", () => {
  // The regression this was found by: two asks written back to back, the second
  // replacing the first. Same ms, so only `mintId`'s monotonicity separates them.
  const ids = Array.from({ length: 50 }, () => mintId(1_760_000_000_000));
  assert.deepEqual([...ids].sort(), ids, "minted in strictly increasing order");
});

// --- the vector is per WRITER, and that is not a detail ------------------------

/**
 * The hole this closes, which I had convinced myself was unreachable.
 *
 * `causality` compresses each writer's history to one ordinal, and `ownLast` treats
 * a writer's own previous event as a causal parent — true by construction for ONE
 * sequential writer. Keyed on the principal it is false for one person on two
 * machines, and the damage is not to that person's own record: it launders an
 * unrelated same-principal event's knowledge into the incoming one, so a real
 * contest between two OTHER people is silently suppressed.
 *
 * The agent is what makes it unambiguous rather than a human-versus-machine
 * question. `contest.ts` forbids an agent from settling a human disagreement, so an
 * agent having seen something cannot establish that the human did.
 */
const ago = (id: string, principal: string, writer?: string, after?: string[], via?: unknown): LogEvent => ({
  id, kind: "finding.revised", subject: "f_1",
  actor: (via ? { principal, via } : { principal }) as Actor,
  at: "2026-01-01T00:00:00Z",
  ...(after ? { after } : {}),
  ...(writer ? { writer } : {}),
} as LogEvent);

test("one person's two machines do not lend each other knowledge they never had", () => {
  //  H  Dana revises.
  //  O  Izzie's LAPTOP agent comments, having seen H.
  //  E  Izzie's stale DESKTOP revises, having seen neither.
  const H = ago("0000000001-aa", "dana@x.com", "w_dana");
  const O = ago("0000000002-bb", "izzie@x.com", "w_laptop", [H.id], { kind: "agent", model: "m" });
  const E = ago("0000000003-cc", "izzie@x.com", "w_desktop");
  assert.equal(causality([H, O, E]).saw(E.id, H.id), false,
    "the desktop never saw Dana's revision, and the laptop agent's sighting is not its own");
});

test("…but one machine's own history is still its own", () => {
  // The control. Keying by writer must not simply make everything unseen: on ONE
  // clone the previous event genuinely IS a causal parent, which is the whole
  // reason `ownLast` exists.
  const H = ago("0000000001-aa", "dana@x.com", "w_dana");
  const O = ago("0000000002-bb", "izzie@x.com", "w_laptop", [H.id]);
  const E = ago("0000000003-cc", "izzie@x.com", "w_laptop");
  assert.equal(causality([H, O, E]).saw(E.id, H.id), true);
});

test("an event written before writer ids folds exactly as it did", () => {
  // Backward compatibility is the whole reason `writer` is optional. Untagged
  // events fall back to the principal — which is the old behaviour, hole included.
  const H = ago("0000000001-aa", "dana@x.com");
  const O = ago("0000000002-bb", "izzie@x.com", undefined, [H.id]);
  const E = ago("0000000003-cc", "izzie@x.com");
  assert.equal(causality([H, O, E]).saw(E.id, H.id), true, "as it always did");

  // And a mixed log is safe rather than merely tolerable: an old event and a new
  // one from the same person land under different keys, so the fabricated edge
  // between them is not available in the first place.
  const mixed = ago("0000000003-cc", "izzie@x.com", "w_desktop");
  assert.equal(causality([H, O, mixed]).saw(mixed.id, H.id), false);
});

// --- the writer chain: writerPrev, GENESIS, and forks ---------------------------

/** An event that makes a chain claim. `prev` defaults to opening the chain. */
const link = (id: string, writer: string, prev: string = GENESIS, over: Partial<LogEvent> = {}): LogEvent =>
  ({ id, kind: "noted", subject: "f_1", actor: izzie, at: "2026-01-01T00:00:00Z",
     writer, writerPrev: prev, ...over });

test("a chain that never branches is not a fork", () => {
  const a = link("0000000001-aa", "w_one");
  const b = link("0000000002-bb", "w_one", a.id);
  const c = link("0000000003-cc", "w_one", b.id);
  assert.deepEqual(detectForks([a, b, c]), []);
});

test("two events naming one predecessor are a fork", () => {
  const a = link("0000000001-aa", "w_one");
  const b = link("0000000002-bb", "w_one", a.id);
  const b2 = link("0000000003-cc", "w_one", a.id);
  assert.deepEqual(detectForks([a, b, b2]),
    [{ writer: "w_one", prev: a.id, events: [b.id, b2.id] }]);
});

test("two clones that both open with GENESIS are a fork — the clause an implementation drops", () => {
  // Copy a clone BEFORE it has written anything and neither side has a predecessor
  // to disagree about. Treating the first event of a chain as unremarkable lets
  // exactly this pair through, and it is the commonest way one writer id ends up
  // in two places: a machine image, a synced home directory.
  const a = link("0000000001-aa", "w_copied");
  const b = link("0000000002-bb", "w_copied");
  assert.deepEqual(detectForks([a, b]),
    [{ writer: "w_copied", prev: GENESIS, events: [a.id, b.id] }]);
});

test("two writers each opening their own chain are not a fork", () => {
  // The control for the GENESIS rule. Every clone's first event names GENESIS, so
  // a detector keyed on the predecessor alone would call an ordinary team a fork.
  assert.deepEqual(detectForks([link("0000000001-aa", "w_one"), link("0000000002-bb", "w_two")]), []);
});

test("one event stitched in twice is not a fork", () => {
  // `merge=union` produces duplicate lines, and an id is minted once, so both
  // sightings are the same event making one chain claim.
  const a = link("0000000001-aa", "w_one");
  assert.deepEqual(detectForks([a, { ...a }]), []);
});

test("events written before the chain existed are not judged", () => {
  // No `writerPrev` is not an implicit GENESIS. Reading it as one would make every
  // pre-chain log in the wild a fork on its second event.
  const a = ev("0000000001-aa", { writer: "w_one" });
  const b = ev("0000000002-bb", { writer: "w_one" });
  assert.deepEqual(detectForks([a, b]), []);
  // …and the control: the same two events, once they make the claim.
  assert.equal(detectForks([link(a.id, "w_one"), link(b.id, "w_one")]).length, 1);
});

test("a chain claim needs a writer, not a principal", () => {
  // `causality` falls back to the principal so an old event still folds. A fork is
  // a claim about a CLONE, and the fallback would attribute two machines' chains to
  // one person and call their independent GENESIS events a fork.
  const a = { ...link("0000000001-aa", "w_x"), writer: undefined };
  const b = { ...link("0000000002-bb", "w_y"), writer: undefined };
  assert.deepEqual(detectForks([a, b]), []);
});

// --- scope status ---------------------------------------------------------------

test("an ordinary scope is complete", () => {
  assert.deepEqual(scopeStatus([link("0000000001-aa", "w_one")]), { status: "complete" });
});

test("a fork blocks the scope", () => {
  const st = scopeStatus([link("0000000001-aa", "w_c"), link("0000000002-bb", "w_c")]);
  assert.equal(st.status, "blocked");
  assert.equal(st.diagnostic?.reason, "fork");
  assert.deepEqual(st.diagnostic?.evidence, ["0000000001-aa", "0000000002-bb"]);
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

test("an unreadable envelope is reported ahead of a fork it makes unjudgeable", () => {
  // Precedence, not severity: this reader cannot know what a newer envelope means,
  // so every judgement downstream of it — the fork included — is unreliable.
  const st = scopeStatus(
    [link("0000000001-aa", "w_c"), link("0000000002-bb", "w_c", GENESIS, { sidecarProtocol: 99 })]);
  assert.equal(st.diagnostic?.reason, "protocol");
});

test("one id with two different bodies blocks the scope; the same body twice does not", async () => {
  const root = tmp();
  try {
    const dir = join(root, "s");
    mkdirSync(dir, { recursive: true });
    const a = link("0000000001-aa", "w_one");
    // Byte-identical, in two shards: exactly what `merge=union` produces.
    writeFileSync(join(dir, "w_one.ndjson"), JSON.stringify(a) + "\n");
    writeFileSync(join(dir, "w_two.ndjson"), JSON.stringify(a) + "\n");
    let read = await readScopeChecked(root, "s");
    assert.equal(read.status, "complete");
    assert.equal(read.events.length, 1, "and still deduped");

    // Same id, different content: two writers have claimed one identity.
    writeFileSync(join(dir, "w_two.ndjson"), JSON.stringify({ ...a, subject: "f_2" }) + "\n");
    read = await readScopeChecked(root, "s");
    assert.equal(read.status, "blocked");
    assert.equal(read.diagnostic?.reason, "duplicate-id");
    assert.deepEqual(read.diagnostic?.evidence, [a.id]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("a blocked scope still hands back its events", async () => {
  // Non-authoritative, not hidden. A reviewer who can see what the team wrote is
  // better placed to repair a fork than one staring at an empty page.
  const root = tmp();
  try {
    const dir = join(root, "s");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "w_c.ndjson"),
      [link("0000000001-aa", "w_c"), link("0000000002-bb", "w_c")].map((e) => JSON.stringify(e)).join("\n") + "\n");
    const read = await readScopeChecked(root, "s");
    assert.equal(read.status, "blocked");
    assert.equal(read.events.length, 2);
  } finally { rmSync(root, { recursive: true, force: true }); }
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
    assert.equal(read.status, "complete", "a clone writing its own chain never forks it");
  } finally { rmSync(root, { recursive: true, force: true }); }
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
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("a copied clone id forks the chain, and that is what the detector is for", async () => {
  const root = tmp();
  try {
    mkdirSync(join(root, ".git"), { recursive: true });
    await emitEvent(root, "s", izzie, "noted", "f_1");
    const writer = await writerFor(root);
    // The other clone, holding the same id, having pulled nothing: it opens with
    // GENESIS because ITS shard is empty. Union-merged in as a second line.
    appendFileSync(join(root, "s", writer + ".ndjson"),
      JSON.stringify(link("0000000009-zz", writer)) + "\n");
    const read = await readScopeChecked(root, "s");
    assert.equal(read.status, "blocked");
    assert.equal(read.diagnostic?.reason, "fork");
  } finally { rmSync(root, { recursive: true, force: true }); }
});
