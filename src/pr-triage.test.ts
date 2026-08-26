import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Anchor, State } from "./schema.js";
import { writeStore, writeSnapshot, readTriage } from "./store.js";
import { setTriageBatch, setTriage, ratchet, triageStatus } from "./triage.js";
import { spineRole, backendSpineRole, layerOf } from "./pr-story.js";
import { workShapes } from "./pr.js";
import { spawnSync } from "node:child_process";
import { fixtureHash } from "./fixture-hash.js";
import { discard } from "./test-tmp.js";

const state: State = { schemaVersion: 1, lastVerifiedCommit: null, branch: null } as State;
const anchor = (id: string, hash: string): Anchor => ({ id, file: "src/x.cs", symbolPath: ["X"], kind: "function", bodyHash: hash, lastVerifiedCommit: null });

test("spineRole says nothing about a symbol it cannot place; layerOf still orders it", () => {
  assert.equal(spineRole("Acme.API/Domains/D/Commands/Confirm.cs", "ConfirmEndpoint"), 0);
  assert.equal(spineRole("Acme.API/Domains/D/Queries/Get.cs", "GetThing"), 4);
  // a service or model is on no recognisable layer — deriving "important" from the
  // ordering fallback would assert a stake about every unclassifiable file
  assert.equal(spineRole("Acme.API/Services/Templating/MoneyModule.cs", "MoneyModule"), null);
  assert.equal(layerOf("Acme.API/Services/Templating/MoneyModule.cs", "MoneyModule"), 3, "ordering still places it mid-spine");
});

test("batch triage witnesses against the given ref, not the working tree", async () => {
  const root = mkdtempSync(join(tmpdir(), "codemap-prtri-"));
  try {
    await writeStore(root, [], state);                                    // symbol not on this branch
    await writeSnapshot(root, "headsha", "feature", [anchor("a_new", fixtureHash("NEW"))], "2026-08-18T00:00:00Z");

    await setTriageBatch(root, [{ anchorId: "a_new", importance: "business-critical", complexity: "deep" }], { source: "agent", ref: "headsha" });
    const t = (await readTriage(root)).triage.find((x) => x.target.id === "a_new")!;
    assert.equal(t.witnesses[0]!.bodyHash, fixtureHash("NEW"), "a symbol only on the branch must not witness sha256:absent");
    assert.equal(t.likely, true, "an agent proposes; it does not confirm");
  } finally { discard(root); }
});

test("batch triage obeys the same ratchet as a single set — agents never lower a human mark", async () => {
  const root = mkdtempSync(join(tmpdir(), "codemap-prtri-"));
  try {
    await writeStore(root, [anchor("a_1", fixtureHash("H"))], state);
    await setTriage(root, { targetKind: "anchor", targetId: "a_1", importance: "business-critical", complexity: "deep", source: "human" });

    const r = await setTriageBatch(root, [{ anchorId: "a_1", importance: "low", complexity: "wiring" }], { source: "agent" });
    assert.equal(r.applied, 0);
    assert.equal(r.refused, 1);
    const t = (await readTriage(root)).triage.find((x) => x.target.id === "a_1")!;
    assert.equal(t.importance, "business-critical", "the human's tier stands");
    assert.equal(t.source, "human");
  } finally { discard(root); }
});

test("batch triage still escalates — raising is always allowed", async () => {
  const root = mkdtempSync(join(tmpdir(), "codemap-prtri-"));
  try {
    await writeStore(root, [anchor("a_1", fixtureHash("H"))], state);
    await setTriage(root, { targetKind: "anchor", targetId: "a_1", importance: "low", complexity: "wiring", source: "agent" });
    const r = await setTriageBatch(root, [{ anchorId: "a_1", importance: "business-critical", complexity: "deep" }], { source: "agent" });
    assert.equal(r.applied, 1);
    const t = (await readTriage(root)).triage.find((x) => x.target.id === "a_1")!;
    assert.equal(t.importance, "business-critical");
    assert.equal(t.complexity, "deep");
  } finally { discard(root); }
});

test("the extracted ratchet is what both paths use", () => {
  const human = { target: { kind: "anchor" as const, id: "a" }, importance: "business-critical" as const, likely: false, source: "human" as const, at: "", witnesses: [] };
  assert.ok("refused" in ratchet(human, { importance: "low", source: "agent" }), "agents cannot lower");
  assert.ok(!("refused" in ratchet(human, { importance: "low", source: "human" })), "a human can");
  assert.ok("refused" in ratchet(human, { importance: "business-critical", source: "graph" }), "the blind graph batch does not nag a human mark");
});

