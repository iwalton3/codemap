# Repair records: P2 contract

Repair records are evidence and classification history. They do not themselves
resolve or refute findings. [P3 verification](repair-verification.md) adds
independent sealed verification and a separate application check. Existing human-ruling application keeps its
own direct and indirect reader cardinalities.

The authoritative acts live in the canonical finding's sidecar scope:
`repair.claims-recorded`, `repair.sort-recorded`,
`repair.participant-recorded`, and `repair.evidence-recorded`.
The finding fold projects them atomically with the findings into SQLite.
Materializer version 45 introduced these records; version 46 adds verification
and refolds unchanged shards from older caches. Normal
readers use the projection; writes capture causality under the sidecar lock.

`repair_records` reads the complete history for a review. The web page is linked
from that review's findings. `post_repair_sort` records a classification,
isolated/pattern kind, exact owner source or reported sorter assessments,
coverage, dependencies, disagreements and arbitration. A correction names its
prior version and reason. Superseded versions survive. Competing current heads
in one lineage remain held even after further corrections on one branch.
Reported sorter identities and arbitration remain unverified unless independently sealed and validated (see admission below); an agent
cannot turn its own report into an owner-reviewed worklist.

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
commands, actual results and output, reproducer phases at witness/fix, reversal
or mutation falsifiers, regression runs, expected/actual pattern sites, inspected
sources and reasoning, attribution, ruling references and no-check reasons
separate. Unknown execution requires an explicit reason; absent checks stay
absent. A passing regression run is not a reproducer or a change falsifier.
Inspection remains a weaker evidence grade. Commands are data: storing or
reading them never executes them or authorizes external side effects.

`record_repair_participant` has no identity input. The measured native MCP host
metadata supplies an opaque in-process capability bound to the repository
principal, pinned to Desktop `0.158.0-alpha.2.1`. The resulting participation act
travels through the log and is available to the verifier boundary after sync.
Caller identity objects and serialized capabilities are refused. Blocked scope
records remain visible and cannot supply authoritative participant admission.
This is ordinary local/sidecar provenance, not cryptographic attestation.

The fixer-sort guard permits the original principal-authored owner approval;
later fixer participation under that principal does not revoke that approval.
Corrections by a fixer principal remain held, and a reported assessment from
the exact fixer identity cannot improve eligibility. Independent sorter eligibility uses the bounded admission described below. Native host metadata proves which session made a codemap call; it
does not prove that all shell repair work was registered. Participant reporting
and codemap-domain freshness cannot establish that stronger claim.

No stored execution result is an independent verifier receipt. P3 checks
code availability, rerun usefulness, evidence adequacy, current claim/sort
identity and ruling holds before application. In particular an unavailable
commit, dependency or environment must produce an unknown verification result,
never a negative verdict. Nothing in P2 supplies that authority.

## Independent sorter admission (materializer 47)

A fresh native `claim_repair_sorter` session receives one `repair_sort_brief`
and submits `repair_sort_assess`; a distinct arbitration session receives both
sealed assessments and addresses the recorded disagreements through
`repair_sort_arbitrate`. The brief binds the exact proposed classification,
coverage and all immutable claim obligations, including original creation event
identity. Sorters remain separate from fixers, relayers and repair verifiers.
Same-model sessions are distinct; one session or connection cannot fill both
assessment slots. Reported receipts remain visible without granting authority.

Producer registration precedes the sort act. Signatures bind the source review
scope, proposal, claims, actual identity, connection and opinion. Changed content,
missing registrations, unaddressed disagreement and recorded participation keep
the sort held. Posting, verification requests and separate application also
recheck locally known forbidden role activity through the durable admission
ledger. Later contamination raises attention without erasing historical acts.
The browser reads these records through the existing repair API; native producer
operations require the host boundary and cannot be issued by a browser caller.

A fold receives events without the physical bucket path. It verifies the signed
scope and original event identities, but cannot distinguish a wholesale copied
scope from its original physical location. Posting checks the actual destination
scope. Cross-machine role taint is local control evidence, not a new shared act;
these receipts retain the existing trusted-machine/sidecar limits.
