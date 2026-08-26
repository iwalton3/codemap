# docs — what is in here, and which of it you can trust

Every file carries a `> **Kind:**` line under its title, and that line is authoritative;
this index is a view of them. Four kinds, and the distinction that matters most is the
last one — an archived session log reads exactly like reference material if nothing says
otherwise, which is how a doc asserting `main` had no event log stayed normative for
five days after the event log shipped.

## Current Reference

How codemap works today. If one of these is wrong, that is a bug — fix the doc.

| doc | lines | |
|---|---:|---|
| [`shared-triage.md`](shared-triage.md) | 423 | triage on the sidecar, built. |
| [`findings-publishing-spec.md`](findings-publishing-spec.md) | 407 | built, with deviations in §0. §5 is quoted verbatim by `src/mcp.ts`. |
| [`sidecar-architecture.md`](sidecar-architecture.md) | 383 | NORMATIVE for shared state — it outranks the proposal docs where they disagree. |
| [`triage.md`](triage.md) | 374 | the stakes-triage model, BUILT: `src/triage*.ts` and 5 MCP tools. |
| [`fork-repair.md`](fork-repair.md) | 322 | built 2026-08-23. Read before touching `eventlog.ts` or `contest.ts`. |
| [`pr-walkthrough-design.md`](pr-walkthrough-design.md) | 289 | BUILT: `src/walkthrough.ts`, `src/shared-walkthrough.ts`, 3 MCP tools. |
| [`doc-versioning.md`](doc-versioning.md) | 149 | hash-versioned docs, BUILT. The schema section is aspirational — see the note there. |
| [`state-map.md`](state-map.md) | 119 | implemented in the Marten analyzer. |
| [`SESSION-STATE.md`](SESSION-STATE.md) | 105 | the live handoff. Replace it, do not append to it. |

## Active Plan

Decided, not yet built. This is the work queue.

| doc | lines | |
|---|---:|---|
| [`plan-retire-local-findings.md`](plan-retire-local-findings.md) | 383 | ready and deliberately soaking. The next substantial change. |
| [`plan-sharing-the-rest.md`](plan-sharing-the-rest.md) | 356 | PARTLY BUILT — see the status line below; §4 is cut, not pending. |
| [`plan-finding-parity.md`](plan-finding-parity.md) | 144 | the field-by-field prerequisite to the retirement. |

## Decision Record

Why the code looks the way it does. Finished; kept for the argument, not as a to-do.

| doc | lines | |
|---|---:|---|
| [`anchor-id-provenance.md`](anchor-id-provenance.md) | 1236 | MIXED and the longest doc here: landed mechanism, cancelled `AnchorReceipt`, and unlanded recovery work. Cited from source, so it cannot simply be retired. |
| [`plan-findings-unification.md`](plan-findings-unification.md) | 510 | all six steps done. |
| [`decision-receipts-vs-prefix.md`](decision-receipts-vs-prefix.md) | 401 | decided and landed: B for hashes, A for ids. |
| [`plan-docs-unification.md`](plan-docs-unification.md) | 251 | done 2026-08-23. |
| [`finding-event-shape-audit.md`](finding-event-shape-audit.md) | 181 | the measurement the finding-lifecycle work was built from. |
| [`review-target-identity.md`](review-target-identity.md) | 134 | branch-canonical keying was REFUTED. Nothing built; kept for the counterexample. |

## Archive

Superseded or finished. **Do not plan from these.** Kept for history, and in two cases because something still cites a section of them.

| doc | lines | |
|---|---:|---|
| [`HANDOFF.md`](HANDOFF.md) | 782 | three stacked session logs. `CLAUDE.md`, `src/oracle.ts` and `src/oracle-properties.ts` cite SECTIONS of it, so extract those before retiring it. |
| [`mcp-complaints.md`](mcp-complaints.md) | 723 | a use log, newest first, partly resolved in code. Verify any entry against HEAD before acting on it. |
| [`agent-reports.md`](agent-reports.md) | 242 | unapproved draft, never built. The study it carried moved out. |
| [`proposal-committed-docs.md`](proposal-committed-docs.md) | 235 | unapproved proposal. |
| [`proposal-xagent.md`](proposal-xagent.md) | 193 | explicitly not a codemap feature. |
| [`mcp-use-reports.md`](mcp-use-reports.md) | 184 | every entry marked addressed 2026-08-25. |
| [`bug-walkthrough-republish-conflict.md`](bug-walkthrough-republish-conflict.md) | 147 | resolved; the fix that shipped is deliberately not the one proposed here. |
| [`sidecar-gap.md`](sidecar-gap.md) | 132 | says so itself at §"The plan, in order". |

## Not in here

`CLAUDE.md` at the repo root is the orientation doc and outranks everything here on
how to work in the tree. `docs/SESSION-STATE.md` is the live handoff — replace it rather
than appending to it.
