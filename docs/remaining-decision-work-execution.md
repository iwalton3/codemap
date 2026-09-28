# Remaining decision work: what was built

The branch `questionnaires-and-repair-verification` (cut as `codex/remaining-decision-work`; planned in
`.git/plan/2026-09-25-remaining-decision-work/plan.md`) was implemented by Codex between 2026-09-24
and 2026-09-28, then reviewed and recovered (`.git/plan/2026-09-28-codex-recovery/`). This file used
to narrate every session of that work (1,259 lines); the narrative is in git history at `ff3bef3`.
What remains normative lives in the contracts below.

| Area | Contract |
|---|---|
| Rulings: rounds, questionnaires, answers, revision, withdrawal, comparison, application | `docs/rulings-contract.md`, `docs/rulings-workflow.md` |
| Repair records: claims, sorts, evidence, participants | `docs/repair-records.md` |
| Repair verification: verifier identity, the evidence bar, application, lifecycle | `docs/repair-verification.md`, `docs/repair-verification-worked-cases.md` |
| Operation sign-off relayed from a person's answer | `docs/operation-signoff.md`, `docs/requirements-architecture.md` |
| What codemap reads from harness transcripts | `docs/harness-provenance.md` |
| Measuring decision outcomes (protocol only) | `docs/decision-measurement-protocol.md` |

The recovery removed what the owner had not asked for — the Ed25519 layer, the Codex provenance
stack and Codex question receipts — rebuilt verifier identity on the owner's rulings, and made the
decisions fold total. Its plan, rulings and per-phase record are in the recovery directory above.
