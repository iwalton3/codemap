# What else should travel: flows, bugs, contest talk, and an inbox

Design, not yet built. Written 2026-08-24, after shared triage landed and the beta
readiness review named four remaining cross-team gaps.

`docs/sidecar-architecture.md` is normative and outranks this. The one sentence that
decides most of what follows:

> **Acts enter the log at the moment they happen; everything derivable is a local
> projection.**

---

## 0. The graph travels — flows are not a special case

**Owner's reframing, 2026-08-24, and it supersedes the itinerary design this document
opened with: a flow is just a node with forced cardinality.** A `process` is a
`node_versions` row like any other; what makes it a flow is that its `step_of` edges are
ORDERED. So there is no flow entity to design. Sync the graph and flows arrive with it.

That also fixes a live defect rather than deferring it. The `edges` table has no
`origin`/`source_scope` columns (`src/db.ts:182`), so an edge cannot be fold-owned — a
teammate's doc arrives with its citations and **none of its wiring**. Every wiring
surface reads local-only `readGraph()`, so on the event matrix their aggregate reports
`orphan: true` (`src/ops/graph.ts:207`) — "nothing folds this, nothing projects it" —
when the truth is their `connect` calls never travelled. A confident false claim on a
headline surface, reachable the moment two people publish docs.

### What does not travel is what is DETERMINISTICALLY REGENERABLE

The criterion is not "a machine wrote it" — an agent's doc, and an agent's flow, are
authored work that costs real reading time and does not come back if lost. Those sync,
and docs already do. The criterion is whether **any clone can reproduce it exactly from
the code at a commit**, in which case shipping a copy buys nothing and costs a copy that
can never be refreshed or judged stale.

`generatedBy` is that marker today and means exactly one thing: *"Analyzer that
generated this node; absent = human-authored"* (`src/schema.ts:299`). An agent writing
through MCP does not set it. So the filter is analyzer output, not machine authorship,
and the distinction matters because getting it backwards would drop the most valuable
shared content in the system.

Measured on the live targets, which is what makes this cheap:

| store | edges | analyzer-generated | human |
|---|---|---|---|
| `Acme.API` | 1109 | 830 (75%) | **279** |
| `Acme.React` | 217 | 0 | **217** |

Human types are the ones that carry meaning between people: `step_of` (flows),
`touches`, `depends_on`, `calls_api`, `from_state`, `transitions_to`. A few hundred rows
per universe — the volume objection that deferred edge sync does not survive the
generated-output filter.

### The unit is a node's OUTGOING wiring, at a commit

Not per edge. One act publishes the whole set of edges out of one node, stamped with the
commit it was authored against.

Per-node is what makes ordering coherent: a flow's cardinality is a property of the
whole `step_of` set, and per-edge events would let two clones hold a half-reordered flow
that neither person ever authored. It is also the granularity a repair queue wants —
"this node's wiring diverged" is actionable; "edge 7 of 55 diverged" is not.

`graph.published` carries `{ nodeId, commit, edges: [{to, type, order}] }`. It is a
REPLACE for that node's human edges; analyzer edges are never in it and are never touched
by the fold.

### Merge: fast-forward, or queue it

**Owner's rule, and it is sharper than "detect divergence": if the interleave produces a
different answer than a plain wall-clock replay, the reordering deserves an agent's
eyes.** Git's fast-forward versus a real merge, and it makes the detector decidable
rather than a judgement about causality.

Concretely, per node's wiring:

- **W** = the winner under wall-clock order (`at`, then event id for the tie — `at`
  alone is not a total order, and two clones sharing a timestamp would otherwise pick
  differently, which breaks CONVERGENCE).
- **C** = the winner under canonical `sortEvents` order, which is the causal one.
- **W is served.** That is the owner's call: wall-clock based.
- **W ≠ C is the flag.** The two orders disagree exactly when a causally later
  publication carries an earlier clock, or when the writes were concurrent and the tie
  broke differently. Either way the ordering *mattered*, which is the whole signal.

Two cheap reductions over a small set, no causal reasoning at the call site.

This is what keeps the repair model fed. A silent last-write-wins leaves nothing to
queue: the loser vanishes and nobody learns the ordering was load-bearing. The
comparison is what turns "somebody's write lost" into a fact the queue can carry.

The queue is the existing `review_queue`, filed the way contested triage is: derived
locally from the receipts, never mirrored, closed when the fold stops reporting the
divergence. Conflict classes worth naming, because they are what an agent will actually
see:

