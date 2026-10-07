# Codemap workflow

Read this reference at entry for either skill, then keep its capability/record choices with the run.
These rules govern durable authority, where questions go and repair closure wherever a step
says to save an answer or land a fix.

## Capability and the run

Check actual callable codemap tools, an accessible codemap database and a configured, resolvable
sidecar before choosing shared mode. A tool definition in source or a working CLI is not proof this
session can call the tools.
Discovery is read-only: inspect registered capabilities and existing paths; do not initialize a
database, create a sidecar, install codemap or start a server to obtain missing capability. Record per capability `available`, `unavailable` or
`unmeasured` with its observed reason. Discover on each run; never promote a diagnostic observation into authority.

When codemap is absent, run the existing markdown workflow with explicit `markdown-only,
non-verified` status. Ordinary markdown sorting/diagnosis and already-authorized repairs may continue with the required
ordinary independent participants.
Codemap steps below apply only in shared mode. Markdown-only runs do not call them;
missing codemap capabilities do not trigger launch outages or block ordinary workflow/handover.
Keep exact questions, answers and evidence; do not call those notes shared
rulings, independently verified closure or operation sign-off. If a shared operation becomes
unavailable mid-run, retain its durable IDs, pending request and reason; resume that operation after
reconciliation instead of republishing it or replacing shared authority with markdown. Historical
markdown can be evidence to read, never imported as a trusted human answer.

For the existing versioned Artifact route, when its real artifact read/version capability is
available, keep the established non-git RECORD/report placement outside the temporary replay.
Do not invoke the git record resolver for an outside-git artifact run. Retain its artifact URL/ID,
version identity and absolute RECORD separately; refuse a different artifact on resume. An ordinary
non-git document or session transcript does not acquire that exception.

For git runs, resolve absolute `RECORD` once from the primary's `git rev-parse --git-common-dir`, relative to that
repository root, using `scripts/run_record.py`. Use `triage/<date>-<slug>` or `plan/<date>-<slug>`
unless an in-scope instruction names an explicit destination for that skill. Pass that override
as `--record`; it does not move the other skill's store. Save primary/common repository identity
with the run and reuse the absolute path on resume. A linked worktree of the same repository may
resume; a different repository with the same basename/slug may not. Preserve K2 committed/ignored
behavior. Keep codemap universe, review, finding/claim, sort, evidence, round/question/answer,
request/verdict/application and operation IDs in `RECORD/codemap.md`; do not rediscover them by
labels. A failed/partial write records what actually succeeded and where to resume.

Every independent participant starts with no inherited history, on the model `shared.md` A names
(X1 for an ordinary participant under Codex; never a verifier, below); a model label is not
independence. Never relay one verifier's conclusion to another. Only grants verify a repair: a fresh
session the person starts with the `codemap-verify` skill, or a subagent launched with exactly the
prompt `repair_brief` returns. The session that asks for verification never fills a slot of its own
request.

**Every transcript-verified act is Claude Code only.** codemap checks a verifier's launch, a sort's
/triage-review run, a logged question and a reader's verdict against Claude Code's own transcripts,
which a Codex run does not leave in a form it can read. So a Codex subagent never posts a sort,
records a verifier, logs a question or withdraws one: the Claude Code session that launched it does.
A Codex verifier does not count: a verifier is a session the person starts with `/codemap-verify`, or
the item stays pending and the report says so. Codex never puts a question to the owner. A Codex
host is not supported for these acts.

## Findings and sort

Before posting a shared round, record each missing canonical finding in the correct universe and
review with the ordinary finding operations, publish local-only findings, and retain its ID beside
its F-number in `findings.md`. Re-read IDs rather than recreating records after retries/sync. Keep
as-filed text immutable; `record_repair_claims` may decompose it without deleting the original or
any claim. A partial fix cannot erase the other claims.

Use the existing category definitions and owner authority. Preserve the informed first/blind second
arrangement: the blind second starts before blame and receives only the raw findings, permitted
purpose and artifact, never the first reading. Post the skill's own sort with the round through
`post_repair_sort`: `dual-sorted`, with both sorters' classifications and reasons and the
arbitrator's reasons where they disagreed, or `owner-reviewed` for a genuine owner-approved
worklist — never fabricate owner approval. Name each subagent sorter by its agent id (`child`, as
its Agent result shows it) and leave it out for this session's own reading; codemap fills the
session. Two sorters, and the arbitrator, must differ. Read `repair_records` for eligibility and
holds. A correction names the current sort as prior and supersedes it; a correction naming an
older sort is refused as stale. Adding sites or claims, or rewording, is free. A correction that
REMOVES a site or claim is refused unless it cites a logged ruling (its ruling field, a decisions
answer id) on why it is not an instance — ask the person, log their answer, then post the
correction citing it. `restsOn` names what holds a sort: a free label at sort time, re-pointed with
a correction to `decision:<id>` once /ez-plan has posted the question that decides it. Nothing else
drops a `restsOn` entry: once the person has answered, `release_held_sort` releases the sort with
two readers (`references/verify-repair.md` in the codemap skill).

A requirement/scope choice is the owner's. Design defects, assumptions and suggestions remain held
for their relevant ruling. A pattern is held only when its fix forks the design (`triage-review`'s
`prompts/sorter.md`, *Defect patterns*): an agreed mechanical or implementation-defect pattern with
its predicate and sites is eligible like any other. Adoption of a suggestion authorizes work; it does not mean
that work was fixed. Explicit human acceptance/decline is a human disposition, not factual
refutation. A real not-now item uses the existing principal-granted dated backlog with witnesses;
a deadline is required. No agent backlog shortcut.

## Questions and answers

