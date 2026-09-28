## Phase 3b — Triage (one agent, the Delegate Model; never a fork)

Launch one `general-purpose` agent and **end the turn**. A finished agent re-invokes you; a
shell loop or repeated `echo` while it runs is a busy-wait that buys nothing.

> Follow `SKILL_DIR/prompts/triager.md` verbatim. It is your whole procedure; this message
> adds only paths.
>
> `<Where the unit has more than one member, give repository, window, in-flight commit, where the
> tests live, evidence pack and checkpoint once per member, under its label and absolute path.>`
>
> - repository: `REPO`
> - window: `<base sha>..<head sha>` (`<what the base is and how it was found: the ref the user
>   named / the merge-base with origin/HEAD (<its target>) / the merge-base with <name>, git's
>   configured default (init.defaultBranch or built-in) / an empty window, no finding's lines in
>   this repository / the replay's v1 / the date resolved / the description confirmed>`)
> - in-flight commit: `<its sha, or "none">` — the stuck session's work in flight, committed before
>   the checkpoint. The evidence pack counts it; it is not a repair round.
> - where the tests live: `<the paths from the checkpoint step or the owner, "there are none", or "none found">`
> - lens readings: `RECORD/lens-a.md` and `RECORD/lens-b.md`
> - deposition: `RECORD/deposition.md`
> - sort of the round that stopped the loop: `RECORD/sort.md`
> - the owner's own words: `RECORD/owner.md` (`<or "the owner was not asked, and why">`)
> - answers that arrived after the readers launched: `RECORD/owner-late.md` (`<or "none">`)
> - evidence pack: `RECORD/evidence/` (`<or RECORD/<label>/evidence/ per member>`)
> - checkpoint: `<tag name>`
> - report template: `SKILL_DIR/references/report.md`
> - what counts as a noticing: `SKILL_DIR/references/noticings.md`
> - `<if the work is a document:>` `SKILL_DIR/references/artifacts.md`, and what the document
>   draws on: `<the paths of the files in the repository it draws on — rulings, handoffs — or "a
>   conversation only: pairwise within the document, population skipped">`
> - write the report to: `<report path>`
>
> Write the report yourself, at that path. Reply with the path, the two halves of the
> diagnosis and the decision you recommend, one line each, and nothing else.

Two readers is the whole of the parallelism. **One triager, still.** If it asks a question
instead of returning a decision, answer it once with `SendMessage` to the same agent. Do not
restart with a fresh one and do not run a second triager: two readings of the evidence are
what you want, two frames arbitrating the recovery are the failure this skill exists to end.

## Phase 4 — Relay the void, then put the easy moves to the user

Everything you put in front of them should be something they can mark wrong or dismiss in a
sentence, not a reading to approve: an incomplete statement that looks whole gets approved as
fitting, and the approval settles nothing.

Read the report's executive summary, §2, the opening of §5, the decision section and the
belief-versus-record section. Give the user:

- **what doesn't add up (§2), in the report's own words and not summarised.** Lead with this.
  It is the part they can act on, and the part most likely to meet what they know of what the
  thing is for: a discrepancy they recognise in one line is worth more than any conclusion in
  the file. Say
  which lenses turned up nothing, too;
- **the domain-model sentences that open §5, verbatim.** They are what the report believes the
  thing means, and the one part of the diagnosis they can mark wrong without opening the file;
  name the mechanism in a clause, no more;
- the delta entries that change a decision, which are the ones about your own beliefs;
- the three kill conditions from §5, in the report's own words. They are what the next person
  scores this diagnosis against, and nobody will if you do not repeat them;
- the report path, said plainly enough that they can send the file to somebody else. It is
  written to be forwarded, and forwarding it is often the right next move.

**The report is produced every time.** It is the output of this skill and it does not depend
on anything below.

**Then put the easy moves to them**, where there are any, with `AskUserQuestion`. An easy move
is a question with a small set of concrete answers where naming the answer unblocks the work:
the decision in §3 when it has genuinely forked, and the questions in §10 that the owner alone
can settle. Up to four, each with the options and their costs, and your recommendation first and
marked as such where the fork is genuine, carrying its downsides and what choosing it covers up:
the recommended option is the one most likely to fit their intuition while incomplete.
Each is written out in full in the question's own text, not the message above it — the fork or
the §10 question itself, not its section number, and never as the triager's — because opening the triager's output discards the
pending questions, and answering should not need the report open (`references/shared.md` Q1).
A fork put as a choice is answered in one exchange; the same fork in
prose gets deferred, and the option that happens by default is always the one that resumes the
loop.

**Where there is no easy move, say so and do not manufacture one.** That is not a failure of
the run. The hard case is precisely the one where the move is unavailable to you for want of
context or domain knowledge, and unavailable to them because they cannot see it from inside a
large diff after several rounds — or unavailable to both of you so far. In that case the report
**is** the deliverable: its job is to put enough of the shape in front of them that, between
you, it can be named, or that you can say what would find it out.
Three invented options are worse than one honest sentence, because they imply the analysis got
further than it did and they spend the attention that was going to go on §2.

**Do not apply the answer in this session.** A choice is not an instruction to begin: relay
what they picked, hand on the envelope, and write the handoff below. Whether the triage is right is
the user's call, the evidence is in the file so they can check it, and the commands are there to
re-run.

**Append the exchange to the report as §11, and nothing else.** Each question and its answer,
verbatim. A picked option is recorded as its label with the option text marked as yours: it is
your sentence with their click on it, not their words. No reading of the answers against §5 and
no hypothesis labelled as one — a hypothesis appended here has been ratified as a requirement
anyway.

Two things to say plainly in the relay, both of which are easy to get wrong in your own
favour:

- **Say what noticed the loop — the mechanical trigger, a review or a person.** Crediting one
  with what another caught puts the next process decision on a false premise: "I noticed"
  over work that was prompted inflates the tooling, and crediting a person with what the
  trigger caught hides that it works. In the runs so far the frame-break has nearly always come
  from outside the session.
- **If you quote the numbers from §9, quote them as the triager stated them**, with their units
  and the floor caveat.
  Never collapse them into one rate. Three instruments over the same window answer in three
  units and are distorted in different directions; a single percentage quoted to a lead gets
  quoted back forever.

**Then write the handoff to planning** (`references/diagnose.md` D8): `RECORD/handoff.md`. At its
head: that it is resumed with `/ez-plan --resume RECORD/handoff.md`, that it came from the
diagnosis route, and that it is deleted once the plan is implemented, or cleaned up where the work
is done without one (`references/shared.md` K4). It names the report, `RECORD/sort.md`,
`RECORD/owner.md` and every `--spec` by path; `ez-plan` reads the report's §3 decision and §11
answers as rulings. Tell the owner its path and that command, commit the record where it is in the
working tree (`references/shared.md` K2), and stop.

This is the last step.
