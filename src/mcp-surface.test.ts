/**
 * Invariants over the MCP tool surface itself.
 *
 * The descriptions cross-reference each other heavily, and that reference graph is
 * the workflow an agent actually follows — "report back with `close_finding`",
 * "read one in full with `finding`". It is also unchecked prose, so a tool can be
 * renamed or never built and the sentence pointing at it keeps reading fine. That
 * is not hypothetical: `shared_findings` told every caller to dereference a finding
 * id with a `finding` tool that has never existed, so the only way to read one
 * record was to re-page a list, or to take ~195k characters of the whole set.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";

const SRC = readFileSync("src/mcp.ts", "utf8");
const TOOLS = new Set([...SRC.matchAll(/^\s*name: "([a-z_]+)",$/gm)].map((m) => m[1]!));

/**
 * Backticked words in a "go call it" phrase that are NOT tools — parameters, enum
 * values and record fields, which read identically inside a sentence. Each is here
 * because it is one of those, and `no exemption is stale` below fails if one stops
 * appearing, so the list cannot quietly outlive its reason.
 */
const NOT_TOOLS = new Set([
  "disposition", "tier", "category", "line", "offset", "locate", "reversibility", // parameters
  "untriaged", "unverified", "refuted", "settled", "transitions_to", "baseline", // enum values
  "witnesses", "anchors", "citations", "vouch", "diagnostic", "rank", // record fields
]);

/**
 * Backticked words a SKILL uses that are vocabulary rather than tools — trigger names,
 * outcomes, record fields. Kept apart from `NOT_TOOLS` because that list is about
 * `mcp.ts`'s own prose and this one grows with the skills.
 */
const SKILL_VOCAB = new Set([
  "scrub", "differential", "baseline", "ad-hoc",           // audit triggers
  "conformant", "nonconformant", "indeterminate",          // audit outcomes
  "prior", "evidence", "observations", "assertedby",       // record fields
]);

/** `use \`x\``, `see \`x\``, `with \`x\`` … — a reference to something callable. */
const REFS = /(?:with|use|using|see|via|call|from|and)\s+`([a-z][a-z_]{2,})`/g;

test("every tool a description tells you to call exists", () => {
  const dangling = new Set<string>();
  for (const m of SRC.matchAll(REFS)) {
    const name = m[1]!;
    if (!TOOLS.has(name) && !NOT_TOOLS.has(name)) dangling.add(name);
  }
  // Could this fail? At the commit before this file existed it reports exactly
  // ["finding"] — the real one, and nothing else.
  assert.deepEqual([...dangling], [],
    "a description sends the agent to a tool that is not on the surface — build it, or fix the sentence");
});

test("no exemption is stale", () => {
  const seen = new Set([...SRC.matchAll(REFS)].map((m) => m[1]!));
  const unused = [...NOT_TOOLS].filter((w) => !seen.has(w));
  assert.deepEqual(unused, [],
    "these are no longer referenced anywhere — drop them so the list keeps meaning something");
});

