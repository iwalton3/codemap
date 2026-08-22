# Proposal: immutable provenance — profiles, generations, and receipts

Status: **draft.** Split out of `PROPOSAL-sidecar-materialization.md`, where it had
grown from an open question into the larger of the two designs. Four review rounds
are folded in; §7 records what each round changed.

Reviewed against `worktree-shared-review-hashscheme` at `6d4c40d`.

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

**Legacy events without a generation** must not be collapsed into one synthetic
writer per principal: that recreates the false edge this exists to remove. Treat an
explicit `after` as authoritative and otherwise degrade conservatively, accepting
extra contests rather than inventing causality. An unnecessary contest asks a
person a question; an invented causal edge answers one for them.

Honest cost: shard count becomes generations × scopes rather than principals ×
scopes. Bounded by machines and by rare profile changes, so it stays far from the
file-count problem that motivated bundling — but it should be stated, not buried.

## 5. Receipts

Every durable code-derived value carries how it was derived.

```ts
interface AnchorReceipt { id: string;    profile: string; anchorScheme: number; grammar: string }
interface HashReceipt   { value: string; profile: string; hashScheme: number;   grammar: string }
```

**Receipts reference the PROFILE, not the producing generation.** A hash outlives
the generation that minted it and passes through many that merely copy it.

**Every receipt is explicit at serialization time.** No "same profile as this
event" default in durable data — that default is precisely what lets a later copy
relabel a value, which is the defect in §2.

### Why both fields, when the string already says

Worth knowing, because the two are not symmetric and it looks like redundancy.

*Hashes self-describe their scheme.* `hashTokens` stamps `h<scheme>:sha256:…` and
`hashSchemeOf` reads it back — the entire reason `comparableHashes` works across a
bump with no side table.

*Anchor ids do not.* `anchorId` is `"a_" + sha256(file \0 symbolPath \0
disambiguator).slice(0,16)`. No marker; nothing distinguishes a scheme-1 id from a
scheme-2 one by inspection. `anchorScheme` on the receipt is load-bearing.

*And `hashScheme` stays anyway*, because scheme 1 is encoded as the ABSENCE of a
prefix — so in-band encoding could not distinguish "scheme 1" from "not a hash",
and defaulted to 1. That fail-open was live and is fixed in `6d4c40d`; an explicit
field cannot be spoofed by absence, which is the property that matters.

**Where both exist, cross-validate them.** Duplicated metadata that nobody checks
is a new fail-open: if a hash string says `h2:` and its receipt says `hashScheme:
1`, that is a corrupt record, not a choice between two answers.

Neither an id nor a hash string encodes its grammar, so `grammar` is needed on
both regardless.

### Comparability

- `comparableHashes` requires matching `hashScheme` **and** matching grammar
  identity for the relevant language.
- Do not attempt an anchor join when the receipt's `anchorScheme` is incompatible
  with the reader's. Report `unverifiable` / incompatible derivation — never
  `lost`, which claims the code is gone.
- A missing or malformed referenced profile **fails closed** into
  quarantine/unverifiable. It must never default to the current client's profile.
- Changing the receipt or hash encoding bumps `HASH_SCHEME`.

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

- **Legacy attribution.** §4 says degrade conservatively; what a reader is *shown*
  for an event with no generation still needs designing. "Unknown writer" is
  honest; whether it suppresses contests, or raises them liberally, is a product
  call with real ergonomic cost either way.
- **Digest strictness.** `hashSchemeOf` currently validates the form but not the
  digest's length or charset, because ~100 readable fixtures across 22 files use
  short synthetic digests. That check should land with receipts, together with a
  fixture helper that keeps tags legible while carrying real digests.
- **Profile granularity per language.** `grammars` is a map, but a C# repo does not
  care that the Python grammar changed. Comparability should require matching
  grammar identity *for the relevant language* — which means a profile change in
  one language should not invalidate another's values. Not yet designed.
- **Seed durability.** The clone seed is local and uncommitted by design. What
  happens when it is lost — a wiped `.codemap`, a restored backup — needs an
  answer: a new generation is correct and cheap, but the old one's events must
  remain attributable.
