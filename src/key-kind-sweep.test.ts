/**
 * Every switch on a finding key's KIND — pull request, branch, topic — handles the topic key or
 * says why falling through is right (plan 2026-10-02-review-topics, F11).
 *
 * Found by this test, not by reading: a third key kind lands in code written when there were
 * two, and most such sites fall through to "not a pull request, not a branch" — usually right
 * for a topic, not always. Judged per FUNCTION, through the vendored grammar: a file-wide check
 * passed while one function in a file with a topic arm elsewhere dropped the topic (review round
 * 2026-10-05, F52). A web route built as `/u/…/pr/${…}` counts as a switch: it reads a key as a
 * pull request number (F37).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parserForPath } from "./grammars.js";

const SWITCH = /\bisBranchKey\(|(?<![\w.])branchOf\((?!root\b)|startsWith\(["']branch:["']\)|\/\^\\d\+\$\/\.test\(|\/\^\[1-9\]\\d\*\$\/\.test\(|\/u\/\$\{[^}]+\}\/pr\/\$\{/g;
const TOPIC_ARM = /topicOf\(|isTopicKey\(|topicKey\(|["']topic:["']|startsWith\(["']topic:["']\)|reviewLabel\(|sharedUrl\(/;

/** `file#function` → how many switches it holds, and either `arm` (it handles the topic key) or why not. */
const SITES: Record<string, { count: number; arm?: true; why?: string }> = {
  "src/findings-unify.ts#replay": { count: 2, arm: true },
  "src/ops-shared.ts#shareFinding": { count: 1, arm: true },
  "src/ops-shared.ts#headOf": { count: 1, arm: true },
  "src/ops-shared.ts#sharedFindings": { count: 1, arm: true },
  "src/ops-shared.ts#sharedHub": { count: 1, arm: true },
  "src/promote-annotation.ts#promoteAnnotation": { count: 3, arm: true },
  "src/review-target.ts#normalizeFindingKey": { count: 2, arm: true },
  "src/review-target.ts#findingKeyScope": { count: 2, arm: true },
  "src/ruling-application.ts#expectedFindingScope": { count: 2, arm: true },
  "src/shared-bugs.ts#findingScopeOfBugKey": { count: 2, arm: true },
  "web/core.js#reviewLabel": { count: 1, arm: true },
  "web/shared.js#template": { count: 2, arm: true },
  "src/review-target.ts#branchOf": { count: 1, why: "the branch accessor itself: null for anything else, a topic key included" },
  "src/ops-shared.ts#verdictGround": { count: 1, why: "a topic finding has no branch: its code is on the trunk, which the checkout answers for as it does for a pull request's" },
  "src/ops-shared.ts#landedAt": { count: 1, why: "a topic key has no pull request and no branch to ask about, so ancestry's answer stands" },
  "src/ops-shared.ts#linkReviewOp": { count: 1, why: "links a pull request NUMBER to a branch; topics are never linked" },
  "src/ops-shared.ts#inboundReplies": { count: 1, why: "replies are read from a pull request by number; anything else, a topic included, is refused" },
  "src/pr.ts#landingOf": { count: 1, why: "landingOf: a topic key has no pull request or branch to ask GitHub about, so ancestry's answer stands" },
  "src/repair-lifecycle.ts#linkedRepairLanded": { count: 2, why: "a topic finding's repair has no PR head branch: no linked PR to ask" },
  "src/repair-lifecycle.ts#repairSourceBranch": { count: 1, why: "repairSourceBranch's null means compare against the default branch, which is a topic's case" },
  "src/cli.ts#cmdMigrateFindings": { count: 1, why: "migrate-findings --assign places LEGACY local annotations, which predate topics, on a pull request" },
  "src/normalize.ts#hashSchemeOf": { count: 1, why: "parses a numeric token, not a finding key" },
  "src/refs.ts#resolveOne": { count: 1, why: "parses file:line, not a finding key" },
  "src/shared-reviews.ts#foldReviewLinksReport": { count: 1, why: "a review link joins a pull request NUMBER to a branch; topics are never linked" },
  "web/app.js#prUrl": { count: 1, why: "the pull request list's links: a number from GitHub, never a finding key" },
};

const walk = (d: string): string[] => readdirSync(d, { withFileTypes: true }).flatMap((e) =>
  e.isDirectory() ? (e.name === "e2e" || e.name === "vendor" ? [] : walk(join(d, e.name))) : [join(d, e.name)]);

type Node = { type: string; text: string; parent: Node | null; childForFieldName(n: string): Node | null };

/** The nearest NAMED function around a node — an inner arrow is part of the function it sits in. */
function functionOf(n: Node | null): { name: string; text: string } | null {
  for (; n; n = n.parent) {
    if (n.type === "function_declaration" || n.type === "method_definition" || n.type === "generator_function_declaration") {
      return { name: n.childForFieldName("name")?.text ?? "?", text: n.text };
    }
    if (n.type === "variable_declarator" && /function/.test(n.childForFieldName("value")?.type ?? "")) {
      return { name: n.childForFieldName("name")?.text ?? "?", text: n.text };
    }
  }
  return null;
}

/** Every switch site in the tree, keyed `file#function`, with the function's text. */
async function sites(): Promise<Map<string, { count: number; text: string }>> {
  const out = new Map<string, { count: number; text: string }>();
  for (const f of [...walk("src"), ...walk("web")]) {
    if (!/\.(ts|js)$/.test(f) || f.endsWith(".test.ts")) continue;
    const src = readFileSync(f, "utf8");
    const ms = [...src.matchAll(SWITCH)];
    if (!ms.length) continue;
    const { parser } = (await parserForPath(f))!;
    const tree = parser.parse(src)!;
    try {
      for (const m of ms) {
        const before = src.slice(0, m.index), row = before.split("\n").length - 1;
        const column = Buffer.byteLength(before.slice(before.lastIndexOf("\n") + 1), "utf8");
        const fn = functionOf(tree.rootNode.descendantForPosition({ row, column }) as unknown as Node);
        const key = `${f}#${fn?.name ?? "<top level>"}`;
        const s = out.get(key) ?? out.set(key, { count: 0, text: fn?.text ?? src }).get(key)!;
        s.count++;
      }
    } finally { tree.delete(); }
  }
  return out;
}

test("every key-kind switch handles the topic key or states why it falls through", async () => {
  const found = await sites();
  const problems: string[] = [];
  for (const [k, s] of found) {
    const want = SITES[k];
    if (!want) problems.push(`${k}: ${s.count} unlisted switch(es)`);
    else if (want.count !== s.count) problems.push(`${k}: ${s.count} switch(es), SITES says ${want.count}`);
  }
  for (const [k, s] of Object.entries(SITES)) {
    const f = found.get(k);
    if (!f) problems.push(`${k}: listed, but no switch is there any more`);
    else if (s.arm && !TOPIC_ARM.test(f.text)) problems.push(`${k}: listed as handling the topic key, and does not`);
    else if (!s.arm && !s.why?.trim()) problems.push(`${k}: falls through without a reason`);
  }
  assert.deepEqual(problems, [], "Handle `topic:<slug>` in that function (review-target.ts `topicOf`, web core.js "
    + "`reviewLabel`), or say in SITES why falling through is right for a topic.");
});
