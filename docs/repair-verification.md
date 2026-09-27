# Repair verification: P3 contract

The repair path is separate from human-ruling invalidity application. Its acts
are `repair.verification-producer`, `repair.verification-requested`,
`repair.verification-sealed`, `repair.verification-arbitrated`, and
`finding.repairApplied`, in the canonical findings scope. The sidecar log is
authoritative. SQLite projects verification and findings atomically;
materializer version 46 replays unchanged shards from earlier versions.

A fresh claimed orchestrator calls `repair_request` with an eligible current
sort and evidence record. A trusted fixer must already be recorded. The request
preserves the entire immutable original/decomposed claim set, accepted sort,
evidence, exact witness/base/fix commits and diff, current finding claim hashes
and open epochs, and ruling context. Missing code remains explicitly unknown.
No stored command is executed by these operations.

Each of two fresh verifiers calls `repair_brief` for one exact slot, then
`repair_verification`. Both receive the same neutral scope, original claims,
accepted classification, pinned code and evidence definitions/results. Fixer
coverage conclusions and inspection reasoning are omitted. Other verifier
answers are absent from briefs and submission responses. Assignment cannot
change to another request, slot or role. Same-model sessions remain distinct;
the same session or connection cannot occupy multiple jobs.

Per-claim outcomes are fixed, factually-refuted, decision-needed or unknown.
Useful pinned executable evidence must be independently rerun. Fixed executable
proof needs a failed witness, passing fix and failing reversal or mutation,
with actual results and mutation/reversed-hunk detail. Regression green alone
is insufficient. When no useful executable check exists, independent inspection
may qualify with its explicit no-check reason and visibly weaker grade. Pattern
coverage includes the original expected and actual sites. Partial coverage never
closes an entire finding, and code proof cannot settle a scope judgment.
Factual refutation must check the as-filed witness commit, rather than merely
finding the repaired condition at the fix commit. An immutable full-SHA source
reference must establish that witness; unresolved branch-only or hash-only
provenance currently cannot grant factual-refutation authority.

A third fresh arbitrator receives both sealed runs only after genuine
disagreement. `repair_arbitration` must address each disagreement substantively;
it cannot manufacture missing independent repair evidence.

The original orchestrator separately calls `repair_apply_verification`. The
operation rechecks current claim/epoch, sort, evidence, code availability and
ruling context. The findings fold also checks the signed application, immutable
P2 snapshot, act-time claim and epoch, independent complete coverage and
participant exclusions. Fixed closes as resolved; factual refutation closes as
refuted. Unknown never closes or automatically reopens. Reopening creates a new
epoch that cannot reuse the old application. Linked bugs are not auto-closed.
Historical records and weaker grades remain visible on the repair page.
Later participation contradictions preserve the earlier canonical closure and
raise visible attention, while disqualifying compromised receipts from new acts.
Current target decision holds apply even when the evidence omits ruling IDs.
Ordinary holds retain the existing later-human-assignment release rule; hard
comparison holds still require their own judgment or resolution.

Seals use Node's built-in Ed25519 implementation. The private producer key is
local store control data and never enters the shared log or tool responses.
Producer public keys are registered separately; signatures bind exact event
kind, subject, request, session, connection and content. An opaque one-shot
capability from the admitted boundary is required to issue a seal. This proves
local producer issuance within the existing trusted-machine/sidecar model; it
is not remote hardware attestation or a defence against a hostile log writer.

Support includes the pinned Desktop 0.158.0-alpha.2.1 profile and a separate
measured CLI continuation (client/child 0.157.1, historical parent
0.158.0-alpha.2.1, exact measurement server alias). The latter completed a live
dual-sort, participant, fresh orchestrator and two blind executable-verifier
factual-refutation application in an isolated fixture. It does not establish a
live Desktop workflow or other versions/aliases. Domain freshness and recorded
participants cannot prove a session never fixed code through shell tools.
Opaque initial prompts remain the owner's accepted role-admission limitation.
Purpose-specific native application readers still refuse current opaque launch
records because those cannot prove the exact issued brief. Claude human-ruling
and operation sign-off reader successes are recorded separately; Claude repair
role admission and synchronous human-answer variants remain unproven.

Unverified reported dual-sort/arbitration receipts and requirement dependencies still hold
P2 eligibility. Independently admitted sorter receipts can establish mechanical eligibility. An original principal-authored owner-approved worklist survives
later fixer participation by that principal; fixer reclassification corrections
remain held. Ruling-context invalidation currently uses the whole local decision
scope conservatively. The derived lifecycle slice below implements landing/drift attention on repair history; queue and detail presentation now share that lifecycle contract. Exact operation
sign-off is described in operation-signoff.md; skill deployment remains separate.

## Derived lifecycle slice

`repair_records` now reports `lifecycles` separately from the historical
application. Exact-file equality can establish repair landing through a squash
or cherry-pick; otherwise ancestry and the existing restricted PR fallback are
used. A negative ancestry result in a shallow clone remains unknown. An earlier
PR merge cannot establish that a later repair commit landed. Expensive ancestry
checks are keyed on both the checked and resolved default commits.

Workspace and default-branch source movement raise attention while retaining
closure history. Drift is deliberately conservative at file granularity;
opaque inspection descriptions without an exact file or cached anchor boundary
remain unknown. Commands stay data. The repair history page and the canonical read surfaces below carry landing/drift
presentation; explicit human acceptance remains separate from repair adequacy.

## Canonical read surfaces and human acceptance

Queue, search, finding detail and decision-round detail now carry the same
review-qualified repair presentation. Canonical closed findings leave the active
queue immediately; search and explicit history reads retain them. These reads
show original claim scope, exact checked commit, landing, evidence grade,
verifiers, ruling references and prior applications. The canonical current state
is shown alongside historical verification, so reopening cannot read as a new
closure. Blocked or unavailable repair history remains explicitly unknown.

Branch-linked PR fallback requires the checked commit to be an ancestor of the
PR head, unchanged repair files at that head, and the PR's merge commit to be an
ancestor of the resolved default tip. A merged status alone cannot establish
landing. Older merges, changed source, stacked merges outside the default line
and failed metadata remain insufficient.

Explicit permanent acceptance is a separate human disposition. A verified
selected decision effect names `as: "accepted"`; adoption for implementation is
an unblock, and postponement uses dated backlog. The existing independent ruling
reader checks the complete acceptance scope. A version-2 application capsule
binds the selected effect and credited answerer into the hashed displayed
context, rejects contradictory dispositions, and applies canonical `accepted`.
It retains executor attribution separately and consumes the ruling–issue pair
once. Legacy version-1 applications retain invalidity semantics. Acceptance is
not repair proof and never closes a linked bug.

Materializer 48 introduced acceptance semantics; 49 additionally introduces the
operation sign-off event. Neither later answer revision nor source drift erases
an applied historical closure. The source-principal attribution remains the
existing local answer model; native account identity is not a proven mapping to
a repository principal.
