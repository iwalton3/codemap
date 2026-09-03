# Static review: codemap collaboration branch against `main`

> **Kind: archive** — superseded or finished. Do NOT plan from it; read it only for history.
> a one-off review of the collaboration branch against `main`, at commits that are long merged.

Reviewed `main` (`90fde01`) through `worktree-shared-review-hashscheme` (`ffea2c0`), including the intended-state proposal in `PROPOSAL-shared-review-state.md` and the vdx contract in `/working/vdx-web/FRAMEWORK.md`.

This was a static review. I did not rerun the test suites (the request states they are passing); `git diff --check main...HEAD` is clean. A second pass assigned three independent reviewers to event/Git convergence, witness/spec/security, and web/framework/protocol behavior. They were asked to refute as well as extend the first pass. No original finding was materially refuted; the same-principal manifest finding was replaced below with the deeper immutable-provenance defect.

## Executive summary

**Recommendation: request changes before merging.** The branch contains a thoughtful event model and much stronger attribution, conflict residue, hash-scheme handling, and browser typing than `main`, but several load-bearing guarantees described by the proposal are not connected end to end.

The largest problem is that `pr_push` still plans and records publications exclusively in the local store. The new sidecar `alreadyPosted()` guard is unused in production, so the motivating duplicate-publication race remains. Shared findings and mirrored annotations also bypass codemap's witness-hash model: the primary MCP creation path cannot supply a witness, shared reads never compare one with live code, and annotation mirroring discards the local witness. A malformed but parseable event can crash an entire scope; sync can claim it sent work after a failed commit; and the docs UI/CLI can label a partially missing document `fresh`.

The implementation is also structurally short of the proposal's intended scope. Sidecar state bypasses `store.ts` instead of materializing into SQLite, so ordinary outline/node/graph/flow/Bug/triage consumers never see synchronized knowledge. Reported Bugs and triage remain local, docs edges are not shared, promotion-to-Bug only records a string, and `finding.assigned` has a reader but no writer.

The combined review found 11 P1, 14 P2, and 1 P3 issues below. P1 means the behavior breaks a central correctness or safety guarantee and should block the merge; P2 is important but narrower or has a workaround.

## Findings

### P1 — The shared publication guard is not connected to `pr_push`

**Evidence:** `src/shared-findings.ts:578-589`, `src/pr-push.ts:508`, `src/pr-push.ts:720-779`, `src/ops.ts:944-993`.

`alreadyPosted()` is documented as the fix for two reviewers publishing the same finding, but its only call sites are tests. `planPrPush()` still builds its candidate set from local annotations and deduplicates with local `readPushes()`. `executePrPush()` records only through local `writePush()` and never emits `finding.posted` or syncs/pulls the sidecar.

Consequently, reviewer B cannot observe reviewer A's publication when planning a review, even after syncing. Shared findings are not publishable through the ordinary inspected `pr_push` path either; an agent must post them by some other mechanism and separately remember to call `record_published`. This leaves the proposal's motivating duplicate-comment failure intact and makes inbound replies depend on an easy-to-forget bookkeeping call.

**Recommendation:** make the shared finding set and shared publication map inputs to the inspected push plan, pull before planning, and make successful execution record `finding.posted` immediately as part of the same operation. The plan fingerprint should cover the shared inputs it approved.

### P1 — Shared findings are created without a trustworthy code witness

**Evidence:** `src/mcp.ts:701-714`, `src/ops-shared.ts:75-80`, `src/ops-shared.ts:222-236`, `src/shared-findings.ts:463-480`, compared with `src/ops.ts:2646-2691`.

The model permits optional `witness` and `sourceRef`, but the primary `share_finding` MCP schema cannot accept either (and has `additionalProperties: false`). `shareFinding()` does not resolve or validate the target and does not capture the live/ref body hash as local `annotate()` does. Reading shared findings only classifies whether the target exists; it never compares a stored witness with the current body, and the flattened view omits the witness.

Agent-created shared findings therefore silently survive body changes and can be filed against nonexistent or mistyped ids. Cross-branch contamination—the class that `witness`/`sourceRef` is meant to detect—looks current instead of stale or unverifiable.

