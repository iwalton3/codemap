# Sidecar event references — foreign keys and expected shapes

> **Kind: spec for plan phase 3** (`.git/plan/2026-09-30-online-only-sync/`, items 1.1 and 1.2).
> Which fields of which event kinds reference a SHARED item, and the shape each kind is expected
> in. Local-only targets (anchors, paths, commits, PR numbers, the `@work` index) are not
> foreign keys (owner, 2026-09-30). **Every file:line is against `64c27f8`**, the commit before
> the linear log; the fold logic cited did not move with it. §1.1b's ambiguous rows wait on the
> owner's rulings at the phase 1 gate. Measured against the live sidecar by
> `scripts/measure-references.mjs` (plan 1.3).
> **Phase 5 and 6 changed rows here (2026-09-30):** every hold, contest and pick it lists (the
> held withdrawal, `*.conflict.resolved`, field contests, triage contests, graph reordering) was
> deleted or became a refusal at replay. `docs/sidecar-architecture.md` is the current statement.

Notation: `E` = envelope field, `d.` = a path under `data`. "Checked" means the fold (or the
door) refuses or drops the event when the reference does not resolve. "Drop" = silently
skipped (`continue`/`break`, no refusal record); "Refuse" = pushed to a refusal list (decisions,
standard, repair records), which the write door turns into a write error.

---

## 0. How scope is determined (the shard directory FK targets live in)

A scope is a POSIX directory under the sidecar root; its shards are `<scope>/<writer>.ndjson`
(`shardFor`, eventlog.ts:176, HEAD; in-flight: `<scope>/events.ndjson`). A scope is any
directory holding `*.ndjson` (`scopesOnDisk`, eventlog.ts:670). A fold sees exactly the
events of the scope(s) it is handed; nothing in the envelope names the scope.

| Kind family | Scope | Function (file:line) | Notes |
|---|---|---|---|
| `finding.*`, `repair.*` | `findings/<universe>/pr-<n>` or `findings/<universe>/b-<sha256(universe\0branch\0name)[:40]>` | `findingScope` shared-findings.ts:448, key from `findingKeyScope` review-target.ts:96 via `scopeFor` sidecar-config.ts:169 | Every op passes the universe-qualified key (`prKey`, ops-shared.ts:115; ops/repairs.ts:102; ops/repair-verification.ts:163). A bare `findingScope(264)` is legal (tests). `<universe>` itself contains slashes. |
| `bug.*` | `bugs/<universe>` | `bugScope` shared-bugs.ts:184 | |
| `note.*` | `notes/<universe>/<bucket>`, bucket = `sha256(targetId)[:2]` | `noteScope` shared-notes.ts:94, `bucketFor` :91, emit :175-178 | Every event of one note must land in the bucket of the note's **target**, not of the note id. |
| `doc.*` | `docs/<universe>` | `docScope` shared-docs.ts:35 | |
| `triage.*` | `triage/<universe>` | `triageScope` shared-triage.ts:37 | |
| `graph.published` | `graph/<universe>` | `graphScope` shared-graph.ts:30 | |
| `review.linked` | `reviews/<universe>` | `reviewScope` shared-reviews.ts:21 | |
| `walkthrough.published` | `walkthrough/<universe>/pr-<n>` (same key as findings) | `walkthroughScope` shared-walkthrough.ts:29, called with `prKey` ops-shared.ts:2665 | |
| `decision.*` | `decisions/<universe>` | `decisionScope` shared-decisions.ts:36 | |
| Law: `spec.*`, `ack.granted`/`ack.released` **with basis `gap`** | `law/standard` (ONE per sidecar/workspace) | `LAW_SCOPE`/`lawScope` shared-standard.ts:71-72; routing standard-publish.ts:183-249 | Pre-split stores hold law events in `standard/<universe>`; the fold merges both (shared-standard.ts:61-70 comment). |
| Evidence: `audit.recorded`, `vacuity.checked`, `pointer.*`, `population.pinned`, `scrub.policy`, `problem.*`, `problem.conflict.resolved`, `ack.*` **with basis `debt`** | `standard/<universe>` | `standardScope` shared-standard.ts:57; `share(..., scope ?? standardScope)` standard-publish.ts:175 | **Ambiguity:** `isLawEvent` (shared-standard.ts:75) says every `ack.*` is law; actual routing is by basis (standard-publish.ts:238, 249). `isLawEvent` is imported (standard-publish.ts:34) but never called. |
| `scope.acknowledged` | any scope (the scope it acknowledges) | `acknowledgeScope` eventlog.ts:329-332 | Exempt from the "folded at the door" rule (eventlog.ts:407). |

**Which events a fold sees together** (this bounds what an FK check can resolve without
reading another scope):

- Findings, bugs, notes, docs, triage, graph, reviews, walkthrough, decisions: one scope
  (`projectionFor`, shared-projections.ts:824-833).
- Standard: law + ONE universe's evidence, merged and sorted (`cachedStandard`,
  standard-publish.ts:50-56). The **door** for an evidence write reads `law/standard`; for a
  law write it reads **every** `standard/*` scope (`standardDoor`, shared-standard.ts:116-120).
  So a law write is validated against all universes' evidence, a read folds against one.
- `foldFindings` also folds `repair.*` from the same scope (shared-findings.ts:1113-1126).

**Cross-scope ordering does not exist at HEAD.** `after` is the causal heads of the event's
*own scope* (eventlog.ts:410 `causalHeads(events)` over `readScope(scope)`), and
`causalContext` credits a writer with everything in scopes it never linked to
(eventlog.ts:1221). So "valid against the log before it" is well-defined within a scope and
**undefined across scopes** today. The in-flight `seq` field is the first global order.

---

## 1. Entity identity (how each shared target is identified)

| Entity | Identity | Minted by | Lives in |
|---|---|---|---|
| finding | `E.subject` of `finding.created` (`f_…` or caller id) | `finding.created` (first one wins, shared-findings.ts:710) | findings scope |
| finding epoch / closure | event id of the event that opened (`finding.created`, re-open `stateChanged`, `finding.reopened`) or closed it | those events (`openEpoch`, `closed.eventId`) | same findings scope |
| finding comment | event id of a `finding.commented` (thread entry id = `e.id`, :888) | `finding.commented` | same |
| repair claim | `${findingId}:original` (derived from `finding.created`, repair-records.ts:59) or `d.claims[].id` of `repair.claims-recorded` | derived / `repair.claims-recorded` | same findings scope |
| repair sort / evidence / verification request / run / arbitration / application | `d.id` (= `E.subject`, checked) of the corresponding `repair.*` / `finding.repairApplied` | those events | same findings scope |
| bug | `E.subject` of `bug.filed`; from a finding: `bugIdFor(findingId)` (shared-bugs.ts:195) or `bugIdFor(findingId@site)` (ops/bugs.ts:918) | `bug.filed` (first wins; later ones merge anchors, :284-291) | `bugs/<universe>` |
| bug comment / epoch / closure | as for findings | | same |
| note | `E.subject` of `note.created` | `note.created` | `notes/<u>/<bucketFor(targetId)>` |
| doc version | `d.version.versionId` of `doc.version` (unique per scope, first wins, shared-docs.ts:119) | `doc.version` | `docs/<u>` |
| logical node (shared) | `E.subject` of `doc.version` (= `d.version.nodeId`) | `doc.version` | `docs/<u>` — **only if published**; see §3 ambiguity |
| decision round | **event id** of `decision.round.posted` (shared-decisions.ts:927); fallback: `d.round.id` label if unique (`exactRound` :824-829) | `decision.round.posted` | `decisions/<u>` |
| decision (question) | `${roundEventId}:${raw.id}` (:942); fallback: `raw.id` label if unique (`exactDecision` :830-835). Confirm: event id of `decision.confirm.posted` (:978) | round/confirm posting | same |
| answer | event id of `decision.answer.recorded`/`.revised`; questionnaire answers `qans_`+sha256(eventId\0questionId)[:24] (:1065); fold-internal bound copies `${source}/${decisionId}` (:1587) | those events | same |
| logged question | event id of `decision.question.logged` (:866) | | same |
| withdrawal | event id of `decision.withdrawn` | | same |
| comparison request | `d.request.id` (= `E.subject`, checked :1869); judgment/resolution id = its event id (:1890, :1902) | | same |
| spec | `d.spec.id` of `spec.drafted` | `spec.drafted` | `law/standard` (or legacy `standard/<u>`) |
| operation | `d.operation.id` of `spec.operation` | `spec.operation` | law |
| requirement | **derived, no minting event**: `requirementIdFor(opId)` (schema.ts, `"r_"+sha256(opId)[:12]`) when a `spec.ratified` applies an `add_requirement` op (shared-standard.ts:1311-1318) | `spec.ratified` (applied, not `conflicted`) | law (fold state) |
| criterion | **derived**: `criterionIdFor(opId)` when `spec.ratified` applies an `add_criterion` op (:1290-1295) | `spec.ratified` | law (fold state) |
| acknowledgement | `d.ack.id` of `ack.granted` | | law (gap) / evidence (debt) |
| audit / pointer / population / problem | `d.audit.id` / `d.pointer.id` / `d.pin.id` / `d.problem.id` | `audit.recorded` / `pointer.declared` / `population.pinned` / `problem.raised` | `standard/<u>` |
| held verdict | event id of `spec.ratified` / `spec.withdrawn` / `problem.adjudicated` | | law / evidence |

