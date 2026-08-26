# Sharing triage

> **Kind: current reference** — describes how codemap works today. Trust it; fix it if it is wrong.
> triage on the sidecar, built.

Normative for how stakes travel between people. Written 2026-08-24.
`docs/sidecar-architecture.md` outranks this where they disagree.

**The decision is made:** triage travels, because the hand-off currently transfers
findings without the stakes used to rank them. `docs/sidecar-gap.md` §3 recorded it as
open; the owner settled it on 2026-08-23, and `oracle-handoff.test.ts` carries an
inverted WALL that fails when it starts working. What follows is only *how*.

## Fold canonical order, do not join

Agent writes are **not commutative**. `{important, complexity absent}` then
`{business-critical, wiring}` yields complexity absent — which every consumer reads as
`standard` — while the reverse yields `wiring`. The cause is a deliberate asymmetry: an
absent complexity is read as `DEFAULT_COMPLEXITY` once a mark exists
(`src/triage.ts:133`), but an explicit `wiring` stands on a FIRST mark
(`src/triage.ts:150`).

So there is no lattice and no max-fold. **Replay events in canonical `sortEvents` order
through `ratchet`.** DETERMINISM (`src/oracle-properties.ts`) requires every clone to
reach the same value after sorting, not a commutative reducer — and `sortEvents` is a
causal-first, then id-total order, so it always does.

The counterexample is a mutation-checked test, not a paragraph. Do not replace the fold
with a max because the axes look ordered.

## The model

Two event kinds.

**`triage.asserted`** — one writer's claim about one target, carrying only the fields it
actually asserts, each with its own receipt.

**`triage.cleared`** — a human's assertion that a target has NO stakes. It carries an
explicit presence discriminator and must NOT be encoded as `importance: undefined`:
`applyRevision` (`src/contest.ts:70`) reads an absent field as "this event did not touch
it", so a clear written that way is indistinguishable from silence.

### Supersession is per FIELD

An assertion supersedes causally-seen claims **only for the fields it carries**.
`triage.cleared` asserts presence=false and supersedes every field it saw. A settlement
must likewise name the field: writing complexity after seeing an importance disagreement
does not settle importance.

Per-field is about what an assertion REACHES, not about how a local write is composed —
see "Local semantics do not change" below.

### Clearing

`clearTriage` (`src/triage.ts:200`) filters the target out of the local blob. That cannot
be copied into shared state: the log is append-only and NO LOSS forbids removing an event
once observed. A shared clear appends `triage.cleared`, **human-only enforced at the
fold** — today's "human-only in practice" is a comment, not a gate.

- Causally after a mark → the target folds to absent. The superseded mark stays in
  history and simply does not appear in the projection.
- Concurrent with another human assertion → **presence wins**, by the same rule as
  everything else: a mark nobody wanted costs a glance, a mark silently removed costs
  the review it was asking for. The clear stays in history and a human who has seen both
  can clear again.
- A later agent escalation may create a new `likely` mark. **A clear is not a permanent
  ban** — stakes genuinely arrive later. But a complexity-only agent claim after a clear
  is still refused, because there is no importance on record and an agent that asserts no
  stakes does not get one invented for it (`src/triage.ts:130`).

### Merging: let the stakes decide how much machinery the conflict gets

Triage exists to say how much ceremony a thing deserves. Its own conflicts get the same
treatment, and that is what keeps the rule from being either lossy or exhausting.

**1. Causally-seen always supersedes.** If you looked at `business-critical` and set
`low`, you win — that is a decision, not a merge, and it is the normal way anything gets
lowered. Most of what looks like conflict is this, and it needs no machinery at all.

**2. Concurrent divergence: the higher value wins, silently.** No contest label, no queue
item. Two people who never saw each other disagreeing about `low` versus `important` is
not worth anyone's attention. Nothing is lost by taking the higher one — **both receipts
are retained regardless**, because per-field provenance is already required — it simply
does not demand a decision.

The asymmetry is the whole argument, and it is the same one that makes `tripwire`
arm-safe: ranking something too high costs somebody a few minutes; ranking it too low
costs the thing this project exists to prevent.

**3. Except across the `business-critical` line, which goes to the review queue.** When
one side says `business-critical` and another says lower, that is the only disagreement
where being wrong is expensive, and it is rare. It becomes an item in the existing
`review_queue` — the same queue `ackHole` files into — for a person to settle.