**Recommendation:** use the same strict reference resolution and `witnessAt()` behavior as `annotate`, accept an explicit PR/ref where appropriate, persist the scheme-bearing witness, and expose a derived live status on reads.

### P1 — Mirroring an annotation strips its witness and source ref

**Evidence:** `src/ops.ts:2684-2691`, `src/ops.ts:2755-2778`, `src/shared-notes.ts:154-169`, `src/ops-shared.ts:301-326`.

Local annotation creation correctly captures `witness` and `sourceRef`, then mirrors only id, target, kind, text, severity, category, and line. `NewNote` has no witness fields and `sharedNotes()` has no drift evaluation. The shared copy of codebase knowledge therefore loses the very receipt that lets codemap determine whether it still describes the code.

This is particularly risky because the local write returns success and the shared note is presented to the next reviewer as reusable knowledge. After a behavior change, they receive a confident old note with no stale indication.

**Recommendation:** preserve witness/sourceRef in note events and derive `fresh`/`stale`/`unverifiable` against the reader's checkout. Keep the local-first failure policy, but return a warning when configured sharing failed instead of silently dropping it.

### P1 — A parseable malformed event can make an entire scope unreadable

**Evidence:** `src/eventlog.ts:148-157`, `src/eventlog.ts:254-274`, `src/shared-findings.ts:258-274`.

`readShard()` accepts any object with string `id`, `kind`, and `subject`. It does not validate `actor`, `actor.principal`, `at`, `data`, or causal fields. Every findings fold first calls `causality()`, which immediately dereferences `e.actor.principal` (and does the same for parents). A line such as `{"id":"x","kind":"finding.created","subject":"f"}` passes the reader and then throws before the fold can skip it.

That contradicts both the proposal and the fold's own contract that malformed events from another client are skipped rather than fatal. One buggy or older client can prevent everybody from reading every finding in that PR scope.

**Recommendation:** centrally validate the complete `LogEvent` envelope before it enters sorting/causality, including the nested actor and causal arrays. Skip or quarantine invalid lines with enough location information to diagnose the writer.

### P1 — Docs can be shown as fresh when cited code is missing or stale

**Evidence:** `web/shared.js:358-372`, `src/cli.ts:291-300`, `src/ops-shared.ts:448-453`.

Both the UI and CLI filter citations down to those currently present, then declare the document fresh when every *present* citation matches. A document with one matching citation and one missing citation receives a green `fresh` badge. `docUnverified()` uses `some`, so one old-scheme citation can also mask a separate genuinely changed citation as merely `unverified`. Conversely, a correctly selected removal tombstone has no present citations and is always displayed as stale.

The backend's `needAttention` count only includes retained/lost citations, not present-but-hash-mismatched ones, so the summary can also omit live drift.

**Recommendation:** compute one authoritative document status in the backend. For a live version, require every citation to be present and matching for `fresh`; real comparable drift should outrank `unverifiable`. Apply the inverse presence rule for a removal tombstone and include all actionable drift in `needAttention`.

### P1 — Shared docs compare and confirm cached hashes, not live source

**Evidence:** `src/ops-shared.ts:386-389`, `src/ops-shared.ts:400-434`, `src/ops-shared.ts:474-493`.

The helper called `liveHashes()` reads hashes from the persisted anchor store without re-indexing the current files. If code changes after the last index, `sharedDocs()` continues resolving and labeling versions against the old body. Worse, `confirmSharedDoc()` can emit `doc.accepted` for that cached hash while telling the user it confirmed the document “against this checkout.”

This breaks the core invariant that staleness is judged against live hashes, never frozen stored ones. It can both hide a stale document and create a durable false confirmation.

**Recommendation:** derive hashes from current source for the cited files under the normal universe lock, or make the operation first perform the same safe incremental re-index used by staleness checks. Never emit an acceptance from a cached hash whose source has not been verified live.

### P1 — `share_doc` can create floating docs or poison the whole docs scope

