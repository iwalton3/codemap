# Harness provenance

What codemap reads from an agent harness's own records, and what that reading is measured to
support. Only Claude Code's transcripts are read. A Codex adapter stack (native question answers,
reader and verifier admission) was built and removed on 2026-09-28 at the owner's direction —
native Codex questions are "fundamentally broken" for this workflow — and is in git history before
that date (`docs/harness-provenance.md` at `ff3bef3`).

## Claude Code subagent transcripts (measured 2026-09-26)

`readReader` (`src/transcript.ts`) proves that a subagent was launched fresh with an exact prompt and
made a given call: its own `<session>/subagents/agent-<id>.jsonl`, every row a sidechain carrying its
id, a meta file naming the parent's `Agent` call (not a fork), and the parent's transcript holding
that call and a launch result naming the id. Two live Claude Code 2.1.283 runs, one diagnostic MCP
server, one fresh reader each: each child recorded its own sidechain rows, a non-fork meta record,
one submit call and its paired result; `readReader` accepted both, and the second checked the
exact parent brief. The runs had distinct session and child identities.

That supports what codemap uses it for — reader, comparison, application, sign-off, withdrawal and
repair-verifier subagents whose held submissions are recorded from their own transcripts — and no
more. It is file-level evidence on this machine, not an attestation: it guards against an agent's
mistakes, not a forger.

A subagent shares its parent's MCP connection, so the connection alone cannot tell them apart; the
transcript can, which is why repair verification records a subagent by its id on its parent's
connection (`docs/repair-verification.md`).

## Questions to the person

Questions are asked with `AskUserQuestion` and recorded from the transcript by `log_question`, or
published as a questionnaire for the person to answer on the codemap web page (the owner's
preferred route when the page is open). Only an explicit browser submission or a logged answer
records an answer; showing or dismissing a popup, saving a draft or ordinary chat consent does not.