**Only a person settles, and the build changed this sentence.** It used to say an agent
may settle an agent/agent disagreement. That half is UNREACHABLE: settling is asserting
a value having SEEN both sides, `ratchet` refuses an agent's no-op restatement, and a
contest exists only across the `business-critical` line — so there is never a higher
value left for an agent to assert. The options were a special case inside `ratchet`
(consolidated from three copies precisely to stop them drifting) or dropping the claim.
Dropped: the agent is ASSIGNED the queue item, investigates, and reports an `outcome` —
a proposal, so the person is not deciding blind — and the person settles by triaging the
symbol again. That mark supersedes both sides and every clone's item closes itself.

**Rejected: last-in-wins.** Among concurrent events "last" means "larger event id", so a
`low` written by somebody who never saw the `business-critical` would silently lower it
because its id happened to sort later. Review priority decided by id during an
unresolved disagreement is the failure mode this codebase rejects everywhere else, and
it is silent, which makes it the worst available option.

**Rejected: contest everything.** Correct and exhausting. A sticky contested label on a
`low` versus `important` disagreement spends attention to protect nothing, and a rule
people route around is worse than a simpler one they keep.

### Which agent claims are still active

A sequential fold alone gets this wrong. If an agent claim `A` is concurrent with a
human assertion `H` and ids sort `A` before `H`, treating `H` as "reset the state"
erases `A` — even though `H` never saw it. Per target and per field:

1. A claim is suppressed by a human assertion only if `causal.saw(human.id, claim.id)`.
2. An agent claim **concurrent** with a human assertion stays eligible regardless of
   canonical sort order.
3. From the active human baseline, replay eligible agent claims in canonical order
   through `ratchet`.
4. An eligible agent claim is **visible only if it actually raises** the effective
   value. Concurrency alone does not make a lower or no-op claim an escalation.

The projection carries three things per field, not one:

```ts
importance: {
  baseline?: AxisReceipt;    // the active human assertion
  effective: AxisReceipt;    // what ranking and severity use
  escalation?: AxisReceipt;  // set when an agent supplied the effective value over a human baseline
}
```

`Triage.importance` as existing consumers see it is the **effective** value. The human
baseline stays visible, or "confirm" has nothing concrete to mean.

### Local semantics do not change

A local write is one act and keeps producing one record: `ratchet` inherits the existing
complexity and `setTriage` stamps it (`src/triage.ts:153`, `:182`). The fold then treats
that record as a set of field assertions **sharing one receipt**, which is where per-field
provenance comes from without inventing a second merge rule. Single-player behaviour is
untouched, and there is exactly one rule for what a write means.

### Where a derived item lives, and where an act lives

One sentence, which the build had to learn twice and which
`docs/sidecar-architecture.md` already contains in two halves:

> **Acts enter the log at the moment they happen; everything derivable is a local
> projection.**

An event is something somebody DID. If it is computable from what is already in the log
it must not be an event: a derived event has no honest actor and no honest causal
position, and since the fold is deterministic, N clones derive it N times. That is not
theory — the contest queue item was filed through `annotate`, which mirrors, so every
clone produced its own shared question with its own random id for one team fact, and the
shared-note fold refuses agent resolutions so none of them could ever be closed. The
duplication is the SIGNATURE of a derived fact being logged.

Symmetrically: a claim somebody did make but that never entered the log cannot be
retrofitted with a causal position. `after` is captured at APPEND time, so a local row
published later claims to have seen everything pulled in between. That is why a failed
append now writes nothing rather than falling back to a local row, and why a bulk
publish holds back targets the log already answers differently.

### Local versus shared: pessimistic, and flagged

Where the log answers a target and this clone also has an unpublished mark, the merged
read takes the WORSE of each field — higher stakes, deeper verification, armed tripwire
— and records a `divergence` naming every field where the two disagree.

Two rules were tried and are wrong, both recorded because each looks reasonable:

- **Merge per field, silently.** Produces a pair neither side asserted, and a reader
  cannot tell it from a judgement.
- **The log is the whole answer.** Fixes that, and hides an uncontradicted local `deep`
  behind a team mark that only ever mentioned importance — so consumers fall back to
  `standard` and a review bar is lowered by a merge rule.

