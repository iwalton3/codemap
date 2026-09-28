## Phase 1 — Deposition (you write this, in your own words)

Follow `SKILL_DIR/prompts/deposition.md` and write `RECORD/deposition.md`.

**As you begin it, start the evidence pack**: read `SKILL_DIR/steps/diagnose-3-evidence.md` and run
it for every window that has a base. It is mechanical and its summary goes to a file; read that
summary once the deposition is on disk, not before. A window whose base is open waits until the
owner's answer below resolves it.

Write it **from your own context, before you read the evidence pack, before the owner is
asked anything about the artifact, and do not revise it afterwards**. Do not re-read the code to
check yourself first.
Its value is that it records what you believed at the moment help was asked for; the triager
checks it against the record, and the gap between the two is the most useful thing this skill
produces. A deposition corrected in advance destroys that gap and reports health.

## Phase 1b — Ask the owner (after the deposition is written, never before)

Where a window's base was open, start its evidence pack as soon as its base is resolved: at the
answer for a date, at the owner's confirmation for a description.

Start with one question, in their own words, **derived from this
work rather than picked off a list.**
You are the session that has been in it, so you know what the repairs kept fighting over.
Name those two or three things in the project's own nouns and ask what each one means and
what the code owes it.

The shape that has worked: *what is this supposed to guarantee, and when you say `<their
noun>`, what is one of them and what makes two of them the same one?* But **the nouns must
come from this repository**, and so must the second half of the question. A stored record
wants asking who may see it and what makes two the same; a compiler pass wants asking what
must still be true after it runs; a retry wants asking what is safe to do twice; a renderer
wants asking what the user is entitled to see and when. Asking a fixed question drawn from
somebody else's project will be leading where it half fits and nonsense where it does not.

**Ask here what the checkpoint step could not resolve**, and only that: the last point the owner
knows was good, per member whose base the checkpoint step left open; where each member's
tests live, for each member whose tests you could not find. Where the owner does not know, the
readers and the triager are told "none found" for that member. A last good point given as a
description is put back as a follow-up naming the commit you read it as — *base 3f2a1c9, the
commit before "auth: session tokens"; right?* — and the question and answer go into `owner.md`
like any other.

Take whatever comes back verbatim into `RECORD/owner.md`. Do not paraphrase it, do not
research it first, and do not argue with it. And take whatever else they say: an answer that
arrives in three unrelated pieces is not a malformed answer, it is part of the shape of the
criterion. What it leaves out is still open.

**`owner.md` reaches the blind lens readers, so the question must not carry the review's
framing** (`references/diagnose.md`, *Diagnosis questions*): state cases in the artifact's own
terms — *a retry here sends the confirmation email twice when the first response is lost; is that allowed?* —
never with quoted finding text, finding ids, site lists, group names or counts.

**Follow-ups are allowed, and they have done real work**: the second half of the opening question
has gone unanswered, and a criterion has arrived in the third exchange. Put each as a concrete case
like the one above, and record the question and the answer in `owner.md`, both verbatim. The
deposition stays as it was written.

**`owner.md` is frozen the moment the lens readers launch.** A later answer goes to
`RECORD/owner-late.md`, which the triager alone reads.

If they decline, are not around or do not know, say so and carry on. That is a finding in
itself — the criterion may not be written or held anywhere yet — and it points at what would
settle it.

Next: `SKILL_DIR/steps/diagnose-3-evidence.md`, if you have not started it.
