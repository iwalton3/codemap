/**
 * Every switch on a finding key's KIND — pull request, branch, topic — handles the topic key or
 * says why falling through is right (plan 2026-10-02-review-topics, F11).
 *
 * Found by this test, not by reading: a third key kind lands in code written when there were
 * two, and most such sites fall through to "not a pull request, not a branch" — usually right
 * for a topic, not always. The counts are per file so a NEW switch in a listed file fails too.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const SWITCH = /\bisBranchKey\(|(?<![\w.])branchOf\((?!root\b)|startsWith\(["']branch:["']\)|\/\^\\d\+\$\/\.test\(|\/\^\[1-9\]\\d\*\$\/\.test\(/g;
const TOPIC_ARM = /topicOf\(|isTopicKey\(|topicKey\(|["']topic:["']|startsWith\(["']topic:["']\)/;

/** `arm`: the file handles the topic key. Anything else is the reason the switch is not about it. */
const SITES: Record<string, { count: number; arm?: true; why?: string }> = {
  "src/review-target.ts": { count: 5, arm: true },
  "src/ops-shared.ts": { count: 8, arm: true },
  "src/findings-unify.ts": { count: 2, arm: true },
  "src/promote-annotation.ts": { count: 3, arm: true },
  "src/ruling-application.ts": { count: 2, arm: true },
  "src/shared-bugs.ts": { count: 2, arm: true },
  "web/core.js": { count: 1, arm: true },
  "web/shared.js": { count: 1, arm: true },
  "src/pr.ts": { count: 1, why: "landingOf: a topic key has no pull request or branch to ask GitHub about, so ancestry's answer stands" },
  "src/repair-lifecycle.ts": { count: 3, why: "a topic finding's repair has no PR head branch: no linked PR to ask, and repairSourceBranch's null means compare against the default branch, which is a topic's case" },
  "src/cli.ts": { count: 1, why: "migrate-findings --assign places LEGACY local annotations, which predate topics, on a pull request" },
  "src/normalize.ts": { count: 1, why: "parses a numeric token, not a finding key" },
  "src/refs.ts": { count: 1, why: "parses file:line, not a finding key" },
  "src/shared-reviews.ts": { count: 1, why: "a review link joins a pull request NUMBER to a branch; topics are never linked" },
};

const walk = (d: string): string[] => readdirSync(d, { withFileTypes: true }).flatMap((e) =>
  e.isDirectory() ? (e.name === "e2e" || e.name === "vendor" ? [] : walk(join(d, e.name))) : [join(d, e.name)]);

test("every key-kind switch handles the topic key or states why it falls through", () => {
  const found: Record<string, number> = {};
  for (const f of [...walk("src"), ...walk("web")]) {
    if (!/\.(ts|js)$/.test(f) || f.endsWith(".test.ts") || f.endsWith("key-kind-sweep.test.ts")) continue;
    const n = (readFileSync(f, "utf8").match(SWITCH) ?? []).length;
    if (n) found[f] = n;
  }
  assert.deepEqual(found, Object.fromEntries(Object.entries(SITES).map(([f, s]) => [f, s.count])),
    "a switch on the finding key's kind was added or removed. Handle `topic:<slug>` there (review-target.ts "
    + "`topicOf`), or say in SITES why falling through is right for a topic — then update the count.");
  for (const [f, s] of Object.entries(SITES)) {
    if (s.arm) assert.match(readFileSync(f, "utf8"), TOPIC_ARM, `${f} is listed as handling the topic key and does not`);
    else assert.ok(s.why?.trim(), `${f} falls through without a reason`);
  }
});
