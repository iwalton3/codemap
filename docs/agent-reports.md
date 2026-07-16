# Design: agent reports — a witness-hashed, decaying cache of exploration

Status: **DRAFT / for brainstorm** (not approved). Sketch to argue over.

## Why

Every non-trivial agent task starts by re-deriving the same understanding: an
Explore agent reads 20–40 files to answer "how does settlement post to the
ledger?", writes a paragraph, and that paragraph evaporates when the subagent
returns. The next task re-explores from scratch. codemap already anchors
*durable* claims (docs) to hashed code; the gap is the **ephemeral** layer — the
90% of agent understanding that's too provisional to document but too expensive
to keep re-deriving.

The insight: an exploration answer is just a **claim with a shelf life**. It was
true against the code it read; when that code changes it may not be. codemap's
whole machinery — witness hashes, anchors, staleness — is exactly the tool for
"true at these hashes, decays when they drift." Point it at exploration output
and you get a cache that **self-invalidates** and, for the high-value entries,
**graduates into durable docs**.

## Prior art: `cl-dream` (cl-pprint)

`cl_dream.py` already mines Claude Code transcripts (`~/.claude/projects/*.jsonl`)
for exploration patterns. Worth borrowing from, and worth contrasting:

- **File-access heatmap** — counts `Read` calls per file across sessions;
  `pct = count / session_count`. Files >30% access → "Key Locations" in CLAUDE.md.
- **Explore-prompt mining** — collects `Task(subagent_type="Explore")` prompts and
  LLM-summarizes them into *recurring themes / knowledge gaps → suggested docs*.
- **Frequency-thresholded promotion** — a theme in 5+ sessions → CLAUDE.md; 2–4 →
  `docs/`; once → skip.
- It's an **offline batch** ("dream") that reads transcripts; it produces *gap
  reports for a human/agent to act on*, not a live queryable cache.

What that teaches us:

1. **Frequency ≠ freshness, and we want both.** cl-dream measures *popularity*
   (how often a file is read). codemap measures *validity* (does the answer still
   hold). They multiply: **hot × fresh = promote to a durable doc; hot × stale =
   the highest-value re-exploration; cold × anything = let it decay.** A report's
   worth is `freshness × frequency-of-its-region × recency`.
2. **Frequency thresholds are a real promotion heuristic** — reuse the "seen N
   times ⇒ document it" rule instead of inventing one.
3. **Explore prompts are questions** — they're the same shape as the review
   [questions loop](../src/ops.ts) we just shipped. An unanswered recurring Explore
   prompt IS a documentation gap; a saved report is a cached answer to one.
4. **Scraping works but couples to the transcript format.** cl-dream proves it's
   feasible; it also shows the cost (parsing an external, unstable JSONL shape).
   See "Push vs scrape" below — we take push as primary and keep a scraper only for
   the cross-session heatmap, which push can't produce.

## Core model

A **report** is one `(question, answer, read-set)` triple, where the read-set is
witnessed: the anchors the agent relied on, each with the code hash at read time.

- **Fresh** where every witnessed anchor's live hash still matches (answer holds).
- **Partially stale** — `k` of `n` witnessed anchors drifted; the report is
  demoted and annotated "verify these k areas", not hidden. (Binary hide throws
  away the 80% still valid.)
- **Dead** — freshness below a floor (e.g. <50% of load-bearing anchors fresh, or
  any *load-bearing* anchor removed). Drops out of retrieval; kept for archeology
  until GC'd.

Same witness mechanism as bugs/reviews/docs — no new staleness engine.

## Positions (argue with these)

1. **Push, not scrape, for the report itself.** The finishing agent calls
   `save_report` with `{question, answer, anchors}`. It knows what it read and what
   was load-bearing; that's higher signal than reconstructing intent from a Read
   log, and it gives the model control over what's worth keeping. (Opus is capable
   of naming its own citations — same as `document`/`report_bug` today.)
2. **Two-tier read-set.** `anchors` = the load-bearing citations (small, curated by
   the agent — decays slowly, high signal). Optionally `touched` = everything read
   (large, mechanical — a weak frequency signal, decays fast). Retrieval and decay
   key on `anchors`; `touched` only feeds the heatmap. Start with just `anchors`.
3. **Retrieval is anchor-overlap, not embeddings.** The strongest signal is *"I'm
   about to work in files X,Y — show me fresh reports whose read-set intersects
   X,Y."* That's set intersection over data we already store — **no vector dep**
   (keeps the golden rule). Text-match on the question is a secondary filter.
