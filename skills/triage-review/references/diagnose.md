# The diagnosis contract

The rules of `triage-review`'s diagnosis route — nodes 14-19 of the flow in
`references/contract.md` — split off because only this route reads them. They are part of the
contract: where a step file disagrees with this file, the step file is the defect.

## The rules

- **D1.** The deposition is written from the session's memory before the owner is asked about the
  artifact and before any lens reading exists. The findings, the blame and the sort that routed the
  round are not evidence in this sense: they are the state the session was already working in.
- **D2.** The lens readers get every member's repository and window, and `owner.md` — the
  questions and answers of 15, which are not review framing — and mark every entry `discovered` or
  `read in`. The triager gets the final arbitrated sort, the deposition, the owner's words, the
  evidence pack and both lens readings — never the unsorted findings or either raw sort. The triager
  reads the distribution of groups from `sort.md`: the count of deduplicated items per group, and
  the number of sites the sorters counted.
- **D3.** The report is produced every time. Nothing in it is applied by this session.
- **D4.** Every disagreement `sort.md` carries goes into the report's §10 verbatim, with both
  readings, and each command where the sorter gave one. §10 has no cap.
- **D5.** The evidence pack searches prior records as `references/shared.md` K5 says, given every
  declared store with `--records` — this skill's, and `ez-plan`'s where a `CLAUDE.md` names one —
  and `--records-undeclared` in the one case nobody named the directory. It derives the defaults
  itself.
  - **The pack does not measure the record.** Every declared store is left out of the document
    surface and the put-back list, prior runs' records included. The report is not in it.
  - Beyond the run directories, prior records include every earlier report at both report paths,
    uncapped, and the older roots: `review/` in the git common directory of the repository the
    report is written into, files under `docs/` whose names or folders look like records, and that
    directory's session `artifacts/` directories — never the replay's.
  - Runs and reports live only in the primary repository (on a versioned Artifact run, where
    `references/shared.md` K1 puts them), so only the primary window's evidence pack searches for
    prior records; every other window's pack says it skipped the search and why.
- **D6.** The checkpoint surveys every member for anything unusual (`references/shared.md` U) and
  for any change, tracked or untracked, before it tags any, then tags every member's `HEAD`. Either,
  in any member, tags nothing and stops the skill (`references/shared.md` G2), naming the repository
  and the paths or what `git status` said. `checkpoint.py` also refuses both itself; its refusal in
  a race after the survey is the same stop, naming any member already tagged.

  On resume, a member already tagged is not tagged again. Its tag stands where its `HEAD` is still
  the tagged sha, **or** where the tag is an ancestor of `HEAD` and every path in `git diff
  --name-only <tag>..HEAD` is under `RECORD` — the run's own record commits (`references/shared.md`
  K2). Both halves of the second case are checked. Any other `HEAD` that has moved is a tree that
  changed under the run (`references/shared.md` G2), named with the tag.
- **D7.** A git member's window runs from its base to its checkpointed sha. The base, in order:
  1. `--since`, where it names a commit in that member;
  2. else the merge-base with `refs/remotes/origin/HEAD` as last fetched — no fetch is run;
  3. else, where there is no `origin/HEAD`, remote or not, the merge-base with the branch
     `init.defaultBranch` names — `master` only where that is unset — where that branch exists
     locally;
  4. else — a configured branch missing locally included, where `master` is not tried — the base
     is open.

  A merge-base that cannot be computed — `origin/HEAD` naming a ref that is gone, or unrelated
  histories — is `references/shared.md` G2. A base from 2 or 3 that is not older than the fixes is
  open, except that one equal to the checkpointed sha is open only where a finding's lines are in
  that member (node 4's blame reached a commit there); otherwise the window is empty, valid and
  stated. Every base from 2 or 3, and every empty window, is stated with how it was found: to the
  owner at the checkpoint step, and in the triager launch's base description. The replay's base is
  under `references/contract.md`, *For a versioned Artifact*.

  **A window with no commits**, or none past the bot filter, is valid, and its pack is written in
  full: it says NO COMMITS IN WINDOW, searches prior records or says SKIPPED as `D5` says, and says
  MEASURED NOTHING for the self-fix instruments and the put-back list.

  The evidence pack runs once per window — into `RECORD/<label>/` where the unit has more than one
  member — and starts at 14, with the deposition. Where a window's base is open, 15's answer
  resolves it: a date, to the last commit before 00:00 on that day on the member's branch, from its
  checkpointed sha, stated; a description, to the commit the session reads it as, named and
  confirmed with the owner as a follow-up. That window's pack starts once its base is resolved — at
  the answer for a date, at the confirmation for a description; on a spanning run, the windows that
  have a base start at 14.

**Diagnosis questions.** Nodes 15 and 18 ask under the shared question rules
(`references/shared.md` Q1-Q3) and these of their own: they come after the deposition (`D1`); and
`owner.md` reaches the lens readers, so **a question must not carry the review's framing** — quoted
finding text, finding ids, site lists, group names, counts. The owner has not read the findings, so
the leak is always the question: state cases in the artifact's own terms. `owner.md` is frozen when
the lens readers launch, because both hold its path.

## The document lenses

The pairwise and population lenses check a document against what it draws on. Where it draws on
files in a member's repository — rulings, handoffs — the launch names those paths and both lenses
check against them. Where the source was only a conversation, pairwise runs within the document,
population is skipped, and the report says it was skipped and why. Nothing is excerpted from the
conversation.
