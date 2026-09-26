# Rulings contract

> **Kind: active behavioral contract** — owner-approved direction for round five,
> 2026-09-24. It is not an as-built description. The historical quotes below remain
> evidence; the current design details appear under *Current design resolutions*.
> Implementation status is stated separately and must be verified before claiming
> the workflow is complete.

## Purpose and owner agreements

The owner's statement of purpose, verbatim:

> 1. Durably record answers to questions, **including questions raised in bulk by a finding backlog reviewer**.
> 2. Allow rulings to close out findings or bugs if they're invalid based on a question response and it's not a simple "is this a bug that is fixed" question that can be answered by two sorters and an arbitrator agent.
> 3. When rulings between users conflict on sync, the sync conflict should be resolved, two users deciding the same question different ways should not just silently discard one verdict.
> 4. This one is more of a question: Should it be possible for questions to be superseded at all? The supersede mechanic seems to be a major source of intent conflicts.

The session recommended removing automatic question supersession and retaining:

- **Withdraw an unanswered question:** record that it no longer needs answering,
  with a reason. Withdrawal does not itself decide its findings.
- **Revise an existing ruling:** preserve the earlier answer and record the human's
  new instruction and exactly what it replaces. Concurrent incompatible revisions
  still require resolution.

The owner's response, verbatim:

> > I recommend removing automatic question supersession from the contract.
>
> Agreed. It's been a common theme of these rounds.
>
> I would retain two narrower capabilities -- Yes, I agree with both.

Earlier owner direction remains relevant. From the round-four diagnosis's
`owner-late.md`, verbatim:

> Yes, if the two answers mean the same thing (as judged by a reader) there is no need to block. If there is a change later by the same user or with another user having the old answer in their event store, then no arbitration is needed.

## Agreed boundary: questions do not supersede questions

Posting a new question is not an implicit withdrawal, answer revision, or conflict
resolution. Withdrawal of an unanswered question and revision of a ruling are the
explicit alternatives agreed above. Earlier records remain history.

This replaces the automatic question-supersession direction in earlier plans.
**Deployment correction from the owner:** this branch has never been merged or used;
no rulings were logged into the actual system. There are no existing supersession
events, old briefs, or pending ruling verdicts requiring migration. Legacy-rulings
recovery is removed from this work. This says nothing about unrelated deployed
codemap data, which remains governed by the sidecar architecture.

## Behavioral contract

These clauses incorporate the owner's case rulings recorded below. Explanatory
consequences are the session's wording, not additional owner quotations. “Principal”
here means the person behind an answer. The owner confirmed this interpretation of
“principles” in the replies below.

### C1. Preserve the question and the answer

Keep the complete question as presented, its options and descriptions, relevant
context, answer, human provenance, and the identities of affected findings or bugs.
A display label such as D1 is not sufficient identity. Synchronization preserves
accepted source records; later events can change current authority without rewriting
what someone previously answered.

A bulk question preserves the relationship between the displayed batch, each item,
and the answer that applies to it. A backlog reviewer can raise these questions
without losing their item-level meaning. Questionnaires are a first-class way to
present and answer the batch (C7).

When Q1 covers findings A and B and Q2 covers A, both questions remain linked to their
findings and visible to humans in the web app and agents through the CLI unless a
ruling is withdrawn. Posting Q2 does not implicitly withdraw Q1 or revise its answer.
Withdrawing affects active visibility; it does not erase the historical record.

### C2. Interpret what the human was actually shown

A reading is evidence about a particular answer and the question context available
for that reading. It must not silently acquire different questions or lose its
original identity after synchronization. Information needed to distinguish options
must reach the reader; exact labels alone do not establish equivalent meaning.

If the underlying question response changes, its old reading is cancelled and a
new reading is required. Keep the old reading as historical evidence, but it cannot
authorize a pending closure or confirmation against the changed response. This
applies even when the reading completed before the response changed.