Pessimistic-and-flagged keeps one asymmetry in the system rather than two: it is the
same rule the fold already applies to concurrent divergence, for the same reason
(over-reviewing costs minutes, under-reviewing costs the thing this exists to prevent).
The flag is what stops it lying — the record is the SAFE reading, not anybody's
assertion, and every surface that shows the value shows the flag beside it. Publishing
yours, or adopting theirs, ends it.

### Lifecycle needs to be commit-chain aware, and is not yet

**Open, and the honest answer to a class this build only papered over.** A clear is
superseded only by something that could reinstate the mark, which stops a complexity-only
assertion erasing a tombstone — but that is a guard, not a model.

The real question underneath is one this codebase keeps meeting in different clothes:
**"dead at commit" and "just not on this branch right now" are different facts, and
nothing here can currently tell them apart.** A tombstone says a person asserted an
absence; it does not say whether the code is gone from the history or merely absent from
the ref you have checked out. The same ambiguity is why a doc nobody can place is queued
rather than cleared (`docs/anchor-id-provenance.md`), and why `orphanedWork`'s `lost`
bucket had to grow a `why`.

The direction, per the owner: make the lifecycle commit-chain aware, and give agents the
job of resolving the ambiguity — `whereWas` already answers "what did this id name at
that commit" for a single record, and a lifecycle built on it could say *dead at this
commit* rather than *absent here*. Not designed yet. Until it is, a clear is a person's
assertion about the branch they were on, and that is what the tombstone records.

### The compatibility surface

`Triage` (`src/schema.ts:868`) and `TriageInfo` (`src/triage.ts:208`) have singular
`source`, `likely`, `reason` and `witnesses`. A record whose importance is human and
whose complexity is an agent's cannot truthfully have one of any of them. So:

- `likely` is **derived**: true when any effective field is agent-supplied.
- Top-level `source` and `reason` become aliases of the **importance** field's receipt,
  and are documented as such rather than left ambiguous.
- `axes.importance` / `axes.complexity` / `axes.tripwire` carry the authoritative
  provenance.
- **`triageDrift` and human-drift re-escalation read per-field receipts**
  (`src/triage.ts:429`, `src/triage.ts:526`). Left on the assembled `Triage.witnesses`
  they would keep asking a record-wide question of one field's witness array — which is
  the compound-value bug, surviving the fix.

### `tripwire`

A third receipt-bearing field, not a flag on the record. It fires from the record-wide
witnesses today (`src/triage.ts:523`); once importance and complexity have independent
receipts, neither is necessarily the snapshot the tripwire was armed against.

- **Humans only.** An agent's value is ignored by the fold.
- Omitted means "did not touch"; `true` arms, `false` disarms.
- A causally later human value wins — the same supersession rule as everything else, so
  the way to disarm an alarm is to look at it and disarm it.
- Concurrent `true`/`false` resolves to **armed**, by the same "higher value wins" rule:
  silently choosing `false` loses an alert, while choosing `true` produces an unwanted
  one that is reversible and visible. No contest label; an alarm nobody asked to be
  armed is a nuisance, and one silently disarmed is the failure.
- `triage.cleared` causally after an arm disarms it — the clear asserts the absence of
  the whole mark. A clear CONCURRENT with `tripwire: true` leaves it armed, by the
  presence rule above.

Prior art is weak and should not be copied blindly: `finding.promoted` is a genuine
one-way latch with no false event (`src/shared-findings.ts:281`), and `note.resolved`
takes both values but is silently id-ordered on concurrency
(`src/shared-notes.ts:143`). The note rule is tolerable for a note lifecycle and wrong
for an alarm whose `false` suppresses notification.

## What travels

Each asserted field carries its actor, source, `likely`, reason, timestamp, **source
commit** and `BugWitness[]` — unchanged. The source commit is new: `TriageInput.ref`
exists (`src/triage.ts:100`) but is used only to obtain hashes, and the record stores no
locator (`src/triage.ts:182`). A body hash decides whether a claim applies here; it
cannot retrieve or explain the writer's version of the code.

**No verdict travels.** Not `fresh`, `drifted` or `fired`. Whether a teammate's claim is
fresh *here* is a local join against this machine's index — `witnessDrift`
(`src/reviews.ts:469`) via `resolveAnchor` (`src/anchor-resolve.ts:151`) already answers
`found` / `absent` / `undetermined` / `incomparable`. A teammate's witness is a portable
**receipt**, not portable truth.

