# The requirements architecture — normative

> **Kind: current design** — settled 2026-08-27. NORMATIVE for requirements, specs,
> audits and acknowledgements: it outranks COD-29's description and comments, and the
> *Requirement Kernel* draft, where they disagree.

COD-29 states the problem — requirements and explanations are different claims with
inverted truthmakers, and codemap models only the second. This document settles the
shape of the first. It is short on purpose; the argument is on the ticket, the
mechanisms are here.

One sentence carries most of it: **the standard is the authority, a spec is a set of
operations on it, and every mechanism that silences an audit is one record with one
lifecycle.**

## Two documents, two hierarchies, and they are not the same hierarchy

- **The standard** is the master requirements document. It is a **reference**, organized
  taxonomically (`Credit/Limits`, `Settlement/Float`), and read by someone who needs the
  rule governing an area without knowing which spec introduced it.
- **A spec** is a **narrative** document — background, argument, locked decisions. It is
  organized to make a case, and read once.

These are different axes over the same content, so a spec's sections are **not** the
standard's sections. A statute does not share an outline with the code it amends: a bill
section says *"Section 4 of this Act amends 12 U.S.C. § 1831o(b)(2)…"* — it argues in its
own order and names the code locations it operates on. Nobody has made those one
hierarchy, and it is not for want of trying.

**So the mapping is per-requirement, not per-spec-section.** A spec's hierarchy organizes
the reading; each requirement's `section` says where it files in the standard.

## The standard is positive law

A folded spec is **repealed as authority and retained as history**. The standard is the
only place a rule is binding.

This has to be decided once, up front, for everything. The US Code has spent since 1947
converting titles from *prima facie evidence* — where the underlying statute still governs
and the code is an editorial compilation — to *positive law*, and is not finished. The
default, the state reached by not deciding, is the bad one: two representations of the
same rules, the original still authoritative, drifting.

We have already shipped that failure once at smaller scale. `Pricing-Engine.md` is a
requirements document that was later read as an as-built description, and the misnomer it
introduced propagated into code comments and a codemap node (COD-18 §candidate directions).

## A spec is operations, not a diff

The operative content of a spec is a list of **operations** on the standard — add a
requirement to a section, amend a statement, retire a requirement, move or rename a
section. The before/after view a reviewer reads is a **rendering** of those operations.

Storing a rendered diff would make the fold a parser. Storing operations makes it an
executor: deterministic, replayable, and dispositionable one at a time, which is what
per-section comment-and-propose needs anyway.

**Amending language is operational for a reason worth stating.** Legal drafting says
*strike "shall" and insert "may"* rather than reprinting the section, so a provision
cannot be deleted by forgetting to retype it. Section-level replacement makes **omission
destructive**, and omission is the one error class review cannot see — a missing thing
looks like nothing (COD-18 §"diffs are structurally blind to omission"). Nothing unnamed
by an operation is ever touched by a fold.

### Every operation carries its own context, and the fold verifies it

An instruction with no context fails **silently** against a base that moved: it applies
cleanly to the wrong thing. This is why `patch` carries context lines and refuses a hunk
that does not match.

So each operation records the state it was written against, and the fold refuses when that
state has moved. Same mechanism as `NodeCitation.acceptedHashes` (`schema.ts`) one level
up, and the same reason: a reviewer who approved a rendering built from the standard *as
of sign-off* did not approve the result of applying it to a standard another spec has since
changed. The before/after view feels most verified exactly when it is least reliable.

### Business context is not binding, and is marked so

Rationale and background live in the spec and are **explicitly non-operative**. Two
traditions converged on pairing plain language with an operative change — a legislative
explanatory memorandum, an ITIL change record's business justification — and both
document the same failure: the two halves drift, the reviewer reads the prose, and the
operative half is what lands.

The structural fix is not discipline. **Each operation carries its own rationale**, so
there is no free-floating prose to drift, and any document-level narrative is a reading
aid that is never the thing signed.

## Finding the rule wrong while implementing: propose, do not edit

The commonest real situation, and the one a no-edit-path design has to answer or people
will route around it. An implementer — usually an agent — is writing the code and finds
the rule is wrong in a detail: a status code, a field name, a state the enumeration
missed.

