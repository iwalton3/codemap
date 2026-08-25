# Plan: one canonical `findings` table, and one way to file into it

**Status: IN PROGRESS** on `findings-unification`. Steps 1, 2, 3 and 5 are done, and
step 4's create verb — the part that stops the split recurring — has landed. What is
left is merging the parallel bug/finding lifecycle verbs, routing the web UI's own
"raise a finding" through `report_defect`, and the shared hub's missing per-PR index. Written 2026-08-25 from a live investigation of the
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

1. ~~**`METHODOLOGY` rewrite + dangling references.**~~ **DONE** (`15c1ee4`). One
   reference was not a typo: `get_anchor` takes no `ref`, so an MCP agent had no way to
   read a PR head's source while two descriptions named `pr_packet` — an op that existed
   and was never exposed. It is a tool now. Cover the PR review path, state
   the finding/bug boundary, fix the four references to non-existent tools. No schema
   change, no migration. Largest behavioural lever, lowest risk — do it first, and
   before the surface changes, so the document describes the surface as it is today
   rather than as it will be.
2. ~~**Canonical `findings` table**~~ **DONE** (`e022b98`, `34c0caa`, `629f91b`).
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
   LEFT: merging the parallel lifecycle verbs (`comment_bug`/`comment_on_finding`,
   `corroborate_bug`/`corroborate`, `ask_about_bug`/`request_ack`,
   `update_bug`/`close_finding`). That is ergonomics rather than correctness — the
   create verb is what made wrong placement impossible — and it is a wide change to
   land on its own.
5. ~~**Migration script** for the 96~~ **DONE** — `src/findings-migrate.ts`,
   `codemap migrate-findings`. Applied to Acme.API: 45 moved (23 on #227, 22 on #264),
   51 left with no recorded pull request, of which only 6 are open — and four of those
   six turned out to be duplicates of findings already on the sidecar, so leaving them
   unplaced is the right outcome rather than a gap.
6. **Web UI**: PR story page reads the canonical table; fix the "No findings raised"
   empty state; give the shared hub a per-PR index (there is currently no
   navigational path from a PR to its findings at all).

Steps 2 and 3 are one landing — a canonical table nothing reads is a fourth store.

## What this plan does not cover

- **`shared_note` stays.** Notes are symbol-scoped knowledge that outlives branches;
  findings are PR-scoped work with corroboration, promotion and acknowledgment. That
  split is load-bearing and is not what went wrong. What went wrong is two different
  things both called a finding, with the agent choosing between them.
- Trusted per-request work context (see "Honest limitation" above).
- The `retireSharedDoc` write-through gap (item 9), which is a docs bug.
