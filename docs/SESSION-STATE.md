# Where this is — handoff, 2026-08-25

On `main`, at `a6b6f23`. 970 unit + 89 e2e green, `tsc -p web` clean.

If you are picking this up cold: read `CLAUDE.md`, then this, then
`docs/plan-findings-unification.md` § "Near-term" for the work queue. The earlier
`fix/selfreview-backlog` handoff this file used to hold is in git history; it is closed.

## What this session did

One arc, chased end to end: **two kinds of finding, and two kinds of walkthrough, became
one each.** Everything below followed from that, mostly because closing one half kept
exposing the next.

- **Walkthroughs** got a canonical table (`walkthroughs`, keyed `(pr, author)`);
  `shared_walkthrough` is dropped. Before that, a teammate's walkthrough travelled,
  folded, and sat in the reader's own database while the pull-request page told them "no
  agent has walked this one". `pr_walkthrough` publishes as it writes;
  `pr_walkthrough_chapter` rewrites ONE chapter; four tools became two.
- **Findings** got `codemap unify-findings` — one-time, replays history rather than
  copying, refuses anything whose replay would forge attribution. Verified on a clone of
  the production store: 45 local findings published, 0 refused.
- **The create tap is shut** so the migration cannot be a treadmill: `annotate` refuses
  `kind:"finding"`, `pr-ingest` routes to `report_defect`, and declared enums are now
  ENFORCED — nothing validated `inputSchema` before, so the enum was documentation.
- **Every finding tool dispatches on the record.** `defer_finding`, `record_published`
  and `relocate_finding` dropped their `pr`; two of them had been returning `{ok:true}`
  for events the fold silently drops.
- **The ratchet gates on CONFIRMATION, not filing state** — an agent may close or sharpen
  what nobody has stood behind; past a confirm or a promote, only a person.
- **Two axes findings did not have:** `remediation` (so "was real, and has been fixed"
  stops being written as `refuted`) and `withdraw` on `request_human`.

Commits `a8e6203`…`a6b6f23` carry the reasoning; each one states what it rejected and
why, which is usually the more useful half.

## What to do next, in order

**1. `inbound_replies` reads the log while everything else reads canonical.** It answers
`"nothing from here has been published to the pull request"` over twelve findings each
carrying a `postedRef`. This is first not because it is biggest but because of its
SHAPE: it does not say "no replies yet", it asserts a premise, and an agent that believes
it stops looking — reporting "no submitter response" on a PR where every finding had been
answered. One-line class of fix, high blast radius if left.

**2. Notes are the last parallel table** (`shared_note`), and the mirror is
one-directional. So `questions` — the tool that calls itself "the 'answer these to improve
the docs' queue" — cannot see a teammate's question, and `resolve_question` cannot close
one. Docs, bugs, findings, triage and walkthroughs all went canonical; notes did not. This
is the last real instance of the pattern the whole session was about.

**3. Audit what reads pointers.** Izzie's call, and a good one: pointers are a legitimate
kind — a review aid is not a defect — but they are now the only thing `annotate` writes at
volume, on machinery everything else has moved off. Find out what still reads them and
whether that path has an owner, *before* it becomes the next thing quietly holding half a
picture.

**4. Small and mechanical:** `shared_finding` is created and never used (the file's own
rule, three lines above it: "a table nothing writes is a table somebody reads by
mistake"); `retire_shared_doc` is named in three user-facing errors and is not a tool;
bulk-folded bugs carry an epoch `filedAt`; two `universe` namespaces — every shared read
prints the `owner/repo` slug and the `universe` INPUT wants a workspace id, so a tool
prints an identifier the next call refuses as unknown.

## How to work on this — what cost time here

- **Ask who validates a rule before trusting it.** Two defects this session were a stated
  rule with no enforcement: the `annotate` enum (nothing checked `inputSchema`) and
  `additionalProperties` (only the CLIENT checks it). My first fix for the second one
  passed its own mutation test, which is how I found out I had fixed the wrong layer.
- **Mutation-check every new assertion.** Four of them here would have passed under the
  defect they were written for. The oracle asserted a walkthrough's TRANSPORT and never
  the surface, which is exactly why the gap was invisible from inside it.
- **Verify agent and report claims.** An MCP-surface audit was mostly right and partly
  wrong; two complaint items were withdrawn by their own author once the split store
  explained them. `record_published`'s silent no-op, by contrast, reproduced in one call.
- **Validate on scratch clones of `/working/`, never in place** (`CLAUDE.md` says this;
  it earned its place twice today). `cp -a` the universe and the sidecar, point the copy's
  workspace manifest at the copy, and check `find … -newermt` afterwards to prove the live
  one was untouched.

## Operational

- `codemap unify-findings` has NOT been run on the live `Acme.API` store — only on a
  clone. It publishes 45 findings to the team and re-attributes their legacy author
  strings to whoever runs it; that is Izzie's call to make.
- `/working/Acme.API` still holds doubled walkthrough rows for PRs 269 and 271 (the
  migrated `''` row beside the published one). Harmless — they render as "1 other
  reading" — and they collapse the next time either is re-walked or published.
- `Acme.Settlement` has still not been re-indexed under the overload-id scheme.
- The push-to-GitHub UI has still never posted for real.
- `docs/mcp-use-reports.md` is the durable home for use reports;
  `docs/bug-walkthrough-republish-conflict.md` is one kept as history because its
  diagnosis explains a fix that deliberately is not the one it proposed.
