# Plan: one canonical `findings` table, and one way to file into it

> **Kind: decision record** — why the code looks like this. Done — kept for the argument, not as a to-do.
> all six steps done.

**Status: ALL SIX STEPS DONE** on `findings-unification`. Kept because the arguments
are still the reasons the code looks like this, and because two of them changed under
review — see the notes on step 2's key and on what step 4 did not merge. Written 2026-08-25 from a live investigation of the
`acme/acme.api` universe. `docs/sidecar-architecture.md` is the architecture
this implements and wins wherever the two differ; this plan answers the question that
document leaves open ("Whether findings follow docs into a canonical table") in the
affirmative, for the reasons in "Why".

## Why

A reviewer opened PR 269 in the web UI and saw **"No findings raised on this pull
request yet."** Ten findings existed for it, correctly associated, materialized in
SQLite, committed and pushed to the sidecar's remote. The page that said none existed
reads a different store from the one they were in.

That is the whole defect in one sentence, but the measurement is worth keeping:

| | count | visible to |
|---|---:|---|
| local findings (`meta.annotations` blob) | 96 | ~30 surfaces incl. the GitHub publish path |
| shared findings (sidecar log -> `shared_finding`) | 26 | one web page, one MCP tool, one CLI command |

**122 findings, and no surface shows more than 96 of them.** Neither store is a
superset of the other. Which half an agent's work lands in is decided by which tool
name it picked.

## The inversion that causes it

A local `Annotation` **has no `pr` field**. The only `pr` on it lives inside
`postedRef`, which is written *after* the finding has been posted to GitHub. So PR
membership is inferred at read time by intersecting `target.id` with that PR's
changed-symbol worklist (`ops/pr.ts` `prOffStoryFindings`, `pr-push.ts` `planPrPush`).
Anything off-diff falls out as "off-story" and needs a hand-set `publishPath`.

A shared finding's PR is **structural** — it *is* the log scope, i.e. which NDJSON
shard the event was appended to. That is why all 26 shared findings were correctly
associated and none could be misfiled.

So the store the product reads cannot express "this belongs to PR N", and the store
that can is the one almost nothing reads. Everything below follows from that.

## The measured gaps

Each verified against the code at `2009fdb`, and against live data where a live
observation was possible.

1. `shareFinding` (`ops-shared.ts`) writes only the log event — never a local
   annotation. Invisible to review queue, PR story, anchor page, dashboard counts,
   orphans.
2. `annotate` mirrors to the sidecar as a **note** (`notes-publish.ts` `mirrorNote` ->
   `createNote`, scope `notes/<universe>/<bucket>`), dropping PR, ratchet state, ack
   queue, corroboration, `comment`, `disposition`, `witness`, `sourceRef`.
3. No `publishLocalFindings`. Notes, docs, triage and graph each have a local->shared
   bridge; findings have none. **`publishLocalNotes` does not filter by kind**, so all
   96 local findings *are* bridged — into `shared_note`. The wrong bridge is worse
   than none: the hub reports `wouldPublish: 0` and looks fully synced.
4. The GitHub publish path never reads shared findings — zero references in
   `pr-push.ts`. Measured: PR 270 has 10 shared findings; `push_plan?all=1` returns 2
   comments, both from local annotations.
5. `orphanedWork` (`ops/orphans.ts`) reads annotations, bugs and reviews, never
   `shared_finding`. *Code-reading claim only* — no live instance was observed,
   because every shared finding in the universe is `offTree` rather than `lost`.
6. **All twelve finding write ops skip write-through.** Docs (`shareDoc`,
   `confirmSharedDoc`), walkthroughs and bugs materialize on write; findings never do,
   so the row appears only on the next read or sync. This violates the architecture
   doc's "Write-through" rule, which is listed there under *consequences that are
   decided, not open*. The comment at `bugs-publish.ts` asserting that "triage,
   findings and docs all materialize on write" is stale — findings do not.
7. Filing does not commit or push. `emitEvent` writes NDJSON; `commitLocal` runs only
   from sync/heal. Twelve events were sitting uncommitted in the sidecar working tree
   when this was written.
