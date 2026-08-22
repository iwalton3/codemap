# Proposal: immutable provenance — profiles, generations, and receipts

Status: **draft.** Split out of `PROPOSAL-sidecar-materialization.md`, where it had
grown from an open question into the larger of the two designs. Eight review rounds
are folded in; §9 records what each round changed.

Reviewed against `worktree-shared-review-hashscheme` at `4ef2a49`.

## 1. The rule

> **Producer provenance may be referenced through the writer generation.
> Derivation provenance must travel explicitly with every durable code-derived
> value.**

Everything below is that sentence made concrete. The distinction is the whole
design, and it is the thing three earlier attempts each got half of:

- The **producer** is who wrote an event and what they were running. One reference
  on the envelope is enough, because it is a fact about the writing.
- The **derivation** is which rules minted a particular anchor id or body hash.
  That is a fact about the VALUE, not about the event carrying it, and a value
  outlives the event that first published it.

## 2. What is broken today

Four separately-filed problems, all of them this one.

**The manifest is mutable and relabels history.** `ensureSidecar` overwrites one
"current" manifest per principal on every run. When somebody upgrades, their
manifest claims the new schemes while their immutable historical events sit in the
same shard under the old derivation. A teammate folds old anchor ids as current and
silently mis-targets or orphans them. (Static review, P1.)

**An event's profile is not its values' provenance.** `publishLocalDocs` re-emits
each historical version with its original `citations` and their `acceptedHashes` —
minted under whatever scheme was current when somebody confirmed them, sometimes
years earlier. Stamp that event with today's profile and it asserts they were
derived today. The manifest defect one level down, reachable through an ordinary
migration rather than only an upgrade.

**Grammar identity is nowhere.** Body hashes encode `HASH_SCHEME` but not which
grammar tokenized the code. Two tree-sitter builds can tokenize unchanged source
differently under the same `h2:` prefix, so a reader reports real-looking drift.
Grammar mismatch is currently advisory only. (Static review, P1.)

**One principal is not one writer.** `readScope` dedupes by id because
`merge=union` can produce a line twice, and its comment names the case exactly:
*"one person appending from two machines."* Those writes are not causally related,
but `causality()` keys its vector on principal and treats a principal's previous
event as a causal parent — so fold order fabricates an edge that never existed.
Recorded in `eventlog.ts` as a known limitation.

## 3. Profiles

A **compatibility profile** is the set of values that decide whether two
derivations can be compared. It is immutable and content-addressed by its own
digest.

```ts
/** How code is turned into ids and hashes. Referenced by VALUES. */
interface DerivationProfile {
  anchorScheme: number;
  hashScheme: number;
  /** The tree-sitter runtime participates in derivation as much as the grammar. */
  parserRuntime: string;
  /** Language -> full SHA-256 of the vendored grammar blob. */
  grammars: Record<Language, string>;
}

/** Who wrote, and what they could read. Referenced by EVENTS. */
interface GenerationRecord {
  format: 1;
  writer: WriterId;
  eventSchema: number;
  derivationProfile: ProfileId;
}
```

`eventSchema` is deliberately NOT in the derivation profile. It governs how an
event is decoded, not how code is hashed, and conflating them means a receipt-format
change would bump `HASH_SCHEME` and relabel every hash in the store as a different
derivation. **Only a change to hash derivation or its canonical encoding bumps
`HASH_SCHEME`;** receipt-format changes bump `eventSchema`.

It holds only derivation-affecting values — **not** the release version. That is
what keeps generation churn low: shipping a release does not change a profile,
re-vendoring a grammar does.

Grammar identity is the **full digest**, not a friendly label and not a prefix. The
blobs are vendored and committed on purpose, so this is already sitting in the
repo — five `sha256sum`s over `grammars/*.wasm`, computed at startup or baked in at
build and checked. No registry, no version negotiation, no dependency.
`grammars/PROVENANCE.md` already records where each came from.

Profiles live in the sidecar as immutable content-addressed objects. A mutable
"what this client currently runs" manifest may remain, but it must never be
consulted to describe a historical event.

Content-addressed means the encoding is normative, not incidental: canonical bytes,
fixed key ordering, explicit integer bounds, a stated rule for unknown fields, and
domain-separated hashes so a profile digest cannot collide with a generation digest.
Readers must **verify** that an id matches the object it names rather than trusting
the reference — an unverified content address is just a mutable pointer with extra
steps, and the whole point is that history cannot be relabelled.

For the same reason a **generation id must commit to both the writer identity and
the profile id**. If it commits to only one, a generation record can be swapped to
point at a different profile and relabel every event that references it — the
mutable-manifest defect reintroduced through one more level of indirection.

## 4. Generations

A **writer generation** is `(local clone seed, profile id)`.

- The seed is **local and uncommitted**, so cloning a sidecar produces a new seed
  and therefore a new generation. Two machines on identical schemes get distinct
  writer identities, which is the point.
- A profile change deterministically produces a new generation.
- The event envelope references the generation; the generation's immutable record
  references the profile. **One field on the wire, not two.**

Causal continuity across an upgrade is not a special case: the first event of the
new generation records the current causal heads, which include the old
generation's. The `after` chain carries the writer forward exactly as it carries
anyone else.

### Shard and key the vector by generation

- Shard by generation rather than principal.
- Key the vector clock's sequence and `ownLast` by generation.
- Keep `Actor.principal` for attribution and independence, unchanged.

