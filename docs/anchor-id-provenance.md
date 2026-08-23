# Design: derivation provenance for anchor ids

Status: **draft 4.** Written against `b51834e`, the commit that turned hash emission
on. Supersedes the id half of `PROPOSAL-provenance.md` §5's Comparability bullet,
and **cancels** §5's `AnchorReceipt` struct. Read
`docs/decision-receipts-vs-prefix.md` first — it decided *B for hashes, A for ids*,
and this document is the finding that A is not needed.

**The conclusion, up front.** Anchor ids stay bare. Their derivation evidence is the
fingerprint already riding on the body hash minted beside them, which as of
`b51834e` is nearly every stored id. What remains is join-side: teach the sinks to
consult one predicate, fix three carriers that genuinely have no hash beside them,
and keep the `anchorScheme` gate that already exists.

Three review rounds got here — two Codex, one Fable 5. Draft 1 proposed a resolution
ladder (cut, §4); drafts 2–3 proposed a receipt struct on six event kinds and two
local storage idioms (cut, §5). What survived every round is the analysis: which
fields gate an id, which joins break, and why.

## 1. The fact this is built on

An anchor id is `"a_" + sha256(file \0 symbolPath.join("\0") \0 disambiguator)`
(`schema.ts:219`), and two of those three inputs are read off the tree-sitter parse:
`symbolPath` from `childForFieldName("name")`, `disambiguator` from `signatureKey`
(`indexer.ts:386`), which branches on grammar node types and field names.

So a grammar decides ids. Demonstrated, not argued — two C# grammars, the same
source, the same `indexSource`, the same `ANCHOR_SCHEME` 3:

```sh
node --input-type=module -e 'import {Parser,Language} from "web-tree-sitter"; import {indexSource} from "./dist/indexer.js";
await Parser.init(); const src="class C { void M(int x){} void M(ref string y){} }";
for (const [label,path] of [["other","/home/izzie/.vscode/extensions/.c55bfd16-8b98-40ab-92e6-6ec562dec54e/dist/tree-sitter-c-sharp.wasm"],["vendored","grammars/tree-sitter-c_sharp.wasm"]]) {
  const l=await Language.load(path), p=new Parser(); p.setLanguage(l);
  console.log(label, JSON.stringify(indexSource(src,"x.cs","c_sharp",p.parse(src).rootNode)
    .filter(a=>a.symbolPath.at(-1)==="M").map(a=>[a.id,a.disambiguator])));
}'
# other    [["a_6c483026496ffb1e","(int)"],["a_94320d2fbe405514","(string)"]]
# vendored [["a_6c483026496ffb1e","(int)"],["a_b3a81853fb161ea8","(refstring)"]]
```

`M(ref string)` has two ids: the `ref` modifier is visible to one grammar's node
structure and not the other's. `ANCHOR_SCHEME` cannot see this, because nobody in
this repository edited anything.

Note the other row, which carries as much weight: **`M(int)` has the same id under
both grammars.** A derivation change moves the ids whose preimage it touched, not
all of them.