**Evidence:** `src/mcp.ts:834-838`, `src/ops-shared.ts:457-466`, `src/shared-docs.ts:61-69`, `src/shared-docs.ts:139-155`, compared with `src/ops.ts:2248-2263`.

The official MCP path accepts an opaque `version` object and forwards it without validating the node, citations, accepted hashes, or basic field types. It can publish `citations: []`, unknown anchor ids, or fabricated hashes, bypassing the no-floating-claims validation in local `document()`. It can also publish `citations: "bad"`; the write reports success, but the next fold calls `.map()` on the string and makes every shared-doc read for that universe fail.

**Recommendation:** define and validate the complete nested input schema, resolve every citation against the intended ref, require at least one real citation for live docs, capture trustworthy hashes server-side, and make folds defensively reject malformed payloads without throwing.

### P1 — Sync can report that it pushed work after the work failed to commit

**Evidence:** `src/sidecar.ts:66-69`, `src/sidecar.ts:294-306`, `src/sidecar.ts:312-327`.

`commitLocal()` ignores failure from `git add` and returns `false` for both “nothing changed” and commit failure. Both `push()` and `sync()` ignore the return. If an index lock, hook, permissions problem, or commit configuration rejects the commit, `git push` can successfully push the previous HEAD and sync returns `{ pushed: true }` while the new events remain dirty and local.

The one-button sync is explicitly load-bearing; a false success is worse than an explicit retryable failure because the reviewer believes their finding reached the team.

**Recommendation:** distinguish clean/no-op from add/commit failure, include Git's error, and refuse to report a successful send while relevant sidecar changes remain uncommitted.

### P1 — Compatibility metadata is mutable and relabels historical events

**Evidence:** `PROPOSAL-shared-review-state.md:614-617`, `src/eventlog.ts:38-62`, `src/sidecar.ts:85-108`, `src/sidecar.ts:193-200`, `src/sidecar.ts:269-281`.

The proposal requires every pushed event to carry the anchor/hash/grammar compatibility tuple. `LogEvent` carries none of it. Instead, `ensureSidecar()` overwrites one “current” manifest per principal on every run. When a principal upgrades, their manifest now claims the new scheme while their immutable historical events remain in the same shard under the old derivation. A teammate can therefore fold old anchor ids as current and silently mis-target or orphan them. Missing and malformed manifests also fail open: remote parsing skips them without tying valid provenance to the actor shards being merged.

Grammar mismatch is unsafe under the current alternative too. It is only advisory, while body hashes encode `HASH_SCHEME` but not grammar identity. Two grammars can tokenize unchanged code differently under the same `h2:` prefix, so the reader reports real-looking code drift rather than `unverifiable`.

**Recommendation:** stamp each event with the complete compatibility tuple or an immutable writer-generation manifest id, and refuse incoming generations without valid compatible provenance. If grammar mismatch is allowed, grammar identity must participate in hash comparability; otherwise refuse it before merge as the proposal specifies.

### P1 — Shared state bypasses the required `store.ts` materialized-view seam

**Evidence:** `PROPOSAL-shared-review-state.md:287-289`, `PROPOSAL-shared-review-state.md:568-579`, `src/ops-shared.ts`, `src/shared-docs.ts`, `src/ops-shared.ts:553-573`.

The intended design puts the event log behind `store.ts` and folds it into SQLite so existing ops/frontends consume shared state. This branch instead builds a parallel `ops-shared` read model. A teammate can sync a doc or note, but ordinary outline, `get_node`, graph, flow, coverage, Bug, and triage operations remain blind to it. Ordinary `document()` writes remain local, while bulk publication only considers whether a node id exists and does not propagate later local versions.

The proposal shares docs nodes, versions, **and edges**, but the shared-doc log has only version/accepted-hash events and `publishLocalDocs()` never reads the graph. Process/step/touches relationships therefore cannot power the product's normal graph and flow views. Bugs and triage remain local for the same structural reason; `finding.promotedToBug` stores only a string, and `finding.assigned` has a fold case but no writer.

