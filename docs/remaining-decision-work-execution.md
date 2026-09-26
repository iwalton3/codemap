# Remaining decision work: execution record

Implementation began on 2026-09-26 at
`582780cfac89f1be9fa4e8e910f0ef5f5a99eb81`, on
`codex/remaining-decision-work`, with a clean worktree. The owner's instruction
to start implementation supplies the separate authorization required by the
finalized plan. The plan itself is retained unchanged.

## P0: behavioral baseline

[Worked cases](repair-verification-worked-cases.md) freeze 26 synthetic scenarios
and the negative controls for the later protocol. They state expected record,
authority, eligibility and visibility. They distinguish the existing human-ruling
application path from the new two-blind repair-verifier path and preserve the
owner's inspection, acceptance and queue decisions.

Two new baseline tests use existing capabilities:

- `src/decision-ops.test.ts`: real posting and principal answers for both decisions
  produce work authorization while both canonical findings remain unresolved.
  The pre-answer state is asserted so the answer check is not vacuous.
- `src/shared-findings.test.ts`: real append/read/fold records a prose fixed report
  carrying a passing-suite assertion without resolving either finding or altering
  the sibling claim. The report's presence and history are asserted separately.

Existing regression coverage runs alongside them:

| Cases | Existing executable seams |
|---|---|
| C14/C15: changed answer, holds and conflict | `decision-ops.test.ts`, `decision-lifecycle-round5.test.ts`, `decision-comparison-ops.test.ts` |
| C13: one-shot human-ruling application and reopening | `ruling-application.test.ts`, `ops/ruling-application.test.ts`, `oracle-ruling-application.test.ts` |
| Human-invalidity direct/indirect cardinalities and arbitration | `ruling-application-matrix.test.ts`, `mcp-ruling-application.test.ts` |
| Existing Claude human/reader provenance and negative fixtures | `transcript.test.ts`, `decision-ops.test.ts` |
| C18/C19: existing agent sign-off refusal | `decision-stamps.test.ts` |
| C22: existing dated backlog, witness and authority gates | `finding-backlogged.test.ts`, `finding-backlog-flow.test.ts`, `bug-backlogged.test.ts`, `bug-backlog-flow.test.ts` |

These tests exercise delivered behavior, not the absent repair protocol. In
particular, today's legacy ratchet permits some unconfirmed agent proposals to
be refuted; that is not proof of the proposed factual-verification contract.

## Absent capabilities, not observed behavioral failures

Read-only source probes at the starting tree confirm the plan's baseline:

- `rg -n 'verifyClose|postSort|RepairEvidence|Verification' src/schema.ts src/ops.ts src/ops/annotations.ts`
  finds no repair-sort or verification API. The unrelated verification-difficulty
  comment in the schema is not such a capability.
- `src/transcript.ts` defines Claude project paths and `AskUserQuestion` receipts.
  It does not implement native Codex delayed-answer or fresh-connection proof.
  The plan's harness measurements are discovery evidence, not a passing adapter.
- `src/materialize.ts` has `MATERIALIZER_VERSION = 43`.
  No vocabulary/projection change is made by P0, so it needs no version bump.

P1-P6 remain implementation work: measured harness/role provenance, persisted
sort/claim coverage/evidence, independent verification and application, lifecycle
and visibility, verified operation sign-off, and skill integration/deployment.
P7 remains measurement protocol and synthetic extraction work. New-capability
negative controls will run with their implementation; none is reported here as
a pre-existing failed test. No downstream repositories or installed skills were
changed, no dependencies were added, and no deployment or landing took place.

## Validation

Environment: Node `v24.21.0`. `npm run unit` compiles the source and typechecks the
web modules before running serialized hermetic tests.

The first invocation stopped at compilation: the new decision baseline omitted
`await` on `readFinding`, producing TS2339 on its three property checks. The
test was corrected before the second invocation. No behavioral result is
claimed for that failed invocation.

The second invocation compiled successfully but stalled in the existing
`audits.test.ts` commit-witness test. Process inspection found the runner waiting
on an idle `git cat-file --batch` child for over two minutes. Those exact runner
and child PIDs were terminated; the resulting interrupted/cancelled test output
is not a regression verdict or a passing baseline. A third invocation runs
outside the sandbox, with output at
`/tmp/codemap-remaining-decision-work-unit.log`. It completed with exit code 0:
**1,998 passed, 0 failed, 0 cancelled, 0 skipped, 0 todo**, in 716.236 seconds.
Both new P0 tests passed. Source compilation and web typechecking also passed.
`git diff --check` passed. The e2e suite was not run for this test/document-only
slice; full `npm test` remains required after integration.
No fail-before/pass-after production repair is claimed: P0 adds cases and
baseline coverage, and leaves production behavior unchanged. Browser and skill
scenario validation belong to the implementation slices that change them.

## P1: native delayed-answer slice (partial)

[Harness provenance](harness-provenance.md) records the measured support and
limits. A benign native question received a real delayed human reply; the
adapter read `Probe answer` from that reply, not from the display acknowledgment.
A separate benign child launch/follow-up exposed parent/child metadata but not
a readable exact initial brief or a proven fresh MCP connection.

