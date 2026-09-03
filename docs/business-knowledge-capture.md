# Business knowledge capture — the measurement, and what it settled

> **Kind: measurement + settled design — NOT BUILT.** Measured 2026-09-03 against
> `b12f42e`, over one person's own transcript archive. It supersedes
> `docs/PROPOSAL-drive-by-requirements.md`, which is gone from the tree and — unlike the
> retired root proposals — was **never committed**, so there is no `<sha>^` to recover it
> from. Its argument is carried here rather than cited: the gap, the two signals, the
> refusal to let capture become a proposal, and the reason paraphrase is inadmissible.
> What changed is the framing (knowledge, not requirements), the storage (its own scope,
> not the law scope), and the fact that there are now numbers.

The standard has no supply between seedings. `adjudicate_problem`'s
`requirement-misstated` is described in this tree as *"the commonest real outcome and the
one that otherwise evaporates — an exception that lives in one person's head until a
discrepancy forces it out"* — and that mechanism has a precondition it cannot meet: **a
discrepancy needs a requirement to be discrepant with.** A rule stated nowhere is never
forced out.

The claim this document tests is that there is a moment when such a rule is fully
visible, and the programme discards it: a **redirect** ("no, that's not right") is an
unwritten rule surfacing *after* violation, a **question answered** is one surfacing
*before* it. Both are already paid for — the principal was engaged, read the situation
and stated the rule — so capturing costs a tool call rather than an adjudication.

---

## What was measured

Every `type: "user"` turn with STRING content across six project directories in
`~/.claude/projects` — two Acme repositories under `/working`, their two
`~/source` predecessors, and codemap's own directory. 2025-11 through 2026-09.

### 36% of what looks like a person talking is not, and this is the load-bearing filter

A measurement that skipped this is wrong by more than a third, and wrong in the direction
that flatters the proposal.

| removed | n | what it is |
|---|---:|---|
| synthetic | 1,461 | `<task-notification>`, `<bash-input>`/`<bash-stdout>` (the `!` prefix), slash-command expansions, hook output — all delivered as user turns with string content |
| compaction summaries | 179 | `"This session is being continued from a previous conversation…"` |
| pasted material | 101 | logs, JSON, HTML, stack traces — the person hit paste, they did not talk |
| resume noise | 10 | "please continue", "another brownout" |

**The compaction summaries are the trap.** They are prose *about* a session, and they
QUOTE rules the person stated in a session this one cannot see — so counting them
double-counts the exact phenomenon being measured, using text the model wrote.

Left: **3,055 spoken turns** — 2,438 across 534 Acme sessions, 617 across 42 codemap
sessions.

### Rate

| | Acme repos | codemap |
|---|---|---|
| redirect-marked | 0.67/session | 1.95/session |
| redirect + domain vocabulary | 0.22/session | 0.48/session |
| answering an agent's question | 0.84/session | 3.43/session |

codemap runs ~3x the Acme rate because it is a design conversation rather than an
implementation one. Its rules are engineering conventions, not business law, and it is
not the population this is for.

### From candidates to rules: precision, then recall

All 120 Acme redirect+domain turns were read. **~33% carry a durable, statable
piece of knowledge**; the rest are task instructions, UI defect lists and planning.

