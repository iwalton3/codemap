# When the thing looping is a document

Read this when what went round the loop is text made for a reader — a page, a spec, a plan, a
handoff, instructions — rather than code. Code that produces a document for a reader is still code.
Everything else in the skill applies; this file says only what changes.

## What drift looks like here

In code, drift is the work anchoring to whatever the latest reviewer claimed instead of to the
requirements. A document drifts differently: it stops doing the job it was written for, and content
keeps being added to it **to defend against the next review**. The additions are usually true and
written for the reader. What marks them is why they were added, not how they read.

So its defects come in two anchors:

- **Purpose:** is it doing what it was written for, for the reader it was written for?
- **Correctness:** does it contradict itself, cite something that does not exist, or re-ask a
  question that was already answered without saying why?

A finding that is true and serves neither is not a defect of the document, however precise.

## Checkpoint and scope — the record

- **In a git repository**, a document runs like code: its commits are its versions.
- **A versioned Artifact is the one document outside git the skill runs on.** Anything else outside
  git — a session transcript, any other document whose versions could be replayed — stops with
  "not a git repository". The Artifact's versions are already replayed into a git repository in
  a temporary directory, one commit per version (`steps/1-blame.md`), and that replay is `REPO` for
  the checkpoint, the evidence pack and the readers' window.
- **The record and the report are never in the replay**, which is lost when the temporary
  directory is cleaned. Where the current directory is a git repository, both are placed exactly
  as they are for code — `references/shared.md` K1, including a destination a
  `CLAUDE.md` names and the rule that a record in the working tree is committed as it is written.
  Otherwise both go in the current directory: `./triage-<YYYY-MM-DD>-<slug>/` and
  `./POSTMORTEM-<YYYY-MM-DD>-<slug>.md`. **That last case is the one nobody named**, so the
  evidence pack is told so with `--records-undeclared` (`steps/diagnose-3-evidence.md`).
- **Checks:** name any the document has — link checks, schema validation, a script that matches
  quotes against their sources — as the checkpoint step says. Often there are none.
- **What the document draws on.** Where it draws on files in the repository — rulings, handoffs —
  name those paths in the lens readers' and the triager's launch messages, because a reader opens
  only what it is given. Where the source was only a conversation, say so in both launches.
  Nothing is excerpted from the conversation.

## Phase 1b — what the document is for

When you ask what the thing must guarantee, also ask what the document must do for its reader:
fold it into the opening question, or ask it as the first follow-up. The product's guarantees and
the document's job are different levels, and a document with no written job gets reviewed against
perfection. The answer heads the envelope in §7.

## Evidence pack

- **Self-fix attribution measures nothing** on a document: it counts lines in code files, and it
  cannot see a correction that adds a clause, which on a document is the normal shape of a
  correction. Expect `NO RATE` and `MEASURED NOTHING` from it.
- **The put-back list and the docs section do read document files**, but only with extensions the
  pack treats as documents (`.md`, `.rst`, `.txt`, `.adoc`). An HTML page, for example, is invisible
  to both; say so in §9.
- **Where any replayed commit says `publish time not held`**, its date is a stand-in, so a per-day
  table, where the pack has one, is reported in §9 as unreliable.
- **Measure instead, per version:** size, lines added and removed, and which added passages trace to
  a review finding. Report both in §9.

## Lenses

- **Pairwise:** statements in the document that name the same event or decision, against each other
  and against the repository files it draws on. Where the source was only a conversation, pairwise
  runs within the document.
- **Population:** every line of the repository files the document draws on, mapped to what the
  document does with it: settled, ambiguous, in conflict with something, or context only. Unmapped
  lines are how a settled question gets asked again. Where the source was only a conversation,
  population is skipped, and the report says it was skipped and why.
- **Discriminator decay** usually has nothing to act on, unless the document has checks. Report
  that; do not stretch it.
- **Checking the owner's answers against what the document states as settled** has been invented by
  a reader once, on the one document run so far. If a reader invents it again, that is a candidate
  for the lens list, through the admission rule in `prompts/lens.md`.

## Report §7

- **The target is the document's job, in the owner's words.** The previous version's defects are
  falsifiers under that target, never the target itself. A review told only to confirm that earlier
  defects are gone has no bottom.
- **"A check observed failing at the parent"** becomes a mechanical check on the text: every quote
  matched against its source file, every number recomputed, every block attributed to someone
  containing only their words.
- **Corrections default to cutting or rewording.** A true finding that serves no reader goes into a
  record outside the document, not onto the page.
- **After several revisions, a fresh synthesis from the sources is safer than another edit**, and
  whoever briefs that synthesis passes on the sources and the owner's words verbatim; the brief's
  own lists of what to keep and what to correct are claims from inside the loop.
