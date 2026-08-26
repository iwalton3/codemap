# Parity: what the annotation store did that the findings table does not

Prerequisite to `docs/plan-retire-local-findings.md`. The old system got several things
right, and dropping it before the new one covers them would lose capability rather than
duplication. This is the field-by-field diff, not an impression.

Written 2026-08-25 from the two declarations (`Annotation` in `schema.ts`, `SharedFinding`
in `shared-findings.ts`), then checked against what each field is actually read by.

## The diff

```
OLD only:  disposition  publishPath  publishLine  publishAttribution  escalated  createdCommit  kind
BOTH:      id target text comment severity category line witness sourceRef author assignment outcome revisions
NEW only:  state corroboration thread promotion posted upstream bug remediation outcomes
           pending asks closed relocation contested origin pr filed
```

The new store is a superset in every respect except `disposition` and the three publishing
fields. That is a smaller gap than it looked, and two of the four are already moot.

## 1. `disposition` — the real gap, now half closed

Six values: `open | confirmed | partial | rerated | refuted | accepted`. The new store
answers the same question with per-reviewer **verdicts**, which is strictly richer — it
keeps who said it, whether they were independent, and the disagreement between two models.
But the vocabulary was narrower, so two values had nowhere to go.

- **`partial`** — *"real in part; `comment` states the part that is real, in full"*.
  **CLOSED**: `partial` is now a fourth verdict. It counts as standing behind the finding
  everywhere `confirm` does (`findingTier`, `needsHumanAck`, the closing gate, the re-rate
  gate) because it says *real, with a correction*, not *maybe*.

  This is not a theoretical gap. On the last real triage pass an agent concluded `partial`
  on `finding_0916cfc2ad21`, and with no word for it the conclusion lived in the
  corroboration rationale and the close detail — in no filterable field. Its own report
  said so: *"`disposition` is not recorded on shared findings (verdicts are), so `partial`
  lives in the corroboration rationale and the close detail, not as a filterable field."*

- **`rerated`** — *"real, but the severity or impact differs from as-filed"*. **STILL OPEN.**
  The data exists: `revisions` records every `severity` change with its `was`. What is
  missing is the derived, filterable signal — "this finding's severity is not the one it
  was filed at". Cheap to compute at read time; nothing needs storing. Worth doing before
  the retirement, because "what did triage change its mind about" is a real triage question
  and today it needs reading every revision list.

- `open` / `confirmed` / `refuted` map to no-corroboration / a standing-behind verdict / a
  refute verdict. `accepted` maps to the `bug` link (`defer_finding`). All covered.

## 2. The publishing fields — moot where it matters, real where it does not

`publishPath`, `publishLine`, `publishAttribution` and `escalated` exist to serve one act:
posting a finding to GitHub as a review comment. `publishPath` is the interesting one —
GitHub only accepts a comment on a file in the diff, and plenty of real findings are about
code the branch never touched, or about an ABSENCE, which has no line anywhere. A person
picks the nearest file; nothing is guessed.

**Moot wherever a sidecar is configured**, because raw comment push is now off there: the
findings live on the sidecar and the pull request gets the verdict and the viewed ticks.
So on every universe that has a team, these four fields serve nothing.

**Not moot for a solo store**, which is exactly the configuration the retirement plan turns
into "a sidecar nobody else pulls from" — at which point comment push is off there too, and
the fields become dead everywhere.

So the honest sequencing is: **these are not a parity gap to close, they are a feature to
decide about.** Either raw comment push is a thing codemap does (and canonical findings
need the four fields) or it is not (and they go with the annotation store). The current
answer is "not, wherever there is a team", and the retirement makes that universal. Worth
stating out loud rather than discovering it as an absence later.

## 3. `createdCommit` — deliberately not carried, and that is right

The old store recorded the checkout's HEAD at filing time. The new one records `sourceRef`
(what was actually read) and `filed.at`. The audit in `docs/finding-event-shape-audit.md`
measured why the distinction matters: `createdCommit` is where you were STANDING, not what
you were READING, and on `Acme.React` it was the same merge commit for 24 of 51 records —
it discriminated nothing. `sourceRef` is the field that would have caught the wrong-tree
triage, and it is the one the new store kept.

Not a gap. Recorded because it looks like one in the diff.

## 4. `kind` — correctly absent

A finding is one kind. Notes, questions and pointers stay annotations, which
`docs/sidecar-architecture.md` settles as a different entity. `promote_annotation` is the
bridge when a pointer turns out to be a defect.

## What is left before parity

1. **`rerated` as a derived signal** — a finding whose current `severity` differs from its
   earliest recorded one, filterable. Read-time only.
2. **Decide about raw comment push.** If it stays, canonical findings need `publishPath` /
   `publishLine` / `publishAttribution` and an elect gate. If it goes, delete those four
   fields with the annotation store and say so in the tool descriptions.

Everything else the old store did, the new one does — and the reverse list is fourteen
fields long.
