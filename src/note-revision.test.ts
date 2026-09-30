/**
 * A note's revision carries `was`, like a finding's: staged against a value a teammate has
 * since changed, it is refused at replay and its author told (plan 5.1).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { scenario, who, inSequence, settle, type Scenario } from "./scenario.js";
import { createNote, reviseNote, notesForTarget } from "./shared-notes.js";
import { begin, syncSession } from "./sync-engine.js";

const U = "acme/api";
const T = "a_1";
const NEW = { targetKind: "anchor" as const, targetId: T, kind: "note" as const, text: "the original text" };

async function team(fn: (s: Scenario, id: string) => Promise<void>) {
  const s = await scenario(["izzie@x.com", "dana@x.com"]);
  try {
    const izzie = who(s, "izzie@x.com");
    const id = await createNote(izzie.sidecar, U, izzie.actor, NEW);
    await settle(s);
    await fn(s, id);
  } finally { s.dispose(); }
}

const note = async (s: Scenario, principal: string) =>
  (await notesForTarget(who(s, principal).sidecar, U, T))[0]!;

test("a note revised against a value a teammate has since changed is refused at replay, naming what moved", async () => {
  await team(async (s, id) => {
    const izzie = who(s, "izzie@x.com"), dana = who(s, "dana@x.com");
    begin(izzie.sidecar);
    await reviseNote(izzie.sidecar, U, T, izzie.actor, id, { category: "auth", severity: "high", line: 10 });
    await reviseNote(dana.sidecar, U, T, dana.actor, id, { category: "billing", severity: "high", line: 42 });
    const r = await syncSession(izzie.sidecar, izzie.actor);
    assert.ok("error" in r, "izzie's revision replays against dana's");
    // Severity agreed, so it is not named (owner, Q5: identical is not a conflict).
    assert.match(r.conflicts?.[0]?.why ?? "", /^category, line changed since you read it$/);
    await settle(s).catch(() => {});
    for (const p of ["izzie@x.com", "dana@x.com"]) {
      const n = await note(s, p);
      assert.deepEqual([n.category, n.line, n.revisions.length], ["billing", 42, 1], `${p} holds dana's alone`);
    }
  });
});

test("revising with the full picture is ordinary collaboration", async () => {
  await team(async (s, id) => {
    await inSequence(
      s,
      "izzie@x.com", (p) => reviseNote(p.sidecar, U, T, p.actor, id, { text: "izzie's" }),
      "dana@x.com", (p) => reviseNote(p.sidecar, U, T, p.actor, id, { text: "dana's, having read izzie's" }),
    );
    assert.equal((await note(s, "izzie@x.com")).text, "dana's, having read izzie's");
  });
});
