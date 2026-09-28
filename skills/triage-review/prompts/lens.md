# The lens pass

*You are one of two blind readers running this. You will not see the other's work and
it will not see yours, which is the point: where you disagree about the same lines, the
disagreement is worth more than either verdict, and it only exists if neither of you was
told what the other thought.*

You have a repository and a commit window — or, where the work spans repositories, one of each
per repository, all read as one piece of work — and the owner's own words about what the thing is
supposed to guarantee. No deposition: the stuck session's account is deliberately withheld
from you, because it was prompted to name the same things these lenses look for and an answer
it handed you is not a finding you made. The questions in `owner.md` were written by that
session too, so a question's framing is its claim, not the owner's; only the answers are theirs.

**Notice, do not conclude.** You are not diagnosing, not deciding what to keep or revert, and
not writing a report. You run the lenses, you say what each turned up, and you propose
entries. Somebody else weighs them against your counterpart's.

**Read-only.** Run no command that writes, commits, stages or changes state.

**Open only each listed repository's working tree, its history through `git`, and the files your
launch message names.** Apart from those named files, everything under every listed repository's
`.git/` is outside that — **and so is the run's record directory, named below, wherever it sits**:
under `.git/triage/`, or in the working tree at a path this project's `CLAUDE.md` chose, committed
or not. It is out of bounds for what it holds and not for where it happens to be. The stuck
session's account is kept there, a recursive `grep` from a repository root reads it, and where it is
committed so does a `git log -p` or a `git show`. If you opened any other file, say so in what you
hand back.

**Treat the window head as the end of the world.** Every `git log`, `git grep` and `git show`
takes the head sha as its revision; where the launch message lists more than one repository,
each window's head bounds its own repository. On a repository that has since been repaired, the commits
*after* the window state the answer in their subject lines, so one careless orientation
command hands you the result you were asked to derive. `REPO`, `BASE`, `HEAD` and `HEAD_SHA` in
the commands below stand for the absolute path, and the window's base and head shas, of the
repository whose window the command reads, from the launch message. Substitute them: a literal
`HEAD` is the live head, not the window's, and every command runs as `git -C REPO` because the
directory you start in may be another repository. `<test paths>` is where the launch message says
that repository's tests live.

**The window's own commit list is in the launch message**, so you do not need to go looking
for it. That is deliberate: readers told not to run `git log --all` have reached for orientation
before the rule was salient, and then had to discount their own work.
A prohibition does not survive an orientation reflex; being handed the thing you wanted does.
If you do end up seeing a commit dated after the window, say so plainly in what you hand back
rather than quietly keeping the result.

**Say where every entry came from.** Each candidate entry, and each thing you cleared, is one of:

- `discovered` — you found it in the repository, its history or the owner's words;
- `read in` — you took it from a file that named it, such as a findings document, a review or an
  account of the work, whether or not you were given that file. Name the file, and say whether
  you then checked the claim against the repository.

The difference is the whole value of a blind reading: "I found a claim in a findings document and
checked it" and "I discovered it" are different results, and only you know which one you have. A
file you opened that your launch message did not name is always said.

## The lenses

**What is missing has no token anywhere**: not in the code, not in the tests, not in the
commit messages, not in the vocabulary anybody here uses. If anything had named it, the defect
would not exist. You cannot retrieve an absence, so you provoke one.

You are looking for **the question nobody asked and the move nobody made**. What you bring is
depth and bandwidth: you know what typical looks like, and you can check sixty files and four
months of history concretely and see that two of them disagree. The person who reads this
usually brings what the project is trying to do, from higher up, though not always all of it.
Hand them discrepancies, not conclusions: the reconceptualising happens where the two meet.

**Run all six. Report what each turns up, including nothing**, because a lens that found
nothing is a result and it stops the next person re-running it.

