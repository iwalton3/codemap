# Proposal: shared review state — the sidecar

> **Kind: archive** — superseded or finished. Do NOT plan from it; read it only for history.
> **SUPERSEDED by `docs/sidecar-architecture.md`**, which says so itself and wins wherever they disagree. Still cited from source for its long-form arguments, which is why it is kept rather than deleted.

Status: **PROPOSAL — not approved.** Written 2026-08-21, from a design session
about running PR review across a team where every reviewer has codemap and
several agents review alongside them.

Does not supersede `docs/proposal-committed-docs.md`. That document answers a
different question — docs that belong to the codebase, versioned by checkout —
and its conclusion that review marks stay out of git is not what this reverses.
What this reverses is narrower: review marks stay out of **the code repo's** git,
and go into a repo of their own.

---

## The problem

Review is about to become a team activity, and none of the state it produces is
shared. A finding lives in one person's `.codemap/codemap.db`, which is
gitignored on purpose. The only channel between two reviewers today is GitHub,
and GitHub can only carry the half of a finding that is addressed to the
submitter.

Two things have to become true:

- **Findings are shared.** One person's sweep — or their agent's — is visible to
  everyone else's codemap, including everyone else's agents.
- **Findings are attributable, on two levels.** *Who* caused this to exist (always
  a person), and *what* produced it (a human, or an agent, and which model).

And one thing has to stay true: **codemap becomes load-bearing for code review.**
That raises the bar. A sync that loses a finding, or silently picks a winner
between two people's edits, is worse than no sync at all.

## What is shared, and what is not

This table is the load-bearing decision in the whole document. Everything else
follows from it.

| Layer | Home | Why |
|---|---|---|
| Findings, threads, corroboration | **sidecar** | the point of the exercise |
| Reported bugs (`Bug`) | **sidecar** | same reason, and the entity needs the refactor more — see Decision 5 |
| Triage (stakes/complexity/tripwire) | **sidecar** | a property of the code, not of the reviewer; already ratcheted |
| Docs (nodes, versions, edges) | **sidecar** | shared knowledge; PR churn is not wanted in the code repo |
| Walkthroughs | **sidecar** | one person maps the PR, everyone reads it |
| **Reviews — viewed/signed** | **local, unsynced** | see below |
| Anchors, snapshots, the index | **local, derived** | rebuildable; ~2MB per PR side |

**Keeping attestation local is what makes this tractable**, and it deserves to be
recorded as a reason rather than a preference. Merging attestation is the hardest
problem in the set: `accepted[].entries` accumulates per anchor across branches,
and `AcceptanceVia` (`direct`/`replayed`/`reverted`) is resolved by probing
*each user's own local git ancestry*. Two reviewers' accepted-hash sets
converging correctly across a stacked branch chain is a genuinely hard
distributed problem, and it buys little: a sign-off is a statement about what
*you* read.

It also keeps an independent check. Viewed state continues to push to GitHub, so
before clicking merge you can ask the PR itself — not codemap — whether every
file in the diff is ticked. A tool that is load-bearing for review should not
also be the only thing that can audit it.

## Decision 1 — GitHub is not the team channel

`pr-push` stays a feature. It remains the right tool when the other side does
*not* have codemap, which is the case it was built for.

It is not the channel for this workflow, for reasons that accumulated:

- **The push record is per-store.** `pr_push` exists so a re-run cannot duplicate
  a comment someone already replied to. With two reviewers holding separate
  stores, the guard does not see the other person's push — so the second
  reviewer re-posts the first reviewer's findings, and a posted comment cannot be
  un-posted.
- **GitHub cannot host a conversation about the findings that matter most.** The
  schema already records why: a review comment must land on a file in the diff,
  and plenty of real findings are about code the branch never edited, or about an
  **absence**, which has no line anywhere. `publishPath`/`publishLine` are a
  human-picks-the-nearest-file workaround and `BlockedComment` is the record of
  the ones that cannot be placed at all. Absences are precisely the
  event-sourced failure mode this project exists to surface — the projection
  nobody wrote, the handler that never subscribed.