8. The PR story page reads neither store's shared half and asserts "No findings raised
   on this pull request yet" while ten exist (`web/app.js`).
9. `retireSharedDoc` also skips write-through. Docs, not findings, but same class.

## Desired state

**One canonical `findings` table**, on the `bugs` precedent, which was built canonical
from the start and already has the right polarity (`ops/bugs.ts`, `bugs-publish.ts`):

- One table holding both origin-less local rows and fold-owned shared rows, with
  `origin` / `source_scope` columns. Not a parallel `shared_finding`.
- **A `pr` column that is not nullable for a PR finding.** PR membership is stored,
  never inferred. Worklist intersection stays what it is — a rendering decision about
  which chapter a finding belongs in — and stops being the thing that decides whether
  a finding exists.
- Event-first **write-through** when a healthy sidecar is configured: append, then
  materialize that scope, so the tool that just filed it reads it back.
- A PR-associated local row when **no** sidecar is configured. Degraded delivery
  (not team-synced), never degraded semantics.
- A configured-but-broken sidecar is an **error**, and writes nothing. A claim that
  never entered the log cannot be retrofitted with a causal position, because `after`
  is captured at append time.
- **Every** surface reads that one table: review queue, PR story, anchor page,
  dashboard, orphans, and the GitHub publish path.

### The entity boundary, which is real and currently written down nowhere

- A **PR finding** is raised while reviewing a specific pull request and is resolved
  at or before merge.
- A **bug** is either a finding deferred to fix after merge, or a drive-by defect
  noticed during unrelated work.
- A PR finding must never be filed as a bug. The one legitimate transition is
  finding -> bug, via `accept_finding` (proposed rename: `defer_finding`).

This boundary is currently respected in practice — of 39 bugs, 38 are genuine
drive-by defects and the one from a PR went through `accept_finding` carrying
`{"pr":"270","finding":"f_00mt82rwn0-83b56ba936"}` — but nothing enforces it, and the
reverse route is broken: `acceptFinding` resolves via `shared.findingRecord`, so it
works only on `f_` findings. The 96 local findings have no route to a bug at all,
which is exactly the "defer to fix post-merge" path.

### The guardrail

Creation takes a **required discriminated context**, and no caller-supplied storage,
entity-kind or `shared` field:

```
report_defect({ context: { kind: "pull_request", pr: 270 }, ... })      -> always a finding
report_defect({ context: { kind: "drive_by", rationale: "..." }, ... }) -> always a bug
defer_finding({ finding: id })                                         -> the only finding -> bug transition
```

Bug provenance is persisted as `origin: drive_by | { finding, pr }`, for which there
is already partial precedent in `shared-bugs.ts` and `acceptFinding`.

**`report_bug` cannot refuse "when a PR review is in scope", because no such scope
exists.** The MCP context carries workspace and universe only, and inferring PR scope
from branch or HEAD is unsound — a PR can be reviewed without checking out its head,
and `get_anchor` already warns that the working tree is a third version. Do not build
that inference.

**Honest limitation, recorded so it is not rediscovered as a defect:** a discriminated
union makes the invalid *shape* unrepresentable but cannot prove an agent did not
mislabel a PR defect as drive-by. Intent is not observable. Literal impossibility
needs either a trusted work-context token supplied by the harness rather than chosen
by the agent, or removing direct bug creation from MCP entirely (agents file findings
and defer them; drive-by bugs become a human/CLI act). Neither is in this plan.

### Id dispatch is rejected

Verbs must **not** dispatch on id prefix (`f_` / `bug_` / `finding_`). Those are
serialization details minted by a generic `prefix + id` helper, and the three are
visually confusable. Resolve the opaque id against the canonical record instead —
which is what `routeWrite` in `ops/bugs.ts` already does for bugs. Creation cannot use
id dispatch at all, since no id exists yet; that is what the required context is for.

## The tool surface

83 MCP tools. ~25 of them implement one lifecycle three times:

