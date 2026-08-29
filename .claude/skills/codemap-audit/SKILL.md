---
name: codemap-audit
description: >-
  Work a codemap standard queue: a scrub (coverage deadlines), a differential audit
  (what a change touched), or a baseline sweep before a high-risk ship. Use when the
  hub says something is overdue, when a branch is about to land, before a release, or
  when asked to audit requirements. Records what it actually read and ran, files
  problems it may not resolve, and refuses to certify anything it did not check.
---

# Working a standard queue

The requirements subsystem records what a caller reports; **nothing runs a lint and
nothing runs a scrub**, by design. You are the thing that runs. That is the whole
reason this file exists.

Read `docs/requirements-architecture.md` § *What resets a coverage deadline* and
`docs/cross-universe-standard.md` before your first pass. They are normative and
short.

## Pick the job, because they select on different things

| Ask | Trigger | What you look at |
| --- | --- | --- |
| "something is overdue" | `scrub` | `standard_queue` → whatever `scrub_plan` lists as due |
| "this branch is landing" | `differential` | the rules `/diff` rolls up, via their pointers |
| "we ship on Friday" | `baseline` | everything in force — expensive on purpose |
| curiosity | `ad-hoc` | whatever you like; it resets no deadline and nobody asked |

Use `scrub_plan` for the first, `diff` for the second, `baseline_plan` for the third.
`audit_queue` tells you which pointers are FIRING and which rules have nothing
watching them at all — the second half matters as much, because a rule with no
pointer can never rise and its silence is not calm.

## The rules that will refuse you, and why they are not obstacles

- **A `conformant` audit needs code you READ or a command you RAN, and anchors in
  `evidence.read`.** Consulting documentation is not enough — a stale doc yields a
  pass rather than a flag, so a doc-only check certifies nothing. And without anchors
  nothing can ever move under the claim, so it would read as verified for ever.
- **A `nonconformant` audit needs demonstrated non-conformance.** *"I could not verify
  this"* is an unverified requirement, not a violation. File `indeterminate`, which is
  the quiet bucket and may carry nothing.
- **A `scrub` or `baseline` audit must say what EVERY active pointer was doing**
  (`observations: [{pointerId, firing}]`). A `differential` one reports the subset it
  examined, and only those pointers' deadlines move. An `ad-hoc` one carries none.
- **You may raise a problem and you may never adjudicate one.** Which side moves is a
  business question. Put your view in `prior` — it is recorded as context precisely so
  it does not have to be smuggled in as a resolution.
- **You cannot ratify, withdraw, grant debt or re-file.** Those are a person's, and
  the refusal is deliberate rather than an oversight. Say what you would propose and
  leave it.

## How to audit one rule

1. `requirement <id>` — the statement, what watches it, what has silenced it, what
   discharges it (`criteria`), and what it ranges over (`population`).
2. **Read the code.** The pointers say where; `get_anchor` gives you the body. If a
   criterion names an `assertedBy` check, run it — a green check that is asserted is a
   stronger claim than an unedited anchor, which is exactly why a vacuous one is worse
   than no check at all.
3. Decide. `conformant` only if you touched code and it holds. `nonconformant` only if
   you can show it. Otherwise `indeterminate`.
4. `record_audit` with the trigger, the evidence, and the observations the trigger
   owes. If nonconformant, `raise_problem` against it.

## What NOT to do

- Do not economise on verification to save tokens. That is the one measured way this
  goes wrong (COD-27): the saving is visible and the cost — a closed gap and a
  disabled detector — is not.
- Do not audit off the default branch and expect it to count. A branch finding is
  **provisional**: it travels to your teammates as a document so a reviewer can see it,
  it moves nobody's conformance, and it becomes an observation of the codebase only by
  promotion, decided on witnesses.
- Do not audit with a dirty tree if you want the finding to travel. The witnesses come
  off the filesystem while the commit names an unchanged HEAD, so it stays local — and
  `record_audit` tells you so in `notShared`.
- Do not report a firing rate from one look, and do not repeat an observation to reach
  one. Both are refused, and both are the error the scrub exists to catch.

## When you are done

Say what you looked at, what you could not decide and why, and what you would have
proposed if you were allowed to. The last one is the most valuable thing you produce
that the store cannot hold.