- **Diverged wiring** — two people re-wired one node apart.
- **Duplicate flow nodes** — two people created a `process` for the same real flow under
  different ids. Not a merge at all; the repair is to retire one and re-point its steps.
- **A step that is not a node here** — an edge citing a node this clone does not have,
  which is ordinary while docs are still arriving and a real hole if it persists.

An agent's repair is an ordinary `graph.published` act by that agent. It carries a
commit like any other, so it is authoritative for that commit exactly as a local edit is
— there is no special repair authority, which is what keeps this from needing a
settlement protocol.

### What this does NOT need

No itinerary snapshot, no per-flow scope, no `flow.retracted`, and no separate flow
payload. Those were the previous section of this document and are superseded. The four
review findings against them (wall-clock premise, per-step witnesses, container-level
`DerivationTag`, review marks on a shared step) are moot along with the design — a
shared flow is now a local node with local review, wired by edges that travelled.

One finding survives the change, and its first statement here was wrong. **An edge cites
node ids, and a node id is not derivation-dependent** (it is a doc id, minted by whoever
wrote the doc), so edges do not inherit the anchor-provenance problem. I then claimed the
hazard was ORDER — an edge arriving before its node. That is not really reachable: one
`git pull` brings every scope, so arrival is atomic at the transport.

**The real hazard is REFERENTIAL, and it is much bigger.** A human edge can cite a node
that by design never travels — an analyzer-generated one. Measured on `Acme.API`: of the
279 human edges, **84 (30%) touch an analyzer-generated node**, all `from_state` and
`transitions_to` pointing at analyzer-derived state nodes.

So a third of the wiring that would sync cites nodes the reader can only obtain by
running the analyzer themselves. That is not a corner case, it is a precondition:
**graph sync is only useful to a teammate who has run the same analyzers.** Three
consequences:

- The reader's surface must say **pending analyzer**, never *dangling* or *orphan* — the
  node is not missing, it has not been generated here yet. Rendering it as absent is the
  same false claim this whole section exists to remove.
- The hub should say so during onboarding, beside the peers list: *this universe's shared
  wiring references analyzer output; run `analyze marten` to resolve it.*
- The publish surface should COUNT them, the way `publishLocalDocs` counts skipped
  generated docs, so somebody publishing wiring can see how much of it depends on the
  other side running an analyzer.

## 2. Bugs — findings that outlive a pull request and go stale instead of closing

**Status: BUILT (2026-08-24).** `src/shared-bugs.ts` is the fold, `bugs` is the table,
and every point below landed as written. Four things the design did not say, each forced
by building it:

1. **A bug is filed straight into the log**, not published from a local row. The owner's
   call, and it matches findings: `shareFinding` appends the moment it is called. A
   `publish_bugs` op still exists, but as the BACKFILL path for the backlog that predates
   the sidecar — not the ordinary one.
2. **There is no local `bugs` twin, and the migration is the interesting part.** The
   entity moved from `meta["bugs"]` — a JSON blob whose create and update rewrote the
   whole array — into one canonical table where a teammate's bug is a row with an
   `origin`. The four legacy statuses map onto `FindingState` (open→created,
   fixed→resolved, wontfix→withdrawn with the old name as the closing reason,
   invalid→invalid), and the free-text `history` becomes the thread, because it is the
   only record those bugs have. Every migrated bug stays LOCAL: a legacy `Bug` has no
   `Actor`, so publishing on upgrade would attribute the whole backlog to whoever
   upgraded first.
3. **The finding→bug id is DERIVED** (`bugIdFor`), for the reason §3's review gave about
   raising a contest: two people accepting one finding offline would otherwise mint two
   bugs for one defect, with the conversation split across them. Derived, the fold merges
   them — first filing owns what one person owns, citations merge.
4. **Tracking is a list keyed by system, not a scalar.** A bug genuinely can be a Jira
   ticket AND a GitHub issue. Within one system the first entry stands and only a person
   may re-point it; an agent detaching the team's conversation from a ticket is the same
   class as an agent closing a finding somebody stood behind.

Two things the design named that did NOT need building: `filedAt` (when a published bug
was originally recorded, apart from when it reached the team) had to be added, and
`possiblyFixed` never travels — `ops/bugs.ts` computes it on every read against the
local index, and `shared-bugs.test.ts` asserts the string never appears in a folded bug.

**Owner's spec:** a bug is a finding not anchored to a specific PR, which can go stale
but is **not auto-closed when its anchors drop out from under it**. Stale citations put
it in a possibly-fixed queue.

