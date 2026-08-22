# Proposal: immutable provenance — profiles, generations, and receipts

Status: **draft.** Split out of `PROPOSAL-sidecar-materialization.md`, where it had
grown from an open question into the larger of the two designs. Five review rounds
are folded in; §9 records what each round changed.

Reviewed against `worktree-shared-review-hashscheme` at `071a43d`.

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

One boolean cannot carry a recovery action, and these need different ones:

```
legacy_no_receipt          incompatible_hash_scheme     unsupported_event_schema
missing_profile            grammar_mismatch             corrupt_receipt
incompatible_anchor_scheme
```

Re-witnessing and relocation are **not** interchangeable. Provenance
incompatibility does not prove the code moved — an anchor receipt carries no
locator evidence — so offering "relocate" for a scheme mismatch invites exactly the
false re-targeting that `witness`/`sourceRef` exist to prevent. `missing_profile`
resolves itself when the profile arrives and needs no user action at all.

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

- one derivation profile per anchor REF, `@work` and every snapshot;
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

Those columns do not re-open the materializer cache key: they are copied verbatim
from events, like the anchor ids beside them, so nothing in the projection becomes
anchors-derived. The criterion in `PROPOSAL-sidecar-materialization.md` §3 holds,
and the receipts are what let the read-time join refuse work *without* invalidating
anything.

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
   **protocol cutover**: an additive `generation` field does not protect an older
   reader, because event parsing ignores unknown fields and a legacy client would
   fold new shards with principal-keyed causality regardless. It needs a versioned
   layout or namespace that old readers physically cannot mistake for their own —
   a new shard extension or a scope-level format marker. This is the part that
   cannot be retrofitted, so it is the part to settle first.
3. **Generation-based sharding and causality, plus the sidecar-root lock.** The
   lock is part of this step, not a follow-up, because prefix closure depends on it.
4. **Materialization tables, with receipt ownership built in.**
5. **SQL joins and outbox semantics.**

Steps 1 and the basic cache mechanics can proceed in parallel with 2. Nothing
downstream of 3 should be finalized before 2 is settled.

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
  marked partial, state-dependent writes refused. What remains open is the wire
  mechanism for the cutover itself (§7 step 2).
- **Where the refusal is removed.** The `fatal` manifest check in `sidecar.ts` has
  to be deleted in the same change that lands receipts, not before and not after.
  Neither document currently owns that edit.
- **Notes have no contest detection.** Independent of this design and worth its own
  fix; recorded in §4 because that is where it was found.

---

## 9. What each round changed

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
