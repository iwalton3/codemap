---
name: ez-plan
description: Turn a pile of work into one checked plan, putting to the owner only the decisions that are theirs. By the owner's solidity ladder, what a rule, a principle, the code or a check already settles the agent decides and logs; level-5 design forks, business rules and anything nothing settles go to the owner — as questions, or on an editable page. Takes a todo list, a session's open items or diffuse context from a discussion, a round handed over by /triage-review, or a handoff from an earlier session. Sorts a todo list into mechanical work, work that needs design, suggestions whose scope the plan decides, and items not correct as written; takes a /triage-review round already sorted. Lets the owner discuss first, plan with questions or on a page, or hand off to a fresh session, and never lands anything the owner has not been shown.
argument-hint: "[<todo list: a path, or text> | --round <RECORD> | --resume <path to handoff.md>] [--spec <path>]..."
---

Work handed to an agent drifts from what it was for when the decisions inside it are made by the
agent in passing, and stalls when every one of them is put to the owner. This skill decides by the
ladder (`references/shared.md` L): what is already settled, it decides and logs; the rest it puts
to the owner at the altitude they rule at, with the consequences worked out; and it writes one
checked plan from both. **It does not execute the plan,
and it never reviews its own work.**

`references/contract.md` is this skill's contract and `references/shared.md` the rules it shares
with `triage-review`; the steps cite both by rule ID. Where a step disagrees with either, the
step is the defect. **Run under Codex**, read `references/shared.md` X1-X2 before step 1: launches use the
Delegate Model, and questions become a turn that ends on them, or a file the owner marks.
**At entry**, read [references/codemap-workflow.md](references/codemap-workflow.md) for capability
checks, durable IDs, where questions go and independent verification.

**The Delegate Model** is the model every agent this skill launches uses. On Claude Code it is the
user's currently selected model, unless that model is Fable; then use Opus. On Codex it is the
latest GPT Sol model, not Astra unless the user explicitly asks for it.

**On `--round`, don't read `references/shared.md` a second time.** `triage-review` already read its
own copy in this session, and the two are identical. Cite that read, unless it survives only in a
compaction summary; then read this one.

**The input** (`references/contract.md` Z1) is exactly one of: `--resume <handoff.md>`; `--round
<RECORD>`, which `/triage-review` passes when it hands a round over in the same session; or anything
else — a path, pasted text, or nothing, meaning what this session already holds — as a todo list or
the session's items. `--spec` is a written criterion the plan is drafted and checked against, never
a source of plan items.

`REPO` is a member's repository root; `RECORD` is the run's directory (`references/shared.md` K1);
`SKILL_DIR` is the absolute base directory the skill loader printed when this file loaded.

## Steps

Read each file when you reach it. Each ends by naming what comes next.

1. `SKILL_DIR/steps/1-input.md` — the input, the unit, the tree, and on a todo list the sort
2. `SKILL_DIR/steps/2-opening.md` — the first settling pass, the summary, the opening, and a
   discussion if one is chosen
3. `SKILL_DIR/steps/3-plan.md` — the second settling pass, the decisions as questions or on a page,
   the plan, the coherence check, or the handoff

## Stop conditions

- **The Delegate Model is not available at a launch** → an outage
  (`references/shared.md` A). Tell the owner, end the turn, and resume from that launch when they
  say so.
- **Not a git repository**, and not a versioned Artifact round → say "not a git repository" and stop.
- **The owner wants the plan executed** → a separate ask, after the plan is shown, and **where it is
  executed is theirs to say.** Whoever implements the plan deletes `RECORD/handoff.md` where the run
  left one (`references/shared.md` K4).
