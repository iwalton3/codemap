# Picking up the close-audit work

> **Kind: handoff.** Written 2026-09-22 at the end of the measurement arc in
> `PROPOSAL-close-evidence.md` §8.6–§8.8. That document is the evidence; this one is what to
> do next, and what not to do again. Nothing here is ratified.

## Read this first if you read nothing else

**This is not a skill, and the shape that looked obvious does not work.** "Two agents audit the
close, an arbitrator settles conflicts, agreement closes it" was measured three ways and failed
three ways: symmetric agents agreed 16/16 *and missed together*; asymmetric roles routed well but
flagged 88% of everything; and a paired design showed the refuter cannot tell a known-defective
fix from the same fix after repair (p = 0.50).

**The generalisation worth carrying:** every mechanism that discriminated asked a question with
edges. Every one that failed asked an open one.

| worked | did not |
|---|---|
| "can I falsify THIS change?" — perfect separation | "can I find a failing case?" — fires on 88% |
| "does this close carry a decision nobody made?" — 13/183 by reading records | "is this fixed?" — agreement without accuracy |

So: **auto-close is earned by the closer's evidence, not granted by a checker.** Build the
evidence slot (§5), not the auditor-as-gate.

## What we are actually dealing with

> Added 2026-09-22, after the arc, from re-reading the three runs together. It reads the table
> above at a finer grain, and it changes which shape below is most decisive.

**Every discriminating result in the arc detected the same single class: no change present.**

- §8.6 — the two controls both agents caught were *the fix was never written* and *audited at its
  pre-fix commit*.
- §8.7 — the Prover's refusal, the one clean discriminator, fired on exactly those two and on
  nothing else.
- §8.8 — 3/8, the same three items, for the third time.

Nothing in five auditor passes ever detected the **inadequacy** of a change. It detected the
**absence** of one. So bounded-versus-unbounded is the right shape at the wrong grain: the bounded
question that worked is bounded because it asks about existence, and existence is one bit about an
artifact already in hand.

Which means **a falsifier proves non-vacuity, not sufficiency.** Re-running the 52 recorded
falsifiers (shape 1) establishes that a real change was made and that it does something. It does
not establish that the finding is fixed. Still the cheapest thing here and still worth doing first
— but it is tier 0, and it should be sold as *"a change exists and is not vacuous"* rather than as
a close.

### A close is a conjunction of up to four independent claims

Different bounds, different admissible evidence, different answers to *may an agent do this*:

| the claim | bounded by | what settles it | the fix-failure it catches |
|---|---|---|---|
| a change exists and does something | the change | a falsifier — mutate it, the check reds | — |
| the finding's own defect no longer fires | the finding | its reproducer, re-run | insufficient, invalid |
| every instance is covered | the pattern | a predicate, zero hits | not-enumerated |
| the change did nothing else | the diff | every hunk attributed to the ask | new-defect |
| somebody with standing decided | nothing in code | a ruling | assumption |

§8.1's *"the audit and the evidence slot produce one thing, not two"* is the load-bearing error.
Reproduce-at-witness and mutate-the-change are two artifacts answering two questions with two
different bounds. §8.8 half-caught it — *"execution establishes that an artifact is SOUND, not that
it is RELEVANT"* — and kept them fused anyway.

### Why one model asked one question cannot work

**The truth condition varies by finding type, and the store does not record the type.**
`Annotation` carries `kind` (note/question/finding/pointer), `severity`, a freeform `category` and
`disposition` — nothing that says which of the sort's five groups an item is, and so nothing that
says what would close it. An auditor therefore reconstructs the closing condition from code under
batch pressure, and defaults to the modal type (isolated defect) and the cheapest condition (the
site is patched). On an isolated defect that is nearly right, which is why it reads as calibrated.
On a pattern it is 1/N of the truth. On a design defect or an assumption the truth condition is a
**ruling**, which is not in the code at all — so there an auditor cannot fail honestly; it can only
read the site and say fixed.

**And the agreement is bias, not luck.** Two models sharing a prior and confirming it locally will
agree. Replication and role asymmetry both attack variance; this failure is bias, and no amount of
independent sampling reduces bias. That is what 16/16, and then *3/8, same three items, three
times*, looks like from outside.

**The five never-found defects all sit in the one row with no bound** — *the change did nothing
else*. "What else broke?" is an open search over the whole program, and §8.8 showed that in this
codebase such a search always succeeds. But **"what else changed?" is finite**: the authorization
widening was a hunk outside the ask. That class is reachable by attribution and never by search,
which is a stronger argument for shape 2 than the one given for it below.

### How the list below reads now

1 settles vacuity — do it first because it is free, but on its own it closes nothing. 2 is the only
shape that touches the row with no bound. 3 is answered rather than open: narrowing to the
finding's own defect **is** the second row, and it needs that finding's reproducer recorded when the
finding was sorted, which nothing collects today. 4 is the *ruling* row and is not a detector
problem at all. 5 belongs with 2.

The follow-through — storing the closing condition instead of re-deriving it — is
`docs/PROPOSAL-close-pipeline.md`.

## Shapes to try, most decisive first

Each names the data that already exists, so none starts from zero.

### 1. The falsifier re-runner — no agent at all

**52 of 183 closes already name a mutation and the check it breaks**, unprompted. Extract them,
re-apply the mutation at the fix commit, run the named check, and see it go red; restore, see it
go green.

- *Settles:* what fraction of recorded falsifiers actually re-run, and whether any are wrong. That
  number is the real ceiling on tier-1 auto-close.
