# Verifying that findings were fixed

A repaired finding closes on evidence blind verifiers re-ran, never on the fixer's word. The
chain is: **claims → sort → evidence → request → verifier runs → application.** How many runs
is the sort's `stakes`: **low** closes on one verifier's run; **high** — or a sort posted before
stakes existed — on two, with an arbitrator if they disagree. Verification is batched per round:
one verifier per slot covers every request on the review, and on a review that spans repos, every
universe's requests. Each step is a shared act on the sidecar, so this needs shared mode.
A local finding — one that never reached the sidecar — has no repair verification: its close is a
person's ask (`close_finding` with a closing state).

## 1. Read what already exists

`pull`, then `repair_records` for the review: the findings' claims, the sorts with their `eligible`
flag and `holds`, any evidence, and earlier requests with their results. `repair_pending` lists
jobs already open. If a request is open for these findings, go to step 5. Do not start a second
one beside it. Once both runs are in and agree, `repair_pending` lists nothing for that request even
though nothing is applied yet: go to step 6.

This step is the fixer's and the applier's. A slot-2 verifier of a high-stakes request does not call
`repair_records` before it has derived its own check: its run is refused if it saw the evidence first.

Check holds now, before any evidence work. `findings` marks a finding `held` when a person's
decision holds it, and `repair_request` refuses a request that covers a held or closed finding. A
held finding is a person's decision first (`references/asking.md`).

## 2. Claims first, then a current, eligible sort

**Split the claims before anything is sorted.** A finding that makes several claims is split with
`record_repair_claims` (parent `<findingId>:original`, with a reason). A verdict on a claim the
sort does not cover is refused, so a split found after the sort needs a new sort (below), and one
made after the evidence makes that evidence stale. The original stays an obligation, so a partial
fix never closes the whole finding.

`repair_request` needs a sort that is current (nothing superseded it) and eligible (no holds).

- **There is none:** the sort comes from `/triage-review`, which posts a `dual-sorted` sort — two
  sorters, an arbitrator where they disagreed — when codemap is attached. Run it over these
  findings. An `owner-reviewed` sort needs a person's
  authorship and their exact source: one an agent posts is held, and then stands in the way of the
  next sort.
- **It has holds:** read them. Three shapes are eligible: `implementation-defect` or `mechanical`;
  a factual refutation (`refutationSubtype: "factual"`); and a reviewer's refuted assumption
  (`invalid` with `refutationSubtype: "assumed"`). A non-empty `restsOn` always holds. A design
  defect, an assumption in the code, a scope judgment or a dependency on a requirement is a
  person's decision first (`references/asking.md`), not something a verifier can settle.
- **The person has ruled on a held sort:** its `restsOn` must name the decision —
  `decision:<id>`. If it still holds a free label, re-point it first: a correction with the held
  sort as prior and the label replaced by the decision entry. Then `release_ruled_sort`: it
  releases the sort when every decision it rests on has a **verified** standing answer whose chosen
  options **unblock every finding the sort covers**, and no open intent comparison restricts one of
  them (compare the readings first). codemap writes the correction itself,
  `implementation-defect`, provenance `ruled`, with the rulings in it; evidence lists them in
  `rulingIds`, and the blind verifiers still answer `decision-needed` where a ruling does not
  decide a claim. It refuses an unverified answer (relayed words the transcript could not confirm
  only unblock decision holds), a settle, and an unblock that misses a covered finding: ask the
  person again, with a decision whose unblock names them all. Dropping a `restsOn` entry any other
  way is refused.
- **Break-glass, headless backlog work only:** when nobody is present to ask and the ruling does
  not unblock the sort as it stands, two readers may release it instead (owner, D2):
  `release_reader_brief` for slot 1 and slot 2, each launched as a fresh background subagent from
  this session with exactly its prompt; each calls `submit_release_verdict`; then
  `release_held_sort` with both refs. Both must say yes. A `no` or a split leaves the sort held for
  a person-led `/ez-plan`. With a person in the session, use `/ez-plan` and the ruled release.
- **It has no stakes** (posted before stakes existed): it reads as high, so its request needs two
  slots, and `repair_request` says so in a `note`. If it is low, set that first with a
  `dual-sorted` correction by **fresh** sorters, not the prior sort's (setting stakes is a new
  reading); raise-only allows no other way down, and none at all once any earlier sort in its
  chain said `high`. Every sort posted now must state `stakes`.
- **Stakes for a backlog** — the sweep, and the same thing for one round's stakes-less sorts at
  request time: FULL sorts, not a stakes-only pass (owner). Batch ~20-30 findings still true on the
  trunk per sorter run, two sorters and an arbitrator where they disagree, posted with
  `post_repair_sort` as `dual-sorted` corrections; sorters who disagree on stakes mean high.
  Findings no longer true on the trunk are left alone: they cost nothing.
