## Settle, first pass

**On a handoff, keep `RECORD/decisions.md`** where it exists — a handoff from before the ladder
redesign has none, and gets the full first pass — and settle again only what changed since it was
written: a ruling in `owner.md`, a commit touching an item's sites, a rule or principle added
(`references/contract.md` Z14). Otherwise, before the summary, sort every item that reaches the plan
into what you decide and what the owner decides, **from the sort alone** — on a planning-only
conversation, from the sort and the record in `RECORD/owner.md` too (`references/contract.md` Z9,
Z14). Measure nothing yet: an item you cannot place without a measurement is marked *to measure*,
and waits for the second pass in `steps/3-plan.md`.

1. **On a triage round, reconcile the two sorts.** A difference only in group, neither invalid, is
   agreement: take the more cautious group. A difference in evidence, in what settles it, in level
   or in a fork: read both readings where `sort.md` keeps them, and settle from their evidence
   together. The raw `sort-a.md` and `sort-b.md` go to nothing downstream of the arbitrator. Where
   two fixes still both work, apply the owner's tie-break as Z14 quotes it; where it needs a
   measurement, mark the item *to measure*.
2. **Decide and log** what is settled at levels 6-8, defect patterns without a level-5 fork, and
   arbitrated items without one (a verdict settles only its tie) — each with what settled it, the
   level, and the check that will fail first. Name every level-7 change.
3. **Make a decision for the owner** of each level-5 fork (every option with its cost and what
   depends on it, none the default), anything touching a level-4 rule (marked for who holds it),
   and anything nothing settles. A rule a finding refuted goes first.

Write the result to `RECORD/decisions.md`: the log, by level, then the decisions left. Commit it as
the record is committed (`references/shared.md` K2).

## The summary

Write it as `references/contract.md` Z3 lists, for someone who has not read the input. On a todo
list or the session's items, list every item. On a handoff, summarise the state the handoff carries
and what has landed since.

**If nothing is left for a plan, say so and stop** (`references/contract.md` Z4). The opening was
never offered, so write this session's choice line in one act: nothing left for a plan (Z8).

## The opening

In the same message as the summary: recommend one option and say why, by the order in
`references/contract.md` Z5, and say what each option costs: planning here buys independence from
this session's priors where a drafter runs, but shares a context that may already be long; the page
lets the owner answer in any order and talk while they do, but is a page to open and a round trip
per pass; a new session is dedicated and resumable, but is a second session to drive and carries
only what was written down. Then put the options with `AskUserQuestion` — the names as labels, the
lines as descriptions, not restated in the message. On a handoff, without Plan Later.

**Write the choice to `RECORD/sort.md` as soon as it is taken**, before anything else — the first
act of this session's choice line (`references/contract.md` Z8).

- **Plan with Questions** → `SKILL_DIR/steps/3-plan.md`.
- **Plan with Artifact** → `SKILL_DIR/steps/3-plan.md`, from the top: its second settling pass
  runs first, then *Plan with Artifact*.
- **Plan Later** → `SKILL_DIR/steps/3-plan.md`, *The handoff*.
- **Discuss First** → below.

## Discuss First

Hand the conversation back and talk (`references/contract.md` Z6). No drafting checks, no question
batches, no turn-by-turn transcript, and no reciting what still binds. What still binds is the
shared contract and the fix-all guard (Z11).

**Where the owner asks for a bulk fix** (`references/contract.md` Z11): first mention the key design
changes they have not already read — what was discussed and is known is just done. Where agents
sorted the items (`sort.md` says who did), apply the full gate as well: name every group-2 item and
everything marked "don't fix early" one by one, say what you will do, and end the turn: their reply
is the confirmation, and nothing is applied before it. Land it under `references/shared.md` C.

**The discussion ends one of three ways** (`references/contract.md` Z7):

| ending | what you do | the choice line's outcome |
|---|---|---|
| **Plan here** | quote what the discussion settled into `RECORD/owner.md` as `references/contract.md` Z7 says, under a heading naming this session, then `SKILL_DIR/steps/3-plan.md` from the top, taking *Plan with Artifact* after the second pass where the owner asks for the page | planned here |
| **Plan later** | quote it into `RECORD/owner.md` the same way (`references/contract.md` Z7), then `SKILL_DIR/steps/3-plan.md`, *The handoff* | handed off |
| **Ad-hoc fixes**, under Z11 | the commits hold the intent; no `plan.md`, no new record file; offer to write any clear ruling to `owner.md`; stop | `cancelled` |

Where the discussion fixed everything there is to fix, nothing is left for a plan: stop.
