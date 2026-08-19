/**
 * Ingest a first-pass agent review into the durable map.
 *
 * The point of routing agent findings through codemap rather than straight to
 * GitHub is that an annotation is anchored to a *symbol*, so the same finding
 * shows up on the node page, the flow page, the review page and the file modal —
 * and it survives the PR. A GitHub review comment is pinned to a line in one
 * diff and is orphaned the moment the branch is rebased.
 *
 * Findings are written against the PR head ref, so a symbol that exists only on
 * the branch can still carry one (see `resolveRefs`' scopeRef).
 */

import type { BugSeverity } from "./schema.js";
import type { Annotation } from "./schema.js";
import { setTriage } from "./triage.js";
import type { Importance, Complexity } from "./schema.js";

export interface AgentLine {
  kind: "finding" | "pointer" | "question" | "triage" | "summary";
  anchorId?: string;
  file?: string; symbol?: string; line?: number;
  severity?: BugSeverity; category?: string;
  text?: string; evidence?: string; confidence?: "high" | "medium";
  importance?: Importance; complexity?: Complexity; reason?: string;
  batch?: string; reviewed?: number; findings?: number; narrative?: string;
}

const IMPORTANCE = new Set(["business-critical", "important", "low", "mechanical"]);
const COMPLEXITY = new Set(["deep", "standard", "rote", "wiring"]);

/**
 * `annotate` floors and drops a non-positive line; the dedupe key must apply the
 * same rule or a `"line": 0` from an agent compares against a stored `undefined`
 * and duplicates on every re-run.
 */
const normLine = (n: number | undefined) => (Number.isFinite(n) && (n as number) > 0 ? Math.floor(n as number) : undefined);

export interface IngestResult {
  annotations: number;
  /** Findings already present from an earlier ingest of the same batch. */
  duplicates: number;
  triaged: number;
  /** Triage lines the ratchet declined — an agent may only ever ESCALATE a tier. */
  triageRefused: { line: number; why: string }[];
  summaries: { batch: string; reviewed: number; findings: number; narrative: string }[];
  rejected: { line: number; why: string }[];
  bySeverity: Record<string, number>;
}

/** Parse JSONL, tolerating blank lines and a trailing partial write. */
export function parseAgentLines(text: string): { lines: AgentLine[]; bad: { line: number; why: string }[] } {
  const lines: AgentLine[] = [];
  const bad: { line: number; why: string }[] = [];
  text.split("\n").forEach((raw, i) => {
    const t = raw.trim();
    if (!t) return;
    try { lines.push(JSON.parse(t)); } catch (e) { bad.push({ line: i + 1, why: (e as Error).message }); }
  });
  return { lines, bad };
}

/**
 * Write parsed agent output into the map. `annotate` is injected rather than
 * imported so this module stays below ops.ts in the layering.
 */
export async function ingestAgentReview(
  root: string,
  lines: AgentLine[],
  deps: {
    /** Existing annotations, so a re-ingest does not mint a second copy of every finding. */
    existing?: { targetId: string; line?: number; kind?: string; text: string; author: string }[];
    annotate: (root: string, input: {
      targetKind: "anchor"; targetId: string; text: string; author?: string;
      kind?: Annotation["kind"]; severity?: BugSeverity; category?: string; line?: number; ref?: string;
    }) => Promise<{ error?: string } | unknown>;
  },
  opts: { headRef: string; author?: string; dryRun?: boolean } = { headRef: "" },
): Promise<IngestResult> {
  const out: IngestResult = { annotations: 0, duplicates: 0, triaged: 0, triageRefused: [], summaries: [], rejected: [], bySeverity: {} };
  const author = opts.author ?? "agent:pr-first-pass";

  // A finding's identity is what it says and where it says it. Ingest mints a fresh
  // annotation id per call, so without this a re-run — the natural response to a
  // partial batch — silently doubles every finding already in the map.
  const key = (targetId: string, line: number | undefined, kind: string, text: string) =>
    [author, targetId, normLine(line) ?? "", kind, text].join(" | ");
  const seen = new Set((deps.existing ?? []).map((a) => key(a.targetId, a.line, a.kind ?? "note", a.text)));

  for (const [i, l] of lines.entries()) {
    if (l.kind === "summary") {
      out.summaries.push({ batch: l.batch ?? "?", reviewed: l.reviewed ?? 0, findings: l.findings ?? 0, narrative: l.narrative ?? "" });
      continue;
    }
    if (!l.anchorId) { out.rejected.push({ line: i + 1, why: "no anchorId" }); continue; }

    if (l.kind === "triage") {
      // Straight from an agent's JSONL. An unknown tier reaches `triageSeverity`'s
      // table lookup and throws, which 500s `diff` and every surface that reads
      // triage — one malformed line would blank the whole PR worklist.
      if (l.importance !== undefined && !IMPORTANCE.has(l.importance)) { out.rejected.push({ line: i + 1, why: `unknown importance "${l.importance}"` }); continue; }
      if (l.complexity !== undefined && !COMPLEXITY.has(l.complexity)) { out.rejected.push({ line: i + 1, why: `unknown complexity "${l.complexity}"` }); continue; }
      if (!opts.dryRun) {
        // `source: "agent"` keeps the ratchet honest — an agent may only ever raise a
        // tier, and its mark is recorded as a `likely` proposal for a human to confirm.
        // `ref` witnesses the mark against the PR head: a symbol the branch ADDS is
        // not in the working tree, so without it every proposal on new code is
        // witnessed `sha256:absent` and can never be told apart from drift later.
        const r = await setTriage(root, {
          targetKind: "anchor", targetId: l.anchorId,
          importance: l.importance, complexity: l.complexity,
          source: "agent", reason: l.reason ?? "first-pass review",
          ref: opts.headRef || undefined,
        });
        // Refusal is the COMMON case on a re-ingest. Counting it as applied told the
        // operator a tier had been written when the store was untouched.
        if (!r.ok) { out.triageRefused.push({ line: i + 1, why: r.reason ?? "refused by the ratchet" }); continue; }
      }
      out.triaged++;
      continue;
    }

    const text = [l.text, l.evidence ? `\n\nEvidence: ${l.evidence}` : "", l.confidence === "medium" ? "\n\n(agent confidence: medium)" : ""].join("");
    if (!l.text) { out.rejected.push({ line: i + 1, why: "no text" }); continue; }
    const KINDS = new Set(["note", "question", "finding", "pointer"]);
    if (l.kind && !KINDS.has(l.kind)) { out.rejected.push({ line: i + 1, why: `unknown kind "${l.kind}"` }); continue; }
    const k = key(l.anchorId, l.line, l.kind ?? "note", text);
    if (seen.has(k)) { out.duplicates++; continue; }
    seen.add(k);
    if (!opts.dryRun) {
      const r = await deps.annotate(root, {
        targetKind: "anchor", targetId: l.anchorId, text, author,
        kind: l.kind, severity: l.severity, category: l.category, line: l.line, ref: opts.headRef,
      }) as { error?: string };
      if (r && r.error) { out.rejected.push({ line: i + 1, why: r.error }); continue; }
    }
    out.annotations++;
    if (l.severity) out.bySeverity[l.severity] = (out.bySeverity[l.severity] ?? 0) + 1;
  }
  return out;
}