The new isolated native adapter supports the measured Desktop rollout version.
`log_question` explicitly selects it with `harness: "codex"`; existing Claude
parsing remains intact. Native receipt identity survives the log, fold, answer
projection and browser history. Corrections are separate source records,
partial answers stay partial, and retries deduplicate by exact source message.
Unknown versions and unsupported reader paths fail visibly with questionnaire
guidance. No new agent role, verifier authority or closure path is introduced.
Source creator identity is retained separately from recorder attribution; its
mapping to a git principal is not claimed solved.

Projection semantics changed, so `MATERIALIZER_VERSION` is now **44**. A real
two-clone sync and unchanged-shard older-cache test verify receipt replay rather
than assuming it. Invalid native receipts cannot become legacy answers.

Validation: `npm run typecheck` passed. The targeted backend command ran
`codex-transcript`, `transcript`, `decision-ops`, `db-migrate`,
`decision-storage-upgrade`, `mcp-codex-transcript`, `mcp-ruling-application` and
`ruling-application-matrix`: **92 passed, 0 failed/cancelled/skipped/todo**,
43.822 seconds, `/tmp/codemap-p1-targeted-final.log`. The decisions UI suite:
**10 passed, 0 failed/cancelled/skipped/todo**, 12.919 seconds,
`/tmp/codemap-p1-browser.log`. These used isolated synthetic repositories and
transcripts. The full unit/e2e suite has not been repeated for this partial
slice; the P0 full-unit result above is not a P1 regression result.

During implementation, new-test typechecking caught a missing import, an
incorrect guessed `readScope` return shape and a nonexistent team method; each
was corrected. The first targeted run also caught a new operation fixture
retaining a Claude-style header: exact native matching correctly refused it.
The fixture now uses only text actually shown by the native tool. That failed
run is retained at `/tmp/codemap-p1-targeted.log`, not counted as a pass.

## P1: verifier identity and role-boundary slice

The owner's 2026-09-26 instruction accepts opaque launch prompts explicitly:
exact prompt visibility is no longer a blocker. The risk and its limits are
recorded in [Harness provenance](harness-provenance.md); it does not establish
a fresh session-to-MCP connection binding.

`src/verifier-boundary.ts` supplies a scoped identity key, fresh-connection role
admission and an in-process receipt registry. Same-model sessions and children
remain distinct, while the same session retains its key across revised model
metadata and reconnects. Legacy review/actor independence remains unchanged.
Trusted fixer/relayer participants exclude their identities at claim, submission
and replay. Exact receipts bind the actual verifier, role, connection, request
and content; a forbidden role action invalidates subsequent receipt validation.

The real MCP dispatcher now admits `claim_verifier` before domain activity and
counts reads, writes and failed domain attempts. Protocol negotiation does not
count. Supported claims would constrain the entire dispatcher to explicit repair
operations, including future additions. Production claims currently refuse with
the measured session/connection evidence gap: no native adapter binds a child to
this connector. No caller arguments or environment identity override enables
success. The supported-boundary tests use synthetic trusted adapter context;
they are not a passing live harness measurement. No repair receipt producer,
shared verification event, closure or new human-ruling authority is exposed.

Validation: `npm run typecheck` passed; the targeted provenance, MCP admission,
legacy identity and direct/indirect human-application regressions passed outside
the sandbox: **47 passed, 0 failed/cancelled/skipped/todo**, 2.954 seconds,
`/tmp/codemap-p1-boundary-tests-final.log`. This includes eight boundary unit
cases and two real MCP admission cases. `git diff --check` passed. No store
schema or projection semantics changed in this slice, so no materializer bump
is needed. Full `npm test` remains an integration requirement.

The initial sandbox run did not supply a regression result: the MCP child
exited with code 0 before answering any calls, and the combined runner stopped
making progress. A separate single-file invocation reproduced that premature
exit. The outside-sandbox rerun above completed normally. The initial output
is retained at `/tmp/codemap-p1-boundary-tests.log`.

## P1: native context consumption and durable role admission

The measured request metadata is now consumed by `codex-verifier-context.ts` and
the real MCP dispatcher. Fresh supported child claims succeed and return the
actual child/session identity. Parent-only, inherited, followed-up, interrupted,
unknown-version and unreadable provenance refuse. The adapter rechecks native
records on later role requests and receipt validation. Discovery corrected an
incorrect assumption: a child's header `id` names the child, while its
`session_id` names the parent. Read-only parser diagnostics accepted both real
probe rollouts after that correction, using synthetic request metadata; this was
not a live product role claim.

A local admission ledger survives reconnection and atomically chooses one owner
when two processes race. Domain reads and failed attempts consume freshness.
Ordinary domain use after a role claim is refused and taints that claim across
processes. Identity lookup for restrictions survives a client-version change;
role support itself remains pinned to the measured version. The table is local
control state, not a shared projection; migration preserves old local evidence
and creates a backup without a materializer version change.

Independent review caught two implementation defects: serializing all handlers
would prevent concurrent status waits from being woken, and a storage exception
in admission could leave an RPC unanswered. The dispatcher again admits requests
synchronously then runs handlers concurrently, with immutable bound provenance;
both admission and claim-storage failures return explicit errors and invalidate
the boundary. A later review caught that version-pinned restrictive identity
lookup could bypass the durable ordinary-action ratchet on upgrade; restrictive
lookup now parses the stable identity fields regardless of version, while claims
remain pinned. Transport tests cover clean and tainted reconnects, omitted
metadata, malformed domain attempts, upgraded clients and storage failure.

