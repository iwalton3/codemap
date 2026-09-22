# Proposal: decision rounds — people answer questions, agents close findings

> **Kind: proposal — not approved.** Filed 2026-09-22 against `main` at `eaf49cd`. It
> **supersedes `docs/plan-decision-log.md`** (markdown decision files become records in
> codemap, and the success measure changes) and takes `PROPOSAL-close-pipeline.md` §3(a)
> and §4–§6 as components. `PROPOSAL-close-evidence.md` §5's evidence slot is a
> component too. §7 is a sketch stated concretely so it can be marked wrong, not a schema.

## 1. The claim

**People will not work a finding queue, and they should not have to.** Most code is never
going to be read by a person (COD-18 §Load), and a finding log is the same shape: when an
agent can be asked to fix everything, a person is only kept in the loop by a click. A
downstream team, asked to close findings an agent had already fixed, said it plainly: they
will open the list, see green, and click resolve on every row. That feels like working a
backlog and settles nothing.

**What a person has that an agent does not is authority over requirements.** That is the
boundary `triage-review` and `ez-plan` were built to defend: Claude is usually good about
not inventing requirements, and much less so when handed a batch of 34 findings of which a
few state a requirements void with a suggestion attached. The re-sort of one such loop's
142 applied findings put 37 (26%) outside "implementation defect", 12 of them assumptions,
and no severity threshold separated them (`/working/skills`,
`ideas/automated-integration/` §4).

So the proposal splits the work by who can do it:

| who | does | because |
|---|---|---|
| two sorters and an arbitrator | decide each finding's **group**, before any fix | "which of five kinds is this?" is a bounded question, and bounded questions are where agents discriminate (`close-audit-next.md`) |
| the fixer | changes code, and records the **evidence** | it is the only one holding it |
| a verifier that is not the fixer | **re-runs** the evidence and reaches one of four outcomes | re-running is bounded; judging "is this fixed?" is not, and two model families agreed 16/16 while missing together |
| a person | **answers questions** — the decisions the sort routed away from agents | a ruling is not in the code, so no reader can recover it |

A person's queue is then a list of **decision rounds**: *round 12 — 4 questions; answering
them settles 23 findings.* The findings are one click away and hidden by default.

## 2. Why this is stronger than closing on merge

The obvious alternative, and the one asked for (IZ-2 below), is: the fixing agent marks a
finding `fixed-on-branch`, and it closes when the branch merges. That fails four ways this
arc has measured:

- **The fixer grades itself.** Every `fixed` outcome in both measured ledgers was
  agent-authored; 7.1% of 183 closes took authority nobody granted, five of them saying so
  in their own prose (`PROPOSAL-close-evidence.md` §8.2).
- **A merge proves where the change is, not that it is sufficient.** `findingLanding`
  already derives *landed* from the code; nothing derives *adequate*.
- **The closing condition depends on the group, and nothing records the group.** An
  isolated defect closes when its reproducer stops firing; a pattern needs every site; a
  design defect or an assumption needs a ruling. Close-on-merge applies the first
  condition to all of them.
- **A requirements void closed by a fix is an invented requirement.** Merge makes it
  permanent.

Here the group is decided **before** the fix by two sorters and an arbitrator, the fix is
checked by an agent that did not write it and that re-runs rather than reads, and a finding
whose closing condition is a ruling **cannot** close until a person gives one.

## 3. The four outcomes

| outcome | reached when | who |
|---|---|---|
| **fixed** | group 1, not left unresolved by the arbitrator; the reproducer fires at the witness and not at the fix; the predicate is at zero hits for a pattern; every hunk of the diff is attributed to the ask | verifier, alone |
| **refuted** | group 5 *wrong*, both sorters agreed, and its command re-runs; **or** a person's answer settles it | verifier for the first; the answer for the second |
| **blocked on a decision** | groups 2, 3 and 4; a pattern's rule question; anything the arbitrator could not settle; a diff with a hunk nobody asked for | routed at sort time, or by the verifier |
| **open** | anything the verifier could not settle — `unknown` | nobody; *"I could not ask" is never a verdict* (`pr.ts`) |