This removes the fabricated-edge problem structurally rather than compensating for
it: one person on two machines writes two files, so nothing union-merges anyone's
shard and prefix-closure becomes true instead of assumed.

**Prerequisite: the sidecar-root lock.** Prefix closure holds only if one
generation is a genuinely serialized writer, and two processes sharing a clone can
still read concurrently and append without seeing each other. The lock the static
review filed as P2 is therefore a **correctness** requirement here, not git
hygiene. Materialization tolerating its absence (deterministic re-folds make
concurrent cache writes benign) does not extend to this.

It must be held across **selecting the generation, reading the causal heads and
`writerPrev`, and appending** — not merely around the final write. The race is
between reading what came before and committing to it, so two processes that both
read the same predecessor have already forked whatever order their writes land in.
See §7 for how a fork that escapes the lock is detected and contained.

**Keep id deduplication anyway**, as cheap hardening. Under this model a duplicate
id is unexpected rather than routine — so if the same id appears with differing
content, quarantine it instead of silently taking the first copy.

**Legacy events without a generation** keep their principal as authoritative
ATTRIBUTION — the author is not what is unknown. What is unknown is the writer
generation and therefore the implicit causality. So:

- Use explicit `after` edges only; infer nothing from a shared principal.
- Treat otherwise-unordered contestable writes as concurrent.
- Never collapse a principal's legacy events into one synthetic writer, which
  recreates the false edge this exists to remove.
- Legacy values with no receipt stay `unverifiable`. Do not rewrite them with
  present-day provenance — that is the §2 defect, performed deliberately.

An unnecessary contest asks a person a question; an invented causal edge answers
one for them.

### Detecting a forked writer

A copied seed is the one failure a user can cause by ordinary means, and neither
documentation nor a rotation command *detects* it — two restored clones would share
a generation and silently recreate the fabricated edge.

So every event carries an explicit **`writerPrev`**: the previous event from this
same generation. Then a fork is visible rather than inferred — two events naming
the same predecessor are a writer fork, which is a fact worth surfacing, instead of
being quietly linearized by `ownLast`. It also makes prefix closure checkable
rather than assumed, which is what the sidecar lock was buying on trust.

### Generation identity must reach the entity folds

Sharding and the vector clock are not the only places one person is treated as one
writer. Verified in the current code:

- `shared-findings.ts:244` — `held.by.principal === e.actor.principal` suppresses a
  contest, so two generations of one person silently last-write-wins.
- `shared-findings.ts:335` — corroboration is keyed by principal, so one person's
  second model replaces the first, disagreement included.
- `shared-walkthrough.ts:81` — `byAuthor.set(e.actor.principal, …)` keeps one
  walkthrough per principal.

Fixing causality without fixing these leaves the collapse in place at the layer
users actually see. Each needs the *writer* identity for concurrency and the
*principal* for attribution and independence — the same split as everywhere else.

**And notes have no contest detection at all.** `note.revised`
(`shared-notes.ts:107`) overwrites `text`, `category`, `severity` and `line`
unconditionally, with no `noteContest` equivalent — for any two people, not just two
generations. Revisions survive in `n.revisions[]`, so nothing is destroyed, but
nobody is ever asked to arbitrate. That is the same class of concurrent scalar
rewrite `contested` exists for on findings, and it is a gap independent of this
design.

### The seed

Store a random clone-local seed under the sidecar's real git directory, located
with `git rev-parse --git-path` so it lands correctly in a worktree or a separate
`.git` file, created atomically with restrictive permissions.

It is deliberately **not** in the tree and **not** derivable. Losing it — a wiped
directory, a restored backup — correctly starts a new generation, which is cheap;
old events stay attributable through their principals. Reconstructing it from the
principal, the hostname, or old events would defeat the entire point.

Copying a seed into two clones that are both live recreates exactly the
single-generation-multiple-writers problem this design removes, and it is the one
failure mode a user can cause by ordinary means (cloning a machine image, syncing a
home directory). So: document the seed as clone-local, provide an explicit rotation
command, and rotate automatically whenever it is absent.

Honest cost: shard count becomes generations × scopes rather than principals ×
scopes. Bounded by machines and by rare profile changes, so it stays far from the
file-count problem that motivated bundling — but it should be stated, not buried.

## 5. Receipts

Every durable code-derived value carries a reference to how it was derived — and
only a reference.

```ts
interface DerivationRef { profile: ProfileId; language: Language }

interface AnchorReceipt { id: AnchorId;    derivation: DerivationRef }
interface HashReceipt   { value: string;   derivation: DerivationRef }
```

`anchorScheme`, `hashScheme` and the grammar digest are **resolved from the
profile**, never copied alongside it. An earlier draft duplicated them, arguing
that an explicit field cannot be spoofed by absence the way an in-band scheme
prefix can. That reasoning does not transfer: the profile is content-addressed and
therefore authenticated, so a copy adds consistency states to validate without
improving the one case it was meant to help — an absent profile is `unverifiable`
either way. Materialized SQL rows may denormalize these fields **after**
validation; the event may not.

**Receipts reference the PROFILE, not the producing generation.** A hash outlives
the generation that minted it and passes through many that merely copy it.

**Every receipt is explicit at serialization time.** No "same profile as this
event" default in durable data — that default is exactly what lets a later copy
relabel a value, which is the defect in §2.

### `language` is what makes granularity work

