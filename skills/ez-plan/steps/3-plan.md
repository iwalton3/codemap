## Settle, second pass

Measure every item `RECORD/decisions.md` marks *to measure* — count the sites, read the code, run
the check — and move it into the log or the decisions left (`references/contract.md` Z14). Ask
nothing yet. This runs for Plan with Questions and Plan with Artifact alike.

## The questions

Ask the decisions `RECORD/decisions.md` left for the owner, and the planning questions
(`references/contract.md` Z10): what counts as critical, acceptance, taste and missing requirements,
and the goal. Nothing in the decision log is asked one by one: print the whole log in your own
message, grouped by area, one line per item with what settled it, then ask one question: is any of
it a problem? (`references/contract.md` Z14). An item named comes out of the log and is asked as a
decision in the next batch. Skip a question only where a discussion — on a planning-only
conversation, the one before `/ez-plan` ran included (`references/contract.md` Z9) — clearly and
unambiguously ruled it.

Draft the batch, check it against Z10's four checks and `references/shared.md` Q1-Q3, then ask it
where the owner is (`references/codemap-workflow.md`, *Asking*): in codemap when it is open, and
otherwise with `AskUserQuestion` (under Codex, `references/shared.md` X2), at most four per call, the
ones that shape the plan first. The owner may defer a batch into a codemap questionnaire that anyone
on the team may answer. Each option carries
its consequences and what choosing it covers up. Write every question and answer verbatim to
`RECORD/owner.md`, and say what you decided instead of asking.

## Plan with Artifact

The same decisions and planning questions, on a page (`references/contract.md` Z15).
**`page.html` at this skill's root (`SKILL_DIR/page.html`) is that page**: copy it, write
`decisions.json` in the shape its header comment gives — the decisions left with their options and
costs, `dependsOn` where one waits on another, the rules to raise first, the planning questions as
`questions` (the goal, what counts as critical, a suggestion's scope, an item not correct as written
— any reading of yours marked as yours), and the decision log by area — and publish the page with
the JSON as a supporting file and `capabilities: {db: {}, user: {}}`. The page orders decisions by
ladder position, then consequence, nests dependents under what they depend on, and keeps the log
collapsed below with a *Problem* button per item. Change the page only where a run shows it wrong.

**Yield while it is open**, and talk about it when asked. Marks land in the page's `marks/<id>`
documents. When the owner says the pass is done: read the
marks with `ArtifactData`, resolve each `by` (the id `data/users/me` resolves to is the owner, whom
`profiles` does not list; any other id by its `profiles` action), and write the round to
`RECORD/owner.md` verbatim — the option picked by its label, the owner's words, and who answered
(the *Answering for* box where it is filled). A logged item marked a problem becomes a decision.
Then add what the answers raised, hide what another answer settled with the reason in `hidden`,
raise `round`, and republish to the same page; marks persist. When nothing is open, go on to the
plan.

## The plan

**One plan** (`references/contract.md` Z4), written to `RECORD/plan.md`. It covers every design
defect, assumption, defect pattern, disputed item and open decision (`open-decisions.md`), and its
goal is the owner's:

- the decision log from `RECORD/decisions.md`, each item with what settled it and its check, and
  the owner's decisions with their answers — grouped by area for reading, not by finding;
- a defect pattern without a fork is fixed where its cause is; one with a fork carries the owner's
  pick;
- group-1 items inside the plan's reach, and relevant suggestions, are inputs, not requirements;
- it names its run at its head (`references/shared.md` C), says what already landed, and lists what
  was decided instead of asked, each with its reason.

**First, the log form** (`references/contract.md` Z12): where settling left the owner no decision,
write the plan yourself as the decision log and launch no drafter.

**Otherwise, who drafts** (`references/contract.md` Z9):

- **You draft it** where this session is fresh or early, started on a handoff, or is a
  planning-only conversation, whatever its length (`references/contract.md` Z9). Incorporate the
  owner's answers yourself.
- **A drafter drafts it** where the plan comes after concrete work in this session. Launch it with
  `SKILL_DIR/prompts/drafter.md`. Its open choices come back as draft questions: check them like
  your own, ask what survives in your own words, write the answers to `RECORD/owner.md`, and send
  them to the drafter with `SendMessage`. It revises its own plan; do not edit `plan.md` around it.

## The coherence check

Launch one agent with `SKILL_DIR/prompts/coherence.md`. Fix in the plan what can be fixed — through
the drafter where there is one — and append, with a summary, anything it cannot address. Show the
plan to the owner, complete the choice line (`references/contract.md` Z8), and **stop**.

## The handoff

Write `RECORD/handoff.md` (`references/contract.md` Z13, `references/shared.md` K4), or append to it
where this run already has one. At its head: that it is resumed with
`/ez-plan --resume RECORD/handoff.md`; that it is deleted once the plan is implemented; and that it
should be cleaned up too where the work is done without a plan ever being written. Do not
write the procedure into it; the resumed session loads this skill.

Tell the owner its path and that command, complete the choice line, and **stop**.