Acme.API's spec-authoring playbook says to **fix the spec in the same commit as the
code** (§14.2), and its argument is good: *"a spec corrected at review time means every
review of record between here and there analysed a design that never shipped"* — with a
real incident behind it. That argument is entirely about keeping the **commit-review**
record coherent, which is the practice COD-18 says has stopped producing signal. It pays
an in-place edit to a business rule to buy coherence in a process being retired.

**And it assumes the only alternative is a stall. It is not.** Proposing is open to any
actor; only adoption is a principal's:

1. The agent that found the error **sends the proposal** — `draft_spec` + `add_operation`,
   both `requireActor` and neither principal-gated.
2. The code lands. The requirement now reads **non-conformant**, which is true, visible,
   and exactly what the record is for.
3. The principal ratifies at their own cadence, and conformance is restored by an audit.

Nothing blocks, and nothing is laundered. The playbook had two options — edit the spec, or
stop — because it had no proposal channel; given a third, the case for editing in place
disappears. **We are not, in the long run, reviewing commits the way we review business
rules**, so the coherence of a commit's review record is the wrong thing to spend a rule's
integrity on.

## Two queues, because they are two practices

| | Change enablement | Problem management |
|---|---|---|
| Record | spec, operations, acknowledgements | problem (discrepancy) |
| Raised by | anyone authoring | auditor agents |
| Disposed by | a principal, at ratification | a principal, by adjudication |
| Question | what should the standard say | does the system conform to it |

Conflating them is why "what happens at adoption" reads as unresolved. They have
different owners and different clocks.

## Effective dates are the wrong shape; classification is the right one

An effective date exists because parties with obligations need notice and can be
sanctioned. Neither half applies here — there is nobody to notify and nothing to sanction,
so an effective date is a shield against a punishment that does not exist.

The real question at adoption is **what state the system is in relative to the new rule**.
Four states, and the fourth is the dangerous one:

- **conformant** — checked, and it holds.
- **gap** — no code that should conform exists yet. Not a defect. Roadmap work.
- **debt** — conforming code should exist and does not. Owed. Engineering work.
- **unknown** — nobody has checked.

**`unknown` must never render as `conformant`.** COD-29 already forbids absence of
evidence from *filing* a discrepancy; the corollary is that it must not read as *fine*
either. At seeding scale most harvested criteria land here, and a standard that looks
satisfied because it is merely unexamined is confidence manufactured at scale — a vacuous
test one level up.

**`gap` is only decidable against an enumerable population.** Saying *no code should
conform to this yet* requires knowing what the rule ranges over; without that it means
*I looked and did not find any*, which is absence of evidence being used to avoid filing.
Note the asymmetry: the guard exists in the filing direction and not in this one, and this
one is worse because it is silent. An agent that calls debt a gap has written off real
non-conformance, and it looks like diligence.

## One acknowledgement record, `basis: gap | debt`

Both say *the rule stands, we know, do not raise it*. They differ only on whether
conforming code exists — the gap/debt axis. Identical lifecycle: granted, scoped, carrying
a priority and a **revalidate-by date**, released.

One record rather than two, for the reason the sidecar architecture gives generally (one
canonical table per entity kind) and one that is specific here: **an acknowledgement is a
silencer, and there should be exactly one thing to count when asking how much of the
standard is currently silenced.**

The `basis` routes reporting — *how much have we not built* stays a different question
from *how much do we owe* — without splitting the mechanism.

### The mint-time rules differ by basis, and this is the load-bearing part

- **`gap` may only be minted before ratification.** An auditor agent classifies ahead of
  adoption so holes are poked *while the spec is still a proposal*. There is no path to a
  gap notice after the fact.
- **`debt` is post-hoc and principal-granted**, at the cost of a waiver.

This is what keeps the record from becoming the cheapest way to clear an audit finding.
Filing a gap notice in response to a raised problem would be the laundering pattern
arriving through a third door — not *amend the rule to match the code*, but *declare the
rule not yet applicable*. Closing that path at mint time is why the two bases share a
record and not a constructor.

### A gap has a magnitude, and it is counted rather than estimated

**Ratification cost is decoupled from conformance cost.** A one-sentence requirement can
imply rebuilding the product: write *"the client must be a native iOS application"* against
a web app and the standard updates happily — the operation is well-formed, the provenance
is real, the ratification is one act. The gap is the entire system.

