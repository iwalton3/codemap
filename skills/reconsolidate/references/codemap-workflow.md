# Codemap workflow

For a records repo that is **cut over**: `git check-ignore -q docs/rules/INDEX.md` succeeds there,
so its rules live in codemap's standard and `docs/rules/` is generated from them. The codemap
skill's *Rules in a cut-over repo* (`codemap/SKILL.md`) is the rule; this is how this skill carries
it out. Not cut over, the skill runs as written. Business rules need the codemap MCP tools in this
session; without them, run the principles and record the business rules' words in the run record,
saying they are not in force anywhere yet.

## Before it starts

`docs/rules/` existing is not the test here: the standard is. Read the rules with `requirements`
and `status: "ratified"` (levels 1-4, each with its `r_…` id; a retired rule is history and explains
nothing now), and the drafts still waiting on the owner: `standard_queue` with `pending_specs` lists
them by id and count only, so read each with `spec` for its `add_requirement` and amendment
operations. A rule in a draft predicts answers like one in force. If the standard has no
level 1-3 rules, stop as the skill says: run `/discover-rules` first. Rejected candidates are in the
discover run records, not in `docs/rules/`. Where `standard_status` reports a `scope`, say so on
the page: the rules read are not settled.

## Writing (step 4)

Principles, doc material, tabled clusters, one-offs and discussion notes are written exactly as the
skill says. Everything that would have changed `docs/rules/` goes into **one draft spec** for the
run (`draft_spec`, titled with the run record's name) instead:

- **A business rule** → `add_requirement`: `statement` the owner's words verbatim, `level` 4,
  `authority` the owner's reason and who holds the rule, `lapsesWhen` its falsifier, `interim` true
  if they marked it provisional, `provenance` the run and its cases, `title` and `section` this
  skill's wording (the owner reviews both at sign-off; the page asks for neither). The skill still
  drafts no rule: no words from the owner, no operation.
- **Joined clusters, or a contradiction answered**, that change a rule already in force →
  `amend_statement` on that rule, in the words given; the old wording stays in the run record.
- **A known conflict left open on purpose** (*not a surprise*, with a note) is a deviation: the
  owner grants it as `debt` once the rule is in force, or it waits as a problem (`/codemap-audit`).
  List it in `writeback.md` for them; never write a `Deviations` line.

`rationale` names the run; `reversibility` says a ratified rule is changed by a later spec. Then
tell the owner the draft spec's id and that it waits for them to review, sign off and ratify on the
spec page. Do not sign or ratify for them. `writeback.md` records the spec id and each operation
beside the cluster it came from.
