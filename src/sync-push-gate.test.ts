/**
 * A pull that arms the push gate says so (plan 2026-10-02-review-topics, F25).
 *
 * Measured in docs/review-topics.md §7: an event of a family this build does not
 * read is folded by no scope, so the sync summary said `blocked: []` and the very next
 * write was refused as newer. The gate is one place, so the summary asks it.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { team, who } from "./oracle.js";
import { sharedSync } from "./ops-shared.js";
import { LINEAR_SHARD, SIDECAR_PROTOCOL, EVENT_SCHEMA, mintId } from "./eventlog.js";

const git = (cwd: string, ...args: string[]) =>
  spawnSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", ...args], { cwd, encoding: "utf8" });

test("a sync that pulls a family this build does not read names the push gate it armed", async () => {
  const t = await team(["ana@acme.test", "ben@acme.test"]);
  try {
    const ana = who(t, "ana@acme.test"), ben = who(t, "ben@acme.test");
    const before = await sharedSync(ben.repo) as Record<string, unknown>;
    assert.equal(before.pushBlocked, null, "nothing newer yet");

    // What a newer build writes, pushed with plain git: a scope family this build has never heard of.
    const dir = join(ana.sidecar, "futurething", "acme-api");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, LINEAR_SHARD), JSON.stringify({
      id: mintId(), kind: "futurething.made", subject: "x", actor: ana.actor, at: new Date().toISOString(),
      writer: "w_future", writerPrev: "GENESIS", after: [], sidecarProtocol: SIDECAR_PROTOCOL, eventSchema: EVENT_SCHEMA,
      data: {}, seq: 100_000,
    }) + "\n");
    git(ana.sidecar, "add", "-A"); git(ana.sidecar, "commit", "-qm", "a newer build"); git(ana.sidecar, "push", "-q", "origin", "HEAD:main");

    const after = await sharedSync(ben.repo) as { materialized?: { blocked: unknown[] }; pushBlocked?: string | null; error?: string };
    assert.equal(after.error, undefined, String(after.error));
    assert.deepEqual(after.materialized?.blocked, [], "no folded scope is blocked — which is why the summary used to look clean");
    assert.match(String(after.pushBlocked), /futurething/, "but the gate is armed, and the summary says so");
  } finally { t.dispose(); }
});
