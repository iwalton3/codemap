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

**Built:** `Pointer.universe` and `Audit.universe`; a pointer baseline is `contested`
rather than overwritten, with the order-insensitive comparator that keeps it from firing
when auditors agree (`221d2b3`). **The law/evidence scope split itself**, folded through
`readCachedMerged`, with `MATERIALIZER_VERSION` at 16 and the guard that refuses a
withdrawal whose evidence half could not be read.

Also built: **a requirement cites nothing** — `Requirement.cites`, `Requirement.witnesses`
and `Operation.cites` are gone, `recheckDue` derives from this universe's pointers, and the
`/diff` rollup travels along pointers.

Also built: **provisional audits travel as commit-discovered documents** (`provisional.ts`)
— the last piece of this arc.

Also built: the three DRAFT correction events (`spec.revised`, `spec.operation.revised`,
`spec.operation.removed`) are LAW, like every other `spec.*` — a proposal is not about a
repository. `isLawEvent`'s prefix test already covered them. See
`docs/requirements-architecture.md` § *Immutability attaches at ratification*; the one
guard that could not be restated in the fold is the comment count, for the reason § *The
fold cannot be split in two* gives.

**Migration is free, and that was not a given.** Law events written before the split sit in
`standard/<universe>`; the fold reads BOTH scopes and merges, so a pre-split log folds
exactly as it did and only new law lands in the shared scope. Nothing rewrites history.

**One materializer per entity, and this is where it bites.** The standard is folded from two
scopes, so `projectionFor` deliberately does not offer it: the generic loop would fold one
half alone and write a LAW-LESS standard under the real key. That bug was written twice
during the split — once in `projectionFor`, and again on the READ path, where
`standardScopeWarning` folded the evidence scope by itself and silently replaced the
standard on every read, so requirements vanished from the rows moments after ratification.
`materializeUniverse` and `standardScopeWarning` both go through `cachedStandard` now, and
`sharing-boundary.test.ts` holds both halves of the rule.

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
  was always supposed to mean. One consequence worth knowing before it surprises somebody:
  a PASSING COMMAND ALONE no longer supports a `conformant` audit, because nothing can then
  ever move under the claim. The rule's citations used to supply that baseline invisibly.

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

The hole this closed: a provisional audit was invisible to everyone but its author, and
`promotableAudits` read local rows — so it was promotable only by that author, on that
machine. A teammate reviewing the branch could not see that it fails a rule.

A provisional audit **travels** as a document at
`provisional/<universe>/<commit>/<auditId>.json` in the sidecar, and is **never folded into
the standard**. Not folding it is what keeps a branch observation out of a receiving clone's
standard STRUCTURALLY rather than by a filter: there is no row for it there at all, so
nothing downstream has to remember to exclude it. The existing fold guard is therefore MORE
load-bearing, not less: `foldStandard` still refuses a provisional audit arriving in the
standard scope, in case a client publishes one there, and `sharing-boundary.test.ts`
registers both ends.

**And conformance has a SUBJECT, decided with it.** The author's machine still writes a
local row — it has to, so the author can promote the finding and raise a problem from it —
and `conformance()` used to count it, so a branch finding moved the author's own verdict
and nobody else's. That is now an explicit question rather than an accident:

- `conformance({ about: "codebase" })`, the default, is **the team's standard**. Provisional
  evidence is excluded, so `silenced()` means the same number on every machine.
- `conformance({ about: "branch" })` is **the reviewer's question** — does the code checked
  out here conform — and is the only read where provisional evidence counts. It reads local
  rows AND the team's documents, on the discriminator used everywhere else: a finding whose
  witnesses still match is about the code in front of you, whoever took it.

The branch read must never leak back. It feeds no queue, resets no coverage deadline and
releases no acknowledgement — `settleAcknowledgements`, `scrub.ts` and `problems.ts` already
filter provisional, and `conformance()` was the one that did not.

Three mechanics carry it, and each is where the design could have gone wrong:

- **One file per audit**, which makes it conflict-free with no merge driver: two people
  auditing one commit write two names, and nobody rewrites anybody's file.
- **The READER binds the writer.** A document is written by whatever client its author was
  running, so `readProvisionalAudits` re-checks everything the path claims — `provisional`,
  the universe, the commit, and that the filename is the id. Without the first of those a
  document would be a second route to a `conformant` claim no fold ever agreed to.
- **A dirty tree does not travel at all.** Its witnesses come off the filesystem while
  `commit` names an unchanged HEAD, so filing it under that commit would attribute
  uncommitted work to a commit that does not contain it — COD-3's dirty snapshot with a
  directory name on it. The finding stays local and the author is TOLD (`notShared`), because
  believing your team can see a finding it cannot is the failure this path exists to fix.

Promotion is unchanged and still decided on **witnesses**: `promotableAudits` now reads the
union of local rows and documents, so a teammate can promote a finding they did not take.
The promotion is an ordinary audit of the codebase and travels in the log like one.

