---
name: codemap-check-fixes
description: >-
  Check a review round's fixes without a full review: batch-verify every repair requested on the
  review — one verifier for low-stakes findings, two and an arbitrator where they split for
  high-stakes ones — and read only the fix hunks for new defects, reported for triage. Use when
  the person wants the last round's fixes confirmed and not the whole branch reviewed again.
argument-hint: "<review, e.g. 7 or acme/api#7>"
---

A round's close-out costs a fixed number of agents, whatever the number of findings: one verifier
per slot covers every request on the review. Slot 1 always; slot 2 only where a request is
high-stakes; an arbitrator only where the two high-stakes runs split. Each verifier also reads the
fix hunks it checked for new defects, so the round gets some review of the fixes themselves.

This needs codemap's shared mode and Claude Code subagents: codemap counts a subagent's
verification only from Claude Code's transcripts. The whole procedure behind each step is the
codemap skill's `references/verify-repair.md`; read it if a step below refuses.

## 1. What is open

`pull`, then `repair_pending` for the review. It lists open jobs: verifier slots per request, and
any arbitration. A finding that was fixed but has no request yet needs its claims, sort, evidence
and `repair_request` first (`verify-repair.md` steps 1-4) — do those, `sync` if a `begin` is open,
then come back. If nothing is open, say so and stop.

## 2. One verifier per slot

For each slot with open jobs, `repair_batch_brief` with the review, `role: "verifier"` and the slot.
It returns `launch`, one line, and the entries it covers. Launch one fresh subagent per slot from
this session — never a fork, never from inside another subagent — with `isolation: "worktree"` and
an agent type that has the codemap tools. Its prompt is the `launch` line, whole and on a line of
its own, then this, and nothing else:

```
Then, for each entry you verified, read only the hunks between its evidence's base and fix commits
for defects the fix introduced. Report each as a finding in your final reply — file, symbol, the
line, what goes wrong and how you checked — and do not file it anywhere. End your reply with the
receipt each repair_verification returned, by request id.
```

Write nothing else into the prompt: not what the fixes did, not what you expect. The verifiers are
blind, and the rest of the prompt is trusted. Slot 1 and slot 2 are different subagents; they may
run in parallel. Do not send either one anything after launch, and never relay one's result to the
other.

## 3. Record, then arbitrate

`record_repair_verification` for each receipt a verifier reports: the review, the request id,
`role: "verifier"`, its slot and the receipt. `pending` means wait a moment and record again; an
error that says the run will never count means launch a new verifier for that slot.

Then `repair_pending` again. If an arbitration is open, `repair_batch_brief` with
`role: "arbitrator"` covers every request that split: launch one more subagent with exactly its
`launch` line and nothing added, and record its receipts with `role: "arbitrator"`.

## 4. Apply and report

`repair_apply_verification` for each finding whose verdict closes it, with a reason
(`verify-repair.md` step 6). `decision-needed` and `unknown` are not applied: they are results.

Tell the person, per finding: the verdict, who ran what, what was applied and what stayed open and
why. Then the new defects the verifiers found in the fix hunks, as findings for `/triage-review` —
this skill files none of them.
