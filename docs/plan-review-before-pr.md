# Plan — reviewing a branch before its pull request exists

> **Kind: plan, DRAFT (2026-09-18).** Not built. Supersedes the "Nothing built" status of
> `docs/review-target-identity.md` where the two disagree; that document's refutation of
> branch-canonical keys still stands and is why this one looks as it does.

## The consumer, and what it already requires of us

Acme.API's spec playbook is merged policy, and `/codemap-review` (a command in that repo)
is its codemap consumer. Three sections set the requirement:

- **§12:** every spec and implementation runs in its own worktree, one per card, so several
  branches are live at once.
- **§14.6:** the review runs in a fresh session **before the PR exists**. Findings and their
  outcomes go to the sidecar, and they are published once the PR opens.
- **§14.8:** the gate before merge is "`check_stale` empty over the anchors this PR touched",
  judged at the PR head.

None of the three works today, for two independent reasons:

1. **Every read answers about the universe's root checkout.** A universe is one path. `@work`
   is that path's working tree. `check_stale` rebuilds that index when the root's branch
   changes, and it runs on every MCP connect. An agent in a worktree gets answers about
   someone else's branch, and nothing in the answer says so.
2. **A finding's home is a PR number.** Sidecar scope `findings/<u>/pr-<n>`, local column
   `findings.pr NOT NULL`, and `report_defect` accepts only `pull_request` (which needs `pr`)
   or `drive_by` (which makes a bug). `/codemap-review`'s default mode files
   `{kind:"pull_request", pr}` before any PR exists, so the command contradicts itself.

## Settled with the owner (2026-09-18)

- **The registry of reviews lives in the sidecar.**
- **No generations.** A reused branch name is the same review, and the case is treated as a
  PR being reopened.
- **The git model:** the branch is the local identity, and the PR number is its "origin",
  attached once the PR exists.
- **One branch name, one review, per universe**, even across teammates who never pushed.
  Acceptable, because card-derived branch names make it mostly the same work.
- **One card can span Acme.API and Acme.React.** That gives two reviews, one per universe,
  because a PR belongs to one repo.

## Assumed, not yet confirmed — each is a case that can be marked wrong

- **A1. A purged and rerun spec branch inherits the abandoned run's findings.** This follows
  from "no generations". The findings are witness-hashed, so those about code that is gone
  read as moved.
- **A2. Without `gh` there is no automatic link** between a PR and its branch.
  `refs/pull/N/head` carries a sha and no branch name, and guessing one from branch tips is
  the refuted mechanism. An explicit link verb covers it (B4).
- **A3. Branch reads see the last commit, not uncommitted edits.** Every playbook gate is at a
  commit, and snapshots of a dirty tree are already refused (COD-3).

---

## Part A — reads at a branch head

**Mechanism.** A read tool takes an optional `at: <branch | sha>`, resolved with
`git rev-parse` in the universe root. `refs/heads` is shared with every linked worktree, so
the main checkout can resolve a worktree's branch without knowing its path.
`snapshotAt(sha)` indexes from git objects, never checks out, and caches per sha. Reads at a
sha never write `@work`, never take the lock, never rebaseline and never refresh analyzers,
so concurrent agents cannot disturb each other or the root. Every `at` response carries
`at: {ref, sha}`.

**A1. The partly-honoured `ref` sites: DONE (2026-09-18, `4ced38b..9bc78a0`).** Triaged in
run `2026-09-18-partial-ref-sites` (two of the nine claims were invalid), then fixed on the
owner's rulings:
- **A working tree's index belongs to the worktree, never a commit.** `init`/`reindex` on a
  dirty tree no longer write HEAD's snapshot, and `snapshot` indexes from git objects.
- **A snapshot is built on the read that needs it.** `readSnapshot` (in `snapshots.ts`)
  rebuilds anything absent, dirty or from another derivation, so null means "git cannot read
  it". That is what Part A's `at:` stands on.
- **At a ref, everything comes from the ref**: node resolution in the review functions, and
  diff's review, coverage and drill-down at its head.
- **Batch marks skip and report ids that witnessed nothing**; covers and caller-supplied
  hashes are exempt.

Left open: `docDiff` with no head still resolves against the stored `@work` rows (the same
shape the no-head `computeDiff` fix closed).

**A2. `at` on the read tools**, in the order the command uses them:

- **`check_stale at:`** is a read-only mode, not a variant of today's pass. It takes a base
  (the review's recorded base, or the merge-base with the default branch) and returns:
  - the anchors changed from base to head (the set operation `computeDiff` already does);
  - the docs citing them, judged with `loadNodesAt(snapshotHashes(head))`. This is §14.8's
    "stale among the anchors this PR touched", exactly;
  - review marks gone stale at head (`reviewStatesFor({ref: head})`). This is the command's
    round-to-round state.
- **`context at:`** — `coverageFor`, ref resolution and `reviewStatesFor`, all at the sha.
  `.codemapignore` is read from the commit, as `indexCommit` already does.
- **`get_anchor at:`** — source from the blob at the sha. `sourceCommit` is that sha.
- **`search at:` / `get_node at:`** — anchor hits from the snapshot, and node status from
  `loadNodesAt`.

**A3. Derived views stay root-only, and say so.** `pipeline_graph`, `event_matrix` and
`state_map` are analyzer output generated from `@work`. Running analyzers per snapshot is
out of scope. Until then those tools refuse `at:` with a sentence rather than silently
answering about the root. The command uses `event_matrix` and `state_map`, so this is a
visible gap and is written down as one.

**A4. Measure before optimising.** `snapshotAt` re-indexes the whole tree for every new sha
(about 2s per 1,200 files, so more on Acme.API's ~1,700), and nothing evicts snapshots.
Agents that commit often each pay a full index per commit. Measure on a scratch copy of the
real repo first. If it hurts, the fix is a per-blob-oid parse cache (an unchanged file is
not re-parsed), not a change to the snapshot model.

## Part B — reviews that exist before the PR

**B1. Identity is derived, because there are no generations.** A branch name names one
review for ever, so its id can be computed rather than minted:
`r_` + hex(sha256(universeKey \0 "branch" \0 name)). Two people opening a review of the same
branch concurrently compute the same id. That dissolves the old design's open question 1
("the fold has to pick one and alias the other"). The id is fixed-length lowercase hex, so
the escaping and 255-byte problems from the refutation do not arise.

**B2. Scopes.**
- New: `findings/<u>/b-<hex>`.
- Existing `findings/<u>/pr-<n>` scopes are **never moved or renamed**. They hold the deployed
  findings, and splicing writer chains across scopes reads as a fork.
- A PR's findings are the **union** of `pr-<n>` and the linked branch's `b-<hex>`. A PR
  reviewed both before and after it opened has findings in both, and that is correct.

**B3. The registry: a new sidecar scope `reviews/<u>`, with one event kind.**
`review.linked {pr, branch}` is an act: the moment someone connects PR n to branch X. It
records one link; the id and the scope are computed, and the head comes from git. Rules:

- Written when a PR is resolved through `gh` (`pr_packet`, `pr`, `shared_findings pr=`), from
  `headRefName`. Never written from the sha-matching `prBranchFor`.
- **Same-repo heads only.** A fork PR's `headRefName` names a branch in somebody else's
  repository. Linking it to a local branch of the same name is the refuted "unrelated branch
  at the same sha" row in a new form. `gh` reports `isCrossRepository`, and a cross-repo head
  is never linked.
- Several links for one PR (a branch renamed, then the PR reopened from another) are all
  kept, and the union grows.

This is a new fold with a new event kind, so it costs a `MATERIALIZER_VERSION` bump.
`db-migrate.test.ts` pins the vocabulary. Review the fold by **running** it on hand-built
events, per CLAUDE.md.

**B4. The tool surface.** It follows the finding-routing rule: the verb takes the target, and
the op decides storage.

- `report_defect` context gains `{kind:"branch", branch}`. The `pull_request` context keeps
  working unchanged.
- `findings` and `shared_findings` accept `branch` as well as `pr`.
- `link_review {pr, branch}` is the explicit act for a machine without `gh` (A2).
- The id-derived verbs (`close_finding`, `revise_finding`, `comment`, `corroborate`,
  `defer_finding`, `record_published`, …) resolve the finding's **target** where they now
  resolve `f.pr`. That is ~10 call sites through `whichRecord`. Do all of them or none; see
  the `sidecarForWrite` lesson.
- `src/standard-reach.test.ts`'s rule applies: reachable from the web too, or exempted with a
  reason.

**B5. Local store.**
- `findings.pr TEXT NOT NULL` becomes a target key: `pr:<n>` or `branch:<name>`, typed, so a
  branch named `pr-17` cannot collide with PR 17.
- The PR a finding is shown under is derived through the links.
- `readFinding`'s "one id on two PRs" refusal becomes "one id on two targets".
- Clean up the unnormalized writes the sweep found on the way: `defect.ts:160`,
  `promote-annotation.ts:65/89`, and the `findings-unify.ts` sites that bypass `prKey`.

**B6. Out of scope, deliberately.**
- **Walkthroughs.** `foldWalkthroughs` drops any event whose `pr` is not a number, so
  pre-PR walkthroughs are a follow-up with the same shape.
- **Web routes** (`/shared/:pr/`). The hub needs a branch-review page eventually. MCP comes
  first, because that is what the command drives.

## Publishing is not in scope

Codemap findings are not pushed to GitHub; `pr-push` does not apply to them, and the
publish mode in `/codemap-review` is outdated (owner, 2026-09-18). "Published like any other
PR finding" therefore means: visible under the PR through `findings pr=` and `shared_findings`,
which B2's union provides.

## Order of work

1. **A1:** the ref defects. Independent, and they improve PR review now.
2. **A2 and A3:** `at:` on the read tools, with `check_stale at:` first because §14.8 gates on it.
3. **B1–B5:** reviews, the registry, branch scopes and the verbs.
4. **A4:** only if measurement says so. **B6** after that.

**Testing.**
- Unit tests for every A1 row, each failing first.
- An oracle scenario for B: two clones; one files findings on a branch, the PR opens, and
  the other clone sees them under the PR. The oracle runs without `gh`, so it exercises
  `link_review`. The automatic `gh` link needs its own test with a stubbed `PrMeta`.
- The e2e suite's Jellyfin clone for an `at:` read on a real history.

## Acceptance, in the requester's terms

For a branch `feature/x`, checked out in a worktree:

- `search IdentifierFilter at: feature/x` returns the branch's anchors. The same search
  without `at` returns nothing, as before.
- `check_stale at: feature/x` lists the symbols the branch changed against its base, and
  nothing from whatever branch the root checkout has out.
- `context` and `get_anchor` with `at` return the branch's source, and report the sha they
  read.
- The root's `status` (baseline commit and anchor count) is identical before and after.
  `at` reads write nothing but a snapshot.
- A finding filed with `{kind:"branch", branch:"feature/x"}` appears in `findings pr=<n>`
  once PR n is linked to `feature/x`.

**What the requester changes on their side:** `/codemap-review` self-review mode files with
the branch context and passes `at:` to its reads, its precondition drops the bare
`check_stale`, and its publish mode is outdated. That is their command. We tell them; we do not write it.