- *Cost:* mechanical. The build works — see **Making it buildable** below.
- *Changes the design if:* a meaningful share fail to re-run. Then recorded falsifiers are prose
  too, and the slot needs a verifier at write time rather than at close time.

### 2. Scope-delta — the one that might catch the class nobody found

For each close, compare **what the finding asked for** against **what the commit actually
touched** (files, symbols, and whether the change adds a branch on authorization or state).
Anything outside the ask is flagged for a person.

- *Settles:* whether the authorization-widening class is reachable at all. It is the one defect of
  the five that no control and no falsifier catches, because the fix did what was asked *and
  something else*.
- *Test it against:* the known case — the existing-contract arm that appended its event
  unconditionally. Score it the way the others were scored: does it flag that commit, and does it
  stay quiet on the ordinary ones?
- *Bounded, so per the table above it stands a chance where a search did not.*

### 3. Narrow refutation — the direct test of §8.8's conclusion

Re-run the refuter, paired exactly as §8.8 did, with one change: **the failing case must fire the
FINDING'S OWN defect.** Anything else is out of scope and gets filed as a new finding instead of
blocking the close.

- *Settles:* whether narrowing restores discrimination. §8.8 argues it should and does not show it.
- *Reuse:* `close-audit-2026-09-22-paired.jsonl` has the arms, commits and counterbalancing; the
  eight pairs and their pre/post commits are in it. Rerunning is a brief change, not a rebuild.
- *Changes the design if:* pre and post separate. Then the auditor can gate, narrowly. If they
  still do not, the auditor is bug discovery only and should be built and sold as that.

### 4. Does the authority detector automate?

The 7.1% authority-taking rate was found by **one reader going through 183 close records by
hand**, with no access to the codebase. Ground truth exists for all 183.

- *Settles:* whether the single detector with a confirmed hit rate can be run by an agent.
- *Reuse:* the hand sort is the key; the scheme it used is in `PROPOSAL-close-evidence.md` §8.2's
  two axes and the A1/A2/A3 distinctions.
- *Watch for:* the same trap as everywhere else — an agent asked "did this take authority?" over
  an unbounded record may say yes to everything. Score against the hand sort, not against itself.

### 5. Controls, as a cheap second field

Two of the five never-found defects are **over-rejections** — the fix refused input it should
have accepted. A falsifier cannot see those; a *control* can, and the better closes already write
them ("a table AT the cap is still accepted", "the header mapping must STILL apply").

- *Settles:* coverage — how many closes already carry a control — and whether requiring one would
  have caught the wrong-sentinel case.
- *Cheapest of the five, and it feeds straight into §5's slot.*

## What not to do again

- **Do not gate on an auditor's failure to refute.** Absence of evidence is not a verdict, and
  §8.8 shows the refuter's evidence is present nearly always regardless of truth.
- **Do not read agreement as confidence.** Two models of different families agreed 16/16 while
  missing four known-bad fixes identically. The arbitrator never fires when both are wrong the
  same way.
- **Do not put the asymmetry in the desired conclusion.** Opposed objectives manufacture
  disagreement exactly as symmetric briefs manufacture agreement. Asymmetry belongs in the
  artifact each role must produce.
- **Do not trust "produced an artifact" as "found the defect."** Three separate runs scored 3/8 on
  defect identity while scoring far higher on producing something. The disposition can be right
  while the reason is wrong, and it was, four times out of seven.

## Traps that cost time in this arc

- **The fix commit is not always the first sha in the vouch.** Several vouches open with a tree
  check — *"witnessed at <sha>, an ancestor of…"* — so a naive regex pins the audit to the commit
  BEFORE the fix. Two items were mis-pinned this way; both became accidental controls, which was
  luck, not design.
- **13% of findings have had their submitter-facing comment overwritten with the fix report.** The
  as-filed wording survives at `revisions[].was.comment` — under `was`, which is the key an
  earlier attempt at this guessed wrong, silently, serving the fixer's own account to an auditor
  on 3 of 16 items.
- **`git checkout <sha>` and `git worktree add` both print the commit subject.** Two agents saw one
  that way despite being told not to read messages. Instruction cannot close it; only serving the
  tree differently can.
- **`cmd | tail -20` reports `tail`'s exit code.** One agent read a failing build as exit 0 and
  spent its run writing tests it could not run.

## Making it buildable

The reason the first two runs produced only static traces: `Acme.BaseClasses` is a submodule whose
`.gitmodules` url is relative and resolves into a directory agents may not read. Mirror it instead:

```sh
git clone --local --bare <baseclasses> ./baseclasses.git
git clone --local <api> repo && cd repo
rm -rf Acme.BaseClasses && git clone ../baseclasses.git Acme.BaseClasses
git -C Acme.BaseClasses checkout $(git ls-tree HEAD Acme.BaseClasses | awk '{print $3}')
dotnet build Acme.API.Tests/Acme.API.Tests.csproj -v q --nologo     # ~16s, 0 errors
```

Re-run the last two lines after every `git checkout <audit_at>` — the gitlink moves per commit and
the mirror has the history to follow it. Many tests need a database and will fail for that reason;
that failure is not evidence of anything.

## The by-product, which may outlast the research

Two refuter runs produced **~21 defects, 18 demonstrated by execution**, against code that is
merged or on open PRs — including several on commits where a verification round had already
declared the fix repaired. Runnable sources, the manifest and the per-item records are at
`~/Desktop/close-audit-repros-2026-09-22/`, kept outside this repo because they carry real
namespaces.

**They were never triaged.** They are a side effect of measuring an audit loop, not a review, and
nobody has ruled on whether any of them is real, in scope, or worth a bug. That is a queue with no
disposition — which is the exact problem `docs/finding-backlog.md` exists to name.