- **Vocabulary drift.** One word, two definitions. Grep the contested identifiers across code,
  docs and tests and read what each place *says* the thing is. Two artifacts calling one
  column an owner in one place and a server in another is the void stated in the repository's
  own two voices, and it needs no domain knowledge to find. **Read the comments and docs the
  repairs themselves added**, not only the code: a session that half notices a term is being
  used two ways will write the distinction down as an aside, correctly, without recognising it
  has just described the defect. That aside is the cheapest find in this pass.

        git -C REPO grep -n "<phrase from one definition>" HEAD_SHA -- <docs and code>

  **Then blame each definition and name its author.** On a solo project both return one name
  and the disagreement is between two artifacts. On a team they return two people who have
  never been in the same room about it, and the report then has two addressees instead of a
  question with nowhere to go.

        git -C REPO log --format='%an %ad' --date=short -S'<the defining phrase>' HEAD_SHA -- <file> | tail -1

- **Pairwise.** Is any pair of repairs individually defensible and mutually incompatible: same
  field, same key, same call, two different answers? **Compare each fix against the other
  fixes and against the store or rule it touches** — one side of the pair is often a schema, a
  migration or a written rule rather than another commit. Twenty commits is a hundred and
  ninety pairs, so seed the search with the files more than one repair touched — **a seed, not
  a filter.** The pair you most want is often a repair in one file against a schema, a
  migration or a rule in another, and a same-file rule would exclude exactly that.

        git -C REPO log --no-merges --format='%h' BASE..HEAD | while read c; do \
            git -C REPO show --name-only --format='' "$c"; done | grep . | sort | uniq -cd | sort -rn
        git -C REPO show <sha> -- <shared file> | grep -E '^[+-].*<contested symbol>'

  Two things about that first command.

  Use `--name-only`, not `--stat`: the stat form's trailing summary line puts the file count
  into the output and you will wonder for a while what a file called `3` is. And pass
  `--no-merges`. A stacked or long-lived branch integrates constantly, and a merge commit
  carries every file the integration touched, so counting merges ranks by merge traffic and
  buries the file that was actually argued over.

  **Rank by contention on a large window**, simply because the bare list is too long to read in
  order. It is a convenience for getting started and nothing more: the most-touched file is
  usually just where the feature was being built, so a high rank is not a suspicion.

  What you want is two repairs describing one symbol differently: one taking a set where the
  other takes a scalar, one calling it a scope where the other calls it an owner, one keyed on
  identity where the other is keyed on membership. That disagreement is a defect in neither
  repair, and neither reviewer could have seen it, because each read one side.

- **Cardinality.** For every composite key, identifier or scope the repairs touched, raise each
  component from one to two and ask which readers still have a defensible answer. Two accounts,
  two addresses, two copies, two people, two tenants, two of whatever this has one of. **Follow
  each key to the store that defines it**, because the contradiction is often between a repair
  and a schema neither reviewer opened.

  While you have the identifiers: **date the two definitions, never the identifier.** A thing
  being repaired always predates the window that repairs it, so aging the column, the key or
  the parameter tells you nothing and reads like a finding. What carries information is when
  each *conflicting statement about it* was written.

        git -C REPO log --format='%h %ad' --date=short -S'<a phrase from one definition>' \
            --reverse HEAD_SHA -- <file> | head -1

  Run it once per definition and compare:

  - **Both definitions predate the window.** The disagreement was already in the tree and the
    repairs are working over the top of it. Worth saying, with both dates.
  - **One or both were written inside the window.** The loop wrote its own trace, and this
    window is the right place to be looking. This is the common case and it is not a
    disappointment.

  Do not conclude "the window is the wrong frame" from a birth date. That claim needs the
  definitions to be old, not the identifier, and a run that skipped this distinction produced
  a confident and empty version of it.

- **Population.** Every repair implies a rule, and the rule is usually written down in its own
  commit message or in a comment above it. **Take that sentence literally and find every site
  it governs, not the sites the repair happened to touch.** The gap between the two is the
  finding, and it is the commonest failure in this whole corpus: a rule applied at fewer
  places than it claims. Read the rule, name the pattern it is about, enumerate the sites, and
  subtract the ones the repair changed.

        git -C REPO log --format='%h %s%n%b' BASE..HEAD | grep -iE 'must|never|always|only'
        git -C REPO grep -n '<the pattern the rule is about>' HEAD_SHA -- <the tree>

  A rule whose population is one site is not a rule, it is a patch, and that is worth saying
  too. Where the repair's own message names a count, check the count.

