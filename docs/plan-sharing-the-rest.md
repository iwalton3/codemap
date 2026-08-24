# What else should travel: flows, bugs, contest talk, and an inbox

Design, not yet built. Written 2026-08-24, after shared triage landed and the beta
readiness review named four remaining cross-team gaps.

`docs/sidecar-architecture.md` is normative and outranks this. The one sentence that
decides most of what follows:

> **Acts enter the log at the moment they happen; everything derivable is a local
> projection.**

---

## 0. A LIVE defect this design work uncovered: shared docs arrive unwired

Not a future gap. Docs sync today, edges never have, and the `edges` table has no
`origin`/`source_scope` columns at all (`src/db.ts:182`) — so an edge structurally
cannot be fold-owned. A teammate's doc therefore arrives as a node with its citations
and **none of its wiring**.

Every wiring surface reads `readGraph()`, which is local-only. So on the event matrix a
teammate's aggregate arrives with `folds === 0 && projects === 0` and is reported
**`orphan: true`** (`src/ops/graph.ts:207`) — "nothing folds this, nothing projects it"
— when the truth is that their `connect` calls never travelled. The node catalog shows
it at degree zero for the same reason.

That is a confident false claim on a headline surface, which is the failure class this
project exists to prevent, and it is reachable the moment two people publish docs.

**It is also the honest reframing of "defer flows".** The question is not only whether
the flow-walker is single-player; it is that the graph half of every shared doc is
already missing and the UI does not say so. Two ways out, and they are not exclusive:

- **Say it.** Cheapest, and it stops the lie today: a node whose origin is `sync` cannot
  have local wiring, so the matrix and catalog must render "wiring not shared" rather
  than `orphan`. A day's work, no protocol change, and it should land before the beta
  rather than after.
- **Sync structural edges** as a fourth thing that travels. Bigger, and the itinerary
  design below deliberately avoids it for flows — but flows are the case where a WALK
  substitutes for the graph, and `folds`/`emits`/`projects` have no such substitute.

## 1. Flows — publish the WALK, never the graph

### The decision

**A shared flow is an ITINERARY, not a graph.** It says: walk these symbols, in this
order, and here is why. The `step_of` edges stay local and are never synced.

That is the whole design, and it dissolves the blocker rather than paying it. Edge sync
was judged too expensive for zero demonstrated demand, and the cost was never the
transport — it was that a graph needs a merge rule per edge, and edges interact. An
itinerary needs none: it is one immutable document per (flow, commit), and two people's
walks of one flow are two answers rather than a conflict, exactly as two walkthroughs
of one pull request already are.

`notPublishable` currently refuses `process`/`step` docs with "the shared copy would
render as an empty flow on every teammate's machine". That refusal is correct about
docs and stops being relevant here: a shared walk carries its own steps in its payload,
so there is nothing to render empty.

### Identity and supersession

Scope `flows/<universe>`, subject the flow's node id. One published walk per
**(flow id, commit)**, and within that key the **newest wall-clock `at` wins, tie-broken
by event id**.

**Identity is not selection, and conflating them was the first draft's bug.** Keying on
the commit says which walks *supersede* each other. It must not decide which walk a
reader *sees*, because a flow describes how something works and outlives the commits it
was written at — a reader is almost never sitting on the publishing commit, so
"the walk for your commit" would show nothing almost always.

`currentWalkthrough` (`src/shared-walkthrough.ts:88`) is the precedent NOT to copy here:
it requires an exact `head` match and calls everything else stale, which is right for a
pull request, where one head is the thing under review, and wrong for a flow.

So selection is: **the newest walk for this flow, whatever commit it was built at**,
rendered with its relationship to the reader's HEAD stated —

| the walk's commit | what the reader is told |
|---|---|
| is your HEAD | exact |
| is an ancestor of your HEAD | built earlier on this history; per-step anchors say what has moved since |
| is neither | built on a branch you do not have — the steps may not resolve |

`isAncestor` (`src/git.ts:374`) already answers this and is memoised per ref in
`pr-push.ts`; the same shape applies. The per-step resolution below is what makes the
middle row safe: a walk built three commits ago whose steps all still resolve is a good
walk, and one whose steps have moved says so per step rather than being suppressed
wholesale.

**Wall-clock is a deliberate exception, and the tie-break is not optional.** This
codebase rejects wall-clock ordering everywhere else, for a stated reason: a laptop
whose clock is a minute fast silently sorts its refutation ahead of the confirmation it
was answering. Two things make it safe here and neither generalises:

- The key already pins the code. Both candidates describe **the same commit**, so the
  loser is not a stale claim about different code — it is a different, equally valid
  rendering of identical source. Being wrong costs you somebody else's walk of the same
  thing.
- The artifact is **throw-away and regenerable**. Nothing accumulates on it, nothing
  cites it, and re-publishing is cheap.

The tie-break is what keeps CONVERGENCE true: `at` alone is not a total order, and two
events sharing a timestamp would let two clones pick differently. Newest `at`, then
highest event id, is deterministic on every machine.

**Do not copy this rule to anything witness-bearing.** If a future flow grows a field
somebody *accumulates* — a sign-off, a corroboration, an assignment — it stops being
throw-away and this rule stops being safe. That is the condition to check, not the shape.

### The payload