Initial typechecking caught nullable-principal adapter inputs and optional test
assertion messages; they were fixed. A targeted run then caught the new storage
failure test expecting an admission prefix while the claim-handler catch used a
generic prefix; the error path now explicitly invalidates admission and reports
it. The failed log is `/tmp/codemap-p1-adapter-targeted-final.log`, not a passing
validation. Account identifiers appeared once in a helper's discovery tool
output; subsequent reads were sanitized and none entered fixtures/docs.

The broad unit run found a source import cycle introduced by the preceding
native-answer slice: `transcript -> codex-transcript -> transcript`. Shared
harness constants now live in the independent `codex-harness.ts`; existing
imports retain their public exports. The source/web/store cycle checks all pass
without changing their guard. This is not a passing result for the initial
`npm test` invocation.

Validation after that fix: source/web typechecking and **109 targeted tests**
passed, with 0 failed/cancelled/skipped/todo in 30.610 seconds,
`/tmp/codemap-p1-adapter-targeted-final4.log`. `git diff --check` passed.
A benign live follow-up to probe child A reopened it on a new diagnostic MCP
connection with the same thread identity; parser recheck refused its additional
input/turn while still accepting clean child B. These were read-only diagnostics
using synthetic request metadata, not native repair verdicts. The broad unit run
finished with **2,062 passed and 1 failed**, no cancellations/skips/todos,
551.450 seconds, `/tmp/codemap-p1-adapter-full.log`. Its sole failure was the
source cycle above; the corrected source/web/store cycle checks pass on rerun
and are included in the 109 targeted passes. The whole unit suite was not
repeated after that structural fix, so no clean full `npm test` result is claimed.
E2e was launched separately because the initial cycle failure prevents the
chained command reaching it: **168 passed**, 0 failed/cancelled/skipped/todo,
204.507 seconds, `/tmp/codemap-p1-adapter-e2e.log`. No dependencies were added,
and no code was deployed, committed or landed in this slice.

## P2: durable repair records

The additive repair record path is implemented through `ops/repairs.ts`, the
store seam and the existing canonical findings scope. Four new acts capture
sort versions, claim decompositions, participation and structured evidence.
The finding fold materializes repairs and findings atomically; unchanged-shard
upgrade replay is covered and `MATERIALIZER_VERSION` is **45**. The log remains
authoritative, with normal readers using SQLite. No dependencies were added.
See [the repair record contract](repair-records.md) for producer and reader
details.

Original claim text, stable IDs, witness and provenance survive revisions and
decomposition. Per-finding/per-claim reports preserve omitted obligations;
pattern completeness retains the original sites. Sort history includes source,
classification, dependencies, both reported assessments, disagreement and
arbitration. Competing correction heads stay held across later descendants.
Reported sorter/arbitrator identities are unverified rather than being promoted
to receipts. A principal-authored owner worklist retains distinct provenance.
Sorts made by a recorded fixer cannot improve eligibility.

Evidence separately records reproducer witness/fix phases, reversal/mutation
falsifiers, regressions, expected/actual pattern sites, pinned inspected sources
and reasoning, command/environment/results, diff attribution, ruling IDs and
unknown/no-check reasons. Commands remain data and are never executed by these
operations or the reader. Stale evidence remains visible. The read-only web
page is linked from PR findings and uses the same ops contract as MCP.

Native participation is bound to an opaque server-issued capability from host
request metadata, with exact repository-principal and measured-version checks.
The log retains that act across clone sync; the production verifier participant
callback now reads the stored records and refuses blocked provenance. No tool
argument can substitute a session identity. The guard against fixer sorting is
currently conservative across a principal/review scope; refining independence
to bounded repair/session identities is required before P3 enables authority.

Independent review executed a fold and found a real conflict-laundering gap:
`root → left/right → left2` initially let the second descendant become eligible.
The source now checks current heads across the entire lineage, including
overlapping roots. Review also found that the version-agnostic restrictive
identity observer was being reused to grant participation; producer admission
now separately pins the measured version. Negative tests cover both corrections.
The follow-up review found repeated narrowing could discard an ancestor's
pattern restriction, and malformed arbitration could throw during hold
derivation. Corrections now compare with the original lineage scope; malformed
nested provenance is rejected before derivation. Both have negative tests.

Initial new-test typechecking caught the synthetic admission event missing
envelope fields and incorrect `readFinding` argument ordering; these were
corrected. The first sandbox test invocation also reproduced the known MCP
subprocess early-exit restriction and ran an earlier emitted test with the bad
lookup. It is retained at `/tmp/codemap-p2-ops.log`, not counted as a passing
validation. A subsequent outside-sandbox run passed **15** repair operation,
participation and MCP-boundary tests, no failures/skips/cancellations/todos,
10.073 seconds: `/tmp/codemap-p2-ops-external.log`. This predates the final
unknown-version negative and deeper lineage changes; final validation is
recorded below after integration.

