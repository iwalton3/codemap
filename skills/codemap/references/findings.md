# Findings and bugs

A **finding** is a claim about one change: a pull request, a branch or a review topic. A **bug**
is a standing defect record that outlives any branch. Each tool's description carries its full
rules; this is the lifecycle they fit into.

## Before filing

- `search` for it, closed records included. A refuted finding usually holds the reasoning.
- On a pull request, `shared_findings` (the team's view) and `inbound_replies` (what the submitter
  said back). They may already have explained why it is not a defect.

## Filing

`report_defect`, one verb. Its `context` decides what the record becomes:

- a pull request or a branch → a finding on that change, at or before merge. A symbol that exists
  only in uncommitted edits is refused: commit first.
- a review topic → a finding on the topic, kept across re-walks.
- `drive_by`, with a rationale → a bug, which outlives the branch.

A defect is never an `annotate` (pointer, question or note). A pointer that turns out to be a
defect moves with `promote_annotation`, which keeps its id and history.

## Working one

- **Assigned to you** (`review_queue`): investigate or fix, then report with `close_finding`. A fix
  spans one file; declining a wider one, with what it would take, is the right answer.
- **Somebody else's**: `corroborate` with a rationale. Disagreement is the signal, so refute
  plainly.
- **Wrong wording, target or severity**: `revise_finding`. It appends; the old text stays. A
  confirmed finding's severity is not yours to re-rate. A finding already posted to the pull
  request is refused unless you pass `allowPostEdit`, which changes the map and not the posted
  comment; usually, reply on the pull request instead.
- **Its symbol is missing**: check `target.where` first. `offTree` is fine. For `retained` or
  `lost`, propose `relocate_finding`.
- **No witness**: `rewitness_finding`, after reading the finding against the current code. It is
  the one repair an agent makes on its own.
- **`held`**: a person's decision holds it. Do not work on it — unless a person assigned it to
  you themselves after the hold began (`review_queue` keeps those, still marked `held`), which
  releases an ordinary hold. A hold waiting on a comparison of the person's words is never
  released that way.

## The exits

A finding leaves through one of these. Pick the one that is true.

| It is | Exit | Who |
| --- | --- | --- |
| fixed | repair verification (`verify-repair.md`) | agent, with blind verifiers |
| not a defect | a person's ruling: `close_finding` with a closing state records the ask, or `post_round` with a settle effect | a person decides |
| real, and somebody intends to fix it | `defer_finding` — the only route from a finding to a bug | agent, one at a time |
| one site of a pattern that will not be fixed now | `file_site_bug` | agent |
| real, not now, must come back | the backlog: carried with a deadline, on the web | a person only |
| a duplicate | `request_human` with `withdraw` | a person decides |

`finding_backlog` sorts every open finding by what the code says now: `live` (still exactly true
on the default branch), `moved`, `unjudgeable`, `due`, `woken` and the rest. An agent's part is to
investigate the live and unjudgeable buckets and report through the verbs above.

## Bugs

- `list_bugs` with `queue: true` lists what needs a person; `asked: true` lists what somebody asked
  a person to close. `possiblyFixed` means the code moved: re-validate it, because a vanished
  symbol may be a rename.
- `bug` before acting: it resolves each anchor against the code in front of you.
- `update_bug` for state, comments, anchors and witnesses. A bug somebody stood behind is moved by
  a person (`request_human`).
- `track_bug` records an external ticket. Being tracked is not being fixed.
