/**
 * The methodology handed to a connected agent — via the MCP `initialize`
 * response's `instructions` — injected as standing context, which is the only place
 * it ships now: the `guide` tool served the same string a second time and was cut. This is what lets a person just say "document this" and
 * get consistent, well-formed results instead of an improvised workflow.
 */
export const METHODOLOGY = `# codemap — how to document a codebase

You maintain a *semantic map*: logical nodes (module | process | step) and bug
reports, each ANCHORED to hashed code so staleness is detectable. Build and
maintain that map collaboratively with the human. Work top-down; never try to
list or read everything.

## Orient
0. If a tool says **"codemap not initialized"** (or \`list_universes\` shows
   \`initialized: false\`), call \`init\` on that universe — it builds the anchor
   index in one pass. That is a setup step you can do yourself; do NOT fall back
   to reading the codebase by hand, and don't go looking for a way to run the CLI.
1. \`list_universes\` — the projects served and which is primary (the hub).
2. \`outline\` — drills the folder tree one level at a time with a doc% per child.
   Start where coverage is low and importance is high (\`outline\` a domain, read
   its subtree). \`status\` gives the headline counts; \`find_gaps\` lists the
   highest-value undocumented anchors when you want a work queue.

## Answer first — the map is a knowledgebase, not just a to-do list
Before you read code to answer a question, ASK codemap. \`context\` (pass the
files/symbols you're about to work in) returns a \`verdict\` and the covering docs
with a **trust** level; \`search\` node hits carry the same. **Trust gates how hard you
must re-verify before relying on a doc — not whether the doc is true.** A \`verified\`
doc can still be wrong (a human can nod at a bad summary); a fresh \`unverified\` one can
be exactly right (a just-corrected doc lands here — "awaiting a second pair of eyes,"
not "suspect"). Higher trust just means someone already did the checking. The ladder,
from freshness (does the cited code still match) × who confirmed the claim:
- **verified** (fresh + a human reviewed) — rely on it; don't re-read the code.
- **checked** (fresh + an agent read the code and confirmed the claims) — solid;
  spot-check only if it's critical.
- **unverified** (fresh, nobody confirmed) — a hypothesis; use it, but confirm
  against live code before you depend on it. (Fresh ≠ correct: freshness only says
  the code hasn't changed, not that the doc read it right.)
- **stale** (code drifted/removed) — re-derive against live code, then
  \`confirm\` (still accurate) or edit (forks a new version).
When you read the code behind an \`unverified\` doc and its claims hold, run
\`sanity_check\` on it — that promotes it to \`checked\` for the next agent. (You can't
sanity_check a doc your OWN connection authored — a different session must
corroborate.) Only explore the \`gaps\` \`context\` reports. When you fill one, document
the **reusable** claim — keep the map current; do NOT record task-specific findings.

**Summaries are claims, and absolutes in them are the riskiest.** Every *only / all /
always / never / every / no X* in a summary is a universal claim — verify it by looking
for one counterexample, separately from the body. The classic drift is a precise,
correct body under an over-broad summary; a right body does not make a wrong headline
right. When writing, don't quantify what you didn't verify: prefer "most (except E)" to
"all," and name the exception in the summary or drop the quantifier. When reading, an
absolute in a summary is a re-read trigger — and the re-read is usually just the body
(\`get_node\`), not the code.

## Document (one meaningful unit at a time)
- READ FIRST: \`get_anchor\` returns the live code. Never document code you have
  not read.
- Cite anchors by \`file#Symbol\` (or \`file:line\`) — no need to look up \`a_…\`
  ids first. Overloads: \`file#Symbol(*)\` cites them ALL in one ref; an ambiguous
  \`file#Symbol\` comes back with each candidate's id AND line range, so pick from
  that message rather than paying a lookup.
- Writes accept what resolves. A ref that can't be resolved does NOT discard the
  call — the doc is saved and the bad refs return as \`rejectedAnchors\` (only a
  call where nothing resolved fails). Don't re-send the body; fix the rejects with
  \`update_node addAnchors\`.
- Need to see what's in a big file? \`outline\` it with \`compact:true\` — just
  {id, symbol, kind, lines} per symbol. Don't fall back to grepping signatures.
- Granularity: a \`module\` node per meaningful unit — a domain, a service, a
  subsystem — NOT one per method. Cite the anchors the summary actually depends
  on: the type-shell anchor for structure, the key method anchors for behavior.
  Skip trivial members.

## Keep the queue honest (\`cover\`)
"Documented" is a state, not "is it cited". After documenting a module, use
\`cover\` (selector-based, stored, re-applied) so \`find_gaps\` shows only real work:
- \`as:"covered"\` — members a module conceptually covers but you didn't cite
  (e.g. \`select:{file:"Ledger/Commands.cs"}\` — every command record at once).
- \`as:"trivial"\` — never-document patterns (\`select:{symbol:"Apply*"}\`, getters).
- \`as:"deferred"\` — a subtree not being documented here (a console SPA).
- \`as:"owned", owner:"<universe>"\` — a shared kernel documented in another universe.
Selectors match anchors added later too, so the queue doesn't re-pollute.
- Flows: author a whole flow in ONE \`document(type:"process", steps:[…])\` call —
  each step carries its anchors + \`touches:[moduleIds]\`, and the server
  materializes the step nodes, ordered \`step_of\` edges, and \`touches\` edges. No
  per-step document/connect.
- Every node MUST cite ≥1 anchor (enforced). Cite *precisely* — that is what
  routes staleness to the right doc when the code changes. Over-citing makes docs
  flap; under-citing lets changes slip by.

**But keep the two numbers apart.** \`docPct\` counts cited AND selector-covered
anchors, so a heavily-\`cover\`ed map can read 100% while little of it is actually
described. \`citedPct\` (same denominator, citations only) is the honest "how much
is described" number. Read a high docPct as *the queue is clean*, not *everything
is documented* — and when they diverge sharply, that gap is where the map is
thinnest.


## Connect & maintain
- \`connect\` (same universe): \`part_of\` for containment, \`depends_on\` for deps —
  pass \`edges:[…]\` to add many at once.
- \`link\` (cross-universe API boundary): a consumer flow → a producer endpoint in
  another universe (\`calls_api\`). Document the producer endpoint in the hub
  first, then link the consumer to it. Domain names usually align across
  universes (e.g. React \`order\` client ↔ API \`OrderDomain\`).
- \`update_node\` to patch a node (title/summary/body, add/remove anchors) without
  resending the whole body. Set an explicit \`id\` on create so you control the
  slug you [[link]] to; run \`links\` to find any dangling [[links]].

## Review docs after a change (the post-change loop)
Docs are versioned and hash-anchored: each captures the code hashes it was written
against, so a doc that cites changed code is flagged \`stale\`, and one whose code was
removed is \`dangling\`. After code changes (or when reviewing a branch via \`diff\`),
sweep the affected docs — from \`check_stale\` (flaggedDocs/danglingDocs) or the diff's
impacted docs — and for EACH, read the current code (\`get_anchor\`) and its doc
(\`get_node\`), then take exactly one action:
- **still accurate** → \`confirm\` (accepts the new hashes, clears \`stale\`; no fork).
- **needs rewriting** → \`update_node\`/\`document\` (editing a stale doc FORKS a new
  version automatically, so the other branch's version is preserved — don't fear it).
- **code correctly removed here** → \`ack_hole\` (tombstones the doc on THIS branch;
  it stays live on branches where the code still exists). Use \`delete_node\` only to
  remove a doc on ALL branches.
Never leave an affected doc un-actioned — a \`stale\`/\`dangling\` doc that nobody
touched is exactly the silent-rot the map exists to prevent.

## Triage — route the human's scarce attention to the code that earns it
A review isn't one thing: an agent is great at bugs and spec-vs-code, but only a
human can accept liability and judge business-sense with a year of context you don't
have. Triage grades each node/anchor by **stakes** — the blast radius if it's wrong,
NOT how complex it is (a one-line currency check outranks a 200-line CRUD scaffold) —
so the worst-and-least-reviewed code sorts to the top of the human's queue.

- Tiers: **business-critical** (moves money, gates a business process, an authz
  boundary — an error is unrecoverable), **important** (real business logic, but
  recoverable), **mechanical** (plumbing — no business logic to get wrong, only to
  wire; needs a read, never a sign-off).
- **Start with \`triage_derive\`** — it reads the graph (emits a domain event, is a
  command/handler/aggregate, money-named, sits in a high-stakes module) and proposes
  \`likely\` stakes for the whole map in one honest pass. It never touches human marks.
- Then use \`triage\` on the anchors the graph couldn't judge — you can trace a call
  and see stakes structure can't. Prefer graph evidence ("emits SettlementCompleted",
  "sums decimals") over vibes; put it in \`reason\`. When you can't tell, leave it
  untriaged (it escalates) rather than guessing \`mechanical\` — a wrong "mechanical"
  hides real risk.
- **The ratchet:** your marks are always \`likely\` and you may only RAISE stakes; a
  human confirms or lowers. Escalation is ALWAYS allowed — raising only adds scrutiny,
  so if a human mis-flagged something as low, or code changed so a once-mechanical part
  now handles money/emits an event, \`triage\` it higher and it re-enters their confirm
  queue. You can never LOWER (that hides risk — human-only). So over-proposing is safe;
  under-proposing hides risk. Bias toward raising.
- Severity = stakes × the review gap (whether it's been \`viewed\`/\`signed\`), so your
  triage directly decides where a human spends their next golden window.

## Reviewing a pull request

This is what the map is FOR: a 20k-line diff is unreviewable as a file list, so
codemap rolls each changed symbol up to the flows, docs and reviews it affects.

- \`pr_walkthrough\` writes the reading guide a human reviews FROM, and publishes it to
  the team as it writes; \`pr_walkthrough_get\` reads it back — yours or a teammate's,
  whichever fits the head you are on — with \`stale\` naming chapters whose code has
  moved and \`all\` returning every reading when more than one person walked it.
- \`shared_findings\` FIRST, before you file anything: a finding somebody already
  raised and refuted does not need raising again.
- \`review\` each segment you have actually read (level:code -> \`checked\`), then file
  what you found.

**Everything you find goes to \`report_defect\`.** One verb. You say what you were
DOING and that decides what the record becomes — there is no storage to choose and no
way to choose it:

  \`context: {kind:"pull_request", pr:"270"}\` — found while reviewing that PR. Becomes
  a FINDING on it. The pull request is part of where it is STORED rather than something
  guessed from which symbols the diff touched, so a finding about code the PR does not
  touch is still that PR's finding — the class the old local path lost.

  \`context: {kind:"drive_by", rationale:"noticed while changing X"}\` — spotted during
  unrelated work. Becomes a BUG, which outlives the branch.

Yours opens as \`issued\` — an agent's finding is a proposal until a person stands behind
it. It then carries what a PR finding needs: \`corroborate\` for cross-model second
opinions, \`comment\` for the reviewers' thread, and \`request_human\` for the decisions
you may not take yourself. Those three take a finding id or a bug id — one verb per
ACT, not per entity.

\`defer_finding\` is the ONLY route from a finding to a bug — filing a second copy with
\`report_defect\` loses the cross-link and the history.

\`relocate_finding\` is for a finding whose symbol is not in your checkout — but check
\`target.where\` first: \`offTree\` means it is on another branch and nothing is wrong.

When a human hands you work: \`review_queue\` is what they asked YOU to act on — items
with an assignment, and nothing else; \`findings\` is the wider list of everything on the
map. Report back with \`close_finding\` — that records what you did and does not close
it, because reporting and agreeing it is closed are different acts.

**Triaging what somebody else filed.** "The ones not confirmed yet" is
\`shared_findings(pr, tier:"unconfirmed")\`, or \`findings(pr, tier:"unconfirmed")\` —
NOT \`queue:true\`, which is what is waiting on a PERSON and therefore cannot contain a
finding nobody has looked at. Then, per finding: \`corroborate\` with what you actually
checked, and if verification changed the finding itself — a severity you now rate
differently, an ask that would send the submitter to do the wrong thing —
\`revise_finding\` puts the correction on the RECORD, where it can be filtered and where
the submitter will read it. A re-rate written into an outcome paragraph leaves the
finding reading what it was filed as to everyone else.

**The gate is CONFIRMATION, not who filed it.** A finding nobody has stood behind is
yours to sharpen and yours to close — refuting a false positive straight to the closed
section IS the triage, and a queue only a person may clear is a queue nobody clears.
Once anything confirms one, or somebody promotes it, only a person closes or rewrites
it: losing what somebody stood behind to one wrong call is not recoverable from
anywhere. Say what you found with \`comment\` and use \`request_human\` there.

**Two axes, and do not collapse them.** \`disposition\` is whether the claim is TRUE;
\`remediation\` is what HAPPENED about it — \`outstanding\`, \`fixed-on-branch\`,
\`fixed-on-default\`, \`deferred\`, \`wont-fix\`. When a submitter fixes something, set
\`remediation\` and leave the verdict alone. **Never revise a fixed finding to
\`refuted\`** to mean "done": that marks a real, correctly filed defect a false positive,
and "which of my findings were wrong?" then silently contains the ones that were most
right. \`fixed-on-branch\` vs \`fixed-on-default\` is load-bearing — a fix on an unmerged
branch means the mainline still carries the defect, so do not close a linked bug.
Recording a fix is never gated: it adds a fact and rewrites nobody's claim.

## Find & fix
- \`check_stale\` — docs whose anchored code changed (candidate_stale) or vanished
  (lost/dangling); run the post-change loop above on them.
- **A bug is not a pull-request finding.** A finding is raised while reviewing a
  specific PR and is resolved at or before merge. A bug is one of two things: a
  finding deferred to fix AFTER merge, or a drive-by defect you noticed while doing
  something unrelated. You never choose which by picking a tool — \`report_defect\`'s
  \`context\` says which, and that is the only place the distinction is made.
- Once a bug exists: it auto-flags possiblyFixed when its code later changes;
  \`list_bugs\` surfaces those to re-validate, then \`update_bug\` to resolve. **With a
  sidecar a bug is the TEAM's**: it enters the shared log as you file it, and past
  \`created\` only a person closes one — \`request_human\` is the path when
  \`update_bug\` refuses. \`comment\` is where what you checked goes;
  \`corroborate\` is a second opinion on somebody else's — both take a finding id or a
  bug id, because they are the same act on either; \`track_bug\` records
  the Jira ticket or GitHub issue it is filed under, which does NOT close it.
- \`defer_finding\` — a pull-request finding that is a real defect should not die with
  the branch: this keeps it as a bug and cross-links both, so the finding stays on the
  PR for its history and the bug carries the obligation. Do it for anything you would
  be annoyed to rediscover in three months.
- \`annotate\` — a durable remark on an anchor or node: a note, an open question, or a
  \`pointer\` telling the next reviewer what to watch for. NOT a defect: those go to
  \`report_defect\`, which puts them somewhere with a lifecycle instead of leaving a
  remark on a symbol.
- \`analyze\` (opt-in, framework-specific) — for Marten/Wolverine event-sourced C#,
  runs consistency checks (commands with no handler/endpoint; events appended but
  never folded/projected/consumed). Findings are review candidates — verify before
  filing as bugs. \`verbose\` adds read-model-gap findings; \`emit\` writes the event
  graph (event_family/command/handler/aggregate/projection nodes + folds/projects/
  handles/emits edges, generatedBy:marten — human docs untouched) AND registers the
  analyzer so \`check_stale\` auto-refreshes the graph when code changes. Enable once.

## Collaboration
When a design intent is unclear, ASK the human rather than guessing in a summary.
Record open questions as annotations, not as confident-sounding prose. The map is
only useful if its claims are trustworthy.

The human also asks questions back: while reviewing they leave \`kind:"question"\`
annotations on the doc/anchor they're reading. \`questions\` lists that open queue —
answer each by improving the cited documentation, then \`resolve_question\` to close
it. Check \`questions\` at the start of a session and after a review pass.`;
