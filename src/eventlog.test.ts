import { test } from "node:test";
import { testEvent } from "./test-events.js";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync, appendFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, win32 } from "node:path";
import type { Actor } from "./schema.js";
import { ACK_KIND, evidenceDigest, chainCycles, wellFormed, mintId, shardFor, appendEvents, readShard, readScope, readScopeChecked, sortEvents, causalHeads,
  causality, writerFor, detectForks, scopeStatus, emitEvent, scopesOnDisk, SHARD_EXT, GENESIS, SIDECAR_PROTOCOL, EVENT_SCHEMA,
  type LogEvent } from "./eventlog.js";
import { projectionFor } from "./shared-projections.js";
import { docScope } from "./shared-docs.js";
import { noteScope } from "./shared-notes.js";
import { bugScope } from "./shared-bugs.js";
import { discard } from "./test-tmp.js";

const izzie: Actor = { principal: "izzie@x.com" };
const dana: Actor = { principal: "dana@x.com" };
const izzieAgent: Actor = { principal: "izzie@x.com", via: { kind: "agent", model: "claude-opus-5" } };

/**
 * One writer PER PRINCIPAL, which is what these tests mean by "a different person".
 *
 * Before the freeze the vector fell back to `actor.principal`, so passing a different
 * principal was enough to get a different vector key. It keys on the writer alone
 * now, and a shared default would quietly fold two people into one chain — turning
 * "concurrent" into "sequential" and passing tests that assert the opposite.
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

test("independent events order by id, so every machine folds the same state", () => {
  const a = ev("0000000001-aa"), b = ev("0000000002-bb"), c = ev("0000000003-cc");
  assert.deepEqual(sortEvents([c, a, b]).map((e) => e.id), [a.id, b.id, c.id]);
});

test("causality beats the clock — a fast laptop cannot reorder a reply before its cause", () => {
  // dana's machine is a minute fast, so her id sorts FIRST; but she wrote it having
  // already seen izzie's, and `after` says so. Without this the refutation lands
  // ahead of the confirmation it was answering.
  const cause = ev("0000000009-izz", { kind: "confirmed" });
  const reply = ev("0000000001-dan", { kind: "refuted", actor: dana, after: [cause.id] });
  assert.deepEqual(sortEvents([reply, cause]).map((e) => e.kind), ["confirmed", "refuted"]);
});

test("an `after` naming an event this scope does not have is not a deadlock", () => {
  const orphan = ev("0000000005-aa", { after: ["0000000001-elsewhere"] });
  assert.deepEqual(sortEvents([orphan]).map((e) => e.id), [orphan.id]);
});

test("a cycle still yields every event — a log that refuses to load is worse", () => {
  const a = ev("0000000001-aa", { after: ["0000000002-bb"] });
  const b = ev("0000000002-bb", { after: ["0000000001-aa"] });
  assert.equal(sortEvents([a, b]).length, 2);
});

test("sorting is deterministic regardless of input order", () => {
  const evs = [ev("0000000003-cc"), ev("0000000001-aa", { after: ["0000000002-bb"] }), ev("0000000002-bb")];
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
  const second = ev("0000000002-aa", { after: [first.id] });
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
  assert.equal(causality([H, O, E]).saw(E.id, H.id), false,
    "the desktop never saw Dana's revision, and the laptop agent's sighting is not its own");
});

test("…but one machine's own history is still its own", () => {
  // The control. Keying by writer must not simply make everything unseen: on one
  // clone the previous event genuinely IS a causal parent — and the chain is what
  // says so. `E` names `O` as its predecessor, which is what `emitEvent` writes.
  const H = ago("0000000001-aa", "dana@x.com", "w_dana");
  const O = ago("0000000002-bb", "izzie@x.com", "w_laptop", [H.id]);
  const E = ago("0000000003-cc", "izzie@x.com", "w_laptop", undefined, undefined, O.id);
  assert.equal(causality([H, O, E]).saw(E.id, H.id), true);
});

test("two events of one writer that BOTH open the chain lend nothing", () => {
  // The other half of the same rule, and the bug that made the old vector unsound:
  // one writer id on two clones. `O` and `E` both claim GENESIS, so they are not one
  // history — they are a fork — and fold order must not supply the edge between them.
  // Under the per-writer ordinal it did, and `E` was credited with Dana's revision
  // that only the OTHER clone ever saw.
  const H = ago("0000000001-aa", "dana@x.com", "w_dana");
  const O = ago("0000000002-bb", "izzie@x.com", "w_copied", [H.id]);
  const E = ago("0000000003-cc", "izzie@x.com", "w_copied");
  assert.equal(causality([H, O, E]).saw(E.id, H.id), false,
    "a forked writer's branches are separate histories");
  assert.equal(causality([H, O, E]).saw(E.id, O.id), false, "and they cannot see each other");
});


// --- the writer chain: writerPrev, GENESIS, and forks ---------------------------

/** An event that makes a chain claim. `prev` defaults to opening the chain. */
const link = (id: string, writer: string, prev: string = GENESIS, over: Partial<LogEvent> = {}): LogEvent =>
  testEvent({ id, subject: "f_1", actor: izzie, at: "2026-01-01T00:00:00Z", writer, writerPrev: prev, ...over });

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


