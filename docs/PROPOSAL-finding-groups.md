# Proposal: group the findings that must be fixed together

> **Kind: proposal — not approved.** Filed 2026-09-03 from an outside session against
> `main` at `b12f42e`, then REVISED the same day against evidence from this repository's
> own history. The revision changed the recommendation: see § *What the evidence changed*.
> The `/breakfix-review` skill referred to below was `/review` when this was first filed.

## What is missing

A finding on a pull request carries **one** target — `targetKind`/`targetId`, one
anchor or node (`src/mcp.ts:1013`, `SharedFinding.target` at
`src/shared-findings.ts:213`). There is no way to say *these N findings are one
rule, and the repair spans them.*

The existing relations do not cover it. `corroborate` records agreement about a
finding. `link` and `defer_finding` cross-link a finding to a bug.
`promote_annotation` moves an annotation up. None expresses sibling-hood among
findings, so the fixer receives N independent rows and fixes them N times — which
is the shape that makes the next round's findings land in this round's fixes.

**Note what already exists:** a `drive_by` bug takes `anchors` (**plural**). The
multi-site primitive is there; the pull-request finding is the one that lacks it.

## What was withdrawn from an earlier draft

An earlier version of this file complained that `close_finding` refuses a `fixed`
report touching more than one file (`src/ops/annotations.ts:968`, `:1451`). That
complaint was wrong and has been removed. The refusal is about a review tool
proposing an inline fix in a review comment — a multi-file change is dispatched to
an agent, not performed as a side effect of closing a finding. Reporting is not
constrained: `text` and `comment` are free-form, and nothing refuses a finding
whose prose describes six files.

The gap is structural, not a refusal: the grouping cannot be *recorded*, so it
cannot be filtered, counted or handed over.

---

## What the evidence changed

