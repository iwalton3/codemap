# Proposal: review topics — walkthroughs of any set of code, not only a pull request

> **Kind: proposal — approved for building.** Filed 2026-10-02 against `main` at `6859b46`. §2,
> §6 and §8 are settled by the owner (answers quoted); §7 is a measurement. The build plan is
> `.git/plan/2026-10-02-review-topics/`.

## 1. Why

Two cases the PR walkthrough cannot reach:

- **Business-critical subsets.** An agent reviews most of a change; a person wants to walk
  only the part that matters — the fee calculation, the settlement fold — with the same
  guide-plus-sign-off the PR walkthrough gives.
- **Code already on main.** Under COD-18 most merges are gated by agents alone, so code
  lands that still deserves a manual walkthrough later. That later review has no pull
  request to hang on, or spans several.

### What already works — measured, not assumed

A walkthrough of one **merged** pull request works today, end to end. Run 2026-10-02 on the
jellyfin fixture (`src/e2e/real-repo.ts`, #17463, merged) with the working tree checked out
441 commits later on trunk: `pr_walkthrough` stored it (13/13 code-lane symbols covered),
`pr_walkthrough_get` read it back with nothing stale, and `prChapterMark` signed all 13.
So "this one PR merged without a manual review" needs nothing new. Topics are for what that
cannot express: a SUBSET, a RANGE spanning many PRs, and WHOLE code with no diff at all.

One limit of that path, worth knowing: its staleness is judged against the PR's head, which
never moves once merged — so it cannot tell you trunk has since changed the code. Review
MARKS still can (they are judged against live hashes); the walkthrough's chapters cannot.

## 2. Settled (owner, 2026-10-02)

- **A stored selector is the denominator.** "Stored selector": the set of code a topic must
  account for is resolved from a saved selector, not chosen by the agent as it writes, so
  `unaccounted for` keeps meaning something. An agent may propose the selector.
- **Hand review only.** No "delegated to an agent" coverage bucket: "scope to just
  hand-reviews for now."
- **Findings are scoped to the topic.** "findings scoped to these are probably a good idea
  after all."
- **Snapshots, re-walkable selector.** "The reviews are point-in-time snapshots, the
  selector should probably be re-walkable."
- **Name: topic.** `subject` was refused because every `LogEvent` already carries an
  envelope `subject` that the folds group by.

## 3. The model

```
Topic            durable, named: a slug, a title, a selector       topic:<slug>
  └── Walkthrough   one snapshot: the selector resolved at a commit (head [, base])
        └── Feature → Chapter → Blocks       unchanged from the PR walkthrough
Findings         scoped to the TOPIC, not to a snapshot
```

**Why findings hang off the topic, not the snapshot.** A finding is a witnessed claim about
code. Scoped to one snapshot, re-walking would hide it — and a re-walk is exactly when you
want to see what is still open. Scoped to the topic, walk 2 opens with walk 1's findings,
each still true or moved.

### 3.1 The selector

A selector resolves, at a commit, to a set of anchor ids. First cut, three forms, combined
as a union then filtered:

| form | resolves to |
|---|---|
| `paths: [glob…]` | every anchor in a matching file |
| `symbols: [anchorId…]` | those anchors and every anchor contained in them (byte span, as `prContainment`) |
| `nodes: [nodeId…]` | the anchors a doc or flow node cites |
| `base: <ref>` (optional) | intersect with what changed between `base` and the head — the "merged range" form, deleted symbols included |

Then the existing lane policy: `[tests]`, excluded and generated paths are counted apart
(`WalkCoverage.outsideQueue`), never in the denominator. A `symbols` entry the head no longer
has is reported as `unresolved`, never dropped.

A snapshot **copies** the selector it resolved and the resolved id set, so revising a
topic's selector never rewrites what an old walkthrough was about.

### 3.2 Coverage

`validateWalkthrough` and `walkCoverage` take the resolved set where they took `inPr`
today, and keep their rules: no citing outside the set, no symbol in two chapters, no empty
chapter, everything else listed `unaccounted for`. One difference (§6.1): in a topic, a cited
container covers what it contains, so a whole-file topic does not make the agent cite every
method of every class. PRs keep today's rule.

### 3.3 Signing

**Each walkthrough keeps its own sign-off history** (§6.5), in a LOCAL append-only table
(§8): who, which symbol or chapter, which attestation, signed or withdrawn, and the body hash
at that walkthrough's head. Nothing about sign-off travels; the rows hold everything an event
would, so exporting them later loses nothing. March's page keeps showing what was signed in
March after May's walk re-signs the same code. The ordinary per-anchor mark
(`markReviewedBatch`, `ref` = the head, `base` = the base when there is one) is re-projected
from that history — the latest walk whose latest act on the symbol is a sign-off — so the
map's review state and staleness work as today, and withdrawing in May leaves March's
sign-off standing on the map. The cover (`coveredBy`) is bounded by the topic's resolved set where the PR path bounds it
by what the PR touches — same reason: one click must not become a claim over code the
reviewer was never shown as part of this review.

**Signing is pinned to the snapshot's commit** (§6.3): a sign-off made in a walkthrough witnesses
the bodies at that walkthrough's head, never trunk's tip, and each symbol and chapter shows
an indicator when trunk's code has moved since. Signing an old snapshot is allowed and
honest — it says what was read — and the indicator says the code read is no longer main's.

### 3.4 Staleness and re-walking

A snapshot is judged against the live trunk, not only its own head: re-resolving the
selector at the tip shows chapters whose code moved (`staleChapters` against trunk hashes)
and symbols the selector matches now that the snapshot never saw. Both are the prompt to
re-walk. A re-walk is a NEW snapshot; the old one stays readable as history. Its `base`
defaults to the head of the latest walkthrough of the topic in which THIS MACHINE'S PERSON
signed anything — an agent writes, the person signs — with the whole selector on request.

### 3.5 Findings

- New key kind `topic:<slug>` beside `"<n>"` and `branch:<name>` (`src/review-target.ts`),
  normalized the same way. Sidecar scope `<universe>/t-<hex>`, hex of `universe \0 topic \0
  slug` as the branch scope does — a slug can be renamed in the title, never in the key.
- `landed` needs no new rule: it is decided by the code first. A finding filed from a walk at
  trunk's tip is landed from filing; one from a walk at an off-trunk head falls to ancestry like
  any other. Their exits are the existing ones —
  fixed, Escalate, File Bug, Backlog with a deadline.
- Agents can file against a topic with the existing finding verbs, since they take a key.
  That is not a coverage bucket; it is just a finding.
- Not linked back to PRs: a range topic covering merged #N does not show its findings on #N.

**The sweep this costs.** Many non-test files branch on the key kind today
(`isBranchKey` / `branchOf` / `findingKeyScope` / `normalizeFindingKey`, plus `/^\d+$/`
checks such as `repair-lifecycle.ts:91`); no count is given, because two greps disagreed and
the sweep test below is the authority. Most fall through to "not a PR, not a branch",
which for a topic is usually right — `repairSourceBranch` returning no branch means "compare
against the default branch", which is exactly a topic's case. Usually is not always, so the
build includes a test that sweeps the key-kind switches the way `standard-reach.test.ts`
sweeps front ends, rather than an audit by reading.

## 4. Storage and the sidecar

- **Topic definitions travel.** Scope `topics/<universe>`, events `topic.defined`,
  `topic.revised` (selector or title), `topic.retired` — a tombstone, never a delete,
  because findings cite the key (the `withdraw_spec` lesson in `requirements-architecture.md`).
- **Snapshots travel.** Their own family, `topic-walkthrough/<universe>/t-<hex>`, kind
  `topic.walkthrough.published` — not `walkthrough/`, whose door and fold are registered by
  prefix and would claim them. Each carries the topic key, head, base, copied selector and
  resolved set. A topic walkthrough is an immutable record whose id is its publishing event's,
  never replaced: its sign-off history (§3.3) hangs off that id, so replacing one would orphan
  it. The PR fold keeps its one-per-author rule.
- New families register kinds and doors (`registerKinds`, `registerDoor`). Teaching folds new
  events costs a **`MATERIALIZER_VERSION` bump (55 → 56)** for the reason `finding-backlog.md`
  gives: a teammate a day behind folds the new kind into nothing, upgrades, and is served the
  cached nothing for ever. A topic finding also bumps `EVENT_SCHEMA` (§7 measured why).
- **Rollout: the team upgrades together.** `EVENT_SCHEMA` is stamped on EVERY event, so the
  first write of anything by an upgraded build — topic or not — blocks every older build's
  shared writes until it upgrades, as do the new `topics/` and `topic-walkthrough/` families.
  Reads carry on. That is the existing upgrade gate, not a new mechanism, but it is team-wide.

## 5. Surfaces

Both front ends, per `standard-reach.test.ts`.

| surface | what |
|---|---|
| ops | generalize the walkthrough ops over a target (`pr` \| `topic`) internally; `src/walkthrough.ts` is already pure and needs only the denominator passed in |
| MCP | `topic` (define / revise / retire / list), `topic_packet` (resolved set + source, as `pr_packet`), `topic_walkthrough` (write), `topic_walkthrough_get` |
| web | topics list; `/#/u/:u/topic/:slug` reusing the PR walkthrough renderer; selector and who defined it shown above the walkthrough; snapshot picker |
| CLI | `codemap topic …` |

## 6. Settled in the second round (owner, 2026-10-02)

1. **A cited container covers what it contains, for topics.** "Yes." PRs unchanged.
2. **Re-walk defaults to the delta, whole on request.** "The default you proposed plus the
   whole-selector option makes sense": a re-walk's `base` defaults to the head of the latest
   walkthrough you signed in (§8.2); the whole selector is one option away.
3. **Signing is pinned to the walkthrough's commit.** "The specific walkthrough should
   probably be pinned to a commit for signing with an indicator if the code moved." See §3.3.
4. **Anyone may define or revise a topic; old walkthroughs show the change.** "Anyone can
   change it, walkthroughs made against an old selector show if the selector was changed."
   Each snapshot already copies the selector it resolved (§3.1), so the indicator is a
   comparison of that copy with the topic's current one — and it can name what changed
   (paths added, symbols removed), not only that something did.
5. **Sign-off history lives on the walkthrough.** "The idea is the walkthrough is a snapshot
   in time, but if we only keep the latest sign-off state and not sign-off history, that is
   less practical. The topic has no such concrete code range just the walkthrough." (§3.3)

## 7. Measured: what a build without topics does with them (2026-10-02)

Run on a two-person oracle team at `6859b46`: one member's sidecar gets a planted topic event
pushed with plain git; the other syncs with the current build, reads, then files an ordinary
finding.

| Planted | Reads | Lock | Teammate's own shared write |
|---|---|---|---|
| `findings/<u>/t-<hex>`, `finding.created`, new `data.topic`, schema 1 | **folded, mis-keyed**: `pr = "acme-api/t-abab…"`, in the backlog's `live` bucket and in search | no | goes through |
| same, without `data.topic` | same as above | no | goes through |
| same, schema **2** | scope blocked as newer; finding invisible | no | **refused**: "Pushes are blocked until codemap is upgraded" |
| `topics/<u>`, `topic.defined` (unknown family) | carry on, nothing folded | no | **refused**: "no family of this build reads topics/acme-api" |

What follows:

- **An unknown DATA field is folded silently.** That is the rule working as written — a data
  field needs an `EVENT_SCHEMA` bump, there is no per-kind field table — and the first two
  rows are what forgetting the bump looks like: a finding under a key that is no PR, no
  branch and no topic, live in the backlog. So the topic finding bumps `EVENT_SCHEMA`.
- **In practice the gate fires before any topic finding exists.** Defining a topic writes a
  `topics/` event; that stops every older build
  from pushing ANY shared write until it upgrades, while its reads carry on. Rollout order:
  the whole team upgrades before the first topic is defined. That is the existing upgrade
  gate, not a new cost, but it is a team-wide one.
- **Aside, existing behaviour:** in the last row the pull's report said `blocked: []`
  and the very next write was refused as newer. The pull summary does not mention the gate it
  just armed.

## 8. Settled in the third round (owner, 2026-10-02)

1. **Sign-off history is local-only.** "I lean towards the walkthrough sign-off state being
   local-only, since we aren't updating PRs to have shared sign-off state." The rows store
   enough to be shared later.
2. **A re-walk defaults to the delta since the latest walkthrough you signed in**, the whole
   selector on request (§3.4).