test("an event with no writer is malformed, not a chain claim", () => {
  // Until the protocol-1 freeze, `causality` fell back to the principal so an event
  // written before writer ids could still fold — and `detectForks` had to ignore such
  // events, because attributing two machines' chains to one person calls their
  // independent GENESIS events a fork. No such event has ever existed: nothing was
  // deployed. The envelope is mandatory now, so the question moves to the door.
  const a = { ...link("0000000001-aa", "w_x"), writer: undefined } as unknown as LogEvent;
  const b = { ...link("0000000002-bb", "w_y"), writer: undefined } as unknown as LogEvent;
  assert.deepEqual(detectForks([a, b]), [], "nothing to fork: neither event names a chain");
  // CONTROL — the same two events WITH writers, each opening its own chain, are still
  // not a fork; and two sharing one writer are. Without these the assertion above
  // would pass against a `detectForks` that had simply stopped working.
  assert.deepEqual(detectForks([link("0000000001-aa", "w_x"), link("0000000002-bb", "w_y")]), []);
  assert.equal(detectForks([link("0000000001-aa", "w_x"), link("0000000002-bb", "w_x")]).length, 1);
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
  } finally { discard(root); }
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
    assert.equal(read.status, "complete", "a clone writing its own chain never forks it");
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
  } finally { discard(root); }
});

// --- the protocol-1 freeze ------------------------------------------------------