Recording the language actually used is not bookkeeping; it is what lets one
profile serve a polyglot repo without over-invalidating:

- The producer profile carries the **full** grammar map.
- Each receipt records the language its value was derived for.
- Comparability checks the relevant scheme and **that language's** grammar digest.
- **Unequal profile ids never mean incompatible on their own.** Two profiles
  differing only in the Python grammar are fully comparable for a C# value.

That last rule is the one an implementation is most likely to get wrong, because
comparing profile ids is the cheap thing to reach for and it is wrong in the
direction that manufactures false staleness.

A Python grammar update rotates the generation even when the next event concerns
C#. That is shard churn, not invalidation, and it is cheap: vendored grammars
change rarely. Paying it is better than separating writer identity from producer
profile again, which is what the single-envelope-field design bought.

### `unverifiable` is not one state

One boolean cannot carry a recovery action, and a value that cannot be compared
has several distinct reasons that call for different ones. **The authoritative
list is the table in §6** — it is not repeated here, because an earlier draft did
repeat it and the copy went stale the moment the table changed.

Re-witnessing and relocation are **not** interchangeable. Provenance
incompatibility does not prove the code moved — an anchor receipt carries no
locator evidence — so offering "relocate" for a scheme mismatch invites exactly the
false re-targeting that `witness`/`sourceRef` exist to prevent.

This is also why the existing `unverifiable` status must not simply absorb these.
It currently means "confirmed under an older hashing scheme", which is one of seven
reasons and the only one a `confirm` button repairs.

### Comparability

- `comparableHashes` requires matching `hashScheme` **and** matching grammar
  identity for the value's own language, both read from the profile.
- Do not attempt an anchor join when the profile's `anchorScheme` is incompatible
  with the reader's. Report `unverifiable` / incompatible derivation — never
  `lost`, which claims the code is gone.
- A missing or malformed referenced profile **fails closed** into
  quarantine/unverifiable. It must never default to the current client's profile.
- Changing the receipt or hash encoding bumps `HASH_SCHEME`.

### What the hash string still carries, and why it is not the mechanism

`hashTokens` stamps `h<scheme>:sha256:…` and `hashSchemeOf` reads it back, which is
how comparability works today with no side table. That stays — it is a useful
self-description and the migration path for values written before receipts exist.
But once receipts land it is a *hint*, and the profile is the authority. Where both
are present and disagree, that is a corrupt record, not a choice between answers.

Anchor ids, by contrast, have never carried anything: `anchorId` is `"a_" +
sha256(file \0 symbolPath \0 disambiguator).slice(0,16)`, with no marker at all.
Nothing distinguishes a scheme-1 id from a scheme-2 one by inspection, which is why
they cannot be handled the way hashes were and why the receipt is the only answer
for them.

## 6. Materialization, and migration

**The live side of the comparison has provenance too.** A receipt is compared
against `@work` anchor rows, and those rows carry no profile and no language today
— so they may themselves have been minted under an older grammar or runtime, and
comparing against them recreates the relabeling defect on the reader's side. So:

- a derivation reference on each anchor ROW (see below — per-ref was tried and
  withdrawn);
- the actual language on each anchor row;
- an anchor receipt on every shared target;
- **one row per accepted hash**, with its own receipt — a single citation can hold
  hashes minted under several profiles, so a JSON list cannot carry them.

**Evaluation order is part of the contract**, not an implementation detail:

```
validate derivation → establish comparability → resolve anchor → classify absence/drift
```

A join that goes straight from citation to anchor row cannot tell a missing symbol
from an unreadable derivation, and defaults to `lost` — claiming code is gone when
the truth is that nobody can compare it. `ABSENT_HASH` is universally comparable
only *after* anchor derivation compatibility is established; before that, "there is
no code here" is not yet a statement anyone is entitled to make.

**Scope completeness is data, not an assumption.** `shared_scope` records
seen/folded/quarantined counts with typed reasons, because otherwise "no findings"
and "the finding event was skipped" are the same answer. An event whose
`eventSchema` is unsupported is preserved and quarantined — never best-effort
folded as authoritative — the scope is marked partial, and state-dependent writes
are refused until the client understands it. Guessing at a payload you cannot
decode is how a client corrupts everyone's state while reporting success.

**Two kinds of missing profile, two kinds of repair.** A missing *receipt* profile
only blocks comparability, so a read-time registry join repairs every affected row
the moment it arrives — no re-fold. A missing *generation* profile means the
payload could not be decoded at all, so when it arrives the scope must be
**re-folded**. Treating them alike either wastes a rebuild or leaves undecodable
events silently absent.

**Receipt columns from the beginning.** `shared_doc_citation`, finding targets and
note targets need profile/receipt columns in their first schema, so read-time SQL
can refuse an incompatible join before making it. Adding them later means a second
migration and, until then, keeping the `lost`-instead-of-`unverifiable` P1 alive on
purpose.

### The live side: provenance per ANCHOR, not per ref

An earlier draft of this section proposed `anchor_ref(ref, profile, indexed_at)` —
one profile per ref, covering `@work`, `@orphan` and each snapshot. **Withdrawn.**
It is unsound, and it is unsound for the reason §1 already states, which I failed
to apply one layer down:

> Derivation provenance must travel explicitly with every durable code-derived
> value.

An anchor id and a body hash **are** durable code-derived values. A ref is not a
derivation; it is a bag of rows that were derived at different times. Two places in
the current code make that concrete:

- **Incremental update mixes profiles inside one ref.** `sync.ts` refreshes an
  existing anchor's location but deliberately **preserves its `bodyHash`** as the
  baseline, while newly discovered anchors are indexed fresh. So after a profile
  change, `@work` legitimately holds rows derived under two profiles. Stamping the
  ref with the new profile relabels the old rows; keeping the old one relabels the
  new rows. There is no correct single value.
- **`@orphan` is additive and never overwritten** (`store.ts`, `INSERT OR IGNORE`),
  and its own comment says why: the FIRST eviction holds the last state the anchor
  was really seen in, and a later reindex must not replace it with something
  re-derived. Its rows are frozen at different moments by design, so one profile
  for the ref is definitionally wrong.

So:

```sql
ALTER TABLE anchors ADD COLUMN profile  TEXT;   -- NULL = derived before receipts
ALTER TABLE anchors ADD COLUMN language TEXT    -- GrammarName selector; see below
  CHECK ((profile IS NULL) = (language IS NULL));
```

**The order is load-bearing**, and an earlier draft of this block was simply
invalid SQL — it trailed a bare table-level `CHECK` after two `ALTER TABLE`s,
attached to nothing. Checked against `node:sqlite` rather than assumed:

- a bare table-level `CHECK` is a syntax error;
- SQLite has **no `ALTER TABLE ... ADD CONSTRAINT`** at all, so a table-level check
  cannot be added to an existing table without rebuilding it;
- a **column-level** `CHECK` on `ADD COLUMN` is accepted, and SQLite permits it to
  reference another column — so the constraint has to ride on the SECOND column
  added, because it cannot be written until the first exists.

It refuses both half-populated forms and admits both-NULL and both-set. Existing
rows are **not** re-validated by `ALTER TABLE`, which is the behaviour this wants:
legacy rows are both-NULL and pass regardless.

Per-row costs a repeated short id on ~10k rows and buys correctness in both cases
above. Read cost is not the objection: the hot lookup still goes through the
existing `(ref, id)` primary key, and resolving a profile is an indexed hit on a
registry with a handful of rows.

**The real cost is the seam, and it is larger than two columns.** `Anchor` is the
currency between the indexer, `sync.ts`, the store and orphan retention, and it has
no provenance fields. `rowToAnchor` builds an `Anchor` from a fixed column list;
`replaceAnchors` does `DELETE FROM anchors WHERE ref = ?` and re-inserts every row
from `Anchor[]`; and the incremental updater round-trips *all* anchors — old and
new — through exactly that path. So adding columns alone would have them **erased
on the first incremental update**, which is the opposite of what per-row provenance
is for.

So this requires `Anchor.derivation?: DerivationRef` threaded through the seam —
indexer, sync, store, `retainOrphans`, and every site that constructs an `Anchor` —
or write paths that update anchors in place instead of replacing them. The first is
honest and the second fights the existing design. Either way it is a change to the
`store.ts` seam's currency, not an `ALTER TABLE`.

**Half a receipt is not a receipt.** `profile IS NULL, language IS NOT NULL` and
its converse have no meaning, and the `CHECK` above makes them unrepresentable
going forward. A reader must still classify either half-populated form as
`corrupt_receipt` rather than guessing which half to believe — because `ALTER
TABLE` does not re-validate what is already there, so a store where the migration
ran partially, or ran before this constraint existed, can hold rows the constraint
would now refuse.

`anchor_ref` disappears as a provenance mechanism.

`snapshots` keeps its `scheme`/`hash_scheme` columns as the cheap "is this whole
cache stale" check it already is — that is a different question from "what derived
this row" and it is answered correctly by a ref-level value, because
`writeSnapshot` replaces a snapshot wholesale.

**`GrammarName` is a selector, not the identity.** An earlier line here said it
*is* the identity, which contradicts §3 two hundred lines earlier: identity is the
full blob digest, and renaming `tsx` while shipping identical bytes would change no
derivation. What the anchor row stores is the key used to look the digest up in the
profile. `typescript` and `tsx` still stay distinct — they map to separate blobs
with different digests — but that is a fact about the blobs, not about the names.

### Migration: never stamp, reindex, and be honest about legacy

Existing rows **cannot** be truthfully backfilled. A profile needs `parserRuntime`
and full grammar digests; what a store actually has is `State.grammarVersions`
(friendly version strings) and, on snapshots, two integers. Nothing there
reconstructs a profile, so:

- **Never stamp existing rows with the current profile.** That is the §2 defect
  performed deliberately.
- **Reindex `@work`** to populate it — a genuine full reindex, gated on a store
  migration marker. **Not `check`.** `check` calls `applyIndexUpdate`, whose
  contract explicitly never rehashes an existing anchor; `init` is the full reset.
  An earlier draft claimed connect already did this, which would have left every
  existing row NULL forever while reporting success.
- **Rebuild cached snapshots** — but nothing currently drives that either.
  `staleSchemeSnapshots` compares only the two numeric schemes, and `readSnapshot`
  accepts a snapshot on the same basis, so a pre-migration snapshot with current
  schemes and NULL per-row provenance reads as usable indefinitely. It needs a
  snapshot-level provenance marker, or `readSnapshot` rejecting refs whose rows are
  NULL. **Do not bump a derivation scheme to force it** — that is the borrowed
  signal §7 rejects, and it would rebuild caches in universes that have no sidecar.
