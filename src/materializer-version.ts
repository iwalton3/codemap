/**
 * Bumped whenever the FOLD or the PROJECTION changes shape.
 *
 * Not the schema numbers. `ANCHOR_SCHEME` and `HASH_SCHEME` are deliberately absent
 * from the key: the projection copies anchor ids and accepted hashes verbatim out
 * of events and joins to the anchors table at READ time, so a scheme bump changes
 * the join's answer and cannot change a stored row. Re-folding after one produces
 * byte-identical output, so invalidating on it buys a rebuild and nothing else.
 *
 * That holds only while nothing derived from the anchors table is stored. See the
 * guard comment on the tables in `db.ts`.
 *
 * 2 -> 3: the folds changed what they PRODUCE, not merely how it is stored.
 * Contest suppression keys on the writer rather than the principal, so a scope
 * with one person's two machines in it folds to a different contested set; and
 * corroboration keys on (principal, model), so a scope where somebody ran two
 * models folds to a different verdict list. Rows folded under 2 are answers to a
 * question this build no longer asks.
 *
 * 3 -> 4: the causal vector is derived from the `writerPrev` chain instead of fold
 * order, and `contest.ts` lost its `sameWriter` short-circuit. A scope holding a
 * forked writer now folds to a DIFFERENT contested set — the disagreement between
 * two branches is raised where it used to be silently suppressed — and `scopeStatus`
 * gained a `chain-cycle` verdict. See docs/fork-repair.md.
 *
 * 4 -> 5: `foldDocs` drops analyzer-generated versions and `process`/`step` docs. A
 * docs scope that already carried any of them folds to a smaller map now.
 *
 * 5 -> 6: the docs projection writes `node_versions` instead of the `shared_doc*`
 * family. The SHAPE changed, not just the content — a cache written under 5 points at
 * tables the new reader does not read, so without this the fingerprint matches, the
 * reader returns an empty map, and the canonical fold never happens until the sidecar
 * itself changes.
 *
 * 6 -> 7: `foldDocs` stopped refusing `process`/`step` versions, because edges travel
 * now and a flow is a node whose `step_of` set is ordered. A RULE change with no shape
 * change, and it needs the bump for the same reason: the fingerprint is over the
 * SHARDS, which do not move when the fold's mind changes, so every existing store would
 * keep serving rows that were folded under the old rule and a flow published before the
 * bump would never appear. Found by walking a real two-clone flow — the events arrived,
 * the fold was fixed, and the reader still answered from a cache hit.
 *
 * 7 -> 8: findings moved from `shared_finding` to the canonical `findings` table. The
 * same SHAPE change as 5 -> 6 and it needs the bump for the same reason — a cache
 * written under 7 points at a table the new reader does not read, so the fingerprint
 * matches, the reader returns an empty map, and every shared finding a store already
 * held vanishes until that scope's shards happen to move. On a real universe that is
 * 26 findings across three pull requests disappearing on upgrade.
 *
 * 8 -> 9: walkthroughs moved from `shared_walkthrough` to the canonical `walkthroughs`
 * table. The same SHAPE change as 7 -> 8, needing the bump for the same reason, and it
 * is also what makes the migration free on the shared half: those rows are a projection
 * of the log, so invalidating the scope re-folds them into the new table and no row has
 * to be copied across.
 *
 * 9 -> 10: the agent ratchet keys on CONFIRMATION rather than on filing state, so
 * `mayTransition` and the new `mayRevise` accept events both folds previously dropped —
 * an agent closing or sharpening a finding nobody has stood behind. A RULE change with
 * no shape change, needing the bump for the reason 6 -> 7 gives: the fingerprint is over
 * the SHARDS, which do not move when the fold's mind changes, so every existing store
 * would keep serving rows folded under the old rule and the events it used to ignore
 * would stay ignored for ever.
 *
 * 11 -> 12 adds `errorIndependent` to every corroboration — a SHAPE change, and the
 * bump is what makes it visible. The field is derived in the fold from actors the log
 * already carries, so nothing migrates and no event changes; but the projection is
 * CACHED on the shards plus this number, and the shards do not move when a fold starts
 * emitting a new field. Without the bump every store that had already folded a scope
 * would serve corroborations without it, for ever, while new stores had it.
 *
 * 12 -> 13 adds the `standard/<universe>` scope — specs, operations, requirements,
 * acknowledgements, audits and problems. A NEW scope needs no bump of its own (nothing
 * has folded it before), but the fold also began deriving requirements from ratified
 * specs, and every store that had already cached any scope would keep serving under the
 * old number. Bumped for the reason 6 -> 7 gives: the fingerprint is over the shards,
 * which do not move when the fold's mind changes.
 *
 * 13 -> 14 adds six projected tables to that same scope — criteria, vacuity checks,
 * pointers, populations, scrubs and the scrub policy — and `foldStandard` now derives
 * criteria from ratified `add_criterion` operations. Exactly the 12 -> 13 case: the scope
 * is not new, so every store that has already folded it keeps its cached rows, and the
 * shards do not move when the fold's mind changes. Without the bump such a store serves a
 * standard with none of the new records in it FOR EVER — and worse than at 12 -> 13,
 * because `served()` now reports that answer as authoritative.
 *
 * 14 -> 15 folds the scrub INTO the audit: `scrubs` stops being projected (a scrub is an
 * audit with a covering trigger, so it was the same row twice) and `audit.recorded` now
 * carries the trigger and the pointer observations. Same rule again — the scope is not new
 * and the shards do not move when the fold's mind changes.
 */