As described so far, an acknowledgement cannot say that. A gap for a missing null check and
a gap for a rewrite are the same record, so a ratifier sees *N gaps* rather than *N gaps of
this size*, and the cavern arrives in a bulk acknowledgement alongside two hundred trivial
ones. That is the batch-ratification failure with a new payload.

**Magnitude is the population, not an estimate.** An agent's cost estimate is a self-report
by the party whose judgement is in question — COD-17's refuted `coverage.method` wearing
different clothes. What is honestly available is countable: how much of the system the rule
ranges over, and how much of that conforms.

So the population predicate does **three** jobs, not one — it is what makes gap-versus-debt
decidable, what makes a gap's size honest, and what COD-17's `re-derive` was always for.
Three arguments for the same mechanism is a reason to pull it forward rather than defer it.

The rendering rule that follows is not a threshold, which would be arbitrary: a bulk
acknowledgement always shows the distribution and always itemises the largest gaps by
population, whatever the batch size.

One thing this correctly does *not* do. A requirement whose gap is the whole system is
usually a product-strategy statement wearing a requirement's clothes, and the design
already routes it correctly — gaps are roadmap work, and elicitation is explicitly out of
scope. The failure was never the routing; it was that the routing happened silently.

### Release is a date, never an external work item

An acknowledgement carries a **priority** and an **expected revalidate-by date**. It may
link a ticket as evidence; the link is never the release condition.

`track_bug` already settled this shape: *"It does NOT close the bug: being tracked
elsewhere is not being fixed."* A release condition living in a system nothing guarantees
becomes unreachable — tickets get closed as won't-do, duplicate or stale, and get moved,
renamed and deleted — and the acknowledgement then silences the audit permanently and
silently.

## Audits produce records whether or not they find something

A **positive audit** — the rule was checked at commit X and holds — is a first-class
record, not the absence of a problem. It does two jobs nothing else does:

1. **It closes a gap.** A gap has no code to witness, so it cannot drift and would
   otherwise outlive its truth in silence. A positive audit is the event that says the
   code now exists and conforms.
2. **It makes regression detectable.** Once a rule has been met, a later failure is a
   problem rather than a gap that was always there.

Cheap secondary trigger: **a gap notice on a requirement that acquires citations is due
for review.** Someone linking code to the rule is evidence the gap may have become debt or
conformance.

### Non-vacuity applies to audits, not only to tests

A positive audit has an **effect** — it closes a gap and silences the mechanism that would
have caught the thing. So *"I checked and it conforms"* from an agent that did not really
check is worse than a vacuous test: it manufactures confidence and disables the detector.

The evidence base for this is not hypothetical. Two of three tests examined in one session
were vacuous when written (COD-18, 2026-08-27), and four of six of the oracle's own
invariants were vacuous as written. Assume the same rate here.

## The auditor pipeline

1. A **documenting agent** produces descriptive documentation of the code, anchored to it.
   This is codemap's original concept, enriched by `codemap-explore` passes and review.
2. **Auditor agents** check those documents against the standard, reading code as needed,
   and file **problems** — never resolutions.
3. A contradiction between two requirements, caught at review, is a problem filed **against
   the requirements**.

### The blind spot is purchased, not inherent — which is why it is fixable

Auditing documentation against requirements inherits the documentation's errors, and the
failure is silent: a stale or missing doc yields a *pass*, not a flag.

COD-27 is the nearest measurement and it must be read carefully, because the obvious
reading is wrong. The map-backed agent was **efficient at confirming what was written and
incurious about what was not**, missing six real defects a code-reading agent found in the
same domain. That is not evidence that a map makes an agent incurious: **its instructions
told it not to double-check, in order to save tokens.** The incuriosity was bought.

The real lesson is more general and more useful. **Verification effort is a policy
setting, and economizing on it buys a silent pass.** A positive audit is the worst place
in this system to make that trade, because the saving is immediate and visible while the
cost — a closed gap and a disabled detector — is neither.

