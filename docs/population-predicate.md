# The population predicate — a hash-pinned lint, and what it rests on

> **Kind: design brief — NOT built and NOT settled.** It states the shape and the
> constraints, so whoever builds it does not rediscover them one at a time.
> `docs/requirements-architecture.md` is normative and outranks this.

The predicate is the largest unbuilt thing in the requirements subsystem, and it is
load-bearing in four separate places: it makes **`gap` decidable** (*no code that should
conform exists yet* needs to know what the rule ranges over), it makes a **gap's magnitude**
honest (counted, never estimated — an estimate is a self-report by the party whose
judgement is in question), it is what **COD-17's `re-derive`** was always for, and it is
**what a ratifier is being asked to take on faith** when an agent attaches a gap to a draft
operation. Four independent reasons for one mechanism is the mechanism being central.

## The answer is a lint, hash-pinned — not a query language

The obvious design is a query over the anchor graph: *every HTTP endpoint*, *every event
handler*. Recorded here as the road not taken, because the reason it fails is worth
keeping.

Anything strong enough to express those populations is **framework knowledge**, which is
the analyzer boundary — and the first Marten pass produced 138 false positives before it
produced 4 genuine findings. A query language would make codemap responsible for
understanding every target framework, and would inherit that error rate into the one record
that is supposed to be more trustworthy than the code.

A **lint** — an executable check living in the target repo, in the target language, against
the real types — dissolves that entirely:

- **codemap never has to understand the population.** It hashes the lint and observes
  whether it passed. The framework knowledge stays where the framework is.
- **Population and conformance test fuse into one artifact**, which answers a question this
  brief previously left open. And that artifact already has a review process: it is code, it
  lands in a pull request, it is read like code.
- **The cost collapses.** Not rules × tree per audit — CI runs the lint once for the whole
  tree and codemap reads a result.
- **It is proven here.** Four lint tests written 2026-08-26, ~600 lines, closed failure
  modes that had already shipped bugs, and they are diff-independent: a new violating site
  fails even though its own diff looks innocent (COD-18 §"what is known to work").
- **The hash pin is the witness the scrub was missing.** The designed scrub catches *never
  fires* and *always fires*; it does not catch **fired → was edited → now quiet**, which is
  the detector being modified by the change it was meant to detect. A pin on the lint's own
  normalized hash is exactly that witness.

The relation this needs is COD-18's **`asserted_by`**, distinct from `cites`: `cites` is the
code a claim is ABOUT and its staleness is *that code moved*; `asserted_by` is the check
that WOULD FAIL if the claim stopped holding, and its staleness is *the build is red*.
Snapshot versus live.

## A lint must report its population, or it answers none of the four jobs

Pass/fail carries no arity. A green lint cannot say whether the population is empty
(gap-versus-debt) or whether a gap is one null check or the entire system (magnitude). So
the lint has to **emit the members it examined**, not just a verdict — which is a convention
on an artifact that already exists, not a query language creeping back in. This codebase
already writes lints that way, because non-vacuity already demanded it.

The enumeration is also the only review anybody can perform on it: *is this predicate
correct?* has no finite answer, *show me the members* does.

### The empty population is the dangerous case, and it is caught in two layers

A lint over zero members is **green**, and green reads as conformant. With a query language
that was an edge case; with a lint it is the DEFAULT failure mode. Two layers, and they
catch different things — keep both, or the cheap one gets dropped as redundant:

- **Mechanical**: a lint reporting zero members is refused as a pin. Free, and it catches
  the common case — a selector that matches nothing by accident.
- **The auditor / the scrub**: codemap cannot run the lint, so a lint that *claims* 47
  members and examined 0 is a self-report, and only a reader of the lint catches it. This is
  the ordinary vacuous-test problem, on the artifact the whole mechanism now rests on.

## A member has three states

`conforms`, `violates`, and **`undecidable`** — in the population, and this check could not
reach a verdict (unparseable, generated, behind an interface, needs a runtime fact).

Folding `undecidable` into `conforms` is `unknown` rendering as `conformant` one level down.
Folding it into `violates` is the 138-false-positive shape. Its own number, reported.

## Narrowing the population is laundering, and the lint makes it easier

