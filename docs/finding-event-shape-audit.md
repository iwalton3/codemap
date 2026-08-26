# Event-shape audit: what the finding log actually records

**Measured 2026-08-25** over every findings scope in `codemap-sidecar` — 491 events,
155 findings, 8 pull requests across two universes. Prompted by PR 270 reading as "a
genuine mess"; the audit says that is true, that it is one workflow rather than one
tool, and that two of the three problems are missing verbs rather than misuse.

## What was measured

```
scope                        ev  find  asgn       outc       remd      state      revd  thread  corrob
acme.api/pr-227               66    23     0    1+0lost          -   19+0lost         -       0       0
acme.api/pr-264              106    22     0   17+0lost   12+0lost   21+0lost         -       0      11
acme.api/pr-269               26    10     0    2+0lost          -          -         -       4      10
acme.api/pr-270              181    25     0  22+37lost  22+12lost   15+0lost         -       9      22
acme.api/pr-271               30     7     1    5+0lost          -    1+0lost   2+0lost       2      12
acme.api/pr-272               37    37     0          -          -          -         -       0       0
acme.react/pr-275             20    19     0          -          -          -         -       0       0
acme.react/pr-297             25    12     0          -          -          -   1+0lost       0      12

TOTAL: 491 events over 155 findings; 1 ever assigned
  finding.outcome        readable   47   OVERWRITTEN   37
  finding.remediated     readable   34   OVERWRITTEN   12
  finding.stateChanged   readable   56   OVERWRITTEN    0
  finding.revised        readable    3   OVERWRITTEN    0
  outcome detail nobody can reach: 53,419 characters
```

`lost` counts events whose folded field a later event of the same kind overwrote.
`f.outcome` and `f.remediation` are single fields, last-write-wins; `thread` and
`corroboration` are append-only.

## 1. The overwriting is ONE pull request, and it is a multi-round loop

Every `lost` in that table is PR 270. Seven other scopes lose nothing. So the latch
shape is not wrong in general — it is wrong under the workflow only 270 has run: an
agent that re-verifies after each submitter push. One finding's timeline:

```
15:44:48 corroborated  opus-5   "Confirmed at head a183de64…"
15:45:00 outcome       agent    "Confirmed at head a183de64…"      ← the same claim, 12s later
17:43:48 outcome       agent    "Submitter reports fixed…"         ← the SUBMITTER's reply, as our outcome
18:39:15 commented     opus-5   "CORRECTION to my verification…"
19:34:42 outcome       agent    "Record correction (remediation was left at default…)"
23:03:28 stateChanged  human    resolved
```

Only the last outcome survives the fold, and it is the bookkeeping note — not the
verification. Across 270, 37 of 59 outcomes and 12 of 34 remediations are unreachable,
carrying 53k characters of investigation.

**This is not only the model's fault.** `close_finding`'s description says "Report back
on a finding from `review_queue`" — an assignment queue that **1 of 155 findings has
ever entered** — and then "Takes any finding id… there is no second tool for the shared
half" and "Set `disposition` whenever you reached a conclusion." An agent reaching a new
conclusion in round 7 is doing what the tool says. The verb has become "record what I
concluded" while its event is modelled as a one-shot report on an ask.

Either `finding.outcome` becomes append-only like `thread` and `corroboration` — rounds
are real, there were seven — or `close_finding` refuses a second outcome and routes the
caller to `comment`/`revise`. `remediation` at least documents latest-wins as deliberate
("it is an observation, and a later look supersedes an earlier one"); `outcome` does not,
it just assigns.

## 2. A corrected summary cannot replace the summary, so it becomes a note

This is the sharpest result in the audit, because the agents said it out loud.

```
thread comments total: 15
  that read as a CORRECTION or round update: 15   (all of them)
finding.revised events — the verb that actually replaces the summary: 3
```

Four thread comments open verbatim with:

> **"Submitter-facing replacement (supersedes the current wording): …"**

That is an agent describing, in prose, the thing `revise` exists to do — because it was
refused. `mayRevise` gates on `needsHumanAck`, which is true the moment anything
corroborates a finding with `confirm`. After that an agent may not touch `comment`, and
`reviseFinding` tells it: *"Say what you found with `comment`, and `request_human` if the
wording itself has to change."* So it says it with `comment`, and the stale summary stays
the one everybody reads.

**The rule protects the record and not the reader.** The submitter-facing `comment` is
the text that gets published and acted on. Leaving it wrong with a correction three
entries below it is worse than replacing it — and replacing it loses nothing, because
`revisions` is append-only and stores the `was` of every field it changes. The gate's own
justification is "losing a confirmed finding to one wrong call is not recoverable from
anywhere"; a comment revision is recoverable, by construction.