- **Re-pointing or re-posting without a new reading** keeps the sorters: a correction with the
  same classification, stakes, refutation, coverage, kind, predicate, sites and `testGap`, and
  either no assessments or the prior's own classifications and reasons, keeps the prior sort's
  assessments with their identities. Change any of those — widening coverage included — and the
  correction is a new reading, with its own readers.
- **`testGap`** is the sorters' mark that every claim the sort covers is a missing test; only
  then does a mutation run count for it. Sorters who disagree on it mean no marker, and a sort
  that would mix a behaviour claim with a test gap is split into two sorts. Nothing checks these
  two rules but you.
- **The sort is wrong:** a correction is a whole new sort. Re-sort with `/triage-review`, naming
  the current sort as `prior`, with a reason. Adding sites or claims is free; dropping one needs a
  logged ruling (a decisions answer id) on why it is not an instance.

## 3. Evidence

`record_repair_evidence` against the sort, by whoever ran the checks — usually the fixer.

- **witness / base / fix commits**: the defect shown, the parent, the fix — full shas, present in
  this clone. `repair_request` refuses one it cannot read: fetch it and request again.
- **reproducer runs** with `phase: "witness"` and `phase: "fix"`: the **same command string**, the
  actual exit code and output — it **fails at the witness and passes at the fix**. Run each at its
  commit in a fresh, clean worktree: a run must not see a file another run wrote, and a check that
  finds no test to run ("No tests found") is not a failure. A **refutation** inverts this: its
  check **passes at the witness**, because the old code never had the defect; pin base and fix to
  the commit you examined, so the request freezes no diff. Commands are data; codemap runs nothing,
  so a result you did not observe is `outcome: "unknown"` with the reason. **Evidence whose own runs
  could never meet that bar is refused at filing** — a fix command written as "same command as …",
  or a check that passes at both commits.
- **A missing test** has nothing to fail at the witness. On a sort marked `testGap`, pin a
  **mutation run** instead: `phase: "mutation"` at the fix commit, with `mutation: { site, change }`
  naming exactly what you broke, and the run failing; beside it, the same command passing at the
  fix without the change. The verifier reruns the mutation and judges whether it tests this claim.
  On an unmarked sort a mutation run meets nothing: filing refuses evidence whose only red is one,
  so the missing-test claim needs a witness red or an inspection — or a corrected sort with the
  marker.
- **regression runs** in their own phase. A passing suite is not a reproducer and closes nothing.
- **coverage**: per finding, the claims covered and a result with a reason for each claim.
  **attribution**: which file and hunk serve which claim.
- **A pattern** lists its sites in `patternEnumeration`. It closes site by site from the SORT's
  list: each site is fixed, or filed as its own bug with `file_site_bug`. List each filed site in
  `siteBugs` with the id `file_site_bug` returned: the blind verifier cannot look bugs up, and
  reports those sites by these ids.
- **No runnable check**: `noCheckReason` and `inspected` — the source, the commit and your
  reasoning. Inspection is a visibly weaker grade.

## 4. The request

`repair_request` with the review, the sort id and the evidence id. It freezes everything and
returns a request id. You are now the requester: you can never fill a slot of this request, but
you may launch the verifiers. If a `begin` is open, `sync` now: a staged request is invisible to
every verifier outside this session. Request every repaired sort of the round before step 5, so
one batch covers them.

## 5. Blind verifiers, one per slot, batched

Slot 1 always; slot 2 only for a high-stakes request (`repair_pending` lists exactly the open
slots). `repair_batch_brief` with the review, `role: "verifier"` and the slot lists every open job
of that slot on the review — a low-stakes request appears in slot 1's batch only — and returns
one `launch` line for the batch. One verifier per batch does every entry, submitting each as its
own `repair_verification`. `repair_brief` is the same for one request.

**A review that spans repos** still takes one verifier per slot, not one per repo: call
`repair_batch_brief` with `workspace: true`, the role and the slot. It returns every universe's
batch for that slot, and `launch` holds all of their lines; put them all, each whole and on a line
of its own, in ONE subagent's prompt. It does each batch's entries with that batch's `universe`.

**Slot 2 of a high-stakes request is two steps**, so it is a second check and not a second run of
the first: its brief first carries the claims and code only (`stage: "derive"`); the verifier
submits the check it derived from them with `repair_derived_check`, reads the brief again for the
evidence, and submits that check's own runs as `derivedCheck` with its results. A subagent's
`repair_derived_check` returns a **receipt**: it passes it as `derived` when it reads the brief
again (a batch: `derived: { <requestId>: <receipt> }`) and as `derivedCheck.receipt` with its
results. Without the receipt the brief stays at `stage: derive`, so a relaunched verifier derives
its own. The record refuses a run whose check another agent derived, or that read the evidence
before deriving. A batch entry at `stage: derive` works the same way.

