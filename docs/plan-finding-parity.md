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

- **`rerated`** — *"real, but the severity or impact differs from as-filed"*. **CLOSED**:
  `reratedFrom` derives it from `revisions`, never storing a second copy that could
  disagree. It compares against the EARLIEST recorded `was`, so a finding raised to
  critical and dropped back to medium is not counted — comparing against the previous
  value would have said it was.

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

## 5. Push state: less missing than it looks, and split in two

Izzie's instinct — *"store the push state in the sqlite database on push, referencing the
findings as foreign keys"* — is the right shape, and half of it is already built. Push
state is two different things and they were conflated on the annotation:

- **Where it LANDED**, after the fact. Already canonical: `SharedFinding.posted` is an
  `ExternalRef` (`system`, `key`, `url`, `at`, `by`), written by `record_published` and
  read by `inbound_replies` to match the submitter's thread. It needs no `pr` because a
  finding carries its own. **Done.**
- **Where a person WANTS it published**, before the fact — `publishPath`, `publishLine`,
  `publishAttribution`, and the `escalated` elect gate. No canonical home. This is the
  part that would want the table.

The remaining piece of the first half is `pr_push`, still a `meta` JSON blob keyed by
pull request and listing ANNOTATION ids (`readPushes`/`writePush`). That is the record
that stops a re-run duplicating a comment, and it is the one thing here that genuinely
wants to become a table with a finding foreign key: keyed on annotations, it cannot
dedupe a canonical finding at all.

**But building either is gated on the decision below**, not on parity. Both serve raw
comment push, which is off wherever a sidecar exists.

## What is left before parity

1. ~~**`rerated` as a derived signal.**~~ **DONE** — `reratedFrom` compares the current
   severity against the EARLIEST recorded `was`, so a finding raised and dropped back is
   not counted; filterable via `shared_findings(rerated: true)`. Derived, never stored, so
   it cannot disagree with `revisions`. Across 169 real findings: 8 have revisions, 2 have
   a severity revision, 1 is actually re-rated — which is the discrimination the field is
   for.
2. **Decide about raw comment push.** Everything else on this page hangs off it. If it
   stays, canonical findings need the three publish fields, the elect gate, and `pr_push`
   as a table keyed on findings. If it goes, all four fields retire with the annotation
   store, `pr_push` goes with them, and `posted` stays for `inbound_replies` — which is
   worth keeping either way, because findings already pushed still get replies.

Everything else the old store did, the new one does — and the reverse list is fourteen
fields long.
