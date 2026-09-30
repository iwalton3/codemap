import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { team, machine, settle, cloneMachine, type Member } from "./oracle.js";
import { Ledger, checkSettled } from "./oracle-properties.js";
import { shareFinding, sharedFindings } from "./ops-shared.js";
import { begin, syncSession } from "./sync-engine.js";
import { readScopeChecked, scopesOnDisk } from "./eventlog.js";

/**
 * WORKFLOW 3 — one person, two machines, one writer id.
 *
 * A restored backup, a synced home directory, a machine image: one writer id in two clones.
 * Under the merge model that forked the writer's chain and `heal` existed for it. Under the
 * linear log it cannot: an event's `writerPrev` is taken from the tip when it is replayed, so
 * two clones sharing an id extend ONE chain in push order. What is left to prove is that the
 * copy is harmless — nothing forks, nothing blocks, nothing is lost — including when the two
 * write apart (one inside a transaction).
 */

const IZZIE = "izzie@acme.test";
const BEN = "ben@acme.test";
const PR = 7;

const writerOf = (m: Member): string | null => {
  try { return readFileSync(join(m.sidecar, ".git", "codemap-writer"), "utf8").trim(); }
  catch { return null; }
};

test("a cloned machine shares a writer id harmlessly: one chain, no fork, nothing blocked", async () => {
  const t = await team([IZZIE, IZZIE, BEN]);
  const ledger = new Ledger();
  try {
    // Ben is on the sidecar throughout: `t.all` checks what the copy does to him too.
    const laptop = machine(t, "m0"), desktop = machine(t, "m1");
    await shareFinding(laptop.repo, PR, { targetKind: "anchor", targetId: "a_laptop", text: "filed from the laptop" });
    cloneMachine(laptop, desktop);
    assert.equal(writerOf(desktop), writerOf(laptop), "precondition: both machines are one writer");

    // Apart: the laptop's act is staged, the desktop's lands, then the laptop syncs.
    begin(laptop.sidecar);
    await shareFinding(laptop.repo, PR, { targetKind: "anchor", targetId: "a_laptop2", text: "laptop, staged" });
    await shareFinding(desktop.repo, PR, { targetKind: "anchor", targetId: "a_desktop", text: "filed from the desktop" });
    const r = await syncSession(laptop.sidecar, laptop.actor);
    assert.ok(!("error" in r), JSON.stringify(r));
    await settle(t);
    await checkSettled(t, ledger);

    for (const m of t.all) {
      const scope = (await scopesOnDisk(m.sidecar)).find((s) => s.startsWith("findings/"))!;
      const read = await readScopeChecked(m.sidecar, scope);
      assert.equal(read.status, "complete", `${m.machine}: a shared writer id is not a fork any more`);
      const f = await sharedFindings(m.repo, PR) as any;
      assert.deepEqual(f.findings.map((x: any) => x.text).sort(),
        ["filed from the desktop", "filed from the laptop", "laptop, staged"], `${m.machine} lost a write`);
    }
  } finally { t.dispose(); }
});
