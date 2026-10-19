# Batch release: one reader pair for every held sort that cites the same decision

## Problem

Releasing a held sort takes two reader subagents: `release_reader_brief` for slot 1 and slot 2, each
launched fresh, then `release_held_sort` with both receipts. Both tools take **one** `sort`. So when one
ruling unblocks many sorts, the reader cost scales with the number of sorts, not the number of rulings.

## The case that hit it (Acme, 2026-10-19)

Triage run `2026-10-19-ops-app-hosted-review-2`, review `branch:ops-app-hosted`, universes `settlement`
and `api`. The owner approved one decision log in a single answer ("No problems"), which settles eight
held sorts:

| Cluster | Sort |
|---|---|
| C1 | rs_eebae2243823453102a1 |
| C2 | rs_ddbdf017b2e330ce11b0 |
| C3 | rs_76994cb7cfa78efbac1e |
| C4 | rs_6b64fd4f2099f7923cd7 |
| C6 | rs_0ec18edbcc63efd2cfd8 |
| C8 | rs_1a855593dc6d75bc05c2 |
| C9 | rs_4bf90830233d6dddf3ae |
| C11 | rs_bd83462f2edd058079ab (api) |

That is 16 reader subagents to confirm one sentence, before evidence, repair requests and the two blind
verifiers each repair needs. The session deferred the release rather than spend that.

## Proposal

`release_reader_brief` and `release_held_sort` accept `sorts: string[]`, all citing the same
`decision:<id>`, possibly across universes in one review. A single reader pair reads the ruling once and
returns a per-sort verdict: yes, no, or split. `release_held_sort` releases the sorts both readers said
yes to and leaves the rest held, each with its own reason, so one bad sort cannot ride in on a batch.

What stays the same: two independent readers, a fresh subagent with exactly the brief, receipts checked
against the transcript, and no release on a single reader's word.

## Not part of this request

In this run the decision log was never posted as a round. The planning session dropped it after
`post_round` refused options with no finding effect ("a decision needs options, each with a label and
effects"). It could have been posted with each option's effect being "unblocks" on the eight findings, so
the missing `decision:<id>` came from how the session recorded the answer, not from codemap. It would
still help if the refusal message said an unblock counts as an effect. That is a wording fix, separate
from this request.
