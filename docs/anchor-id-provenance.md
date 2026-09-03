# Design: derivation provenance for anchor ids

> **Kind: decision record** — why the code looks like this. Done — kept for the argument, not as a to-do.
> MIXED and the longest doc here: landed mechanism, cancelled `AnchorReceipt`, and unlanded recovery work. Cited from source, so it cannot simply be retired.

Status: **draft 4 — MIXED, and read the kind line above before planning from it.**
At 1200+ lines this is the longest document here and it holds three different things:
the landed mechanism (§6, §7 — built and emitting), a CANCELLED design (`AnchorReceipt`,
which does not exist in the source), and unlanded recovery work. It is cited from source,
so it cannot simply be retired — splitting it is queued, not done. Written against `31153fa`, the commit that turned hash emission
on. Supersedes the id half of `PROPOSAL-provenance.md` §5's Comparability bullet,
and **cancels** §5's `AnchorReceipt` struct. Read
`docs/decision-receipts-vs-prefix.md` first — it decided *B for hashes, A for ids*,
and this document is the finding that A is not needed.

**The conclusion, up front.** Anchor ids stay bare. Their derivation evidence is the
fingerprint already riding on the body hash minted beside them, which as of
`31153fa` is nearly every stored id. What remains is join-side: teach the sinks to
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

A body hash minted at `31153fa` or later carries `derivationFingerprint`
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
has a compounding cost. **That cost was already paid at `31153fa`**: the marks are
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

A Codex round over `01ac653..HEAD` produced five findings, four of them real. They
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

And one performance defect the review did not find: `derivationsOf` was hashing
**per anchor row** to dedupe, on a helper `loadNodes`/`confirmNode`/`ackHole` all
call. Tags are interned, so identity dedup comes first now and the hashing is once
per distinct tag. Real, and worth fixing on its own terms.

**The diagnosis attached to it was wrong, and the mistake is the more useful half.**
It was found because the test suite started hanging, and a stash-and-rerun appeared
to show the suite green at HEAD and stuck with the changes — so it was recorded as
*caused* by the change rather than by this project's known load-dependent flake.
Neither was true. `sh -c 'tsc && tsc -p web && node --test "dist/**/*.test.js"'` —
npm's own command, run directly — completes in ~32s green, while `npm test` blocks
with almost no CPU. The hangs tracked which other processes were running, not which
code was checked out: two review agents were running the suite concurrently
throughout. A bisect is only as good as the noise floor, and A/B runs minutes apart
on a shared machine do not have one. When a run blocks with near-zero CPU, that is
a wait, and the first question is who else is running.

### The perimeter, after two more reviews

A `/code-review` pass and a Fable round over the implementation agreed on the shape
of what was left: the resolution core was faithful and test-pinned, and the
*perimeter* was wider than this document recorded. Fixed since:

- `reviewStatesFor` still handed `undefined` to `resolveAcceptance`, which reads it
  as `none` — the red tick. On the surface this product leads with, and in a
  function whose input (`liveHashes`) the work had already changed.
- `bugDetail`'s `present: !!liveA` moved the confident claim rather than removing it:
  absent-and-not-stale renders as "removed, and the bug is unaffected".
- `checkStale` recomputed dangling docs from raw id membership, so one doc could read
  `unverifiable` through `evalVersion` and "code no longer exists" through
  `check_stale` — two surfaces disagreeing about one doc.
- `evalVersion`'s removed branch reported an undecidable citation in `stale`, which
  on a tombstone means "the code came back".
- Both confirm paths said neither "nothing to confirm" nor "cannot confirm", while
  the web offered a button that, for the id cause, clears nothing. They now name
  what they could not confirm, and the copy says so.
- The relocation gate fired on `node`-kind targets, refusing a legitimate relocation
  with a message about anchors.

**Still open, and now the sharpest thing here.** A doc whose citations read
`incomparable` cannot be cleared: `confirmNode` has no live hash to add, and
`ackHole` refuses because the status is not `dangling`. Worse, `ackHole` could not
help even if it ran — the tombstone it writes inherits the prior version's
old-derivation hashes, so §6's inversion counts them against it and the content
version wins. The tombstone judges its own author foreign.

That is not a patch. The evidence a tombstone needs is *the derivation of the build
that made the removal judgment*, and a `NodeVersion` has nowhere to put it. Recorded
rather than guessed at the end of a long session.

Also still bypassing: `orphanedWork`'s `lost` bucket, and the shared citation
presentation's `lost` label — both presentation over an already-resolved answer.

## Recovery: placing an id nobody can place

Everything above makes an unplaceable id *legible*. It does not place it. This is
that arc, and it turned out to have a smaller centre than the framing it started
with.