That last clause is the whole design and it is the opposite of the obvious behaviour.
When the code a bug cites disappears, the tempting read is "fixed, close it" — and that
is exactly the silent green check this project exists to prevent. Code vanishing from
your checkout means the symbol moved, the branch changed, or somebody deleted it without
addressing the defect; only a person can tell those apart. So the drift moves it to a
queue and never past one.

Reused verbatim from `shared-findings.ts`, because a second copy of a lifecycle is how
two copies drift: `FindingState`, corroboration as a grow-only per-reviewer set,
`needsHumanAck`, asks, outcomes.

Three things differ, and only the first is what the owner called out:

- **Scope is `bugs/<universe>`.** A bug outlives every PR that touches it, where
  `findingScope` is PR-keyed precisely because a finding is about a change.
- **Bugs are witness-bearing, and the verdict does not travel.** The witness is a
  portable receipt; whether it is stale HERE is a local join against this machine's
  index, by the rule that already governs doc freshness and triage drift. So
  `possiblyFixed` is derived per clone and is never an event.
- **Anchors are a grow-only SET, not a revisable scalar.** This is the one place "just
  findings" does not transfer, and it has a measured shape: the local bug is a JSON blob
  in `meta` whose create and update paths rewrite the whole array (`src/ops/bugs.ts:115`),
  and it carries `addAnchors`, whole-witness refresh, and append-only history. Two people
  adding different anchors offline would, under scalar-revision semantics, either contest
  whole arrays or lose one addition. Grow-only is what findings already do for
  corroboration, for the same reason — the additions are not in conflict, and collapsing
  them destroys the thing being collected. Removing an anchor stays a person's act.

## 3. Contest discussion — the gap I introduced

The contest queue item is derived and local, so an investigation written on it stays on
one machine. Two people can both spend an evening on the same disagreement. This was the
right correctness call — mirroring derived state produced N unclosable questions per
contest — but it is a live cross-team cost.

**The fix is one action, not a mechanism: "raise this to the team".**

It files an ordinary **shared note** on the contested target, seeded with the contest's
evidence digest and both sides. A note is an *authored act*, so it enters the log
legitimately, travels, threads, and closes under the rules that already exist — no new
lifecycle, no special case in the note fold.

That keeps the boundary intact: the machine's *derivation* stays local, and a person's
*decision to discuss it* is what travels. The digest in the note body is what links the
thread back to the contest, so a reader arriving at the note can see what it was about
even after the contest settles.

Cheap, and it should land before a second person starts investigating contests.

---

## 4. An inbox — derived, local, and needing exactly one stored number

Today "waiting on you" exists per pull request (`ackQueue`). There is no universe-wide
"what arrived since I last looked", which is how things get missed once more than two
people are syncing.

**It is a projection, not a feature.** Everything it shows already travels; what is
missing is a watermark to subtract. So:

- One local value per universe: the last event id the reader acknowledged seeing. Local,
  because it is a fact about this person's attention on this machine — the same category
  as a review mark, and for the same reason.
- The inbox is every folded scope's contents whose originating event sorts above that
  watermark, grouped by kind: findings needing your ack, notes and questions on symbols
  you have marked, docs a teammate changed that you had signed, stakes that now contest.
- It **derives**, so it needs no new events, no merge rule, and it is identical on two
  clones holding the same log.

Two things to get right, both of which this codebase has already been bitten by:

- **Filter by relevance, not by novelty.** A universe-wide list of everything new is the
  wall of noise that made the push panel unreadable. The interesting predicate is
  "touches something I have signed, triaged, or authored".
- **Advancing the watermark is an explicit act.** Advancing it on render means opening
  the page marks everything read, and the one thing an inbox may not do is silently
  decide you have seen something.

---

## Order

