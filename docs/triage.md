# Design: stakes triage — routing scarce human attention on big changes

Status: **DRAFT / for brainstorm** (not approved). Sketch to argue over.

## Why

The problem this solves, stated plainly: *how do you reduce the risk of a 20k-line
PR when you dissociate after 5k lines?* A linear read-through spends your sharpest
attention on whatever happens to be at the top of the diff and rubber-stamps the
rest. The scarcest resource in review is **un-clouded human attention**, and today
nothing points it at the parts of the change that actually carry consequence.

Triage is the mechanism that points it. It grades each anchor by **stakes** (what
does an error here touch), and combines that with the **review gap** (how far the
current attestation falls short) to produce a **severity** — so the worklist sorts
by "most dangerous thing least looked at," and the golden window lands there first
while you're fresh.

This composes with the `viewed`/`signed` split (see the review-attestation work):
triage *needs* the `viewed` state, because the whole severity model turns on the
gap between *unread* and *read-but-unsigned*. Without `viewed` you can't tell them
apart, and the matrix below collapses.

## Two axes → severity

Severity is a function of two independent things:

1. **Importance** — the stakes of the anchor (blast radius if wrong).
2. **Review gap** — how far the *live* attestation falls short of what the tier needs.

### Importance tiers

Three tiers, each its own rung (Business Critical and Important are **not** merged):

| tier | meaning | example |
|---|---|---|
| **Business Critical** | an error moves money, gates a business process, or is otherwise unrecoverable | summing currency; a settlement gate; an authz boundary |
| **Important** | real business logic, consequential but recoverable | a projection with branching rules; a validation path |
| **Mechanical** | plumbing — no business logic to get *wrong*, only to *wire* | copy attributes into a projection; a DTO map; a log formatter |

Two qualifiers ride on top of the tier:

- **`likely` (agent-proposed).** An agent may *suggest* a tier it hasn't confirmed
  (`Likely Business Critical`, `Likely Mechanical`). `likely` marks provenance, not
  a lower severity — a *suspected*-critical anchor is treated as critical until a
  human says otherwise (safe direction). Confirmation (dropping `likely`) is a human
  act; it's the cheap triage pass, distinct from reviewing the code itself.