A completed reading awaiting confirmation remains discoverable while that
confirmation could authorize an action; a cancelled reading is shown as historical,
not actionable. Visibility, admissibility, current authority,
and work eligibility are separate facts; one cannot stand in for all four.

### C3. Separate a ruling from applying it

A human's answer can justify closing a finding or bug as invalid when it settles the
premise on which that record depends. Closure requires a reader agent to find the
claim sound. If the ruling does not directly mention the finding in a form codemap
can parse, two readers are required, plus an arbitrator if they disagree. This is
validation of the ruling's application, not a fresh demand for human approval.

Applying a ruling records the affected record, the ruling relied on, and the evidence
supporting the disposition. Recording an answer and applying its closure remain
distinct responsibilities. The exact execution path is a design detail; a bare answer
does not bypass the required reader validation.

A repair-verification question remains the agents' verification task; a human ruling
is not a substitute for evidence that code was fixed. Conversely, agents must not
invent a missing product requirement to dispose of a finding.

The action described to the human must agree with the action authorized by their
answer. A matching question number or option label does not excuse contradictory
action text. Unrelated findings and bugs gain no disposition from that answer.

A later revision of the ruling leaves an already applied closure intact. Reopening
is a separate follow-up task. Agents may reopen findings or vouch for them without
human approval; closure requires the stronger validation above.

Each ruling has one opportunity to close a given finding or bug. Once that closure
has executed, reopening the record does not renew the ruling's authority to close it.
Another ruling is required, with the applicable reader validation. A new reader,
a retry, another clone, or replay of the same ruling cannot supply that new authority.
This is per affected issue: a ruling addressing several issues does not lose its
unapplied authority over the others merely because one was closed.

### C4. Preserve disagreement and distinguish it from correction

Sync retains independently given answers. Conflicts apply across principals, not to
a person's changes to their own answer. A revision made with the old answer already
stored in the system is not a conflict, including when a different principal makes
that informed revision. A timestamp or fold order must not silently choose between
incompatible independent rulings from different principals.

Mechanical differences are candidates for semantic comparison, not proof of a
conflict; matching words or finding effects are not proof of equivalent implementation
intent either. If a reader finds equivalent meaning, record that reading and consider
the question conflict resolved. The evidence must travel with the shared record.

Batch work depending on candidate answers pauses while semantic comparison is
pending, marked as awaiting comparison rather than as an established disagreement.
Work that requires answer arbitration remains frozen for batch tasks. Assignment
alone cannot bypass either restriction; conflict resolution is required, through an
interactive agent using standard question logging or through the web UI. An agent
working interactively with a user can put the conflict to that user and record the
answer through standard question logging. The resolution identifies the alternatives and
its scope. An unseen third answer is not automatically resolved: independent conflicts
across principals go to a user; revisions made with the old answer stored do not.

Current authority is derived from the relevant answers, revisions and resolutions.
Preserving an old answer for history does not make it a fresh competing instruction
forever. A later informed correction of a resolution must not accidentally leave
all alternatives eliminated.

If a closure already executed using a ruling involved in a conflict, surface that
execution when resolving the conflict: the affected issue, the ruling and reading
used, and the recorded closure. Discovering the conflict does not silently undo the
execution. Agents handling the conflict can open a new question about whether a
revert is needed. This remains separate from resolving which answer has authority.

### C5. Withdraw without silently deciding

Withdrawal records that an unanswered question no longer needs an answer and why.
Humans may withdraw; agents may do so with the existing human approval mechanism,
such as a logged question or approval in codemap. Withdrawal does not erase the
question or decide its findings. Conflicts involving withdrawal use the same answer
conflict rules as other questions, rather than a separate winner policy.

An answered-ruling withdrawal retires only that answer’s pending authority, readings
and holds within its exact scope. It preserves source history and completed closures;
it does not revive an older answer or close or reopen an issue. An unanswered-question
withdrawal ends only its own request and ordinary holds. An independently given
answer, including a delayed relay, remains visible and is judged by what the person
knew when answering, not by the recorder’s later pull. An agent may execute a
withdrawal only against a recorded human approval of that exact act and scope.