1. **Graph sync** (§0) — flows come with it, and it removes a live false claim
   (`orphan: true` on a teammate's wired node) that is reachable on day one of the beta.
   Human edges only; the generated filter is what makes the volume trivial.
2. **Contest raise-to-team** (§3) — small, closes a gap already open, needs the
   deterministic id below.
3. ~~**Bugs** (§2)~~ — **BUILT 2026-08-24.** Most machinery reused, as predicted; see
   the four deviations at the top of §2.
4. **Inbox** (§4) — CUT from this plan. The watermark design does not work (see below);
   the product need stands and wants a separate frontier design.

## What a design review refuted, 2026-08-24

Nine findings against an EARLIER draft, in which a shared flow was an itinerary snapshot
rather than a synced graph. **Four of them died with that design** and are kept only so
the reasoning is not re-derived: the wall-clock premise, per-step witnesses, a
container-level `DerivationTag`, and review marks on a shared step were all consequences
of a flow being a foreign artifact. Under §0 a shared flow is a local node with local
review, so none of them arise.

The rest still bind, and are what §0, §2, §3 and §4 above were written against.

**The wall-clock safety argument does not cover the selection rule I added.** It rests
on both candidates describing the same commit; the selection rule then reaches across
commits, so a walk published at an ancestor from a fast clock beats a later walk at a
descendant. And even within one commit the loser is not necessarily equal: the commit
pins the SOURCE, not the local graph the itinerary was snapshotted from, so a six-step
walk can be replaced by somebody's stale three-step one. The stopping condition I named
("if a flow grows an accumulated field") is too narrow. The real one: every losing
artifact must be discardable, carry no obligation or external reference, **and compete
only with descriptions of the same code** — which cross-commit selection already breaks.

**Raw anchor ids cannot make an older itinerary safe on a newer checkout, so
"per-step anchors say what has moved since" is false.** Anchor ids deliberately survive a
body rewrite. A walk published at C1 whose step cites `a_transfer` resolves perfectly at
C2 after `transfer` was rewritten — the reader gets last week's explanation beside this
week's code with nothing marking it stale, and may sign it. Fixing that means carrying
witnessed hashes per step, which makes the flow **witness-bearing today**, which in turn
removes the "throw-away" premise the wall-clock rule depends on. These two findings are
one problem: the artifact is less disposable than the design assumed.

**One `DerivationTag` on the container contradicts the provenance model**, which carries
derivation per VALUE precisely because one container can hold values from several. A
flow spanning C# and TypeScript has more than one valid tag, and `resolveAnchor` consumes
per-anchor hash evidence rather than a tag anyway. The payload needs `BugWitness`-shaped
per-anchor evidence — which is the same conclusion the previous finding reaches by
another route. The three reader states also omit `undetermined`, and "offer to re-derive
locally" promises a mapping from an incomparable id back to a local one that does not
exist without a locator.

**Review marks on a shared step produce a green check covering nothing.** Node-level
review derives its covered anchors from the reader's LOCAL node, and a shared step
deliberately creates none — so signing one stores a review with zero witnesses that
reads `reviewed/direct` forever. Shared steps need payload-driven anchor-level review,
or no node-level control at all. This does not require edges.

**Identity, storage and retraction in §1 describe three different folds:** "two people's
walks are two answers", one winner per `(flowId, commit)`, and a row per
`(flowId, commit, author)`. Walkthroughs resolve this by superseding within an author,
keeping both, and selecting a display candidate. Settle that before choosing a key, and
drop `flow.retracted` from a first build — a correcting publication is already the
reversal under a throw-away model.

**The inbox watermark is unsound and §4 should be cut from any build plan.** An event id
orders CREATION, not arrival: B advances to `e2` (Tuesday), then pulls A's `e1` (Monday,
written offline), and `e1 < e2` so it never appears despite arriving after B last looked.
No clock skew needed. Worse, folded entities do not retain an event id per act — a
finding created before the watermark can be `finding.requested` after it, and the row
keeps `created_at`, not a last-activity id, so recovering it would mean reading NDJSON on
a read path. A real inbox needs an observation frontier or per-event arrival metadata,
and it is NOT identical across clones — relevance depends on local review marks.

**Bugs differ by more than identity.** *(Upheld, and it decided the build: the entity
became a table before it became shared.)* There is no local `bugs` table: they are one
JSON blob in `meta`, and both create and update rewrite the whole array — the whole-list
writer my "open question" guessed at. Bugs also carry collection semantics findings do
not (multiple anchors, `addAnchors`, whole-witness refresh, append-only history), so two
people adding different anchors concurrently either contests whole arrays or loses one.
The lifecycle reuses; the entity update semantics do not. `possiblyFixed` must not
travel — that part holds.

**"Raise to the team" needs a deterministic id.** Two people deriving the same contest
offline and both raising it mints two random note ids, and the fold dedupes only on
identical subject — two threads for one disagreement, which is the failure the action
exists to prevent. Derive the id from `(target, evidence digest)`, as the local queue
already does.

**Also missing from the payload:** `touches` edges, which the walker uses to show the
modules each step traverses. Snapshotting those references into each step keeps the
no-edge-sync property; it is payload completeness, not graph synchronisation.
