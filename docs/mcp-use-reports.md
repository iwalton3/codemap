# Use reports: codemap through its own MCP surface

Issues hit while USING codemap to do real review work, logged as encountered rather
than found by reading the code. Each entry states what the task was, what happened,
the evidence checked in this repo, and what would fix it; each is answered in an
"addressed" section once it is.

Kept because the reports are better evidence than the fixes are: every one of these
was a reachability or honesty defect over a capability that already existed, folded
and tested — so nothing here would have been found by looking at whether the
operations work. Add to it when the tool surface fails you mid-task, in the same
shape, and leave the report standing after the fix.

---

## 2026-08-25 — triaging the four untriaged findings on Acme.API PR #269

Task: "address the 4 findings in 'not confirmed yet' on PR 269." All four were
shared findings (`f_00mt82r2nq-…`, `f_00mt82rigw-…`, `f_00mt82tajq-…`,
`f_00mt82rw2x-…`), filed by a previous session via the sidecar.

### 1. An agent cannot revise or comment on a shared finding through MCP, though both exist

**Blocking.** Verification changed the *ask* on two of the four findings — one
asked for a fix the reviewed code deliberately rejects on correctness grounds, so
leaving the filed wording would have sent the submitter to do the wrong thing. The
obvious tool refused:

```
revise_finding(id: "f_00mt82r2nq-52690f0ad5", severity: "medium", comment: "…")
→ { "error": "no annotation \"f_00mt82r2nq-52690f0ad5\"" }
```

This is not a missing capability in the model — it is a hole in the MCP surface
only. `src/shared-findings.ts` exports both operations, folds both, and tests one:

- `comment()` — `src/shared-findings.ts:514`, folded at `:379` (`finding.commented`
  → `f.thread.push`), tested at `src/shared-findings.test.ts:238` ("a thread is
  append-only and keeps every voice in order").
- `revise()` — `src/shared-findings.ts:543`, folded at `:342` (`finding.revised`
  rewrites `text` / `comment` / `severity` / `category` / `line`), described in
  its own doc comment as "the one event that can contest".

But neither is reachable. Every `shared.*` call in `src/mcp.ts` is:
`answerSharedNote, confirmSharedDoc, contestedTriage, inboundReplies,
recordPublished, relocateFinding, reportOnFinding, sharedDocs, sharedFindings,
sharedNotes, shareDoc, sharedPull, sharedSync, sharedTriage, sharedWalkthroughs,
shareWalkthrough`. No `comment`. No `revise`.

The prior session's findings carry thread entries opening "Submitter-facing
replacement (supersedes the current wording)", so the capability is plainly
available to a human through the CLI/UI. An agent asked to triage the same
findings cannot do the same thing.

**Fix:** expose `shared-findings.comment` and `shared-findings.revise` as MCP
tools. The fold, the contest machinery and the append-only guarantees are already
built and tested behind them.

### 2. `revise_finding`'s description actively points you at the thing it can't do

`revise_finding` says: "Correct a finding — **yours or somebody else's** … Use it
to sharpen a `comment`, to record what triage concluded (`disposition`), to
re-rate a `severity` you now think is wrong." It names exactly one refusal
condition — "Refused once the finding is on the pull request" — and these
findings were not posted (`publishState: "approved"`, no `postedRef`).

Nothing in the description says it operates on *local annotations only*. Following
it on a shared finding is the natural reading, and it fails.

**Fix:** say so in the description, and detect the id shape in the error. The two
namespaces are trivially distinguishable — local ids are `finding_88acc31fcc46`,
shared ids are `f_00mt82r2nq-52690f0ad5`. `no annotation "f_…"` should instead
read "that is a shared finding; MCP cannot revise those — use `report_on_finding`,
or revise from the CLI."

### 3. `report_on_finding` is the only writable fallback, and it drops the structured verdict

With `revise_finding` unavailable, `report_on_finding` is the only way to get
corrected wording onto a shared finding. Its schema is `{pr, id, result, detail,
files, universe}` — no `comment`, no `severity`, no `disposition`.

So a re-rating lands as prose inside `detail`, and the corrected submitter-facing
text is recorded as an `outcome`, not as the `comment` the submitter actually
reads. The severity stays `high` on the record while the reasoning for `medium`
sits in a paragraph nothing can filter on.

`close_finding` — same family, richer schema — takes `comment`, `disposition`
**and** `line`, and its own description warns against precisely this failure:
"prose saying 'recommend closing as invalid' cannot be filtered on". That warning
describes what `report_on_finding` forces.

**Fix:** give `report_on_finding` the same `comment` / `disposition` / `severity`
fields as `close_finding`. Reporting and closing differ in who acts, not in how
much structure the verdict deserves.

### 4. `shared_findings(queue: true)` hides exactly the findings that need triage

The user's request — "the 4 in *not confirmed yet*" — is the single most common
triage query, and no surface answers it.

`queue: true` narrows to what "is waiting on a PERSON (promoted, or confirmed by
somebody, or with an outstanding request)". An untriaged finding satisfies none of
those, so **the queue excludes everything nobody has looked at yet**. Confirming
all four moved `waitingOnYou` from 4 → 8: the act of triaging is what *adds* them
to the queue. Finding the untriaged four meant reading all 10 findings and
filtering `tier: "unconfirmed"` by eye.