### C6. Revise explicitly and within scope

A revision records the human's new instruction, the earlier ruling it revises, and
the affected scope. The old answer remains available as history. A new question may
provide the context for a revision; merely posting it does not perform the revision.
Unmentioned items do not inherit an implicit change. Independent incompatible
revisions across principals require resolution under C4. Already applied closures
remain closed under C3.

### C7. Publish and answer questionnaires

Provide an MCP tool that publishes an entire organized batch of ruling questions
for another team member to answer in codemap. A questionnaire supports:

- Multiple choice, including an **Other** free-text answer.
- Short answer.
- A list of items to mark wrong, with a free-answer verdict.

The stakeholder can read the whole questionnaire and answer its questions in the web
app. Presentation must not impose the interactive tool's four-question batching
limit. Answers become durable codemap ruling records and return directly to the
requesting coding agent through codemap, without manual transcription. Agents must
be able to retrieve the questions and answers, including through the CLI as required
by C1. The transport for notifying or refreshing the requesting agent is a design
detail, not a promise of an existing push channel.

Questionnaires organize the existing question/answer model; they must not introduce
a second set of conflict, reading, revision, or closure rules. Preserve the association
between questionnaire, question, list item, respondent, and answer. Another team
member answering the batch uses the same human provenance and conflict rules.

A stakeholder may save a local draft and submit selected complete questions. Saving
or leaving a form grants no authority. A reviewed list submits as one unit: the
submit action says that unmarked items are approved, and each marked item needs its
own correction text. Other complete questions may be submitted while that list is
incomplete. The selected batch is validated atomically and identified by an attempt
ID and exact payload, so an identical retry returns its receipt. Submission makes
only those answers durable; unanswered questions remain pending. Completion is
derived per person and separate from readings, conflicts and closure authority.

## Acceptance cases and former design details

The behavior column records settled direction. The final column preserves the
questions open when this table was written. The round-five plan resolved them as
recorded below; they are not outstanding owner decisions.

| Case | Required behavior | Remaining detail |
|---|---|---|
| A backlog reviewer publishes questions for a stakeholder | Entire organized questionnaire, all three answer formats, whole-batch visibility, answers returned through codemap | Publish/retrieve interface, completion and partial-answer behavior, recipient routing |
| A questionnaire contains a list of items to mark wrong | Preserve each item's identity and the free-answer verdict | How untouched items differ from approved items, and whether the verdict is per item, per list, or both |
| Q1 covers A and B; Q2 asks about A | Both linked and visible in web/CLI unless a ruling is withdrawn; no automatic supersession | Distinguish question withdrawal from withdrawal of an answered ruling |
| A human or approved agent withdraws unanswered Q1 | Record authorized withdrawal; no finding disposition; conflicts follow ordinary answer rules | Hold release and the answered-ruling withdrawal case |
| A person corrects their answer, or another revises with the old answer stored | Retain history; no arbitration for that revision | Capture the relevant knowledge at the act, including relayed answers |
| Alice and Bob independently answer incompatibly | Retain both; pause dependent batch work during comparison and arbitration; assignment cannot bypass; resolve interactively or in the web UI | Trace pause and release consistently across queue, marks and action |
| A reader finds two answers equivalent | Log the reading; question conflict resolved | Reader evidence representation and scope |
| A resolution is corrected, or a third answer arrives | Informed revision is not conflict; independent disagreement across principals goes to a user | Exercise both histories without erasing all authority or resolving unseen intent |
| A ruling establishes invalidity | Reader finds the claim sound; indirect application needs two readers and an arbitrator on disagreement | Define parseable direct mention and evidence linkage for both findings and bugs |
| A ruling used to close a record is revised | Keep closure; reopening is a follow-up task; agents may reopen or vouch for findings | Preserve the closure's original evidence when presenting the revised ruling |
| An answer changes after its reading but before closure | Cancel the old reading; require a new reading; old validation cannot authorize the pending closure | Check both local operations and reordered replay |
| Sync discovers a conflict involving a ruling whose closure already executed | Retain the closure and surface its execution at conflict resolution; agents can ask whether a revert is needed | Show execution evidence alongside the conflicting answers |
| A ruling closes F, then F is reopened | The same ruling cannot close F again, even with a new reader; another ruling is required | Exercise retries, two clones, and replay without a second closure |