The original draft argued from a cross-repository number (38–92% of a round's findings
being defects in the previous round's own fixes) toward one record: a group carrying a
rule, a site inventory and an exit predicate. Two round-pairs in **this** repository were
then read directly, and they support the phenomenon while refuting the single-record
conclusion.

### `5b9fce7` → `5d9f747`

Round two performed a **correct cross-cutting repair** for rule A — *every write to
shared state goes through one door* — enumerating eight bypassing call sites in its own
commit message and consolidating them onto `sidecarForWrite`. So the process already
produces rule-shaped repairs when the class is named; grouping is not the missing
capability.

In doing so it introduced rule B: the consolidated door collapsed "no sidecar" and "the
wrong sidecar" into one quiet null. Rule B was noticed at **one** site, `provisional.ts`,
because a test caught it there, and was fixed with an inline local guard at that site.
`5d9f747` then swept rule B across nine more files.

**This refutes the exit predicate as the defence.** A predicate on rule A would have read
MET after `5b9fce7` — correctly — and could not have seen rule B, which is a semantic
property of the new door rather than a property of the site set. The sibling blindness
struck the **regression introduced by the repair**, which is one level in from where this
proposal put it.

### `f7ac593` → `e47444f`

That round's own message names the mechanism three times without having a word for it:
*"the first fix exempted them, leaving the hole open on half the findings"*; *"the same
blind spot one level up"*; and a bulk-conversion guard living on `deferFinding` while the
surface people actually sweep a queue from posts to `acceptFinding`. **At least 5 of 11
were one-site fixes with live siblings.**

### The rules are STANDING, not per-pull-request

The classes that generate these rounds are named in `CLAUDE.md` and keep coming back.
*"A guard in the tool but not the FOLD"* is recorded as having happened **twelve times**.
*"One door of N"* has now happened twice in two commits. They are not discovered fresh
each round.

And this repository already has an answer to a standing rule, used in **eleven** test
files: a test that scans the tree, enumerates the population, and fails on drift.
`db-migrate.test.ts` pins the fold's event vocabulary and the projection's table set;
`ops-reach.test.ts` and `standard-reach.test.ts` pin front-end reachability — *"a text
scan rather than an import graph because that is what the drift is, a name nobody
typed."* That **is** an exit predicate, and it runs on every `npm run unit` rather than
once per review round.

The rule that cost the two rounds above had no such test. `src/sidecar-door.test.ts` is
now that test, and it is the worked example of the shape this section argues for: two
halves that fail in opposite directions, an exemption list where every entry carries a
reason and a stale entry fails, and a note saying how to verify it is not vacuous. It
found exactly one live drift — `provisional.ts`, still carrying `5b9fce7`'s inline guard
that `5d9f747` never came back to, plus `bugs-publish.ts` re-composing the door's two
steps. Both now go through the door.

---

## Two records, and the original draft conflated them

| | what it is worth | where it belongs |
|---|---|---|
| **standing invariant** — the rule that keeps returning | high: it is what generates fix-of-fix rounds | a pinned enumeration test. No schema, no fold, no `MATERIALIZER_VERSION`. |
| **per-PR repair** — N findings, one rule, one fix | handover: one person reviews and another applies; a finding outlives the PR | the cheap version below |

**So the recommendation inverts.** The original draft called a nullable `groupId` plus
`rule` text the "cheap 80%" and treated the full record with a re-runnable predicate as
the real thing. On this evidence the predicate's right home is a test that runs every
build, and a second, weaker predicate engine inside the finding store would be a
duplicate authority for one fact — the seam risk `/breakfix-review`'s own angle 7 names.

What survives, and it is the third reason the original draft gave rather than the first:
**outside sources.** Copilot, a human report, `/breakfix-review existing` — those
genuinely arrive as N rows at N locations, nobody told them to look for siblings, and
there is no way to record that six of them are one repair. `/breakfix-review` itself
files **one `report_defect` per rule** (its Phase 5.6), so the tool this was written for
does not need the grouping; the tools that do are the ones that never had the concept.

### The cheap version, which is now the proposal

- nullable `groupId` and `rule` on `SharedFinding`, both inside the existing `body` JSON
  plus one `part_of` column via the additive `ALTER TABLE` pattern (`src/db.ts:884`);
- grouping enforced at write time **and in the fold**, because a guard in the tool and
  not the fold is the twelve-times class above;
- one level only — a member may not itself be a group, since a rule needing two searches
  is two rules;
- no separate group record, no group state machine. Closing a member does nothing to the
  others; the group is a label that makes a repair filterable, countable and handable.

## What generalizes to codemap itself

The standing half is not a new subsystem here — **codemap already models it**, and this
is the part worth acting on:

- a **requirement** is the rule (*every write goes through one door*);
- an **acceptance criterion** with `evidenceKind: "lint-test"` carries its falsifier —
  and `CLAUDE.md` already says an invariant phrased always/never/every wants exactly
  that, *"because a green suite at merge does not prove nobody reintroduces the thing
  next quarter"*, which is precisely what happened between `5b9fce7` and `5d9f747`;
- a **population predicate** pins the member set, and `broken_pins` fires when the lint
  itself is edited;
- **pointers** say where an auditor looks.

Every piece is built. What is missing is named in `docs/README.md` against
`docs/population-predicate.md`: *"its last section is still open: nothing runs the
lint."* **That gap, not the finding group, is what this repository's own history argues
for closing.** An engineering invariant is as much a rule the code exists to satisfy as a
business rule is; the kernel does not care which, and `LogicalNodeType`'s openness is not
needed because a requirement is already its own record kind.

## Costs, honestly

The cheap version is a field, a fold guard, a column and two surfaces. The standing half
is one test per invariant in an idiom that already exists eleven times over, plus
whatever it takes to make a pinned population actually run.

What was costed in the original draft — a group entity, its fold rules, and a state
machine for members resolving separately — is not proposed any more.

## Where this reading could be wrong

Two round-pairs, one repository, and they are the pairs this repository's own handoff had
already flagged — so they are the cases most likely to show the pattern. The
`/breakfix-review` corpus figure spans four repositories and could not be checked from
here.

**The test that would settle it:** after the next two rounds, classify each finding as
*sibling of a rule already named in `CLAUDE.md`* versus *a rule new to this round*.
Mostly the former means tests. Mostly the latter means the record, and this revision is
wrong.
