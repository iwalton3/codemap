# The deposition

*You are the session that has been doing the work. Write this in your own words, to
`RECORD/deposition.md`, before you read the evidence pack, before the owner has been
asked anything about the artifact, and do not revise it afterwards.*

This is a request for help, not a report of results. Write it the way you would explain the
situation to a colleague you just pulled in: what you were trying to do, what you did, what
you tried that did not work, and where you are now. Prose is fine and preferred. There is no
length target; it is done when somebody who was not here could take over.

**Do not go and check yourself first.** Do not re-read the code, re-run the suite or verify
a claim before writing it down. The triager checks these claims against the record, and the
gap between what you believed and what the record shows is the most useful thing this
produces. A deposition corrected in advance has no gap and reports health.

If you notice while writing that something you believed is probably wrong, **leave the
belief in and add a line saying you now doubt it.** That is data, not an error.

## Five things that must be in it

They are the claims that most often turn out to be where the loop lives, and each one is
checkable against the record.

1. **What you were asked for, and what you decided yourself.** Separate the two. Quote the
   instruction if you have it. Where an acceptance criterion came from matters more than
   what it says: something authored before this work and elsewhere is a different kind of
   target from something you inferred while working.
2. **What you changed to make something pass** — tests, fixtures, expected values, golden
   files, the spec itself. Name each one. If closing a problem meant editing the thing that
   was supposed to detect it, that artifact is why the problem was invisible and it is the
   first thing the triager will look at.
3. **Which tests you watched fail before the fix, and how you watched.** For each test added
   or repaired: observed red before the change, or not. "I followed fail-first" is not the
   evidence; the observed failure is. A test written after a fix, against the fixed code,
   can pass on the unfixed code too, and nobody would know.
4. **The last point you know was good**, as a commit, a moment or a description, and how you
   know.
5. **What you are unsure about, and what you were about to do next.** Including the thing
   you would have done if nobody had stopped you.

## Also worth writing, if it applies

- The order things happened in, roughly: what the first problem was, what each attempt
  changed, what the next problem was. A loop is only visible as a sequence.
- **Any call you kept making that nobody handed you**, and where it came from. A judgement
  applied once is a decision; applied across sites without anybody ratifying it, it is a
  reflex, and a reflex is not a specification. A session that wrote this line down had found
  the defect before the triage started.
- **Any term you have been using that means two things** in two places, and any fact you
  asserted from memory rather than from something you read or ran.

- Anything you tried that you then backed out, and why.

- Anything that surprised you.
- Where you think the problem is now, stated as a guess rather than a conclusion.

## What not to do

- Do not summarise the diff. The triager reads the diff.
- Do not argue the fixes are correct. You wrote them and the tests asserting they are
  correct, so neither is independent evidence, and the triager is told this.
- Do not leave out an attempt because it was abandoned or embarrassing. An abandoned attempt
  is often the one that names the real constraint.
- Do not tidy the account into a clean narrative. The mess is the specimen.
