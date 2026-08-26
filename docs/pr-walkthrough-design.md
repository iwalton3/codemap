# Design: the PR walkthrough as an auto-built stacked PR

> **Kind: current reference** — describes how codemap works today. Trust it; fix it if it is wrong.
> BUILT: `src/walkthrough.ts`, `src/shared-walkthrough.ts`, 3 MCP tools.

**Status:** **BUILT.** Corrected 2026-08-26 — this said "proposal, for review before
implementation" while `src/walkthrough.ts`, `src/shared-walkthrough.ts` and the three
`pr_walkthrough*` MCP tools were shipped. Parts of the design have since been revisited;
where this and the code disagree, the code is what runs
**Problem:** "people keep flinging 22 KLOC PRs at me and they're basically impossible
to review coherently."

---

## 1. What is wrong with the current walkthrough

Measured on two real pull requests:

| | #264 | #227 |
|---|---|---|
| changed symbols | 200 | 541 |
| chapters | 37 | 64 |
| of which from spec sections | 28 | 50 |
| symbols that fell through to directory grouping | 17 | 57 |
| spec sections binding nothing | 31 | 166 |

The fallback is not the problem — 57 of 541. The problem is that **the spec
document's section structure became the chapter structure**, and a spec's sections
are not features:

- `Key Locations` claimed 33 symbols and `Common Pitfalls` 34. They are a reference
  table and a page of advice. They bind heavily *because* they name many
  identifiers, which is exactly backwards.
- One feature fragments across `3.1 Changed: QuoteReleaseCreated`,
  `3.2 New: QuoteReleaseConfirmed`, `3.3 Changed: …`, `3.4 New (Phase 2): …` —
  four chapters of 1–3 symbols that are one thing: the event model. Granularity is
  whatever heading depth the author happened to use.
- Chapter prose is the raw spec text, verbatim. It reads as an explanation of
  everything because it *is* the specification — never written as a reading guide.

And the deeper issue: **the spec is not ground truth.** #264 "lied about what it was
about and included 4 drive-by changes not in the spec." Any structure derived *from*
the spec inherits its lies. The walkthrough has to describe what the code does.

---

## 2. The model

Two levels, replacing today's single flat one.

```
Feature          a coherent capability this PR delivers or changes
  └── Chapter    a unit worth describing, and worth signing off as a unit
        └── Symbols
```

**Feature** — "Supplier order confirmation", "Document block nesting",
"Drive-by: airport reference data refresh". Carries a short statement of what it
aims to do and why it is in this PR.

**Chapter** — "the state machine on Quote", "the confirm/decline endpoints",
"the reminder job". This is the review unit (§5).

**A chapter body is an ordered sequence of BLOCKS, not prose followed by a symbol
list.** Prose sits *between* symbols:

```
Chapter — the state machine on Quote
  prose    The aggregate owns every transition. Read the guard first:
  symbol   Quote › Apply(QuoteReleaseCreated)
  prose    …which is the only place Pending is enforced. Confirmation
           is then a straight fold:
  symbol   Quote › Apply(QuoteReleaseConfirmed)
  prose    The reminder job is the one writer outside the request path,
           so it is the one that can race:
  symbol   ReleaseConfirmationReminderJob › ProcessQuoteAsync
```

That interleaving is the whole point: it is what makes it a walkthrough rather
than a wall of text with ten code boxes attached underneath.

**Symbols** — as today: anchors, with their diff, review state and findings.

A 22 KLOC PR becomes ~6 features and ~20 chapters. That is a reviewable object.

---

## 3. Where the structure comes from

An agent walks the PR and emits the structure; codemap validates and stores it.
**The human invokes it** — open Claude Code, "map out PR 227" — and **the
instructions for how to do it live in the MCP tool descriptions**, the way the
findings content contract does. codemap never shells out to a model: the golden
rule holds, and the agent doing the reading is the one the human is already talking
to.

