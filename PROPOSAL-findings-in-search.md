# Proposal: findings in global search

**Status:** untracked proposal, not started. For another agent after
`dashboard-attention` merges.

## The ask

`search` (`src/ops/read.ts:114`) covers **anchors** and **logical nodes**.
Findings are the one canonical record kind it does not reach — so the only way to
find a finding is to already know its pull request, or to page a list. A defect
somebody reported eight months ago is effectively unfindable by what it says.

This matters more now than it did. Findings used to be scoped to a live pull
request and were read in that context; with the backlog, a finding can be **live
on the trunk for months** and is exactly the kind of thing somebody rediscovers
from scratch. Search is how you find out it was already known.

## Shape

Add a third hit kind alongside `anchors` and `nodes`. The fields worth matching,
and the reason each:

- **`comment`** — the DESCRIPTION. This is the one people will search for, and it
  is the field whose name suggests otherwise (see below).
- **`text`** — the running triage narrative. Worth matching because it holds the
  verification detail ("verified at head b24dc21e"), which is how somebody finds
  the round that already answered their question.
- **`id`**, and **`target.id`** so an anchor id finds the findings filed on it.
- Probably **`thread[].body`**, since discussion is where the real reasoning
  often ends up. Judge this on cost — it is the only unbounded one.

**Read the note on `findingBacklog`'s `row()` before touching either text field.**
`comment` is the description and `text` is the triage narrative — inverted from
what the names suggest. A search that ranked `text` first would surface "RE-TRIAGE
2026-08-21 — FIXED UPSTREAM…" as the answer to a query about the defect. The
backlog page shipped that mistake and it had to be swapped.

## Things to get right

1. **State must be visible in the hit.** A refuted finding and a live one are
   different answers to the same query. Carry `state`, `severity`, and — once the
   sibling proposal lands — whether it is backlogged and until when.
2. **Closed findings still match.** "Was this ever reported?" is the question
   search is for, and a closed finding is often the best possible answer:
   somebody already looked, and their reasoning is in the record.
3. **Don't rank findings above code.** Search is primarily how an agent locates a
   symbol. Findings are context, so they belong beside the results and not in
   front of them.
4. **`search` is on the MCP surface and the web.** Both must get it, per
   `ops-reach.test.ts`'s standard — a hit type only one front end can see is half
   a feature.
5. **The store holds team findings too.** `readFindings` returns one canonical
   table, this machine's rows beside the team's, so this is free — but the hit
   should say which, the way `published` does elsewhere.

## Related

`PROPOSAL-bug-backlog.md` — its hard constraint is that a backlogged bug is
**never silenced from global search**, which assumes this work or something like
it. Worth doing this one first.