| verb | bug | local finding | shared finding |
|---|---|---|---|
| create | `report_bug` | `annotate(kind:"finding")` | `share_finding` |
| list | `list_bugs` | `findings` / `review_queue` | `shared_findings` |
| comment | `comment_bug` | — | `comment_on_finding` |
| second opinion | `corroborate_bug` | — | `corroborate` |
| ask a human | `ask_about_bug` | — | `request_ack` |
| report back | `update_bug` | `close_finding` | `report_on_finding` |
| revise | `update_bug` | `revise_finding` | **nothing** |

`review_queue` and `findings` are the same handler (`ops.reviewQueue`) with different
default flags.

### The largest single lever is not a tool

`METHODOLOGY` (`guide.ts`) ships as the server's `instructions` in the MCP initialize
response, so every agent is handed it at connection. In 188 lines it teaches the
**bug** lifecycle in full, mentions `annotate` once as "leave a note or open question"
— never saying it can file a finding, which is how 96 of the 122 findings here were
created — and never mentions `share_finding`, `shared_findings`, `review_queue`,
`pr_walkthrough` or PR review at all. The product's north star is absent from the
document every agent reads. The measured 38-direct-`report_bug`-to-1-`accept_finding`
split is what that document produces.

### Descriptions that cause a wrong choice

- **Four references to tools that do not exist**: `pr_packet` (`mcp.ts:261`, `:639`),
  `report_finding` (`mcp.ts:926`), `publish_local_docs` (`mcp.ts:975`), `check`
  (`mcp.ts:422`). An agent told to report "through `report_finding`" substitutes
  something.
- `findings` (`mcp.ts:729`) claims "Every finding and question on the map, whoever
  raised them" and reads local annotations only — with a sidecar configured it
  silently omits every shared finding. The same lie the web UI's empty state tells.
- `review` (`mcp.ts:308`) recommends "Pair with `annotate(kind:finding)`" — a tool
  with no PR parameter that mirrors to the sidecar as a note.
- `report_bug` (`mcp.ts:492`) never states the boundary above.

### Cuts

Verified:

- **`guide`** — redundant; `METHODOLOGY` already ships as `instructions`
  (`mcp.ts:123` vs `:1028`).
- **`retire_shared_doc`** — unusable by construction. The op refuses `isAgentActor`
  and MCP marks every session an agent at startup, by design. It can never succeed
  through MCP. Keep the operation in CLI/UI.

Proposed by review, **not yet verified, do not action without checking**: `reindex`
(subsumed by `init`), `sanity_check` (claimed equal to `review(node, logical)`),
`confirm_shared_doc`, `publish_bugs`, `record_published`.

## Migration

The 96 local findings **did** reach the sidecar — all 155 annotations are
`shared_note` rows. They went into the log as the wrong entity type, not into nothing.
This is a retype-and-rescope inside the sidecar, not a rescue.

| | count | PR |
|---|---:|---|
| have `postedRef.pr` — definitive, no inference | 45 | 23 on #227, 22 on #264 |
| no PR, already resolved or withdrawn | 45 | closed history |
| no PR, **still open** | 6 | needs a judgement call |

Only **six** findings genuinely need someone to decide which PR they belong to. A
backfill is a new attributed act, not reconstructed causality: `after` is captured at
append time and cannot be recreated, so migrated findings enter the log now, with the
migrating actor, and say so.

## Steps

1. ~~**`METHODOLOGY` rewrite + dangling references.**~~ **DONE** (`a9ae214`). One
   reference was not a typo: `get_anchor` takes no `ref`, so an MCP agent had no way to
   read a PR head's source while two descriptions named `pr_packet` — an op that existed
   and was never exposed. It is a tool now. Cover the PR review path, state
   the finding/bug boundary, fix the four references to non-existent tools. No schema
   change, no migration. Largest behavioural lever, lowest risk — do it first, and
   before the surface changes, so the document describes the surface as it is today
   rather than as it will be.
