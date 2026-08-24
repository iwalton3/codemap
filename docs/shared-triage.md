# Sharing triage

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

### Supersession is per FIELD, never per record

A human assertion supersedes causally-seen claims **only for the fields it explicitly
asserts**. `triage.cleared` asserts presence=false and supersedes every field it saw.

This is the rule that "per-axis receipts" actually implies, and it has to be stated
because the local code chooses a third answer: `ratchet` inherits existing complexity
(`src/triage.ts:153`) and `setTriage` then stamps the whole record `likely: false`
(`src/triage.ts:182`). Under a per-field rule, a human asserting only `importance`
leaves an agent's `complexity` in place **with its own `likely` and its own receipt**.

A human SETTLEMENT must likewise name the field. Writing complexity after seeing an
importance contest does not settle importance.

### Clearing

`clearTriage` (`src/triage.ts:200`) filters the target out of the local blob. That cannot
be copied into shared state: the log is append-only and NO LOSS forbids removing an event
once observed. A shared clear appends `triage.cleared`, **human-only enforced at the
fold** — today's "human-only in practice" is a comment, not a gate.

- Causally after a mark → the target folds to absent. The superseded mark stays in
  history and simply does not appear in the projection.
- Concurrent with another human assertion → a contest between presence and absence,
  settled by a later human who has seen both sides.
- A later agent escalation may create a new `likely` mark. **A clear is not a permanent
  ban** — stakes genuinely arrive later. But a complexity-only agent claim after a clear
  is still refused, because there is no importance on record and an agent that asserts no
  stakes does not get one invented for it (`src/triage.ts:130`).

### Which agent claims are still active

A sequential fold alone gets this wrong. If an agent claim `A` is concurrent with a
human assertion `H` and ids sort `A` before `H`, treating `H` as "reset the state"
erases `A` — even though `H` never saw it. The algorithm, per target and per field:

1. A claim is suppressed by a human assertion only if `causal.saw(human.id, claim.id)`.
2. An agent claim **concurrent** with a human assertion stays eligible regardless of
   canonical sort order.
3. From the active human baseline, replay eligible agent claims in canonical order
   through `ratchet`.
4. An eligible agent claim is **visible only if it actually raises** the effective
   value. Concurrency alone does not make a lower or no-op claim an escalation.

The projection therefore carries three things per field, not one:

```ts
importance: {
  baseline?: AxisReceipt;    // the active human assertion, when uncontested
  effective: AxisReceipt;    // what ranking and severity use
  escalation?: AxisReceipt;  // set when an agent supplied the effective value over a human baseline
}
```

`Triage.importance` as existing consumers see it is the **effective** value. The human
baseline stays visible, or "confirm" has nothing concrete to mean.

### While two humans disagree, do not pick by id

Concurrent human assertions contest. An agent claim never settles or replaces a human
contest. While a field is contested:

- every maximal concurrent human assertion is kept as a side;
- an agent claim is applied separately to each side whose assertion did not causally
  cover it;
- the **maximum** effective value across sides is what ranks the queue, labelled
  contested and non-authoritative;
- a later human who names the field and causally sees all sides establishes the single
  new baseline. Agent claims that human also saw are reset; still-concurrent ones stay
  eligible.

This is deliberately **stricter than findings**, where `applyRevision` assigns the
incoming value before recording the contest (`src/contest.ts:75`) and a scalar is
therefore chosen by total order. Copying that here would make review priority depend on
event ids during an explicitly unresolved disagreement, and would let a `low` side that
happened to sort last quietly lower attention on a symbol somebody called critical.

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
- A causally later human value wins. Concurrent equal values agree.
- Concurrent `true`/`false` **contests**, and while contested the projection shows
  **armed**. Silently choosing `false` loses an alert; choosing `true` produces an
  unwanted one, which is reversible and visible. Arm-safe is the only defensible default
  for an alarm.
- `triage.cleared` causally after an arm disarms it — the clear asserts the absence of
  the whole mark. A clear concurrent with `tripwire: true` joins the presence contest
  and stays armed provisionally.

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

## Contests: human events only

`contest.ts` does **not** gate contest creation on the actor. `applyRevision` records
every incoming owner before any actor check (`src/contest.ts:75`) and detects a
divergence without testing either side (`src/contest.ts:103`); `isAgentActor` appears
only in the settlement branch (`src/contest.ts:88`). **Measured:** two agent
assertions produce an `importance` contest that neither of them may settle.

Do not fix this globally as part of this feature — findings and notes depend on the
current semantics (`src/shared-findings.ts:237`, `src/shared-notes.ts:127`). Feed only
human assertions and clears into triage's `ContestState`; agent claims live in separate
escalation state and never become scalar owners for contest detection. "Use the existing
machinery" means its causal detection and settlement representation, for human events.

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

## Implementation checklist

Register triage with `projectionFor`, and extend CONVERGENCE, OWNERSHIP and COMPLETENESS
to cover it — every one of the six properties stays green over an entity kind that is
simply absent. Give `setTriage`/`clearTriage` `verified(...)` receipts. Replace the WALL
in `oracle-handoff.test.ts` with the real assertion.
