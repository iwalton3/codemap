## Reconcile

1. **Three conflicts go to one arbitrator** (`references/contract.md` R3), launched once for every
   tie in the round — never one per tie — and nothing else applies to those items until it returns.
   They are not the owner's question, and not yours to break the tie on:
   - **valid or not** — one sorter calls it invalid and the other calls it real;
   - **one finding or two** — the sorters' covers sets differ;
   - **isolated or pattern** — both put it in group 1, with different kinds.

   Substitute every bracket:

   > Break the ties between two sorters of review findings. You are read-only.
   >
   > - the ties, each with its kind: `<per tie: valid or not / one finding or two / isolated defect
   >   or defect pattern>`
   > - the findings behind each tie, as the reviewer wrote them: `<each from RECORD/findings.md,
   >   with its number, under its tie>`
   > - how each sorter read them, and nothing else of either reading: `<per tie, every entry in
   >   RECORD/sort-a.md and RECORD/sort-b.md that covers any of that tie's findings. You are given
   >   the union of these across your ties and no more of either sort>`
   > - what the artifact is for: `<the purpose sentences, "not stated", or "code">`, and which
   >   parts of each member are inside it. *Out of scope* is a verdict only on a document with a
   >   stated purpose, decided against these and nothing else: never on code, and never where the
   >   purpose is `not stated`.
   > - the artifact: `<each member's absolute path and commit, or for a document, the version under
   >   review>`
   > - the round: `<which review>`
   > - the definitions: `SKILL_DIR/prompts/sorter.md`
   > - what the work was built against: `<the written criteria steps/1-blame.md collected, or
   >   "none">` — read them to judge a finding, as the artifact's own requirements
   >
   > **Settle validity for every tied item first, then the action axis** — the covers split, and
   > isolated versus pattern. **Skip the action question on anything you invalidated:** it is moot.
   >
   > Read the artifact at those commits and the history under them. Do not go looking for any
   > earlier sort, triage record or ruling on these items, or any plan beyond the criteria above:
   > finding the previous answer makes you an echo, not a third reading. If you come across one
   > anyway, name it and do not decide on it.
   >
   > **Rule each tie on evidence from the artifact, never on the other sorter's record across
   > ties.** Finding one sorter wrong on one tie tells you nothing about that sorter on the next.
   >
   > Answer each tie under its own heading — valid or invalid and which refutation; one item or two
   > and which findings each covers; isolated or pattern and the sites you counted with the command
   > — **what you rested on, per tie**, and anything you needed and were not given.
   >
   > **You may launch your own reader for a tie that needs a lot of code or docs read** — for depth,
   > never for count; you alone are the default and the common case. If you do, its brief carries
   > these, or they are dropped where nobody is watching: it uses the Delegate Model with **no inherited history**; it carries the anti-echo paragraph above
   > verbatim; it is given only what *that* tie was given, never the union across your ties; and its
   > reply comes back inside your answer — and so into `RECORD/arbitration.md` — **verbatim and
   > attributed**, never folded into your own prose.

   **Save the reply verbatim to `RECORD/arbitration.md`**, keeping its heading per tie. Where it
   reports a gap instead of a verdict, carry that item as an open question. **Every item that went
   to the arbitrator is marked "don't fix early"**, whatever was ruled (`references/contract.md`
   P1).

2. **Every other disagreement is carried, never settled here** — a different group, a different
   site count. Keep both readings, who gave them, and each command where the sorter gave one. The
   higher count is not automatically right, and neither is yours.

## Route

Using the blame from `steps/1-blame.md`, one of three (`references/contract.md` R4):

- **No finding is fixes on fixes** → land, then hand over to `ez-plan`.
- **Fixes on fixes** → answer R4's question from the blame and the sort: *are there assumptions or
  inconsistencies in the codebase, created during the last fix round, which aren't easily
  explainable or summarizable to a human?*
  - **No** — each gap is one the owner can fill, and it is known: work not completely applied, a
    rule stated in a plan and forgotten, a design change this round follows. A prior run that ended
    in ad-hoc fixes wrote no `plan.md`; its `sort.md` choice line marked `cancelled` and its
    commits' trailer and message — on a Claude Artifact, the published version's label alone — are
    its explanation, written down. → land, then hand over, **without asking**. Say in `sort.md`'s
    route, in one or two sentences, that it was fixes on fixes and why no diagnosis was needed.
  - **Yes** — inconsistencies, many hidden assumptions, or rot patterns → ask the owner: *diagnose,
    or don't?*, recommending Diagnose. A diagnosis takes about half an hour, so this bar is narrow.
    State why in one or two sentences in the question's own text, in the artifact's terms: no
    quoted finding text, no finding ids, site lists, group names or counts. Route by the answer.

## Write `RECORD/sort.md`

In the order `references/shared.md` S2 gives, in plain prose. What this skill puts in it:

- **Who sorted it**: two sorters, one blind, and the arbitrator.
- **The items**, clustered, each with both sorters' readings wherever they differed, any
  arbitration with its outcome and the path of its reply, and **"don't fix early"** where it went to
  the arbitrator.
- **The round**: the unit, and per member the range the review covered — through the in-flight
  commit for a review this session ran; otherwise the pull request's or the branch's range unless
  the owner said otherwise. Then which review, at which commit, and which findings were fixes on
  fixes — or one sentence saying the findings are new work against existing code
  (`references/contract.md` R1). For a versioned Artifact, per version: fixes on fixes or not and what
  the call rested on, any version not held, and node 4's question and answer verbatim.
- **The route and why**, with the owner's answer verbatim if they were asked.
- **One sentence of counts about the review itself** — *eleven of twenty were out of scope.*
- **The carried sentences**, and last, **`Uncovered:`**.

*What landed* and `ez-plan`'s choice lines are appended later.

**Apply none of the round here.** Then read the first file of the route:

- no diagnosis: `SKILL_DIR/steps/5-land-and-hand-over.md`
- diagnosis: `SKILL_DIR/steps/diagnose-1-checkpoint.md`
