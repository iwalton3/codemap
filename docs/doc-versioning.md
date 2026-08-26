# Design: hash-versioned, branch-aware docs

> **Kind: current reference** — describes how codemap works today. Trust it; fix it if it is wrong.
> hash-versioned docs, BUILT. The schema section is aspirational — see the note there.

Status: **BUILT.** Corrected 2026-08-26 — this said "Building Phase 1" for six weeks
after Phase 1 landed.

**One thing below was never built as described:** the schema section names
`node_citations` and `accepted_hashes` as their own tables. They are not. Citations are
a JSON `citations` column on `node_versions`, and `acceptedHashes` is a field inside
each citation (`src/doc-version.ts`). The MODEL is right and is what the code implements;
the table decomposition is not what shipped.

## Decisions (approved)

1. **Auto-fork:** editing forks **iff any cited anchor is stale** (its live hash ∉
   the version's accepted set); if all cited anchors are fresh, edit in place.
2. **Accepted-hash *set* per citation** (a version can be valid on several branches).
3. **Tiebreak is git-aware:** among equally-good versions prefer the one whose
   `created_commit` is an ancestor of / closest to current HEAD, then most-recent.
   (Rare in practice.) So **`created_commit` is load-bearing, not just advisory** —
   track the commit each version was written against.
4. Version selection is otherwise by **hash-match** (no explicit branch tags).
5. **Analyzer-generated nodes are NOT versioned** — regenerated per branch. Emission
   is idempotent: identical re-emit reuses the existing node (no churn / DB bloat).
6. **Archeology auto-applies when the reconstruction is unambiguous**; anything
   strange/non-obvious is surfaced for review. Run by a **subagent** (keeps the
   implementation context focused).

### Note on the deletion nuance (from review)
If code is deleted, a version that cited it goes **dangling** (missing citation),
not merely fewer-matches — so it loses to any version that's fresh/valid here, which
is correct. "Fewest stale+dangling" already handles it; the git-aware tiebreak only
breaks ties between otherwise-equal candidates.

## Why

The whole point of codemap is meaningful review of large changes. That breaks
today because **docs cite anchor *ids*, not the hashed versions they were written
against**, and **nodes are single-version, not branch-aware**. Two consequences,
both hit on the Acme.API `develop` ↔ `feat/payments-seam` diff:

1. Staleness is measured against one global baseline (`@work`), not per-doc. A doc
   is flagged "an anchor it cites changed since the last reindex" — not "since
   *this doc* was written / last confirmed."
2. The `.codemap` DB is one shared, gitignored store across all branches. So when
   the payments-seam agent retitled the CreditLine docs "(REMOVED)", it edited the
   **same records** `develop` reads — **branch edits leak backward.** View
   `develop` now and those docs lie.

## Target model (the one you sketched)

A doc is a **set of versions** under one id. Each version records the anchors it
cites **with the hash it was written against** (an "accepted hash" per citation).
The version whose accepted hashes match the current branch's live code **wins**;
the others stay valid on the branches whose code they match.

### Data
- **`node_versions`** — `(version_id, node_id, type, title, summary, body,
  generated_by, created_commit, created_branch, created_at)`
- **`node_citations`** — `(version_id, anchor_id, accepted_hashes[])` — the
  hashes this version is known-valid against for that anchor (a small set, one
  entry per branch it was confirmed on).

### Per-version status, evaluated against `@work`'s live anchors
For each citation compare the anchor's live hash to `accepted_hashes`:
- **fresh** — every cited anchor exists and its live hash ∈ accepted_hashes.
- **stale** — a cited anchor exists but its live hash ∉ accepted_hashes (code
  drifted since this version; needs confirm-or-rewrite).
- **dangling** — a cited anchor is absent from `@work` (code removed/renamed) — a
  *hole* where the doc described code that no longer exists here.

### Which version wins on the current branch
Among a node's versions: prefer **fresh**; else the least stale+dangling; ties →
most recent. The winner's status is what the UI/agent shows. If *no* version is
fresh, the doc is genuinely "needs review here."

This makes each branch resolve to *its* version automatically, by hash-match — no
branch tags needed, exactly as you described.

## Operations

- **`document`** (new id) → creates node + v1, capturing current live hashes.
- **`confirm(id)`** — "the winning version's text is still accurate at this code."
  Adds the current live hashes to each citation's accepted set. **No new version**;
  the doc becomes fresh here *and stays fresh on the other branches whose hashes are
  still in the set* — so confirming can never leak. This is also the per-doc
  **"accept"** that converges the review queue without a global reindex.
- **`fork/revise(id, …)`** — the text must change for the new code → new version,
  captures the current branch's hashes; the old version is retained and keeps
  winning where its hashes match.
- **`update_node`** — edits the winning version in place **only when it's fresh**
  (same code, better words); if the winning version is stale (you're editing
  against drifted code) it **auto-forks** — so you can never silently overwrite the
  version another branch depends on. *(Open Q1: auto-fork vs. require explicit fork.)*
- **`delete_node` / ack-hole** — for a dangling winner: either remove the doc
  (the deletion is correct) or fork a rewrite for the new code. `check_stale`
  already reports `danglingDocs`; this gives them a resolution.

Generated (analyzer) nodes are **excluded** from versioning — they're re-emitted
from current code every run, so they're inherently current-branch. *(Open Q5.)*

## Phasing

1. **Schema + resolution** — versioned `node_versions`/`node_citations`; `loadNodes`
   resolves the winning version per branch; staleness/dangling computed per version.
   Migrate existing nodes → v1, seeding accepted_hashes from **current** live hashes.
2. **Ops** — confirm / fork / auto-fork-on-divergence / ack-hole, in ops + MCP + CLI;
   fold hash-capture into `document`/`update_node`. Methodology (`guide.ts`) gets the
   post-change loop: *for each affected doc, confirm or fork.*
3. **UI** — show version status (fresh/stale/dangling) everywhere a node renders; the
   diff shows the doc as it resolves on each side; confirm/fork/ack buttons.
4. **Archeology (one-time, Acme.API)** — below.

## Migration + archeology (what's salvageable)

Plain migration seeds every existing node as a single v1 against *current* code
(`@work` = payments-seam right now). That's a fine floor but **can't un-leak**
the docs payments-seam clobbered. We can do better, because we have both inputs:

- **The two anchor snapshots** already cached in the DB: `develop@8c80b94f` and
  `feat/payments-seam@430cd788` — so we can compute the *correct* write-time hash
  for any anchor on either branch.
- **The two session transcripts** — `develop` = `f153eb96…` (38 `document`),
  `payments-seam` = `02218f21…` (15 `document` + 36 `update_node`). These hold the
  actual doc content each branch's agent authored.

Reconstruction:
1. Parse each session's `document`/`update_node` calls → per-branch content by node id.
2. For a node both sessions touched → build **two versions**: develop's content
   (accepted_hashes from the develop snapshot) + payments-seam's content (from the feat
   snapshot). The leak is undone: `develop` gets its original text back, `payments-seam`
   keeps the rewrite.
3. For a node only one session touched → single version on that branch's snapshot.
4. **Produce a report** — per node: salvage-as-fork / keep-as-is / drop-and-let-the-
   agent-recreate — for you to approve before anything is written. *(Open Q6: how
   automatic — I lean "report first, you approve per node.")*

Result: you salvage the develop map (recovered from f153eb96) **and** the
payments-seam map, correctly forked, instead of hand-redoing either.

## Rough size

Phase 1–2 (schema/resolution/ops) is a real but contained change — `store.ts`,
`schema.ts`, the node-writing ops, `reviews.ts` (witness capture already exists and
can be reused for citation hashes). Phase 3 (UI) touches every node render. Phase 4
(archeology) is a one-off script over the two transcripts + two snapshots.
