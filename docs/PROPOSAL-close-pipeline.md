# Proposal: the close pipeline — store what the sort already decided

> **Kind: proposal — not approved.** Filed 2026-09-22 against `main` at `c8b31ea`. It depends on
> the diagnosis in `docs/close-audit-next.md` § *What we are actually dealing with*, and does not
> repeat it. `PROPOSAL-close-evidence.md` §5 — the evidence slot on `close_finding` — is a
> **component** of this, not an alternative to it. Nothing here is ratified, and §8 is a list of
> things nobody has settled rather than a list of things left to implement.

## 1. The claim

**The closing condition for a finding is decided once, early, in writing — and then thrown away
before anything can check against it.**

`triage-review` sorts a round into five groups, counts a defect pattern's sites *with the command
it counted them by*, records the refutation for an invalid one, takes the owner's rulings verbatim,
and requires of every plan item *"a check that fails before its own fix, and run it."* All of that
is written to `$(git rev-parse --git-common-dir)/triage/<YYYY-MM-DD>-<slug>/` and read by nobody
afterwards. The fix lands. The close is prose in `outcome.detail`, one path in `files`, and codemap
holds no record that the item was ever a pattern, that two sorters disagreed about it, or that a
person ruled anything.

So the auditors measured in `PROPOSAL-close-evidence.md` §8 were not failing at a hard task. They
were reconstructing from code, blind and under batch pressure, a decision that had already been
made deliberately and discarded. Five passes never recovered it, which is the expected result and
not a detector problem.

**What this proposes is that codemap become the store for that decision**, so the close can be
checked against the condition the round agreed on rather than against an auditor's reconstruction
of it.

## 2. What already exists, per item

Everything below is produced today, by a skill that already runs, and lands in a git-dir path.

| artifact | where `triage-review` writes it | which claim of the four it settles |
|---|---|---|
| **group** (1–5), and for group 1 its **kind** — isolated or pattern | `sort.md` | *which claim applies at all* |
| `covers F4, F30` — the dedup | `sort.md` | finding identity |
| a pattern's **sites and the command** that counted them | `sort.md` | every instance is covered — **this is the predicate** |
| the **refutation** for group 5: wrong / assumed / out of scope | `sort.md` | the finding is invalid |
| what the "why" **rests on** | `sort.md` | whether it needs a rule nobody wrote down |
| both sorters' readings where they differed; the arbitrator verbatim; the **"don't fix early"** mark | `sort.md`, `arbitration.md` | how much the sort itself is worth |
| the owner's **rulings, verbatim** | `owner.md` | somebody with standing decided |
| per plan item, **a check that fails before its own fix** | `plan.md` | the finding's own defect no longer fires |
| **blame** — does this finding land in an earlier round's fixes | `sort.md` | fixes-on-fixes |

Two of those deserve naming outright, because they are exactly the artifacts §8 could not
manufacture:

- **the pattern's command is the predicate** for the third row of the table. Nobody has to invent
  an enumeration at close time; the sorter already ran one, and wrote it down.
- **`owner.md` is the ruling record** for the fifth row — the one that is not in the code and that
  no reader can ever recover from the code.

**The sort is not free-of-doubt data, and it should not be stored as if it were.** Measured over 15
rounds: two blind sorters agreed on 106/154 (69%) exactly and 114/154 (74%) on group-1-versus-not,
with over half of all disagreement being 1-vs-2 — *the authority line itself*. So it is data with a
known error rate in a known direction, and the rule that follows is that ties go to the group
needing a person, never to the group an agent may close.

## 3. What to store

Field names are a sketch, stated concretely so they can be marked wrong rather than approved.

### (a) The sort, on the finding

A `sort` object on `Annotation`: `group`, `kind` for group 1, `covers`, `sites` + `command` for a
pattern, `refutation` for group 5, `restsOn`, `contested` (it went to an arbitrator), and
`by` / `at` / `round`.