test("the finding workflow spells the record id the same way throughout", () => {
  // `close_finding`, `revise_finding`, `relocate_finding`, `record_published` and
  // `defer_finding` all take one finding id in one workflow, and `defer_finding`
  // alone called it `finding` — a required param, so the mistake was a refusal.
  for (const tool of ["close_finding", "revise_finding", "relocate_finding", "defer_finding"]) {
    const at = SRC.indexOf(`name: "${tool}"`);
    assert.ok(at > 0, `${tool} is gone`);
    const block = SRC.slice(at, at + 4000);
    const schema = block.slice(block.indexOf("inputSchema"));
    assert.match(schema.slice(0, 900), /\bid: \{ type: "string"/,
      `${tool} must accept the id as \`id\``);
  }
});

test("sanity_check does not default the reviewer to a literal", () => {
  // `actor` already records that an agent did it; defaulting `reviewer` to the
  // string "agent" threw away the identity `markReviewed` derives otherwise
  // (`principal (model)`), so the same act through `review` and through
  // `sanity_check` disagreed about who performed it. A source check because the
  // handler is not exported — the behaviour it relies on is pinned in
  // `mcp-tool-fixes.test.ts`.
  const at = SRC.indexOf('name: "sanity_check"');
  assert.ok(at > 0, "sanity_check is gone");
  const block = SRC.slice(at, at + 2000);
  assert.ok(!/reviewer: a\.reviewer \|\|/.test(block),
    "let markReviewed derive the reviewer when the caller omits one");
});

/**
 * The same defect class one layer out. `codemap-explore` is the agent that drives
 * this surface, and its frontmatter allowlist is plain text: a tool it names that
 * does not exist silently removes that capability rather than erroring. `report_bug`
 * sat there after the verb became `report_defect`, so the flagship exploration
 * workflow's "I found a real defect" branch had been unreachable — and the file was
 * edited since without anyone noticing.
 */
test("the explore agent names only tools that exist", () => {
  const agent = readFileSync(".claude/agents/codemap-explore.md", "utf8");

  const allowlisted = [...agent.matchAll(/mcp__codemap__([a-z_]+)/g)].map((m) => m[1]!);
  assert.ok(allowlisted.length > 10, "the allowlist should be substantial");
  assert.deepEqual(allowlisted.filter((n) => !TOOLS.has(n)), [],
    "an allowlisted tool that does not exist grants nothing — the agent just cannot do that step");

  const referenced = new Set<string>();
  for (const m of agent.matchAll(REFS)) if (!TOOLS.has(m[1]!) && !NOT_TOOLS.has(m[1]!)) referenced.add(m[1]!);
  assert.deepEqual([...referenced], [],
    "the agent's instructions tell it to call a tool that is not on the surface");
});

/**
 * And the same sweep over the SKILLS, for the same reason one layer further out.
 *
 * A skill file is the only thing that makes a queue get worked — nothing in this
 * subsystem runs a lint or a scrub, by design, so the skill IS the runner. A tool it
 * names that does not exist removes that step silently: the agent reads an instruction
 * it cannot follow, does the rest, and reports success. That is exactly how
 * `report_bug` sat in the explore agent after the verb was renamed.
 */
test("the skills name only tools that exist", () => {
  const dir = ".claude/skills";
  const files = readdirSync(dir, { withFileTypes: true })
    .filter((d) => d.isDirectory()).map((d) => join(dir, d.name, "SKILL.md"))
    .filter((f) => existsSync(f));
  assert.ok(files.length, "no skills found — if they moved, this sweep is now vacuous");

  // EVERY backticked snake-case word, not just the ones after "use" or "see". `REFS` was
  // written for `mcp.ts`'s prose and matched exactly ONE name in the first skill — a table
  // row and a bare mention read nothing like a sentence. Checked: with `REFS` a deliberate
  // `scrub_plann` typo sailed through, which is the whole failure this is meant to catch.
  const dangling = new Set<string>();
  for (const f of files) {
    for (const m of readFileSync(f, "utf8").matchAll(/`([a-z][a-z_]{2,})`/g)) {
      const w = m[1]!;
      if (!TOOLS.has(w) && !NOT_TOOLS.has(w) && !SKILL_VOCAB.has(w)) dangling.add(`${f}: ${w}`);
    }
  }
  assert.deepEqual([...dangling], [], "a skill tells an agent to call something that is not on the surface");
});

test("confirm records the read it performs", () => {
  // Recording is the fix. The don't-overwrite-a-person guard that used to sit beside
  // it is gone — review rows are keyed on the reviewer now, so an agent's read cannot
  // replace a sign-off and the guard has nothing left to prevent. What must NOT come
  // back is a `?? "human"` style default, which is why the no-self-vouching check is
  // still asserted here. Source-read: the handler is not exported.
  const at = SRC.indexOf('name: "confirm"');
  assert.ok(at > 0, "confirm is gone");
  const block = SRC.slice(at, at + 4000);
  assert.match(block, /markReviewed\(/, "confirming must record the read it performed");
  assert.match(block, /guardSelfCheck\(/, "and obey the same no-self-vouching rule as sanity_check");
});
