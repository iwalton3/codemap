# Harness provenance: measured support

Measured on 2026-09-26 in Codex Desktop `0.158.0-alpha.2.1`. This is a
version-specific local transcript adapter, not a claim that every Codex client
or future rollout format has the same provenance. Fixtures use synthetic
identities; private rollout files and account identifiers are not copied here.

## CLI continuation profile (2026-09-27)

Roles and held application-reader submissions have a separate CLI contract. It pins
client/child `0.157.1`, the historical parent `0.158.0-alpha.2.1`, direct
`fork_turns:none` launches and MCP server name
`codemap_native_production_measurement`. It does not admit an ordinary all-CLI
parent/child pair, arbitrary aliases or other versions. Historical Desktop
labels in rollout headers do not identify the owner's current frontend.
Human-question parsing retains its existing contract.

Active host thread, session, parent and turn metadata must agree with the unique
initial child task and launch. The measured child kind is `thread_spawn`.
An earlier implementation assumed `agent`; two actual sorter calls and a fresh
probe refused without issuing roles. Literal capture and the original claim's
digest established the correction; `agent` now has a negative control. Completed
MCP items must follow startup and the initial task, with a consistent execution
interval. Known followups, inherited history, duplicate or parent-owned calls,
torn records, different tools/servers and changed arguments/results refuse.

For roles, the dispatcher retains the actual completed request arguments and
result for replay at later calls; native `McpToolCall` IDs bind host `callId`.
Outer exec IDs never substitute. Existing durable freshness/participation
ledgers and independence checks remain in force.

For the two purpose-specific reader submissions, the dispatcher mints an opaque
in-process capability from its actual initialized client and host request. Only
that capability can store immutable machine-local `native_host` metadata beside
a held receipt. Recording and application re-read the exact native successful
submission/result and exact issued launch prompt. Native reader identity uses
the child's thread, so independent siblings remain distinct. Unbound receipts
and serialized capability lookalikes do not gain this path. The nullable local
column upgrades with the existing backup mechanism; no shared event vocabulary
or materializer meaning changed. Cleartext exact-brief admission and its negative
controls pass hermetic fixtures; current live reader recording remains unsupported.

The native `agent_message` task token must match the parent's launch token
exactly. Current live reader records put ciphertext in both the launch message
and `encrypted_content`; neither equals the issued plaintext brief. Actual reader
submissions held receipts, but recording refused, so no native P3/P5 application
occurred. The accepted opaque-initial-task risk for role admission does not waive
the purpose-specific exact-brief check. A trusted delivery binding from native
launch/token to issued request, or verified decryption, is still needed.
Host/native result-object serialization is correlated; complete JSON-RPC
response-line bytes are not attested. Local git principals are not a proven
mapping from native account identity. The production measurements and remaining
limits are recorded in `remaining-decision-work-execution.md`.

## Native delayed question answers

The measured top-level rollout has a `session_meta` header naming the session,
creator user, Desktop origin, `vscode` source and `user` thread source. The
question is a `response_item/function_call` named `request_user_input_async`,
with a call ID and readable JSON question titles and optional string choices.
Its paired output is exactly `{accepted:true}`. That output acknowledges display;
it contains no answer.

The answer arrives later as a user-message record. Its
`send_user_message_question_reply` envelope contains a JSON list: each
`questionItemId` encodes the tool name, call ID and question index, alongside
the exact shown question text and the person's answer. The record has a message
ID, turn ID, creation time and `content_item_kinds: ["user.text"]`; a matching
turn-start event precedes it. Injected instructions can also have `role: user`,
so role alone is not enough.

`src/codex-transcript.ts` checks these measured relationships and times, the
supported header/version, successful display, exact question text and unique
answer indices. It reads only the selected local session, or discovers a unique
supported session holding the call. It rejects torn JSONL, ambiguous sources,
unsupported formats, injected-message markers and acknowledgment-only records.
Partial replies remain partial. Multiple reply messages require an exact
`entryId`; a correction never overwrites the earlier source receipt.

The receipt retains harness/version, source message, turn and creator-user IDs.
The creator-user ID is source identity, not a proven mapping to the repository's
git principal. Recorder attribution remains separate. Local rollout provenance
is not a cryptographic attestation and does not defend against a user rewriting
their own transcript files.