- **The schema already split the audiences.** `text` is "evidence for the map and
  for whoever triages"; `comment` is "for the person who has to fix it, who does
  not want the investigation". Discussion *is* triage. So `text` gets the thread,
  and `comment` is what gets published.

What still crosses to GitHub: viewed state, the review verdict, and resolution
sync. All three already exist and all three are per-user-correct by construction
— the viewed query reads `viewerViewedState`, which is the authenticated
account's own tick, and a tick imports as `viewed`, never `signed`.

> **Once the sidecar exists, GitHub is a projection, not a store.** Nothing is
> ever read back from it as authoritative. `pullViewedFromGitHub` and the resolve
> pull become bootstrap and audit paths. The instinct to "finish" them into
> two-way sync is the thing that would break this.

One inbound exception, read-only: the submitter *will* reply to a promoted
finding on the PR, and that reply is information the reviewer needs.
`fetchReviewThreads` already pages threads and correlates `databaseId` to
`postedRef.commentId`; it needs `body`/`author`/`createdAt` added to the
selection and its `comments(first:5)` cap raised. Pull replies in; never host
the conversation there.

## Decision 2 — Identity is `principal` + `via`

There is no user identity in the system today. `reviews.ts:215` writes
`reviewer: "me"`; `ops.ts:2723` writes `author: "agent"`; `ops.ts:2776` writes
`by: "human"`. Fine for one person, unworkable the moment state is shared — and
the review model's central claim is *about* identity, since "the creating session
may not self-verify" cannot be enforced without knowing who created it.

```ts
interface Actor {
  principal: string;          // ALWAYS a person — gh api user / git config
  via?: {                     // absent = the human acted directly
    kind: "agent";
    model?: string;           // "claude-opus-5" — free string, never an enum
    harness?: string;         // "claude-code", "mcp"
  };
}
```

An agent acts *on behalf of* a principal, so no action anywhere is
unattributable, and "who caused this finding" is answerable even for agent
output. It also makes no-self-verify survive automation: an agent running as
`izzie` cannot independently corroborate `izzie`'s own finding.

Two practical constraints:

- **The model id must be supplied, not guessed.** A model does not reliably know
  its own id; it comes from the MCP client at session start or per call, plus a
  CLI flag/env. Free string, because the model list churns faster than any enum
  would ship.
- **`"me"` / `"agent"` / `"human"` need a backfill decision** across three call
  sites before anything is shared.

## Decision 3 — A finding has three independent axes

The current `Disposition` enum does two jobs at once: `open`/`confirmed` are
lifecycle, while `partial`/`rerated` are verdicts about the report's accuracy.
Splitting them is the actual cleanup.

```ts
// 1. Promotion — a latch. Surfaces to team-wide human attention.
//    Deliberately NOT the same field as postedRef: promotion is a sidecar
//    concept, and it does NOT gate another member's agent from triaging.
promotion?: { at: string; by: Actor };

// 2. Accuracy — a grow-only set, one entry per actor. NEVER collapsed to a scalar.
corroboration: {
  actor: Actor;                                  // carries via.model
  verdict: "confirm" | "refute" | "unsure";
  at: string; rationale: string;
}[];

// 3. Lifecycle — state, plus a DERIVED gate.
state: "open" | "closed" | "contested";
// needsHumanAck = !!promotion || corroboration.some(c => c.verdict === "confirm")
```

The rules, in the vocabulary of the sketch this came from:

| Transition | Who may write it |
|---|---|
| → `issued` | an agent files (default when `via.kind === "agent"`) |
| → `created` | a human files (default), or an agent promotes an `issued` one |
| `issued` → `invalid` | an agent, directly — the only terminal an agent may write |
| anything with `needsHumanAck` → `closed` | **human ack only** |
| a request to refute/resolve | any actor, at any state — enters the ack queue |