// 15 -> 16: the standard folds from TWO scopes (law + evidence). A store that folded the
// old single scope holds rows whose input set is now different, and only the shards move a
// fingerprint — so without this bump it would serve that standard for ever and `served()`
// would call it authoritative. See `materialize.ts` 12 -> 13 for the same rule stated first.
//
// 16 -> 17: a DRAFT spec has a correction path, so `foldStandard` folds three new law
// events (`spec.revised`, `spec.operation.revised`, `spec.operation.removed`) and the
// `spec.withdrawn` gate now admits an agent taking back its own draft. Same rule as every
// entry above: the table set did not change and the shards do not move when the fold's mind
// does, so without the bump a store that has already folded this scope would serve the
// pre-correction standard for ever — showing an operation its author pulled as one the
// principal is being asked to adopt.
//
// 17 -> 18: `proposal_witnesses` is a new projected table, and `spec.ratified` now folds
// against it — a ratification whose ratifier had not signed the proposal's own text is
// applied by no clone. A store that has already folded this scope holds rows computed
// without either, and only the shards move a fingerprint.
//
// 18 -> 19: `foldFindings` folds three new events — `finding.backlogged`,
// `finding.backlogReleased`, `finding.rewitnessed` — so a `SharedFinding` now carries
// `backlogged` and `witnessAttached`. Same rule as every entry above, and this time the
// upgrade SKEW is the case it protects rather than a hypothetical: a teammate on the old
// build pulls a backlogged finding, folds it into nothing (unknown kinds are dropped, the
// correct degradation — verified), and then upgrades. Their shards have not moved since
// that fold, so without this bump the new build reads the cached rows and shows the
// finding as undisposed FOR EVER, while the log has said otherwise the whole time. The
// finding then reads as debt on one machine and as a decision on another, which is the
// disagreement the log exists to prevent.
//
// 19 also changes what an EXISTING event does: `finding.assigned` now clears the stale
// `outcome`, because a fresh ask means the previous answer no longer stands. That is a
// fold-mind change on an already-folded scope, which is its own reason for a bump (see
// 16 and 17, where the table set did not move either) — it does not need a SECOND number
// only because nothing outside this branch has ever folded at 19.
//
// The table set did not change — `backlogged` lives inside the `findings.body` JSON, not a
// column — so this is a refold and not a migration. Nothing in anyone's LOG is touched;
// only derived rows are discarded and rebuilt from events that were always there.
//
// 19 -> 20: `foldBugs` folds two new events — `bug.backlogged` and `bug.backlogReleased`
// — so a `SharedBug` now carries `backlogged`. Same rule and the same skew as 18 -> 19
// one record kind over: a teammate on the old build pulls a backlogged bug, folds it into
// nothing (unknown kinds are dropped, which is the correct degradation), and upgrades.
// Their shards have not moved since that fold, so without this bump the new build serves
// the cached rows and shows the bug as ordinary open work for ever, in the queue the
// deferral was supposed to take it out of — while the log has said otherwise the whole
// time. Teaching a fold a new EVENT is the same hazard as giving it a new table.
//
// The table set did not change again — `backlogged` lives inside the `bugs.body` JSON —
// so this is a refold, not a migration. Nobody's log is touched.
//
// 20 -> 21: no new event and no new table — both folds changed what an EXISTING event
// MEANS. `finding.backlogged` and `bug.backlogged` now store the DATE part of `until`,
// because `ISO_DATE` admits a trailing `T` and a full timestamp and every reader compares
// it lexicographically against a date, so anything past the tenth character slept a day
// past its own deadline. That is a fold-mind change on already-folded scopes, which is
// its own reason for a bump — see 16 and 17, where the table set did not move either.
// Without it a store that folded at 20 keeps serving the un-sliced value for ever,
// because only the shards move a fingerprint and they have not.
//
// 21 -> 22: a new scope kind (`reviews/`, table `review_link`) and a finding field
// (`branch`, on `finding.created`, which decides the row's `pr` key). A store that folded
// a branch scope at 21 holds rows keyed by the scope's hash, and only a refold fixes them.
//
// 22 -> 23: `witness.deleted` (a finding on code a change deletes). An older fold kept the
// field raw and read the witness as a body, so its rows say `landed` at filing; the same
// shards refold only if the version moves.
//
// 23 -> 24: a backlog on a deletion finding folds as a deletion backlog when an older
// build wrote it with a plain body witness (`finding.backlogged`). A fold-mind change on
// shards that do not move — and 24 rather than reusing 23, because stores have already
// folded under 23 with the build that introduced deletions.
//
// 24 -> 25: a bug citation carries `deleted` (a bug filed from a deletion finding once it
// landed). An older bugs fold dropped the field and read the citation as a body, so its
// rows call the deletion's own absence a fix.
//
// 25 -> 26: a finding field (`namedRef`, on `finding.created`) — the ref the filer named
// when it was explicitly origin's, which decides WHICH COMMIT the finding is witnessed and
// judged at (owner, Ruling 11). Exactly the reason `branch` bumped 21 -> 22: an older fold
// drops the field, so its rows resolve the branch local-first for ever, and only a refold
// fixes them because the shards have not moved.
//
// 26 -> 27: a new scope kind (`decisions/`, tables `decision_rounds`, `decision_records`,
// `logged_questions`) with four events — see shared-decisions.ts. The scope is new, so no
// store has folded it; the bump is for the EXISTING findings fold, which this change teaches
// to accept an agent's close that carries a person's answer to a decision — a fold-mind change
// on already-folded scopes whose shards have not moved.
//
// 27 -> 28: both folds change what EXISTING events derive (review round
// 2026-09-23-decision-rounds-2-review). Decisions: an answer binds only to its round and a
// question posted before it, typed replies are never parsed, precedence by own-ness then by
// when given, a replaced question's ruling holds; events without the new fields are dropped
// (H7.12 — they exist only in stores this unpushed branch wrote). Findings: `settledBy`, and a
// stamped close of a closed finding is a no-op. The same shards, a different fold.
//
// 28 -> 29: both folds again (review round 2026-09-23-decision-rounds-2-impl-review). Decisions:
// the standing answer is ranked from the set, not in recording order; close-on-answer and the
// "own" class are gone; a reading binds only from codemap's parse of the reader's hand-back
// (older readings are dropped, S0.7); confirm-this-reading calls bind. Findings: a
// decision-stamped close no longer opens the gate, and `settledBy` is gone (S0.6).
//
// 29 -> 30: the decisions fold (review round 2026-09-23-decision-rounds-2-impl-2-review). A new
// event, `decision.confirm.posted` — the confirm is a posted decision, no longer a logged call's
// text — and changed derivations under the existing ones: a decision's own posting time, only
// an accepted reading claims a slot, a reading carries its brief, an answer with no time is
// dropped. The reason 18 -> 19 gives: an old fold drops the new kind, and after an upgrade the
// shards have not moved.
//
// 30 -> 31: the decisions fold (review round 2026-09-23-decision-rounds-2-impl-2-codex), from the
// same events: a confirm records the pick that answered it and whether its words were never
// recorded (`confirms.picked`, `never`), no longer voids itself on a ref shared in the round as
// folded now, and a reading is refused on a ref its brief showed as shared and accepted when
// only its session side cannot bind. The same shards, a different fold — 18 -> 19's reason.
// 31 -> 32: decision admission, brief identity, invalid confirmations and human conflict
// resolution change projections of unchanged decision shards (2026-09-24 Codex round).
// 32 -> 33: round-five confirmation and conflict derivations change existing decision rows
// without moving their shards. Refold so old cached authority and holds are not served.
// 33 -> 34: changed responses cancel pending readings and confirmations on existing shards.
// 34 -> 35: explicit comparison nominations add holds from a new decision event.
// 35 → 36 refolds decision withdrawal authority and finding/bug reopen events.
// 37 → 38: questionnaire submissions are one new decision event; old cached folds would hide them.
// 38 → 39: comparison requests, judgments and resolutions change decision authority and add a projection table.
// 39 → 40: explicit withdrawal approval and revision presentation are new decision events.
// 42 → 43: list relay revisions now fold into per-item authority; cached decisions must refold.
// 43 → 44: the findings and bugs folds spend a ruling only when its application closes the issue;
// the decisions fold leaves out events it cannot read, and records them.
// 44 → 49: an unreleased branch (repair records and verification, acceptance, operation
// sign-off; renumbered by a rebase, so its own notes are in git history).
// 49 → 50 (2026-09-28 recovery, one bump for all of it): repair seals, sorter receipts and
// Codex receipts are gone and verification identity is the connection; the ruling capsule's
// key fields are one; revision receipts and withdrawal approvals are gone and withdrawal takes
// readers or a relayed answer; cross-clone keys order by code unit, not locale.
// 50 → 51 (2026-09-28 pre-merge review, one bump for phases 1–4): the decisions and standard
// folds HALT on damage instead of leaving an event out (`decision_skipped` is no longer
// written); a held withdrawal, a held spec or problem (`*.conflict.resolved`) and `lateActs`
// are new; the confirmer rules (`rulerOf`), two people's different confirms hold, a withdrawn
// Yes re-folds; an agent never closes a finding directly; repair verification drops
// participants, gains `invalid`, a refutation basis and per-site dispositions, and spends in
// the findings arm; a bug from a finding inherits its filer; an operation sign-off is kept by
// the text it signed; the ruling capsule is version 3. The shards do not move when a fold's
// mind changes, so 18 → 19's reason applies to all of it.
// 51 → 52: the graph fold no longer applies an analyzer node's wiring (owner, Q2: "Drop them"),
// merge-era events included.
// 52 → 53 (plan 2026-09-30-online-only-sync phase 6, one bump for phases 3–6): every fold orders
// by `seq` and credits reads from `after` alone; every refusal is classed, and a refused linear
// event is damage in every family; contests, holds, picks, forks, cycles and acknowledgements
// are gone (stale revisions, raced verdicts and unseen withdrawals refuse at replay); triage and
// wiring go by push order; K3/K5–K8. Same reason as 18 → 19: the shards do not move.
// 53 → 54 (review 2026-09-30-online-only-sync-review): one classification step before every
// fold — an unknown kind, an envelope field this build does not read, or a newer protocol or
// schema is NEWER and never folded; a refusal that depends on one (by `after`, too) is newer;
// a validator failure while a teammate's manifest records a higher version than this is newer
// until this build reaches it. Same reason as 18 → 19: the shards do not move.
export const MATERIALIZER_VERSION = 54;
