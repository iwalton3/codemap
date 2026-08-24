# Review-target identity — what a review is *about*

Written 2026-08-23, after branch-canonical keying was proposed, reviewed and
**refuted**. Nothing here is built. It exists so the next attempt starts from the
counterexample rather than rediscovering it.

## The problem

Team state is keyed by scope: `<universe>/findings-<key>`, `<universe>/walkthrough-<key>`.
Today `<key>` is the **GitHub PR number**, and walkthroughs and push records are keyed
by `String(pr.number)` locally as well.

That is a problem for the workflow codemap is actually for. A teammate's agents review
and triage a branch **before a pull request exists**; what reaches the owner is a
walkthrough plus the residual findings. If the number is the identity, none of that
work has anywhere to live until a PR opens, and it all has to be re-keyed the moment
one does — precisely when it becomes valuable.

## What was proposed, and why it is wrong

**Proposal:** make the *branch name* canonical when the head is a branch on origin,
and `pr-<n>` only when it is not — a fork, whose head is on somebody else's repository
and so is in no branch here. `prBranchFor` implements that test with
`git ls-remote --heads`, matching the head sha against branch tips.

**It is not a stable identity.** Measured on one repository, one PR, five reads:

| situation | `headRef` resolves to |
|---|---|
| normal | `feature/x` |
| **remote briefly unreachable** | `pull/7/head` |
| branch renamed | `feature/y` |
| branch deleted | `pull/7/head` |
| an unrelated branch at the same sha | `somebody-elses-thing` |

A **transient network error alone changes the key**, so one review's findings split
across two scopes and each half looks complete. Exact-tip matching cannot answer
"which branch owns this pull request" — it answers "which branch happens to point
here", which is a different question with the same shape.

Three more, all verified:

- **`pr-<n>` collides with a real branch.** `git check-ref-format refs/heads/pr-17`
  exits 0, and both a branch named `pr-17` and fork PR #17 produce the scope
  `acme/api/pr-pr-17`. The two key domains are untyped and overlap.
- **No lifecycle generation.** Two sequential PRs from one branch name share a scope;
  a deleted-and-recreated branch inherits the old review; a force-push that repurposes
  a name keeps findings about code that is gone. Git cannot distinguish "the review
  continued" from "this name was reused" — only an explicit act can.
- **Escaping `/` as `~` is injective but not portable.** The premise held: `~` is
  forbidden in a ref name, so no two valid branch names collide when escaped. But two
  130-byte path components escape to a 264-byte filename and `mkdir` fails at the
  255-byte limit; case-insensitive filesystems and unicode normalization are also
  unhandled.

## The design: separate the SELECTOR from the IDENTITY

The mistake was using a *way of finding* a review as the *name of* the review.

- **A review target has a minted, durable id** — `r_<fixed lowercase hex>`. Nothing
  derives it from a branch, a sha, or a number, so nothing about the world can change
  it. Fixed-length and lowercase, so it is a safe path segment everywhere.
- **Selectors are typed aliases** pointing at that id: `branch:<exact-name>`,
  `pr:<number>`. Distinct domains, so `pr-17` the branch and PR #17 cannot collide.
  A rename adds an alias; opening a PR adds an alias. **Neither moves data.**
- **The target records the intended base and the current head.** A review is
  `(base, head)`, not a branch — which is also why `refs/pull/N/head` alone cannot
  reconstruct a PR that targets `release` rather than `main` (see below).
- **`prBranchFor` becomes a discovery HINT only.** An ambiguous match or a remote
  error may never select an identity — at most it fails to offer one.
- **Reuse needs an explicit generation.** Closing a review releases its branch
  selector only by starting a new generation, so a recycled branch name cannot
  inherit the previous review's findings.

### Walkthroughs must witness the base too

`walkthrough.ts` stores only `head`, and a walkthrough counts as current on a head
match alone. Retarget a PR from `main` to `release` and the walkthrough stays
"current" while describing a different change. Whatever lands here should witness
both.

## What IS built, and is unaffected

Git-only PR resolution (`prMetaFromGit`, `prBranchFor`, `defaultBaseRef`,
`mergedBaseFor` in `src/pr.ts`) shipped in this branch and stands on its own: it
resolves a PR — fork or not, open or merged — with no `gh`, keyed by number exactly as
before. It is what makes the oracle hermetic. It does **not** depend on any of the
above.

One honest limitation it carries, and the reason `PrMeta.baseInferred` exists:
`refs/pull/N/head` is a head commit and nothing else, so a PR onto `release` is
indistinguishable from one onto `main`. Guessing the remote default attributes every
commit `release` has that `main` does not to this author's change — measured at 2
changed files instead of 1 on the fixture. The guess is flagged and an explicit base
is honoured; it is not silently absorbed.

## Migration

The owner's position is that codemap `main` is a previous epoch and a migration is
acceptable where it makes the code simpler. That still leaves one rule:

**Do not infer historical branch names.** A deleted branch's pull ref preserves only a
sha, and any present-day branch at that sha may be unrelated — see the fifth row of
the table above.

So: keep every existing number scope as its own legacy review target and register
`pr:<n>` as its alias. For a currently open, explicitly verified same-origin PR, a
branch alias may additionally point at that legacy target. Merged or deleted PRs need
no branch alias.

**Never combine two existing scopes by moving shard files.** Writer chains are defined
per scope; splicing two independently-opened chains can give one writer two `GENESIS`
children, which is indistinguishable from a fork and will correctly be reported as
one. If two scopes both hold work, merge them with an explicit import that re-emits
events, or leave the old one archived under a v2 namespace.

## Open questions, for whoever builds this

1. **Where does the target registry live?** It is team state (a teammate must resolve
   the same selector to the same target), so it wants to be in the sidecar — which
   makes it a new entity kind with a fold and a projection, subject to the same
   single-writer and conflict rules as everything else. Two people opening a review
   for one branch concurrently mint two ids; the fold has to pick one and alias the
   other, and that rule is unwritten.
2. **What starts a generation?** "The reviewer says so" is the safe answer and puts a
   decision in front of somebody at the moment a branch name is reused, which may be
   the wrong moment to ask.
3. **Does the local store follow?** `readWalkthroughs`/`readPushes` key by
   `String(pr.number)` in the meta blob. They can keep doing that against the target
   id, but that is the migration.
