# Plan: the decision log, prototyped in markdown

> **Kind: prototype plan** — the shape is decided, the schema deliberately is not.
> Written 2026-09-22 from the diagnosis in `close-audit-next.md` § *What we are actually
> dealing with* and the design discussion after `PROPOSAL-close-pipeline.md`. It supersedes
> that proposal's §3(b) and §8's first two open questions; the rest of it still stands.

**Status: ready, and nothing is built.** The thing being prototyped exists nowhere today, so
there is no migration, no fold, no `MATERIALIZER_VERSION` bump and no surface to keep in
parity. That is the whole reason to do it this way round.

## What this is for

**A queue of decisions a person owes, which they will actually work** — and which, once
worked, lets an agent close findings it currently cannot touch.

The observation behind it: people have stopped reading the finding queue, because a finding
is a claim about code and what a person wants is a thing that needs something *from them*. A
review round produces both, mixed together, and only the first has a store. So the design is
not to enrich the finding. It is to give the second kind its own record at its own altitude.

## What is NOT being prototyped

**Findings do not move.** They stay in codemap, witnessed and hashed. Demoting them to
markdown re-opens the split store `unify-findings` exists to drain, and gives up the witness,
which is the only reason a stored claim stays honest. Nothing in this plan touches
`Annotation`, `close_finding`, the fold or the sidecar.

`PROPOSAL-close-evidence.md` §5's evidence slot is orthogonal and can land on its own schedule.

## The object: a decision

One entity with two states, not two records. `open` is the question; `ruled` carries the
answer. That is the "open decisions log" and the ruling in one thing, because they are one
thing at two times.

One file per decision, at `docs/decisions/<YYYY-MM-DD>-<slug>.md`, committed. Not `.codemap/`
— a decision is not per-branch review state and does not belong in a gitignored store; not
`$(git rev-parse --git-common-dir)/triage/`, which is per-machine and dies with the clone,
which is the defect this whole plan is about.

```markdown
---
id: d-<slug>
state: open | ruled
question: <one line — the fork, not the finding>
blocks: [<finding ids, codemap>]           # may be empty: a decision can precede a finding
about: <file:symbol @ <sha>>               # what code it is a decision about, if any
filed: { by: <actor>, at: <date>, round: <record slug or "ad hoc"> }
ruled: { by: <principal>, at: <date> }     # absent while open
---

## The fork
<what the choice actually is, in the code's terms>

## Options
<each, with what it costs and what it forecloses>

## What I would do, and what breaks if I am wrong
<the recommendation, stated as a consequence someone can mark WRONG>

## Ruling
<the principal's words, verbatim. Absent while open.>
```

**Why the recommendation field is load-bearing.** Queue cost decides whether a queue gets
worked, and ruling on a concrete proposal costs a fraction of answering an open question. The
constraint on it is this repository's own: *a missing contract is worked out through concrete
cases that can be marked wrong — not a finished clause put up for approval.* A recommendation
phrased as a finished clause gets approved for fitting the shape, which is the "ratified is
not complete" trap. Phrase it as the consequence.

**Why the record is this small.** Filing has to be cheaper than deciding, or an agent at a
fork does what the ledger shows it does: decides. **13 of 183 closes carried a decision
nobody with authority made**, five of them saying so in their own prose. A third move — file
it, leave the finding blocked — is the structural fix for that number, and it only works if
the record demands nothing the agent has to go and look up.

## Who may do what

- **Anyone files.** An agent at a fork it may not take files a decision and stops. This is
  the point.
- **Only a principal rules.** Principal-granted at both ends, like `debt` and like
  backlogging. An agent may record that a ruling exists and cite it; an agent may not make
  one, and may not rule on its own filing under any framing.
- **A ruling is not a requirement,** and the test that keeps them apart is: *would this still
  be true if the finding had never been filed?* Yes → it is upstream of the code, and it
  belongs in the standard, with ratification and everything ratification costs. No → it is
  downstream of one finding or one pattern, and it is a ruling.
- **One direction only: a ruling cited across several rounds is evidence it should have been
  a requirement.** Cheap graduates to expensive; expensive never demotes. Without that valve
  the light record quietly becomes a second law surface.

## Who produces them

