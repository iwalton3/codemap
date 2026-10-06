---
name: codemap
description: >-
  How to work with codemap's shared records when its MCP tools are attached: findings, bugs, review
  queues, repair verification, rulings and questions to a person. Use when the work touches any of
  them — "check these findings were actually fixed", "what's open on this PR", "file that as a
  bug", "ask me in codemap", "is this finding still live" — and before closing, deferring or
  disposing of anything codemap tracks. It says which procedure fits, which acts are a person's
  and never an agent's, and where the longer procedures are.
---

# Working with codemap

codemap anchors claims (docs, findings, bugs, reviews, rulings) to hashed code, so a claim goes
visibly stale when its code changes. Its shared records live in a git sidecar: **the log is
authoritative and pull/push only** — an ordinary read does not see the team's latest, so `pull`
before deciding anything on the team's state, and `sync` to land a transaction.

**Is it attached?** The tools must be callable in this session. A tool definition in the source, a
working CLI or a `.codemap/` directory is not the same thing. If a tool answers "codemap not
initialized", `init` that universe. If every call answers a lockout diagnostic, stop and show it to
the person: the sidecar is damaged and a repair is theirs (`docs/log-repair.md`). `pull` still runs
while locked, and clears the lock once the repair has been pushed.

## What an agent never does

Each of these is a person's act. The tools refuse most of them; where one does not, the rule
still holds. Ask instead (`references/asking.md`).

- **Close a finding directly** — not as refuted, not as invalid, not even your own. A fix closes
  through repair verification (`references/verify-repair.md`); every other close is a person's
  ask, which `close_finding` with a closing state records for you.
- **Verify a repair you requested, or apply a verdict you gave.** Only grants verify: a fresh
  session a person starts with `/codemap-verify`, or a subagent launched with exactly the prompt
  `repair_brief` returns.
- **Backlog (carry) a finding, or defer a bug.** There is deliberately no tool. Investigate, then
  ask, saying what the release condition should be.
- **Move a bug somebody stood behind**, or settle a teammate's question — answer it with
  `answer_shared_note` and let them close it.
- **Sign anything**: a walkthrough, a review as `verified` (web only), an operation on someone's
  behalf, a ratification. Your own `review` mark records `checked`, and it is yours to make.
- **Lower a triage stake** or `sanity_check` a doc your own connection wrote.
- **Act on a ruling** that is `held`, undecided or `possiblySuperseded`. A held finding is not
  free work.
- **Mass-convert** a pull request's leftover findings into bugs to clear it. Defer one at a time,
  on the merits.

## What do you need?

| The ask | Do this |
| --- | --- |
| "Were these findings actually fixed?" | `references/verify-repair.md` |
| "What is open / what was I asked to do?" | `review_queue` (assigned to you), `findings` with `tier: "unconfirmed"` (nobody has looked), `finding_backlog` (open on merged work), `list_bugs` with `queue: true`, `decision_rounds` (waiting on the person) |
| "Was this ever reported?" | `search` — closed findings match on purpose; a refuted one carries the reasoning |
| File, investigate, correct or dispose of a finding or bug | `references/findings.md` |
| Put a decision to the person, or record their answer | `references/asking.md` |
| Sort a pile of review findings | `/triage-review` (posts its sort here in shared mode) |
| Plan the work that a review or a discussion left | `/ez-plan` |
| Review a branch or pull request | `/codemap-review` where it is installed; otherwise `pr_packet` for the changed symbols at the head (never `get_anchor` without `at`, which reads the working tree), `shared_findings` and `inbound_replies` before filing, `report_defect` with a pull-request or branch context to file, `pr_walkthrough` for the reading guide |
| Understand how some code works | the `codemap-explore` agent, or `context` / `search` before reading code |
| Docs went stale after a change | `check_stale`, then per doc `confirm`, `update_node` or `ack_hole` (the server's instructions, *Review docs after a change*) |
| Requirements, audits, scrubs | `/codemap-audit` |
| More than one write | `begin`, the writes, then `sync` — all or none; a refused write comes back with why: `drop_staged` it and every later write that depended on it, redo them, `sync` again. Not across a `repair_request`: sync that as soon as it is made, or no verifier outside this session can see it |

## Reading the answers

- **Refusals are the rules talking.** A tool that refuses says why; that reason is usually one of
  the acts above. Do not look for a second tool that gets the same effect.
- **`ok: false`, `refused` and `held` are results**, not noise to retry past. Report them. The one
  thing to call again is a `pending` from a record call (`record_repair_verification`,
  `record_reading`, …): its call is not on disk yet. An error after that is final.
- **Unknown is an honest verdict.** A verification that comes back `unknown` closes nothing. A new
  request on the same fix shows the earlier runs that did not come back fixed, so asking again
  cannot bury them.

The normative documents are in the codemap repository, not shipped with this skill:
`docs/repair-verification.md`, `docs/finding-backlog.md`, `docs/sidecar-architecture.md`. When a
procedure here and a tool's own description disagree, the tool is current; say so to the person.