- **Leave orphans legacy forever.** Their source may not exist any more, so their
  provenance is genuinely unknown and must read that way.

A NULL `profile` on an anchor is `legacy_live_derivation`, **not**
`legacy_no_receipt`. They look alike and their repairs differ: a legacy stored
receipt needs re-witnessing, while a legacy live index needs the reader to reindex
their own code. One label that maps to two actions is precisely the failure typed
states were introduced to fix, so the reader must also carry which operand was
missing, not only that something was.

The earlier draft called this `missing_profile`, which was doubly wrong: under
`anchor_ref` with `NOT NULL` an old store would have had **no row at all**, and the
state is a legacy one rather than the waiting-on-a-pull one.

### Three levels, not two

An earlier draft split this in two — scope status for absence, value states for
comparability — and that split leaks. A quarantined `finding.revised` leaves the
finding **present and materially wrong**: `finding.created` produced the entity,
and the revision that would have corrected its text or severity never applied. The
scope is not merely missing something; a specific entity is stale in a way nothing
on it says.

So there is a middle level:

```
scope    complete | partial | blocked        why an ANSWER SET may be short
entity   complete | incomplete(reasons)      why THIS record may be wrong
value    eight states (below)                why THIS field cannot be compared
```

```sql
CREATE TABLE IF NOT EXISTS shared_scope (
  scope TEXT PRIMARY KEY,
  protocol INTEGER NOT NULL,
  key TEXT NOT NULL,               -- the cache key: materialization proposal §3
  folded_at TEXT NOT NULL,
  status TEXT NOT NULL,            -- 'complete' | 'partial' | 'blocked'
  seen INTEGER NOT NULL, folded INTEGER NOT NULL, quarantined INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS shared_quarantine (
  scope TEXT NOT NULL, event_id TEXT NOT NULL,
  subject TEXT,                    -- the entity it would have touched, when known
  reason TEXT NOT NULL, detail TEXT, at TEXT,
  PRIMARY KEY (scope, event_id)
);

-- Entity status is read by subject and only by subject; the primary key cannot
-- serve it, so without this every such read scans the scope's quarantines.
CREATE INDEX IF NOT EXISTS ix_shared_quarantine_subject
  ON shared_quarantine(scope, subject) WHERE subject IS NOT NULL;
```

**`subject` must be a protocol invariant, not a hope.** It is knowable today
because it sits in the stable envelope rather than in `data`, and the entity level
depends on that staying true: `sidecarProtocol` governs an envelope containing
`id`, `subject`, generation and causal fields, and `eventSchema` governs **only**
the payload. Without that split, a future schema could move `subject` and every
unsupported-schema event would force scope-wide uncertainty instead of naming what
it touched.

`subject` is what makes the middle level derivable rather than a fourth thing to
maintain: an entity is `incomplete` exactly when a quarantined event names it.

**Except that not every discard has a subject, or an id.** Found while writing
this, not in review. `readShard` drops on three different paths and only the last
can be recorded as written:

| discard | has id? | has subject? | recordable |
|---|---|---|---|
| `JSON.parse` throws — torn or stitched line | no | no | **not at all** — it never became an event |
| `wellFormed` fails — parsed, bad envelope | maybe | maybe | partially |
| fold rejects it — unsupported schema, ratchet | yes | yes | fully |

Two consequences. `shared_quarantine` is keyed `(scope, event_id)`, so a torn line
has no key to file under; and both of the first two paths happen inside
`readShard`, which returns only survivors, so the fold cannot count what it never
saw. `seen` has to be counted at the READ layer and `readShard` has to report its
discards — a signature change to a function every scope read goes through.

That does not sink the model, but it does mean `seen - folded - quarantined` is a
real quantity ("lines nobody can attribute") that the schema must name rather than
leave as arithmetic. An unattributable line is still a reason a scope is `partial`.

**`partial` no longer claims the remainder is sound** — that was the false part.
It claims the remainder is *everything that could be applied*, and the entities a
quarantined event named are individually marked. `corrupt_receipt` sits at both
levels for the same reason and that is not a contradiction: the value cannot be
compared, and the record carrying it is one a person should look at.

### `blocked` is two different situations

Grouping forks with unsupported protocols was wrong, because they differ on the
one question the status has to answer — is there anything to show?

| | can the reader decode it? | what to render |
|---|---|---|
| unsupported protocol | **no** | nothing projected, plus the upgrade reason |
| detected writer fork | yes | the rows, read-only and unmistakably non-authoritative |

There is no single rendering rule, and asking for one is what made the earlier
draft's open question look hard. It is not: **the answer depends on the reason,
and the reason is already recorded.** An unsupported protocol has no answers to
hide; a fork has answers whose authority is void, and hiding those hides work
people did.

This also settles the §7 contradiction: a fork's scopes are `blocked`, not
`partial`. `partial` means some events did not apply; a fork means the ones that
did cannot be trusted to be in the right order.

### The value states