test("a PR's parse-derived shapes are computed once per commit pair, not per request", async () => {
  // Reading and tree-sitter-parsing every file a PR touches is the expensive half of
  // the worklist — 1,319ms for 2,012 changed symbols across 490 files, measured —
  // and it is a pure function of two immutable commits. It was being redone on every
  // request, including the whole-story reload after each sign-off.
  const root = mkdtempSync(join(tmpdir(), "codemap-shape-"));
  try {
    mkdirSync(join(root, "src"));
    const src = "export function transfer(cents: number) {\n  if (cents < 0) throw new Error('neg');\n  return cents;\n}\n";
    writeFileSync(join(root, "src/pay.ts"), src);
    const g = (...a: string[]) => spawnSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", ...a], { cwd: root });
    g("init", "-q", "-b", "main"); g("add", "-A"); g("commit", "-qm", "one");
    const head = spawnSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).stdout.trim();

    const entries = [{ b: { id: "a_1", file: "src/pay.ts" }, change: "changed" }];
    const first = await workShapes(root, "base-sha", head, entries);
    assert.ok(first.size > 0, "the head blob was read and parsed");

    // Same commit pair → the SAME map, not a recomputation. Asking for a file that
    // does not exist proves it: a recompute would come back empty.
    const second = await workShapes(root, "base-sha", head, [{ b: { id: "a_1", file: "does/not/exist.ts" }, change: "changed" }]);
    assert.equal(second, first, "a second request on the same two commits must not re-parse");

    // A different commit pair is a different question and is computed afresh.
    const other = await workShapes(root, "other-base", head, entries);
    assert.notEqual(other, first);
  } finally { discard(root); }
});

test("the batch ratchet is judged on BAR and severity, not just on importance", async () => {
  // The existing batch tests only compared importance on both sides, which is
  // exactly the input where an agent could lower a human's mark: a complexity-only
  // write left importance untouched while dropping the bar from `signed` to
  // `viewed` and the severity from high to medium.
  const root = mkdtempSync(join(tmpdir(), "codemap-bar-"));
  try {
    await writeStore(root, [anchor("a_1", fixtureHash("A"))], state);
    await writeSnapshot(root, "h", "feature", [anchor("a_1", fixtureHash("A"))], "2026-08-19T00:00:00Z");
    await setTriage(root, { targetKind: "anchor", targetId: "a_1", importance: "business-critical", source: "human" });
    const before = await triageStatus(root, { kind: "anchor", id: "a_1" });
    assert.equal(before.bar, "signed");

    // complexity only, from an agent: no importance to compare, and `wiring` is the
    // cheapest tier — the shape that used to slip through
    const r = await setTriageBatch(root, [{ anchorId: "a_1", complexity: "wiring" }], { source: "agent", ref: "h" });
    assert.equal(r.applied, 0);
    assert.equal(r.refused, 1);

    const after = await triageStatus(root, { kind: "anchor", id: "a_1" });
    assert.equal(after.bar, "signed", "the bar a human set is what an agent must not lower");
    assert.equal(after.severity, before.severity);
    assert.equal(after.likely, before.likely, "and it stays a confirmed human mark, not an agent proposal");
  } finally { discard(root); }
});

test("front-end paths order a PR but never assert stakes", async () => {
  // `spineRole` places front-end files so a React PR can be ORDERED, but those
  // positions are indices into the backend's stake table — so every `/components/`
  // and `/routes/` file asserted "important", which pins severity at >= medium and
  // leaves the ranking carrying no information at all.
  for (const [file, sym] of [["src/api/orders.ts", "fetchOrders"], ["src/components/Spinner.tsx", "Spinner"], ["src/routes/orders.tsx", "OrdersRoute"]] as const) {
    assert.equal(backendSpineRole(file, sym), null, `${file} is not on the command → read-model spine`);
    assert.notEqual(spineRole(file, sym), null, "but it still has an ordering position");
  }
  // the backend spine is untouched
  assert.equal(backendSpineRole("Acme.API/Domains/D/Commands/Confirm.cs", "ConfirmEndpoint"), 0);
  assert.equal(backendSpineRole("Acme.API/Domains/D/Queries/Get.cs", "GetThing"), 4);
});
