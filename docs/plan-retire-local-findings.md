# Plan: retire the local-finding code path

> **Kind: active plan** — decided, not yet built. The work queue.
> ready and deliberately soaking. The next substantial change.

**Status: ready, and deliberately SOAKING.** Written 2026-08-25 while the evidence was in
hand and parked until the finding lifecycle stopped moving; unblocked 2026-08-26 by the
decision in "Comment push is a fallback" below, which was the one question everything
waited on.

Not started on purpose: **use codemap for a few days first.** Every section here came from
measuring real use rather than from reading the types, and the last two sessions each found
lifecycle cruft that changed the design — `partial` had nowhere to live, the ack gate was
doing two opposite jobs, `toFinding` was dropping a vouch. This is a large mechanical change
and it should land on a target that has stopped moving, which is a claim about the next few
days of use, not about the code today.

Read `docs/plan-finding-parity.md` first — it is the field-by-field diff this plan
assumes, and its § 5 is the origin of the push-state table below.

## Why

There are two implementations of one thing. Every finding op has a fold-owned branch and
a local branch, and the local one is not a thinner version of the other — it is a second
implementation that drifts. Measured 2026-08-25, all of it found by review rather than
by anything failing:

- `closeLocalFinding` appended a verdict without dedupe; `reviseLocalFinding` deduped by
  PRINCIPAL, which clobbers the same person's other model's verdict — the exact thing
  `reviewerKey` exists to prevent; only `corroborateLocalFinding` matched the fold. Two of
  the three hardcoded `independent: false`, so a genuinely independent confirmation read
  as self-agreement on the field the queue is ranked by.
- The `applied`/`refused` envelope, the honest `ok`, the `fixed → fixed-on-branch`
  inference and the severity gate all existed ONLY on the fold-owned branch, while the
  tool descriptions promised them unconditionally.
- `closeAssignment` accepted `remediation` and dropped it silently — an annotation has no
  such field.

All four are now fixed. That is the argument: they were fixed one at a time, by three
separate reviews, and the next one will be found the same way. **"Local" is not an edge
case** — it is every finding before `unify-findings`, and everything on a machine with no
sidecar.

The stronger argument is the one the surfaces made. Findings reached the pull-request page
only through a collapsed panel, while local ANNOTATIONS rendered inline at their line — so
raising a finding from the diff put nothing where it was typed. The good surface was
attached to the store being retired. (Fixed since; but that is the shape of the problem.)

## The claim: a store with no sidecar loses nothing

Three facts, each verified in the code rather than assumed:

1. **The event log is plain files.** `eventlog.ts` contains no git call at all. Shards are
   NDJSON under a directory; git is the TRANSPORT, not the store.
2. **A sidecar with no remote is already supported, deliberately.** `sidecar.ts`:
   *"`false` means there is no remote, which is not an error: a sidecar with no remote is
   a perfectly good local one and the whole design works offline."*
3. **`resolveSidecar` already accepts a bare directory** as the zero-configuration form:
   *"a directory named `sidecar`, which IS the sidecar — the zero-configuration case, for
   one person trying it out."*

So "no sidecar" becomes "a sidecar nobody else pulls from": `.codemap/sidecar/`,
`git init`, no remote. One write path (`emit` → fold → projection), one read path, every
finding carrying a `source_scope` and an `origin`.

**The migration verb already exists.** `unify-findings` replays local rows into a log
preserving ids and history, and refuses anything whose replay would forge attribution. It
was built to publish to a TEAM; pointed at a local log it is the retirement.

## Comment push is a fallback, and stays available everywhere

`docs/plan-finding-parity.md` ends on one question — does codemap post raw comments to
GitHub at all? — and this plan could not start until it was answered. **It does.** The
reason is not the finding lifecycle, it is the audience: *the pull request's author may
not use codemap*, and a raw comment is the only channel that reaches them.

That inverts the current gate and it must be fixed BEFORE the default sidecar lands, not
after. `planPrPush` disables comment push whenever `resolveSidecar(root)` is non-null
(`pr-push.ts:667`), and `multi.ts:31` uses the same test to decide whether to offer a pull
button. Give every store a sidecar and that predicate stops meaning "there is a team" —
it means nothing at all, and comment push turns off **universally**, which is the exact
opposite of the decision. Three guards replace it:

1. **No blanket disable.** The `commentPush` block goes. `alreadyPosted`, folded from the
   log, is what stops two reviewers double-posting — the guarantee the blanket gate was
   standing in for — with the honest limit it always had: it only works if you PULL before
   planning.
2. **A warning in the web UI, not a refusal**, when the sidecar has more than one
   principal. The text is the argument the old gate made silently: the team already reads
   these findings on the sidecar, so a raw comment makes a second copy that the author
   replies to and nobody folds back. A person can weigh that; the code cannot.
3. **An agent may not push unprompted on a multi-user sidecar.** `codemap pr-push <pr>
   --confirm` is the ONLY agent-reachable push — there is no MCP tool and the web POST is
   a human action — so the guard has exactly one site. Refuse it for an agent actor when
   the sidecar has peers, unless the run carries an explicit `--requested-by "<who asked,
   and what they said>"`, recorded on the push row.

   Same shape as `DefectContext`'s required discriminator, and the same honest limit,
   recorded here so nobody rediscovers it as a bug: a required flag makes the unmarked
   shape unrepresentable, but it cannot prove a person actually asked. Intent is not
   observable.

**The multi-user predicate is `readManifests(cfg.path)` with more than one distinct
`principal`** — the same read `codemap peers` already does. Local files, no network. Two
things to state rather than discover:

- A store that has never pulled sees no peers, so both guard (2) and guard (3) UNDER-fire
  there. Safe for the warning, a real bypass for the agent gate. Do not describe it as
  enforcement.
- A brand-new local sidecar has exactly one manifest — yours — so solo is the default and
  push is unguarded. That is the point of the whole change.

## Promotion is the raise, and it has to become a person's act

**A pushed comment cannot be taken back.** So the gate is not "what did triage conclude"
but "did a person decide to send this": `f.promotion && !isClosed(f.state)`. Nothing else
is pushable. `escalated` retires into it, `PUBLISHABLE`/`disposition` retires with the
annotation store, and `promotion` stops being a passive latch — it becomes the raise
button, which is the act the UI never had a word for.

That is a bigger change to `promotion` than it looks, and three things have to move with
it. All three are measured, on `/working/Acme.API` and `/working/Acme.React`, 285 findings
and 118 annotations between them:

