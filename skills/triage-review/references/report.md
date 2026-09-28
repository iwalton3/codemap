# The report

One file, two audiences, never split. A lead version and a practitioner version have drifted
silently before: by the time anybody noticed there were two files, one of them had lost the
pinned commit and the escalation.

Sections in this order. Skip none; a section with nothing in it says so in a line. The
relaying session later appends a §11, the owner's answers verbatim; you do not write it.

---

## 1. Executive summary

One page. **No paths, no symbols, no jargon.** A lead who has not opened the repository
must be able to read this and act. Cover, in this order:

- what was being built, in a sentence;
- what happened, in three or four sentences, as a sequence;
- what it cost: elapsed time and rounds. The self-fix figures go in §9 with their units, not
  here: no decision so far has turned on one;
- **what kind of failure it was**, in the plainest available words, because the answer
  assigns the problem to a different place and a different person. Give both halves: what
  made the repairs wrong, and what was available to settle the argument. A process defect, an
  execution regime, a missing distinction in the design and an unopened reference are four
  different bills, and two of them can be true at once;

- **what is being asked for, and of whom**: a decision where the path has forked, a question
  only they can answer, or the one measurement that has to happen before anybody can choose.
  Say which of the three it is. A decision is put to them as a choice in §3, so state it
  there as a question with an answer rather than as a topic; the other two are not choices
  and must not be dressed as one.

Write this section about conditions, never about a person or a session. If the rate of work
is the finding, say the rate of work is the finding.

## 2. What doesn't add up

**The rules for this section live in `references/noticings.md`** and are read by the lens
readers too, so that what they hand back and what lands here are the same thing. Follow them
exactly; they are not restated here.

This section carries the entries the triager kept after reconciling the two readings, in the
three categories that reconciliation sorts into: found by both, found by one and cleared by
the other, and found by one where the other never looked. It is the first thing after the
summary because it is the part a person can act on and the report cannot.

## 3. Decision requested

**Written so it can be put to the decider as a choice, not read as an essay.** Two or three
options, mutually exclusive, each with a short name of its own, its cost, and what choosing
it forfeits. The usual set: revert named commits and re-derive; keep and pay for the
unreviewed ring; stop and settle the contract first. Name the commits. Recommend one, say in a
single sentence why, and name its downside. State what happens if nothing is decided, because
that is an option
too and it is the one that happens by default.

Keep each option's description short enough to be read in a picker. If an option cannot be
stated without a paragraph of qualification, it is two options or it is not ready.

**If the path has not forked, say that instead.** One honest next step, or a question for
somebody who is not here, or a measurement that has to happen before anybody can choose.
Padding a single path into three options to fill this section makes the analysis look further
along than it is, and the reader will spend their attention arbitrating a choice you invented.

## 4. Timeline

Each round: what it was told, what it changed, what the next round then found. This is the
section that shows a reader whether the criteria were moving, so record where each round's
brief came from, not only what it said.

## 5. Diagnosis

Both axes, each with the evidence that selects it: the mechanism, and what evidence was
available per rule. Do not rank one against the other and do not report only the dominant
one. Evidence carries commands.

**Open with the domain model this diagnosis assumes**, as two or three sentences in the
owner's vocabulary, each of which they can mark wrong without opening the repository. Claims
about meaning, not about code. *"Two readers on one school card, one reserved book: this
report assumes both see the same due date and the same renewal right."* Again the
example is from a domain that is not yours, on purpose. This is mandatory whether or not
you think a distinction is missing. A section that only makes claims about code cannot be
refuted by the person best placed to judge what it means, so they defer, and the
recommendation runs
unexamined. Loops have broken on the owner correcting exactly this kind of sentence, and
without one they broke late, on a sentence reconstructed from elsewhere in the report.

Where the mechanism is a missing distinction, give the **smallest scenario in which two
defensible repairs appear to demand different answers**. Before writing it, look for a value or
an earlier fact both repairs could read, and say what you found: a scenario of this kind can be
false for exactly that reason while the mechanism it illustrates holds, so the
check tests the scenario and not the label. Put the scenario to the owner as a §10 question,
not a conclusion, and price the remedy conditionally on the answer: if the distinction holds,
its remedy is larger than the remedy for a rule applied at too few sites, and a report that
omits that reads as authorising the cheap repair.

**End this section with three kill conditions**, in those words: things the recovery must not
turn out to need if this diagnosis is right. A migration, a new concept in the glossary, a
ruling from the owner on a question this report did not ask. They exist to be scored after the
recovery. **Aim at least one at the scenario the diagnosis rests on**, not only at its label: a
right label over a wrong scenario passes every condition aimed at the label. A report has made
its price prediction four times in prose and never once as a condition, and nobody checked it.

## 6. Believed versus actual

The claims from the deposition that were checked, what the record said, and the command that
settled each. Only entries that change a decision.

This section is addressed to the session that will do the recovery. Write each entry as
*believed A, record shows B, the difference matters because C*. It is the part that
re-orients a session still inside the loop, and it is worth more to the next one than the
diagnosis is.

## 7. Recovery envelope

**Not an implementation plan.** Every time exact repair steps have been written here, they have
been withdrawn in whole by the next thing that looked at them, and the loop simply moved into
plan review. So this section bounds the recovery and leaves the design to whoever takes it.

Write it for **a person on the team who was not here** and who may be the one to hand it on:
this is the section they will read as "what happens next". Plain words, no reliance on the
rest of the file, and every item either something to do or something to decide. A fresh
session should also be able to follow it, and those two audiences want the same thing, which
is to know what is settled and what is not.

- **What is preserved, what is reverted.** Name commits. Separate the code from the coverage:
  tests, fixtures and probe tools written during a bad run are usually sound even when the
  fixes are not, and a revert that carries them off turns a recovery into a second loss.
