# Proposal: committed documentation nodes

> **Kind: archive** — superseded or finished. Do NOT plan from it; read it only for history.
> unapproved proposal.


Status: **PROPOSAL — not approved.** Written 2026-08-05, from a session auditing
a Python codebase (`jellyfin-mpv-shim`) where twelve bugs were found and fixed,
five of them *led to by comments that stated a property the code no longer had*.

Complements `docs/doc-versioning.md` rather than replacing it. That design makes
the **store** branch-aware; this one lets **git** be the store for the authored
layer, in universes where the docs belong to the codebase rather than to the
reviewer.

---

## The observation this comes from

A long-lived codebase accumulates prose *inside* the code: 8,745 lines of it in
blocks of ≥8 lines across 54,020 lines of Python in the repo in question — 16%.
It is there because the context does not fit in anyone's head across months, and
because agents arrive with no memory at all. Most of it earns its place. The
failures are specific and they rhyme:

1. **The claim spans several symbols; a comment can only sit next to one.** All
   five invariants that broke had this shape. "The pending queue drains in
   enqueue order so an unresolvable row cannot block it" lived in `db.list`; the
   code that violated it was `_run`, in another file. The comment stayed locally
   true for the whole life of the bug.
2. **Nothing changed at the comment's own site.** A module docstring describing
   seven mixins went wrong because four of those files *moved*. No
   comment-adjacency check can see that. An anchor-citing claim can.
3. **Confidently wrong prose suppresses scrutiny.** One docstring said its
   (buggy) behaviour was "on purpose", with a plausible rationale attached. The
   maintainer had *observed the symptom* and filed it as intended behaviour. A
   wrong comment is not neutral — it converts an observation into a
   non-observation.

Codemap already answers (1) and (2): no floating claims, deterministic anchors,
witness-hash staleness. It answers (3) better than any prose can, because a
trust level with "the creating session may not self-verify" is a *receipt* where
"deliberately" is only an assertion.

What it cannot do today is let those claims travel with the branch that changes
the code.

## Why committed, specifically

The DB is gitignored on purpose, and that reasoning is right for review marks:
they are per-reviewer state about someone else's code, and they must not
pollute a PR diff. It is wrong for documentation, for four reasons:

- **A doc that describes a branch's code belongs to that branch.**
  `doc-versioning.md` reaches the same conclusion from the Acme.API
  `develop` ↔ `feat/payments-seam` case — "branch edits leak backward" — and
  solves it with per-citation accepted-hash sets. In git, the problem does not
  arise: a checkout *is* the version.
- **A doc that lies should be reviewable in the PR that made it lie.** The
  branch that breaks a claim should show the claim in its diff. That is the
  north star of this project applied to prose.
- **Merge conflicts in a doc are a feature.** Two branches that disagree about
  an invariant *are* in conflict. A hash tiebreak picks a winner silently;
  `<<<<<<<` does not.
- **Graceful degradation decides it.** An agent's first move is usually a
  generic code search, not an MCP call. Committed markdown is legible to that
  agent, to GitHub's blame view, to a human with no Node installed, and to a
  clone with no index. A gitignored SQLite file is legible to exactly one tool.
  The server's job is to say *which claims stopped being true*, not to be the
  only way to read them.

## Model

Add a per-universe mode. Nothing changes for existing universes.

```jsonc
// .codemap/config.json  (or the workspace entry)
{ "docs": { "mode": "committed", "root": "docs/claims" } }
```

**`mode: "db"`** — today's behaviour, unchanged. The financial universes stay
here: review marks on code that is not yours to annotate publicly.

**`mode: "committed"`** — the authored layer lives in `<root>/**/*.md`. The DB
becomes a pure index of those files: derived, gitignored, rebuildable from the
repo at any commit by `check`. `node_versions` is not needed in this mode —
version selection is `git checkout`.

### File format

One file, one topic. Front-matter for the file's defaults; each `##` section is
a **claim** and may cite its own anchors.

```markdown
---
id: n_sync_queue_progress
title: The download queue makes progress on every runnable row
type: state
cites:
  - anchor: jellyfin_mpv_shim/sync/db.py#SyncDB.list
    accepted: [3f9a1c22]
  - anchor: jellyfin_mpv_shim/sync/manager.py#SyncManager._run
    accepted: [3f9a1c22, 91b4de07]
asserted_by:
  - tests/test_sync_manager.py#QueueHeadOfLineTest
verified: { at: 6096f13e, by: izzie }
---

Rows are drained in enqueue order so a not-yet-resolvable item cannot float to
the front on catalog sort. That ordering is worthless if the worker then takes
the head unconditionally: one row for a server that is gone parks itself there
and everything behind it waits for the process lifetime.

## The auto-download pass is gated on runnable work, not on an empty queue
<!-- cites: jellyfin_mpv_shim/sync/manager.py#SyncManager._run,
            jellyfin_mpv_shim/sync/auto.py#AutoDownloader.tick -->

A pending row for a server we cannot reach is not a download in flight. Treating
it as one switched the reaper off for the life of the process — retention, the
cap and the failed-row reclaim all silently stopped.
```

Three deliberate choices:

- **Citations are `path#symbolPath`, not anchor ids.** An `a_`+sha256 id is
  unreadable and unwritable by hand, and the resolution rule already exists. The
  index stores the resolved id; the file stores what a human can check.
- **Accepted hashes are committed, and they do not churn.** A hash set changes
  only when someone *confirms*, never when the code changes — code drift is what
  makes a claim stale, and staleness is computed, not stored. So the diff noise
  is one line per confirmation, which is precisely the event worth having in
  git history. (For an audited codebase that history is arguably the artifact
  you most want.)
- **Per-section citations are an HTML comment.** Invisible when rendered,
  greppable in raw, and no new syntax for a markdown parser to swallow.

### Staleness is the diff you already have

For a claim, staleness is `diff.ts`'s set-op with the base pinned per-claim
instead of per-branch: resolve each cited anchor at `@work`, compare its live
hash to that citation's `accepted` set.

- **fresh** — every cited anchor resolves and its live hash ∈ accepted.
- **stale** — resolves, hash ∉ accepted. The code drifted since this claim was
  last confirmed.
- **lost** — `symbolPath` no longer resolves. Moved, renamed or deleted; this is
  the case that would have caught the seven-mixin docstring.

**Granularity is the one genuinely new capability**, and it is the difference
between a useful signal and alarm fatigue. Staleness lands on the *section*
whose citations drifted, not on the file. A doc with nine claims and one changed
symbol reports one stale claim and eight fresh ones.

### Trust, and who may confirm

The existing rule — the session that created a node may not mark it verified —
becomes checkable from git rather than from session state:

> `verified.by` must differ from the author of the commit that last changed this
> claim's body.

`git blame` on the section's line range answers it, which means CI can enforce
it and a reviewer can see it. Levels carry over from `ReviewLevel`: `logical`
(read the claim against the doc) versus `code` (read the claim against the
source). A claim with `asserted_by` pointing at a test that runs in CI is a
third and strongest level — the only kind that says *violated* rather than
*re-check this*.

## Layering

Respects the seams; the engine is reused, not rebuilt.

```
schema.ts     + DocSource ("db" | "committed"), claim-level ids, accepted-hash set
store.ts      + importDocs(root) / writeDoc(id)  — the SEAM absorbs the format
ops.ts        unchanged API surface; ops resolve through store as they do now
mcp/serve     unchanged; a committed doc is a node like any other
```

`check` gains a step: if the universe is committed-mode, re-read `<root>` and
reconcile before evaluating staleness. Write ops (`document`, `update_node`,
`confirm`) serialize back to the file — the file is the source of truth and the
DB never diverges from it silently.

**No new dependency.** Front-matter is restricted to a trivial subset — `key:
value`, `- list items`, one level of nesting — parseable in well under a hundred
lines of `node:` nothing. Do not reach for a YAML library; the golden rule is
worth more than the last 5% of the format.

## What this deliberately does not do

- **It does not help external or historical reference.** A docstring quoting
  `vo_gpu_next.c`, a measurement against mpv v0.41.0, the rationale for a
  setting that no longer exists — nothing can hash those. They are the largest
  category by volume in the codebase examined, and their problem is only that
  they sit in a file that is read at edit time. Plain docs, no citations.
- **It does not replace comments.** Prose whose job is to stop a future editor
  reverting the code stays next to the code, whatever its length: the person
  about to revert is reading the code, not the docs. The rule that sorts them is
  arity, not size — *a claim that spans more than one symbol should not be a
  comment.*
- **It does not say "violated", only "re-check".** The Marten pass is the
  precedent recorded in `CLAUDE.md`: 138 false positives before 4 genuine ones.
  Staleness is a prompt for judgement at the right moment. Only a test asserts.

## Risks

- **Alarm fatigue.** A bulk migration of prose into claims produces hundreds of
  simultaneously-stale sections and trains everyone to ignore them. Mitigate by
  admitting claims that either have an `asserted_by` test or were written
  because something actually broke.
- **Anchor churn on refactors.** Ids are stable across line moves, not renames.
  Conveniently anti-correlated in practice: the invariants worth recording live
  in settled modules, and the churn is in code too young to have invariants.
- **Scope drift for codemap itself.** The primary product is meaningful review
  of large diffs. This is defensible as the same product — a claim that names
  the five symbols an invariant spans is exactly "context a raw diff hides" —
  but if it stops feeling that way, the exit is cheap: the serializer is
  additive and deleting it leaves the engine untouched.

## Suggested sequencing

The uncertain part is workflow, not storage, so do not build first.

1. **Validate by hand.** Write ~6 real claims as committed markdown in the
   target repo, no tooling, using the format above. Two weeks. Do they get
   consulted? Does anyone update one when they break it? If they rot untouched,
   no server would have saved them.
2. **Then the importer** (`store.importDocs`) plus claim-level staleness in
   `check` — read-only, no write-back. This is the whole value.
3. **Then write-back and `confirm`**, which is what makes the trust level real.
4. **CI check last**: fail on a stale claim in the diff of a PR that touched its
   cited symbols. That is the step that turns it from a tool into a contract,
   and it should only be taken once the false-positive rate is known.