**`source: "graph"` does not travel**, refused at the publish surface *and* at the fold.
It is regenerated locally by `deriveTriage` (`src/triage.ts:431`), and
`docs/sidecar-architecture.md` puts deterministic analyzer output in local SQLite. The
fold has to refuse it too, because remote events come from builds this one did not write
— the rule already stated for findings (`src/shared-findings.ts:22`).

## Triage does NOT use `contest.ts`

Worth saying outright, because "use the existing machinery" was an earlier draft's
answer and the merge rule above replaced it. Triage resolves concurrent divergence by
taking the higher value, and escalates only across the `business-critical` line — to the
review queue, where a person acts, rather than to a contested field that sits on the
record until somebody clears it.

That also sidesteps a live defect rather than depending on it. `contest.ts` gates
SETTLEMENT on the actor (`src/contest.ts:88`) and not CREATION: `applyRevision` records
every incoming owner (`:75`) and detects divergence without testing either side (`:103`).
**Measured:** two agent assertions produce a contest that neither of them may settle.

That defect is live for findings and notes today (`src/shared-findings.ts:237`,
`src/shared-notes.ts:127`) and is deliberately **not fixed here** — a global actor rule
has consequences for both that are unrelated to this decision. It is filed in
`docs/HANDOFF.md`.

## Storage

Triage lives in `meta["triage"]` as one JSON blob (`src/store.ts:1091`). A
`shared_triage` table beside it would be the parallel-table bridge the docs unification
deleted. So triage moves to **one canonical table**, carrying `origin` and
`source_scope` exactly as `node_versions` does.

**Identity needs partial unique indexes.** SQLite does not conflict NULLs, so a
`UNIQUE(target_kind, target_id, source_scope)` permits duplicate local rows — measured,
it inserts two. Use:

```sql
CREATE UNIQUE INDEX ... ON triage(target_kind, target_id, field)
  WHERE source_scope IS NULL;
CREATE UNIQUE INDEX ... ON triage(source_scope, target_kind, target_id, field)
  WHERE source_scope IS NOT NULL;
```

### The seam needs several shapes, because every writer is a whole-list rewrite

`WHERE source_scope IS NULL` on the write is necessary and **not sufficient**. Once
`readTriage` returns local and fold-owned rows merged, every read-modify-write path
feeds a teammate's rows back as local ones:

| path | what it does now | what breaks |
|---|---|---|
| `setTriage` (`src/triage.ts:169`) | reads all, replaces one target, writes all | copies every unrelated fold row into the local partition |
| `clearTriage` (`src/triage.ts:200`) | filters one target, writes the rest | does **not** remove a fold-owned target — the next merged read returns it — and clones the others |
| `deriveTriage` (`src/triage.ts:431`, `:500`) | seeds from all non-graph marks, regenerates graph, writes all | turns regenerating graph output into an accidental adoption of teammate rows |
| `setTriageBatch` (`src/triage.ts:570`, `:597`) | rebuilds the whole list from every anchor row | same cloning |
| overload remap (`src/ops/indexing.ts:105`) | rewrites ids and witnesses in place (`src/migrate-overloads.ts:110`) | locally rewrites immutable shared history into duplicate local rows |

The remap is the case that shows the rule rather than merely obeying it. Remapping an id
is this build re-deriving *its own* index; a teammate's mark names ids in **their**
claim, and rewriting those here silently edits somebody else's record of what they
marked. They remap on their own machine and republish. `whereWas` already exists to say
where an id went.

So:

```ts
readTriage(root)                     // the resolved combined view — every READER
readLocalTriage(root)                // this clone's own rows — migration and regeneration
replaceLocalTriage(root, rows)       // legacy and no-sidecar local state
replaceLocalGraphTriage(root, rows)  // delete-and-replace the graph rows ONLY
upsertLocalTriage(root, row)
```

`deriveTriage` computes graph proposals against the resolved view and persists only the
graph rows it generated. `setTriageBatch` splits by source: `graph` to local replacement;
`agent`/`human` with a sidecar to events plus one materialization after the batch.

**The ratchet still decides against the MERGED value.** A writer edits its own rows, but
whether a write is a legal raise is judged against the effective stakes. Ratcheting
against a local-only baseline would let an agent "raise" to a tier below a teammate's and
lower the effective stakes while looking like an escalation.

### No sidecar, and the legacy blob