**Recommendation:** implement the sidecar as a storage/materialization concern behind the existing seam, or explicitly revise the spec and product contract to describe a separate catalogue. Add event-kind reachability and integration tests proving synchronized state appears through the ordinary ops surfaces.

### P1 — Shared MCP actions normally lose the required model attribution

**Evidence:** `src/mcp.ts:701-756`, `src/mcp.ts:869-885`, `src/mcp.ts:920-922`, `src/identity.ts:82-96`, `src/ops.ts:2708-2714`, `src/ops.ts:2769-2774`.

Shared MCP schemas do not accept `model` or `harness`, and initialization metadata is not used to populate them. MCP only marks the session as agent-authored. Unless the server was manually launched with `CODEMAP_AGENT_MODEL`, shared finding and corroboration events have no model, defeating the proposal's two-level attribution and later model reliability analysis. Annotation mirroring similarly discards the actor/model already resolved by `annotate()` and resolves a new environment-only actor.

**Recommendation:** bind model/harness from trusted MCP session initialization (with a per-call override only if the client supplies it), thread the resolved Actor through mirrors, and test the ordinary launch path rather than only environment-populated identity.

### P2 — `outcome` receipts do not enter the human acknowledgement queue

**Evidence:** `PROPOSAL-shared-review-state.md:187-192`, `src/shared-findings.ts:377-386`, `src/shared-findings.ts:566-575`, `src/ops-shared.ts:121-125`.

`reportOnFinding()` promises that a person still has to close the item, but `ackQueue()` does not consider `f.outcome`. An unpromoted and uncorroborated issued finding can therefore receive `fixed`, `answered`, or `declined` and disappear from the default human queue even though only the human can accept the result.

**Recommendation:** include outstanding outcomes in `ackQueue()` (or record an explicit pending acknowledgement that is cleared by the human transition).

### P2 — Corroboration from different models under one principal overwrites itself

**Evidence:** `src/shared-findings.ts:330-341`, `src/identity.ts:128-136`, `PROPOSAL-shared-review-state.md:145-163`.

The fold deduplicates corroboration solely by `actor.principal`. If the same person asks two different models to review a finding, the second verdict replaces the first, including a confirm/refute disagreement. This destroys the model-level history that `Actor.via.model` was introduced to retain and prevents the proposed long-term reliability analysis. Independence is already computed separately by principal, so keeping both entries would not falsely make them independent human votes.

**Recommendation:** key the replaceable opinion by the full acting identity appropriate to a review session (at minimum principal plus model/harness), while continuing to derive `independent` from distinct principals.

### P2 — Workspace sidecar configuration and universe identity are discarded

**Evidence:** `src/workspace.ts:46-78`, `src/sidecar-config.ts:42-44`, `src/sidecar-config.ts:53-96`.

`loadWorkspace()` parses and returns the manifest's resolved `sidecar`, but no production code consumes `ws.sidecar`; shared ops rediscover it by walking upward from each repository for at most four levels. A valid manifest can list an absolute universe elsewhere on disk (or one nested more deeply), yet that universe reports “no sidecar configured.”

Shared scoping also ignores the workspace's explicitly unique universe id. For repositories without a GitHub origin, `universeKey()` falls back to the directory basename. Two gitless/non-GitHub universes named `api` in one workspace therefore share a sidecar namespace and cross-contaminate docs, notes, and PR findings.

**Recommendation:** thread the loaded workspace's sidecar path and universe id into the per-universe context used by shared ops. Use origin slug only as a single-repo fallback, not in preference to an explicit workspace identity.

### P2 — Bulk doc publication is not resumable within a node

**Evidence:** `src/ops-shared.ts:553-576`.

`publishLocalDocs()` decides work at node granularity: once `readDocs()` contains a node id, that node is skipped. It then emits that node's historical versions one at a time. If the process stops after the first of several versions, the next run sees the node and permanently skips every remaining version while reporting it as already shared.

**Recommendation:** compare stable source-version identities, or append a node's backfill batch atomically enough that a retry can identify and emit only missing versions.

### P2 — Retirement rationale is validated and then discarded

