Read `SKILL_DIR/references/codemap-workflow.md` at entry if not already read. Its capability and record-identity rules apply before publishing or consuming authority.

**Where the findings are about a versioned Artifact**, read *A versioned Artifact* below first: the
unit is the replay alone, the tree does not apply, and the record and the blame change.

For a versioned Artifact unit, enter *A versioned Artifact* below first and skip the ordinary
unit/tree/git record resolver. Preserve the existing outside-replay RECORD placement and artifact
URL/version identity; never resolve its record under the temporary replay's git common directory.

## The unit

Establish the unit from the findings, the owner's reference and the work you hold, and **say it**:
each member's absolute path and why it belongs (`references/shared.md` U). The owner may correct
it; it is not a question. The repository you are running in is the **primary**.

## The tree

Run `references/shared.md` G1 — nodes 2 and 3. **Survey every member first** with plain
`git -C <member> status`, untracked files included, and commit nothing yet. Each member is one of:

- **anything unusual** (`references/shared.md` U) → abort at once, asking nobody and committing
  nothing anywhere; name each such repository and what `git status` said, with the `HEAD` sha where
  it is detached. When the owner says to resume, survey every member again.
- **clean** — nothing to do.
- **in-flight work** — to be committed by path, never `git add -A`.
- **something objects to committing it** — another agent's work, temporary files, secrets, build
  output, an earlier report left untracked, anything unexpected → ask the owner once, naming every
  repository and what objects in each. An earlier report is theirs to decide on: say such reports
  are generally committed before another run, and recommend it. The answer is not recorded.

If any tree is still dirty and cannot be committed, stop before committing anything. Otherwise
commit each member's in-flight work: `git -C <member> add <paths>`, then
`git -C <member> commit -- <paths>` — the `add` is not optional, because `git commit -- <path>`
refuses a path git has never tracked. Anything unexpected in git stops you as
`references/shared.md` G2 — which names any agent still in flight, the blind sorter once it is
launched below.

Tell the owner what you committed. Each sha is that member's **in-flight commit**; on the diagnosis
route the readers and the triager are told it is not a repair round.

## The record

Choose the slug from the review — a few words naming what it reviewed — and create `RECORD` from
the primary before anything is saved:

    python3 SKILL_DIR/scripts/run_record.py --repo REPO --skill triage-review --slug <YYYY-MM-DD>-<slug>

Use the returned absolute `record` path as `RECORD`; retain its repository identity.

**Unless a `CLAUDE.md` in scope names a destination for this skill by name**, in which case create
it there, a relative path taken from the primary's working tree root (`references/shared.md` K1).

Then settle how it is kept, once, and say which: `git check-ignore -q <RECORD>` in the primary.
Ignored, or under `.git/`, and nothing is committed. Otherwise **every step commits what it wrote to
it before that step ends** (`references/shared.md` K2). Tell the owner its path and whether it is
committed.

**Write `RECORD/findings.md` first** (`references/shared.md` S2): F1..Fn in the order received,
across every source, under a heading per source, each with the source's own id in brackets where it
has one and **its full text, copied — never a pointer**. One comment making two claims is still one
finding; the sort decides what it covers. Every later step names findings by F-number.

## Purpose — documents only

Where the artifact is a document, write one or two sentences: what it is for, and for whom
(`references/shared.md` S1). Where you cannot, write `not stated` and ask nobody. On code, skip
this.

## The written criteria

What the work under review was built against (`references/contract.md` R3): each `--spec`, and each
`plan.md` a `Work-plan:` trailer in the reviewed range names — `git log --format=%B <range>` per
member, the trailer's run found where `references/shared.md` K5 looks. Where there are none, the
list is `none`.

## Launch the blind second sort

**Always, and now, before blame** (`references/contract.md` R3). **Do not wait on it** — launch it
and go straight on to blame. Give it nothing of your own reading:

> Sort these review findings. You are read-only and propose no fixes.
>
> - the findings, numbered: `RECORD/findings.md`
> - what the artifact is for: `<the purpose sentences, "not stated", or "code">`. *Out of scope*
>   is a verdict only on a document with a stated purpose: never on code, and never where it is
>   `not stated`.
> - the sorting rules — deduplicating, the covers format, the two kinds, the definitions, the
>   defect-pattern rule and the group-1 exclusions: follow `SKILL_DIR/prompts/sorter.md`
> - the artifact: `<each member's absolute path and commit, or for a document, the version under
>   review>`
> - what the work was built against: `<the written criteria above, or "none">` — read them to judge
>   a finding, as the artifact's own requirements
>
> Per item: the findings it covers (`covers F4, F30`); a group; for group 1 its kind, the sites
> you counted and the command; for group 5 its refutation; and what the "why" rests on.
>
> **Write your finished sort to `RECORD/sort-b.md` yourself**, and **return nothing of it in your
> reply** — not the sort, not a summary, not what you made of any one finding. Another sorter is
> reading the same findings while you work, and your reading must not reach it. Reply only that the
> file is written.

`steps/3-blind-sort.md` collects it.

## Blame every finding

**First, where the findings came from** (`references/contract.md` R1). Where what you were handed
is **new work against existing code** — a bug tracker's issues, a feature list, a report from
outside the project — no finding is fixes on fixes, and blame below only records where each lands.
Say which it was in one sentence, for the round section of `sort.md`.

For each finding, blame the lines it names in the member that holds them — `git log -L`, or
**Blame with `-M -C -w`**, so a moved line is attributed to the commit that wrote it. Where the
blamed commit carries `Review-round:` or says it applied review findings, confirm with
`git show <sha> -- <path>` that it **wrote** the lines: adding the line at one place and deleting
it at another is a relocation, not fixes on fixes. Lines that only record the owner's words —
`owner.md`, `owner-late.md`, anything under a run's `RECORD`, a file of rulings — are never fixes
on fixes.

Write down, per finding: fixes on fixes or not, the member and the commit. Nobody is asked anything
here, except on a versioned Artifact as below.

## A versioned Artifact

The one document outside git this skill runs on (`references/contract.md`, *For a Claude
Artifact*). Anything else outside git — a session transcript included — stops: "not a git
repository".

- **A unit of one**, the replay; skip *The unit* and *The tree*. `RECORD` is placed as
  `references/shared.md` K1 says, never in the replay.
- **Build the replay**: a fresh git repository from `mktemp -d`, one commit per version, message
  its label or `unlabelled`. Date each by its publish time where you hold one, otherwise by the
  nearest later time you hold, keeping the order, and say `publish time not held` in that commit's
  message. Take the versions from what this session holds — files it published, its conversation,
  a handoff file — plus the live version from the Artifact tool's `read`; assume no way to fetch
  past versions. A version not held is named in `sort.md`, noted in the next replayed commit's
  message, and treated as unlabelled. The replay is `REPO` for blame, the evidence pack and the
  readers' window.
- **Fixes on fixes, per version**, from its label, this session's record or a handoff file; failing
  those, inferred, and marked as inferred. Where an inferred call alone decides whether the round
  is fixes on fixes, ask the owner now, in the Artifact's terms — *was this version published to
  apply review findings?* — and write the question and answer verbatim into `sort.md`.

Next: `SKILL_DIR/steps/2-sort.md`.