2. ~~**Canonical `findings` table**~~ **DONE** (`834f7a0`, `fbfda15`, `5301d3f`).
   Keyed like `triage`, NOT like `bugs`: a universe has one bugs scope, so an id alone
   identifies a bug, but findings have one scope per pull request and a log can carry
   the same id in two of them. An id-only key silently dropped the second, and the
   oracle's hostile-history property caught it. Partial unique indexes instead.
   Write-through landed on all thirteen write ops (twelve was a miscount — `settleContest`
   is one too), and the store half is `readFindings` / `readFinding` /
   `writeLocalFinding`.
3. ~~**Repoint every reader** at the canonical table.~~ **DONE** — `sharedFindings`,
   the PR story page, the anchor page, `orphans`, and `reviewQueue` (with it the
   `findings` / `review_queue` tools and `close_finding`). `reviewQueue` converts a
   finding row into the Annotation shape it already handles, so every filter, the
   paging and the off-tree resolution kept working; `close_finding` resolves the id
   against the RECORD and routes to annotation / local row / log. That router lives in
   `ops.ts` because the three branches span two layers that may not import each other —
   `ops/annotations` reaching `ops-shared` closes a cycle through `ops/triage`, which
   `import-cycles.test.ts` catches.
   `pr-push` stays local: publishing to GitHub is a manual raise and the sidecar is not
   meant to feed it. The dashboard's `open` is documentation coverage, not findings.
4. **Collapse the tool surface.** DONE for the part that stops the split recurring:
   `report_defect` is the one create verb, taking a required discriminated `context`
   (`pull_request` + pr, or `drive_by` + rationale) and NO storage parameter.
   `share_finding` and `report_bug` are gone, `accept_finding` is `defer_finding`,
   `annotate` no longer accepts `kind:"finding"`, and the two verified cuts (`guide`,
   `retire_shared_doc`) are gone. 84 tools -> 81.
   The parallel lifecycle verbs are merged too: `comment`, `corroborate` and
   `request_human` each take a finding id OR a bug id and resolve it against the
   RECORDS. A finding carries its own pull request, so there is no longer a `pr` to
   pass wrongly. 84 tools -> 78.
   NOT merged: `update_bug` and `close_finding`. They look like a pair and are not —
   one changes fields, the other reports an outcome, and collapsing them would make
   `result` mean two things.

   **A later use-report finished the row this table calls "report back"** (see below).
   `revise_finding` and `close_finding` now resolve any finding id against the records,
   the same way `comment` does, and `report_on_finding` — which was `close_finding` for
   the shared half, with a `pr` to get wrong and no `comment`, `severity` or
   `disposition` — is gone. 78 tools -> 77. What made this worth doing was not the
   duplication: it was that the shared half had NO revise verb at all, so an agent whose
   triage changed a finding's ask could only put the correction in an outcome paragraph,
   over a record still reading the severity it was filed as.
