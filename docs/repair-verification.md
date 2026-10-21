# Repair verification

How a repaired finding gets closed on evidence rather than on the fixer's word. The records it
builds on (claims, sorts, evidence) are in [repair records](repair-records.md);
the fold is `src/repair-verification.ts`, the ops `src/ops/repair-verification.ts`. The owner's
rulings behind it are in `.git/plan/2026-09-28-codex-recovery/` (plan Phase 2.6).

The acts are `repair.verification-requested`, `repair.verification-recorded`,
`repair.verification-arbitrated` and `finding.repairApplied`, in the canonical findings scope.
The sidecar log is authoritative; SQLite projects verification with the findings.

## Who a verifier is

A verifier's identity is the **MCP connection** its work arrived on (`src/verifier-boundary.ts`),
optionally with a **subagent** id. There are two ways to be one:

- **A dedicated session.** A separate agent session calls `claim_verifier` before any other
  codemap tool on its connection. The claim is held in memory for the connection's life — no
  table, no permanent taint — and the connection is then refused anything outside the role. The
  role includes `pull` (owner, 2026-10-06), so a request made on another clone reaches it. A pull
  brings records into the projection, but none of the role's tools reads them back, and it adopts
  no gone session's queue (it could never sync one).
- **A subagent.** An agent launches one with exactly the `launch` prompt `repair_brief` returns
  ("Run the instructions from codemap MCP tool repair_brief with …"). Its `repair_verification`
  is only HELD on this machine; the launching session records it with
  `record_repair_verification`, and codemap reads the subagent's own transcript: launched with
  exactly that prompt, submitted exactly what was held, got that receipt back.
- **A batch subagent — a reviewer, typically** (plan 2026-10-19-batch-release-held-sorts 4.2;
  owner, DB: "Reviewers verify"). `repair_batch_brief` returns one `launch` line for every open job
  of one role and slot on a review. A subagent whose launch prompt holds that line **whole, on a
  line of its own**, verifies every job in the batch; the rest of its prompt is trusted, the way
  I13 trusts a sort. **Accepted gap, the owner's pick:** a launcher could write steering into the
  surrounding prompt and codemap cannot tell. The single-request pointer keeps exact equality.

A subagent shares its parent's connection, so its identity carries the parent's connection plus
its own id.

**A refused record is re-checked, not spent** (owner, 2026-10-20: "yes to both, build the re-check
then merge"). A receipt a record refuses is settled `invalid` and may be recorded later; `recorded`
and `cancelled` stay final. The residual, accepted: a refusal names what failed, so somebody could
edit the transcript file to match and record again. A spent receipt made that one try harder and
no more, because the transcripts are plain files the launching machine can already write before the
first record. What it cost was real: two codemap-side refusals on 2026-10-20 each burned a whole
verifier run, since a spent receipt left nothing to correct but a new run.

**Only grants verify** (R2, plan 3.1: "We shouldn't pretend to know who the fixer is"): (G1) a
fresh session a person starts with the `codemap-verify` skill, which claims the role first; (G2) a
subagent on a controlled prompt path above — the exact single pointer, or a prompt holding a
batch's launch line; (G3) question logging, which buys derived actions.
There is no fixer record and no weaker grade for a verifier the fixer launched. The tool enforces
the grants; the fold keeps what it can see — the requester (whoever calls `repair_request`) never
fills a slot of its own request, two runs are distinct verifiers, and a verifier cannot apply
the verdict it gave. The rest is an accepted gap: a fixer that reconnects gets a fresh connection
and could claim the role. This guards against mistakes, not adversaries.

## The request and its slots

`repair_request` freezes an eligible current sort and evidence record, the immutable original and decomposed claims, the pinned witness/base/fix commits and
diff, the findings' open epochs and claim hashes, and the ruling context. A pinned commit missing
from the requesting clone refuses the request (owner, 2026-10-06): one frozen as unknown could never
be applied. That is not a verdict on the finding; fetch the commit and request again. Nothing runs a
stored command.

How many blind verifier slots a request has is its frozen sort's `stakes` (plan
2026-10-19 V1, V2; `slotsFor`): **low** has slot 1 alone and closes on that run; **high** has two
slots, and on a genuine disagreement a third verifier arbitrates. Stakes is the sorters'
judgment, trusted like the rest of the sort (I13): a standing `CLAUDE.md` definition, else the
owner's five conditions (money, permanent data loss, PII, a credible lawsuit, a terminal broken
state). Sorters who disagree make it high. Correcting a requested sort makes the request stale, as
any sort change does.

