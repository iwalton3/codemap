import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { scenario, who, concurrently, settle, asAgent, type Scenario } from "./scenario.js";
import { createFinding, revise, resolveContest, readFindings, ackQueue } from "./shared-findings.js";
import * as shared from "./ops-shared.js";
import { discard } from "./test-tmp.js";
import { matrix } from "./test-matrix.js";

const git = (root: string, ...args: string[]) => spawnSync("git", args, { cwd: root, encoding: "utf8" });

const withEnv = async (vars: Record<string, string | undefined>, fn: () => Promise<void>) => {
  const saved: Record<string, string | undefined> = {};
  for (const k of Object.keys(vars)) { saved[k] = process.env[k]; if (vars[k] === undefined) delete process.env[k]; else process.env[k] = vars[k]!; }
  try { await fn(); } finally { for (const k of Object.keys(saved)) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]!; } }
};

const PR = "acme/api/pr-264";
const NEW = { targetKind: "anchor" as const, targetId: "a_1", text: "the original text", comment: "the original ask", severity: "medium" as const };

/**
 * A contest between izzie ("critical") and dana ("low"), and a third person
 * carol who has seen both and holds no stake in it.
 *
 * The existing clearing tests both settle on "high" — a value NEITHER
 * participant wrote — which turns out to be the only cell of this matrix that
 * ever worked. The whole point here is to settle on the values a person is
 * actually offered.
 */
async function contested(fn: (s: Scenario, id: string) => Promise<void>) {
  const s = await scenario(["izzie@x.com", "dana@x.com", "carol@x.com"]);
  try {
    const izzie = who(s, "izzie@x.com");
    const id = await createFinding(izzie.sidecar, PR, izzie.actor, NEW);
    await settle(s);
    await concurrently(
      s,
      "izzie@x.com", (p) => revise(p.sidecar, PR, p.actor, id, { severity: "critical" }),
      "dana@x.com", (p) => revise(p.sidecar, PR, p.actor, id, { severity: "low" }),
    );
    assert.ok((await readFindings(izzie.sidecar, PR)).get(id)!.contested?.length, "precondition: contested");
    await fn(s, id);
  } finally { s.dispose(); }
}

/**
 * Settling must clear it for EVERYONE, not just the person who clicked — the
 * fold replays history on every read, so a clear that does not survive the
 * replay leaves the item in every teammate's ack queue forever, with no button
 * that can shift it.
 */
async function assertSettled(s: Scenario, id: string, expected: string) {
  await settle(s);
  for (const p of s.all) {
    const f = (await readFindings(p.sidecar, PR)).get(id)!;
    assert.equal(f.severity, expected, `value for ${p.actor.principal}`);
    assert.equal(f.contested, undefined, `still contested for ${p.actor.principal}`);
    assert.equal(ackQueue([f]).length, 0, `still in ${p.actor.principal}'s ack queue`);
  }
}

// --- the matrix: who settles it × which value they pick -------------------------

// One cell of the 3x3 on a platform run. The cross-product proves the fold picks the
// right winner and the fold is platform-independent, so Linux proves it for everyone;
// what Windows adds is the plumbing underneath, and one cell exercises all of it.
// The `both buttons` test below is deliberately NOT collapsed — see its comment.
for (const settler of matrix(["izzie@x.com", "dana@x.com", "carol@x.com"])) {
  for (const [label, value] of matrix([["their own", "critical"], ["dana's", "low"], ["a third", "high"]] as const)) {
    test(`${settler} settles on ${label} value (${value})`, async () => {
      await contested(async (s, id) => {
        const p = who(s, settler);
        const r = await resolveContest(p.sidecar, PR, p.actor, id, "severity", value);
        assert.ok(!("error" in r), JSON.stringify(r));
        await assertSettled(s, id, value);
      });
    });
  }
}

// --- the two the browser actually offers ---------------------------------------

/**
 * `web/shared.js` renders exactly two buttons per contested field — "keep
 * <held.by>'s" and "keep <incoming.by>'s" — so these are the only settlements a
 * person can reach without a CLI. If a cell of the matrix above fails but these
 * pass, the bug is theoretical; if these fail, the feature does not exist.
 */
test("both buttons the browser offers actually settle it", async () => {
  for (const value of ["critical", "low"]) {
    for (const settler of ["izzie@x.com", "dana@x.com"]) {
      await contested(async (s, id) => {
        const p = who(s, settler);
        const r = await resolveContest(p.sidecar, PR, p.actor, id, "severity", value);
        assert.ok(!("error" in r), `${settler} keeping ${value}: ${JSON.stringify(r)}`);
        await assertSettled(s, id, value);
      });
    }
  }
});

