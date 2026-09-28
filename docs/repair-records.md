# Repair records: P2 contract

Repair records are evidence and classification history. They do not themselves
resolve or refute findings. [P3 verification](repair-verification.md) adds
independent verification and a separate application check. Existing human-ruling application keeps its
own direct and indirect reader cardinalities.

The authoritative acts live in the canonical finding's sidecar scope:
`repair.claims-recorded`, `repair.sort-recorded`,
`repair.participant-recorded`, and `repair.evidence-recorded`.
The finding fold projects them atomically with the findings into SQLite.
Normal
readers use the projection; writes capture causality under the sidecar lock.

`repair_records` reads the complete history for a review. The web page is linked
from that review's findings. `post_repair_sort` records a classification,
isolated/pattern kind, exact owner source or reported sorter assessments,
coverage, dependencies, disagreements and arbitration. A correction names its
prior version and reason. Superseded versions survive. The latest correction on a
lineage wins; two corrections competing from one sort (or two sorts of the same
claims) are held as a question for the owner, which they answer by posting a
correction of their own — the newest head, person-authored, wins and the rest read
"outranked" (owner, Defaults A2). An agent cannot turn its own report into an
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

`record_repair_participant` has no identity input: the identity is the MCP connection
the call arrived on (see [repair verification](repair-verification.md)), and that
connection then cannot verify the repair. Blocked scope records remain visible and
cannot supply authoritative participation. It records which connection made codemap
calls; it cannot prove all shell repair work was registered.

The fixer-sort guard permits the original principal-authored owner approval;
later fixer participation under that principal does not revoke that approval.
Corrections by a fixer principal remain held, and a reported assessment from
the exact fixer session cannot improve eligibility.

No stored execution result is an independent verifier receipt. P3 checks
code availability, rerun usefulness, evidence adequacy, current claim/sort
identity and ruling holds before application. In particular an unavailable
commit, dependency or environment must produce an unknown verification result,
never a negative verdict. Nothing in P2 supplies that authority.