`triage-review` already decides all of this and writes it to a git-dir path nobody reads
again. The one change to the round: **at the sort, every group 2, 3 and 4 item, every defect
pattern's rule question, and every contested item becomes a decision file.**

Those are the items whose closing condition is a ruling, which is why they can never be
settled by reading code. Group 1 isolated items produce nothing here — they are agent work.

Nothing else about the skill changes in the prototype. `sort.md`, `owner.md`, `plan.md` are
still written where they are written; the decision files are an additional output, and
`owner.md`'s rulings are their source.

## The seam, and its accepted cost

**One string.** The finding names the decision blocking it, in prose, and the decision names
the findings it blocks in `blocks:`.

It is unenforced, it can drift silently, and that is the accepted price of not changing the
schema yet. It is also **the first thing to fix at reification**, not something to discover
later: the enforced version is a real field with a real referent, and the check that a
blocked finding's decision exists is the same mechanical link check the close gate needs.

## How a close would use it

The gate for a group 2 or 3 finding is a **link check**, and the split matters more than
anything else here:

- **Mechanical, and an agent may do it alone:** a ruling exists, is in force, and covers this
  item; the change cites it. Bounded, no judgement.
- **Not the gate, ever:** whether the ruling is *coherent with the business requirements*.
  That is the unbounded question that failed five auditor passes running, and it is what
  ratification is for — deliberately expensive, and deliberately not on this path.

So an agent closes because a ruling **covers** the finding, never because the ruling **looks
right**.

## What the prototype settles

The schema is not the question. These are, and none of them is answerable by design:

1. **Does a person actually work the queue?** The whole bet is that decisions are read where
   findings are not, because they need something from the reader. Measure rulings per round
   and time-to-ruling. **If this is no, the reified version fails identically and the plan
   ends here.**
2. **Does the authority-taking rate drop?** The baseline is measured: **7.1% of closes (13 of
   183)**. Re-measure over prototype rounds.
3. **What fields did the record grow** that neither of us designed? This is the real payoff of
   not reifying yet.
4. **Does anything ever need to reference an ITEM after its round closed?** This is the
   falsifier for *don't reify the item*. An item is round-scoped bookkeeping — the dedup — and
   what outlives the round is findings, decisions and rulings. If something reaches back for
   an item, that call was wrong and the item is real.
5. **Does a decision need a deadline?** Every deferral on record rotted in the "linked ticket
   closed or moved" state, which is why the backlog's `until` is fold-enforced. A decision is
   different in kind — it *blocks* rather than defers, so its staleness shows through the
   finding it holds up. Open: whether "open for six rounds" is a decision about the code or a
   finding about the process.

## Where to run it

**Here first.** codemap runs its own `triage-review` rounds and is writable; the private C#
universes under `/working/` are live and edited by another agent, so a prototype that writes
into them is not on. Once the shape has survived a few rounds here, running it on a real
Acme.API round is the user's to drive.

## What would make this fail

- **Filing ceremony.** Any required field an agent has to go and look up — the round slug, an
  item id, which requirement this might touch — and the queue stays empty while the agent
  decides instead. Everything in the frontmatter above is either at hand or optional.
- **Rulings written by agents under a framing.** "The owner ruled in the round" with nothing
  to cite is the cheapest possible close for a group-2 finding, and worse than the 7.1%
  because it looks authorised. A ruling with no principal actor is not a ruling.
- **Letting the queue become the finding queue at a different altitude.** If group 1 items
  start arriving here, the split that makes it readable is gone.
- **Reifying before (1) is answered.** A schema for a queue nobody works is the expensive
  version of the thing that already does not work.

## If it works

Reification is then **one entity and one field**, not a rework of the finding: a decision
record with its states, and a real reference on the finding replacing the prose string. The
fold hazard is the familiar one — teaching it a new event kind is a `MATERIALIZER_VERSION`
bump (now 26) with the failure `finding-backlog.md` states verbatim — and `db-migrate.test.ts`
would pin the vocabulary the way it pins the findings one.

Sharing has an answer already: a ruling governs work across a team, so it travels with the
finding it unblocks. `cross-universe-standard.md`'s split puts law at workspace scope and
observations of code per-universe; a ruling is the light form of law, so workspace.