Integration validation: `npm test` ran **2,082 unit tests, all passing**, no
failures/cancellations/skips/todos, 750.503 seconds. The chained e2e run passed
**169 of 170** tests; the only failure was the new `:review` route parameter
lacking a fixture substitution in `routes.e2e.ts`, not a browser rendering
failure. That substitution is now added. The combined failed command is
retained at `/tmp/codemap-p2-full.log` and is not a clean `npm test` result.
The unit phase used the earlier compiled integration snapshot; review changes
made while it ran were compiled for the e2e phase and final targeted reruns.

The first final targeted run passed **123 of 124** tests; the native
participation case timed out, `/tmp/codemap-p2-final-targeted.log`. Unsupported
participant requests now refuse without taking the repository write lock that
initialization maintenance may hold. An isolated rerun passes (one test,
`/tmp/codemap-p2-native-rerun.log`), and the complete final targeted command
passes **124 of 124**, no failures/cancellations/skips/todos, 24.533 seconds,
`/tmp/codemap-p2-final-targeted2.log`. It covers the repair fold/ops/capabilities,
native MCP boundary, store migration and unchanged-shard replay, materialization,
canonical findings, API reach, import cycles and existing direct/indirect
human-ruling application regressions. Caller-alias mutation and blocked sidecar
reads/writes are also exercised. Final source/web typechecking and
`git diff --check` pass. Full unit has not been rerun after the final review
changes; no clean final full-unit or `npm test` result is claimed.

Final full e2e rerun passes **170 of 170**, no failures/cancellations/skips/todos,
200.615 seconds, `/tmp/codemap-p2-e2e-final.log`. This includes the repair page,
the formerly failing route smoke check, and the existing decision/ruling UI
regressions. Its source/web compilation succeeds. Final branch remains
`codex/remaining-decision-work`, HEAD remains
`582780cfac89f1be9fa4e8e910f0ef5f5a99eb81`, and all earlier modified/untracked
implementation files are retained. Nothing is committed.

Remaining authority limits: claim completeness is a reported scope result,
not independently verified adequacy. Sorter/arbitration receipt admission,
independent sealed verification, exact-code reruns and separate application
remain gated. Neither suite success nor inspection prose resolves a finding.
No existing human-ruling application cardinality changed. P1's live handler
claim, native reader-verdict receipt, synchronous and new Claude measurement
limits remain; shell repair absence is still unprovable. Nothing was committed,
deployed, landed or written into live `/working` repositories.

## Remaining work after P2

P1's native identity and connection role gate is implemented. A live production
claim through the new handler remains unmeasured; the native answer/application
reader-verdict receipt path, synchronous variants and new live Claude
measurements remain unfinished. Opaque initial prompts are an accepted risk.
P2 now persists sort, original claim coverage, native fixer/relayer participants
and repair evidence. P3 still needs trusted sorter/arbitration receipt admission,
durable sealed verification and guarded application. The local role ledger
proves codemap activity freshness and cannot
prove that a session never fixed code through shell tools. No repair authority,
closure producer, downstream deployment or landing is introduced here.

## P3: sealed verification and separate application

The [P3 contract](repair-verification.md) adds immutable neutral requests, two
bounded blind verifier slots, substantive fresh arbitration and a separately
sealed application to canonical findings. Producer keys use Node's built-in
Ed25519 support. Private keys stay in the local store; public registration and
exact signed acts travel through the sidecar. Caller JSON cannot issue sealing
capabilities. The fold validates registered producer, identity, session,
connection, request and exact content rather than trusting a serialized boolean.

Requests retain exact P2 claims/sort/evidence, commit availability and diff,
current claim/epoch and ruling context. Trusted fixer participation precedes
request creation. Verifier briefs exclude peer runs and fixer coverage/inspection
conclusions. Sessions cannot switch request, job or blind slot. Actual executable
repair proof needs a failed witness, passing fix and failed reversal/mutation;
regression green alone cannot qualify. Explicit independent inspection remains
permitted with its weaker grade and no-check reason. Partial original/decomposed
coverage and omitted original pattern sites cannot close a whole finding.

Application rechecks inputs independently and emits `finding.repairApplied` only
when the canonical fold actually closes that exact current finding. One sibling
application does not prevent separate complete siblings from applying, and does
not close a linked bug. Existing human-ruling application remains separate.
Reopened epochs cannot reuse verification. Unknown neither closes nor silently
reopens. Later participant contradictions retain the historical closure with
visible attention; current compromised receipts cannot grant new authority.

Materializer **46** adds the verification projection atomically with canonical
findings and P2 records. Two-clone sync and version-45 unchanged-shard replay
exercise real accepted signed requests and rejected unsigned attempts. The
browser displays immutable history, weaker grades, partial/unknown outcomes,
stale inputs, applications and historical-closure attention. Commands remain
data throughout request, brief, seal and application; a sentinel test verifies
that storing them does not execute them.

An original principal-authored owner approval now survives later fixer
participation by the same principal. This narrow exception does not permit a
fixer correction or reported sorter identity to upgrade eligibility. Dual-sort
and sorter-arbitration receipts remain reported/unverified, and ruling-dependent
sorts remain conservatively held.

