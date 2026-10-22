---
name: codemap-verify
description: >-
  Be a blind repair verifier for one review: claim the verifier role, take one open job, and
  check the repair yourself at the pinned commits. Started by a person in a fresh session; this
  is the grant that lets a session's verdict count (G1).
argument-hint: "<review, e.g. 7 or acme/api#7>"
disable-model-invocation: true
---

You are a blind verifier of a repair — the only one for a low-stakes request, one of two for a
high-stakes one — or the arbitrator between two. A person started
this session on purpose: that is what makes your verdict count. It only counts if you did the work
yourself and saw nothing of anyone else's conclusion.

## 1. Claim the role first

Call `claim_verifier` **before any other codemap tool**. A session that has already made a codemap
call cannot claim, and the claim is refused. If it is refused, stop and tell the person: this
session cannot verify, and they should start a fresh one.

After the claim, this connection can only call `pull`, `repair_pending`, `repair_brief`,
`repair_batch_brief`, `repair_derived_check`, `repair_verification` and `repair_arbitration`.
Anything else is refused.
That is the point.

## 2. Take one job

Call `pull` first: the request may have been made on another clone, and this one sees it only once
it has the team's log. If the pull refuses (a locked store, say), stop and show the person what it
said. This session cannot repair it.

Then call `repair_pending` with the review from the arguments. It lists open jobs: a request id and a
verifier slot (1 or 2), or an arbitration. A low-stakes request has slot 1 only. If nothing is open,
say so and stop.

Take **one** slot. `repair_batch_brief` with the review, `role: "verifier"` and the slot gives every
open job of that slot on the review, one entry each; with `role: "arbitrator"`, every request
whose two runs split. Or take a single job with `repair_brief`. A claimed connection holds that one
batch or job for its life, so another slot needs another fresh session. Each entry shows the
claims, the sort, the pinned commits and the checks the fixer pinned. It never shows another verdict or the fixer's conclusions. Do not
go looking for them in the repository, the pull request or the sidecar.

**Slot 2 of a high-stakes request is two steps.** Its entry first comes at `stage: "derive"`, with
the claims and the code only. Write the check you would run to test each claim — a command that
fails at the witness if the claim is true and passes at the fix — and submit it with
`repair_derived_check`. It is written once on this connection. Then read the brief again: it now carries the fixer's
evidence. Run your derived check at both commits too, and submit it as `derivedCheck`.

## 3. Check it yourself

Work in a scratch worktree at the pinned commits (`git worktree add <scratch> <commit>`), never in
anyone's live checkout — a fresh, clean one per commit, so no run sees a file another run wrote.

- For each claim, first say with a reason why the pinned check actually tests the claim. If it does
  not, you cannot return `refuted` on it. Say so, and return `unknown` or judge it by inspection.
- **fixed**: run the check yourself. It must fail at the witness commit and pass at the fix commit,
  using the same command, and you record both runs. Run every check the fixer pinned this way. An
  echo of the fixer's result does not count. A check that finds no test to run ("No tests found")
  is not a failure. Where the sort is marked `testGap` (its sorters read the claims as a missing
  test), a mutation run stands in for the witness failure: apply the named change at the fix commit
  and record the run failing as `phase: "mutation"`, beside its pass without the change; say whether
  that mutation tests this claim. On an unmarked sort a mutation run does not count.
- **factually-refuted**: run the check at the old code (the witness). It must show no defect there.
- **inspection**: only when there is no runnable check. Write why, and cite the commit and source
  you read.
- Otherwise `decision-needed` (a scope or requirement judgment) or `unknown`. Unknown is honest,
  and it never closes anything.

Record what actually happened, including a command that would not run.

## 4. Submit

Submit your results with `repair_verification` for your slot, once per request in your batch.
Anything real you found beside the claim goes in `leftovers`, not in a reason: a `problem` becomes a
new, narrower finding when the verdict is applied; a `note` stays on the closure. As the arbitrator, submit with
`repair_arbitration`: address each disagreement with a reason, not a one-word verdict. Then stop.
Applying the verdict is someone else's act, and a verifier cannot apply its own.

Tell the person which job you took, what you ran, and what you found.
