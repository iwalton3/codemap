import type { CanonicalIssueReference } from "../schema.js";
import { prOfScope, type SharedFinding } from "../shared-findings.js";
import type { DecisionsView } from "./decision-holds.js";

export function findingIssueRef(
  f: SharedFinding, universe: string, source?: { scope: string; review: string },
): CanonicalIssueReference | undefined {
  const scope = source?.scope ?? f.origin?.scope;
  const review = source?.review ?? f.pr ?? (f.origin ? prOfScope(f.origin.scope) : undefined);
  if (!scope || !review) return undefined;
  return { kind: "finding", universe, id: f.id, scope, review };
}

export function findingWork(
  view: DecisionsView, f: SharedFinding, universe: string, source?: { scope: string; review: string },
) {
  const ref = findingIssueRef(f, universe, source);
  return ref ? view.issueWork(ref, f.assignment) : view.work(f.id, f.assignment);
}

export function findingMark(view: DecisionsView, f: SharedFinding, universe: string) {
  const ref = findingIssueRef(f, universe);
  return ref ? view.issueMark(ref) : view.mark(f.id);
}
