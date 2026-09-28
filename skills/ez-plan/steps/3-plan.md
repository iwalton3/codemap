## The questions

Ask the planning questions (`references/contract.md` Z10): what counts as critical, acceptance,
taste and missing requirements, any sorter disagreement that would change what is done, and the
goal. Skip one only where a discussion clearly and unambiguously ruled it.

Draft the batch, check it against Z10's four checks and `references/shared.md` Q1-Q3, then ask it
where the owner is (`references/codemap-workflow.md`, *Asking*): in codemap when it is open, and
otherwise with `AskUserQuestion` (under Codex, `references/shared.md` X2), at most four per call, the
ones that shape the plan first. The owner may defer a batch into a codemap questionnaire that anyone
on the team may answer. Each option carries
its consequences and what choosing it covers up. Write every question and answer verbatim to
`RECORD/owner.md`, and say what you decided instead of asking.

## The plan

**One plan** (`references/contract.md` Z4), written to `RECORD/plan.md`. It covers every design
defect, assumption, defect pattern and disputed item, and its goal is the owner's:

- each defect pattern gets its own section, whose question is only *does this pattern mean a design
  rule is missing?* — "no, just fix every site" is the default and a first-class answer;
- group-1 items inside the plan's reach, and relevant suggestions, are inputs, not requirements;
- it names its run at its head (`references/shared.md` C), says what already landed, and lists what
  was decided instead of asked, each with its reason.

**First, the list form** (`references/contract.md` Z12): where the sort qualifies, write the plan
yourself as a list of questions and launch no drafter.

**Otherwise, who drafts** (`references/contract.md` Z9):

- **You draft it** where this session is fresh or early, or started on a handoff. Incorporate the
  owner's answers yourself.
- **A drafter drafts it** where the plan comes after concrete work in this session. Launch it with
  `SKILL_DIR/prompts/drafter.md`. Its open choices come back as draft questions: check them like
  your own, ask what survives in your own words, write the answers to `RECORD/owner.md`, and send
  them to the drafter with `SendMessage`. It revises its own plan; do not edit `plan.md` around it.

## The coherence check

Launch one agent with `SKILL_DIR/prompts/coherence.md`. Fix in the plan what can be fixed — through
the drafter where there is one. What only the owner can rule on — a contradiction between rulings,
an item nothing covers, an assumption an implementer would have to make — ask as planning questions
(`references/contract.md` Z10), write the answers to `RECORD/owner.md`, revise the plan, and run the
check again. **Repeat until a check returns nothing for the owner.** An item the owner defers is
listed in the plan as deferred, in their words.

Show the plan to the owner. Append the seal line to `RECORD/owner.md` (`references/shared.md` K3):
*Rulings taken after the plan was shown on `<date>` — while it is revised or executed — are logged
below, verbatim, under a heading naming the session.* Complete the choice line
(`references/contract.md` Z8), and **stop**.

## The handoff

Write `RECORD/handoff.md` (`references/contract.md` Z13, `references/shared.md` K4), or append to it
where this run already has one. At its head: that it is resumed with
`/ez-plan --resume RECORD/handoff.md`; that it is deleted once the plan is implemented; and that it
should be cleaned up too where the work is done without a plan ever being written. Do not
write the procedure into it; the resumed session loads this skill.

Tell the owner its path and that command, complete the choice line, and **stop**.