Recall was checked separately, because a marker-based filter cannot see a rule stated
calmly. In 26 random NON-redirect turns, one carried a rule (*"the entire payments-seam
surface should be cent precision unless banks can genuinely support something finer"*).
At ~4% over the ~2,000 such turns, that is **~80 rules the filter never sees, against
~40 it finds.**

> **≈120 durable pieces of business knowledge across 534 sessions — one every four to
> five sessions, over ten months.**

Two things follow, and they point opposite ways:

- **The load is nothing.** ~120 tool calls in ten months. The proposal's bounded-rate
  claim holds with enormous margin, and the ergonomic objection — that capture fires
  during an interruption the person was already annoyed by — is answered by the
  frequency: this is not every correction, it is one every few days.
- **Capture volume is therefore NOT where the value is.** A corpus this size is one a
  person could plausibly maintain by hand. What they demonstrably do not do is maintain
  it by hand (below). **Retrieval and promotion carry the value; a capture verb with a
  weak read path buys nothing.**

### Recurrence — and the first pass was wrong

Does the same rule get restated in a later session? That is the question the whole idea
turns on, because the value is preventing a second agent from making the first agent's
mistake.

**First pass: 6 of 11 themes recurred, tenant isolation in 11 distinct sessions. That was
wrong.** A broad regex counted the *topic* appearing in pasted plans and quoted review
findings, not the person asserting the rule. Recorded here rather than quietly fixed,
because the inflated number is the one that would have sold the feature.

Tightened — dispatch turns dropped (`^Implement the following plan`, `^Design a
detailed`, `^Conduct a thorough`, `^Please migrate`, `^#`), quoted lines dropped (`^>`,
`^File.cs:123`), identical turn text deduped (a resumed session stores the turn twice):

**4 of 10 hand-picked themes were asserted by the person in 2+ distinct sessions.**
Tenant isolation is 2, not 11.

The cleanest: *"rating profiles are legacy; templates and instances must never reference
them"* — stated 2026-01-09, 2026-01-14 and 2026-03-06, twice after an agent had used the
old system anyway.

Selection bias, stated: the themes were picked from the window where they appeared, so
their base rate is inflated. Each recurrence *outside* the source session is still
independent evidence.

---

## The two findings that argue for this better than the rate does

**Manual routing already happens — 15 turns across 14 sessions (0.028/session).**

> *"add a note to CLAUDE.md to NEVER add unconditional filtering requirements to
> endpoints … as it breaks the ability to page through entities in admin and similar
> UIs"*
>
> *"We should add a note that business rules currently prohibit that remedy to
> overcapture."*

That is the workaround, and it is the same shape as the bug minted with the rationale
*"so it survives the PR closing"* that `docs/finding-backlog.md` was built on. When a
record kind is missing, people route around it into whatever record they do have —
there, a bug; here, CLAUDE.md prose with no provenance and no promotion path.

**Expert blindness, caught in the act:**

> *"We need to make sure the profile used to generate a quote is stored on the
> quote, however it can never be returned to the operator **of course**."*

A rule stated for the first time, at the moment of its violation, with *of course*
attached. That is the mechanism the proposal argues from, with a timestamp on it.

---

## `cl-dream` — the batch half already exists, and why it stopped

`~/Desktop/cl-pprint/cl_dream.py`: mine new transcripts → parallel Sonnet subprocesses
extract lessons → Opus edits CLAUDE.md → an optional cleanup phase removes stale content.
356 sessions processed across five projects; 202 lesson files cached; `last_run:
2026-01-30`.

**It did not decay, and an earlier draft of this document said it did.** It was retired
for two structural reasons: 1M context removed much of the need for session-to-session
consolidation, and it is built on `claude -p` subprocess spawning, which has long-term
plans to be phased out from subscriptions.

What survives that correction is narrower and still decides the shape:

- **A batch importer built the same way inherits a deprecated foundation.** An MCP verb
  inside codemap does not.
- **It aims one layer off.** Its lessons are break-fix coding mistakes — the read sample
  is `operatorName` null-handling and empty parentheses in string interpolation. **4 of
  202 lesson files mention "business rule" at all.**
- **Its output is model paraphrase**, synthesized into CLAUDE.md prose with no verbatim
  quote and no provenance — the exact artifact this design holds is inadmissible as the
  rule.

The demand is proven by the tool having been built. The gap is the layer and the
structure, not the mining.

---

## What the corpus is made of — and why `kind` exists

Classifying the ~36 knowledge-bearing turns among the 120 read:

| kind | share | promotable? | example |
|---|---:|---|---|
| **rule** | ~64% | yes → a requirement | *"templates and instances should **never** be referring to profiles"*; *"null != 0.0 … treated as sacred to avoid extensive financial losses"* |
| **definition** | ~14% | no | *"it's really 'Available to Withdrawal' and 'Available to Spend'"*; *"Hold means a claim by a supplier to a Credit Line amount (reduces available)"* |
| **context** | ~22% | no | *"the profile system is legacy anyway, instances are where we are focusing now"*; *"a lot of that code was demo grade"* |

**About a third of the log would never promote to anything, and that is the
justification for the design rather than a defect in it.** A definition like *Available
to Spend versus Available to Withdrawal* is not a requirement — it cannot be audited, it
binds nothing, and it is precisely the tacit knowledge an agent gets wrong. It has
nowhere to live today.

---

## Settled design

Renamed from *drive-by requirements*. **"Requirement" overclaims** — these bind nothing
until ratified, which is the whole point — and **`drive_by` collides** with
`report_defect`'s context discriminator, which means something adjacent but different.

- **Its own scope, `knowledge/standard`** — workspace-scoped like law, but NOT in
  `LAW_SCOPE`. Own fold, own projection table, own `MATERIALIZER_VERSION` bump. Sharing
  the law scope would make a scratchpad look like law at the storage layer, put its
  volume on every standard read, and risk it reaching `pending_specs`, which is the one
  queue it must never create load in.
- **The promotion link points ONE way.** `Operation.provenance` names the knowledge
  entry; the entry records only that it was promoted. Neither fold depends on the other —
  the `commentsByOthers` precedent in `docs/requirements-architecture.md`, which accepted
  an unverified residue rather than couple two folds.
- **`kind`: `rule` | `definition` | `context`.** Only `rule` has a promotion path;
  `promote_knowledge` filters to it by default rather than presenting the whole queue as
  a proposal backlog.
- **`basis`: `stated` | `inferred`, structurally checked.** `stated` requires a verbatim
  `quote`; `inferred` REFUSES one — you cannot quote what you inferred. The `report_defect`
  discriminator move: make the invalid shape unrepresentable. It cannot prove an agent did
  not mislabel, and that limit is honest rather than solved.
- **The quote and the model's restatement are separate fields, and the quote travels
  with the restatement everywhere.** The model that just got the rule wrong is the worst
  available summariser of it.
- **The ratifier sees the quote.** `getSpec` renders the originating entry's verbatim
  words on the promoted operation. The ratifier is the person who allegedly said it, so a
  fabricated quote is caught at the only moment it is about to bind, by the only person
  who can falsify it.
- **Anchors are breadcrumbs and a retrieval key, never a citation.** A requirement cites
  nothing (`docs/cross-universe-standard.md`); where the code is goes in a
  `declare_pointer` at promotion.
- **Retrieval is targeted, never bulk.** By section (the agent's guessed, revisable
  taxonomy path), by anchor through `context`, and by `search`. Two hundred entries in
  every context window is the CLAUDE.md failure with worse economics. The knowledge base
  is deliberately the low-visibility tier; **promotion to a requirement is how something
  graduates to always-visible**, because requirements get pointers and audits.
- **A promoted entry LEAVES the active read**, superseded, pointing at the requirement it
  became. Without that guard the requirement is amended a year later and the entry still
  carries the original wording — two statements of one rule with the stale one easier to
  find, which is the `Pricing-Engine.md` failure the positive-law section exists to
  prevent.
- **Capture is announced, never silent.** One line, in session. Somebody's verbatim words
  are entering a log their team reads; doing that silently is surprising in a way that
  would sour the feature the first time anyone noticed. It is also the cheapest
  correction channel — *"no, that was a one-off"* costs a sentence, at the only moment
  anyone has the context to say it.
- **Dismissal is principal-granted**, or an author withdrawing their own unpromoted
  entry. Promotion needs no new gate: it is drafting, drafting is open to any actor, and
  the refusal-by-default already exists downstream at `ratify_spec`.

---

## What was NOT measured, and cannot be from here

**The target population is absent from the sample.** This is one person's archive, and
that person writes things down — CLAUDE.md pitfalls are *numbered*, and they built
`cl_dream.py`. The colleague this is for is the one who does not. The bias direction is
at least knowable: a less documentation-inclined expert leaves more rules unwritten, not
fewer, so ~120/534 sessions is a **floor**.

**And their archive probably does not exist.** `cleanupPeriodDays` defaults to 30 days;
the archive measured here survives only because it is set to 99999. So for them:

- retroactive mining reaches back one month, not ten;
- **their rules are being deleted continuously**, which makes in-session capture the only
  channel that exists rather than the more convenient of two;
- capture must be recognised by the agent unprompted, because somebody who does not
  document will not invoke a verb.

Worth doing today, independent of any of this: **have them set `cleanupPeriodDays`.** One
settings line, costs disk, and turns their next months into raw material whether or not
this ships on time.

---

## Re-running it

The number matters because it is the only one in the programme that should **fall** as
things improve — findings, audits and coverage all rise when the system is working, which
makes none of them a health signal. Recurrence should fall faster than the total: a rule
captured twice is a rule nobody retrieved.

A count with no recorded derivation is a number that gets ratified without being
checkable (`pin_population` exists for this reason one level down), so the derivation is
above rather than in a lost scratch file:

1. Extract `type:"user"` turns with STRING content, carrying the tail of the preceding
   assistant text — that tail is the only local evidence for `question` versus `redirect`.
2. Apply the four filters in § *36% of what looks like a person talking is not*. **Verify
   the filter removed something it should have**: an unfiltered run reports ~4,800 turns
   and a filtered one ~3,050.
3. Rate is per distinct session, never per turn — sessions vary in length by two orders
   of magnitude.
4. For recurrence, drop dispatch turns and quoted lines and dedupe identical text, or the
   count measures how often a topic appeared in a pasted plan.

**What a regex cannot do, and an agent can:** the marker-based filter finds roughly a
third of what is there (§ *precision, then recall*). An agent capturing in session has
the context the regex lacks, so these rates are a lower bound on the phenomenon, not an
estimate of the feature's yield.
