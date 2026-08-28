# The population predicate — what it has to handle

> **Kind: design brief — NOT built and NOT settled.** It states the problem and the
> constraints a solution has to satisfy, so that whoever builds it does not rediscover them
> one at a time. `docs/requirements-architecture.md` is normative and outranks this;
> where this document commits to a mechanism it is a proposal, not a decision.

The predicate is the largest unbuilt thing in the requirements subsystem, and it is
load-bearing in **four** separate places. That is the argument for pulling it forward: four
independent reasons for one mechanism is not a coincidence, it is the mechanism being
central.

1. **It makes `gap` decidable.** *No code that should conform to this exists yet* requires
   knowing what the rule ranges over. Without that it means *I looked and did not find
   any*, which is absence of evidence deciding a classification — and an agent that calls
   debt a gap has written off real non-conformance while looking diligent.
2. **It makes a gap's magnitude honest.** A gap for a missing null check and a gap for a
   rewrite are otherwise the same record, so a ratifier sees *N gaps* rather than *N gaps of
   this size*. Magnitude is the population, counted; an estimate is a self-report by the
   party whose judgement is in question (COD-17's refuted `coverage.method`).
3. **It is what COD-17's `re-derive` was always for.**
4. **It is what a ratifier is being asked to take on faith.** A gap attached to a draft
   operation binds at ratification, so the rule arrives classified `gap` rather than
   `unknown` on an assertion nothing can check. `getSpec` now shows the silencer; it cannot
   yet show the evidence for it.

## The core constraint: derived, never enumerated

A population is a **query**, not a list. COD-18 states the failure it exists to fix:
an invariant "must hold over a derived population that grows on its own; new code should
fall in scope automatically rather than requiring someone to add an anchor. The failure
mode is *a member of the population that violates*, which the anchor model cannot express."

So the thing codemap already has — a citation, a set of anchor ids — is exactly the wrong
shape. A stored list is complete on the day it is written and silently incomplete every day
after, and its incompleteness looks like conformance.

Two consequences follow immediately:

- **It survives anchor-id churn, because it does not name ids.** Ids are derived from
  file + symbol path, so a rename or an overload-signature change mints a new one — and in
  an event-sourced codebase that is `Apply(SomeEvent)`, i.e. the code people file findings
  about. A rule pinned to ids goes quiet exactly when the code it governs is edited.
- **It is evaluated against a commit, never stored as a result.** A count is a fact about a
  tree. Persisting the number rather than re-deriving it reintroduces the staleness the
  whole project exists to make visible.

## A member has three states, not two

`conforms`, `violates`, and **`undecidable`** — the member is in the population and this
check could not reach a verdict on it (unparseable, generated, behind an interface, needs a
runtime fact).

Collapsing `undecidable` into `conforms` is `unknown` rendering as `conformant` one level
down, and it is the same silent failure: coverage that looks total because the hard cases
were dropped. Collapsing it into `violates` is the 138-false-positive shape. It has to be
its own number and it has to be reported.

## The empty population is the dangerous case

A predicate that matches nothing reports `0/0`, which reads as *fully conformant* under any
naive ratio and as *a gap* under another. Both are wrong: it means the predicate is broken,
or the rule does not range over code at all.

This is the vacuity problem in its purest form — **a predicate matching nothing looks like
perfect coverage every single time you look at it** — and it is why the mechanism needs the
same treatment as a scrub rather than trust: an empty population is a *finding about the
predicate*, surfaced, never a conformance answer.

## Being wrong has two directions and they are not symmetric

- **Too narrow** → violating members are outside the population → **false conformance**.
  Silent, and it accumulates.
- **Too broad** → members the rule never meant are judged → **false non-conformance**.
  Noisy, and it corrects itself because somebody has to triage the noise.

Design against the first. Where the two trade off, prefer the noisy failure — which is the
same call the audit's evidence gates already make in the other direction.

## Narrowing a population is laundering, and must be gated as such

This is the part most likely to be missed, because the predicate looks like metadata.

If a rule is failing, the cheapest way to make it pass is to **narrow its population until
the violators fall outside it**. That is not amending the rule and it is not fixing the
code; it is redefining what the rule was ever about, and it leaves the statement — the part
a human reads — untouched. It is the third laundering door wearing a fourth disguise:
after *amend the rule to match the code* and *declare the rule not yet applicable*, this is
*declare those things were never in scope*.

So the predicate is **operative content of the requirement**, not an annotation on it:

- Changing it is a **spec operation**, principal-ratified, exactly like changing a
  statement. There is no edit path, for the same reason there is none on `statement`.
- The rendering a ratifier reads must show the **population delta** — how many members the
  old predicate matched, how many the new one does, and which members left. A predicate
  diff shown as two regexes is not reviewable; a diff shown as *"this drops 14 members, 9
  of which currently violate"* is.
- Broadening is the safe direction and narrowing is the gated one, the same asymmetry as
  `gap`/`debt` and as raising versus lowering a severity.

## It must be listable, not just countable

A predicate that reports `47/53` and cannot say *which* 53 is a claim nobody can check, by
the party whose judgement is in question. The mechanism must be able to enumerate its
members on demand, because that enumeration is the only review anyone can perform on it.

This is also what makes the ratifier's problem tractable: *show me the members* is a
question with a finite answer, where *is this predicate correct?* is not.

## It is a pointer, and inherits every pointer problem

A predicate is a standing declaration about what would need re-checking, which is the
pointer relation. So it inherits the scrub:

- **Never changes** → false calm, or a dead query.
- **Always changes** → cry-wolf, and the requirement behind it gets ignored.
- **Changed in the same commit that made it go quiet** → the detector was edited by the
  change it was meant to detect. This third pathology is not a rate and the scrub as
  designed does not catch it; it needs a **witness on the predicate's own definition**, not
  only on the members it selects. Codemap has that mechanism everywhere already.

And the standing rule that outranks all of the above: **a predicate never changes the
conformance state.** `conformant` stays reachable only through a code-backed audit. A
predicate that reports every member conforming is a prior about where to look, not a
verdict — letting it certify is the cheap-signal trap the audit's own evidence refusal
already forbids.

## Some rules cannot be expressed, and saying so must be cheap

*"The client must be a native iOS application"*, written against a web app. The population
is the entire system; no query over anchors expresses it.

The mechanism therefore needs an honest **`not-expressible`**, distinct from an empty
population and distinct from an absent one. Without it, the field gets satisfied with a bad
predicate — which is worse than no predicate, because a bad one produces numbers.

A rule whose population is not expressible is usually a product-strategy statement wearing
a requirement's clothes, and the design already routes it correctly: gaps are roadmap work
and elicitation is out of scope. The failure was never the routing, it was that the routing
happened silently. `not-expressible` is what makes it loud.

## Open, in rough order of how much they change the design

- **What language.** A structural query over the anchor graph (kind, path, symbol shape,
  edges) is language-agnostic and weak. Anything strong enough for *"every HTTP endpoint"*
  or *"every event handler"* is framework knowledge, which is the analyzer boundary — and
  the first Marten pass produced 138 false positives before it produced 4 genuine findings.
  Whatever is chosen inherits that error rate, so it inherits the requirement to be
  adversarially verified before anyone is shown a number.
- **Cost and caching.** Rules × tree, per audit, at seeding scale. The cache key has to be
  the commit AND the predicate's own hash, or an edited predicate reads through to the old
  answer — which is the edited-detector failure with a performance optimisation on top.
- **Whether the conformance test is part of the predicate or beside it.** Jobs 1 and 2 need
  only the population; job 3 needs the test as well. They may be two fields.
- **Who authors it.** An agent that writes the predicate and evaluates it against its own
  rule is grading its own work in both directions at once.
