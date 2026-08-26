# Where this is — handoff, 2026-08-26

On `main`. `npm test` green (1022 unit + 89 e2e), `tsc -p web` clean.

Read `CLAUDE.md`, then this. The work queue is `docs/plan-findings-unification.md`
§ "Near-term"; the two design documents below are what to read before touching the
finding lifecycle.

## What this session did

The arc: **the finding lifecycle stopped fighting the people using it.** Everything
followed from measuring what agents actually did with the tools, rather than from what
the tools said they did.

- **`docs/finding-event-shape-audit.md`** — 491 events, 155 findings, 8 scopes. The
  evidence base for everything below. Its headline: 37 of 59 outcome reports on one PR
  were unreachable, 15 of 15 thread comments were state changes written as prose, and
  **1 of 155 findings had ever been assigned** while `close_finding` documented itself as
  the report-back for the assignment queue.
- **The ack gate stopped locking agents out.** `needsHumanAck` was doing two opposite
  jobs — filling the human queue and freezing the record. Split: `agentClosureNeedsAck`
  gates only burying a finding (confirmed, or filed by a person), promotion gates nothing,
  and `mayRevise` is unconditional. An agent's close is now recorded as a PENDING ASK with
  its reason rather than refused, which is why the prose existed.
- **History survives.** `outcomes` and `asks` are append-only; a granted close keeps the
  ask that earned it; declining an ask is a verb (`finding.askDeclined`) instead of a
  badge nobody could clear.
- **`partial` and `rerated`** — the two dispositions the canonical store had dropped. See
  `docs/plan-finding-parity.md`.
- **A verdict records the commit it was formed on**, and is refused when the checkout
  demonstrably lacks the code. This is the guard for the wrong-tree triage below.
- **Findings render at their line in the diff**, which is why raising one there used to
  look like a no-op — `report_defect` files a canonical finding and canonical findings
  reached the page only through a collapsed panel.
- **`promote_annotation`** — a pointer that turns out to be a defect becomes the finding,
  keeping its id. Its absence is what made pointers feel like a parallel system.
- **`pr-push`**: a sidecar turns off raw comment push and keeps the verdict/viewed half.
  (REVERSED 2026-08-26 — see next-step 1. Push is the escape hatch and stays everywhere.)
- **The web UI's navigation is real links** — ~50 sites; middle-click, cmd-click and
  right-click-copy work now.

## What to do next

1. ~~**Does codemap post raw comments to GitHub at all?**~~ **ANSWERED: yes, everywhere** —
   it is the escape hatch for a submitter who does not use codemap. `publishPath`/
   `publishLine`/`publishAttribution` and `pr_push` get a canonical home in SQLite (keyed
   on findings); `escalated` retires into `promotion`, which becomes the RAISE: only a
   promoted, unclosed finding is pushable, and `--only` no longer overrides that. The gate
   that disables comment push wherever a sidecar exists has to go FIRST — after the default
   sidecar lands, that predicate means nothing and push turns off universally.
2. **`docs/plan-retire-local-findings.md` — READY, and it is the work.** Unparked by (1);
   rewritten 2026-08-26 with the push guards, the promotion-as-raise gate and an eight-step
   order. The claim that makes it cheap is verified in the code: a store with no sidecar loses nothing, because the log is plain files, a
   remote-less sidecar is already supported, `resolveSidecar` already takes a bare
   directory, and `unify-findings` already replays local rows into a log.
3. The rest of `plan-findings-unification.md` § Near-term: `shared_finding` created and
   never used; `retire_shared_doc` named in three errors and not a tool; two `universe`
   namespaces. **Item 6 is back to being a real gap** now that push stays: `planPrPush` reads
   `readAnnotations` and nothing else, so nothing `report_defect` files today is pushable.
   It is step 3 of `plan-retire-local-findings.md`, not a rewrite.
4. **Open decisions on live data:** `finding_0916cfc2ad21`'s severity re-rate is sitting
   on its row for a person; `finding_79bb05ce3c19` on `Acme.React` needs one check to
   settle (re-witness at `5fbefa07`, see whether the aircraft `SearchableSelect` is
   disabled while `selectedRelease` is null).

## How to work on this — what cost time

- **Ask WHERE a rule is enforced, not just whether.** `resolve_question` and
  `resolveSharedNote` disagreed, and the tiebreak was neither op but `foldNotes`, which
  drops the event. Relaxing the op would have shipped a silent no-op.
- **A test that asserts the old behaviour is evidence, not an obstacle.** Six tests
  changed this session; each encoded a decision being deliberately reversed, and reading
  the reasoning first is what made the reversal defensible.
- **`tsc -p web` and 1022 unit tests all pass with the app completely broken.** The routes
  e2e is the only thing that catches a render-time error — twice this session, both from
  code called during render that had only ever run on click (`router` unassigned, then a
  TDZ on a `const` url builder). If you touch anything that runs at render, run that suite.
- **Verify an agent's report before acting on it.** Three of four audits this session were
  substantially right and each contained something wrong. The check is cheap and changed
  the outcome every time.
- **`cp -a` of a `/working/` repo does NOT isolate git.** They are WORKTREES: `.git` is a
  file pointing at `/home/izzie/repos/*.git/worktrees/*`, so every git command in the
  "copy" hits the real repository. Use `git clone --local --no-hardlinks`, and remove the
  scratch sidecar's `origin` so it cannot reach GitHub.

## Operational

- **The sidecar's `origin` is real** (`git@github.com:Acme/codemap-sidecar.git`)
  and `sharedSync` PUSHES. I pushed to it once this session as a side effect of a read.
  Treat any sync on a live universe as an outward-facing act.
- **`/working/Acme.API`** — annotation backlog drained: 0 unresolved `kind:"finding"` left;
  merged PRs read 2 open / 68 closed / 19 carried as bugs; 62 bugs total. 7 bugs filed this
  session are in the sidecar log and reach the team on the next sync.
- **`/working/Acme.React`** — 6 bugs filed, 5 notes kept, 31 resolved. Its PR 297 findings
  are pre-canonical annotations; `migrate-findings` has run only partially there.
- **A triage pass on `Acme.React` used the wrong tree** (`document-ui`, which predated the
  PR under review) and inverted five verdicts. `Acme.API` was re-audited and is clean —
  by branch topology, not by design, which is why the verdict guard now exists.
- `Acme.Settlement` still has not been re-indexed under the overload-id scheme.
- `docs/mcp-complaints.md` is the durable home for use reports; `docs/mcp-use-reports.md`
  and `docs/bug-walkthrough-republish-conflict.md` sit beside it.