**On the surfaces:** MCP `provisional_audits` (optional `commit` — the reviewer's question),
a *branch findings* page in the browser, and a section of the same name on the rule dossier.
`getRequirement` serves `audits` (the codebase's record) and `provisionalAudits` separately
for the same reason the conformance subject exists: an audit history that mixes the two is
how a branch observation gets taken for the state of the code. The conformance page carries
the `about` toggle, and says on the page which code the answer is about.

**Partial staleness at promotion is deliberately not handled.** If some of the bodies an
audit witnessed have changed by merge time, it will not promote. That is correct rather
than a gap: an audit is an observation of specific bodies, and promoting it past the
evidence that earned it would carry a verdict the code no longer supports. Re-auditing is
the honest answer, and the scrub is the mechanism built to schedule re-looks. Chasing the
partial case would fill the auditor queue with noise to recover a verdict that should be
re-taken anyway. A staled fault node also stales the pointer that watches it, so the
re-audit is already queued by the machinery.

## The browser's principal is a notice, not a boundary

`serve.ts` binds 127.0.0.1 and resolves the actor from git identity with no agent marker,
which is what lets a person ratify, withdraw, adjudicate, grant debt and re-file — the five
acts the MCP agent latch is a ratchet to prevent. Anything that can reach that port can
perform them and be recorded as the repository's principal, an agent with a shell included.

**No gate closes it, and one is built anyway — for a reason that is not security.** An agent
that would do this could equally write events into the sidecar by hand — the store is a git
repository and the schema is in this tree — so nothing on the HTTP route removes the
capability, and this must never be described as authentication.

What it removes is the *cheapness*. The failure mode this subsystem is built against is not
malice, it is completion drive under deadline pressure taking the shortest path, and
`curl -XPOST .../adjudicate` was that path. The five acts now require the sentence handed
back by `GET /api/standard/attest`, and the sentence is the mechanism: it says **"I am a
person, acting at a browser… If you are an agent assembling this sentence in order to send
it, you are claiming to be a person so that you can perform an act this system reserves to
one. That is off the rails."** An agent can satisfy it in one extra request. It cannot
satisfy it truthfully, and it cannot satisfy it without having been told, in the response it
just fetched, what sending it would mean.

So: **do not harden this and do not make it opaque.** Hashing or signing the token would make
it easier to satisfy without reading, which is the only property it has. See
`PRINCIPAL_NOTICE` in `src/serve.ts`.

The threat model is otherwise unchanged and is the one principal identity makes everywhere
else here: **attribution without prevention.** Identity forgery is accepted; what is defended
is that nothing *silently* attributes an agent's act to a person — and now that nothing does
it *accidentally* either.

## The fold cannot be split in two

Law and evidence are entangled inside `foldStandard` BY DESIGN:

- `spec.ratified` binds and activates the acknowledgements chained to its operations.
- `spec.withdrawn` calls `foldReliance`, which reads **audits, pointers, populations,
  problems and criteria** — evidence — to decide whether a LAW act is permitted.

So the two scopes are folded together, over a merged event stream. This is safe:
`sortEvents` is a deterministic topological sort that treats a parent outside the input set
as already satisfied, so folding the union of two scopes yields the same order on every
clone with no new machinery.

**The hazard, and it fails quietly:** a machine that cannot read the evidence scope computes
a WRONG withdrawal verdict rather than an incomplete one — `foldReliance` would see no
reliance and permit a withdrawal that something already cites. So the fold refuses to decide
a withdrawal when the evidence half is BLOCKED, rather than deciding it optimistically.

**Blocked, and not merely absent — the distinction is worth stating because the guard cannot
make it.** An absent scope reads `complete` with zero events, because a scope that nobody
has written and a scope this clone did not receive are the same thing on disk. Ordinarily
that is right: the sidecar is one git repository, `pull` takes all of it, and a scope with no
events genuinely has no reliance in it. The case it does not cover is a **universe-key
mismatch** — one clone resolving `owner/repo` from its origin while another falls back to the
directory basename — where a withdrawal decided on the first clone would see none of the
second's evidence. That is the same misconfiguration `CLAUDE.md` warns about for the oracle's
fixtures, and it is not separately defended here.

## What the build cost, kept because the next scope change pays it again

The whole arc landed before seeding, which is what made it a refactor with tests rather than
a migration with referential integrity to preserve: after ~150 requirements exist, audits,
acknowledgements and pointers hold their ids.

- `MATERIALIZER_VERSION` had to bump (15 → 16). The cache fingerprint is over the sidecar's
  SHARDS, which do not move when the fold's mind changes, so a store that had already folded
  the old scope would have served a standard missing everything — and `served()` would have
  called it authoritative.
- `served()` spanning two scopes is **compiler-enforced**: its return type carries the
  `scope` field, so an unmarked read does not type-check. The `blocked-scope` sweep is a
  second line, not the first — and it had been failing open on `withdrawSpec` for two
  commits before that was noticed.
