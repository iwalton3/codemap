import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Anchor, State } from "./schema.js";
import { writeStore, writeSnapshot, readTriage } from "./store.js";
import { setTriageBatch, setTriage, ratchet } from "./triage.js";
import { spineRole, layerOf } from "./pr-story.js";

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
    await writeSnapshot(root, "headsha", "feature", [anchor("a_new", "sha256:NEW")], "2026-08-18T00:00:00Z");

    await setTriageBatch(root, [{ anchorId: "a_new", importance: "business-critical", complexity: "deep" }], { source: "agent", ref: "headsha" });
    const t = (await readTriage(root)).triage.find((x) => x.target.id === "a_new")!;
    assert.equal(t.witnesses[0]!.bodyHash, "sha256:NEW", "a symbol only on the branch must not witness sha256:absent");
    assert.equal(t.likely, true, "an agent proposes; it does not confirm");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("batch triage obeys the same ratchet as a single set — agents never lower a human mark", async () => {
  const root = mkdtempSync(join(tmpdir(), "codemap-prtri-"));
  try {
    await writeStore(root, [anchor("a_1", "sha256:H")], state);
    await setTriage(root, { targetKind: "anchor", targetId: "a_1", importance: "business-critical", complexity: "deep", source: "human" });

    const r = await setTriageBatch(root, [{ anchorId: "a_1", importance: "low", complexity: "wiring" }], { source: "agent" });
    assert.equal(r.applied, 0);
    assert.equal(r.refused, 1);
    const t = (await readTriage(root)).triage.find((x) => x.target.id === "a_1")!;
    assert.equal(t.importance, "business-critical", "the human's tier stands");
    assert.equal(t.source, "human");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("batch triage still escalates — raising is always allowed", async () => {
  const root = mkdtempSync(join(tmpdir(), "codemap-prtri-"));
  try {
    await writeStore(root, [anchor("a_1", "sha256:H")], state);
    await setTriage(root, { targetKind: "anchor", targetId: "a_1", importance: "low", complexity: "wiring", source: "agent" });
    const r = await setTriageBatch(root, [{ anchorId: "a_1", importance: "business-critical", complexity: "deep" }], { source: "agent" });
    assert.equal(r.applied, 1);
    const t = (await readTriage(root)).triage.find((x) => x.target.id === "a_1")!;
    assert.equal(t.importance, "business-critical");
    assert.equal(t.complexity, "deep");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("the extracted ratchet is what both paths use", () => {
  const human = { target: { kind: "anchor" as const, id: "a" }, importance: "business-critical" as const, likely: false, source: "human" as const, at: "", witnesses: [] };
  assert.ok("refused" in ratchet(human, { importance: "low", source: "agent" }), "agents cannot lower");
  assert.ok(!("refused" in ratchet(human, { importance: "low", source: "human" })), "a human can");
  assert.ok("refused" in ratchet(human, { importance: "business-critical", source: "graph" }), "the blind graph batch does not nag a human mark");
});
