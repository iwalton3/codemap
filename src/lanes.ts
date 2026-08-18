/**
 * Review lanes — what kind of attention a changed file deserves.
 *
 * A big PR is not uniformly expensive to read. Some of it is generated and
 * worth nothing; some is test evidence about code elsewhere; some is the spec
 * that explains the rest. Sorting changed files into lanes is what turns
 * "61k lines" into "these 300 symbols, in this order, and here's why the rest
 * doesn't need you".
 *
 * Deliberately *heuristic and overridable*, not authoritative: lanes route
 * attention, they never hide a defect. The core stays codebase-agnostic — the
 * defaults below are conventions, and `.codemaplanes` overrides them per
 * universe. Patterns reuse the `.codemapignore` glob engine (extend the
 * defaults; `!pattern` re-includes, last match wins).
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { compileIgnore, type Ignore } from "./ignore.js";
import { grammarForPath } from "./grammars.js";

export type Lane = PatternLane | "code" | "other";
/** Lanes decided by path patterns (as opposed to "is it parseable source"). */
export type PatternLane = "generated" | "test" | "spec" | "data";

/** Most-specific first — a lockfile is generated before it is data. */
export const LANE_ORDER: PatternLane[] = ["generated", "test", "spec", "data"];

const DEFAULTS: Record<PatternLane, string[]> = {
  generated: [
    "*.gen.ts", "*.gen.tsx", "*.g.cs", "*.designer.cs", "*.Designer.cs",
    "**/Generated/", "**/generated/", "*.min.js", "*.snap",
    "package-lock.json", "yarn.lock", "pnpm-lock.yaml", "*.lock",
  ],
  test: [
    "*.Tests/", "*Tests/", "**/__tests__/", "**/test/", "**/tests/",
    "*.test.*", "*.spec.*", "*_test.py", "test_*.py",
    "e2e-playwright/", "**/testdata/", "TestDataScripts/", "test-scripts/",
    "**/ObjectMothers/", "**/fixtures/",
  ],
  spec: ["*.md", "*.mdx", "*.adoc"],
  data: [
    "*.json", "*.yaml", "*.yml", "*.csv", "*.sql", "*.resx", "*.xml",
    "**/InitialData/", "**/locales/", "**/migrations/", "**/Migrations/",
  ],
};

export interface LaneRules { classify(relPath: string): Lane }

/**
 * How much human attention a lane earns by default. `code` is the queue;
 * `test` is deliberately *visible to an agent but not to the human queue* — the
 * volume is unreviewable by hand, but a broken test is still a real finding, and
 * an agent may promote an individual one into the queue.
 */
export const LANE_POLICY: Record<Lane, { review: "queue" | "agent" | "context" | "glance" | "skip"; why: string }> = {
  code:      { review: "queue",   why: "symbol-bearing logic — the review queue" },
  spec:      { review: "context", why: "explains the change; read before the code, not as review load" },
  test:      { review: "agent",   why: "agent reads it as evidence and may promote one into your queue" },
  data:      { review: "glance",  why: "seed/locale/config data — a glance confirms shape" },
  generated: { review: "skip",    why: "machine-produced; reviewing it reviews the generator" },
  other:     { review: "glance",  why: "unmapped file type" },
};

export function compileLanes(overrides: Partial<Record<PatternLane, string[]>> = {}): LaneRules {
  const matchers = new Map<PatternLane, Ignore>();
  for (const lane of LANE_ORDER) {
    matchers.set(lane, compileIgnore([...DEFAULTS[lane], ...(overrides[lane] ?? [])].join("\n")));
  }
  return {
    classify(relPath: string): Lane {
      for (const lane of LANE_ORDER) if (matchers.get(lane)!.ignores(relPath, false)) return lane;
      return grammarForPath(relPath) ? "code" : "other";
    },
  };
}

/** Parse a `.codemaplanes` file: `[lane]` sections of gitignore-style patterns. */
export function parseLaneOverrides(text: string): Partial<Record<PatternLane, string[]>> {
  const out: Partial<Record<PatternLane, string[]>> = {};
  let cur: PatternLane | null = null;
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const section = /^\[(\w+)\]$/.exec(line);
    if (section) {
      const name = section[1]!.toLowerCase() as PatternLane;
      cur = LANE_ORDER.includes(name) ? name : null;
      if (cur) out[cur] ??= [];
      continue;
    }
    if (cur) out[cur]!.push(line);
  }
  return out;
}

export async function loadLanes(root: string): Promise<LaneRules> {
  try {
    return compileLanes(parseLaneOverrides(await readFile(join(root, ".codemaplanes"), "utf8")));
  } catch {
    return compileLanes();
  }
}
