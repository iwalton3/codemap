---
name: triage-review
description: Handle a review round's findings without starting a repair loop. It blames each finding for whether it lands in an earlier round's fixes, sorts them with two sorters, one blind, and an arbitrator (implementation defect, design defect, assumption, design suggestion, or invalid with the reason), lands the trivial fixes both sorters agree on, and hands the rest to /ez-plan to decide with the owner — or, when fixes keep landing on fixes over a hole nobody named, diagnoses the loop into a report the owner can forward. Runs on its own when a review returns more than four findings; the owner can run it on any.
argument-hint: "[<path to the review output> | <reference to the findings>] [--since <last-known-good ref>] [--spec <path>]... [--test <path>]"
---

Findings carry assumptions. Applying a list nobody has ruled on rots the artifact: it drifts from
what it was for into a thing defending itself against review, and the next round finds the
patches. But a long round cannot be hand-sorted by the person who owns the intent, because they no
longer hold the implementation — and you do. **This skill is that translation, and it never starts
a loop:** it does not review its own fixes.

**It starts on its own only when a review returns more than four findings.** At four or fewer the
owner triages them, and runs this skill if they want help. Findings from any source count:
`/code-review`, Codex, Copilot, PR comments, a bug report.

`references/contract.md` is this skill's contract, `references/diagnose.md` its diagnosis route's
rules, and `references/shared.md` the rules it shares with `ez-plan`. Where a step file disagrees
with any of them, the step file is the defect. **Planning is `ez-plan`'s**: this skill hands a
round over to it and stops (`references/contract.md` H). **Run under Codex**, read
`references/shared.md` X1-X2 before step 1: launches use the Delegate Model, and questions become
a turn that ends on them, or a file the owner marks. **At entry**, read
[references/codemap-workflow.md](references/codemap-workflow.md) for capability checks, durable IDs,
where questions go and independent verification.

**The arguments.** `--spec` reaches both routes: the diagnosis route's evidence pack reads it, and
`ez-plan` receives it as a written criterion. `--test` and `--since` are the diagnosis route's —
`--since` names a git member's window base — and are a **declared no-op** on a round that is handed
to `ez-plan`. Say so rather than dropping one silently. Resuming a plan is `ez-plan --resume`, not
an argument here.

The work is a **unit** of one or more repositories, established at step 1 (`references/shared.md`
U); the skill runs from its **primary** member. `REPO` is a member's repository root: where a step
says `REPO`, it means each member in turn unless it names the primary. `RECORD` is placed as
`references/shared.md` K1 says, under `triage/`, created at step 1 with the slug chosen from the
review — **a `CLAUDE.md` in scope naming a destination for this skill by name supersedes that
path** — and committed as K2 says. For a versioned Artifact, the unit is one member, the replay.
`SKILL_DIR` is the absolute base directory the skill loader printed when this file loaded.

**Every agent this skill launches** gets its brief as a launch block, with every bracket and every
`SKILL_DIR` / `REPO` / `RECORD` substituted before it is sent. It is launched with the Delegate Model
and **never as a `fork`**: a fork inherits this context — the sort, or
the loop's frame — and silently ignores the model override (`references/shared.md` A).

**The Delegate Model** is the model every agent this skill launches uses. On Claude Code it is the
user's currently selected model, unless that model is Fable; then use Opus. On Codex it is the
latest GPT Sol model, not Astra unless the user explicitly asks for it.

## Steps

Read each file when you reach it, not before. Each ends by naming what comes next.

1. `SKILL_DIR/steps/1-blame.md` — the tree, the record and the findings, purpose, the blind
   sorter's launch, then blame every finding
2. `SKILL_DIR/steps/2-sort.md` — the first sort
3. `SKILL_DIR/steps/3-blind-sort.md` — collect the blind second sort
4. `SKILL_DIR/steps/4-route.md` — reconcile, write `sort.md`, route

No diagnosis:

5. `SKILL_DIR/steps/5-land-and-hand-over.md` — land the trivial fixes, then hand over to `ez-plan`

Diagnosis route:

5. `SKILL_DIR/steps/diagnose-1-checkpoint.md` — checkpoint and scope, asking nobody
6. `SKILL_DIR/steps/diagnose-2-deposition-and-owner.md` — the deposition, then the owner
7. `SKILL_DIR/steps/diagnose-3-evidence.md` — the evidence pack
8. `SKILL_DIR/steps/diagnose-4-lens-readers.md` — two blind lens readers
9. `SKILL_DIR/steps/diagnose-5-triage-and-relay.md` — the triager's report, relayed

## Stop conditions

- **The Delegate Model is not available at a launch** → it is an outage. Tell the
  owner you are waiting on an outage, end the turn, and resume from that launch when they say so.
  An agent an outage interrupted is resumed with `SendMessage`, not relaunched. Never downgrade and
  never cut a reader: two lens readers and the triager, every time.
- **Not a git repository** → blame has nothing to read; say "not a git repository" and stop. A
  versioned Artifact is the one exception (`steps/1-blame.md`); a session transcript is not.
- **`/ez-plan` is not installed** at the handover → say so and stop: `sort.md` is complete and
  what landed is committed, so the owner can install it and run `/ez-plan --round <RECORD>`.
- **The owner wants a recovery executed** → that is a separate ask, after they have read the
  report, and **where it is executed is theirs to say. There is no default.**