Call `log_question` with `harness: "codex"`, the native call ID as `toolUseId`,
and optionally the exact session and reply `entryId`. Posted payloads must match
native titles and choice strings; do not add a Claude-style header or choice
descriptions that the native tool did not display. The server resolves the
directory from `CODEMAP_CODEX_TRANSCRIPT_DIR` or `~/.codex/sessions`.
Unsupported sources return an unverified reason and point to the existing web
questionnaire. An unknown receipt version cannot downgrade to legacy authority.

## Reader and verifier boundary

A benign child launch and follow-up were measured with no inherited turns.
The child header names its parent, depth and agent path. The parent records
`fork_turns: "none"`, but the launch prompt in the measured rollout is encrypted;
the child does not expose a plaintext initial brief that this adapter can check.
These records therefore do not establish exactly what a reader saw. The owner
explicitly accepted that opaque-prompt risk on 2026-09-26: exact initial prompt
visibility is no longer a blocker. An encrypted brief might contain fixer
conclusions or another verifier's result; the role gate cannot detect that. This
acceptance does not make inherited history or known follow-up contamination safe.

`src/verifier-boundary.ts` now defines a separate repair-verifier identity key:
principal, harness, session and optional child. Model metadata does not determine
identity, so two same-model sessions remain distinct and a session's revised
opinion retains its key across reconnections. Legacy actor and review keys are
unchanged. The boundary generates its own connection UUID separately from that
identity. A trusted adapter must supply the measured session/connection binding;
no tool argument or environment variable enables it.

`claim_verifier` is admitted before any domain read or write, including unknown
or malformed tool attempts. Initialization, capability listing, ping and the
server's initialization maintenance do not count. After a supported claim, an
explicit allowlist admits only repair brief/evidence/verification/arbitration
operations; those producers belong to later slices and are not exposed yet.
Forbidden attempts invalidate that boundary's subsequent receipt checks.
Fixer and relayer identities are excluded at claim, submission and replay,
including reconnections and changed model labels.

The receipt registry binds exact content and request to the actual claimed
identity, role and generated connection. Replay compares the issued receipt and
rechecks role eligibility against current participants. This registry is local
and in-process: it is neither a cryptographic attestation nor a durable shared
verification record. Persisted evidence, folding and application remain later
plan work; registry receipts cannot close findings.

### Live MCP connection measurement after app restart

On 2026-09-26 the owner configured a separate diagnostic STDIO MCP server and
restarted Codex Desktop. The probe became callable through the real MCP tool
surface. It touched no codemap store and granted no verifier authority. Parent
and two children launched with `fork_turns: "none"` made five calls: one parent
call and two sequential calls per child. All used Desktop client
`codex-mcp-client`, version `0.158.0-alpha.2.1`.

| Caller | Server-generated connection | Call numbers | Request thread | Request session |
|---|---|---|---|---|
| Parent | P | 1 | Parent thread | Parent thread |
| Fresh child A | A, distinct from P/B | 1, 2 | Child A thread | Parent thread |
| Fresh child B | B, distinct from P/A | 1, 2 | Child B thread | Parent thread |

Each connection had its own server process and initialization. Both forwarded
environment fields (`CODEX_THREAD_ID`, `CODEX_SESSION_ID`) were absent in those
server processes. Identity arrived on `tools/call` request `params._meta` instead:
`threadId` names the actual caller thread; `sessionId` names the parent session.
The same object also had `callId`, `x-codex-turn-metadata`, `windowId`, `itemId`
and `progressToken`; only key/type shapes were retained for these other fields.
Do not key child independence on `sessionId`: both children share it.

The probe retained SHA-256 digests rather than raw identity values. Hashing the
three rollout-header IDs reproduced the three request thread digests. Both child
headers name this parent, depth 1 and the corresponding probe agent path. A
parent shell thread-ID digest also matched the parent request metadata. Repeated
child calls retained both thread identity and connection identity.

This supplies the previously missing live connection observation for this build:
two fresh same-model children have separate STDIO connections and request caller
identities that agree with their native headers. It does not prove a guarantee
for every client, reconnect, shared connector or future version. The probe did
not inspect nested turn metadata or pair exact call-ID bytes with transcript
records. Those checks, contamination controls and server-side consumption of the
observed metadata still need implementation and regression fixtures.

