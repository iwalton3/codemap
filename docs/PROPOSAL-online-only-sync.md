# PROPOSAL — online-only sync: the git remote is the serializer

> **Kind: proposal, UNRATIFIED.** Drafted 2026-09-29 for the owner to review and mark up. Nothing
> here is decided until the owner rules; the open decisions are numbered **D1…** so they can be
> answered by number. Where this disagrees with `docs/sidecar-architecture.md`, that document still
> governs until this one is ratified.

## Why

The pre-merge plan (`.git/triage/2026-09-28-pre-merge-review/`) was the fix round of a diagnosis.
Its one review round found **eight of eight findings in the round's own fixes**, and the round
before it was nearly all fixes on fixes. The owner, 2026-09-29: *"I think the actual mistake was
making this system distributed instead of client-server."*

Most of that work rebuilds, on every client, the two things a server gives for free: **an order**
and **validation at write time**. Examples:
- causal vectors, `after`/`writerPrev` and fork repair;
- a write door that folds every write locally;
- a damage-versus-race classifier inferred from causal context (the round's worst finding);
- an application-wide lockout for bad entries that have already spread;
- holds and "did not land" for concurrent acts.

The original case against a server still holds: no hosting, auth or backups; GitHub's access
control; git history as an audit log. Its note said it "loses real-time and server-side
validation; neither bites at this scale". The second half was wrong: server-side validation is
what the recent rounds kept rebuilding.

**The owner's option, and this proposal:** stay on the git sidecar, but make shared state **online
only**. Local events are staged in a sync queue, then synced and pulled frequently. When a staged
event conflicts with what the remote already holds, it is **rolled back**, and whatever created it
retries or fixes the request. A git push that is not a fast-forward is refused, and that refusal
is a compare-and-swap. The remote becomes the single serializer without anybody running a server.

## The model

1. **The sidecar branch is linear.** No merge commits, no union of shards. An event's position in
   the remote's history *is* its order. Nothing is inferred.
2. **A write stages an event locally, then syncs it:**
   1. `git fetch`.
   2. Reset the local projection to the remote tip.
   3. Replay the staged events one at a time, each validated by the fold against the log exactly as
      it stands before it.
   4. Commit the ones that pass, and push as a fast-forward.
   5. If the push is refused because someone got there first, go back to step 1.
3. **A staged event that fails validation against the remote is rolled back.** It leaves the queue,
   and its creator gets the refusal and the current state to retry against. A person sees *"this
   changed since you read it: …"*. An agent gets a tool error.
4. **Reads stay local** (the SQLite projection) and are refreshed by frequent pulls. A read is at
   most one pull interval stale, and says so when the remote could not be reached.
5. **Online only.** If the sidecar remote cannot be reached, a shared write fails loudly instead of
   queueing for later. Reads keep working from the last pull.

Invariant this buys: **every event on the remote was valid against its exact predecessor, checked
by the build that pushed it.** A conforming build cannot produce damage.

## What this deletes (or shrinks)

| Today | Under this proposal |
|---|---|
| Causal vectors, `after`/`writerPrev` ordering, `docs/fork-repair.md` | Order is history position. The fields may stay for audit, but nothing depends on them. |
| Union merge of shards, `resolveConflictedShards`, `erasedByMerge`, `linesAt` | Gone. History is linear. |
| Damage-vs-race classification (`log-damage.ts` `causalContext` re-fold) | Gone. A refused event is never pushed. |
| Application-wide lockout (`lockout*.ts`, `damage-scan.ts`) | Shrinks to "the remote holds something this build cannot read". Sync refuses; see D5. |
| Write door folding at the writer (`emitEventChecked(…, fold)`) | Becomes step 2's replay validation. The same code, run at sync against the remote tip. |
| Concurrent holds: held withdrawals, standard ratify-vs-withdraw holds, `lateActs`, "settled" duplicates, `contest.ts` field contests | Mostly gone. The second writer is rejected and retries. Holds remain only as **product rules** about sequential disagreement between people (D6). |
| Two-machine-per-person races, re-fold loops for concurrent confirms | Gone, for the same reason. |

The distributed layer is roughly 3,000 lines (`eventlog.ts` 1,243, `sidecar.ts` 1,140,
`contest.ts` 122, the damage and lockout modules about 460). A large part of it becomes deletable,
plus race arms in the folds. How much exactly is for the plan to count, not this proposal. The **rules** survive unchanged in meaning. They become validation at the one point where
order is known: grants, the one closure bar, confirmer credit, the standard's law/evidence split,
questionnaires, the backlog.

## Open decisions (for the owner)

- **D1 — Does an act sync inline or in the background?** *Recommended: inline for single acts.* The
  op stages, syncs and returns the outcome, so a rejection reaches the caller while it is still
  there. That costs about one fetch and push per act; bulk operations batch into one sync. A
  background queue means an agent that has moved on never learns its act was rolled back.
- **D2 — Pull cadence for reads.** The web UI already polls every 15s. Should MCP reads pull when the
  last pull is older than N seconds, or only on explicit `sync`? What is N?
- **D3 — Retry policy on push contention.** How many fetch-replay-push attempts before reporting
  "busy, try again"? Is the queue per process or per machine (several MCP sessions and the web UI
  write through one sidecar clone)? A per-machine lock is needed if the queue is shared.
- **D4 — What "rolled back" shows.** For a person: the web page shows the refusal and the current
  state and keeps their draft. For an agent: an error naming what changed. Is anything logged about
  a rolled-back act, or does it just vanish? Today's "did not land" record would become unnecessary.
- **D5 — What remains of the lockout.** If the remote holds bytes or shapes this build cannot read
  (a broken or newer build pushed them), should sync refuse and reads carry on from the last good
  projection, or should everything lock as now? *Recommended: sync refuses, reads continue, and the
  hub shows a banner.* `docs/log-repair.md` still applies, with a linear-history rewrite.
- **D6 — Which holds are product rules.** Two people ruling differently *one after the other* is not
  a concurrency artifact. The comparison holds and confirm disputes may still be wanted. Every other
  hold (concurrent withdrawal, ratify-vs-withdraw race, "did not land") is expected to disappear.
  The list needs the owner's pass.
- **D7 — Migrating existing data.** `/working/codemap-sidecar` holds findings, bugs, docs and notes
  merged the old way, and no decision or repair events (measured 2026-09-28). A one-time
  linearisation: fold today's merged state and re-append it in fold order as one linear history? Or
  keep the old history and start linear from here?
- **D8 — The branch `questionnaires-and-repair-verification`.** Its product rules stay:
  - grants, the closure bar, confirmer credit;
  - questionnaires;
  - the standard's holds as product rules;
  - the web fixes.

  Its concurrency layer (1.2's causal classifier and lockout, 1.3's race holds, the 2.2 re-fold) is
  replaced, not fixed. The choice: rework on this branch, cut a new branch from it, or merge the
  product half first. It has not been pushed and `main` has not moved.
- **D9 — Offline agents.** Is "a shared write fails without the network" acceptable for every
  caller, including agents running in CI or on a laptop offline?
- **D10 — Git host limits.** Is a push per act acceptable against the git host (rate limits,
  latency), or must acts batch on a timer, which pushes D1 toward a background queue?

## Kill conditions — the aborted triage round

The review round that ended the pre-merge plan (record:
`.git/triage/2026-09-29-pre-merge-final-review/`, `findings.md` holds each finding's full text, and
`repro/` holds the reproduction scripts) is saved here as a **diagnosis kill condition** for this
rework. The rework has failed if any condition below still holds when it lands. Each needs a test
that shows it cannot happen, or a ruling that makes it moot.

| # | Finding (abbreviated) | Expected to be killed by | Check the rework must ship |
|---|---|---|---|
| K1 | A scan cached per process misses damage written later by another process (F1) | Validation at sync: nothing unvalidated reaches the remote; D5 | Hand-written garbage on the remote: sync refuses; no read serves it as clean |
| K2 | An ordinary cross-log race (law vs evidence) is classed as damage and locks the app (F2) | Linear order: the second writer is rejected at push | Replay `repro/cross-scope.mjs`'s two acts: one lands, one is rolled back, nothing locks |
| K3 | A correction can drop sites an intermediate correction added (F3) | **Not** a concurrency defect: a rule defect that survives the rework | Correction checked against its predecessor; `repro/r1.mjs` refused |
| K4 | An author's withdrawal raced by a confirm is silently refused (F4) | Linear order: whichever lands second is validated against the first and rolled back if invalid, with its creator told | `repro/s2.mjs` as two sequential syncs: the loser is rolled back and told, never silently refused |
| K5 | Withdrawing a disputing pick never releases the dispute (F5) | Partly: the re-fold goes, but the "withdrawn ruling" sweep on a confirm question is a rule question (D6) | `repro/s1.mjs`: withdrawing one side releases the dispute |
| K6 | With a confirm dispute, an agreeing reading still binds (F6) | **Not** concurrency: a rule defect that survives | A dispute never binds, whatever the reader said |
| K7 | A site bug's confirmation is frozen at filing, but closure checks the current one (F7) | **Not** concurrency: needs the "as of when" rule | Pick the rule; test a finding confirmed after its site bug was filed |
| K8 | A pull-request finding has no source judgement until landed (F8) | **Not** concurrency: needs a choice of which commit stands for an open pull request | Pick it; test an open verified repair can read as current proof |

K3, K6, K7 and K8 are **not** fixed by the new architecture, and saying they are would be the
failure this table exists to catch. They are carried into the rework as ordinary defects.

## Next

The owner marks up this document and answers D1–D10. A plan follows from the ratified version. No
code before that.
