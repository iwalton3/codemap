# The standard across universes — normative

> **Kind: current design** — settled 2026-08-28. NORMATIVE for how the standard relates to
> more than one repository. It EXTENDS `docs/requirements-architecture.md` and outranks it
> where that document assumes one universe, which it does implicitly throughout.

One sentence carries it: **the standard is a property of the business, and a universe is an
index of code — so the law is workspace-scoped and the evidence is not.**

## What is BUILT, and what is only decided

The design below is settled. Most of it is not implemented yet, and a document that reads
as though it were is worse than no document — so the state is stated once, here, rather
than hedged in every section.

**Built** (`221d2b3`): `Pointer.universe` and `Audit.universe`; a pointer baseline is
`contested` rather than overwritten, with the order-insensitive comparator that keeps it
from firing when auditors agree.

**Decided, NOT built:** the law/evidence scope split itself; removing `Requirement.cites`
and re-deriving `recheckDue` from pointer staleness; provisional audits as commit-discovered
documents; and the fold guard for an absent evidence scope. Everything below in the
imperative — "is removed", "is workspace-scoped" — describes the target, not the tree.

## The problem, and why the obvious fix is the wrong one

`Acme.API` and `Acme.React` implement one business. A rule like *a credit limit change
requires dual approval* governs a handler in one repo and a screen in the other. Today the
standard is scoped `standard/<universe>`, so stating that rule means stating it twice.

Duplicating it is the failure this project already shipped once and already argued against
at length: `Pricing-Engine.md` was a requirements document later read as an as-built
description, and its misnomer propagated into code comments and a codemap node. The
positive-law section of the requirements architecture exists to prevent exactly two
representations of one rule, one nominally authoritative, drifting. A "mirrors" link
between two copies is that failure with a pointer attached.

**And scoping the standard to a universe inverts the subsystem's own premise.** A
requirement is upstream of code — the code exists to satisfy it. A universe is a code
index. Tying the rule to the index makes authority follow the implementation, which is the
inversion the requirement record was separated from `LogicalNodeType` to avoid.

## The split: law is workspace-scoped, evidence is not

| Scope | Records | Why |
|---|---|---|
| **Law** — one workspace scope | requirement, spec, operation, acceptance criterion, **gap** | A rule, and the acts that author it. None of them is about a repository. |
| **Evidence** — per universe | audit, pointer, population predicate, problem, **debt** | Each is an observation OF CODE, and code lives in a repository. |

The transport is already shared: `codemap.workspace.json` declares one sidecar for every
universe in the workspace, so the separation between the two scopes is a key, not
infrastructure.

**Gap and debt land on different sides, and the asymmetry is the same one that governs
their minting.** A `gap` is granted before ratification, chained to an operation, and says
*nothing satisfies this rule yet* — a statement about the whole system, so it belongs with
the rule. A `debt` is post-hoc and says *this code does not conform and we accept that* — a
claim about one implementation. Law-scoping debt would let accepting it for the React app
silence the rule for the API, which is the "declare the rule not yet applicable" escape the
mint-time asymmetry exists to close.

## A requirement cites nothing

**`Requirement.cites` goes.** A requirement citing code is the inversion again in
miniature: the rule is upstream, so it does not point down at an implementation. Where a
reader wants the code that implements a rule, they want **pointers** — which are
auditor-maintained, aimed as high up the abstraction ladder as they reach, and already
defined as *a prior, not a verdict*.

Three consequences, and none is a loss:

- **The `/diff` rollup keeps working.** It already fires on any of three signals, and the
  third is pointers — added precisely for *"a requirement that cites nothing and asserts
  nothing… could not be reached by a set-op over anchors at all"*. Removing `cites` retires
  the weakest signal, not the audit trigger.
- **`recheckDue` re-derives from pointer staleness.** A pointer is witness-hashed, so code
  moving under a pointer is what calls for the re-audit. This is the same signal, taken
  from the record that actually knows which universe it is in.
- **An auditor must cite what they read.** `recordAudit` merged the rule's `cites` into the
  audit's evidence, so an audit silently inherited citations it never looked at. With no
  `cites` to inherit, the auditor's own evidence is load-bearing — which is what an audit
  was always supposed to mean.

**A pointer names exactly one universe at a time.** A requirement may carry pointers in
several; a pointer that spanned two would have no coherent re-audit timing, because
staleness is evaluated against one checkout.