**The framing it started with — and why it is now only half right.** "Local ids are
mine to rewrite; shared ids are evidence I can only interpret" is true about
REWRITING: a local rewrite moves my records onto new ids while the shared log still
holds the old ones, which creates the divergence rather than closing it, and pairing
on everyone else's behalf asserts a fact about my checkout as though it were a fact
about theirs. All of that stands.

What it got wrong is where the difficulty sits. The hard part is not shared versus
local, and it is not working out what an id NAMED — for most records this build can
do that alone. It is saying what that symbol is NOW, which no digest can confirm and
which stays a judgement whoever makes it.

### The two causes need different work

An id that will not resolve is not one condition, and `resolveAnchor` already
separates them:

- **`absent`** — this build COULD have minted that id and did not. The code moved: a
  rename, a file move, a signature change. Derivation is not involved.
- **`incomparable`** — this build could not have minted it at all. Another build's
  derivation spelled it, and no amount of re-indexing here reproduces it.

`migrateOverloads` repairs a slice of the first: it pairs old rows to new by body
hash inside a `file + symbolPath` group and rewrites reviews, triage, annotations,
bugs and citations. It is destructive, it runs on full `reindex` only, and it
refuses anything it cannot pair beyond doubt.

The measurement below says `incomparable` is also drawn too widely — it is reached
from the BODY HASH's provenance and applied to the ID, and for most ids those are
not the same question.

### What the id is made of — and one claim about it that is false

An anchor id is `sha256(file \0 symbolPath.join("\0") \0 disambiguator)`, truncated
(`anchorId`, `schema.ts`). It cannot be inverted.

**A first draft of this section claimed it could be CHECKED, and that this made a
published locator verifiable by arithmetic with no trust in the publisher. That is
wrong, and the way it is wrong is worth keeping.** The encoding is a flat NUL-joined
byte string with no tagged field boundaries, so any re-partition at a NUL produces
the same digest. Verified against HEAD:

```
anchorId("x.cs", ["N","C","M"])            === anchorId("x.cs", ["N","C"], "M")
anchorId("x.cs", ["N","C","M"], "(int)")   === anchorId("x.cs", ["N","C","M","(int)"])
anchorId("x.cs", ["N","C","M"])            === anchorId("x.cs\0N", ["C","M"])
```

So recomputing the digest proves a triple is *a* preimage, never *the* one. A false
locator can verify without going anywhere near a SHA attack — no 2^64 anything, just
a different split of the same bytes.

Making the encoding injective is one length prefix per field, and `normalize.ts`
already length-prefixes its token stream for exactly this reason. It is not
scheduled: it changes every id in every store, which is an `ANCHOR_SCHEME` bump and
the phantom-diff event the scheme numbers exist to contain. **Recorded as a known
limit, and the design below is built so as not to need it.**

The other thing the draft got wrong: it said the grammar's only contribution to an
id is the disambiguator. §1 says otherwise and §1 is right — the grammar decides
what counts as a declaration, what its name is, and how containers nest, all of
which feed `symbolPath`. What is true is narrower and is the measurement below: the
disambiguator is the field that varies most, and it is present on very few ids.

### Measured: 96.6% of ids carry no disambiguator at all

The indexer emits one only when a name COLLIDES in its scope (`indexer.ts`:
`if ((totals.get(k) ?? 0) > 1)`). A symbol whose name is unique where it sits gets
`undefined`, and `anchorId` skips the field.

Counted in process, read-only:

