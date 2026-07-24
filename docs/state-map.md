# State map — per-aggregate state machines

Status: **implemented** (Marten analyzer).

## Why

The state machine of an aggregate — its states, transitions, and guards — is the
behavioral contract a raw diff hides, and reviews need it most exactly when a
20k-line change moves it. The state map derives it in two phases:

1. **Static skeleton** (analyzer emission, rides `analyze marten --emit` and the
   `check` auto-refresh): states from the aggregate's status enum, event →
   target-state transitions from literal assignments in `Apply`/`Create`
   methods, initial states from Create-assignments and property defaults.
2. **Enrichment** (LLM/agent- or human-authored): the parts static analysis
   can't see — **source states** and **guard conditions** live in handler
   conditionals and need judgment. Enrichment is a *versioned node citing the
   guard/Apply anchors*, so a claim goes **stale when the code drifts** and
   re-derivation becomes a visible queue instead of silent rot.

## Vocabulary

Nodes (a transition is a claim → it must be a node, because only nodes cite
anchors; edges can't):

| node | id | provenance | cites |
|---|---|---|---|
| `state` | `mst-<agg>-<member>` | generated | the status enum's shell anchor |
| `transition` (skeleton) | `mtr-<agg>-<event>` | generated | Apply/Create method + emitting handlers |
| `transition` (enrichment) | `tr-<agg>-<event>` | authored (versioned) | the guard/Apply anchors the claim rests on |

Edges: `state_of` (state→aggregate), `transition_of` (transition→aggregate —
the tether that survives even when a dynamic transition has no target edge),
`transitions_to` (transition→state target; generated when static, **authored**
for dynamic targets), `on_event` (transition→event_family), `initial_state`
(aggregate→state), `from_state` (state→transition source; **authored only** —
its presence alone means "sourced by enrichment").

## The enrichment loop (what an agent does)

1. `state_map` → each machine lists `unenriched` transition ids.
2. Read the transition skeleton's anchors (Apply method + emitting handlers).
3. `document` — type `transition`, id `tr-<agg>-<event>`, citing the guard code.
4. `connect` — `from_state` edges for each source state; `transitions_to` when
   a dynamic target was derived; `initial_state` (aggregate→state) when the
   static pass couldn't see the initial (no `Create` method / property default —
   common when the creation event folds through a plain `Apply`).
5. Trust starts `unverified`; an agent `review`/`sanity_check` makes it
   `checked`; a human sign-off makes it `verified`. Code drift → `stale`, and
   the transition re-enters `unenriched`.

The skeleton `mtr-`/`mst-` nodes are cleared+rewritten on every re-emit (same
`generatedBy: "marten"` discipline as the event graph); `tr-` nodes and
authored edges are never touched by emission. **Never store enrichment by
editing a generated node — the next re-emit deletes it** (`writeNode`'s
generated branch replaces all versions under that id).

## Authored machines — the static/model balance

The analyzer only asserts what it can prove; everything judgment-shaped is the
model's job, recorded as witness-hashed claims. That split extends to WHOLE
machines: lifecycles the fold-pass can't see — handler-mutated side documents
(`TransferRecord.State`), collection-item children (card holds in
`lane.Holds`) — can be authored end-to-end. `document` the state/transition
nodes (citing the enum and the mutating code) and `connect` the same edge
vocabulary; `state_of`/`transition_of` may tether to ANY node standing for the
machine's owner. `stateMap` treats an authored transition as its own
enrichment (no `tr-` pair needed), so it participates in layout, trust, and
staleness exactly like a generated-then-enriched one: when the cited handler
drifts, the claim goes stale and re-enters the queue.

## Gap checks (analyzer findings)

- `state-unreachable` (warn) — a member no fold assigns and no default/Create
  initializes; only fires when the machine has zero dynamic transitions.
- `transition-dynamic` (info) — target is runtime-determined; enrichment
  candidate.
- `status-prop-ambiguous` (info) — the aggregate has other enum-typed
  properties; one machine per aggregate, the status-ish property wins.
- `transition-unguarded-candidate` (info) — a handler emits a state-changing
  event without ever reading the status property: a missing-guard candidate.

## Surfaces

- MCP `state_map { aggregate? }` · HTTP `/api/statemap?u=<u>&aggregate=` ·
  web `/#/u/<u>/statemap/`.
- Layout is computed in `ops.stateMap`: BFS layers from initial states over
  authored `from_state` → `transitions_to` chains; targets of source-less
  transitions sit at layer 1 (the UI renders a "?" gutter feeding them);
  never-reached states land in a final layer. Before any enrichment exists the
  map is deliberately flat — depth appears as sources get authored.

## Known limits (static pass)

- One machine per aggregate (id convention); multi-enum aggregates surface the
  rest via `status-prop-ambiguous`.
- A status machine needs either a status-ish property name
  (`/status|state|phase|stage|lifecycle/i`) or ≥1 statically-resolved target.
  Enum-typed type/kind DISCRIMINATORS copied from payloads (`Type = cmd.Type`)
  are rejected — the Acme.API CustomFieldType/Order false-positive class.
- Reference-data statuses (`Guid InvitationStatusId = InvitationStatuses.Pending`,
  the Acme.API pattern) are invisible to the enum pass — enrichment/future work.
- Ternary/switch/call targets aren't mined — flagged `dynamic`, enrichment's
  job. Implicit state (bool/timestamp combinations) is enrichment-only.
- Guard detection is member-access-based; C# property patterns
  (`agg is { Status: X }`) aren't counted (a handler using only patterns can
  false-positive as unguarded).
- Cross-aggregate reaction/policy chains (event on A → handler → command on B)
  are a later phase, composed over the existing `emits`/`handles` edges.