**Every posted sort states its stakes** (owner, F15: "Yes ideally"), at the op and in the fold.
Released and ruled sorts are codemap's and inherit the held sort's. A sort without stakes is one
from before they existed, and it is high: the default is applied where the fold reads
`capsule.sort.stakes`, never computed by an op. **A correction may raise stakes and never lower
them, with one exception** (owner: "agreed"): a `dual-sorted` correction may set `low` on a sort
that has NO stakes, and only with fresh readers — the fold refuses it when a sorter's identity is
the prior sort's. Setting stakes is a new reading; without that, the backlog's sorts had no way
down and every request needed two slots. `repair_request` on a stakes-less sort answers with a
note saying so. A correction that changes no reading keeps the prior's sorters (F5).

`repair_brief` gives a slot the claims, the sort, the pinned commits and the checks the fixer
pinned — never the fixer's conclusions or the other slot's verdict. `repair_batch_brief` gives the
same, one entry per open job of one slot across the review, so a round's close-out costs one
verifier per slot (plus an arbitrator for the high-stakes runs that split) whatever the number of
findings. Each entry is still submitted and recorded per request, so every rule below is per
request. Batches are per universe; a review that spans repos still costs one verifier per slot,
because one subagent may carry several universes' launch lines (measured, P1), and
`repair_batch_brief` with `workspace: true` hands the coordinator all of them at once.

**Slot 2 of a high-stakes request derives its own check** (F18, owner: "Agreed"). Two slots that
re-run the fixer's check are two observers of one check. Its brief is two steps: the claims and
code only, then — once `repair_derived_check` has saved the check it wrote, once and never
replaced — the evidence. Its run carries `derivedCheck`, that command run at the witness and the
fix; the op and the fold refuse a slot-2 run without one. **Accepted gap:** the fold sees that a
check was derived, never when the verifier read what; the order is the two-step brief's alone. Per-claim outcomes are `fixed`, `factually-refuted`, `decision-needed` or `unknown`. An
arbitrator addresses each disagreement with a reason; it cannot manufacture evidence a run did not
have.

## What "fixed" needs

The owner's bar ("Your approved bar only"):

- **fixed**, executable: the verifier itself runs the check and records it **failing at the
  witness commit and passing at the fix commit** — both observations, the same command. Every
  check the fixer pinned with a known outcome must be run that way; the verifier's result is its
  own, never compared with the fixer's (an echo does not count). Each run is in a fresh, clean
  worktree at its commit, and a check that finds no test to run is not a red (F17, the session's
  tightening of this bar, named in the plan). **A mutation run** stands in for the witness red,
  per command: run at the fix commit with a named change applied, failing, beside the same
  command passing without it. It is how a missing-test claim shows its test can fail, since the
  witness has none. Nothing marks a claim as a test gap; whether the mutation proves this claim is
  the verifier's judgment, in its reason.
- **factually-refuted**, executable — the *real basis* (plan 3.3): the verifier first states in
  `basis`, with a reason, whether the pinned check actually tests the claim. If it does not, the
  verifier cannot refute on it. Then it runs every pinned check at the witness (the old code),
  where each must pass. Any other passing command proves nothing. With no pinned check, a refutation
  is an inspection with a written reason.
