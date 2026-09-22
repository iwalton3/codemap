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
