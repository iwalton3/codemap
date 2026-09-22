# Proposal: what a close has to show

> **Kind: proposal — not approved.** Filed 2026-09-21 against `main` at `161d754`. The
> measurement in §1 is over the Acme.API and Acme.React finding ledgers as they stood that
> day and is reproducible with the commands given. §4's principle is already law here;
> §5 is the only thing whose implementation is proposed. §8 records the shape of the audit
> loop as worked out with the owner on 2026-09-21 — **design discussed, not ratified, and not
> the next step** — so that §7's constraints have something concrete to bind.

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

A sort-and-verify pipeline over claimed-fixed findings is the obvious next thing. Its SHAPE is
in §8; what is not proposed is **building it before the slot lands**, for two reasons that
should bind whatever gets built:

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

## 8. The audit loop, as discussed

> Design worked out with the owner, 2026-09-21. **Not ratified and not the next step** — §5 is.
> Recorded because a shape nobody wrote down gets re-derived differently each round.

**Polarity.** Adversarial. The default is *not fixed*; the fix has to survive. Two independent
passes by different models, an arbitrator on conflict — the `triage-review` shape, reused
because the same problem produced it: a second reader settles whether a claim is true and
settles nothing about who had standing to act on it.

### 8.1 Failure to refute is not evidence of a fix

An auditor that cannot construct a failing case has not shown there is none, and closing on two
such passes treats absence of evidence as a verdict. Codemap refuses that shape twice already:
the `unfetched` bucket exists so a change this clone cannot see reads as an absence of evidence
rather than drift (*"never seen is not stale"*), and `pr.ts`'s GitHub fallback keeps ancestry's
answer because *"I could not ask" is never a verdict.*

**The control is free, because the finding already carries it — reproduce at the witness first:**

1. Reproduce the defect at the witness commit. Cannot → `unknown`. The finding does **not**
   close. This is *"check that a passing property COULD have failed"* turned on the auditor.
2. Run that same reproduction at the current commit. Still fires → `confirmed`. Does not fire →
   `fixed`, **and the reproduction is the falsifier** — the same artifact §5's `falsified` field
   wants. The audit and the evidence slot produce one thing, not two.

An auditor therefore cannot reach `fixed` without having first demonstrated it understood the
defect.

### 8.2 Two axes, because a fix can do both

Four exclusive verdicts about the FINDING — `unknown`, `confirmed`, `fixed`, `refuted` — and a
separate question about the FIX. A defective fix is not a fifth verdict: a fix can remove the
defect it was asked to remove *and* introduce another, and forcing one vote loses half of it.

Measured: **5 of the 183 closes were exactly that, and every one came from the 10 findings whose
fix got a second pass.** The sharpest is a close that added the branch the finding asked for —
so `fixed` is true — and appended its event unconditionally, letting an operator admin rewrite
an Active contract's governing law and liability cap through a path the direct endpoint denies
them.

So a defective fix is **FILED AS A FINDING**, not voted on. That is what it is — a new defect in
code somebody just wrote — and the better closes in the ledger already do it unprompted.

### 8.3 What each verdict may DO

§4's split decides this, and only one verdict can act alone:

| verdict | may |
|---|---|
| `fixed`, with a falsifier that fired at the witness and passes now | close — it is evidence |
| `confirmed` / `unknown` | nothing; the finding stays open, the audit is recorded |
| `refuted` | **ask, never act** |
| a defective fix | file a finding |

`refuted` is gated because `close_finding`'s own contract warns that reaching for it to mean
fixed *"marks a real defect a false positive and poisons the one question this data answers"* —
and an adversarial auditor has a standing incentive toward that exact error.

### 8.4 Conflict is detected on the evidence, not on the vote

Two agents reaching `fixed` look like agreement and may not be: one ran a falsifier, the other
read a comment asserting the fix. A verdict-level predicate never sees that, and it is precisely
the contamination path §8.5 cannot close.

So conflict is `(verdict, evidence cited)`. Two `fixed`es from different falsifiers agree. A
`fixed` backed by a re-run and a `fixed` backed by a reading is a conflict although the votes
match. `unknown` against `fixed` is always a conflict, and the arbitrator's first question there
is whether the one who concluded reproduced at the witness or merely failed to find a problem.

The arbitrator's effort asymmetry — routinely more than each finding got in the first pass — is
the design and not a side effect: the two cheap passes are a triage over *where to spend*, and
disagreement is a free signal for "this one needs thought." Widening the predicate to include
evidence will raise the arbitration rate, possibly sharply on early runs. That is the right
trade, and it should be expected rather than read as the pipeline misbehaving.

### 8.5 The role latch, and the three things it cannot reach

A skill claims the `fix-auditor` role as the **literal first call on the connection** — first
call or forfeit, rather than "no other *meaningful* calls," because "meaningful" is a judgement
the server would have to encode and the contamination risk lives in the reads that look
harmless.

**What the role is FOR is withholding reads, not restricting writes.** The fixer's account lives
in `detail`, and a server that does not serve it to this connection has made blindness a
property of the data flow rather than an instruction. Write restrictions matter less: they stop
an auditor becoming a fixer, which is the smaller hazard.

**Redact at the serialization boundary, not per tool.** `findings`, `review_queue`,
`shared_findings` and `get_node` all return finding bodies, and the body carries
`outcomes[].detail`. Guarding one verb and leaving the others serving the same field is the
`sidecarForWrite` failure verbatim — *"Guarding two doors was worse than guarding none, because
the comment then lied about the rest."*

Three contamination sources the latch cannot reach, in order of how controllable they are:

- **Commit messages — solvable.** `git show --format= --patch` is message-free, and if codemap
  serves the diff the auditor has no reason to shell out. Not enforcement, but it held for all
  142 findings of the blind re-sort run on 2026-09-21.
- **Round records — instruction only.** An agent with a shell can find them. Low risk under
  §8.1, where the verdict turns on whether a reproduction fires.
- **Inline comments asserting the fix — unreachable, and the worst.** You cannot audit a fix
  without reading the fixed code, and stripping comments hands the auditor a different program.
  Worse, `CLAUDE.md`'s comment rules forbid *"anything addressing a code reviewer to refute a
  finding"* while permitting *"decisions that look like mistakes to avoid them being 'fixed'"* —
  and the ledger is full of the permitted form, which contaminates identically. Enforcing the
  rule would not buy the blindness, and tightening it would cost the guards that are the point
  of writing them.

Which is why the weight sits on §8.1 rather than on blindness for this source. **A comment can
bias a reading; it cannot make a mutant pass.**

## 9. Open

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

From §8, each of which is measurable rather than arguable:

- **The disagreement rate between two auditors is unmeasured**, and the arbitrator's budget is a
  function of it. Nobody has run two passes over the same findings; the only comparable number
  here is that a single sorter corrected four of its own calls mid-pass.
- **Whether inline comments actually move verdicts.** Audit a sample twice — code as-is, and
  with comments stripped from the touched files — and see whether the verdicts differ. If they
  do not, §8.5's worst source stops being a worry. Cheaper than designing around it blind.
- **One connection per finding, or per batch.** Per-finding is the pure form; a batch is far
  cheaper but shares context BETWEEN findings, so the second is judged by a session that already
  formed a view on the first. Different contamination, not less of it.
- **Whether the auditor sees the diff.** It probably must — a diff is the change, not the
  narrative — but the line should be drawn deliberately rather than by what is convenient to
  serve.
