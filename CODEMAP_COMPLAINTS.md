
---

## 2026-08-25 (later still) — an agent cannot write up a human's own finding

Izzie filed a one-line finding during review (`f_00mt8wx6ec`, PR #271: "This locks
a credit application to submitted even if it is declined...") and asked me to
write it up properly so it could be handed to the PR submitter. That is the exact
task, and the tool refuses it:

```
close_finding(id: "f_00mt8wx6ec-e5fd29802f", comment: ..., severity: "high", line: 182)
→ "comment and line and severity NOT changed: f_00mt8wx6ec-e5fd29802f is `created`
   — past a proposal, only a person revises a finding."
```

The rule is defensible in isolation — an agent should not rewrite what a person
stood behind. But the effect here is backwards. A human's raw note is precisely
the thing that most needs an agent to attach file:line evidence, a severity and a
remedy, and `created` is the state every such note starts in. So the findings an
agent can fully write up are the ones an agent already wrote, and the ones it
cannot are the ones a human dashed off. `corroborate` and the `outcome` still land,
so the evidence is on the record — but the submitter-facing `comment`, which is
the whole message the submitter receives, stays a one-liner.

Net result: I had to do the write-up on a *different, agent-authored* finding
covering the same defect on the same anchor (`f_00mt83099s`), leaving two findings
for one issue and a manual withdraw for Izzie.

**Fix:** let an agent enrich a `created` finding's `severity`/`line`/`category`
(pure additions — the note carries none of them), and let it *propose* a comment
rewrite that the author accepts, rather than refusing outright. Refusing to touch
the human's own words is right; refusing to attach a severity to them is not.

### Follow-on: `request_human` has no word for "withdraw"

Izzie then asked me to withdraw the duplicate, and I could not do it directly —
correctly, as it turns out. **Routing it to a person is the intended design**, and
Izzie confirmed the reason: it prevents accidental loss of confirmed findings. An
agent should not be able to retire one unilaterally. That part is working as
designed and is not a complaint; I filed it as one and was wrong.

The real gap is narrower and purely lexical. `request_human` offers exactly four
actions — promote, invalidate, refute, resolve — and none of them means "retire
this record, the claim stands." So a TRUE-but-duplicate finding has to be queued
as `invalidate`, which reads as "this was not a real finding". The alternatives are
worse: `refute` would put a false verdict on the record and, by the disposition
rules at `src/mcp.ts:101`, generate a submitter-facing comment that *leads with the
withdrawal*; `resolve` would claim a defect was fixed that was not. `withdrawn` is
already a first-class terminal `FindingState` (`src/shared-findings.ts:41`, `:44`,
folded to tier `doubted` at `:230`), so the concept exists everywhere except in the
one vocabulary an agent has to speak.

I used `invalidate` with a rationale opening "the claim is TRUE and confirmed",
because the alternative was to mislabel a real defect to tidy the queue. The human
gate then worked exactly as intended — Izzie read it and approved.

**Fix:** add `withdraw` to `request_human`'s action enum. Keep the human
acknowledgement exactly as it is. Deduplication is a routine outcome of two
reviewers landing on one anchor, and it should not require borrowing a word that
means something false to get there.

---

## 2026-08-25 (evening) — refreshing a PR after the submitter fixes things

Task: PR #264's submitter answered all 12 posted findings and pushed one commit
fixing 11 of them. Izzie asked me to refresh codemap and report the PR's state.
The *reading* half went well. The *writing back* half fought me at every step, and
the root cause is one missing concept, described last.

### 1. `inbound_replies` contradicts `findings` about whether anything was posted

First call of the session, and it is simply wrong:

```
inbound_replies(pr: "264")
→ { "findings": [], "note": "nothing from here has been published to the pull request" }
```

Meanwhile `findings(pr: "264")` returns 12 rows each carrying:

```
"publishState": "posted",
"postedRef": { "pr": 264, "at": "2026-08-24T19:52:16.142Z", "placement": "inline",
               "url": ".../pull/264#pullrequestreview-5011943580" }
```

So the store knows exactly when and where these were posted, and the tool whose
entire job is "what did the submitter say back" reports that nothing was posted.
I only found the 12 replies because I distrusted the note and ran `gh api
.../pulls/264/comments` by hand.

The note is also the most damaging possible failure mode: it does not say "no
replies yet", it asserts a *premise* ("nothing was published") that an agent will
reasonably act on by not looking further. On this PR that would have meant
reporting "no submitter response" when in fact every finding had been answered.

**Fix:** derive the "was anything published" check from the same `postedRef` field
`findings` reads. If replies genuinely cannot be fetched (no token, no sidecar),
say *that* — "could not read replies" is recoverable, "nothing was published" is not.

### 2. Two finding-id namespaces, and the error message names neither

`defer_finding` could not see a finding that `findings` had just returned:

```
defer_finding(pr: 264, finding: "finding_26f9651bab55")  → "no finding finding_26f9651bab55 on pr 264"
defer_finding(pr: 264, finding: "26f9651bab55")          → "no finding 26f9651bab55 on pr 264"
```

Both false: `findings(pr:"264")` lists `finding_26f9651bab55` with `"pr": "264"`.
The actual explanation only surfaced from `list_bugs` — the one already-deferred
bug on this map records `from: { pr: "270", finding: "f_00mt82rwn0-83b56ba936" }`.
A different id shape entirely. So there are (at least) two namespaces, `finding_*`
and `f_*`, and `defer_finding` speaks only the second while `findings` hands out
the first.

"no finding X on pr N" is the wrong diagnosis for "that id is from the other
store". It sent me hunting for a data problem that did not exist.

**Fix:** either accept both namespaces, or fail with "that is a local finding id;
defer_finding operates on shared findings" and name the id it *did* want. An error
that misdescribes the cause costs more than one that admits confusion.

### 3. `defer_finding` rejects the universe id the other tools report

```
shared_findings(pr:"264") → { "universe": "acme/acme.api", ... }
defer_finding(..., universe: "acme/acme.api")
  → Error: unknown universe "acme/acme.api"
```

One tool prints an identifier; another refuses it as unknown. Whichever is right,
they should agree.

### 4. `revise_finding` silently drops `disposition`

This one cost the most, because it fails *successfully*:

```
revise_finding(id: "finding_bfdf0796248e", disposition: "confirmed",
               allowPostEdit: true, text: "FIXED UPSTREAM in 6965b31f...")
→ { "ok": true, "changed": ["text"] }
```

`disposition` is absent from `changed`, with no warning. Passing it alone returns
`{ "ok": true, "changed": [], "note": "nothing changed" }` — which reads as "it was
already that value". It was not: all 12 findings still report `"disposition":
"open"` after the call.

So I believed I had triaged 12 findings, and had not. I only caught it because I
re-listed at the end for the write-up.

Note the contrast with `close_finding`, which refuses *loudly* and explains itself
("comment and line and severity NOT changed: ... only a person revises a finding").
That is the right behaviour. `revise_finding` should not have a quieter failure
mode than its sibling for the same class of rule.

**Fix:** report dropped fields the way `close_finding` does — an explicit "NOT
changed, and why" line. And distinguish "already this value" from "you may not set
this" in the `note`; today both render as "nothing changed".

### 5. `close_finding` refuses findings its own docs say it takes

```
close_finding(id: "finding_bfdf0796248e", result: "answered", disposition: "confirmed", detail: ...)
→ "that finding was not assigned to an agent"
```

All 12 refused this way. But the tool description says: *"Takes any finding id —
your own, another agent's, or the TEAM's from `shared_findings`; there is no second
tool for the shared half."* These are my own findings, filed from this machine, on
this PR. There is no assignment step anywhere in the flow that produced them
(`report_defect` → publish → submitter fixes → report back), so the precondition
is one an agent cannot satisfy by any route it controls.

The description also frames `close_finding` as *"this records what you did"* —
reporting back, not resolving. Reporting back on a finding nobody assigned is the
normal case, not an anomaly.

**Fix:** allow `close_finding` on a finding you authored regardless of assignment,
or drop the reporting half into `revise_finding` so there is one working path.
Right now neither tool records a triage outcome, so the outcome lives only in
free-text `text` where nothing can filter on it.

### 6. The real gap: there is no word for "was real, and has been fixed"

Everything above is friction. This is the actual design hole.

`disposition` is one axis — *what is true of the claim*: open, confirmed, partial,
rerated, refuted, accepted. There is no axis for *what happened about it*. So when
a submitter fixes 11 findings, the map cannot say so.

The workaround I inherited is worse than nothing. My own notes from PR #227 record
"four fixed upstream (revised to `refuted`)" — marking a real, correctly-filed,
now-fixed defect as a **false positive**, because `refuted` was the closest word.
That poisons exactly the data a reviewer most wants later: "which of my findings
were wrong?" now silently includes the ones that were most right. I declined to
repeat it this round, which left me with no option but prose:

```
text: "FIXED UPSTREAM in 6965b31f. Verified in the diff. ..."
```

Twelve findings, each carrying its outcome in a paragraph that no query can reach.
`findings(disposition: "confirmed")` cannot distinguish "confirmed and outstanding"
from "confirmed and fixed last night".

**And there is a second axis underneath it.** The fixes live on
`feat/release-confirmation`, which is unmerged. Six of these findings already
exist as shared bugs, and I deliberately did *not* close them — `develop` still
carries every one of those defects. That distinction ("fixed on a branch" vs "fixed
on the mainline") is load-bearing for anyone reading the bug list, and it is
currently expressible only as a sentence I hope someone reads.

**Fix:** add a `remediation` field orthogonal to `disposition` — something like
`outstanding | fixed-on-branch | fixed-on-default | deferred | wont-fix` — set by
whoever verifies, and filterable. The rules that make this cheap already exist:
codemap knows the finding's `pr`, knows the head it was witnessed at, and (per §7)
already detects that the anchored code changed. It has everything except somewhere
to put the answer.

Concretely, the report Izzie asked for — *"what is the general state of this PR"* —
should have been one query. It took reading 12 findings' prose, 39 bugs, the git
diff, and the GitHub comment thread.

### 7. Credit where due: `possiblyFixed` worked, and it did not last time

Six of these findings had been folded into shared bugs, and every one came back
`"possiblyFixed": true, "codeChanged": true` with the moved anchors named. That is
exactly right, and it is the thing that told me which bugs to re-validate. My notes
from PR #227 record staleness detection *not* firing when it should have; whatever
changed between then and now, it is working.

The guidance attached to it is right too — *"re-validate those rather than closing
them, because a symbol that vanished may have been renamed or deleted without the
defect being addressed."* That is the correct instinct and I followed it.

### 8. Minor: bulk-folded bugs carry an epoch `filedAt`

Every bug created in the 2026-08-25T02:18:50 fold reports:

```
"createdAt": "2026-08-25T02:18:50.649Z",
"filedAt":   "1970-01-01T00:00:00.000Z"
```

39 of them. Harmless today, but anything that ever sorts or ages by `filedAt` will
put the entire backlog at the dawn of time.

### Follow-up, same evening — §4, §5 and §6 are fixed; §1, §2, §3 are not

Izzie shipped changes and reconnected the server mid-session. Re-ran everything
against the same PR. Scoreboard, so the next reader knows which half of this entry
is history and which is still live:

**Fixed — and §6 is fixed properly.** `close_finding` now accepts a finding I
authored with no assignment (§5), and it takes a **`remediation`** field on exactly
the axis §6 asked for: `outstanding | fixed-on-branch | fixed-on-default | deferred
| wont-fix`, orthogonal to `disposition`. All 12 #264 findings now carry a real
verdict *and* a real outcome:

```
"disposition": "confirmed", "tier": "confirmed", "remediation": "fixed-on-branch"   × 11
"disposition": "open",      "tier": "unconfirmed", "remediation": "deferred"        × 1
```

That is the report Izzie originally asked for, now answerable as one query instead
of by reading twelve paragraphs of prose. `fixed-on-branch` in particular does the
job I had to write a sentence for — the six linked bugs stay open because `develop`
still carries the defects, and the map now says so structurally.

§4 is fixed too, and fixed the *right* way: the silent drop became a loud note.

```
close_finding(id: "finding_26f9651bab55", disposition: "accepted", ...)
→ { "ok": true, "note": "disposition \"accepted\" is not recorded on a finding — verdicts are" }
```

That is the whole complaint answered — I now learn the field was rejected, and why.

**Still live: §1, §2, §3.** All three reproduce unchanged after the reconnect, so
they are not connection artifacts:

```
inbound_replies(pr: "264")
→ { "findings": [], "note": "nothing from here has been published to the pull request" }
```

— still asserted while all 12 findings carry `"publishState": "posted"` and a
`postedRef` URL, in the same store, on the same PR.

```
defer_finding(pr: 264, finding: "finding_26f9651bab55") → "no finding ... on pr 264"
defer_finding(..., universe: "acme/acme.api")   → Error: unknown universe "acme/acme.api"
```

— and `inbound_replies` prints `"universe": "acme/acme.api"` in the very
response above, which `defer_finding` then rejects as unknown.

Practical consequence, unchanged: the one genuinely-outstanding #264 finding (the
credit-line stream replay under an exclusive lock) still cannot be deferred into a
bug, so it will vanish from view when the PR closes. It survives only because Mike
independently filed Jira ACME-742. The `remediation: "deferred"` flag now at least
records *that* it was deferred — but there is no codemap bug behind it, and
`track_bug` needs a bug id to attach the Jira key to, so the link lives in prose.

### Second follow-up — §2 and §3 were my misdiagnosis. Withdrawing them.

Izzie pointed out the `finding_*` → `f_*` migration had landed, which made me look
properly. `shared_findings` says it outright, and I had not read it:

```
"splitStore": { "local": 22,
  "note": "these are on this map only — the team cannot see them.
           `codemap unify-findings` publishes them, ids and history preserved." }
```

PR #264's findings were never **published** — every one carried `"shared": false`,
`"published": false`. `defer_finding` resolves against the shared store, so it
correctly could not see them. There was no id-parsing bug and no second namespace
in the sense I described: `f_*` ids are simply what a finding gets once published,
and #264's had not been. **§2 is withdrawn.** The error message is still terse for
the situation ("no finding X on pr N" when the real state is "that finding is
local"), and `splitStore` already computes the better answer — but that is a
wording improvement, not the defect I claimed.

**§3 is withdrawn on the same grounds**; "unknown universe" was downstream of the
same lookup, not an independent inconsistency.

`codemap unify-findings` (45 local findings, `refused: []`) plus `codemap sync`
fixed it. Deferral then produced a *completely different* error — and the right one:

```
"finding_26f9651bab55 points at anchor a_f742e340ce, which resolves to no anchor in
 this checkout (unresolved anchor ref \"a_f742e340ce7cf75a\") — file the bug against
 code you can see, or index the branch it is on first"
```

That refusal is **correct, and it caught a real error of mine.** The anchor is
`OutstandingReservationAsync`, which `git show develop:...ReleaseCancelledHandler.cs`
shows appears **zero times** on develop — PR #264 introduces the whole ledger-summing
method. So there is no mainline code to file a bug against, and a bug filed against
develop would have pointed at nothing. codemap refused to let me create exactly that.

It also exposed a wrong claim I had already written into six bug notes. I had said
"the branch is unmerged, so develop still carries the defect" on all six. Checked
each against develop:

- **Genuine mainline debt (3):** `bug_4ca62a2fcc75` (develop `:391` unlocked check,
  `:941` lock, `:942` append, no re-check), `bug_143a3963d07d` (develop `:451` locks
  then `:464` gates on the stale match), `bug_846f1288a85b` (develop `:109`
  unnormalized `InvoiceId`).
- **Branch-only, defect never on develop (3):** `bug_cbffd5b6c834` and
  `bug_6c0f4ca2cc6b` — those files do not exist on develop at all; `bug_33aaee1ef6a8`
  — `AcceptedDateTime` appears zero times in develop's copy. Each was created and
  fixed inside the same unmerged branch.

All six notes corrected on the map.

**The one thing worth keeping from this thread**, now that the noise is stripped
out: a PR finding about code the PR *introduces* has no bug it can defer to, by
construction, and that is the normal case for feature branches — most #264 findings
were about new code. `defer_finding`'s advice ("index the branch it is on first")
points at a per-branch index this workflow does not maintain. Either the deferral
should be allowed to land against the branch anchor and resolve on merge, or the
refusal should say *"this code does not exist on the default branch — there is
nothing to carry forward"*, which is the actual situation and is often the correct
final answer rather than an obstacle.

---

## 2026-08-25 (later) — a walkthrough re-walk is all-or-nothing, and that is expensive

Re-walked PR #264 after the submitter's fix commit. Eight of twenty-six chapters
needed revision. I had to send all twenty-six.

`pr_walkthrough` takes the whole document inline as `features`, and its rejection
rules are global — every changed symbol must be covered, no chapter may be empty,
no symbol may appear twice — so there is no way to submit a partial update. To
change eight chapters I had to reconstruct the other eighteen byte-for-byte and
resend them.

The measurements, because the cost is not obvious:

- stored document, as `pr_walkthrough_get` returns it: **62 KB**
- after stripping `id` and `witnesses` (see below): **34.5 KB**
- that document has to be READ into the agent's context and then WRITTEN back out
  in the tool call: **~30k tokens of context for an eight-chapter edit**

That is the whole of a re-walk's cost, and almost none of it is the edit. It also
scales the wrong way: the larger and better-documented the PR, the more expensive
the smallest correction to it becomes. #264 is a 91-file PR with 227 symbols, which
is exactly the size where a walkthrough earns its keep — and exactly the size where
re-walking one chapter costs the most.

There is a correctness cost too, not just a token one. Resending eighteen unchanged
chapters means re-transcribing ~25 KB of prose I am not editing, through a channel
where a single dropped character invalidates the document. The safe-looking act
(re-walk after a push) carries more risk than the risky-looking one (write a new
chapter), and the risk is entirely in the part I did not intend to touch.

**Fix, in rough order of how much it would help:**

1. **A per-chapter write.** `pr_walkthrough_chapter(pr, chapterTitle, blocks)`, with
   the coverage check run across stored chapters plus the incoming one. Chapter ids
   are already derived from titles and chapters are already witnessed individually
   — `stale` names them one by one — so the data model supports this already; only
   the write verb does not. This is the one that matters.
2. **Failing that, accept the document from a file path.** The MCP call would carry
   a path, not 34 KB. This is a smaller change and would remove the transcription
   risk entirely, though not the read cost.
3. **Stop returning what you refuse to accept.** `pr_walkthrough_get` returns each
   feature/chapter with `id` and each chapter with a `witnesses` array; the write
   schema is `additionalProperties: false` and rejects both. So the natural
   round-trip — get, edit, put — fails, and every caller has to know to strip them.
   Either accept and ignore them, or return a `features` shaped like the input.
   Stripping them also halved the payload, which says the response is carrying a lot
   the writer never needs.

Worth saying that the underlying design is right: chapters ARE the unit, `stale`
names exactly the ones whose code moved, and ids-from-titles genuinely did preserve
the reviewer's place across the re-walk. The model is per-chapter. Only the write
path is per-document.

### Smaller thing in the same call

The write returned `"outsideQueue": 2` alongside `covered: 227, total: 227,
uncovered: []`, and succeeded. Two symbols I cited are apparently not in the ranked
queue — but the response does not say WHICH, so there is nothing to act on. If it is
benign, it does not need to be in the result; if it is not, it needs the two ids.

### Third follow-up — the deferral worked, and the real fix was one reindex

Izzie asked the right question: *does that anchor exist on the branch you're running
tests on, and would an index let you file it now?* Yes to both.

The test run had the PR branch checked out, so the code was in the working tree:

```
$ grep -n OutstandingReservationAsync .../ReleaseCancelledHandler.cs
77:    public static async Task<Money?> OutstandingReservationAsync(...)
$ codemap reindex /working/Acme.API
indexed 5106 anchors across 979 files
baseline commit: 6965b31f...
68 previously-missing anchor(s) are back in the tree
```

`defer_finding` then succeeded first try → `bug_a4ad586a8afa`, cross-linked, ACME-742
attached via `track_bug`. **1.6 seconds.**

So the practical fix for a PR finding on branch-introduced code is: check the branch
out, reindex, defer. Worth knowing the anchor store is **per-worktree**
(`/working/Acme.API/.codemap`), so re-baselining it at a feature branch costs nothing
shared — only the sidecar is shared, and that carries findings and bugs, not anchors.
I had assumed a reindex was a heavyweight, map-wide act; it is neither.

That downgrades what I wrote in the previous follow-up. The gap is not that
`defer_finding` should resolve through snapshots — it is that **the error does not
say what it wants**. "index the branch it is on first" is correct advice and I could
not act on it, because nothing said which branch, that `codemap reindex` was the
verb, or that the store being re-baselined is local to this checkout. All three are
knowable at the point of failure: the finding records the ref it was witnessed at
(`6965b31f`), so the message could read *"witnessed at 6965b31f, which is not this
checkout's baseline — check that ref out and `codemap reindex <repo>` (per-worktree,
~2s), or file against code in the current tree."*

The `sha256:absent` witness path at `bugs.ts:46` still looks unreachable from
`acceptFinding`, since `resolveRefs` bails at `:42` before it. That may be
deliberate — refusing to anchor a bug to a symbol nobody can currently see is
defensible. Not filing it as a defect; noting it in case the intent was otherwise.

### Fourth follow-up — located it. `witnessRefs` drops two optional args.

Izzie: *"the PR view should really just deal with the indexing."* It already does.
`codemap pr <N>` calls `indexCommit` and writes a snapshot (`src/pr.ts:448`), which is
why `get_anchor a_f742e340ce7cf75a` returned `present: true, offTree: true,
sourceRef: 6965b31f` while `defer_finding` on the same id said no such anchor.

And `resolveRefs` already knows how to use that snapshot. Both mechanisms are
present, with comments describing this exact scenario (`src/ops/shared.ts:166-202`):

```js
if (scopeRef) {
  // A symbol that exists only on a PR's head is not a floating claim — it is in
  // this store, under that commit's ref. Union those anchors in so a finding can
  // be raised on code that has not merged yet.
  const snap = await readSnapshot(root, scopeRef);
```

and under `includeOrphans`:

```
// a commit SNAPSHOT holds code that exists on a branch, which during a PR review
// is most of what is worth annotating — the files the branch ADDS are not in the
// working tree at all, so requiring the caller to name the ref made the common
// case the one that failed.
```

That comment is a description of the bug I hit, written before I hit it.

**The defect is one call site.** `witnessRefs` (`src/ops/bugs.ts:41`):

```js
const r = await resolveRefs(root, refs);   // no scopeRef, no includeOrphans
```

`acceptFinding` has everything needed to pass them: it takes `pr`, and the finding
record it loads at `:521` carries the ref it was witnessed at — `f.target.at`, which
the `findings` API surfaces as `targetAt: "6965b31f…"`. So:

```js
const { witnesses, errors } = await witnessRefs(root, refs, f.target.at);
```

with `witnessRefs` forwarding it as `scopeRef` (and/or `includeOrphans: true`) would
have made the whole thread a non-event — no checkout, no reindex, no error to
interpret. `reportBug`'s call at `:59` likely wants `includeOrphans` for the same
reason, since filing a drive-by against branch code has the identical shape.

This supersedes my previous two attempts at diagnosing it. It is not about snapshots
being unreadable (they are readable), not about id namespaces (that was the separate
split-store issue), and not primarily about the error wording (though the message
still names no ref and no command). The plumbing is all there and one function does
not use it.

It also retracts the "may be deliberate" hedge I put on the `sha256:absent` path at
`bugs.ts:46`. That path is unreachable from `acceptFinding` for the same reason —
`resolveRefs` returns nothing, so `:42` bails before any witness is taken.