// --- the op the UI and MCP both call --------------------------------------------

/**
 * A person's machine: a code repo whose `.codemap/sidecar` points at their own
 * clone of the shared sidecar. The ops layer takes the UNIVERSE root and derives
 * both the sidecar and the actor from it, which is the binding under test.
 */
function machine(origin: string, principal: string, dirs: string[]) {
  const mk = (tag: string) => { const d = mkdtempSync(join(tmpdir(), `codemap-cs-${tag}-`)); dirs.push(d); return d; };
  const root = mk("repo");
  const side = mk("side");
  for (const r of [root, side]) {
    git(r, "init", "-q", "-b", "main");
    git(r, "config", "user.email", principal);
    git(r, "config", "user.name", principal);
  }
  git(side, "remote", "add", "origin", origin);
  // The same code origin on both, because `universeKey` is the origin slug and
  // scopes are universe-qualified: two clones of different-named directories are
  // two different universes and would never see each other's findings. Never
  // fetched — teammates clone one repo, and this is how that looks on disk.
  git(root, "remote", "add", "origin", "https://github.com/acme/api.git");
  mkdirSync(join(root, ".codemap"), { recursive: true });
  writeFileSync(join(root, ".codemap", "sidecar"), side, "utf8");
  return root;
}

/**
 * `resolveContest` is the library call; `settleContest` is what the HTTP route
 * (`serve.ts` case "settle") and the MCP tool actually reach. Nothing covered the
 * latter at all, so a break in the binding — the wrong prKey, a dropped actor —
 * would not have shown up in any of the tests above.
 *
 * Driven end to end through `ops-shared` for that reason: a universe root in,
 * `sharedFindings` out, exactly as a browser sees it.
 */
test("settleContest, the op behind the route and the MCP tool, clears it", async () => {
  const dirs: string[] = [];
  const origin = mkdtempSync(join(tmpdir(), "codemap-cs-origin-"));
  dirs.push(origin);
  git(origin, "init", "-q", "--bare", "-b", "main");
  try {
    await withEnv({ CODEMAP_SIDECAR: undefined, CODEMAP_AGENT_MODEL: undefined }, async () => {
      const izzie = machine(origin, "izzie@x.com", dirs);
      const dana = machine(origin, "dana@x.com", dirs);
      const sync = async () => { for (let i = 0; i < 2; i++) for (const m of [izzie, dana]) await shared.sharedSync(m); };

      await sync();
      const created = await shared.shareFinding(izzie, 264, NEW) as { id: string; error?: string };
      assert.ok(!created.error, JSON.stringify(created));
      await sync();

      // Concurrent: both revise, then both sync. Neither `after` names the other.
      await shared.reviseFinding(izzie, 264, created.id, { severity: "critical" });
      await shared.reviseFinding(dana, 264, created.id, { severity: "low" });
      await sync();

      const before = await shared.sharedFindings(izzie, 264) as { contested: number };
      assert.equal(before.contested, 1, "precondition: the op layer sees it as contested");

      // dana's own value, settled by dana — the cell that failed every way it could.
      const r = await shared.settleContest(dana, 264, created.id, "severity", "low") as { error?: string };
      assert.ok(!r?.error, JSON.stringify(r));
      await sync();

      for (const m of [izzie, dana]) {
        const v = await shared.sharedFindings(m, 264) as { contested: number; waitingOnYou: number; findings: { severity?: string }[] };
        assert.equal(v.contested, 0, `still contested on ${m}`);
        assert.equal(v.waitingOnYou, 0, `still waiting on a person on ${m}`);
        assert.equal(v.findings[0]!.severity, "low");
      }
    });
  } finally { dirs.forEach((d) => discard(d)); }
});

// --- the ratchet still holds ----------------------------------------------------

/**
 * Clearing moved ahead of the conflict tests, and this is the guard that it did
 * not also move ahead of the ratchet: a disagreement between two PEOPLE is the
 * one thing an agent may never decide, and an agent restating either value must
 * leave the contest standing.
 */
test("an agent restating a value does not clear a contest", async () => {
  for (const value of ["critical", "low", "high"]) {
    await contested(async (s, id) => {
      const izzie = who(s, "izzie@x.com");
      // Straight to `revise`: `resolveContest` refuses agents up front, and the
      // fold must refuse them too, for events arriving from somebody else's client.
      await revise(izzie.sidecar, PR, asAgent(izzie, "claude-opus-5"), id, { severity: value });
      await settle(s);
      for (const p of s.all) {
        assert.ok(
          (await readFindings(p.sidecar, PR)).get(id)!.contested?.length,
          `an agent cleared it with ${value} for ${p.actor.principal}`,
        );
      }
    });
  }
});
