## What the diagnosis is for

Fixes keep landing on fixes, over a hole nobody named. **The goal is to find the void**: the
question nobody asked, the move nobody made, the requirement nobody wrote down — not a defect list.
The answer usually sits one level above the findings: what the thing is for, its concepts, its
rules, its sites, and the top level is the one most often never written down. The output is a
report that puts enough of the shape in front of the owner that, between you, it can be named, and
the easy moves put to them as choices.

Read `SKILL_DIR/references/diagnose.md` now: the rules this route runs under.

**Diagnose only.** Fix nothing, revert nothing, apply none of the round, and start no review. If
what went round the loop is a document — a page, a spec, a plan — read
`SKILL_DIR/references/artifacts.md` now; it says what changes in each step.

## Checkpoint and scope

**Nothing here asks the owner anything about the artifact.** The deposition comes before any such
question, so what this step cannot resolve from the arguments and each member's docs is asked with
the owner's question after the deposition (`steps/diagnose-2-deposition-and-owner.md`).

1. **Checkpoint every member.** Every tree was committed before blame, but another session can
   have edited one or left it mid-operation since. **Survey every member before tagging any**:

       git -C REPO status
       git -C REPO status --porcelain --untracked-files=normal

   Anything unusual (`references/shared.md` U) or any porcelain output, in any member, means **tag
   nothing and stop** as `references/shared.md` G2, naming the member and what `git status` said or
   the paths (`references/diagnose.md` D6). On resume, survey every member again: a member already
   tagged keeps its tag where its `HEAD` is still the tagged sha, **or where the tag is an ancestor
   of `HEAD` and every path in `git diff --name-only <tag>..HEAD` is under `RECORD`** — this run's
   own record commits. Otherwise stop the same way, naming the tag. Once every member passes, tag
   each one not yet tagged:

       python3 SKILL_DIR/scripts/checkpoint.py --repo REPO --slug <RECORD's slug>

   It tags `HEAD`, and refuses anything unusual or any change itself — naming the repository and
   what it found, tagging nothing, exiting non-zero — which after the survey means a race: stop the
   same way, naming any member already tagged and its tag. Nothing is moved, reset or cleaned. On
   Windows, where `python3` can be the Store stub, run the scripts with `python`.

2. **Resolve each member's window** (`references/diagnose.md` D7): its head is the checkpointed
   sha; its base is `--since`, else the merge-base with `origin/HEAD` as last fetched (run no
   fetch), else with the branch `init.defaultBranch` names (`master` only where that is unset)
   where it exists locally, else open.

          git -C REPO symbolic-ref -q refs/remotes/origin/HEAD
          git -C REPO config init.defaultBranch      # unset: <name> is master; set: its value, nothing else
          git -C REPO rev-parse -q --verify refs/heads/<name>
          git -C REPO merge-base <checkpointed sha> <refs/remotes/origin/HEAD or refs/heads/<name>>

   A merge-base that cannot be computed — git exits 128 or 1 — stops you as
   `references/shared.md` G2, naming the repository, the command and its output. A Claude
   Artifact's base is the replay's v1, stated and not asked. Whether a merge-base base that is not
   older than the fixes, or an empty window, is open is D7's; the blame record from
   `steps/1-blame.md` names each finding's member. **Say each member's base to the owner with how it
   was found.**

   An open base is asked after the deposition — *what is the last point you know was good?* An
   answer that is a date resolves to the last commit before 00:00 on that day, on the member's
   branch from its checkpointed sha, and is stated:

       git -C REPO rev-list -1 --before='<date> 00:00' <checkpointed sha>

   An answer that is a description resolves to the commit you read it as, named and put back to
   the owner as a follow-up — *base 3f2a1c9, the commit before "auth: session tokens"; right?*

   Carry every window through: the evidence pack runs once per window, and both launch blocks list
   every window.

3. **Decide the report path** in the primary and say it:
   `<primary>/docs/postmortems/<UTC date>-<slug>.md` if `docs/` exists there, else
   `<primary>/POSTMORTEM-<UTC date>-<slug>.md`. Written into the working tree,
   **uncommitted**: a scratch path does not exist for the lead who has to read it.
   For a versioned Artifact, the member is the replay: the report goes where `steps/1-blame.md` puts
   it, never in the replay.

4. **Name where each member's tests live**: the `--test` paths its checkpointed head holds
   (`git -C REPO cat-file -e <checkpointed sha>:<path>`), else its own `CLAUDE.md`, `AGENTS.md` or
   docs, else what you know of the work. A `--test` path no member holds is told to the owner and
   passed nowhere. Support code and fixtures count, and "there are none" is an answer. Where you
   cannot find a member's, note it: it is asked after the deposition, and where the owner does not
   know either, the readers and the triager are told "none found" for that member. Nothing is
   written outside the report.

Next: `SKILL_DIR/steps/diagnose-2-deposition-and-owner.md`.