## Pointers are never provisional

Provisionality exists for one purpose: to keep an observation about somebody's branch out
of the team's conformance state. **A pointer cannot reach conformance** — it changes queue
position and nothing else. So there is nothing on a pointer for provisionality to protect,
and marking one provisional would suppress the one signal whose over-firing is free: the
worst case of a stale pointer is a re-audit.

This is what keeps the design from circling. Pointer staleness is the antidote to a
provisional audit going unnoticed; if pointers were themselves provisional, the antidote
would be suppressed by the thing it treats.

## A pointer's baseline is contested, never overwritten

Two auditors re-baselining one pointer from two branches used to resolve to whoever folded
last. Both baselines are CORRECT — they are observations of two directions the codebase is
being taken in — so the fold has no basis to pick, and the discarded one is worth most in
exactly the load-bearing code where two branches touch one rule at once.

`contested` here is **preservation, not arbitration**: the residue hands whoever audits
next the context that was being thrown away. Two mechanics matter and both are tested:

- Comparison is **order-insensitive over the witness set**. `applyRevision` compares with
  `===`, and two identical witness arrays are different objects — so the default would
  raise a contest on every concurrent restate, including when both auditors agree
  completely. A conflict marker that fires when nobody disagrees is the eager failure that
  trains people to clear the state without reading it.
- Concurrency must be tested with **two clones**. `emit` reads the log for its causal heads,
  so two writes into one root are sequential by construction and nothing is ever concurrent.

## Provisional audits: a document found by commit, not a folded event

*Not built.* A provisional audit is invisible to everyone but its author, and
`promotableAudits` reads local rows — so it is promotable only by that author, on that
machine. A teammate reviewing the branch cannot see that it fails a rule.

The shape: a provisional audit **travels** as an artifact discovered by commit, and is
**never folded into the standard**. Not folding it is what makes it structurally impossible
for a branch observation to reach `conformance()`, rather than filter-dependent. The
existing fold guard therefore becomes MORE load-bearing, not less: `foldStandard` must
still refuse a provisional audit arriving in the standard scope, in case a client publishes
one there.

**Partial staleness at promotion is deliberately not handled.** If some of the bodies an
audit witnessed have changed by merge time, it will not promote. That is correct rather
than a gap: an audit is an observation of specific bodies, and promoting it past the
evidence that earned it would carry a verdict the code no longer supports. Re-auditing is
the honest answer, and the scrub is the mechanism built to schedule re-looks. Chasing the
partial case would fill the auditor queue with noise to recover a verdict that should be
re-taken anyway. A staled fault node also stales the pointer that watches it, so the
re-audit is already queued by the machinery.

## The fold cannot be split in two

Law and evidence are entangled inside `foldStandard` BY DESIGN:

- `spec.ratified` binds and activates the acknowledgements chained to its operations.
- `spec.withdrawn` calls `foldReliance`, which reads **audits, pointers, populations,
  problems and criteria** — evidence — to decide whether a LAW act is permitted.

So the two scopes are folded together, over a merged event stream. This is safe:
`sortEvents` is a deterministic topological sort that treats a parent outside the input set
as already satisfied, so folding the union of two scopes yields the same order on every
clone with no new machinery.

**The hazard, and it fails quietly:** a machine that has synced only the law scope computes
a WRONG withdrawal verdict rather than an incomplete one — `foldReliance` would see no
reliance and permit a withdrawal that something already cites. The fold must refuse to
decide a withdrawal when the evidence scope is absent, not decide it optimistically. Write
that guard with the split, not after it.

## Sequencing

**Before seeding.** After ~150 requirements exist, audits, acknowledgements and pointers
hold their ids, and this stops being a refactor with tests and becomes a migration with
referential integrity to preserve.

Two further notes for whoever builds it:

- `MATERIALIZER_VERSION` must bump. The cache fingerprint is over the sidecar's SHARDS,
  which do not move when the fold's mind changes, so a store that had already folded the old
  scope would serve a standard missing everything — and `served()` would call it
  authoritative.
- `served()` spanning two scopes is **compiler-enforced**: its return type carries the
  `scope` field, so an unmarked read does not type-check. The `blocked-scope` sweep is a
  second line, not the first — and it had been failing open on `withdrawSpec` for two
  commits before that was noticed.
