# Decision rounds — the worked cases

**The gate for plan `2026-09-22-decision-rounds` (I11).** Three past rounds are worked by hand
against `PROPOSAL-decision-rounds.md` §7 as the plan amends it. Nothing here is built. No schema
is written until the owner has marked every C-item below **holds** or **wrong**. **The owner
marked it on 2026-09-23** (*The owner's marks*, at the end). The table before that section holds
the session's proposals, and it is kept as the evidence for them.

Written 2026-09-23. The plan (`.git/plan/2026-09-22-decision-rounds/plan.md`) holds the C-list's
full text. This document holds its evidence.

## What the transcripts show, measured

Two main-thread transcripts were parsed: case 2's session `3cd1d67c` and case 3's `ad2a3664`.
Case 1's is not on this machine (see case 1). These facts bind I8e.

- **Every `AskUserQuestion` answer** has the shape the plan assumes: `type: "user"`,
  `isSidechain: false`, no `origin`, the paired `tool_use_id`, and a `toolUseResult` holding
  exactly `{questions, answers}`, with nothing else in any of the 9 results read.
- **`toolUseResult.questions` is not byte-equal to the `tool_use` input.** It drops
  `multiSelect: false` (the key disappears) and keeps `multiSelect: true`. This held on every
  single-select question in both sessions. **C14's "equal" must compare with `multiSelect`
  defaulting to false.** A byte comparison fails closed on every real answer.
- **The answer value takes four shapes:**
  1. a picked label, verbatim;
  2. "Other" free text, with no label;
  3. a label with the owner's words appended ("Both, findings stay on the PR/branch page but…");
  4. for multi-select, an array of picks where one element may carry appended words ("Slowness,
     if the caching isn't behaving…").

  Shapes 3 and 4 have no separator. So "a label with words" can only be detected as "the value
  starts with an offered label and is longer than it".
- **Typed messages** have `origin.kind: "human"` and `promptSource: "queued"`, and no
  `toolUseResult` (case 3, twice). C15 treats them as unverified.
- **Sizes** (C9, C22):
  - The largest single question is case 3's nine-call bulk approval: a 1045-character question,
    1356 characters as an object. It went through, and the answer came back intact.
  - The largest single call was 3046 characters (four questions).
  - No harness limit was hit, and none was measured.

## Case 1 — a downstream review round (read-only; placeholders)

Round `2026-09-21-*-invite-review` in Acme.API's `docs/triage/`: 42 findings from four reviews
of two pull requests (API and React), sorted into 36 items. Names and domain terms are
replaced: "staff" is the vendor's own admin role, "tenant" is a customer account, and "the
brand" is the product name.

**Codemap holds 8 of the 42 findings:** F14–F21, from a fresh `/codemap-review`. The other 34
came from `/code-review` and `/ci-review`, so an effect naming one of them is named by number
only (C11).

**The transcript could not be read, because it was never here.** The round was run by a
downstream teammate's Claude Code user, on their own machine: the record names Windows worktrees,
and a different author committed it. The "owner" in its `owner.md` is that teammate, not this
project's owner. No transcript on this machine holds the answers; the owner's exact words appear
only in sessions that quoted them. So **every answer below reads `unverified` under C14**, which
is the fail-closed ruling working as written. The general point is below, under *Verification
happens where the question was asked*.

| # | decision (as `owner.md` records it) | effects, if posted | the answer | shape | under the plan |
|---|---|---|---|---|---|
| D1 | Node 9: how to go on (Discuss First / plan / …) | none | "Discuss First (Recommended)" | picked | recorded, no effects (C6) |
| D2 | Design fork on the "primary user" rule: (1) key the admin wording on the invitee's role, (2) stamp "primary" at creation, (3) leave the design and fix the smaller items | option 3 **settles** I-a–I-d as accepted: F2, F3, F6, **F14**, F28 (email half), F29. F14 is codemap's | "3. these are edge cases document them but don't address". It came after an interrupted "…don't document them…" that the owner corrected | option number + words | free text → arbitrator (C1). Maps to 3. "document them" is **work**, not a note (see C1 below). C3: the corrected message supersedes |
| D3 | The fix gate: 15 items listed by number | **unblocks** the 15 items | "confirmed and also I confirm that test, demo and prod have no customised templates. Don't worry about deployment timing" | free text | arbitrator maps "confirmed" to approve (C4: unblock only). The rest settles **V-a (F10)** and **V-b (F17, codemap's)** — decisions the gate did not ask (see below) |

**Counts:** 3 answers. 1 settles (D2, 6 findings, 1 in codemap). D3 unblocks 15 items and
carries two unasked settles (2 findings, 1 in codemap). 1 has no effect. 2 are free text, and an
arbitrator could map both to an option. Neither maps cleanly: each carries words that do
something no option held.

**The new shape: an answer that settles a question nobody posted.** V-a and V-b were group-3
assumptions ("no environment has a customised template"; "no old replica renders during a
rolling deploy"). The owner settled them inside the fix gate's answer. If they had been posted
as their own decisions, an arbitrator maps the words to them. If they had not, C20 applies:
the words fit no option of the decision asked, the session posts V-a and V-b as decisions, and
the owner answers them. That is a second round-trip for something the owner has already said.
The record cannot tell which happened, because the session wrote the reading ("Settles V-a and
V-b") and not the question.

## Case 2 — codemap's `2026-09-19-branch-review-round`

Nineteen findings (Codex review, Codex adversarial review, `/code-review xhigh`) became 16
items, J1–J16. **None of them is a codemap finding**, so every effect is by round number only
(C11). All 11 answers are paired `AskUserQuestion` results in the main transcript, so **every
one verifies under C14**, with the `multiSelect` normalization above.

| Q | effects, if posted | answer | shape | under the plan |
|---|---|---|---|---|
| Q1 approve items 1–9 | unblock J1, J2, J5, J6, J7, J9, J10, J13, J16 | "Approve all" | picked | C4: unblocks, settles nothing. **The nine items are in the message body only.** The question is "Approve items 1–9 above as listed?", 282 characters as an object. So C22 allows unblocking only, which C4 gives anyway |
| Q2 deleted symbol | unblock J3 (F2, F6) | "Accept, witnessed at base (Recommended)" | picked | unblocks |
| Q3 branch names | unblock J4, and J5 behind it (F9) | "origin/x becomes x (Recommended)" | picked | unblocks |
| Q4 link write | unblock J7, J8 (F5, F16) | "One place, brief lock (Recommended)" | picked | unblocks |
| Q5 when landed | J12 (F11) | "Ideally when the witness marks … are seen in the default branch … OR the commit merges. For squashes … via github PR status." | Other | **C20**: fits no option. The session posted Q9–Q11 from the words, which is exactly what C20 prescribes |
| Q6 unbuildable snapshot | unblock J14 (F14) | "Fail fast, no cache (Recommended)" | picked | unblocks |
| Q7 what is critical | none (plan policy) | four picks, the last with words appended | multi + words | no effects; words kept |
| Q8 the goal | none | "Ensure new codemap features are coherent and especially don't break existing functionality." | Other, **by design** | the question asked for words. There is nothing to arbitrate (see C17 below) |
| Q9 already on trunk | J12 | "Landing at filing is the honest answer, the defect is already live" | Other | arbitrator maps it to "Landed at filing is fine" (C18) |
| Q10 which PR | J12 | "Merged after filing (Recommended)" | picked | unblocks |
| Q11 PR findings too | J12 | "Both, findings stay on the PR/branch page but also show as debt on the backlog page immediately if …" | label + words | arbitrator maps it to "Both". The words are a **new requirement** (see C1) |

**Decided rather than asked**, printed in the message: three lines, covering J11 (F17), J15
(F18) and J14's message half. They are a note with no effects (C5).

**Counts:** 11 answers. **0 settle**, 8 unblock, 2 have no effect (Q7, Q8), and 1 fits no
option (Q5). 5 are free text: an arbitrator could map 3 of them (Q7, Q9, Q11), Q5 fits nothing,
and Q8 is not a mapping question. The longest question object is 955 characters (Q4).

## Case 3 — this run, `2026-09-22-decision-rounds`, with codemap treated as absent

Members `codemap` and `skills`. `skills` is not a universe. Items I1–I14 are plan items, not
findings, so **no answer has a finding effect** and every decision is a plan ruling (C6).
Thirteen `AskUserQuestion` answers verify under C14. Two typed messages do not (C15).

| owner.md | answer | shape | under the plan |
|---|---|---|---|
| Opening | "Start Planning Here (Recommended)" | picked | no effects |
| Goal | "Yes, as stated" | picked | no effects |
| Where to stop | "Records + skills seam (Recommended)" | picked | no effects (C6) |
| Impossible, not visible | "Agent fills a void", "Wrong close, hidden" | multi | no effects |
| Approve six items | "For I5, yes although the finding should be verified closed by an agent other than the one that passed the answer on. All others are fine." | Other | arbitrator maps it to "Approve all six". The words are a **new requirement**, and became R1's addition |
| Sign-off question | "Ahh it can settle findings, ratifying standards we should implement a stronger mechanism…" | Other | **C20**: fits no option, and created work (the transcript check) |
| Posting | "Every batch (Recommended)" | picked | no effects |
| Approve three items | "Approve all three" | picked | see *what was shown* below |
| Protection for settles | "I'd be more worried about completion drive or errant summaries, but you do make a good case to do the transcript check now." | Other | arbitrator maps it to "Transcript check now". The first clause is a threat model, kept as words |
| Free text | "Make another agent arbitrate it" | Other | **C20**: the offered options were "echo and confirm" and "the reading closes"; this is a third |
| Relay may settle | "Yes, if verified" | picked | no effects |
| Promotion | "Sign-off only" | picked | no effects (C9 is never exercised: no case promotes) |
| Nine policy calls | "Approve all nine" | picked | all nine items are **inside** the question (1045 characters). The only bulk approval in any case that C22 lets settle |
| (typed) | "I would say just use AskUserQuestion and check that the response matches in the transcript" | typed, `origin.kind: human` | unverified (C15). It had no finding effect, so C6 lets it be relayed, and it became R10 |

**Counts:** 15 answers, **0 settle and 0 unblock** (none is a finding). 4 are Other free text.
An arbitrator could map 2 (the six-item approval and the protection question). 2 fit no option
(C20). The plan's C7 lists the free-text answers as "R2, R5, R6", which misses the six-item
approval (R1's addition).

**What was shown for the two bulk approvals.** Both asked "Approve the N items listed in my
message as a batch?", and neither message listed them.
- **Six items:** the text before that question was one status line. The six items had been
  shown one turn earlier, in the opening summary's item table and in different words, and
  I5's proposed ruling ("an agent may pass on only answers that unblock") was not in it.
- **Three items:** they existed only in a subagent's hand-back, which the owner does not see.
  The option description compressed them to one line.

`owner.md` records both lists as "the list, as shown", so **that record is a reconstruction.**
It is the errant-summary threat R5 names, found in the run that named it, and it is the exact
case C22 exists for: under C22 neither approval could settle. The owner answered the six-item
question about I5 by name, so what was approved is not in doubt here. What the record claims
was shown is.

## Verification happens where the question was asked — ruled 2026-09-23

A transcript lives only on the machine that asked, and C14 reads only the local one. Case 1 is
the ordinary shape of that, not an edge: downstream rounds are asked on the downstream team's
machines. The owner, on it:

> Correct, what needs to happen is the agent makes a codemap MCP call along the lines of
> LogQuestion that has the info about the AskUserQuestion call to durable log and confirm it.

What that changes, as the session reads it (I8e and collision 3 are to be redrafted from it; neither is yet):

- **The check runs once, at call time, on the asking machine.** The agent passes the call's
  identity (`session`, `toolUseId`). Codemap reads its own machine's transcript and confirms it
  there, under C14 and C16 as they stand.
- **What enters the log is the call itself, not a hash of it:** the questions and options as
  sent, and the answers as returned, copied from the transcript, alongside `session` and
  `toolUseId`. Every clone can then read what was asked and what was said. A `resultHash`
  alone gave a teammate nothing to read.
- **A teammate trusts the machine that logged it,** as they already trust the machine that
  took a witness hash. Hand-forging a log entry remains the residual R5 accepts.

**And the message around it (ruled 2026-09-23).** Asked whether the same call should also copy
the assistant's message text between the person's last message and the question, the owner:

> Yes that would be really good for bulk approvals

And on how the span is found:

> For message before it, probably what makes sense would be send the approval start and finish
> hunks and the codemap MCP grabs the full text out of the transcript.

What that means, as the session reads it (the details are the session's, for the owner to mark
wrong):

- **The agent sends two verbatim excerpts**, the list's first and last lines. Codemap finds them
  in the main transcript's assistant `text` blocks before the call and copies everything from the
  start of the first to the end of the last. The agent never sends the list itself, so it cannot
  paraphrase it.
- **Fails closed:** if either excerpt is not found, or the end comes before the start, the span is
  unverified. Where an excerpt occurs more than once, the occurrence nearest before the call is
  used.
- **Only what was shown:** thinking blocks are excluded, because they are not shown. A peer
  hand-back is excluded, because it is not the assistant's text and the person does not see it.
- **A bulk approval can then settle when its items are inside that span.** This relaxes C22,
  which allowed settling only for items inside the question. Case 2's Q1 qualifies: its nine
  items are the assistant text right before the call. Case 3's six-item and three-item
  approvals still do not: the span before each holds one status line. So the rule would have
  caught exactly the reconstruction found above, and let through the one list that really was
  shown.

## Marking the C-list — proposed marks, with the evidence

Only the owner's marks count, and each proposal below is the session's. **Not exercised**
means no case contains the situation, so the case cannot mark it.

| C | proposed | evidence |
|---|---|---|
| C1 | **wrong** | The rule "extra words are a note with no effect" loses a requirement three times out of three: case 1 D2 "document them", case 2 Q11 "also show as debt on the backlog page", case 3's I5 condition. Each was acted on as a requirement. Proposal: the arbitrator reports words that ask for something no option holds, and the session posts them as a new decision (C20's path). They are never silently a note |
| C2 | holds, with a gap | D3's settles are the session's reading, never the thing that closes (that holds). The gap is the new shape above: the words settle **decisions not asked**. C20 then costs a second round-trip. Owner's call: accept it, or let an arbitrator map words to any open decision in the round |
| C3 | not exercised | the correction is in the record, but not in any readable transcript |
| C4 | holds | case 2 Q1 unblocks nine items and settles none. Case 1 D3 the same |
| C5 | holds as written; **flags R4** | case 2's list decided J11, which sorter B called a **design defect** (group 2). An agent's design decision passed as a note, blocking nothing. That is R4's "agent fills a void", allowed by C5. Proposal: a "decided rather than asked" line may not cover a group 2 or 3 item. Where it does, that line is posted as a decision |
| C6 | holds | case 3 entirely, and case 2 Q7 and Q8 |
| C7 | **wrong in its count** | the free-text answers are the six-item approval and R2, R5, R6. The session's readings in `owner.md` close nothing, which holds |
| C8 | not exercised | no case has an unverified relay of a settling option: case 1 is unreadable, and cases 2 and 3 verify |
| C9 | not exercised | no case promotes to a rule |
| C10 | not exercised | no answer came after the session |
| C11 | holds | case 1: 34 of 42 findings are by number only. Case 2: all 19 |
| C12 | not exercised | nothing closed through codemap |
| C13 | holds | case 2 Q5 stayed open, the round went on, and nothing was blocked but J12 |
| C14 | **wrong in one detail** | "equal" must normalize `multiSelect` (above), or every real answer fails. The pairing, `isSidechain`, and "copied from `answers`" hold on 24 of 24 answers |
| C15 | holds | case 3's two typed messages carry `origin.kind: human` and no result |
| C16 | holds, and it was needed | case 3's three-item list existed only in a subagent hand-back |
| C17 | holds, with a gap | case 2 Q8 asks for words ("the goal, in your words"), so there is nothing to map. C17–C20 assume every decision has options. Proposal: a decision may be marked `words` (no options), and its answer is recorded, never arbitrated, and has no effects |
| C18 | holds on paper | case 2 Q9 and case 3's protection answer each map to one option on a plain reading |
| C19 | not exercised | no arbitrator was run. Nothing here shows a disagreement |
| C20 | holds | case 2 Q5 did exactly this (Q9–Q11 were posted from the words), and case 3 twice |
| C21 | not exercised | |
| C22 | **amended by ruling** | "inside the question" becomes "inside the question or the logged span before it" (above). Case 2 Q1 then verifies. Case 3's six-item and three-item approvals still do not: their items are in neither. The nine-call approval put its items inside the question, and it fit (1045 characters) |
| C23 | not exercised | no case parks |

**What changes I8 if the marks stand:** C1's words-as-requirement path, C5's group 2/3 limit,
C14's `multiSelect` normalization, and C17's `words` decision. C7 changes only the plan's text.
The first two are policy and the owner's call. The last two are mechanics.

## The owner's marks — 2026-09-23

Asked in session with `AskUserQuestion`, every item inside the question text. The answers are
verbatim.

- **C1 — wrong.** Asked what happens to words that ask for work no option holds:
  > New decision (Recommended)

  The arbitrator flags such words, and the session posts them as a new decision (C20's path). The
  picked option still applies.
- **C5 — amended.** Asked whether the "decided rather than asked" list may cover a group 2 or 3
  item:
  > If the note is bulk approved and verified asked via the transcript checking mechanism we
  > discussed, it is fine.

  *The session's reading, confirmed by the owner ("Yes your reading of C5 checks out."):* a list line covering a group 2 or 3 item stands
  only when the owner has bulk-approved the list, and the approval verifies. That means the line
  is inside the question, or inside the span its excerpts name. Otherwise the line is posted as
  a decision. Lines covering other groups stay a note, as written.
- **C2 — amended.** Asked what happens when words settle a question the round never asked:
  > Map to any open one

  The arbitrator is given every open decision in the round, not only the one asked, and may map
  the words to any of them. This settles only decisions that were posted. Case 1's V-a and V-b
  would have needed posting first.
- **Approved as a batch:**
  > Approve all six

  1. C17 gains a `words` decision kind: recorded, never arbitrated, with no effects.
  2. C14 treats a missing `multiSelect` as false.
  3. C7 counts four free-text answers in case 3.
  4. C4, C6, C11, C13, C15, C16, C18, C20 and C22 (as amended) hold.
  5. C3, C8, C9, C10, C12, C19, C21 and C23 are carried into I8 as written, each with a fixture
     test.
  6. The excerpts: the nearest match before the question is used, with no limit on how far back.

- **The logging verb.** Asked whether logging a question is its own tool or part of
  `relay_answer`:
  > Yes log question makes sense, and it should probably be the default way owner questions are
  > related to codemap.

  ("related" was corrected by the owner to "relayed".) *The session's reading:* `log_question` is its own tool, and it is how an owner's answer
  reaches codemap. It is used after every `AskUserQuestion` put to the owner when codemap is
  present. `relay_answer` keeps only unverified words, which unblock and never settle.

**Consequence for the plan.** C1, C7 and C14 are marked wrong, and C2, C5 and C17 are amended.
The in-session rulings also add a logged-question record: the call and the excerpt-named span.
The plan says a C-item marked wrong sends I8 back to a redraft, so **I8 is redrafted before
anything is built.**

## Ruled after the plan review — 2026-09-23

- **A typed reply can be verified (supersedes C15).** The owner: "Relay answer could verify words
  match too actually, the transcript covers that verification too." Asked whether it settles:
  "Settles if unambiguous, should probably grab entire user message so \"do not run the tests\"
  can't be forged as \"run the tests\"". Codemap copies the **whole** message by its entry id.
  *The session's reading of "unambiguous":* the whole message parses as a reply naming one
  decision and option. Anything more is free text, and goes to arbitration.
- **What counts as the person's words.** The owner: "queued operations are user words, subagents
  and goal messages are not"; and an accepted prompt suggestion counts ("Yes, you chose it").
  Measured: a mid-turn message and a goal message both arrive as a `queue-operation` with no
  `origin`. Only the paired `queued_command` attachment separates them: `origin.kind` is `human`
  for the person, `auto-continuation` for a goal, and `peer` for a subagent. So the person's
  words are a `type: "user"` or `queued_command` entry with `origin.kind: "human"`. A bare
  `queue-operation` never counts, and a missing origin fails closed.
- **Answers are read from `toolUseResult`, not the result's text.** The text form
  (`"question"="answer"`) breaks on a question that contains a quote mark.
- **`codemap answer` is dropped.** The owner: "answering happens either via MCP verified channels
  or the web app via the human attestation guardrail" ("Drop it (Recommended)").
- **Verification happens before the fold.** The owner: "Correct, verification needs to happen
  before it ends up in the fold."
- **A park on a date no option offered is accepted and flagged.** Asked about a typed
  `D1 park 2099-12-31`, the owner said: "If it's a valid decision it should be accepted, if
  it is errant the system should probably flag it." *The session's reading:* a verified park
  applies. The answer is flagged when the date is not one the decision offered, or when it had
  already passed on the day it was answered. It is never refused.

## The I8a review round (R20–R25) — ruled 2026-09-23

The owner's words from that round's discussion, verbatim. Plan rev 7 numbers them R20 (the
stamp, "B"), R21 (already closed), R22 (the park flag, superseded below by the views), R23
(replaced question), R24 (a sidecar is required) and R25 (no "accepted" yet).

- **Forgery:** "Yeah I am not worried about forged sidecar entries."
- **P10, a settle on a finding already closed:** "Closing an already closed finding should just
  leave it closed."
- **P2, an arbitration that maps to a park:** "Arbitration mapping to park should probably set an
  awaits you flag, agreed."
- **P9, what the downstream folds check about a stamp:** asked for the options, then "I lean
  towards B". B is the self-describing stamp: it carries what it carries out, and the fold checks
  it names this finding and the state its `as` maps to. A sign-off stamp names the operation and
  the hash of the text shown.
- **Where closes land:** asked whether items would be marked closed in the local SQLite database,
  the session answered that the close is a log event every clone folds into its own SQLite. The
  owner raised the default local sidecar ("Don't we have a local sidecar that is enabled by
  default and placed in .codemap? The long-term target was to drop local findings.") and then
  ruled: "Yes, so requiring a sidecar is fine because long-term the plan is enable it by
  default."
  - Decision records need a sidecar. "Codemap present" gains "a sidecar resolves".
  - The decision tools never create `.codemap/sidecar/` themselves: that would turn comment-push
    off, per `docs/plan-retire-local-findings.md`.
- **P4, an arbitration of an answer whose question was replaced:** "P4 - agree, just drop it".
- **"Accepted" as a settle:** "Accepted should probably be a different status, I don't like
  overloading resolved with it. We should probably overhaul finding states to include the finding
  state taxonomy I proposed the other day." And: "Agreed, finding sort overhaul should be its own
  thing." Until that overhaul, a decision settles only as `refuted`, and `accepted` is removed
  from `DecisionEffect.as`.
  - *The session's reading of "the taxonomy":* the five sort groups plus the four close outcomes.
    Reported to the owner as a reading.
- **The ending:** "Record the settled items in owner and apply the fixes you listed". The fixes:
  P1, P2 (the flag), P3, P4, P6, P7, P8, P9 (B) and P10, with `accepted` removed.

## The recovery — ruled 2026-09-23

After two review rounds landed in their own fixes, the diagnosis
(`docs/postmortems/2026-09-23-i8a-fix-round.md`) asked for the missing level to be put to the owner
as cases. These are the questions and answers, verbatim; a picked option is quoted as its label
and its description is the session's. They supersede C11 ("by number only"), R12's excerpts and
span, and C22's "or that span" relaxation.

### Session e5813f62, 2026-09-23 — planning batch 1 (the cases)

Running example: round R, question D2 "Is F14 a real defect?", options A: not a defect, close as
refuted / B: real, fix it / C: park until 2026-10-15.

- **Q1.** When you look at a round of decisions, which of these do you need to be able to see? Each
  one you pick becomes something the record answers directly; the rest stay in the log but get no
  view. Options: Waiting on me / Ruled, not carried out / Readings in dispute / Replaced questions.
  **A (picked, multi):** "Waiting on me", "Ruled, not carried out", "Readings in dispute"
  (not picked: "Replaced questions").
- **Q2.** You pick D2 A. An agent does the close, so for a while F14 is ruled on but still open.
  Today F14 is released the moment you answer and looks like any other open finding. What should
  F14 be during that period? Options: Held for the verifier / Open, ruling attached.
  **A (picked):** "Held for the verifier" — the session's description: F14 shows as "ruled
  refuted, awaiting close", not offered as open work, only a verifier acts on it; a "fix it"
  ruling still releases F14 as fix work.
- **Q3.** Some findings can close directly on your answer when the verdict was pre-validated
  (example: triage says F9 is invalid because the cited line doesn't exist; D4 offers "Agree,
  close F9 as refuted", marked to close on answer). What makes that verdict pre-validated?
  Options: A verifier re-checked it / Both sorters agreed / Either of those.
  **A (typed):** "Hmm, this would have to be for questions logged into codemap, there's no way to
  display an intent prior to an AskUserQuestion in a way codemap itself can verify. If an external
  sort posted questions to answer into codemap in unanswered state it could be done."
- **Q4.** Alice answers "sign off operation 3 of the spec"; an agent running for Bob carries it
  out. As built the sign-off is credited to Bob, the agent's principal. Whose act is carrying out
  a ruling? Options: Stays the answerer's / Answerer's agents only.
  **A (picked):** "Stays the answerer's" — the session's description: credited to Alice whoever's
  agent runs it; for a close, the agent is recorded as closer and Alice as the one who ruled.

### Session e5813f62, 2026-09-23 — planning batch 2

Before this batch the session told the owner: batch 1's Q3 answer confines the pre-staged close to
questions posted into codemap unanswered before they are asked (`postRound`), never questions
logged after the fact (`logQuestion`).

- **Q5.** So a close-on-answer option can exist only on a question an external sort posted into
  codemap, unanswered, before it was asked. On such a posted question, is the posting itself enough
  to count as pre-validation? Options: Posting is enough / Posting plus a check.
  **A (typed):** "Hmm you caught me. The whole goal of this is \"dual control\" for agents. The
  control for this is I think is two methods: 1. For fix auditors, the skill makes a role
  assertation that it's executing a skill with two blind sorts and an arbitrator, so it gets
  pre-validated decisions. A regular session needs a check even if a user answers in codemap
  because the premise the question is based off of might be flawed. Suggestion would be another
  agent needs to vet the question's action either before or after the user answers it for
  non-skill-on-clean-session decisions."
- **Q6.** A decision names findings by codemap id, so a round's question may name only findings
  already recorded in codemap; the posting agent records each first (30 triage findings → 30 in
  codemap); posting one naming an unrecorded finding is refused. Right? Options: Yes, refuse
  unrecorded / Round number + optional id.
  **A (picked):** "Yes, refuse unrecorded"
- **Q7 (goal; the session's derived wording).** "Settle what a ruling, carrying it out, and a
  finding's state are, as cases you've marked; then keep, rewrite or revert the ten frozen commits
  against them, and put the rest of the decision-rounds arc back in an order where nothing is built
  before what reads it." Options: Use it / Narrower: just the ten.
  **A (picked):** "Use it"
- **Q8.** The non-fold prefix ending at `21cb228` (I2 plus design docs). Options: Review I2, land
  I2 only / Branch pointer only / Land the whole prefix.
  **A (picked):** "Branch pointer only"

### Session e5813f62, 2026-09-23 — planning batch 3

Before this batch the session said codemap cannot see which skill is running, and that the local
transcript records the skill call. It also printed a six-item bulk list in its message; **the
owner did not see it** (see Q12).

- **Q9.** The ten frozen commits `747f7fd..c745e30`: what survives the answers is the question-text
  binding, the shape checks and the logged-question event. Options: Revert, rebuild (Recommended)
  / Rewrite on top.
  **A (typed):** "Check what all was committed first, decide what we discard based on that. A
  history rewrite to keep the good parts is likely worth it."
- **Q10.** Should this plan build I8e (the transcript module) first, before the record is rebuilt?
  Options: Yes, I8e first / Not in this plan.
  **A (typed):** "If there's a redesign here, we should take a look at the original plan and most
  likely fold the changed parts into this one, the old one is flawed."
- **Q11.** The role claim that makes a posted round pre-validated: codemap cannot see which skill
  is running. Options: Check it in the transcript / Record it as a claim / Leave to verifier plan.
  **A (typed):** "The claim would limit what the session is allowed to do after the claim is
  called and only be available from an MCP server connection that hasn't logged findings or other
  codemap actions. Not perfect, but likely good enough if the skill is the only documented
  instance of the exact call to make the claim."
- **Q12.** Approve the six items listed in my message? Options: Approve all six / Push back on some.
  **A (typed):** "Didn't see the items listed, just a narration that you were presenting them.
  (Did you present it in a block that gets summarized?)" — not a ruling; the list is re-presented.

### Session e5813f62, 2026-09-23 — planning batch 4

Before this batch the session said: three answers collide with each other or with rev 7; the bulk
list is inside the last question this time.

- **Q13.** Collision: a round may name only findings already in codemap, so the posting session
  records them first; a role claim is available only on a connection that has not yet filed
  findings or done other codemap acts. Which gives way? Options: Claim first, then file / File
  elsewhere, then claim.
  **A (typed):** "That was for the agent that does validation of questions and verifies existing
  findings, not one logging new findings. That would have to use a different pathway such as a
  bulk import from the skill file structure (which could theoretically be forged, but I am less
  worried about that)."
- **Q14.** Outside a claimed skill round a second agent must vet the question's action; that is
  the verifier, deferred to I9. Until it exists, what happens to an ordinary session's ruling?
  Options: Minimal verifier in this plan / You close by hand meanwhile / Held until I9.
  **A (picked):** "Held until I9"
- **Q15.** Is the old plan (rev 7) closed, with its unchanged rulings (R1–R25, minus what today
  supersedes) carried over as this plan's baseline? Options: Close it, carry rulings / Keep both
  plans.
  **A (typed, with the option):** "Close, carry rulings (codemap isn't managed in codemap, so no
  findings to move...)"
- **Q16 (bulk, the list inside the question):**
  1. A settle option that doesn't say how it closes is refused when posted, not defaulted to
     'refuted'.
  2. I8b (the ops) is built after today's cases and from them.
  3. Fix the stale 'not yet: untracked' line at docs/decision-rounds-next.md:30.
  4. No separate rename pass: new code uses the owner's names — the closer is the 'verifier'; the
     free-text mapper is renamed, 'reader' proposed.
  5. Every ruling code quotes is committed word for word at the doc path the code cites, in or
     before the commit that cites it. R20–R25 and today's rulings go into
     docs/decision-rounds-worked-cases.md.
  6. Replaced questions get no view: supersession stays in the log, and a replaced question's
     answer keeps what it already did.
  7. A repo in a round that has no codemap has its items asked in session and recorded in
     owner.md only, never posted as decisions.
  **A (picked):** "Approve all seven"

### Session e5813f62, 2026-09-23 — after the plan was shown

- **(unprompted, owner):** "Drop a feedback file into /working/skills that pushback items should
  become batched multi-select question groups where any that the person wants to rule on
  separately as a question gets a check. This is because I think the list above the question
  block got summarized. This also supersedes inline text capture from message approvals in the
  plan, so it kills two birds with one stone."

### Session e5813f62, 2026-09-23 — the open questions O1–O4

- **O1.** Does a verified answer's operation sign-off also wait for I9 (the verifier)? Options:
  Carries out at once (Rec.) / Waits for I9 too. **A (picked):** "Waits for I9 too"
- **O2.** Pre-validation needs "two blind sorts and an arbitrator"; `/triage-review` records "two
  sorters, one of them blind". Options: Today's sort counts / Skill changes to 2 blind.
  **A (typed):** "2 blind only applies to verifiers, they handle a higher finding load and an
  uncontaminated orchestrator would be good for that"
- **O3.** A park picked together with other options on a multi-select. Options: Refuse at posting
  (Rec.) / The park wins / Apply rest, flag park / Treat as free text.
  **A (picked):** "Refuse at posting (Rec.)"
- **O4.** Can a multi-select be submitted with nothing checked? Options: Empty submit works / Need
  a 'none' option / Not sure: add 'none'. **A (typed):** "Pretty sure you can, let's test it now"

### Session e5813f62, 2026-09-23 — marks on the session's calls (bulk, multi-select form; also the O4 test)

Each group: "Check any item you want to rule on separately; unchecked items are approved as written."
- **Group 1 (Closing):** K1 Only pre-staged close / K4 Only agreed verdicts / Hold as posting event /
  O2 reading. **A:** picked "Hold as posting event"; typed: "There's a skip button but unsure if it
  skips the whole batch, selecting none is NOT available". → K1, K4 and the O2 reading approved; the
  hold's mechanism is to be ruled on separately.
- **Group 2 (The ten):** Keep / Adapt / Discard / Rewrite mechanics. **A (typed):** "None" → all
  approved.
- **Group 3 (Other calls):** Bulk decision shape / Record + ops together / Import by PR or branch /
  §5 sentences marked. **A (typed):** "None" → all approved.

**O4, measured:** a multi-select cannot be submitted empty ("selecting none is NOT available"). The
transcript's `toolUseResult.answers` records a multi-select answer as a LIST, and typed "Other"
text is one more element of that list (e.g. `["Hold as posting event", "There's a skip button …"]`,
`["None"]`).

### Session e5813f62, 2026-09-23 — the hold's mechanism (ruled separately)

- **Q.** You ruled that a finding with a settle ruling on it is held for the verifier. Where should
  that hold be enforced? Options: Posting writes a hold / Findings read decisions / Import needs
  person-ack / Close tool refuses only.
  **A (typed):** "Epistemically correct option: don't let findings confirmed by two agents get
  closed, log two confirmations one per sort and the arbitrator if applicable. The purpose of
  allowing agents to close agent findings was if they weren't triaged first."

### The model these rulings give

- **A ruling** is the person's answer, and it stands as given whatever then happens to the finding
  (§11 of the diagnosis; R21). A finding already closed stays closed; the ruling is still recorded.
- **Carrying it out** is a separate act: the verifier's, or — only on an option a skill posted
  before it was asked, from a sort of two sorters and an arbitrator — the answer itself. Until the
  verifier exists (I9), every other settle and every sign-off is held. A carried-out act is the
  answerer's (Alice's sign-off is Alice's, whoever's agent runs it).
- **A finding's state** stays the finding record's; the decision record never stores "carried
  out". A finding a triage confirmed is not agent-closable without a stamp — the existing ratchet —
  because "the purpose of allowing agents to close agent findings was if they weren't triaged
  first."
- **Three views**, each a question the record answers: *waiting on me*, *ruled, not carried out*,
  *readings in dispute*. Replaced questions get no view.
- **Names.** The closer is the **verifier**. The agent that maps the person's free text onto options
  is the **reader** (the code's former "arbitration"); *arbitrator* is `/triage-review`'s
  tie-breaker between its sorters and nothing else.
- **Bulk approvals** are multi-select questions: each item an option, checked = ruled on
  separately, a "None — approve all" option in every group (an empty multi-select cannot be
  submitted). Every item is then inside the logged call; nothing is captured from message text.
- **The diagnosis's four sentences, as these rulings mark them:** 1 right; 2 right; 3 moot
  (effects name codemap ids, and posting a decision that names an unrecorded finding is refused);
  4 right.

## The decision-rounds-2 review round — ruled 2026-09-23

The rulings the review round `2026-09-23-decision-rounds-2-review` was planned on, verbatim from its
`owner.md`; the code cites them as B1.1–B5.4 and H1–H8. They supersede "The model these rulings
give" above in four places: there are four views (*Parked* is the fourth); a replaced question's
ruling keeps its hold, and its place under *ruled, not carried out*, until the replacement rules;
an answer that is not the person's own never displaces one that is; and every typed reply is the
reader's to bind — nothing is parsed.

> **Note (2026-09-23, the implementation review round below):** close-on-answer and the "own"
> answer class were cut, so B1.1's close path, B2.2's close half, B2.3, H1 and B5.3 lapse, and H8
> reduces to "a reader-bound typed reply is a verified answer". "Not the person's own" above now
> reads "unverified": the standing answer is ranked from the set, verified first, then the later
> given. See § "The decision-rounds-2 implementation review round".

Questions put to the owner and their answers, verbatim. A picked option is quoted as its label; its
description is the session's, not the owner's.

### Session d5793383, 2026-09-23 — opening

- **Q.** How do you want to proceed with this round? Options: Start Planning Now / Discuss First.
  **A (picked):** "Start Planning Now"

### Session d5793383, 2026-09-23 — planning batch 1

- **B1.1 (goal; the session's derived wording).** "Settle the rules the review found missing
  under the rebuild (which answer counts, what an answer may carry out, and what enforces the
  hold), then fix decision-rounds-2 against them, so the branch is stable enough to resume the
  skill work (/triage-review writing through MCP, the import) and I9." Scope point put with it:
  the close-on-answer path is latent today (nothing can post a pre-staged round). Options: Use it,
  whole round / Live paths only.
  **A (picked):** "Use it, whole round" — the session's description: rule and build everything
  now, the latent close path included.
- **B1.2 (critical; multi-select).** Which, if still possible, would stop you calling
  decision-rounds-2 stable? Each picked becomes a gating check. Options: Ruling overwritten (by an
  identical question in another round, a stale "D2 A", or an agent's unconfirmed words) / Closed
  unseen (a finding closed through a question you never saw) / Held offered as work (a finding
  you ruled "not a defect" shown to agents as ordinary fix work) / Silently vanishes (a decision
  or ruling drops out of every view).
  **A (picked, all four):** "Ruling overwritten", "Closed unseen", "Held offered as work",
  "Silently vanishes"
- **B1.3 (the hold, Q3).** Settle rulings hold a finding "not offered as open work"; you ruled the
  ratchet enforces it via confirmations the import logs; the import is unbuilt. Today
  review_queue and the findings lists still offer a held finding as ordinary work. What holds it
  until the import exists? Options: Queues skip held (Rec.) / Page only until import / Log
  confirmations now.
  **A (picked):** "Queues skip held (Rec.)" — the session's description: the agent work queues
  leave held findings out and say why; closing stays under the ratchet; this is the "findings
  read decisions" direction passed over for enforcement, used for listing only.
- **B1.4 (which question an answer belongs to, Q7 + Q9).** Cases: an identical question in round
  R2 overwrites R1's ruling; a verified "D2 A" typed for R5 can be relayed to D2 in any round,
  even one posted later. Options: One round, once (Rec.) / Newest open match.
  **A (picked):** "One round, once (Rec.)" — the session's description: an answer binds only to
  the round it was asked for and a question posted before it; each call or message answers once;
  anything else is refused; correcting yourself is answering the same question again.

### Session d5793383, 2026-09-23 — planning batch 2

- **B2.1 (unverified vs verified, Q8).** You click "Not a defect" on D1 (verified); an agent then
  relays "D1 B" the transcript cannot confirm; today the relay stands and F1 goes out as fix work.
  C8 says unverified words only unblock. Options: Verified outranks (Rec.) / Newest wins, flagged.
  **A (picked):** "Verified outranks (Rec.)" — the session's description: unconfirmed words cannot
  replace a verified answer; they are recorded and shown under "waiting on me" as a conflict; your
  own verified correction still replaces.
- **B2.2 (a reading onto a question not shown, Q4).** C2 lets the reader map words onto any open
  question in the round; a close-on-answer option fires only after its question was asked. Words
  on D1 are mapped onto pre-staged D2 "Agree, close F2 as refuted", never shown; today F2 closes.
  Options: Rules, but held (Rec.) / Closes too.
  **A (picked):** "Rules, but held (Rec.)" — the session's description: D2 counts as ruled and F2
  is held for the verifier like any settle; only your own verified answer to D2 itself closes on
  answer.
- **B2.3 (close once, Q5 + Q6).** Cases: a reopened F9 re-closed by an unrelated reading; an answer
  recorded, the op crashes before the close, and the retry is dropped as a duplicate. Proposed:
  each (answer, finding) close carried out at most once, and retried until done. Options: Once,
  retried (Rec.) / Once, then verifier.
  **A (picked):** "Once, retried (Rec.)" — the session's description: a close that happened never
  happens again, even after a reopen; one that has not happened is retried on the next call or
  reading until it lands.
- **B2.4 (a replaced question's ruling, Q1).** D1 answered "Not a defect" (F1 held, not closed);
  D1b posted replacing D1; today the D1 ruling drops out and F1 is only undecided under D1b.
  Options: Holds till D1b answered (Rec.) / Holds regardless / Replacement releases.
  **A (picked):** "Holds till D1b answered (Rec.)" — the session's description: F1 stays held under
  the D1 ruling; when D1b is answered its answer takes over ("Real, fix it" releases F1 as fix
  work).

### Session d5793383, 2026-09-23 — planning batch 3

- **B3.1 (park words, Q19).** The I8a ruling "Arbitration mapping to park should probably set an
  awaits you flag, agreed" is built for unverified parks only; verified words read as a park apply
  directly. Did the ruling mean verified words too? Options: Yes, wait for me / No, verified
  applies.
  **A (typed):** "Probably makes sense to have a separate park queue where I can still see parked
  issues. If the phrasing is ambiguous per the verifier agent, it shouldn't park."
- **B3.2 (reader id, Q10).** record_reading takes the reader's transcript id as given; deferred to
  I9 by the recovery plan. Options: Check it now (Rec.) / Leave for I9.
  **A (typed):** "Would probably have to think this through, not sure how feasible it is to detect
  subagent separation. We should check it."
- **B3.3 (bulk 1).** (1) a held finding stops showing as held once closed; (2) an answer that rules
  nothing keeps its decision under "waiting on me"; (3) a park whose date passes comes back under
  "waiting on me", its findings held as undecided until answered; (4) a follow-up to a reading's
  copy attaches to that decision; (5) a decisions scope with a broken sidecar reads as blocked and
  writes on it refuse; (6) a person's close of an already-closed finding leaves it closed with its
  first reason (R21); (7) the finding lookup goes through the store and refuses an ambiguous id.
  Options: Approve all as written / Rule on some separately.
  **A (picked):** "Approve all as written"
- **B3.4 (bulk 2).** (8) posting refuses duplicate decision ids in a round and duplicate option
  labels in a decision — both sites fixed, not a missing rule; (9) posting refuses two decisions
  replacing the same question; (10) a decision may name only a finding published to the sidecar.
  Options: Approve all as written / Rule on some separately.
  **A (picked):** "Approve all as written"

### Session d5793383, 2026-09-23 — confirming the typed answers

- **B4.1 (park).** The session's reading of B3.1: (a) a fourth view, "Parked", lists every parked
  decision with its date; (b) words read as a park apply only when the reading is unambiguous,
  otherwise nothing parks and the decision stays under "waiting on me"; (c) when the date passes it
  leaves "Parked" and returns to "waiting on me". Who judges ambiguity? Options: Reader judges
  (Rec.) / Verifier judges (I9).
  **A (picked):** "Reader judges (Rec.)" — the session's description: ambiguous unless the reader
  and the session map the words to the same park; parks from words can happen before I9.
- **B4.2 (reader id).** Proposed: measure first what a reader subagent leaves on this machine that
  the relaying session cannot produce; build the check if it separates them; otherwise stop and
  bring it back rather than build a weaker one. Options: Measure, then build (Rec.) / Build best
  effort.
  **A (picked):** "Measure, then build (Rec.)"

### Session d5793383, 2026-09-23 — after the coherence check

- **B5.1 (a replaced question's view).** Keeping B2.4's hold visible lists the replaced D1 under
  "ruled, not carried out" until D1b is answered, against Q16.6 "replaced questions get no view".
  Options: Override for that view (Rec.) / Show it under D1b.
  **A (picked):** "Override for that view (Rec.)" — Q16.6 is **superseded for that one view only**;
  the rest of Q16.6 (no other view, supersession stays in the log) stands.
- **B5.2 (catalogue lists).** Options: Mark in catalogues (Rec.) / Drop from all lists.
  **A (picked):** "Mark in catalogues (Rec.)" — refines B1.3: work queues drop held findings; the
  `findings` and `shared_findings` catalogues mark them `held`.
- **B5.3 (bulk item 6's scope).** Options: Decision closes only (Rec.) / Every close.
  **A (picked):** "Decision closes only (Rec.)" — narrows B3.3 item 6 to closes that carry out a
  ruling.
- **B5.4 (typed reply round).** Options: Refuse if ambiguous (Rec.) / Latest round wins.
  **A (picked):** "Refuse if ambiguous (Rec.)" — the session's description: more than one open
  round with that ref when typed → refused, name the round ("R5 D2 A"); only one → binds there.
  **Superseded by H5** (every typed reply is bound by the reader); nothing of it still stands.

### Session d5793383, 2026-09-23 — after the plan was shown

- **(the plan's two remaining details: `log_question` takes a required `round`; re-asking a
  replaced question replaces its replacement, so the chain stays linear.)**
  **A (typed):** "These both make sense, record as decided."
- **(unprompted, owner):** "Since this plan is the second round of deciding assumptions that were
  caught in review, let's review the plan for hidden assumptions an implementing agent would have to
  make."

### Session d5793383, 2026-09-23 — hidden-assumption review of the plan, batch 1

Two independent readers (a fresh Opus agent, and Codex on gpt-6-astra) plus the session's own
self-check reviewed `plan.md` for decisions an implementer would have to make. Questions from it:

- **H1 (a close that never landed, then a reopen).** Answer to pre-staged D2 "close F9 as refuted";
  a teammate's clone already closed F9 as invalid, so the close did nothing; later F9 is reopened.
  Does "retry until it lands" re-close it? Options: Reopen wins (Rec.) / Retry closes it.
  **A (picked):** "Reopen wins (Rec.)"
- **H2 (how a typed reply identifies its question).** Refs restart at D1 per round; "open" is
  undefined. Options: Unique refs (Rec.) / Round-qualified / Latest round only.
  **A (typed):** "Both 1 and 2 will likely fail due to collisions across different team members,
  it has to be scoped to a round, perhaps the question should just say \"Close D13
  (f_09deadcafef3)?\""
- **H3 (free text with no ref).** Codemap verifies the words, not which question they answered.
  Options: Shown just before (Rec.) / Agent's word, flagged / Not via typed text.
  **A (typed):** "agent should relay context, reader decides if it is unclear and should be
  escalated"
- **H4 (a replacement naming fewer findings).** D1 settles F1, F2; D1b replaces it asking only
  about F1, answered "Real, fix F1". Options: Per finding (Rec.) / Whole question / Refuse it.
  **A (picked):** "Per finding (Rec.)"

### Session d5793383, 2026-09-23 — hidden-assumption review, batch 2

- **H5 (the typed-reply model, confirming H2 + H3).** The session's reading: refs stay per round and
  every question shown carries what it acts on ("Close D13 (f_09deadcafef3)?"); relay_answer sends
  the whole message plus the context the agent says it answered (round and question); the reader
  decides which question the words answer, checking that context against what the transcript shows
  the session said just before the message; unclear → escalated to "waiting on me", nothing binds.
  Open point: does a bare "D13 A" skip the reader? Options: Reader binds all (Rec.) / Parse if
  unambiguous.
  **A (picked):** "Reader binds all (Rec.)" — every typed reply goes through the reader.
  **Supersedes B5.4** ("Refuse if ambiguous", "R5 D2 A") entirely, and the typed-reply half of
  B1.4's mechanism; B1.4's rule (the round it was asked for, a question posted before it, once)
  stands, now judged by the reader against the transcript.
- **H6 (bulk A, items 1–8)** and **H7 (bulk B, items 9–15)**, as put in the question text:
  (1) a crashed logged call records its missing answers on retry; "answers once" is per call and
  question; (2) only a verified answer on a replacement ends a verified hold its predecessor left;
  (3) a hold passes along a replacement chain until a later one answers; (4) of two concurrent
  replacements the first in log order replaces, the second stays live and is listed under "waiting
  on me" as a conflicting replacement; (5) parked decisions are not in "waiting on me", unread free
  text waits on an agent, Q11's "rules nothing" means read and ruled nothing; (6) a park holds
  through its whole date, by UTC date; (7) "Other" text mapped by the reader to a close option is
  ruled but held; (8) an unconfirmed answer picking the same option is not a conflict, and a
  conflicting unconfirmed free-text answer is not sent to the reader; (9) between two verified
  answers, the later by when given wins; (10) an answer's time is its transcript entry's or the
  page click's, against the round's posting time, no skew allowance, a refusal states both;
  (11) "carried out once" is recorded by the findings fold (applied closes per answer; a second
  close from the same answer is ignored); (12) no migration — events lacking the new fields are
  dropped, the bump rebuilds; (13) `findings` marks held findings, `shared_findings queue:true`
  marks them, only review_queue's assigned-work list drops them; (14) a blocked decisions scope
  makes the work queue refuse with the diagnostic and catalogues mark hold status "unknown";
  (15) an explicit assignment of a held finding wins, marked held.
  **A (both picked):** "Approve all as written"
- **Supersedes, in part, B5.2's application:** `shared_findings queue:true` was listed in the plan
  as dropping held findings; item 13 corrects it to marking. B5.2's rule (work queues drop,
  catalogues mark) stands.

### Session d5793383, 2026-09-23 — second coherence check

- **H8 (is a reader-bound typed reply the person's own answer?).** The plan had inferred, unruled,
  that a typed reply never closes on answer. You type "D13 A"; the reader binds it to D13 against
  the transcript. Options: Own answer after P7 / Own answer now / A reading, held.
  **A (picked):** "Own answer after P7" — the session's description: it is the person's own
  verified answer (verified for precedence, can end a replaced question's hold, closes a pre-staged
  option) once the reader's independence is checked (P7 passes); until then, or if P7 fails, it is
  ruled but held.

### What a reader subagent leaves on this machine — measured 2026-09-23 (P7 step 1)

A reader launched as a background `Agent` from the session that relays the words (Claude Code, this
machine, session `0ff94697…`), asked to reply with one line and use no tools:

- **Its transcript** is `<project>/<session>/subagents/agent-<agentId>.jsonl` — beside the
  session's own `<session>.jsonl`, never at the top level — with `agent-<agentId>.meta.json`
  holding `agentType`, `description`, `toolUseId` (the parent's `Agent` call), `spawnDepth`,
  `requestShape`, `model`.
- **Every entry** carries `isSidechain: true`, `agentId: <agentId>` and `sessionId: <parent session>`.
- **The agent id** is a 17-character `a…` string (`a263b7e5098218522`).
- **The parent's transcript** records the launch — an assistant `tool_use` named `Agent`, then a
  `tool_result` whose `toolUseResult` holds `isAsync`, `status: "async_launched"`, `agentId`,
  `resolvedModel` and the prompt — and the result: a `queued_command` attachment whose
  `origin` is `{kind: "peer", from: <agentId>, senderTaskId, body: <the report>, handback: true}`,
  then a `task-notification`.
- **Could the relaying session produce these itself?** Not through the harness: all of the above
  is written by Claude Code, not by the model, and the entries cross-reference (the meta file's
  `toolUseId` is the parent's call; the result names the `agentId`; the sidechain entries carry it).
  **But every one is an ordinary file the session can write** with its shell or file tools — the
  transcript files are mode 0600 and owned by the same user. Nothing in them is signed. That is the
  same strength as every other transcript check codemap makes (C14: the person's own message is a
  line in the same file), and no stronger.


### Session 0ff94697, 2026-09-23 — the P7 gate

- **Q.** A reader subagent leaves harness-written artifacts that cross-reference each other, all of
  them plain same-user files the relaying session could write, none signed: exactly C14's strength.
  Does it pass the gate? Options: Passes, at C14's bar (Rec.) / Fails: forgeable / Discuss first.
  **A (picked):** "Passes, at C14's bar (Rec.)" — the session's description: build step 2;
  `record_reading` requires `reader.transcript` to be a subagent of this machine whose files
  cross-reference and contain the reading, and refuses anything else; a typed reply the reader
  binds then becomes the person's own answer (H8).
- **(unprompted, owner, while step 2 was being built):** "If an agent is writing fake transcripts,
  it has gone off the rails and ideally auto mode would stop it." — forgery is outside what this
  check defends against; it guards honest mistakes, like every transcript check.

## The decision-rounds-2 implementation review round — ruled 2026-09-23

The rulings the review round `2026-09-23-decision-rounds-2-impl-review` was planned and built on,
verbatim from its `owner.md`; the code cites them as P1.1–P4.1 and S0.1–S0.8. Where they and the
sections above disagree, these win: close-on-answer and the "own" class are gone; which answer
stands is derived from the set (verified first, then the later given, then log order); words
that may overturn a ruling flag it until bound or outranked; the reader's verdict is parsed by
codemap from the reader's own hand-back; and a person's assignment keeps a held finding on the
work queue only when made after the latest hold on it began. The plan is
`.git/triage/2026-09-23-decision-rounds-2-impl-review/plan.md`; the hidden-assumption readers'
reports are `step0-claude.md` and `step0-codex.md` beside it.

Questions put to the owner and their answers, verbatim. A picked option is quoted as its label; its
description is the session's, not the owner's.

### Session 21f9988f, 2026-09-23 — the discussion (Discuss First)

What the discussion settled, the owner's words verbatim; the session's readings between them are
marked as the session's.

- **(unprompted, owner):** "This will now be round 3 of fixes. What I am curious about is if we need
  to break the frame here. I'm starting to wonder if we should cut the whole pre-approved decision
  action thing and send everything through a reader agent."
- *(session's reading: the "pre-approved" path is `closesOnAnswer`; unreachable today — `post_round`
  refuses it and no skill posts rounds; H8's "own" class exists only for it; cutting it dissolves
  Q1–Q3 and lowers Q6–Q8's stakes, leaves ~13 items untouched; the session pushed back on routing
  clicks through a reader — the uniformity comes from dropping "own", typed words stay the
  reader's per H5.)*
- **(owner):** "Okay so it sounds like closesOnAnswer isn't the source of most of the issues. It
  sounds like most of our issues are with conflict resolution and marking items on hold for a
  decision."
- *(session's reading: mostly; close-on-answer is the source of the deepest conflict items (Q1–Q3)
  though not most by count; the reader check is its own cluster; holds are the largest cluster —
  B1.3's stopgap computed at three read doors — and a higher-order fix is one function answering
  "held / not held / unknown (blocked)" that every surface asks. Proposed four parts: answers (drop
  close-on-answer and "own"; verified over unverified, later-given between verified; Q4, Q5 on
  their own), the reader check at lower stakes, holds through one door with Q15 ruled on its own,
  the rest mechanical.)*
- **(owner):** "This framing makes sense, in my mind close-on-answer is probably not going to be
  used a lot because most closing happens in-session where annotations can't be assured without
  another reader agent anyways."
  **Settled:** close-on-answer is cut, and the "own" answer class with it. Ranking: verified
  outranks unverified; between verified, the later given (H7.9). Every settle waits for the
  verifier (I9) or an in-session close. Supersedes B1.1's "whole round" for the close path; B2.3,
  H1, B5.3 and B2.2's "only your own verified answer to D2 itself closes on answer" half lapse with
  it; H8 reduces to "a reader-bound typed reply is a verified answer" (its "closes a pre-staged
  option" part lapses; the rest stands, re-keyed on verified).
- **(owner):** "I think we're good to plan now" — the discussion ends in planning here.

### Session 21f9988f, 2026-09-23 — planning batch 1

- **P1.1 (goal and critical).** "Goal (my wording, correct it if wrong): \"Cut close-on-answer and
  the own answer class; settle what the reader check must contain and who keeps a held finding on
  the queue; answer every hold through one function that all surfaces ask; fix the rest — so
  decision-rounds-2 is stable enough to resume the skill work (/triage-review writing through MCP,
  the import) and I9.\" The gates from last round stay critical: a ruling overwritten, a finding
  closed unseen, a held finding offered as work, a decision silently vanishing. Keep this goal and
  these four gates?" Options: Keep both (Rec.) / Change the goal / Change the gates.
  **A (picked):** "Keep both (Rec.)"
- **P1.2 (what the reader must have said — Q6).** "What must a reader have said for its binding to
  count? Today codemap checks only that the reading text the session passes appears somewhere in
  the reader's messages — an empty reading passes — and the mapping that actually binds (\"D1 → Real,
  fix it\") comes from the session and is never compared with the reader. Reproduced: the reader
  said \"D1 -> Real, fix it\", the session passed \"Not a defect\" and it bound." Options: Codemap
  takes it (Rec.) — the session's description: the reader ends with its mapping in a fixed form,
  codemap reads it from the reader's own last message, the session no longer supplies it / Session
  passes, checked — the session's description: the session passes the mapping, codemap refuses
  unless each pair appears verbatim in what the reader said.
  **A (typed):** "Am a little confused by this. The reader's job is to make sure an agent requested
  action matches with what a user said to do. For a pre-proposed action, one additional reader is
  fine. For agent-only actions like auto-closure we probably need something like two sorts +
  arbitrator."
  *(Not yet settled: the form in which codemap sees the reader's verdict is re-asked in batch 2.
  "Agent-only actions like auto-closure … two sorts + arbitrator" is outside this round —
  close-on-answer is cut — and is carried to I9, the verifier.)*
- **P1.3 (which reader counts — Q7, Q8).** "Which reader counts, beyond being a real subagent on
  this machine? The honest mistake today: a session reuses an earlier reader (from another answer,
  or before the words were typed), or the agent that relayed the words also reads them — the guard
  meant to stop that now compares an agent id with session ids and can never fail." Options: Fresh,
  after the words (Rec.) — the session's description: launched from the session the words were
  typed in, after the relay was recorded, not itself the relayer / Any real subagent — today's rule,
  dead guard removed.
  **A (typed):** "Any subagent after the text was submitted."
- **P1.4 (held and assigned — Q15).** "A decision holds finding F (you ruled it, or it's still
  undecided), so the agent work queue should not hand F out. But if a person assigned F, it stays
  on the queue, marked held. Today any person's assignment counts, made at any time — and
  assignments only come from the page, so nearly every queued finding was person-assigned and the
  hold almost never removes anything. Reproduced: you assign F as \"fix\", then rule \"Not a
  defect\"; agents still get F as fix work. Which assignment should keep a held finding queued?"
  Options: Assigned while held (Rec.) / Never, while held / Any person, any time.
  **A (picked):** "Assigned while held (Rec.)" — the session's description: only a person's
  assignment made after the hold began (the decision posted, or the ruling) keeps it queued,
  marked held; an earlier one is withheld and the queue says so.

### Session 21f9988f, 2026-09-23 — planning batch 2

- **P2.1 (the reader's verdict — Q6, re-asked).** "Rephrasing the reader question, since I muddled
  it. It's working the way you describe: the agent requests an action (\"your words mean D1 → Real,
  fix it\"), a reader checks it against what you typed, and it binds only if they match. Under your
  earlier rule C17 the reader is blind: it gets your words and the question, not the agent's
  request, states its own mapping, and codemap compares the two. The hole is only the last step:
  codemap never looks at what the reader said. The session reports the reader's mapping itself, so
  a mis-copy binds. How should codemap get the reader's verdict?" Options: Blind, read by codemap
  (Rec.) / Confirms request, by codemap.
  **A (picked):** "Blind, read by codemap (Rec.)" — the session's description: C17 kept; the reader
  ends with its mapping in a fixed line ("D1 → <label>" or "unclear: <why>"); codemap reads that
  line from the reader's own transcript and compares it with the agent's request.
- **P2.2 (a blocked log and the work queue — Q14).** "When the decisions log can't be read (for
  example a corrupt shard, which can't be acknowledged away), codemap can't tell which findings
  are held. Your ruling H7.14 made the agent work queue refuse outright, so a universe's queue stays
  empty until someone repairs the sidecar. It could instead fall back to the last decisions it
  successfully read: hand out findings no stored decision names, withhold the named ones as
  \"held: unknown\", and say the log is blocked." Options: Keep refusing / Serve the rest.
  **A (picked):** "Keep refusing" — H7.14 stands.
- **P2.3 (given before a replacement, recorded after — Q4).** "You answer D1 at 10:02. At 10:03
  another agent posts D1b, which replaces D1. At 10:04 your 10:02 answer is logged. Today it is
  dropped: D1 shows no answer, F1 only shows as undecided under D1b, and nothing tells you. (Had it
  been logged at 10:02, your ruling would hold F1 until D1b was answered.) How should an answer be
  judged when it was given before the replacement but recorded after?" Options: By when given
  (Rec.) / Dropped, but shown.
  **A (picked):** "By when given (Rec.)" — it counts on D1 as though logged when given; B2.4 applies.
- **P2.4 (one call, two rounds — Q18).** "One AskUserQuestion call can carry up to four questions,
  and an agent could ask D1 from round R1 and D3 from round R2 in the same call. Your ruling
  requires log_question to name one round, so the second round's answer can't be recorded and is
  lost. Whether agents actually mix rounds is not known." Options: Name each round (Rec.) / One
  round per call.
  **A (picked):** "Name each round (Rec.)" — the session's description: log_question takes every
  round the call asked; each question binds in the named round whose posted text it matches
  exactly; a question matching two named rounds is refused. Amends the "required `round`" ruling
  (after the plan was shown, session d5793383) to "required, one or more".

### Session 21f9988f, 2026-09-23 — planning batch 3

- **P3.1 (bulk A).** "Smaller rulings, approve or pick some out. (1) The dead reader-is-not-relayer
  guard is removed, not repaired; the reader must instead be launched after your words were typed
  (your \"any subagent after the text was submitted\"). (2) An unconfirmed agent answer arriving
  after your verified ruling can't be read, so it can't be told apart from agreement: \"waiting on
  me\" shows it as \"an unconfirmed answer arrived after your ruling: <words>\" instead of
  \"disagrees\". (3) A finding id that exists under two review keys: a hold on it applies to both
  rows, on every surface. (4) When the decisions log is blocked, the decisions page shows every
  empty list as \"unknown — the log can't be read\" and hides the answer controls (answering
  refuses on a blocked log anyway)." Options: Approve all as written / Rule on some separately.
  **A (picked):** "Approve all as written"
- **P3.2 (bulk B).** "Mechanical fixes, approve or pick some out. (5) All three web findings pages
  show a held finding's mark and \"held: unknown\" (today none do, so held work looks free on the
  web). (6) Inside the one hold function: a missing sidecar or decisions folder reads as
  \"unknown\" when this store has read decisions from a sidecar before, and as \"no holds\" only
  when it never has (today it always says \"no holds\", so held findings go back on the queue).
  (7) The decisions page's two reads show stored rows marked blocked when the sidecar binding is
  broken, instead of refusing, like every other read. (8) Today's date is computed once per
  response, so a park can't drop out of both views at midnight UTC." Options: Approve all as
  written / Rule on some separately.
  **A (picked):** "Approve all as written"
- **P3.3 (done means).** "This is the third round where most findings sat in the previous round's
  own fixes. What must be true before you'd call this round's implementation done?" Options:
  Reproducers + run the fold / Also a plan-assumption pass — the session's description: the
  above, plus an independent hidden-assumption review of this plan before anyone builds it.
  **A (picked):** "Also a plan-assumption pass"

### Session 21f9988f, 2026-09-23 — planning batch 4

- **P4.1 (unread words after a ruling).** "With the own class gone, a typed reply counts as a
  verified answer, and the later-given verified answer wins. But a typed reply only means something
  once a reader has bound it to an option. Case: you click \"Not a defect\" on D1 at 10:00. At 10:05
  you type \"D1 — hmm, not sure anymore\". The reader either hasn't read it yet, or reads it as
  unclear. Which stands on D1? (Either way F1 stays held; the difference is whether your 10:00
  ruling still shows as the ruling. I'll also compute the standing answer from all answers when
  it's read, so recording order stops mattering.)" Options: Click stands (Rec.) — the session's
  description: typed words compete only once a reader binds them, then by when typed; unread or
  unclear words never displace a ruling and show under "waiting on me" beside it / Words reopen it.
  **A (typed):** "Possibly superseeded items stay as described, but are flagged when read in the
  web interface and by an agent as being possibly superseded. An agent can ask the user to confirm
  a read via AskUserQuestion and post it back to codemap to get the read approved, avoiding a stale
  response misdirecting a session."
  *(The session's reading, for the owner to mark wrong: the ruling stands; while verified typed
  words given after it are unread, unclear or in dispute, the decision — and every hold it
  places — carries a "possibly superseded" flag on every web and agent read; the flag clears when
  a later verified answer to that decision is recorded. How the agent's confirmation is posted
  back is not settled: see the plan's open detail.)*

### Session 21f9988f, 2026-09-23 — after the plan was shown (the four Step 0 points)

The session listed four points for Step 0; the owner answered them directly, numbered as listed:

1. **(confirming a reading)** "Confirming a reading: how an agent posts back your confirmation.
   Either it re-asks the question and logs it, or a new \"confirm this reading\" question is built.
   The choice decides which time the answer stands at."
   **A (typed):** "a new \"confirm this reading\" question is built"
2. **(the flag's reach)** "you said \"flagged when read in the web interface and by an agent\".
   Extending that to every hold the decision places, and the rule for when it clears, are my
   reading of your words."
   **A (typed):** "Sounds good"
3. **(`prevalidated`)** "whether this round data stays for the import, now that it can no longer
   close anything."
   **A (typed):** "probably, because it would likely control the level of reader agent time is
   needed for subsequent processing"
4. **(relay guards)** "two smaller relayer guards go with the dead one. That follows from \"any
   subagent\" but wasn't asked."
   **A (typed):** "seems reasonable"

### Session 21f9988f, 2026-09-23 — the confirm-this-reading question's shape

The session listed three open points; the owner answered each, quoted with the point:

- **"What it offers you, and what \"no\" does."**
  **A (typed):** "Probably a yes/no/other question. Yes takes the agent's read. No drops the read
  from the record. Other allows the user to type their own read of the question. An action proposed
  would need to be formatted in a particular way in the question for it to be directly authorized
  by the question."
  *(The session's reading, for the owner to mark wrong: after "No" the words rule nothing and the
  flag clears — the words are not put back as unread, which would re-flag them; "Other" text is the
  person's words in a logged call and goes to the reader like any typed reply (H5, H7.7).)*
- **"An unclear reading has no mapping to confirm. My proposal is that the agent re-asks the
  original question instead."**
  **A (typed):** "Agreed"
- **"A disputed reading could offer the two readings as the options, the way C19's re-ask does."**
  **A (typed):** "Also agree with this"

### Session 21f9988f, 2026-09-23 — what "No" does on a confirm-this-reading question

- **(the session asked whether, after "No", the words rule nothing and the flag clears, or go back
  to unread.)**
  **A (typed):** "Unread would be a little odd, but then again so is dropping the reading. Need to
  think through the consequences of that. A practical instance is the user might realize what they
  originally said makes no sense, that would make them want to drop the answer as a ruling. But
  without entering a new one, it would revert precedent to whatever the old ruling was, which may
  not be correct either. I'm leaning towards the user has to provide a replacement ruling."
- *(Session: until a replacement, the old ruling stands, flagged, the rejected reading recorded so
  it is not re-offered; the replacement is an ordinary later verified answer and clears the flag;
  proposed collecting it by re-asking the original decision (two steps) or listing its options in
  the confirm question (one step, at most four options).)*
  **A (typed):** "I'm thinking the user can enter different text under other, if the agent wants
  it to immediately authorize something, it would need to ask a specially formatted question as a
  second turn."
- *(Session: the confirm question states the formatted action; **Yes** authorizes exactly it;
  **Other** is the person's own words, read by a reader like any typed reply, a verified answer at
  its typed time that authorizes nothing directly — a direct authorization needs a second,
  formatted confirm question; until replaced the old ruling stands, flagged, with the rejected
  reading attached. `AskUserQuestion` needs at least two options, so the second is **"No — ask me
  again"**: no text, the agent re-asks the original decision as a second turn.)*
  **A (typed):** "Yes that seems reasonable."
  **Settled** as the session stated it. Supersedes, in the confirm-question ruling above, "No drops
  the read from the record"; the rest of that answer (yes/no/other, Yes takes the read, Other types
  their own, a formatted action) stands.

### Session ad2a3664, 2026-09-23 — Step 0 (hidden-assumption pass)

Two independent readers ran on the plan at `49957dc`: a fresh Claude subagent (`step0-claude.md`,
S1–S15) and Codex gpt-6-astra (`step0-codex.md`, HA-01–HA-09). Their false code facts and the
corrections that follow from standing rulings were applied to the plan without a question (listed
there under *Step 0 corrections*). The owner ruled the rest, each question quoted with its answer.

### Batch 1

- **S0.1 (S1 — whose reading a confirm asks about).** "You click \"Not a defect\" on D1 at 10:00. At
  10:05 you type \"D1 actually it's real\". Nothing has read those words yet, so D1 is flagged
  possibly superseded. The confirm question asks \"is this reading what you meant?\", but no reader
  has produced a reading to confirm. Whose reading goes in the question?" Options: Agent's own (Rec.)
  — the session's description: the agent puts its own reading in the formatted question; your Yes
  binds it at 10:05, and no reader runs; a second way for typed words to bind without the reader /
  Reader first.
  **A (picked):** "Agent's own (Rec.)"
- **S0.2 (S2, HA-07 — how a confirm is kept).** "How is a confirm question kept in the log? Case: two
  flagged messages on D13, \"hmm\" at 10:05 and \"no, it's real\" at 10:07. The example text \"D13 →
  Not a defect (settles f_…)\" doesn't say which of the two messages it confirms." Options: Derived,
  names words (Rec.) — the session's description: codemap computes the text and posts nothing:
  \"D13, your words at 10:07 → Real, fix it (unblocks f_…)\"; your logged answer is the only record,
  and Yes binds at 10:07; the confirm holds no findings and never lists as unanswered; if the same
  words are confirmed twice with different readings, the later confirmation wins / Posted as a decision.
  **A (picked):** "Derived, names words (Rec.)"

  > **Note (2026-09-23, the second implementation review round below):** superseded. The confirm
  > is now a POSTED decision in the words' own round, answered through `log_question`, which holds
  > the findings its readings act on and waits on you while open; "Other" on it is words read by a
  > reader, not a typed answer on the original decision. See § "The decision-rounds-2
  > implementation review round 2".
- **S0.3 (S4, HA-03 — a reading onto an answered decision).** "D2 was ruled \"Real, fix it\" by a
  click at 10:00. At 10:05 you type \"actually D2 is not a defect\", but the agent relays it against
  D1. The reader correctly maps it to D2. Today the fold refuses this because D2 already has an answer
  (C2's rule), and whether it refuses also depends on the order the events were recorded in. What
  should happen?" Options: Admit, ranked (Rec.) — the session's description: a verified answer on D2,
  given at 10:05, becomes D2's ruling; recording order stops mattering / Refuse, flag D2.
  **A (picked):** "Admit, ranked (Rec.)"
- **S0.4 (S5, HA-02, HA-05 — when a hold began).** "Which assignment keeps a held finding on the work
  queue? D1 is posted at 10:00. At 10:02 you answer \"Real, fix it\", which releases F1 as fix work,
  and at 10:05 you assign F1 as fix. At 10:10 your typed correction binds \"Not a defect\", so F1 is
  held again. Measured from D1's posting, your 10:05 assignment counts as \"after the hold began\", and
  F1 stays on the queue as fix work under a \"Not a defect\" ruling." Options: Latest current hold
  (Rec.) — the session's description: each hold on F1 starts when it last became a hold for F1 (its
  posting, or the answer that re-held it); with several holds, the latest start counts; a person's
  assignment must come after it / Earliest posting.
  **A (picked):** "Latest current hold (Rec.)"

### Batch 2

- **S0.5 (S3 — what ranks).** "Which verified answers enter the \"later given wins\" ranking? Case:
  you click \"Not a defect\" on D1 at 10:00, then pick \"Park until 2026-10-01\" on the page at 10:05.
  A second case: at 10:05 you type \"forget D1\", and the reader reads it as ruling no option."
  Options: Any verified act (Rec.) — the session's description: picks, parks, bulk answers, and words
  read as ruling nothing all rank by when given; only unread, unclear or disputed words stay outside
  the ranking and flag the decision; two answers given at the same moment are ordered by the log /
  Picks only.
  **A (picked):** "Any verified act (Rec.)"
- **S0.6 (S10 — the findings fold's stamped close).** "The findings fold lets an agent close a finding
  a person stood behind, as long as the close carries a decision stamp. The fold never checks the
  stamp against the decisions record. Once close-on-answer is cut, nothing writes a stamp, but the
  bypass was also meant for the verifier (I9), and its once-per-answer guard (settledBy) goes in this
  plan." Options: Remove it now (Rec.) — remove the bypass and closeStampFor; I9 adds its own close
  path under its own ruling / Keep for I9.
  **A (picked):** "Remove it now (Rec.)"
- **S0.7 (S11 — stored readings).** "Readings already stored on this branch hold the mapping the
  SESSION passed in, not one read from the reader … Once codemap reads the verdict itself, what
  happens to those stored readings?" Options: Drop them (Rec.) — the session's description: readings
  without the new verdict are ignored (H7.12's rule); typed replies they bound go back to unread and
  show flagged; old closesOnAnswer fields on posted decisions are ignored, not dropped / Keep them.
  **A (picked):** "Drop them (Rec.)"
- **S0.8 (bulk — S6, S8, S9/HA-04, S12, S13).** The question listed (a)–(e) verbatim as they now stand
  in the plan's *Step 0 rulings* section. Options: Approve all as written / Rule on some separately.
  **A (picked):** "Approve all as written"

## The decision-rounds-2 implementation review round 2 — ruled 2026-09-23

The rulings the review round `2026-09-23-decision-rounds-2-impl-2-review` was planned and built on,
verbatim from its `owner.md`; the code cites them as P1.1–P3.5 and "the discussion". Where they and
the sections above disagree, these win: the confirm-this-reading question is a posted decision
(S0.2 is superseded); a reading the fold rejects never counted; words typed on a question before it
was replaced are read on it until its replacement rules; codemap writes the reader's brief. The plan
is `.git/triage/2026-09-23-decision-rounds-2-impl-2-review/plan.md`.

Questions put to the owner and their answers, verbatim. A picked option is quoted as its label; its
description is the session's, not the owner's. The route questions are in that record's `sort.md`.

### Session f75a592d, 2026-09-23 — the opening (ez-plan, --round)

- **Q.** How do you want to proceed with this round? Options: Discuss First (Rec.) / Start
  Planning Here / Plan Later in a New Session.
  **A (picked):** "Discuss First (Rec.)"

### Session f75a592d, 2026-09-23 — the discussion (Discuss First)

What the discussion settled, the owner's words verbatim; the session's readings between them are
marked as the session's.

- *(session: the confirm question's fragility comes from S0.2's choice to derive it and recognise it
  by its text; offered three directions — patch it, post it as a real decision of a dedicated kind
  that holds nothing and never waits, or cut the single-reading confirm.)*
- **(owner):** "Yeah I think making it another decision that can be answered via log_question makes
  more sense. Then it uses the same pathway. We would need to still do some text analysis to make
  sure the question is well-formed, since the whole idea was allowing an in-session read to
  immediately act in codemap without it requiring going outside the session."
- *(session: three cases to mark — (1) `confirm_reading` posts the confirm itself so it is
  well-formed by construction, the fold checking the posted text against its recomputation; (2)
  whether an open confirm also holds D1's findings and lists under "waiting on you" — the session
  read "lists, holds nothing extra"; (3) whether "Other" on a confirm is a typed answer on D1 (S0.2)
  or a free answer on the confirm itself. Noted this reverses S0.2's "Derived, names words".)*
- **(owner):**
  "1. If confirm returns a question made by codemap, that makes this easy. I agree with that.
  2. Yes I think the hold should apply there too
  3. Other on a confirm should downgrade the confirm to a regular decision and it loses it's
  special meaning."
- *(session: proposed the confirm is posted into D1's own round as a new question, so a reader can
  map "Other" words onto D1's options, the confirm's, or any question in the round; read "loses its
  special meaning" as: a reader-bound Yes on the confirm is an ordinary answer and authorizes nothing
  about the original words; words the reader maps onto D1 stand there as a new typed answer at their
  own typed time. Asked whether the open confirm and D1 holding the same findings as two entries is
  fine.)*
- **(owner):** "Yes two entries is fine. And yes \"loses it's special meaning\" means it becomes a
  decision that has to be read by a reader."
- *(session: the owner did not separately answer "posted into D1's round"; it is carried as the
  session's reading, to be confirmed in planning.)*
- **(owner):** "I think we're ready for a plan." — the discussion ends in planning here.

**Settled** (as the owner stated it): the confirm-this-reading question becomes a POSTED decision,
answered through `log_question` like any other; `confirm_reading` posts it with codemap's own text,
so well-formedness is by construction; while open it holds the findings too (two hold entries, D1's
and the confirm's, are fine) and waits on the person; "Other" on it makes it a regular decision whose
words must be read by a reader, and a Yes so read carries none of the confirm's special meaning.
Supersedes S0.2's "Derived, names words (Rec.)" and its "the confirm holds no findings and never
lists as unanswered".

### Session f75a592d, 2026-09-23 — planning batch 1

- **P1.1 (goal and critical).** "Goal (my wording, correct it if wrong): \"Make the confirm-this-reading question a posted decision codemap writes, settle the three unwritten rules (a rejected reader, words on a replaced question, the reader's prompt), and fix the rest — so decision-rounds-2 is stable enough for I9 and the skill fork.\" Keep last round's four gates as critical: a ruling overwritten, a finding closed unseen, a held finding offered as work, a decision silently vanishing?" Options: Keep both (Rec.) / Change the goal / Change the gates.
  **A (picked):** "Keep both (Rec.)"
- **P1.2 (a rejected reader — R2).** "A reader subagent reads your words on D1, but the fold rejects its reading (say it named a question replaced before you typed). Can that same reader then read your words on D2?" Options: Not used (Rec.) — the session's description: a rejected reading never counted; the reader may read another answer, and a new reader may read D1; only accepted readings count / Used.
  **A (picked):** "Not used (Rec.)"
- **P1.3 (words on a replaced question — R13).** "You type 'close it' on D1 at 10:00. At 10:02 D1 is replaced by D1b. The words are relayed at 10:05. They count on D1 (your A4 ruling), but no page shows them, no reader is asked for them, and no confirm can be posted for them. Where should they go?" Options: Read on D1 (Rec.) — the session's description: a reader is asked for them; bound, they rule D1 as of 10:00, and that ruling holds D1's findings until D1b is answered (B2.4), shown under D1 as replaced; they show under 'waiting on me' beside D1b / Shown only.
  **A (picked):** "Read on D1 (Rec.)"
- **P1.4 (the reader's prompt — R7).** "The reader must be blind to the agent's own reading, but codemap never sees what the reader was told. An agent that pastes 'I read this as D1 → Not a defect' into the reader's prompt, by honest mistake, gets agreement that binds. How should that be guarded?" Options: Codemap writes the brief (Rec.) — the session's description: a new op returns the reader's exact prompt (the words, the round's questions, the verdict format, nothing of the agent's reading); record_reading refuses a reader whose Agent call input is not that prompt; same strength as every transcript check (C14) / Accept and document.
  **A (picked):** "Codemap writes the brief (Rec.)"

### Session f75a592d, 2026-09-23 — planning batch 2

- **P2.1 (bulk defaults).** "Defaults to approve, or pick some out by number: (1) The confirm is posted into D1's own round as a new question, so a reader can map 'Other' words onto any question there. (2) A confirm's action lines state everything a Yes does: for a bulk item, every item it approves; for an option with no effects, the findings it releases from the hold. (3) Empty mapping lists are refused everywhere a mapping is checked (your reading, a reader's verdict unless 'unclear', the fold); no new rule, just fix every site. (4) Two decisions sharing a ref in one round (only another writer could post that): a verdict or confirm line naming it is refused as ambiguous; the fold never drops a posted question. (5) An answer with no parseable time is dropped by the fold, as a typed message with no time already is. (6) Comments that narrate removed code are reworded to say what the code does now, keeping those that guard against re-adding something." Options: Approve all as written / Rule on some separately.
  **A (picked):** "Approve all as written"
- **P2.2 (suggestions).** "Design suggestions, in or out of this plan: (7) holds computed only when a caller reads a finding's mark, not on every write (unmeasured; the op now builds the whole view once per recorded answer); (8) the ops use the fold's own validators and helpers instead of copies, which is what keeps 'the op refuses exactly what the fold drops' true (one copy has already drifted); (9) the round page's held list keeps showing holds other rounds place on its findings, as the one hold function gives them, not filtered to this round's." Options: Approve all as written / Rule on some separately.
  **A (picked):** "Approve all as written"

### Decided instead of asked (the session's)

- R8, R9, R10, R11 (the confirm's Other path, its prefix, minted ids, the once-key): dissolved by the
  discussion's ruling — a posted confirm goes through `post_round`/`log_question` like any decision,
  so none of them has a separate fix. The plan checks each is gone.
- R1, R3, R4, R6 (the slot claimed before acceptance, the two-pick verdict, the copy's `nothing`,
  verdict lines from anywhere): isolated defects both sorters agree on; the plan fixes them, R1
  before or with R3 (the carried warning).

### Session f75a592d, 2026-09-23 — planning batch 3 (the drafter's open choices, asked in the session's words)

- **P3.1 (the confirm's round).** "The confirm goes into D1's own round, as ruled. Consequence: two agents on two clones each post a confirm for the same words at once. Both get the next free ref (say D14), and the round then has two D14s. A reader line or confirm naming D14 is then refused as ambiguous (your default 4), which assumed only a foreign writer could cause that. Keep the confirm in D1's round?" Options: Keep D1's round (Rec.) / Own round per confirm.
  **A (picked):** "Keep D1's round (Rec.)"
- **P3.2 (what Other downgrades).** "You pick Yes on the confirm at 10:10. At 10:12 you type something in Other on the same confirm. You ruled that Other downgrades it to a regular decision. Does that undo the 10:10 Yes?" Options: Latest pick decides (Rec.) — the session's description: your Yes stands as the confirm's special answer; the 10:12 words are read like any typed reply and, if bound, rank by when typed; a later picked No or Yes replaces the earlier pick / Other ends it for good.
  **A (picked):** "Latest pick decides (Rec.)"
- **P3.3 (moot words and confirms).** "Some pending things stop being able to change anything: words a later answer already outranks, words bound another way, and words on a replaced question whose replacement has since ruled. What happens to them, and to an open confirm about them?" Options: Stop surfacing (Rec.) — the session's description: they drop off 'waiting on me', the reader queue and the flag; an open confirm about them stops holding and waiting, and stays listed on its round as 'no longer needed', never dropped / Keep showing.
  **A (picked):** "Stop surfacing (Rec.)"
- **P3.4 (checking codemap's own text).** "The fold checks a posted confirm (and the reader's brief) is codemap's own text. It can recompute the exact text, or check only the structure: that it names the answer, the mapping lines match real options, and so on. Case: a later codemap build rewords the confirm template while one is open. Under exact recompute, your Yes to the old wording then binds nothing." Options: Structure only (Rec.) / Exact recompute.
  **A (picked):** "Structure only (Rec.)"
- **P3.5 (the confirm's hold and queued work).** "You assigned F1 as fix work yourself at 09:00. At 10:05 you type words that may overturn D1's 'Real, fix it', so F1 is only marked, still on the queue. At 10:20 an agent posts a confirm for those words, which holds F1 (your earlier ruling), and under 'a person's assignment keeps it only if made after the latest hold began' F1 now leaves the agents' queue. So whether F1 is offered as work depends on whether an agent has posted the confirm yet. Accept that?" Options: Accept it (Rec.) / Confirm holds no queued work.
  **A (picked):** "Accept it (Rec.)"

### What a fork and a message sent into a reader leave — measured 2026-09-23 (impl-2 Step 5)

Measured on this machine's own transcripts, for P1.4's two channels the ruling did not name:

- **A fork** (`subagent_type: "fork"`): its meta file carries `agentType: "fork"` and `isFork: true`,
  and its own transcript opens on a `fork-context-ref` entry with no `isSidechain` — it inherits the
  parent's conversation, and with it the agent's own reading. `record_reading` refuses it by the
  meta file and by the launch call's `subagent_type`.
- **A message sent into a running subagent** (`SendMessage`): it lands in the subagent's own
  sidechain as a `user` entry with `origin: {kind: "coordinator"}` and text content ("The
  coordinator sent a message while you were working: …"). A reader's own `user` turns after its
  first entry are tool results only, so `record_reading` refuses a reader whose sidechain holds a
  `user` entry with an `origin`, or with no tool result, after the first. What this cannot see:
  text riding inside a tool result, and anything the harness does not record in the sidechain.
