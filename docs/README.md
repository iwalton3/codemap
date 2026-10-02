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
| [`README.md`](../README.md) | 524 | the project front door: what codemap is, the CLI, the MCP tools, and the agent setup. |
| [`docs/shared-triage.md`](shared-triage.md) | 423 | triage on the sidecar, built. |
| [`docs/findings-publishing-spec.md`](findings-publishing-spec.md) | 407 | built, with deviations in §0. §5 is quoted verbatim by `src/mcp.ts`. |
| [`docs/sidecar-architecture.md`](sidecar-architecture.md) | 349 | NORMATIVE for shared state — the linear log (2026-09-30); it outranks the proposal docs where they disagree. |
| [`docs/log-repair.md`](log-repair.md) | 105 | NORMATIVE: repairing a damaged shared log — one commit pushed with git, approved by a person. |
| [`docs/sidecar-migration.md`](sidecar-migration.md) | 53 | operator procedure: migrating a merge-era sidecar to the linear log, once per team. |
| [`docs/triage.md`](triage.md) | 374 | the stakes-triage model, BUILT: `src/triage*.ts` and 5 MCP tools. |
| [`docs/pr-walkthrough-design.md`](pr-walkthrough-design.md) | 289 | BUILT: `src/walkthrough.ts`, `src/shared-walkthrough.ts`, 3 MCP tools. |
| [`docs/doc-versioning.md`](doc-versioning.md) | 149 | hash-versioned docs, BUILT. The schema section is aspirational — see the note there. |
| [`docs/state-map.md`](state-map.md) | 119 | implemented in the Marten analyzer. |
| [`docs/SESSION-STATE.md`](SESSION-STATE.md) | 64 | Current ruling/questionnaire closeout and remaining skills/verifier work. Replace it, do not append to it. |
| [`docs/close-audit-next.md`](close-audit-next.md) | 146 | handoff for the close-audit arc: five concrete shapes to try, what not to repeat, and the traps. Read with `PROPOSAL-close-evidence.md` §8.6–§8.8. |

## Current Design — NORMATIVE

Settled design that the code implements and that outranks everything else where they
disagree, `CLAUDE.md` included. Both were missing from this index entirely, which is the
failure it exists to prevent: the two documents a reader most needs before touching the
standard were the two hardest to find from here.

| doc | lines | |
|---|---:|---|
| [`docs/requirements-architecture.md`](requirements-architecture.md) | 1124 | NORMATIVE for requirements, specs, operations, audits and acknowledgements. Outranks COD-29 and the *Requirement Kernel* draft. |
| [`docs/cross-universe-standard.md`](cross-universe-standard.md) | 319 | NORMATIVE for the standard across more than one repository, and it EXTENDS the above — it wins wherever that document assumes one universe, which it does implicitly throughout. |
| [`docs/finding-backlog.md`](finding-backlog.md) | 374 | NORMATIVE for `backlog`, `rewitness` and `findingBacklog`, and AS-BUILT for the bug backlog and findings-in-search — it carries the two root `PROPOSAL-*` notes those were built from, which are gone from the tree and recoverable at `9a7b1a8^`. |

## Active Plan

Decided, not yet built. This is the work queue.

| doc | lines | |
|---|---:|---|
| [`docs/plan-retire-local-findings.md`](plan-retire-local-findings.md) | 383 | ready and deliberately soaking. The next substantial change. |
| [`docs/business-knowledge-capture.md`](business-knowledge-capture.md) | 289 | the measurement behind the knowledge scratchpad AND its settled design. It carries the retired `PROPOSAL-drive-by-requirements.md`, which was never committed and has no `<sha>^`. |
| [`docs/plan-bug-backlog-and-ci.md`](plan-bug-backlog-and-ci.md) | 238 | the five open COD bugs re-triaged against `93cbffb`, plus the GitHub Actions that should have caught two of them. |
| [`docs/plan-sharing-the-rest.md`](plan-sharing-the-rest.md) | 356 | PARTLY BUILT — see the status line below; §4 is cut, not pending. |
| [`docs/plan-finding-parity.md`](plan-finding-parity.md) | 144 | the field-by-field prerequisite to the retirement. |
| [`docs/PROPOSAL-close-evidence.md`](PROPOSAL-close-evidence.md) | 500 | **PROPOSED, not approved.** An `evidence` slot on `close_finding`, from a measurement of 183 agent fix-vouches. §8 is the audit loop's shape — discussed, NOT ratified; §7 the constraints it must satisfy; §8.6 the run where two auditors agreed 16/16 and missed together. |
| [`docs/PROPOSAL-decision-rounds.md`](PROPOSAL-decision-rounds.md) | 264 | **PROPOSED, not approved.** People answer decision rounds; agents sort, fix and verify-close findings. Supersedes `plan-decision-log.md`; §8 maps the downstream team's IZ-1…IZ-10 onto it. |
| [`docs/PROPOSAL-close-pipeline.md`](PROPOSAL-close-pipeline.md) | 212 | **PROPOSED.** Store the sort's closing condition instead of re-deriving it. §3(a) and §4–§6 are components of the decision-rounds proposal. |
| [`docs/PROPOSAL-review-topics.md`](PROPOSAL-review-topics.md) | 209 | **PROPOSED, not approved.** Review topics: a walkthrough of any selector-defined set of code, including code already on main. §7 is the old-build measurement, §8 what is still open. |
| [`docs/close-audit-2026-09-21.jsonl`](close-audit-2026-09-21.jsonl) | 16 | the per-item scores behind §8.6. Data, not prose. |
| [`docs/close-audit-2026-09-21-asym.jsonl`](close-audit-2026-09-21-asym.jsonl) | 16 | the same items under §8.7's asymmetric roles. Data, not prose. |
| [`docs/close-audit-2026-09-22-paired.jsonl`](close-audit-2026-09-22-paired.jsonl) | 24 | §8.8's paired pre/post-repair run. Data, not prose. |