Group 5 *assumed* and *out of scope* go to a decision, not to the verifier: both rest on a
purpose or a requirement, which is the person's to state.

**An unanswered decision is a success state, not a failure.** Its default is the status quo:
nothing changes, the findings it blocks stay open, and it never blocks a merge. The failure
this defends against is an agent filling the void. So the health measure is not rulings per
round; it is **how often an agent fills a void**, against the 7.1% baseline and
`settledWithoutAdjudication` (`problems.ts`).

## 4. Two kinds of answer

An answer affects findings in one of two ways, and only one of them is immediate:

- **Settling.** *"That behaviour is intended."* *"Not a requirement."* *"Out of scope."* The
  answer *is* the resolution: the findings it covers go to `refuted` or `accepted` the
  moment it is recorded, with the decision as the reason. This is the bulk close.
- **Unblocking.** *"Option B."* *"Yes, the rule is per-tenant."* The findings stay open
  until a change that **cites** the decision lands, and the verifier then closes them by a
  link check — the decision exists, is answered, covers them, and the change cites it.
  Never because the change **looks right** against the answer: that is the unbounded
  question that failed five auditor passes.

Keeping them apart means "I picked B" is never read as "fixed".

**Every option states its effects**, and codemap computes them rather than trusting the
agent's prose: *"option A settles F3, F7, F12 as accepted; option B unblocks F3, F7, F12
and F19."* That is the confirm gate's own rule — no approval without the consequences
enumerated first — delivered by the record rather than by a second message, which is the
re-ask the downstream team objected to (IZ-8).

## 5. Importance: a plan's decision or a rule

Not every decision should become a requirement in the standard. The test from
`plan-decision-log.md` stands: *would this still be true if the finding had never been
filed?* A void passes it; a choice between two fixes does not.

So where a question looks upstream, **promotion is one more option on the same question**:
*"per-tenant — for this plan only"* beside *"per-tenant — and make it a rule in the
standard."* Plan-only is the default. A plan-only answer cited by a later round is flagged
as a candidate for promotion; promotion goes one way only, from cheap to expensive, never
back.

A promoted answer drafts an operation in a spec. It does **not** ratify it — see §9.

## 6. Where the answer is given

**In the session, usually.** It is where the person already is, and on a mobile connection
it is the only place that is convenient. The web page is for large plans and for rounds
left open.

- The skill **posts the round before asking**: one record per question, holding the text
  as shown, its options and effects, the recommendation, and a content hash. The message to
  the person cites the ids — `D2 · …` — and the reply form `D2 yes / D3 park` works on
  either surface.
- **Park is an answer.** It defers the question with a deadline, `until` required and
  enforced by the fold exactly as the backlog's is (`finding-backlog.md`), so a person who
  cannot read it now can say so truthfully instead of clicking approve.
- **Partial answers are normal.** The round's page shows what is still open and what each
  open question is holding.

**Who may record an answer** is the question this design turns on:

- **A settling answer, and a promotion, are principal acts** at both ends, like `debt` and
  backlogging. They close findings with no further check, so an agent may not record one.
  In a session the person types `! codemap answer 12 "D2 yes D3 park"` — the CLI is a
  person unless a harness says otherwise (`identity.ts`) — or answers on the page.
- **An unblocking answer may be relayed** by the agent over MCP, carrying the person's
  words verbatim and bound to the hash of the question as shown. It is recorded as relayed
  (`via` an agent), which is honest; it closes nothing by itself, because the findings still
  need a verified change.

The residual, accepted and not worth hardening, as for the web's principal notice (`src/serve.ts`): an agent can
run the CLI through a shell and be recorded as the person. The hash binding means that it
can at most answer the question that was actually shown, never a different one.

