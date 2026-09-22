# Proposal: what a close has to show

> **Kind: proposal — not approved.** Filed 2026-09-21 against `main` at `161d754`. The
> measurement in §1 is over the Acme.API and Acme.React finding ledgers as they stood that
> day and is reproducible with the commands given. §4's principle is already law here;
> §5 is the only thing being proposed. The pipeline in §7 is **not** proposed — it is
> named so the first step is not mistaken for a commitment to it.

## 1. The measurement

Every `fixed` outcome in both ledgers — **183 of them, across 172 distinct findings** — was
written by an agent. There is not one human fix-vouch in either store.

```bash
cd /working/Acme.API/.codemap && sqlite3 -readonly codemap.db "select count(*) from findings"
# then, per finding body: outcomes[].result == "fixed", by.via.kind == "agent"
```

What those 183 closes actually name as evidence:

| what the close names | n | |
|---|---:|---|
| a **falsifier** — what fails without the fix | 52 | 28% |
| a predicate — a command with a stated expected result | ~7 | ~4% |
| nothing re-runnable: a description, often with a suite count | ~99 | ~54% |
| **declares outright that it has no check** | 25 | 14% |

The falsifier count is hand-verified: ten sampled at random, ten true positives, each naming
a mutation or revert and its outcome (*"reverting the three sites fails exactly 2 of 7"*,
*"restore the one-sided form and all four go red"*). The predicate count is a floor — a
spot-check found three of ten were prose *about* a predicate rather than a predicate run.

**Roughly a third of closes volunteer a re-runnable check although nothing asks for one.**

Two other numbers from the same pass, because they bear on §5:

- **13 closes (7.1%) carried a decision nobody with authority made** — new business rules
  invented in review, a credential-hashing scheme replaced on a finding that said outright
  *"Design decision, not a mechanical fix"*, a new endpoint built to close a finding, one
  close that overrode the filed disposition. Five of the thirteen say so themselves
  (*"NEEDS EYES"*, *"a judgement call, not a mechanical fix"*).
- **6 closes were false or introduced a new defect — and every one of them came from the 10
  findings whose fix got a second pass.** The other 162 produced zero, because nothing
  looked. One false vouch claimed `fixed-on-branch` in a commit `git show --stat` shows never
  touched the file; it was caught only because a person reopened it.

## 2. A green suite is not evidence about this fix

The 54% bucket is not empty — most of it carries `1439 passed, 0 failed` or `build 0 errors,
targeted tests green`. That is evidence that the tree is not broken. It is not evidence that
the fix does anything, and this repository has the counterexamples in its own history:

- `deletion-bug.test.ts` passed with the read-side file ladder **wholly removed** — it never
  re-indexed, so it asserted through a stale `@work`.
- Four of the oracle's six properties were **vacuous on first write**: `ownership` passed
  after deleting every fold-owned row; `converged` never read the projections it claims to be
  about.
- §B3's fixture branched straight off main, so the base it passed and the base the code
  derives were the same commit — the fix's base half was untested and green.

That is `CLAUDE.md`'s own standing rule — *"Check that a passing property COULD have failed"*
— and the reason the falsifier shape is the one worth asking for. It is simultaneously the
only form that is re-runnable without judgement and the only one that cannot be vacuous.

## 3. The gap

`record_audit` takes structured evidence and **grades** it:

```
evidence: { read: [anchors], ran: [{command, passed}], consulted: [docs] }
```