The first combined run passed **186/188** checks. The two failures were outdated
P2 expectations for materializer 45 and original-owner eligibility; both were
corrected, with fixer-correction refusal retained as a negative control.
`/tmp/codemap-p3-targeted.log` records that failed run. The following combined
run passed **193/193**, with no failures/cancellations/skips/todo, in 15.059
seconds, `/tmp/codemap-p3-targeted-final.log`. These results preceded the later
independent-review fixes and are not claimed as final validation of those fixes.

Independent review demonstrated two authority defects: repaired-commit-only
inspection could falsely refute an as-filed claim, and omitting evidence ruling
references could bypass an already-held finding. It also identified historical
closure erasure after late participant registration. The authority fixes and
negative controls require new validation. The first full `npm test` invocation
was stopped by its captured process IDs while those fixes were made;
`/tmp/codemap-p3-full.log` is an interrupted run, not a passing full-suite result.

The review fixes are now implemented. Factual refutation requires checking the
immutable full-SHA as-filed witness, rather than the repaired commit; missing,
branch-only and hash-only source provenance cannot grant factual-refutation
authority. Useful witness execution or explicit witness inspection must support
the selected outcome, including arbitration. Existing unanswered, comparison
and withdrawal holds are derived from authoritative decisions for every target,
even when evidence names no ruling IDs. Both legacy finding-id and typed issue
references are covered at request and separate application. Existing later
human assignments may still release ordinary work holds; hard comparison holds
retain their existing gate.

Historical closure uses the act-time participant view. Later participation can
invalidate current receipts, but the canonical historical closure and its
application identity remain visible with attention, even when the orchestrator's
request itself is no longer eligible. Browser negative controls exercise both
late verifier and late orchestrator participation without silently reopening.
The independent review's original scratch counterexamples now refuse authority.

After those fixes, source/web typechecking passes. The combined run passes
**203/203**, with no failures/cancellations/skips/todo, 23.081 seconds,
`/tmp/codemap-p3-reviewed-targeted.log`. It covers protocol/ops/projection/
capability/upgrade/MCP and existing human-ruling cardinality checks. The final
isolated repair browser check passes **1/1**, without skips. The final full
`npm test` run at `/tmp/codemap-p3-full-final.log` completed with **exit code 0**:
**2,134 unit tests passed** in 566.303 seconds and **170 e2e tests passed** in
213.865 seconds. Both phases had zero failures, cancellations, skips and todo.
This is a clean full-suite result for the final reviewed P3 implementation;
the interrupted first invocation remains separately recorded above. Source/web
typechecking and final `git diff --check` also pass.

P3's owner-reviewed eligible-worklist verification/application core is
implemented. Independent sorter/arbitration receipt admission remains
conservatively gated, not silently trusted. Live native production role-to-verdict
measurement, native answer/application-reader verdict recording, synchronous
variants and new Claude measurements remain unfinished. Domain freshness cannot
prove absence of shell repair work. P4 landing/drift/queue integration, P5
operation sign-off and subsequent skill/deployment work remain outstanding.
No dependencies, commits, pushes, live private repository writes or downstream
deployments were introduced. Branch and HEAD remain unchanged; all previous and
new implementation, including untracked files, remains in this workspace.

## Continuation: sorter admission, derived lifecycle and measurement design

Continued from the reviewed P3 tree without committing or changing branches.
Independent bounded sorter/arbitrator admission is now implemented. Native
`claim_repair_sorter` consumes the same fresh-session ledger while restricting
the dispatcher to sort briefs and assessment/arbitration submission. Exact
signed opinions bind source review, proposed sort, original creation identities
and all immutable claim obligations; reported labels retain their unverified
status. Same-model independent sessions remain distinct. Producer registration,
substantive arbitration, participant exclusions and separate verification
remain necessary. Materializer **47** refolds the changed eligibility semantics;
a two-clone `sharedSync` and unchanged-shard version-46 fingerprint test exercise
accepted receipts through the actual projection.

Independent review executed five fold negatives and two cross-process/late-taint
counterexamples. It found that a local callback registry did not see another
producer process's later forbidden activity, and that posted sort eligibility
could remain usable after later taint. Posting now checks the durable ledger
before and inside append; request and application recheck it, and ordinary reads
show the local hold without rewriting historical acts. Four sorter tests retain
these controls. The source guard is local control evidence; no remote taint
transport or hardware attestation is claimed. Admission checks the actual review
scope, but an isolated fold cannot compare the physical bucket path because its
input has no path. Wholesale copied-scope replay remains the documented limit.

P4's derived lifecycle slice adds exact checked commit versus landing, workspace
and default source movement, evidence grade, verifier identities, claims and
attention on repair history. Landing uses exact touched-file equality before
ancestry/fallback, with ancestry cached by resolved default SHA. An earlier PR's
merge cannot land a later repair. Independent review demonstrated a shallow
clone's negative ancestry could incorrectly appear open; it now remains unknown
until sufficient history is available. Seven real-git tests include deepening,
squash, absent commits, no-diff inspection boundaries and untracked reappearance.
Browser checks inspect landed/inspection labels and source drift while preserving
the canonical historical closure. File granularity is deliberately conservative;
opaque source descriptions remain unknown. Broader queue/detail integration,
explicit human acceptance and branch-linked PR fallback remain P4 work.