`setTriage` is a core op reachable with no sidecar configured (`src/ops/triage.ts:5`),
and most existing stores have none. Unstated, three implementers produce three authority
models. The rule, which is the one docs already use:

- **No sidecar configured** — write locally and succeed. Publishable later, exactly as
  `publishLocalDocs` publishes docs written before anyone had a sidecar.
- **Configured but unreachable** — write locally and succeed; the event is appended and
  the next sync sends it. This is what `shareFinding` already does.
- **A local pre-sharing mark meeting a configured sidecar** — it is published by an
  explicit act, attributed to the person running it. Never automatically.

That last one is not fastidiousness. A legacy `Triage` carries `source` but **no
`Actor`** (`src/schema.ts:868`), so automatic publication cannot recover who made the
mark and would attribute every historical judgment to whoever upgraded first. Docs and
notes each faced the same choice and made it the same way.

The blob migration must be idempotent: insert the rows, and only on success remove or
mark the `meta` blob, so re-opening never re-imports. `schema-eras.ts` seeds a real
triage blob in every era and `db-eras.test.ts` requires it to survive a read
(`src/db-eras.test.ts:89`), so the ladder has five fixtures watching it.

## What the build settled

**BUILT, 2026-08-24.** `src/shared-triage.ts` is the fold, `triageProjection` writes it
into the canonical table, and `oracle-contested-triage.test.ts` drives the whole arc
across two real clones. The WALL in `oracle-handoff.test.ts` is gone: triage travels,
and that test now asserts izzie inherits the stakes ben's agent set, with the receipts.

Five things the build had to decide that the design above does not state, or states
ambiguously. Each is in the code with the reasoning; they are collected here because a
reader comparing the two would otherwise have to diff them.

1. **The local-vs-shared read merge, which is not the fold's merge.** `readTriage`
   resolves PER FIELD and the fold-owned row WINS; a local row fills only a field the
   scope never mentions. The log is authoritative, and this clone's own published marks
   are events the fold has already weighed — including a teammate lowering something you
   raised, having seen it. A local row outranking that would silently reinstate the value
   they superseded, on your machine only. What is left is the honest case: a row from
   before there was a sidecar, and `publishLocalTriage` is how it stops being a gap.

2. **With a sidecar, a write is an event and NOT also a local row.** "Write locally and
   succeed" is satisfied by the append — the sidecar is a local clone, and nothing
   contacts a remote until `sync`. Keeping both would make a second copy that no
   supersession can reach. The local row remains the fallback when there is no sidecar,
   or when publishing throws: a mark must never be lost because a shared repo is missing.

3. **`setTriageBatch` publishes in ONE append.** `emitEvent` re-reads the scope to find
   its causal heads, so 531 marks on a real pull request is quadratic. `emitEvents`
   (eventlog) chains `writerPrev` across a batch and records the same `after` for all of
   them, which is the honest description: they were written knowing the same thing.

4. **The escalation is entered by STATE, which is the opposite of `ackHole`** and safe
   for the opposite reason: a contest takes two people, on one symbol, disagreeing across
   one line, so it is rare by construction — where a `HASH_SCHEME` bump made 985 docs
   unplaceable at once. `queueContestedTriage` runs on every `sync`, dedupes on a digest
   of the EVIDENCE (never the rendered prose), and revises rather than re-asking.

5. **Two modules exist only to keep the import graph acyclic**, and both are noted where
   they live. `triage-rules.ts` is the pure ratchet, so the fold can replay through the
   same rule a local write obeys without importing `triage.ts`. `triage-publish.ts` is
   the publish seam, because `triage.ts` reaching `ops-shared.ts` closes a cycle by four
   routes — `src/import-cycles.test.ts` found the second one.

The `detail` column on `triage` is what makes the projection round trip exactly: the
other columns carry the EFFECTIVE receipt so every ordinary reader works unchanged, and
`detail` carries that field's whole `Axis`.

**What is NOT built:** nothing on the checklist. CONVERGENCE covers triage for free
(it is generic over `projectionFor`); OWNERSHIP and COMPLETENESS were extended by hand.
One honest limit is recorded in `oracle-handoff.test.ts`: a local write that flattens
fold-owned rows is repaired by the re-fold the same operation triggers, so the ARC cannot
observe it — the permanent case, where no event moves the fingerprint and the cache stays
a hit, is `triage-store.test.ts`, and both mutations of the seam fail it.