5. ~~**Migration script** for the 96~~ **DONE** — `src/findings-migrate.ts`,
   `codemap migrate-findings`. Applied to Acme.API: 45 moved (23 on #227, 22 on #264),
   51 left with no recorded pull request, of which only 6 are open — and four of those
   six turned out to be duplicates of findings already on the sidecar, so leaving them
   unplaced is the right outcome rather than a gap.
6. ~~**Web UI**~~ **DONE**. The PR story page reads the canonical table, the "No
   findings raised" empty state counts the team's, the shared page wraps its findings
   and puts triage first, and the hub has a per-PR index — there was no navigational
   path from the hub to a pull request's findings at all. The browser's own "raise"
   goes through `report_defect` with the context it can see: on a pull request it files
   a finding there, anywhere else a drive-by bug, and the button says which.

Steps 2 and 3 are one landing — a canonical table nothing reads is a fourth store.

## One axis, two vocabularies

The stores are one table, and the *lifecycle* verbs are now one each. What is still two
words is the question every triage list is read by — how settled a finding is:

| local `disposition` | shared `tier` | means |
|---|---|---|
| `open` | `unconfirmed` | filed; nobody has weighed in |
| `confirmed` / `partial` / `rerated` | `confirmed` | somebody stood behind it |
| `refuted` | `doubted` | probably not real, nobody has closed it |
| `accepted`, or resolved | `settled` | done with |

Until one word wins, **both surfaces answer to both**: `findings` takes `tier` and puts
it on every row, `shared_findings` takes `tier`, and the mapping lives in exactly one
place (`tierOfAnnotation`, `ops/annotations.ts`) rather than being re-derived per caller.
`findings` also takes `pr`, which it can only do because membership is stored.

### And a SECOND axis, which is not that one

`disposition` / `tier` say whether the claim is TRUE. `remediation` says what HAPPENED
about it: `outstanding` | `fixed-on-branch` | `fixed-on-default` | `deferred` | `wont-fix`.

Its absence was a live defect rather than a gap. With nowhere to record a fix, the
workaround in use was to revise fixed findings to `refuted` — marking real, correctly
filed, now-fixed defects as false positives — which poisons the one question the data is
for. Measured on PR #264: twelve findings, eleven fixed by the submitter, and the outcome
expressible only as a paragraph in `text` that no query reaches.

`fixed-on-branch` and `fixed-on-default` are separate because the difference is
load-bearing: a fix on an unmerged branch means the mainline still carries the defect,
which is exactly when a linked bug must NOT be closed.

It is its own event (`finding.remediated`), not a revision, and that is what makes it
work: a revision rewrites somebody's claim and is gated on confirmation, while this adds
an observation and destroys nothing. Gated, it would have refused the case it exists for —
a submitter fixing findings other people confirmed.

Two things about the tier correspondence that are easy to get wrong:

- **`tier` is taken from the RECORD, before the flattening.** `findingAsQueueEntry`
  reduces a finding's state and corroboration to a `Disposition`, and that reduction
  cannot tell `invalid` from unreviewed — both come out `open`. Deriving the tier from
  the disposition would therefore file a closed-as-invalid finding under "nobody has
  looked at this". Only a plain annotation, which never had the richer state, is
  derived from its disposition.
- **`accepted` is `settled`, not `confirmed`.** It means real and deliberately not being
  fixed. Leaving it under `confirmed` would keep it at the top of a list read for what
  still needs deciding.

A verdict recorded on one side is visible on the other, and that is not a coincidence:
`corroborate` on a shared finding appends to the canonical row's corroboration, so the
local view's `disposition` moves from `open` to `confirmed` with it. There is one row.

## Near-term: what is left before there is only one kind of finding

The end goal is that a local finding exists only where it is CORRECT — a store with no
sidecar — and that the duplication needed to serve two kinds is gone. Ordered by what
blocks what.

1. ~~**`inbound_replies` reads the log, not the canonical table.**~~ DONE. It reads
   `readFindings` after materializing, so a finding filed locally and pushed by the web UI
   is in the list its replies are looked up from. Two things came out of it that the item
   did not say:

   - **The migration was dropping the comment id.** `postedRef.commentId` had no `key` in
     the `posted` it wrote, and `inboundReplies` matches the submitter's thread by that
     key — so fixing only the read would have moved the false premise one layer down and
     kept the same answer. Fixed in `findings-migrate.ts`; both halves are
     mutation-checked separately.
   - **Two emptinesses are now distinct.** A finding posted in the review BODY has a
     `posted` and no key: there is no thread to read, but something IS on the pull
     request, and saying "nothing has been published" about it is the same lie in a
     quieter place.

   The sidecar is no longer required for the read either — a store that filed locally and
   pushed still has replies to read, and demanding a sidecar for them was the split
   showing through.

2. ~~**Notes are the last parallel table, and the mirror is one-directional.**~~ DONE for
   the READS and the writes; the storage layout is deliberately unchanged, and
   `docs/sidecar-architecture.md` is why — it settles that notes keep their own table
   ("symbol-scoped knowledge that outlives a branch is a different entity"). What was
   actually broken was the direction, not the table:

   - `questions` merges the team's (`readSharedNotes`, the projection — never a fold of
     256 buckets on a read), dedupes a mirrored question to one row, and marks whose is
     whose with `shared`.
   - `resolve_question` dispatches on the record. A mirrored question closes on BOTH
     copies; a teammate's, which has no local copy, closes on the sidecar.
   - `get_anchor` carries `sharedNotes`, the way it already carried `sharedDocs`. The web
     anchor page had shown them for months; the MCP surface had not.

   Three things the item did not say, all found by building it:

   - **The agent gate is in the FOLD.** `foldNotes` drops any `note.resolved` from an
     agent actor. Relaxing the op to match `resolve_question`'s deliberate "an agent may
     close a question" (`26a61d6`) would have appended an event every reader ignores and
     reported it as shared — the silent no-op this plan spent a session removing. So an
     agent closes its own LOCAL question and is TOLD the team's is still open. The
     shared refusal now also covers re-opening, which the fold drops and the op used to
     answer `{ok:true}` for.
   - **Notes never wrote through.** `mirrorNote` appended and returned, so the row
     appeared only when something else folded — and every canonical reader queries SQLite.
     Findings were fixed for this in `fbfda15`; notes were the last kind that skipped it.
   - **The note store holds 96 findings** on the primary universe (45 also rows in
     `findings`, 36 anchors that rendered the same finding twice — once as a note with no
     PR, tier or thread, once as the finding that has them). `annotate(kind:"finding")`
     mirrored them before the tap shut. `shared_notes` and `get_anchor` no longer list
     them and say how many they left out. See (4a).