## 7. What codemap gains — a sketch

Names are placeholders. **Naming hazard:** `Annotation.kind: "question"` and the
`questions` / `resolve_question` tools already mean *a doc question a reviewer left*, and
`triage/` already means stakes triage. The new entity should be a **decision** in a
**decision round**, and the sort should be called a **sort**.

### Records

- **`DecisionRound`** — `id`, `source` (a review round slug, a plan slug, or ad hoc),
  `universe`, the PR or branch where there is one, `postedBy`, `at`. Rounds are the unit a
  person sees.
- **`Decision`** — `id`, `round`, `question` (as shown), `options[]` each with `text`,
  `consequence`, `effects[]`, and `promotes?`; `recommendation`, `hash`, `state`
  (`open` / `answered` / `parked`), `answer?` (`option`, `words` verbatim, `by`, `relayed`,
  `at`, `until` when parked).
- **`effects[]`** — `{ findings: [...], on: "settle" | "unblock", as?: "refuted" |
  "accepted" }`. Validated at post: each finding exists and belongs to the round's findings.
- **`Annotation.sort`** — `PROPOSAL-close-pipeline.md` §3(a) unchanged: `group`, `kind`,
  `covers`, `sites` and `command`, `refutation`, `restsOn`, `unresolved` (the arbitrator
  could not settle it), `by`, `round`. Written by the sort, **refused once any close has
  been attempted**, so a fixer cannot re-sort its own item into group 1.
- **The close evidence** — `PROPOSAL-close-evidence.md` §5, keyed to the four claims as
  `PROPOSAL-close-pipeline.md` §3(c) has it.
- **`blockedBy` is derived, not stored**: a finding is blocked by every open decision whose
  effects name it. Nothing to drift, which removes the one cost `plan-decision-log.md`
  accepted.

### Ops, both surfaces

| op | MCP | web / CLI | gate |
|---|---|---|---|
| `postRound` — a round and its decisions | yes | — | any actor |
| `postSort` — the sort, per finding | yes | — | any actor; refused after a close attempt |
| `decisionRounds`, `decisionRound` | yes | the queue page, the round page | read |
| `relayAnswer` — unblocking only | yes | — | agent, verbatim, hash-bound |
| `answer` — any answer, park included | **no** | `codemap answer`, the round page | principal |
| `verifyClose` — reach one of the four outcomes | yes | — | refused to the actor that wrote the fix |

`ops-reach.test.ts` forbids an MCP tool for `answer`, as it does for backlogging;
`standard-reach.test.ts`'s rule, that nothing is reachable from neither surface, holds.

### The page

`/#/u/:u/decisions` — open rounds, newest first, each line *N questions · settles M ·
unblocks K*. The round page shows each question with its options, the effects of each
**computed from the record**, the recommendation phrased as a consequence, and a reply box
that takes the `D2 yes / D3 park` form. Findings behind a collapsed row.

### The fold

Three new event kinds (round posted, sort posted, answer recorded), shared through the
sidecar with the findings they govern. That is a `MATERIALIZER_VERSION` bump, **26 → 27**,
with the hazard `finding-backlog.md` states verbatim, and `db-migrate.test.ts` pins the new
vocabulary. Scope follows `cross-universe-standard.md`: a round and its plan-only answers
are per-universe, like the findings they govern; a promoted answer becomes law and goes to
the workspace standard through the existing spec path.

### The skills

`triage-review` and `ez-plan` post the sort and the round **when codemap is present**, and
write markdown alone when it is not: both ship to people with no codemap (a todo list from
another project is the standing example). The records they already write — `sort.md`,
`owner.md` — stay the source; codemap is where they stop being lost.

One change the skills need regardless: **keep the reproducer.** `triage-review`'s landing
step already says *"derive a check from the finding's words and watch it fail first"*, and
then records one line and a commit. Record the command and its fail-then-pass result too;
it is the `reproduced` row the verifier re-runs.

