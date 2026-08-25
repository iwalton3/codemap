# Where this is — handoff, 2026-08-25 (evening)

On `main`, at `0f813ba`. 987 unit + 89 e2e green, `tsc -p web` clean.

If you are picking this up cold: read `CLAUDE.md`, then this, then
`docs/plan-findings-unification.md` § "Near-term" for the work queue.

## What this session did

Worked the near-term queue in order. Items 1 and 2 are closed; a live 500 and a
sanitization leak came in from the side and were fixed too.

- **`inbound_replies` reads canonical** (`fb6d46d`). It folded the sidecar log, so it
  saw only findings that entered that way and answered "nothing from here has been
  published" over a PR where everything had been. Two things the item did not say: the
  MIGRATION was dropping `postedRef.commentId`, which is the key the thread lookup
  matches on, so fixing only the read moved the same false premise one layer down; and
  the two emptinesses (nothing published / published with no comment id) are now
  distinct. On the real store PR 264 now reports 22 findings with no comment id
  recorded. Those 22 are a `pr-push` id-resolution miss — all 45 share one
  `#pullrequestreview-` URL — not a migration loss, so recovering them means matching
  GitHub's review comments back by path and line.
- **Notes are bidirectional** (`f8f75ef`). `questions` merges the team's from the
  projection, `resolve_question` dispatches on the record, `get_anchor` carries
  `sharedNotes`. Three discoveries: the agent gate is in the FOLD (`foldNotes` drops any
  agent `note.resolved`), so an agent closes its own LOCAL question and is TOLD the
  team's is still open rather than being handed an event no reader honors; notes never
  wrote through, the last kind that skipped it; and the note store holds 96
  `kind:"finding"` rows, 45 of them double-rendering with `findings`.
  The TABLE is deliberately unchanged — `docs/sidecar-architecture.md` settles that
  notes keep their own, and that was always about the table, never the reads.
- **A walkthrough published as INPUT took PR 269's page down** (`16621ed`). One
  `walkthrough.published` carried `WalkInput` — no chapter id, no witnesses — where the
  built `PrWalkthrough` belonged, and `staleChapters` threw on every render, forever,
  because the log is append-only and the fold checked only the envelope. Three guards;
  the fold one is what heals the data on every machine without a rewrite.
- **Client names came back into the repo** (`0f813ba`). `cfade33`, `a8e6203` and
  `a6b6f23` reintroduced them in prose. Files are fixed; **history is not** — see
  Operational.

## What to do next

`docs/plan-findings-unification.md` § "Near-term" is the queue; 1 and 2 are struck.
Next is (3) audit what reads pointers, then (4a) — new, and a person's call: **51
findings are published as NOTES and are in no findings surface.** They are the local
annotations `migrate-findings` reported as "unplaced"; the team can already see them as
notes while every findings surface calls them local-only. Assign each a PR, or accept
them as history. (6) is the biggest and least understood: `planPrPush` reads
`readAnnotations` and nothing else, so nothing `report_defect` files today is pushable
by the UI at all.

## How to work on this — what cost time here

- **Ask who validates a rule before trusting it, and WHERE.** Both items this session
  turned on it. `resolve_question` says an agent may close a question and
  `resolveSharedNote` said it may not — and the tiebreak was neither op but `foldNotes`,
  which drops the event. Relaxing the op to match the "deliberate" rule would have
  shipped a silent no-op. Earlier the same shape: the `annotate` enum (nothing checked
  `inputSchema`) and `additionalProperties` (only the CLIENT checks it).
- **A cast to `never` in a fixture is a finding.** `materialize.test.ts` round-tripped
  `{pr, head, chapters} as never` — a walkthrough shape nothing produces — and so tested
  the projection against a fiction. The same substitution in production data took a page
  down permanently.
- **Do not rebuild `dist/` while a suite is running.** I invalidated three runs that way.
  Nine `dist/mcp.js` servers and the user's `serve.js` also load from it.
- **`git stash`/`checkout`/`reset` are not inspection tools.** A speculative
  stash round-trip to check whether a commit stood alone popped a PRE-EXISTING stash
  (`c36b578`, from `worktree-shared-review-hashscheme`) and conflict-merged seven files
  of somebody else's old work into the tree. Nothing was lost, by luck. Verify by
  reading, or in a throwaway worktree.
- **Mutation-check every new assertion.** Four of them here would have passed under the
  defect they were written for. The oracle asserted a walkthrough's TRANSPORT and never
  the surface, which is exactly why the gap was invisible from inside it.
- **Verify agent and report claims.** An MCP-surface audit was mostly right and partly
  wrong; two complaint items were withdrawn by their own author once the split store
  explained them. `record_published`'s silent no-op, by contrast, reproduced in one call.
- **Validate on scratch clones of `/working/`, never in place** (`CLAUDE.md` says this;
  it earned its place twice today). `cp -a` the universe and the sidecar, point the copy's
  workspace manifest at the copy, and check `find … -newermt` afterwards to prove the live
  one was untouched.

## Operational

- `codemap unify-findings` has NOT been run on the live `Acme.API` store — only on a
  clone. It publishes 45 findings to the team and re-attributes their legacy author
  strings to whoever runs it; that is Izzie's call to make.
- **PR 269's doubled walkthrough row is now gone rather than harmless.** The published
  half was the malformed one; the fold drops it on the next materialization and the good
  local row takes over. PR 271's pair is still the benign case the old note described.
- **The repo's git HISTORY still carries the client names.** `cfade33`, `a8e6203` and
  `a6b6f23` are unrewritten, so `git grep` of the pack still matches. Rewriting published
  history is Izzie's call; the files are clean as of `0f813ba`.
- **`refs/stash` holds an entry `git stash list` cannot show** — `c36b578`, from
  2026-08-22 on `worktree-shared-review-hashscheme`. Its reflog file has been empty since
  2026-08-24, which predates this session. Reach it by sha, not by `stash@{0}`.
- `Acme.Settlement` has still not been re-indexed under the overload-id scheme.
- The push-to-GitHub UI has still never posted for real.
- `docs/mcp-use-reports.md` is the durable home for use reports;
  `docs/bug-walkthrough-republish-conflict.md` is one kept as history because its
  diagnosis explains a fix that deliberately is not the one it proposed.