The dormant `postPrevalidated` producer and reach exemption are removed.
Historical events retain provenance through a replay test and cannot close a
finding through that mark. `import_round` error guidance now names the actual
record-findings-first workflow. This completes the small F14 cleanup portion;
P6 skill integration/deployment remains untouched.

P7 design-only work supplies a versioned JSON schema, measurement protocol and
synthetic extractor. Six tests retain all observed authority-taking attempts,
unique questions versus batches, eligible reruns and evidence grades, and
explicit audited/unaudited closure counts including delayed wrong-close
observations. No downstream cohort or calibration was run and no improvement
claim is made. See [the protocol](decision-measurement-protocol.md).

The live harness probe still exposes diagnostic observations only. This chat
has no production codemap role/repair/reader tools. Its nested calls appear
inside `custom_tool_call exec` output rather than as standalone native MCP
function calls, so the current exact-call correlation assumption remains
unproven for that path. No synthetic metadata run is counted as a live claim.
Native production role-to-verdict, synchronous and new Claude measurements,
application-reader provenance and P5 operation sign-off remain unfinished.

Validation before the final integration run: the F14 cleanup passes **63/63**
outside the sandbox; the initial sandbox CLI test returned empty JSON and is not
a regression verdict. The first combined targeted run caught two source import
cycles and the known sandbox MCP early exit. The cycles were removed through
pure sort types and projection reads; no guard was relaxed. Integrated targeted
checks then passed **81/81**, no failures/cancellations/skips/todo, 9.509 seconds,
`/tmp/codemap-continuation-targeted-final.log`. That result predates the final
late-taint and shallow-history fixes. The repair browser check passed **1/1**,
4.648 seconds, `/tmp/codemap-continuation-browser.log`. Review-fixture validation
initially failed because a forged sort had already created a competing head
(making the later-taint refusal vacuous), and a source-import replacement leaked
into the subprocess script. Both fixtures were corrected; the final sorter
suite passes **4/4** outside the sandbox, and lifecycle passes **7/7**. Source/web
typechecking and all three import-cycle checks pass after the authority fixes.
The full integration result follows below when the run completes.

Final integration validation: `/tmp/codemap-continuation-full.log` completed with
**exit code 0**. `npm test` passed **2,154 unit tests** in 1,087.502 seconds and
**170 e2e tests** in 206.015 seconds. Both phases had zero failures,
cancellations, skips and todo. Source compilation and web typechecking passed,
as did the import-cycle and browser template checks. The repair lifecycle page
check passed in this final integration snapshot. Final `git diff --check` passes.

All changes remain uncommitted on `codex/remaining-decision-work`, at unchanged
HEAD `582780cfac89f1be9fa4e8e910f0ef5f5a99eb81`. Earlier modified and untracked
files are retained. No dependency, commit, push, deployment, installed skill
change, live downstream write, downstream measurement or calibration was made.
This completes the sorter-admission slice, P4 repair-history lifecycle slice,
F14 cleanup and P7 measurement design; it does not claim completion of the
remaining live harness/application-reader, wider P4, P5 or P6 work described
above.

## Owner-requested checkpoint

The owner subsequently requested committing the complete working tree. This
checkpoint includes P0–P3 implementation, independent sorter admission, the P4
repair-history lifecycle slice, F14 cleanup, P7 measurement design, their tests
and execution records. The final full-suite validation above applies to this
checkpoint. No push, merge or deployment is part of this request. Remaining work
is unchanged: live harness/application-reader validation, wider P4 lifecycle and
queue integration, P5 verified operation sign-off, and P6 skill integration,
continuity checks and deployment.

## Continued implementation after checkpoint 4920853

The user authorized continued implementation and subagents. The finalized plan
is unchanged. P4 now integrates review-qualified lifecycle information into
working queue, search, canonical finding detail and decision-round detail, with
shared browser presentation. Canonical closed states leave the active queue;
search and explicit history retain closure evidence and source-drift attention.
A reopened finding's current state is shown independently of its historical
applications. Legacy review keys that cannot identify a repair scope retain
their ordinary finding read and report repair history unavailable.

Branch-linked PR fallback now requires checked-commit ancestry to the PR head,
unchanged relevant source at that head, and merge-commit ancestry to the resolved
default tip. Merged status, older branch merges and stacked merges outside that
line cannot establish landing. Eight real-git lifecycle tests pass.

Explicit human acceptance uses the existing verified ruling application, a
version-2 capsule, canonical `accepted`, and distinct human/executor attribution.
Adoption is authorized work, not acceptance; postponement stays dated backlog.
The independent reviewer executed folds and found malformed nested contexts
could crash, conflicting selected dispositions could close, and the credited
principal was not bound to the hashed reader context. All three were corrected;
negative fold controls retain those counterexamples. Thirteen pure ruling
application checks and four application matrix checks pass. A combined backend
run passed 189/189 in 8.394 seconds, no failures/cancellations/skips/todo,
`/tmp/codemap-p4-acceptance-final.log` (before the final independent fold controls).

A real two-clone oracle suite passed 3/3. It includes another principal's agent
applying the human acceptance, matching remote projections, queue exit,
unchanged-shard version-47 upgrade replay, later withdrawal preserving closure,
and reopening followed by a refused duplicate ruling. Materializer 48 covers
acceptance semantics; 49 is reserved for the new P5 event in this continuation.