### Adapter and admission now implemented

`src/codex-verifier-context.ts` consumes host `params._meta`, not tool arguments.
Role support is pinned to the measured client/version. Only measured direct children of a
top-level user session are supported; deeper nested launches remain unsupported. It binds request
`threadId` to child header `id`, and request `sessionId` to the child header's
`session_id` and parent header `id`. These are different fields: a child header's
`session_id` names the parent, not the child. Parent/child creator-user values
must agree; the repository principal is resolved locally and separately, not
inferred from an account identifier.

The adapter requires one parent launch explicitly using `fork_turns: "none"`,
one successful matching output, the child header within that launch interval,
and one initial child task/input with a matching turn identity. Inherited
history markers, additional child user input/task turns, recorded follow-ups,
send-message or interruption calls, duplicate/missing/torn records, unknown
versions and missing metadata refuse. The initial brief may remain opaque under
the owner's accepted risk. The current request need not already be flushed to
the transcript before its response; collisions with recorded parent calls or
duplicate recorded child call IDs refuse. Exact native verdict call/result
recording remains unimplemented and is not claimed by this role adapter.

`claim_verifier` now succeeds when that context passes, before any codemap domain
attempt. It returns the actual identity, server connection ID and role limits.
Each later claimed-role request rechecks its own metadata and native provenance;
receipt checks reread provenance using immutable bound metadata. Identity loss,
identity changes, known contamination or forbidden actions invalidate the
boundary. Admission is synchronous before handlers await, while handlers remain
concurrent so status waits do not block calls that could wake them. Admission
storage failures return explicit RPC errors rather than leaving calls hanging.

The local `verifier_session_activity` table atomically permits one role claim per
identity. Prior domain use includes reads and refused/malformed attempts. A
reconnect cannot claim again or resume ordinary domain actions after a claim;
trying the latter taints the durable claim. Restrictive identity lookup remains
active across client-version changes, but granting authority still requires the
pinned version. The principal is bound once from the workspace's primary repo.
This is local control history, not a shared event or a folded projection, and
store migration backs it up without a materializer bump.

This establishes codemap-domain freshness, not an absence of shell repair work.
P2 now records fixer/relayer participation from native host request metadata
through opaque process capabilities and a durable shared act. The producer is
pinned to the measured Desktop version; caller identity fields cannot substitute
for it. The production participant callback reads the SQLite projections across
the workspace and refuses blocked participant provenance. Participation must be
recorded and synced to be known on another clone; this does not prove absence of
unregistered shell repair work. See [the repair record contract](repair-records.md).
The role claim cannot
close a finding, submit a legacy human-application verdict or apply a repair.
In-process receipts remain non-portable; durable verification is later work.

The adapter was exercised read-only against both real probe rollouts using
synthetic request metadata and accepted both after correcting the child
`session_id` assumption. A subsequent benign follow-up to probe child A produced
a NEW connection with the SAME child/request thread identity. A read-only parser
recheck then refused A for additional user input/task turns while clean child B
still passed. This directly shows why a fresh connection alone is insufficient
and the local session ledger must survive it. That is a parser diagnostic, not an end-to-end live
production role claim. Real dispatcher tests use isolated repositories and
sanitized synthetic native records; no production store or downstream repository
was used. During discovery one inspection included account identifiers in tool
output; subsequent inspection was sanitized and no identifiers were copied into
fixtures or this document.

Synchronous question responses, arbitrary human text and other Codex clients
are not normalized by this adapter. Existing Claude question/reader behavior is
retained and regression-tested; no new live Claude measurement was performed
in this slice. These are remaining P1 work, not passing capability checks.

### Continued-session diagnostic and remaining live blockers

On 2026-09-26 a continued-session child called the installed identity probe
through `functions.exec`. Its real MCP request again reported client version
`0.158.0-alpha.2.1`, absent forwarded thread/session environment variables,
and distinct hashed caller-thread and parent-session identities. A sanitized
read of the matching native header reproduced both digests and confirmed a
direct depth-1 child. No account identifiers or raw session IDs were emitted.
The observation explicitly returned `authority: false` and touched no store.

The native record for this call is a `custom_tool_call` named `exec`, paired
with a `custom_tool_call_output` containing the probe observation. It is not a
standalone `function_call` naming the nested MCP tool. The probe retains only
the type of host `callId`, so this observation cannot establish exact nested
MCP call-ID/transcript correlation. The current child also has two recorded
task-start events; a separate connection does not restore role freshness.

