# Decision: receipts, or a fingerprint in the hash string?

Status: **open.** Written to be decided, not to advocate. Blocks step 2 of
`PROPOSAL-provenance.md` §7.

## The exposure, stated once

After a grammar or parser change, both sides of a staleness comparison carry the
`h2:` prefix. `comparableHashes` answers *comparable*, the hashes differ, and every
review witness and doc citation in the store reads as drift. Verified at
`reviews.ts:460`; `doc-version.ts`, `acceptance.ts` and the bug witnesses share the
shape. That is the 985-of-985 event, store-wide, and nothing built so far touches
it — the diff work covers one consumer and not the important one.

Three durable shapes hold a body hash:

| shape | where | used by |
|---|---|---|
| `BugWitness { anchorId, bodyHash }` | local | bugs **and** reviews (one shape, both) |
| `NodeCitation.acceptedHashes: string[]` | local `node_versions` **and** sidecar doc events | doc resolution |
| `AcceptedEntry.bodyHash` | local | review acceptance |

## A — receipts (what §5 currently specifies)

Every stored hash gains a `DerivationTag` beside it.

```ts
interface HashReceipt { value: string; derivation: DerivationTag }
```

**Cost.** Three durable shapes change, two of them in two places (local schema and
sidecar event payload). `acceptedHashes: string[]` becomes a set of receipts, and
it is a *grow-only set per (version, anchor)* — so the merge rule changes too, not
just the type. Roughly 20 call sites touch `acceptedHashes` alone. Every producer
and consumer of all three shapes moves, and each needs a migration that must not
stamp existing values (§6's rule).

**What it buys that B does not.** Anchor **ids**. A teammate's finding targets
`a_X`, derived under their `ANCHOR_SCHEME`; an id is not a hash and no prefix
inside a hash can describe it. Only a receipt beside the id can.

## B — a fingerprint in the hash string

`hashTokens` emits `h2:<fp>:sha256:<digest>`, where `fp` is a short digest over
(`hashScheme`, `parserIntegrity`, `grammarDigest`).

**Cost.** No durable schema changes — every shape above still holds strings. The
sites that compare hashes must move behind a helper, because a legacy
`h2:sha256:ABC` and a new `h2:<fp>:sha256:ABC` describe the *same body* and are not
string-equal.

**The count in an earlier draft of this document was wrong, and wrong in a way
worth recording.** It said sixteen sites, from a grep written around `===` and
`.includes` — so it structurally could not see the eight that use `!==`, including
`stale.ts:81`, which is the core staleness path. The enumeration was as good as its
search pattern and was presented as if it were complete. There are about
twenty-four, eight of them still unexamined.

`hashTokens` also does not change "in one place": the fingerprint is
grammar-specific and `hashTokens` receives only tokens, so the tag has to reach it,
and `comparableHashes` has to start consuming the parsed annotation, which it does
not yet.

That refactor is worth doing on its own terms. Raw `===` on a hash string is
precisely what makes any format change hazardous, and this session has already
shipped two.

**What it buys that A does not, and cheaply.**

- **Local universes.** Most stores have no sidecar and never will. **Corrected:**
  an earlier draft said they could never be protected under A. That is false — A
  changes the three durable shapes, and two of them are local, so A can protect
  them; it is more expensive there, not impossible. The honest claim is cost, not
  capability, and "they are not alternatives" below is therefore overstated:
  A-for-both remains a real option.
- **The grow-only set does not move.** An earlier draft said "the sidecar for
  free, no event-format change", which is true per value and misleading per event:
  `doc.accepted` carries `{versionId, anchorId, bodyHash}` — one payload holding
  both an id and a hash — and the hybrid's `AnchorReceipt` changes that payload
  anyway. What B actually saves is narrower and still real: `acceptedHashes` stays
  `string[]`, so the grow-only merge rule and its ~20 call sites stay put.

**What it gives up.** `fp` is one-way. A reader can tell *different* but not *what
differed* — unless it has seen that tag before, which the local `derivations` table
already records. For a foreign fingerprint the honest message is "derived
differently, and I do not have theirs". Under the collapsed state table
(`incompatible_derivation` + detail) that is all a reader needs to act on, since
every branch of it recovers the same way.

**The fingerprint's preimage is itself an unversioned canonicalization**, which is
the founding hazard of this whole design pointed at its own solution. The
serialization of (`hashScheme`, `parserIntegrity`, `grammarDigest`) must be
canonical across every build forever, with no scheme number guarding it — and this
project has already redefined one of those inputs once. Round 10 caught
`parserIntegrity` hashing the CommonJS loader rather than the wasm that lexes, and
the fix changed its value. Had emission begun before that correction, every
annotated hash would have silently turned foreign: a relabeling flood caused by
*fixing a mistake*, indistinguishable from a real derivation change.

Receipts do not have this failure mode, because fields are stored rather than
digested and a definitional correction stays field-wise judgeable afterwards. So
three conditions on B: one function owns the preimage, with a committed test
vector; the length is exactly 16 hex (a range invites two spellings of one
derivation — the `h1:` trap, one capture group over); and a future preimage
correction is accepted as costing a bounded `unverifiable` flood, which at least
fails in the safe direction.

**The one-way-ness is fixable without resurrecting profiles.** Record fp → tag in
the existing local `derivations` table at mint time. Unlike the registry §9 cut,
this dictionary is diagnostic only — the comparability *decision* is answerable
from the fingerprint alone, so a missing entry degrades an error message and never
an answer. Worth stating, or somebody re-proposes profiles in a year to fix it.

**The load-bearing migration decision.** Adding `fp` must **not** bump
`HASH_SCHEME`. The digest is byte-identical — the token stream did not change, only
the annotation riding beside it — so by §3's own rule ("only a change to hash
derivation or its canonical encoding") this is an extension, not a new derivation.
Bump it and every hash in every store becomes incomparable at once: a store-wide
`unverifiable` event and a forced re-witness pass, for a change that altered
nothing about how anything was hashed. `hashSchemeOf` keeps returning 2; an fp-less
hash is legacy and falls back exactly as untagged values do everywhere else in this
design.

**But the claim is conditional, and the first draft presented it as freestanding.**
It is sound only *after* the comparison helpers are in. Emit without them and every
raw `===` site ships false drift, because two spellings of one body are not
string-equal; emit with a bump instead and the store goes universally unverifiable.
"Must not bump" and "helpers first" are one decision, not two, and somebody
cherry-picking emission without the refactor gets exactly the failure the no-bump
rule appears to license.

One documented invariant does break — not §3's, but `hashSchemeOf`'s own comment,
which declares "exactly one spelling per scheme". B deliberately creates a second
spelling of scheme 2 and moves that rule from the format into the helpers. Coherent,
but the comment must be rewritten in the same change or it becomes a confident wrong
comment sitting on top of the new behaviour.

## They are not actually alternatives

The comparison above assumes A and B answer the same question. They do not.

- **Hashes** — witnesses, accepted hashes, acceptance. B covers these, locally and
  in the sidecar, with no schema change.
- **Anchor ids** — a shared target pointing at an id derived under another scheme.
  B cannot touch this. A must.

So the shape is **B for hashes, A for ids only** — deleting `HashReceipt` from §5
and leaving `AnchorReceipt`.

**The reason it is forced, not chosen.** "An id is not a hash" is hand-waving, and
invites the obvious rebuttal: annotate the id too, `a3_<sha>`. What actually
forecloses that is **equality semantics you do not control.** A body hash is a leaf
value compared by about two dozen sites of code in this repository, so its spelling
may vary as long as comparison goes through a helper. An anchor id is an equality
KEY — a SQL primary key and join column, a Map key, a URL parameter, an MCP tool
argument. `WHERE anchor_id = ?` cannot call a helper. Annotating an id breaks joins
inside a database engine that will never learn our comparison family.

Which is §8's round-10 correction applied to transport rather than to minting:
provenance travels in the medium the value travels in. Hashes travel as strings, so
the tag goes in the string; ids travel as keys, so the tag goes beside them.

For hashes, A remains *capable* — only dearer. So the split is forced on the id
side and a cost argument on the hash side, and it is worth saying which is which:
"they solve different problems" is exactly the conclusion that lets somebody keep
both mechanisms and cut neither.

### The tax for keeping both, made concrete

One concept gets two encodings and a projection. The fingerprint digests three of
`DerivationTag`'s four fields; `comparableDerivation` compared all four, including
`anchorScheme` — so the struct path called a pair unverifiable where the fingerprint
path would call it comparable, **and the fingerprint was right**: identical
tokenization rules mean a differing digest is genuine drift. Reachable, too, since a
symbol with no disambiguator keeps its id across a scheme bump.

Fixed by making hash comparability the three-field projection and using it on both
paths. Recorded because it is the tax: two encodings of one concept must reduce to
ONE predicate, or the store's answer depends on which encoding happened to carry
the tag.

It also unblocks §8's "the other comparison sites are blocked on the sidecar work".
They were only ever blocked because provenance was made a parallel structure
instead of part of the value it describes. Under B they are not blocked at all, and
the local exposure — which is the larger one — closes without the sidecar shipping.

## What would change my mind

- If `fp` collisions matter. An 8-hex fingerprint is 4 billion; a collision means
  two different derivations read as one and a real drift is reported as clean.
  16 hex is free and removes the question — there is no reason to be clever here.
- ~~If a site turns out where digest-equality is genuinely wrong.~~ **Checked, and
  two turned up** — but they are not comparisons, which is the part I had wrong.
  Fourteen of the sixteen are genuine comparisons and digest-equality is right at
  every one. The other two are a *set insert* and a *map key*:

  - `shared-docs.ts:96` — `if (!acceptedHashes.includes(h)) push(h)`. Under
    digest-equality an annotated hash whose digest is already present would be
    skipped, so the grow-only accepted set would never acquire the annotation and
    that doc would stay unable to distinguish derivation drift from code drift,
    permanently. Insertion wants EXACT identity, not body identity.
  - `acceptance.ts:160` — the cap-eviction heuristic keys a `Map` by the raw hash
    string to count distinct bodies. Two annotated forms of one body would count
    as two, and the "once every body is down to one entry" rule would misjudge
    what to evict. Keying wants the digest.

  `recordAcceptance` (`acceptance.ts:156`) is fine and worth naming as the
  contrast: it filters matching entries and then appends the new one, so an
  annotated entry *replaces* a legacy one. It upgrades where the doc set would
  not.

  **So a single `sameBody` helper is the wrong shape.** Comparison, insertion and
  keying are three operations on a hash string and conflating them is precisely
  how a format change goes wrong quietly. The helper is a small family:
  `sameBody` for comparison, the digest for keying, exact strings for insertion —
  and the last one has to be a deliberate choice at each call site rather than a
  default.
- If anchor-id receipts turn out to need the same plumbing as hash receipts anyway,
  in which case building both is cheaper than building two mechanisms.

## Why "wait until a grammar is actually re-vendored" fails

The tempting answer, given that the blobs have been committed exactly once, is to
defer. It does not work, for a reason the cache reasoning does not reach.

**A witness is an attestation, not a derivation.** A snapshot rebuilds and `@work`
reindexes, because a machine can re-derive them. Nobody can regenerate a review
mark somebody made in 2026. So there is no repair-at-the-event: the tag has to be
inside the witness *before* the re-vendor arrives. Protection accrues only to
witnesses minted after emission begins, and witnesses are frozen for years — ship
at re-vendor time and the protected population is zero, and every existing witness
floods exactly as if nothing had been built.

**And the failure is not an event you can respond to.** `applyIndexUpdate` never
rehashes untouched anchors, so `@work` keeps old-derivation hashes and false stales
leak out symbol by symbol as files happen to be edited — mixed indistinguishably
with genuine drift, in files somebody really did touch. Unlike 985-of-985 it never
looks systemic, so nobody diagnoses it.

The honest counterweights, since they are real: re-vendors here are deliberate
acts, the flood is bounded to symbols whose token streams actually changed
(digest-equal pairs auto-clear through `sameBody`), and the recovery is the same
re-witness either way — only the label changes, from a lie to the truth.

## Recommendation

**Build everything except emission now**, which is nearly done at HEAD: the parse
side, `sameBody`/`bodyDigest`/`bodyKey`/`derivationMark`, and the comparison sites
moved onto them. Then treat turning emission on as a switch, flipped at whichever
comes first:

- the sidecar's first shipped format — clean, because no legacy shared events exist
  to mix with; or
- the first *planned* re-vendor, decided before it happens rather than during.

Do not let it wait *for* a re-vendor to be scheduled. Every day the switch is off,
the population that can never be protected retroactively grows by one day's
witnesses — and that cost belongs in the decision rather than in a later surprise.

Do not emit until the comparison helpers are complete and their tests pass. Right
now they are not: eight `!==`-shaped sites remain unexamined (see above), and until
they are, a format change is a change to two dozen implicit contracts rather than
one explicit one.