| state | what happened | recovery |
|---|---|---|
| `legacy_no_receipt` | a stored receipt predates receipts existing | re-witness at a current profile |
| `legacy_live_derivation` | the reader's own `@work`/snapshot rows have no provenance | **reindex** — the gap is on this machine, not in the record |
| `missing_profile` | the profile it names is not here **yet** | none while the registry is incomplete — see below |
| `dangling_profile` | the registry is complete and the profile is still absent | a person: the writer published a reference to something that does not exist |
| `incompatible_anchor_scheme` | ids derived differently | re-witness; **never** relocate |
| `incompatible_hash_scheme` | hashes derived differently | re-witness |
| `grammar_mismatch` | same schemes, different grammar for this language | re-witness |
| `corrupt_receipt` | malformed, or disagreeing with its own hash string | quarantine the record; a person looks |

`unsupported_event_schema` is not here: a quarantined event's values never enter
the projection, so no value is unverifiable on its account. It appears as scope
status and as an `incomplete` entity.

**`missing_profile` splits.** The earlier draft promised it repairs itself on the
next pull and needs no action. That holds only while the profile registry is known
incomplete. Once a pull has completed and the referenced object is still absent,
this is a dangling reference — an integrity failure someone has to act on — and
calling it self-healing would leave it invisible forever. The registry's own
completeness is what distinguishes them, which is another reason it needs its own
materialized state rather than living inside a scope's cache.

Where a recovery is a person's action at all, it is **re-witness or reindex, never
relocate.** `missing_profile` needs nothing, `dangling_profile` and
`corrupt_receipt` need somebody to look, and the rest are "establish this fact at a
profile I can read". None is evidence the code moved — an anchor receipt carries no
locator — so offering relocation for a derivation mismatch invites exactly the
false re-targeting `witness`/`sourceRef` exist to prevent.

**Publication preserves receipts unchanged**, alongside the source version id and
`createdAt`. Structural deduplication needs the id; *semantic* deduplication —
knowing two copies are the same claim — needs the receipts to survive the trip.

**Profiles and generations need their own materialized registry**, complete and
independent of any scope's cache. Otherwise a scope folded while a profile was
missing stays valid after the profile arrives, and its values stay `unverifiable`
forever for no reason — the cache concealing a resolvable state. Event rows store
the profile REFERENCE and join the registry at read time, so a late-arriving
profile fixes every row that referenced it without re-folding anything.

**Refusing a pull is correct today and becomes wrong here.**
`PROPOSAL-shared-review-state.md` says a pull under different schemes must be
"refused, not merged", and `sidecar.ts:246` implements that: an `ANCHOR_SCHEME`
mismatch is fatal and the pull errors out.

That is right *without* receipts, because without them a reader genuinely cannot
tell which of a teammate's values it can interpret — so the choice is refuse
everything or mis-target silently, and refusing is the safe one. With receipts the
third option exists: accept the events, interpret what is compatible, and mark the
rest with a typed reason. Refusal then becomes strictly harmful, because it blocks
the compatible majority to protect against the interpretable minority.

So this supersedes that decision, and the cutover is not optional ordering: the
refusal must stay until receipts land, and must be removed when they do. Leaving it
in place afterwards means an upgraded team still cannot sync; removing it early
means silent mis-targeting.

**Migration must degrade, not block.** History is append-only, so incompatible old
events are there forever and no sync may refuse on their account. Sync accepts
them; operations that require interpreting code gate or degrade explicitly. Two
precedents already exist and should be reused rather than reinvented: anchors that
leave the tree are retained under `@orphan` and reported by `codemap orphans`, and
findings already carry relocation events that re-point a citation as a person's
act. A current-profile re-witness or relocation is the path forward; the
incompatible original stays readable and explicitly unverifiable.

## 7. Sequencing

Corrected from the materialization proposal's order, which finalized the schema
before receipts existed:

1. **Extract the pure folds** into a storage-free module. Independent of
   everything here; unblocks `store.ts` without a dependency cycle.
2. **Design profiles, generations and receipts** — this document. Including the
   **protocol cutover** (below), which is the part that cannot be retrofitted and
   therefore the part to settle first.
3. **Generation-based sharding and causality, plus the sidecar-root lock.** The
   lock is part of this step, not a follow-up, because prefix closure depends on it.
4. **Materialization tables, with receipt ownership built in.**
5. **SQL joins and outbox semantics.**

Steps 1 and the basic cache mechanics can proceed in parallel with 2. Nothing
downstream of 3 should be finalized before 2 is settled.

### The cutover — settled

Three candidate mechanisms, and what today's reader actually does with each. Run
against `dist/`, not reasoned about:

| mechanism | today's reader | failure mode |
|---|---|---|
| additive `generation` field, same `.ndjson` | reads both events, folds both findings, keeps the unknown fields and ignores them | **wrong, silently** |
| new shard extension (`.ndjson2`) | reads only the legacy shard | **incomplete, silently** |
| peer manifest with an `anchorScheme` it rejects | `pull` errors and merges nothing (`sidecar.ts:246`) | loud, but false |

**The third is rejected.** `ANCHOR_SCHEME` has a precise invariant — anchor-id
derivation changed — and a synthetic bump does not stay inside the sidecar.
`staleSchemeSnapshots` (`store.ts:155`) selects every snapshot whose `scheme`
differs from the constant, so a lie told to make old sidecar clients fail loudly
would drop and rebuild the branch-diff cache in **every universe, including ones
that have never had a sidecar**. It would also relabel receipts, diagnostics and
future migrations. Lying through a field with an invariant does not create a
compatibility signal; it moves the failure somewhere the reader cannot trace it.

A notice event is rejected too, for a smaller reason: protocol compatibility is not
a domain fact, and it does not belong in anyone's finding list.

