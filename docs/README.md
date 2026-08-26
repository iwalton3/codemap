# docs — what is in here, and which of it you can trust

Every file carries a `> **Kind:**` line under its title, and that line is authoritative;
this index is a view of them. The distinction that earns its keep is `archive` — a
superseded document reads exactly like reference material if nothing says otherwise,
which is how `sidecar-architecture.md` went on asserting that `main` had no event log
for five days after the event log shipped, in the one file `CLAUDE.md` calls normative.

Paths without a directory are at the repo root, where they are MORE prominent than this
directory — the two superseded `PROPOSAL-*` files in particular.

## Current Reference

How codemap works today. If one of these is wrong, that is a bug — fix the doc.

| doc | lines | |
|---|---:|---|
| [`README.md`](../README.md) | 461 | the project front door: what codemap is, the CLI, and the MCP tools. |
| [`docs/shared-triage.md`](shared-triage.md) | 423 | triage on the sidecar, built. |
| [`docs/findings-publishing-spec.md`](findings-publishing-spec.md) | 407 | built, with deviations in §0. §5 is quoted verbatim by `src/mcp.ts`. |
| [`docs/sidecar-architecture.md`](sidecar-architecture.md) | 383 | NORMATIVE for shared state — it outranks the proposal docs where they disagree. |
| [`docs/triage.md`](triage.md) | 374 | the stakes-triage model, BUILT: `src/triage*.ts` and 5 MCP tools. |
| [`docs/fork-repair.md`](fork-repair.md) | 322 | built 2026-08-23. Read before touching `eventlog.ts` or `contest.ts`. |
| [`docs/pr-walkthrough-design.md`](pr-walkthrough-design.md) | 289 | BUILT: `src/walkthrough.ts`, `src/shared-walkthrough.ts`, 3 MCP tools. |
| [`docs/doc-versioning.md`](doc-versioning.md) | 149 | hash-versioned docs, BUILT. The schema section is aspirational — see the note there. |
| [`docs/state-map.md`](state-map.md) | 119 | implemented in the Marten analyzer. |
| [`docs/SESSION-STATE.md`](SESSION-STATE.md) | 106 | the live handoff. Replace it, do not append to it. |

## Active Plan

Decided, not yet built. This is the work queue.

| doc | lines | |
|---|---:|---|
| [`docs/plan-retire-local-findings.md`](plan-retire-local-findings.md) | 383 | ready and deliberately soaking. The next substantial change. |
| [`docs/plan-bug-backlog-and-ci.md`](plan-bug-backlog-and-ci.md) | 216 | the five open COD bugs re-triaged against `4d80d65`, plus the GitHub Actions that should have caught two of them. |
| [`docs/plan-sharing-the-rest.md`](plan-sharing-the-rest.md) | 356 | PARTLY BUILT — see the status line below; §4 is cut, not pending. |
| [`docs/plan-finding-parity.md`](plan-finding-parity.md) | 144 | the field-by-field prerequisite to the retirement. |

## Decision Record

Why the code looks the way it does. Finished; kept for the argument, not as a to-do.

| doc | lines | |
|---|---:|---|
| [`docs/anchor-id-provenance.md`](anchor-id-provenance.md) | 1236 | MIXED and the longest doc here: landed mechanism, cancelled `AnchorReceipt`, and unlanded recovery work. Cited from source, so it cannot simply be retired. |
| [`PROPOSAL-provenance.md`](../PROPOSAL-provenance.md) | 688 | the provenance design, largely landed. Its §5 `AnchorReceipt` was CANCELLED — see `docs/decision-receipts-vs-prefix.md` and `docs/anchor-id-provenance.md`. Cited from a dozen source files. |
| [`docs/plan-findings-unification.md`](plan-findings-unification.md) | 510 | all six steps done. |
| [`docs/decision-receipts-vs-prefix.md`](decision-receipts-vs-prefix.md) | 401 | decided and landed: B for hashes, A for ids. |
| [`docs/plan-docs-unification.md`](plan-docs-unification.md) | 251 | done 2026-08-23. |
| [`docs/finding-event-shape-audit.md`](finding-event-shape-audit.md) | 181 | the measurement the finding-lifecycle work was built from. |
| [`docs/review-target-identity.md`](review-target-identity.md) | 134 | branch-canonical keying was REFUTED. Nothing built; kept for the counterexample. |

## Archive

Superseded or finished. **Do not plan from these.** They are kept, rather than deleted, because source files cite specific sections of them for the long-form reasoning behind a decision — deleting one breaks that compression. Four that nothing cited were retired on 2026-08-26; `git log --diff-filter=D -- docs/` finds them.

| doc | lines | |
|---|---:|---|
| [`PROPOSAL-sidecar-materialization.md`](../PROPOSAL-sidecar-materialization.md) | 1084 | **SUPERSEDED by `docs/sidecar-architecture.md`.** Nine source files cite sections of it for the reasoning behind a decision; read those sections, not the plan. |
| [`docs/HANDOFF.md`](HANDOFF.md) | 782 | three stacked session logs. `CLAUDE.md`, `src/oracle.ts` and `src/oracle-properties.ts` cite SECTIONS of it, so extract those before retiring it. |
| [`docs/mcp-complaints.md`](mcp-complaints.md) | 723 | a use log, newest first, partly resolved in code. Verify any entry against HEAD before acting on it. |
| [`PROPOSAL-shared-review-state.md`](../PROPOSAL-shared-review-state.md) | 662 | **SUPERSEDED by `docs/sidecar-architecture.md`**, which says so itself and wins wherever they disagree. Still cited from source for its long-form arguments, which is why it is kept rather than deleted. |
| [`COLLABORATION-STATIC-REVIEW.md`](../COLLABORATION-STATIC-REVIEW.md) | 257 | a one-off review of the collaboration branch against `main`, at commits that are long merged. |
| [`docs/proposal-committed-docs.md`](proposal-committed-docs.md) | 235 | unapproved proposal. |
| [`docs/sidecar-gap.md`](sidecar-gap.md) | 132 | says so itself at §"The plan, in order". |

## Not indexed here

`CLAUDE.md` (and `AGENTS.md`, a symlink to it) is the orientation doc and outranks
everything here on how to work in the tree. `docs/SESSION-STATE.md` is the live handoff —
replace it rather than appending to it.