```ts
interface SharedFlow {
  flowId: string;              // the process node's id
  commit: string;              // what this walk describes. Part of the identity.
  title: string;
  summary: string;
  steps: {
    // A CROSS-REFERENCE, never a source of content: it lets a reader who also has this
    // step locally open their own doc and their own review state for it. The rendering
    // always comes from the payload, so a reader whose local node has drifted sees the
    // walk the author published rather than a silent blend of the two.
    nodeId: string;
    title: string;
    summary: string;
    anchors: string[];         // cited anchor ids, in the author's order
  }[];
  derivation: DerivationTag;   // see below — the reason this is not optional
  actor: Actor;
  at: string;
  eventId: string;
}
```

`derivation` is the field that stops this repeating the mistake `notPublishable` was
guarding against. Anchor ids are derivation-dependent, so a teammate whose build mints
ids differently cannot place the steps — and the failure mode without the tag is an
itinerary that renders as a list of symbols nobody can open, which is the empty flow
again wearing a different hat. With it, the reader says **"this walk was built by a
build I cannot compare with"** and offers to re-derive locally. Same machinery docs
already use (`resolveAnchor` → `incomparable`), same honest answer.

### What the reader sees, and what stays local

A shared walk creates **no local nodes and no local edges**. It renders from its own
payload, beside the local flows rather than mixed into them.

Per step, three states, and naming them is the point:

| the reader's index | what renders |
|---|---|
| has the anchor id | the live source, reviewable exactly as a local flow's step |
| minted under another derivation | the step, marked *cannot be placed by this build* |
| genuinely absent | the step, marked *not in this checkout* — it may be another branch |

**Review marks stay local**, unchanged and deliberately. You walk a teammate's itinerary
against **your own** checkout and sign off in your own ledger. That preserves the
existing decision (GitHub owns PR-level sign-off; the local mark is your review debt)
and it is also the honest reading: their walk is a route, your review is yours.

### Why not the alternatives

- **Sync the edges.** The original plan, and the reason this sat unbuilt. Every edge is
  a merge rule, edges interact, and the result is mutable shared graph state — the
  unbounded reconciler `sidecar-architecture.md` opens by refusing.
- **Publish the process doc and let steps resolve locally.** What `notPublishable`
  describes and refuses. The steps are the flow; without them it is an empty shell.
- **Make a walk a `walkthrough`.** Close, and wrong on identity: a walkthrough is keyed
  to a pull request and answers "what changed here". A flow answers "how does this work"
  and outlives every PR that touches it.

### Build order

1. `shared-flow.ts` — the two event kinds (`flow.published`, `flow.retracted`), the fold
   (newest-at-then-id per (flowId, commit)), `flowScope`.
2. `sharedFlowsProjection` into a `shared_flow` table, registered in `projectionFor`.
   One row per (scope, flowId, commit, author).
3. Ops: `shareFlow` (snapshot the local flow at HEAD and publish), `sharedFlows`,
   `sharedFlow(id, commit?)`. Web route + MCP read. `shareFlow` is a person's act;
   an agent may read.
4. `notPublishable` loses the `process`/`step` clause, and the WALL in
   `oracle-handoff.test.ts` becomes the real assertion.
5. Oracle workflow 8: A publishes a walk, B walks it against their own checkout, B signs
   off locally and A cannot see that; A re-publishes at a new commit and both are listed
   with the newer current. **Include the case that motivated the selection rule**: B is
   several commits ahead of the walk and must still see it, marked as built on an
   ancestor — a test that only ever walks at the publishing commit would pass over the
   bug this rule exists for.

---

## 2. Bugs — the finding lifecycle, universe-scoped

**Design only; the owner has judged implementation not yet critical.**

Bugs get the same semantics as findings because they are the same act at a different
altitude: somebody asserts a defect, others corroborate or refute, a person closes it.
`shared-findings.ts` already has the whole lifecycle, and a second implementation of it
is how two copies drift.

Reuse verbatim: `FindingState`, corroboration as a grow-only per-reviewer set,
`needsHumanAck`, asks, outcomes, the contest machinery for concurrent scalar edits.

Three differences, all in identity rather than lifecycle:

- **Scope is `bugs/<universe>`, not per pull request.** A bug outlives every PR that
  touches it. `findingScope` is PR-keyed precisely because a finding is about a change.
- **Bugs are witness-bearing.** A bug snapshots the covered code's normalized hashes and
  reads `possiblyFixed` when they move. That verdict is a **local join** and must not
  travel, by the rule that already governs doc freshness and triage drift: the witness
  is a portable receipt, the verdict is not.
- **`possiblyFixed` is not a state transition.** It is a derived flag, so it never
  becomes an event. Only a person closing the bug is an act.

Open question worth settling before building: whether a shared bug is a `bugs` row with
an origin (one canonical table, as docs and triage did) or its own projection. The
canonical-table rule says the former; check whether the local `bugs` table has a
whole-list writer, because that is what bit triage.

---

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

## Order, if all four are built

1. **Contest raise-to-team** (§3) — smallest, closes a gap already open.
2. **Flows** (§1) — the largest reviewer-facing win, and the last inverted WALL.
3. **Inbox** (§4) — worth more once flows and bugs are also arriving.
4. **Bugs** (§2) — most machinery reused, least new risk, and the owner has it as not
   yet critical.

---

## What a design review refuted, 2026-08-24

Nine findings against the draft above. The itinerary CONCEPT survives — no case was
found where a reader needs the local `step_of` graph to walk a self-contained ordered
snapshot — but four claims in §1 were wrong, and §4 does not work at all. Recorded here
rather than silently edited, because each looked right.

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

**Bugs differ by more than identity.** There is no local `bugs` table: they are one JSON
blob in `meta`, and both create and update rewrite the whole array — the whole-list
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
