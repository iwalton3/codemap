/**
 * Review topics end to end through ops, on a real git repo with a local sidecar
 * (docs/review-topics.md; plan 2026-10-02-review-topics, phases 3-4).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { init } from "./ops.js";
import {
  topicDefine, topicRevise, topicRetire, topicList, topicPacket, topicWalkthroughSet, topicWalkthroughGet,
  topicStepMark, topicChapterMark,
} from "./ops/topics.js";
import { anchorMark } from "./ops/triage.js";
import { readSnapshot } from "./snapshots.js";
import { discard } from "./test-tmp.js";

const FEES = "export class Fees {\n  calc(c: number) {\n    return c * 2;\n  }\n  round(c: number) {\n    return Math.round(c);\n  }\n}\n";

async function repo() {
  const base = mkdtempSync(join(tmpdir(), "codemap-topics-ops-"));
  const root = join(base, "repo");
  mkdirSync(join(root, "src"), { recursive: true });
  mkdirSync(join(root, ".codemap"), { recursive: true });
  const git = (...a: string[]) => {
    const r = spawnSync("git", a, { cwd: root, encoding: "utf8" });
    if (r.status !== 0) throw new Error(`git ${a.join(" ")}: ${r.stderr}`);
    return r.stdout.trim();
  };
  git("init", "-q", "-b", "main");
  git("config", "user.email", "izzie@x.com"); git("config", "user.name", "izzie");
  writeFileSync(join(root, "src/fees.ts"), FEES);
  writeFileSync(join(root, "src/other.ts"), "export function other() {\n  return 1;\n}\n");
  writeFileSync(join(root, ".gitignore"), ".codemap/\n");
  writeFileSync(join(root, ".codemap", "sidecar"), join(base, "side"), "utf8");
  git("add", "-A"); git("commit", "-q", "-m", "one");
  await init(root);
  const commit = (path: string, text: string) => {
    writeFileSync(join(root, path), text); git("add", "-A"); git("commit", "-q", "-m", path); return git("rev-parse", "HEAD");
  };
  const ids = async (sha = git("rev-parse", "HEAD")) => {
    const snap = (await readSnapshot(root, sha))!;
    const by = (leaf: string) => snap.find((a) => a.symbolPath.at(-1) === leaf)!.id;
    return { fees: by("Fees"), calc: by("calc"), round: by("round"), other: by("other") };
  };
  return { root, commit, ids, head: () => git("rev-parse", "HEAD"), cleanup: () => discard(base) };
}

const ch = (title: string, ...anchorIds: string[]) => ({ title, blocks: anchorIds.map((anchorId) => ({ kind: "symbol" as const, anchorId })) });
const feat = (...chapters: ReturnType<typeof ch>[]) => [{ title: "Fees", summary: "the fee rules", chapters }];
const ok = <T>(r: T): Exclude<T, { error: string }> => {
  if (r && typeof r === "object" && "error" in r) assert.fail(String((r as { error: string }).error));
  return r as Exclude<T, { error: string }>;
};

test("define, packet, walk: a cited class covers its members, and citing outside the set is refused", async () => {
  const r = await repo();
  try {
    const id = await r.ids();
    ok(await topicDefine(r.root, { slug: "fees", title: "Fees", selector: { paths: ["src/fees.ts"] } }));
    const packet = ok(await topicPacket(r.root, "fees"));
    assert.deepEqual(packet.items.map((i) => i.id).sort(), [id.calc, id.fees, id.round].sort());
    assert.match(packet.items.find((i) => i.id === id.calc)!.head!, /return c \* 2/);

    const bad = await topicWalkthroughSet(r.root, "fees", feat(ch("all", id.fees, id.other))) as Record<string, unknown>;
    assert.deepEqual(bad.notInSet, [id.other]);
    const w = ok(await topicWalkthroughSet(r.root, "fees", feat(ch("the class", id.fees))));
    assert.deepEqual(w.coverage.uncovered, [], "the class covers calc and round");
    assert.equal(w.coverage.total, 3);
    assert.equal((await topicList(r.root) as { topics: { walks: number }[] }).topics[0]!.walks, 1);
  } finally { r.cleanup(); }
});

test("two walks at one commit both survive; a revision and a trunk commit show on the old one", async () => {
  const r = await repo();
  try {
    const id = await r.ids();
    ok(await topicDefine(r.root, { slug: "fees", title: "Fees", selector: { paths: ["src/fees.ts"] } }));
    const w1 = ok(await topicWalkthroughSet(r.root, "fees", feat(ch("calc", id.calc), ch("rest", id.fees, id.round))));
    const w2 = ok(await topicWalkthroughSet(r.root, "fees", feat(ch("everything", id.fees))));
    assert.notEqual(w1.walk!, w2.walk!);
    const g0 = ok(await topicWalkthroughGet(r.root, "fees", w1.walk!));
    assert.equal(g0.walkthroughs.length, 2);
    assert.deepEqual(g0.moved, { chapters: [], symbols: [] });
    assert.deepEqual(g0.selectorChanged, {});

    ok(await topicRevise(r.root, "fees", { selector: { paths: ["src/fees.ts", "src/other.ts"] } }));
    r.commit("src/fees.ts", FEES.replace("c * 2", "c * 3"));
    const g = ok(await topicWalkthroughGet(r.root, "fees", w1.walk!));
    assert.deepEqual(g.selectorChanged, { paths: { added: ["src/other.ts"], removed: [] } });
    assert.deepEqual(g.moved!.chapters, ["calc"]);
    assert.deepEqual(g.moved!.symbols, [id.calc]);
    assert.deepEqual(g.newlyMatched, [id.other]);
  } finally { r.cleanup(); }
});

test("sign-off history stays with each walk; the map's mark is re-projected from it", async () => {
  const r = await repo();
  try {
    const id = await r.ids();
    ok(await topicDefine(r.root, { slug: "fees", title: "Fees", selector: { paths: ["src/fees.ts"] } }));
    const w1 = ok(await topicWalkthroughSet(r.root, "fees", feat(ch("calc", id.calc), ch("rest", id.fees, id.round)), { whole: true }));
    const h1 = r.head();
    ok(await topicChapterMark(r.root, "fees", w1.walk!, "calc", { attestation: "signed" }));
    const w2 = ok(await topicWalkthroughSet(r.root, "fees", feat(ch("calc", id.calc), ch("rest", id.fees, id.round)), { whole: true }));
    ok(await topicStepMark(r.root, "fees", w2.walk!, id.calc, { attestation: "signed" }));

    const state = async (walk: string) => ok(await topicWalkthroughGet(r.root, "fees", walk)).signoffs!;
    assert.equal((await state(w1.walk!)).symbols[id.calc]?.signed, true, "walk 1 still reads signed in walk 1");
    assert.equal((await state(w1.walk!)).chapters.calc?.signed, true);

    ok(await topicStepMark(r.root, "fees", w2.walk!, id.calc, { attestation: "signed", unmark: true }));
    assert.equal((await state(w2.walk!)).symbols[id.calc]?.signed, false);
    assert.equal((await state(w1.walk!)).symbols[id.calc]?.signed, true, "walk 1 unchanged");
    assert.equal((await anchorMark(r.root, id.calc, { ref: h1 })).reviewed, true, "the map still shows calc signed, from walk 1");

    ok(await topicStepMark(r.root, "fees", w1.walk!, id.calc, { attestation: "signed", unmark: true }));
    assert.equal((await anchorMark(r.root, id.calc, { ref: h1 })).reviewed, false, "no walk signs it now, so the mark is gone");
  } finally { r.cleanup(); }
});

test("signing an older walk after a newer one leaves the newer walk's code accepted", async () => {
  const r = await repo();
  try {
    const id = await r.ids();
    ok(await topicDefine(r.root, { slug: "fees", title: "Fees", selector: { symbols: [id.calc] } }));
    const w1 = ok(await topicWalkthroughSet(r.root, "fees", feat(ch("calc", id.calc))));
    const h2 = r.commit("src/fees.ts", FEES.replace("c * 2", "c * 3"));
    const w2 = ok(await topicWalkthroughSet(r.root, "fees", feat(ch("calc", id.calc)), { whole: true }));
    ok(await topicStepMark(r.root, "fees", w2.walk!, id.calc, { attestation: "signed" }));
    ok(await topicStepMark(r.root, "fees", w1.walk!, id.calc, { attestation: "signed" }));
    assert.equal((await anchorMark(r.root, id.calc, { ref: h2 })).reviewed, true);
  } finally { r.cleanup(); }
});

test("a re-walk defaults to the delta since the latest walk this person signed in; whole on request", async () => {
  const r = await repo();
  try {
    const id = await r.ids();
    ok(await topicDefine(r.root, { slug: "fees", title: "Fees", selector: { paths: ["src/fees.ts"] } }));
    const h1 = r.head();
    const w1 = ok(await topicWalkthroughSet(r.root, "fees", feat(ch("all", id.fees))));
    r.commit("src/fees.ts", FEES.replace("c * 2", "c * 3"));
    const unsigned = ok(await topicPacket(r.root, "fees"));
    assert.equal(unsigned.counts.total, 3, "nothing signed yet: the whole selector");
    assert.equal(unsigned.base, undefined);

    ok(await topicStepMark(r.root, "fees", w1.walk!, id.fees, { attestation: "signed" }));
    const delta = ok(await topicPacket(r.root, "fees"));
    assert.equal(delta.base, h1);
    assert.deepEqual(delta.since, { walk: w1.walk!, head: h1 });
    assert.deepEqual(delta.items.map((i) => i.id), [id.calc], "only what changed since walk 1");
    assert.equal(ok(await topicPacket(r.root, "fees", { whole: true })).counts.total, 3);
  } finally { r.cleanup(); }
});

test("a retired topic is still listed with --all and refuses a new walk", async () => {
  const r = await repo();
  try {
    const id = await r.ids();
    ok(await topicDefine(r.root, { slug: "fees", title: "Fees", selector: { symbols: [id.calc] } }));
    ok(await topicRetire(r.root, "fees"));
    assert.equal((await topicList(r.root) as { topics: unknown[] }).topics.length, 0);
    assert.equal((await topicList(r.root, { all: true }) as { topics: { status: string }[] }).topics[0]!.status, "retired");
    assert.match((await topicWalkthroughSet(r.root, "fees", feat(ch("c", id.calc))) as { error: string }).error, /retired/);
    assert.match((await topicDefine(r.root, { slug: "fees", title: "again", selector: { symbols: [id.calc] } }) as { error: string }).error, /never reused/);
  } finally { r.cleanup(); }
});

test("topic findings: landed from a walk at main's tip, ancestry from an off-trunk one, searchable, on no PR, kept after retiring", async () => {
  const r = await repo();
  try {
    const { reportDefect } = await import("./ops/defect.js");
    const { findingBacklog } = await import("./ops-shared.js");
    const { search } = await import("./ops/read.js");
    const { readFindings } = await import("./store.js");
    const id = await r.ids();
    ok(await topicDefine(r.root, { slug: "fees", title: "Fees", selector: { paths: ["src/fees.ts"] } }));
    const onMain = ok(await topicWalkthroughSet(r.root, "fees", feat(ch("all", id.fees))));
    const file = (walk: string | undefined, comment: string) => reportDefect(r.root, {
      context: { kind: "topic", topic: "fees", ...(walk ? { walk } : {}) }, targetKind: "anchor", targetId: id.calc,
      text: "calc doubles where it should add the fee", comment, severity: "high",
    }) as Promise<Record<string, unknown>>;
    const f1 = await file(onMain.walk!, "calc doubles the amount");
    assert.equal(f1.error, undefined, String(f1.error));
    assert.equal(f1.topic, "fees");

    // An off-trunk head: a side branch that edits calc, walked there.
    spawnSync("git", ["checkout", "-q", "-b", "side"], { cwd: r.root });
    const side = r.commit("src/fees.ts", FEES.replace("c * 2", "c * 2 + 0"));
    spawnSync("git", ["checkout", "-q", "main"], { cwd: r.root });
    const offTrunk = ok(await topicWalkthroughSet(r.root, "fees", feat(ch("all", id.fees)), { head: side, whole: true }));
    const f2 = await file(offTrunk.walk!, "calc still doubles on the side branch");
    assert.equal(f2.error, undefined, String(f2.error));

    const b = await findingBacklog(r.root);
    const rows = [...b.due, ...b.woken, ...b.sleeping, ...b.live, ...b.moved, ...b.unjudgeable, ...b.unfetched, ...b.inReview];
    assert.equal(rows.find((x) => x.id === f1.id)?.landed, "landed", "its code is main's tip");
    assert.equal(rows.find((x) => x.id === f2.id)?.landed, "open", "off-trunk: ancestry says no, and a topic has no PR to ask");

    const hits = (await search(r.root, "doubles") as { findings: { id: string; pr?: string; state: string }[] }).findings;
    assert.deepEqual(hits.map((h) => h.pr).sort(), ["topic:fees", "topic:fees"]);
    assert.ok(hits.every((h) => typeof h.state === "string"));
    assert.equal((await readFindings(r.root, { pr: "1" })).findings.length, 0, "never on a pull request");

    ok(await topicRetire(r.root, "fees"));
    assert.equal((await readFindings(r.root, { pr: "topic:fees" })).findings.length, 2, "a retired topic's findings still list under its key");
    assert.match(String((await file(undefined, "another")).error), /retired/);
    // The door, not just the op: a write that skips `topicFindingContext` is refused too.
    const { shareFinding } = await import("./ops-shared.js");
    const direct = await shareFinding(r.root, "topic:fees", { targetKind: "anchor", targetId: id.calc, text: "x" } as never).catch((e: Error) => ({ error: e.message }));
    assert.match(String((direct as { error?: string }).error), /topic fees is retired/);
  } finally { r.cleanup(); }
});

test("withdrawing a container takes back only its cover, never a member's own sign-off", async () => {
  const r = await repo();
  try {
    const id = await r.ids();
    ok(await topicDefine(r.root, { slug: "fees", title: "Fees", selector: { paths: ["src/fees.ts"] } }));
    const w = ok(await topicWalkthroughSet(r.root, "fees", feat(ch("class", id.fees), ch("calc", id.calc), ch("round", id.round))));
    ok(await topicStepMark(r.root, "fees", w.walk!, id.calc, { attestation: "signed" }));
    ok(await topicStepMark(r.root, "fees", w.walk!, id.fees, { attestation: "signed" }));
    ok(await topicStepMark(r.root, "fees", w.walk!, id.fees, { attestation: "signed", unmark: true }));
    const s = ok(await topicWalkthroughGet(r.root, "fees", w.walk!)).signoffs!;
    assert.equal(s.symbols[id.calc]?.signed, true, "calc was signed in its own right");
    assert.equal(s.symbols[id.round]?.signed, false, "round was only ever covered");
    assert.equal((await anchorMark(r.root, id.calc, { ref: r.head() })).reviewed, true);
    assert.equal((await anchorMark(r.root, id.round, { ref: r.head() })).reviewed, false);
  } finally { r.cleanup(); }
});

test("a topic finding at a line nothing holds is not told to file on a branch", async () => {
  const r = await repo();
  try {
    const { reportDefect } = await import("./ops/defect.js");
    ok(await topicDefine(r.root, { slug: "fees", title: "Fees", selector: { paths: ["src/fees.ts"] } }));
    const e = await reportDefect(r.root, {
      context: { kind: "topic", topic: "fees" }, targetKind: "anchor", targetId: "src/fees.ts:400", text: "x", comment: "x is wrong",
    }) as { error?: string };
    assert.match(String(e.error), /not in topic fees/);
    assert.doesNotMatch(String(e.error), /your branch/);
  } finally { r.cleanup(); }
});

test("an identical define of a retired topic is refused, not a silent success (R21)", async () => {
  const r = await repo();
  try {
    const def = { slug: "fees", title: "Fees", selector: { paths: ["src/fees.ts"] } };
    ok(await topicDefine(r.root, def));
    ok(await topicRetire(r.root, "fees"));
    assert.match(String((await topicDefine(r.root, def) as { error?: string }).error), /never reused/);
  } finally { r.cleanup(); }
});

test("a chapter citing only the class shows moved when main changes a member (R15)", async () => {
  const r = await repo();
  try {
    const id = await r.ids();
    ok(await topicDefine(r.root, { slug: "fees", title: "Fees", selector: { paths: ["src/fees.ts"] } }));
    const w = ok(await topicWalkthroughSet(r.root, "fees", feat(ch("the class", id.fees))));
    r.commit("src/fees.ts", FEES.replace("c * 2", "c * 3"));
    const g = ok(await topicWalkthroughGet(r.root, "fees", w.walk!));
    assert.deepEqual(g.moved!.chapters, ["the-class"]);
    assert.deepEqual(g.moved!.symbols, [id.calc]);
  } finally { r.cleanup(); }
});

test("a path entry that matches nothing is reported unresolved (R18)", async () => {
  const r = await repo();
  try {
    ok(await topicDefine(r.root, { slug: "fees", title: "Fees", selector: { paths: ["src/fees.ts", "src/renamed.ts"] } }));
    const p = ok(await topicPacket(r.root, "fees"));
    assert.deepEqual(p.unresolved, [{ kind: "path", id: "src/renamed.ts" }]);
  } finally { r.cleanup(); }
});

test("a symbolic base is resolved to its commit when the topic is defined and revised (R20)", async () => {
  const r = await repo();
  try {
    const git = (...a: string[]) => spawnSync("git", a, { cwd: r.root, encoding: "utf8" }).stdout.trim();
    const h1 = r.head();
    git("branch", "release");
    ok(await topicDefine(r.root, { slug: "fees", title: "Fees", selector: { paths: ["src/fees.ts"], base: "release" } }));
    const sel = () => (topicList(r.root) as Promise<{ topics: { selector: { base?: string } }[] }>).then((l) => l.topics[0]!.selector.base);
    assert.equal(await sel(), h1);
    r.commit("src/fees.ts", FEES.replace("c * 2", "c * 3"));
    git("branch", "-f", "release", "HEAD");
    const id = await r.ids();
    const w = ok(await topicWalkthroughSet(r.root, "fees", feat(ch("calc", id.calc))));
    assert.equal(w.base, h1, "the walk's range is the commit the topic named, not where the branch is now");
    ok(await topicRevise(r.root, "fees", { selector: { paths: ["src/fees.ts"], base: "release" } }));
    assert.equal(await sel(), r.head());
    assert.match(String((await topicDefine(r.root, { slug: "x", title: "X", selector: { paths: ["a"], base: "nope" } }) as { error?: string }).error), /nope/);
  } finally { r.cleanup(); }
});

test("an empty walkthrough is refused (R34)", async () => {
  const r = await repo();
  try {
    ok(await topicDefine(r.root, { slug: "fees", title: "Fees", selector: { paths: ["src/fees.ts"] } }));
    assert.match(String((await topicWalkthroughSet(r.root, "fees", []) as { error?: string }).error), /walks nothing/);
  } finally { r.cleanup(); }
});

// ---------------------------------------------------------------------------
// Review round 2026-10-05 §B: the map mark carries topic acceptances apart from PR ones
// ---------------------------------------------------------------------------

test("withdrawing in a newer walk leaves only the older walk's acceptance on the map (R8, F25)", async () => {
  const r = await repo();
  try {
    const id = await r.ids();
    ok(await topicDefine(r.root, { slug: "fees", title: "Fees", selector: { symbols: [id.calc] } }));
    const w1 = ok(await topicWalkthroughSet(r.root, "fees", feat(ch("calc", id.calc))));
    ok(await topicStepMark(r.root, "fees", w1.walk!, id.calc, { attestation: "signed" }));
    const h2 = r.commit("src/fees.ts", FEES.replace("c * 2", "c * 3"));
    const w2 = ok(await topicWalkthroughSet(r.root, "fees", feat(ch("calc", id.calc)), { whole: true }));
    ok(await topicStepMark(r.root, "fees", w2.walk!, id.calc, { attestation: "signed" }));
    assert.equal((await anchorMark(r.root, id.calc, { ref: h2 })).reviewed, true);
    ok(await topicStepMark(r.root, "fees", w2.walk!, id.calc, { attestation: "signed", unmark: true }));
    assert.equal((await anchorMark(r.root, id.calc, { ref: h2 })).reviewed, false, "walk 2's body is no longer accepted");
  } finally { r.cleanup(); }
});

test("a topic withdrawal leaves a pull request's acceptance of the same symbol standing (R8)", async () => {
  const r = await repo();
  try {
    const { markReviewedBatch } = await import("./reviews.js");
    const id = await r.ids();
    const h = r.head();
    await markReviewedBatch(r.root, [id.calc], { level: "code", actor: "human", attestation: "signed", ref: h });
    ok(await topicDefine(r.root, { slug: "fees", title: "Fees", selector: { symbols: [id.calc] } }));
    const w = ok(await topicWalkthroughSet(r.root, "fees", feat(ch("calc", id.calc))));
    ok(await topicStepMark(r.root, "fees", w.walk!, id.calc, { attestation: "signed" }));
    ok(await topicStepMark(r.root, "fees", w.walk!, id.calc, { attestation: "signed", unmark: true }));
    assert.equal((await anchorMark(r.root, id.calc, { ref: h })).reviewed, true, "the pull request's sign-off still stands");
  } finally { r.cleanup(); }
});

test("a later walk's cover replaces an earlier walk's direct mark on the map (R8, F26)", async () => {
  const r = await repo();
  try {
    const id = await r.ids();
    ok(await topicDefine(r.root, { slug: "fees", title: "Fees", selector: { paths: ["src/fees.ts"] } }));
    const w1 = ok(await topicWalkthroughSet(r.root, "fees", feat(ch("calc", id.calc), ch("rest", id.fees, id.round))));
    ok(await topicStepMark(r.root, "fees", w1.walk!, id.calc, { attestation: "signed" }));
    const h2 = r.commit("src/fees.ts", FEES.replace("c * 2", "c * 3"));
    const w2 = ok(await topicWalkthroughSet(r.root, "fees", feat(ch("the class", id.fees)), { whole: true }));
    ok(await topicStepMark(r.root, "fees", w2.walk!, id.fees, { attestation: "signed" }));
    assert.equal((await anchorMark(r.root, id.calc, { ref: h2 })).reviewed, true, "walk 2's cover of calc is the standing one");
  } finally { r.cleanup(); }
});

test("withdrawing a covered member directly ends its cover in that walk; its siblings stay covered (R10)", async () => {
  const r = await repo();
  try {
    const id = await r.ids();
    ok(await topicDefine(r.root, { slug: "fees", title: "Fees", selector: { paths: ["src/fees.ts"] } }));
    const w = ok(await topicWalkthroughSet(r.root, "fees", feat(ch("the class", id.fees))));
    ok(await topicStepMark(r.root, "fees", w.walk!, id.fees, { attestation: "signed" }));
    ok(await topicStepMark(r.root, "fees", w.walk!, id.round, { attestation: "signed", unmark: true }));
    const s = ok(await topicWalkthroughGet(r.root, "fees", w.walk!)).signoffs!;
    assert.equal(s.symbols[id.round]?.signed, false);
    assert.equal(s.symbols[id.calc]?.signed, true);
    assert.equal((await anchorMark(r.root, id.round, { ref: r.head() })).reviewed, false);
  } finally { r.cleanup(); }
});

test("the re-walk base is the latest walk with a sign-off still standing — not a viewed one, not a withdrawn one (R13, R14)", async () => {
  const r = await repo();
  try {
    const id = await r.ids();
    ok(await topicDefine(r.root, { slug: "fees", title: "Fees", selector: { paths: ["src/fees.ts"] } }));
    const h1 = r.head();
    const w1 = ok(await topicWalkthroughSet(r.root, "fees", feat(ch("all", id.fees))));
    ok(await topicStepMark(r.root, "fees", w1.walk!, id.fees, { attestation: "signed" }));
    const h2 = r.commit("src/fees.ts", FEES.replace("c * 2", "c * 3"));
    const w2 = ok(await topicWalkthroughSet(r.root, "fees", feat(ch("all", id.fees)), { whole: true }));
    ok(await topicStepMark(r.root, "fees", w2.walk!, id.fees, { attestation: "viewed" }));
    r.commit("src/other.ts", "export function other() {\n  return 2;\n}\n");
    assert.equal(ok(await topicPacket(r.root, "fees")).base, h1, "walk 2 was only viewed");
    ok(await topicStepMark(r.root, "fees", w2.walk!, id.fees, { attestation: "signed" }));
    assert.equal(ok(await topicPacket(r.root, "fees")).base, h2);
    ok(await topicStepMark(r.root, "fees", w2.walk!, id.fees, { attestation: "signed", unmark: true }));
    assert.equal(ok(await topicPacket(r.root, "fees")).base, h1, "walk 2's sign-off was withdrawn");
  } finally { r.cleanup(); }
});

// ---------------------------------------------------------------------------
// Review round 2026-10-05 §C: indicators and what a selector resolves against
// ---------------------------------------------------------------------------

test("a walk whose head is not on main shows no 'main has moved' (R16)", async () => {
  const r = await repo();
  try {
    const id = await r.ids();
    ok(await topicDefine(r.root, { slug: "fees", title: "Fees", selector: { paths: ["src/fees.ts"] } }));
    spawnSync("git", ["checkout", "-q", "-b", "side"], { cwd: r.root });
    const side = r.commit("src/fees.ts", FEES.replace("c * 2", "c * 2 + 0"));
    spawnSync("git", ["checkout", "-q", "main"], { cwd: r.root });
    const w = ok(await topicWalkthroughSet(r.root, "fees", feat(ch("all", id.fees)), { head: side }));
    assert.equal(ok(await topicWalkthroughGet(r.root, "fees", w.walk!)).moved, null);
  } finally { r.cleanup(); }
});

test("MERGED is on main only when the merge commit reaches it (R17)", async () => {
  const { trunkMoved } = await import("./ops/pr.js");
  const { mergedOnto } = await import("./pr.js");
  const r = await repo();
  try {
    const git = (...a: string[]) => spawnSync("git", a, { cwd: r.root, encoding: "utf8" }).stdout.trim();
    const w = { features: [] };
    git("checkout", "-q", "-b", "stack-base");
    git("checkout", "-q", "-b", "stacked");
    const head = r.commit("src/other.ts", "export function other() {\n  return 3;\n}\n");
    git("checkout", "-q", "stack-base");
    git("merge", "-q", "--no-ff", "-m", "merge stacked", "stacked");
    const mergedIntoBase = r.head();
    git("checkout", "-q", "main");
    assert.equal(await trunkMoved(r.root, w, { headSha: head, state: "MERGED", mergeCommit: mergedIntoBase }), null, "merged into a stack base, not main");
    git("merge", "-q", "--no-ff", "-m", "merge base", "stack-base");
    assert.notEqual(await trunkMoved(r.root, w, { headSha: head, state: "MERGED", mergeCommit: mergedIntoBase }), null);

    assert.equal(mergedOnto({ at: "t", oid: "x" }, () => false), false, "merged elsewhere is not landed");
    assert.equal(mergedOnto({ at: "t", oid: "x" }, () => true), "t");
    assert.equal(mergedOnto({ at: "t", oid: "x" }, () => null), null, "a merge commit this clone lacks says nothing");
    assert.equal(mergedOnto({ at: "t", oid: null }, () => true), null);
    assert.equal(mergedOnto(false, () => true), false);
  } finally { r.cleanup(); }
});

test("a selector resolves with the walked commit's .codemapignore, not the working tree's (R19)", async () => {
  const r = await repo();
  try {
    r.commit(".codemapignore", "[tests]\nsrc/fees.ts\n");
    writeFileSync(join(r.root, ".codemapignore"), "");
    ok(await topicDefine(r.root, { slug: "fees", title: "Fees", selector: { paths: ["src/fees.ts"] } }));
    const p = ok(await topicPacket(r.root, "fees"));
    assert.equal(p.counts.total, 0);
    assert.deepEqual([...new Set(p.outside.map((o) => o.lane))], ["test"]);
  } finally { r.cleanup(); }
});
