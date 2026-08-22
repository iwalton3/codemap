import { test } from "node:test";
import assert from "node:assert/strict";
import { scenario, who, concurrently, inSequence, settle, asAgent, type Scenario } from "./scenario.js";
import { createNote, reviseNote, notesForTarget } from "./shared-notes.js";

const U = "acme/api";
const T = "a_1";
const NEW = { targetKind: "anchor" as const, targetId: T, kind: "note" as const, text: "the original text" };

/**
 * Real clones, not one directory.
 *
 * `emit` reads the log to find its causal heads, so two writes into a SHARED root
 * are sequential by construction — the second names the first and nothing is ever
 * concurrent. Manufacturing the concurrency this is about needs one sidecar per
 * person and a remote between them, which is what `scenario` builds.
 */
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

/**
 * `note.revised` used to overwrite these scalars unconditionally.
 *
 * Two people editing one note while apart resolved to whoever happened to fold
 * last, silently. Nothing was destroyed — `revisions` keeps both — but nobody was
 * ever asked to arbitrate, which is the entire job the residue does on a finding.
 * Notes are the same class of concurrent scalar rewrite and had none of it.
 */
test("two people revising one note without seeing each other is contested", async () => {
  await team(async (s, id) => {
    await concurrently(
      s,
      "izzie@x.com", (p) => reviseNote(p.sidecar, U, T, p.actor, id, { text: "izzie's reading" }),
      "dana@x.com", (p) => reviseNote(p.sidecar, U, T, p.actor, id, { text: "dana's reading" }),
    );
    for (const p of s.all) {
      const n = (await notesForTarget(p.sidecar, U, T))[0]!;
      assert.ok(n.contested?.length, `silent winner for ${p.actor.principal}`);
      assert.equal(n.contested![0]!.field, "text");
      assert.deepEqual(
        [n.contested![0]!.held.value, n.contested![0]!.incoming.value].sort(),
        ["dana's reading", "izzie's reading"],
      );
      assert.equal(n.revisions.length, 2, "and both readings survive in the history");
    }
  });
});

test("a person who has seen the disagreement settles it, for everyone", async () => {
  await team(async (s, id) => {
    await concurrently(
      s,
      "izzie@x.com", (p) => reviseNote(p.sidecar, U, T, p.actor, id, { text: "izzie's" }),
      "dana@x.com", (p) => reviseNote(p.sidecar, U, T, p.actor, id, { text: "dana's" }),
    );
    assert.ok((await note(s, "izzie@x.com")).contested?.length, "precondition");

    const izzie = who(s, "izzie@x.com");
    await reviseNote(izzie.sidecar, U, T, izzie.actor, id, { text: "dana's" });
    await settle(s);
    for (const p of s.all) {
      const n = (await notesForTarget(p.sidecar, U, T))[0]!;
      // The fold replays history on every read, so a clear has to survive that or
      // the disagreement is re-detected forever and nobody can ever settle it.
      assert.equal(n.contested, undefined, `still contested for ${p.actor.principal}`);
      assert.equal(n.text, "dana's");
    }
  });
});

test("an agent may not settle a disagreement between two people", async () => {
  await team(async (s, id) => {
    await concurrently(
      s,
      "izzie@x.com", (p) => reviseNote(p.sidecar, U, T, p.actor, id, { text: "izzie's" }),
      "dana@x.com", (p) => reviseNote(p.sidecar, U, T, p.actor, id, { text: "dana's" }),
    );
    const izzie = who(s, "izzie@x.com");
    await reviseNote(izzie.sidecar, U, T, asAgent(izzie, "claude-opus-5"), id, { text: "dana's" });
    await settle(s);
    for (const p of s.all) {
      assert.ok((await notesForTarget(p.sidecar, U, T))[0]!.contested?.length,
        `an agent cleared it for ${p.actor.principal}`);
    }
  });
});

test("revising with the full picture is ordinary collaboration, not a conflict", async () => {
  // The false-positive direction, and the one that matters most: a rule eager
  // enough to flag this trains people to clear the state without reading it.
  await team(async (s, id) => {
    await inSequence(
      s,
      "izzie@x.com", (p) => reviseNote(p.sidecar, U, T, p.actor, id, { text: "izzie's" }),
      "dana@x.com", (p) => reviseNote(p.sidecar, U, T, p.actor, id, { text: "dana's, having read izzie's" }),
    );
    const n = await note(s, "izzie@x.com");
    assert.equal(n.contested, undefined, "informed disagreement is a revision");
    assert.equal(n.text, "dana's, having read izzie's");
  });
});

test("every contestable scalar is covered, and agreeing on one is not a conflict", async () => {
  await team(async (s, id) => {
    await concurrently(
      s,
      "izzie@x.com", (p) => reviseNote(p.sidecar, U, T, p.actor, id, { category: "auth", severity: "high", line: 10 }),
      "dana@x.com", (p) => reviseNote(p.sidecar, U, T, p.actor, id, { category: "billing", severity: "high", line: 42 }),
    );
    const fields = ((await note(s, "dana@x.com")).contested ?? []).map((c) => c.field).sort();
    assert.deepEqual(fields, ["category", "line"], "severity agreed, so it is not contested");
  });
});