Whenever the ordinary route records a batch in `owner.md`, post it first through `post_round` when
shared capability is available. Put all operative items/full list inside the actual question; for
issue-action questions include exact finding IDs/effects. A preview, label or
linked file is insufficient. Diagnosis criterion questions remain effect-free and use artifact
vocabulary without finding IDs, site lists or quoted review framing, under `triage-review`'s `references/diagnose.md`. Keep
canonical associations only in unshown `codemap.md` metadata, never in the owner.md supplied to
blind lens readers; do not attach issue-closing/unblocking effects to those criterion questions.
Keep full questions and returned IDs in markdown. Frozen questions never mutate; a later `follows`
question adds context and does not supersede authority. Use explicit revision/withdrawal routes
when needed.

Ask the exact returned payload with `AskUserQuestion` and record it with `log_question` and the
round: codemap finds the call itself. Do not submit browser attestations as the person, forge
transcripts or pass a summary as the source response. Unanswered and partial
items stay pending; a partial batch unblocks only what was answered. When `post_round` answers with
`alreadyRuled`, the issue already has a standing ruling: tell the owner rather than asking again as
if it were new. A ruling that looks wrong or conflicts with another is reported with `report_ruling`,
which asks its principal whether to withdraw it; only their "Withdraw it" answer lets
`withdraw_decision` retire it.

For free words needing interpretation, use `reader_brief` and the independent `submit_verdict`
receipt/record flow codemap offers. Keep a `(none)` or disputed reading pending
and ask the person where necessary. Application of a human-invalidity or explicit-acceptance ruling
is separate: `application_reader_brief`, fresh independent reader(s), `submit_application_verdict`,
`record_application_verdict`, then `apply_ruling` after current-context checks. A request/brief is
not execution. Use a measured direct-mention route only when the operation itself accepts it; do
not replace it with the two-repair-verifier protocol. Missing reader receipts remain pending.

Discuss First preserves its suspended bookkeeping: do not post every exploratory exchange, convert
conversation fragments into decisions, or bulk repair before the existing owner-display gate.
When discussion becomes a plan/ad-hoc authorized work, record the settled exact words as its route
requires; shared authority still needs a real recorded source, never retroactive prose certification.
On shared-mode resume, pull/reconcile through codemap's `sync` tool before deriving actionable work. Inspect current
holds, partial replies, revisions and executed history; sync/retry retains identities.

## Asking

Ask with `AskUserQuestion`, or on `ez-plan`'s Plan with Artifact page (below). A codemap
questionnaire is not a planning instrument for now (owner, 2026-10-06: "leave questionnaires out as
a planning instrument for now and keep all the other codemap integration until codemap catches
up"): do not post a round with one, and do not defer a batch into one. Everything else here stays:
`post_round` first, then `log_question` or `relay_answer`, and readers — that is the durable record.
Under Codex there is no verified answer to record, so shared-mode rulings stay pending (above).

A fork question — the opening's choice of route — is asked in the session, never deferred.

`ez-plan`'s **Plan with Artifact** page stays available in shared mode. Its marks are read with
`ArtifactData`, which is not a verified answer, so they go to `owner.md` only and are never posted,
logged or relayed as codemap rulings. A decision whose effect needs a ruling — settling or
unblocking a finding — is asked through codemap as above.

## Repair evidence and verification

Before claiming success, record `record_repair_evidence` with exact witness/base/fix commits,
coverage of every claim, changed-file/hunk attribution, and the check: its command, environment and
actual result failing at the witness and passing at the fix, or `unknown` with why it could not run.
Regression runs and whole-pattern enumeration are separate; a regression suite is not the check.
Inspection-only work records exact source/reasoning and `noCheckReason`, visibly weaker; no-check
never pretends a test ran.

After an eligible sort and evidence, `repair_request` freezes them. Each of two blind verifier slots
(`repair_brief` slot 1 or 2) is either a dedicated session that calls `claim_verifier` before any
other codemap call, or a subagent launched with exactly the `launch` prompt `repair_brief` returns,
whose held `repair_verification` its launcher records with `record_repair_verification`. A verifier
runs the check itself, failing at the witness and passing at the fix, and records both; it sees no
other verdict or fixer conclusion. A third verifier arbitrates only a genuine disagreement. Then
`repair_apply_verification` applies the verdict; a verifier never applies its own. An unavailable
seam leaves the repair reported and pending. Never skip a verifier to finish.

Read lifecycle from `repair_records`, queue/search/issue/round views: adequate at exact commit is
separate from landed/default proof. Verified applied repairs leave active work without another
human acknowledgment. Drift/unknown/conflicting evidence raises attention, preserves historical
closure and never automatically reopens. Reopening creates a fresh epoch; old applications and
rulings cannot be reused. A branch-only repair cannot close a linked bug. Keep bugs' typed lifecycle.

## Exact operation sign-off

Default to a plan-only ruling unless the person chooses promotion of exact shown draft operation
text/context. Use `operation_signoff_question` to bind full operative text, operation ID and
content witness; post and ask the exact question. A label like “approve” without text is not
sign-off. After verified human provenance, issue `operation_signoff_reader_brief`; fresh independent
reader calls `submit_operation_signoff_verdict`, coordinator records via
`record_operation_signoff_verdict`, then `apply_operation_signoff` pulls/rechecks immediately.
Credit the answering principal; retain the agent executor separately. Changed text/context,
unverified/conflicting/withdrawn answer or missing reader refuses. A plan-only answer signs nothing.
Only that operation is signed; framing and other operations are untouched. Ratification remains a
separate principal act with every existing prerequisite. Unavailable tools mean pending sign-off,
not an impersonated `ActorInput`, browser attestation or trusted markdown import.
