Read `SKILL_DIR/references/codemap-workflow.md` at entry if not already read. Its capability and record-identity rules apply before publishing or consuming authority.

For a versioned Artifact unit outside git, preserve its existing absolute current-directory
RECORD and artifact URL/version identity. Skip the git resolver; never use the temporary replay's
common directory as this run's durable record. This exception is only the existing Artifact route.

## Which input

Read the arguments (`references/contract.md` Z1):

- **`--resume <path>`** — a handoff. `RECORD` is the path's parent directory. Read `handoff.md`,
  then `sort.md`, `decisions.md`, `owner.md` and any `open-decisions.md` by the paths it names, and
  every `--spec` path it names. The unit is `sort.md`'s round section.
- **`--round <RECORD>`** — a round `/triage-review` sorted and handed over in this session, or named
  in a diagnosis relay for a later one. Read `RECORD/sort.md`, `RECORD/owner.md` and
  `RECORD/open-decisions.md` where it exists, and every `--spec` path passed with it. The unit is
  `sort.md`'s round section.
- **Anything else** — a todo list, the session's items, or diffuse context. Establish the unit from
  the work and say it (`references/shared.md` U). `RECORD` is created after the tree survey below,
  under `plan/` (`references/shared.md` K1), with a slug chosen from the work.

For git runs, on `--resume`/`--round`, validate the retained absolute `RECORD` with
`python3 SKILL_DIR/scripts/run_record.py --repo REPO --skill ez-plan --record RECORD --resume`
before consuming any codemap ID or owner authority. For a new run after the tree survey, use
`python3 SKILL_DIR/scripts/run_record.py --repo REPO --skill ez-plan --slug <date-slug>`;
add `--record <explicit skill destination>` where instructed, and retain the returned absolute path.
A legacy run without a manifest needs an explicit ownership check before adopting it; do not
silently create a manifest around another repository's records.

## The tree

Run `references/shared.md` G1 on every member, whichever input this is: a discussion may land fixes,
and a committed record needs a clean tree. Where it commits in-flight work on a handoff, append that
commit to `sort.md`'s round section under its member, marked as a resume-time commit no review
covered; on a todo list or the session's items, it is the member's in-flight commit in the round
section you write below.

**On a versioned Artifact round** there is no tree: check the replay path `sort.md` names instead, and
stop as `references/shared.md` U says if it is gone.

Commit the record as it is written where it is in the working tree (`references/shared.md` K2).

## The walls

Find what already decides fixes in this unit: `docs/rules/INDEX.md` and the area docs it points to,
and the `## PRINCIPLES` section of each `CLAUDE.md` in scope, the user's global one included. Note
each path, or `none`. Settling (`steps/2-opening.md`) cites them. On `--round`, use the list in
`sort.md`'s round section; where it has none, find them as above.

## The sort, on a todo list or the session's items only

1. **Itemize** the input into `RECORD/findings.md` (`references/shared.md` S2), numbered as
   received. Where it was diffuse — a discussion, things mentioned in passing — say at its head that
   you itemized it, so the owner can see what you took to be an item. **On a planning-only
   conversation** (`references/contract.md` Z9), first write to `RECORD/owner.md`, verbatim,
   everything the owner said about planning the work that is still current and not refuted by a
   later turn. Then, where the conversation did not both list the work items and check them against
   the code's actual state, do what is missing now, against the code as it stands.
2. **Sort it yourself** into `RECORD/sort.md`, in the four work-item categories
   (`references/contract.md` Z2): deduplicate, group, give each item with sites its command, what
   settles it and its level — as `SKILL_DIR/../triage-review/prompts/sorter.md` defines them, or
   `references/shared.md` L where that file is not installed — and measure what can be measured
   rather than argue it. There is no blind sorter and no arbitrator. Write everything
   `references/shared.md` S2 lists — that one sorter sorted it and the owner reads every item, the
   round with the unit and each member's in-flight commit, the sentence of counts, carried sentences
   and `Uncovered:` — because a later `--resume` recovers the unit from it.
3. **Land nothing.** Every item waits for the owner (`references/contract.md` Z2).

Next: `SKILL_DIR/steps/2-opening.md`.