And the fix cannot be the prompt. *"Check thoroughly"* is steering, and the standing
evidence here (COD-24) is that unenforced steering does not reach the consumer — a tool
description may not even be sent (see the note above the tool table in `mcp.ts`). So it is
a **recorded fact**: a positive audit records what was actually read and run, and one that
records nothing is not a positive audit. That is the same non-vacuity rule the assertion
side already needs, applied to the actor instead of the test.

### Requirement-vs-requirement audits carry a known false-positive budget

Contradiction detection is O(N²) over the standard and is the same shape that produced
138 false positives in the first Marten pass. Two rules that appear to contradict very
often have an unstated scope distinction — which is `requirement-misstated`, the
highest-value record the system holds. So: an agent may **raise** it and may not resolve
it, which is already the discrepancy rule and needs no new machinery. Budget for the
false positives rather than discovering them.

## An audit is about a branch, and only the default branch is "the codebase"

A problem says the rule and the code disagree — but *which* code? On a feature branch the
code is somebody's work in progress. Broadcasting a non-conformance from there announces a
violation that may not exist on the default branch and may never, because the branch can
be fixed or abandoned before it merges.

So an audit records its branch, and one taken off the default branch is **provisional**: it
is real work, fully usable locally, and it never enters the shared log. A problem raised
from it inherits that — a problem is exactly as shareable as the evidence it rests on. So
does an adjudication of one, which would otherwise arrive at a clone with no problem to
attach it to.

### What becomes of it after the merge: evidence, never ancestry

Both obvious answers are wrong. Publishing every provisional failure on merge floods the
team with findings that were fixed before they ever landed. And concluding anything from
the commit being an **ancestor** of the default branch is unsound in the other direction:
a commit being in history does not mean the code is still that way, because a later commit
on the same branch may have fixed it.

The sound discriminator is the one this codebase already uses everywhere — **the
witnesses.** If the hashes the audit recorded still match live code, the exact source it
examined is verbatim present, so the finding still holds and that is evidence rather than
inference. If they differ, the audit is superseded and says nothing: it falls away
silently, which is exactly the no-noise answer for the fixed case.

Two properties fall out, and both are load-bearing:

- **Nothing about merging ever makes anything `conformant`.** Only a positive audit does,
  so there is no path by which code passes an audit by having landed.
- **Promotion is explicit.** The list is derived so nobody has to remember, but the act of
  putting a finding in front of the team is a decision, and it re-records the finding as a
  fresh observation rather than rewriting a branch audit to claim it was something else.

## Audit pointers — a prior on where to look, never a verdict

*Designed, not built.* A **pointer** is a standing declaration that a requirement's
conformance depends on some observable: a set of anchors, a test, a lint, a query, any
runnable check. When a pointer moves, the requirement rises in the audit queue.

This generalises what already exists in pieces — `cites` (staleness means the code moved)
and COD-18's `asserted_by` (staleness means the build is red) — into one relation whose
question is *what would make this claim need re-checking*.

### A pointer is WHERE TO LOOK; the acceptance criterion is WHAT and HOW to verify

These are two records, not one, and conflating them is easy because both sit at the same
seam. The criterion states the check and its falsifier — *what would discharge this rule,
and what would refute it*. The pointer is the **address the auditor goes to**. One
criterion can be watched from several pointers; one pointer can serve several rules.

**And a pointer aims as HIGH up the abstraction ladder as it can reach.** COD-29's two
gradients run along that ladder in opposite directions — a requirement is a rule about
*what should be*, a doc is a compression of *what is*, and the code is *what is* — so the
interface between them is not flat, and where a pointer attaches decides how much it is
worth:

| pointer target | covers | survives |
|---|---|---|
| a test or lint enforcing an invariant | a whole population | any single site changing |
| a doc describing a general pattern | everything the pattern governs | refactors within it |
| one anchor | one symbol | almost nothing — a rename mints a new id |

So **an anchor is the last resort, not the default**, which cuts against the instinct: the
map's own primitive is a citation to an anchor, and reaching for one here produces a
pointer that goes quiet exactly when the code it governs is edited. Point at the highest
artifact that still actually constrains the thing — which is why an executable check ranks
where it does. It is a compression *and* it runs.

### They make re-auditing cheaper; they do not replace auditing