The cheapest way to make a failing rule pass is to **narrow its population until the
violators fall outside it**. That is not amending the rule and not fixing the code; it
redefines what the rule was ever about, and leaves the statement — the part a human reads —
untouched. After *amend the rule to match the code* and *declare the rule not yet
applicable*, this is *declare those things were never in scope*.

A lint makes this **more** invisible than a stored predicate would be, not less: the edit is
buried in test code and looks like maintenance. That is the standing observation about
agents editing tests, arriving in the mechanism built to prevent it.

The pin is what closes it — but only if **re-pinning is gated**. Narrow the selector, the
pin breaks, `recheckDue`, re-witness, quiet again is the same door in two steps. So:

- The rendering a reviewer sees must show the **population delta**: not two diffed
  selectors, which are not reviewable, but *"this drops 14 members, 9 of which currently
  violate"*.
- **Gate by consequence, not uniformly** — the same lint does two jobs with very different
  blast radii, and this is the distinction that decides how much the whole design rests on
  agent judgement:
  - **As a pointer**, a laundered lint costs **queue position only**. A pointer never sets
    conformance; `conformant` stays reachable solely through a code-backed audit. So a
    missed underhanded edit makes the system slower and noisier — not wrong.
  - **As a population predicate**, a laundered lint can flip **debt into gap**, which is
    *silencing*. That is the laundering door with a lint in front of it.

  So re-pinning for queue purposes may stay open; re-pinning that changes a gap/debt
  classification is a principal's act. Gate what silences, never what unsilences.

## Some rules have no lint, and saying so must be cheap

*"The client must be a native iOS application"*, written against a web app. And the case a
lint specifically cannot reach: **a population spanning repos** — a rule ranging over
`Acme.API` and `Acme.React` together is not one lint, and that shape is real for this
target. Two lints that can drift apart is not an answer.

So the record needs an honest **`not-expressible`**, distinct from an empty population and
from an absent one. Without it the field gets satisfied with a bad predicate, which is worse
than none because it produces numbers. A rule that lands there is usually a product-strategy
statement wearing a requirement's clothes; the design already routes those to roadmap work.
The failure was never the routing, it was that the routing happened silently.

## What this rests on, stated as the bet it is

The pin makes an underhanded edit **visible**. It does not make it **caught**. Something has
to look, and at the rate this has to run, that something is an auditor agent — so the design
rests on requirements auditing being automatable by agents cross-checking each other.

That is an empirical bet, not a design property, and the honest version of it is:

- **Independence cannot be assumed between two agents.** COD-17 had to *measure* it
  (`isErrorIndependent`, `clientInfo` from the transport rather than self-reported) because
  two agent sessions are free and correlated by construction. Segregation of duties works
  elsewhere because collusion is expensive; here it is not.
- **What works is diversity of METHOD, not redundancy of agent.** Measured 2026-08-27 on
  this repo: codex, `/code-review high` and the author's own re-reading found overlapping
  but different defects, and the self-check found three neither review had. COD-18 says
  the same from the other side — more agents and more findings does not close it.
- **So structure the cross-check to decorrelate.** One reader sees the lint diff with the
  population delta; one runs the lint at both hashes and diffs the member lists, which is
  mechanical and needs no judgement at all; one sees only the requirement's statement and
  the new selector — **never the diff** — and judges whether the selector is still a
  faithful proxy. An agent that has not seen the edit cannot be anchored by it.
- **Minimize what needs judgement.** The population delta converts *detect underhandedness*
  into *read a number*. Take that conversion wherever it is available: agent arithmetic and
  agent discernment do not have the same reliability.
- **And know where the bet is load-bearing.** Because a pointer cannot set conformance,
  this bet governs THROUGHPUT — how fast the queue moves and how much noise it carries —
  and not SOUNDNESS, provided the classification path stays principal-gated. That is the
  right place to put a bet that can only be settled by running it.

## Tests occupy a different position from code, and the map has to say so

The whole mechanism above puts tests into the map for the first time. They must not enter
as more anchors in the same population, because the two are not the same kind of thing:

- **Code is a liability**, justified only by a requirement it satisfies. Bringing it under
  description reduces that liability, which is what `find_gaps` ranks and what every
  coverage percentage measures. Uncited code is *unregulated*, not wrong — the distinction
  the architecture doc already draws when an implementation outlives its rule.