The P4 browser check passes 1/1 outside the sandbox. The first browser invocation
failed at sandbox listen permission; the first actual browser check then exposed
a cached finding missing its review identifier, which was corrected. Targeted
finding read/search/deletion/unification checks pass 29/29 outside the sandbox;
they exposed legacy review-key incompatibility, now shown as unavailable repair
history. Earlier in-flight typechecks found unfinished worker type annotations
and root's test-fixture edit mistakes; those were corrected. One initial
acceptance test tried to switch cached git identity and failed its Bob-executor
assertion; the test now uses a restored, process-local principal override. None
of these failed runs is counted as a passing integration result.

Production harness tools are still absent from this chat's callable surface;
only the diagnostic identity probe is available. No probe launch, native
role-to-verdict certification, new Claude measurement, synchronous-answer
measurement or downstream cohort run was performed. P5 and P6 progress and final
integration validation follow below after their work is reviewed.

### P5 exact operation sign-off

P5 adds an exact operation/framing presentation with an explicit plan-only
choice; all operative instructions are in the actual question. Native payloads
carry labels without hidden descriptions, no fabricated header, and a decision
reference (default D1). A separate independent application reader verifies the
human answer, then application pulls and rechecks the current draft, text,
framing and answer authority. Sign-off credits the answerer while retaining the
agent executor and source universe/scope/provenance. Framing, siblings and
ratification stay unsigned. The standard view exposes that receipt provenance.

Independent review ran a fabricated capsule through the fold and demonstrated
that the original authority snapshot could mint a human proposal witness. The
new path now uses registered local Ed25519 producer seals over the exact act;
unsigned stamps, body/identity/reader/executor mutations, unregistered keys,
producer takeover and source-scope mismatch refuse. Replay enforces the same
exact-content and producer rules as admission. Private keys remain local control
data. The trust boundary remains the existing local producer/sidecar model,
not hostile-log or hardware attestation. Materializer 49 refolds the two new law
events: `spec.operation-signoff-producer` and `spec.operation-signoff-applied`.

Final targeted validation passes 14/14, no failures/cancellations/skips/todo,
25.256 seconds, `/tmp/codemap-p5-final-targeted.log`; independent authority/ops
rerun passes 2/2 and 5/5. The browser provenance check passes 1/1 outside the
sandbox in 1.264 seconds, `/tmp/codemap-p5-browser-external.log`. That browser
fixture seeds the read-view contract, rather than claiming native issuance;
backend ops and two-clone replay establish issuance. Source/web typechecking
and import-cycle checks pass. Earlier iterations exposed a missing decision
reference, normalized multiSelect mismatch, an incomplete withdrawal fixture,
an inline schema type import cycle and sandbox browser bind EPERM; these failed
runs were corrected or rerun outside the sandbox, not counted as passes.

Native Codex application-reader receipts remain unsupported. Existing verified
native human sources may be consumed, but synthetic metadata or missing native
reader evidence cannot grant sign-off. No new live Claude/harness measurement
or account-to-git principal mapping is claimed. See operation-signoff.md.

### P6 source integration, deployment pending

Both source skills now read a shared capability/provenance workflow, retain
canonical IDs and exact questions, reconcile pending shared acts on resume,
use independently admitted sorting/repair and human application paths, and
preserve honest markdown-only operation when capabilities are absent. Model
choices use the user's selection or configured default. The Python stdlib run
resolver preserves common-git-dir, absolute RECORD, repository identity and
independent skill-specific overrides; versioned Artifact routing preserves its
separate exception rather than requiring git.

Complete source/installed comparisons preserved the installed baselines and
selected intentional differences, including client-neutral Artifact wording.
The older embedded triage planning route is not restored over the current
source handoff to ez-plan. A required independent whole-shipped-artifact
semantic sweep found native sorting tried to use a domain-used parent,
Artifact routing invoked git too early, and diagnosis questions leaked review
framing. These were corrected and the recheck is clean. Independent synthetic
forward artifacts cover Discuss First, partial answers, acknowledgments,
pending-ID resume, absent premises, exact pending operation text and worktree
identity. They are simulations, not production role/reader measurements;
the outside-git Artifact capability could not be exercised live.

The full staged skill suite passed 96/96. Applied source validation also passes
96/96 in 2.898 seconds at `/tmp/codemap-p6-source-final.log`; pre-existing
ResourceWarnings about unclosed reads in test_declared_records remain visible.
The exact Codex quick validator rejects the pre-existing Claude argument-hint
frontmatter in both original and updated skills. That compatibility field was
preserved; copies omitting only that field validate. No exact-file quick-validator
success is claimed.