A requirement whose pointers were checked recently and are quiet is **less likely** to be
broken than one with no pointers at all. That is a prior, not a verdict, and the
distinction is the whole discipline here:

- **A pointer never changes the conformance state.** `conformant` stays reachable only
  through a code-backed audit. What a pointer changes is **queue position**.
- The temptation to resist is letting green pointers read as conformance. That is the
  vacuity trap one level up — a cheap signal certifying — and it is exactly the trade the
  audit's own evidence refusal already forbids.

What this buys is the thing the queue needs at seeding scale, where nearly everything is
`unknown`: **`unknown` stops being uniform.** A rule audited last week with three quiet
pointers and a rule never audited with none are both honestly `unknown` — nobody has
checked what is there right now — and they belong in very different places in the queue.
Pointers are what make that difference legible without weakening the state.

And the residue recorded above closes: an uncited requirement can raise neither
*recheck-due* nor an assertion failure, so nothing ever fires on it and the highest-value
record in the store is also the quietest. A pointer gives it something to fire on. But
**a requirement with no pointer can never rise**, so the absence has to be visible in its
own right — "no pointer" is the requirement-side twin of `unknown`, and must not read as
settled.

### What the wiring is FOR: differential audit

The payoff, and the reason a pointer is worth its cost. Without one, re-checking the
standard is a sweep — every rule against the whole tree, which is the cost that makes an
auditor agent unaffordable and its output noise. With one, an audit is provoked by what
actually MOVED, and arrives with the chain already assembled:

```
test fails / test changes  ──pointer──▶  requirement possibly broken   + the backtrace
code changes ─▶ doc stales ──pointer──▶  requirement possibly broken   + the backtrace
```

**The second path is the one nobody would have designed on purpose, and it is free.** Doc
staleness is codemap's ORIGINAL machinery — witness hashes on the downstream gradient,
shipped years before any of this. A doc is a compression of what is; a compression going
stale is a cheap, high-level signal that something underneath it moved. The pointer just
connects that existing detector upward. It is also the second reason to aim a pointer at a
doc-describing-a-pattern rather than at an anchor: drift detection is already attached to it.

**The backtrace is what makes the audit cheap**, and it is the same move as the population
delta — convert *judgement* into *reading*. Not "requirement R may be broken, go and
audit it" but "R points at this lint, whose hash moved in commit X, and here is the doc
that covers the same code". An auditor that starts from an assembled chain is doing
arithmetic; one that starts from a rule and a codebase is doing the perplexity evaluation
COD-18 says no longer works.

Both paths yield a **prior, never a verdict**, and that survives inspection: even a failing
test only proves the *invariant* broke, and whether the *requirement* broke depends on
whether the check faithfully encodes it. So `conformant` stays reachable only through a
code-backed audit, in both directions.

**The same wiring runs DOWNWARD, and that is what prices a proposal.** A ratified
amendment means code that was conformant may not be any more — `requirement changes →
pointer → code now suspect`. Upward, the mechanism populates the audit queue; downward, it
tells a ratifier what their amendment is about to break, before they adopt it. One
relation, both audiences.

**The upward half is BUILT.** `computeDiff` rolls changed symbols up to the requirements
that cite them (`impact.requirements`), and it reports two different facts, because they
answer different questions:

- the rule is *about* code this change moves — re-audit it;
- `auditMoved`: the last audit's **witnesses** move too, so the verdict on record was
  reached against source this change rewrites. A `conformant` there is not evidence any
  more. Those are different anchor sets — a rule may cite ten symbols and have been
  audited against one — and only the second one falsifies anything.

Both are set-ops over the two snapshots. Nothing on this path consults live hashes, which
is deliberate: `ServedRequirement.recheckDue` and `ServedAudit.superseded` answer the same
shape of question **against the working tree**, and a diff of two cached commits must not
depend on what is checked out — the same constraint `loadNodesAt` exists for.

*Still not built:* the DOWNWARD direction above (a ratified amendment pricing what it
breaks) needs pointers, and the rollup reaches only rules that CITE something. An uncited
requirement is a well-formed record — the rule the code does not yet satisfy — and no
set-op over anchors can find it. That hole is exactly what pointers fill, and it is pinned
in `diff.test.ts` rather than left as a comment.

### Differential audit has a blind spot, and the scrub is its complement