Only the diagnostic probe is installed in this continued session's tool
surface: production `claim_verifier`, repair brief/submission, and answer or
application-reader submission tools are absent. A shell-driven dispatcher
with hand-built request metadata would test the dispatcher but would not be a
live host provenance measurement. The next useful experiment is a separate
diagnostic installation of the current production dispatcher against an
isolated scratch repository, followed by fresh direct children with no
inherited turns. Capture the host request's call-ID digest and the native
record format for each claim, bounded brief and submission, then run negative
controls for follow-up contamination, reconnect and forbidden domain calls.
Keep the production store and live private universes out of that experiment.

No synchronous human-question tool is available in Default mode here, and no
new live Claude launch or human response was measured. Those capability gaps
remain explicit; the existing delayed-answer and synthetic regression results
do not certify them.

The official [app-server documentation](https://learn.chatgpt.com/docs/app-server)
also distinguishes request resolution/cleanup from an answer and describes
automatic resolution. Those protocol descriptions inform negative controls;
they are not evidence that the local rollout proves a blind reader or a human
answer on every path.

## Checks actually run

For the native role-adapter slice, source/web typechecking and 109 targeted
backend checks pass, including all three cycle checks after extracting shared
harness constants. The broad unit run passed 2,062 tests with its sole failure
being that now-fixed cycle; it was not wholly rerun after the fix. All 168 e2e
checks pass. Exact logs and limitations are in
[the execution record](remaining-decision-work-execution.md). The measurements
above are diagnostic observations, not a live product role claim or verdict.


Synthetic parser negatives, real posting/logging operations, MCP schema and
transport checks, two-clone `sharedSync`, unchanged-shard upgrade replay, and
existing Claude/ruling regressions passed: **92 tests, no failures or skips**.
The decisions browser suite passed **10 tests, no failures or skips**, including
native source details in answer history. Source and web typechecking passed.
Reading the benign live delayed reply returned `Probe answer` with a Codex
receipt. It was not used as a product ruling or stored in a product sidecar.

## Claude Code fresh-reader diagnostic (2026-09-26)

Two live, restricted Claude Code 2.1.283 runs used the configured default model,
only the built-in Agent tool and one explicit diagnostic STDIO MCP server. Each
parent launched one fresh probe-reader. Each child recorded twelve own-sidechain
rows, a non-fork metadata record, one diagnostic submit and one paired result.
The existing `readReader` validator accepted both actual launch/call records.
The second run also checked the exact parent brief. Its host-provided
`claudecode/toolUseId` matched the child's native tool-use ID, and the returned
diagnostic receipt matched the paired native result. The two runs had different
session and child identities. Sanitized structure and identity digests are
retained in `skill-integration-evaluation/claude-reader-probe-{first,second}.json`;
private transcripts and raw identities are not copied.

This checks the current Claude fresh-child transcript seam and diagnostic native
call correlation. It does not certify a production repair role, production
application/sign-off verdict or synchronous human answer. The probe returned
`diagnostic: true, authority: false`, and production verdict discovery correctly
returned no calls. Purpose-specific production receipt admission remains to be
measured with the actual tools and current brief. No codemap store was accessed.

A preliminary tool-free safe-mode launch stalled with no output inside the
sandbox and was interrupted. Its bounded outside-sandbox retry succeeded; that
launch alone established only executable availability.

## Continued production discovery (2026-09-26, checkpoint 55a177a)

After the authorized scratch MCP installation, the owner continued in Codex CLI
because Desktop was crashing. The current actual MCP client and child header
are 0.157.1; the parent's source/header remain historical Desktop/vscode
0.158.0-alpha.2.1. Those labels do not establish the active frontend. A fresh
real production claim correctly refused the unsupported version, granting no
role. The new native event_msg/item_completed/McpToolCall record matches the
nested host callId through item.id, with exact arguments and serialized result
digest. The outer exec call_id is different. This is measured CLI correlation
of a refusal, not Desktop compatibility, complete RPC-byte attestation or
reader authority. See native-production-cli-refusal-2026-09-27.json in the
evaluation directory and the latest execution-record section. Admission stays
pinned while diagnostic format support is added separately.

`src/codex-mcp-observation.ts` now extracts this version-specific completed-call
correlation without granting authority. Its 26 adversarial tests and actual CLI
refusal observation pass; independent review confirms no production references.
Every return explicitly states diagnostic:true and authority:false. It checks
exact identity/tool/argument/result shape and rejects ambiguity/torn input; it
does not establish reader freshness, an active frontend or full RPC-line bytes.

Rechecked on 2026-09-27: the actual Desktop probe still reports
0.158.0-alpha.2.1; CLI is still 0.156.1. Only the diagnostic probe is callable,
and its callId observation still contains a type rather than exact identity.
Independent investigation found no basis for admitting native reader receipts.
A scratch-only bridge to the unchanged production dispatcher is prepared under
/tmp/codemap-native-production-2026-09-27/, with digest capture for host metadata,
arguments and paired response lines. Direct-versus-bridge transport and process
lifecycle checks passed outside the sandbox; a sandbox smoke timed out. The
prepared MCP entry has not been installed. These checks grant no native authority
and do not establish host/native correlation. See
skill-integration-evaluation/production-capabilities-2026-09-27.json and the
latest execution-record section for failures, repairs and remaining limits.

The continued Desktop chat still exposes only
`mcp__codemap_identity_probe__observe_connection`. Production role claims,
repair verification and application-reader submissions are absent. The installed
shell Codex CLI is 0.156.1; invoking it with temporary MCP configuration would
not validate the adapter pinned to Desktop 0.158.0-alpha.2.1 and a native
`vscode` parent. No client/version check was relaxed and no persistent MCP
configuration or diagnostic server was changed.

Native nested `functions.exec` source can be plaintext JavaScript. That does
not establish the identity of a nested MCP request: its outer
`custom_tool_call` ID is not measured as the host's nested `callId`. The existing
diagnostic retains only that metadata field's type. Even an outer output
containing a real held receipt cannot establish the exact purpose-specific
submission. Native application readers therefore remain unsupported; this is
an exact-correlation gap, not a blanket claim that exec source is encrypted.

The synchronous question tool remains unavailable in Default mode. A displayed
async questionnaire is only pending until the actual later human reply passes
the existing adapter. Neither elapsed time nor `{accepted:true}` grants
authority. Current capability evidence is retained in
`skill-integration-evaluation/production-capabilities-2026-09-26.json`.

A fresh live Claude Code 2.1.283 child also reached the actual production
`submit_application_verdict` and `submit_operation_signoff_verdict` handlers
against an isolated two-clone fixture. Missing request IDs refused for missing
briefs; neither issued a receipt. For both calls, the host tool-use ID digest
matched the child's native call and the production error matched its paired
result. `readReader` accepted the actual launch/call records. The bridge filtered
inventory only, leaving handlers and responses intact. Sanitized evidence is
`skill-integration-evaluation/claude-production-refusal-2026-09-26.json`.
This establishes production refusal/correlation, not successful production
receipt issuance, human authority, application or native repair-role admission.
The owner subsequently answered both scratch choices in ordinary chat. That
genuine human reply lacks the linked question-item envelope required by the
native adapter; both original calls still read pending. Text consent is not
converted into a native receipt. The persistent web questionnaire provides the
supported fallback for a separately attributable human submission.

On 2026-09-27 the owner used that browser fallback. Current verified questionnaire
answers then supported two real fresh Claude readers with exact purpose-specific
briefs, production held receipts and successful application. Both scratch clones
converged on the operation witness and refuted finding. See
`skill-integration-evaluation/claude-production-success-2026-09-27.json`.
This validates the existing Claude human-ruling application and exact-operation
sign-off paths. It does not certify native Codex readers, synchronous answers,
native account-to-git-principal mapping or Codex-only repair-verifier closure.

## Preferred human-question delivery (2026-09-28)

The owner chose Codemap web UI popup questionnaires for further decision work
and deferred additional native Codex binding investigation. Publish the actual
operative questions as a frozen questionnaire and retain the publication ID.
Only an explicit browser submission creates an answer; showing or dismissing a
popup, saving a draft or receiving ordinary chat consent does not. Existing
native refusal boundaries and pending native receipts retain their meaning.
The web answer source does not itself authenticate an independent reader or
prove that an operation or repair has been applied.
