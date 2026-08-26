import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { team, who, settle, type Member, type Team } from "./oracle.js";
import { Ledger, checkSettled } from "./oracle-properties.js";
import { sharedFindings } from "./ops-shared.js";
import { readScope, scopesOnDisk } from "./eventlog.js";
import { withSidecarLock } from "./lock.js";
import { setTimeout } from "node:timers/promises";

/**
 * Two PROCESSES syncing one sidecar at once.
 *
 * The lock, the retry loop, the fetch outside the lock and the merge inside it have
 * never had two processes racing them — `src/scenario.ts` and the oracle harness both
 * serialise by construction, so the least-exercised safety mechanism in the system is
 * also the one whose failure is quietest. `docs/sidecar-gap.md` §2 calls this the
 * highest-value missing test, and it is the one thing the harness cannot help with:
 * two `await`s in one process share a lock owner and never contend at all.
 *
 * Real children, then: `node --input-type=module` against the built `dist/`, which is
 * the same code path the CLI and the MCP server take.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
/**
 * The child's `import` specifier must be a `file://` URL, not a path.
 * `D:\a\codemap\dist\ops-shared.js` in an ESM import is read as protocol `d:` and
 * Node refuses it — `ERR_UNSUPPORTED_ESM_URL_SCHEME`. POSIX never notices, because
 * there an absolute path and a bare specifier happen to be distinguishable.
 */
const run = promisify(execFile);

const A = "ana@acme.test";
const B = "ben@acme.test";

/**
 * A child process that files one finding and syncs — an ordinary write, not a probe.
 *
 * The RENDEZVOUS is what makes this a race rather than two things that happened.
 * Each child drops a marker and waits for its sibling's before touching the sidecar,
 * so both are inside the sync window together by construction. Without it, node's
 * ~50ms startup jitter is enough for one child to finish before the other begins —
 * and the test would pass having never put two writers on the lock at once, which is
 * the only thing it exists to do.
 *
 * `execFile` rather than a shell: the paths are temp dirs and the source is a blob of
 * JavaScript, and neither should ever meet a shell's quoting rules.
 */
interface RaceResult { id: string; from: number; to: number; retries: number }

function racer(m: Member, pr: number, tag: string, gate: string, other: string): Promise<RaceResult> {
  const script = `
    import { writeFileSync, existsSync } from "node:fs";
    import { setTimeout as sleep } from "node:timers/promises";
    import { shareFinding, sharedSync } from ${JSON.stringify(pathToFileURL(join(HERE, "ops-shared.js")).href)};

    writeFileSync(${JSON.stringify(gate)}, "ready");
    const deadline = Date.now() + 30000;
    while (!existsSync(${JSON.stringify(other)}) && Date.now() < deadline) await sleep(5);

    const from = Date.now();
    const f = await shareFinding(${JSON.stringify(m.repo)}, ${pr}, {
      targetKind: "anchor", targetId: "a_" + ${JSON.stringify(tag)},
      text: "filed by " + ${JSON.stringify(tag)},
    });
    if (f.error) { console.log("SHARE_FAILED " + f.error); process.exit(2); }
    const r = await sharedSync(${JSON.stringify(m.repo)});
    if (r.error) { console.log("SYNC_FAILED " + r.error); process.exit(3); }
    console.log(JSON.stringify({ ok: true, id: f.id, from, to: Date.now(), retries: r.retries ?? 0 }));
  `;
  return run(process.execPath, ["--no-warnings", "--input-type=module", "-e", script], {
    encoding: "utf8", timeout: 120_000,
  }).then(({ stdout, stderr }) => {
    const line = stdout.trim().split("\n").pop() ?? "";
    if (!line.startsWith("{")) throw new Error(`child ${tag} did not complete: ${stdout.trim()} ${stderr.trim()}`);
    return JSON.parse(line) as RaceResult;
  });
}

/** Both children, gated on each other. Returns their results in start order. */
function race(m: Member, pr: number, tags: [string, string]): Promise<RaceResult[]> {
  const gate = (tag: string) => join(m.repo, "..", `gate-${pr}-${tag}`);
  return Promise.all([
    racer(m, pr, tags[0], gate(tags[0]), gate(tags[1])),
    racer(m, pr, tags[1], gate(tags[1]), gate(tags[0])),
  ]);
}

const withTeam = async (fn: (t: Team) => Promise<void>) => {
  const t = await team([A, B]);
  try { await fn(t); } finally { t.dispose(); }
};