**Fix:** a `tier` filter on `shared_findings`, or a second mode meaning "nobody has
weighed in on these".

### 5. Two finding stores, two vocabularies for the same axis

Known and tracked (`docs/plan-findings-unification.md`), logged here as a
use-report rather than a discovery, with one thing worth keeping and one worth
fixing.

**Works better than the docs imply:** the stores are *not* fully disjoint on
verdict. `corroborate` on a shared finding propagates to the local record — local
`disposition: open` went 26 → 22 as I confirmed the four, and all four then
appeared under `disposition: confirmed`. That is the right behaviour and it is
undocumented; I only established it by re-querying.

**Still bites:** the two surfaces name the same axis differently. Local findings
use `disposition` (`open` | `confirmed` | `partial` | `rerated` | `refuted` |
`accepted`); shared findings use `tier` (`unconfirmed` | `confirmed` | `doubted`).
Neither uses the phrase a human reaches for. And `findings(disposition: "open")`
returns a superset spanning four different PRs, so it cannot answer "what is
untriaged on #269" even though it is the tool whose name matches the question.

**Fix:** one vocabulary across both surfaces, and a `pr` filter on `findings`.

---

## 2026-08-25 (later) — same two holes, second PR

Triaging the two unconfirmed findings on PR #271 hit complaints **1** and **3**
again, unchanged. Both findings needed a severity re-rate off the filed value
(`high` → `high` with a scope qualifier, and `high` → `low`); neither could be
recorded as a severity. Both re-rates are now prose inside a `report_on_finding`
`detail`, while the findings still read `severity: "high"` to anyone filtering.

This is the second PR in one session where the *verdict* survived and the
*rating* did not. Worth noting that a prior session left a standing note that one
PR #271 finding "is stuck at disposition `open` when it should read `partial`" —
same root cause, independently hit.

---

## 2026-08-25 — addressed

Every entry above, in the code. Tests: `src/finding-triage-surface.test.ts`, which is
written from these reports rather than from the operations, because none of this was a
missing capability — the fold has revised findings since it was written.

**1 & 2 — revise is reachable, and dispatches like `comment`.** `revise_finding` now
resolves the id against the RECORDS (annotation / local finding / the fold's), so there
is no store to pick and no `pr` to get wrong. Two refusals, both stating a fold rule at
the write path so the event is not appended-then-ignored: already posted, and a team
finding past `issued` (say it with `comment`, then `request_human`). `no annotation
"f_…"` is gone — an unknown id now names every namespace it could have come from.

**3 — `report_on_finding` is removed; `close_finding` is the one report verb.** They
were one act split by store, with the shared half carrying no `comment`, `severity` or
`disposition`. `close_finding` takes all three across both, and a re-rate the ratchet
refuses is reported back in `note` rather than swallowed. 78 tools -> 77.

**4 — `shared_findings(tier:"unconfirmed")`.** Plus `tiers` counts on every answer,
filtered or not, and `queue`'s description now says outright that it cannot contain the
untriaged. `codemap shared --tier` on the CLI.

**5 — one vocabulary, and `findings(pr:…)`.** Every finding row carries `tier` as well
as `disposition`, `findings` filters on either, and the correspondence lives in one
function (`tierOfAnnotation`) and one table (`docs/plan-findings-unification.md` § "One
axis, two vocabularies"), which also records the cross-store propagation you found by
re-querying. `tier` is taken from the record BEFORE the flattening to a `Disposition`,
which cannot tell `invalid` from unreviewed.

Also, unasked: `METHODOLOGY` now teaches triage — the task in the report was one no
agent was told how to do.