No legacy-rulings migration case remains: the owner confirms the branch was never
merged or used and no actual rulings were logged.

## Current design resolutions — round five

These are the working contract for implementation, from the approved cases and
round-five plan at `.git/plan/2026-09-24-rulings-round5/plan.md`. The local
plan is implementation evidence and does not travel with a pushed documentation
branch. This section does not assert that every operation or surface now passes.

- **Identity and context.** A canonical issue reference includes universe, kind,
  owning scope/review and exact ID. D1-like display refs never select an issue or
  ruling by iteration order. Publication freezes the exact displayed question,
  option descriptions/effects, list items and visible action. A new question may
  link context but neither withdraws nor revises an older answer.
- **Human act time.** Answers, revisions, withdrawals, reader judgments and
  applications enter the log when they occur. A relay carries given time and
  verifiable human source context. Append-time causality alone cannot prove the
  human saw a later answer or withdrawal. A cross-principal revision needs its
  named predecessor and verified context shown to that person at the act; an
  independently given answer remains a possible conflict. Same-principal
  corrections retain given-time ranking and deterministic log order for ties.
- **Authority and comparison.** Preserve source answers separately from current
  authority. Compare independently authoritative answer versions with complete
  question and response context. An independent reader records equivalent,
  incompatible or unclear with rationale and scope. Equivalent releases only its
  comparison restriction; incompatible requires a logged human resolution; unclear
  remains pending. Contradictory reader judgments remain disputed. Assignment does
  not bypass pending comparison or arbitration. A changed answer invalidates its
  previous comparison and reading evidence. Correcting a resolution derives a new
  authority frontier without erasing historical choices or resolving an unseen
  third answer.
- **Reading and application.** The reader receives the frozen full brief, not only
  labels or hashes. A direct issue mention must be an exact shown ID/link whose
  target is unambiguous; indirect application needs two independent sound readers
  and arbitration on disagreement. Confirmation must match the complete approved
  action. Applying invalidity is a separate guarded, one-shot act for a finding or
  bug, with source and reading evidence in the target scope. An already-closed
  no-op spends nothing. An executed application remains history after revision,
  withdrawal or conflict; reopening is separate and never renews that ruling/issue
  pair.
- **Retrieval.** Web drafts are local to principal and exact questionnaire version.
  MCP and CLI reads use the same projected records. Requesting agents retrieve by
  stable questionnaire ID after explicit sync; status and bounded wait observe local
  projection changes and cannot wake a terminated session or silently pull a remote.
  Pending, cancelled, conflicting and withdrawn history stays discoverable.

**Implementation status, 2026-09-25:** the round-five workflow is implemented.
Focused real-operation tests pass for exact agent-withdrawal approval, informed
revision with act-time source proof, corrected resolution, and bug-scoped revision.
Two-clone oracles cover answer preservation, conflict frontiers, withdrawal races,
consumer restrictions, retrieval after sync, and one-shot finding/bug application.
The browser suite passes for questionnaire submission and human decision acts.
The final `npm test` run passed 1,982 unit tests and 165 e2e tests with no failures
or skips. The historical table and diagnosis below remain evidence of earlier
behavior, not current policy.

## Round-four findings integrated into round five

Source: the reconciled `2026-09-24-decision-rounds-2-round4-review/sort.md`
under `.git/triage/`. Nine deduplicated items cover F1–F10; none was adjudicated
invalid. This section preserves their identity and substance in a traveling document.
It does not change their historical classification disagreements. “Covered” means
behavior specified for the next implementation, not a repaired or tested defect.

