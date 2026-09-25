/** Exact shared issue identities used by ruling application. */
import { createHash } from "node:crypto";
import { readBug, readFinding, lookupFinding } from "./store.js";
import { universeKey } from "./sidecar-config.js";
import { findingKeyScope, normalizeFindingKey } from "./review-target.js";
import { findingScope, type SharedFinding } from "./shared-findings.js";
import { bugScope, type SharedBug } from "./shared-bugs.js";

export type IssueReference =
  | { kind: "finding"; universe: string; id: string; review?: number | string; scope?: string }
  | { kind: "bug"; universe: string; id: string; scope?: string };

export type { CanonicalIssueReference } from "./schema.js";
import type { CanonicalIssueReference } from "./schema.js";

export type ResolvedIssue =
  | { ok: true; ref: Extract<CanonicalIssueReference, { kind: "finding" }>; key: string; issue: SharedFinding }
  | { ok: true; ref: Extract<CanonicalIssueReference, { kind: "bug" }>; key: string; issue: SharedBug };

export type IssueRefusal = {
  ok: false;
  reason: "invalid-reference" | "wrong-universe" | "not-found" | "ambiguous" | "local-only" | "wrong-scope";
  error: string;
};

const refuse = (reason: IssueRefusal["reason"], error: string): IssueRefusal => ({ ok: false, reason, error });

/** Stable across clones, readers and retries; no display label enters the identity. */
export function canonicalIssueKey(ref: CanonicalIssueReference): string {
  return "issue_" + createHash("sha256")
    .update(JSON.stringify(["codemap-issue-v1", ref.kind, ref.universe, ref.scope, ref.id]))
    .digest("hex");
}

/** Resolve only an exact store ID. The source scope, not a display ref, owns the issue. */
export async function resolveDecisionIssue(root: string, input: IssueReference): Promise<ResolvedIssue | IssueRefusal> {
  if (!input || (input.kind !== "finding" && input.kind !== "bug")
    || typeof input.id !== "string" || !input.id.trim() || input.id !== input.id.trim()
    || typeof input.universe !== "string" || !input.universe.trim()) {
    return refuse("invalid-reference", "an issue needs a kind, universe and exact ID");
  }
  const universe = universeKey(root);
  if (input.universe !== universe) return refuse("wrong-universe", `${input.id} belongs to universe ${input.universe}, not ${universe}`);

  if (input.kind === "bug") {
    const scope = bugScope(universe);
    if (input.scope !== undefined && input.scope !== scope)
      return refuse("wrong-scope", `${input.id} is not in ${input.scope}; bugs in this universe use ${scope}`);
    const issue = await readBug(root, input.id);
    if (!issue) return refuse("not-found", `no bug with exact ID ${input.id}`);
    if (!issue.origin) return refuse("local-only", `${input.id} is local only; publish this bug before applying a shared ruling`);
    if (issue.origin.scope !== scope) return refuse("wrong-scope", `${input.id} came from ${issue.origin.scope}, not ${scope}`);
    const ref = { kind: "bug" as const, universe, id: issue.id, scope };
    return { ok: true, ref, key: canonicalIssueKey(ref), issue };
  }

  let review: string | undefined;
  let scope: string | undefined;
  if (input.review !== undefined) {
    try {
      review = normalizeFindingKey(input.review);
      scope = findingScope(findingKeyScope({ path: "", universe }, review));
    } catch (e) {
      return refuse("invalid-reference", (e as Error).message);
    }
  }
  if (input.scope !== undefined) {
    if (typeof input.scope !== "string" || !input.scope.startsWith(`findings/${universe}/`))
      return refuse("wrong-scope", `${input.scope} is not a findings scope in ${universe}`);
    if (scope && input.scope !== scope)
      return refuse("wrong-scope", `review ${review} resolves to ${scope}, not ${input.scope}`);
    scope = input.scope;
  }

  let issue: SharedFinding | null = null;
  if (review !== undefined) {
    issue = await readFinding(root, input.id, { pr: review });
  } else {
    const found = lookupFinding(root, input.id);
    if (!found) return refuse("not-found", `no finding with exact ID ${input.id}`);
    if ("ambiguous" in found) {
      if (!scope) return refuse("ambiguous", `${input.id} is on more than one review (${found.ambiguous.join(", ")}); supply review or scope`);
      for (const pr of found.ambiguous) {
        const candidate = await readFinding(root, input.id, { pr });
        if (candidate?.origin?.scope === scope) { issue = candidate; break; }
      }
    } else issue = found.finding;
  }
  if (!issue) return refuse("not-found", `no finding ${input.id} under the requested review or scope`);
  if (!issue.origin) return refuse("local-only", `${input.id} is local only; publish this finding before applying a shared ruling`);
  if (scope && issue.origin.scope !== scope)
    return refuse("wrong-scope", `${input.id} came from ${issue.origin.scope}, not ${scope}`);
  if (!issue.pr) return refuse("invalid-reference", `${input.id} has no owning review key in the store`);
  const ref = { kind: "finding" as const, universe, id: issue.id, scope: issue.origin.scope, review: issue.pr };
  return { ok: true, ref, key: canonicalIssueKey(ref), issue };
}
