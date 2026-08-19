# Where this branch is — `fix/selfreview-backlog`

Written as a handoff. If you are picking this up cold, read this, then
`docs/pr-walkthrough-design.md`, then `docs/findings-publishing-spec.md`.

## Done

**The 2026-08-18 self-review backlog is closed.** All 70 medium/low findings, on
top of the 17 high/critical fixed earlier. The annotated record is at
`~/codemap-backups/selfreview-2026-08-18/TRIAGE.md`; each cluster there says how it
was closed, and the commit messages carry the reasoning.

**A second review, by four agents over this branch's own diff, is also closed.** It
found real regressions introduced while fixing the first batch — the lock being
stolen mid-flight once network work went under it, a genuine revert reading as a
green check, the overload migration pairing by position, two markdown changes that
silently swallowed whole spec files. All fixed. Worth knowing: the second review
caught more than the first, because the first reviewed code nobody had just
touched.

**Found outside both reviews, and more serious than most of what was in them:**

- tree-sitter parsers and trees were never freed (the wasm heap is not GC'd), so a
  long-running `serve.js` or MCP server died on a bare `Aborted()`;
- an overload's anchor id encoded its ORDINAL, so unrelated methods diffed against
  each other and deleting one retargeted the rest's reviews. Now the parameter type
  list, with a migration that carried ~1,350 references across on the live
  universes (verified lossless, 301/301 identical verdicts);
- `/api/pr/story` re-parsed every touched file on every request; the walkthrough
  reloaded the whole story to learn what one sign-off did.

**The walkthrough redesign** is designed (`docs/pr-walkthrough-design.md`), its
model is built and tested (`src/walkthrough.ts`), and it renders. Not yet exercised
end-to-end: nobody has run a real `map out PR 264` against it.

## Next, in order

1. **`docs/findings-publishing-spec.md` — accepted, unbuilt, and blocking.** It is
   what lets #264's findings go back to its submitter as one batched review with
   short submitter-facing text. `brief: true` by default on `review_queue` is
   approved.
2. Exercise the walkthrough for real on #264 and #227 and see what the structure
   actually looks like.
3. `code in no spec section` — the dual of `specWithoutCode`, designed in §4 of the
   walkthrough design, not built. It is the drive-by detector.

## Decisions made in conversation that the code does not show

- **The agent is invoked by the human**, not by codemap. You open Claude Code and
  ask it to map out a PR; the instructions live in the MCP tool descriptions. This
  is a golden-rule call: codemap shells out to `git` and `gh`, never to a model.
- **The spec is evidence, never structure.** #264 misdescribed itself and carried
  four drive-by changes. Anything derived *from* the spec inherits its lies.
- **Chapter size is a coherence judgement, not a number.** "Chapters are only
  justified when the breaks are coherent and make sense." So the tool description
  asks for a unit someone can hold in their head; validation only rejects a chapter
  with no symbols in it.
- **Chapter sign-off is a SHORTCUT, not a granularity.** Per-symbol and per-file
  marking and commenting stay exactly as they are.
- **Cross-PR features are out of scope.** The #239–#246 stack predates this tool
  and is coherent enough to review per-PR.

## Operational notes

- `Acme.API` was re-indexed on 2026-08-19 under the new overload-id scheme, and its
  six open PRs (#264, #241, #240, #239, #227, #94) re-snapshotted. Backup of the
  pre-migration DB: `~/codemap-backups/Acme.API-preoverload-20260819-1211/`.
- **`Acme.Settlement` has NOT been re-indexed.** It has 128 overloaded anchors and
  ~200 references; the dry run says they pair cleanly, so `reindex` should be as
  clean as `Acme.API` was — but it has not been run.
- The push-to-GitHub UI has never posted anything for real. The backend is tested
  with an injected `gh`; no comment has actually landed on a pull request.
- 191 unit tests, 22 e2e. `npm test` is hermetic; `npm run test:e2e` needs puppeteer
  and a `jellyfin/jellyfin` clone and skips loudly without them.