**Evidence:** `src/ops-shared.ts:519-550`.

The operation refuses an empty rationale because a reasonless tombstone is indistinguishable from a mistake, but the emitted doc version contains no rationale. The rationale exists only in the transient return object and is lost to every later reader.

**Recommendation:** persist the rationale (and retiring actor is already on the event) as tombstone metadata and display it wherever the removed version resolves.

### P2 — The embedded shared-notes UI hides failures and clears failed replies

**Evidence:** `/working/vdx-web/FRAMEWORK.md` (`createTask` error handling), `web/shared.js:300-327`, `web/shared.js:159-174`.

`SharedNotesPanel` uses `createTask()` but never reads `taskError(this.load)`. Its template treats every `d.error` as the normal no-sidecar case, so transport failures, malformed responses, and server defects all render as an empty panel. `answer()` clears the user's draft even when the API returns `{ error }`; the finding composer clears its draft before awaiting the POST. A failed write therefore both disappears and destroys the text the reviewer wrote.

**Recommendation:** distinguish the expected no-sidecar result from operational errors, render task/API errors, and clear drafts only after a confirmed successful response.

### P2 — Unvalidated scope keys permit path traversal outside the sidecar layout

**Evidence:** `src/mcp.ts:692-714`, `src/serve.ts:275-294`, `src/sidecar-config.ts:99-101`, `src/shared-findings.ts:150`, `src/eventlog.ts:97-101` and `src/eventlog.ts:136-138`.

PR identifiers are accepted as arbitrary strings and interpolated directly into a filesystem scope. With enough `../` segments, `path.join()` normalizes a finding shard outside its intended universe/scope, after which reads and appends operate there. The server is loopback-only by default, which limits remote exposure, but malformed or hostile MCP/HTTP input can still create/read NDJSON in unintended directories accessible to the process.

**Recommendation:** parse PR inputs to a canonical numeric id before building the scope, and validate every externally influenced path component with a single safe-segment helper (or encode/hash it).

### P2 — Same-principal multi-machine events break the vector clock's premise

**Evidence:** `src/eventlog.ts:235-243`, `src/eventlog.ts:254-299`, `src/shared-findings.ts:242-245`, `src/sidecar.test.ts:104-116`.

The vector is keyed by principal and implicitly makes the previously folded event for that principal a causal parent through `ownLast`. The implementation also explicitly supports one principal writing concurrently from two machines. Those writes are not causally related, but after a union merge fold order fabricates an edge between them. Concurrent same-person revisions can silently become id/clock-based last-write-wins, and a third party who saw only one machine's branch can be inferred to have seen both.

**Recommendation:** separate the human principal from a stable writer-generation identity. Shard/vector by writer generation while using principal for attribution and independence, or preserve exact causal reachability instead of reducing it to one counter per principal.

### P2 — Shared mutations can report success for events the fold permanently ignores

**Evidence:** `src/ops-shared.ts:75-146`, `src/shared-findings.ts:279-308`, `src/shared-findings.ts:398-405`, `src/serve.ts:275-301`.

Most shared writers do not verify that the finding exists. Corroborating, promoting, commenting on, or recording publication for `f_typo` appends an event and returns `{ok:true}`, but the fold encounters it before any creation and discards it forever. `shareFinding()` can similarly return an id for blank text that its own fold rejects. The untyped HTTP path can pass an invalid lifecycle state; a human clears the write-time gate, receives success, and the fold drops the invalid value.

**Recommendation:** validate the current entity and complete payload before appending, and return the post-fold entity/version so a claimed mutation is demonstrably visible.

### P2 — One sidecar clone has no lock shared by web, MCP, CLI, and universes

**Evidence:** `src/serve.ts:263-269`, `src/mcp.ts:905-908`, `src/lock.ts:18-31`, `src/cli.ts:537-538`.

Git's non-fast-forward rejection arbitrates different clones; it does not serialize two processes operating on the same clone's index, worktree, and merge state. The HTTP path deliberately takes no lock, MCP locks the individual universe's `.codemap` rather than the shared sidecar, and CLI sync takes none. Two universes sharing one sidecar also take different locks. Concurrent Git operations can hit `index.lock` or leave work outside the commit one caller reports as sent.