*(The command stamps the same derivation mark on both runs, because
`derivationTag(grammar)` digests the vendored blob rather than the `Language`
actually passed in. In normal operation `repo.ts` loads the blob the tag names, so
they coincide — see §4's second invariant.)*

**How many ids, honestly.** The scheme number is not in the preimage, so a
derivation change moves an id only where it moves one of the three inputs, and
`file` is not parse-derived. So: symbols whose name node is read differently, plus
disambiguated ones — and a disambiguator exists only where two same-named items
share a scope. Nothing like the hash side, where a grammar change moves **every**
hash. Few records, and §3 says exactly which of the resulting failures are durable.

### Why not make the id grammar-stable instead?

The obvious response is to fix the id rather than describe it. That direction is
closed, and closing it explicitly is the point of this section.

The id names a node in a parse tree, so any encoding of *which node* factors through
the grammar — `symbolPath` already depends on what the grammar calls a declaration
and how it nests. Stability by construction can therefore only mean narrowing the
preimage, and every narrowing trades a rare failure for a frequent one:

- **Raw source text of the parameter list** is genuinely grammar-stable — both
  grammars yield `(ref string y)` — but it carries the parameter *name*, and
  `indexer.test.ts:124` pins "the parameter's NAME is not identity". A rename would
  orphan every review on the method. Excluding the name requires knowing which token
  is the name: grammar structure again, no gain.
- **Arity-only or modifier-stripped signatures** collide — `ANCHOR_SCHEME` 3 exists
  because dropping modifiers made two extension-method overloads collide — and a
  collision falls back to the ordinal.
- **The ordinal** is refuted in the code itself: it "attaches somebody's sign-off to
  a method they never read".

The general form: the preimage was already optimized to exclude everything
excludable — names, defaults, the code itself, line numbers. What remains is the
minimum that distinguishes overloads, and that minimum is read off grammar
structure because there is nothing else to read it off. Grammar-robustness is bought
only with edit-robustness, and edits outnumber grammar changes by this repository's
entire history to zero.

## 2. Comparability

### It is three fields, not one

`PROPOSAL-provenance.md` §5 says *"do not attempt an anchor join when the tags
disagree on `anchorScheme`."* One field. Which fields actually gate an id:

| field | gates an id? | why |
|---|---|---|
| `anchorScheme` | **yes** | definitionally |
| `grammarDigest` | **yes** | demonstrated in §1 |
| `parserIntegrity` | **yes**, conservatively | the wasm is what parses. `runtimeIntegrity` hashes every shipped runtime file, so a change to the CJS loader this program never imports moves the tag without being able to move an id. Safe direction |
| `hashScheme` | no | an id contains no body hash; `anchorId` sees only file, path and disambiguator |

Two three-field projections of one four-field tag, overlapping in two: hash
comparability is everything but `anchorScheme`; id comparability is everything but
`hashScheme`. §5's one-field rule is the mirror of the four-field mistake the hash
side already made and corrected, and it fails in the worse direction — under-broad
comparability *proceeds with the join* and returns a confident wrong answer.

**Each projection must be one named predicate**, and no function called
`comparableDerivation` should survive: `comparableHashDerivation` and
`comparableAnchorDerivation`, so a call site picks by question rather than by name.

### The gate is consulted only after equality fails

Read literally, §5 says do not *attempt* the join — which would refuse two
byte-identical ids because their tags disagree. That is the over-broad failure: the
safe direction, and still wrong. It is precisely the mistake the hash side made once
by including `anchorScheme`, which called comparable bodies incomparable.

The hash side settled the ordering and it transfers exactly: *"comparability is
consulted only after two digests differ."* For ids: **equal id → resolved, evidence
unread; ids differ → consult the gate.**

§1's `M(int)` is why this is not pedantry. Its preimage was untouched, so its id is
identical across both derivations and it must simply resolve. Only `M(ref string)`
reaches the gate. A derivation change is a statement about a *build*; a per-symbol
equality is evidence about a *symbol*, and the specific evidence wins where it
exists.

**Comparable to *which* derivation?** A reader has one tag per grammar, not one.
`liveDerivationDrift` (`store.ts:425`) already set the shape — build the set of tags
this build produces and ask whether the value's is *in* it. Set membership under the
id projection, and no grammar has to be guessed from a file extension.

## 3. What breaks today

Four sink classes, each failing differently. This classification is the durable
artefact; a call-site list would rot, and two review rounds each found joins the
previous list had missed.

| sink class | example | how it fails on a foreign id |
|---|---|---|
| record → live index | `evalVersion` (`doc-version.ts:22`), `staleChapters` (`walkthrough.ts:188`), `witnessDrift`, bug `possiblyFixed`, `confirmNode`/`confirmSharedDoc` | the id resolves to nothing, which reads as *the code is gone or changed* |
| record → record | `foldDocs` (`shared-docs.ts:91`) matching `doc.accepted` to its citation | the event is dropped during the fold |
| request → record | `notesForTarget` (`shared-notes.ts:204`), annotation display | filtered out by exact id: invisible, not mislabelled |
| id → routing scope | `bucketFor` (`shared-notes.ts:76`) | the lookup reads a shard the record is not in (§5) |

```sh
# record → live index: identical bodies, different ids, reported as drift-to-absent
node --no-warnings --input-type=module -e 'import {witnessDrift} from "./dist/reviews.js"; import {hashTokens} from "./dist/normalize.js";
const h=hashTokens(["same"],null);
console.log(witnessDrift([{anchorId:"a_old",bodyHash:h}], new Map([["a_new",h]])));'
# [ { anchorId: 'a_old', was: 'h2:sha256:00d0…', now: 'sha256:absent' } ]
```

**Only two of these are durable, and the document should say so precisely.**
`evalVersion`'s `dangling` scores in `badness`, so `selectWinner`
(`doc-version.ts:54`) picks a different doc version and `documentNode`
(`store.ts:616`) **forks** instead of editing in place — a durable write. An applied
`finding.relocation` **rewrites a target id** — the other durable write. The fold
discard is not durable: `foldDocs` recomputes from the log on every read, so the
event survives and a corrected fold recovers it. The tombstone misread
(`doc-version.ts:27`, fresh precisely where its anchors are ABSENT) is a false
*claim* rather than a false write.

The same file already refuses to let a *hash* derivation problem into `badness` —
"letting it score would shuffle the winner for a reason that has nothing to do with
the branch." That judgement was made for hashes and never extended to ids, because
nothing could tell an unmatched id from a deleted symbol. Something can now.

**The partial repair, and its gaps.** `reindex` calls `migrateOverloads`
(`ops.ts:354`), which pairs old anchors to new by body hash and rewrites citations.
It only considers anchors that HAVE a disambiguator (`migrate-overloads.ts:37`), and
its group key is `file + symbolPath`, so a `symbolPath` change is never repaired and
breaks the grouping; it refuses any group where a body differs, which is what a
grammar change that alters tokenization produces; it runs on `reindex` only, not
`applyIndexUpdate`; and it is local.

**The audit method**, since a list rots: inventory every durable anchor-id field and
every anchor-derived scope key; trace each read into one of the four classes; then,
at implementation time, change the durable carrier type on a scratch branch and let
the typecheck enumerate consumers. Event decoders must still be audited by hand —
their `Record<string, unknown>` casts are invisible to the compiler.

## 4. The design: the evidence is already there

A body hash minted at `b51834e` or later carries `derivationFingerprint`
(`normalize.ts:235`) over `{hashScheme, parserIntegrity, grammarDigest}`. §2's id
projection is `{anchorScheme, parserIntegrity, grammarDigest}`. **The mark therefore
answers two of the three id-gating fields, for free, on a value already stored
beside the id.**

It is sound in the direction that matters: an id can only move via the grammar, the
parser, or `anchorScheme`; the first two both move the mark. So mark-inequality
never *misses* an id-derivation change. It over-rejects — a `hashScheme` bump moves
the mark without touching any id — which is the same conservative trade §2 already
accepts for `parserIntegrity`, and `derivationFor` (`store.ts:85`) softens it by
resolving any locally-known fingerprint back to its full tag for the honest
three-field test. Only a never-seen foreign fingerprint falls back to
over-rejection.

`anchorScheme` is not in the mark and is handled out of band, as it already is:
`checkManifest` (`sidecar.ts:116`) refuses a sync fatally on a mismatch,
`readSnapshot` rejects a snapshot minted under another scheme, and `migrateOverloads`
carries local references across a bump.

> **This cancels a parent open item.** `PROPOSAL-provenance.md` §8 says
> `checkManifest`'s fatal check must be deleted in the same change that lands
> receipts. It must now be **kept** — it is the third field of id comparability.

**Where the accrued set is stronger than a receipt would have been.** A
`NodeCitation`'s `acceptedHashes` only ever gains a hash when the id *resolved* in
some build's live index (`store.ts:610`: `work.has(id) ? [work.get(id)!] : []`). So
a mark in that set is not merely "who minted this id" — it is "a build with this
derivation successfully joined this id". If any entry carries the reader's own
fingerprint, the id's absence now is genuine deletion rather than incomparability.
That is exactly the discrimination the record → live-index class needs, per symbol,
and it improves as `confirmSharedDoc` appends. A mint-time receipt could not say it.

### The two invariants this rests on — and they must be tested, not stated

1. **An id and the hash beside it are minted by one build.** True at every current
   site (`confirmSharedDoc` reads `liveHashes`; witnesses are captured at review
   time; `publishLocalDocs` re-emits pairs verbatim), but nothing enforces it.
2. **`derivationTag(grammar)` describes the parser that actually ran.** It digests
   the vendored blob for that grammar *name*; `indexSource` accepts a name and an
   already-parsed root and does not check they correspond. `repo.ts` gets this right
   and the §1 command deliberately does not — which is why both its runs stamp one
   mark.

A design resting on an unenforced coupling is how this project has been bitten
before, and it prefers tests to advisory comments. Both invariants are cheap to
pin.

### The three carriers with no hash beside them

| carrier | fix |
|---|---|
| tombstone citations — `retireSharedDoc` (`ops-shared.ts:578`) deliberately emits `acceptedHashes: []`, and the tombstone rule *inverts* absence, so this is where a misread is sharpest | stop emptying: carry the prior version's set through. `evalVersion`'s removed branch never reads it, so this is a line, not a mechanism |
| `finding.relocation.to` — a bare foreign id durably written into shared state | an **apply-time gate**: the applier verifies the proposed id resolves in *their* live index before writing. This closes the failure; a receipt would only have labelled it |
| note targets, `Bug.anchors[]`, `Review.coveredBy` (`schema.ts:744`) | bugs carry witnesses; notes are the shard question below. `coveredBy` is local and moves only with a local reindex, where `migrateOverloads` already applies |

### Why the receipt struct is cut

By this project's own proportionality standard. The parent sized `liveDerivationDrift`
as "one query, on demand, one sentence" for an event that has never happened, and §9
cut two subsystems on the same grounds. The id-moving event is *rarer at the symbol
level* than the hash-moving event it is modelled on. Against that, drafts 2–3
specified a struct on six shared event kinds, two local storage idioms, a 150-byte
locator, a new reader state, a fold change and a child document — more mechanism
than the hash side got for a strictly more frequent failure.

The attestation argument that justified emitting hashes early does not transfer
either. It said protection accrues only to records minted after emission, so delay
has a compounding cost. **That cost was already paid at `b51834e`**: the marks are
being minted now, at zero additional bytes, into every paired carrier. What is left
for a v1-format decision is small — do not strip marks from event payloads, keep the
`anchorScheme` gate, fix the tombstone emptying.

Also cut with it: draft 1's **resolution ladder**, and the proof is worth keeping
because the mechanism is intuitive enough to be re-proposed. A receipt about
`M(ref string)`, against a branch that deleted that overload and kept only `M(int)`
— now undisambiguated — makes a locator join find exactly one candidate and resolve
to the wrong method:

```sh
node --input-type=module -e 'import {anchorId} from "./dist/schema.js";
const file="x.cs", path=["N","C","M"];
const receipt=anchorId(file,path,"(string)");          // about M(ref string)
const live=[{id:anchorId(file,path), about:"M(int)"}]; // the only M left, undisambiguated
console.log({exactJoin:live.find(a=>a.id===receipt)??null, locatorCandidates:live.length});'
# { exactJoin: null, locatorCandidates: 1 }   <- one candidate, and it is the wrong method
```

`migrate-overloads` is safe from this only because it holds **both complete groups**
and refuses when their cardinality differs (`migrate-overloads.ts:47`). And the
generalization: a disambiguator exists iff two same-named items shared a scope
(`indexer.ts:383`), so a unique locator candidate means the reader's side is
undisambiguated; if the producer's was too, the ids were already equal and the
locator added nothing; if it was not, this is the mis-target. **Unique-candidate
locator resolution is either redundant or wrong, with nothing in between.** The
body-hash tie-break does not rescue it — on this project's target codebases,
`Apply(EventA)` / `Apply(EventB)` overload sets have identical trivial bodies.

## 5. Presentation, and the note shard

**Not a new state.** Draft 3 proposed `incomparable`. But the parent's state table
collapsed four `incompatible_*` labels into one on the explicit test *does the
recovery differ?* — and id-incomparability recovers the same way
`incompatible_derivation` does: align builds, re-witness, never relocate. So it is a
**detail** on the existing state, not a sibling of it.

Present it as `evalVersion` already presents `unverifiable`: below the states that
can be proved, **out of `badness`**, one count. That is the internal tri-state the
sinks need (resolved / absent / incomparable) and it needs no new reader-facing
vocabulary. The distinction that is load-bearing is the guard; the label is not.

**The note shard.** `shared-notes.ts:76` shards by `sha256(targetId)` and
`notesForTarget` reads one shard then filters by exact id, so a teammate's note
under a different id is invisible. Sharding by `sha256(file \0 symbolPath)` would
make routing derivation-independent, at a real cost: bucketing by id needs only the
id, so `sharedNotes(root, anchorId)` works for a symbol this checkout no longer has.
Scope names are the shard layout, so this is free today and a sidecar-structure
migration once a client ships. It is orthogonal to everything above and should be
its own record.

## 6. The mechanism

### The failure has a one-line signature

The whole record → live-index class is one idiom:

```
live.get(anchorId) ?? ABSENT_HASH
```

Five occurrences — `reviews.ts:455` (`witnessDrift`), `walkthrough.ts:188`
(`staleChapters`), `ops.ts:239` (the `possiblyFixed` rollup), `ops.ts:2500`, and
`ops.ts:2540` — plus `evalVersion`'s `work.get(c.anchorId)` (`doc-version.ts:32`)
and the tombstone branch's `work.has` (`:27`).

Every one of them conflates *not there* with *could not look it up*, and the
conflation is invisible downstream because `ABSENT_HASH` is deliberately comparable
to everything:

```sh
node --no-warnings -e 'import("./dist/normalize.js").then(m =>
  console.log(m.comparableHashes(m.ABSENT_HASH, "h2:sha256:"+"a".repeat(64))))'   # true
```

That is correct for "the code is gone" and wrong for "I could not resolve the id",
and the parent already wrote the rule that separates them — nothing implements it:

> `ABSENT_HASH` is universally comparable only *after* anchor compatibility is
> established; before that, "there is no code here" is not a statement anyone is
> entitled to make.

### The resolution is three-valued

```ts
type Resolved =
  | { at: "found"; hash: string }
  | { at: "absent" }                          // it would have resolved here; the absence is real
  | { at: "incomparable"; detail: string };   // it could not have been minted by this index
```

`ABSENT_HASH` is then synthesized only in the `absent` branch, which is exactly the
evaluation order the parent specified.

### The operand is the index, not the running build

This is the part that is easy to get backwards, and draft 3 did. The question a sink
asks is *"could this id have been minted by the build that produced the index I am
searching?"* — not *"does it match the build I am running."*

If `@work` was indexed by an older grammar and a newer one is running, an id from a
record minted by that older build **would** match the rows in `@work`. Comparing
against the running build's tags would call it incomparable and suppress an answer
that was available. `liveDerivationDrift` compares `@work`'s tags to the build's
tags, but that is a different question — *is my index stale* — and reusing its
operand here would be borrowing the right shape for the wrong purpose.

So the operand is the index's own tag set: `SELECT DISTINCT derivation FROM anchors
WHERE ref = ?`, resolved through the interned table. A **set**, not a value:
`applyIndexUpdate` adds rows incrementally, so one ref legitimately holds rows minted
by two builds — which is the granularity rule the parent settled, arriving where it
matters.

### The evidence, and the accrual rule

The record side carries zero or more marks — one for a `BugWitness`, up to *n* for a
citation's `acceptedHashes`:

| evidence | answer | why |
|---|---|---|
| no marks at all | fall back to today's behaviour | legacy, and the same fallback every other path in this design uses. A pre-emission record asserts nothing about its derivation |
| **any** mark in the index's set | `absent` | the accrual rule: a hash only enters `acceptedHashes` when the id *resolved* (`store.ts:610`), so a matching mark means a build like this one joined this id before. Its absence now is deletion |
| all marks outside the set | `incomparable` | nothing here could have minted it |

The asymmetry is deliberate: **one positive proof of resolvability outranks any
number of negatives.** A record that has been confirmed under three derivations and
matches on one of them is answerable, and treating it as incomparable because two
others do not match would be the over-broad failure again.

This is also why the tombstone carrier fix (§4) is load-bearing rather than
cosmetic: `retireSharedDoc` emits `acceptedHashes: []`, so a tombstone arrives with
**no evidence**, falls into the legacy row, and keeps reading as holding. Carrying
the prior version's hashes through is what supplies the evidence the rule needs.

### What each sink does with it

| sink | today | with the resolution |
|---|---|---|
| `evalVersion` | absent → `dangling` → scores in `badness` | `incomparable` → the **existing** `unverifiable` list, already excluded from `badness`. No new bucket and no new vocabulary: the file made this exact judgement for hashes and this extends it to ids |
| `evalVersion`, tombstone branch | fresh precisely where cited anchors are absent | an incomparable absence is not evidence of removal, so it must not make a tombstone read as holding |
| `witnessDrift` | `?? ABSENT_HASH`, then `comparableHashes` — always decidable | it *already* emits `unverifiable: true` for hash-incomparability; route incomparable absence to the same flag |
| `staleChapters` | `sameBody(live.get(…) ?? ABSENT_HASH, …)` | a chapter is not stale because its ids are foreign |
| bugs `possiblyFixed` (`ops.ts:239`, `:2500`) | absence counts as possibly-fixed | it does not, when the id was unresolvable |
| `confirmNode` / `confirmSharedDoc` | silently add nothing | *nothing to confirm* and *cannot confirm* are different answers and both are worth saying |

`witnessDrift` is the encouraging one: the shape is already there, the flag is
already there, and only the ABSENT_HASH short-circuit stands between them.

### `foldDocs` is a different class and gets a different answer

Do not attempt to match a `doc.accepted` to a citation whose id differs. Pairing
records to records with no group information is draft 1's ladder one level over, and
it fails the same way. **Retain instead**: keep the unmatched acceptance on the
version rather than dropping it. The fold recomputes from the log on every read, so
retention costs nothing durable and a corrected fold recovers what a naive one could
not. The requirement is only that the discard stop being silent.

### The seam

`evalVersion`, `selectWinner`, `resolveNode` and `winningVersionAt` all take
`work: Map<string, string>`, and `workHashes` (`store.ts:510`) selects only
`id, body_hash` from a table whose `derivation` column is right there. The change is
to pass an index *view* — the hashes plus the ref's tag set — instead of a bare map.

That is also the audit method (§3) in its cheapest form: change the carrier type and
let the typecheck enumerate the consumers. The five `?? ABSENT_HASH` sites are found
by grep; the map-shaped ones are found by the compiler.

## 7. Build order

The mint side is substantially done. What remains is join-side, and it spans both
stores identically — `evalVersion` does not care whether a citation came from the
sidecar or the local DB. That, not "the local half", is the seam if this needs a
child document.

Ordered so that each step is testable before the next depends on it:

1. ~~**The tombstone carrier fix.**~~ **Done.** Both paths — `retireSharedDoc` and
   `ackHole`, the local one this document had missed — now carry the prior version's
   accepted hashes onto the tombstone. First, because §6's rule is evidence-driven
   and a tombstone arrived with none.
2. ~~**`comparableAnchorDerivation` + `resolveAnchor`**~~ **Done**, in
   `src/anchor-resolve.ts`. `comparableDerivation` is now
   `comparableHashDerivation`, so neither projection can be picked by name. The
   resolver has no callers yet, deliberately — see step 3. Two facts it pins that
   were only prose before: the raw mark **over**-rejects on `hashScheme` and
   **under**-rejects on `anchorScheme`, so the manifest gate is load-bearing and the
   local dictionary is the only thing that closes either gap.
3. ~~**The five `?? ABSENT_HASH` sites**~~ **Done.** The idiom no longer appears in
   production code; `ABSENT_HASH` is synthesized only inside an `absent` branch.
4. ~~**`evalVersion` and the index-view seam**~~ **Done.** An incomparable citation
   goes to the existing `unverifiable` list and out of `badness`, so it can no
   longer reshuffle which version wins or make `documentNode` fork. A **tombstone
   inverts that**: its claim is about absence, so an undecidable citation counts
   against it rather than being excluded — letting it win would hide a doc whose
   code may be present, and hiding has no recovery.

   Two things the wiring turned up that the design had not:

   - **An index with no rows has no tags**, so "no tag matches your mark" read as
     *incomparable* for every record the moment a repo's last anchored symbol was
     deleted — which stopped `ackHole` from acknowledging a hole. An empty index is
     not evidence about how ids are derived; it now falls back.
   - **The operand differs per site and the rule has to be applied, not quoted.**
     `liveHashes` with no ref re-parses in process, so the operand is *this build*;
     with a ref, and for `@work` and snapshots, it is *the stored rows*. Taking the
     tags off whatever a re-index happened to produce would call a deleted file's
     symbols undecidable.
5. ~~**`foldDocs` retaining rather than discarding**, and the relocation apply-time
   gate.~~ **Done.** An acceptance that matches no citation is kept on
   `SharedDoc.unmatched` with why — `no-citation` or `no-version` — rather than
   dropped, and surfaced as a count so the retention is not itself silent. It is
   still not MERGED: two ids are not known to name one symbol, and guessing is the
   ladder again. Applying a relocation now checks the proposed id against the
   applier's own index first, because that is the one place a foreign id is written
   INTO shared state, where "cannot tell" is not enough — the write outlives the
   reader. Proposing stays ungated: telling a teammate about a symbol they may not
   have yet is the point.
6. ~~**The two invariants pinned by tests**~~ **Done**, in
   `derivation-invariants.test.ts`: an anchor's hash carries the same derivation as
   its row, and a grammar's tag digests the blob `loadLanguage` loads. Both were true
   by construction and neither was enforced by a type — which is the whole reason the
   design gets to rest on them.

   Still open: **a one-page v1 format note** — ids stay bare, their evidence is the
   adjacent mark, the pairing is an invariant, `anchorScheme` stays gated, and the
   parent's "delete the fatal manifest check" item is cancelled.

Steps 1–4 are local-only and need no format decision. Step 5 is the shared half.
The note shard (§5) is not on this list — it is a separate record.

## What the implementation review found

A Codex round over `eacb1c3..HEAD` produced five findings, four of them real. They
are worth recording because three are about the *seam*, not the logic:

1. **Three `workHashes(d)` calls omitted the store root**, so `loadNodes`,
   `confirmNode` and `ackHole` compared fingerprints without the local dictionary
   while `writeNode` used it — reads and writes disagreeing about one doc. The
   parameter is now required.
2. **The dictionary is not an inverse.** A fingerprint excludes `anchorScheme`, so
   two retained tags can share one and "the first match" made the answer depend on
   row order. It returns every candidate now, and the caller takes the permissive
   reading. This *narrows* what the dictionary claims: it closes the `hashScheme`
   over-rejection, not the `anchorScheme` under-rejection — which stays gated by
   `checkManifest`, exactly as §4 said.
3. **A typed seam does not enumerate a duplicated implementation.** `nodeVersions`
   had its own copy of `evalVersion`'s rule written in raw `work.has`/`sameBody`, so
   it was the one document surface the change did not reach. It calls `evalVersion`
   now. Two remaining bypasses are recorded below.
4. **More evidence made the answer worse.** `resolveAnchor` dropped unannotated
   hashes before counting marks, so a legacy-only citation read `absent` while the
   same citation with one foreign annotated hash accrued beside it read
   `incomparable`. An unannotated hash still proves the id resolved under *some*
   derivation, so it now preserves the fallback.

And one performance defect the review did not find but the test suite did: the
whole suite began hanging. The tempting explanation was this project's known
load-dependent deadlock; a stash-and-rerun showed the suite green at HEAD and stuck
with the changes, so it was not. `derivationsOf` was hashing **per anchor row** to
dedupe, on a helper `loadNodes`/`confirmNode`/`ackHole` all call. Tags are interned,
so identity dedup comes first now and the hashing is once per distinct tag.

**Still bypassing the resolution**, recorded rather than fixed: the dashboard's
dangling-doc count recomputes membership from raw ids (`ops.ts`), and the shared
citation presentation (`ops-shared.ts`) labels an incomparable missing id `lost`.
Both are presentation over an already-resolved answer, and both belong with the
`incompatible_derivation` detail decision in §5.

## What would change my mind

- **If the pairing invariant cannot be pinned.** The whole design rests on an id and
  its neighbouring hash sharing a build. If a carrier turns up where that is false
  and cannot be made true, that carrier needs a receipt after all — and the struct
  comes back for it alone, not for all six.
- **If `derivationFor`'s local dictionary turns out to be usually empty in
  practice.** Then most foreign fingerprints degrade to the four-field
  over-rejection, and `hashScheme` bumps start marking ids incomparable for nothing.
  Measurable: count distinct rows in `derivations` on a real store over time.
