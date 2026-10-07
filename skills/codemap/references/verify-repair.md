# Verifying that findings were fixed

A repaired finding closes on evidence two blind verifiers re-ran, never on the fixer's word. The
chain is: **claims → sort → evidence → request → two verifier runs (an arbitrator if they
disagree) → application.** Each step is a shared act on the sidecar, so this needs shared mode.
A local finding — one that never reached the sidecar — has no repair verification: its close is a
person's ask (`close_finding` with a closing state).

## 1. Read what already exists

`pull`, then `repair_records` for the review: the findings' claims, the sorts with their `eligible`
flag and `holds`, any evidence, and earlier requests with their results. `repair_pending` lists
jobs already open. If a request is open for these findings, go to step 5. Do not start a second
one beside it. Once both runs are in and agree, `repair_pending` lists nothing for that request even
though nothing is applied yet: go to step 6.

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
  findings. Its sorters are subagents of one session; codemap accepts that because it finds
  /triage-review's run in that session's transcript. An `owner-reviewed` sort needs a person's
  authorship and their exact source: one an agent posts is held, and then stands in the way of the
  next sort.
- **It has holds:** read them. Three shapes are eligible: `implementation-defect` or `mechanical`;
  a factual refutation (`refutationSubtype: "factual"`); and a reviewer's refuted assumption
  (`invalid` with `refutationSubtype: "assumed"`). A non-empty `restsOn` always holds. A design
  defect, an assumption in the code, a scope judgment or a dependency on a requirement is a
  person's decision first (`references/asking.md`), not something a verifier can settle.
- **The person has ruled on a held sort:** rerun `/triage-review` on the held claims with the
  ruling in hand. Where the ruling decides them, the sorters reclassify — a design defect the
  ruling has decided becomes an implementation defect. Post that as a correction: the held sort as
  prior, `ruling` = the answer id, and `restsOn` without what the ruling decided. Dropping a
  `restsOn` entry without a ruling is refused. Then evidence as usual, listing the ruling in
  `rulingIds`. The blind verifiers judge whether the ruling really decides each claim, and answer
  `decision-needed` if it does not.
- **The sort is wrong:** a correction is a whole new sort. Re-sort with `/triage-review`, naming
  the current sort as `prior`, with a reason. Adding sites or claims is free; dropping one needs a
  logged ruling (a decisions answer id) on why it is not an instance.

## 3. Evidence

`record_repair_evidence` against the sort, by whoever ran the checks — usually the fixer.

- **witness / base / fix commits**: the defect shown, the parent, the fix — full shas, present in
  this clone. `repair_request` refuses one it cannot read: fetch it and request again.
- **reproducer runs** with `phase: "witness"` and `phase: "fix"`: the same command, the actual
  exit code and output — it **fails at the witness and passes at the fix**. Run them yourself
  before recording. A **refutation** inverts this: its check **passes at the witness**, because the
  old code never had the defect; pin base and fix to the commit you examined, so the request
  freezes no diff. Commands are data; codemap runs nothing, so a result you did not observe is
  `outcome: "unknown"` with the reason.
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
every verifier outside this session.

## 5. Two blind verifiers

Two ways, and only these two count.

**A. Subagents you launch** — Claude Code subagents only: codemap checks them against Claude Code's
transcripts, so a Codex subagent never counts as a verifier (use B, or leave the request pending
and say so). For slot 1 and slot 2:

1. `repair_brief` with the review, the request id, `role: "verifier"` and the slot. It returns
   `launch`, a one-line prompt.
2. Launch a fresh subagent whose prompt is **exactly `launch`, with nothing added before or
   after**, and with `isolation: "worktree"` so its checkouts cannot move a live checkout (an
   isolated subagent's transcript still passes codemap's check, measured 2026-10-06). Use an agent
   type that has the codemap tools. Launch it from this session, never from inside another
   subagent: codemap looks for the launch in this session's own transcript. Never a fork: a fork
   inherits this session. The two may run in parallel. Do not send either one anything else, and
   never relay one verifier's result to the other.
3. The subagent reads its own brief, works in a scratch worktree at the pinned commits and calls
   `repair_verification`. That submission is **held** until you record it.
4. Record it with `record_repair_verification`: the review, the request id, `role: "verifier"`, the
   slot and the `receipt` the subagent got back, which it reports. codemap finds the subagent's
   call that returned that receipt, and checks that its transcript shows the exact prompt and the
   exact held submission. `pending` means the call is not on disk yet: record again in a moment
   (for up to a minute). After an error, record once more: some failures (writing to the sidecar,
   say) leave the receipt usable. If the second answer is `no pending held submission…`, the run
   will never count — a fork, a message sent to it after launch, or a call this machine's
   transcripts do not show. Say so, and launch a new verifier rather than resubmitting. Any other
   error that repeats, report as it is.

**B. Sessions a person starts.** The request must be on the remote first (`sync`, step 4). Ask the
person to open two fresh sessions and run `/codemap-verify <review>` in each. They claim the role,
`pull`, and submit directly; nothing to record. `pull` before step 6 to see their runs. Use this
when subagents cannot reach the codemap tools, or when the person prefers it.

**Arbitration.** When `repair_pending` shows the two runs disagree, do the same with
`role: "arbitrator"` and no slot. Its call is `repair_arbitration`, and it is recorded with
`role: "arbitrator"`.

## 6. Apply

`repair_apply_verification` per finding whose verdict closes it (the first three rows below), with
a reason. It rechecks the claim, epoch, sort, evidence and ruling context, and refuses a stale
request. A verifier cannot apply its own verdict; the requester can. Do not apply the rest — the op
refuses `decision-needed`, `unknown` and an incomplete verdict: they go straight to the report.

| Verdict | The finding becomes |
| --- | --- |
| fixed — both runs, or an arbitrator between two closing verdicts | resolved |
| factually refuted | refuted |
| a reviewer's assumption refuted | invalid |
| decision-needed | nothing — it is a person's decision now |
| unknown | nothing — not closed, not reopened |

An arbitrator only chooses between two runs that both closed with evidence: fixed against unknown
or decision-needed stays open, and so does a finding whose claims mix invalid with another
verdict. Linked bugs are not closed by this.

## 7. Tell the person

Per finding: what each verifier ran and found, what was applied, and what stayed open and why.
An `unknown` or a disagreement is a result to report, not a step to retry. A new request on the
same fix shows the earlier runs that did not come back fixed, so asking again cannot bury them.