with the tool's own description saying doc-only evidence *"is recorded but is weaker on
purpose."* `close_finding` takes prose `detail` and `files` — and `files` takes **one path
maximum**, which several closes work around by listing the rest in prose (*"the tool takes one
in `files`"* appears verbatim in the ledger).

So the one thing that would make a fix-vouch checkable has nowhere to live, on the one verb
where the claim is about a change rather than about a reading.

## 4. The principle is already settled here

`docs/finding-backlog.md:87`, under *Re-witnessing, and why an agent may*, and
`src/ops/annotations.ts:1256`:

> It is **evidence, not a disposition**, which is why the gate is off.

An agent may repair a witness, because repairing one is evidence; the disposition it feeds
stays principal-granted. The close side splits the same way and needs no new principle:

- **did the fix happen** — evidence. An agent may establish it, and a recorded falsifier lets
  a later pass re-establish it with no judgement at all.
- **did the fix take authority it did not have** — a disposition. Stays with a person.

## 5. What to add

**On `close_finding`, an `evidence` object mirroring `record_audit`'s, graded the same way**,
with one addition that carries the §2 lesson:

- `ran: [{command, passed}]` — as on `record_audit`.
- `falsified: [{command, without_fix, with_fix}]` — the check that fails without the change.
  This is the field the 28% are already writing into prose.
- `read: [anchorIds]`, `consulted: [docs]` — as on `record_audit`, and weaker, explicitly.

**And `at:` on both write verbs**, which `context`, `search`, `get_node`, `get_anchor` and
`outline` already take (`src/mcp.ts`, the shared `AT` schema). Measured warrant: **3 of the
183 vouches are pure re-reports**, the same close recorded two or three times because the
disposition was refused — *"codemap's universe checkout is on develop, which does not contain
b24abc7e."* No fix in the second or third call; only bookkeeping.

### Three things NOT to do

- **Do not demand a test.** 25 closes declare they have none and most give a good reason — a
  two-line null guard needing a DB-backed integration test was judged a poor trade, correctly.
  The slot records and grades what was done; it does not extract a bad test by refusing.
- **Do not make `falsified` required.** A required evidence field is a field that gets filled
  with the nearest available string. `record_audit` demonstrates the working shape: everything
  optional, the weak kinds recorded *as* weak.
- **Do not let an agent assert `fixed-on-default`.** The refusal at `src/ops/annotations.ts:141`
  should probably not be lifted by `at:` at all — `findingLanding` (`src/pr.ts:1224`) already
  derives landing from the code first, ancestry second, GitHub only as a fallback. A stored
  `fixed-on-default` is a second source of truth for something computed on every read. **Open:
  whether to stop storing it rather than to let `at:` justify writing it.**

## 6. What it buys

A **re-runner** — execute the recorded falsifier, compare — settles "did the fix happen" for
whatever names one, today about a third of the queue, with no reader and no judgement. That is
the close-side form of this project's own COD-18 lesson: to review a fold, run it. The
closes that were fastest to confirm by hand were exactly the mutation-proven ones, because
they named the command; the slowest were prose.

Everything mechanically settled never reaches a reader. What is left for a person is the
disposition question, which the same pass sized at **13 of 183 (7%) authority-taking, plus 9
(5%) where a principal had already ruled** — the second group being what it looks like when
this works (*"meet the spec, add the provenance bit"*, *"fix before merge, red-first"*). Those
nine are rulings, not verifications, and rulings are the thing only a person can supply.

## 7. What is NOT proposed here, and the caution

A sort-and-verify pipeline over claimed-fixed findings is the obvious next thing and is
**deliberately out of scope for this document.** Two reasons to name it rather than drift into
it:

**It automates the close side, and automating the open side is what produced
`review-fix-loop`** — measured in `/working/skills/ideas/automated-integration/`: 142 findings
applied with no gate, 65% of consecutive iterations editing a file the previous one had just
fixed, and a blind re-sort putting **37 of the 142 outside "implementation defect"**, 36 of
them auto-applied. The four properties that distinguish a sort from that loop are enumerable
and would have to be written in as requirements, not hoped for:

1. it never reviews its own fixes;
2. blame runs first, so fixes-on-fixes are visible rather than undetectable by construction;
3. the classification axis is **authority, not severity** — the same re-sort found no severity
   threshold that beats applying everything, and applying everything is wrong 26% of the time;
4. the gate is mandatory and names items one by one.

**And (1) is awkward here on purpose:** a close-side reader *is* reviewing fixes. The property
that has to survive is blindness to the fixer's own account — which means blind to `detail`,
the field a person reads. Building the reader before the evidence slot exists would force it
to read `detail`, which is the one input it must not have.

## 8. Open

- Whether `fixed-on-default` should stop being stored (§5).
- The grain of any later close-side reader's output: a list of authority-taking closes, or a
  rate with the exceptions named. `automated-integration` §7 already warns that the analogous
  gate has unbounded grain and is untested at size; a close queue is worse, being cumulative.
  385 findings in the Acme.API ledger.
- Whether closing-and-hiding a finding is acceptable at all. Everything else here refuses to
  close silently — `close_finding`'s own contract is that reporting and agreeing it is closed
  are different acts. If that is to have an exception, it should be stated as one.
- `files` taking one path maximum. Not proposed as part of this, but the ledger shows fixes
  routinely spanning more, with the remainder in prose where nothing can read it.
