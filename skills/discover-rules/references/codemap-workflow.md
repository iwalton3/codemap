# Codemap workflow

For a records repo that is **cut over**: `git check-ignore -q docs/rules/INDEX.md` succeeds there,
so its rules live in codemap's standard and `docs/rules/` is generated from them. The codemap
skill's *Rules in a cut-over repo* (`codemap/SKILL.md`) is the rule; this is how this skill carries
it out. Not cut over, the steps run as written. Every step below needs the codemap MCP tools in this
session; without them, stop at step 0 and say so — nothing this run approves would have anywhere to
go.

## Reading (step 0)

- **What is already a rule**: `requirements` with `status: "ratified"`, and every `add_requirement`
  in a spec still waiting on the owner (`standard_queue` with `pending_specs`, then `spec` for each).
  Skip both: a rule in a draft is proposed already.
- **What was rejected** lives in the run records, never in `docs/rules/`: read the **Rejected**
  section of every earlier discover run record wherever run records are kept (*Where records live*).
  Propose one again only with a new source.
- **Run records** stay where *Where records live* puts them, except under `docs/rules/`: a
  destination there would make git track the generated directory, and codemap then refuses to
  generate it. Stop and tell the owner if a `CLAUDE.md` names one. Under the git common directory
  (the default) a record is this clone's only, so a teammate's run on another clone does not see
  its Rejected list; a `CLAUDE.md` naming a tracked directory shares it.

## Conflicts (step 4)

A conflict is still listed with both `path:line`s. What it becomes once the rule is in force is the
owner's: a **recorded deviation** they accept is `debt`, which they grant; an **unrecorded** one is
a problem — an audit that finds the code non-conformant, then `raise_problem` (`/codemap-audit`).
Neither can be filed before the rule is ratified, so step 6 lists them.

## Writing (step 6)

Everything approved goes into **one draft spec** for the run (`draft_spec`, titled with the run
record's name), one `add_operation` per approved rule:

| Entry line | `add_requirement` field |
|---|---|
| short name | `title` |
| area, or `System-wide` | `section` |
| Rule | `statement` |
| Level | `level` |
| ratified / provisional | `interim`: true for provisional |
| Authority | `authority` |
| Source | `provenance` |
| Falsifier | `lapsesWhen` |
| Rests on | `restsOnRules`: an existing rule's id, or the `add_requirement` operation id of one in this spec |

`rationale` says which run approved it; `reversibility` that a ratified rule is changed by a later
spec. The title and section are this skill's wording and the owner reviews them at sign-off. An item
the owner placed at level 4 is still not written (step 6, as before).

Nothing goes to `docs/rules/` — no area doc, no `INDEX.md`, no Rejected list — and no `CLAUDE.md`
line pointing at `INDEX.md` as must-read: in a cut-over repo the line saying the rules live in
codemap is the one that stands. The run record gets what the standard has no field for:

- **Rejected** — one line each, in the format the skill gives, with the owner's reason.
- **After ratification** — for each rule: its `Applies at` code sites, to `declare_pointer` once the
  rule has an id; sites that are not code; its Deviations (for the owner to grant as debt) and
  Conflicts (for an audit and a problem); its Gaps; its *Built on it* plans and areas.

Then tell the owner the draft spec's id and that it waits for them to review, sign off and ratify
on the spec page. Do not sign or ratify for them. Once it is ratified, the next session in this
repo works the *After ratification* list.

## Standing duties

A rule found wrong, refuted, or whose falsifier someone states goes to the owner at once with what
`rests_on` lists as resting on it, and the *Built on it* lines in the run records.