- **invalid**: a reviewer's refuted assumption, sorted `refutationSubtype: "assumed"`. It closes
  the same way (its stakes' runs, an arbitrator on disagreement), and each run may be executable or an
  inspection with a written reason, because such a refutation is often shown by reading. An
  assumption IN THE CODE is a real finding and never invalid.
- **inspection** grade (weaker): only when no pinned check ran, with a no-check reason and the
  relevant commit inspected.

**Evidence that could never meet this bar is refused at filing** (F13, owner: "yes"), by
`record_repair_evidence` and by the fold: per command a reproducer pins, a fix needs a red (at the
witness, or a mutation run) and a pass at the fix under that exact command string; a refutation
needs a pass at the witness. Each such filing used to cost a verifier run returning `unknown`.

**The schema-6 rules bind only events written under them** (`closeoutRules`, the first fold to
condition on an event's own `eventSchema`): stakes on a posted sort, the filing check, the mutation
phase, leftovers and slot 2's derived check. An event stamped lower keeps the rules it was written
under, so evidence already in a team's log and every stakes-less sort stay valid instead of
becoming damage.

**This is the only way an agent closes a finding** (R4, "one bar"). An agent's direct `refuted` or
`invalid` close is gone, including on its own unconfirmed finding. It becomes a person's ask. Local
findings have no repair verification, so an agent's close there is always an ask. Bugs keep their
agent close path until the bug follow-up.

**A pattern closes site by site** (plan 3.4). The sites are the arbitrated SORT's list, never the
evidence record's own enumeration, which is kept out of the verifier brief. A `fixed` result gives
each site a disposition: fixed, or filed as a bug with `file_site_bug`. That bug inherits the
finding's filer and confirmation, must still be open when the verdict is applied, and must cite a
symbol in the site's own file. The op checks each bug at submission and again at application. The
fold checks only that every site has a disposition, because the bug lives in another scope. The
verifier learns a filed site's bug id from the evidence's `siteBugs`, which the brief carries — it
cannot look bugs up, so this tells it which sites the fixer did not fix (owner, I14 (a)). A
correction of a sort supersedes it and may add sites or claims freely; one that drops a site or
claim is refused unless it cites a logged ruling on why it is not an instance (R5, plan 5.2). A
held sort's `restsOn` is dropped only by its ruling (`ruled`) or, break-glass, a two-reader
release (`released`; `docs/repair-records.md`), and the verifier brief carries the release's
rulings with their words.

Any bug made from a finding (`defer_finding`, `file_site_bug`) keeps the finding's filer and
the verdicts that stood behind it (plan 3.5). An agent deferring a person's confirmed finding
therefore files it as a confirmed bug of theirs, not as an agent proposal.

Regression runs never close anything. Partial coverage never closes a whole finding; code
evidence cannot settle a scope or requirement judgment (`decision-needed`).

## Applying, and after

`repair_apply_verification` rechecks the current claim, epoch, sort, evidence, code availability
and ruling context, and the findings fold checks the same (a stale claim or superseded sort
refuses). Fixed closes `resolved`, a factual refutation `refuted`, a refuted assumption `invalid`; unknown
never closes or reopens. One application per finding per opening; a reopen starts a new epoch. Linked bugs are
not closed.

**Leftovers** (F19, owner: "if it is a real problem it becomes a newer, narrower scoped finding,
otherwise it is a note during closure"). A verifier records anything real it found beside the claim
as `leftovers`, `problem` or `note`. The application carries every slot's, unioned by text, and a
text any slot called a problem is a problem — on a low-stakes request the one verifier is the only
judge. The fold refuses an application whose leftovers are not exactly its runs'. The apply op files
each problem itself as a new finding on the same review and the parent's code, citing the parent,
once per request; notes stay on the closure (`repairClosure.notes`). The verifier stays blind and
writes nothing but its run.

A later contradiction — the code the closure verified has moved — keeps the historical closure and
raises attention. A new request on the same fix shows the **earlier runs
that did not come back fixed** beside it, so asking again cannot bury a bad result; verifier
briefs never show them.

## Derived lifecycle

`repair_records` reports `lifecycles` separately from the historical application: landing (exact
file equality through a squash or cherry-pick, else ancestry, else the restricted PR fallback;
negative ancestry in a shallow clone is unknown) and drift (file-granular; opaque inspections
without an exact file are unknown). Queue, search, finding detail and decision-round detail carry
the same review-qualified presentation. Explicit permanent acceptance is a separate human
disposition (`as: "accepted"` on a verified decision effect), never repair proof.