**It is not `category` and not `severity`.** `category` is a freeform CI bucket ("Authorization",
"Logic") and `severity` is stakes; this is the closing-condition type, a third axis, and collapsing
it into either loses exactly the distinction the whole proposal turns on.

**Naming hazard:** `triage/` is already a shared scope in this store and it means **stakes triage**
— importance and complexity per anchor, `docs/triage.md`. The review-round artifact is called a
*sort* throughout the skill. Keep that word; a second meaning for `triage` here would be a
`sidecarForWrite`-shaped confusion where two unrelated things answer to one name.

### (b) The ruling, as its own record

A ruling is **not a property of a finding**. One ruling settles several, and it outlives the round,
the pull request and usually the findings themselves. That is the same shape the standard already
has — `docs/requirements-architecture.md`'s operations carry their own context and are
principal-granted — and whether a triage ruling *is* a standard operation or a lighter record
beside it is the largest open question here (§8), because it decides whether this is a schema
addition or a second law surface.

What is **not** open: a ruling is **principal-granted at both ends**, like `debt` and like
backlogging. An agent may record that a ruling exists and cite it; an agent may not make one.
Without that, "the owner ruled" becomes the cheapest way to close a group-2 finding, which is the
deferral hazard `docs/finding-backlog.md` already names, with worse consequences.

### (c) The closure proof, on the close

`PROPOSAL-close-evidence.md` §5's `evidence` object, with its fields keyed to the **claim** rather
than to the verb:

- `falsified: [{command, without_fix, with_fix}]` — a change exists and is not vacuous.
- `reproduced: [{command, at_witness, at_fix}]` — the finding's own defect no longer fires.
  **This is not the falsifier.** Fusing them is §8.1's error: one is bounded by the change, the
  other by the finding, and they answer different questions.
- `predicate: [{command, expected, actual}]` — every instance is covered. For a pattern this is
  the sort's own command, re-run, and the expected result is zero.
- `accounted` — every hunk of the diff attributed to the ask, or flagged. The only thing that
  reaches the never-found class.
- `ruling: <id>` — somebody with standing decided.
- `read`, `consulted` — recorded, and weaker on purpose, exactly as `record_audit` already grades
  them.

**None of these is required**, per §5: a required evidence field is a field that gets filled with
the nearest available string, and 25 closes declare outright that they have no check, most of them
for a good reason. What the stored type buys is that the *admissible* fields are known in advance,
so a close carrying none of them is visibly unevidenced rather than indistinguishable from prose.

## 4. Who may close what

| group | what closes it | may an agent alone? |
|---|---|---|
| **1, isolated** | the reproducer: red at the witness, green at the fix | **yes** — and this is the whole domain of auto-close |
| **1, pattern** | the predicate at zero hits; plus the ruling, where the plan adopted a design rule rather than fixing every site | the predicate, yes; the ruling gates the rest |
| **2, design defect** | a ruling, the design change, and the enumeration where a pattern sits under it | **no** |
| **3, assumption** | a ruling, and the change it authorises | **no** |
| **4, design suggestion** | nothing — it is not a defect, so it has no close. It exits by being adopted or backlogged | no close verb applies |
| **5, invalid** | already `disposition: refuted`, which §8.3 gates to *ask, never act* | **no** |

Two consequences, and they are the point rather than a side effect:

- **Three of the five groups can never be closed by a code-reading agent at all.** That is a
  structural refusal, not a detector that needs improving. The blind re-sort sized the population:
  **37 of 142 (26%) outside "implementation defect"**, 36 of them auto-applied by a loop with no
  gate.
- **Auto-close's domain shrinks to group 1**, which is where the §8 auditors were nearly right
  anyway. The gate is a router, and routing is the bounded question — *which of five kinds is
  this?* — that the arc showed models can answer. It is answered once, at sort time, by two sorters
  and an arbitrator, and the answer is what this proposal stores.

## 5. What a second agent can verify

The point of storing the proof is that the verifier **re-runs** rather than **judges**:

| row | it runs | it compares | it may conclude |
|---|---|---|---|
| a change exists | the falsifier's mutation at the fix commit | red under the mutation, green restored | vacuous / not vacuous |
| the defect is gone | `reproduced.command` at the witness and at the fix | fires / does not fire | the finding's own defect, and nothing else |
| every instance | the sort's predicate at the fix commit | hit count against `sites` | covered / not enumerated |
| the diff did nothing else | nothing — it reads the diff against the ask | hunks attributed / unattributed | flag for a person |
| somebody decided | nothing — it resolves `ruling` | the ruling exists, is in force, and covers this item | cite / refuse |

**Cannot-verify is never a close, and never a re-open either.** It is `unknown`, which §8.3 already
gives no power to act. *"I could not ask" is never a verdict* — `pr.ts`, verbatim, on exactly this
shape.

And the standing limit, from §8.8: a failing case the verifier finds that is **not** the finding's
own defect is a new finding, filed, never a block on this close. That is bug discovery, it is
genuinely valuable — two runs produced ~21 mostly-executed defects — and it is a different product.
Conflating them is what made `both-true` a 56% queue.

## 6. What not to do

- **Do not let the closer write the sort.** The type is an input from before the fix; a fixer who
  can retype its own item into group 1 has the authority hole back in one step.
- **Do not make any evidence field required.**
- **Do not read the sort as ground truth.** 69% / 74%, with the disagreement concentrated on the
  authority line. Store both sorters where they differed, and let a **contested** group-1 item
  refuse auto-close — `triage-review` already marks exactly those items *"don't fix early"*, for
  the same reason.
- **Do not fuse the falsifier and the reproducer** (§8.1).
- **Serve the finding as filed.** `revise_finding` has overwritten the submitter-facing comment on
  13% of findings with a fix report; the as-filed wording survives at `revisions[].was.comment`,
  and any close-side reader must be served that, **at the server**. Reconstructing it caller-side
  has already failed silently once, on 3 of 16 items.

## 7. Cost, stated honestly

- **Schema:** `Annotation.sort`, the evidence object on the close, a ruling record. `store.ts` is
  the seam and all three sit above it.
- **The fold:** new event kinds mean a `MATERIALIZER_VERSION` bump — currently **26** — carrying
  the hazard `docs/finding-backlog.md` states verbatim: a teammate folds the unknown kind into
  nothing, upgrades, their shards have not moved, the fingerprint is unchanged, and the new build
  serves the cached rows for ever. `db-migrate.test.ts` pins the findings vocabulary for exactly
  this, and would pin the sort's too.
- **Sharing:** findings already share (`findings/`). A ruling that governs a finding must travel
  with it, or a teammate reads a close whose authority is off-store. On the workspace-versus-
  universe question `docs/cross-universe-standard.md` already answers: a ruling is **law**, so
  workspace-scoped; the evidence that a close satisfied it is an observation of code, so
  per-universe.
- **`triage-review`:** it writes these artifacts today. What changes is that it also writes them to
  codemap — which is where the skill currently stops, and the whole of the ask.

## 8. Open

- **Is a triage ruling a standard `operation`, or a lighter record beside it?** This decides the
  size of everything above.
- **Does the sort attach to a finding, or to an item that covers findings?** The sort deduplicates:
  an item may cover several findings, and a finding may be covered by two items where it makes two
  claims. Codemap has no *item*. Flattening the sort onto each covered finding loses the dedup;
  adding an item is a new entity on every surface.
- **Group 4 has no exit.** `backlog` is the nearest fit (defer with a deadline) but a suggestion is
  not a defect and the backlog is for real defects worth neither fixing now nor dropping.
- **May a contested group-1 item auto-close at all**, or does arbitration permanently cost it the
  mechanical path?
- **What replaces 3/8 as the number to beat.** §8 measured an auditor's unaided detection; if the
  closing condition is stored, the thing to measure is re-run yield — what fraction of group-1
  closes carry a reproducer that actually re-runs, and how many of those are wrong. That is shape 1
  in the handoff, and it is now a measurement of the pipeline rather than of a model.