| Item / original findings | Defect and minimal case | Contract disposition | Required implementation check |
|---|---|---|---|
| **A — F1, F8** | A legacy pending verdict loses its submission context; settling after a pull substitutes later replacement knowledge and invalidates the completed reading. | **Original recovery case inapplicable.** No legacy ruling data exists, and automatic question replacement is removed. C1/C2 still require accurate context for newly submitted readings. No legacy-row reconstruction work. | A new-format submitted reading retains its question/response identity through transcript delay and unrelated sync. If that response is revised, cancel the reading explicitly under C2; do not confuse an unrelated new question with a changed response. |
| **B — F6** | A text-only brief lists one D1; a later pull adds an identical-looking D1 and retroactively makes the old brief ambiguous. | **Legacy reconstruction inapplicable; forward identity rule covered by C1/C2.** A displayed ref or text is not identity. Newly issued briefs must preserve the identities they actually included. | Two clones introduce the same displayed ref/text. Sync cannot add a question to an already issued brief or reinterpret its accepted answer. If a new brief actually shows ambiguous refs, interpretation must identify the target or visibly refuse ambiguity. |
| **C — F9** | A partial successor rules on A and hides a completed disputed reading on Q1 covering A/B, although B was omitted. | **Supersession trigger removed; visibility covered by C1/C2/C6.** Q2 about A cannot suppress Q1 or B. An actual changed response cancels its reading; merely posting or answering a related question does not. | Q1 covers A/B and has a disputed reading; Q2 covers A. Both questions and the actionable dispute remain discoverable through web, CLI and agent reads. Repeat with an explicit answer revision and verify visible cancellation instead. |
| **D — F2** | Two successive resolutions of the same answer pair choose opposite alternatives; accumulated losing-answer marks eliminate both. | **Covered by C4/C6.** An informed correction changes current authority while retaining history. Independent incompatible resolutions across principals require resolution themselves. | Select Alice over Bob, then knowingly revise the resolution to Bob: Bob has current authority and neither record vanishes. On isolated clones make incompatible resolutions: preserve both and surface the conflict rather than accumulating two exclusions. |
| **E — F3** | Equal “Yes” answers and equal finding effects on differently qualified questions are discarded as a possible conflict even though implementation intent differs. | **Covered by C1/C2/C4.** Compare relevant question context and meaning; neither words nor effect tuples prove equivalence. The detector must not suppress the diagnosis's qualified-Yes case. | Independent answers to differently qualified questions with equal labels/effects reach semantic comparison; different implementation intent reaches human resolution. A control with genuinely equivalent meaning logs equivalence and resolves the conflict. |
| **F — F4** | A candidate hold uses the first question's ordinary hold/posting time rather than the conflict's beginning, corrupting assignment eligibility. | **Covered by C4 and decision F below.** Assignment cannot bypass a pending-comparison or conflict freeze. The ordinary assignment-time override does not apply to these restrictions. | Trace assignment before the conflict, assignment after it, interactive conflict resolution, and an unaffected task through queue, marks and action. A conflict must not inherit a question's earlier ordinary hold start. |
| **G — F10** | Every mechanical candidate, including unread/disputed words, becomes an established hold and suppresses actionable rulings without semantic judgment. | **Covered by C4 and decision G below.** Candidate, equivalent intent, and established disagreement are distinct. Dependent batch work pauses pending comparison; logged equivalence resolves the conflict. | Run the approved pre-comparison pause; then reader equivalence, reader-confirmed disagreement, and unresolved comparison. Inspect all work consumers. An equivalence clears only this conflict restriction, not unrelated ordinary holds. |
| **H — F5** | A losing answer already resolved out of authority creates a fresh candidate against Carol, even when Carol agrees with preserved Alice. | **Covered by C4/C6.** Historical losing answers remain evidence, not permanently active instructions. A third unseen answer is judged against current authority rather than treated as already resolved. | Resolve Alice/Bob in Alice's favor; add independent Carol agreeing with Alice and record equivalence without resurrecting Bob. Control: Carol disagrees with Alice and requires resolution. Repeat after a deliberate revision of the earlier resolution. |
| **I — F7** | Confirmation validation accepts a matching `D1 → option` prefix even when the remaining action text contradicts stored effects. | **Covered by C3 and the earlier no-authority rule for invalid confirmations.** What the person approves must match the authorized action in full, not just its label. | Keep the prefix and finding IDs but change the described action; the confirmation cannot authorize the mismatched action through ops or replay. Keep the invalid record and reason visible. A valid confirmation control still works; do not repair text after the human approved it. |