3. ~~**Pointers still ride the annotation machinery — audit what reads them.**~~ DONE.
   **The path has an owner, and it is the product's core surface.** The worry was
   backwards: the annotation store IS a pointer's canonical home, and nothing has moved
   off it. Measured on `Acme.API`: 44 pointers, 34 line-pinned, 40 on live anchors, all
   but one from a single `pr-first-pass`, categorised the way findings are (Security 7,
   Logic 8, Tenant Safety 5, …).

   **Readers, all live:** `getAnchor.annotations` (MCP + the anchor page); the PR story's
   per-step `annotations` (`pr.ts`, kind-agnostic) which `codeReviewLines` pins inline at
   its line with 👁 — this is the one that matters; `shared_notes` and the web panel, so a
   teammate has them; `orphanedWork`, which covers them when their anchor leaves the tree
   (16 annotation orphans on that store); and `planPrPush`, which gates on DISPOSITION
   and deliberately **not** on kind — a pointer later confirmed is a finding in all but
   the field it was filed under, and the six once excluded on kind included the
   highest-rated item in the review.

   **Deliberate exclusions, all documented at their site:** the ⚑ action-item count,
   `review_queue`'s open view, `listQuestions`, the overview's open-question count,
   `prOffStoryFindings`. Not one reader in the tree branches on `kind === "pointer"`;
   every kind-aware read filters FOR finding/question. That is a coherent design, not
   neglect.

   **The one real gap, and it is fixed.** Every pane that pins an annotation to a line —
   `prStory`'s steps, `nodeReview`, `fileView`, `prAnchorCode` — read LOCAL annotations
   only. So your own pointer showed at line 183 while you read the diff and a teammate's
   showed nowhere near the code; `get_anchor` was the sole surface carrying it, one
   navigation away. `notes-lookup.ts` now supplies `sharedNotes` to all four, rendered
   read-only beside the local ones (`teamNoteEl`) — never merged into `annotations`,
   because those carry assign/escalate/resolve and a fold-owned note is not locally
   mutable. Findings are excluded for the same reason `shared_notes` excludes them.

   On `Acme.API` this changes nothing visible today: every shared note there has a local
   twin, so the dedupe correctly yields zero. What a TEAMMATE of that store would now see
   pinned to code is 59 notes across 55 anchors, 47 of them at a line.

4a. **51 findings are published as NOTES and are in no findings surface.** Measured on
   `Acme.API`: of the 96 `kind:"finding"` rows in the note log, 45 are also rows in
   `findings` and 51 are not — they are the local annotations `migrate-findings` reported
   as "unplaced, a person must assign a PR". So the team can already see them, as notes,
   while every findings surface calls them local-only. Excluding them from the notes
   surfaces (done) stops the double-render; it does not give them a home. That is a data
   decision for a person: assign each a pull request, or accept them as history.