## 8. The downstream team's note, item by item

Ten items from a team running both tools on four cards (`~/Desktop/note-to-izzie.md`,
outside this repo).

| id | the ask | this plan |
|---|---|---|
| **IZ-2** | close a PR's findings on merge | **Addressed differently.** Status still follows the merge; closing is the verifier's, with evidence, and no person clicks anything. A person sees only decisions. |
| **IZ-8** | an `N` list with a veto; don't re-ask what was ruled; Discuss First loses the form | **Addressed.** Numbered decisions, `D2 yes / D3 park`, and effects on the record so the confirm gate is not a second message. Discuss First staying free-form is the skill's to decide. |
| *general* | a blind sort and an arbitrator over findings claimed fixed | **The core of it** — the sort before the fix, the verifier after. |
| **IZ-7** | carry a recorded verification forward | **Partly.** The verifier re-runs recorded evidence instead of re-reading code, and one record serves triage and codemap. Carrying a verification across commits where nothing in scope changed is not designed here. |
| **IZ-3** | a rule approved in the session should not be asked again in the browser | **Partly.** A promoted answer is bound to the hash of the text shown, which is what makes it *possible* for that answer to count as sign-off. Whether it should is §9's first question. |
| **IZ-6** | state the evidence at build start, not at the close | **Partly.** For findings, the closing condition is fixed at sort time, before the fix. For a rule's audit evidence, no change; a "using codemap" skill may be the better answer there. |
| **IZ-10** | the round record from inside a worktree | **Incidentally.** MCP writes go through the server, not the sandbox, so the durable half no longer needs the git-dir path. The markdown record still does; committing it, or an opt-in in-tree folder, is the skill's fix. |
| **IZ-1** | `at:` on `record_audit` and `close_finding` | **Not addressed, and a prerequisite.** The verifier must record against the merged commit, not the checkout's. |
| **IZ-4** | codemap owns its freshness | **Not addressed.** |
| **IZ-5** | say when the map is stale | **Not addressed.** |
| **IZ-9** | a size-aware triage path | **Not addressed.** The owner's reply points at the review producing findings nobody wants, not at the sort: one sorter is what mis-classifies. A round with no decisions does put nothing in front of a person, which is the cheap half. |

## 9. Open

- **Does a promoted answer count as sign-off?** (IZ-3.) The hash binding makes it
  mechanically possible. The risk the owner named is a subagent of a subagent approving
  something a person should read, and a ratified spec is only different from a markdown doc
  if a person actually read it. Recommendation: the answer drafts the operation, and
  ratification stays its own act — but that leaves IZ-3 as it is.
- **Closing and hiding.** Agent-closed findings leaving every human view is the point of §1,
  and it is the exception `codemap-now` says must be stated if it is taken: everything else
  here refuses to close silently. This proposal takes it, for **verified** closes only.
- **Is `fixed-on-default` still stored** once `findingLanding` derives landing and the
  verifier derives adequacy?
- **May a relayed answer ever settle?** §6 says no. If typing `! codemap answer` turns out
  to be the friction that leaves rounds open, this is the lever — and the cost is that
  bulk-closing becomes an agent act.
- **The item.** A sort covers findings through items; `effects` names findings. Whether the
  verifier needs to address an item after its round closed is `plan-decision-log.md`'s
  falsifier 4, and this is the first design that might.

## 10. What to measure

- **Voids filled by agents** — closes and fixes that took authority nobody granted, against
  7.1%. The number this exists to move.
- **Decisions left open after the session**, and parked against answered. How much the
  web queue actually carries.
- **Verifier yield** — of group-1 closes, how many carry a reproducer that re-runs, and how
  many of those are wrong. This replaces 3/8 as the number to beat
  (`PROPOSAL-close-pipeline.md` §8).

Measure on a downstream team's rounds, not on codemap's. On codemap the owner is the
requirements oracle and every fix is local, so every one of these reads better than it
will anywhere else.
