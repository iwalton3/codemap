# Decision rounds — the worked cases

**The gate for plan `2026-09-22-decision-rounds` (I11).** Three past rounds are worked by hand
against `PROPOSAL-decision-rounds.md` §7 as the plan amends it. Nothing here is built. No schema
is written until the owner has marked every C-item below **holds** or **wrong**. The marks
proposed here are the session's; the owner's marks replace them.

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