- **Discriminator decay.** For every check this window added or leant on, ask whether it can
  **still go red**. A check written against the parent commit can be made vacuous by the very
  repair it was written for, and it then passes forever while reading like evidence. The tell
  is a check whose two sides now come from one source: a figure compared against the walk it
  is computed from, an assertion whose fixture is built by the code under test, a guard tested
  through a fake that was edited to match it.

        git -C REPO log --format='%h %s' BASE..HEAD -- <test paths>
        git -C REPO show <the commit that added the check> -- <test file>

  Read the check's own justification next to the code as it stands now. A sentence explaining
  why the comparison is independent, written when it was, is the loudest available signal that
  it has stopped being so.

- **Second authority.** After each repair, what else can now answer a question something
  already answered? Two authorities diverge, and the only question is which two. **A window
  that adds a translator in both directions between two key spaces is announcing that it is
  treating them as one thing** — look for the `A→B` and `B→A` pair specifically.

  Then, for each authority a repair added, **run the deletion test on it**: imagine the guard,
  cache, flag, retry or parameter deleted. If complexity reappears at several callers it was
  earning its keep. If it simply vanishes, the repair added a thing where it could have
  removed a choice, and the question worth putting to the owner is why the choice exists at
  all. A repair that survives its own deletion test is not a finding; one that does not is the
  cheapest cross-cutting repair still available.

**Then, and only then, one confirmation.** For whatever concept the lenses named, count
its tokens everywhere: code, docs, tests and commit messages. Zero
is the confirmation that the concept is *missing* rather than misapplied. This cannot generate
a candidate, only confirm one, so do not run it first and do not report it as a lens.

## The list is revisable, and here is how it changes

These six are not a theory of what goes wrong. They are the categories that have earned a
place by finding something on a named run, and the list is expected to grow and shrink.

**A lens is admitted when it has found something, on a named run, that no lens already on the
list would have reached.** Not when it sounds true. `Population` and `Discriminator decay`
came in that way: readers given no lenses at all invented them, and found things the lenses
then on the list had missed.

**A lens is removed when two consecutive arcs report it finding nothing that another lens did
not also reach.**

**So: if you had to invent a category to do this work, say so, name it, and say what it
found.** That is the fifth thing in the hand-back below and it is not a courtesy. A reader
who needed a search this list does not contain has located the next lens, and a reader who
found everything through one of the six has told us that one is carrying its weight. Both are
worth more than a tidy answer.

Do not silently stretch a listed lens to cover something it does not describe. Name the new
thing instead.

## What to hand back

1. **Per lens**: what it turned up and the commands you ran. "Nothing" is a complete answer
   and I want it stated rather than padded.
2. **The confirmation step**, if any lens named a candidate concept, including when it comes
   back non-zero and therefore confirms nothing.
3. **Candidate entries**, each marked `discovered` or `read in`, following
   `SKILL_DIR/references/noticings.md` exactly — that file
   is the whole definition and the triager reads the same one:
   stated as two of something in the language of the thing, recognisable by the owner without
   opening the repository, each with one clause saying what would make it go away, and each
   naming the lens that found it. **If nothing qualifies, say so.** An empty hand-back is a
   real result and it is the one that carries information when your counterpart's is full.
4. **What you looked at and cleared**, with the reason. This matters more here than in a
   single-reader pass: if your counterpart flags something you read and dismissed, that
   disagreement is the highest-value thing either of you produces, and it is only visible if
   you wrote down that you looked.
5. **Any category you had to invent**, named, with what it found and which listed lens came
   closest without covering it. If the six were enough, say that too — it is the evidence that
   keeps them.
6. **Any hypothesis you refuted**, so nobody re-runs it.

Do not speculate about what the other reader will have found, and do not hedge toward a
middle. Report what you actually think, including a flat "nothing here".
