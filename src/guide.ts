/**
 * The methodology handed to a connected agent — via the MCP `initialize`
 * response's `instructions` (injected as standing context) and the `guide` tool
 * (on-demand recall). This is what lets a person just say "document this" and
 * get consistent, well-formed results instead of an improvised workflow.
 */
export const METHODOLOGY = `# codemap — how to document a codebase

You maintain a *semantic map*: logical nodes (module | process | step) and bug
reports, each ANCHORED to hashed code so staleness is detectable. Build and
maintain that map collaboratively with the human. Work top-down; never try to
list or read everything.

## Orient
1. \`list_universes\` — the projects served and which is primary (the hub).
2. \`outline\` — drills the folder tree one level at a time with a doc% per child.
   Start where coverage is low and importance is high (\`outline\` a domain, read
   its subtree). \`status\` gives the headline counts; \`find_gaps\` lists the
   highest-value undocumented anchors when you want a work queue.

## Document (one meaningful unit at a time)
- READ FIRST: \`get_anchor\` returns the live code. Never document code you have
  not read.
- Cite anchors by \`file#Symbol\` (or \`file:line\`) — no need to look up \`a_…\`
  ids first. Ambiguous names come back with the candidate list; disambiguate.
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

## Find & fix
- \`check_stale\` — docs whose anchored code changed (candidate_stale) or vanished
  (lost); refresh those.
- \`report_bug\` — anchor a defect to the exact code. It auto-flags possiblyFixed
  when that code later changes; \`list_bugs\` surfaces those to re-validate, then
  \`update_bug\` to resolve.
- \`annotate\` — leave a note or open question on an anchor/node for the human or
  a future session.
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
only useful if its claims are trustworthy.`;
