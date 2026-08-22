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
- **The sidecar for free.** Shared doc citations store hashes as strings in event
  payloads. Under B those strings carry the fingerprint across machines with **no
  event-format change** — the cross-machine case falls out rather than being built.

**What it gives up.** `fp` is one-way. A reader can tell *different* but not *what
differed* — unless it has seen that tag before, which the local `derivations` table
already records. For a foreign fingerprint the honest message is "derived
differently, and I do not have theirs". Under the collapsed state table
(`incompatible_derivation` + detail) that is all a reader needs to act on, since
every branch of it recovers the same way.

**The load-bearing migration decision.** Adding `fp` must **not** bump
`HASH_SCHEME`. The digest is byte-identical — the token stream did not change, only
the annotation riding beside it — so by §3's own rule ("only a change to hash
derivation or its canonical encoding") this is an extension, not a new derivation.
Bump it and every hash in every store becomes incomparable at once: a store-wide
`unverifiable` event and a forced re-witness pass, for a change that altered
nothing about how anything was hashed. `hashSchemeOf` keeps returning 2; an fp-less
hash is legacy and falls back exactly as untagged values do everywhere else in this
design.

## They are not actually alternatives

The comparison above assumes A and B answer the same question. They do not.

- **Hashes** — witnesses, accepted hashes, acceptance. B covers these, locally and
  in the sidecar, with no schema change.
- **Anchor ids** — a shared target pointing at an id derived under another scheme.
  B cannot touch this. A must.

So the shape that *may* fall out is **B for hashes, A for ids only** — which would
delete `HashReceipt` from §5 and leave `AnchorReceipt`.

Stated more carefully than the first draft did: B genuinely cannot describe an
anchor id, so **A is irreducible for ids**. But A is not incapable for hashes, only
dearer, so the mixed design is a cost argument rather than a forced decomposition.
That distinction matters, because "they solve different problems" is exactly the
conclusion that lets somebody keep both mechanisms and cut neither.

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

## Recommendation

Take B for hashes, keep A for ids, and do the equality-helper refactor first as a
standalone change — it is safe, mechanical, valuable regardless of which design
wins, and it is the part that would be riskiest to do under time pressure during a
real grammar upgrade.

Do not build either until the equality helper is in and its tests pass, because
until then a hash-format change is a change to sixteen implicit contracts rather
than one explicit one.