That is a ratchet with `created` as the floor for agents, structurally identical
to `triage.ts`'s `ratchet()` — already written, tested and understood. Reusing
the shape is worth more than the code it saves.

Three notes:

- **`needsHumanAck` is derived, never stored.** It is an OR over a latch and a
  grow-only set, so two people computing it from different pulls always agree and
  there is no field for them to race on.
- **Corroboration is never reduced to one value.** The reason for running several
  models is that disagreement is the signal; a scalar `accuracy` field would
  destroy exactly the data being collected. One entry per actor; a re-review
  replaces that actor's own entry. Over time this also answers which models
  systematically refute real findings, which is the failure mode that would
  otherwise erode trust in the queue silently.
- **Agent fix-attestation already exists and is unsurfaced.** `outcome` carries
  `result: "fixed" | "answered" | "declined"`, a `detail`, and a `files[]`
  receipt. It needs to feed the ack queue, not a new field.

Targeted questions need one new value: `assignment.kind: "answer"`. The return
path — `outcome.result: "answered"` — is already defined and waiting.

### Migrating `Disposition`

Every existing value maps, including `accepted`, which the enum's own doc block
already defines as *"real, deliberately not being fixed (a product or
architecture call)"* — a won't-fix, not an ambiguity:

| today | accuracy | lifecycle |
|---|---|---|
| `open` | none | `issued` if agent-authored, `created` if human-authored |
| `confirmed` | one `confirm` from the author | `created` |
| `partial` | one `confirm`, verdict qualified | `created` |
| `rerated` | one `confirm`, severity restated | `created` |
| `refuted` | one `refute` | `closed` (refuted) |
| `accepted` | one `confirm` — it **is** real | `closed` (won't-fix) |

`accepted` and `Bug.status: "wontfix"` are the same concept under two names.
Unifying the machinery should unify that vocabulary too, or the shared ack queue
will show one idea twice.

## Decision 4 — Shared state is an append-only event log

The requirement is not a reconciler for arbitrary concurrent mutation; that is
unbounded, because every new field is a new merge rule and the rules interact.
The requirement is:

> Make conflict **structurally impossible** for almost everything, and make the
> small residue **loud** instead of silently resolved.

Which follows from storing shared state as events rather than records:

```
events/
  pr-264/izzie.ndjson          one line per event, append-only, ONE writer
  pr-264/dana.ndjson
  pr-227/izzie.ndjson
  docs/izzie.2026-08.ndjson
```

```jsonc
{"id":"01H8X…","kind":"created","finding":"f_9c1","actor":{...},"at":"…","text":"…"}
{"id":"01H8Y…","kind":"corroborated","finding":"f_9c1","actor":{...},"verdict":"refute"}
{"id":"01H8Y…","kind":"commented","finding":"f_9c1","actor":{...},"body":"…"}
```

**The conflict-freedom comes from single-writer files, not from one file per
event.** Two actors never write the same file, so git merges by adding or
extending disjoint files and cannot conflict. Current state is a fold over every
line, sorted by event id. That is the entire reconciliation design.

One file per event would give the same property and was the first draft, but it
does not survive contact with Windows: NTFS has a 4KB minimum allocation, so a
200-byte event costs 4KB on disk — and Defender stats every file, and `git
status` stats them again. A busy quarter of review is six figures of tiny files.
This is the Minecraft Alpha chunk-file problem and it takes the same fix Region
files did: bundle many records into few append-only containers. Line-delimited
JSON is the bundling, and file count goes from *O(events)* to
*O(actors × shards)* — tens, not hundreds of thousands.

Three mechanics that follow from bundling:

- **`merge=union` in `.gitattributes` for `*.ndjson`.** Git's union merge takes
  the lines from both sides, which is exactly right for append-only line files
  and covers the one case single-writer sharding does not: the same person
  appending from two machines. Safe because the fold sorts by event id and
  dedupes — union may reorder or duplicate lines, and neither survives the fold.
- **Shard by scope as well as actor.** Findings shard per PR, which is how review
  is scoped and how old work goes cold; docs shard by month. Roll to
  `<actor>.002.ndjson` past a size bound so no single file grows unbounded.
- **A torn final line is expected, not exceptional.** A process killed mid-append
  leaves a partial line. Each line is self-contained JSON with its own id, so the
  fold discards an unparseable trailing line and moves on. It must never fail the
  whole read — a shared store that will not load because someone closed a laptop
  is worse than one that lost the last event.

The materialized view stays incremental: record per file the byte offset already
folded, and re-read only what grew.

Two properties carry it:

- **Total, machine-independent ordering.** A sortable id (ULID-style: timestamp
  prefix, actor, random suffix) means every user sorts identically and folds to
  the same state. That is the convergence guarantee — an op-based CRDT, where the
  fold is the proof.
- **Causality over clocks.** Each event records the highest event id it was
  written knowing about. That gives a causal partial order; the timestamp
  tiebreak then applies only to genuinely concurrent events. Without it, a laptop
  running forty seconds fast silently reorders a refutation ahead of the
  confirmation it was answering.

This is event sourcing, in a tool built to review event-sourced systems, for a
team that already thinks in `command → event → fold`. The mental model needed to
debug a sync problem is one the reader already has.

**The DB does not go away — it becomes the materialized view.** The sidecar holds
events; SQLite holds the fold. Reads stay fast, nothing above `store.ts` changes,
and the seam absorbs the new backend exactly as it absorbed JSON→SQLite.

## Decision 5 — Reported bugs join the same machinery

Drive-by bugs (`Bug`, `report_bug`) are shared team state for the same reason
findings are, and they need the refactor more, because `Bug` is the older and
cruder of the two entities:

- **It has no author.** Not `author`, not `by`, nowhere. Findings at least carry
  `author: string`. A shared bug store with no attribution is worse than no
  shared bug store.
- **`history: string[]` is a degenerate event log** — "free-form log of status
  changes / resolution notes", with no actor, no timestamp and no structure. It
  is precisely the thing Decision 4 replaces, already present in spirit.
- **`status` is flat** (`open`/`fixed`/`wontfix`/`invalid`): no ack gate, no
  corroboration, no way for a second model to weigh in.

What it already gets right is `witnesses`, which is the same
snapshot-the-hash mechanism as reviews and findings.

**Unify the machinery; keep the entities.** Both become event-sourced over the
same `Actor`, the same corroboration set, the same thread, and — the point — the
**same ack queue**. Merging `Bug` into `Annotation` is a large surface for little
gain: a bug targets *several* anchors ("the exact areas") and has no publish
path, while a finding targets one and does. Those differences are real and worth
keeping. Two queues to work is not.

### Upstream references

A bug that someone has typed into JIRA needs to say so — but it is **not a
lifecycle state**. A bug can be upstream-filed *and* open *and* corroborated at
the same time, and putting that in `status` would repeat the mistake `Disposition`
made by encoding two axes in one enum.

It is a reference, and it is the fourth thing in this design with that shape —
`escalated`, `promotion`, `postedRef`, and now this — which is the argument for
factoring it once. It belongs on **findings as well as bugs**: a finding gets
typed into JIRA for the same reasons a bug does, and having one shape for both is
the point of unifying the machinery.

```ts
interface ExternalRef {
  system: "github" | "jira" | string;
  key?: string;                    // "ABC-123"
  url?: string;
  at: string; by: Actor;
}
```

A latch, therefore merge-safe, therefore free under Decision 4.

Two rulings it needs:

- **Filing upstream does not close the bug.** "Tracked in JIRA" is not "fixed".
  It should drop out of the *review* queue — that is what filing it is for — but
  closure stays gated on the witness check, because only the code can say whether
  it is actually fixed.
- **It makes the witness mechanism pay upstream.** Once a JIRA key is attached,
  a witness mismatch means codemap can say *"the code under ABC-123 changed — it
  may be fixed"*, on the ticket, at the moment it happens. That is the
  `possiblyFixed` signal finally pointed at something that tracks work — and it
  closes the loop this whole design is for: an agent reports the fix with its
  `outcome` receipt, the human confirms against the witness, and the ticket gets
  closed with evidence instead of going quietly out of sync.

### Promoting a finding to a bug

A finding is pull-request-scoped and single-anchor; a bug is codebase-scoped and
multi-anchor. A real finding that outlives its PR is a bug, and today there is no
way to say so — it either rots attached to a merged branch or gets retyped by
hand.

Under Decision 4 this is one event, not a move:

```jsonc
{"kind":"promoted-to-bug","finding":"f_9c1","bug":"b_31a","actor":{…},"at":"…"}
```

Both records survive and cross-link. That matters: the PR history should still
show the finding was raised there, and the bug should say where it came from.
Three things follow:

- **The witness carries over.** The bug inherits the finding's `witness` and
  `sourceRef`, so `possiblyFixed` works from the moment of promotion rather than
  from the next scan.
- **The ack queue shows one, not both.** Promotion transfers the obligation; a
  promoted finding stops asking for a decision because its successor is asking.
- **Corroboration carries over too.** A finding two models already confirmed does
  not restart at zero because someone reclassified it.

## Decision 6 — Contested scalars

What survives the event log: two people writing different values to the same
scalar, concurrently and without seeing each other. Alice rerates to `high`,
Bob to `low`.

Both events are in the log; nothing is lost. When the fold finds concurrent
divergent writes to one field it does **not** pick a winner. It sets the finding
to `contested`, shows both values with their actors and rationales, and requires
a person to **re-submit what the value should be** — which lands as a new event
that is causally after both, and therefore resolves cleanly on every machine.

Two consequences worth stating:

- `contested` is a state a *human* clears, never an agent. It is the same
  instinct as the ack queue: a machine may propose, a person decides.
- This is `docs/proposal-committed-docs.md`'s "merge conflicts are a feature"
  argument, finally landing on a layer where it is true. A hash tiebreak picking a
  winner silently is the failure it warned about; the difference from `<<<<<<<`
  is that you can keep working while it is unresolved.

## The sync loop

The UX is an email client's send/receive, and it has to be honest — a one-button
sync over a fragile operation is a lie.

```
pull:  git fetch && git rebase       → re-fold → done
push:  write new event files → commit → git push
       on reject: pull, retry
```

The retry is safe to perform blindly, which is the property that makes the button
truthful: events are immutable and commutative, so a rebase can never change
their meaning. That is the whole algorithm.

**`pr_push` moves into the shared store**, and must be pulled before any publish
plan is built. It is the one place where a stale pull is actively destructive
rather than merely incomplete.

## Prerequisite — the body hash is wrong today

Independent of everything above, and worth fixing before a second store exists to
migrate. Two defects, both measured on the real repos.

**1. `#region` names are in the body hash.** C#'s `preproc_arg` token runs to
end of line, so `#region Distribution Summary` puts its text — and, in a CRLF
file, a trailing `\r` — into the hash of the enclosing **class shell**. This is
wrong on its own merits: renaming or adding a region is cosmetic, and discarding
cosmetics is the entire job of normalization. Today it stales every review mark
and finding witness on the type.

Scope the fix by **node**, not token type: skip the `preproc_region` and
`preproc_endregion` subtrees in `collectLeaves` (`indexer.ts:100`), the same
treatment comments get. `#if DEBUG` uses an `identifier`, not `preproc_arg`, so
conditional compilation is untouched — a blanket `preproc_arg` exclusion would
also have swallowed `#warning` text as a side effect.

**2. CRLF leaks into multi-line content tokens.** Inter-token whitespace never
reaches the hash, but a leaf token that itself spans lines carries its own line
endings — C# verbatim/raw strings, Python triple-quotes, JS template literals,
JSX text.

Measured blast radius:

| | anchors | moved by region fix | moved by CR fix | total |
|---|---|---|---|---|
| Acme.API | 10,084 | 180 (1.79%) | 30 | **~210 (2.1%)** |
| Acme.Settlement | 1,519 | 1 | 0 | **1** |
| Acme.React | — | n/a | 2 | **2** |

Supporting counts: 589 of 1,373 Acme.API files are CRLF (42.9%) against 6 of 833
in Acme.React (0.7%); CR-carrying tokens in Acme.API are 374 `preproc_arg`, 84
`string_content`, 22 `raw_string_content`, and in Acme.React 45 `jsx_text`. 185
Acme.API files use `#region` and only 176 anchors move, so the exposure is
concentrated.

**Both changes need a `HASH_SCHEME` stamp, and it does not exist.** `ANCHOR_SCHEME`
covers id derivation only. `state.grammarVersions` is written once at
`ops.ts:353` and **read by nothing** — it is a stamp with no reader. Without a
scheme on the witness, changing normalization silently re-stales every mark in
every store, with no way to tell that from real drift. A mismatch must read as
*unknown*, not *changed*. This is the `ANCHOR_SCHEME` lesson one level up, and
shared state raises the stakes: unstamped drift stops looking like local churn
and starts looking like "Bob's witnesses never match mine".

Do both fixes under one bump, while there is one store to migrate.

## Prerequisite — submodules are handled on one side only

`Acme.BaseClasses` is a git submodule of **both** `Acme.API` and `Acme.Settlement`,
mounted at the same path in each. Indexing understands that; retrieval does not.

**Indexing is submodule-aware.** `indexCommit` recurses through gitlink entries,
opens the submodule's own repo at the pinned oid, and prefixes paths so ids match
the parent's (`repo.ts`). It works: 16 of the 17 cached snapshots on the live
`Acme.API` store carry exactly 186 `Acme.BaseClasses/**` anchors each. (The
seventeenth pair predates the commit that extracted the submodule and is
correctly smaller — checked, not assumed.)

**Retrieval is not.** `codeAtSnapshot` calls `showFile(root, sha, file)`, a flat
`git show <sha>:<path>` against the *parent* repo. A gitlink is mode 160000, not
a tree, so the parent cannot reach inside it:

```
$ git show 03ae28f6:Acme.BaseClasses/Contracts/CallbackTypes.cs
fatal: path '…' exists on disk, but not in '03ae28f6…'

$ (cd Acme.BaseClasses && git show d748b453:Contracts/CallbackTypes.cs)
using Acme.API.Money;        # fine, from the submodule's own repo at the gitlink oid
```

So every one of those 186 shared-kernel anchors has a hash, a review state and a
diff verdict, and **no base-side code**. Drill-down is blank and the PR code diff
(`pr.ts`) is empty for exactly the code two products depend on. The fix mirrors
what indexing already does: teach `showFile` to detect a gitlink ancestor at
`sha`, resolve its oid, and read from the submodule's repo. One helper, two call
sites.

**A missing submodule is silent.** In `indexCommit`, a failed recursion is
dropped by a bare `if (sub)`, while the blob path deliberately returns `null`
because "a partial read here would be cached as this commit's snapshot and read
as a mass symbol deletion by the next diff". The submodule path should follow the
same rule. **No evidence it has fired** — the two undersized snapshots have an
innocent explanation — so this is a latent inconsistency, not a live defect, and
should be fixed on those terms.

**The shared kernel becomes its own universe.** An anchor id is
`file + symbolPath + disambiguator` with no repo in it, and both products mount
the submodule at the same path — so **158 of 186 ids are byte-identical across
`Acme.API` and `Acme.Settlement`**. Same id, same path, two products. That is the
cross-PR contamination class the `witness` / `sourceRef` work already fixed, one
level up, and namespacing the sidecar by universe only hides it.

`Acme.BaseClasses` is already its own git repo with its own standalone clone, and
`CoverageState: "owned"` ("documented in another universe (shared kernel)")
exists for exactly this. So: index it once as its own universe, exclude
`Acme.BaseClasses/` from each product's scan, and let a kernel finding live in one
place.

This also resolves the pull-request case, which the prefix approach does not. A
PR that touches shared code shows up in the product repo as a **gitlink move** —
`kernel: A → B` — and the thing to review is that range *in the kernel universe*.
The decomposition is correct rather than convenient: the product PR should say
"this also moves Acme.BaseClasses A→B (N symbols)" and link across, instead of
inlining someone else's repo into its own diff.

Costs, both bounded:

- **Kernel anchor ids change** (the path prefix goes away), so existing marks on
  those 186 anchors need remapping. `remapNodeCitations` and
  `migrate-overloads.ts` are the precedent for doing that losslessly.
- **The kernel universe needs pinning discipline.** Its worktree has one commit;
  the products pin whatever they pin. Findings already carry `sourceRef`, which
  is what makes a kernel finding legible as being about a particular kernel
  commit rather than about "the kernel".

## Prerequisite — a worktree scan must not outrun its submodules

> **Assert it: a submodule must be updated before a worktree is re-scanned.**

Cheap to enforce and already violated on this machine. `git submodule status`
prefixes `+` when the checked-out commit differs from the one the parent pins:

```
Acme.API:         d748b4537be9…  Acme.BaseClasses (heads/main)      # in sync
Acme.Settlement: +cf08f1af9855…  Acme.BaseClasses (remotes/…/main)  # AHEAD of the pin
```

`Acme.Settlement` pins `d748b453` and has `cf08f1af` checked out. Its `@work`
index therefore holds kernel anchors read from code its own commits do not ship —
which is the whole explanation for the 28 of 186 ids that differ between the two
products. Not deliberate divergence; ordinary drift that nothing reported.

A scan should refuse (or at minimum refuse loudly) on `+` or `-`, before
indexing. One `git submodule status` call, no new dependency.

The check does not cover the PR path, where nothing is checked out: `indexCommit`
reads the gitlink oid from the tree and needs that oid present in the submodule's
repo. If a branch bumps the kernel to a commit nobody fetched, the recursion
fails — which is the `if (sub)` silent drop above, and the reason it must become
a `null` rather than a shrug.

Once the kernel is its own universe, this assertion mostly dissolves for the
products: they stop scanning the submodule directory at all. It still governs the
kernel universe itself, which should be scanned from a **dedicated clone** rather
than from a submodule checkout inside a parent — a detached, parent-pinned
checkout is the thing the assertion exists to catch.

## Layering

```
schema.ts     + Actor, three-axis finding, event types, HASH_SCHEME
indexer.ts    + skip preproc_region/preproc_endregion; strip CR in leaf text
git.ts        + gitlink-aware showFile (resolve oid, read from the submodule)
repo.ts       + a failed submodule recursion returns null, like the blob path
store.ts      + event-log read/append behind the existing signatures  ← the SEAM
sidecar.ts    + fetch/rebase/append/push + fold  (new, small)
ops.ts        unchanged API surface
mcp/serve     unchanged; a shared finding is a finding
```

**No new dependency.** git is already reached through `node:child_process`, as is
`gh`. The sidecar is a git repo, the log is line-delimited JSON, the fold is
ours.

## What this deliberately does not do

- **It does not sync attestation.** Viewed/signed stay local, and GitHub keeps
  carrying the per-file tick so the PR remains an independent check before merge.
  The round-trip is lossy by design and must stay that way: a file ticks only
  when every reviewable symbol in it is seen, and attestation is never
  reconstructed from a tick.
- **It does not make review real-time.** State arrives when you pull.
- **It does not validate events centrally.** A buggy client's malformed event
  propagates. A schema check on fold plus a quarantine bucket is the mitigation,
  not a cure — this is the clearest thing a server would have given us.
- **It does not replace `pr-push`.** That feature stays for the workflow it was
  built for: reviewing for people who do not have codemap.

## Risks

- **Log growth.** Events accumulate without bound. Bundling makes this a
  byte-count problem rather than an inode problem, which buys a lot of runway;
  past that, size-rolled shards bound any single file and periodic
  snapshot-and-truncate commits bound the whole. Safe because the fold is
  deterministic — a snapshot is just a checkpoint of it.
- **Windows.** The sprawl objection is answered by bundling, but it is worth
  re-checking on a real Windows clone before step 4 rather than trusting the
  arithmetic: `git status` cost and Defender behaviour on the sidecar are the
  things to measure, and they are cheap to measure early.
- **No exclusive locking.** `withLock` is a pid-based local file lock and is
  worthless across machines; the cross-machine arbiter is git's non-fast-forward
  rejection. Nothing in the shared set needs mutual exclusion today. If something
  ever does, the sidecar cannot express it.
- **Scheme drift across the team.** `ANCHOR_SCHEME`, `HASH_SCHEME` and the
  vendored grammar versions become a team-wide compatibility contract. Every
  pushed event must carry them, and a pull under different values must be
  **refused, not merged**.
- **Self-corroboration.** With promotion no longer gating triage, any actor may
  corroborate at any time — which is simpler, but means the no-self-verify check
  must compare `principal`, not session. Otherwise "three models confirmed it"
  can quietly mean izzie's agent confirmed izzie's finding three times.
- **Contested fatigue.** If the fold is too eager, ordinary concurrent editing
  reads as conflict and people learn to clear the state without reading it. It
  should trigger only on genuinely concurrent, genuinely divergent writes to the
  same field — never on causally ordered ones.

## Sequencing

1. **`HASH_SCHEME` + the region and CRLF fixes.** One bump, ~210 anchors on
   Acme.API. Independent of everything else, and losing sign-offs today.
2. **Submodules.** In order: the `git submodule status` scan guard (smallest,
   and catching a live drift on `Acme.Settlement` today); gitlink-aware `showFile`,
   which restores base-side code for 186 shared-kernel symbols per snapshot; the
   `if (sub)` null rule. Splitting the kernel into its own universe runs
   **alongside** rather than gating: it touches few live findings or reviews
   today, and every week it waits is more marks minted against ids that the split
   will move.
3. **Identity** (`principal` + `via`), with the `"me"`/`"agent"`/`"human"`
   backfill. Schema-touching, and everything below assumes it.
4. **Event log behind `store.ts`, plus walkthrough sync.** Walkthroughs are the
   right first payload: self-contained, keyed by PR, already stamped with the
   head they were written against, so a stale one is detectable rather than
   silently wrong. Key files per principal so two people mapping one PR is a
   non-event.
5. **Three-axis findings, threads, and `pr_push` moved into the shared store.**
   Bugs come with it — same `Actor`, same thread, same ack queue, plus
   `ExternalRef` — since building the machinery twice is the thing to avoid.
6. **Contested detection**, once there is enough real concurrent traffic to tune
   it against. Shipping it before that is guessing at the false-positive rate —
   the mistake the Marten pass records (138 false positives before 4 genuine).
7. **Inbound reply pull**, small once (5) exists.
8. **Docs.** Note that choosing the sidecar keeps `node_versions` load-bearing:
   the committed-docs proposal could drop it because "version selection is
   `git checkout`", and the sidecar's timeline is not the code repo's. Selection
   is `winningVersionAt` against the code in front of you (`store.ts:422`), which
   is branch- and machine-independent — so a single linear sidecar serves every
   branch correctly, but only via the per-citation accepted-hash sets that
   `docs/doc-versioning.md` designs.