**What settles it: there is nothing deployed to be compatible with.** `main` at
`2519800` contains no `sidecar.ts`, no `eventlog.ts` and no `shared-*.ts` — the
entire feature is on this unmerged branch. So the rolling-upgrade problem this
section was trying to solve does not exist, and version checking simply ships as
part of the first generation-aware format:

- The manifest carries **`sidecarProtocol`**, and clients enforce it.
- A client that does not understand a scope's protocol refuses it, by name, and
  says what to upgrade.

If a rolling upgrade from a deployed client ever does have to be supported, the
answer is a two-phase rollout — one release that understands and enforces
`sidecarProtocol` while still writing v1, then a later one that begins writing v2
— or a separate v2 sidecar root with a coordinated cutover. An ignorant client
cannot be retrofitted into failing loudly through a contract it does not read.

### Where the boundary sits

**Per scope for the data.** The scope is the unit of folding, materialization and
completeness, and mixing v1 and v2 shards inside one scope is the worst case: an
old client returns a plausible, partial answer. Migrated scopes must read as
absent, never as partially current.

Migration is atomic under the sidecar lock:

1. mark the scope v2;
2. move the legacy shards into the v2 namespace **unchanged**;
3. keep reading those events as legacy — no generation, per §4's rules;
4. write everything new as generation shards;
5. treat a v1 shard reappearing afterwards as a protocol violation needing
   attention, not as data to merge.

Step 2 matters for this repository specifically: the branch has real sidecar state
from being used, so "nothing deployed" does not mean "nothing to migrate".

**Sidecar-wide for the operation.** Per-scope migration leaves a window in which an
old writer recreates a v1 shard in a scope already moved. If coexistence with old
writers is ever real, a sidecar-wide protocol epoch is the safer operational unit.
Per-scope is the correct data boundary; sidecar-wide is the cleaner rollout one.

### Forks: three layers, not one

I had asked whether `writerPrev` subsumes the sidecar lock. It does not — they
address different failures, and a third mechanism is needed to contain what they
find:

```
sidecar lock  -> PREVENTS local forks (two processes, one clone)
writerPrev    -> DETECTS distributed forks (two clones, one copied seed)
scope status  -> STOPS a detected fork producing authoritative answers
```

The lock is doing more than serializing a file write. It must be held across
**selecting the generation, reading the causal heads and `writerPrev`, and
appending** — not merely around the final write — because the race is between
reading what came before and committing to it. Two processes that both read the
same predecessor have already forked by the time either appends.

And a detected fork is **not** an ordinary contest, which is where my framing was
wrong. A contest is per-field residue on one entity; a fork invalidates the
vector's single-writer compression for that whole generation, and the two sides
may touch entirely different entities. So containment is scope-level: mark the
affected scopes **blocked** — not `partial`, which means "some events did not
apply"; a fork means the ones that did cannot be trusted to be in the right order —
block state-dependent writes, and force generation rotation or explicit recovery. Entity-level contests can still be derived where
they apply, but they are a symptom, not the containment.

## 8. Open

- ~~Digest strictness.~~ **Done in `f723e78`** — canonical form required, and
  `fixtureHash` derives real digests from readable labels. My deferral was the
  wrong trade; the helper made the premise false as well.
- ~~Profile granularity per language.~~ **Resolved in §5** by putting the full
  grammar map in the profile and the language in the receipt, so comparability
  checks only the relevant language. No per-language profiles.
- ~~Seed durability.~~ **Resolved in §4.**
- ~~Legacy attribution.~~ **Resolved in §4** for causality and attribution. What
  remains is narrower and genuinely a product call: how a reader is *shown* a
  legacy value that is `unverifiable` for provenance reasons rather than because
  the code moved. Both are "cannot be decided", and conflating them would repeat
  the mistake the `unverifiable` status was introduced to fix.
- ~~Event-schema evolution.~~ **Resolved in §6**: preserved, quarantined, scope
  marked partial, state-dependent writes refused.
- ~~The wire mechanism for the cutover.~~ **Resolved in §7** — `sidecarProtocol`
  in the manifest, enforced from the first generation-aware release, because
  nothing is deployed to be compatible with.
- ~~Live-index provenance, and the partial/unverifiable contract.~~ **Resolved in
  §6**, and both of the questions left open under it turned out to be artefacts of
  a wrong design rather than genuine choices: backfilling dissolves once provenance
  is per-row (never stamp, reindex, leave legacy NULL), and hide-or-show dissolves
  once `blocked` is split by reason (an unsupported protocol has nothing to show; a
  fork has answers whose authority is void).
- **Where the refusal is removed.** The `fatal` manifest check in `sidecar.ts` has
  to be deleted in the same change that lands receipts, not before and not after.
  Neither document currently owns that edit.
- **Notes have no contest detection.** Independent of this design and worth its own
  fix; recorded in §4 because that is where it was found.

---

## 9. Recommended cut — READ BEFORE IMPLEMENTING

Round 9 asked whether this had outgrown its value, and the answer was yes as **one
coupled design**: it bundles a provenance core with two other correctness systems
and one availability optimization.

```
1. derivation compatibility   profiles, receipts, live-anchor provenance   KEEP
2. multi-writer causality     writer identity, sharding, lock, writerPrev  KEEP
3. projection completeness    protocol boundary, read diagnostics          KEEP (trimmed)
4. partial-scope salvage      three levels, subject, quarantine index      CUT for v1
```

