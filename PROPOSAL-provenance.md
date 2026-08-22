# Proposal: immutable provenance — profiles, generations, and receipts

Status: **draft.** Split out of `PROPOSAL-sidecar-materialization.md`, where it had
grown from an open question into the larger of the two designs. Four review rounds
are folded in; §9 records what each round changed.

Reviewed against `worktree-shared-review-hashscheme` at `f723e78`.

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
interface CompatibilityProfile {
  eventSchema: number;
  anchorScheme: number;
  hashScheme: number;
  /** Language -> full SHA-256 of the vendored grammar blob. */
  grammars: Record<Language, string>;
}
```

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
2. **Design profiles, generations and receipts** — this document.
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
- **Event-schema evolution.** `eventSchema` sits in the profile but nothing yet
  says what a reader does with an event whose schema is *newer* than its own —
  quarantine, best-effort fold, or refuse the shard. It is the one profile field
  whose mismatch is not about interpreting code.

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
