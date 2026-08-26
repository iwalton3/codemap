# Plan: the open bug backlog, and the CI that should have caught half of it

> **Kind: active plan** — decided, not yet built. The work queue.
> the four open COD bugs, re-triaged against `4d80d65`, plus GitHub Actions.

**Status: ready.** Written 2026-08-26 from a triage of the five open bugs in the `COD`
Jira project against `4d80d65`, every verdict reproduced rather than read off the code.
Nothing here is started.

The tickets are COD-1, COD-3, COD-7, COD-8 and COD-12; the Jira comments carry the
per-item evidence and are not repeated in full here.

## Why these five, in this order

Two of the four original bugs are **wrong answers, not missing features**: COD-1 makes
`context` report a documented symbol as a gap, and COD-3 makes `diff` report a dirty
branch as empty. Both are the first call in their respective workflows, so each is
confidently wrong at the point a reader has least reason to doubt it.

The other two are Windows. That matters more than it looks, because triaging COD-8
turned up a fifth bug — COD-12 — which is not a test-harness problem at all:

> On win32 `scopesOnDisk` returns backslash scope paths, so `inUniverse` and
> `projectionFor` reject **every** scope, `materializeUniverse` scans zero, and the
> sidecar projection is never built. Reads then fall back to folding the log.

That silently defeats the claim `docs/sidecar-architecture.md` is built on — the log is
pull/push, SQLite is its projection, an ordinary read does not fold. The oracle property
written to catch exactly this (`readsDoNotFold`, `src/oracle-properties.ts:537`) walks
`notes/` scopes explicitly and asserts the fold count does not move after a sync. It can
never fire on it, because the oracle only ever runs on POSIX.

**So CI comes first.** Two of these five are invisible on the only platform we currently
test on, and the sixth one will be too.

### What COD-8 got wrong, and why it is worth saying

COD-8 offered two explanations for the empty `notes/` shards: the per-prefix lazy fold is
not finding them, or `sync` should pre-fold them like docs/triage/findings. Both are
wrong, and both would have been no-ops — `notes/` was already routed in `projectionFor`
and `materializeUniverse` already pre-folded every scope on disk, and **both were present
in `2009fdb`, the build the bug was reported from.**

The tell was in the report the whole time: the transcript has no `rebuilt N of M scope(s)`
line. That line (`src/cli.ts:276`) was already in that build and is gated on `scanned`,
which was zero. A fix built to either hypothesis would have changed nothing and read as
correct on Linux.

## Phase 0 — CI

`.github/workflows/ci.yml`. Matrix `ubuntu-latest` × `windows-latest`, Node 24.x — the
store needs ≥ 23.4 for unflagged `node:sqlite`, and 24 is LTS. `npm ci` is cheap: the
lockfile is five packages.

No runtime dependency is added. `actions/checkout` and `actions/setup-node` are CI-only,
so the golden rule holds.

Four setup facts, each of which would otherwise produce a red run for a reason unrelated
to the code:

1. **Git identity is required.** `resolvePrincipal` (`src/identity.ts:37`) shells out to
   `git config user.email`, and `requireActor` errors without one. Runners have no
   identity configured. Set it globally in the workflow — *not* `CODEMAP_PRINCIPAL`,
   which `identity.test.ts` deliberately unsets in order to test the git path.
2. **`core.autocrlf false` on Windows, before checkout.** A precaution rather than a known
   failure: CR is stripped at index time (`src/indexer.ts:135`) so hashing is safe, but
   byte-exact fixtures are not guaranteed, and CRLF has bitten this repo before — it is
   what forced `HASH_SCHEME` 2.
3. **Invoke the npm scripts, never `node --test` directly.** `--test-isolation=none` and
   `--test-concurrency=1` are load-bearing, not leftover: isolation because of the
   `DrainTasks` stall in the runner's per-file child, concurrency because a few tests set
   `CODEMAP_AGENT_MODEL` around a call that resolves its own actor.
4. **e2e on ubuntu only, and it will mostly skip.** playwright and puppeteer resolve from
   an external checkout via `CODEMAP_E2E_*`, `vdx-lint` needs `CODEMAP_VDX_TOOLS`, and
   `pr-import` needs a jellyfin clone. Run it anyway — the value is proving it *skips
   cleanly* rather than fails, which is the property `CLAUDE.md` asks of that tree.
   Wiring a real browser into CI is a separate decision, not part of this phase.

**Windows starts non-blocking (`continue-on-error: true`).** It is red today by COD-7's
own measurement, and a required job that is red by design is how a team learns to ignore
CI. It flips to required at the end of Phase 1, and **that flip is the acceptance
criterion for the phase** — not a follow-up. If Phase 1 stalls, the Windows job quietly
becomes decoration, which is the failure mode this sequencing is trying to avoid.

## Phase 1 — Windows correctness

**1. COD-12.** One line at `src/eventlog.ts:507`:

```ts
// A scope is a POSIX path, always: `projectionFor` prefix-matches it and
// `inUniverse` slices it at the first "/". `join` is platform-dependent.
await walk(rel ? `${rel}/${e.name}` : e.name);
```

`readScope`/`collect` already `join(logRoot, scope)`, which tolerates forward slashes on
Windows, so nothing downstream changes.

Then two regression tests that are hermetic and run **on Linux**: `scopesOnDisk` never
returns a path containing `\`, and `projectionFor` / `inUniverse` against a
`path.win32.join`-built scope string. Both would have failed at `2009fdb`. This is the
point — the platform-specific bug gets a platform-independent test, so it stays caught
even when nobody is looking at the Windows job.

Do this first. Smallest change, largest blast radius, and the only one of the Windows set
that is wrong in production rather than in the test harness.

**2. COD-7 §1** — export `closeDb(root)` / `closeAll()` from `db.ts` that call `d.close()`
and drop the cache entry; call it from the test temp-dir teardown before `rmSync`. No
production behaviour changes. Watch one thing: the suite is single-process, so closing a
handle another test still holds surfaces as a use-after-close. Scope the teardown to the
root the test owns.

**3. COD-7 §2** — `realpathSync.native` at `src/sidecar.ts:40`, keeping the existing
`catch { return a === b }`. `.native` goes through `GetFinalPathNameByHandle` and expands
8.3 short names; plain `realpathSync` walks lstat and does not.

**4. COD-7 §3** — compare `path.resolve("/elsewhere")` on both sides at
`src/ops-shared.test.ts:87-88` and `:260-261`. `resolveSidecar` does `resolve(env)`
(`src/sidecar-config.ts:108`), so the literal cannot match on win32.

**5. Flip `windows-latest` to required.** Re-measure the pass count here rather than
against COD-7's 543/884 — the suite is 1023 tests now, and green on Linux.

## Phase 2 — the two confidently-wrong answers

**6. COD-1 — prune nested repository roots.** In `listSupportedFiles`, do not descend into
a directory below the root that contains a `.git` entry, **file or directory**. One rule
covers worktrees, submodules and vendored clones; no config; one `stat` per directory.
`.git` is already in `SKIP_DIRS` and does not help, because in a linked worktree `.git` is
a regular file and basename directory-pruning never fires.

Measured at `4d80d65` on a clone with one worktree at `.claude/worktrees/wt1`: 1882 of
3764 anchors — exactly half the store — came from the worktree, which was already
gitignored.

One thing that looks like a problem and is not: `isIndexablePath` carries a comment that
it must stay in step with the walk, or a divergence shows up as phantom added/removed
anchors in a diff. It judges from the path alone with no filesystem, so it *cannot* make
this check — and it does not need to. It indexes a commit's tree listing, and a nested
worktree's files are untracked, so `git ls-tree` never lists them. Put this in the commit
message so the next reader does not re-derive it.

**Release note, because this will look alarming:** the fix changes what gets indexed, so
the next `init` on any repo with worktrees reports a large removed-anchor set. That is
correct, and review marks covering the duplicates land under `@orphan`.

**7. COD-3 — split the honest half from the real fix.**

The honest half is nearly free and should not wait: `isDirty()` already exists
(`src/git.ts:71`) and `snapshot()` already returns `dirty` (`src/ops/indexing.ts:298`) —
it is simply unwired. `init` never computes it, and `dirty` appears in no front-end.
Compute it in `init` and print a warning in `cli.ts`, `mcp.ts` and `serve.ts`. That is the
ticket's expectation §3, and it removes the silence today.

The real fix is expectation §1: record on the snapshot that it was taken from a dirty
tree (a column alongside the existing `scheme` / `hash_scheme` in `writeSnapshot`,
`src/store.ts:225`), and have `diff` refuse `--base <sha>` when the only cached snapshot
for that sha is dirty, saying why. **No `ANCHOR_SCHEME` bump** — the id derivation does
not change, only what is recorded beside it.

Reproduced at `4d80d65`: `init` on a tree with one newly added exported function, then
`diff <sha>` → `+0 added -0 removed ~0 changed`.

## Phase 3 — say what the sync did

**8. COD-8 §2.** A per-kind fold summary at sync (`docs 266 · triage 645 · findings 45 ·
bugs 94 · notes 0`) and honest wording for `received N event(s)` — "received" means
"pulled from the remote since the last sync", and on a fresh store that folded a thousand
events it reads as the opposite of what happened.

After COD-12, not before. The original complaint was that this line was the only output;
once materialization works on Windows the adjacent `rebuilt N of M` line fires there too,
which changes what this needs to say. The per-kind counts are the part that carries its
weight — they are what would have made the notes gap visible at sync time rather than at
query time, which was the reporter's actual point.

## What this plan does not cover

The seven open COD **tasks** (COD-2, 4, 5, 6, 9, 10, 11). Three of them state a sidecar
prerequisite and are gated on work that is only partly landed; COD-10 and COD-11 are a
pair. None of them is a wrong answer, which is why none of them is here.
