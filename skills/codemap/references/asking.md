# Asking the person, and recording what they said

A person's answer becomes a **ruling** codemap can act on only when codemap can see the question
they were shown and their own words. A summary of what they said is not one.

## Asking

1. **Post first.** `post_round` with each decision's exact question (`payload`) and per option its
   `effects`. The question text names its ref and every finding its options act on. If it answers
   `alreadyRuled`, tell the person there is a standing ruling rather than asking again.
2. **Ask where they are.** `questionnaire_list`: when `codemapOpen.open` is true, post the round
   with a questionnaire, give the person its link, and wait with `questionnaire_wait`. Otherwise
   ask with `AskUserQuestion`, using the returned `ask` payload **verbatim**. A paraphrase cannot
   be matched.
3. **Log it.** After every `AskUserQuestion`, `log_question` with its tool-use id and the round.
   codemap reads the question and the answer from this session's transcript. Retrying is safe.

The person may defer a batch into a questionnaire instead. Anyone on the team may answer it under
their own name.

## Typed answers

When the person types instead of picking ("D2 B", or free words), `relay_answer` with the message's
transcript entry id. codemap copies the whole message and parses nothing. A reader binds the
words: `reader_brief` gives the exact prompt, launch a fresh subagent with exactly that, and
`record_reading` records its verdict. Until a reader binds them, the words wait.

## Before acting on a ruling

- `decision_rounds` / `decision_round` show what is waiting, what is ruled but not carried out, and
  readings in dispute.
- **`possiblySuperseded`**: the person's later words may overturn it. `confirm_reading` posts the
  confirm question; ask it verbatim and log it. Do not act until it is settled.
- A ruling that looks wrong, or conflicts with another: `report_ruling` asks its principal whether
  to withdraw it. Only their "Withdraw it" lets `withdraw_decision` retire it.
- A ruling is not a close. A settle holds its finding until a verifier carries it out.