- **Promotion is not enforced as a person's act, anywhere.** `promoteFinding`
  (`ops-shared.ts:441`) has no `isAgentActor` check — `declineFindingAsk` twelve lines
  above it does — and the fold sets `f.promotion` from whatever actor the event carries
  (`shared-findings.ts:655`). It is a person's act by REACHABILITY only: the web POST is
  the sole caller and there is no MCP tool, the same arrangement `heal` documents. Once it
  gates publication that is not enough, and **the check belongs in the fold**: a
  write-time check protects the honest writer and nobody else, and a teammate's agent
  promoting through the log would fold in here regardless. `findingTier`'s existing
  comment — *"it outranks a verdict because a person did it"* — becomes true rather than
  assumed.

  The agent's route already exists and finally has a purpose: `request_human(action:
  "promote")` is in `ASKS`, and the person's grant of that ask IS the raise.

- **Promotion is currently rare: 3 of 285 findings, none by an agent.** So on the day this
  ships, essentially nothing is pushable until people start promoting — including the 60
  findings already on GitHub, which is fine (they are `already-pushed`) and the rest of the
  backlog, which is not obviously fine. Say so in the release note rather than letting it
  read as a broken button.

- **`toFinding` drops `escalated`, and under this rule that becomes a real defect.**
  `findings-migrate.ts:85` maps sixteen fields and not that one. Today the loss is
  invisible because promotion gates nothing and push reads annotations; after the cutover
  it is a person's vouch silently deleted, leaving the finding unpushable. **20 records
  still carry it** — 6 findings, 9 pointers, 3 notes, 2 questions — so this is fix-forward
  plus a small backfill, not archaeology. Map `escalated → promotion` in `toFinding`, and
  in `replay` so `unify-findings` carries it too.

**The `--only` override goes, and the schema is why.** `pushVerdict`'s `filter.ids` escape
currently OUTRANKS the disposition default, and `schema.ts:509` documents the case: *"a
refutation the human already raised on the PR is worth one line closing it out, which
saves the submitter defending a non-issue."* Under this gate `--only` NARROWS within it
instead of opening it, and a closed finding is unpushable however it is named.

Not a reluctant trade. A GitHub post is an ESCAPE HATCH — the channel for a submitter who
does not use codemap — so the bar for sending one is deliberately higher than the bar for
concluding something. And the combination the escape needed cannot be said here anyway:
`findingTier` reads state BEFORE promotion (`shared-findings.ts:395-402`), so a promoted
finding that is refuted or resolved comes out `doubted`/`settled` and the latch is
invisible. There is no shape in this schema meaning "settled, but send it". The closeout
case is served by replying on the thread that already exists.

## Questions stay, on the same gate

`planPrPush` gates on DISPOSITION and deliberately not on kind, so it publishes `question`s
too, and `renderAnnotation` has a `**Question** — ` marker built for it. Findings are one
kind; notes, questions and pointers stay annotations (`docs/sidecar-architecture.md`
settles that). Asking the submitter something on their pull request is worth keeping, so
push keeps one narrow annotation branch — **`kind:"question"`, promoted, not resolved** —
and that branch is the last one. Say so at its site.

Measured, because "keep it" is only proportionate if it is used: **11 questions across the
two universes, 2 raised, 1 ever posted.** Small, real, and cheap to keep.

A pointer needs no branch: `promote_annotation` already turns one that proves to be a
defect into the finding, keeping its id, and it is promotable from there.

`escalated` is the raise mark on an annotation and should be renamed `promoted` there, so
there is one vocabulary rather than two words for the act. The blob is rewritten wholesale
by `writeAnnotations`, so it is a read-map-write over 118 records.

## Push state: what moves to SQLite, and what does not

Push state is genuinely local: it is this machine's record of what it sent to GitHub under
this person's account, and no clone can act on somebody else's copy of it. It therefore
belongs in the store, not the log — and the fields split cleanly in two, which is what
`plan-finding-parity.md` § 5 measured.

**Already logged, nothing to build:**

| annotation field | canonical home |
|---|---|
| `withdrawn` | `FindingState` has `"withdrawn"` (`shared-findings.ts:41`) |
| `postedRef` | `SharedFinding.posted` (`ExternalRef`), plus `f.pr` for the PR it names |
| `escalated` (the raise) | `SharedFinding.promotion` — see "Promotion is the raise" |
| `disposition ∈ PUBLISHABLE` | retired: the gate is `f.promotion && !isClosed(f.state)` |

**Not logged, and this is the table.** One row per finding per pull request, keyed
`(pr, finding_id)` on the same argument as `ix_findings_identity`: one id can be a finding
on two pull requests, and a comment sent to one is not thereby answered on the other.

The raise is NOT here. `promotion` is logged, and a person's decision to send a finding is
exactly the kind of act the sidecar exists to carry — putting a second copy in SQLite would
be the dual-write `publishStateOf` already refuses to do. What is left is placement,
attribution and receipts, and `publish_path` is rarer than it reads: **3 records across
both live universes** set it. It stays because it is the only escape for a finding about
code the branch never touched, not because it is load-bearing volume.

```sql
CREATE TABLE IF NOT EXISTS finding_push (
  pr TEXT NOT NULL, finding_id TEXT NOT NULL,
  -- intent, before the fact: where a person wants it to land
  publish_path TEXT, publish_line INTEGER, publish_attribution TEXT,
  -- receipt, after the fact: the local half of `posted`
  posted_at TEXT, posted_key TEXT, posted_url TEXT,
  requested_by TEXT,                          -- guard (3)'s record, when an agent pushed
  PRIMARY KEY (pr, finding_id)
);
CREATE TABLE IF NOT EXISTS pr_push_review (
  pr TEXT PRIMARY KEY, review_url TEXT, viewed_paths TEXT, at TEXT
);
```

The second table is the half of `PushRecord` that is not per finding. Split rather than
denormalized because a viewed-only publish writes it with no comments at all
(`pr-push.ts:972`), and that write currently has to pass an empty `annotationIds` and rely
on `writePush`'s union to not clobber.

**Migrating the existing `pr_push` blob is a straight copy**, which was not obvious and is
worth the line: `migrateLocalFindings` preserves `a.id` verbatim (`findings-migrate.ts:159`,
and `readFinding(root, a.id)` is its own dedupe check), so a migrated finding's id IS the
annotation id the blob already lists. **Checked on live data: of 60 pushed ids, 55 are now
finding ids, 5 are still annotations, none are orphaned.** The blob is only blind to
findings `report_defect` created natively — which is every finding since the create tap
shut, and exactly why the table is needed.

## Solo → team: the transfer, and the thing that shadows it

Somebody starts alone on the default `.codemap/sidecar`, files findings for weeks, then
joins or forms a team. That transition is not covered by `unify-findings` — that verb moves
local ROWS into a log, and here everything is already in a log, just the wrong one. It is a
log-to-log move, and the plan has to say what it is.

**The store side needs nothing, which is worth checking rather than hoping.** Verified:

- **Nothing persists the sidecar path in the database.** `shared_scope` keys on the
  universe-prefixed SCOPE (`acme/api/findings/pr-264`), which is identical whichever
  sidecar holds it.
- **`sidecarIdentity` — the sidecar's realpath — is hashed into `scopeFingerprint`**
  (`materialize.ts:107`). So swapping the sidecar invalidates every fingerprint and the
  next read refolds from the new log. Self-healing; not a migration step.
- **Shards are per-WRITER files** (`shardFor`, `eventlog.ts:176`). A solo user's history
  arriving in a team log is structurally the same event as a teammate joining. There is no
  "my repo" the log would have to rewrite.

**So the transfer is: clone the team sidecar, copy the solo shards in, commit, push, and
RETIRE the local one.** The writer id lives in `.git/codemap-writer` and is not copied, so
the new clone mints a fresh id while the copied shards keep the old writer's name — which
is correct: the old writer is a decommissioned clone whose history is complete and
prefix-closed.

**It is a MOVE, not a copy, and that is the one hard rule.** Two live clones sharing a
writer id is precisely the fork `writerPrev` exists to detect, and `docs/fork-repair.md` is
the price of getting it wrong. Pushing the solo sidecar at the team remote is also not the
route — unrelated root commits.

### Hazard 1: the default would SHADOW every team sidecar

`resolveSidecar`'s precedence is env → `.codemap/sidecar` pointer-or-directory → workspace
manifest. **The directory beats the manifest.** Step 6 makes `.codemap/sidecar` the
auto-created default, so every store acquires that directory — and it would then shadow
every team sidecar configured in a manifest, silently, for everyone, not only for someone
migrating. That is this project's recurring defect exactly: two stores, and which one you
get decided by config nobody looked at.

**The default must sort LAST**, after the manifest. But it cannot simply be appended,
because a directory somebody deliberately placed at `.codemap/sidecar` still legitimately
beats the manifest — that is the documented zero-configuration form. So the auto-created
one has to be distinguishable: mark it in its own manifest when creating it, and sort only
the marked one last. Fold this into step 6; discovering it afterwards means every team
member's reads have been served from their own private log.

### Hazard 2: `universeKey` drift, which is what actually loses findings

The scope prefix is `universeKey(root)` — the CODE repo's origin slug, else the directory
basename (`sidecar-config.ts:88`). Someone working alone on a clone with no origin is
writing under `acme-api`. The afternoon they push the code to GitHub and join the team, the
key becomes `acme/acme.api`, and **every scope they have already written is orphaned under
the old prefix**: findings intact, findable by nobody, and no error anywhere.

Solo→team is precisely when a code repo acquires an origin, so this is not hypothetical. It
is the same mechanism the oracle leans on from the other side — *"All clones share the
directory basename `acme-api` on purpose: a local origin is never a GitHub URL, so
`universeKey` takes its fallback"* — and the fallback that makes the oracle work is what
strands a real user here.

This is the argument for making the transfer a VERB rather than a documented copy-paste:
it has to compare the universe key it is moving FROM against the one now in effect, and
either rename the scope directories or refuse and say which two keys it saw. Silent is the
one thing it cannot be.

## What deletion this earns

- `writeLocalFinding`, `localFindingWrite`, and every `*LocalFinding` op.
- Every `!f.origin` branch, including the split-store gate in `sharedFindings` and the
  `unmigrated` reporting around it.
- `migrateLocalFindings`' destination distinction (it still has a job: annotations → the
  log).
- The duplicated predicates introduced to keep the two halves honest: `mayRerate`,
  `recordVerdict`, the second `applied`/`refused` envelope.
- The `whichRecord` dispatch collapses to "finding or bug", not "which store".
- `readPushes`/`writePush` and the `pr_push` meta blob.

## `pr-push.ts` is the bulk of the work

It is `Annotation`-typed end to end — `attributionOf`, `labelOf`, `lastCommentAuthorIsAgent`,
`renderAnnotation`, `isElected`, `publishStateOf`, `pushVerdict`, `placeAnnotation`,
`buildComments`, `planResolveSync`. Retargeting them onto `SharedFinding` + its push row is
mechanical given the mapping above, with two things that are not:

- **`revisions` is the same shape on both** (`{at, by, was}`), so `lastCommentAuthorIsAgent`
  ports directly; use `isAgentActor(f.author)` rather than the `"agent"` string prefix,
  which was the annotation store's provenance convention.
- **`citedLine`, `placeAnnotation` and the `evidence-moved` witness gate are entity-agnostic**
  and should come through untouched. They are the parts with real logic in them; do not
  rewrite them while retyping.

## Order

1. **Fix the gate first, on today's code.** Replace the `commentPush` disable with the
   three guards. This is independently correct — the current behaviour already denies a
   solo-with-sidecar user the fallback channel — and it must not be attempted after the
   default sidecar exists, when every store looks like a team.
2. **Make promotion a person's act, in the fold**, and map `escalated → promotion` in
   `toFinding` and `replay`. Before the push gate reads it, so no window exists where the
   gate is live and the vouch is still being dropped.
3. Land `finding_push` + `pr_push_review`, migrate the blob, and cut `pr-push.ts` over to
   findings + the one question branch. Run the PR e2e suite — the only thing that
   exercises a real repo.
4. Verify the two sidecar obstacles on a scratch universe (`git clone --local
   --no-hardlinks`, no `origin`): `git init` under `.codemap/`, `ensureSidecar` accepts it,
   and the writer id persists across processes. Both look already handled by reading —
   `ensureSidecar` inits then re-checks it is its own repo root (`sidecar.ts:254-265`), and
   `writerFor` persists in the git dir (`eventlog.ts:250`) — but a claim about identity is
   not one to take from a read.
5. Teach `resolveSidecar` a default: no env var, no pointer, no manifest →
   `.codemap/sidecar`, created on first write, **sorting after the manifest and marked as
   auto-created** so it cannot shadow a team sidecar (hazard 1 above). This is the whole
   behavioural change; everything after it is deletion.
6. Run `unify-findings` on a store with local rows and the new default, and confirm the
   rows are adopted rather than duplicated (`materialize.test.ts` already covers adoption).
   Note `unifyFindings` currently errors on a missing sidecar — that branch becomes dead.
7. Delete the local ops, one verb at a time, leaning on the tests that already assert both
   branches behave identically — `finding-triage-surface.test.ts` was written for exactly
   that comparison and is the safety net for this change.
8. Only then simplify `whichRecord` and the `!f.origin` readers.
9. **The solo→team transfer verb.** Independent of the retirement and can land any time
   after (5), but it is the transition the default creates, so it is not optional: move the
   shards, retire the source, and refuse loudly on a `universeKey` mismatch.

## The two obstacles, and neither is large

- **The writer id lives in the sidecar's GIT DIRECTORY**, and `eventlog.ts` says a root
  with no resolvable git dir "gets an id for the life of the process only". A local log
  must therefore be `git init`-ed, not merely a directory — otherwise every process is a
  new writer, which is precisely the fork `writerPrev` exists to detect.
- **`ensureSidecar` refuses a sidecar that resolves to the ENCLOSING repository** (it
  checks, having once pointed every git call at the user's own repo). `.codemap/` is
  gitignored, so `git init` inside it yields a genuinely separate repo — but that is a
  claim to verify with `git rev-parse --git-dir` from inside the candidate, not to assume.

## What this does NOT propose

Retiring **annotations**. Notes, questions and pointers are a different entity — symbol-
scoped knowledge that outlives a branch — and `docs/sidecar-architecture.md` settles that
they keep their own table. The audit in `docs/finding-event-shape-audit.md` measured what
that store actually holds and found it healthy once the pre-canonical findings were
excluded from it. This plan is about the FINDING lifecycle only.