### Settled design decisions for F and G

**G — before semantic comparison.** Dependent batch work pauses while a reader
compares possible conflicts. Present the state as awaiting comparison, not as an
established disagreement. Logged equivalence resolves the conflict; an established
disagreement keeps dependent batch work frozen pending human resolution. An unclear
comparison remains pending or is escalated through a logged question rather than
silently releasing work. Unrelated work is unaffected by this restriction.

**F — assignments versus conflict holds.** Assignment alone never resolves or bypasses
the restriction on dependent batch work. Retain assignment as history and scheduling
intent. Resolution can happen through an interactive agent using normal question
logging or through the web UI. Earlier S0.4's ordinary hold/assignment exception does
not override pending comparison or arbitration. Ordinary question/verifier holds
remain separate; equivalence or resolution removes only its own conflict restriction.

This removes conflict eligibility's reliance on comparing an assignment timestamp
to a question's posting. The conflict record still needs evidence of its source
answers and the comparison or resolution that establishes/releases the restriction;
display chronology must not pretend it began at an unrelated question's posting.
No event schema is selected here.

The session asked whether dependent batch work should pause before semantic
comparison, and whether assignment could bypass the freeze. The owner's decisions,
verbatim:

> 1. Yes, pause batch work.
> 2. Probably makes sense to force conflict resolution, that can be done easily in an interactive agent or in the web ui.

### Reader-brief completeness from the diagnosis

The diagnosis also identifies a defect outside the nine-item sort: the reader sees
question text and option labels while answer identity includes more information.
C1/C2 cover the required behavior, but the implementation must make it concrete:
provide the exact relevant question, option descriptions, selection semantics,
item context, and associated action/effect meaning. For questionnaires this includes
the list item and the scope of the submitted verdict. Internal hashes or full stored
payloads do not substitute for presenting this information to the reader.

Check the same labels with differing descriptions/actions: the reader must receive
the difference. Inspect the actual generated brief, not just its manifest. Keep the
reader independent of the requesting agent's proposed interpretation. This is a
coverage requirement under C1/C2, not a newly approved reader protocol.

## Diagnosis kill conditions and recovery assessment

Assessed against [the round-four diagnosis](postmortems/2026-09-24-decision-rounds-2-round4-review.md),
§5 and §§2, 7–8. Its “kill conditions” are **falsifiers of the diagnosis**, not
conditions a successful implementation should satisfy. Meeting one would undermine
its account of why the loop happened. They are not met by this contract:

| Diagnosis §5 kill condition, verbatim | Assessment against this contract |
|---|---|
| The differently qualified Yes case can always be classified by stored effects alone. | **Not met.** C1/C2/C4 and item E require the full context and semantic judgment. Equal effects remain insufficient. |
| Recovery needs only guards at known sites and no rule separating candidates from holds. | **Not met.** C4 separates candidate comparison, equivalence and arbitration. F/G now state the approved pause and mandatory resolution rules. This is not a guard-only repair. |
| The owner can close the cases without ruling on reader-visible meaning or when uncertainty pauses work. | **Not met.** The owner has ruled on reader-judged equivalence and arbitration-dependent freezes. The owner also approved pausing during comparison and requiring resolution rather than assignment override. The design depends on these rulings. |

Thus the diagnosis is **not falsified** by the new direction. The contract responds
to its mechanism; that does not demonstrate the implementation is repaired. The
following table preserves the 2026-09-24 design-stage assessment and its then-open
evidence obligations; the implementation status above records subsequent checks.
The report's narrower “this goes away if” conditions and recovery obligations are:

| Recovery obligation | Design status | Evidence still required |
|---|---|---|
| A semantic reading governs both equal-looking/different-meaning and different-looking/equal-meaning cases (§2.1) | C4 and E/H specify the outcome; F/G settle the pre-comparison pause and forbid assignment bypass | Both scenario directions through real operations, including reader evidence and work eligibility |
| Readers receive interpretation-relevant descriptions/effects (§2.2) | C1/C2 and the completeness requirement above specify it | Inspect full/reduced briefs for an ambiguous case; run the actual generated-brief path |
| Preserve historical records and inspect legacy recovery (§7) | Legacy-rulings recovery is **inapplicable by owner correction**, not successfully demonstrated | For new records, verify unrelated sync preserves context while a changed response cancels reading authority |
| Trace a candidate through queue, assignment and action (§7–8) | F/G policies settled; the required trace is not yet run | Operation scenarios on isolated clones and every consumer, including interactive resolution and batch freeze/release |
| Independent behavioral oracle and fail-before checks (§7–8) | Owner rulings and the crosswalk provide the intended outcomes | Run applicable cases against current behavior, then new implementation; demonstrate actual failing checks rather than self-consistent fixtures |
| Cover the full affected population, not just d763557 (§6–8) | All nine sorted items plus brief completeness are accounted for here | Map write, replay and read consumers; retain unrelated admission/receipt guarantees and validate them |

No runtime experiment, fail-before check, two-clone run, or repair certification was
performed for this integration. All nine sorted items are now covered at the design
level or retired by the changed scope, and the diagnosis's brief-completeness
requirement is covered. The contract addresses the diagnosis issues; implementation
and runtime validation remain outstanding. Questionnaires and withdrawal still have
their separately listed design details; this assessment does not mark the entire
contract implementation-ready.

## Owner's additional rulings, verbatim — 2026-09-24

**Deployment:**

> None exist. This branch has not been merged or used.

**Questionnaires:**

> Also, one thing I want to add: Questionnaires. We already have questions, we should add an MCP tool that allows an entire batch of ruling questions to be published and answered by another team member. The format would be multiple choice (with "other" answer supported), short answer, and list of items to mark wrong with a free-answer verdict.
>
> The goal of that is I can hand an organized list of rulings I need a stakeholder to someone in codemap and they can answer all the questions and it gets imported directly back into my coding agent. It also lets me read all the questions if I am answering, instead of getting them piecemeal in 4 question groups.

**Backlog batch:**

> The proposed direction makes sense, see above as it pertains.

**Q1 covers A/B; Q2 covers A:**

> Both questions get linked to the findings, both are visible to humans in the webapp and agents in the cli unless a ruling is withdrawn.

**Withdrawal:**

> Yes this makes sense. Humans can withdraw or agents with the human approval mechanism (i.e. logged question or approval in codemap). Conflicts are handled like any other question answer.

**Correction or informed revision:**

> Agree with stated direction. Conflicts only apply across principles.

**Terminology clarification:** The session asked whether “principles” meant
“principals”—the people whose answers are recorded. The owner confirmed:

> Yes that's correct

**Independent incompatible answers:**

> Agree with stated direction. Work which requires an answer arbitration is frozen for batch tasks, for an agent a user is working with, the agent can just put the conflict to the user and it gets logged using standard question logging.

**Equivalent answers:**

> Agree, log and the question conflict is considered resolved.

**Corrected resolution or third answer:**

> Conflicts between principles are brought to a user. Revisions where the old answer are stored in the system is not considered a conflict.

**Invalidity closure:**

> Closure can be applied if a reader agent finds the claim sound. If the finding isn't directly mentioned in the ruling in a way codemap can parse, two readers are needed, plus an arbitrator if they disagree to settle the disagreement.

**Revision after closure:**