**Proposed:** let an agent revise `comment` (and only `comment`) past confirmation, with
the prior wording kept in `revisions` as it already is. `severity`, `state` and
`disposition` stay behind the ratchet — those are the judgements a person stood behind.
`request_human` stays for the case where the agent wants a person to look, rather than
being the only door.

## 3. "Fixed" is recorded, and no surface shows it or lets you confirm it

The axis exists and is used heavily:

```
PR 270   fixed-on-branch 21   outstanding 3   wont-fix 1      waitingOnYou 6
PR 264   fixed-on-branch 11   outstanding 10  deferred 1      waitingOnYou 0
PR 269   outstanding 10                                       waitingOnYou 8
PR 271   outstanding 7                                        waitingOnYou 5
PR 272   outstanding 37                                       waitingOnYou 37 untriaged
```

Thirty-two findings across two pull requests claim to be fixed. Two problems:

- **`remediation` is rendered nowhere in the web.** `grep -n remediation web/*.js` returns
  nothing. The only way to learn a finding is fixed is to read its prose — which is
  exactly the skim this was supposed to remove.
- **Nothing routes a fix claim to a person.** `queue:true` and `waitingOnYou` are keyed on
  `needsHumanAck` = promoted **or** confirmed. An agent marking `fixed-on-branch` does not
  put the finding in front of anybody; on 270, 21 claim fixed while `waitingOnYou` is 6.

**Proposed:** a fix claim is an ASK, and should behave like one.

- `needsHumanAck` also true when `remediation` is a fixed state that nobody has confirmed,
  so it enters the same queue every other "waiting on a person" item does.
- A `remediationConfirmed` marker set by a person — one click — so the queue drains and a
  confirmed fix is distinguishable from a claimed one. This is the same shape as
  corroboration: the claim and the confirmation are different acts by different actors.
- Render it: a badge on the finding row, and a filter, so "what claims to be fixed" is a
  view rather than a read-through.

The vocabulary needs nothing new — `fixed-on-branch` vs `fixed-on-default` is already
load-bearing, and the distinction (mainline still carries the defect) is exactly what a
person confirming needs to see.

## What this audit does NOT claim

- That the tools are being used wrongly in general. Six of eight scopes are clean; 272 is
  37 findings filed and nothing else, which is a first pass and correct.
- That assignments are broken. 1 of 155 is not evidence that `request`/`review_queue` fails
  — it is evidence that nobody drives findings that way, and `close_finding` documenting
  itself as that queue's report-back verb is a description problem before it is a design one.
- That the latch shape is wrong for `state`. 56 `stateChanged` events, zero overwritten:
  a state machine is exactly what a latch is for.

## Addendum — what was built from this (2026-08-25)

Izzie set six rules after reading the audit, and they cut the gate differently from
either proposal above. Recorded here because the audit is the evidence for them.

1. **The triage log is append-only, read on expand.** (`outcome` is still a latch — the
   one item NOT yet built; see below.)
2. **Agents may always revise the description.** `mayRevise` is unconditional.
   `severity` keeps a gate, on CONFIRMATION only — supplying a severity to a person's
   raw one-liner is the write-up an agent exists for; re-rating a number somebody has
   since stood behind is theirs.
3. **Promotion is optional triage, never a gate.** It left `mayTransition` entirely, and
   it now counts in `findingTier` — clicking promote used to leave a finding sitting in
   `unconfirmed`, the pile documented as "filed, and nobody has weighed in".
4. **State never blocks remediation.** Already true; `remediate` had no gate.
5. **Closing needs an ack when confirmed OR filed by a person** — `agentClosureNeedsAck`,
   which is deliberately not `needsHumanAck`. That predicate was doing two opposite jobs:
   populating the human queue and locking agents out.
6. **The ask is marked on the item.** An agent's close is no longer REFUSED — it is
   recorded as a pending ask carrying its reason, and rendered `fixed pending` /
   `refuted pending`. That is the whole fix for §2 above: the agent reached for
   `close_finding`, the tool said no, and what it reached for next was prose. There were
   zero `request_human` asks in the entire sidecar against fifteen thread comments doing
   the job by hand.

Also built, from the workflow-issues section of `docs/mcp-complaints.md`: `close_finding` returns `applied`/`refused` with
an honest `ok` (§2 there), `result:"fixed"` infers `fixed-on-branch` (§8), and
`remediation` is rendered on the shared view (§1) — it was on every record and no
surface, which is why five findings verified fixed still read as live defects.

**Still open from this audit:** `finding.outcome` remains last-write-wins, so PR 270's
37 overwritten reports are still unreachable. Rule 1 wants it append-only. Nothing else
in the sidecar loses an event, so this is one PR's damage plus a shape that will do it
again the next time somebody runs a multi-round verification.
