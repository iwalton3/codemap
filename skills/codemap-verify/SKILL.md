---
name: codemap-verify
description: >-
  Be a blind repair verifier for one review: claim the verifier role, take one open job, and
  check the repair yourself at the pinned commits. Started by a person in a fresh session; this
  is the grant that lets a session's verdict count (G1).
argument-hint: "<review, e.g. 7 or acme/api#7>"
disable-model-invocation: true
---

You are one of two blind verifiers of a repair, or the arbitrator between them. A person started
this session on purpose: that is what makes your verdict count. It only counts if you did the work
yourself and saw nothing of anyone else's conclusion.

## 1. Claim the role first

Call `claim_verifier` **before any other codemap tool**. A session that has already made a codemap
call cannot claim, and the claim is refused. If it is refused, stop and tell the person: this
session cannot verify, and they should start a fresh one.

After the claim, this connection can only call `repair_pending`, `repair_brief`,
`repair_verification` and `repair_arbitration`. Anything else is refused. That is the point.

## 2. Take one job

Call `repair_pending` with the review from the arguments. It lists open jobs: a request id and a
verifier slot (1 or 2), or an arbitration. If nothing is open, say so and stop.

Take **one** job. A claimed connection holds one job for its life, so a second one needs another
fresh session. Call `repair_brief` for it. The brief shows the claims, the sort, the pinned commits
and the checks the fixer pinned. It never shows another verdict or the fixer's conclusions. Do not
go looking for them in the repository, the pull request or the sidecar.

## 3. Check it yourself

Work in a scratch worktree at the pinned commits (`git worktree add <scratch> <commit>`), never in
anyone's live checkout.

- For each claim, first say with a reason why the pinned check actually tests the claim. If it does
  not, you cannot return `refuted` on it. Say so, and return `unknown` or judge it by inspection.
- **fixed**: run the check yourself. It must fail at the witness commit and pass at the fix commit,
  using the same command, and you record both runs. Run every check the fixer pinned this way. An
  echo of the fixer's result does not count.
- **factually-refuted**: run the check at the old code (the witness). It must show no defect there.
- **inspection**: only when there is no runnable check. Write why, and cite the commit and source
  you read.
- Otherwise `decision-needed` (a scope or requirement judgment) or `unknown`. Unknown is honest,
  and it never closes anything.

Record what actually happened, including a command that would not run.

## 4. Submit

Submit your results with `repair_verification` for your slot. As the arbitrator, submit with
`repair_arbitration`: address each disagreement with a reason, not a one-word verdict. Then stop.
Applying the verdict is someone else's act, and a verifier cannot apply its own.

Tell the person which job you took, what you ran, and what you found.