4. **Decay demotes, it doesn't delete.** Partial-fresh reports still surface, with
   a "stale areas" list. Only fully-dead reports leave retrieval.
5. **Promotion is the trust gate.** Reports are *unverified agent scratch* and are
   labelled so; they are **never cited-by a node** (the "no floating claims"
   invariant stays clean — only durable docs cite anchors as truth). A report earns
   trust only by an agent reviewing it and calling `document` (→ a real, versioned,
   anchor-citing doc). `report.promotedTo = nodeId` then retires it.
6. **Frequency gates promotion, freshness gates retrieval.** cl-dream's thresholds:
   a question/region answered fresh in ≥N reports is a promotion candidate the
   dashboard surfaces ("hot + fresh + undocumented → write the doc").

## Data

A new small store (mirrors `bugs`/`annotations` — one blob, behind `store.ts`):

- **`reports`** — `(id, question, answer, author, createdCommit, createdAt,
  witnesses: {anchorId, bodyHash}[], touched?: string[], uses: number,
  promotedTo?: nodeId, dead?: boolean)`

No schema-breaking changes elsewhere. `witnesses` is exactly the bug/review shape.

## Retrieval & scoring

`find_reports({ anchors?, near?, query?, limit })`:
1. Resolve `anchors`/`near` (a file / dir / symbol ref) → anchor id set.
2. Candidate reports = those whose `witnesses` intersect that set (or text-match
   `query` when no anchors given).
3. Score = `overlap · freshness · recency`, where
   `freshness = fresh_witnesses / total_witnesses`.
4. Drop `dead`; return top `limit` with each report's **stale-area list** so the
   caller knows what to re-verify. Increment `uses` on a hit (frequency signal).

## Decay & the heatmap

- **Decay** is computed live on read (like bug/doc staleness) — re-index the
  witnessed files, compare hashes. No background job; `dead` is just a cached hint
  refreshed on `check_stale`.
- **Heatmap** (phase 2): aggregate `witnesses`/`touched`/`uses` across reports →
  "hot anchors." Feeds `find_gaps` ("hot but `open`/undocumented") and the
  dashboard. This is the one place a **transcript scraper** earns its keep — an
  optional `codemap absorb-sessions` that reads `~/.claude/projects/*.jsonl` (à la
  cl-dream) to seed read-frequency that push alone can't see. Isolated, optional,
  never in the agnostic core's hot path.

## Operations (ops + parity in MCP and web)