Two things come out, and the rest of this document should be restructured around
their absence before anyone builds it.

**Inline the derivation tag; drop the content-addressed profile.** Every durable
value carries `{anchorScheme, hashScheme, parserIntegrity, grammarDigest}`
directly, rather than a reference into a registry. That deletes the registry, its
publication ordering, `missing_profile`, `dangling_profile`, `language` as an
indirection key, and the "who owns the local registry" problem entirely — those
states exist *only because* of the indirection. It costs perhaps 100–200 bytes per
receipt, which is the right trade at this scale, and SQLite may normalise identical
tags after validating them so long as the durable event stays self-contained.

**Decouple writer identity from derivation.** A clone-local random `writerId` in
the envelope, sharded `(scope, writerId)`. `GenerationRecord` goes. This also fixes
a coupling I introduced: with generation = (seed, profile), re-vendoring the Python
grammar rotated the shard of somebody writing only C#. Once every value
self-describes, a producer profile has no job.

**Fail the scope closed for v1.** Unsupported protocol, unsupported schema, torn
line, malformed envelope → `blocked`, render nothing. Fork → blocked, optionally
rows marked non-authoritative. Known domain rejection → understood no-op, scope
stays complete. Value mismatch → render the entity, mark that value.

That removes the entity level, `shared_quarantine.subject` and its index, the
partial answer-set semantics, and most discard accounting. What it gives up is
availability: one bad event hides a scope until repaired. The trade is smaller than
it looks, because `partial` already refused state-dependent writes — and it never
silently lies, which is the guarantee that actually matters. Add salvage later if
evidence says hiding a usable scope is worse than the machinery.

**Not negotiable, per the same round:** per-value derivation provenance, exact
grammar and runtime identity, provenance on the live operand, the
validate→compare→resolve→classify order, the protocol boundary, clone-local writer
identity, the sidecar lock, and `writerPrev`. Cutting the last three accepts
fabricated causality and silent last-write errors.

## 10. What each round changed

Recorded because the design's shape came from being wrong in public four times,
and the corrections are more instructive than the result.

1. **Insertion-only ordering was false.** A late-arriving *parent* reorders events
   already folded; my property test could not generate that shape because it drew
   parents only from events already present. Replaced with the counterexample plus
   a determinism property that includes forward references.
2. **`ANCHOR_SCHEME` in the materializer cache key was unnecessary**, not merely
   insufficient. Re-folding reproduces the same ids, so nothing changes. One
   criterion covers both scheme numbers: a scheme belongs in the key iff the
   projection stores something *derived* from the anchors table.
3. **An event's profile is not its values' provenance.** The correction that
   produced this document: a backfill republishes values minted years earlier, so
   the envelope cannot speak for them.
4. **Receipts should not copy what the profile authenticates**, and digest
   strictness should not have been deferred. Both were me choosing the locally
   comfortable answer — extra fields "just in case", and readable fixtures over a
   correct parser — where the better one cost nothing once looked at properly.

5. **Round 5** (three-angle pass) — the envelope is not a protocol boundary; a
   copied seed needs *detection* (`writerPrev`), not documentation; the live index
   has provenance too, and comparing against rows that carry none recreates the
   defect on the reader's side; `unverifiable` is seven states, not one; and the
   documents had begun to contradict each other, which is its own hazard.

6. **Round 6** — `ANCHOR_SCHEME` must not be borrowed as a compatibility signal:
   its invariant reaches `staleSchemeSnapshots`, so the lie would rebuild the
   branch-diff cache in universes that have never had a sidecar. And the question
   dissolved once someone checked whether there were any deployed clients — there
   are none, the feature is entirely unmerged, so version checking ships as part
   of the first format rather than being retrofitted into one. My "a detected fork
   is just a contest" framing was also wrong: a fork invalidates a generation's
   single-writer compression across every entity it touched, so containment is
   scope-level and a contest is a symptom of it.

7. **Round 7** — the first round conducted machine-to-machine rather than through a
   human courier, and it caught me making the same mistake §1 exists to prevent.
   Provenance was proposed per REF, when a ref is a bag of rows derived at
   different moments: `sync.ts` preserves an existing anchor's hash while indexing
   new ones fresh, and `@orphan` is `INSERT OR IGNORE` by design. Per-row was
   always the answer, and §1 already said so. Two open questions dissolved with the
   wrong design rather than being answered, and `blocked` turned out to be two
   situations wearing one name.

8. **Round 8** — the first follow-up on a live thread, and it found the revision
   worse than the thing it replaced in one respect: per-row provenance is right as
   a data model and **physically impossible on the current seam**, because `Anchor`
   carries no provenance and `replaceAnchors` reconstructs every row from it. Two
   columns would be erased by the first incremental update. Also caught me leaving
   the withdrawn design in force above the archive boundary — the exact hazard I
   had filed against this document two rounds earlier and then committed myself.

9. **Round 9** — asked whether the design had outgrown its value, which is the one
   question its author cannot answer. It had, as one coupled design: see §9. The
   two cuts both dissolve states rather than hiding them — inlining the derivation
   tag deletes `missing_profile` and `dangling_profile` outright, because those
   exist only to describe a registry that would no longer exist. It also caught a
   coupling I had introduced without noticing: generation = (seed, profile) meant
   re-vendoring the Python grammar rotated the shard of somebody writing only C#.
