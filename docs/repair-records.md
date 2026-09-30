# Repair records: P2 contract

Repair records are evidence and classification history. They do not themselves
resolve or refute findings. [P3 verification](repair-verification.md) adds
independent verification and a separate application check. Existing human-ruling application keeps its
own direct and indirect reader cardinalities.

The authoritative acts live in the canonical finding's sidecar scope:
`repair.claims-recorded`, `repair.sort-recorded` and `repair.evidence-recorded`.
`repair.participant-recorded`, `repair.verification-producer` and
`repair.verification-sealed` are retired kinds: skipped, never shown as rejected
(`RETIRED_REPAIR_KINDS`).
The finding fold projects them atomically with the findings into SQLite.
Normal
readers use the projection; writes capture causality under the sidecar lock.

`repair_records` reads the complete history for a review. The web page is linked
from that review's findings. `post_repair_sort` records a classification,
isolated/pattern kind, exact owner source or reported sorter assessments,
coverage, dependencies, disagreements and arbitration. A correction names its
prior version and reason, and supersedes it; superseded versions survive. The log is
linear, so corrections are sequential: one naming a sort that was already corrected,
or a fresh sort of claims another current sort covers, is refused as stale (plan 5.2).
Adding sites or claims is free. A correction that REMOVES a site or claim its prior
had is refused unless it cites a logged ruling on why those are not instances: a
decisions answer, named in `ruling` (R5, narrowed by the owner's batch 5: "Narrowing
needs a ruling"). The op checks that the ruling is a verified, standing answer; the
fold checks only that the field is there. An agent cannot turn its own report into an
owner-reviewed worklist.

A `dual-sorted` sort is the skill's own two-sorter sort, posted with the round: two
assessments from distinct sessions, and an arbitration from a third when they
disagree. The sorter identities are reported provenance (the owner: "2 blind isn't
needed for the skill's findings sort"); there is no sorter role to claim.

Original claim IDs and exact text come from `finding.created`, with the complete
as-filed payload and witness retained. `record_repair_claims` adds decomposed
claims and provenance;
it never replaces the original or removes earlier claims. Coverage cites those
immutable IDs. Each evidence record reports outcomes for each covered claim.
Completeness requires every original and decomposed obligation, and pattern
coverage retains the original enumeration. A complete report for one claim or
finding does not complete another. Completeness is reported scope coverage,
not verified repair adequacy.

`record_repair_evidence` keeps witness/base/fix commits, execution environment,
commands, actual results and output, reproducer phases at witness/fix, regression runs, expected/actual pattern sites, inspected
sources and reasoning, attribution, ruling references and no-check reasons
separate. Unknown execution requires an explicit reason; absent checks stay
absent. A passing regression run is not a reproducer.
Inspection remains a weaker evidence grade. Commands are data: storing or
reading them never executes them or authorizes external side effects.

There is no fixer record. Who may verify is decided by grants, not by who fixed
(see [repair verification](repair-verification.md)).

No stored execution result is an independent verifier receipt. P3 checks
code availability, rerun usefulness, evidence adequacy, current claim/sort
identity and ruling holds before application. In particular an unavailable
commit, dependency or environment must produce an unknown verification result,
never a negative verdict. Nothing in P2 supplies that authority.