4. **`shared_finding` is still created and never used.** `db.ts` says three lines above
   it, about `shared_walkthrough`: "a table nothing writes is a table somebody reads by
   mistake."

5. **`retire_shared_doc` is named in three user-facing errors and is not a tool** — no
   MCP tool, no CLI command; the op is reachable only from a web POST. An agent following
   any of those messages has nowhere to go.

6. **The push-to-GitHub plan cannot see a canonical finding.** Found while doing (1),
   and it is the same shape one layer out: `planPrPush` reads `readAnnotations` and
   nothing else, and its whole vocabulary is `Annotation` (`pushVerdict`,
   `fromAnotherReview`, `postedRef`). Since the create tap shut, `report_defect` writes a
   canonical row or a log event and never an annotation — so nothing filed today is
   pushable by the UI, and `record_published` by hand is the only way a finding acquires
   the `posted` that (1) depends on. Bigger than the rest of this list, and unmeasured:
   the push UI has never posted for real, so how much of it is load-bearing is a question
   before it is a plan.

7. **Two `universe` namespaces.** Every shared read prints `cfg.universe` (the
   `owner/repo` slug); the `universe` INPUT is keyed on workspace ids (manifest id, else
   directory basename). So a tool prints an identifier the next call refuses as unknown,
   under the same field name, in the same session.

## Found on the way, and fixed: a walkthrough published as INPUT

Not part of this plan, but the same defect shape one entity over, and worth the entry
because the diagnosis is reusable. One `walkthrough.published` event on `Acme.API` PR 269
carried the agent's `WalkInput` — `{title, blocks}`, no chapter id and no witnesses —
where the BUILT `PrWalkthrough` belonged. `staleChapters` reads `c.witnesses.some`, so
`/api/pr/story` 500'd for that pull request permanently: the log is append-only, and the
fold validated only the envelope (`pr`, `head`).

- **The two types are structurally close and every publish path crosses a JSON boundary**
  (an MCP argument, the unvalidated `walkthrough_share` POST, an NDJSON line), so
  TypeScript never sees the substitution. Only one event in the whole sidecar is affected;
  the current write path builds correctly.
- **Three guards, because they catch it at three different distances:** the fold skips it
  (which is also what HEALS it — the next materialization drops the row on every machine,
  no history rewrite), `shareWalkthrough` refuses it, and `staleChapters` no longer throws
  on a chapter a local row could still carry.
- **The fold guard failed one existing test, and the test was wrong.** `materialize.test.ts`
  round-tripped `{pr, head, chapters}` cast through `as never` — a shape nothing produces —
  so it was checking the projection plumbing against a fiction. It now round-trips a real
  walkthrough. A cast to `never` in a fixture is worth treating as a finding on its own.

## After this: retiring the local path entirely

`docs/plan-retire-local-findings.md`. The end state this plan describes — one canonical
table, one way to file — leaves TWO write paths into it, and the local one is a second
implementation that drifts rather than a thinner version of the other. Three separate
reviews this session each found a different divergence in it.

The claim that makes it feasible is checked there and worth stating here: a store with no
sidecar loses nothing, because "no sidecar" can become "a sidecar nobody else pulls from".
The event log is plain files, a remote-less sidecar is already supported and documented as
such, `resolveSidecar` already accepts a bare directory, and `unify-findings` already
replays local rows into a log preserving ids. Parked deliberately until the lifecycle
stops moving.

## What this plan does not cover

- **`shared_note` stays.** Notes are symbol-scoped knowledge that outlives branches;
  findings are PR-scoped work with corroboration, promotion and acknowledgment. That
  split is load-bearing and is not what went wrong. What went wrong is two different
  things both called a finding, with the agent choosing between them.
- Trusted per-request work context (see "Honest limitation" above).
- The `retireSharedDoc` write-through gap (item 9), which is a docs bug.
