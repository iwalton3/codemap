# Proposal: provisional business rules in the standard

**From:** the /spec redesign planning run (skills repo, `.git/plan/2026-10-05-spec-redesign`),
2026-10-05. A proposal, not a ruling.

## The gap

`RequirementStatus` is `"ratified" | "retired"` (`src/schema.ts:970`). A business rule the owner has
settled for now but expects to change has no place in the standard. Acme.API's `docs/rules/` already
draws that line: each rule is **ratified** (not on the roadmap to change) or **provisional**
(interim, expected to change), and the owner sets the status (`docs/rules/INDEX.md:8-9`, owner
2026-09-30). For example, "Delegate complicated or edge cases to a human in v0" is provisional.

Codemap is designed as the source of truth. Because it cannot hold provisional rules, the reshaped
`/spec` will use an interim arrangement:

- The repository is authoritative for now: `docs/rules/` for level-4 business rules, and the spec
  cluster for level-5 design rules.
- Each rule is written as one block with an id, its status, its reason and the owner's words, so it
  can be ingested mechanically later.
- At sign-off, only ratified rules enter codemap.
- When codemap can hold provisional rules, it becomes the single source and the repository copy
  becomes a mirror.

## What would close it

A third status, or an orthogonal flag, for a business rule the owner has settled but marked
interim. Questions for whoever designs it:

- **Does a provisional rule bind the scrub and audits?** Today they read `status: "ratified"` only
  (`src/scrub.ts:142`, `:216`, `:296`; `src/audits.ts:574`). A provisional rule is still the rule in
  force. It is just expected to move.
- **How does a rule move from provisional to ratified?** By a new operation, or by a status change
  on the same id? Its owner quote and time should survive the change.
- **Is "provisional" the owner's call alone,** as it is in `docs/rules/`?

## What stays out

Level-5 design rules do not belong in the standard as ratified requirements. Izzie, 2026-10-05:
"I don't think design rules should be ratified as standards in codemap, standards can't reference
code only pointers between standards and code can". They stay in the spec cluster. Pointers from
standards to code are where design shows up in codemap.