> Keep the closure, if the user wants to re-open the closed finding that would be a follow-up task. An agent can re-open findings or vouch for them without a human needing to approve it, it is closure that requires a higher degree of validation.

**Old briefs, pending verdicts and supersession events:**

> Not applicable, this branch was never merged and nothing logged any rulings into the actual system.

## Owner's closure-lifecycle rulings after adversarial review

The review raised (1) a response changing between reading and application, or a
conflict discovered after application, and (2) reuse of a ruling after reopening.
The owner's answers, verbatim:

> 1. The old reading becomes cancelled and a new one is required if the underlying question response changes. If a closure has already executed over a conflict, surface that execution at conflict resolution time, the agents dealing with the conflict can open a new question about if a revert should be done if needed.
> 2. No, each ruling gets one shot of closing the issue, if it is re-opened another ruling is needed to close.

These settle the two outstanding closure-lifecycle cases from that review. The
one-shot application rule is a new explicit ruling here, not an assertion that the
older close-on-answer rules remained in force after their removal.

## Relationship to earlier work

This is the starting contract for round five, not another accumulated patch plan.
The agreed removal of automatic question supersession changes previous replacement
rules; it does not erase their historical justification or authorize deleting data.
The reader-validated closure rule now supplies the direction that the earlier
"no answer closes a finding" implementation deferred to verifier work (I9). A ruling
alone still does not bypass validation; the next plan must cover both findings and bugs.

Other prior rulings are not silently repealed by this draft. Before implementation,
map each retained or changed rule to its current clause and mark any unresolved
collision. Shared-state architecture remains governed by
[the sidecar contract](sidecar-architecture.md); this draft does not change backlog
deferral permissions or deadlines in [the backlog contract](finding-backlog.md).

The round-four findings and diagnosis obligations are integrated above. The next
implementation plan must preserve that crosswalk: covered is not fixed, retired
legacy recovery is not a passed test, and the settled F/G policies must reach every
work consumer. For each behavior, show the expected record, authority, visibility and
work state through real operations and replay, using owner cases as the oracle.
No implementation or behavioral validation is claimed by this document.

Sources: [latest diagnosis](postmortems/2026-09-24-decision-rounds-2-round4-review.md),
[historical worked cases](decision-rounds-worked-cases.md), and the local records under
`.git/triage/2026-09-24-decision-rounds-2-codex-round-review/` and
`.git/triage/2026-09-24-decision-rounds-2-round4-review/`. Local `.git` records do not
travel; the controlling owner statements for this draft are reproduced above.

## Implementation checkpoint — response-reading cancellation (2026-09-24)

A verified changed response from the same principal now cancels pending interpretation
of the earlier response. Ordering uses the time the human answered, then log order
for ties. The original response identity includes free-text versus selected-option
semantics; comparison is against the response before any reading. Another principal's
answer stays a separate conflict candidate, and unrelated activity does not cancel a
reading.

Cancellation is projected from source answers, including late arrivals. The earlier
answer, reading and confirmation receipts remain visible as history, with the changed
answer's ID and reason. Their interpretation copies cannot authorize pending work or
become current through a late confirmation. Changing the response back requires new
evidence. Reader and confirmation operations refuse reuse; the web view shows the
history and removes cancelled confirmation controls. No issue lifecycle is changed by
this derivation, so executed closures are untouched.

This is a partial implementation checkpoint, not completion of C1–C7. Explicit
revision/withdrawal, questionnaire submission, semantic comparison, typed bug
eligibility and one-shot issue application remain separate outstanding work. Existing
automatic question supersession also remains to be removed.

### Explicit acceptance (remaining-work Q5)

A human may explicitly accept a complete finding as real and deliberately not
being fixed. This disposition is `accepted`, distinct from fixed, refuted,
adopted implementation work and dated backlog. An agent applies a verified
human acceptance through the independent ruling-application reader path; it
cannot choose acceptance as a repair verifier. The receipt binds the exact
selected disposition and human answerer, retains the executor separately, and
has the same one-shot ruling–issue consumption as invalidity application.