**Leftovers.** Anything real a verifier finds beside the claim goes in `leftovers` on its
`repair_verification`, never in a reason: `{ kind: "problem", text }` for something that is wrong,
`{ kind: "note", text }` for something worth knowing.

Three ways, and only these count.

**A. Subagents you launch** — Claude Code subagents only: codemap checks them against Claude Code's
transcripts, so a Codex subagent never counts as a verifier (use C, or leave the request pending
and say so). For each slot with open jobs:

1. `repair_batch_brief` (or `repair_brief` for one request) with the review, `role: "verifier"`
   and the slot. It returns `launch`, a one-line prompt.
2. Launch a fresh subagent whose prompt is **exactly `launch`, with nothing added before or
   after**, and with `isolation: "worktree"` so its checkouts cannot move a live checkout (an
   isolated subagent's transcript still passes codemap's check, measured 2026-10-06). Use an agent
   type that has the codemap tools. Launch it from this session, never from inside another
   subagent: codemap looks for the launch in this session's own transcript. Never a fork: a fork
   inherits this session. The two may run in parallel. Do not send either one anything else, and
   never relay one verifier's result to the other.
3. The subagent reads its own brief, works in a scratch worktree at the pinned commits and calls
   `repair_verification`. That submission is **held** until you record it.
4. Record each with `record_repair_verification`: the review, the request id, `role: "verifier"`, the
   slot and the `receipt` the subagent got back for that request, which it reports. codemap finds the subagent's
   call that returned that receipt, and checks that its transcript shows the exact prompt and the
   exact held submission. `pending` means the call is not on disk yet: record again in a moment
   (for up to a minute). After an error, record once more: some failures (writing to the sidecar,
   say) leave the receipt usable. A refusal names its reason — a fork, a message sent to it after
   launch, a call this machine's transcripts do not show — and repeats on every record unless
   codemap itself changed, so say so and launch a new verifier rather than resubmitting. The
   receipt is not spent: if codemap's own check was the defect, record it again after the fix. Any other
   error that repeats, report as it is.

**B. The next review round's reviewers.** A reviewer's prompt may carry a batch's `launch` line,
**whole and on a line of its own**, beside its own review instructions: it verifies that batch and
reviews in the same run, and its submissions are recorded as in A. Slot 1's and slot 2's lines go
to different reviewers. `/codemap-review` does this; `codemap-check-fixes` is the scoped form, for
checking fixes without a full review. The rest of the prompt is trusted, so write nothing in it
about what the fixes did.

**C. Sessions a person starts.** The request must be on the remote first (`sync`, step 4). Ask the
person to open two fresh sessions and run `/codemap-verify <review>` in each. They claim the role,
`pull`, and submit directly; nothing to record. `pull` before step 6 to see their runs. Use this
when subagents cannot reach the codemap tools, or when the person prefers it.

**Arbitration.** High stakes only. When `repair_pending` shows two runs disagree, do the same with
`role: "arbitrator"` and no slot — `repair_batch_brief` batches every request that split. Its call
is `repair_arbitration`, and it is recorded with `role: "arbitrator"`.

## 6. Apply

`repair_apply_verification` per finding whose verdict closes it (the first three rows below), with
a reason. It rechecks the claim, epoch, sort, evidence and ruling context, and refuses a stale
request. A verifier cannot apply its own verdict; the requester can. Do not apply the rest — the op
refuses `decision-needed`, `unknown` and an incomplete verdict: they go straight to the report.

| Verdict | The finding becomes |
| --- | --- |
| fixed — its one run (low stakes); both runs, or an arbitrator between two closing verdicts (high) | resolved |
| factually refuted | refuted |
| a reviewer's assumption refuted | invalid |
| decision-needed | nothing — it is a person's decision now |
| unknown | nothing — not closed, not reopened |

An arbitrator only chooses between two runs that both closed with evidence: fixed against unknown
or decision-needed stays open, and so does a finding whose claims mix invalid with another
verdict. Linked bugs are not closed by this.

Applying makes the leftovers findings: every slot's are unioned, a text either slot called a
`problem` is a problem, and each problem becomes a new, narrower finding on the same review that
cites its parent (`filed` in the answer) — the verifier's as author, its text as the comment, the
fix commit as its ref. Notes stay on the closure. On a retired topic nothing is filed: the
problems show on the closure with attention, for you to file where they belong. Nothing else to
file by hand.

## 7. Tell the person

Per finding: what each verifier ran and found, what was applied, what stayed open and why, and
any leftover filed as a new finding.
An `unknown` or a disagreement is a result to report, not a step to retry. A new request on the
same fix shows the earlier runs that did not come back fixed, so asking again cannot bury them.