## Active Behavioral Contracts

Owner-approved behavior and current implementation status; historical proposals remain in their original sections.

| doc | status |
|---|---|
| [`docs/rulings-contract.md`](rulings-contract.md) | Round five current behavioral contract: stakeholder questionnaires, durable answers, semantic comparison, reader-validated one-shot closure, and explicit withdrawal/revision. Owner case rulings and implementation status are distinguished. No legacy rulings exist to migrate. |
| [`docs/rulings-workflow.md`](rulings-workflow.md) | Current publication, web submission, sync/read/wait, revision, withdrawal, comparison and one-shot application workflow with CLI and MCP entry points. |

## Decision Record

Why the code looks the way it does. Finished; kept for the argument, not as a to-do.

| doc | lines | |
|---|---:|---|
| [`docs/PROPOSAL-online-only-sync.md`](PROPOSAL-online-only-sync.md) | 270 | RATIFIED 2026-09-30 and built; `docs/sidecar-architecture.md` is the current statement. |
| [`docs/anchor-id-provenance.md`](anchor-id-provenance.md) | 1236 | MIXED and the longest doc here: landed mechanism, cancelled `AnchorReceipt`, and unlanded recovery work. Cited from source, so it cannot simply be retired. |
| [`PROPOSAL-provenance.md`](../PROPOSAL-provenance.md) | 688 | the provenance design, largely landed. Its §5 `AnchorReceipt` was CANCELLED — see `docs/decision-receipts-vs-prefix.md` and `docs/anchor-id-provenance.md`. Cited from a dozen source files. |
| [`docs/plan-findings-unification.md`](plan-findings-unification.md) | 510 | all six steps done. |
| [`docs/decision-receipts-vs-prefix.md`](decision-receipts-vs-prefix.md) | 401 | decided and landed: B for hashes, A for ids. |
| [`docs/plan-docs-unification.md`](plan-docs-unification.md) | 251 | done 2026-08-23. |
| [`docs/finding-event-shape-audit.md`](finding-event-shape-audit.md) | 181 | the measurement the finding-lifecycle work was built from. |
| [`docs/review-target-identity.md`](review-target-identity.md) | 134 | branch-canonical keying was REFUTED. Nothing built; kept for the counterexample. |
| [`docs/population-predicate.md`](population-predicate.md) | 254 | design brief, mechanism BUILT (`population.ts`). Its last section is still open: nothing runs the lint. |
| [`docs/trust-split.md`](trust-split.md) | 278 | BUILT, steps 1–3. Step 4 (removing `trust`) is deliberately not done. |

## Archive

Superseded or finished. **Do not plan from these.** They are kept, rather than deleted, because source files cite specific sections of them for the long-form reasoning behind a decision — deleting one breaks that compression. Four that nothing cited were retired on 2026-08-26; `git log --diff-filter=D -- docs/` finds them.

| doc | lines | |
|---|---:|---|
| [`docs/fork-repair.md`](fork-repair.md) | 322 | SUPERSEDED 2026-09-30 by the linear log; archive. |
| [`docs/sidecar-references.md`](sidecar-references.md) | 576 | the plan-phase-3 inventory of every cross-scope reference and how each is validated. |
| [`docs/decision-rounds-next.md`](decision-rounds-next.md) | 188 | Historical pre-recovery handoff; next-job and branch-freeze instructions are superseded. Current handoff is `SESSION-STATE.md`. |
| [`docs/plan-decision-log.md`](plan-decision-log.md) | 188 | **SUPERSEDED by `docs/PROPOSAL-decision-rounds.md`** the same day it was written. Kept for the ruling-vs-requirement test and its falsifiers. |
| [`PROPOSAL-sidecar-materialization.md`](../PROPOSAL-sidecar-materialization.md) | 1084 | **SUPERSEDED by `docs/sidecar-architecture.md`.** Nine source files cite sections of it for the reasoning behind a decision; read those sections, not the plan. |
| [`docs/session-log-2026-08.md`](session-log-2026-08.md) | 782 | three stacked session logs. `CLAUDE.md`, `src/oracle.ts` and `src/oracle-properties.ts` cite SECTIONS of it, so extract those before retiring it. |
| [`docs/mcp-complaints.md`](mcp-complaints.md) | 723 | a use log, newest first, partly resolved in code. Verify any entry against HEAD before acting on it. |
| [`PROPOSAL-shared-review-state.md`](../PROPOSAL-shared-review-state.md) | 662 | **SUPERSEDED by `docs/sidecar-architecture.md`**, which says so itself and wins wherever they disagree. Still cited from source for its long-form arguments, which is why it is kept rather than deleted. |
| [`COLLABORATION-STATIC-REVIEW.md`](../COLLABORATION-STATIC-REVIEW.md) | 257 | a one-off review of the collaboration branch against `main`, at commits that are long merged. |
| [`docs/proposal-committed-docs.md`](proposal-committed-docs.md) | 235 | unapproved proposal. |
| [`docs/sidecar-gap.md`](sidecar-gap.md) | 132 | says so itself at §"The plan, in order". |

## Not indexed here

`CLAUDE.md` (and `AGENTS.md`, a symlink to it) is the orientation doc and outranks
everything here on how to work in the tree. `docs/SESSION-STATE.md` is the live handoff —
replace it rather than appending to it.