```
pr_packet(227, limit, offset)      MCP — ranked symbols + source + spec text
        ↓  (the agent reads code, spec, diff)
pr_walkthrough(227, features[])    MCP — ingest, validate, store
        ↓
the web walkthrough renders features → chapters → blocks
```

The agent's output is a document of features and chapters citing anchor ids. It is
ingested the way findings already are (`pr-ingest`), against the PR head, so a
chapter can cite a symbol that exists only on the branch.

### 3.1 Coverage is an invariant

**Every changed symbol in the code lane lands in exactly one chapter, or is
reported as unaccounted for.** No floating claims, applied to the walkthrough:

- a symbol in no chapter goes to an explicit `Unaccounted for` bucket, visible in
  the UI and in the ingest result;
- a chapter citing an anchor not in this PR is rejected at ingest;
- a symbol in two chapters is rejected — the reviewer must not read it twice or
  wonder which sign-off counted.

This invariant is what makes the walkthrough trustworthy enough to review *from*.
It is also, for free, the drive-by detector (§4).

The consequence is concrete: **anything not covered here is what you end up
reviewing on GitHub instead**, unviewed, without context. So an uncovered symbol is
not a cosmetic gap — it is work escaping the tool. The bucket is loud for that
reason, and lane policy still applies: generated and vendored code is *expected* to
be uncovered and is counted separately from code that simply was not walked.

### 3.2 The agent is told to account for everything

The tool description carries the contract, in the same way the findings `comment`
field does: describe what the code does; every changed symbol belongs somewhere;
if a cluster does not fit the stated purpose of the PR, that is a feature of its
own named as such.

---

## 4. The spec is evidence, not structure

codemap already computes `specWithoutCode` — spec claims with no code behind them.
This design adds its dual:

| signal | meaning | today |
|---|---|---|
| spec section with no code | claimed but not shipped | exists (`specWithoutCode`) |
| **code in no spec section** | **shipped but not specified — a drive-by** | **missing** |

Both belong at the top of the walkthrough, as *findings about the PR itself*:

> **4 changes are not in the spec.** `fix/airport-reference-data-refresh` (3 symbols),
> `AddDataProtection` registration (1)…

That is precisely the #264 complaint, surfaced rather than absorbed. The spec still
feeds the agent as an input — it is usually right — but it never dictates structure,
and where it disagrees with the code the disagreement is the output.

---

## 5. A chapter is the review unit — as a SHORTCUT, not a replacement

Today sign-off is per symbol: 541 decisions on #227. A chapter-level mark that rolls
up its symbols makes it ~20.

- Signing (or viewing) a chapter applies that mark to every symbol in it, witnessed
  exactly as today — per-anchor body hashes, so staleness still works at symbol
  granularity and nothing about the attestation model changes.
- Both attestations, as everywhere else: chapter-`viewed` and chapter-`signed` are
  different acts.
- A chapter shows `12/14 signed`, and signing it covers the rest.

**Per-symbol and per-file marking stay, and so does commenting on them.** The
chapter mark is a shortcut that saves clicking a hundred buttons; it is not a new
granularity that replaces the old one. A reviewer who wants to sign three symbols in
a chapter and leave the rest must still be able to, and raising a finding is
unchanged.

This is why chapter boundaries matter: a chapter should be something a person can
hold in their head and then say yes to.

### 5.1 A sign-off covers what it contains

The other source of the 541 decisions is not chapters at all — it is nesting. A PR
that adds a class puts the class on the worklist *and* every member it changed, and
a member is often chapters away from its type. On #227, 385 of 541 steps sit inside
another step.

The reviewer has already read them: an anchor's pane is its whole span, so a type's
pane is the entire class and its diff is every changed line inside it, member bodies
included (a type's *hash* is only its shell — that is what makes the members
separately stale-able, not what the pane shows). Asking for a second sign-off on
each member asks the reviewer to read the same lines twice.

So signing or viewing a symbol also marks every symbol **this pull request touches**
inside it (`prStepMark`, `containedAnchorIds`):

