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
one beside it.

## 2. A current, eligible sort

`repair_request` needs a sort that is current (nothing superseded it) and eligible (no holds).

- **There is none:** the sort comes from `/triage-review`, which posts a `dual-sorted` sort — two
  sorters in distinct sessions, an arbitrator where they disagreed — when codemap is attached.
  Run it over these findings. An agent cannot post an `owner-reviewed` sort: that one needs a
  person's authorship and their exact source.
- **It has holds:** read them. Only `implementation-defect` and `mechanical`, or a factual
  refutation, are eligible. A design defect, an assumption, a scope judgment or a dependency on a
  requirement is a person's decision first (`references/asking.md`), not something a verifier
  can settle.
- **The sort is wrong:** post a correction that names it as prior. Adding sites or claims is free;
  dropping one needs a logged ruling (a decisions answer id) on why it is not an instance.

A finding that makes several claims can be split with `record_repair_claims`. The original stays
an obligation, so a partial fix never closes the whole finding.

## 3. Evidence

`record_repair_evidence` against the sort, by whoever ran the checks — usually the fixer.

- **witness / base / fix commits**: the defect shown, the parent, the fix. All pinned and
  reachable.
- **reproducer runs** with `phase: "witness"` and `phase: "fix"`: the same command, the actual
  exit code and output — it **fails at the witness and passes at the fix**. Run them yourself
  before recording. Commands are data; codemap runs nothing, so a result you did not observe is
  `outcome: "unknown"` with the reason.
- **regression runs** in their own phase. A passing suite is not a reproducer and closes nothing.
- **coverage**: per finding, the claims covered and a result with a reason for each claim.
  **attribution**: which file and hunk serve which claim.
- **A pattern** lists its sites in `patternEnumeration`. It closes site by site from the SORT's
  list: each site is fixed, or filed as its own bug with `file_site_bug`.
- **No runnable check**: `noCheckReason` and `inspected` — the source, the commit and your
  reasoning. Inspection is a visibly weaker grade.

## 4. The request

`repair_request` with the review, the sort id and the evidence id. It freezes everything and
returns a request id. You are now the requester: you can never fill a slot of this request, but
you may launch the verifiers.

## 5. Two blind verifiers

Two ways, and only these two count.

**A. Subagents you launch.** For slot 1 and slot 2:

1. `repair_brief` with the review, the request id, `role: "verifier"` and the slot. It returns
   `launch`, a one-line prompt.
2. Launch a fresh subagent whose prompt is **exactly `launch`, with nothing added before or
   after**. Use an agent type that has the codemap tools. Never a fork: a fork inherits this
   session. The two may run in parallel. Do not send either one anything else, and never relay one
   verifier's result to the other.
3. The subagent reads its own brief, runs the checks in a scratch worktree and calls
   `repair_verification`. That submission is **held** until you record it.
4. Record it with `record_repair_verification`: the review, the request id, `role: "verifier"`, the
   slot, the subagent's `agentId` (from its launch result), its `receipt`, and the `callId` — the
   tool-use id of the subagent's own `repair_verification` call. The subagent cannot see that id;
   take it from its transcript:

   ```sh
   t=$(find ~/.claude/projects -name "agent-<agentId>.jsonl" | head -1)
   jq -r 'select(.type=="assistant") | .message.content[]?
          | select(.type=="tool_use" and (.name|test("(^|__)repair_verification$"))) | .id' "$t"
   ```

   The receipt is in that call's result, which the subagent usually reports too:

   ```sh
   jq -r --arg id "<callId>" 'select(.type=="user") | .message.content[]?
          | select(.type=="tool_result" and .tool_use_id==$id) | .content | tostring' "$t" \
     | grep -oE '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}' | head -1
   ```

   codemap checks that the transcript shows the exact prompt, the exact held submission and that
   receipt. `pending` means the transcript has not landed yet: wait and record again. An error
   means the run does not count. Say so; do not resubmit for it.

**B. Sessions a person starts.** Ask the person to open two fresh sessions and run
`/codemap-verify <review>` in each. They claim the role and submit directly; nothing to record.
Use this when subagents cannot reach the codemap tools, or when the person prefers it.

**Arbitration.** When `repair_pending` shows the two runs disagree, do the same with
`role: "arbitrator"` and no slot. Its call is `repair_arbitration`, and it is recorded with
`role: "arbitrator"`.

## 6. Apply

`repair_apply_verification` per finding, with a reason. It rechecks the claim, epoch, sort,
evidence and ruling context, and refuses a stale request. A verifier cannot apply its own verdict;
the requester can.

| Verdict | The finding becomes |
| --- | --- |
| fixed (both runs, or arbitrated) | resolved |
| factually refuted | refuted |
| a reviewer's assumption refuted | invalid |
| decision-needed | nothing — it is a person's decision now |
| unknown | nothing — not closed, not reopened |

Linked bugs are not closed by this.

## 7. Tell the person

Per finding: what each verifier ran and found, what was applied, and what stayed open and why.
An `unknown` or a disagreement is a result to report, not a step to retry. A new request on the
same fix shows the earlier runs that did not come back fixed, so asking again cannot bury them.
