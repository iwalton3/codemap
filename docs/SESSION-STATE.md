# Project handoff — 2026-09-25

> **Kind: current reference** — replace this handoff when the next work finishes.
> The ruling/questionnaire implementation is complete through `c752740` on
> `decision-rounds-2`. The owner authorized integration into `main` after clean
> closeout validation, then a new branch for the revised remaining-work plan.

## What is complete

The core now records human rulings separately from carrying them out. It supports
published questionnaires, device-local drafts, partial submissions, exact publication
identity, scoped revisions, explicit withdrawal, independent answer comparison, and
reader-validated one-shot invalidity closure for both findings and bugs. The last
repair preserves earlier per-item corrections in revision presentations and derives
relayed list corrections from the human's transcript answer.

Read [rulings-workflow.md](rulings-workflow.md) for current operations and
[rulings-contract.md](rulings-contract.md) for the controlling behavior. Historical
worked cases and diagnoses explain changes; their superseded mechanics are not a
new implementation queue. The materializer version at this checkpoint is 43.

The latest correctness and fold review found no actionable defects. Closeout
`npm test` passed on 2026-09-25: **1,996 unit tests and 167 end-to-end tests**,
zero failures and zero skips. This includes the browser workflows and vdx template
lint. Source remained at `c752740`; the closeout changes only these handoff documents.
The publication sanitizer and `git diff --check` also passed.

## Remaining work

The original plan's boundary was **records + skills integration**, with general
repair verification in a later plan. The records are built; skills integration is
still pending. Reconcile the old items against the current contracts before planning:

- **I1:** reproducer retention landed in the skills source repository. Reconcile
  source and installed skill versions when deploying the integration.
- **I2 and I11:** commit-specific evidence (`at:` on `close_finding` and
  `record_audit`) and the worked-case/owner-ruling gate are complete.
- **I8:** the records, transcript adapter, operations and surfaces are built and
  extended by the questionnaire/ruling redesign.
- **I10:** integrate `triage-review` and `ez-plan` through MCP, preserving operation
  without codemap. The recovery ruling replaced the proposed markdown importer
  with skills writing through MCP. The transcript adapter currently reads Claude
  transcripts; a Codex relay needs an explicit supported path.
- **I9, including I4/I6/I7:** plan durable sorting, repair evidence, independent
  repair verification and the remaining finding-lifecycle/identity choices.
  Reader-validated invalidity application is already built and must not be
  commissioned again as a general verifier. Requirement sign-off execution from
  verified answers remains deferred; ratification stays a separate principal act.
- **I12–I14:** optional falsifier calibration, the downstream sort-before-fix-all
  guard, and downstream outcome measurements retain their separate scope decisions.

The original records are local to the repository's common Git directory under
`plan/2026-09-22-decision-rounds/` and
`plan/2026-09-23-decision-rounds-recovery/`. They do not travel with commits.
The next plan must enumerate the remaining items, identify superseded proposals,
and retain explicit deferrals rather than silently dropping them.

## Operational boundaries

Use isolated scratch repositories for validation. Live downstream repositories and
sidecars are not test fixtures; `sharedSync` may publish through their remotes.
Questionnaire wait observes local projections only; remote answers require explicit
sync. General repair verification and skills integration are not implied by passing
the ruling workflow's tests.
