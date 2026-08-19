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
    "*.test.*", "*_test.py", "test_*.py",
    // `*.spec.*` matched an API contract (`orders.spec.yaml`) as readily as a Jest
    // spec, and the test lane is evaluated first, so a specification became "test
    // evidence about code elsewhere". Excluding DATA extensions rather than listing
    // source ones: an allowlist quietly dropped `foo.spec.rb`, `foo.spec.vue` and
    // `foo.spec.go` out of the agent lane, which is the same shape of loss.
    "*.spec.*",
    "!*.spec.yaml", "!*.spec.yml", "!*.spec.json", "!*.spec.xml", "!*.spec.toml", "!*.spec.md",
    "e2e-playwright/", "**/testdata/", "TestDataScripts/", "test-scripts/",
    "**/ObjectMothers/", "**/fixtures/",
  ],
  spec: ["*.md", "*.mdx", "*.adoc"],
  data: [
    "*.json", "*.yaml", "*.yml", "*.csv", "*.sql", "*.resx", "*.xml",
    "**/InitialData/", "**/locales/", "**/migrations/", "**/Migrations/",
  ],
};

export interface LaneRules {
  classify(relPath: string): Lane;
  /** Complaints about `.codemaplanes` — a broken override file must not look like it worked. */
  problems: string[];
}

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

export function compileLanes(overrides: Partial<Record<PatternLane, string[]>> = {}, problems: string[] = []): LaneRules {
  // The user's own `[data]` patterns, separately from the defaults, so an explicit
  // override can outrank the "data never claims source" rule below.
  const userData = compileIgnore((overrides.data ?? []).join("\n"));
  const matchers = new Map<PatternLane, Ignore>();
  for (const lane of LANE_ORDER) {
    matchers.set(lane, compileIgnore([...DEFAULTS[lane], ...(overrides[lane] ?? [])].join("\n")));
  }
  return {
    problems,
    classify(relPath: string): Lane {
      const parseable = !!grammarForPath(relPath);
      for (const lane of LANE_ORDER) {
        if (!matchers.get(lane)!.ignores(relPath, false)) continue;
        // `data` means "not executable". A DIRECTORY name must not take source out
        // of the queue: `**/Migrations/` sent EF migrations — C# that can drop a
        // column — to `glance`, and `**/locales/` did the same to any module living
        // there. Lanes route attention; they never hide a defect.
        //
        // A user's OWN `[data]` pattern is honoured, though: overriding it silently
        // would be the same complaint from the other side, and `.codemaplanes` is
        // documented as the way to override these defaults.
        if (lane === "data" && parseable && !userData.ignores(relPath, false)) return "code";
        return lane;
      }
      return parseable ? "code" : "other";
    },
  };
}

/**
 * Parse a `.codemaplanes` file: `[lane]` sections of gitignore-style patterns.
 *
 * Every way this can go wrong is REPORTED rather than absorbed. A misparse here
 * silently reroutes attention — a header with inner spaces was not recognised as a
 * header, so the line and everything under it were appended to the PREVIOUS
 * section, and if that was `[generated]` the user's own code went to the skip lane
 * and vanished from the review queue. A broken override file must not look like it
 * worked.
 */
export function parseLaneOverrides(text: string): { overrides: Partial<Record<PatternLane, string[]>>; problems: string[] } {
  const overrides: Partial<Record<PatternLane, string[]>> = {};
  const problems: string[] = [];
  let cur: PatternLane | null = null;
  // Set by an unknown header, so the patterns it swallowed are not each reported
  // again — one complaint per broken section is the useful granularity.
  let underBadHeader = false;
  text.split("\n").forEach((raw, i) => {
    const line = raw.trim();
    if (!line || line.startsWith("#")) return;
    // Anything bracket-shaped is a HEADER attempt, never a pattern: reading a
    // malformed one as a glob is what leaked patterns into the wrong lane.
    const bracket = /^\[(.*)\]$/.exec(line);
    if (bracket) {
      const name = bracket[1]!.trim().toLowerCase() as PatternLane;
      if (LANE_ORDER.includes(name)) { cur = name; underBadHeader = false; overrides[cur] ??= []; return; }
      cur = null;
      underBadHeader = true;
      problems.push(`line ${i + 1}: unknown lane "${bracket[1]!.trim()}" — expected one of ${LANE_ORDER.join(", ")}; every pattern under it is ignored`);
      return;
    }
    if (!cur) {
      if (!underBadHeader) problems.push(`line ${i + 1}: "${line}" is not under any [lane] section, so it does nothing`);
      return;
    }
    overrides[cur]!.push(line);
  });
  return { overrides, problems };
}

export async function loadLanes(root: string): Promise<LaneRules> {
  let text: string;
  try {
    text = await readFile(join(root, ".codemaplanes"), "utf8");
  } catch {
    return compileLanes();          // no override file at all is the normal case
  }
  const { overrides, problems } = parseLaneOverrides(text);
  return compileLanes(overrides, problems);
}