test("the mandatory envelope is checked at the door, field by field", async () => {
  // The freeze deleted every accommodation for events written before `writer`,
  // `writerPrev`, list-form `after`, and the version numbers — events that never
  // existed, because nothing was ever deployed. What replaces them is a door: a line
  // missing any of it is dropped, rather than folding under a guessed default.
  //
  // This matters beyond tidiness. `writerPrev` is the chain edge the causal vector
  // derives its segments from, and an absent one is not a missing convenience — it is
  // an event whose place in its own writer's history is unknown, which is exactly the
  // input that makes `saw()` fabricate knowledge.
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

// --- the segment vector ---------------------------------------------------------

test("a fork does not credit a third party with the branch they never saw", () => {
  // THE counterexample. It is why `docs/fork-repair.md` exists, and it defeated the
  // fix that shipped in the architecture doc first: dropping the writer's own
  // fold-order edge changes nothing here, because the false claim lives in X's
  // vector and is produced by the ORDINAL, not by that edge.
  //
  //   F1, F2  one writer, two clones, both opening the chain at GENESIS
  //   X       somebody else, who saw ONLY F2, disagreeing with F1 about the subject
  const F1 = testEvent({ id: "0000000001-a", writer: "W", subject: "S" });
  const F2 = testEvent({ id: "0000000002-a", writer: "W", subject: "T" });
  const X = testEvent({ id: "0000000003-a", writer: "X", subject: "S", after: [F2.id] });
  const c = causality(sortEvents([F1, F2, X]));

  assert.equal(c.saw(X.id, F1.id), false, "X never saw F1 and is no longer told it did");
  assert.ok(c.heads().includes(F1.id), "and F1 is still a head, so a later write can name it");

  // CONTROL — the same three events with F2 CHAINED onto F1. Now it is one honest
  // history, X really does hold all of it, and the vector must say so. Without this
  // the assertions above pass against a vector that credits nobody with anything.
  const F2c = testEvent({ id: "0000000002-a", writer: "W", subject: "T", writerPrev: F1.id });
  const ok = causality(sortEvents([F1, F2c, X]));
  assert.equal(ok.saw(X.id, F1.id), true, "a sequential writer's prefix is still a prefix");
  assert.deepEqual(ok.heads(), [X.id], "and only the tip is a head");
});

test("a fork's shared prefix is credited to both branches, and neither to the other", () => {
  // The case per-branch designs get wrong in one direction or the other. Everything
  // before the fork point is genuinely known to both branches; nothing after it is
  // known to the sibling.
  const a = testEvent({ id: "0000000001-a", writer: "W" });
  const b1 = testEvent({ id: "0000000002-a", writer: "W", writerPrev: a.id });
  const b2 = testEvent({ id: "0000000003-a", writer: "W", writerPrev: a.id });
  const c = causality(sortEvents([a, b1, b2]));
  assert.equal(c.saw(b1.id, a.id), true, "the shared prefix belongs to this branch");
  assert.equal(c.saw(b2.id, a.id), true, "…and to that one");
  assert.equal(c.saw(b1.id, b2.id), false, "but the branches lend each other nothing");
  assert.equal(c.saw(b2.id, b1.id), false);
  assert.deepEqual(c.heads().sort(), [b1.id, b2.id].sort(), "both branches stay reachable");
});

test("a segment key cannot be forged by a separator in a writer id or an event id", () => {
  // Segments are interned to INTEGERS. Keyed by `writer + NUL + root` instead, writer
  // `W` with root `a<NUL>b` collides with writer `W<NUL>a` with root `b` — and the
  // collision reproduces the very bug segments exist to fix. Third instance of that
  // class in this repo; see docs/anchor-id-provenance.md for the first.
  const SEP = String.fromCharCode(0);
  const target = testEvent({ id: `root${SEP}tail`, writer: "W", subject: "S" });
  const other = testEvent({ id: "tail", writer: `W${SEP}root`, subject: "T" });
  const x = testEvent({ id: "0000000009-x", writer: "X", subject: "S", after: [other.id] });
  const c = causality(sortEvents([target, other, x]));
  assert.equal(c.saw(x.id, target.id), false, "two different writers are two different keys");
  assert.ok(c.heads().includes(target.id), "and the aliased event is not covered away");
});

test("a writerPrev cycle is excluded rather than zeroing the scope", () => {
  // A.prev = B, B.prev = A. Left in the vector every event covers every other,
  // `heads()` returns NOTHING, and the next append records having seen nothing at
  // all — a silent, total loss of causality for the scope. A cycle has no place in
  // any segment, so it gets none, and `chainCycles` reports it.
  const a = testEvent({ id: "0000000001-a", writer: "W", writerPrev: "0000000002-b" });
  const b = testEvent({ id: "0000000002-b", writer: "W", writerPrev: "0000000001-a" });
  const sane = testEvent({ id: "0000000003-c", writer: "V" });
  assert.deepEqual(chainCycles([a, b]).sort(), [a.id, b.id].sort(), "both are reported");

  const c = causality(sortEvents([a, b, sane]));
  assert.equal(c.saw(a.id, b.id), false, "a cycle grants nobody anything");
  // …but it stays NAMEABLE. See "a cycle grants nothing but stays nameable": dropping
  // cyclic events from `heads()` makes them unreachable and hands the next append an
  // empty `after`, which is the loss this is meant to prevent.
  assert.deepEqual(c.heads().sort(), [a.id, b.id, sane.id].sort());

  // CONTROL — an acyclic chain of the same shape is untouched and reports no cycle.
  const p = testEvent({ id: "0000000001-a", writer: "W" });
  const q = testEvent({ id: "0000000002-b", writer: "W", writerPrev: p.id });
  assert.deepEqual(chainCycles([p, q]), []);
  assert.deepEqual(causality(sortEvents([p, q])).heads(), [q.id]);
});

test("a chain cycle blocks the scope ahead of anything it makes unjudgeable", () => {
  const a = testEvent({ id: "0000000001-a", writer: "W", writerPrev: "0000000002-b" });
  const b = testEvent({ id: "0000000002-b", writer: "W", writerPrev: "0000000001-a" });
  const st = scopeStatus([a, b]);
  assert.equal(st.status, "blocked");
  assert.equal(st.diagnostic?.reason, "chain-cycle");

  // CONTROL - the same two events acyclic are complete, so this is not "any chain
  // blocks". And a genuine fork still reports as a fork, not swallowed by the new arm.
  const p = testEvent({ id: "0000000001-a", writer: "W" });
  const q = testEvent({ id: "0000000002-b", writer: "W", writerPrev: p.id });
  assert.deepEqual(scopeStatus([p, q]), { status: "complete" });
  const f1 = testEvent({ id: "0000000001-a", writer: "W" });
  const f2 = testEvent({ id: "0000000002-b", writer: "W" });
  assert.equal(scopeStatus([f1, f2]).diagnostic?.reason, "fork");
});

test("a cycle with a branch hanging off it is still a cycle", () => {
  // Inferring cycles from "never got a segment" missed this, and I only found it by
  // probing: A and B loop, C also names A, so A looks like a fork point, B gets
  // treated as a segment root, and the loop becomes a segment with invented
  // ordinals. `saw(A, B)` came back TRUE for a pair with no honest order at all.
  const A = testEvent({ id: "A", writer: "W", writerPrev: "B" });
  const B = testEvent({ id: "B", writer: "W", writerPrev: "A" });
  const C = testEvent({ id: "C", writer: "W", writerPrev: "A" });
  assert.deepEqual(chainCycles([A, B, C]).sort(), ["A", "B"], "the loop, and not the branch off it");
  assert.equal(causality(sortEvents([A, B, C])).saw("A", "B"), false, "a loop grants nothing");

  // An event naming ITSELF is the degenerate case of the same shape.
  const self = testEvent({ id: "S", writer: "V", writerPrev: "S" });
  assert.deepEqual(chainCycles([self]), ["S"]);

  // CONTROL - a branch off an HONEST chain is not a cycle, and both branches keep
  // their segments. Without this the rule could be "any branch is a cycle".
  const p = testEvent({ id: "0000000001-p", writer: "U" });
  const q1 = testEvent({ id: "0000000002-q", writer: "U", writerPrev: "0000000001-p" });
  const q2 = testEvent({ id: "0000000003-r", writer: "U", writerPrev: "0000000001-p" });
  assert.deepEqual(chainCycles([p, q1, q2]), []);
  assert.equal(causality(sortEvents([p, q1, q2])).saw(q1.id, p.id), true);
});

test("a cycle grants nothing but stays nameable", () => {
  // Excluding cyclic events from segments was right and not sufficient: it also took
  // them out of `heads()`, and `emitEvent` captures `heads()` as the next event's
  // `after`. A cycle-only scope produced `after: []` — the append recorded having
  // seen nothing at all, which is the total causality loss the cycle handling exists
  // to prevent, arriving through the other door.
  const a = testEvent({ id: "a", writer: "W", writerPrev: "b" });
  const b = testEvent({ id: "b", writer: "W", writerPrev: "a" });
  assert.deepEqual(causalHeads(sortEvents([a, b])).sort(), ["a", "b"], "both nameable");
  assert.equal(causality(sortEvents([a, b])).saw("a", "b"), false, "and neither credited");

  // CONTROL — an honest chain still collapses to its tip. Without this, "everything
  // is a head" would pass the assertion above and destroy `after` entirely.
  const p = testEvent({ id: "0000000001-p", writer: "U" });
  const q = testEvent({ id: "0000000002-q", writer: "U", writerPrev: "0000000001-p" });
  assert.deepEqual(causalHeads(sortEvents([p, q])), [q.id]);
});

test("a writerPrev naming another writer's event grants nothing", () => {
  // `writerPrev` means "my own previous event". `buildSegments` already refused the
  // link, but the own-edge absorbed the raw field anyway — so an event could name
  // somebody else's, inherit their entire vector, and cover them in `heads()`. That
  // is over-crediting, which is the direction that suppresses contests.
  const a = testEvent({ id: "0000000001-a", writer: "WA" });
  const b = testEvent({ id: "0000000002-b", writer: "WB", writerPrev: "0000000001-a" });
  const c = causality(sortEvents([a, b]));
  assert.equal(c.saw(b.id, a.id), false, "a cross-writer chain claim is not a sighting");
  assert.deepEqual(c.heads().sort(), [a.id, b.id].sort(), "and it does not cover the other writer");

  // CONTROL — the same claim made honestly, through `after`, DOES grant sight.
  const b2 = testEvent({ id: "0000000002-b", writer: "WB", after: [a.id] });
  assert.equal(causality(sortEvents([a, b2])).saw(b2.id, a.id), true);
});

test("an event may not be named GENESIS", () => {
  // The sentinel is a word, not an id. An event actually called `GENESIS` becomes the
  // apparent predecessor of every chain opening and lends them everything it saw.
  const shadow = testEvent({ id: GENESIS, writer: "W", writerPrev: "absent" });
  assert.equal(wellFormed(shadow), false, "refused at the door");

  // …and even if one reached the vector, the sentinel is never looked up.
  const h = testEvent({ id: "h", writer: "V" });
  const ghost = testEvent({ id: GENESIS, writer: "W", writerPrev: "absent", after: [h.id] });
  const fresh = testEvent({ id: "z", writer: "W", writerPrev: GENESIS });
  assert.equal(causality(sortEvents([fresh, ghost, h])).saw(fresh.id, h.id), false);

  // CONTROL — an ordinary chain opening is still well formed and still opens a chain.
  const ok = testEvent({ id: "0000000001-a", writer: "W", writerPrev: GENESIS });
  assert.equal(wellFormed(ok), true);
});

// --- acknowledging blocking evidence ---------------------------------------------

test("an acknowledgment covers exactly its own evidence, and nothing later", () => {
  // Identity is a digest of the EVIDENCE, not of the prose describing it — so a copy
  // edit to the message does not look like new evidence, and a LATER fork does. That
  // second half is what makes acknowledging safe rather than a permanent mute.
  const f1 = testEvent({ id: "0000000001-a", writer: "W" });
  const f2 = testEvent({ id: "0000000002-b", writer: "W" });
  const forked = [f1, f2];
  const before = scopeStatus(forked);
  assert.equal(before.status, "blocked");
  assert.equal(before.diagnostic?.reason, "fork");

  const ack = testEvent({
    id: "0000000003-c", writer: "V", kind: ACK_KIND, subject: "s",
    after: [f1.id, f2.id],
    data: { acknowledges: [{ reason: "fork", digest: evidenceDigest(before.diagnostic!) }] },
  });
  const after = scopeStatus([...forked, ack]);
  assert.equal(after.status, "complete", "a person has seen this fork");
  assert.equal(after.acknowledged, true);
  assert.ok(after.diagnostic, "and the evidence stays visible rather than vanishing");

  // A NEW fork by another writer is different evidence, so the same ack does not
  // cover it. CONTROL against an implementation that stores "acked" per scope.
  const g1 = testEvent({ id: "0000000004-d", writer: "U" });
  const g2 = testEvent({ id: "0000000005-e", writer: "U" });
  assert.equal(scopeStatus([...forked, ack, g1, g2]).status, "blocked", "new evidence blocks again");
});

test("an agent cannot acknowledge, and neither can a digest written before its evidence", () => {
  const f1 = testEvent({ id: "0000000001-a", writer: "W" });
  const f2 = testEvent({ id: "0000000002-b", writer: "W" });
  const d = scopeStatus([f1, f2]).diagnostic!;
  const payload = { acknowledges: [{ reason: "fork", digest: evidenceDigest(d) }] };

  const byAgent = testEvent({
    id: "0000000003-c", writer: "V", kind: ACK_KIND, subject: "s", after: [f1.id, f2.id],
    actor: { principal: "izzie@x.com", via: { kind: "agent", model: "claude-opus-5" } },
    data: payload,
  });
  assert.equal(scopeStatus([f1, f2, byAgent]).status, "blocked",
    "settling a disagreement between two people is not an agent's call");

  // Planted: the right digest, but written without having seen the evidence. Without
  // the causal gate this lies dormant and activates the moment the fork appears.
  const planted = testEvent({
    id: "0000000000-z", writer: "V", kind: ACK_KIND, subject: "s", data: payload,
  });
  assert.equal(scopeStatus([f1, f2, planted]).status, "blocked",
    "an acknowledgment must have seen what it acknowledges");

  // CONTROL — the same digest, by a person, naming both branch heads. This is the
  // one that must WORK, and it only can because the segment vector keeps both
  // branches of a fork in `heads()`.
  const good = testEvent({
    id: "0000000009-y", writer: "V", kind: ACK_KIND, subject: "s", after: [f1.id, f2.id], data: payload,
  });
  assert.equal(scopeStatus([f1, f2, good]).status, "complete");
});

test("a newer protocol can never be acknowledged away", () => {
  // Clearing it would be agreeing to read data this build cannot interpret. It
  // resolves by upgrading, and there is no person-shaped way around that.
  const ahead = testEvent({ id: "0000000001-a", writer: "W", sidecarProtocol: 99 });
  const d = scopeStatus([ahead]).diagnostic!;
  const ack = testEvent({
    id: "0000000002-b", writer: "V", kind: ACK_KIND, subject: "s", after: [ahead.id],
    data: { acknowledges: [{ reason: d.reason, digest: evidenceDigest(d) }] },
  });
  // The ack is well formed and covers the digest; `sharedHeal` is what refuses to
  // write it. Pinned here so the refusal is not quietly dropped later.
  assert.equal(scopeStatus([ahead, ack]).diagnostic?.reason, "protocol");
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
