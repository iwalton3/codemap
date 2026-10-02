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
    assert.deepEqual(g.moved.chapters, ["calc"]);
    assert.deepEqual(g.moved.symbols, [id.calc]);
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
