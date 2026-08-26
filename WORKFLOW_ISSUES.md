# Workflow issues

Friction hit while *using* the review workflow end-to-end, as opposed to bugs in a
single tool call (those live in `CODEMAP_COMPLAINTS.md`). Newest first. Same
conventions: real transcripts, a **Fix:** per item, and withdrawals recorded when
a complaint turns out to be my misdiagnosis.

---

## 2026-08-25 (night) — a fixed finding still reads as a live defect

Full pass over PR #270: fold eight review rounds, verify every finding against
head `5e600945` in source, file what the head delta turned up. The verification
worked. The *reporting* of it did not, and Izzie caught it:

> "I still see 4 findings which don't have comments saying they're fixed.
> I could be missing something or it could be a codemap bug"

Neither. The data was right and the presentation was wrong, in a way no amount of
care on my side could have fixed.

### 1. `comment` is immutable once confirmed, so "fixed" is unsayable

Five findings carried `remediation: "fixed-on-branch"` and a full `outcome.detail`
with file:line verification at head. What they carried in `comment` — the
submitter-facing field, and the one the finding list renders — was still the
original defect prose: *"The Acme per-gallon platform fee is multiplied by a litre
count…"*. Reading the list, every one looked live.

Both routes to fixing that are closed:

```
revise_finding(id: "f_00mt8zvn7m-cc017f2546", remediation: "fixed-on-branch",
               allowPostEdit: true)
→ "f_00mt8zvn7m-cc017f2546 has been confirmed, so only a person rewrites it now"

close_finding(id: "f_00mt833n50-9ab3835b8e", comment: "Resolved at head 5e600945…")
→ ok: true, but: "comment NOT changed: … has been confirmed, so only a person
   rewrites it now"
```

The gate itself is correct and I do not want it removed — it is the same rule that
stops an agent quietly rewriting what someone stood behind. But it currently
conflates two very different edits:

- **rewriting the claim** ("this isn't actually a defect") — rightly gated;
- **recording that the claim was addressed** ("this is fixed, here is where") —
  not a rewrite of anyone's judgement at all, and gated identically.

So there is no way for an agent to make a fixed finding *read* as fixed. The
status lives in `remediation` and `outcome`, and the eye lands on `comment`.

**Fix:** either render `remediation` next to `comment` wherever findings are
listed (cheapest, and fixes it for every existing record), or let an agent attach
a resolution banner that is stored separately from the author's wording and
displayed above it. The author's words stay untouched either way — that is the
point of the gate, and it is preserved.

### 2. `close_finding` returns `ok: true` while refusing half the call

The transcript above is the whole problem: `ok: true`, with the refusal buried in
prose inside `note`. An agent that treats `ok` as the success signal — which is
what `ok` means everywhere else — believes the comment landed and moves on. I only
caught it because I re-read the notes.

**Fix:** either `ok: false` when a requested field was refused, or a structured
`applied: [...]` / `refused: [...]` pair. Prose in `note` is not a status code.

### 3. Truncated finding ids fail as "does not exist"

Findings render as `f_00mt8zvn7m-cc017f2546`. The prefix alone is a natural thing
to copy, and it fails opaquely:

```
revise_finding(id: "f_00mt8zvn7m")
→ "no finding or annotation \"f_00mt8zvn7m\" — ids come from `findings`,
   `shared_findings` or `review_queue`"
```

The message says the record does not exist. It does; the id is half of one. Cost
four failed calls before I spotted the pattern.

**Fix:** on a unique prefix match, either resolve it or say *"did you mean
`f_00mt8zvn7m-cc017f2546`?"*.

### 4. `allowPostEdit` reads like the escape hatch and is not

Its description covers the *posted* case ("The GitHub copy is NOT updated — reply
there instead"). Nothing says it is inert against the *confirmed* gate, so the
obvious reading is that it unlocks post-hoc edits generally. I passed it on four
calls before the error told me the real blocker was a different gate entirely.

**Fix:** one clause — "does not lift the confirmed-finding gate; use
`request_human`."

### 5. Listing tools blow the token budget at ordinary corpus sizes

Both exceeded the response cap on a normal-sized PR corpus, in `brief` mode, which
is already the default:

```
findings(limit: 100)              → 130,338 chars across 1,862 lines — spilled to file
shared_findings(pr: "270", …)     → 194,614 chars across 1,101 lines — spilled to file
```

84 findings across six PRs, and 25 on one PR. Both times I had to dump to disk and
query with python. Workable, but it turns "what is still open" into a three-step
detour, and the spill-to-file path carries an instruction block telling me to read
100% of the content sequentially — for data I only wanted four fields from.

**Fix:** a genuinely terse mode (`id`, `severity`, `tier`, `remediation`, and the
first line of `comment`) — `brief: true` still returns full `comment` plus
`textPreview` plus `postedRef` per row, which is where the size goes.

### 6. Credit: `withdraw` exists now

The complaint logged earlier in `CODEMAP_COMPLAINTS.md` — *"`request_human` has no
word for 'withdraw'"*, forcing a true-but-duplicate finding to be queued as
`invalidate` — is fixed. The enum today is
`promote | invalidate | refute | resolve | withdraw`, and the description frames it
exactly as the complaint asked: *"`withdraw` retires the record with the claim
intact — a duplicate."*

### 7. Credit: `defer_finding` is the right shape

Accepting three findings as bugs was frictionless, and the derived-id design does
the thing it claims: the bug id comes from the finding id, so two people accepting
the same finding independently land on one bug. The note — *"the finding stays on
the pull request and the bug now carries the obligation"* — is exactly the mental
model I needed and saved me asking.

### 8. The two-axis model paid off, having previously cost

`disposition` (is the claim true) and `remediation` (what happened about it) being
independent is what let today's pass say "confirmed **and** fixed-on-branch" rather
than corrupting the claim record to mean "done". Worth noting because a prior
session got this wrong in the other direction — folded submitter replies with
`close_finding` and left `remediation` at its default, so "what is still open on
this PR" returned nine findings that had been fixed a day earlier. The axes are
right; what was missing was any prompt to set the second one.

**Fix:** when `close_finding` is called with `result: "fixed"` and no
`remediation`, either infer `fixed-on-branch` or refuse and say so. Silently
defaulting to `outstanding` on a call that literally says "fixed" is the trap.

---

## Cross-reference

`CODEMAP_COMPLAINTS.md` holds the per-tool-call issues from the same period,
including the `created`-state write-up gate (§ "an agent cannot write up a human's
own finding"), which is the same conflation as §1 above at a different lifecycle
stage: an agent may not enrich a human's raw note, and may not record a resolution
on a confirmed one. Both are the gate treating *adding evidence* and *rewriting
judgement* as one operation. If only one thing gets fixed, that distinction is it.