---

## 1.1 Foreign-key table

Grouped by scope. "Same scope" = same shard directory as the referencing event. Every row
cites the fold/validator. Where a row says **op only**, the reference is validated by the
writing op against local state immediately before append, but a teammate's clone never runs
that check.

### Findings scope (`findings/<u>/…`)

| # | Kind | Field | Target | Identified by | Target lives in | Fold checks today? | Notes |
|---|---|---|---|---|---|---|---|
| 1 | finding.revised | E.subject | finding | finding id | same | Drop: shared-findings.ts:746 | |
| 2 | finding.corroborated | E.subject | finding | " | same | Drop :746 | |
| 3 | finding.remediated | E.subject | finding | " | same | Drop :746 | |
| 4 | finding.backlogged | E.subject | finding | " | same | Drop :746 | |
| 5 | finding.backlogReleased | E.subject | finding | " | same | Drop :746 | |
| 6 | finding.rewitnessed | E.subject | finding | " | same | Drop :746 | |
| 7 | finding.commented | E.subject | finding | " | same | Drop :746 | |
| 8 | finding.promoted | E.subject | finding | " | same | Drop :746 | |
| 9 | finding.posted | E.subject | finding | " | same | Drop :746 | |
| 10 | finding.upstreamed | E.subject | finding | " | same | Drop :746 | |
| 11 | finding.assigned | E.subject | finding | " | same | Drop :746 | |
| 12 | finding.outcome | E.subject | finding | " | same | Drop :746 | |
| 13 | finding.requested | E.subject | finding | " | same | Drop :746 | |
| 14 | finding.askDeclined | E.subject | finding | " | same | Drop :746 | |
| 15 | finding.stateChanged | E.subject | finding | " | same | Drop :746 | |
| 16 | finding.reopened | E.subject | finding | " | same | Drop :746 | |
| 17 | finding.repairApplied | E.subject | finding | " | same | Drop :746; also `d.findingId === subject` repair-verification.ts:126 | |
| 18 | finding.rulingApplied | E.subject | finding | " | same | Drop :746 | |
| 19 | finding.relocation | E.subject | finding | " | same | Drop :746 | |
| 20 | finding.promotedToBug | E.subject | finding | " | same | Drop :746 | |
| 21 | finding.commented | d.inReplyTo | finding comment | event id of a `finding.commented` | same | **No** (stored verbatim :888) | optional; may point to a comment on another finding or any id |
| 22 | finding.reopened | d.observedClosure | closure event of this finding | event id (`f.closed.eventId`) | same | Drop unless equal to current closure :1001 | required |
| 23 | finding.promotedToBug | d.bug | bug | bug id (normally `bugIdFor(subject)`) | **other scope** `bugs/<u>` (u = universe segment of this scope) | **No** (:1089-1098; latch only) | op writes it right after `fileBug` (ops/bugs.ts:872-888) |
| 24 | finding.repairApplied | d.requestId | repair verification request | `d.id` of `repair.verification-requested` | same | Refuse (repair fold) repair-verification.ts:143-144; findings arm drops unless the application folded :1011-1013 | |
| 25 | finding.repairApplied | d.findingId | finding | = E.subject | same | repair-verification.ts:126 | |
| 26 | finding.repairApplied | d.openEpoch | finding epoch | event id | same | vs request target :263; vs act-time and current finding shared-findings.ts:1014-1022 | |
| 27 | finding.rulingApplied | d.capsule.issue.ref | this finding (kind, universe, scope, id, review) | scope-qualified | self | ruling-application.ts:191-194: `ref.id === subject`, `ref.scope === expectedFindingScope(universe, review)` | **Not** checked that `ref.scope` is the scope the event is actually in |
| 28 | finding.rulingApplied | d.capsule.issue.openEpoch | finding epoch | event id | same | act-time snapshot shared-findings.ts:1046-1052; current :1057-1060 (recorded as refused attempt, not dropped) | |
| 29 | finding.rulingApplied | d.capsule.ruling.answerId | decision answer | answer id | **other log** `decisions/<u>` | **No** (fold is pure); **op only** ops/ruling-application.ts:79-85 | `c.key === applicationKey(answerId, issueKey)` checked ruling-application.ts:205 (consistency, not existence) |
| 30 | finding.rulingApplied | d.capsule.ruling.roundId | decision round | round event id | decisions/<u> | **No**; op fills from `d.round` (ops/ruling-application.ts:339) | |
| 31 | finding.rulingApplied | d.capsule.ruling.questionId | decision | folded decision id | decisions/<u> | **No**; op fills (:339) | |
| 32 | finding.rulingApplied | d.capsule.acceptance.findingId | finding | = E.subject | self | ruling-application.ts:175 | present iff outcome `accepted` |
| 33 | repair.claims-recorded | E.subject / d.findingId | finding | finding id | same | Refuse: parent claim must exist for that finding (repair-records.ts:66), which exists only after `finding.created` (:58) | |
| 34 | repair.claims-recorded | d.parentId | original repair claim | `${findingId}:original` | same | Refuse :66 | |
| 35 | repair.sort-recorded | d.coverage[].findingId | finding | finding id | same | Refuse via claims :52 | array |
| 36 | repair.sort-recorded | d.coverage[].claimIds[] | repair claim | claim id | same | Refuse :51-52 | array |
| 37 | repair.sort-recorded | d.prior | repair sort | sort id | same | Refuse :81 | optional (a correction) |
| 38 | repair.sort-recorded | d.ruling | decision answer | answer id | **other log** decisions/<u> | Presence only (:82; comment :125-128); **op only** ops/repairs.ts:138-144 (verified, standing) | optional; may legitimately become withdrawn later (the sort keeps citing it) |
| 39 | repair.evidence-recorded | d.sortId | repair sort | sort id | same | Refuse :88 | |
| 40 | repair.evidence-recorded | d.coverage[].findingId / .claimIds[] | finding / claim | ids | same | Refuse :87, :90 | must ⊆ sort's coverage |
| 41 | repair.evidence-recorded | d.rulingIds[] | decision answers | answer ids | **other log** decisions/<u> | nonempty+unique only :97-98; **op checks only later**, at `requestRepairVerification` (ops/repair-verification.ts:84-91), **not** at record time (ops/repairs.ts:164-170) | array, may be empty |
| 42 | repair.verification-requested | d.capsule.sort.id | repair sort (current, eligible, identical) | sort id | same | Refuse repair-verification.ts:272-274 | |
| 43 | repair.verification-requested | d.capsule.evidence.id | repair evidence | evidence id | same | Refuse :273-275 | |
| 44 | repair.verification-requested | d.capsule.claims[] | repair claims | (findingId, id) | same | Refuse: hash-equal to log's claims for covered findings :276-278 | |
| 45 | repair.verification-requested | d.capsule.targets[].findingId | finding | finding id | same | **No** (shape only :131); not required ⊆ sort coverage | op derives targets from the sort |
| 46 | repair.verification-requested | d.capsule.targets[].openEpoch | finding epoch | event id | same | **No** at request; checked at application (#26) | |
| 47 | repair.verification-requested | d.capsule.scope | this findings scope | scope string | self | **No** (non-empty only :130) | |
| 48 | repair.verification-requested | d.capsule.rulingContext (JSON `{rulings:[{id, decision, …}]}`) | decision answers / decisions | ids inside a JSON string | **other log** decisions/<u> | **No**; op builds (ops/repair-verification.ts:59-97); staleness recomputed on read (ops/repairs.ts:36-40) | |
| 49 | repair.verification-recorded | d.requestId | verification request | request id | same | Refuse :143-144 | |
| 50 | repair.verification-recorded | d.results[].(findingId, claimId) | claim in request coverage | pair | same (via request capsule) | Refuse `resultError` :67 | |
| 51 | repair.verification-recorded | d.results[].sites[].bug | bug | bug id | **other scope** `bugs/<u>` | non-empty only :85 (comment :78-80); **op only** `siteBugRefusal` ops/repair-verification.ts:272-293 (exists, open, filed from this finding, cites the site) | optional per site; must be **open** at closure — may legitimately close later (re-checked at application :403) |
| 52 | repair.verification-arbitrated | d.requestId | verification request | request id | same | Refuse :143 | |
| 53 | repair.verification-arbitrated | d.runIds[2] | verification runs | run ids | same | Refuse :163 | |
| 54 | repair.verification-arbitrated | d.addresses[].(findingId, claimId) | a disagreement between the two runs | pair | same | Refuse :166-169 | |

### Bugs scope (`bugs/<u>`)

| # | Kind | Field | Target | Identified by | Target lives in | Fold checks today? | Notes |
|---|---|---|---|---|---|---|---|
| 55-69 | bug.revised, bug.anchored, bug.unanchored, bug.corroborated, bug.backlogged, bug.backlogReleased, bug.commented, bug.promoted, bug.tracked, bug.assigned, bug.outcome, bug.requested, bug.reopened, bug.rulingApplied, bug.stateChanged (15 rows) | E.subject | bug | bug id | same | Drop: shared-bugs.ts:328 | |
| 70 | bug.filed | d.fromFinding | finding | finding id | **other scope**: `findingScope(findingKeyScope({universe}, d.fromPr))` | **No** (:316-321, stored as `from` only when both fields present) | op reads the finding first (`acceptInHome` ops/bugs.ts:832-888; `fileSiteBug` :911) |
| 71 | bug.filed | d.fromPr | review key of the finding's scope | PR number or `branch:<name>` (raw key, **not** universe-qualified) | used to locate #70 | **No** | A PR number is otherwise local-only; here it is half of a composite FK `(fromPr, fromFinding)` |
| 72 | bug.filed | d.inherits.author, d.inherits.corroboration[] | the finding's filer and corroborations | copies of the finding's folded `author`/`corroboration` | findings scope of #70 | Shape only (`inheritanceOf` :47-53); fold trusts it (:295-298; "R4's accepted gap" :603-604) | changes the bug's opening state and independence (:312) |
| 73 | bug.filed | E.subject | (derived from finding) | expected `bugIdFor(fromFinding)` or `bugIdFor(fromFinding@site)` | — | **No** | a second `bug.filed` of one id merges anchors, it does not refuse (:284-291) |
| 74 | bug.commented | d.inReplyTo | bug comment | event id | same | **No** (:437) | optional |
| 75 | bug.reopened | d.observedClosure | closure event | event id | same | Drop unless equal :490 | |
| 76 | bug.rulingApplied | d.capsule.issue.ref | this bug | `{kind:"bug", universe, scope:"bugs/<u>", id}` | self | ruling-application.ts:191-194 (form only, not vs actual scope) | |
| 77 | bug.rulingApplied | d.capsule.issue.openEpoch | bug epoch | event id | same | shared-bugs.ts:514-520, :525-530 (refused attempt) | |
| 78 | bug.rulingApplied | d.capsule.ruling.answerId | decision answer | answer id | **other log** decisions/<u> | **No**; op only ops/ruling-application.ts:79-87 (also requires the ruling to name this exact bug) | |
| 79 | bug.rulingApplied | d.capsule.ruling.roundId | decision round | round event id | decisions/<u> | **No** | |
| 80 | bug.rulingApplied | d.capsule.ruling.questionId | decision | decision id | decisions/<u> | **No** | |

### Notes scope (`notes/<u>/<bucket>`)

| # | Kind | Field | Target | Identified by | Target lives in | Fold checks today? | Notes |
|---|---|---|---|---|---|---|---|
| 81 | note.revised | E.subject | note | note id | same bucket | Drop shared-notes.ts:139 | |
| 82 | note.answered | E.subject | note | note id | same bucket | Drop :139 | |
| 83 | note.resolved | E.subject | note | note id | same bucket | Drop :139 | |
| 84 | note.created | d.targetId (targetKind `spec`) | spec | spec id | **other log** `law/standard` (or legacy `standard/<u>`) | **No** (kind list only :120); **op does not check either** (`commentOnProposal` ops-shared.ts:2065-2085) | a comment on a withdrawn/ratified spec is legitimate discourse |
| 85 | note.created | d.targetId (targetKind `operation`) | operation | operation id | **other log** law | **No**; op does not check | a pulled (removed) operation is a legitimate target |

### Docs scope (`docs/<u>`)

| # | Kind | Field | Target | Identified by | Target lives in | Fold checks today? | Notes |
|---|---|---|---|---|---|---|---|
| 86 | doc.accepted | d.versionId | doc version | versionId, and its `nodeId` must equal E.subject | same | Not applied, but **retained** in `unmatched` (`no-version`/`no-citation`), never refused: shared-docs.ts:156-168 | retention is deliberate (cross-build anchor ids) |
| 87 | doc.accepted | E.subject | logical node (shared doc) | node id = subject of a `doc.version` | same | via #86 (:157) | |

### Decisions scope (`decisions/<u>`) — every kind here is folded at the write door (eventlog.ts:385, 407-408; `decisionsDoor` shared-decisions.ts:2512)

| # | Kind | Field | Target | Identified by | Target lives in | Fold checks today? | Notes |
|---|---|---|---|---|---|---|---|
| 88 | decision.round.posted | d.decisions[].options[].effects[].findings[] | finding | **bare** finding id (no scope) | **other scope**: any `findings/<u>/…` of the universe, resolved by unique id | **No** (non-empty strings, named in the question text: `checkDecision` :341-347, :372); **op only** ops/decisions.ts:109-116 (exists in local projection, unambiguous across reviews, published) | unqualified by design; the op refuses an id that is in >1 review |
| 89 | decision.round.posted | d.decisions[].options[].effects[].issues[] | finding or bug | `CanonicalIssueReference {kind, universe, scope, id, review?}` | **other scope** `findings/<u>/…` or `bugs/<u>` | Form only (`validIssue` :257-263: bug scope is `bugs/<u>`, finding scope starts `findings/<u>/`); **op only** `resolveDecisionIssue` ops/decisions.ts:117-121 | |
| 90 | decision.round.posted | d.decisions[].follows (legacy `supersedes`) | decision | decision id or label | same | **No** (:947); op ops/decisions.ts:122-125 | context only |
| 91 | decision.round.posted | d.decisions[].origin.answer | answer | answer id | same | **No**: `followUps` silently skipped when absent (:1500-1501); **no op check found** | optional |
| 92 | decision.round.posted | d.decisions[].resolves.answers[2] | answers (two different people's verified rulings, words shown in question) | answer ids | same | Refuse posting event :1439-1446 (`resolutionInvalid`) | |
| 93 | decision.confirm.posted | d.round | round | round event id or unique label | same | Refuse :973-974 | |
| 94 | decision.confirm.posted | d.decision.confirms.answer | answer (in the same round, not on a confirm) | answer id | same | Refuse (marked invalid, kept visible) `confirmRefusal` :478-480, refused at :1117-1120 | |
| 95 | decision.confirm.posted | d.decision.confirms.readings[][].decision | decision (option must exist) | folded decision id | same | Refuse :483-484; same round via `bindRefusal` :1523 | |
| 96 | decision.question.logged | d.rounds[] | rounds | round event id or label | same | **No** existence check (non-empty list, log-shape.ts:49); used as a filter | |
| 97 | decision.question.logged | d.bound{questionText → round} | round | round id/label | same | Filtered to `rounds` (:865); existence not checked; consumed by `resolve` :1604-1609 | |
| 98 | decision.answer.recorded | d.decision | decision (posted before this event) | decision id or unique label | same | Refuse :875-877 | subject is conventionally the same value (not checked) |
| 99 | decision.answer.recorded | d.via.question (via.kind `question`) | logged question | event id of `decision.question.logged` | same | Refuse (resolve → null → :882-883) :1604-1609 | |
| 100 | decision.answer.recorded | d.via.round (via.kind `message`) | round | round event id; must equal the decision's round | same | Refuse :1655 | |
| 101 | decision.answer.revised | d.decision | decision | id or label | same | Refuse :993 → :875-877 | |
| 102 | decision.answer.revised | d.revision.of[] | answers on the same decision | answer ids | same | Refuse (answer cancelled + refusal) :1206, :1221-1241 | |
| 103 | decision.answer.revised | d.revision.findings[] | findings the decision names (or the decision id itself for a `words` decision) | bare ids | same (named set) | Refuse :1214-1215 | |
| 104 | decision.answer.revised | d.revision.issues[] | issues the decision names | canonical refs | same (named set) | Refuse :1216 | |
| 105 | decision.answer.revised | d.revision.resolves.answers[2] | the decision's `resolves.answers` | answer ids | same | Refuse :1210-1212 | |
| 106 | decision.answer.revised | d.revision.resolves.priorResolution | answer being revised | answer id | same | Refuse :1211 | |
| 107 | decision.questionnaire.submitted | d.round (and E.subject = questionnaire id or round id) | round with a questionnaire | round id/label | same | Refuse :1019-1022 | |
| 108 | decision.questionnaire.submitted | d.staged.questionnaireId | the round's questionnaire | questionnaire id | same | Refuse via `stageSubmission` :1024-1029 | |
| 109 | decision.questionnaire.submitted | d.staged.answers[].questionId | decision in that round, posted before | decision label | same | Refuse :1033-1034, :1061 | |
| 110 | decision.comparison.nominated | d.answers[2] | two different people's verified original answers | answer ids | same | Refuse :1486-1488 | |
| 111 | decision.comparison.nominated | d.findings[] | findings named by those decisions | bare ids | same (named set) | Refuse :1491 | |
| 112 | decision.comparison.nominated | d.issues[] | issues named by those decisions | canonical refs | same (named set) | Refuse :1492 | |
| 113 | decision.comparison.requested | d.request.left/right.answerId | answers (exact version) | answer ids | same | Refuse :1882-1883 (`comparisonRequestFor` :1817-1824) | |
| 114 | decision.comparison.requested | d.request.left/right.questionId | decisions | decision ids | same | Refuse :1871-1874 | |
| 115 | decision.comparison.requested | d.request.issues[] (finding / bug / decision) | issues named by the two decisions; a `decision` issue must be this scope and the (single) decision | canonical refs | same / named set | Refuse :1873-1880 | |
| 116 | decision.comparison.judged | d.judgment.requestId (= E.subject) | comparison request | request id | same | Refuse :1891-1898 | |
| 117 | decision.comparison.resolved | d.resolution.requestId (= E.subject) | comparison request | request id | same | Refuse :1903-1920 | |
| 118 | decision.comparison.resolved | d.resolution.preserve | one of the request's two answers | answer id | same | **Not a fold refusal**: recorded refused in projection history, decision-comparison.ts:129 | |
| 119 | decision.comparison.resolved | d.resolution.revises, d.resolution.shownResolution.id | prior resolution by the same principal | event id of a `decision.comparison.resolved` | same | **Not a fold refusal**: projection history decision-comparison.ts:145-157 | optional |
| 120 | decision.withdrawn | d.decision (= E.subject) | decision | **exact** folded id (no label fallback, `decisions.get`) | same | Refuse :1304-1305 | |
| 121 | decision.withdrawn | d.answer | verified source answer on that decision | answer id | same | Refuse (recorded `refused`) :1316 | optional (absent = withdraw the question) |
| 122 | decision.withdrawn | d.knownAnswers[] | answers | answer ids | same | **No** existence check; unknown ids simply match nothing (:1310, :1336-1339) | a knowledge claim, not a pointer |
| 123 | decision.withdrawn | d.relay | the relayed withdrawal decision | decision id | same | Refuse only for an agent withdrawing a named answer :1320-1327; otherwise stored | |
| 124 | decision.conflict.resolved | d.decision (= E.subject) | decision | decision id | same | Refuse :1362-1363 | |
| 125 | decision.conflict.resolved | d.withdrawal | a held (conflict) withdrawal on that decision | event id of `decision.withdrawn` | same | Refuse :1362-1363 | |
| 126 | decision.conflict.resolved | d.keep | `"withdrawal"` or an answer in the conflict set | answer id | same | Refuse :1367 | a kept answer that later goes is moot (:1383) |
| 127 | decision.reading.recorded | d.answer | free (unbound) answer | answer id | same | Refuse :1138-1139, :1142 | |
| 128 | decision.reading.recorded | d.reader.verdict[].decision | decisions in the answer's round | decision ids | same | Refuse `readingRefusal`→`bindRefusal` :1523 | |
| 129 | decision.reading.recorded | d.session.maps[].decision | decisions | decision ids | same | Refuse only when the reader said `unclear` (:1562-1566); otherwise compared, not resolved | |

### Standard — law (`law/standard`) and evidence (`standard/<u>`); folded at the door (eventlog.ts:385; `standardDoor` shared-standard.ts:116)

| # | Kind | Field | Target | Identified by | Target lives in | Fold checks today? | Notes |
|---|---|---|---|---|---|---|---|
| 130 | spec.operation | d.operation.specId | spec (draft) | spec id | same (law) | Refuse if known and not draft; **kept if the spec is unknown** (:497-499, comment :494-496) | subject is conventionally = specId, **not checked** |
| 131 | spec.operation | d.operation.requirementId (amend_statement, retire_requirement; also add_criterion without target) | requirement | derived id | law fold state | Not at `spec.operation`; at ratification `applyOperation` :1335-1336 → spec `conflicted` | a retired target → stale (:682) |
| 132 | spec.operation | d.operation.context.requirementId | requirement (statement must match) | derived id | law | At ratification :681-682 → `conflicted` | |
| 133 | spec.operation | d.operation.targetOperationId | `add_requirement` op in the same ratification | op id | law | At ratification :1280 (`siblings`); at removal :548-551 | |
| 134 | spec.revised | d.spec.id (= E.subject) | spec (draft) | spec id | law | Refuse :518-520 | |
| 135 | spec.operation.revised | d.operation.id | operation (draft spec, not removed, same kind) | op id | law | Refuse :535-543, :560 | new content's requirementId/targetOperationId re-checked only at ratification (#131-133) |
| 136 | spec.operation.removed | d.operation.id | operation | op id | law | Refuse :535-551 | |
| 137 | spec.operation-signoff-applied | E.subject | operation (draft, live) | op id | law | Refuse :589-591 | |
| 138 | spec.operation-signoff-applied | d.capsule.operationId / .specId | operation / spec | ids | law | Refuse operation-signoff.ts:33 | |
| 139 | spec.operation-signoff-applied | d.capsule.ruling.answerId | decision answer (verified, current) | answer id | **other log** `decisions/<ruling.universe>` | **No** (fold uses `current:false`, shared-standard.ts:596); **op only** ops/operation-signoff.ts:70-80 | law is workspace-wide, so the target universe is whichever wrote the ruling |
| 140 | spec.operation-signoff-applied | d.capsule.ruling.decisionId | decision | decision id | decisions/<u> | **No** | |
| 141 | spec.operation-signoff-applied | d.capsule.ruling.sourceScope | decisions scope | `decisions/<universe>` | — | Form only operation-signoff.ts:43 | |
| 142 | spec.reviewed | d.witness.specId | spec (draft) | spec id | law | Refuse :607-611 | E.subject conventionally = specId, **not checked** |
| 143 | spec.reviewed | d.witness.operationId | operation live in that spec | op id | law | Refuse :620-623 | optional (absent = framing sign-off) |
| 144 | spec.ratified | E.subject | spec (draft, not held) | spec id | law | Refuse :630-644 | |
| 145 | spec.ratified | d.operations[] | operations | op ids | law | Missing/removed → `conflicted` :662-665, :716-719 | **does not filter `op.specId === sp.id`** (:663); a foreign op is caught only indirectly by `reviewGap` (unread → conflicted) |
| 146 | spec.ratified | keys of d.witnesses{opId → anchors} | operations | op ids | law | **No** (extra keys ignored; read as `witnesses[op.id]` :712) | |
| 147 | spec.withdrawn | E.subject | spec | spec id | law | Refuse :775-784 | |
| 148 | spec.conflict.resolved | E.subject + d.keep | a held ratify/withdraw verdict on that spec | event id | law | Refuse :436 | |
| 149 | problem.conflict.resolved | E.subject + d.keep | a held adjudication on that problem | event id | evidence | Refuse :436 | |
| 150 | ack.granted | d.ack.operationId (basis `gap`) | `add_requirement` op in a draft spec | op id | law | Refuse :899-903 | |
| 151 | ack.granted | d.ack.requirementId (basis `debt`) | requirement | derived id | **law**, referenced from evidence | **No**; op only acknowledgements.ts:188 | |
| 152 | ack.released | E.subject | acknowledgement (not released) | ack id | law (gap) / evidence (debt) | Refuse :914-915 | released into the same half as the grant (standard-publish.ts:241-249) |
| 153 | audit.recorded | d.audit.requirementId | requirement | derived id | **law**, from evidence | **No** existence check (used only to filter pointers :951-952); op only audits.ts:160 | E.subject conventionally = requirementId, **not checked**. A covering audit of a nonexistent rule with no pointers passes. |
| 154 | audit.recorded | d.audit.observations[].pointerId | pointer active on the rule | pointer id | evidence (same universe) | Refuse :950-957 | |
| 155 | vacuity.checked | d.check.criterionId | criterion | derived id | **law**, from evidence | Refuse :970-971 | E.subject conventionally = criterionId, not checked |
| 156 | pointer.declared | d.pointer.requirementId | requirement | derived id | law | **No** (presence :990); op only pointers.ts:342 | |
| 157 | pointer.declared | d.pointer.criterionId | criterion | derived id | law | **No**; op only pointers.ts:351 | optional |
| 158 | pointer.declared | d.pointer.operationId (state `pending`) | live `add_criterion` op; its spec's state decides | op id | law | Refuse :1015-1022 | a withdrawn spec → folds `retired`, not refused (:1051-1055) |
| 159 | pointer.restated | E.subject | pointer (active) | pointer id | evidence | Refuse :1063-1064 | |
| 160 | pointer.retired | E.subject | pointer (not retired) | pointer id | evidence | Refuse :1079-1080 | |
| 161 | population.pinned | d.pin.requirementId | requirement | derived id | law | **No** (presence :1093); op only population.ts:217, :310 | |
| 162 | population.pinned | d.supersedes | population | pin id | evidence | **Ignored**: the fold derives the prior pin itself (:1109-1117) | optional |
| 163 | problem.raised | d.problem.requirementId | requirement | derived id | law | **No** (presence :1146) | |
| 164 | problem.raised | d.problem.auditId | audit | audit id | evidence (same universe) | **No** (presence :1146); op only problems.ts:104 | |
| 165 | problem.adjudicated | E.subject | problem (open, not held) | problem id | evidence | Refuse :1160-1171 | |

**Row count: 165 FK (kind, field) rows** (rows 55-69 are 15 rows written as one line).

- **Checked by the fold in some form: 124** — drop, refuse, `conflicted`, or retained-but-unapplied.
  Three caveats inside that number: rows 131-133 are checked **late** (at the ratification that
  applies the operation, not at the `spec.operation` event); rows 118-119 are checked only as
  **projection history**, which the write door never sees; row 86 is **retained** as
  `unmatched`, not refused.
- **Not checked by the fold: 41** — rows 21, 23, 29-31, 38, 41, 45-48, 51, 70-74, 78-80, 84-85,
  88-91, 96-97, 122, 139-141, 146, 151, 153, 156-157, 161-164. (Rows 38, 51, 89, 141 have a
  presence/form check but no existence check.)
  - **27 cross-log or cross-scope**: 23, 29-31, 38, 41, 48, 51, 70-72, 78-80, 84-85, 88-89,
    139-141, 151, 153, 156-157, 161, 163. Most of these are validated by the writing **op**
    against local state; a teammate's clone never re-checks them ("R4's accepted gap").
  - **14 same-scope**: 21, 45, 46, 47, 73, 74, 90, 91, 96, 97, 122, 146, 162, 164.

---

## 1.1b Ambiguous candidates — shared or local? (decide before the FK spec)

These reference a **logical node id**, or free-form labels. A node is shared only if some
`doc.version` in `docs/<u>` has it as subject; unpublished human nodes and analyzer nodes
(`generatedBy`, never published — shared-docs.ts:113; ops-shared.ts:2394-2398) exist only in
the local store under the same id space. So the same field is sometimes a shared FK and
sometimes a local reference, and nothing in the event says which.

| # | Kind | Field | Why ambiguous | Fold today |
|---|---|---|---|---|
| A1 | finding.created | d.targetId when d.targetKind = `node` | node may be unpublished/local | no check (:713-714) |
| A2 | note.created | d.targetId when targetKind = `node` | same | no check (:120) |
| A3 | triage.asserted | d.targetId (= E.subject tail) when targetKind = `node` | same | subject agreement only shared-triage.ts:258 |
| A4 | triage.cleared | d.targetId when targetKind = `node` | same | same |
| A5 | graph.published | d.nodeId (= E.subject) | the source node; only human nodes' edges travel, but the node itself may be unpublished | subject agreement only shared-graph.ts:64 |
| A6 | graph.published | d.edges[].to | frequently an **analyzer** node (e.g. an aggregate) that never travels; `calls_api` edges carry a cross-universe qualified `to` (`api::handler`, schema.ts:368) | none (edge dropped only if malformed or `generatedBy`, :69-74) |
| A7 | pointer.declared | d.pointer.target.id when target.kind = `node` | same as A1 | none |
| A8 | repair.sort-recorded | d.restsOn[], d.release.rulings[] | a `decision:<id>` entry names a decision in `decisions/<u>`, and a release ruling an answer to it (owner, D2); other entries are free labels (e2e uses `"req-credit"`) with no target | `repairSortReferences` (ruling-references.ts), door and read |
| A9 | round.posted / answer.* | E.subject vs `d.decision` / `d.round.id` | subject is a label, not an id, for round/confirm/answer/reading/question kinds; nothing checks it | not checked |

Also note-worthy but **not event-log references** (excluded, but a reviewer may expect them):
`audit.recorded d.audit.promotedFrom` names a *provisional* audit, which travels as a
commit-discovered document and is never an event (standard-publish.ts:251-267; schema.ts:1620-1627).
`audit.recorded d.audit.evidence.consulted[]` is free text ("documentation you read", mcp.ts:2180).

---

## 1.1c Local-only reference fields, excluded, per kind

Local-only per the brief: anchor ids / witnesses (`{anchorId, bodyHash, deleted?}`), `@work`
rows, file paths, symbol paths, commit SHAs, PR numbers, git refs/branches. Also excluded here
as not-shared: transcript/session/tool-use ids, reader/agent receipts (machine-local reader
receipt store), external tracker refs, content hashes (they bind content, not an entity).

| Kind | Excluded local-only fields |
|---|---|
| finding.created | targetId when targetKind=`anchor`; witness.*; sourceRef; branch; namedRef; line; filedBy/filedAt (migration provenance) |
| finding.revised | now.sourceRef, now.line |
| finding.corroborated | ref (a commit — `ground.head`, ops-shared.ts:554) |
| finding.remediated | ref (commit/PR ref) |
| finding.backlogged | witness.*; system/key/url (external ticket) |
| finding.rewitnessed | witness.* (must equal target anchor, checked :873) |
| finding.posted / upstreamed | system/key/url (external) |
| finding.outcome | files[] (paths) |
| finding.relocation | to (an anchor id) |
| finding.repairApplied | identity.{principal,session,harness,child}; capsuleHash, claimHash, contextHash (hashes) |
| finding.rulingApplied | capsule.evidence.readers[]/arbitrator (reader receipts: id, request, launch, session); capsule.evidence.directMention (a displayed URL/id — compared to the display, ruling-application.ts:113-141); capsule.ruling.authority.sourceFingerprint; hashes. Intra-event: arbitrator.readerReceipts ⊆ readers[].id (:230) |
| repair.claims-recorded | — |
| repair.sort-recorded | sites[] (file paths); predicate; source; assessments[].identity/receipt; arbitration.identity/receipt. Intra-event: arbitration.addresses ⊆ disagreements[].id (:150) |
| repair.evidence-recorded | witnessCommit/baseCommit/fixCommit; reproducer[]/regression[] (commands, commits); inspected[].commit/source; patternEnumeration (sites); attribution[].file/hunk. Intra-event: attribution[].claimIds ⊆ coverage (:99) |
| repair.verification-requested | capsule.code.* (commits, touched paths/blobs); capsule.orchestrator (identity) |
| repair.verification-recorded | identity; results[].executions/inspected (commits); results[].sites[].site (path) |
| repair.verification-arbitrated | identity |
| bug.filed | anchors[]; createdCommit; filedAt |
| bug.anchored / bug.backlogged | anchors[] (backlog witnesses must be the bug's own live citations, checked :408-409); system/key/url |
| bug.unanchored | anchorId |
| bug.tracked | system/key/url |
| bug.outcome | files[] |
| bug.rulingApplied | as finding.rulingApplied |
| note.created | targetId when targetKind=`anchor`; line |
| note.revised | now.line |
| doc.version | version.citations[].anchorId/acceptedHashes; createdCommit; createdBranch. Intra-event: version.nodeId must equal E.subject (:90) |
| doc.accepted | anchorId; bodyHash |
| triage.asserted | targetId when targetKind=`anchor`; witnesses[]; assertedCommit |
| triage.cleared | targetId when `anchor` |
| graph.published | commit |
| review.linked | pr (PR number); branch |
| walkthrough.published | walkthrough.pr, walkthrough.head (commit), chapters[].blocks[].anchorId, chapters[].witnesses[]; E.subject `pr-<n>` |
| decision.round.posted | round.pr; round.branch; round.prevalidated.{record,sortedBy} (skill record — new posts refuse it, ops/decisions.ts:136); round.universe (a name) |
| decision.question.logged | session; toolUseId (= E.subject); answeredAt; transcript |
| decision.answer.recorded | via.session/entryId/at/text (message); relayedBy (the verified message's session, set by `relay_answer`; no longer an input); hash (content hash of the decision — **checked** equal to the decision's hash :878) |
| decision.answer.revised | via.proof.{session,toolUseId,entryId,answeredAt,question,answer}; list.* (questionnaire list items, intra-decision) |
| decision.questionnaire.submitted | staged.attemptId, payloadHash, listApprovals |
| decision.comparison.requested | request.contextHash; left/right.version (response hash — checked current) |
| decision.comparison.judged | proof.{receipt, agent, session, launch, call, toolUseId}; judgment.reader.* |
| decision.comparison.resolved | proof.*; resolution.human.{session, request, receipt, shownHash} |
| decision.withdrawn | review.readers[]/arbitrator (reader receipts) |
| decision.reading.recorded | reader.{agent, launchedAt, brief, manifest, verified.*}; asks |
| spec.drafted / spec.revised | — (spec.author is an actor) |
| spec.operation(.revised/.removed) | section/fromSection/toSection (standard's own section paths, not code) |
| spec.operation-signoff-applied | capsule.reader.* (receipt), capsule.executor (actor), hashes |
| spec.reviewed | witness.content (text hash map) |
| spec.ratified | values of witnesses{} (anchor witnesses) |
| ack.granted | ack.workItem (external ticket) |
| audit.recorded | audit.witnesses[]; evidence.read[] (anchors), evidence.ran[] (commands), evidence.consulted[] (free text); commit; branch; promotedFrom (non-log provisional document); universe (name) |
| vacuity.checked | check.witnesses[] |
| pointer.declared | target.id when kind=`anchor`; witnesses[]; universe (name) |
| pointer.restated | witnesses[] |
| population.pinned | pin.lint[] (anchors), pin.members[].id (lint output), pin.witnesses[], commit, branch |
| scrub.policy | E.subject is the scope string (= its own scope) |
| scope.acknowledged | acknowledges[].digest (sha256 of a diagnostic's evidence in this scope; eventlog.ts:821-825) |

**Kinds with no shared references at all** (neither envelope nor data):
`finding.created` (unless A1 is ruled shared), `doc.version`, `review.linked`,
`walkthrough.published`, `spec.drafted`, `scrub.policy`, `scope.acknowledged`, and the three
retired kinds `repair.participant-recorded`, `repair.verification-producer`,
`repair.verification-sealed` — **10 kinds**.

Kinds whose only candidate references are the ambiguous node ids (§1.1b):
`triage.asserted`, `triage.cleared`, `graph.published`.

Every other kind has at least one definite FK row above (`note.created` only for
`spec`/`operation` targets, rows 84-85; `decision.question.logged` only the soft same-scope
round references, rows 96-97; `decision.round.posted` rows 88-92).

---

## 1.2 Expected-shape table

### 1.2.0 The envelope (every kind, every scope)

`wellFormed` (eventlog.ts:495-513, HEAD) requires: `id` non-empty string and ≠ `"GENESIS"`;
`kind` string; `subject` string; `actor.principal` non-blank string; `writer` non-empty
string; `writerPrev` non-empty string; `after` array; `sidecarProtocol` number; `eventSchema`
number. `at` and `data` are **not** required. A line that parses but fails `wellFormed` is
**dropped silently and is not damage** (splitShard eventlog.ts:615; comment :579-581) — it is
treated as an event from a client this build does not understand. An event with
`sidecarProtocol > 1` or `eventSchema > 1` **blocks the scope** (`protocol`, eventlog.ts:902-913).
In-flight (working tree, not HEAD): optional `seq: number`, protocol 2.

`log-shape.ts` additionally requires `subject` be a string for the kinds it covers
(log-shape.ts:130). It never requires a field be **absent**, so unknown extra fields pass
(log-shape.ts:6-8).

### 1.2.1 Coverage of `log-shape.ts`

`shapeCheckFor(scope)` (log-shape.ts:141-145) returns `DECISION_SHAPES` for `decisions/*`,
`STANDARD_SHAPES` for `standard/*` and `law/*`, and **nothing for every other scope**.
It covers all 13 decisions kinds and all 22 standard kinds. It covers **none** of: the 21
`finding.*`, 6 live `repair.*`, 16 `bug.*`, 4 `note.*`, 2 `doc.*`, 2 `triage.*`,
`graph.published`, `review.linked`, `walkthrough.published`, `scope.acknowledged` (skipped
as unknown even inside decisions/standard scopes).

### 1.2.2 Per-kind shape

`S` = shape stated in log-shape.ts (line). `F` = where the fold reads it. `?` = optional.
`str` = non-blank string unless noted. Subject rule = what the envelope subject must be.

#### Findings scope (no log-shape coverage)

| Kind | Subject | data shape (as the fold reads it) | F |
|---|---|---|---|
| finding.created | new finding id (first wins) | text str; targetKind `anchor`\|`node`; targetId str; comment? str; severity? str (**not** validated against the enum here); category? str; line? number; witness? {anchorId str, bodyHash str, deleted? exactly `true`}; sourceRef? branch? namedRef? filedBy? filedAt? str | shared-findings.ts:709-744; witnessOf :658-663; repair claim mint repair-records.ts:58-61 |
| finding.revised | finding id | now: {text?, comment?, severity?, category?, sourceRef? str; line? number}; was: object. Agent may revise only while nobody stood behind it | :749-766 |
| finding.corroborated | finding id | verdict ∈ confirm\|partial\|refute\|unsure; rationale? str; ref? str | :768-786 |
| finding.remediated | finding id | state ∈ outstanding\|fixed-on-branch\|fixed-on-default\|deferred\|wont-fix (:189); detail? ref? str | :788-799 |
| finding.backlogged | finding id | until str matching `ISO_DATE` (sliced to 10 chars); reason str; witness?; system?/key?/url? str. Agent actor → dropped | :801-833 |
| finding.backlogReleased | finding id | reason str. Agent → dropped | :835-847 |
| finding.rewitnessed | finding id | witness {anchorId, bodyHash, deleted?} | :849-883 |
| finding.commented | finding id | body str; inReplyTo? str | :885-890 |
| finding.promoted | finding id | none | :892-895 |
| finding.posted / finding.upstreamed | finding id | system? key? url? str | :897-908 |
| finding.assigned | finding id | kind ∈ investigate\|fix\|answer; note? str | :910-926 |
| finding.outcome | finding id | result ∈ fixed\|answered\|declined; detail? str; files? array (elements unchecked) | :928-942 |
| finding.requested | finding id | ask ∈ promote\|invalidate\|refute\|resolve\|withdraw\|reopen (:108); rationale? str | :944-955 |
| finding.askDeclined | finding id | reason str. Agent → dropped | :957-968 |
| finding.stateChanged | finding id | state ∈ issued\|created\|invalid\|refuted\|resolved\|withdrawn\|accepted; reason? str; ratchet `mayTransitionFinding` | :970-996 |
| finding.reopened | finding id | state ∈ created\|issued; observedClosure str; reason? | :998-1007 |
| finding.repairApplied | finding id (= d.findingId) | `RepairVerificationApplication`: id, requestId, capsuleHash, findingId, openEpoch, claimHash, contextHash, reason str; outcome ∈ fixed\|factually-refuted\|invalid; identity {principal, session, harness `mcp` (no child) \| `claude-subagent` + child} with principal = actor | repair-verification.ts:39-42, :124-151, :260-268; shared-findings.ts:1009-1028 |
| finding.rulingApplied | finding id | capsule: `ApplicationCapsuleV1` with **version 3** (1 or 2 → `LogDamage` :1033-1034); outcome ∈ refuted\|accepted\|invalid; acceptance iff accepted; key; issue {ref, key, openEpoch, openState, claimHash}; ruling {answerId, answerer?, roundId, questionId, display{question,answer,context}, displayHash, authority{checkedAt, sourceFingerprint, status `current`, comparison `clear`}}; evidence {directMention?, readers[1 or 2], arbitrator?}; reason | ruling-application.ts:34-70, :151-234; shared-findings.ts:1030-1069 |
| finding.relocation | finding id | kind ∈ moved\|gone; to str (required if moved); rationale? str; apply? `true` (agent + apply → dropped) | :1071-1086 |
| finding.promotedToBug | finding id | bug str | :1088-1110 |
| repair.claims-recorded | finding id | findingId, parentId, reason str; claims[] {id str (unique, new), text str} | repair-records.ts:150-154 |
| repair.sort-recorded | sort id (= d.id) | `RepairSortInput` (repair-sort-types.ts:10-25): id; prior? / priors[]?; reason?; classification str; kind isolated\|pattern; coverage[] {findingId, claimIds[]}; predicate? (req. for pattern); sites[]? str; refutationSubtype? factual\|scope\|assumed; restsOn[] str (free label or `decision:<id>`, A8); source str; provenance owner-reviewed\|dual-sorted\|released; assessments[] {identity{principal,session,child?}, classification, reason, receipt?{id,source,content}}; disagreements[] {id,text}; arbitration?; ruling?; release? {rulings[] {decision,answer,question,words}, readers[2] `ReleaseReceipt`} (only on `released`) | repair-records.ts:155-174 (`releaseError`, `sequenceError` :93-140) |
| repair.evidence-recorded | evidence id (= d.id) | `RepairEvidenceInput` (repair-records.ts:12-19): id, sortId; witness/base/fixCommit (40-64 hex); coverage[] + result + reason + claimResults[]; reproducer[] (phase witness\|fix), regression[] (phase regression) of `RepairExecution`; patternEnumeration?; inspected[] {source, commit, reasoning}; noCheckReason?; siteBugs[]? {findingId, site, bug}; rulingIds[] (unique, non-empty, includes the sort's `ruling` and its release's answers); attribution[] {file, hunk, claimIds[]} | repair-records.ts:175-205 |
| repair.verification-requested | request id (= d.id) | id; capsule `RepairVerificationCapsule` (repair-verification.ts:9-18); capsuleHash = hash(capsule); orchestrator.principal = actor | repair-verification.ts:128-141 |
| repair.verification-recorded | run id (= d.id) | id, requestId, capsuleHash, slot 1\|2, identity, results[] `RepairClaimVerdict` (evidence bar `resultError` :64-115) | :155-160 |
| repair.verification-arbitrated | arbitration id (= d.id) | id, requestId, capsuleHash, identity, runIds[2], addresses[] {findingId, claimId, reason (not a bare "agree"/"yes"…), verdict} | :161-172 |
| repair.participant-recorded, repair.verification-producer, repair.verification-sealed | — | RETIRED: skipped, never rejected | repair-records.ts:40, :62; repair-verification.ts:121 |

#### Bugs scope (no log-shape coverage)

| Kind | Subject | data shape | F |
|---|---|---|---|
| bug.filed | bug id (first wins; repeats merge anchors) | title str; text str; severity? ∈ low\|medium\|high\|critical (else `medium`); category?; anchors[] {anchorId, bodyHash, deleted? `true`} (malformed entries dropped); createdCommit?; filedAt?; fromPr? + fromFinding? (kept only as a pair); inherits? {author Actor, corroboration[] {actor, verdict, at, rationale}} | shared-bugs.ts:280-325; `anchorsIn` :226-244; `inheritanceOf` :47-53 |
| bug.revised | bug id | now {title?, text?, severity?, category?}; was | :331-346 |
| bug.anchored | bug id | anchors[] | :348-353 |
| bug.unanchored | bug id | anchorId str; reason?. Agent → dropped | :355-366 |
| bug.corroborated | bug id | verdict ∈ confirm\|refute\|unsure (**no `partial`**, unlike findings); rationale? | :368-383 |
| bug.backlogged | bug id | until ISO_DATE; reason; anchors? (witnesses, filtered to live citations); system?/key?/url?. Agent → dropped | :385-420 |
| bug.backlogReleased | bug id | reason. Agent → dropped | :422-432 |
| bug.commented | bug id | body; inReplyTo? | :434-439 |
| bug.promoted | bug id | none | :441-443 |
| bug.tracked | bug id | system? (default jira); key? / url? (at least one) | :445-459 |
| bug.assigned | bug id | kind ∈ investigate\|fix\|answer; note? | :461-466 |
| bug.outcome | bug id | result ∈ fixed\|answered\|declined; detail?; files? | :468-478 |
| bug.requested | bug id | ask ∈ ASKS; rationale? | :480-485 |
| bug.reopened | bug id | state ∈ created\|issued; observedClosure | :487-496 |
| bug.rulingApplied | bug id | capsule v3 (as findings; `acceptance` not allowed for bugs, ruling-application.ts:174) | :498-537 |
| bug.stateChanged | bug id | state ∈ issued\|created\|invalid\|refuted\|resolved\|withdrawn (**no `accepted`**); reason? | :539-550 |

#### Other per-universe scopes (no log-shape coverage)

| Kind | Subject | data shape | F |
|---|---|---|---|
| note.created | new note id (first wins) | text str; targetId str; targetKind ∈ anchor\|node\|spec\|operation; kind? ∈ note\|question\|finding\|pointer (else `note`); severity? category? str; line? number | shared-notes.ts:115-136 |
| note.revised | note id | now {text?, category?, severity? str; line? number}; was | :142-151 |
| note.answered | note id | body str | :152-156 |
| note.resolved | note id | resolved (`false` = unresolve); reason?. Agent → dropped | :158-163 |
| doc.version | node id (= version.nodeId) | version {versionId str (unique per scope); nodeId; type str; title? summary? body? str (defaulted); citations? array of {anchorId str, acceptedHashes?}; generatedBy must be absent; removed?; createdCommit?/createdBranch?/createdAt? str} | shared-docs.ts:84-146 |
| doc.accepted | node id | versionId, anchorId, bodyHash str | :148-178 |
| triage.asserted | `node:<id>` \| `anchor:<id>` (must match data) | targetKind node\|anchor; targetId str; source human\|agent (`graph` dropped); importance? ∈ business-critical\|important\|low; complexity? ∈ deep\|standard\|rote\|wiring; tripwire? boolean; reason?; assertedCommit?; witnesses[] | shared-triage.ts:253-266, VALID :134-138 |
| triage.cleared | as above | targetKind; targetId; present exactly `false`; reason? | :253-266 |
| graph.published | node id (= d.nodeId) | nodeId str; commit? str; edges[] {to str, type str, order? number; generatedBy must be absent} (bad edges dropped individually) | shared-graph.ts:61-81 |
| review.linked | `pr-<n>` (not checked) | pr string of digits; branch str | shared-reviews.ts:26-40 |
| walkthrough.published | `pr-<n>` (not checked) | walkthrough {pr number; head string; features[] {chapters[] {id string, witnesses array}}} | shared-walkthrough.ts:75-97, `walkthroughShaped` :68-73 |
| scope.acknowledged | the scope string | acknowledges[] {reason, digest}; honoured only from a non-agent actor | eventlog.ts:848-858 (HEAD) |

#### Decisions scope — all covered by `DECISION_SHAPES` (log-shape.ts:36-90)

| Kind | Subject (not checked unless noted) | S | F (first line of the fold's handling) |
|---|---|---|---|
| decision.round.posted | round label | :39-43 (+ `decision` :27-31) | shared-decisions.ts:914-966; per-decision `checkDecision` :317-383 |
| decision.confirm.posted | decision label | :44-47 | :969-986; `confirmRefusal` :475-512 |
| decision.question.logged | toolUseId | :48-53 | :855-873 |
| decision.answer.recorded | decision id | :54-57 | :1013-1015 → `acceptAnswer` :874-910, `resolve` :1600-1680 |
| decision.answer.revised | decision id | :58-67 | :989-1011; validity :1203-1242 |
| decision.questionnaire.submitted | questionnaire id or round id (**checked** :1022) | :68-71 | :1018-1069 |
| decision.comparison.nominated | sorted `a/b` answers (**checked** :1485) | :72-74 | :1478-1497 |
| decision.comparison.requested | request id (**checked** :1869) | :75-77 | `foldComparisons` :1861-1886 |
| decision.comparison.judged | request id (**checked** :1893) | :78 | :1888-1899 |
| decision.comparison.resolved | request id (**checked** :1910) | :79 | :1900-1921 |
| decision.withdrawn | decision id (**checked** :1305) | :80-82 | :1302-1350 |
| decision.conflict.resolved | decision id (**checked** :1362) | :83 | :1360-1372 |
| decision.reading.recorded | answer id | :84-89 | :1095-1105; acceptance :1136-1146 |

Fields the fold reads that log-shape does not type: `round.pr/branch/notes/prevalidated`,
`decision.follows/supersedes/origin/notes/resolves/presentation`, `via.*` per kind (typed by
`resolve`, :1600-1680), `data.list` (answer.revised), `reader.verified.*`, `review` (withdrawn,
typed by `withdrawalReviewRefusal` :189-208). `publication` must be exactly `2` on round/confirm
(dev-era postings are damage, log-shape.ts:37-38).

#### Standard — all covered by `STANDARD_SHAPES` (log-shape.ts:102-125)

| Kind | Subject (not checked unless noted) | S | F |
|---|---|---|---|
| spec.drafted | spec id | :103 | shared-standard.ts:475-483 |
| spec.operation | spec id | :104 (`operation` :92-99) | :484-500 |
| spec.revised | spec id | :105 | :516-531 |
| spec.operation.revised | spec id | :106 | :532-585 |
| spec.operation.removed | spec id | :107 | :532-559 |
| spec.operation-signoff-applied | operation id (**used** as lookup :589) | :108 (capsule: any object; typed by `validateOperationSignoff` operation-signoff.ts:26-59) | :587-603 |
| spec.reviewed | spec id | :109 | :604-628 |
| spec.ratified | spec id (**used** :630) | :110 | :629-773 |
| spec.withdrawn | spec id (**used** :775) | :111 | :774-877 |
| ack.granted | ack id | :112 | :878-912 |
| ack.released | ack id (**used** :914) | :113 | :913-925 |
| audit.recorded | requirement id | :114 (+ `auditClaimStands`, schema.ts ~1470) | :926-962 |
| vacuity.checked | criterion id | :115 | :963-987 |
| pointer.declared | pointer id | :116 | :988-1061 |
| pointer.restated | pointer id (**used** :1063) | :117 | :1062-1077 |
| pointer.retired | pointer id (**used** :1079) | :118 | :1078-1090 |
| population.pinned | pin id | :119 | :1091-1129 |
| scrub.policy | scope string | :120 (policy: any object; fold requires coverageDays > 0, minObservations ≥ 2 integer :1136-1137) | :1130-1140 |
| problem.raised | problem id | :121 (only `problem.id` typed; fold also needs requirementId, auditId, raisedAt :1146) | :1141-1158 |
| problem.adjudicated | problem id (**used** :1160) | :122 | :1159-1192 |
| spec.conflict.resolved | spec id (**used** as grouping key :420) | :123 | :430-441 |
| problem.conflict.resolved | problem id (**used** :421) | :124 | :430-441 |

---

## 1.3 How unknown / malformed events are handled today

| Case | Decisions & standard scopes | Every other scope |
|---|---|---|
| Bytes that are not JSON (not a torn tail) | Scope `blocked`, `corrupt-shard`, not acknowledgeable (eventlog.ts:887-900 HEAD); commit and pull refuse (sidecar.ts:133-146, 182, 220 HEAD) | same |
| Parses but fails `wellFormed` (envelope) | silently dropped, not damage (eventlog.ts:615) | same |
| Protocol/schema number ahead | scope `blocked` `protocol` (eventlog.ts:902-913) | same |
| **Unknown kind** | `shape` returns null (log-shape.ts:128-129); fold switch has no arm → ignored (decisions: no default; standard `default: break` :1196). The write door would still accept it (door fold refuses nothing for it) | fold ignores it (every fold dispatches on known kinds only) |
| **Unknown field on a known kind** | passes: shapes never require absence (log-shape.ts:6-8); the fold never reads it | passes; ignored |
| **Wrong shape of a known kind** | `LogDamage` from `foldHaltingOnDamage` (log-damage.ts:53-57) → lockout of the whole sidecar via `locking` (materialize.ts:33-40) / `recordLockout` (lockout.ts:68); transport gates count it as damage (sidecar.ts:133-146, `isEventLine` :596-600); the write door refuses a new wrong-shaped event (eventlog.ts:426-434) | silently **dropped** at the specific fold guard (e.g. shared-findings.ts:713-714, shared-bugs.ts:281-283, shared-notes.ts:120, shared-docs.ts:90-96, shared-triage.ts:253-266, shared-graph.ts:61-66, shared-reviews.ts:33, shared-walkthrough.ts:83, :93); repair kinds are recorded in `rejected` (repair-records.ts:107-109; repair-verification.ts:176-177). **Exception:** `finding.rulingApplied` / `bug.rulingApplied` with capsule version 1 or 2 throw `LogDamage` (shared-findings.ts:1033-1034; shared-bugs.ts:501-502) → lockout via `locking` on read |
| Refused by the fold (semantic, incl. dangling same-scope references) | Door refuses the write (eventlog.ts:426-437). On read: damage if it is refused **also** in its own causal context, else a race kept for conflict handling (log-damage.ts:63-68, `causalContext` eventlog.ts:1221) | Dropped (no refusal record) for findings/bugs/notes/docs/triage/graph; repair: door refuses (ops/repairs.ts:107-111, ops/repair-verification.ts:164-172), read keeps it in `rejected` |
| Which writes pass a door fold at all | mandatory: `FOLDED_AT_THE_DOOR = /^(decisions\|standard\|law)\//`, throws without one (eventlog.ts:385, 407-408), `scope.acknowledged` exempt | only repair records / verification (ops/repairs.ts:111; ops/repair-verification.ts:167-172). Everything else appends unchecked (`emitEvent` with no fold: shared-findings.ts:1133, shared-bugs.ts:585, shared-notes.ts:178, shared-docs.ts:204, shared-triage.ts:172/204/222, shared-graph.ts:148, shared-reviews.ts:43, shared-walkthrough.ts:46), including `finding.rulingApplied`/`bug.rulingApplied` (ops/ruling-application.ts:294, no fold arg) |

---

## Summary of kinds

- **Kinds any build emits or a fold accepts: 93** — 90 live + 3 retired repair kinds.
  Live: findings 21, repair 6, bugs 16, notes 4, docs 2, triage 2, graph 1, reviews 1,
  walkthrough 1, decisions 13, standard 22, `scope.acknowledged` 1.
- **log-shape.ts covers 35** (13 decisions + 22 standard); **55 live kinds have no stated shape**.
- **FK rows: 165**; ambiguous candidates: 9 (A1-A9).
