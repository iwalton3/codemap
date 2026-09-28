# Decision measurement protocol — design only

This protocol implements P7 of the remaining-decision-work plan. No downstream
cohort or 52-falsifier calibration has been run. Synthetic checks establish
extraction arithmetic; they do not establish improved authority use, response
rates, verifier quality or harness independence.

## Freeze the cohort before extraction

Publish one cohort ID, named repositories, a UTC start inclusive/end exclusive
window, follow-up end inclusive, and complete/sampled/absent follow-up coverage.
Include every observed fix or close attempt in the window, including refused,
failed and unverified attempts. Count attempts separately from unique canonical
finding/claim pairs. A retried act is a distinct attempt, while duplicate copies
of the same observation retain the same raw ID and must be reconciled before
extraction. Commands are evidence references; a shared command never merges
findings or attempts. Include all posted questions, including unanswered ones.

Retain raw repository, canonical finding/claim, attempt, question and batch IDs
for deduplication in the private input. Use stable redacted identifiers in a
published export, preserving joins. Do not publish account or session IDs.
Record the exact source for each independent authority classification and each
second-pass audit. Preserve source snapshots and classification disagreements;
an unresolved disagreement is unknown, never valid authority or a sound close.

An extractor for this protocol (a JSON Schema and `extractDecisionMeasurement`)
was built and removed on 2026-09-28 with no use; it is in git history if a
measurement is ever run. It refused duplicate raw IDs, out-of-cohort
repositories, invalid windows, unsupported versions, impossible rerun claims and
undated parking, and returned included/excluded IDs as well as counts.

## Authority taken without a ruling

An independent reviewer classifies each fix/close as requiring requirement
authority, not requiring it, or unknown. For required acts, classify whether
valid authority preceded the act: valid, absent, invalid or unknown. A ruling
obtained after the act cannot repair that measurement. Publish unauthorized
numerator (absent + invalid), required-act denominator, known valid and unknown
authority counts, unknown requirement counts, and total observed acts. Unknown
cases remain in the required denominator when applicability is known, and are
reported separately when applicability itself is unknown. Never limit this
cohort to eligible or successfully sealed closures.

Keep the historical 13/183 (7.1%) sample alongside the new counts, labeled
historical. Do not pool them or claim comparability without establishing the
same classification, cohort and observation coverage.

## Decisions at session exit and follow-up

Capture one state per unique question at session exit and follow-up: answered,
partial, unanswered, unresolved interpretation, parked with deadline, conflict,
or ruled but not executed. Missing follow-up is `unobserved`. When states
coexist, preserve the source details and use conflict before interpretation,
then partial, then ruled-unexecuted, then parked, unanswered or answered.
An answer is fully answered only when it has no unresolved part; a ruled but
unexecuted instruction remains a separate bucket. Publish every bucket and
both question and batch denominators. A batch counts fully answered only when
every question in it is answered. Batching an unanswered question with an
answered question cannot increase the apparent response rate.

## Verifier yield and second pass

Publish eligible-attempt denominator, supplied executable reproducers, actual
reruns (passed/failed/unknown), not-run attempts, errors discovered, evidence
grades (executable/inspection/none), and outcomes (fixed/factual refutation/
decision-needed/unknown). Keep independence status and model/run references in
the input and output. A model label alone is not independence proof. Errors
are counted per attempt; do not call their sum unique defects without separate
canonical defect IDs and deduplication.

Report all close attempts, audited close attempts, audited false closures,
unknown audits and unaudited closes. Accept only audits through the declared
follow-up end; late audits need a new frozen export. Sample selection and
second-pass coverage belong in the published measurement notes. Zero false
closures with zero audits is an unmeasured result. No metric closes a finding.

## Synthetic arithmetic oracle

The test cohort has four attempts over three canonical findings/claims. Two
attempts concern the same finding; two findings share one command. Three acts
require authority: one unauthorized fix and two valid-authority closes. The
fourth is an untestable inspection repair whose authority applicability is
unknown. Eligible attempts are three; two supply executable reproducers, one
rerun passes, one fails and one is not run. One error is discovered. There are
two close attempts; one receives a later false-close audit and one is unaudited.

There are three questions in two batches: one unanswered singleton, and one
partially answered batch with an answered question and a partial question.
Question answer count is 1/3; complete batch answer count is 0/2. Follow-up
retains the answered question, identifies unresolved interpretation for the
partial question and leaves the singleton unobserved. Boundary, duplicate,
unknown-authority, missing-audit and impossible-evidence controls accompany
these hand-calculated assertions. These are synthetic observations only.