- **`unknown` — and it splits in two.** The default is that agents *do* propose a
  sane tier everywhere; `unknown` is the fallback, and it distinguishes **unchecked**
  (no triage has been attempted) from **uncertain** (an agent looked and genuinely
  can't tell — it needs your context). Both **escalate to Business Critical until
  resolved** (uncertainty never lowers the bar), but they route differently:
  *unchecked* → run an agent triage pass; *uncertain* → needs a human. The flag is
  worth carrying precisely so the worklist knows which of the two will help.

**Permission ratchet (the accountability rule).** Agents may only *raise* stakes (as a
`likely` proposal); **only a human lowers a tier.** Escalation only ever *adds*
scrutiny, so it's always safe — an agent may raise even over a **human** mark when it
finds a mis-flag or code that grew teeth (a once-mechanical part that now sums currency
or emits an event); the escalation re-enters the human's confirm queue rather than
silently overwriting. What no automated source may ever do is *lower*: a silent demotion
of business-critical to mechanical would be the accountability-bearing call — the exact
hole `signed` exists to close. One nuance: the **blind graph batch** (`triage_derive`)
respects a human mark (no new evidence, so re-runs don't nag) — a *deliberate* agent with
evidence escalates via `triage`, and code-change-driven re-escalation is the witnessed
Phase-4 path.

### The severity matrix

Reusing `BugSeverity` (`low | medium | high | critical`) so triage severity and bug
severity read on one scale:

| importance | **unread** (no live `viewed`) | **read but unsigned** |
|---|---|---|
| **Business Critical** | `critical` | `high` |
| **Important** | `high` | `medium` |
| **Mechanical** | `low` | — (sign-off not required) |

Two principles generate the shape, and the table is the authority where they don't
fully agree:

1. **Unread outranks unsigned, at every tier.** This is the non-obvious core, and it
   inverts the naive read ("signing is the higher bar, so missing it must be worse").
   It isn't: a read-but-unsigned anchor has already had human eyes and intuition on
   it — the danger has been *sampled*. An **unread** anchor is a blind spot. Severity
   tracks the *exposure* gap, and the emergency is high-stakes code **no human has
   looked at**. The incident-room test: *"what do you mean you didn't read the code at
   all"* is the sentence this whole system exists so you never have to hear.
2. **Higher stakes raise the baseline.** Same gap, more stakes → more severe.

Consequences worth stating explicitly:

- **Mechanical needs only a read, never a sign-off.** There's nothing complicated to
  verify; a cheap `viewed` pass clears it (and even that is only `low` if skipped).
  Sign-off on plumbing is wasted golden-window.
- **The Business-Critical blind spot is the top of the worklist.** BC + unread =
  `critical` = drop everything. It's the single state the whole system exists to
  surface before you ship.

### Staleness composes for free

Severity runs on **live** attestation, and a stale mark counts as *missing* for its
gap:

- A BC anchor you **signed**, then the code moved under you → signature stale →
  reads as *unsigned* → `high`. (And louder than a never-signed one, per the
  signature-decay work: "your signature no longer covers the shipped code.")
- A BC anchor you **viewed**, then it changed → view stale → reads as *unread* →
  back to `critical`.

So decay (from the attestation work) and triage multiply: a change doesn't just grey
out a check, it **recomputes severity and re-sorts the worklist**.

## Grounding stakes in the graph, not vibes

Stakes is exactly the judgment an agent is *worst* at — it can't reconstruct a year
of meetings — so a pure LLM "this feels risky" score is the wrong instrument. But
codemap is event-sourcing-aware, and **the pipeline graph is a blast-radius oracle.**
Much of importance is *derivable*, not guessed:

- an anchor whose handler **emits a business event** (`SettlementCompleted`) → BC;
- an anchor **reachable from a money-typed field** / currency arithmetic → BC;
- an anchor that **gates a command** on the flow graph → at least Important;
- an anchor that only **folds attributes into a projection** with no branching → a
  strong *Mechanical* signal.

So triage is **graph-derived first**, and the LLM only fills anchors the graph can't
reach a consequence for — and when it can't, that's `unknown` → escalate. This is the
honest version and it leans on what's already built (node catalog, event matrix,
pipeline graph).

**Proximity inheritance.** Risk clusters by location. A new or `unknown` anchor in a
file that *previously held* Business-Critical / Important anchors inherits **`Likely`
(elevated)** status until triaged — high-stakes files are presumed to keep producing
high-stakes code, so a fresh symbol there is guilty until read. This composes with
graph-staleness re-derivation: when the pipeline graph changes (an emit added/removed),
graph-derived tiers re-derive under the same `generatedBy` clear-and-rewrite discipline
as analyzer nodes — and any anchor thereby orphaned from its old high-stakes wiring
drops to `Likely`-pending rather than silently to Mechanical.

## Two jobs, one flag: review-bar vs tripwire

`Business Critical` does double duty, and the two duties are **orthogonal**:

1. **Review-bar** — sets what "done" requires (drives the worklist + coverage).
2. **Tripwire** — *"if this changes unexpectedly, tell me,"* independent of whether
   it's been reviewed. You want this on things you've **already signed off**.

The witness hash is already the tripwire mechanism — here it's pointed at
*notification* instead of staleness. So a `signed` **+** `Business Critical` anchor is
"I own this, and page me the instant it moves." Keep the tripwire separable from the
tier so it can be armed on fully-reviewed code.

**Dismissal requires a human re-attestation — nothing auto-clears.** When a mark goes
stale it returns to the worklist and *stays* there until the human re-approves: a
re-`sign` dismisses it; a re-`view` reduces it to the read-level severity (but doesn't
dismiss). Severity can go *down* only by a human looking again — code can never be
permanently dismissed by the passage of time or by a re-index. This is the operational
form of "reviewed = meaningfully checked, not 'I got tired of reading.'"

## Re-triage on change (promotion)

The "plumbing grows teeth" case: an attribute-copy that starts summing currency. This
falls out of the machinery already:

1. Witness hash fires when the Mechanical anchor changes (decay).
2. Change → **re-triage** (graph-derived, cheap).
3. Re-triage may **raise** the tier — Mechanical → Business Critical — which
   **re-opens it on the worklist at the new severity.**

This also defines "considerably changed" precisely (a Mechanical item shouldn't
re-alert on a rename): it changed *considerably* **iff re-triage raises its tier**.
Cosmetic edits don't move the normalized hash; teeth-growing edits do.

## Coverage & reporting

Coverage becomes a **severity distribution**, not a single %:

- **Per anchor:** its cell in the matrix (or "complete").
- **Per module / flow:** the count in each severity cell, headlined by the worst
  non-empty cell — extends the review rollups the node catalog / outline heatmap
  already compute per module.
- **Universe:** the same rollup at the top ("2 critical, 5 high, 11 medium, …") —
  the dashboard "needs attention" landing already has the shape.

**Review-complete (per anchor)** = live attestation meets the tier's bar:

| tier | bar to be complete |
|---|---|
| Mechanical | `viewed` (agent `checked` + standing invariants also clears the floor) |
| Important | `signed` |
| Business Critical | `signed` (+ tripwire armed) |

A **flow/PR is review-complete** when every anchor it touches is complete. That is the
number that answers "am I actually done reviewing this 20k-line change?" — which a raw
diff can never tell you — and it's stakes-relative, so it doesn't demand golden-window
sign-off on plumbing.

## Data-model sketch (to argue over)

Triage is a **classification on the anchor**, not a review level — a property that
*modifies what review the anchor requires*, closer to `generatedBy` provenance than to
a `Review` row.

```ts
export type Importance = "business-critical" | "important" | "mechanical";

export interface Triage {
  target: { kind: "anchor" | "node"; id: string };
  importance: Importance;
  likely: boolean;              // agent-proposed, unconfirmed by a human
  tripwire?: boolean;           // alert-on-change, independent of the review bar
  source: "graph" | "agent" | "human";
  generatedBy?: string;         // provenance when graph/agent-derived (re-emit safe)
  reason?: string;              // e.g. "emits SettlementCompleted"
  at: string;
  witnesses: BugWitness[];      // re-triage trigger: hash drift → recompute
}
```

- **`unknown`** isn't stored as a tier (no fourth rung) — it's the *absence* of a
  confident triage, surfaced as BC-until-resolved. The **unchecked vs uncertain**
  split (agent never looked vs agent looked and can't tell) is either a stored
  `uncertain?: boolean` or derived from `source === "agent" && importance == null` —
  see Still-open #3.
- **Ratchet enforcement** lives in the write op: an `agent`/`graph` source may set any
  tier as `likely:true` or *raise* a confirmed tier; only a `human` source may lower a
  tier or clear `likely`.
- **Rolls up** to nodes/flows/modules exactly like reviews (a node's importance = max
  over its anchors), reusing `coveredAnchorIds` and the existing rollup batching.
- **Composes** with `viewed`/`signed`: severity = `f(triage.importance, attestation
  gap)` computed against live hashes — one function over the two subsystems, no new
  staleness machinery.

## Standing invariants & the auth lens

"Sign-off not needed" ≠ "unchecked." The clarifying case is **auth**: the
tenant/endpoint authorization code in this repo is itself *very mechanical* (attributes
and guards wired around), and agents are **excellent** at finding auth defects — yet it
is security-critical despite the project's defense-in-depth. So auth is **not a stakes
tier** on the business-logic axis; it's an **orthogonal security lens** that cuts across
every tier.

Decisions:

- **Model standing invariants (authz, PII, unbounded-query) as named lenses**, run by
  agents on every anchor regardless of its stakes tier — waiving *human* review never
  waives the standing checks.
- **A dedicated review surface** for the auth lens — a *tenant/endpoint auth* page
  listing every scoped endpoint and its guard status — because auth review wants to be
  swept endpoint-by-endpoint, not scattered through the stakes worklist.
- **A human `view` is still required even for Mechanical + auth-clean code.** Agent
  clearance reduces urgency but cannot *permanently dismiss* — without a human view the
  anchor stays a (low-severity) work item forever. Nothing in the repo is allowed to
  reach "no human ever needs to look at this."
- **Open sub-question:** do standing-check results live as a distinct *check result*
  type, or just as `bug`s tagged with the lens? (Leaning: a lightweight check result
  so a *clean* pass is recordable, since "no bug" and "checked, clean" differ.)

## Confirming `likely` at scale

Human-owned, but it must be **cheap**: a bulk-confirm affordance ("confirm all
Likely-Mechanical in this module") plus a quick-review UI, or triage never converges on
a large repo. This is the human end of the ratchet and needs first-class UI, not a
per-anchor click.

## Still open

1. **Tripwire delivery.** Where does the alert surface — diff page, dashboard, an MCP
   `notifications` read, all three?
2. **Check-result vs bug** for standing invariants (see auth lens above).
3. **`uncertain` flag: explicit field or derived?** We want the unchecked/uncertain
   distinction; open whether `uncertain` is a stored flag on the triage record or
   inferred from `source === "agent" && !importance`.

## Agent workflow (MCP)

Triage is designed to be agent-drivable — an agent does the first cut, a human
confirms. The methodology (`guide` tool) documents it; the tools:

- **`triage_derive`** (no args) — the honest first pass over the whole graph:
  money-name → business-critical; emits-a-domain-event / command / handler /
  aggregate / event → important; projection → mechanical; proximity elevates
  untriaged neighbors of high-stakes modules; anchors inherit their citing nodes'
  max stakes. Regenerable (clears prior graph marks), never touches human/agent marks.
- **`triage`** (`targetKind`, `targetId`, `importance`, `reason`) — an agent raises
  the stakes of a node/anchor the graph couldn't judge. Always a `likely` proposal,
  **raise-only** (the ratchet). A human confirms/lowers via the web UI and owns the
  final call; agents can never override a human mark.

The intended loop: agent runs `triage_derive`, then `triage`s the judgment calls it
can trace, leaving the rest untriaged (escalates) for a human to confirm.

## Staging

- **Prereq (DONE):** `viewed`/`signed` split + `changedSince` targeted diff.
- **Phase 1 (DONE):** the `Triage` record + ratchet write op; manual/agent tier
  assignment; severity function + per-anchor readout; consistency across all surfaces.
- **Phase 2 (DONE):** graph-derived importance (`deriveTriage` / `triage_derive` /
  node-catalog "derive stakes"): money-name + emit-reachability + node-type priors +
  proximity inheritance + anchor inheritance. Ratchet hardened so a human mark is
  authoritative (agents can't re-raise a deliberate lowering). `unknown` = untriaged,
  escalates. Witnesses are stored empty for now — re-triage-on-change is Phase 4.
- **Phase 3:** coverage rollups per module/flow/universe; the review-complete metric
  on the diff/PR view.
- **Phase 4:** tripwire arming + delivery; re-triage-on-change promotion (witness the
  derived marks, re-derive on drift, escalate a mechanical anchor that grew teeth).