test("two processes syncing one sidecar: both land, nothing is lost", async () => {
  await withTeam(async (t) => {
    const ana = who(t, A);
    const PR = 31;

    const [one, two] = await race(ana, PR, ["one", "two"]) as [RaceResult, RaceResult];

    // THE CONTROL, and the whole test rests on it: prove the two processes were
    // actually inside the sidecar at the same time. Two sequential writes converge
    // trivially, so without this a green result says nothing about the lock.
    assert.ok(
      one.from < two.to && two.from < one.to,
      `the processes did not overlap, so nothing contended: ${JSON.stringify([one, two])}`,
    );

    // BOTH findings exist, on the clone that raced. A lost update is the failure the
    // lock exists to prevent, and it looks like success from either process alone.
    const mine = await sharedFindings(ana.repo, PR) as any;
    assert.equal(mine.findings.length, 2, `expected both findings, got ${mine.findings.map((f: any) => f.text).join(" / ")}`);
    assert.deepEqual(
      mine.findings.map((f: any) => f.text).sort(),
      ["filed by one", "filed by two"],
    );

    // And on the OTHER clone, which is the real test of "it was pushed" — a sync that
    // reports success while the events never leave the machine is a defect this
    // project has already shipped once.
    const ben = who(t, B);
    await settle(t);
    const theirs = await sharedFindings(ben.repo, PR) as any;
    assert.deepEqual(
      theirs.findings.map((f: any) => f.text).sort(),
      ["filed by one", "filed by two"],
      "both writes reached the teammate",
    );

    await checkSettled(t, new Ledger());
  });
});

test("the racing writes go to ONE shard, which is what makes it a race", async () => {
  // CONTROL. Two clones write different shards and cannot contend by construction —
  // so if these two processes had somehow written separate files, the test above
  // would pass without ever exercising the lock. They share a clone, so they share a
  // writer id, so they append to one file.
  await withTeam(async (t) => {
    const ana = who(t, A);
    const PR = 32;
    await race(ana, PR, ["alpha", "beta"]);

    const scope = (await scopesOnDisk(ana.sidecar)).find((s) => s.endsWith(`pr-${PR}`));
    assert.ok(scope, "the findings scope exists");
    const shards = readdirSync(join(ana.sidecar, scope!)).filter((f) => f.endsWith(".ndjson"));
    assert.equal(shards.length, 1, `one writer, one shard — got ${shards.join(", ")}`);

    const events = await readScope(ana.sidecar, scope!);
    assert.equal(events.length, 2, "and both appends are in it");
    assert.equal(new Set(events.map((e) => e.id)).size, 2, "with distinct ids");
  });
});

test("the loser WAITS for a held lock rather than stealing it", async () => {
  // The stronger claim, and the one an absent lock file cannot support: hold the
  // sidecar lock here, start a writer, and show it was still blocked when the hold
  // ended. A lock that was quietly stolen would let the child finish immediately —
  // and every assertion about the result would still pass, because one writer
  // succeeding looks exactly like two writers taking turns.
  await withTeam(async (t) => {
    const ana = who(t, A);
    const HELD_MS = 700;

    let released = 0;
    let child!: Promise<RaceResult>;
    await withSidecarLock(ana.sidecar, async () => {
      const gate = join(ana.repo, "..", "gate-solo");
      child = racer(ana, 34, "waiter", gate, gate); // its own gate: nothing to wait for but the lock
      await setTimeout(HELD_MS);
      released = Date.now();
    });

    const r = await child;
    assert.ok(
      r.to >= released,
      `the writer finished before the lock was released — it was stolen, not waited for `
      + `(finished ${released - r.to}ms early)`,
    );
    // And it did not merely survive: the write is really there.
    const after = await sharedFindings(ana.repo, 34) as any;
    assert.deepEqual(after.findings.map((f: any) => f.text), ["filed by waiter"]);
  });
});

test("the lock leaves nothing behind inside the sidecar", async () => {
  await withTeam(async (t) => {
    const ana = who(t, A);
    await race(ana, 35, ["x", "y"]);

    // The sidecar lock lives OUTSIDE the sidecar deliberately — `sync` is `git add -A`,
    // so a lock file inside it would be committed and pushed to the whole team, and
    // `commitLocal` skips only when `git status` is empty, so its mere appearance is
    // enough to commit.
    assert.equal(existsSync(join(ana.sidecar, ".codemap", ".lock")), false, "no lock inside the sidecar");
    assert.deepEqual(readdirSync(ana.sidecar).filter((f) => f.includes(".lock")), [], "and none at its root");
  });
});