- **Ordinary per-member marks underneath**, each witnessing its OWN hash — so a
  later edit to one method stales that method and leaves the rest standing.
- **Cover rows say so** (`Review.coveredBy`): the tick reads `↳`, not `✓`. A
  borrowed approval never renders as one made here — the same rule `via` follows.
- **Bounded by the change.** The cover reaches only what the PR touches. A class
  with forty methods and two changed covers the two; covering the other
  thirty-eight would turn one click into a review claim over code this branch never
  went near, and inflate the map's coverage with it.
- **Containment is decided by the byte span**, not by `symbolPath` alone: two
  same-named types in one file share a path prefix. A symbol with no recorded span
  is not covered.
- **Withdrawal is symmetric and precise.** Unsigning the type clears the rows it
  wrote; a member the reviewer signed in its own right survives, and a cover never
  overwrote it in the first place.

It is a PR-scoped route (`/api/pr/step_mark`) rather than a flag on `/api/review`,
because "what this change touches" is a question only a PR context can answer.

---

## 6. A walkthrough is a claim about code, so it goes stale

This is the part that keeps it honest, and it is the existing model applied
unchanged: a chapter's walkthrough is witnessed against the body hashes of the
symbols it cites.

- the submitter pushes → symbols change → **those chapters go stale**, not the
  whole walkthrough;
- a stale chapter shows as stale and its sign-off reverts to needing attention;
- re-walking is incremental: the agent is asked for the stale chapters only, which
  is what makes this affordable on a PR that moves daily.

Without this we would have built the thing codemap exists to prevent: a document
that silently stops describing the code.

---

## 7. Ordering

Features in dependency order where it can be derived (a feature whose symbols are
cited by another comes first), else by size. Chapters within a feature keep the
existing spine order: command → handler → event → aggregate → read model → job.
The agent may override both; it has read the change and we have not.

---

## 8. Degradation

The walkthrough is optional. With no agent pass, the PR page shows what it shows
today — the lane strip, the ranked worklist, spec sections — plus a clear "no
walkthrough yet" with the command to produce one. Nothing regresses for a small PR
where the current view is already fine.

---

## 9. What changes in the data model

- **New:** a walkthrough per (universe, PR, head) — features, chapters, cited
  anchors, prose, witnesses. Stored beside the other PR-scoped records.
- **Reused unchanged:** anchors, review marks, findings, triage, lanes.
- **Repurposed:** today's `StoryChapter` becomes the fallback view, not the model.
- **Promotion** (a chapter → a durable node) keeps working, and gets better: it
  promotes an agent's description of what the code does rather than a slice of spec
  prose.

---

## 10. Surfaces

| surface | change |
|---|---|
| MCP | `pr_walkthrough` (write), and `pr_packet` gains what an author needs |
| CLI | `codemap pr-walkthrough <pr> <file.jsonl>`, `--dry-run` |
| Web | features → chapters → symbols; chapter sign-off; the unaccounted-for bucket; spec-vs-code disagreements at the top |

---

## 11. Open questions

1. ~~Who runs the agent?~~ **Settled:** the human asks Claude Code to map out a PR
   by number; the instructions live in the MCP tool descriptions.
2. **Chapter size.** Is there a target (say 5–20 symbols) worth enforcing, or is the
   agent's judgement enough? A chapter of 60 is not a review unit; a chapter of 1 is
   not worth a heading.
3. **Does a feature need its own sign-off**, or is "all its chapters signed" enough?
   Leaning: no — one shortcut level is the point, two is ceremony.
4. **Cross-PR features.** #239–#246 is a hand-built stack of eight. Should a feature
   be able to span PRs, so the walkthrough shows the whole stack? Out of scope for a
   first cut, but it changes where the record lives if we want it later.
5. **What happens to a chapter's sign-off when the agent re-walks and moves a symbol
   between chapters?** Sign-off is per anchor underneath, so it survives — but the
   chapter's own "read and understood" mark is about a grouping that no longer
   exists. Probably: the chapter mark goes stale when its symbol set changes.