A differential audit is cheap precisely because change drives it. The corollary is that a
requirement whose pointers never move is **never audited** — and that is the *never fires →
false calm* pathology promoted from an accident to a structural property.

So the two mechanisms are not alternatives and neither is optional:

- **Differential audit covers what moved.**
- **The scrub covers what did not.**

Which is the stronger argument for the scrub than vacuity-hygiene: without it the system is
systematically blind exactly where nothing has changed for a long time, which is also where
a quietly wrong rule has had the most time to matter.

### Pointers are scrubbed on a schedule, not trusted

Vacuity is **silent corruption**. You do not find it by using the thing, because a vacuous
pointer looks fine every single time you look at it. You find it the way an array finds a
bad block — by going and checking, on a schedule, across the whole population, rather than
waiting for an access to stumble on it. The documentation-scrub agents are the same idea
already running against a different corpus.

Two symmetric pathologies, and both are visible in a pointer's own history:

- **Never fires** → false calm. It looks like coverage and is not.
- **Always fires** → cry-wolf. A pointer that goes off on every commit gets ignored, and
  then so does the requirement behind it. This is the same reason the section guard is
  case-and-whitespace rather than fuzzy.

Both are a **rate**, which is derived rather than asserted — the same reason a gap's
magnitude is a population and not an estimate.

A scrub therefore needs a stated **rate and coverage period**, the way an array does: some
share of the population per period, so everything is covered every *T*. Without one it is
"whenever somebody remembers", which is the thing the whole mechanism exists to replace,
and its cost is unbudgeted — which is the principal-time failure recorded below arriving
from a third direction.

## Backout is two problems, and only one of them is ours

ITIL requires every change to say how it is undone. Here that question splits, and the two
halves have different mechanisms, different authorities, and different owners.

### The standard is a projection of the ratified specs

This is what makes any backout possible, and it is a stronger argument for operations over
diffs than the one given above: **operations replay, a rendered diff does not.** The
standard is folded from the ordered set of ratified specs, the way every other shared
entity here is folded from its log.

### Spec backout: withdrawal before reliance, repeal after

Re-folding without a spec is **not** the same as reverting it. If a later spec amended a
requirement the withdrawn one introduced, that later operation now targets nothing and the
fold is invalid — the same shape as the sidecar's fork, where a prefix claim other events
depend on turns out to be false (`docs/fork-repair.md`).

So there is a window, and which side of it you are on decides the mechanism:

- **Before anything relies on it** — no later spec operates on its requirements, and no
  audit, acknowledgement or problem cites them — a spec may be **withdrawn**. This is
  mistake correction, and it is honest because nothing downstream is falsified.
- **After** — repeal by **compensating spec**: a new spec whose operations reverse the
  old one's. Legal practice does not remove acts from history; it passes an act that
  repeals another and re-derives the code from the whole history.

Deleting a ratified spec from the log destroys the audit trail of the act most worth
auditing. Reliance is mechanically checkable — it is a reference count — so which of the
two applies is decided by the store, not by the person asking.

### Implementation backout is not codemap's job

Reverse migrations, and the data they lose, are a deployment concern. Modelling them here
would be scope this project has no business taking, and it could not be truthful about
them anyway.

**What codemap owes is a correct conformance state afterwards, and that needs no new
machinery.** Backing out an implementation while the rule stands produces **debt**, which
already has a record. Backing out the rule while the implementation stands leaves code
that is *unregulated*, not wrong — a distinction worth keeping, because treating it as
wrong would file problems against code nobody has any rule about.

The two are authorized independently on purpose: very often the code is fine and the rule
was the mistake.

### Reversibility is declared before ratification, not discovered after

ITIL writes the backout plan **before** approval. If satisfying a requirement takes an
irreversible step, the ratifier should know while deciding, because it changes the
decision. So an operation carries a reversibility declaration, and *irreversible* is an
honest value. This makes nothing reversible; it makes irreversibility visible before the
decision rather than after.

**And it constrains the future, not just the past.** A requirement whose implementation was
irreversible is effectively harder to amend — the next amendment may be unimplementable, or
implementable only at further cost — so it must be visible to somebody *opening* an
amendment against it, not only in the spec that introduced it. Legal systems call the
general shape reliance: you can repeal the statute and you cannot unwind what was done in
reliance on it, which is why savings clauses exist. Ours is the acknowledgement record.