- `saveReport(root, {question, answer, anchors, touched?, author?})` → witnesses
  captured via `liveAnchors` (reuses `report_bug`'s path).
- `findReports(root, {...})` → ranked, fresh-filtered (above).
- `reportDetail(root, id)` → prose + per-anchor live staleness (like `bugDetail`).
- `promoteReport(root, id, {anchors, title, summary, body})` → calls `document`,
  sets `promotedTo`, retires the report. (Agent curates the load-bearing anchors.)
- `retireReport(root, id)` / GC of `dead` reports past an age.

MCP tools: `save_report`, `find_reports`, `promote_report` (+ mark the mutating
ones). Guide gets a short section: *at task start, `find_reports` for your work
area; when you finish an exploration worth reusing, `save_report`; if a report is
hot and holds up, `promote_report` it into a doc.*

Web: a **reports** tab (list + freshness bar + stale-area chips + promote button),
and reports rolled into the **dashboard** ("N fresh reports · M gone stale · K
promotion candidates") and the **diff impact** (a changed anchor invalidates the
reports that read it — same join as bugs).

## Relationship to what exists

- **Annotations/questions** — a report is a heavier cousin: multi-anchor,
  witnessed, decaying, promotable. A saved report can *answer* an open review
  question (link `report → question`, resolve on promote). Keep the stores separate
  but let them reference each other.
- **Docs** — the promotion target. Reports are the on-ramp to `document`.
- **Bugs/reviews** — share the witness machinery verbatim.

## Phasing

1. **Store + push + retrieval.** `reports` store; `save_report`/`find_reports`/
   `reportDetail`; anchor-overlap + freshness scoring; MCP tools + guide. (The
   minimum that makes exploration reusable.)
2. **Promotion + decay surfacing.** `promote_report` → `document`; partial-fresh
   demotion; reports tab; dashboard + diff-impact rollup; GC.
3. **Heatmap + gaps + optional scraper.** Frequency aggregation; "hot + fresh +
   undocumented" promotion candidates; optional `absorb-sessions` importer.

## Rough size

Phase 1 ≈ a bugs-tab-sized slice: ~120 LOC store+ops, ~30 LOC MCP, ~150 LOC web —
all inside the existing seam, zero new deps. Phases 2–3 additive.

## Open questions (for the brainstorm)

1. **What counts as "load-bearing"?** Agent-declared only, or also "any anchor
   whose removal would change the answer" (unknowable without re-running)? Lean
   agent-declared; accept some over/under-anchoring.
2. **Freshness floor for `dead`** — fixed (<50%) or per-report (agent hints
   criticality)? Does a single *load-bearing* removal kill it regardless?
3. **Cross-branch reports.** Docs are branch-versioned; are reports? Simplest:
   reports are `@work`-only and just decay across a branch switch (cheap, ephemeral
   by nature) — don't version them.
4. **Dedup / churn.** Two agents save near-identical reports — merge on
   question+overlap, or let `uses`/recency sort it out?
5. **Poisoning ceiling.** A wrong report gets read → cited in a new report →
   compounds. Is "unverified, witnessed, never cited-by-nodes, promotion-gated"
   enough, or do we cap retrieval depth / require ≥2 corroborating reports before a
   claim is treated as strong?
6. **Is `touched`/the scraper worth it in v1?** Or defer all frequency to phase 3
   and ship pure push first?

## Appendix: Acme.API demand vs documentation (empirical, 2026-07-16)

Mined the Acme.API Claude Code transcripts (read-only) for Explore/research demand
and cross-referenced the live codemap. Headline: **184 sessions, ~22.7k tool calls,
248 Explore/research subagent calls**; the map already holds **490 documented files
/ 1227 cited anchors**, with the rating domain richly noded (66 rating nodes:
`RatingTemplate`/`RatingInstance` aggregates, all CRUD commands/events/handlers,
`RatingContext / field resolution`, a `Rating resolution & engine` flow).

Four things fall out, and they reshape the plan:

1. **Most of the mismatch is *access*, not *absence*.** The Explore prompts show
   agents grepping and raw-reading (`RatingProfile` ×22 greps, hundreds of Reads of
   `QuoteEventHandler.cs`/`QuoteRatingService.cs`/`RatingContext.cs`) —
   files that **are already documented**. They re-derive what the map knows because
   they never ask the map. → The biggest lever is the behavioral fix already in this
   branch (**CodemapExplore + answer-first `context`/`search`**), not any new store.
   A large fraction of those 248 explorations should collapse to one MCP lookup.

2. **Residual absence is shaped like *flows* and *conventions*, not modules.** The
   recurring FAQs are cross-cutting process questions — *"how do template + instance
   combine to generate a RatingProfile?"*, *"how is inheritance resolved?"*, *"how
   does order/quote data map to expression variables?"* — asked ~4 ways each. But
   Acme.API has only **8 `process` flows / 64 steps** vs 132 modules and ~600
   analyzer nodes. The demand wants narratives (a `Template→Instance→Profile
   generation` flow, an `inheritance resolution` flow) that don't exist yet. A
   second cluster — error handling (`ApiError` vs `ProblemDetails`), validation
   surfacing (Wolverine/FluentValidation), test setup (ObjectMother) — are
   **convention** questions with no node home today.
   → **To match shape, bias new docs toward `process`/`step` nodes for the hot flows
   and a convention/reference node for the recurring pattern FAQs — not more modules.**

3. **A demand-ranked gap queue is the concrete feeder.** 17 of the top ~36 read
   files are undocumented; filtered to the api universe the real targets are obvious
   — `RatingProfile.cs` (model, ~59 reads), `CreateRatingProfileCommand.cs`,
   `PriceSearchResult.cs`. This is exactly the phase-3 `absorb-sessions` idea:
   rank `find_gaps` by transcript read-frequency + surface "hot Explore theme with no
   covering flow." The analysis above *is* that shortlist, produced by hand.

4. **The demand signal must be filtered by universe + worth.** Top reads also
   include `TestDataScripts/*.py` and `Acme.React/*` — noise for the api universe you
   would NOT want to auto-document. This validates the CodemapExplore "reusable claim
   only, never task-specific" rule against real data: raw read-frequency is a
   candidate generator, not a mandate.

Net: the exploration tax on Acme.API is enormous and the map already covers much of
it — the win is (a) instrumenting agents to *ask* (this branch), then (b) filling the
**flow- and convention-shaped** holes the FAQs reveal, ranked by real read-frequency.
