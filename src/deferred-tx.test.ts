/**
 * A transaction that READS before it writes must take the write lock up front.
 *
 * `BEGIN` is DEFERRED: the first read takes a read snapshot, and the first write then tries
 * to upgrade it — which fails with `SQLITE_BUSY_SNAPSHOT` if anyone else wrote in between,
 * and `busy_timeout` does NOT wait that error out. A transaction that writes first never
 * hits it, because its very first statement takes the lock.
 *
 * That is what made two processes opening one store fail (triage
 * 2026-09-19-review-and-findings-systems, I10), and `tx` takes the lock up front for
 * exactly this reason. But `tx` has six call sites, all migrations: everything else in the
 * store opens a raw `BEGIN`, and one of those read first.
 *
 * WHAT THIS CAN AND CANNOT DO, in the idiom of `review-base-ledger.test.ts`. It cannot
 * prove a transaction is safe — it reads the first data statement after `BEGIN` and nothing
 * more, so a read reached through a helper is invisible to it. What it does is force a NEW
 * raw transaction to declare, and hold the enumeration nobody had when the first one was
 * written. A per-function test is not available here: the failure needs another writer to
 * land BETWEEN one transaction's read and its write, and nothing can get in there from
 * inside the same process.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * Every raw `BEGIN` in the tree, and why it is allowed to be deferred.
 *
 * `writes-first` — its first data statement is an INSERT/DELETE/UPDATE, so the lock is
 * taken by that statement and there is no snapshot to upgrade.
 *
 * Anything that reads first must use `tx` (which is `BEGIN IMMEDIATE` at top level)
 * instead, and so is not in this list at all.
 */
const RAW_BEGIN: Record<string, number> = {
  // The fold's two write-throughs: `proj.write` is the first statement in both.
  "src/materialize.ts": 2,
  // Anchor, node, edge, review and finding writers — each opens by deleting what it replaces.
  "src/store.ts": 12,
};

const FIRST_STATEMENT = /\b(SELECT|INSERT|UPDATE|DELETE|REPLACE)\b/;

/** Every source file below `src/`, tests excluded. */
function sources(dir = "src"): string[] {
  return readdirSync(dir).flatMap((f) => {
    // `join` gives backslashes on Windows, and every key below is written with forward
    // slashes — so without this the whole ledger reads as "every site moved". A path
    // separator leaking into a comparison is this repo's most-repeated Windows defect.
    const p = `${dir}/${f}`;
    if (statSync(p).isDirectory()) return sources(p);
    return p.endsWith(".ts") && !p.endsWith(".test.ts") ? [p] : [];
  });
}

test("a raw transaction that reads before it writes is a deferred-upgrade hazard", () => {
  const readsFirst: string[] = [];
  const counts: Record<string, number> = {};

  for (const file of sources()) {
    const lines = readFileSync(file, "utf8").split("\n");
    lines.forEach((line, i) => {
      // `BEGIN IMMEDIATE` is the safe form and is not what this is about.
      if (!/\bexec\("BEGIN"\)/.test(line)) return;
      counts[file] = (counts[file] ?? 0) + 1;
      // The first data statement after it, ignoring braces, comments and control flow.
      for (const next of lines.slice(i + 1, i + 12)) {
        const m = FIRST_STATEMENT.exec(next);
        if (!m) continue;
        if (m[1] === "SELECT") readsFirst.push(`${file}:${i + 1}`);
        return;
      }
    });
  }

  assert.deepEqual(readsFirst, [],
    "these read before they write inside a DEFERRED transaction — use `tx`, which takes the lock up front");
  assert.deepEqual(counts, RAW_BEGIN,
    "a raw `BEGIN` was added, moved or removed — declare it in RAW_BEGIN, or use `tx`");
});
