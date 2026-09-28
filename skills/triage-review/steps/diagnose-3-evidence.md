## Phase 2 — Evidence pack (mechanical; it starts with the deposition, or once an open base is resolved)

    python3 SKILL_DIR/scripts/evidence.py --repo REPO --run-dir RECORD \
            --since <window base> --until <window head sha> \
            --records <a directory holding run directories>... \
            --reports <the working tree the report goes in> \
            [--spec <path this member holds>]... \
            > RECORD/evidence-summary.txt

`--records` is `RECORD`'s parent directory — `$(git rev-parse --git-common-dir)/triage` for the
primary, or wherever a `CLAUDE.md` override put it (`references/shared.md` K1), or for a Claude
Artifact run outside git, the current directory. **Repeat it for `ez-plan`'s store** where a
`CLAUDE.md` names a destination for `ez-plan`: its plans hold the owner's intent (K5). **In the
Artifact-outside-git case, and only there, add `--records-undeclared`**: nobody named that
directory, so only `triage-<date>-<slug>` and `plan-<date>-<slug>` count as runs inside it.
Everywhere else the directory was named and the flag is omitted — the pack reads the declaration and
never a path's shape (`references/diagnose.md` D5). The pack also searches both default locations,
`triage/` and `plan/`, deriving them from the primary itself, so an override never loses the runs
still sitting behind it. `--reports` is the primary's
working tree, or the current directory. Neither is the replay.

**Where the unit has more than one member**, run it once per window, with that member's `--repo`
and `RECORD/<label>` in place of `RECORD` in both paths, creating that directory first — the
shell opens the summary file before the script runs:

    mkdir -p RECORD/<label>

Only the primary window passes `--records` and `--reports`; every other window passes
`--skip-prior` instead, because earlier runs and reports live only in the primary, and its
`prior.md` says the search was skipped and why.

**Pass `--until` explicitly**, as the sha the checkpoint tagged, not the default of live
`HEAD`. Phase 1b waits on a person, and a commit landing during that wait would otherwise
give the pack and the two readers different heads to reason about.

Mechanical, no agent, seconds to a minute. Its summary goes to a file rather than into this
session: read it once the deposition is on disk. It writes `RECORD/evidence/`
and a summary: the commit window, the self-fix shape by more than one instrument with its blind
zone, a per-day table, the files where one commit took a line out and a later one put it
back, what the window did to named criteria and docs, and prior records. Prior records include,
from each earlier run directory, `sort.md`, `owner.md`, `owner-late.md`, `plan.md` and
`deposition.md` — never the current run, and never its readings — and every earlier report at both
report paths, uncapped; and also the older roots: `review/` in the git common directory of the
repository the report is written into, files under `docs/` whose names or folders look like
records, and that directory's session `artifacts/` directories — taken from `--reports`, never the
replay's. `--additions` lists the commits attribution is blind to.

One argument is worth real thought before the run:

- **`--spec <path>`**, a file or a directory, whenever the work has a written criterion. Each
  window gets only the `--spec` paths its member holds at its window base or head
  (`git -C REPO cat-file -e <sha>:<path>`), both windows where both do; a path no member holds is
  told to the owner and passed nowhere, on a one-repository run too. The pack lists each commit
  that changed a file under it, up to 40 per path and then a `git log -p` command for the rest —
  what it removed, what it added, how many code commits came before — and judges none of it. A
  rule edited, or a new rule added, while the rounds were judging against it is where contract
  drift shows; whether a change conflicts with another rule or with what already exists is for
  the readers and the triager to say.

**Three results are not failures and must reach the report as themselves.** `MEASURED
NOTHING` means an instrument found no lines to attribute, and it is never to be relayed as
health — a postmortem has published a credible `0.0%` from a silently
broken command. `NO PRIOR RECORDS FOUND` means no record was found, which is neither a clean
history nor a fault: a first run in a repository will always find none, and what follows is
that any account of earlier rounds is the deposition's memory and nothing else. A window run with
`--skip-prior` says `SKIPPED` instead, which says nothing either way: the primary window's list is
the one to relay. `NO COMMITS IN WINDOW` means nothing landed in that window, or only bot noise:
valid where the repository belongs for its specs or tests, otherwise the base may be wrong, and it
is relayed with that clause. The pack is still written in full, prior records included, and says
`MEASURED NOTHING` once for the self-fix instruments and the put-back list.

Next: `SKILL_DIR/steps/diagnose-4-lens-readers.md`.