**Recommendation:** add a local lock keyed by the resolved sidecar root for Git operations and shard appends. This does not conflict with the proposal's rejection of a cross-machine distributed lock.

### P2 — Sync's received/sent counters do not describe accepted shared events

**Evidence:** `src/sidecar.ts:205-221`, `src/sidecar.ts:294-327`, `src/eventlog.ts:165-183`, `src/cli.ts:212-217`.

`countEvents()` counts raw nonblank lines, including malformed and duplicate records that reads discard. Events received by a pull during push retry are omitted from the top-level `gained` result, and every successful no-op push reports `pushed:true`/“sent yours.” Even after commit failure is fixed, these counters can still give a false account of what changed.

**Recommendation:** count valid unique accepted event ids before/after the full operation, and distinguish a newly delivered local commit from a successful no-op push.

### P2 — Bulk note migration invents direct-human authorship

**Evidence:** `src/ops-shared.ts:347-373`, `src/ops-shared.ts:319-323`, `PROPOSAL-shared-review-state.md:105-136`.

`publishLocalNotes()` acknowledges that legacy author strings cannot be resolved, then emits every imported note as the current runner's Actor. Readers display that person as the author with no migration provenance. Old agent-authored or differently authored notes can therefore appear as direct statements by whoever ran the migration.

**Recommendation:** preserve explicit legacy/unattributed migration provenance rather than inventing authorship; never imply the runner personally made the original claim.

### P2 — Human-only doc retirement has no usable human client

**Evidence:** `src/ops-shared.ts:519-525`, `src/mcp.ts:777-781`, `src/mcp.ts:920-922`, `web/shared.js:388-395`, `web/shared.js:424-428`, `src/cli.ts:207-211`.

`retireSharedDoc()` correctly refuses agents, but MCP always marks the process as an agent. The CLI exposes no retirement command, and the docs page offers only confirmation. A raw HTTP action exists, but no UI invokes it. A legitimately removed doc therefore has no supported human path to perform the closure the system requires.

**Recommendation:** expose retirement, including its rationale and safety checks, in an explicitly human UI/CLI surface.

### P2 — Central shared-review state is largely undiscoverable in the web UI

**Evidence:** `web/app.js:690-700`, `web/app.js:748-754`, `web/app.js:936`, `web/app.js:1013`, `web/app.js:3445-3544`, `web/app.js:3572-3574`, `src/serve.ts:181-188`.

Shared findings, peers, and docs routes are registered, but the dashboard, header, PR inbox, and PR story do not link to their entry points. Node-target shared notes are mounted only on AnchorPage, not NodePage. The browser never calls the submitter-replies or shared-walkthrough routes, and the PR story renders only its local walkthrough. The human acknowledgement queue and information the proposal says reviewers must read are effectively deep-link/API-only.

**Recommendation:** integrate shared queue/replies/walkthroughs into the ordinary PR workflow, link the docs catalogue from normal navigation, and mount shared notes for both supported target kinds.

### P3 — Peers navigation temporarily labels old data as the new universe

**Evidence:** `web/shared.js:253-258`.

`SharedPeersPage.propsChanged()` starts a new load without clearing `d`. When the router reuses the component, the breadcrumb changes immediately while the old sidecar/peer list remains until the request finishes; a failed request can leave the mismatch in place.

**Recommendation:** clear the old payload on parameter change, as the other shared pages already do.

## Positive observations

- The append-only per-principal shards, deterministic sorting/deduplication, causal heads, and contested-scalar residue are a strong basis for collaboration.
- The branch handles torn final lines and appends after torn lines deliberately, and compatibility distinguishes unverifiable hash changes from anchor-identity incompatibility.
- Identity attribution (`principal` plus `via`) is materially better than legacy author-string heuristics.
- The web API map, check-JS setup, route smoke coverage, and broad `taskError` cleanup elsewhere are good defenses against UI/backend drift.
- No new runtime dependency was added.