| store | anchors | with a disambiguator |
|---|---|---|
| this repo (TS) | 481 | 0 |
| `FakeBankSimulator` (C#) | 227 | 2 — 0.9% |
| the real event-sourced target (C#) | 10,111 | **347 — 3.4%** |

All 347 are signature-derived; not one fell back to an ordinal. This does not make
those 96.6% grammar-INDEPENDENT — `symbolPath` is still grammar-shaped — but it does
mean the field two grammars most visibly disagree on (§1's `(refstring)`) is absent
from all but a few of them.

### Verify the READER's candidate, never the publisher's split

The repair for the encoding problem is not to trust the split. It is to stop asking
the publisher's triple to prove anything:

> A candidate is accepted only when the READER's own anchor — file, symbol path and
> disambiguator as the reader's own indexer produced them — reproduces `a_old`.

The reader is then checking an id it minted itself, against a symbol that is
actually there. A re-partitioned locator cannot survive that — and the reason is
structural rather than lucky.

**The two alphabets are disjoint.** Every disambiguator this indexer emits either
starts with `(` (`signatureKey` always returns `(${parts})`) or contains `#` (the
`${sig ?? ""}#${i}` fallback). No identifier in C#, TypeScript, JavaScript or Python
can contain either. So the re-partition that breaks a crafted triple — moving the
last path segment into the disambiguator or back — cannot describe two REAL anchors,
because the string would have to be a valid symbol name and a valid disambiguator at
once.

Measured across four repositories and three languages, 16,093 anchors:

| store | anchors | a name shaped like a disambiguator | a disambiguator shaped like a name | id collisions |
|---|---|---|---|---|
| this repo | 1,345 | 0 | 0 | 0 |
| `FakeBankSimulator` | 1,268 | 0 | 0 | 0 |
| the event-sourced target | 11,018 | 0 | 0 | 0 |
| `mrepo-web` | 2,462 | 0 | 0 | 0 |

That property is now load-bearing, so it wants a test rather than a paragraph: a
grammar added later whose `signatureKey` returns something unparenthesized would
re-open the ambiguity silently.

**And one anchor per id is NOT currently guaranteed** — a review round found a case
the measurement above was blind to, because it keyed on `file + path +
disambiguator` and this collision has all three equal:

```csharp
partial class C { void M(int x) {} }   // one file
partial class C { void M(string x) {} }
```

The two `C` shells are disambiguated `#0` and `#1`, but a container's disambiguator
is not carried into its children's `symbolPath`, and each partial body is a separate
scope in which `M` is unique — so both methods get `symbolPath: ["C","M"]`, no
disambiguator, and `a_fc2ab97b04075e35` twice. `anchors` is keyed `(ref, id)` and
written `INSERT OR REPLACE`, so one of the two methods silently ceases to exist for
the whole map.

Measured on fresh indexes, which is where it is visible (a store has already
overwritten it): **0 colliding groups in 18,761 anchors** across this repo,
`FakeBankSimulator`, both large C# targets and `mrepo-web`. Real `partial` classes
live in different files, and the file is the first field of the digest.

So: latent, not active. Carrying the container's disambiguator into the child path
is the correct fix and it is an `ANCHOR_SCHEME` bump — disproportionate for zero
observed instances, and it should ride along with the next one. **What is
proportionate now is refusing to lose the row silently**, which is also what makes
"the reader's own index has at most one anchor per id" an enforced invariant instead
of a hoped-for one.

And it collapses the mechanism to something nearly present: "does my own index of
that commit contain `a_old`" is that check.

**Nearly, not exactly — `findAnchorsOutsideWork` is not it.** It reads cached rows
that another derivation may have minted, searching every snapshot and returning the
NEWEST occurrence rather than the one at the commit the record names. And a
persisted snapshot has already collapsed any duplicate id. Step 1 has to index the
commit fresh (`indexCommit`) and check uniqueness in the unpersisted result.

**So the locator is redundant for identification whenever the reader's build can
mint the id, and that is the majority case.** What is left for a published locator
is the minority where it cannot — and there, having given up the arithmetic, it is a
trusted assertion like any other.

### Two steps, and only the first can ever be verified

1. **Identify.** What did `a_old` name? Freshly index the commit the record already
   points at and look the id up. Verifiable when this build can mint it; a trusted
   assertion otherwise.
2. **Continue.** What is that symbol NOW? A rename, a moved file, a changed
   signature — the current symbol has a different id BY CONSTRUCTION, so no digest
   check can confirm the pairing. This step is a judgement and always will be.

Everything hard is in step 2, and step 1 does not shrink it.

**Not every record has an address.** `sourceRef` is optional and is often `@work`;
`createdCommit` is nullable. Step 1's answer therefore has four shapes — *here it
is*, *not in that commit under this build*, *ambiguous*, and *no historical address
to ask about* — and the last must be said rather than implied.

### What step 2 can actually stand on

In descending strength, and the ordering matters more than the list:

1. **An exact blob rename.** Git establishes that the file's content is unchanged
   and only its path moved, so the two anchor sets pair by `symbolPath` and
   disambiguator with nothing left to guess.
2. **The commit where the id disappears.** The id is exact until one adjacent
   transition; finding that transition and reading its diff is far stronger evidence
   than comparing an old commit with today. Commit indexing, ancestry, blob reads
   and the diff machinery all exist.
3. **A complete-group body-hash bijection** — `migrateOverloads`' standard: a
   constrained `file + symbolPath` group, unchanged cardinality, unique bodies,
   every old body paired. A single matching body is much weaker, because trivial
   implementations repeat.
4. **Rename similarity, kind and signature likeness.** For RANKING candidates in
   front of a person, never for applying one. Note that no rename-PAIR helper exists
   yet: `changedFilesBetween` and `numstat` pass `-M` and then keep only the
   head-side name.

**Body hashes will not pair across a `hashScheme` change** — `sameBody` requires
equal schemes and `bodyKey` includes it, which is exactly the guard that stops a
scheme bump reading as universal drift. The only recovery is to re-index BOTH the
old commit and the current tree under the running build so the hashes are
commensurable, which is available only once step 1 has identified the old symbol.

And body pairing is narrower than it looks even within one scheme: a callable's hash
covers its declaration, so a rename or a signature change moves the body hash too.
It is strongest for file moves and derivation-only id changes, weakest for exactly
the edits people file findings about.

### What this does to "Clearing a doc nobody can place" part 3

Less than the first draft claimed. A locator can turn an incomparable id into an
ordinary `dangling` one **mechanically**. It does not turn *the old identity is
absent* into *the subject is genuinely gone* **epistemically** — and that judgement
is what part 3 was for. `dangling` deliberately includes renamed code, so routing
through it inherits that limit rather than removing it.

| part 3 blocker | what the locator does |
|---|---|
| 1. `anchorScheme` under-rejection | bypassed for a record with a usable locator, not fixed. Everything without one keeps the hole |
| 2. no singular build derivation | **genuinely removed.** Locator resolution never aggregates writer against reader derivation sets |
| 3. same derivation ≠ same checkout | untouched. A locator gives the old address, not continuity to the new one |
| 4. empty-index fallback, tombstone tie | bypassed only if ONE resolution view returns a decisive answer for both content and tombstone evaluation. Remains for locatorless and ambiguous records |
| 5. shared-only doc has no queue path | untouched, and `retireSharedDoc` would need remap-aware resolution too — it classifies raw ids today |

### The seam, when there is enough here to need one

Read-time interpretation is right: the record is preserved and an append-only
interpretation is applied over it. Rewriting an id string at each read site is not —
it would miss the paths that never reach `resolveAnchor`:

- `classifyCitations` tests raw id membership.
- `liveHashes` discovers which FILES to reparse from the id, and filters snapshots
  by requested ids — a foreign id supplies neither the locator's file nor a
  candidate new id.
- `retireSharedDoc` classifies citations rather than calling `evalVersion`.
- `foldDocs` joins acceptances to citations by exact id, earlier than any read-time
  resolution could reach.

So the store-facing layer would load and validate the interpretations and build the
secondary index they need, and the result would be one value passed into one pure
resolver beside `resolveAnchor`, with the typecheck enumerating its consumers — the
move `AnchorIndex` already makes for derivation evidence. Its result is not
`oldId → currentId` but at least
`exact | mapped(anchor) | absent | ambiguous | no-locator`, exact id equality wins
before anything else is consulted, and a mapped result exposes the current ANCHOR
rather than only a hash so navigation can use the placed symbol.

**None of that is being built yet, and the reason is the next section.**

### Proportion: what is worth building, and what has to be measured first

The temptation here is a remap protocol, a resolution view and a continuation
engine. Against that:

- Step 1 is small, local, needs no protocol and covers the case where this build can
  mint the id.
- `migrateOverloads` already does the strongest form of step 2 for the case it can
  prove, and refuses the rest.
- The queue built in "Clearing a doc nobody can place" already routes the residue to
  a person with its evidence attached.

So: **build the step 1 diagnostic, feed it into that queue, and stop.**

**Built** (`whereWas` / `whereWere` in `ops.ts`, MCP `where_was`). It indexes the
commit fresh, groups the result by id, and answers `found` / `absent` / `ambiguous`
/ `unaddressed`. `ackHole` runs it for every unplaceable citation before filing the
question, so the queue item carries the address rather than instructions for finding
one — and says in as many words which half is settled (what the id named) and which
is not (what that symbol is now). `collidingAnchors` makes `ambiguous` reachable and
`reindex` reports it, so the invariant it rests on is enforced rather than assumed.

The 3.4% disambiguator rate is informative but it is the wrong denominator for the
decision, and it would be dishonest to spend it as one. Disambiguated anchors are
not the same set as ids another build cannot mint; a grammar change can move
`symbolPath` on an undisambiguated anchor; some disambiguated ids are identical
across grammars anyway; and an event-sourced codebase's docs and findings cite
`Apply`/`Handle` overloads far out of proportion to their share of the tree.

**The deferred piece, recorded so it is not redesigned from scratch.** When the
minority that this build cannot mint turns out to matter, what gets published is a
locator as an assertion, with the ratchet the arithmetic does not provide:

```
remap  { anchorId, file, symbolPath, disambiguator, anchorScheme, foundAt, by, applied? }
```

Proposed by whoever can reproduce the id, applied by a PERSON, recorded with its
evidence and retractable by a later event — the same shape as `finding.relocation`,
for the same reason: a wrong remap is false provenance across a fleet rather than on
one machine. `anchorScheme` says how to READ the disambiguator and is explicitly not
bound into the digest. Appended, never migrating anything.

**The denominator to measure is the queue itself**: of the records that actually
reach it, how many carry a concrete source commit, how many step 1 identifies
uniquely, how many stay foreign, and how often a person finds an unambiguous
continuation. Until that residue shows repetition, a general step-2 engine is
mechanism ahead of observed pain — which is the failure this whole document was
written to avoid making twice.

#### Measured (2026-08-23), and it says DO NOT BUILD IT YET

Against the two live C# universes, read-only: `whereWere` run over every stranded
record's own address. 2,641 records, 2,532 of them stranded reviews.

| | records | placed by step 1 | absent | ambiguous | no address |
|---|---|---|---|---|---|
| `Acme.API` bulk import | 1,070 | 4 (0.4%) | 1,066 | 0 | 0 |
| `Acme.API` organic | 82 | 5 (6.1%) | 77 | 0 | 0 |
| `Acme.React` bulk import | 1,371 | 0 (0.0%) | 1,371 | 0 | 0 |
| `Acme.React` organic | 99 | 49 (49.5%) | 50 | 0 | 0 |

Four things follow, and only the first was expected.

**Every record carries an address, and every address answered.** 2,641 of 2,641,
with zero `unaddressed` — so both of that branch's arms (no commit to ask about,
cannot resolve it here) are correctness guards rather than paths anything takes.

**The overall rate is worthless, because the bulk population is a FIXED BUG.**
4,928 of `Acme.API`'s 5,061 reviews are `github-import` `viewed` marks, and every
one carries the same `reviewedCommit` — the working tree's HEAD at import time,
not the PR head each mark was made against. `pr-bulk.ts` passes `ref: headRefOid`
now and its comment describes this exact symptom. The commit that added it landed
**one minute after** that import ran (fix 21:04, import 21:03, same evening). So
the denominator is contaminated by sixty seconds, and the honest rate is the
organic one: **6% to 50%, not 0.4%.**

**What actually decides placement is the SCHEME the record's ids were minted
under** — not the address, and not whether the code is gone. Splitting the same
population by whether it was written before or after `ANCHOR_SCHEME` went to 3:

| | records | placed |
|---|---|---|
| `Acme.React` organic, written AFTER the bump | 49 | **49 (100%)** |
| `Acme.React` organic, written before | 61 | 6 (9.8%) |
| `Acme.API` organic, written after | 5 | 1 (20%) |
| `Acme.API` organic, written before | 80 | 4 (5.0%) |

Step 1 places essentially everything whose ids this build can mint, and almost
nothing older. **That is blocker 1 of "Clearing a doc nobody can place", measured:**
a pre-bump id resolves `absent` when the honest answer is `incomparable`, because
`derivationFingerprint` excludes `anchorScheme`. The doc guessed that a rule which
cannot see the commonest cause of a re-minted id is worth less than it looks. It is
the commonest cause — by an order of magnitude over everything else here.

> **A wrong claim this section made first, kept because the method matters.** An
> earlier pass concluded "the residue is genuine absence, not drifted ids", from a
> test that looked for each record's witnessed body under a different id at its
> address and found none in 67. That test could not have found one: the stored
> witnesses are `HASH_SCHEME` 1 (unprefixed) and today's index mints scheme-2
> digests, so it was comparing values from two tokenizers. It proved nothing, and
> the scheme split above says the opposite.

**Zero ambiguous, in 2,641.** The partial-class collision this document reports as
a latent bug does not appear in the population that would meet it.

So: **step 2 stays unbuilt, and for a better reason than "not enough pain".** The
population it would serve is not code that moved — it is ids this build cannot
mint, and a remap protocol re-points an id at a symbol that is still there. What
those records need is to be CLASSIFIED honestly (`incomparable`, not `absent`),
which is blocker 1, and which the out-of-band gates already half-cover.

The back-catalogue import also wants re-running with the current build — its
addresses are the working tree's HEAD, which is a genuine second defect — but it
is now clearly the smaller one, and a data repair rather than code.

#### The repair, run end-to-end on an isolated copy

`prPullViewedAll(root, { force: true })` against a clone of `Acme.API`: 269 PRs
surveyed, 151 with ticks, **5,375 marks, 0 errors, 202 seconds**. Measured before
and after:

| | before | after |
|---|---|---|
| distinct addresses across the bulk marks | **1** | **107** |
| stranded bulk marks placed by step 1 | 0.4% | **46.8%** |

The single address was the importer's HEAD; each mark now carries the PR head it
was actually made against. It is not 100% because the population is *defined* as
marks whose id is missing from the store's existing `@work` index, so it is a
biased subset by construction — the honest reading is the delta, not the level.

**A reindex is NOT the repair, and it is worth saying because it looks like one.**
Reindexing `@work` re-mints the live index under the current scheme; it does not
touch the id already frozen inside a record. Pre-bump records keep pre-bump ids
forever. Only re-CREATING the records — which the import does — gives them ids
this build can mint. The ~140 organic pre-bump records have no such path and are
exactly the residue the queue exists for.

**Two traps that cost a round each, for whoever reproduces this.** `indexCommit`
reaches a submodule through the WORKING TREE, so a `--no-checkout` clone collapses
the whole index to null and every record answers `unaddressed`. And
`.codemapignore` is untracked in both live universes (kept in `.git/info/exclude`),
so a fresh clone without it indexed 9,828 anchors where the live repo indexed
4,412 — a 2.2x difference that silently invalidates any comparison.

One trap the measurement cost a round to find: `locate` on a `--no-checkout` clone
answers `unaddressed` for everything. `indexCommit` recurses into a gitlink through
the WORKING TREE, and a missing submodule directory correctly collapses the whole
index to null. Measure on a repo with its submodules checked out.

One gap it found and did not fix: `whereWere` returns a bare `absent` without
asking whether this build could have minted that id at all — the classification
`resolveAnchor` exists to make. It changed no number here (no drift was present),
but the rule holds and the code does not apply it.

### The pain this is actually for — observed, and located

Findings, not docs. A doc can be rewritten: its value is its prose, its citations
are replaceable, and re-documenting against current symbols is a legitimate repair.
A finding is a claim about specific code at a specific moment, and re-pointing it
wrongly is the exact failure `witness`/`sourceRef` exist to prevent.

**Reported from codemap as deployed off `master`:** unplaceable findings surface in
the UI, and an agent then gets stuck re-citing them because they appear against
unrelated pull requests — noise that compounds, on the surface whose whole job is to
reduce a reviewer's load.

**The mechanism, located.** It is not the sidecar. Shared findings are scoped per
PR (`findings/<pr>`) and nothing there explains it — which is where the search
stopped the first time. **Local annotations carry no PR scope at all**, and the PR
page's findings panel was reconstructing one client-side:

```js
// web/app.js, offStoryFindings() — before the fix
.filter(q => (q.postedRef && q.postedRef.pr === pr) || q.targetResolved === false)
```

The rows come from `/api/queue?all=1&resolved=1`, which is universe-wide. The first
disjunct is PR-scoped; **the second has no `pr` term in it**. So every finding on
the map whose target is not in `@work` — every orphan, every finding raised on
another branch — was listed on every pull request alike, under a heading saying it
was this one's business. An agent handed that list re-cites them against whatever
change is open, which is the reported symptom exactly.

Two things made it hard to see. It reads as a *deliberate* second case (the comment
above it named "something whose target has gone" as one of two cases that are "this
PR's business"), and `targetResolved` is a true statement about the CODE — it just
says nothing about which change is responsible for it.

Fixed by `offStoryReason` (`src/pr.ts`) and `prOffStoryFindings` (`src/ops.ts`): a
finding off the worklist is admitted only on a tie to this pull request — posted to
it, aimed by `publishPath` at a file it changes, last seen in a file it changes, or
witnessed at its head. The residue is counted (`stranded`) rather than dropped
silently — open findings this build cannot place, posted nowhere and settled by
nobody. A count is not a workflow; `/api/orphans` is served and has no page. It is
there so they do not go back to being found one at a time by tripping over them.

**What this does NOT fix, and it is the half the recovery arc is for.** The finding
is now off the wrong pull request; it is still unplaceable. `"at-head"` only ties a
finding raised against a *snapshot* of the head — one raised with the branch checked
out records `sourceRef: "@work"` and is tied by its file or not at all. Both are
`sourceRef` questions with an address, which is the input the commit-graph
derivation above takes.

## Clearing a doc nobody can place

A doc whose citations all resolve `incomparable` reads `unverifiable`, and there is
no way to clear it. `confirmNode` has no live hash to add and says so
(`unconfirmable`). `ackHole` refuses, because the status is not `dangling` — and
could not help if it ran: `e.dangling` is empty for such a doc, so the tombstone
would cite nothing at all, and one carrying the prior version's hashes is judged
foreign by §6's inversion and loses to the content version. **The tombstone judges
its own author foreign.**

A regression from this branch's work; `main` always answered `dangling` here.

**Decided 2026-08-23 (Izzie): the build does not get to assert a removal it cannot
see, the refusal files triage work instead of erroring, and a `NodeVersion` gets
somewhere to put the judgment.** Three parts, and the middle one is what stops the
first from meaning "the doc is lost".

### 1. The refusal stands

Retiring the doc on an incomparable absence launders *cannot see* into *is gone*,
which §6's own rule forbids: an id this index could not have minted is not evidence
of absence. Hiding is the direction with no recovery.

### 2. The refusal files triage instead of erroring

`ackHole` on an `unverifiable` doc files a `question` annotation on the node,
assigned `investigate`. Nothing new is built for it — the queue, the assignment, the
agent-proposes/person-closes ratchet and the MCP surface all exist, and this is
`review_queue`'s own shape: work a person handed to an agent.

**Entered by an ACT, not by a state.** Every unverifiable doc is not queued work: a
`HASH_SCHEME` bump made 985 of 985 docs unverifiable at once, and
`sharedDocs.needAttention` already excludes them for exactly that reason. What is
queued is one person's attempt to clear one doc, so the queue is bounded by acts
rather than by the store.

The item carries the address the recovery arc above takes as input: the unplaceable
ids, their last-known file and symbol wherever a snapshot or the retained set has
one, the version's `createdCommit`, and the marks the ids were minted under. It asks
for different work depending on whether a locator survived, because those are not
the same job and one of them is not solvable yet.

**One evolving investigation per doc, not one question per version.** The ids and
the commit ARE the question, so an item describing a version that no longer wins
would send an agent to repair citations the doc no longer has: a later attempt
revises the open item rather than filing beside it or leaving it stale. An item that
has been ANSWERED and is still accurate is left alone — it is waiting on a person,
and re-asking would discard an answer nobody has read.

Identity is a digest of the EVIDENCE — version, commit, and the sorted ids with
their marks and locations — written into the item as one line. Not the rendered
text: that carries instructions and wording too, so a copy edit would read as new
evidence, revise an answered item and re-assign it, and re-assigning clears the
outcome. Prose can change freely; the key cannot.

**The guard is on the evidence, never on the headline status.** `evalVersion` ranks
`dangling` over `stale` over `unverifiable`, so a version with one absent citation
and one incomparable one reads `dangling` — and `ackHole` built its tombstone from
`e.dangling` alone, silently dropping the citation nobody could place. That retired
the whole doc on the strength of the comparable subset while the code behind the
foreign id might be sitting right there. **No tombstone while ANY citation is
unplaceable**, whatever the status says.

Which of the two refusals it gets then depends on whether the doc still has a
subject:

- **Something resolves** (matching or drifted) — refused the way `retireSharedDoc`
  refuses it, *"still in this checkout — write a new version"*, and NOT queued. The
  answer is a new version, not an investigation.
- **Nothing resolves** — queued, and the item asks only about the citations that
  cannot be placed. The decidably-gone ones are not in it: they are not what blocks
  retiring, and carrying them would make the question checkout-sensitive, so
  switching branches could revise it and discard an answer.

### 3. Recording the judgment — DESIGNED, NOT LANDED

The third part is what would let triage conclude "it is genuinely gone" and retire
the doc anyway. A tombstone written out of an unverifiable state inherits the prior
version's hashes, so §6's inversion counts them against it and the content version
wins: **the tombstone judges its own author foreign.** The fix is to record the
judgment's own provenance and let a like reader honour it.

The rule as drafted was:

> An incomparable citation SUPPORTS a tombstone when the tombstone's own `judgedBy`
> is comparable with this index's derivations, and counts against it otherwise.

**It is not landing in that form.** A review round took it apart, and five things
have to be settled first. They are recorded here rather than solved on the way past,
because each one is a decision and not a detail:

1. **The `anchorScheme` under-rejection bypasses the rule entirely.** A citation
   minted under `ANCHOR_SCHEME` 2, read by a scheme-3 index, resolves **`absent`**
   rather than `incomparable` — `derivationMark` excludes `anchorScheme` from the
   fingerprint, and `matches` says so about itself (`anchor-resolve.ts`). So
   `ackHole` is already permitted, the tombstone is already written, and `judgedBy`
   never participates. Scheme is gated out of band (`checkManifest`, `readSnapshot`,
   `migrateOverloads`) — this is a pre-existing hole, not one the rule opens, but a
   rule that cannot see the commonest cause of a re-minted id is worth less than it
   looks.
2. **There is no singular "the build's derivation".** *(Decided 2026-08-23: the
   aggregation rule is PER-CITATION, judged against the derivation the citation's
   own marks name. A citation with no marks at all has no language to test and
   counts against the tombstone.)* An index holds one tag per
   grammar and an incrementally updated ref legitimately holds several generations,
   so `judgedBy` is a SET and the aggregation rule has to be stated. "Any writer tag
   matches any reader tag" is unsafe — a matching C# tag would authorize an
   incomparable Python citation. "All must match" resurrects every tombstone on a
   branch that merely lacks an unrelated language. Per-citation is better and the
   citation's own marks name its grammar, but an id with no marks at all has no
   language to test.
3. **"The reader is in exactly D's position" is too strong.** *(Decided 2026-08-23:
   weaken the claim, keep the rule. A comparable reader shares the MINTING FUNCTION,
   not the checkout and not the conclusion that the subject is gone. That limit is
   already true of every tombstone — `dangling` deliberately includes renamed code —
   so `judgedBy` neither adds it nor removes it, and the rule should stop claiming
   otherwise.)* Comparability gives
   the same minting function, not the same checkout: a later D-compatible checkout
   can hold a renamed incarnation of the subject under another id. True of tombstones
   already; `judgedBy` does not strengthen it, so the claim should not be made.
4. ~~**The index fallback does not do what it says.**~~ **CLOSED (2026-08-23),** and
   it was sharper than written. Both halves were real; one of them was real for a
   different reason.

   `resolveAnchor` gained a fourth answer, `undetermined`: not here, and this index
   cannot say whether it could ever have been. An index with no usable derivation
   tags produces absence for free, and only a POSITIVELY established absence is
   evidence a removal holds. Every other caller treats `undetermined` exactly as it
   treated `absent`, which is what they did before it existed — a content version's
   question is still "is the code here", and the answer is still no.

   **The tie was real after all, for this case.** An earlier read of this blocker
   claimed the content version already won 0-vs-1, because `unverifiable` is out of
   content badness while undecided is in tombstone badness. True for `incomparable`
   — and false here, because `undetermined` is `dangling` for a content version and
   therefore scores. Both sat at 1, and `selectWinner` broke it by recency, which a
   removal wins by construction: it is written after the thing it removes. So
   `selectWinner` now prefers SHOWN over hidden at equal badness. Hiding has to be
   strictly better, never merely equal. A legitimate removal is unaffected — it
   scores 0 against the content version's dangling and never reaches the tie.

   The ordering half is fixed too: the positive-match loop now runs BEFORE the
   `anyUntagged` fallback, so one legacy row beside a tagged one can no longer throw
   away a match that had already been found.

   **Where `undetermined` STOPS, and it is load-bearing.** An index with no rows at
   all keeps answering `absent`. The first cut of this made it `undetermined` too,
   which is defensible and broke a real test on the spot: an index scoped to a doc's
   citations is empty exactly when all of that code is gone, which is the situation a
   tombstone DESCRIBES. Every legitimate retirement went inert. `undetermined` is
   therefore only the partially-upgraded window — untagged rows sitting beside tagged
   ones — and the empty index stays the honest `absent` that `ackHole` needs to
   acknowledge a hole at all.
5. **A shared-only doc has no path.** `ackHole` is local and `annotate` validates a
   node target against `loadNodes`, which reads local `node_versions`. A doc that
   exists only on the sidecar cannot be queued by this route at all.

The carrier, when it lands, should be tombstone-only and carry the investigation
rather than only the build — `removalJudgment { indexDerivations, triageId,
rationale }`. A content version already has finer provenance per citation, and its
accepted set accrues confirmations from several builds over time, so one
creation-time stamp on it would be misleading the moment anyone confirms it
elsewhere. `retireSharedDoc` already demands a rationale and then drops it from the
durable event; a judgment that licenses hiding should keep its reason.

**Until then the doc is not clearable — and that is the point of part 2.** It is
queued, not lost, and the queue holds the evidence a retire would need.

### What triage can conclude

- **Re-cite it** with `update_node` — add the current anchor, drop the old id — and
  the doc is ordinary again. Every existing path then works. This is the outcome to
  want, and the reason the recovery arc is upstream of this rather than replaced
  by it.

  **Available today only when the replacement can be found**, and that splits on
  whether a locator survived. With a last-known file and symbol (a snapshot or the
  retained set kept one) git answers the rest, and the queue item says so. Without
  one, `createdCommit` plus an opaque `a_<digest>` is not enough on its own: the id
  is a digest OF file plus symbol path, so the commit has to be indexed and read.
  `snapshot` takes a `ref` for exactly that — it indexes any commit straight from
  git objects, no checkout. It does not pair anything: that index mints ids under
  THIS build's derivation, so it yields that commit's symbols to judge against, not
  a match for the old id. Making the judgement automatic is the recovery arc, and
  it is not built — an agent that cannot make it by hand should report the blocker,
  which is a useful answer.
- **It is genuinely gone.** Retiring needs part 3, which is not built. The agent's
  answer is preserved for it rather than being rediscovered later.

An agent may not retire in any case: it is a closure, the rule `retireSharedDoc`
already enforces — and which `shareDoc` now enforces too, because publishing a
version with `removed: true` through the opaque route was a way round it. Such a
tombstone had to cite live anchors to pass validation, so it lost to any content
version — until that code was deleted, at which point it began winning. A planted
tombstone is worse than a refused one.

## What would change my mind

- **If the pairing invariant cannot be pinned.** The whole design rests on an id and
  its neighbouring hash sharing a build. If a carrier turns up where that is false
  and cannot be made true, that carrier needs a receipt after all — and the struct
  comes back for it alone, not for all six.
- **If `derivationFor`'s local dictionary turns out to be usually empty in
  practice.** Then most foreign fingerprints degrade to the four-field
  over-rejection, and `hashScheme` bumps start marking ids incomparable for nothing.
  Measurable: count distinct rows in `derivations` on a real store over time.