- **A test is an asset, conditional on non-vacuity.** It is already a claim in executable
  form, so it does not need explaining; "document this test" is a work item worth close to
  nothing. A **vacuous** test is a liability wearing an asset's clothes, which is worse than
  either — the cost of a slow or brittle suite is bounded and announces itself, where the
  cost of a test that cannot fail is unbounded and silent.
- **A requirement is the only one of the three that is upstream**, and the thing that
  decides which code was worth its liability.

So the polarity inverts: **an uncovered piece of code is a gap; an uncovered test is not.**

This is also a second, independent argument for the vacuity field. If value is not
monotonic in the number of tests, then counting tests is a bad metric and the only useful
count is of non-vacuous ones. COD-18 reaches the same requirement by another route — a link
to a vacuous assertion upgrades *nobody edited this* into *green as of the last build*, a
stronger claim over a weaker check. Two independent routes to one field.

### And it corrects the review-load arithmetic

COD-18's 524 KLOC/yr excludes deploy merges and vendored schemas, but not tests. To
whatever extent that churn is test code, the ~33 forty-hour weeks **overstates** genuine
review load: test lines do not need perplexity evaluation against a mental model of the
system.

They need a different question asked of them — *could this have failed?* — which is much
closer to arithmetic than *is this behaviour right?*, and is therefore the more
mechanizable of the two. That matters for a programme whose bottleneck is one principal's
attention: it is not that tests need less review, it is that their review is the half a
machine can take.

## Build order

**Step 0 is independent of everything else here** and is the cheapest visible win, so it
does not wait on the rest.

0. **Roll the branch diff up to requirements.** `computeDiff` already rolls changed symbols
   up to nodes, flows, reviews and bugs; requirements are simply not among them. It needs
   no new relation — a requirement's own `cites` and `witnesses` already exist, and
   `recheckDue` is already derived from them. One rollup target turns `/diff`, a surface
   people already use, into the audit trigger the subsystem otherwise has none of.

1. **`asserted_by`, and the three fields that must ship with it.** The second citation
   relation — `cites` is the code a claim is ABOUT (staleness = that code moved),
   `asserted_by` is the check that would FAIL if the claim stopped holding (staleness = the
   build is red). Snapshot versus live. Beside it:
   - **the vacuity field.** COD-18 is explicit it must not ship without one: pointing at a
     vacuous assertion converts *nobody edited the cited code* into *green as of the last
     build*, a stronger-reading claim over a check that cannot fail. Two of three tests
     examined in one session were vacuous when written, and four of six of the oracle's own
     invariants were — assume that rate.
   - **the falsifier**, adopted from the playbook's §13.1. We have no analogue and it is not
     a naming gap: every non-vacuity guard in `audits.ts` fires at AUDIT time, when the
     author already knows what passed. A falsifier is written before the code exists, so it
     cannot be fitted to whatever the check turned out to do. Its payoff, in the playbook's
     words: *"seeing, before a line is written, which criteria are unprovable as stated."*
   - **the evidence kind**, adopted from the playbook's §13.2 closed list of seven with its
     why-it-holds column. `Audit.evidence` cannot stand in — `read`/`ran`/`consulted` records
     what one auditor did once, after the fact, where an evidence kind is a standing
     declaration made at drafting.

2. **The pointer relation** — WHERE an auditor looks, distinct from the criterion's what and
   how. Aims as high up the abstraction ladder as it can reach; an anchor is the last
   resort. Then extend step 0's rollup to reach requirements through pointers, which is
   what makes the second differential path (`code → doc stales → pointer`) light up.

3. **The pin, the delta rendering, and the gating split.** Hash the lint; render a change as
   a POPULATION DELTA rather than two diffed selectors; leave re-pinning open for queue
   purposes and principal-gate it where it changes a gap/debt classification.

4. **The scrub** — not an optional complement. Differential audit covers what MOVED, so a
   requirement whose pointers never move is never audited; the scrub is the only thing
   covering what did not. It now has a third pathology to detect and a hash to detect it
   with.

5. **Test indexing in the target.** One line, now that `.codemapignore` has a `[tests]` bin:
   move `*.Tests/` and friends under a `[tests]` header and the ~3,856 test methods are
   indexed — citable, hashable, pinnable — while staying out of the documentation
   denominator. **This is an edit in a live repo, so it is their act, not ours.**
