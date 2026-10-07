# Asking the person, and recording what they said

A person's answer becomes a **ruling** codemap can act on only when codemap can see the question
they were shown and their own words. A summary of what they said is not one.

## Asking

1. **Decide where to ask, first.** In the session with `AskUserQuestion` is the default, and the
   only route for `/ez-plan` and `/triage-review`, which do not use questionnaires. For any other
   ask, the round may go out as a questionnaire instead — when `questionnaire_list` shows
   `codemapOpen.open`, or when the person asks to answer later. A questionnaire is attached only
   when the round is posted, so this comes before the post.
2. **Post once.** `post_round` with each decision's exact question (`payload`), per option its
   `effects`, and the questionnaire if step 1 chose one. The question text names its ref and every
   finding its options act on. If it answers `alreadyRuled`, the round is posted anyway: codemap
   learns of a standing ruling only by posting. Tell the person there is a standing ruling, and
   withdraw the now-redundant question with two readers (*Withdrawing a question*, below).
3. **Ask.** Ask with `AskUserQuestion`, using the returned `ask` payload **verbatim**. A paraphrase
   cannot be matched. For a questionnaire, see *Waiting on a questionnaire*.
4. **Log it.** After every `AskUserQuestion`, `log_question` with the round. codemap finds the call
   in this session's transcript itself — you cannot see its id — and reads the question and the
   answer from there. Two unlogged calls asking that round's questions are refused, naming both: log
   each by the `toolUseId` the refusal gives. Retrying is safe.

## Waiting on a questionnaire

`sync` before you give the person the link: a staged round is invisible to a browser
(`SKILL.md`, *More than one write*). Then `questionnaire_status` for its cursor, and
`questionnaire_wait` with that cursor for up to 60 seconds. It observes only this machine:

- `changed`: read the answers (`questionnaire_detail`).
- `timedOut`: `pull`, which is how a teammate's answer arrives, and `questionnaire_status` again.
- `blocked`: a result — report it.

If nothing has come back, give the person the link and end the turn; resume from its answers. Anyone
on the team may answer it under their own name.

## Typed answers

When the person types instead of picking ("D2 B", or free words), `relay_answer` with their whole
message as `words`, exactly as typed. codemap finds the message whose whole text is those words and
copies it from the transcript; it parses nothing. If no message matches, the words are recorded as
unverified, which only unblocks. Then:

- **A `words` decision**: the typed answer IS the answer. There is nothing to read, and
  `reader_brief` refuses it.
- **Anything else**: a reader binds the words. `reader_brief` gives the exact prompt; launch a fresh
  subagent with exactly that; `record_reading` records its verdict. Until a reader binds them, the
  words wait.

## Before acting on a ruling

- `pull` first, then `decision_rounds` / `decision_round`: what is waiting, what is ruled but not
  carried out, readings in dispute. A `blocked` read still serves stored rows, which may be old:
  report it instead of acting on them.
- **`possiblySuperseded`**: the person's later words may overturn the ruling. Do not act until it is
  settled. By its `state`:
  - `unread`: bind the words first — your own reading as `maps` to `confirm_reading`.
  - `disputed`: `confirm_reading` puts both readings to the person.
  - `unclear`: `confirm_reading` refuses it; re-ask the original question itself.

  A confirm is answered in the session: ask it verbatim with `AskUserQuestion` and `log_question`
  it with its round. `confirm_reading` posts it into the words' own round, a questionnaire's
  included, and the questionnaire page cannot answer it — so ask it here even then.
- A ruling that looks wrong, or conflicts with another: `report_ruling` asks its principal whether
  to withdraw it. Only their "Withdraw it" lets `withdraw_decision` retire it.
- A ruling is not a close. A settle holds its finding until it is carried out (below).

## Withdrawing a question

An **unanswered** question an agent may withdraw with two readers' verdicts; a **ruling** only its
principal retires (above).

1. `withdrawal_reader_brief` with the decision, your reason and `slot: 1`, then `slot: 2`.
2. Launch a fresh subagent for each with exactly the returned prompt, from this session. It calls
   `submit_withdrawal_verdict` and reports the receipt it got back.
3. `withdraw_decision` with the reason and `review: { readers: [{ requestId, receipt }, …] }`.
   codemap finds each reader's call by its receipt. If the two disagree, `withdrawal_reader_brief`
   `slot: 3` with both refs gives the arbitrator's brief; pass its ref as `arbitrator`.

## Carrying out a settle

A person's settle ruling (refuted, or an explicit acceptance) closes its finding only when it is
applied, from this session — never by a claimed repair verifier, whose role cannot call these tools:

1. `application_reader_brief` for the ruling and the issue. `directMention: true` means one reader
   is enough; otherwise two, and slot 3 arbitrates if they disagree.
2. Launch each reader as a fresh subagent, from this session, with exactly its prompt; it calls
   `submit_application_verdict` and reports the receipt it got back.
3. `record_application_verdict` with each receipt. It returns the reader's ref; `pending` means
   call again in a moment.
4. `apply_ruling` with those refs. It rechecks the current context and refuses a stale one.