## Built, and not

Built, as local rows **and** as shared state over the `standard/<universe>` sidecar scope
(`shared-standard.ts` holds the events and the fold, `standard-publish.ts` the mirror
layer, `standard-sharing.test.ts` the correspondence). Reachable from `ops.ts` and the
MCP surface via `ops/standard.ts`:

- The `requirement` record: no `stale`, no trust, `recheckDue` derived at read time.
  Structurally separated from the node path; `requirements.test.ts` holds that true.
- `title` and `section`, both required, with section paths normalized and a case-variant
  of an existing section refused.
- Propose / ratify / reject / retire, principal-gated on adoption, and `reorganize`
  gated once ratified because retitling a binding rule is laundering one field over.

- `requirements.ts` — the record (no `stale`, no trust, `recheckDue` derived), the
  **spec** and its **operations**, and the fold. Context is verified per operation and
  adoption is all-or-nothing.
- `acknowledgements.ts` — one record, `basis: gap | debt`, with the mint-time asymmetry.
- `audits.ts` — the audit record with non-vacuity as a refusal, plus the conformance
  classification (`conformant` is reachable only through a code-backed audit).
- `problems.ts` — the un-adjudicated record, `adjudicate`, and **no close verb at all**.

**Adjudication and closure are separate events**, which was not obvious until it was
built. Naming which side moves does not move it, so a problem stays open until the named
move actually happens — `adjudicate and forget` is then visible rather than silent. And an
un-adjudicated problem whose disagreement quietly disappears does **not** close: somebody
settled a business question by changing code, which is the failure this whole record exists
to catch, so it is reported (`settledWithoutAdjudication`) instead of tidied away.

Not built, roughly in the order they are worth building — `docs/population-predicate.md`
carries the detail and the reasoning:

- **`asserted_by`**, with its vacuity field, a **falsifier**, and an **evidence kind** —
  the last two adopted from the spec playbook's §13.1/§13.2 rather than re-derived.
- **Audit pointers**, and then the **scrub**, which is their necessary counterweight rather
  than hygiene: differential audit covers what moved and only a scrub covers what did not.
- **The population predicate**, which is a hash-pinned lint. Narrowing a population is a
  laundering door and has to be gated like an amendment.
- Section move/rename operations, and spec withdrawal / repeal. Mechanical.

The web front end has no routes for any of it — `mcp.ts` is wired and `serve.ts` is not, so
this surface is currently agent-only. The one exception is the diff rollup above, which
rides the existing `/api/diff` payload and renders on `/#/u/:u/diff/` with no route of its
own; that is also why its rows do not link anywhere.

## Deliberately open

- **A blocked scope has no non-authoritative carrier.** `readCached` returns a scope
  status, `materializeStandard` reduces it to a boolean, and an ordinary requirement read
  never consults it — so if the `standard/` scope is blocked by a fork or a collision, the
  projection rows are still served and look authoritative. Requirements carry `origin:
  "sync"` and nothing else. The sidecar architecture's §7 is a fail-closed rule and this is
  the surface that never looked; the fix is a status that rides WITH the value, the way
  `Cached<T>` already does one layer down. Found by review, not fixed.
- **Who owns the standard's taxonomy.** If sections only ever arrive via specs it is
  emergent, and emergent will not stay sane. Legal codes have an Office of the Law
  Revision Counsel for exactly this. Reorganizing the standard needs to be a first-class
  principal act, independent of any spec, or the only way to fix filing is to write a spec
  about filing — which nobody will do.
- **Partial ratification.** Approving 18 of 20 operations is tempting and the two held
  back may be what makes the other 18 coherent. If allowed at all it is an explicit
  reviewer choice, and the remainder becomes a new spec rather than a lingering
  half-ratified one.
- **Renumbering.** Moving a section breaks every citation to it. Legal codes keep
  redesignation tables; the local equivalent is `where_was` for section paths.
- **Principal-time.** Every mechanism above spends one person's attention and none of it
  is budgeted. The arithmetic gates the seeding phase, not the audit phase — seeding is
  what first produces a queue nobody can clear.