- **The checkpoint tag**, one per repository where the work spans several, the command that
  returns to each, and what not to do first.
- **The decision frontier.** What has to be settled before an implementation plan can be
  written at all, and **what must not yet acquire a helper name, a site count, a collapse or a
  repair shape.** Naming a shape before the thing it governs is enumerated is the failure that
  has had plans withdrawn; say which areas are still fogged rather than pre-slicing
  them.
- **Premises the plan author must check before writing a step, with the cheapest falsifier
  for each.** One line per premise: what any plan here would have to assume, where that
  assumption came from, and the cheapest thing that would show it false. Two or three, chosen
  because their falsity would withdraw a plan rather than because they are easy to check.
  A falsifier may be a query against live data, a read of the consuming code, a configuration
  file, a protocol document or a person. **These are the plan author's first task, not yours**:
  you have not written the steps, so you cannot have measured their premises. Say so at each
  one rather than marking it `CONFIRMED`. A plan can be withdrawn in whole for a single
  premise about stored data that a ten-line query refutes, when nobody wrote the premise down
  as one.
- **The gates the implementation owes**, stated as gates and not as advice, because the
  window in which the cheap enforceable repair still exists closes on the first patch and
  closes silently. At minimum: every rule's population derived by two different *kinds* of
  instrument before the first patch, **reconciled rather than made equal** — a static search
  yields candidate sites, a runtime probe yields observed artifacts for one scenario, a read
  of the consumer yields semantics, and they are not the same set. Say what each observes,
  account for anything only one of them sees, and stop only on a disagreement that is
  unexplained and relevant. Every rule names the oracle that settles it. Every rule ships a
  check observed failing at the parent.
- **What counts as an oracle here**, and what does not. An oracle is evidence that can make a
  claim wrong independently of the work being judged: the behaviour of the real system, a
  reference consumer, a contract agreed earlier and elsewhere, or a decision from the
  principal. Internal coherence is a design constraint, not an oracle. It can say whether an
  implementation expresses a rule consistently; it cannot say the rule is right, and treating
  it as an oracle is how a missing distinction gets ratified.
- **One next observation** — the single cheapest thing that would move the frontier.
- **Who authors the plan.** A session that wrote neither this report nor the code under it. An
  author cannot un-know a repair shape it has already proposed, which is why this section
  stops here. Where the diagnosis is a missing distinction, brief that session to **author the
  missing level** — what exists, which of it is stored, what single authority answers for each —
  rather than to review this report. Give it the owner's exchanges verbatim, questions included,
  measured facts marked as measured, earlier postmortems labelled as hearsay and permission to change
  anything, and have what it authors come back to the owner as cases they can mark wrong rather
  than as a design to ratify.

## 8. Process findings

What conditions produced this, each paired with a gate that attaches to a moment and names a
check. A gate is a thing that fires at a point in time: before a tag, before a merge, before
the next batch. Advice that describes good judgement is not a gate, and is the thing that
was already failing — an advisory rule is a cold artifact consulted from a hot region, and
the person repairing is at maximum local attention and minimum global attention.

Include here, when they apply, the two conditions a team does to itself and nobody inside
can see: the rate the work is being done at, which predicts this pattern without causing it,
and a policy that rewards the smallest targeted diff per fix, which optimises for precisely the
change that generates it.

## 9. What this report cannot see

**Every instrument here stops at the window base.** Self-fix attribution, the per-day table
and the timeline all begin at `BASE`, so anything that entered the schema or the vocabulary
earlier scores zero on all of them. Where §2 names a disagreement, give the date each side of
it was written: both sides old means the tree already disagreed and these repairs are working
over the top of it, while either side written in-window means the loop left its own trace
here. **Do not report the age of an identifier as though it were the age of the problem.** A
thing being repaired always predates the window that repairs it.

The self-fix figures with their units and the floor caveat, the blind zones of each instrument,
which claims are `ARGUED` rather than `CONFIRMED` and
what would settle them, which lenses in the pass turned up nothing, **any category a reader had to invent** and what it found, anything the evidence pack reported as `MEASURED NOTHING`, `NO
PRIOR RECORDS FOUND` or `NO COMMITS IN WINDOW` (with its clause: valid where the repository belongs
for its specs or tests, otherwise the base may be wrong), and any hypothesis of your own that you
refuted while working, so nobody re-runs it.

Also state, plainly, what noticed the loop: the mechanical trigger, a review or a person.

## 10. Open questions

**No cap, and not a target: zero is a valid and common answer.** Two kinds of question go here.
**Every disagreement the sort carried**, verbatim, with both readings, and each command
where the sorter gave one: they reach the owner whatever else is open. **Your own questions**, only
the ones answerable **now**: a question whose answer depends on another still open is not on the
frontier and does not belong in this round.

Number each, give it a title, and name the person who can answer it. Anything you could have
looked up is not a question; find the fact yourself and put it in as context.

**Recommend only where the fork is genuine**, and a recommendation carries its downsides and
**what choosing it covers up** — what it assumes, defers or makes invisible. The recommended
option is the one most likely to fit the reader's intuition and be approved while incomplete, so
it is the one that owes the disclosure. Give options only the context that earns its weight: a
wall of text is skimmed, and a skimmed option is approved.

## Appendix

- **The deposition, verbatim.** Copy the file; do not summarise it. It is the specimen of
  what the executor believed, it is the evidence for any process finding, and a summary of
  it written by anyone is a summary of a summary, which is the shape in which omissions
  survive. Label it as such so nobody reads it as findings.
- **Every command that produced a number in this report**, runnable as written.
- The checkpoint tag, one per repository where the work spans several, and how to get back to the
  state at the time of writing.
