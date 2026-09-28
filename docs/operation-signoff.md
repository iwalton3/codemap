# Verified operation sign-off

The finalized remaining-decision-work plan authorizes an additive receipt path
for approving one exact draft operation. It does not delegate ratification.
The existing principal-only sign-off verbs and ratification prerequisites remain.

`operation_signoff_question` returns the complete human presentation: operation
and spec IDs, every `operationContent` field, framing context, and explicit
choices between signing the exact operation and recording a plan-only ruling.
All operative instructions appear inside the question. Labels carry no hidden
action descriptions. Publish this payload unchanged through the existing round
or questionnaire mechanism, then record a verified human answer. Drafting the
operation or answering a different approval question signs nothing.

`operation_signoff_reader_brief` issues a frozen independent-reading task for an
exact operation and current human answer. The reader submits its own sound or
unsound verdict through `submit_operation_signoff_verdict`.
`record_operation_signoff_verdict` correlates the exact independent launch,
submission, and successful receipt against the reader subagent's own transcript. A changed,
withdrawn, unverified or conflicted answer cannot authorize application.

`apply_operation_signoff` pulls immediately before application and rechecks the
operation, framing context, source authority and exact reader receipt. Failed
pulls and content movement refuse. The act credits the answering principal while
retaining the agent executor separately. It signs only the named operation;
framing, sibling operations, and ratification require their separate acts.

The workspace law event `spec.operation-signoff-applied` carries a versioned
capsule: the operation and framing content, a copy of the human answer (its id,
principal, the exact question shown, the option picked and the words), the
independent reading and the executor. The standard fold validates it against the
live draft operation and credits the answer's principal only where that copy is a
verified, current answer picking "Sign off this exact operation" on exactly this
operation's question; the event's actor must be the capsule's executor. Plan-only
answers, answers to another operation's question, copies edited after the reading,
and removed/non-draft operations grant nothing (`operation-signoff-authority.test.ts`).
The copy guards against an agent's mistakes, not forgery, which is out of scope
(owner, 2026-09-28); an Ed25519 producer seal was removed for adding ceremony
without trust.

Ordinary reads use projected witnesses. The standard detail view shows the human
answer, source scope, agent executor and independent reader. Later changes do not
erase historical approvals; existing witness content rules decide whether an
operation remains signed for ratification. The fold does not consult a universe's
live decision scope: the writer carries its validated authority snapshot into the
law act, so every clone can replay the same approval independently.
