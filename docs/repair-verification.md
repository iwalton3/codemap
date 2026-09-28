# Repair verification

How a repaired finding gets closed on evidence rather than on the fixer's word. The records it
builds on (claims, sorts, evidence, participants) are in [repair records](repair-records.md);
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
  table, no permanent taint — and the connection is then refused anything outside the role.
- **A subagent.** An agent launches one with exactly the `launch` prompt `repair_brief` returns
  ("Run the instructions from codemap MCP tool repair_brief with …"). Its `repair_verification`
  is only HELD on this machine; the launching session records it with
  `record_repair_verification`, and codemap reads the subagent's own transcript: launched with
  exactly that prompt, submitted exactly what was held, got that receipt back.

A subagent shares its parent's connection, so its identity carries the parent's connection plus
its own id. That is how the fold tells the two cases apart for participants:

- the **fixer's or relayer's own connection** cannot verify its repair (refused in the fold);
- a **subagent the fixer launched** can, and the decision says `launchedByParticipant` — the
  owner's weaker grade, shown wherever the repair is.

The orchestrator (whoever calls `repair_request`) may be the fixer; it cannot fill a slot of its
own request. A verifier cannot apply the verdict it gave.

Known residual, accepted with "no permanent taint": a fixer that reconnects gets a fresh
connection and could claim the role. This guards against mistakes, not adversaries.

## The request and the two slots

`repair_request` freezes an eligible current sort and evidence record (the fixer must already be
recorded), the immutable original and decomposed claims, the pinned witness/base/fix commits and
diff, the findings' open epochs and claim hashes, and the ruling context. Missing code is recorded
as unknown. Nothing runs a stored command.

Each request has exactly two blind verifier slots. `repair_brief` gives a slot the claims, the
sort, the pinned commits and the checks the fixer pinned — never the fixer's conclusions or the
other slot's verdict. Per-claim outcomes are `fixed`, `factually-refuted`, `decision-needed` or
`unknown`. On a genuine disagreement a third verifier arbitrates, addressing each disagreement with
a reason; it cannot manufacture evidence a run did not have.

## What "fixed" needs

The owner's bar ("Your approved bar only"):

- **fixed**, executable: the verifier itself runs the check and records it **failing at the
  witness commit and passing at the fix commit** — both observations, the same command. Every
  check the fixer pinned with a known outcome must be run that way; the verifier's result is its
  own, never compared with the fixer's (an echo does not count).
- **factually-refuted**, executable: the verifier's own run of the check passes at the witness.
- **inspection** grade (weaker): only when no pinned check ran, with a no-check reason and the
  relevant commit inspected.

Regression runs never close anything. Partial coverage never closes a whole finding; code
evidence cannot settle a scope or requirement judgment (`decision-needed`).

## Applying, and after

`repair_apply_verification` rechecks the current claim, epoch, sort, evidence, code availability
and ruling context, and the findings fold checks the same (a stale claim or superseded sort
refuses). Fixed closes `resolved`, a factual refutation `refuted`; unknown never closes or
reopens. One application per finding per opening; a reopen starts a new epoch. Linked bugs are
not closed.

A later contradiction — e.g. a verifier's connection later recorded as the fixer — keeps the
historical closure and raises attention. A new request on the same fix shows the **earlier runs
that did not come back fixed** beside it, so asking again cannot bury a bad result; verifier
briefs never show them.

## Derived lifecycle

`repair_records` reports `lifecycles` separately from the historical application: landing (exact
file equality through a squash or cherry-pick, else ancestry, else the restricted PR fallback;
negative ancestry in a shallow clone is unknown) and drift (file-granular; opaque inspections
without an exact file are unknown). Queue, search, finding detail and decision-round detail carry
the same review-qualified presentation. Explicit permanent acceptance is a separate human
disposition (`as: "accepted"` on a verified decision effect), never repair proof.
