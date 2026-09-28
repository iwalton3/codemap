## Phase 3a — Two lens readers (the Delegate Model; in parallel, never a fork)

Launch **two** `general-purpose` agents in one message so they run concurrently, with the
identical block below, and **end the turn**. They must not see each other, must not be told
the other exists, and must not be given the deposition or the sort: a reading that inherited
the stuck session's account is not blind to it, and its agreement with it would mean nothing. A sort is worse than either — it is a list of sites,
and it hands a reader the site-shaped reading this skill exists to get above.

Two, because a single reader's clearance is silent. Two blind readers bring different invented
priors to the same lines, so where one flags what the other cleared, the conflict lights up;
under one reader the clearance is the only reading and the finding does not exist. The cost is
one extra independent pass over a read-only step, and it buys the part of this skill with the most
evidence behind it.

> Follow `SKILL_DIR/prompts/lens.md` verbatim. It is your whole procedure; this message adds
> only paths.
>
> `<Where the unit has more than one member, give the five lines from repository to where the tests
> live once per member, under its label and absolute path.>`
>
> - repository: `REPO`
> - the run's record directory, which is out of bounds whether or not it is committed: `RECORD`
> - window: `<base sha>..<head sha>`
> - in-flight commit: `<its sha, or "none">` — work in flight that the stuck session committed before
>   the checkpoint. It is inside the window and is not a repair round.
> - the commits in it, oldest first: `<paste `git -C REPO log --reverse --no-merges --format='%h %ad %s'
>   --date=short BASE..HEAD` here, so no reader reaches for an orientation command; "none" for an
>   empty window>`
> - where the tests live: `<the paths from the checkpoint step or the owner, "there are none", or "none found">`
> - the owner's own words: `RECORD/owner.md` (`<or "the owner was not asked, and why">`)
> - what counts as a noticing: `SKILL_DIR/references/noticings.md`
> - `<if the work is a document:>` `SKILL_DIR/references/artifacts.md`, and what the document
>   draws on: `<the paths of the files in the repository it draws on — rulings, handoffs — or "a
>   conversation only: pairwise within the document, population skipped">`
>
> Reply with your lens results, your candidate §2 entries, what you cleared and why, and any
> hypothesis you refuted. Mark every entry `discovered` or `read in`, as your procedure says. Write no
> file.

Save each reply verbatim to `RECORD/lens-a.md` and `RECORD/lens-b.md`. Do not summarise
them, do not merge them, and do not read one to the other.

Next: `SKILL_DIR/steps/diagnose-5-triage-and-relay.md`.
