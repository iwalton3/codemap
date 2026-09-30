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
(X1 under Codex); a model label is not independence. Never relay one verifier's conclusion to
another. Only grants verify a repair: a fresh session the person starts with the `codemap-verify`
skill, or a subagent launched with exactly the prompt `repair_brief` returns. The session that asks
for verification never fills a slot of its own request.

## Findings and sort

Before posting a shared round, record each missing canonical finding in the correct universe and
review with the ordinary finding operations, publish local-only findings, and retain its ID beside
its F-number in `findings.md`. Re-read IDs rather than recreating records after retries/sync. Keep
as-filed text immutable; `record_repair_claims` may decompose it without deleting the original or
any claim. A partial fix cannot erase the other claims.

Use the existing category definitions and owner authority. Preserve the informed first/blind second
arrangement: the blind second starts before blame and receives only the raw findings, permitted
purpose and artifact, never the first reading. Post the skill's own sort with the round through
`post_repair_sort`: `dual-sorted`, with both sorters' classifications and reasons (each sorter named
by its session) and the arbitrator's reasons where they disagreed, or `owner-reviewed` for a genuine
owner-approved worklist — never fabricate owner approval. Read `repair_records` for eligibility and
holds. A correction names the current sort as prior and supersedes it; a correction naming an older
sort is refused as stale. Adding sites or claims, or rewording, is free. A correction that REMOVES a
site or claim is refused unless it cites a logged ruling on why those are not instances (its ruling
field, a decisions answer id) — ask the person, log their answer, then post the correction citing it.

A requirement/scope choice is the owner's. Design defects, assumptions, suggestions and patterns
remain held for their relevant ruling. Adoption of a suggestion authorizes work; it does not mean
that work was fixed. Explicit human acceptance/decline is a human disposition, not factual
refutation. A real not-now item uses the existing principal-granted dated backlog with witnesses;
a deadline is required. No agent backlog shortcut.

## Questions and answers

Whenever the ordinary route records a batch in `owner.md`, post it first through `post_round` when
shared capability is available. Put all operative items/full list inside the actual question or
questionnaire; for issue-action questions include exact finding IDs/effects. A preview, label or
linked file is insufficient. Diagnosis criterion questions remain effect-free and use artifact
vocabulary without finding IDs, site lists or quoted review framing, under `triage-review`'s `references/diagnose.md`. Keep
canonical associations only in unshown `codemap.md` metadata, never in the owner.md supplied to
blind lens readers; do not attach issue-closing/unblocking effects to those criterion questions.
Keep full questions and returned IDs in markdown. Frozen questions never mutate; a later `follows`
question adds context and does not supersede authority. Use explicit revision/withdrawal routes
when needed. A questionnaire may be answered by a different principal; retain the actual answerer.

Ask the exact returned payload with `AskUserQuestion` and record it with `log_question`, or give the
published questionnaire link for its separate browser submission. Do not submit browser attestations
as the person, forge transcripts or pass a summary as the source response. Unanswered and partial
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

Where questions go, in order:

- **Codemap is open** (`questionnaire_list` answers `codemapOpen.open: true`): post the batch as a
  questionnaire (`post_round` with `round.questionnaire`, every operative word in the questions),
  give the owner its link, and wait with `questionnaire_wait`; read the answers back with
  `questionnaire_detail` and write them to `owner.md` verbatim.
- **Otherwise** ask with `AskUserQuestion` (under Codex, `shared.md` X2: a fork question ends the
  turn; the rest go to a markdown file the owner marks).
- **The owner may defer** any batch into a questionnaire instead, open or not: post it, give the link,
  and end the turn. Anyone on the team may answer it, under their own name. Resume from its answers.

A fork question — the opening's choice of route — is asked in the session, never deferred.

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