Automatic approval review initially rejected source application, treating
/working/skills as a prohibited live repository. No write occurred. The retry
supplied the finalized plan's explicit /working/skills source authorization,
the current implementation authorization and the private-live-repository
constraint's actual scope. It was approved. The 24 reviewed hash-checked source
files were applied on a new codex/remaining-decision-work branch from the current
clean source HEAD 9755a20 (newer than the plan's source baseline, preserved).
Source changes were committed as c1a3209. No live private downstream repository was
written. Both installed skill trees still exactly match their initial manifests.
Installation is a separate deployment and was not authorized or performed.

Durable comparison/forward artifacts are in docs/skill-integration-evaluation/;
docs/skill-integration-manifest.json records complete intended source and current
installed hashes. Source commit c1a3209 is recorded; no shipped installation is claimed. The
final codemap integration run is in progress at
/tmp/codemap-remaining-final-full.log; its result is recorded below when complete.

The benign Claude Code 2.1.283 launch check stalled with empty output inside the
sandbox and was interrupted (exit 130). A customization-disabled, tool-free,
nonpersistent outside-sandbox retry completed successfully in 1.295 seconds.
This proves launch availability only; it did not exercise a reader receipt or
human-answer path. The sanitized result is retained in
docs/skill-integration-evaluation/claude-launch-probe.json.

A subsequent live Claude Code 2.1.283 diagnostic measured two fresh Agent
children with the configured default model, restricted built-in tools and an
explicit diagnostic-only MCP server. `readReader` accepted both actual
parent/child/call records. The second run matched the exact launch prompt, host
claudecode/toolUseId to the native child call, and returned receipt to the native
paired result. Production verdict discovery returned zero, correctly: this
probe returned diagnostic:true and authority:false, not a production held
receipt. This advances new Claude discovery evidence but does not complete
production repair/application/signoff admission or synchronous human response
measurement. Sanitized artifacts and limitations are recorded in
docs/harness-provenance.md and skill-integration-evaluation/claude-reader-probe-*.json.
Neither run accessed a codemap store or private downstream repository.

### Final integration result and remaining work

The final outside-sandbox `npm test` exited 0: **2,167 unit tests and 171 e2e
tests passed, zero failures, cancellations or skips**. Unit duration was
817.944 seconds; e2e duration was 208.496 seconds. Both targets compiled the
backend and typechecked the browser source. This included real folds, two-clone
acceptance/sign-off scenarios, negative authority admission, lifecycle git
scenarios and relevant browser flows. Log: /tmp/codemap-remaining-final-full.log.
The 365-file source freeze still matches the files used for this run; no product
or test edits occurred after compilation. `git diff --check` is clean. The
skills source suite passed 96/96; source commit c1a3209 is clean. Installed
triage-review and ez-plan still match their complete original manifests.

P4 integration, explicit human acceptance and branch-linked PR fallback are
implemented and independently reviewed. P5 operation sign-off is implemented
and independently reviewed, including portable producer admission and refusal
controls; live purpose-specific production receipt validation remains unmeasured.
P6 source integration, complete comparisons and independent forward/semantic
review are complete; installed deployment awaits separate authorization.
P1/P3 production native role-to-verdict and application-reader receipt paths
and synchronous human-answer variants remain unproven; the new live Claude
diagnostic advances discovery evidence without granting production authority.
P7 downstream measurements remain intentionally deferred. No new owner policy
decision was introduced, and the finalized plan is unchanged.

No changes were pushed, merged or deployed. No live private /working repository
was written. Historical closures remain canonical; current drift, blocked or
unknown proof raises attention without automatic reopening.

Local staging initially failed because the sandbox exposes .git read-only; the
outside-sandbox retry succeeded. The staged whitespace check then flagged
unified-diff context lines in the retained comparison artifacts. These are
encoded losslessly as JSON line arrays, rather than changing their comparison
content; joining `lines` recovers each exact diff. The final staged check is clean.

## Authorized skill installation: absent-codemap check (2026-09-26)

The owner approved installation, contingent on checking that the codemap
integration is inert when codemap is absent. Independent review found no
executable codemap import, launch or provisioning path: the four shipped Python
helpers use stdlib and their subprocesses launch only git. A forward evaluation
selected markdown-only, non-verified mode, exercised both record resolvers and
cross-skill resume, and produced no codemap calls, .codemap or sidecar. This was
a bounded entry/routing evaluation, not a complete dual-sort or human-answer run.

Review identified applicability ambiguities in resume, native-capability stop
conditions and repair closure. Seven files now state that native operations and
outages apply only to shared runs; discovery may not bootstrap codemap; ordinary
markdown landing/handover remains available. Ordinary independent participants
are still required. The independent recheck found no remaining contradiction or
ordering change. Source commit bf8c248 records these clarifications. All 96
skill tests passed in 2.786 seconds, with the existing unclosed-read
ResourceWarnings still visible. No backend/browser code changed, so the passing
2,167 unit and 171 e2e integration result remains applicable.

Installed triage-review (25 files) and ez-plan (10 files) exactly match source
commit bf8c248. The installer checked the complete existing baselines before
replacement, retained the previous trees at
a local backup directory and verified every installed
file hash. Post-install new/resume smoke checks for both helpers passed with a
PATH containing git only, no codemap executable/database/sidecar and no .codemap
creation. No provisioning, server start or account configuration occurred.

Evidence: skill-integration-evaluation/absent-codemap-forward.json,
installed-absent-codemap-smoke.json and deployment.json. The updated manifest
retains original baseline hashes and records exact deployed source hashes.
P6 skill installation is complete. Production native/verdict and synchronous
human-answer measurements remain outstanding; installation does not certify
those capabilities. Nothing was pushed or merged; no private live repository
was written.
