/**
 * Every place that asks for review state must have DECIDED whether it is looking at a
 * change — and a change is a ref AND a base.
 *
 * The pattern this came from (triage 2026-09-19-review-and-findings-systems, I5): four
 * sites dropped a diff's base along with its head, so a symbol a branch DELETES got no
 * review state at all and its tick read `reviewed` over code nobody had reviewed. Three
 * were found and fixed; the fourth was found only because somebody re-ran the original
 * repro afterwards. The suite was green at that moment and the coverage bar read correct.
 *
 * WHAT THIS IS, AND IS NOT. It is not a pattern match on the mistake — a rule against
 * `ref ? {…base…} : {}` guards one spelling and `if (!ref) return {}` evades it, and "a
 * base gated on a ref" is a shape rather than something enumerable. What IS enumerable is
 * the CALL SITES, so this is a ledger of them, in the exemption-with-reason idiom of
 * `ops-reach.test.ts`.
 *
 * It CANNOT verify a declaration is true. A site declared `change` is checked for a `base`
 * in the call text, following one level of indirection into a prepared opts object — which
 * catches an ABSENT base and misses a CONDITIONAL one, and `head ? { ref, base } : {}` is
 * the spelling all four of I5's sites had. So this would NOT have caught the defect that
 * motivated it, and saying so here is the point:
 * what it does is put every call site in one readable list, which is the enumeration the
 * I5 fixer did not have when they fixed three of four, and make a NEW site declare instead
 * of silently inheriting the no-base path.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

type Kind = "change" | "current" | "forwards";

/**
 * Every call site, by file and order within it, with what it is.
 *
 * - `change` — it is looking at a diff, so it passes a `base` as well as a `ref`.
 * - `current` — not a change view, with the reason. These read state as it stands NOW.
 * - `forwards` — it hands on its own caller's `opts` and cannot declare anything itself.
 *
 * Line numbers are deliberately NOT the key: they move under every edit above them, and a
 * ledger that has to be renumbered is one people renumber without reading.
 */
const LEDGER: Record<string, [Kind, string][]> = {
  "src/diff.ts": [
    ["change", "the branch diff itself — `atHead` carries both sides"],
  ],
  "src/pr.ts": [
    ["change", "a pull request's triage, from its head against its merge-base"],
  ],
  "src/pr-bulk.ts": [
    ["current", "asks which anchors carry a mark AT ALL, to decide what to re-review; no diff is in hand"],
  ],
  "src/reviews.ts": [
    ["forwards", "`reviewStatus` is the one-target wrapper over the many-target call"],
  ],
  "src/triage.ts": [
    ["forwards", "`reviewTriageFor` passes its caller's ref and base through, twice"],
    ["forwards", "and again for the viewed-attestation pass"],
    ["forwards", "`reviewTriageWithSeverity` derives from `reviewTriageFor`"],
  ],
  "src/ops/at.ts": [
    ["change", "`check_stale at:` diffs the view's base against its sha"],
  ],
  "src/ops/diffs.ts": [
    ["change", "the per-symbol drill-down of a diff — I5's fourth site"],
  ],
  "src/ops/triage.ts": [
    ["forwards", "the triage op passes the caller's ref and base through"],
  ],
  "src/ops/graph.ts": [
    ["current", "node catalog: which anchors of each node carry a mark now"],
    ["current", "the outline's per-node triage, as it stands"],
    ["current", "the event matrix reads current node state"],
    ["current", "the pipeline graph reads current node state"],
    ["current", "subgraph: current state of the nodes in it"],
    ["current", "flow listing: current state"],
    ["current", "one flow's nodes, as they stand"],
    ["current", "a node's neighbourhood, as it stands"],
    ["current", "the node page's signed pass, current"],
    ["current", "and its viewed pass, current"],
  ],
  "src/ops/read.ts": [
    ["current", "search results at an optional VIEW — a commit, not a diff: one side, so no base exists"],
    ["current", "a flow's nodes at an optional view; same one-sided read"],
    ["current", "the citations of a node at an optional view; same one-sided read"],
    ["current", "a node's own signed pass, current"],
    ["current", "and its viewed pass, current"],
    ["current", "context's signed pass, current"],
    ["current", "and context's viewed pass, current"],
  ],
};

const FNS = /\b(reviewStatesFor|reviewTriageFor)\s*\(/g;

/** The text of a call's arguments, from its opening paren to the matching one. */
function argsAt(src: string, open: number): string {
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === "(") depth++;
    else if (src[i] === ")" && --depth === 0) return src.slice(open + 1, i);
  }
  return src.slice(open);
}

/** Every source file below `src/`, tests excluded — they are not surfaces. */
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

/**
 * Whether a call passes a base — following ONE level of indirection, because the opts are
 * often a prepared object: `const atHead = { ref, base }` two lines up, handed in by name.
 * Without this the ledger reports a site that is right, which is how a sweep gets muted.
 */
function passesBase(src: string, args: string): boolean {
  if (/\bbase\b/.test(args)) return true;
  const last = args.split(",").at(-1)!.trim();
  if (!/^[A-Za-z_$][\w$]*$/.test(last)) return false;
  const decl = new RegExp(`\\b(?:const|let|var)\\s+${last}\\s*=([^;]*);`).exec(src);
  return !!decl && /\bbase\b/.test(decl[1]!);
}

/** A call, not an import, a type position or a mention in prose. */
const isCall = (line: string) =>
  !/^\s*(?:\*|\/\/)/.test(line) && !/^\s*import\b/.test(line) && !/ReturnType\s*<\s*typeof/.test(line)
  && !/^\s*export (?:async )?function/.test(line);

test("every review-state call site declares whether it is looking at a change", () => {
  const found: Record<string, { args: string; line: number }[]> = {};
  for (const file of sources()) {
    const src = readFileSync(file, "utf8");
    for (const m of src.matchAll(FNS)) {
      const at = m.index!;
      const line = src.slice(0, at).split("\n").length;
      if (!isCall(src.split("\n")[line - 1]!)) continue;
      (found[file] ??= []).push({ args: argsAt(src, at + m[0]!.length - 1), line });
    }
  }

  // The list itself, so a new file or a new call in an old one fails here rather than
  // quietly inheriting whatever the site above it does.
  assert.deepEqual(
    Object.fromEntries(Object.entries(found).map(([f, c]) => [f, c.length])),
    Object.fromEntries(Object.entries(LEDGER).map(([f, c]) => [f, c.length])),
    "a review-state call site was added, moved or removed — declare it in LEDGER",
  );

  // And the one thing a text scan CAN check: a site that says it is looking at a change
  // has to be passing a base. It cannot tell a conditional base from an unconditional
  // one — see this file's header, and do not read a pass here as more than it is.
  const undeclared: string[] = [];
  for (const [file, calls] of Object.entries(found)) {
    calls.forEach((c, i) => {
      const [kind, why] = LEDGER[file]![i]!;
      assert.ok(why.length > 10, `${file} call ${i + 1}: give the declaration a reason`);
      if (kind === "change" && !passesBase(readFileSync(file, "utf8"), c.args)) undeclared.push(`${file}:${c.line}`);
    });
  }
  assert.deepEqual(undeclared, [], "declared a change view, but passes no base");
});
