## Land the settled fixes

**First, the reach of what remains**: every file, rule or section that the design defects,
assumptions, suggestions, disputed items and anything else not landing now in `sort.md` touch. There
is no plan yet, so err wide.

**A fix lands now only when all of these hold** (`references/contract.md` P1): both sorters called
it valid and an isolated defect — never a pattern, which the plan settles; both named what settles
it and put it at level 6-8, with no level-5 fork; it is not marked "don't fix early" and carries no
disagreement; it is outside that reach.

Land each in the member that holds its lines, as its own commit whose message says it applies
findings from run `<RECORD's directory name>`, ending with `Review-round: <RECORD's directory name>`
in the same trailer block as any other trailer (`references/shared.md` C). For a versioned Artifact,
each lands as a new published version of the same Artifact instead — read it first, then publish to
its URL — its label saying in words that it applies findings from that run. Derive a check from the
finding's words and watch it fail first, where the project has tests. **A fix that grows past what
settled it** — more than the sibling shows, a change the rule or principle does not call for —
stops and is carried to the plan instead. **For shared runs, verify repair adequacy independently**
through `references/codemap-workflow.md` before claiming shared closure. This is not another review
round. If shared verification becomes unavailable, retain reported/pending status and evidence.
Markdown-only runs record the ordinary repair outcome and evidence without shared verified closure;
missing codemap does not block landing or handover.

Append **what landed** to `RECORD/sort.md` — per fix one line, its commit or Artifact version, what
settled it (the rule, principle, sibling or check the sorters named), and its check: the command
that fails without the fix, what it did without the fix and what it does with it, or `no check:
<why>` (`references/shared.md` S2). The reproducer is what a later verifier re-runs; a check watched
and not written down is lost. Commit the record where it is in the working tree
(`references/shared.md` K2).

For shared runs, append the canonical finding/claim IDs, sort/evidence IDs and any verification
request/application IDs beside those outcomes. A native verification failure stays pending and
names its reason; committing a fix is not the application of a closure. Follow the capability mode
chosen at entry, then hand over the unresolved state as well as what actually ran.

## Hand over

First, where `sort.md` names rules to raise, tell the owner in one line each: the rule, and the
finding that refuted it or tripped its falsifier. Then invoke `/ez-plan --round <RECORD>` in this
session, with every `--spec` this run was given (`references/contract.md` H), saying where
`RECORD/open-decisions.md` holds open decisions to plan with the round, and stop when it returns.
`ez-plan` settles what it can, writes the summary, decides with the owner whether anything is left
for a plan, and plans, discusses or hands off. Write no summary, ask no planning question, and write
no `plan.md` here.
